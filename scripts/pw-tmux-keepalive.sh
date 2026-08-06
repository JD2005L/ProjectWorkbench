#!/bin/bash
# Persistent tmux server for Project Workbench terminals.
#
# The point of this script, in BOTH deploy modes, is that the tmux server — and
# therefore every project's shells, running agents, and scrollback — lives in a
# cgroup of its OWN, owned by a unit whose whole job is to hold it. Nothing else
# restarting can take the sessions down with it.
#
# CONTAINER MODE (the original): runs as the foreground process of the dedicated
# `pw-tmux` sidecar container, so the server survives a restart of the main
# `project-workbench` app container (dashboard/API + ttyd) — which is what used to
# wipe every project's terminal on a `systemctl restart`. The app container
# attaches over a shared Unix socket in $TMUX_TMPDIR, a host bind mount
# (/opt/project-workbench/run/tmux) present in both containers; server.js's tmux
# clients and ttyd's `tmux attach` all talk to this server because they inherit
# the same TMUX_TMPDIR. Sessions only ever die when THIS container is
# stopped/rebuilt (rare — a Containerfile change). Day-to-day app-code deploys use
# a node-only reload and never touch this server. See DEPLOY.md.
#
# HOST MODE (PW_TMUX_HOST_MODE=1, run by pw-tmux-server.service): same idea
# without the container. Host mode had no equivalent, so the server ended up
# parented to whichever project-terminal@<project>.service happened to run
# `tmux new-session` first — putting EVERY project's panes in one per-project
# ttyd unit's cgroup. On 2026-08-03 a single OOM-killed pane failed that unit and
# systemd tore the cgroup down, killing every project's sessions mid-uptime. See
# systemd/pw-tmux-server.service.
set -u

if [ "${PW_TMUX_HOST_MODE:-0}" = "1" ]; then
  # Host mode shares the per-user DEFAULT tmux socket with project-terminal-start,
  # setup-terminal-start and app/server.js. Redirecting TMUX_TMPDIR here the way
  # the sidecar does would stand up a SECOND, invisible server that no terminal
  # ever attaches to — the sessions would look "lost" exactly as before. Clear any
  # inherited value so tmux resolves its own default (/tmp/tmux-<uid>).
  unset TMUX_TMPDIR
else
  : "${TMUX_TMPDIR:=/opt/project-workbench/run/tmux}"
  export TMUX_TMPDIR
  mkdir -p "$TMUX_TMPDIR"
  chmod 0700 "$TMUX_TMPDIR" 2>/dev/null || true
fi

# Mirrors app/server.js's PW_TMUX_SOCKET and scripts/pw-tmux-restore's
# tmux_sock_args exactly: unset (the production default) means the normal socket,
# so this must never issue a BARE tmux command that could resolve against a
# different socket than the one it was explicitly told to use. Set in tests to
# isolate onto a private server.
sock_args=()
[ -n "${PW_TMUX_SOCKET:-}" ] && sock_args=(-L "$PW_TMUX_SOCKET")
tmux() { command tmux "${sock_args[@]}" "$@"; }

# Bring up the server with a keepalive session (so it never auto-exits) and set
# exit-empty off as a belt-and-suspenders guard. `_keepalive` does NOT start with
# `pw_`, so server.js's orphan-sweep (which only kills `pw_*` sessions absent from
# projects.json) leaves it alone — and so does pw-tmux-save, which only persists
# `pw_*`, meaning a keepalive-only server correctly snapshots as "0 windows" and
# keeps the existing manifest rather than clobbering it.
#
# ORDER MATTERS. Under tmux's default `exit-empty on`, a server with no sessions
# exits the moment `start-server` returns — so setting the option before there is
# a session lands it on a server that is already dying, and `new-session` then
# silently starts a FRESH one with exit-empty back at its default. Create the
# session first, then set the option on the server that actually survives.
tmux -u start-server 2>/dev/null || true
if ! tmux -u has-session -t _keepalive 2>/dev/null; then
  tmux -u new-session -d -s _keepalive 'while true; do sleep 3600; done'
fi
tmux -u set-option -s exit-empty off 2>/dev/null || true

# Stay in the foreground so the unit/container — and therefore the server's
# cgroup — stays up; on SIGTERM/SIGINT exit cleanly and let systemd/podman tear
# it down.
#
# SUPERVISE, don't just idle. This used to be `tail -f /dev/null`, which meant a
# server that died (crash, OOM kill of the server process, a stray
# `tmux kill-server`) was never noticed: the unit sat there "active" with nothing
# behind it, and because the supervisor saw no failure it never restarted — so
# ExecStartPost=pw-tmux-restore never re-ran and the sessions stayed gone until a
# human noticed. Exiting non-zero is what turns a dead server into an automatic
# restore.
term() { exit 0; }
trap term TERM INT
while :; do
  # Backgrounded sleep + wait so SIGTERM is handled promptly instead of being
  # queued behind a blocking sleep.
  sleep "${PW_TMUX_WATCH_INTERVAL:-10}" &
  wait $!
  tmux -u has-session -t _keepalive 2>/dev/null || exit 1
done
