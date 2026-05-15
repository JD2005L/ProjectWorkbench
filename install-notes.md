# Install notes

This repository was exported from CT2115 (`project-workbench`) after initial deployment.

High-level install:

1. Install packages: `nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo`.
2. Install Claude Code: `npm install -g @anthropic-ai/claude-code`.
3. Create `admin` user, `/opt/project-workbench/workspaces`, and `/opt/project-workbench/memory`.
4. Copy `app/` to `/opt/project-workbench/app` and run `npm install --omit=dev`.
5. Copy `config/projects.example.json` to `/opt/project-workbench/projects.json` and edit as needed.
6. Copy `config/shared-memory/*` into `/opt/project-workbench/memory`; copy `config/empty-mcp.json` into `/etc/project-workbench/empty-mcp.json`.
7. Copy scripts/systemd/nginx files to their runtime paths.
8. Configure `/etc/nginx/.htpasswd` separately; do not commit it.
9. Enable services/timers.

Notes:
- `/opt/project-workbench/memory` is local shared memory for all PW workspaces. Keep `CREDENTIALS.md` local-only and `0600`.
- The Claude wrapper intentionally adds `/opt/project-workbench/memory` with `--add-dir` and uses an empty strict MCP config by default so PVI2 does not try to access account-level MCP servers that are not reachable from this network.
