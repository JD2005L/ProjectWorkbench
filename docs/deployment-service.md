# Shared host deployment service

The optional **EXTERNAL** deployment backend runs as a native host Node.js
service, independently of the PW process/container. PW remains the authenticated
UI for submitting jobs, viewing logs, cancelling work, and administering the
runner at `/workbench/deploy-service` (adjust the PW base path as needed).
No additional container, public listener, or privileged script endpoint is
required.

**Installation, activation, and production cutover are human operations.** The
scripts in `deploy/service/` prepare an installation; running tests or updating
this repository does not change a live host. The installer does not modify the
PW service, container, settings, application data, or existing application units.

## Global selection, not per-project enrollment

PW's portable/global Settings selects **LOCAL** or **EXTERNAL**, with the
external endpoint and a protected token. LOCAL remains the default until a PW
administrator deliberately changes it. The token is entered by an administrator
and stored encrypted by PW; it is not a project setting or an environment
identity embedded in this repository.

Every new project inherits the global backend. There is no separate runner
registration, per-project execution-account selection, or new root-grant flag.
Project-specific metadata still describes **what to publish and where**:
repository-managed `.pw/deploy.json` slots, scripts/adapter recipes, deployment
inputs, and destinations. Ordinary destination provisioning (for example an
existing runtime user's application unit) is not runner enrollment.

The broker's root-owned host policy selects the build/runtime accounts and
allowed adapters once for the installation. These execution identities and the
supervisor unit name are immutable through PW's service controls; they are
separate from mutable concurrency, timeout, retention, and pause settings.
Changing an identity requires an operator-controlled host policy change and
explicit runner restart. Optional target pause/timeout overrides are
operational controls, not a prerequisite for a new project. Changing the
global backend does not translate arbitrary old shell scripts.

### Existing applications with legacy resource names

New projects use the project/target naming convention automatically. An existing
application may have an image, container and user unit whose shared name does not
match that convention. Do not rename its live runtime or remove the destination
guard to make it fit. An operator can preserve that name through the optional
`resourceNames` object in the root-owned host policy:

```json
{
  "resourceNames": {
    "ExampleDashboard/prod": "legacy-dashboard"
  }
}
```

This is a destination binding, not a new execution identity or a root grant.
The key is the exact PW project name and `dev` or `prod` target. The value is
the existing shared image/container/user-unit name, without a tag or `.service`
suffix. For that target it becomes the default and the only permitted image and
service name; an explicit recipe must match it. The name is also reserved against
other projects, including a project whose normal naming convention would produce
the same name. Duplicate bindings are rejected.

Only legacy exceptions need entries; new conventionally named projects still
inherit the backend without registration. Bindings cannot be changed through
jobs, project recipes, runtime settings or PW target controls. They are part of
the operator-controlled policy and take effect on an explicit runner restart.
The operator must first confirm the destination belongs to that project and
target. A binding does not create, rename, migrate or start any runtime resource,
and does not enable rootful containers or system units.

## Host prerequisites

Use a reviewed checkout and an operator-maintained Linux/systemd host. The
installer checks prerequisites and fails rather than installing packages.

| Prerequisite | Operator responsibility |
| --- | --- |
| Node.js 20+ at `/usr/bin/node` | The broker and its step launcher both use this path. The package uses only Node built-ins; there is no `npm install` for the runner. |
| `/usr/bin/bash`, `npm`, `podman`, `setpriv`, `systemd-run`, `systemctl`, `getent`, `id` | Use distro-supported tools. `systemd-run` must support `--wait`, `--pipe`, `--collect`, `--uid`, `--property`, `--working-directory`, and `--service-type`. Steps use the approved account name with `--uid`, not an explicit `--gid`. |
| Rootless Podman | The installer requires `newuidmap` and `newgidmap`. Provide a supported rootless storage/network stack and valid nonconflicting `/etc/subuid` and `/etc/subgid` allocations. Confirm kernel, cgroup, SELinux/AppArmor, and storage policy on the actual host. |
| A dedicated local build account | Locked password, nologin/false shell, no supplementary groups or sudo permissions, with its own home. The installer can create it only with `--create-build-user`. |
| An existing non-root runtime account | May be the build account on a new installation. For existing applications, select their established non-root account using `--runtime-user`. UID 0 and GID 0 are rejected. Existing runtime accounts/units/data are not rewritten. |
| User managers/runtime directories | Configure lingering for both accounts. `--enable-linger` explicitly authorizes `loginctl enable-linger`; this can start those users' managers. |
| IIS/tool-specific prerequisites | Where a recipe requires them, the operator supplies the established .NET SDK, Python/WinRM modules, `smbclient`, trust configuration, network access, and destination permissions. This package does not guess host-specific package or remote-administration commands. |

Do not reuse a human administrator account as the builder or solve a refusal
with broad sudo grants, a privileged container, or recursive permission changes.
For current containers, create the dedicated locked builder and keep the
established service account only as `runtimeUser`; do not reuse a sudo-capable
runtime account as `buildUser`. The runtime user must never be root.

## Prepare an installation

The following commands are examples for an **operator on the destination
Linux host**, not instructions for an agent to execute remotely.

Choose subordinate ranges through the host's established allocation process.
The installer does not choose a start value. It checks all entries in the local
subordinate-ID files, rejects overlapping allocations and overlap with
enumerated or individually resolved account/group IDs, and uses the distro
`useradd`/`usermod` tools. Primary GIDs from passwd records and the resolved
execution accounts are included even if NSS has no corresponding group record.
Directory/NSS identities that cannot be enumerated still require operator
review. Do not run concurrent account-allocation changes.

For a new build account, supply separately approved UID and GID starts:

```bash
: "${SUBUID_START:?Set an explicitly allocated, unused subordinate UID start}"
: "${SUBGID_START:?Set an explicitly allocated, unused subordinate GID start}"
: "${RUNTIME_USER:?Set the existing non-root application runtime account}"

sudo bash deploy/service/install.sh \
  --runtime-user "$RUNTIME_USER" \
  --create-build-user --enable-linger \
  --subuid-range "$SUBUID_START:65536" \
  --subgid-range "$SUBGID_START:65536" \
  --check

sudo bash deploy/service/install.sh \
  --runtime-user "$RUNTIME_USER" \
  --create-build-user --enable-linger \
  --subuid-range "$SUBUID_START:65536" \
  --subgid-range "$SUBGID_START:65536"
```

Omit `--runtime-user` only when the dedicated build account is intentionally
also the runtime account. A distinct existing runtime account needs its own
already-provisioned subordinate allocations. Existing sufficient build-account
allocations can be reused without passing range flags.

`--check` performs preflight only. The second invocation creates any explicitly
authorized account/allocations, stages code, creates missing configuration and
credential files, and reloads systemd's unit definitions. **It does not enable,
start, or restart the runner.** Repeated preparation preserves existing policy,
token, state, and previously staged releases. Partial preparation failures are
reported; accounts or allocations already created are not silently removed.

Defaults and layout:

| Path | Contents |
| --- | --- |
| `/opt/pw-deploy/releases/<content-digest>/` | Root-owned, non-writable-by-others, explicit file allowlist: runner modules, `app/atomic-file.js`, a dependency-free ESM package marker, these installation tools, and this document. |
| `/etc/pw-deploy/config.json` | Root-owned host policy; newly generated mode `0600`. |
| `/etc/pw-deploy/service.token` | Newly generated random credential, root-owned mode `0600`. Existing credentials are never rotated by installation. |
| `/var/lib/pw-deploy/` | Dedicated root-owned service state directory, mode `0711`. |
| `/var/lib/pw-deploy/jobs/` | Dedicated root-owned job directory, mode `0711`; other users cannot list jobs. |
| `/var/lib/pw-deploy-build/` | Dedicated builder home/rootless storage when this account is created. Separate from service state. |
| `/etc/systemd/system/pw-deploy.service` | Managed broker unit, pointing directly to a versioned release rather than a mutable checkout or symlink. |
| `/run/pw-deploy/` | Systemd-managed root-only runtime directory, mode `0700`. |

Code is intentionally different from private state: newly installed package,
release, `app`, and `app/deployment` directories are explicitly set to `0755`,
and JavaScript files (including `app/deployment/step.js` and `service.js`) to
`0644`. The ESM package marker and imported modules are also readable by the
non-root worker. These modes are set explicitly after creation so the
installer's `0077` umask cannot strand worker code in root-only directories.
Existing package/release directories must already be readable and traversable;
an inaccessible code parent is refused rather than silently shipping a worker
that will fail. Broad operator-owned ancestors are never repermissioned.

The service state layout is deliberately split:

| State path | Ownership and permissions |
| --- | --- |
| `stateDir` and `stateDir/jobs` | Root-owned `0711`, prepared by the installer. |
| `stateDir/jobs/<UUID>` | Root-owned `0711`, created/managed by the core for each job. |
| `settings.json`, `targets.json`, and each job's `job.json`/retained event data | Root-owned `0600`; directory traversal never grants access to metadata. |
| `stateDir/jobs/<UUID>/stage` | Owned by `buildUser`, mode `0700`; only the allocated build stage is handed to that account. |
| `stateDir/jobs/<UUID>/artifacts` | A separate root-owned `0711` handoff directory, not part of the builder-owned source stage. |
| `stateDir/jobs/<UUID>/artifacts/candidate.oci` | Owned by `root:<runtime primary GID>`, mode `0440`. The runtime account receives group read access, not ownership or write access. |

Mode `0711` provides traversal, not directory listing, to other users. It lets
an unprivileged build reach its allocated stage without making job metadata
readable. Only the exact dedicated `stateDir` and `stateDir/jobs` receive that
mode from the installer, including when safely upgrading existing `0700`
directories. The installer does not recursively chmod/chown state, alter
existing broad ancestors such as `/var/lib`, or traverse/repermission UUID
jobs, stages, artifacts, or data files. The core owns those per-job paths.
Config and token files remain private at `0600`; they are never included in
the directory permission operation.

Symlinks, non-root ownership, and group/world-writable state directories are
refused before changing permissions, not repaired in place. Existing
configuration and credential files must also be private. A restrictive
operator-owned ancestor must be reviewed by the operator; the installer will
not widen that ancestor to make a build work. Point `stateDir` only at a
dedicated service directory, never at a shared system/data/workspace root.

`--prefix`, `--config-dir`, `--state-dir`, `--build-user`, and `--build-home`
support a fresh alternative layout. Paths must be normalized, absolute Linux
paths without spaces, symlinks, or writable/untrusted parent directories.
Code, configuration, state, source checkout, and builder home must be separate.
Existing paths must already have the appropriate owner/type/permissions; the
installer refuses rather than recursively repairing them. It never copies a
live `.git`, PW data, application environments, or application systemd units.

Existing configuration is authoritative. Installation flags cannot silently
change its accounts, state location, or listener. The packaged unit name is
`pw-deploy.service`; its credential is `service.token` beside `config.json`.
For policy changes, an operator edits the protected configuration deliberately.
An existing unmanaged unit or changed/incomplete content-addressed release is
refused instead of overwritten.

## Listener and credentials

`deploy/service/config.example.json` documents the complete initial host
policy. Its listener is `127.0.0.1:3800`, health hosts are loopback, concurrency
is one, timeout is 600 seconds, and retention is seven days. These are policy
defaults, not project-specific hostnames. `adapters` can restrict the available
adapter types. `unitName` is optional and defaults to `pw-deploy.service`; when
present it must match that persistent unit for this package.

The installer prints the **credential file path and endpoint only**, never the
token. Transfer the token directly from the protected file into authenticated
PW Settings through an approved secret-transfer workflow. Do not use `cat`,
`echo`, command arguments, shell history, tickets, logs, or general-purpose
backups to move it. Do not bundle it with the release artifact. A missing token
beside an existing configuration is an error, not permission to silently
generate a different identity.

The normal endpoint is `http://127.0.0.1:3800`. The existing host-network PW
container can reach that listener without any PW service changes. In an
ordinary isolated container, loopback denotes the container itself: configure
an appropriate secure topology rather than binding the broker publicly.

For a new Unix-socket installation, use `--socket` instead of host/port flags.
The resulting policy uses `{"socketPath":"/run/pw-deploy/control.sock"}` under
`listen`, and the PW endpoint is `unix:/run/pw-deploy/control.sock`. The broker
sets the socket to `0600`; only an appropriately privileged PW process with
access to that path can connect. Do not loosen socket permissions to work
around an incompatible container/user topology.

Remote installations use a configurable **HTTPS** endpoint behind an
operator-managed TLS reverse proxy. Keep the broker on loopback, restrict
proxy access to authorized PW callers, retain bearer authentication, and
disable request-body/Authorization-header logging. Do not expose port 3800 to
the network or put credentials in URLs. HTTP endpoints are loopback-only.

## Activate and cut over deliberately

Before the first activation, confirm rootless Podman works under both chosen
accounts, their user managers and runtime directories are available, the
required runtime application units already exist, and the optional toolchains
are present. These environment prerequisites cannot be established by a local
Windows fixture test.

One-time activation is explicit:

```bash
sudo systemctl enable --now pw-deploy.service
```

Alternatively, add `--activate` to the human-run installer invocation for an
inactive service. `--activate` refuses an already-active service; it is not an
upgrade restart shortcut.

Use PW's authenticated **Test connection** before cutover. A successful
`systemctl` start request alone is not proof that application-level startup
and readiness completed. The runner's public `/health` is minimal; its
authenticated `/v1/health` confirms the compatible, ready worker.

In PW, review/migrate the deployment recipes while the global backend is still
LOCAL. Then an administrator supplies the endpoint and protected token and
selects EXTERNAL in global Settings. Exercise an approved development target
before scheduling production work. New projects subsequently inherit this
selection without service enrollment.

## Execution, recovery, and log lifetime

The native host service owns the broker and durable job queue/status store,
not PW's process or container. Each command runs in a named transient
**system** service created through `systemd-run --wait --pipe --collect`, with
the validated non-root account **name** supplied through `--uid` and these properties:
`Delegate=yes`, `BindsTo=pw-deploy.service`, and `After=pw-deploy.service`.
Deployment commands are not launched in user scopes or with `systemd-run --user`.
Steps use `Type=oneshot` and `TimeoutStartSec` so a SIGTERM interruption is not
treated as a successful command. The broker also enforces a whole-job deadline.
At startup its PID must match the configured system unit's MainPID, and it
refuses new steps while a broker lifecycle operation is pending.

Systemd derives the account's native primary group from the named passwd
identity. Do not force a numeric `--gid` or require `getent group <gid>` to
return a record: some NSS/AD users have a valid passwd primary GID without a
separate group entry, and explicitly selecting that GID can fail with
`216/GROUP`. The installer resolves runtime identity through `getent passwd`
by name. Group enumeration for subordinate-ID collision checks and a
new local builder's group-name conflict check do not require a matching
runtime primary-group record.

The broker runs as root only for validated policy, protected metadata, source
stage ownership setup, and fixed account switching. Both `script` and `iis`
jobs, and npm dependency steps, run under the dedicated non-root builder with
`NoNewPrivileges=yes`.
Trusted rootless Podman steps use `--cgroup-manager=cgroupfs` within their
delegated step unit so build/run children cannot escape cancellation into user
manager scopes. They must still be able to use subordinate UID/GID helpers;
the broker unit intentionally avoids blanket `NoNewPrivileges=yes` or
`ProtectSystem` restrictions that would prevent those controlled operations.
Image building uses the builder's rootless store; image import and application
restart use the configured non-root runtime account.

The runner survives a PW restart. A **runner** restart stops its bound
transient system units and their process trees. Startup recovery identifies
steps by the specific job UUID and checks that each unit's `BindsTo` includes
the configured broker unit before stopping it. Both conditions are required;
recovery does not stop unrelated units or units belonging to another
supervisor. A foreign binding or an unconfirmed stop is a recovery failure,
not permission to kill unrelated work or report a clean interruption.

Persisted active jobs become interrupted only after owned execution is safely
stopped; they are never automatically replayed. Review their results and
deliberately submit a new job when appropriate. These bindings supervise
deployment steps, not PW or the independently managed application units that
are deployment destinations.

The per-job `stage`, `home`, and `artifacts` directories are removed immediately
after execution has safely stopped, including safely terminated failed or
cancelled execution. They do not wait for the history retention window. A
failed stop halts scheduling and defers cleanup until recovery has stopped the
exact owned units, rather than deleting files a live process might still use.
Recovery preserves an already recorded failed outcome; it does not replay
scripts or credentials.

Retained logs contain **operational events only**, alongside protected job
metadata. Redacted raw stdout/stderr is bounded in-memory/live output, not a
durable transcript: it can be truncated or expire and is lost on broker
restart. The runner does not write raw command output to its retained journal
or backups. Retained metadata is pruned at startup and then hourly according
to the retention setting; this is separate from immediate per-job staging
cleanup. Retention governs operational history, not full console output.
Scripts must still avoid emitting credentials; output redaction is not
permission to print secrets.

The version API reports the last successful retained deployment, not a fresh
runtime probe. Version metadata can be unavailable after its history expires.

## Recipes and migration

Keep recipe scripts in the project's committed source and use relative paths
inside the uploaded snapshot. A synthetic script/IIS-style manifest begins:

```json
{
  "schemaVersion": 1,
  "slots": {
    "dev": {
      "label": "ExampleApp development",
      "script": "bash deploy/publish.sh \"$DEPLOY_SITE\"",
      "inputs": [
        {
          "name": "site",
          "type": "select",
          "label": "Destination profile",
          "env": "DEPLOY_SITE",
          "required": true,
          "choices": [
            { "value": "example-dev", "label": "ExampleApp development" }
          ]
        }
      ]
    }
  }
}
```

`deploy/publish.sh` is the project's reviewed non-root publisher, not supplied
by this package. Its destination profile supplies generic IIS host/site/share
details appropriate to that project, and approved credentials arrive through
PW's protected credential flow. Do not commit passwords or transplant inline
`nsenter`, `sudo`, `git pull`, or absolute-workspace assumptions into it.

The service protocol supports `script`, `iis`, and `podman` adapters. Put a
Podman recipe in `slots.<target>.execution`. Such a slot needs no project-specific
shell script; LOCAL mode refuses it instead of reporting a no-op deployment:

```json
{
  "schemaVersion": 1,
  "slots": {
    "dev": {
      "label": "ExampleApp development",
      "execution": {
        "adapter": "podman",
        "image": "example-app-dev",
        "service": "example-app-dev",
        "dockerfile": "Containerfile",
        "healthUrl": "http://127.0.0.1:8080/health",
        "versionField": "version",
        "versionFile": "VERSION",
        "versionFormat": "json"
      }
    }
  }
}
```

PW sends the `execution` object as the broker's `recipe`. Image/service names are constrained to
the selected project and dev/prod target. The example health URL/port must be
replaced with the project's actual configured destination; its host must be
allowed by root-owned `healthHosts`. An existing `example-app-dev.service` in
the runtime user's manager is destination provisioning, not a root-script
grant. The image must expose the source version as agreed by the recipe.

Version stamping is explicit. With `versionFile`, the runner writes the source
commit's 12-character SHA into that relative file. `versionFormat: "text"` is
the default; `"json"` writes `version` and `builtAt` fields. The Dockerfile must
copy the stamp and the application must read it. Without `versionFile`, source
files are not implicitly rewritten. `versionField` optionally checks that field
in the health endpoint's JSON response.

The Podman adapter runs host-side
`npm ci --omit=dev --no-audit --no-fund` only when the committed source has a
`package-lock.json` at its root. Normal npm lifecycle scripts remain enabled:
they run as the non-root builder with `NoNewPrivileges=yes`, without privilege
elevation. Without a root lockfile, the host npm step is skipped and the
Dockerfile/Containerfile handles dependencies, including for non-Node
containers. A lockfile only in a nested project directory does not trigger the
host npm step.

Base images use Podman's `--pull=missing` policy, fetching missing images into
the dedicated builder's rootless store. A newly provisioned builder does not
require per-project manual cache seeding or runner enrollment. Registry
connectivity, trust, and any required registry credentials remain
operator-provided prerequisites; unavailable images fail the job rather than
granting additional privileges.

The container adapter checks an isolated candidate, transfers it through a
root-owned artifact readable by the runtime group, promotes it, and restarts
the existing application unit. It keeps one `<image>:rollback` tag and restores
the previous running image after failed activation/health when available.
Unsafe stop or failed restoration halts the worker for recovery. Per-job
candidate tags are removed; no broad Podman prune is performed.

Runtime units must correctly supervise their containers. The established
notify pattern uses `Type=notify`, `NotifyAccess=all`, Podman's conmon readiness
notification, and explicit stop/remove hooks before cgroup teardown. A bare
`podman run` service without a proper shutdown path is not an equivalent
replacement for a reviewed runtime unit.

Source is tied to an exact Git revision. Runtime databases, private `.env`
files, keys, and live systemd/application state are not deployment source.
PW requires a clean committed workspace; it never commits, stashes, resets, or
uploads an operator's pending changes. Scripts receive `PW_SOURCE_REVISION`
and should not assume the staged snapshot contains a `.git` directory.
Build/stage contents live under service state, and a builder receives access
to its allocated stage rather than root-only job metadata.

Use the read-only inventory before a cutover:

```bash
sudo node deploy/service/inventory.mjs \
  --config /etc/project-workbench/deploy-config.json
```

It reports only project/slot identifiers, script/version-command presence, and
review flags such as namespace entry, old `runAsRoot` grants, service control,
container assumptions, absolute paths, mutable checkouts, and optional remote
toolchains. It never prints scripts, environment values, passwords, or
credentials. Flags are heuristic review aids, not proof of compatibility;
comments can produce false positives. Invalid input fails explicitly.

Keep LOCAL unchanged while adapting old slots. Inventory does not rewrite
scripts, remove old grants, register targets, or flip the global backend.
Use reviewed project-specific deployment procedures; do not infer commands
for a real IIS host from these placeholders.

## Optional static landing card

The existing dashboard renderer and health polling are reused. The helper
accepts exactly one top-level inline JavaScript
`const services = [ {name,desc,url,healthUrl,tags}, ... ];` declaration with
literal cards. Single/double quotes, comments, and trailing commas are
supported. Dynamic values, ambiguous markers, unexpected JavaScript before
the declaration, and unexpected formats are refused rather than guessed.
No dashboard JavaScript is executed.

Human-run preview and application:

```bash
sudo node deploy/service/dashboard-card.mjs \
  --dashboard /var/www/dashboard/index.html --pw-base /workbench --check

sudo node deploy/service/dashboard-card.mjs \
  --dashboard /var/www/dashboard/index.html --pw-base /workbench
```

The new **Deployment Service** card points to
`/workbench/deploy-service`, with health polling through
`/workbench/api/deploy-service/health` and tags
`Deployments`, `Logs`, `Administration`. The UI, job/log access, and administrative
operations use PW's existing authentication/project authorization. The PW health
proxy is deliberately public and returns only aggregate readiness/backend
status, not endpoints, job metadata, account names, or credentials. PW supplies
the service credential internally when probing the broker; the card is not a
token-bearing direct link to port 3800. While LOCAL is selected, readiness
describes the local backend; it does not prove an external runner is active.

The tool only inserts the card into the known array, detects an existing link,
and preserves every existing card and all renderer/markup content. It rejects
URL origins, traversal, query strings, fragments, symlinks (including parent
components), hard-linked files, and unsafe directory ownership/permissions.
The containing directories must be root-owned and not group/world-writable;
the original regular page's owner and mode are retained.

Before replacing the page atomically, it creates the root-only page-only copy
`index.html.pw-deploy-service.bak` beside it. No configuration, state, or token
is backed up. A conflicting existing backup is never overwritten. Interrupted
operation locks are reported for operator inspection, not silently removed.
Rollback is also explicit:

```bash
sudo node deploy/service/dashboard-card.mjs \
  --dashboard /var/www/dashboard/index.html --pw-base /workbench --rollback
```

Rollback refuses to overwrite edits made after the generated card change. It
retains the named backup. The installer never invokes this optional helper.

## Later code updates and rollback

Run the installer again from the reviewed replacement source. Existing
policy/token/data remain unchanged and old releases are retained. The updated
unit points to the new release, but an active runner continues using the old
release until the human maintenance action:

```bash
sudo systemctl restart pw-deploy.service
```

Or supply `--restart` explicitly to the installer for an existing managed
service. Pause/drain jobs first if interruption is not acceptable. There is no
implicit restart, active-job replay, release deletion, or application-data
rollback. A code rollback means preparing a reviewed prior compatible source
version and explicitly restarting; assess persisted-state compatibility
before doing so. Never recursively delete the package/state roots as an
upgrade or rollback mechanism.

## Local validation

The existing Node test runner exercises isolated fixture files and never
activates a system service:

```bash
node --test test/deploy-service-install.test.mjs test/deploy-service-install-dashboard.test.mjs test/deploy-service-install-inventory.test.mjs
bash -n deploy/service/install.sh
```

Linux account tools, real ownership/SELinux enforcement, rootless Podman,
systemd job supervision, transport integration, destination permissions, and
production cutover remain human installation checks, not claims made by
these portable fixture tests.

The separate `deploy-service-native`, `deploy-service-startup-native`, and
`deploy-service-podman-native` test files are opt-in Linux host fixtures.
They are skipped unless `PW_DEPLOY_NATIVE_FIXTURE=1` is explicitly set; the
Podman scenario also requires `PW_DEPLOY_FIXTURE_RUNTIME` to select a prepared
non-root account and a cached public `docker.io/library/debian:12` image.
Run them only in a disposable source checkout on an approved test host. They
create and remove uniquely named fixture units/containers, use synthetic data,
and do not install the persistent broker or deploy an existing application.
