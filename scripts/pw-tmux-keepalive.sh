#!/bin/bash
# Persistent tmux server for Project Workbench terminals.
#
# Runs as the foreground process of the dedicated `pw-tmux` sidecar container so
# the tmux server — and therefore every project's shells, running agents, and
# scrollback — lives in the SIDECAR's cgroup. That means it SURVIVES a restart of
# the main `project-workbench` app container (dashboard/API + ttyd), which is what
# used to wipe every project's terminal on a `systemctl restart`.
#
# The app container attaches to this same server over a shared Unix socket in
# $TMUX_TMPDIR, which is a host bind mount (/opt/project-workbench/run/tmux)
# present in both containers. server.js's tmux clients and ttyd's `tmux attach`
# all talk to this server because they inherit the same TMUX_TMPDIR.
#
# Sessions only ever die when THIS container is stopped/rebuilt (rare — a
# Containerfile change). Day-to-day app-code deploys use a node-only reload and
# never touch this server. See DEPLOY.md.
set -u

: "${TMUX_TMPDIR:=/opt/project-workbench/run/tmux}"
export TMUX_TMPDIR
mkdir -p "$TMUX_TMPDIR"
chmod 0700 "$TMUX_TMPDIR" 2>/dev/null || true

# Bring up the server with a keepalive session (so it never auto-exits) and set
# exit-empty off as a belt-and-suspenders guard. `_keepalive` does NOT start with
# `pw_`, so server.js's orphan-sweep (which only kills `pw_*` sessions absent from
# projects.json) leaves it alone.
tmux -u start-server 2>/dev/null || true
tmux -u set-option -s exit-empty off 2>/dev/null || true
if ! tmux -u has-session -t _keepalive 2>/dev/null; then
  tmux -u new-session -d -s _keepalive 'while true; do sleep 3600; done'
fi

# Idle in the foreground so the container (and the server's cgroup) stay up; on
# SIGTERM/SIGINT exit cleanly and let podman tear the container down.
term() { exit 0; }
trap term TERM INT
tail -f /dev/null &
wait $!
