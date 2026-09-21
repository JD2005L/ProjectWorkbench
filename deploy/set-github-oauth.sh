#!/usr/bin/env bash
# Point this workbench at a GitHub OAuth app, so Settings > Users > "connect" can run the
# device flow per person.
#
# Run from a HOST shell on vnl2422:
#   sudo bash /opt/project-workbench/workspaces/ProjectWorkbench/deploy/set-github-oauth.sh <client-id> [scopes]
#
# WHY A SCRIPT AND NOT "edit the unit": the dashboard is a podman container, and a
# container's environment is fixed when `podman run` is executed. So the variable has to
# go into the ExecStart that runs it, and the service has to be restarted for a new
# `podman run` to happen at all — setting it anywhere else looks like it worked and
# changes nothing. This finds the fragment that actually carries that ExecStart rather
# than assuming a filename, backs it up, edits it idempotently, restarts, and then proves
# the variable reached the container.
#
# ROLLBACK is printed at the end, and the backup is left in place.
set -uo pipefail

UNIT=project-workbench.service
CONTAINER=project-workbench
VAR=PW_GITHUB_OAUTH_CLIENT_ID
SCOPES_VAR=PW_GITHUB_OAUTH_SCOPES
STAMP=$(date +%Y%m%d-%H%M%S)

die(){ printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
say(){ printf '[oauth] %s\n' "$*"; }
hr(){  printf '\n[oauth] ---- %s ----\n' "$*"; }

CLIENT_ID=${1:-}
SCOPES=${2:-}
[ -n "$CLIENT_ID" ] || die "usage: sudo bash $0 <client-id> [scopes]
  <client-id>  an OAuth app with Device Flow enabled (GitHub > Settings > Developer
               settings > OAuth Apps), or the GitHub CLI's public client id.
  [scopes]     optional; default repo,read:org,workflow. 'repo' is what makes the
               resulting token usable as a push credential."
case "$CLIENT_ID" in *[[:space:]]*) die "the client id must not contain whitespace";; esac

[ -f /run/.containerenv ] && die "running inside a container. Use a HOST shell on vnl2422."
[ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash $0 <client-id>)"
command -v systemctl >/dev/null || die "systemctl not found; this host does not run the dashboard under systemd"
command -v podman   >/dev/null || die "podman not found"

# ------------------------------------------------------------------ locate ---
# `systemctl cat` prints every fragment with a `# /path` header. The one we want is
# whichever fragment carries the ExecStart that runs THIS container — found by content,
# so a renamed or relocated drop-in still works.
hr "locating the ExecStart that starts $CONTAINER"
mapfile -t FRAGMENTS < <(systemctl cat "$UNIT" 2>/dev/null | awk '/^# \//{print substr($0,3)}')
[ "${#FRAGMENTS[@]}" -gt 0 ] || die "systemctl cat $UNIT produced nothing — is the unit installed?"

TARGET=""
for f in "${FRAGMENTS[@]}"; do
  [ -f "$f" ] || continue
  if grep -qE '^[[:space:]]*ExecStart=.*podman[[:space:]]+run' "$f" && grep -q -- "--name[[:space:]]*$CONTAINER" "$f"; then
    TARGET="$f"
  fi
done
[ -n "$TARGET" ] || die "could not find the fragment holding the podman run for $CONTAINER.
  Fragments seen:
$(printf '    %s\n' "${FRAGMENTS[@]}")
  Look for the one with 'ExecStart=... podman run ... --name $CONTAINER' and set the
  variable there by hand, then: systemctl daemon-reload && systemctl restart $UNIT"
say "ExecStart lives in: $TARGET"

BAK="$TARGET.bak-ghoauth-$STAMP"
cp -a "$TARGET" "$BAK" || die "could not back up $TARGET"
say "backup: $BAK"

# --------------------------------------------------------------------- edit ---
hr "setting $VAR"
python3 - "$TARGET" "$VAR" "$CLIENT_ID" "$SCOPES_VAR" "$SCOPES" <<'PY' || die "the edit failed; nothing was changed (restore: cp -a BACKUP TARGET)"
import re, sys
path, var, val, svar, sval = sys.argv[1:6]
text = open(path).read()
original = text

def upsert(text, name, value):
    if not value:
        return text
    # Already present (any quoting): replace the value in place.
    pat = re.compile(r'(-e\s+' + re.escape(name) + r'=)(?:"[^"]*"|\'[^\']*\'|\S+)')
    if pat.search(text):
        return pat.sub(lambda m: m.group(1) + value, text, count=1)
    # Otherwise inject straight after `podman run`, which works whether the ExecStart is
    # one long line or a backslash continuation.
    pat2 = re.compile(r'(ExecStart=.*?podman\s+run)(\s)')
    if not pat2.search(text):
        raise SystemExit('no "ExecStart=... podman run" found to inject into')
    return pat2.sub(lambda m: m.group(1) + ' -e ' + name + '=' + value + m.group(2), text, count=1)

text = upsert(text, var, val)
text = upsert(text, svar, sval)
if text == original:
    raise SystemExit('nothing to change')
open(path, 'w').write(text)
print('  edited ' + path)
PY

grep -nE "ExecStart=.*podman[[:space:]]+run" "$TARGET" | head -2
grep -o -- "-e $VAR=[^ \\\\]*" "$TARGET" | head -1 || die "the variable is not in the file after editing"

# ------------------------------------------------------------------ restart ---
hr "restarting $UNIT (a new podman run is the only way a new env var lands)"
systemctl daemon-reload || die "daemon-reload failed (restore: cp -a '$BAK' '$TARGET')"
systemctl restart "$UNIT" || die "restart failed (restore: cp -a '$BAK' '$TARGET' && systemctl daemon-reload && systemctl restart $UNIT)"
sleep 8

# ------------------------------------------------------------------- verify ---
hr "verification"
IN_CONTAINER=$(podman inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep "^$VAR=" || true)
if [ -n "$IN_CONTAINER" ]; then
  say "container env: $IN_CONTAINER"
else
  say "WARNING: $VAR is NOT in the container's environment — the edit did not take."
  say "         restore with: cp -a '$BAK' '$TARGET' && systemctl daemon-reload && systemctl restart $UNIT"
fi

code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null; }
printf '  dashboard        %s   (200/302/401 = serving)\n' "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/workbench/)"
# A restart of this container must never take the project terminals with it. 404 from a
# ttyd port is healthy; 000 means that backend is down and the project will show 502.
for port in 7686 7693; do
  printf '  ttyd %s        %s   (404 = healthy, 000 = down)\n' "$port" "$(code http://127.0.0.1:$port/)"
done

cat <<EOF

[oauth] DONE.

Next, in the dashboard: Settings > Users > "connect" on a person's row. The modal will
show a code; that PERSON enters it at github.com/login/device while signed in to GitHub
as themselves — whoever is signed in there is the account that gets stored, which is why
the row shows the GitHub login afterwards.

If any ttyd line above reads 000, or the dashboard is not serving, roll back with:
  cp -a '$BAK' '$TARGET' && systemctl daemon-reload && systemctl restart $UNIT
EOF
