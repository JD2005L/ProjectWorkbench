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

# --- Deploy-mode gate (GOA-3) -------------------------------------------------
#
# This installer is host-mode-only by construction: it installs the per-project systemd terminal
# units and, now, the dedicated tmux owner. It has never installed systemd/pw-tmux.service, the
# container-mode owner — that unit is instance-managed.
#
# Run unchanged against a container-mode host, it would stand up a SECOND tmux-server owner on the
# per-user default socket while the real one lives on the sidecar's bind-mounted TMUX_TMPDIR: the
# "second, invisible server" the keepalive's own comment warns about, reached from the other
# direction. Combined with the fail-closed ownership behaviour below, an ungated run would also make
# this installer unrunnable there.
#
# So the mode is resolved once, from an existing environment contract if there is one, and the
# host-only pieces are gated on it. An ambiguous mode stops the install rather than guessing — same
# rule as app/deploy-mode.js.
PW_DEPLOY_MODE="${PW_DEPLOY_MODE:-}"
if [ -z "$PW_DEPLOY_MODE" ] && [ -r "$CONF_DIR/pw.env" ]; then
  PW_DEPLOY_MODE="$(sed -n 's/^[[:space:]]*PW_DEPLOY_MODE[[:space:]]*=[[:space:]]*["'"'"']\{0,1\}\([A-Za-z]*\).*/\1/p' "$CONF_DIR/pw.env" | head -1)"
fi
PW_DEPLOY_MODE="$(printf '%s' "$PW_DEPLOY_MODE" | tr '[:upper:]' '[:lower:]')"
case "$PW_DEPLOY_MODE" in
  host|container) : ;;
  '')
    PW_CONTAINER_EVIDENCE=""
    [ -n "${container:-}" ] && PW_CONTAINER_EVIDENCE="container=${container}"
    [ -e /run/.containerenv ] && PW_CONTAINER_EVIDENCE="${PW_CONTAINER_EVIDENCE:+$PW_CONTAINER_EVIDENCE; }/run/.containerenv"
    [ -e /.dockerenv ] && PW_CONTAINER_EVIDENCE="${PW_CONTAINER_EVIDENCE:+$PW_CONTAINER_EVIDENCE; }/.dockerenv"
    if [ -n "$PW_CONTAINER_EVIDENCE" ]; then
      die "PW_DEPLOY_MODE is unset but this host looks containerised ($PW_CONTAINER_EVIDENCE).
    This installer configures HOST mode: systemd terminal units and a dedicated tmux owner on the
    per-user default socket. On a container-mode deployment that stands up a competing server owner.
    Re-run with PW_DEPLOY_MODE=host to confirm, or see DEPLOY.md for container mode."
    fi
    PW_DEPLOY_MODE=host
    ;;
  *) die "PW_DEPLOY_MODE='$PW_DEPLOY_MODE' is not one of host|container." ;;
esac
export PW_DEPLOY_MODE
log "Deploy mode: $PW_DEPLOY_MODE"
if [ "$PW_DEPLOY_MODE" = "container" ]; then
  warn "Container mode: skipping the host-mode tmux owner (pw-tmux-server.service) and its MemoryHigh drop-in."
  warn "The container-mode owner is systemd/pw-tmux.service, which this installer does not manage. See DEPLOY.md."
fi

export DEBIAN_FRONTEND=noninteractive
log "Installing apt packages…"
apt-get update -qq
apt-get install -y --no-install-recommends \
  nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo openssl >/dev/null

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js 18+ is required (found: ${NODE_VERSION:-not installed}). Install NodeSource Node 20 and rerun:
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs
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
install -m 0755 "$SRC_DIR/scripts/pw-tmux-keepalive.sh"   /usr/local/bin/pw-tmux-keepalive
install -m 0755 "$SRC_DIR/scripts/pw-tmux-assert-owner"   /usr/local/bin/pw-tmux-assert-owner
install -m 0755 "$SRC_DIR/scripts/pw-mem-high"            /usr/local/bin/pw-mem-high
# The shell half of the authoritative environment contract, sourced by the entry points above from
# /usr/local/lib once installed (they fall back to the repo copy when run from a source tree).
install -d -m 0755 /usr/local/lib
install -m 0644 "$SRC_DIR/scripts/pw-env.sh"              /usr/local/lib/pw-env.sh


# State dir for tmux-session persistence (manifest + captured scrollback).
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 /var/lib/project-workbench/tmux-persist
install -d -o "$PW_USER" -g "$PW_USER" -m 0755 /var/lib/project-workbench/tmux-persist/content

# --- The authoritative non-secret environment contract (GOA-1 / HJ-24-5) ------
#
# One file naming this instance's registry, app dir, users store, state dir, per-user flag and
# deploy mode, loaded by the dashboard, both terminal units, the persistence units and the tmux
# owner. Before it, each entry point resolved those from its own compiled-in defaults, so an
# instance whose registry is not at the default path had a restore that refused every session and
# still exited 0 — a reboot that restored nothing and reported success.
#
# Seeded only when absent, exactly like auth.conf: a re-run of the installer must never silently
# revert an operator's tuning on a live instance. `--check` afterwards so a hand-edited file that no
# longer resolves is reported at install time rather than at the next reboot.
if [ ! -f "$CONF_DIR/pw.env" ]; then
  log "Writing the environment contract ($CONF_DIR/pw.env)…"
  PW_APP_DIR="$APP_DIR" PW_REGISTRY_PATH="$PW_INSTALL_DIR/projects.json" \
  PW_CANONICAL_REGISTRY="$PW_INSTALL_DIR/projects.json" PW_USERS_PATH="$USERS_JSON" \
  PW_SESSIONS_PATH="$SESSIONS_JSON" PW_WORKSPACES="$WORKSPACES_DIR" PW_AUDIT_LOG="$AUDIT_LOG" \
    node "$SRC_DIR/scripts/pw-env-write" --mode "$PW_DEPLOY_MODE" --out "$CONF_DIR/pw.env" \
    || warn "could not write $CONF_DIR/pw.env — entry points will fall back to their built-in defaults"
else
  log "Keeping the existing environment contract at $CONF_DIR/pw.env (operator edits survive updates)."
fi
node "$SRC_DIR/scripts/pw-env-write" --check --out "$CONF_DIR/pw.env" >/dev/null 2>&1 \
  || warn "$CONF_DIR/pw.env does not currently validate — run: node $SRC_DIR/scripts/pw-env-write --check"

if [ -f "$SRC_DIR/config/tmux.conf" ]; then
  install -o "$PW_USER" -g "$PW_USER" -m 0644 "$SRC_DIR/config/tmux.conf" "/home/$PW_USER/.tmux.conf"
fi

log "Installing systemd units…"
install -m 0644 "$SRC_DIR/systemd/project-workbench.service"       /etc/systemd/system/project-workbench.service
install -m 0644 "$SRC_DIR/systemd/project-terminal@.service"      /etc/systemd/system/project-terminal@.service
install -m 0644 "$SRC_DIR/systemd/project-setup-terminal.service" /etc/systemd/system/project-setup-terminal.service
install -m 0644 "$SRC_DIR/systemd/project-preview@.service"       /etc/systemd/system/project-preview@.service
install -m 0644 "$SRC_DIR/systemd/claude-code-update.service"     /etc/systemd/system/claude-code-update.service
install -m 0644 "$SRC_DIR/systemd/claude-code-update.timer"       /etc/systemd/system/claude-code-update.timer
if [ "$PW_DEPLOY_MODE" = "host" ]; then
  install -m 0644 "$SRC_DIR/systemd/pw-tmux-server.service"        /etc/systemd/system/pw-tmux-server.service
fi
install -m 0644 "$SRC_DIR/systemd/pw-tmux-persist.service"        /etc/systemd/system/pw-tmux-persist.service
install -m 0644 "$SRC_DIR/systemd/pw-tmux-save.service"           /etc/systemd/system/pw-tmux-save.service
install -m 0644 "$SRC_DIR/systemd/pw-tmux-save.timer"             /etc/systemd/system/pw-tmux-save.timer
# Drop-in for app-level auth enforcement (Phase 1: defaults to OFF for safe
# rollout — flip PW_AUTH_ENFORCE=true after creating an admin via `pw-user`).
# Only seed the default when none exists: a redeploy must never silently flip an
# operator's PW_AUTH_ENFORCE=true back to OFF on a live instance.
install -d -m 0755 /etc/systemd/system/project-workbench.service.d
[ -f /etc/systemd/system/project-workbench.service.d/auth.conf ] || \
  install -m 0644 "$SRC_DIR/systemd/project-workbench.service.d/auth.conf" /etc/systemd/system/project-workbench.service.d/auth.conf

# Soft memory ceiling for the tmux-server cgroup, which holds every project's panes and their
# long-running agents. Sized from THIS machine's real MemTotal rather than written into the unit,
# because a hardcoded value would be wrong on a smaller box and a percentage is wrong under LXC —
# systemd resolves `%` against the PHYSICAL host's RAM, not the container's limit (a 16G CT on a
# 540G host would get a 352G "limit", i.e. none at all). MemoryHigh throttles and reclaims under
# pressure rather than hard-killing, so a busy box degrades instead of losing sessions. Seeded only
# when absent, so operator tuning survives an update.
#
# The arithmetic lives in scripts/pw-mem-high (and is tested there against representative sizes).
# It used to be `awk '/^MemTotal:/ { printf "%d", $2*1024*0.75 }'`, which on the mawk that Debian
# ships as /usr/bin/awk clamps to INT_MAX — a ~2 GiB ceiling on every machine above ~2.73 GiB,
# below the 8.1 GiB peak of the incident this drop-in exists to protect against (HJ-24-3).
if [ "$PW_DEPLOY_MODE" = "host" ]; then
  install -d -m 0755 /etc/systemd/system/pw-tmux-server.service.d
  if [ ! -f /etc/systemd/system/pw-tmux-server.service.d/memory.conf ]; then
    pw_mem_high="$("$SRC_DIR/scripts/pw-mem-high" /proc/meminfo 75 2>/dev/null || true)"
    if [ -n "${pw_mem_high:-}" ] && [ "$pw_mem_high" -gt 0 ] 2>/dev/null; then
      printf '# Generated by install.sh from MemTotal; edit freely, updates will not overwrite it.\n[Service]\nMemoryHigh=%s\n' \
        "$pw_mem_high" > /etc/systemd/system/pw-tmux-server.service.d/memory.conf
      chmod 0644 /etc/systemd/system/pw-tmux-server.service.d/memory.conf
      log "tmux-server MemoryHigh set to $pw_mem_high bytes (75% of MemTotal)."
    else
      warn "could not read MemTotal — leaving pw-tmux-server without a MemoryHigh drop-in"
    fi
  fi
fi
systemctl daemon-reload

# The dedicated tmux owner (HJ-24-1/HJ-24-2). Enabled BEFORE pw-tmux-persist, which orders itself
# After= this unit and replays the manifest into the server it owns.
#
# FAIL CLOSED. This used to warn and continue, which meant an install could report success while
# leaving the old unsafe topology fully available: with no owner, the first project-terminal@ to run
# `tmux new-session` parents the server into its own cgroup, and a later owner start merely ADOPTS
# that server — it cannot move the server and its panes. Since project-terminal-start now refuses to
# create a terminal without proven ownership, an installer that shrugged here would hand the
# operator a box with no working terminals and no explanation.
if [ "$PW_DEPLOY_MODE" = "host" ]; then
  if ! systemctl enable --now pw-tmux-server.service >/dev/null 2>&1; then
    systemctl status --no-pager --lines=20 pw-tmux-server.service >&2 || true
    die "pw-tmux-server.service failed to start.
    It owns the shared tmux server; without it, terminals would recreate the topology that killed
    every project's sessions on 2026-08-03, so project-terminal-start now refuses to start one.
    Fix the unit above and re-run this installer. To install deliberately without the owner, set
    PW_TMUX_OWNER_REQUIRED=false in $CONF_DIR/pw.env first (see DEPLOY.md)."
  fi
  # An install that lands on a host whose server predates this unit adopts it rather than moving it:
  # the sessions stay in whatever cgroup created them until the server is actually replaced. Say so
  # rather than letting `systemctl is-active` imply the fix is in effect.
  if ! /usr/local/bin/pw-tmux-assert-owner --quiet 2>/dev/null; then
    warn "The running tmux server is not (yet) owned by pw-tmux-server.service."
    warn "Its sessions remain in the cgroup that created them. To migrate when convenient:"
    warn "  sudo -u $PW_USER /usr/local/bin/pw-tmux-save   # snapshot the sessions"
    warn "  sudo -u $PW_USER tmux kill-server              # drop the old, wrongly-parented server"
    warn "  sudo systemctl restart pw-tmux-server.service  # the owner replays the manifest on start"
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
