# Deploying Project Workbench

Project Workbench runs in one of two modes, selected by `PW_DEPLOY_MODE`:

| Mode | `PW_DEPLOY_MODE` | Terminals | Typical use |
|------|------------------|-----------|-------------|
| **host** (default) | unset / `host` | systemd units (`project-terminal@.service`, `project-setup-terminal.service`, `project-preview@.service`) spawn ttyd; tmux runs as the `admin` user | bare-metal / VM install via `install.sh` |
| **container** | `container` | the node app spawns/tracks ttyd itself and attaches to tmux on a shared socket | containerized install (this `Containerfile`) |

Host mode is unchanged from upstream. The rest of this doc covers container mode.

The optional [shared deployment service](docs/deployment-service.md) handles
project deployment jobs. Its LOCAL/EXTERNAL backend choice is separate from
`PW_DEPLOY_MODE`.

## Container mode

Build the image and run it. The app spawns each project's terminal as a
node-managed `ttyd` attached to a tmux server. For terminals to survive an app
(node) restart, point tmux at a **persistent sidecar** socket via `TMUX_TMPDIR`
(the sidecar owns the tmux server; the app is just a client).

### tmux owner contract

All non-bootstrap clients accept the shared tmux server only when **both** the
server marker and its process cgroup identify the configured owner. Container
mode does not weaken this check. In the supported rootful-Podman/systemd
topology, `systemd/pw-tmux.service` starts the sidecar with:

- `PW_DEPLOY_MODE=container`
- `PW_TMUX_OWNER_CGROUP=pw-tmux.slice`
- `PW_TMUX_REQUIRE_CGROUP=1`

The sidecar runs with `--cgroupns=host`, under the delegated `pw-tmux.slice`, so
the tmux PID's real `/proc/<pid>/cgroup` contains the stable segment the strict
gate expects. Do not remove the cgroup namespace/parent options independently.

The unit and application clients therefore resolve the same owner segment, and
the sidecar refuses to stamp or supervise a server when `/proc/<pid>/cgroup` is
unreadable or does not contain that segment. Other container supervisors must
set `PW_TMUX_OWNER_CGROUP` to a stable path segment present in the tmux server
process's cgroup; it is intentionally a deployment adapter rather than part of
the restore-path environment schema. Keep cgroup validation enabled.

For a refusal, save state and stop clients before killing the foreign server,
then restart the owner for the active mode (`pw-tmux-server.service` on a host,
`pw-tmux.service` for the documented container topology).

### Isolated test runs

Run tests from a dependency-complete disposable worktree with a writable private
npm cache and private tmux runtime/socket state. For example, set
`npm_config_cache` and `TMUX_TMPDIR` to directories owned by the test identity;
do not chmod/chown a production cache, socket, or runtime directory to make a
suite pass. CI executes the full suite explicitly in both `host` and `container`
deployment modes.

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
| `PW_TMUX_OWNER_CGROUP` | mode default | expected owner cgroup segment (`pw-tmux-server.service` for host, `pw-tmux.slice` for the supported container sidecar); override for another supervisor topology |
| `PW_NGINX_TEST_CMD` / `PW_NGINX_RELOAD_CMD` | (built-in) | override the nginx validate/reload commands |
| `PW_AUTH_MODE` | `local` | `local` (password) or `ldap` (directory bind) |
| `PW_AUTH_ENFORCE` | `false` | require login (soft mode treats anon as admin) |
| `PW_AUTH_HEADER` | `''` | trust a reverse-proxy / AD pre-auth header (e.g. `x-remote-user`) |
| `PW_LOGIN_ORG` | `your directory account` (ldap mode) | noun phrase in the login page's "Sign in with &hellip;" line, e.g. `your GOA account`. Read once at boot |
| `PW_SSO_USER_HEADER` | `''` | emit the signed-in user from `/api/auth/check` for sibling-app SSO |
| `PW_DEPLOY_CENTRE` | `false` | enable the Windows (WinRM/SMB) Deploy Centre |
| `PW_PER_USER_CLAUDE` | `false` | `true` runs each project under its owner's (`primaryUser`'s) identity: the owner's GitHub token is injected as `GH_TOKEN` (via a sourced `0600` env file — never on the process command line, so `ps` cannot leak it between panes) and Claude uses a per-user config dir seeded from the shared `~/.claude.json` MCP servers. The config dir is keyed on the user, not the project, so each owner logs into Claude once regardless of how many projects they own. Fail-closed: a project whose `primaryUser` has no resolvable token refuses to launch its terminal rather than silently using the shared login |
| `PW_PER_LAUNCHER_CLAUDE` | `true` (only matters when `PW_PER_USER_CLAUDE` is on) | Keys a cockpit tab's credentials to the person who OPENED it rather than to the project's owner, so a shared project stops billing every teammate's Claude/Copilot work to the owner's seat. Each tab also gets `COPILOT_HOME` pointed at that person's own Copilot dir, and the cockpit colours the tab by whose account it runs on (see `userTabColors` in `workbench.json`). Everything with no person behind it — the base session, the boot reattach, scheduled tasks, bots — stays on the project owner. Set to `false` to pin the old owner-keyed behaviour without reverting the app. Requires `PW_PER_USER_CLAUDE=true`; on its own it does nothing |

### GitHub CLI (`gh`)

`gh` is installed by the image (Containerfile), but **the running image can be older than
that layer**, and anything installed inside a running container is discarded when it is
recreated. Both have happened here. Install it where it survives:

```
sudo bash /opt/project-workbench/workspaces/ProjectWorkbench/deploy/install-gh.sh
```

That targets `/opt/npm-global/bin` — a host filesystem bind-mounted into the containers,
already first on a pane's PATH — verifies the download against GitHub's published SHA-256,
and refuses an ephemeral destination. Settings → System & Updates → Readiness checklist has
a line for `gh`, so if it ever goes missing the dashboard says so instead of an agent
discovering it mid-task.

| `PW_GITHUB_OAUTH_CLIENT_ID` (set it with `sudo bash deploy/set-github-oauth.sh <client-id>`) | `''` (feature off) | An OAuth app with **Device Flow** enabled, used by Settings → Users → *connect* (and a person's own `/me`) to authorise GitHub per user instead of pasting a token. Unset leaves the button disabled with an actionable message; nothing falls back silently. Two ways to fill it, NOT equivalent: an app this org registers (accountable, pushes fine, **but GitHub gates Copilot access and a self-registered app is not on that list**), or the GitHub CLI's own public client id (Copilot CLI documents that it accepts gh-app OAuth tokens, so one token does both jobs — at the cost of authorising as another vendor's app). A deliberate operator choice, which is why there is no default |
| `PW_GITHUB_OAUTH_SCOPES` | `repo,read:org,workflow` | What the authorisation asks for. `repo` is what makes the resulting token usable as a push credential — a token without it cannot push anywhere. Comma- or space-separated |
| `PW_GITHUB_OAUTH_BASE` / `PW_GITHUB_API_BASE` | `https://github.com` / `https://api.github.com` | Where the device flow and the verification call go. Overridable for GitHub Enterprise, and for tests, which point them at a local stub |
| `PW_API_TOKENS_PATH` | `/etc/project-workbench/api-tokens.json` | where machine-API service tokens live. Administered from Settings > API tokens; the file stores a SHA-256 digest per token and never the token itself, so it cannot hand back a usable credential (`0600` regardless). Tokens carry an explicit scope list -- today only `projects:register`, which authorises `POST /workbench/api/projects` and nothing else. There is deliberately no admin-equivalent scope: a service token can never reach a dashboard admin route, and a dashboard session can never authorise a machine call. Revoking sets a `disabled` flag rather than deleting, so the audit trail outlives the credential; the store is re-read per request, so revocation is immediate and needs no restart |
| `PW_SCHEDULED_TASKS` | `<registry dir>/scheduled-tasks.json` | where scheduled task definitions live. Managed from Settings → Scheduled tasks; the file is plain JSON and safe to edit by hand (it is re-read every tick, no restart). The scheduler is in-process, not a systemd timer, so it behaves the same in host and container mode; it does not arm in an isolated instance |
| `PW_EXTRA_NGINX` | `/etc/project-workbench/extra-nginx.conf` | inject env-specific sibling-app nginx locations (see `docs/consolidation/extra-nginx.example.conf`) |
| `PW_CANONICAL_REGISTRY` | `/opt/project-workbench/projects.json` | where THIS deployment's real registry lives. Any `PW_REGISTRY_PATH` other than this runs the instance isolated (no host tmux/ttyd/nginx writes). Deployments that keep the real registry elsewhere (e.g. GOA under `/etc/project-workbench/`) set this to that path to opt into host mode — host mode is never inferred from the path's shape |
| `PW_ISOLATED` | unset | `1` forces isolation even on the canonical registry (belt-and-braces for test instances) |
| `PW_TLS_ENABLED` | unset | `1`/`true`/`yes` generates an HTTPS nginx config. **Off by default** — cert files on disk never activate TLS by themselves |
| `PW_TLS_CERT` / `PW_TLS_KEY` | — | fullchain cert / private key paths. Required with `PW_TLS_ENABLED`; startup fails fast if either is missing or unreadable |
| `PW_TLS_SERVER_NAME` | — | this instance's hostname. Required with `PW_TLS_ENABLED`: it becomes `server_name` on both listeners and the target of the 80→443 redirect (`return 301 https://<name>$request_uri`), so the redirect never reflects the client-supplied `$host` |
| `PW_TLS_DEFAULT_SERVER` | unset | `1` marks both the :80 and :443 blocks `default_server`. Only for hosts where PW is the sole site; never claimed implicitly |

## Repository-managed deployment inputs

With Deploy Centre enabled, a project can declare either existing target (`dev`
or `prod`) in its local `.pw/deploy.json`. No registry edits, generated option
lists, discovery scripts, or network providers are needed. The manifest is read
again whenever the deployment page/panel opens and on every deployment request.
An omitted target retains its ordinary saved configuration.

For example, a repository with `identities/<slug>/tokens.json` and
`releases/<slug>/index.json` can declare:

```json
{
  "schemaVersion": 1,
  "slots": {
    "dev": {
      "label": "Publish visual identity",
      "script": "bash deploy/publish.sh \"$DEPLOY_IDENTITY\" \"$DEPLOY_BUMP\"",
      "inputs": [
        {
          "name": "identity",
          "type": "select",
          "label": "Visual identity",
          "env": "DEPLOY_IDENTITY",
          "required": true,
          "source": {
            "directory": "identities",
            "file": "tokens.json",
            "labelPath": ["$meta", "name"],
            "initialVersionPath": ["$meta", "version"],
            "version": {
              "directory": "releases",
              "file": "index.json",
              "valuePath": ["latest"]
            }
          }
        },
        {
          "name": "bump",
          "type": "select",
          "label": "Version bump",
          "env": "DEPLOY_BUMP",
          "required": true,
          "choices": [
            { "value": "patch", "label": "Patch" },
            { "value": "minor", "label": "Minor" },
            { "value": "major", "label": "Major" }
          ]
        }
      ],
      "version": { "input": "identity", "bumpInput": "bump" }
    },
    "prod": {
      "label": "Deploy MCP server",
      "script": "bash deploy/deploy-mcp.sh"
    }
  }
}
```

Each select must declare exactly one of `choices` or `source`; all selects are
required and start with an empty placeholder. A source enumerates only immediate
child directories, using the directory name as the value and a JSON property
path as its label. New identities appear on the next panel opening. The source
and metadata paths must remain inside the workspace, without symlinks, absolute
paths, or traversal. Missing/broken metadata is an error, not a hidden option or
a fallback to some other identity. Unknown manifest fields and duplicate names,
environment names, or choices are rejected. The limits are eight inputs, 1,024
choices per input, and 1 MiB per JSON file.

A script-only slot, such as `prod` above, may omit `inputs` or use `inputs: []`
and omit `version`. It is independently discoverable without a saved host script,
shows no identity/bump controls, and still requires an explicit Deploy action.
The example separates identity publication from rebuilding the MCP server;
the publishing script retains its own CSS refresh step.
Its managed POST body is `{ "inputs": {}, "manifestRevision": "..." }`; extra
inputs and stale revisions are still rejected. Declaring `version` without its
required source/bump inputs is invalid. This does not relax the publishing slot's
required identity/bump selections or infer any root/reauthentication privilege.

The optional slot `version` links the versioned source input to a
patch/minor/major input. Versions must be numeric `major.minor.patch`. An absent
matching release directory means the first release uses `initialVersionPath`
**exactly**, regardless of the chosen bump. An existing release directory with a
missing/invalid index is an error. Published and anticipated versions are shown
for the selected identity; independent releases are never compared with the
application's timestamp-based source version.

For a declared slot, the valid manifest's script and inputs are authoritative,
including when an older script is saved in `deploy-config.json`. The UI shows
read-only repository-managed fields and refuses Save for that slot. A malformed
manifest disables the affected slot rather than executing its saved script.
Slots without a manifest retain their existing Save, URLs, `{ "option": ... }`
request and `DEPLOY_OPTION` behavior.

The existing deployment POST accepts
`{ "inputs": { "identity": "alpha", "bump": "patch" }, "manifestRevision": "..." }`
for managed slots. Obtain the resolved manifest/revision from the existing
`GET /api/deploy/:project/:target/version` endpoint or the rendered card. Only
declared values and the optional existing `password`/`savePassword` fields are
accepted. The server re-reads the manifest and metadata, rejects stale revisions,
and rechecks after reauthentication. A manifest removed after opening the panel
cannot cause that request to fall back to a saved script. Reopen the panel or
reload the page after a stale-choice error.

Inputs travel as literal environment values, not substitutions into shell text;
the declared script runs from the project workspace. Quote environment arguments
in the script as shown above. No provider command runs for managed GET requests.
Existing project access, admin-only configuration, CSRF, request-first
reauthentication, and pane-account execution remain in force. A manifest cannot
declare `runAsRoot`, disable `reauth`, or override credential/environment control
fields: those privileges remain operator-controlled in the saved configuration.
An explicit operator `runAsRoot` grant still applies to the slot, so review
repository-managed scripts accordingly.

History and audit entries retain selected `inputs`, `currentVersion`,
`targetVersion`, and the manifest revision, as well as the observed version and
existing deployment result. A successful versioned script must leave the selected
published metadata at its anticipated version; a mismatch is reported as a
failed deployment, not an inferred success. Publishing/deployment happens only
after a human invokes Deploy (or runs the project's explicit publish command);
opening a panel never publishes anything.

## Release version

The canonical release identifier lives in `app/VERSION` and is shown in the shared footer on every primary UI, including the project cockpit. It must match `1.YY.MMDD.hhmm` (for example, `1.26.0721.2233`). Bump this file once for every release commit; because it is part of `app/`, both `install.sh` and container builds carry the same version to every environment.

## Optional image extras

The `Containerfile` keeps a generic runtime. Two optional, commented sections
enable environment-specific needs:

- **Internal / AD CA** — for `PW_AUTH_MODE=ldap` when the directory's CA isn't
  publicly rooted (drop certs in `config/ca/`, uncomment the `COPY` + `update-ca-certificates`).
- **Deploy Centre toolchain** — `smbclient` / `pywinrm` / .NET SDK for
  `PW_DEPLOY_CENTRE=true`. Not a commented section: it is a **build arg**, so an
  instance that needs it does not have to carry a local diff.

  ```bash
  podman build -t project-workbench:latest \
    --build-arg PW_DEPLOY_TOOLCHAIN=1 \
    --build-arg PW_DOTNET_CHANNELS="8.0 10.0" .
  ```

  | build arg | default | meaning |
  | --- | --- | --- |
  | `PW_DEPLOY_TOOLCHAIN` | `0` | `1` installs smbclient, libicu, pywinrm and the .NET SDK(s) |
  | `PW_DOTNET_CHANNELS` | `8.0` | space-separated channels; pass every one your projects target |

  This layer is the first one that needs the network, so it is where a host with
  no DNS in the default container network shows up — `Temporary failure resolving
  'deb.debian.org'`, then `Unable to locate package`. The earlier layers do not
  hide a working network, they are simply cache hits. Add `--network=host` so the
  build resolves the way the runtime containers already do (they all run
  `--network=host`), or `--dns=<resolver>` if you want to keep the build
  namespaced:

  ```bash
  podman build --network=host -t project-workbench:latest \
    --build-arg PW_DEPLOY_TOOLCHAIN=1 \
    --build-arg PW_DOTNET_CHANNELS="8.0 10.0" .
  ```

  Note that reachability tested from a *running* PW container proves nothing about
  the build: those run `--network=host` and so borrow the host's resolvers, while
  `podman build` defaults to its own network namespace.

  Set `PW_DOTNET_CHANNELS` from the `TargetFramework` values in the projects you
  actually deploy — a `net10.0` project cannot be published by an 8.0-only SDK.
  The SDK lands in `/usr/share/dotnet`, world-readable, because the pane account
  has to be able to run it: installing it into a private home (e.g. `/root/.dotnet`,
  mode 0750) leaves `dotnet` Permission-denied in every terminal while
  `which dotnet` reports nothing, which is easy to misread as "not installed".
  The build fails fast if any piece is missing — it runs `dotnet --list-sdks`,
  imports `winrm`, and checks for `smbclient` before the layer is committed.
