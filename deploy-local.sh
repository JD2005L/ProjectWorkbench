#!/usr/bin/env bash
# Hot-deploy helper for a container-mode (PW_DEPLOY_MODE=container) instance.
#
#   ./deploy-local.sh          # hot deploy: promote the whole app/ tree + scripts/*, restart node only
#   ./deploy-local.sh --full   # also copy Containerfile + rebuild image (RESTART kills sessions)
#
# Hot deploy (default): the entrypoint respawns node in ~2s; tmux/terminal
# sessions survive. Full rebuild is only needed when the Containerfile changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${PW_SOURCE_DIR:-/opt/project-workbench/source}"   # host-side source checkout (bind-mounted)
# Destinations are overridable so a test can aim a promotion at a disposable
# tree. The defaults are the real deployment and are what an operator gets.
LIVE_APP="${PW_LIVE_APP:-/opt/project-workbench/app}"
LIVE_SCRIPTS="${PW_LIVE_SCRIPTS:-/opt/project-workbench/scripts}"
IMAGE="${PW_IMAGE:-project-workbench:latest}"
SERVICE="${PW_SERVICE:-project-workbench}"
CONTAINER="${PW_CONTAINER:-project-workbench}"

die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
log()  { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }

FULL_REBUILD=false
[[ "${1:-}" == "--full" ]] && FULL_REBUILD=true

# Detect inside vs outside the container: the host source path only exists on the host.
if [[ -d "$SRC/app" ]]; then INSIDE_CONTAINER=false; else INSIDE_CONTAINER=true; fi

# Restart only the PW node process. If the container runs with --pid=host, a bare
# name-based kill would also hit sibling containers' node procs; scope the kill to
# the PW node by its cwd. The entrypoint loop respawns it in ~2s.
restart_pw_node() {
  for p in $(pgrep -x node); do
    [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$LIVE_APP" ] && kill "$p" || true
  done
}

# ── the app promotion primitive ──────────────────────────────────────────────
# Everything the live app runs, and nothing else.
#
# TWO THINGS THIS GETS RIGHT, both of which a hand-written list got wrong.
#
# COMPLETE. server.js imports its siblings unconditionally, so promoting a SUBSET
# is how a promoted artifact ends up unable to resolve its own imports and dies
# with ERR_MODULE_NOT_FOUND before serving anything. That happened twice with a
# hand-written list — once for app/orchestrator/, once for app/workspace-file.js —
# which is what a list of filenames guarantees over time. So the manifest is
# derived, and all three promotion paths share this one primitive.
#
# TRACKED ONLY. The manifest is `git ls-files -- app/`, NOT a directory listing.
# A listing promotes whatever happens to be sitting in the working tree: a local
# app/.env, a scratch credential, an operator directory — published straight into
# a live deployment. Git's tracked set is the only exact definition of "app
# source", and it excludes node_modules for free (it is ignored), so the live
# tree keeps its own installed dependencies.
#
# NUL-safe end to end (`ls-files -z` into `tar --null -T -`), because a tracked
# path may contain anything except NUL, and streamed through tar so modes,
# symlinks and nested directories survive in one pass.
#
# Requires a Git checkout, and says so rather than silently falling back to a
# listing: a fallback here is precisely the defect above.
app_manifest() {
  git -C "$REPO_DIR" ls-files -z -- app/
}

# promote_app_tree <dest-app-dir> [runner...]
# `runner` is an optional command prefix (i.e. `sudo`) for a destination this
# user cannot write to directly.
promote_app_tree() {
  local dest="$1"; shift
  command -v git >/dev/null 2>&1 \
    || die "git is required: the app manifest is the Git-tracked file list, and guessing it from a directory listing would promote untracked local state."
  git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 \
    || die "$REPO_DIR is not a Git checkout, so the tracked app manifest cannot be determined. Run this from the source checkout."
  "$@" mkdir -p "$dest"
  # --strip-components=1 drops the leading `app/`; -p keeps the recorded modes.
  ( cd "$REPO_DIR" && app_manifest | tar --null --files-from=- --create --file=- ) \
    | "$@" tar --extract --preserve-permissions --file=- --directory="$dest" --strip-components=1
}

if $FULL_REBUILD; then
  $INSIDE_CONTAINER && die "--full rebuild must be run from the host (outside the container)."
  warn "--full: rebuilds the image and RESTARTS the service (kills all tmux/terminal sessions)."
  read -rp "Continue? [y/N] " confirm; [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
  log "Copying source (whole app tree + scripts)..."
  promote_app_tree "$SRC/app" sudo
  sudo cp "$REPO_DIR/scripts/"*     "$SRC/scripts/"
  sudo cp "$REPO_DIR/Containerfile" "$SRC/Containerfile"
  log "Rebuilding image $IMAGE..."
  sudo bash -c "cd '$SRC' && podman build --network=host --no-cache -t '$IMAGE' ."
  log "Restarting $SERVICE (kills sessions)..."
  sudo systemctl restart "$SERVICE"
  log "Done — wait ~10s then reload the dashboard."
elif $INSIDE_CONTAINER; then
  log "Hot deploy (inside container): promoting app/ + scripts/*..."
  promote_app_tree "$LIVE_APP"
  cp "$REPO_DIR/scripts/"*     "$LIVE_SCRIPTS/" 2>/dev/null || true
  log "Restarting PW node..."; restart_pw_node
  log "Done — node restarts in ~2s; terminal sessions unaffected."
else
  log "Hot deploy (from host): promoting app/ + scripts/*..."
  promote_app_tree "$SRC/app" sudo
  sudo cp "$REPO_DIR/scripts/"*     "$SRC/scripts/" 2>/dev/null || true
  log "Restarting PW node inside $CONTAINER..."
  sudo podman exec "$CONTAINER" bash -c '
    for p in $(pgrep -x node); do
      [ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "/opt/project-workbench/app" ] && kill "$p" || true
    done'
  log "Done — node restarts in ~2s; terminal sessions unaffected."
fi
