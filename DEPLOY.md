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
| `PW_CANONICAL_REGISTRY` | `/opt/project-workbench/projects.json` | where THIS deployment's real registry lives. Any `PW_REGISTRY_PATH` other than this runs the instance isolated (no host tmux/ttyd/nginx writes). Deployments that keep the real registry elsewhere (e.g. GOA under `/etc/project-workbench/`) set this to that path to opt into host mode — host mode is never inferred from the path's shape |
| `PW_ISOLATED` | unset | `1` forces isolation even on the canonical registry (belt-and-braces for test instances) |
| `PW_TLS_ENABLED` | unset | `1`/`true`/`yes` generates an HTTPS nginx config. **Off by default** — cert files on disk never activate TLS by themselves |
| `PW_TLS_CERT` / `PW_TLS_KEY` | — | fullchain cert / private key paths. Required with `PW_TLS_ENABLED`; startup fails fast if either is missing or unreadable |
| `PW_TLS_SERVER_NAME` | — | this instance's hostname. Required with `PW_TLS_ENABLED`: it becomes `server_name` on both listeners and the target of the 80→443 redirect (`return 301 https://<name>$request_uri`), so the redirect never reflects the client-supplied `$host` |
| `PW_TLS_DEFAULT_SERVER` | unset | `1` marks both the :80 and :443 blocks `default_server`. Only for hosts where PW is the sole site; never claimed implicitly |

## Release version

The canonical release identifier lives in `app/VERSION` and is shown in the shared footer on every primary UI, including the project cockpit. It must match `1.YY.MMDD.hhmm` (for example, `1.26.0721.2233`). Bump this file once for every release commit; because it is part of `app/`, both `install.sh` and container builds carry the same version to every environment.

## Optional image extras

The `Containerfile` keeps a generic runtime. Two optional, commented sections
enable environment-specific needs:

- **Internal / AD CA** — for `PW_AUTH_MODE=ldap` when the directory's CA isn't
  publicly rooted (drop certs in `config/ca/`, uncomment the `COPY` + `update-ca-certificates`).
- **Deploy Centre toolchain** — `smbclient` / `pywinrm` / .NET SDK for
  `PW_DEPLOY_CENTRE=true`.
