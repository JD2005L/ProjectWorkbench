# Deploying Project Workbench

Project Workbench runs in one of two modes, selected by `PW_DEPLOY_MODE`:

| Mode | `PW_DEPLOY_MODE` | Terminals | Typical use |
|------|------------------|-----------|-------------|
| **host** (default) | unset / `host` | systemd units (`project-terminal@.service`, `project-setup-terminal.service`, `project-preview@.service`) spawn ttyd; tmux runs as the `admin` user | bare-metal / VM install via `install.sh` |
| **container** | `container` | the node app spawns/tracks ttyd itself and attaches to tmux on a shared socket | containerized install (this `Containerfile`) |

Host mode is unchanged from upstream except where noted below. The rest of this doc covers
container mode and the parts both modes now share.

## The environment contract (`/etc/project-workbench/pw.env`)

Both deploy modes read one authoritative, **non-secret** file naming this instance's registry, app
dir, users store, workspace root, persistence state dir, per-user credential flag and deploy mode.
It exists because every entry point used to resolve those from its own compiled-in defaults, so an
instance whose registry is not at the default path had a `pw-tmux-restore` that refused every
session and still exited 0 — a reboot that restored nothing and reported success.

Generate it once (the generator never overwrites an existing file, so operator tuning survives an
update; `install.sh` runs it for you in host mode):

```bash
node scripts/pw-env-write --mode host        # or --mode container
node scripts/pw-env-write --check            # validate an existing file
node scripts/pw-env-write --mode container --print   # see it without writing
```

| Consumer | How it loads the contract |
|---|---|
| dashboard, both terminal units, `pw-tmux-persist`, `pw-tmux-save`, `pw-tmux-server` | `EnvironmentFile=-/etc/project-workbench/pw.env` |
| container app + `pw-tmux` sidecar | podman `--env-file=/etc/project-workbench/pw.env` |

Keys are documented inline in the generated file and in `app/pw-env.js`. **Nothing secret belongs in
it** — tokens stay encrypted in the users store, and per-user credential material stays under
`PW_USER_CRED_BASE`, owned by the pane account.

An **already-set** variable always wins over the file: systemd has applied `EnvironmentFile=` by the
time a unit's script runs, and an explicit export is a deliberate override.

Misconfiguration is not "nothing to do". If an authoritative path is missing or the wrong type,
`pw-tmux-restore` exits `78` (`EX_CONFIG`) with a message naming the variable and the path, instead
of exiting 0 having restored nothing. A correctly configured instance with no saved manifest still
exits 0 silently.

## The dedicated tmux owner (host mode)

The shared tmux server is owned by `pw-tmux-server.service`, which holds it in its own cgroup so a
ttyd restart, crash or OOM cannot reach it. The unit is `Type=notify`: it does not become ready
until `scripts/pw-tmux-keepalive.sh` has confirmed the server and its `_keepalive` session are live
on the socket the terminals actually use, so the `After=` ordering barrier cannot release a terminal
against a server that does not exist yet.

`project-terminal-start` then **refuses to create a terminal** unless ownership is proven
(`scripts/pw-tmux-assert-owner`):

| Situation | Result |
|---|---|
| owner holds the server | terminal starts normally |
| no server at all (owner failed to start, or crashed before readiness) | refuses; `Restart=on-failure` keeps the unit pending until the owner is healthy |
| a server exists but was created by something else | refuses, and prints the migration steps below |

Creating the server from a terminal is what put every project's panes in one per-project ttyd
cgroup, where a single OOM-killed pane took them all down. Refusing is recoverable; that is not.

**Migrating an existing host.** `systemctl enable --now pw-tmux-server.service` on a box that
already has a running server merely *adopts* it — the sessions stay in whatever cgroup created them
until the server is actually replaced. `install.sh` detects this and prints the steps; run them when
a brief terminal interruption is acceptable:

```bash
sudo -u admin /usr/local/bin/pw-tmux-save    # snapshot sessions + scrollback
sudo -u admin tmux kill-server               # drop the wrongly-parented server
sudo systemctl restart pw-tmux-server.service  # the owner replays the manifest on start
```

`PW_TMUX_OWNER_REQUIRED=false` in `pw.env` opts out of the gate for a deployment that deliberately
runs without the owner unit.

`install.sh` is deploy-mode gated: in container mode it installs and enables neither the owner unit
nor its `MemoryHigh` drop-in, so it can never stand up a competitor to the sidecar.

## Container mode: tmux persistence — what is and is not supported

Container mode has always had a dedicated owner (the `pw-tmux` sidecar), and it now gets the same
keepalive supervision host mode does: a dead server makes the keepalive exit non-zero, and
`Restart=on-failure` brings the sidecar back. **Restore is opt-in and requires two things the image
does not provide by itself**, so it is stated here rather than implied:

1. `PW_TMUX_RESTORE_ON_START=1` in the environment contract, and
2. the persistence state dir bind-mounted into the sidecar, e.g.
   `-v /var/lib/project-workbench:/var/lib/project-workbench`, matching `PW_TMUX_STATE_DIR`.

With both, the sidecar replays the manifest into the server it owns before signalling readiness.
With neither, a sidecar restart comes back to an **empty server and no replay** — detection without
recovery. Without the mount but with the flag, `pw-tmux-restore` now exits non-zero and says so in
the journal rather than reporting success; the keepalive logs it and keeps supervising, because
holding the server open is its job and a restore problem must not cost the instance its supervisor.

**Not claimed:** host mode's boot-time `pw-tmux-persist.service` and its `ExecStop` snapshot have no
container equivalent here. Periodic snapshots in container mode need a scheduler inside the sidecar
or an external timer invoking `pw-tmux-save`; that is not delivered in this change.


## Container mode

Build the image and run it. The app spawns each project's terminal as a
node-managed `ttyd` attached to a tmux server. For terminals to survive an app
(node) restart, point tmux at a **persistent sidecar** socket via `TMUX_TMPDIR`
(the sidecar owns the tmux server; the app is just a client).

```bash
podman build -t project-workbench:latest .
podman run -d --name project-workbench \
  --env-file=/etc/project-workbench/pw.env \
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
| `PW_TMUX_OWNER_REQUIRED` | `true` (host mode) | refuse to create a terminal unless the dedicated tmux owner is proven live. `false` opts out for a deployment deliberately running without the owner unit |
| `PW_TMUX_RESTORE_ON_START` | unset | container mode: replay the persistence manifest into the server the sidecar owns, before readiness. Requires the state dir to be mounted — see above |
| `PW_TMUX_STATE_DIR` | `/var/lib/project-workbench/tmux-persist` | tmux persistence manifest + captured scrollback |
| `PW_ENV_FILE` | `/etc/project-workbench/pw.env` | where the shell entry points read the environment contract from |
| `PW_ORCHESTRATOR_CONTRACT_ROOT` | (sibling repo path) | where the cross-contract tests find the orchestrator checkout |
| `PW_ISOLATED` | unset | `1` forces isolation even on the canonical registry (belt-and-braces for test instances) |
| `PW_TLS_ENABLED` | unset | `1`/`true`/`yes` generates an HTTPS nginx config. **Off by default** — cert files on disk never activate TLS by themselves |
| `PW_TLS_CERT` / `PW_TLS_KEY` | — | fullchain cert / private key paths. Required with `PW_TLS_ENABLED`; startup fails fast if either is missing or unreadable |
| `PW_TLS_SERVER_NAME` | — | this instance's hostname. Required with `PW_TLS_ENABLED`: it becomes `server_name` on both listeners and the target of the 80→443 redirect (`return 301 https://<name>$request_uri`), so the redirect never reflects the client-supplied `$host` |
| `PW_TLS_DEFAULT_SERVER` | unset | `1` marks both the :80 and :443 blocks `default_server`. Only for hosts where PW is the sole site; never claimed implicitly |


## Running the tests

The canonical gate is, and stays:

```bash
cd app && npm ci && npm test
```

Some environments have no route to the npm registry, and `app/package.json` declares exactly one
runtime dependency (`express`) — so on those hosts the full suite reports dozens of failures that
are all one missing package, and the totals cannot be compared with anyone else's. For a result that
IS comparable across environments on the same commit:

```bash
cd app && npm run test:offline        # every test that needs no dependency
cd app && npm run test:offline:list   # the classification, including every exclusion and why
```

The subset is a property of the commit, not of the machine: it is computed identically whether or
not `express` is installed, it pins a short isolated `TMUX_TMPDIR` (a deep socket path breaks
tmux-backed tests with "File name too long"), and it clears ambient `TMUX*`/`PW_TMUX_*` so a
developer shell inside a Project Workbench pane cannot silently change which branch a script takes.
Every excluded file is reported with its reason. It is a **complement** to the canonical gate, never
a replacement.

Cross-contract tests against the sibling orchestrator honour `PW_ORCHESTRATOR_CONTRACT_ROOT`, so a
CI checkout or another instance can point them at its own copy instead of the compiled-in path.

## Release version

The canonical release identifier lives in `app/VERSION` and is shown in the shared footer on every primary UI, including the project cockpit. It must match `1.YY.MMDD.hhmm` (for example, `1.26.0721.2233`). Bump this file once for every release commit; because it is part of `app/`, both `install.sh` and container builds carry the same version to every environment.

## Optional image extras

The `Containerfile` keeps a generic runtime. Two optional, commented sections
enable environment-specific needs:

- **Internal / AD CA** — for `PW_AUTH_MODE=ldap` when the directory's CA isn't
  publicly rooted (drop certs in `config/ca/`, uncomment the `COPY` + `update-ca-certificates`).
- **Deploy Centre toolchain** — `smbclient` / `pywinrm` / .NET SDK for
  `PW_DEPLOY_CENTRE=true`.
