# Deploying Project Workbench

Project Workbench runs in one of two modes, selected by `PW_DEPLOY_MODE`:

| Mode | `PW_DEPLOY_MODE` | Terminals | Typical use |
|------|------------------|-----------|-------------|
| **host** (default) | unset / `host` | systemd units (`project-terminal@.service`, `project-setup-terminal.service`, `project-preview@.service`) spawn ttyd; tmux runs as the `admin` user | bare-metal / VM install via `install.sh` |
| **container** | `container` | the node app spawns/tracks ttyd itself and attaches to tmux on a shared socket | containerized install (this `Containerfile`) |

Host mode is unchanged from upstream. The rest of this doc covers container mode.

## Container mode

Build the image and run it. The app spawns each project's terminal as a
node-managed `ttyd` attached to a tmux server. For terminals to survive an app
(node) restart, point tmux at a **persistent sidecar** socket via `TMUX_TMPDIR`
(the sidecar owns the tmux server; the app is just a client).

```bash
podman build -t project-workbench:latest .
podman run -d --name project-workbench \
  -e PW_DEPLOY_MODE=container \
  -e PW_BASE_PATH=/workbench \
  -e TMUX_TMPDIR=/var/run/pw-tmux \
  -v /var/run/pw-tmux:/var/run/pw-tmux \
  -v /opt/pw/workspaces:/opt/project-workbench/workspaces \
  -p 127.0.0.1:3000:3000 \
  project-workbench:latest
```

`scripts/entrypoint.sh` waits for the sidecar, then runs node in a respawn loop
(a hot code redeploy is just "kill the node PID" — see `deploy-local.sh`).

### nginx

The app generates the reverse-proxy config (`nginxConfig`) and, by default,
runs `nginx -t` + `systemctl reload nginx` from its own namespace. When nginx
lives outside the app's namespace (e.g. on the host while the app is in a
container), tell the app how to reach it — the commands are run as argv (no
shell), so no service name is baked into the repo:

```
PW_NGINX_TEST_CMD="nsenter -t 1 -m -- nginx -t"
PW_NGINX_RELOAD_CMD="nsenter -t 1 -m -- systemctl reload nginx"
```

`applyRouting` still validates with the test command and rolls back to the
previous config on failure before reloading.

## Environment knobs (all optional; defaults keep upstream behavior)

| Var | Default | Purpose |
|-----|---------|---------|
| `PW_DEPLOY_MODE` | `host` | `host` \| `container` terminal model |
| `PW_BASE_PATH` | `''` | serve the whole app under a URL prefix (e.g. `/workbench`) |
| `PW_TMUX_SOCKET` | (auto in isolated tests) | tmux `-L` socket name for container mode |
| `PW_NGINX_TEST_CMD` / `PW_NGINX_RELOAD_CMD` | (built-in) | override the nginx validate/reload commands |
| `PW_AUTH_MODE` | `local` | `local` (password) or `ldap` (directory bind) |
| `PW_AUTH_ENFORCE` | `false` | require login (soft mode treats anon as admin) |
| `PW_AUTH_HEADER` | `''` | trust a reverse-proxy / AD pre-auth header (e.g. `x-remote-user`) |
| `PW_SSO_USER_HEADER` | `''` | emit the signed-in user from `/api/auth/check` for sibling-app SSO |
| `PW_DEPLOY_CENTRE` | `false` | enable the Windows (WinRM/SMB) Deploy Centre |
| `PW_EXTRA_NGINX` | `/etc/project-workbench/extra-nginx.conf` | inject env-specific sibling-app nginx locations (see `docs/consolidation/extra-nginx.example.conf`) |

## Optional image extras

The `Containerfile` keeps a generic runtime. Two optional, commented sections
enable environment-specific needs:

- **Internal / AD CA** — for `PW_AUTH_MODE=ldap` when the directory's CA isn't
  publicly rooted (drop certs in `config/ca/`, uncomment the `COPY` + `update-ca-certificates`).
- **Deploy Centre toolchain** — `smbclient` / `pywinrm` / .NET SDK for
  `PW_DEPLOY_CENTRE=true`.
