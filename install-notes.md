# Install notes

This repository was exported from CT2115 (`project-workbench`) after initial deployment.

High-level install:

1. Install packages: `nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo`.
2. Install Claude Code: `npm install -g @anthropic-ai/claude-code`.
3. Create `admin` user and `/opt/project-workbench/workspaces`.
4. Copy `app/` to `/opt/project-workbench/app` and run `npm install --omit=dev`.
5. Copy `config/projects.example.json` to `/opt/project-workbench/projects.json` and edit as needed.
6. Copy scripts/systemd/nginx files to their runtime paths.
7. Configure `/etc/nginx/.htpasswd` separately; do not commit it.
8. Enable services/timers.
