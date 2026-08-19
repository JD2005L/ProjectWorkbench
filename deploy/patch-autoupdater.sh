#!/usr/bin/env bash
# Add DISABLE_AUTOUPDATER=1 to the live pane env, then restart node — safely,
# from inside the dashboard's own deploy slot.
#
# Wired as the ProjectWorkbench prod slot script:
#   bash /opt/project-workbench/workspaces/ProjectWorkbench/deploy/patch-autoupdater.sh
#
# Runs as root, because the deploy runner is `bash -c <script>` spawned by the
# dashboard process (app/server.js POST /api/deploy/:project/:target), and the
# dashboard runs as root. No sudo, no password.
#
# Two things make a self-deploy different from any other slot:
#
#   1. Restarting node kills the process awaiting this script, so the HTTP
#      response would never be sent and the deploy would read as failed. The
#      restart is therefore DETACHED (setsid, stdio closed) and delayed, so this
#      script returns and the response goes out first.
#   2. If the restart wedges, the dashboard you would use to fix it is gone. The
#      detached child is a watchdog: it restores the backup and restarts again if
#      the dashboard does not answer.
#
# Idempotent: re-running when the token is already present is a no-op.

set -uo pipefail

# Inside the container this path IS workspaces/canonical/app (bind-mounted).
LIVE=/opt/project-workbench/app/server.js
ANCHOR='COPILOT_AUTO_UPDATE=false'
TOKEN='DISABLE_AUTOUPDATER=1'
BAK="$LIVE.bak-autoupd-$(date +%Y%m%d-%H%M%S)"
HEALTH='http://127.0.0.1:7686/'   # this instance's own ttyd; 404 = serving

die(){ printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
say(){ printf '[patch] %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "expected to run as root via the deploy runner; got uid $(id -u)"
[ -f "$LIVE" ] || die "live server.js not found at $LIVE"

if grep -q "$TOKEN" "$LIVE"; then
  say "already patched — $TOKEN is present in the live file. Nothing to do."
  say "If the nag persists it is stale tmux sessions, not this file:"
  say "  recycle the project's terminal, or export $TOKEN in the pane."
  exit 0
fi

N=$(grep -c "$ANCHOR" "$LIVE")
[ "$N" -eq 1 ] || die "expected exactly 1 '$ANCHOR' in the live file, found $N. Not editing."

Q=$(grep -o "['\"]${ANCHOR}['\"]" "$LIVE" | head -1 | cut -c1)
[ -n "$Q" ] || die "could not determine the quote style around $ANCHOR. Not editing."

cp -a "$LIVE" "$BAK" || die "backup failed; nothing changed"
say "backed up -> $BAK"

sed -i "s/${Q}${ANCHOR}${Q}/${Q}${ANCHOR}${Q},${Q}${TOKEN}${Q}/" "$LIVE" \
  || { cp -a "$BAK" "$LIVE"; die "sed failed; restored from backup"; }

grep -q "$TOKEN" "$LIVE" || { cp -a "$BAK" "$LIVE"; die "verify failed; restored from backup"; }
node --check "$LIVE" || { cp -a "$BAK" "$LIVE"; die "patched file fails node --check; restored from backup"; }
say "patched and syntax-checked:"
grep -n "$TOKEN" "$LIVE" | cut -c1-200

ENTRY=$(pgrep -o -f scripts/entrypoint.sh) || die "no entrypoint.sh found; file IS patched, restart manually"
mapfile -t NODES < <(pgrep -P "$ENTRY" -x node)
[ "${#NODES[@]}" -eq 1 ] || die "expected 1 node child of entrypoint $ENTRY, found ${#NODES[@]}; file IS patched, restart manually"
PID=${NODES[0]}

# Detached: stdio fully closed so the deploy runner's pipes reach EOF and this
# request can return. Restart happens ~4s later, after the response is sent.
setsid bash -c "
  sleep 4
  kill $PID 2>/dev/null
  for i in \$(seq 1 25); do
    sleep 1
    code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 '$HEALTH' 2>/dev/null)
    [ \"\$code\" != '000' ] && [ -n \"\$code\" ] && exit 0
  done
  # Dashboard never came back: roll the file back and restart again.
  cp -a '$BAK' '$LIVE'
  NEWENTRY=\$(pgrep -o -f scripts/entrypoint.sh)
  NEWPID=\$(pgrep -P \"\$NEWENTRY\" -x node | head -1)
  [ -n \"\$NEWPID\" ] && kill \"\$NEWPID\" 2>/dev/null
  logger -t pw-patch-autoupdater 'restart did not come back; rolled back server.js and restarted'
" >/dev/null 2>&1 </dev/null &
disown

cat <<EOF
[patch] OK — live file patched.
[patch] node restarts in ~4s (detached, so this deploy can report success first).
[patch] A watchdog will restore $BAK and restart again if the dashboard does not
        answer within ~25s, so a bad patch cannot leave you without the UI.

Terminals will blink and reconnect; tmux sessions survive (parented to conmon).

NOTE: open sessions keep their OLD env — pane env is captured at 'tmux
new-session'. The nag clears in NEW sessions; recycle a project's terminal to
clear it there. Rollback by hand if ever needed:
  cp -a '$BAK' '$LIVE' && kill \$(pgrep -P \$(pgrep -o -f scripts/entrypoint.sh) -x node)
EOF
