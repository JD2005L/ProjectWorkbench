# Install notes

This repository was exported from CT2115 (`project-workbench`) after initial deployment.

High-level install:

1. Install packages: `nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo`.
2. Install Claude Code: `npm install -g @anthropic-ai/claude-code`.
3. Create `admin` user, `/opt/project-workbench/workspaces`, and `/opt/project-workbench/memory`.
4. Copy `app/` to `/opt/project-workbench/app` and run `npm install --omit=dev`.
5. Copy `config/projects.example.json` to `/opt/project-workbench/projects.json` and edit as needed.
6. Copy `config/shared-memory/*` into `/opt/project-workbench/memory`; copy `config/empty-mcp.json` and `config/claude-wrapper.env.example` into `/etc/project-workbench/`.
7. Copy scripts/systemd/nginx files to their runtime paths.
8. Configure `/etc/nginx/.htpasswd` separately; do not commit it.
9. Enable services/timers.

Notes:
- `/opt/project-workbench/memory` is local shared memory for all PW workspaces. Keep `CREDENTIALS.md` local-only and `0600`.
- The Claude wrapper intentionally adds `/opt/project-workbench/memory` with `--add-dir` and reads `/etc/project-workbench/claude-wrapper.env` for instance-local MCP/permission policy.
- Use `PW_MCP_MODE=inherit` for instances like PVE that should use their account/project MCP server. Use `PW_MCP_MODE=isolated` for instances like PVI2 where account MCP is unreachable and should be suppressed.
- `PW_PERMISSION_MODE=skip` (default) makes the wrapper pass `--dangerously-skip-permissions`. Set `prompt` to defer to Claude's normal prompts.

## Setup Wizard

The dashboard exposes a Setup Wizard modal (from the "Setup Wizard" button on the homepage). It manages runtime preferences and offers one-click heal for common drift.

Install bits:

1. Copy `scripts/setup-terminal-start` to `/usr/local/bin/` (mode 755).
2. Copy `systemd/project-setup-terminal.service` to `/etc/systemd/system/` and `systemctl enable --now project-setup-terminal.service`. It serves ttyd on `127.0.0.1:7680` against tmux session `pw_setup`.
3. Seed `/etc/project-workbench/workbench.json` from `config/workbench.example.json` (the wizard writes this file on Save).
4. Hit `/api/setup/heal/nginx` from the wizard once after install so the dashboard regenerates `/etc/nginx/sites-available/project-workbench` with the new `/pty/_setup/` proxy route.

Settings (`/etc/project-workbench/workbench.json`):
- `permissionMode`: `skip` | `prompt` — feeds the Claude wrapper via `claude-wrapper.env`.
- `mcpMode`: `inherit` | `isolated` | `custom` — same.
- `enabledClis`: list of CLIs the instance offers (subset of `claude`, `codex`, `copilot`).
- `updateClis`: subset of `enabledClis` that the nightly `update-claude-code` timer keeps current.

The wizard's "Sign in" buttons send the CLI's native login command into the `pw_setup` tmux session and embed the setup terminal in an iframe so OAuth/device-code flows can be completed inline.
