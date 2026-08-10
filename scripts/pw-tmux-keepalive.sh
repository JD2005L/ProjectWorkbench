#!/bin/bash
# Persistent tmux server for Project Workbench terminals.
#
# The point of this script, in BOTH deploy modes, is that the tmux server — and therefore every
# project's shells, running agents, and scrollback — lives in a cgroup of its OWN, owned by a unit
# whose whole job is to hold it. Nothing else restarting can take the sessions down with it.
#
# CONTAINER MODE (the original): runs as the foreground process of the dedicated `pw-tmux` sidecar
# container, so the server survives a restart of the main `project-workbench` app container
# (dashboard/API + ttyd) — which is what used to wipe every project's terminal on a
# `systemctl restart`. The app container attaches over a shared Unix socket in $TMUX_TMPDIR, a host
# bind mount (/opt/project-workbench/run/tmux) present in both containers; server.js's tmux clients
# and ttyd's `tmux attach` all talk to this server because they inherit the same TMUX_TMPDIR.
# Sessions only ever die when THIS container is stopped/rebuilt (rare — a Containerfile change).
# Day-to-day app-code deploys use a node-only reload and never touch this server. See DEPLOY.md.
#
# HOST MODE (PW_TMUX_HOST_MODE=1, run by pw-tmux-server.service): same idea without the container.
# Host mode had no equivalent, so the server ended up parented to whichever
# project-terminal@<project>.service happened to run `tmux new-session` first — putting EVERY
# project's panes in one per-project ttyd unit's cgroup. On 2026-08-03 a single OOM-killed pane
# failed that unit and systemd tore the cgroup down, killing every project's sessions mid-uptime.
# See systemd/pw-tmux-server.service.
#
# READINESS IS THE WHOLE POINT OF THE UNIT (HJ-24-1). The owner unit is `Type=notify`, and this
# script signals ready ONLY after the server and the `_keepalive` session are confirmed live on the
# socket the terminals actually use. With the previous `Type=simple`, systemd considered the unit
# started the moment this process was forked: the `After=` barrier released, a cold-boot terminal
# could run `tmux new-session` first, and the server was created in the TERMINAL's cgroup —
# reproducing the exact topology this unit exists to eliminate. `ExecStartPost=pw-tmux-restore`
# masked it whenever a manifest existed (restore creates the server itself, in the owner's cgroup);
# with NO manifest, restore returns in milliseconds and the race is wide open.
set -u

# Who owns the server. Exported BEFORE the server is created so the tmux daemon inherits it: the
# server process's own /proc/<pid>/environ then carries proof of which process created it, which is
# what scripts/pw-tmux-assert-owner checks. A server created by a terminal client has no such
# marker — that is the difference between "the owner holds the sessions" and the 2026-08-03
# topology, and it is observable without root, without systemd, and without trusting unit text.
PW_TMUX_OWNER="${PW_TMUX_OWNER:-pw-tmux-server}"
export PW_TMUX_OWNER

if [ "${PW_TMUX_HOST_MODE:-0}" = "1" ]; then
  # Host mode shares the per-user DEFAULT tmux socket with project-terminal-start,
  # setup-terminal-start and app/server.js. Redirecting TMUX_TMPDIR here the way the sidecar does
  # would stand up a SECOND, invisible server that no terminal ever attaches to — the sessions would
  # look "lost" exactly as before. Clear any inherited value so tmux resolves its own default
  # (/tmp/tmux-<uid>).
  unset TMUX_TMPDIR
else
  : "${TMUX_TMPDIR:=/opt/project-workbench/run/tmux}"
  export TMUX_TMPDIR
  mkdir -p "$TMUX_TMPDIR"
  chmod 0700 "$TMUX_TMPDIR" 2>/dev/null || true
fi

# Never inherit a client context. If this script is ever started from inside a tmux pane (a manual
# `systemctl start` from a terminal, a test harness), $TMUX makes tmux talk to THAT server instead
# of the one we were told to own.
unset TMUX TMUX_PANE

# Mirrors app/server.js's PW_TMUX_SOCKET and scripts/pw-tmux-restore's tmux_sock_args exactly: unset
# (the production default) means the normal socket, so this must never issue a BARE tmux command
# that could resolve against a different socket than the one it was explicitly told to use. Set in
# tests to isolate onto a private server.
sock_args=()
[ -n "${PW_TMUX_SOCKET:-}" ] && sock_args=(-L "$PW_TMUX_SOCKET")
tmux() { command tmux "${sock_args[@]}" "$@"; }

log() { printf '%s pw-tmux-keepalive: %s\n' "$(date -Iseconds)" "$*" >&2; }

# Bring up the server with a keepalive session (so it never auto-exits) and set exit-empty off as a
# belt-and-suspenders guard. `_keepalive` does NOT start with `pw_`, so server.js's orphan-sweep
# (which only kills `pw_*` sessions absent from projects.json) leaves it alone — and so does
# pw-tmux-save, which only persists `pw_*`, meaning a keepalive-only server correctly snapshots as
# "0 windows" and keeps the existing manifest rather than clobbering it.
#
# ORDER MATTERS. Under tmux's default `exit-empty on`, a server with no sessions exits the moment
# `start-server` returns — so setting the option before there is a session lands it on a server that
# is already dying, and `new-session` then silently starts a FRESH one with exit-empty back at its
# default. Create the session first, then set the option on the server that actually survives.
tmux -u start-server 2>/dev/null || true
if ! tmux -u has-session -t _keepalive 2>/dev/null; then
  tmux -u new-session -d -s _keepalive 'while true; do sleep 3600; done'
fi
tmux -u set-option -s exit-empty off 2>/dev/null || true

# PROVE it before claiming readiness. A failure here must fail the unit START, not leave a unit
# sitting "active" with no server behind it while the ordering barrier releases every terminal.
if ! tmux -u has-session -t _keepalive 2>/dev/null; then
  log "the tmux server or its _keepalive session did not come up on the intended socket; refusing to report ready"
  exit 1
fi

# Optional: replay the persistence manifest into the server THIS process owns, before readiness.
#
# Host mode gets this from the unit's ExecStartPost. Container mode (GOA) has no systemd inside the
# sidecar, so without this a sidecar restart came back to an empty server and nothing replayed the
# manifest — PR #24 gave container mode faster failure DETECTION with none of the RECOVERY (GOA-2).
# Opt-in, because it is only correct when the persistence state dir is actually mounted into the
# sidecar; see DEPLOY.md for the required mount. Deliberately never fatal: this process's job is to
# hold the server open, and a restore problem must not cost the instance its supervisor. The restore
# script reports its own configuration failures with a non-zero exit, which is logged here.
if [ "${PW_TMUX_RESTORE_ON_START:-0}" = "1" ]; then
  restore_bin="${PW_TMUX_RESTORE_BIN:-/usr/local/bin/pw-tmux-restore}"
  if [ -x "$restore_bin" ]; then
    if "$restore_bin"; then
      log "restore-on-start completed"
    else
      log "restore-on-start exited $? — the server is up and supervised regardless; check the persistence configuration"
    fi
  else
    log "PW_TMUX_RESTORE_ON_START=1 but $restore_bin is not executable; skipping the replay"
  fi
fi

# READY. systemd only releases the After= barrier — and therefore the terminals — once this lands,
# so by construction no terminal client can be the process that creates the server.
#
# Conditional on NOTIFY_SOCKET, which systemd sets for a Type=notify unit with NotifyAccess=all.
# Container mode has no systemd in the sidecar and simply never signals; that must never become an
# exit path that stops this process from supervising (a GOA constraint, and correct in itself).
if [ -n "${NOTIFY_SOCKET:-}" ]; then
  "${PW_TMUX_NOTIFY_CMD:-systemd-notify}" --ready 2>/dev/null \
    || log "could not signal readiness (${PW_TMUX_NOTIFY_CMD:-systemd-notify} unavailable) — continuing to supervise"
fi

# Stay in the foreground so the unit/container — and therefore the server's cgroup — stays up; on
# SIGTERM/SIGINT exit cleanly and let systemd/podman tear it down.
#
# SUPERVISE, don't just idle. This used to be `tail -f /dev/null`, which meant a server that died
# (crash, OOM kill of the server process, a stray `tmux kill-server`) was never noticed: the unit sat
# there "active" with nothing behind it, and because the supervisor saw no failure it never
# restarted — so ExecStartPost=pw-tmux-restore never re-ran and the sessions stayed gone until a
# human noticed. Exiting non-zero is what turns a dead server into an automatic restore.
term() { exit 0; }
trap term TERM INT
while :; do
  # Backgrounded sleep + wait so SIGTERM is handled promptly instead of being queued behind a
  # blocking sleep.
  sleep "${PW_TMUX_WATCH_INTERVAL:-10}" &
  wait $!
  tmux -u has-session -t _keepalive 2>/dev/null || exit 1
done
