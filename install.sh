#!/usr/bin/env bash
# Project Workbench one-shot installer.
#
# This sets up a LAN-internal browser-terminal workbench for AI coding CLIs
# (Claude Code, Codex, Copilot). It is NOT designed to face the public
# Internet — once a user signs in to the app they get shell access inside
# every project workspace. Keep it behind a VPN / Cloudflare Access / similar
# until later phases lock the runtime down further.
#
# Quick start:
#   curl -fsSL https://raw.githubusercontent.com/JD2005L/ProjectWorkbench/main/install.sh | sudo bash
#
# Env-var overrides (set before running):
#   PW_INSTALL_DIR              Where to install (default: /opt/project-workbench)
#   PW_HTTP_PORT                nginx listen port (default: 80)
#   PW_REPO                     Git URL to clone from (default: this repo)
#   PW_REF                      Git branch/tag (default: main)
#   PW_BOOTSTRAP_ADMIN_USER     Initial admin username on a fresh install (default: admin)
#   PW_BOOTSTRAP_ADMIN_PASSWORD Initial admin password (default: auto-generated, printed once at the end)

set -euo pipefail

# ---- host-mode only ----------------------------------------------------------
# DEPLOY.md defines this installer as the bare-metal/VM HOST path; container mode
# is covered separately by that document. The portable invariant that matters:
# this must never stand up the host tmux owner beside an active container sidecar
# owner, because the two would own DIFFERENT sockets — the host unit taking the
# per-user default socket while the real server lives on the bind-mounted one.
# That is the "second, invisible server" failure, reached from the other side.
#
# So: refuse, loudly and early. Do NOT conditionally install a partial container
# topology here — inventing container owner topology in this script is explicitly
# out of scope.
if [ "$(printf '%s' "${PW_DEPLOY_MODE:-host}" | tr '[:upper:]' '[:lower:]')" = "container" ]; then
  echo "install.sh: refusing — PW_DEPLOY_MODE=container." >&2
  echo "  This installer is the host-mode path only. Container deployments are covered by DEPLOY.md" >&2
  echo "  and are owned by the pw-tmux sidecar; installing the host owner unit beside it would create" >&2
  echo "  a second tmux server on a different socket." >&2
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files pw-tmux.service >/dev/null 2>&1 && systemctl is-enabled pw-tmux.service >/dev/null 2>&1; then
    echo "install.sh: refusing — the container sidecar owner pw-tmux.service is enabled on this host." >&2
    echo "  Installing the host owner unit beside it would stand up a competing tmux server owner." >&2
    echo "  Disable the sidecar owner first, or install on a host that is not running container mode." >&2
    exit 1
  fi
fi



PW_INSTALL_DIR="${PW_INSTALL_DIR:-/opt/project-workbench}"
PW_HTTP_PORT="${PW_HTTP_PORT:-80}"
PW_REPO="${PW_REPO:-https://github.com/JD2005L/ProjectWorkbench.git}"
PW_REF="${PW_REF:-main}"
PW_BOOTSTRAP_ADMIN_USER="${PW_BOOTSTRAP_ADMIN_USER:-admin}"
PW_BOOTSTRAP_ADMIN_PASSWORD="${PW_BOOTSTRAP_ADMIN_PASSWORD:-}"
PW_USER=admin   # currently hardcoded; the bundled systemd units run as admin

SRC_DIR="$PW_INSTALL_DIR/source"
APP_DIR="$PW_INSTALL_DIR/app"
WORKSPACES_DIR="$PW_INSTALL_DIR/workspaces"
MEMORY_DIR="$PW_INSTALL_DIR/memory"
CONF_DIR="/etc/project-workbench"
USERS_JSON="$CONF_DIR/users.json"
SESSIONS_JSON="/var/lib/project-workbench/sessions.json"
AUDIT_LOG="/var/log/project-workbench/audit.log"
NGINX_SITE=/etc/nginx/sites-available/project-workbench
NGINX_LINK=/etc/nginx/sites-enabled/project-workbench
PW_AUTH_BACKUP_DIR="/var/backups/project-workbench"

log()  { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash install.sh"
[ -r /etc/os-release ] || die "Cannot detect OS (no /etc/os-release)."
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) : ;;
  *) die "Only Ubuntu and Debian are supported (detected: ${ID:-unknown}). Use the manual install in README.md." ;;
esac

log "Project Workbench installer — target: $PW_INSTALL_DIR ($PW_REPO @ $PW_REF)"
log "Reminder: this host should be LAN-internal only. Authenticated users get shell access."

export DEBIAN_FRONTEND=noninteractive

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
node_major_ok() { [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && [ "$NODE_MAJOR" -ge 18 ]; }
# Whether THIS host's node came from NodeSource rather than Debian. Their `nodejs`
# package bundles npm and deliberately conflicts with Debian's separate `npm`.
node_is_nodesource() {
  dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -qi nodesource
}

# The Node runtime is requested from apt ONLY when this host lacks a usable one.
#
# This step used to name `nodejs npm` unconditionally, which aborted the ENTIRE
# install on every NodeSource host — the shape this installer's own error message
# tells you to create:
#
#   Depends: node-npm-bundled but it is not going to be installed
#   … Depends: nodejs:any
#   E: Unable to correct problems, you have held broken packages.   (exit 100)
#
# NodeSource's `nodejs` OWNS /usr/bin/npm, so Debian's `npm` package is redundant
# there, and it cannot be co-installed: it depends on a chain of `node-*` packages
# plus `nodejs:any`. Because apt resolves the request as a whole, that one
# unsatisfiable token stopped nginx, ttyd, tmux and everything else from being
# installed too — a clean reinstall could not complete at all.
#
# Asking per-package for what is actually missing keeps a bare-Debian install
# byte-identical in behavior (both are absent, so both are requested) while making
# the already-provisioned host a no-op instead of a hard failure.
PW_APT_PACKAGES=(nginx apache2-utils ttyd git curl ca-certificates jq tmux sudo openssl)
node_major_ok || PW_APT_PACKAGES+=(nodejs)
command -v npm >/dev/null 2>&1 || PW_APT_PACKAGES+=(npm)

# A NodeSource host whose runtime is too old is the one case apt cannot repair:
# pulling Debian's nodejs/npm over it reproduces exactly the conflict above. Say so
# in the installer's own voice rather than letting apt fail with a package-solver
# wall of text that never names the real problem.
if node_is_nodesource && ! node_major_ok; then
  die "Node.js 18+ is required (found: ${NODE_VERSION:-not installed}), and this host's node comes from NodeSource.
    apt cannot upgrade across that — Debian's nodejs/npm conflict with the NodeSource package.
    Upgrade NodeSource in place, then rerun:
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs
    sudo bash $0"
fi

log "Installing apt packages…"
apt-get update -qq
apt-get install -y --no-install-recommends "${PW_APT_PACKAGES[@]}" >/dev/null

# Re-read: apt may have just installed or upgraded it.
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
if ! node_major_ok; then
  die "Node.js 18+ is required (found: ${NODE_VERSION:-not installed}). Install NodeSource Node 20 and rerun:
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs
    sudo bash $0"
fi

# npm is what actually installs the dashboard's dependencies further down, and on a
# NodeSource host it arrives with `nodejs` rather than as its own package — so check
# the COMMAND, never the package.
if ! command -v npm >/dev/null 2>&1; then
  die "npm is required but was not found after installing packages. On a NodeSource host npm ships with the nodejs package; reinstall it and rerun:
    sudo apt-get install --reinstall -y nodejs
    sudo bash $0"
fi

if ! command -v ttyd >/dev/null 2>&1; then
  die "ttyd is required but was not found in apt. On Debian you may need to enable backports, or install from https://github.com/tsl0922/ttyd/releases and rerun."
fi

if ! id "$PW_USER" >/dev/null 2>&1; then
  log "Creating user $PW_USER…"
  adduser --disabled-password --gecos '' "$PW_USER" >/dev/null
  usermod -aG sudo "$PW_USER"
fi

log "Creating directory tree…"
install -d -m 0755 "$PW_INSTALL_DIR" "$APP_DIR" "$CONF_DIR"
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 "$WORKSPACES_DIR"
install -d -o "$PW_USER" -g "$PW_USER" -m 0700 "$MEMORY_DIR"
install -d -m 0755 /var/lib/project-workbench
# pending/ must be writable by $PW_USER: the Claude Stop hook (running as that
# user) drops per-project "turn finished" markers here for the dashboard rail.
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 /var/lib/project-workbench/pending
install -d -m 0750 /var/log/project-workbench

if [ -d "$SRC_DIR/.git" ]; then
  log "Updating source tree…"
  git -C "$SRC_DIR" fetch --quiet origin
  git -C "$SRC_DIR" checkout --quiet "$PW_REF"
  git -C "$SRC_DIR" reset --quiet --hard "origin/$PW_REF" 2>/dev/null || git -C "$SRC_DIR" pull --quiet --ff-only
else
  log "Cloning $PW_REPO ($PW_REF)…"
  git clone --quiet --branch "$PW_REF" "$PW_REPO" "$SRC_DIR"
fi

log "Installing dashboard app…"
cp -a "$SRC_DIR/app/." "$APP_DIR/"
# The stdio MCP adapter documented in docs/orchestrator-api.md lives outside app/, so it needs its
# own copy — without this the documented entry point simply does not exist on a deployed instance.
if [ -d "$SRC_DIR/bin" ]; then
  mkdir -p "$PW_INSTALL_DIR/bin"
  cp -a "$SRC_DIR/bin/." "$PW_INSTALL_DIR/bin/"
  chmod +x "$PW_INSTALL_DIR"/bin/* 2>/dev/null || true
fi
# AGENTS.md is served unauthenticated at /agents.md so external automation
# can discover the instance. Mirror it next to the dashboard so the route
# resolves even when the source tree is wiped after install.
install -m 0644 "$SRC_DIR/AGENTS.md" "$APP_DIR/AGENTS.md" 2>/dev/null || true
( cd "$APP_DIR" && npm install --omit=dev --silent --no-audit --no-fund )

if [ ! -f "$PW_INSTALL_DIR/projects.json" ]; then
  echo '[]' > "$PW_INSTALL_DIR/projects.json"
  chown root:root "$PW_INSTALL_DIR/projects.json"
  chmod 0644 "$PW_INSTALL_DIR/projects.json"
fi

log "Seeding shared memory templates…"
for f in CLAUDE.md TOOLS.md DECISIONS.md; do
  [ -f "$MEMORY_DIR/$f" ] || install -o "$PW_USER" -g "$PW_USER" -m 0640 "$SRC_DIR/config/shared-memory/$f" "$MEMORY_DIR/$f"
done
[ -f "$MEMORY_DIR/CREDENTIALS.md" ] || install -o "$PW_USER" -g "$PW_USER" -m 0600 "$SRC_DIR/config/shared-memory/CREDENTIALS.md.example" "$MEMORY_DIR/CREDENTIALS.md"

install -m 0644 "$SRC_DIR/config/empty-mcp.json" "$CONF_DIR/empty-mcp.json"
[ -f "$CONF_DIR/claude-wrapper.env" ] || install -m 0644 "$SRC_DIR/config/claude-wrapper.env.example" "$CONF_DIR/claude-wrapper.env"

log "Seeding per-user CLAUDE.md hints…"
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 "/home/$PW_USER/.claude"
if [ ! -f "/home/$PW_USER/.claude/CLAUDE.md" ]; then
  cat > "/home/$PW_USER/.claude/CLAUDE.md" <<EOF
# ProjectWorkbench User Memory

This account is a Project Workbench instance. Before doing durable work,
read \`$MEMORY_DIR/CLAUDE.md\` and follow this instance's MCP policy
from \`$CONF_DIR/claude-wrapper.env\`.
EOF
  chown "$PW_USER:$PW_USER" "/home/$PW_USER/.claude/CLAUDE.md"
  chmod 0640 "/home/$PW_USER/.claude/CLAUDE.md"
fi
if [ ! -f "$WORKSPACES_DIR/CLAUDE.md" ]; then
  cat > "$WORKSPACES_DIR/CLAUDE.md" <<EOF
# ProjectWorkbench Workspace Root

All PW project terminals share local memory at \`$MEMORY_DIR\`.
Read \`$MEMORY_DIR/CLAUDE.md\` before durable work.

## Front-end standard: force animations (ignore OS "reduce motion")
All PW web projects must display animations regardless of the OS \`prefers-reduced-motion\`
setting (spuriously on for RDP/VMs/"best performance" Windows). Include the drop-in from
\`ProjectWorkbench/standards/force-motion/\` (one inline \`<script>\`, first in \`<head>\`) and never
self-gate animations. See \`$MEMORY_DIR/DECISIONS.md\` (2026-07-15).
EOF
  chown "$PW_USER:$PW_USER" "$WORKSPACES_DIR/CLAUDE.md"
  chmod 0640 "$WORKSPACES_DIR/CLAUDE.md"
fi

log "Installing helper scripts…"
install -m 0755 "$SRC_DIR/scripts/project-terminal-start" /usr/local/bin/project-terminal-start
install -m 0755 "$SRC_DIR/scripts/project-preview-start"  /usr/local/bin/project-preview-start
install -m 0755 "$SRC_DIR/scripts/setup-terminal-start"   /usr/local/bin/setup-terminal-start
install -m 0755 "$SRC_DIR/scripts/update-claude-code"     /usr/local/sbin/update-claude-code
install -m 0755 "$SRC_DIR/scripts/pw-user"                /usr/local/sbin/pw-user
install -m 0755 "$SRC_DIR/scripts/pw-tmux-save"           /usr/local/bin/pw-tmux-save
install -m 0755 "$SRC_DIR/scripts/pw-tmux-restore"        /usr/local/bin/pw-tmux-restore
# Flat is correct here, unlike the two helpers below: plain bash, no relative
# import to break. Repairs a workspace tree that a root process wrote into before
# the writers were dropped to the pane account.
install -m 0755 "$SRC_DIR/scripts/pw-fix-workspace-ownership" /usr/local/sbin/pw-fix-workspace-ownership

# The ownership gate is installed BESIDE app/, then symlinked onto PATH.
#
# Every server-creation seam refuses unless this is on PATH — a missing helper is a
# refusal, not a skip — so shipping it is not optional. But shipping it is not
# sufficient either, and that is the part a presence check cannot see:
# pw-tmux-assert-owner is an ES module that imports `../app/tmux-owner.js` RELATIVE
# TO ITSELF, deliberately, so the shell gate and the JS gate share one verdict
# function and cannot drift. Installed flat into /usr/local/bin, that resolves to
# /usr/local/app/tmux-owner.js, which no deployment has — so the helper died with
# ERR_MODULE_NOT_FOUND and exited nonzero on EVERY invocation. Since the seams
# treat "cannot execute the helper" as fatal, that is a total host-mode outage: no
# project or setup terminal starts, and pw-tmux-restore refuses, so sessions are
# never restored at boot.
#
# Installing under $PW_INSTALL_DIR/scripts puts app/ exactly one level up, so the
# relative import is correct by construction. The /usr/local/bin symlink keeps it
# on PATH for the seams; node resolves an ES module's imports against its REALPATH,
# so reaching it through the link lands on the same app/ directory.
install -d -m 0755 "$PW_INSTALL_DIR/scripts"
install -m 0755 "$SRC_DIR/scripts/pw-tmux-assert-owner"   "$PW_INSTALL_DIR/scripts/pw-tmux-assert-owner"
ln -sfn "$PW_INSTALL_DIR/scripts/pw-tmux-assert-owner"    /usr/local/bin/pw-tmux-assert-owner
# Same shape, same reason: pw-box-remediate imports ../app/workspace-box-owner.js
# relative to itself, so it goes BESIDE app/ and reaches PATH through a symlink.
# Installed flat it would resolve /usr/local/app/… and die ERR_MODULE_NOT_FOUND —
# the Round 12 defect, which is why that is now the pattern rather than a habit.
install -m 0755 "$SRC_DIR/scripts/pw-box-remediate"       "$PW_INSTALL_DIR/scripts/pw-box-remediate"
ln -sfn "$PW_INSTALL_DIR/scripts/pw-box-remediate"        /usr/local/sbin/pw-box-remediate
# The owner unit's ExecStart. It has to be installed BEFORE the unit is enabled at
# the end of this script, and it has to be installed at all: a controlled host
# deployment failed here with 203/EXEC because the host unit named the CONTAINER
# path (/opt/project-workbench/scripts/…, which only the Containerfile creates)
# and this installer shipped the file nowhere. Host mode keeps its helpers here.
install -m 0755 "$SRC_DIR/scripts/pw-tmux-keepalive.sh"   /usr/local/bin/pw-tmux-keepalive.sh

# State dir for tmux-session persistence (manifest + captured scrollback).
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 /var/lib/project-workbench/tmux-persist
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 /var/lib/project-workbench/tmux-persist/content

if [ -f "$SRC_DIR/config/tmux.conf" ]; then
  install -o "$PW_USER" -g "$PW_USER" -m 0644 "$SRC_DIR/config/tmux.conf" "/home/$PW_USER/.tmux.conf"
fi

log "Installing systemd units…"
# Units are RENDERED, not copied. They used to hard-code /opt/project-workbench and
# the `admin` account, which made two advertised contracts untrue: PW_INSTALL_DIR
# produced an install whose units pointed at a tree nothing populated, and the tmux
# owner unit named an account the installer had not necessarily created. The owner
# unit's account is load-bearing — tmux's default socket is per-UID, so an owner on
# the wrong account supervises a socket no seam ever looks at.
PW_GROUP="${PW_GROUP:-$PW_USER}"
PW_HOME="$(getent passwd "$PW_USER" 2>/dev/null | cut -d: -f6)"
[ -n "$PW_HOME" ] || PW_HOME="/home/$PW_USER"

render_unit() {
  render_tmp="$(mktemp)"
  sed -e "s|@PW_INSTALL_DIR@|$PW_INSTALL_DIR|g" \
      -e "s|@PW_USER@|$PW_USER|g" \
      -e "s|@PW_GROUP@|$PW_GROUP|g" \
      -e "s|@PW_HOME@|$PW_HOME|g" \
      "$1" > "$render_tmp"
  # A placeholder that survives rendering would reach systemd verbatim, so it is
  # fatal here rather than a warning discovered by a failing unit later.
  if grep -qE '@PW_[A-Z_]+@' "$render_tmp"; then
    rm -f "$render_tmp"
    die "unit $1 still contains an unrendered @PW_…@ placeholder"
  fi
  install -m 0644 "$render_tmp" "$2"
  rm -f "$render_tmp"
}

render_unit "$SRC_DIR/systemd/project-workbench.service"       /etc/systemd/system/project-workbench.service
render_unit "$SRC_DIR/systemd/project-terminal@.service"       /etc/systemd/system/project-terminal@.service
render_unit "$SRC_DIR/systemd/project-setup-terminal.service"  /etc/systemd/system/project-setup-terminal.service
render_unit "$SRC_DIR/systemd/project-preview@.service"        /etc/systemd/system/project-preview@.service
render_unit "$SRC_DIR/systemd/claude-code-update.service"      /etc/systemd/system/claude-code-update.service
render_unit "$SRC_DIR/systemd/claude-code-update.timer"        /etc/systemd/system/claude-code-update.timer
render_unit "$SRC_DIR/systemd/pw-tmux-persist.service"         /etc/systemd/system/pw-tmux-persist.service
render_unit "$SRC_DIR/systemd/pw-tmux-save.service"            /etc/systemd/system/pw-tmux-save.service
render_unit "$SRC_DIR/systemd/pw-tmux-save.timer"              /etc/systemd/system/pw-tmux-save.timer
# Drop-in for app-level auth enforcement (Phase 1: defaults to OFF for safe
# rollout — flip PW_AUTH_ENFORCE=true after creating an admin via `pw-user`).
# Only seed the default when none exists: a redeploy must never silently flip an
# operator's PW_AUTH_ENFORCE=true back to OFF on a live instance.
install -d -m 0755 /etc/systemd/system/project-workbench.service.d
[ -f /etc/systemd/system/project-workbench.service.d/auth.conf ] || \
  install -m 0644 "$SRC_DIR/systemd/project-workbench.service.d/auth.conf" /etc/systemd/system/project-workbench.service.d/auth.conf
systemctl daemon-reload

# The one non-secret environment contract (app/env-schema.js). Rendered from the
# schema rather than duplicated here, so this file cannot drift from the module
# the consumers validate against. Seeded only when absent: an operator's tuning
# must survive an update, exactly like auth.conf.
#
# NON-SECRET ONLY — paths, one enum, one boolean. Key MATERIAL never lands here;
# PW_SECRET_KEY_PATH names where the key lives, which is configuration.
if [ ! -f /etc/project-workbench/pw.env ]; then
  if command -v node >/dev/null 2>&1; then
    install -d -m 0755 /etc/project-workbench
    if node --input-type=module -e "
      import { renderEnvFile } from '$SRC_DIR/app/env-schema.js';
      process.stdout.write(renderEnvFile(process.env));
    " > /etc/project-workbench/pw.env.tmp 2>/dev/null; then
      mv /etc/project-workbench/pw.env.tmp /etc/project-workbench/pw.env
      chmod 0644 /etc/project-workbench/pw.env
      log "Seeded /etc/project-workbench/pw.env from the environment contract"
    else
      rm -f /etc/project-workbench/pw.env.tmp
      warn "could not render /etc/project-workbench/pw.env — units fall back to schema defaults"
    fi
  else
    warn "node not found; skipped seeding /etc/project-workbench/pw.env"
  fi
fi


# tmux-session persistence: restore-on-boot unit + periodic snapshot timer.
# enable --now so the timer starts snapshotting immediately and the persist unit
# is armed (its restore is a no-op until a manifest exists).
systemctl enable --now pw-tmux-persist.service >/dev/null 2>&1 || warn "could not enable pw-tmux-persist.service"
systemctl enable --now pw-tmux-save.timer >/dev/null 2>&1 || warn "could not enable pw-tmux-save.timer"

if ! command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code CLI globally…"
  npm install -g --silent --no-audit --no-fund @anthropic-ai/claude-code >/dev/null
fi
log "Refreshing /usr/local/bin/claude wrapper…"
/usr/local/sbin/update-claude-code >>/var/log/claude-code-update.log 2>&1 || warn "update-claude-code reported a non-zero status — continuing."

# Project Workbench relies on app-level users/sessions. nginx no longer
# requires Basic Auth. A legacy /etc/nginx/.htpasswd from an older PW install
# is harmless and ignored — remove it manually once you've confirmed app login
# works (see end-of-install output).

# --- Auth bootstrap -----------------------------------------------------------
log "Preparing auth runtime files…"
install -d -m 0755 "$PW_AUTH_BACKUP_DIR"
BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -f "$USERS_JSON" ]; then
  cp -a "$USERS_JSON" "$PW_AUTH_BACKUP_DIR/users.json.$BACKUP_STAMP"
else
  printf '{"users":[]}\n' > "$USERS_JSON"
  chmod 0600 "$USERS_JSON"
fi
if [ -f "$SESSIONS_JSON" ]; then
  cp -a "$SESSIONS_JSON" "$PW_AUTH_BACKUP_DIR/sessions.json.$BACKUP_STAMP"
else
  printf '{"sessions":[]}\n' > "$SESSIONS_JSON"
  chmod 0600 "$SESSIONS_JSON"
fi
[ -f "$AUDIT_LOG" ] || { : > "$AUDIT_LOG"; chmod 0640 "$AUDIT_LOG"; }

# Create an initial admin if (and only if) users.json contains zero users.
BOOTSTRAP_DID_CREATE_ADMIN=0
BOOTSTRAP_INITIAL_PASSWORD=""
USER_COUNT="$(jq -r '.users | length' "$USERS_JSON" 2>/dev/null || echo 0)"
if [ "$USER_COUNT" -eq 0 ]; then
  if [ -n "$PW_BOOTSTRAP_ADMIN_PASSWORD" ]; then
    BOOTSTRAP_INITIAL_PASSWORD="$PW_BOOTSTRAP_ADMIN_PASSWORD"
  else
    BOOTSTRAP_INITIAL_PASSWORD="$(openssl rand -base64 21 | tr -d '+/=' | cut -c1-24)"
  fi
  /usr/local/sbin/pw-user add "$PW_BOOTSTRAP_ADMIN_USER" --role admin --projects '*' --password "$BOOTSTRAP_INITIAL_PASSWORD" >/dev/null
  BOOTSTRAP_DID_CREATE_ADMIN=1
  log "Bootstrap admin '$PW_BOOTSTRAP_ADMIN_USER' created (rotate password ASAP via Settings → Users & Roles)."
else
  log "Auth users already present ($USER_COUNT) — keeping existing users.json untouched."
fi

if [ -f /etc/nginx/.htpasswd ]; then
  warn "Legacy /etc/nginx/.htpasswd detected. nginx no longer reads it. Remove with: sudo rm /etc/nginx/.htpasswd  (after verifying app login works)."
fi

log "Writing nginx site (listen $PW_HTTP_PORT)…"
# Minimal bootstrap site; the dashboard regenerates this file with the full
# /pty/, /preview/, and Referer-routing blocks once it has projects to serve.
cat > "$NGINX_SITE" <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen $PW_HTTP_PORT default_server;
    server_name _;
    client_max_body_size 100m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf "$NGINX_SITE" "$NGINX_LINK"
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx config test failed. Review $NGINX_SITE."

log "Starting services…"
systemctl enable project-workbench.service >/dev/null
# Restart (not just enable --now) so a re-run actually loads the freshly copied
# app code instead of leaving the previous process running on the old code.
systemctl restart project-workbench.service
systemctl reload nginx
systemctl enable --now claude-code-update.timer >/dev/null

# Once the dashboard is up, ask it to regenerate the real nginx config so any
# existing projects.json entries get their /pty/ and /preview/ routes. The
# Origin header satisfies the CSRF guard; direct 127.0.0.1 callers also bypass
# the admin gate (see isTrustedLocal), so this works whether or not app-auth
# enforcement is on.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:3000/healthz; then break; fi
  sleep 1
done
curl -fsS -X POST -H 'Origin: http://127.0.0.1:3000' http://127.0.0.1:3000/api/setup/heal/nginx -o /dev/null || warn "Heal endpoint did not respond; nginx still serves the bootstrap site."

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
URL_SUFFIX="$( [ "$PW_HTTP_PORT" = "80" ] && echo '' || printf ':%s' "$PW_HTTP_PORT" )"

printf '\n'
printf '────────────────────────────────────────────────\n'
printf '  Project Workbench is up.\n'
printf '────────────────────────────────────────────────\n'
printf '  URL:           http://%s%s/login\n' "${HOST_IP:-<host-ip>}" "$URL_SUFFIX"
if [ "$BOOTSTRAP_DID_CREATE_ADMIN" = "1" ]; then
  printf '\n'
  printf '  Initial admin (CREATED NOW — rotate ASAP):\n'
  printf '    Username:    %s\n' "$PW_BOOTSTRAP_ADMIN_USER"
  printf '    Password:    %s\n' "$BOOTSTRAP_INITIAL_PASSWORD"
  printf '    Where:       %s\n' "$USERS_JSON"
  printf '    Rotate:      sudo /usr/local/sbin/pw-user passwd %s\n' "$PW_BOOTSTRAP_ADMIN_USER"
  printf '                 or Settings → Users & Roles → Password\n'
else
  printf '  Existing users in %s preserved (count: %s).\n' "$USERS_JSON" "$USER_COUNT"
fi
printf '\n'
printf '  Source tree:   %s\n' "$SRC_DIR"
printf '  Workspaces:    %s\n' "$WORKSPACES_DIR"
printf '  Registry:      %s\n' "$PW_INSTALL_DIR/projects.json"
printf '  Users:         %s\n' "$USERS_JSON"
printf '  Sessions:      %s\n' "$SESSIONS_JSON"
printf '  Audit log:     %s\n' "$AUDIT_LOG"
printf '  Backups:       %s\n' "$PW_AUTH_BACKUP_DIR"
printf '  Logs:          journalctl -u project-workbench.service -f\n'
printf '\n'
printf '  Next steps:\n'
printf '    1. Open %shttp://%s%s/login%s and sign in.\n' '' "${HOST_IP:-<host-ip>}" "$URL_SUFFIX" ''
printf '    2. Open Settings → CLIs & Sign-in to install + sign in Claude Code (or another CLI).\n'
printf '    3. Open Settings → Users & Roles to add more users (admin / developer / content_editor / viewer).\n'
printf '    4. Open Manage Projects (from the dashboard) to clone your first repo.\n'
printf '    5. When ready, flip app-auth enforcement to ON:\n'
printf '         sudo sed -i %ss/PW_AUTH_ENFORCE=false/PW_AUTH_ENFORCE=true/%s /etc/systemd/system/project-workbench.service.d/auth.conf\n' "'" "'"
printf '         sudo systemctl daemon-reload && sudo systemctl restart project-workbench.service\n'
printf '       Until then, anonymous browser requests are treated as an implicit admin (soft mode).\n'
printf '\n'
printf '  Re-run this installer at any time — it is idempotent and preserves users.json/sessions.\n'
printf '────────────────────────────────────────────────\n'

# ---- tmux owner unit (host mode) --------------------------------------------
# The shared tmux server must live in ITS OWN cgroup, not in whichever terminal
# happened to create it first. Failure here is FATAL: a half-installed owner is
# how the server ends up back inside a ttyd unit.
render_unit "$SRC_DIR/systemd/pw-tmux-server.service" /etc/systemd/system/pw-tmux-server.service

# Soft memory ceiling for the owner. 64-BIT SHELL ARITHMETIC ON PURPOSE: the
# obvious `awk '{printf "%d", ...}'` clamps at INT_MAX under mawk (the default awk
# on Debian), which would impose a ~2 GiB ceiling on every host with more than
# ~2.73 GiB of RAM — throttling exactly the workload this ceiling protects.
pw_mem_kb=$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)
if [ -n "$pw_mem_kb" ]; then
  pw_mem_high=$(( pw_mem_kb * 1024 * 3 / 4 ))
  mkdir -p /etc/systemd/system/pw-tmux-server.service.d
  printf '[Service]\nMemoryHigh=%s\n' "$pw_mem_high" > /etc/systemd/system/pw-tmux-server.service.d/memory.conf
fi

systemctl daemon-reload
systemctl enable --now pw-tmux-server.service
