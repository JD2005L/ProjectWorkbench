#!/bin/bash
# Container entrypoint (PW_DEPLOY_MODE=container): keeps the container alive and
# restarts the node app on exit. tmux/ttyd terminal processes survive node
# restarts, so a hot code redeploy is just "kill the node PID" (see deploy-local.sh).
trap 'kill $NODE_PID 2>/dev/null; exit 0' SIGTERM SIGINT

# OPTIONAL, env-specific self-heal hooks. Both are skipped when absent, so a base
# install needs neither:
#  - ensure-deploy-toolchain.sh: restores the PW_DEPLOY_CENTRE toolchain
#    (dotnet/pywinrm/smbclient) if the image predates it.
#  - ensure-notify-wiring.sh: (re)installs the "turn finished" pending-marker dir
#    + Claude Stop hook used by the dashboard rail.
[ -x /opt/project-workbench/scripts/ensure-deploy-toolchain.sh ] && \
  /opt/project-workbench/scripts/ensure-deploy-toolchain.sh >/dev/null 2>&1 &
[ -x /opt/project-workbench/scripts/ensure-notify-wiring.sh ] && \
  /opt/project-workbench/scripts/ensure-notify-wiring.sh || true

# When TMUX_TMPDIR points at a persistent sidecar's socket, wait for that server
# so the app's first tmux client doesn't auto-spawn a server inside THIS
# container's cgroup (which would die on the next app restart, defeating session
# persistence). Bounded (~10s); proceeds anyway so a missing sidecar never blocks.
if [ -n "${TMUX_TMPDIR:-}" ]; then
  for _i in $(seq 1 50); do
    tmux -u has-session -t _keepalive 2>/dev/null && break
    sleep 0.2
  done
  # THEN wait for the owner to finish replaying saved sessions.
  #
  # `_keepalive` is NOT a sufficient barrier and using it as one silently defeated
  # rebuild restoration: the owner creates _keepalive to bring the server into
  # existence BEFORE it replays, so this loop released immediately, node booted,
  # its boot auto-start created blank pw_* sessions, and pw-tmux-restore then
  # skipped every one of them as "already exists". Fence on the owner's published
  # outcome instead (@pw_restore_state: complete / no-manifest / failed-N / off).
  #
  # Bounded and non-fatal, exactly like the loop above: an owner too old to
  # publish the option, or a wedged replay, must never stop the dashboard from
  # starting. It warns and proceeds.
  _rs=""
  _rs_max="${PW_RESTORE_BARRIER_TICKS:-300}"   # x0.2s => ~60s default
  _i=0
  while [ "$_i" -lt "$_rs_max" ]; do
    _rs=$(tmux -u show-options -sv @pw_restore_state 2>/dev/null || true)
    [ -n "$_rs" ] && break
    _i=$((_i + 1))
    sleep 0.2
  done
  if [ -n "$_rs" ]; then
    echo "[entrypoint] tmux owner reports restore state: $_rs"
  else
    echo "[entrypoint] WARNING: no @pw_restore_state after $((_rs_max / 5))s;" >&2
    echo "[entrypoint]          starting anyway. If the owner supports replay, a blank" >&2
    echo "[entrypoint]          session created now may pre-empt it." >&2
  fi
fi

cd /opt/project-workbench/app
while true; do
  node server.js &
  NODE_PID=$!
  wait $NODE_PID
  EXIT_CODE=$?
  echo "[entrypoint] node exited with code $EXIT_CODE, restarting in 2s..."
  sleep 2
done
