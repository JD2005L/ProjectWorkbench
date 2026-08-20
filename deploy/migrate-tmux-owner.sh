#!/usr/bin/env bash
# Put the pw-tmux sidecar under the tmux ownership contract, so the gate in the
# promoted app stops refusing every session-creating action.
#
# ============================ READ THIS FIRST ==============================
# THIS ENDS EVERY TMUX SESSION ON THE BOX. Sessions are saved first and restored
# afterwards, but anything running inside a pane (agents, builds, editors) is
# killed and does not come back mid-task.
#
# RUN IT FROM AN SSH SHELL ON THE HOST, NOT FROM A PROJECT WORKBENCH TERMINAL.
# A pane is itself a tmux session: run it there and it kills its own shell
# halfway through, leaving the migration half-applied.
#
#   ssh james.levac.z@vnl2422
#   sudo bash /opt/project-workbench/persistent/admin-home/migrate-tmux-owner.sh --dry-run
#   sudo bash /opt/project-workbench/persistent/admin-home/migrate-tmux-owner.sh
# ===========================================================================
#
# WHY: the promoted app enforces tmux ownership (app/tmux-owner-gate.js) and
# requires BOTH an @pw_owner marker on the server AND the server's cgroup to
# contain the expected owner segment. There is deliberately no bypass flag. The
# running sidecar satisfies neither: it was launched without --cgroup-parent,
# --cgroupns=host or PW_TMUX_OWNER_CGROUP, so its cgroup is the libpod scope, and
# the old keepalive never stamped the marker. Result: assertTmuxOwner throws, and
# every project save kills that project's terminal without restarting it.
#
# WHAT IT DOES, in order, stopping at the first failure:
#   1. refuses unless the newer scripts are already promoted (they stamp the
#      marker — restarting into the old ones just recreates the problem);
#   2. refreshes the host helper binaries in /usr/local/bin from the checkout;
#   3. saves tmux session state;
#   4. backs up and installs the checkout's systemd/pw-tmux.service;
#   5. restarts the sidecar so it lands under pw-tmux.slice;
#   6. verifies BOTH halves of ownership actually hold now;
#   7. restores the saved sessions;
#   8. reverts the unit and restarts if verification fails.

set -uo pipefail

REPO=/opt/project-workbench/workspaces/ProjectWorkbench
LIVE_SCRIPTS=/opt/project-workbench/workspaces/canonical/scripts
UNIT_NAME=pw-tmux.service
UNIT_SRC="$REPO/systemd/$UNIT_NAME"
UNIT_DST="/etc/systemd/system/$UNIT_NAME"
STAMP=$(date +%Y%m%d-%H%M%S)
UNIT_BAK="/root/pw-tmux.service.bak-$STAMP"
TMUX_TMPDIR_LIVE=/opt/project-workbench/run/tmux
EXPECT_MARKER=pw-owner
EXPECT_CGROUP=pw-tmux.slice
SELF=/opt/project-workbench/persistent/admin-home/migrate-tmux-owner.sh
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

die(){ printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
say(){ printf '[migrate] %s\n' "$*"; }
hr(){  printf '\n[migrate] ---- %s ----\n' "$*"; }

# ---------------------------------------------------------------- guards -----
if [ -f /run/.containerenv ]; then
  die "running inside a container — and a PW pane is a tmux session this would kill.
      Use an SSH shell on the host:
        sudo bash $SELF"
fi
[ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash $SELF [--dry-run])"
[ -f "$UNIT_SRC" ] || die "unit not found in the checkout: $UNIT_SRC"
systemctl cat "$UNIT_NAME" >/dev/null 2>&1 || die "$UNIT_NAME is not installed on this host.
      This script migrates an existing container-mode install; it does not create one."

# A pane is a tmux session. If this shell is inside tmux we are about to kill it.
[ -n "${TMUX:-}" ] && die "this shell is itself inside tmux (\$TMUX is set).
      Run it from a plain SSH shell instead, or it will kill itself mid-migration."

[ "$DRY" -eq 1 ] && say "DRY RUN — nothing will be changed."

# ------------------------------------------- preflight: scripts promoted? ----
hr "preflight: are the marker-stamping scripts in place?"
KEEP="$LIVE_SCRIPTS/pw-tmux-keepalive.sh"
[ -f "$KEEP" ] || die "not found: $KEEP"
if grep -q "set-option -s .*@pw_owner" "$KEEP"; then
  say "live keepalive stamps the owner marker — good"
else
  die "the live keepalive does NOT stamp the @pw_owner marker, so restarting the
      sidecar would come back just as unowned. Promote scripts/ first:
        sudo bash /opt/project-workbench/persistent/admin-home/promote-app.sh"
fi

# ------------------------------------------------- preflight: unit diff ------
hr "preflight: installed unit vs checkout"
if diff -u <(systemctl cat "$UNIT_NAME" | sed '1d') "$UNIT_SRC" >/tmp/pw-unit.diff 2>&1; then
  say "installed unit already matches the checkout"
  UNIT_NEEDS_INSTALL=0
else
  UNIT_NEEDS_INSTALL=1
  sed -n '1,60p' /tmp/pw-unit.diff
fi
for want in 'cgroup-parent=pw-tmux.slice' 'cgroupns=host' 'PW_TMUX_OWNER_CGROUP=pw-tmux.slice'; do
  if grep -q -- "$want" "$UNIT_SRC"; then printf '  checkout has  %s\n' "$want"
  else die "the checkout unit is missing '$want' — refusing to migrate to it"; fi
done

hr "preflight: current ownership verdict"
CUR_PID=$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux display-message -p '#{pid}' 2>/dev/null || true)
if [ -n "$CUR_PID" ]; then
  printf '  tmux server pid   %s\n' "$CUR_PID"
  printf '  cgroup            %s\n' "$(tr -d '\0' < /proc/"$CUR_PID"/cgroup 2>/dev/null | head -1)"
  printf '  @pw_owner marker  %s\n' "$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux show-options -sv @pw_owner 2>/dev/null || echo '(absent)')"
  printf '  live sessions     %s\n' "$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux list-sessions 2>/dev/null | wc -l)"
else
  say "no tmux server currently reachable on $TMUX_TMPDIR_LIVE"
fi

if [ "$DRY" -eq 1 ]; then
  hr "DRY RUN complete"
  say "Re-run without --dry-run to save sessions, install the unit, and restart the sidecar."
  say "That WILL end every tmux session on this box."
  exit 0
fi

# ------------------------------------------- refresh host helper binaries ----
hr "refresh /usr/local/bin helpers from the checkout"
for h in pw-tmux-save pw-tmux-restore pw-tmux-assert-owner; do
  if [ -f "$REPO/scripts/$h" ]; then
    bash -n "$REPO/scripts/$h" 2>/dev/null || die "$h fails bash -n in the checkout; nothing changed"
    [ -f "/usr/local/bin/$h" ] && cp -a "/usr/local/bin/$h" "/root/$h.bak-$STAMP"
    install -m 0755 "$REPO/scripts/$h" "/usr/local/bin/$h" || die "failed installing $h"
    printf '  installed %s\n' "/usr/local/bin/$h"
  fi
done

# ------------------------------------------------------------ save state -----
hr "save tmux session state"
if command -v pw-tmux-save >/dev/null 2>&1; then
  if pw-tmux-save; then say "sessions saved"
  else say "WARNING: pw-tmux-save returned non-zero — sessions may not restore"; fi
else
  say "WARNING: pw-tmux-save not found; continuing without a session snapshot"
fi

# --------------------------------------------------------- install unit ------
if [ "$UNIT_NEEDS_INSTALL" -eq 1 ]; then
  hr "install the unit"
  systemctl cat "$UNIT_NAME" | sed '1d' > "$UNIT_BAK" || die "could not back up the installed unit"
  say "installed unit backed up -> $UNIT_BAK"
  install -m 0644 "$UNIT_SRC" "$UNIT_DST" || die "failed to install $UNIT_DST"
  systemctl daemon-reload || die "daemon-reload failed"
  say "unit installed and daemon reloaded"
else
  say "unit already current; skipping install"
fi

revert_unit(){
  [ -f "$UNIT_BAK" ] || return 0
  install -m 0644 "$UNIT_BAK" "$UNIT_DST"
  systemctl daemon-reload
  systemctl restart "$UNIT_NAME"
  sleep 10
}

# -------------------------------------------------------------- restart ------
hr "restart the sidecar (this is the point every session ends)"
systemctl restart "$UNIT_NAME" || { revert_unit; die "restart failed; reverted the unit"; }
say "restart issued; waiting for the tmux server to come back"

NEW_PID=""
for _ in $(seq 1 40); do
  sleep 1
  NEW_PID=$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux display-message -p '#{pid}' 2>/dev/null || true)
  [ -n "$NEW_PID" ] && break
done
[ -n "$NEW_PID" ] || { revert_unit; die "no tmux server appeared within 40s. Unit reverted.
      Check: systemctl status $UNIT_NAME ; podman logs --tail 60 pw-tmux"; }
say "tmux server is up as pid $NEW_PID"

# --------------------------------------------------------------- verify ------
hr "verify BOTH halves of ownership"
MARKER=$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux show-options -sv @pw_owner 2>/dev/null || true)
CGROUP=$(tr -d '\0' < /proc/"$NEW_PID"/cgroup 2>/dev/null | head -1)
printf '  marker  %-12s (expect %s)\n' "${MARKER:-(absent)}" "$EXPECT_MARKER"
printf '  cgroup  %s\n' "${CGROUP:-(unknown)}"

OK=1
[ "$MARKER" = "$EXPECT_MARKER" ] || { printf '  FAIL marker\n'; OK=0; }
case "/${CGROUP#*::}/" in *"/$EXPECT_CGROUP/"*) printf '  ok   cgroup contains %s\n' "$EXPECT_CGROUP";;
  *) printf '  FAIL cgroup does not contain %s\n' "$EXPECT_CGROUP"; OK=0;; esac

if [ "$OK" -ne 1 ]; then
  hr "REVERTING — ownership still does not hold"
  systemctl status "$UNIT_NAME" --no-pager | head -20
  podman logs --tail 40 pw-tmux 2>&1 | tail -25
  revert_unit
  die "reverted to $UNIT_BAK. Nothing about ownership changed, and sessions were
      saved before the restart — restore them with: pw-tmux-restore"
fi
say "ownership holds: marker present AND cgroup under $EXPECT_CGROUP"

# -------------------------------------------------------------- restore ------
hr "restore saved sessions"
if command -v pw-tmux-restore >/dev/null 2>&1; then
  pw-tmux-restore || say "WARNING: pw-tmux-restore returned non-zero — see output above"
else
  say "pw-tmux-restore not found; sessions must be recreated by opening projects"
fi
sleep 5

hr "post-migration state"
printf '  tmux sessions: %s\n' "$(TMUX_TMPDIR="$TMUX_TMPDIR_LIVE" tmux list-sessions 2>/dev/null | wc -l)"
printf '  ttyd bridges : %s\n' "$(pgrep -c -f 'ttyd --interface' || echo 0)"
printf '  dashboard    : %s   (200/302/401 = serving)\n' "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/workbench/ 2>/dev/null)"

cat <<EOF

[migrate] DONE — the sidecar is under $EXPECT_CGROUP and carries the owner marker.

Now confirm the thing that was broken actually works: open a project in the
dashboard, edit a field (a Dev/Prod site URL is ideal) and press Save changes.
It should save AND restart that project's terminal instead of refusing.

TS-Chatbot-Dashboard's terminal (port 7681) was killed by the failed save earlier
and will come back on the next successful save or session restore for it.

Rollback:
  install -m 0644 '$UNIT_BAK' '$UNIT_DST' && systemctl daemon-reload \\
    && systemctl restart $UNIT_NAME && pw-tmux-restore
EOF
