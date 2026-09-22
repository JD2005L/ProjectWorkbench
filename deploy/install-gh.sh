#!/usr/bin/env bash
# Install the GitHub CLI so it SURVIVES a container recreation.
#
#   sudo bash /opt/project-workbench/workspaces/ProjectWorkbench/deploy/install-gh.sh [version]
#   bash  .../deploy/install-gh.sh --where          # print the destination, change nothing
#
# WHY THIS EXISTS, given the Containerfile already installs gh (since 5ec4bf0,
# 2026-09-09): the running image predates that layer — everything in its
# /usr/local/bin is dated 2026-08-21 — and an image is only rebuilt deliberately.
# Every time somebody has installed gh INSIDE a running container since, the next
# `podman run` threw it away with the container's writable layer. That is the whole
# story behind "gh isn't installed" recurring: the recipe was right and the artifact
# was in a place that does not last.
#
# So this installs into the directory the containers see as /opt/npm-global — a real
# filesystem on the host, bind-mounted in, already first on the panes' PATH, and the same
# place sqlcmd lives for the same reason. Recreating a container does not touch it.
#
# THE PATH IS DIFFERENT DEPENDING ON WHERE YOU STAND, which is what made the first
# version of this script abort on the host: inside a container it is /opt/npm-global/bin,
# while on the host the same bytes are at /opt/project-workbench/persistent/npm-global/bin.
# Rather than hardcode a second guess, this asks podman what the mount actually is and
# only falls back to the documented host path if no container is running.
#
# Belt and braces on purpose: the Containerfile layer stays, so a rebuilt image also
# has gh in /usr/local/bin. Whichever exists, PATH finds one — /opt/npm-global/bin wins
# and both are the same tool.
#
# The download is verified against GitHub's published checksums, so a truncated or
# tampered fetch fails closed instead of installing a broken binary that reports
# "not installed" in a confusing way later.
set -uo pipefail

FALLBACK_VERSION=2.63.2
# Where the containers see it, and where the host keeps it. Both are consulted; neither
# is assumed.
IN_CONTAINER_DIR=/opt/npm-global
HOST_DIR_DEFAULT=/opt/project-workbench/persistent/npm-global

die(){ printf '\n[gh] ABORT: %s\n' "$*" >&2; exit 1; }
say(){ printf '[gh] %s\n' "$*"; }
hr(){  printf '\n[gh] ---- %s ----\n' "$*"; }

# Ask podman where a container's /opt/npm-global comes from. Self-correcting: if the
# mount is ever moved, this follows it instead of needing this script edited.
resolve_from_podman(){
  command -v podman >/dev/null 2>&1 || return 1
  local c src
  for c in pw-tmux project-workbench; do
    src=$(podman inspect "$c" --format \
      '{{range .Mounts}}{{if eq .Destination "/opt/npm-global"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
    if [ -n "$src" ] && [ -d "$src" ]; then printf '%s' "$src"; return 0; fi
  done
  return 1
}

resolve_dest(){
  # 1. An explicit override always wins.
  if [ -n "${PW_GH_DEST:-}" ]; then printf '%s' "$PW_GH_DEST"; return 0; fi
  # 2. Running inside a container, where the mount is already visible.
  if [ -d "$IN_CONTAINER_DIR" ]; then printf '%s/bin' "$IN_CONTAINER_DIR"; return 0; fi
  # 3. On the host: ask podman rather than guess.
  local src
  if src=$(resolve_from_podman); then printf '%s/bin' "$src"; return 0; fi
  # 4. The documented host path, if it is there.
  if [ -d "$HOST_DIR_DEFAULT" ]; then printf '%s/bin' "$HOST_DIR_DEFAULT"; return 0; fi
  return 1
}

DEST_DIR=$(resolve_dest) || die "could not find the persistent npm-global mount.
  Looked for: $IN_CONTAINER_DIR (inside a container), the /opt/npm-global mount source of
  the pw-tmux or project-workbench containers, and $HOST_DIR_DEFAULT.
  If it lives somewhere else: PW_GH_DEST=/that/path/bin sudo bash $0"

if [ "${1:-}" = "--where" ]; then
  printf '%s\n' "$DEST_DIR"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash $0)
  destination would be: $DEST_DIR"
# The bin/ level may legitimately be absent on a fresh host even when the mount is there.
[ -d "$DEST_DIR" ] || mkdir -p "$DEST_DIR" || die "could not create $DEST_DIR"
# A tmpfs or an overlay upper layer would defeat the entire point of this script.
FSTYPE=$(stat -f -c %T "$DEST_DIR" 2>/dev/null || echo unknown)
case "$FSTYPE" in
  tmpfs|overlay|overlayfs)
    die "$DEST_DIR is on $FSTYPE, which does NOT survive a container recreation.
  Installing there would recreate the exact problem this script exists to fix." ;;
esac
say "destination: $DEST_DIR (filesystem: $FSTYPE)"

command -v curl >/dev/null || die "curl not found"
command -v tar  >/dev/null || die "tar not found"
command -v sha256sum >/dev/null || die "sha256sum not found — refusing to install an unverified binary"

# ------------------------------------------------------------------ version ---
hr "resolving the version"
VER=${1:-}
if [ -z "$VER" ]; then
  # The releases/latest redirect rather than the API: the unauthenticated API is
  # rate-limited and would flake. Same approach as the Containerfile.
  VER="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest 2>/dev/null | sed -E 's#.*/tag/v?##')"
  case "$VER" in ''|*/*) say "could not resolve the latest tag; falling back to $FALLBACK_VERSION"; VER=$FALLBACK_VERSION ;; esac
fi
case "$VER" in v*) VER=${VER#v} ;; esac
case "$VER" in *[!0-9.]*) die "version '$VER' does not look like a release number" ;; esac
say "version: $VER"

TARBALL="gh_${VER}_linux_amd64.tar.gz"
BASE_URL="https://github.com/cli/cli/releases/download/v${VER}"
TMP=$(mktemp -d) || die "could not make a temp dir"
trap 'rm -rf "$TMP"' EXIT

# ----------------------------------------------------------------- download ---
hr "downloading and verifying"
curl -fsSL "$BASE_URL/$TARBALL" -o "$TMP/$TARBALL" || die "download failed: $BASE_URL/$TARBALL"
curl -fsSL "$BASE_URL/gh_${VER}_checksums.txt" -o "$TMP/checksums.txt" || die "could not fetch the checksums file — refusing to install unverified"
EXPECTED=$(awk -v f="$TARBALL" '$2==f{print $1}' "$TMP/checksums.txt")
[ -n "$EXPECTED" ] || die "no checksum published for $TARBALL"
ACTUAL=$(sha256sum "$TMP/$TARBALL" | awk '{print $1}')
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $TARBALL
  expected $EXPECTED
  got      $ACTUAL"
say "sha256 verified"

tar -xzf "$TMP/$TARBALL" -C "$TMP" "gh_${VER}_linux_amd64/bin/gh" || die "the tarball did not contain the expected binary"

# ------------------------------------------------------------------ install ---
hr "installing"
# Into place atomically: a half-written binary on a shared mount would be visible to
# every pane in the meantime.
install -m 0755 "$TMP/gh_${VER}_linux_amd64/bin/gh" "$DEST_DIR/.gh.new" || die "could not write to $DEST_DIR"
mv -f "$DEST_DIR/.gh.new" "$DEST_DIR/gh" || die "could not move the new binary into place"
say "installed: $DEST_DIR/gh"

# ------------------------------------------------------------------- verify ---
hr "verification"
"$DEST_DIR/gh" --version || die "the installed binary does not run"
say "on PATH in this shell as: $(command -v gh || echo '(not on THIS shell PATH — the containers see it as /opt/npm-global/bin, which is first on a pane PATH)')"

cat <<EOF

[gh] DONE — and it is on a filesystem that survives a container recreation.

Two things worth knowing:

  * A pane's PATH is fixed when the pane is created, but the DIRECTORY is already on it
    (the containers see it as /opt/npm-global/bin, first on PATH), so existing terminals
    pick this up with no restart.
  * This does NOT authenticate anything. gh needs a token for private repos: either
    GH_TOKEN in the environment (per-user credentials already export one) or
    \`gh auth login\`, which is what the Users page will drive.

If it ever goes missing again, the dashboard now says so: Settings > System & Updates >
Readiness checklist has a line for it.
EOF
