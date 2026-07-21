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
