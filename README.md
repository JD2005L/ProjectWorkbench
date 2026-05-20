# Project Workbench

LAN-internal web workbench that gives every repo on your network a password-protected browser terminal pre-wired to **Claude Code** (or Codex / Copilot), a drag-and-drop **file inbox**, and an iframe-based **live preview** of whatever dev server the project uses.

It's the missing piece between "I want to use Claude Code in a browser tab" and "I don't want to run a dev environment on every laptop on the LAN."

> [!WARNING]
> Project Workbench is **designed for LAN-internal infrastructure**. Once a user authenticates with Basic Auth they get shell access inside every project workspace as the install's runtime user. Do not expose the host to the public Internet without putting it behind HTTPS plus your own auth proxy. The security boundary is the network, not the password.

![Dashboard](docs/screenshots/dashboard.png)

---

## Install

One command on a fresh Ubuntu 22.04+ or Debian 12+ host:

```bash
curl -fsSL https://raw.githubusercontent.com/JD2005L/ProjectWorkbench/main/install.sh | sudo bash
```

The installer:

- detects Ubuntu/Debian and installs apt deps (`nginx`, `apache2-utils`, `ttyd`, `git`, `nodejs`, `npm`, `jq`, `tmux`, `openssl`),
- creates the `admin` runtime user,
- clones this repo into `/opt/project-workbench/source`,
- deploys the dashboard, helper scripts and systemd units,
- generates a random Basic Auth password (also saved root-readable in `/etc/project-workbench/credentials`),
- starts the dashboard and prints the URL, username and password at the end.

It is **idempotent** — rerun it any time to repair drift or pull a newer release.

### Overrides

| Variable | Default | What it controls |
|---|---|---|
| `PW_INSTALL_DIR` | `/opt/project-workbench` | Install root |
| `PW_HTTP_PORT`   | `80`                     | Nginx listen port |
| `PW_REPO`        | this repo                | Git URL to clone source from |
| `PW_REF`         | `main`                   | Git branch / tag to install |
| `PW_AUTH_USER`   | `admin`                  | Basic Auth username |
| `PW_AUTH_PASS`   | _auto-generated_         | Pre-set Basic Auth password instead of auto-generating |

Example: install from a pinned tag on a host that already uses port 80 for something else.

```bash
curl -fsSL https://raw.githubusercontent.com/JD2005L/ProjectWorkbench/main/install.sh \
  | sudo PW_REF=v1.2.0 PW_HTTP_PORT=8080 bash
```

After the installer finishes, open the URL it printed and you'll land on the welcome screen:

![Empty dashboard](docs/screenshots/dashboard-empty.png)

---

## Features

### Per-project browser terminals
Every project gets its own `ttyd` + persistent `tmux` session backed by Claude Code. The terminal page keeps a tab strip across multiple `tmux` windows so you can run several Claude conversations or build watchers in parallel inside one project.

![Terminal](docs/screenshots/terminal.png)

### Setup Wizard
Multi-CLI install + sign-in flow (Claude, Codex, Copilot). Auth happens inside a shared `ttyd` setup terminal so tokens land in the runtime user's home and apply to every project. Also exposes the instance-wide permission mode, MCP policy, and self-heal endpoints for nginx and runtime dirs.

![Setup Wizard](docs/screenshots/wizard.png)

### Live preview
Each project can declare a preview command (`dotnet watch …`, `npm run dev …`, `hugo server …`, anything that binds a port). The dashboard's Preview button opens a modal iframe pointing at `/preview/<Name>/`, proxied through nginx with WebSocket upgrade, Referer-aware asset fallback (so root-relative `/css/*.css` etc. land on the right backend), and a `proxy_redirect` rule that rewrites framework-issued absolute redirects back under the prefix. Start / Stop / Restart and log tail live in the same modal.

![Preview modal](docs/screenshots/preview.png)

The preview process is owned by `systemd` (one unit instance per project), so closing the modal leaves it running and you can reopen it later without paying the framework's cold-boot tax. A per-project `preview.env` block lets you override env vars (e.g. `ASPNETCORE_ENVIRONMENT`) without touching the project's code.

### File inbox
Each terminal page has a drop-shade for drag-and-drop, paste, and file picker. Uploaded files land in `<workspace>/_inbox/` and the absolute path is auto-inserted into the active terminal — useful for handing screenshots or PDFs to Claude. Pasted images skip the picker and go straight in.

### Project CRUD
A `/manage` page clones repos into workspaces, allocates ports, regenerates nginx, registers systemd units, and tears down cleanly on delete. Per-project preview command and env vars live in the same form. Port collisions across terminals and previews are caught before they bite.

![Manage Projects](docs/screenshots/manage.png)

### Daily Claude Code updater
A nightly `systemd` timer keeps Claude Code (and any other enabled CLIs) on their latest releases without touching the rest of the install.

---

## How it works

```
                         ┌──────────────────────────────┐
   browser  ───┐         │  /etc/nginx (port 80 / 8080) │
   (Basic Auth)│         │  - Basic Auth                │
               ▼         │  - /pty/<Name>/   → ttyd      ────► tmux session per project
       ┌──────────────┐  │  - /preview/<Name>/ → Kestrel ────► dotnet watch / npm run dev / …
       │   nginx      │──┤  - /api, /manage, /, /file/…  ────► Node/Express dashboard (:3000)
       └──────────────┘  │  - Referer-based asset fallback for preview iframes
                         └──────────────────────────────┘
```

- The dashboard runs as `root` so it can regenerate nginx + systemd configs from the `/manage` page.
- Per-project terminals run as `admin` via `project-terminal@<Name>.service`.
- Per-project previews run as `admin` via `project-preview@<Name>.service`.
- All four go through nginx; nothing is exposed except port 80 / your chosen `PW_HTTP_PORT`.

---

## Configuration knobs (post-install)

| Setting | Where | What it does |
|---|---|---|
| Permission mode | Setup Wizard → Environment | `--dangerously-skip-permissions` vs. prompt-for-each |
| MCP mode | Setup Wizard → Environment | `inherit` / `isolated` / `custom` (see `/etc/project-workbench/claude-wrapper.env`) |
| Enabled CLIs | Setup Wizard → CLIs | Which assistants are offered and which the nightly timer updates |
| Per-project preview cmd | `/manage` → project card | The command that boots the dev server (`${PORT}` and `${BASEPATH}` are substituted) |
| Per-project preview env | `/manage` → project card | KEY=VALUE lines exported before the preview cmd runs (`PORT`/`BASEPATH` reserved) |
| Basic Auth | `/etc/nginx/.htpasswd` | Edit with `htpasswd` directly; credentials file at `/etc/project-workbench/credentials` |

---

## Users & permissions (Phase 1)

Phase 1 adds app-level users with hashed passwords, cookie sessions, and per-project grants on top of the existing nginx Basic Auth gate. Basic Auth (or Cloudflare Access / a VPN) should stay in front of the dashboard as the outer perimeter until later phases lock the box down further.

### Roles

| Role | Sees | Can open `/term/<n>/` | Can upload / start preview | Can do project CRUD / Setup Wizard |
|---|---|---|---|---|
| `admin` | all projects | yes | yes | yes |
| `developer` | only granted projects | yes | yes | no |
| `content_editor` | only granted projects | **no** (Phase 2 PVIKPBot workflow) | no | no |
| `viewer` | only granted projects | no | no (read-only status) | no |

`admin` ignores grants and sees everything. The other roles respect `--projects '*'` or an explicit list.

### CLI: `pw-user` (root-only)

`pw-user` lives at `/usr/local/sbin/pw-user` and writes `/etc/project-workbench/users.json` (mode 0600).

```bash
sudo pw-user add james --role admin --projects '*'           # prompts for password (hidden)
sudo pw-user add alice --role developer --projects 'AmrikPublic,HarmaniPublic'
sudo pw-user add carol --role content_editor --projects 'AmrikPublic'
sudo pw-user list
sudo pw-user passwd alice
sudo pw-user grant alice ProVisionIPortal
sudo pw-user revoke alice AmrikPublic
sudo pw-user role alice viewer
sudo pw-user delete alice
```

Password input is read from a TTY with echo disabled. To pipe a password (CI / scripts), pass `--password '...'` to `add`.

### Enforcement switch (`PW_AUTH_ENFORCE`)

The dashboard ships with auth in **soft mode** by default — anonymous requests are treated as an implicit admin so existing browser sessions don't break the moment the code lands. To require login:

1. Create at least one admin via `sudo pw-user add ... --role admin`.
2. Browse to `http://<workbench>/login` and confirm the cookie flow works.
3. Edit `/etc/systemd/system/project-workbench.service.d/auth.conf` and change `PW_AUTH_ENFORCE=false` to `true`.
4. `sudo systemctl daemon-reload && sudo systemctl restart project-workbench.service`.
5. If anything breaks, flip back to `false` and restart.

When enforce is on, nginx's `auth_request` on every `/pty/<n>/` and `/preview/<n>/` block makes the dashboard re-check the cookie + project grant on each terminal/preview page load.

### Audit log

Sensitive events (login ok/fail, logout, terminal open, upload, project CRUD, setup state change) are appended as JSON-lines to `/var/log/project-workbench/audit.log`. Tail it: `sudo tail -F /var/log/project-workbench/audit.log`.

### Public-exposure guidance

Phase 1 is **safe to ship behind an outer gate** (Basic Auth, Cloudflare Access, VPN, etc.). Phase 2 will tighten the runtime further so the dashboard can survive direct public exposure:

- Per-user / per-action rate limiting on `/api/auth/login`.
- WebAuthn / 2FA enrollment.
- A real PVIKPBot supervised-workflow page that `content_editor` users land on instead of `/term/`.
- Read-only project dashboards for `viewer`.
- User management inside the dashboard UI (Phase 1 is CLI-only).
- Tighter file permissions on `/var/log/project-workbench/audit.log`.

---

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| `nginx -t` fails on a port the installer wants | Another service is on port 80 | Set `PW_HTTP_PORT=8080` (or another free port) on the installer run |
| Installer aborts: "Node.js 18+ is required" | Distro repo Node is too old | Install Node 20 from NodeSource and rerun: `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo bash - && sudo apt-get install -y nodejs && sudo bash install.sh` |
| Installer aborts: "ttyd is required" | ttyd not in your distro's default repos | Enable backports or grab a release binary from <https://github.com/tsl0922/ttyd/releases>, drop into `/usr/local/bin/ttyd`, rerun |
| Terminal opens but Claude says "not signed in" | The `admin` user hasn't completed `claude /login` yet | Setup Wizard → Sign in → "Reauthenticate" on Claude Code |
| Preview modal pill stays "starting" | Framework hasn't bound the port yet (or crashed) | Open the Logs panel inside the modal — first dotnet watch boot can take 10–30s |
| Preview app renders unstyled / broken images | App calls Windows-only APIs in Dev branch, or doesn't honor `--pathbase` | The launcher leaves `ASPNETCORE_ENVIRONMENT` unset so apps fall through to their non-Dev branch. Override via the per-project `Preview env` if your app actually needs `Development`. Root-relative assets are auto-routed via Referer; only JS-built fully-qualified URLs miss this |
| `/manage` page errors after add/update | nginx reload failed | Setup Wizard → Heal → "Regenerate nginx + reload" |
| Re-running installer says "Existing /etc/nginx/.htpasswd detected" | Idempotency is working — your existing password is preserved | Edit `/etc/nginx/.htpasswd` with `htpasswd` manually if you need to rotate |

Useful one-liners:

```bash
journalctl -u project-workbench.service -f               # dashboard logs
journalctl -u project-terminal@<Name>.service -f          # one project's terminal
journalctl -u project-preview@<Name>.service -f -o cat    # one project's preview
sudo cat /etc/project-workbench/credentials               # printed at install time
```

---

## Repo layout

```
app/                          Node/Express dashboard, terminal/preload helpers
config/                       Example configs + shared-memory templates the installer drops into /opt
nginx/                        Sample nginx site (the live one is regenerated by the dashboard)
scripts/
  project-terminal-start      ttyd + tmux launcher (per-project terminal)
  project-preview-start       ttyd-less dev-server launcher (per-project preview)
  setup-terminal-start        Shared setup terminal used by the Wizard for CLI sign-in
  update-claude-code          Nightly Claude/Codex/Copilot updater
systemd/                      Service + timer unit files
install.sh                    One-shot installer
docs/screenshots/             Image inventory referenced by this README
```

---

<details>
<summary><b>Manual install (advanced users)</b></summary>

The one-line installer above is the supported path. If you'd rather wire things up by hand — or you're adapting to a non-Ubuntu/Debian host — these are the steps `install.sh` runs.

### 1. Baseline

```bash
sudo apt update
sudo apt install -y nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo openssl
```

Node 18+ is required; install from NodeSource if your distro's default is older.

### 2. Runtime user and directories

```bash
sudo adduser --disabled-password --gecos '' admin
sudo usermod -aG sudo admin
sudo mkdir -p /opt/project-workbench/workspaces /opt/project-workbench/memory /etc/project-workbench
sudo chown -R admin:admin /opt/project-workbench/workspaces /opt/project-workbench/memory
sudo chmod 700 /opt/project-workbench/memory
```

### 3. Application

```bash
sudo git clone https://github.com/JD2005L/ProjectWorkbench.git /opt/project-workbench/source
sudo cp -a /opt/project-workbench/source/app /opt/project-workbench/app
( cd /opt/project-workbench/app && sudo npm install --omit=dev )

# Seed configs
echo '[]' | sudo tee /opt/project-workbench/projects.json >/dev/null
sudo cp /opt/project-workbench/source/config/empty-mcp.json /etc/project-workbench/empty-mcp.json
sudo cp /opt/project-workbench/source/config/claude-wrapper.env.example /etc/project-workbench/claude-wrapper.env

# Shared memory
for f in CLAUDE.md TOOLS.md DECISIONS.md; do
  sudo cp /opt/project-workbench/source/config/shared-memory/$f /opt/project-workbench/memory/$f
done
sudo cp /opt/project-workbench/source/config/shared-memory/CREDENTIALS.md.example /opt/project-workbench/memory/CREDENTIALS.md
sudo chown -R admin:admin /opt/project-workbench/memory
sudo chmod 700 /opt/project-workbench/memory
sudo chmod 640 /opt/project-workbench/memory/{CLAUDE,TOOLS,DECISIONS}.md
sudo chmod 600 /opt/project-workbench/memory/CREDENTIALS.md
```

### 4. Scripts + Claude Code

```bash
sudo install -m 0755 /opt/project-workbench/source/scripts/project-terminal-start /usr/local/bin/project-terminal-start
sudo install -m 0755 /opt/project-workbench/source/scripts/project-preview-start  /usr/local/bin/project-preview-start
sudo install -m 0755 /opt/project-workbench/source/scripts/setup-terminal-start   /usr/local/bin/setup-terminal-start
sudo install -m 0755 /opt/project-workbench/source/scripts/update-claude-code     /usr/local/sbin/update-claude-code
sudo npm install -g @anthropic-ai/claude-code
sudo /usr/local/sbin/update-claude-code
```

The updater also writes `/usr/local/bin/claude` as a wrapper that applies this instance's permission/MCP policy from `/etc/project-workbench/claude-wrapper.env`.

### 5. systemd units

```bash
sudo install -m 0644 /opt/project-workbench/source/systemd/project-workbench.service       /etc/systemd/system/
sudo install -m 0644 /opt/project-workbench/source/systemd/project-terminal@.service       /etc/systemd/system/
sudo install -m 0644 /opt/project-workbench/source/systemd/project-setup-terminal.service  /etc/systemd/system/
sudo install -m 0644 /opt/project-workbench/source/systemd/project-preview@.service        /etc/systemd/system/
sudo install -m 0644 /opt/project-workbench/source/systemd/claude-code-update.service      /etc/systemd/system/
sudo install -m 0644 /opt/project-workbench/source/systemd/claude-code-update.timer        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now project-workbench.service
sudo systemctl enable --now claude-code-update.timer
```

### 6. nginx + Basic Auth

```bash
sudo htpasswd -c /etc/nginx/.htpasswd admin   # prompts for password
sudo bash -c 'cat > /etc/nginx/sites-available/project-workbench' <<'NGINX'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    listen 80 default_server;
    server_name _;
    auth_basic "Project Workbench";
    auth_basic_user_file /etc/nginx/.htpasswd;
    client_max_body_size 100m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/project-workbench /etc/nginx/sites-enabled/project-workbench
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Then hit the dashboard's heal endpoint once so it rewrites the nginx config with any project-specific `/pty/` and `/preview/` blocks:

```bash
curl -fsS -X POST http://127.0.0.1:3000/api/setup/heal/nginx
```

### 7. Verification

```bash
systemctl is-active project-workbench.service nginx
curl -u admin:<password> http://127.0.0.1/healthz
```

</details>

---

## License

MIT — see `LICENSE` if present, otherwise treat this as MIT-licensed for now.

## Contributing

Issues and PRs welcome. Please do not commit:

- `/opt/project-workbench/workspaces/` content
- `/etc/nginx/.htpasswd` or `/etc/project-workbench/credentials`
- Anything under `~/.claude/`
- npm / GitHub / Anthropic tokens
