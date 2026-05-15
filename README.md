# Project Workbench

LAN-internal web workbench for project repos with password-protected browser terminals backed by Claude Code CLI.

The production instance currently runs as CT2115 (`project-workbench`) on PVI2 at `10.0.0.25`, exposed as `http://project-workbench.lan`.

## Components

- Node/Express dashboard (`app/`)
- nginx reverse proxy + HTTP Basic Auth (`nginx/project-workbench.conf`)
- per-project `ttyd` browser terminals backed by persistent `tmux` sessions
- project CRUD manager (`/manage`)
- terminal top bar with landing-page back link, project name, and file tray toggle
- file inbox shade for dropping/uploading files into each project workspace
- daily Claude Code updater (`systemd/claude-code-update.*`, `scripts/update-claude-code`)

## Runtime paths on the CT

- App: `/opt/project-workbench/app`
- Projects registry: `/opt/project-workbench/projects.json`
- Workspaces: `/opt/project-workbench/workspaces`
- Terminal launcher: `/usr/local/bin/project-terminal-start`
- Claude updater: `/usr/local/sbin/update-claude-code`
- nginx site: `/etc/nginx/sites-available/project-workbench`
- Basic Auth file: `/etc/nginx/.htpasswd` *(not committed)*
- Claude/Git user home: `/home/admin`

## CT setup requirements

### 1. Container baseline

Recommended baseline:

- Ubuntu 22.04 or 24.04 LXC
- 4 vCPU / 8 GB RAM / 2 GB swap
- 40-80 GB rootfs depending on workspace size
- Static LAN IP and hostname, e.g. `project-workbench`
- Network access to GitHub/npm/Anthropic auth endpoints

Install required packages:

```bash
apt update
apt install -y nginx apache2-utils ttyd git curl ca-certificates nodejs npm jq tmux sudo
```

If the distro Node.js is too old for the app/runtime, install a current Node LTS package first.

### 2. Create the runtime user and directories

Terminals and git workspaces run as `admin`; the dashboard runs as root so it can regenerate nginx/systemd config from `/manage`.

```bash
adduser --disabled-password --gecos '' admin
usermod -aG sudo admin
mkdir -p /opt/project-workbench/workspaces
chown -R admin:admin /opt/project-workbench/workspaces
```

Configure any SSH/Git credentials for `admin` separately. Do not commit tokens, deploy keys, `.git-credentials`, or Claude credentials.

### 3. Install the application

```bash
mkdir -p /opt/project-workbench
cp -a app /opt/project-workbench/app
cd /opt/project-workbench/app
npm install --omit=dev

cp config/projects.example.json /opt/project-workbench/projects.json
chown root:root /opt/project-workbench/projects.json
chmod 0644 /opt/project-workbench/projects.json
```

Edit `/opt/project-workbench/projects.json` with the projects that should appear on the landing page. Each project needs:

```json
{
  "name": "ExampleProject",
  "repo": "https://github.com/OWNER/ExampleProject.git",
  "path": "/opt/project-workbench/workspaces/ExampleProject",
  "port": 7681
}
```

Ports must be unique. The `/manage` UI can add/update/delete projects later and will regenerate nginx routes.

### 4. Install scripts

```bash
install -m 0755 scripts/project-terminal-start /usr/local/bin/project-terminal-start
install -m 0755 scripts/update-claude-code /usr/local/sbin/update-claude-code
```

`project-terminal-start` reads `projects.json`, creates/reattaches a persistent per-project `tmux` session, and serves it through `ttyd` on localhost.

### 5. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
/usr/local/sbin/update-claude-code
```

The update script also recreates `/usr/local/bin/claude` as a wrapper that runs Claude Code with `--dangerously-skip-permissions` unless a permission-mode/bypass flag is explicitly supplied. This is intentional for this trusted internal workbench so PW does not ask for command-by-command approvals.

Authenticate Claude once as the `admin` user, then verify credentials persist under `/home/admin/.claude/`:

```bash
sudo -u admin -H bash -lc 'claude --version && claude'
```

Do not include `/home/admin/.claude`, `.credentials.json`, or auth tokens in this repo.

### 6. Install systemd units

```bash
cp systemd/project-workbench.service /etc/systemd/system/project-workbench.service
cp systemd/project-terminal@.service /etc/systemd/system/project-terminal@.service
cp systemd/claude-code-update.service /etc/systemd/system/claude-code-update.service
cp systemd/claude-code-update.timer /etc/systemd/system/claude-code-update.timer
systemctl daemon-reload
systemctl enable --now project-workbench.service
systemctl enable --now claude-code-update.timer
```

Enable terminal units for each project listed in `projects.json`:

```bash
systemctl enable --now project-terminal@ExampleProject.service
```

### 7. Configure nginx and Basic Auth

Create the Basic Auth file locally. This file is intentionally not committed.

```bash
htpasswd -c /etc/nginx/.htpasswd admin
```

Install the nginx site:

```bash
cp nginx/project-workbench.conf /etc/nginx/sites-available/project-workbench
ln -sf /etc/nginx/sites-available/project-workbench /etc/nginx/sites-enabled/project-workbench
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

The dashboard's `/manage` page regenerates `/etc/nginx/sites-available/project-workbench` when projects are changed, including `/pty/<Project>/` websocket routes.

### 8. Clone workspaces

For each project, clone the repo as `admin` into its configured workspace path:

```bash
sudo -u admin -H git clone https://github.com/OWNER/ExampleProject.git /opt/project-workbench/workspaces/ExampleProject
```

The `/manage` UI can also clone when adding a project.

### 9. Optional LAN DNS / reverse proxy

For the ProVisionI LAN deployment:

- Technitium DNS maps `project-workbench.lan` to Nginx Proxy Manager (`10.0.0.14`).
- Nginx Proxy Manager forwards `project-workbench.lan` to the CT on port 80.
- Websocket upgrade must be enabled so `ttyd` terminals work.

Direct CT access on `http://<CT-IP>/` also works if routing/DNS is not configured.

### 10. Verification checklist

Run these on the CT:

```bash
node --check /opt/project-workbench/app/server.js
systemctl is-active project-workbench.service
systemctl is-active nginx
systemctl list-timers claude-code-update.timer
curl -u 'admin:<password>' http://127.0.0.1/healthz
curl -u 'admin:<password>' http://127.0.0.1/term/ExampleProject/ | grep 'Project: ExampleProject'
sudo -u admin -H bash -lc 'cd /opt/project-workbench/workspaces/ExampleProject && git status --short && command -v claude'
```

Then open the workbench in a browser, launch a project terminal, confirm the top bar back button returns to `/`, and test a small file upload into the project `_inbox`.

## Security notes

This is privileged LAN infrastructure. Once authenticated, users get shell access inside project workspaces.

Do not commit:

- local workspaces
- `/etc/nginx/.htpasswd`
- Git credentials or deploy keys
- Claude credentials under `/home/admin/.claude`
- npm/GitHub/Anthropic tokens
- production `projects.json` if it contains private repo URLs you do not want published

Use HTTPS at an upstream reverse proxy if exposing beyond a trusted LAN. Do not expose raw `ttyd` ports publicly; keep them bound to `127.0.0.1` behind nginx.
