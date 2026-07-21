#!/usr/bin/env bash
# Hot-deploy helper for a container-mode (PW_DEPLOY_MODE=container) instance.
#
#   ./deploy-local.sh          # hot deploy: copy app/server.js + scripts/*, restart node only
#   ./deploy-local.sh --full   # also copy Containerfile + rebuild image (RESTART kills sessions)
#
# Hot deploy (default): the entrypoint respawns node in ~2s; tmux/terminal
# sessions survive. Full rebuild is only needed when the Containerfile changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${PW_SOURCE_DIR:-/opt/project-workbench/source}"   # host-side source checkout (bind-mounted)
LIVE_APP="/opt/project-workbench/app"
LIVE_SCRIPTS="/opt/project-workbench/scripts"
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

if $FULL_REBUILD; then
  $INSIDE_CONTAINER && die "--full rebuild must be run from the host (outside the container)."
  warn "--full: rebuilds the image and RESTARTS the service (kills all tmux/terminal sessions)."
  read -rp "Continue? [y/N] " confirm; [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
  log "Copying source..."
  sudo cp "$REPO_DIR/app/server.js" "$SRC/app/server.js"
  sudo cp "$REPO_DIR/scripts/"*     "$SRC/scripts/"
  sudo cp "$REPO_DIR/Containerfile" "$SRC/Containerfile"
  log "Rebuilding image $IMAGE..."
  sudo bash -c "cd '$SRC' && podman build --network=host --no-cache -t '$IMAGE' ."
  log "Restarting $SERVICE (kills sessions)..."
  sudo systemctl restart "$SERVICE"
  log "Done — wait ~10s then reload the dashboard."
elif $INSIDE_CONTAINER; then
  log "Hot deploy (inside container): copying app/server.js + scripts/*..."
  cp "$REPO_DIR/app/server.js" "$LIVE_APP/server.js"
  cp "$REPO_DIR/scripts/"*     "$LIVE_SCRIPTS/" 2>/dev/null || true
  log "Restarting PW node..."; restart_pw_node
  log "Done — node restarts in ~2s; terminal sessions unaffected."
else
  log "Hot deploy (from host): copying app/server.js + scripts/*..."
  sudo cp "$REPO_DIR/app/server.js" "$SRC/app/server.js"
  sudo cp "$REPO_DIR/scripts/"*     "$SRC/scripts/" 2>/dev/null || true
  log "Restarting PW node inside $CONTAINER..."
  sudo podman exec "$CONTAINER" bash -c '
    for p in $(pgrep -x node); do
      [ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "/opt/project-workbench/app" ] && kill "$p" || true
    done'
  log "Done — node restarts in ~2s; terminal sessions unaffected."
fi
