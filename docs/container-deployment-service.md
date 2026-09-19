# Contained deployment service

The deployment engine, authenticated administration console, and job toolchain
are packaged together as an independent Podman service. PW is an API client,
not the host for this console. The same immutable image is used for disposable
job containers, so application builds do not require host Node, npm, .NET,
PowerShell, SMB clients or Python deployment modules.

```text
PW project deployment buttons ---- authenticated API ----+
                                                        |
Browser ---- HTTPS ---- [engine + console container] ----+--- isolated job containers
                               |                              (same pinned image)
                               +--- fixed-action builder supervisor
                               |    per-job API/store + delegated user unit
                               +--- fixed-action runtime connector
                                    existing non-root application units/store
```

This is the replacement rollout direction. Do not run the legacy native broker
installer to prepare this service. Native installations remain a separate
compatibility option described in `deployment-service.md`; there is no automatic
or silent fallback between the two execution environments.

## Rollout gate

This candidate is not yet approved for live rollout. Standalone console and
script-worker operation have bounded integration coverage, and the real
dependency-worker/build/export path reaches an intentionally refused runtime
import. That refusal is not evidence of deployment or successful activation.

The trusted host-fixture observer reproduced a real defect in the original
shared remote-build path: client cancellation left its nonce-bound OCI RUN
active for the full twenty-second stop window. The replacement gives each
Podman job its own supervised API process, cgroup and writable store. Bounded
real prototypes proved cancellation, independent deadline and bound controller
loss, but prototypes alone do not approve the integrated connector or full
deployment lifecycle. Do not expose host namespaces to project jobs to obtain
that evidence. Actual runtime import, promotion, health acceptance and rollback
also remain outstanding.

Keep PW in LOCAL mode and retain the existing landing-card destination until
the remaining lifecycle evidence, independent review and operator prerequisites
below are complete. Account/range/key/proxy/SELinux provisioning and application
cutover remain deliberate operator actions, not effects of building this image.

## What remains on the host, and why

| Facility | Purpose and boundary |
| --- | --- |
| Existing Podman, systemd/Quadlet and rootless helpers | Container execution and supervision. Use Podman 5.8.2 or a compatible reviewed version, cgroup v2 and valid subordinate-ID allocations. |
| Dedicated locked, non-sudo builder account and its Unix Podman API | Owns the controller and temporary build resources. Its API grants the whole authority of that account; a `:ro` socket mount does not make the API read-only. Never substitute a rootful daemon or an administrator's broad runtime socket. |
| Small fixed-action builder connector | Creates and stops private per-job Podman API units using the existing user manager. It has no source/shell endpoint, SDK, web UI or always-on deployment daemon. Private writable stores prevent ambiguous cleanup of shared Buildah records. |
| Existing runtime account, SSH and the small fixed-action connector | Preserves existing application's user-unit lifecycle, volumes and image store. The connector uses Python's standard library, Podman and systemctl, not a host deployment SDK or an always-on Node daemon. It is not a shell/argv execution endpoint. |
| Existing TLS reverse proxy and trust configuration | HTTPS for the browser/API; the container port is published only on host loopback. Preserve the site's perimeter and certificate policy. |

A container cannot restart a host-managed application without some host
authority. The runtime connector confines that unavoidable boundary to approved
resource names and fixed operations. Project scripts never receive its SSH key,
the builder socket, controller state, a host home, or a host PID/mount namespace.
The connector cannot turn a recipe into a rootful deployment or control-plane
promotion.

Account creation, ID allocations, socket/linger setup, SSH authorization and
SELinux policy are one-time operator responsibilities. Do not invent ranges,
remove another account's allocation, reuse an administrator as builder, or
disable enforcement to make a connection work. On an existing host, inventory
active stores/mappings before changing them.

## Source and image

The image definition is `deploy/container/Containerfile`. Its base and
deployment-time .NET/WinRM/SMB installation follow PW's existing Containerfile.
PowerShell uses Microsoft's documented Debian package repository. The remote
Podman client is pinned to 5.8.2 and its upstream SHA-256; no local Podman engine
is started inside the service image.

From a clean, reviewed commit in an approved build environment:

```bash
bash deploy/container/build.sh
```

The script streams an explicit Git archive into the image build. It excludes
untracked work, `.git`, runtime configuration, and unrelated workspace files;
it does not require host Node or npm. It prints the resulting image ID. Publish
or transfer that reviewed image through the existing image-distribution process,
then pin both the controller and `container.workerImage` to its immutable ID or
repository digest. Do not use `latest` for the worker.

The build explicitly selects Docker image format to preserve the controller's
`HEALTHCHECK` metadata, which Podman's default OCI image format discards. This
does not change the rootless Podman/OCI container boundary. Image transfer must
preserve that configuration and its exact image ID.

The image normalizes its packaged source permissions rather than inheriting
Git archive's group-writable defaults: directories and the two connector
entrypoints are 0755, other source/templates are 0644. Connector copies must
remain root-owned and not group/other-writable when installed on the host.

The image includes Node/npm, Bash/setpriv, the remote Podman client, SSH, Python
WinRM/NTLM support, SMB/Kerberos clients, .NET SDK channels 8.0 and 10.0, and
PowerShell. Required project SDK/target compatibility is still checked by the
deployment script; packaging is not permission to retarget an application's
framework or database.

Existing IPv4-first/no-family-autoselection settings are preserved. Any required
site CA trust must be present in the reviewed worker image; a CA mount on the
controller is not inherited by isolated job containers. Confirm that trust and
worker egress before enabling a site's IIS recipes. Do not disable certificate
validation, broadly mount/relabel shared host files, or fall back to host
dependency installation when worker networking is not ready.

## Controller configuration and secrets

Copy and complete `deploy/container/config.example.json` outside the repository.
Set a unique stable instance UUID, the reviewed image ID, the public HTTPS
origin, and the operator-approved builder and runtime connections. The all-zero image ID and
example host are deliberately non-operational placeholders.

Execution identities, builder socket, SSH destination/key paths, image, adapter
allowlist and legacy resource bindings are immutable through the web/API
settings. The state volume binds its execution identity; moving it to a different
instance, builder socket, private socket directory or either connector destination requires deliberate reconciliation
of existing work, not an automatic restart with different authority.

Mount configuration, machine API credential, console administrator credential,
builder/runtime SSH keys and pinned known-hosts file as Podman secrets with UID/GID 0
and mode 0400 **inside the container user namespace**, as shown in the Quadlet
example. A root-owned host bind file may appear as the overflow UID inside a
rootless container; do not weaken the file-owner checks to accept it.

The API and console credentials must be separate strong values. The controller
refuses reuse. Provision them through the approved secret workflow; do not put
values into source, image layers, environment examples, URLs, shell arguments,
logs or chat. For a new synthetic/operator setup, the image itself can generate
values directly into `podman secret create` without host Node or terminal output:

```bash
set -euo pipefail
: "${IMAGE_ID:?Set the reviewed immutable image ID}"
for name in pw-deploy-api pw-deploy-ui; do
  podman run --rm --network=none --read-only --cap-drop=all --log-driver=none \
    --security-opt=no-new-privileges --entrypoint=/usr/bin/node "$IMAGE_ID" \
    -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' |
    podman secret create "$name" -
done
```

Those names must not already exist; rotation is an explicit operator action,
not overwrite/retry logic. Transfer the API credential into PW's protected
connection setting and the separate console credential into its sign-in form
through the approved private workflow. Neither service returns the original
credential through its settings endpoints.

The console uses a bounded, memory-only administrator session, Secure/HttpOnly/
SameSite cookies, exact-origin and per-session CSRF checks, and no token-bearing
URLs or browser localStorage. A controller restart signs the console out.
Bounded job/project/target links survive sign-in, expired sessions and credential
retries; an arbitrary external return URL is never accepted.
It does not depend on PW's login service or PW being running. This is a service
administrator console, not an additional per-project user directory.

## Supervised builder connector

Podman recipes require both `container.builderControl` and
`container.builderJobSockets`. A missing connector is an explicit configuration
failure, not permission to build through the unsupervised shared API.
`builderControl` uses its own pinned, non-interactive SSH connection and the
fixed command `pw-deploy-builder`. It accepts bounded control metadata only:
readiness, create/status, stop and remove for an exact instance/job identity.
Source, images, scripts and credentials are never control-request arguments.

Provision `deploy/container/builder-relay.py` and the completed
`builder-policy.example.json` through the same reviewed-release process as the
runtime connector. The builder policy belongs at
`/etc/pw-deploy-builder-policy.json`, root-owned and not writable by the builder.
Install the connector itself at the fixed, root-protected
`/usr/local/libexec/pw-deploy-builder.py`. Its forced SSH command invokes
`/usr/bin/python3 -I /usr/local/libexec/pw-deploy-builder.py`; do not forward
client arguments or environment. The controller's literal
`pw-deploy-builder` request is the only permitted original SSH command.
Internal unit/deadline/cleanup entrypoints are not SSH operations.
SSH/PAM may supply `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for the
approved account. The connector accepts them only when they exactly match
`/run/user/<approved-uid>` and `unix:path=/run/user/<approved-uid>/bus`, then
reconstructs its command environment. Alternate user buses, transports and
other D-Bus overrides remain refused; do not strip PAM settings or change
account privileges to make readiness pass.
The account must be non-sudo with password/interactive access disabled through
the approved account/key policy; its SSH setup must still permit the fixed
forced command. Do not substitute an unrestricted SSH login or another account.
Python, native Podman and the user manager are already host facilities, not
additional deployment SDKs.

The policy binds the stable instance, builder account, existing controller
user-unit name, private metadata/work and runtime directories, immutable image
cache store and maximum lifetime/memory/process limits. Its runtime directory
must match the Quadlet's dedicated socket-directory bind and fit Unix socket
path limits. The example uses `%t/pw-deploy-build` on the host and
`/run/pw-deploy-build` in the controller. Only the controller receives this
mount; a read-only bind still grants full access to the socket's API.

Readiness follows the approved account's standard cgroup path, including the
literal `@` in `user@<uid>.service`. Canonical absolute paths, no-follow directory
walking, approved ownership and non-writable parents are still required; do not
rename cgroups or loosen filesystem permissions to make readiness pass.

For each Podman job, a transient delegated user unit owns a separate native
Podman API process, writable image/container store and private runtime
directory. The approved shared cache is only an additional read-only image
store. The bootstrap moves its own process into a supervisor subgroup; every
worker, image build and smoke container is assigned an explicit child cgroup.
The API unit uses `Type=notify` and `NotifyAccess=all`: rootless Podman may
re-execute a child server, which reports `MAINPID` and `READY` to systemd.
Bootstrap forwards only the approved account's owned
`/run/user/<uid>/systemd/notify` socket. Readiness still requires the Unix socket
peer to equal systemd's actual `MainPID`; it does not accept arbitrary same-user
or descendant processes. Legacy `Type=exec` units remain eligible for guarded
stop/recovery, but new units wait for the server's notification.
The unit's whole-cgroup stop, independent runtime deadline and
`BindsTo`/`After` relationship to the controller cover API-side pull/copy/commit
work as well as Buildah RUN processes. Project code receives no host cgroup,
PID namespace, SDK installation or connector authority.

An absolute deadline timer is armed before the API unit starts. Its metadata
and cancellation marker survive failed or delayed startup, so stopping the
controller or timing out a client does not authorize a later replay. Each API
also receives a fresh private HOME/config with an exclusively created, empty
`mounts.conf`; bootstrap refuses a missing, linked, wrongly owned or nonempty
override. This prevents Podman's vendor defaults from implicitly mounting host
subscription/configuration files. It does not alter global host configuration.
Native API transfer/unpack storage is also bound to an owned mode-0700
`transfer` directory inside the job's work root through `TMPDIR`. Readiness
requires Podman's reported `imageCopyTmpDir` to match that exact path; a
default host temporary directory is refused and cannot escape job cleanup.
Review existing OCI-hook policy separately before provisioning; no hook override
or host-permission workaround is implied by this package.

Cancellation must confirm the entire owned backend stopped before removing its
private store. A CLI exit or API disconnect is not that confirmation. Uncertain
stop/cleanup retains recovery evidence and blocks further activation. Protected
cancelled-job metadata prevents a delayed start request from resurrecting an
already-cancelled job; restart recovery stops/removes rather than replaying.
The shared SDK cache and other jobs' stores are never pruned. Script/IIS workers
continue using the existing shared worker pool and their independent guardians.

Failed private-builder startup retains a protected `startup-failure.json` beside
the job's existing builder metadata. It separates the initiating stage, refusal
rule/code and errno from the cancellation/stop outcome and diagnostic-write
errors. Only fixed identifiers and bounded diagnostic values are retained, never
exception text, commands, environment values, nonces or process output.

The controller carries these details through transport and stop failures into
the private job journal's `builderStartupFailure`; public job responses do not
expose them. Diagnostic-write failure is reported without skipping the existing
safety cancellation/stop sequence. These records are evidence only: they do not
authorize cleanup or replay, replace whole-cgroup stop proof, or change the
fail-closed handling of an unconfirmed stop. Older journals remain readable.

## Runtime connector

Use the supplied `deploy/container/runtime-relay.py` and
`deploy/container/runtime-policy.example.json` under the existing non-root
runtime identity. The completed policy belongs at
`/etc/pw-deploy/runtime-policy.json`, in an administrator-owned directory,
root-owned and not writable by the runtime account. The connector and
its policy must be protected from that account's deployment workloads. Pin the
host key and use a dedicated SSH key restricted to the connector's fixed
command: no interactive shell, forwarding, agent forwarding, PTY or user rc.
Do not grant a generic sudo/SSH command or expose a Podman API as the runtime
connector.

The reviewed image contains this connector at `/opt/pw-deploy/runtime-relay.py`
and the non-operational policy template at
`/opt/pw-deploy/runtime-policy.example.json`. Provision the host copy from the
same reviewed release, not an unrelated workspace or a mutable download. It
remains the small necessary host boundary, not a host installation of the
deployment engine.

The controller sends bounded operation metadata and, for image import only,
an OCI stream. The connector independently validates the selected project,
target, image/service names, legacy reservations and allowed health hosts.
It returns selected operational metadata, never container environments, unit
definitions, application secrets or arbitrary logs.

Only the following policy fields are accepted. Invalid target keys, unexpected
fields or unsafe URLs fail closed; the web console cannot change this policy.

| Field | Operator-controlled purpose |
| --- | --- |
| `resourceNames` | Optional exact `<project>/<target>` bindings for pre-existing legacy image/unit/container names. Standard names require no exception. |
| `healthHosts` | Allowed health hostnames or addresses; allowing a host alone does not authorize arbitrary services or ports on it. |
| `healthTargets` | Optional exact `<project>/<target>` to health URL bindings for approved reverse proxies, HTTPS or other non-direct routes. |
| `maxImageBytes` | Image-transfer limit within the connector's hard bounds. |

Every health request carries the project, target, service and expected image
identity. The connector requires that exact image in the running container
before and after the probe. Direct HTTP probes must use literal `127.0.0.1` or
`::1` and a TCP port published by that container on the same address or an
applicable same-family wildcard. A UDP mapping or an IPv4-only binding does
not authorize an IPv6 probe (or vice versa). Ambiguous `localhost` names and
other routes need the exact approved `healthTargets` URL as well as the host
allowlist; unambiguous direct probes remain enrollment-free.
Redirects, URL credentials, queries and fragments are rejected, and inherited
proxy environment variables are ignored. A `health_target_not_allowed` outcome
is a policy refusal, not permission to probe a different endpoint.
The complete HTTP transaction runs in a separately supervised standard-library
helper with an absolute ten-second budget, including connection, headers and
body. A per-read socket timeout is not its lifetime guarantee. Cancellation
terminates and reaps the helper; an unconfirmed reap remains an explicit failure.
An unconfirmed stop preserves `process_failed`; it is not relabeled as an
ordinary endpoint `health_failed` response. The former requires process
reconciliation rather than assuming the endpoint was merely unhealthy.

Candidate cleanup conditionally untags the exact candidate reference from its
expected image identity. It never removes an image ID with unrelated aliases
or follows a candidate tag that was reassigned. A normal untagged image/cache
entry may remain; job cleanup does not perform blind image garbage collection.
Request framing, upload and helper-output bounds are enforced by the connector,
independently of the caller. Its `HOME` comes from the runtime account record,
not an inherited caller environment.
The canonical OCI pre-write size bound includes the tar writer's final record
padding, not only entry headers and content.

Existing application user units remain the authority for start/stop and runtime
mounts/environment. An absent unit is a provisioning error. Do not replace it
with a bare `podman restart`, rewrite its definition, or synthesize a privileged
profile. Health URLs that use runtime-host loopback are probed on that host
through the connector; controller localhost is not silently substituted.

## Rootless service and proxy

`deploy/container/pw-deploy.container.example` is a rootless Quadlet template,
not an installation command. Replace the image placeholder and install the
reviewed unit in the dedicated account's approved user search path, such as
`/etc/containers/systemd/users/<builder-uid>/pw-deploy.container`.
Do not place it in the all-users directory or run it as a root/system Quadlet.

It uses a read-only root filesystem, drops all capabilities except
`SYS_CHROOT`, sets container no-new-privileges, and provides a private writable
state volume and bounded temporary memory. `SYS_CHROOT` is needed only inside
the controller's rootless user namespace: Podman 5.8.2's remote build client
chroots while unpacking a streamed build context in the controller's `/tmp`
tmpfs. Without it, upstream tar extraction can fall back to parsing the archive
as a Dockerfile and report a misleading missing-FROM error. Startup explicitly
checks the effective and bounding capability when Podman recipes are enabled.
Script/IIS-only controllers do not need this capability. Project workers do not
receive it, and project commands still run as 1001:1001 with no capabilities.
The controller's namespace UID 0 is **not host UID 0**. Startup refuses an
identity-mapped host-root user namespace and a non-rootless builder daemon.
Do not set host service `NoNewPrivileges` on the Podman launcher in a way that
breaks its existing UID/GID mapping helpers.

The builder API remains an unexposed Unix socket. Do not relabel shared runtime
directories or add `SecurityLabelDisable` as a blanket workaround. Establish
the least required SELinux access for the dedicated socket under the host's
approved policy; a permissive host is not proof of enforcing readiness.

After human provisioning, use the standard user-unit daemon reload/start flow.
Quadlet applies its `[Install]` section during generation; generated units
are not enabled like a hand-written persistent service. The controller is
separate from PW and must not replace the old root/system `pw-deploy.service`
by accident. Do not activate both modes on the same listener/state.

The reviewed `deploy/container/nginx.example.conf` fragment belongs inside the
existing TLS server. It preserves bearer authentication for `/v1` and routes the
standalone UI independently. Request buffering is disabled so large source/
credential-bearing uploads are not spooled to proxy temporary files. Do not
add body logging, a public raw worker socket, or an unauthenticated admin route.

## PW and landing-page cutover

1. Keep PW's global backend LOCAL while provisioning the contained service.
2. Open the standalone console through HTTPS and use the separately provisioned
   administrator credential. Minimal public health is not an authorization or
   end-to-end deployment test.
3. Configure PW's existing external API endpoint/credential and optional
   **Service console URL**. The public console URL can differ from the internal
   loopback API endpoint. Test connection without changing the backend.
4. Once the service is actually available, update the existing landing card to
   `/deploy-service/` with health `/deploy-service/health`, using the established
   static-dashboard backup/atomic-update procedure. Preserve the old named
   rollback copy and later page edits; do not overwrite a prior backup.
5. Coordinate source/recipe adoption and an approved isolated canary. Only then
   select EXTERNAL for compatible targets. No application deployment is started
   by saving a console URL or connection setting.

When PW runs in a different container, its localhost is not the deployment
host. Use the approved HTTPS proxy API origin reachable from PW, or the approved
private service network; do not enable host networking to make a loopback URL work.

PW administrators are directed to the configured standalone console. PW retains
permission-filtered per-project status/log views as an API client, so moving
service administration does not grant a developer access to other projects.
PW's administrator-only `/deploy-service/connection` page remains available for
LOCAL/EXTERNAL selection and connection settings, including when the standalone
console is configured or temporarily unavailable. Prefix that path with PW's
configured base path (for example, `/workbench/deploy-service/connection`).
Without a configured console URL, existing PW UI behavior remains available for
backward-compatible migration.

Raw command output remains bounded/redacted in controller memory only. Worker
log drivers are disabled; credentials/script bodies use attached stdin, not
Podman create environment/argv or persistent logs. Durable history contains
operational metadata. Source/work volumes and image tags are cleaned only after
owned execution has been confirmed stopped; no broad prune is used.

## Recovery and remaining gates

The controller holds an exclusive state lock. Job containers have independent
hard deadlines, so stopping the controller does not remove their supervision.
Podman jobs additionally retain an independent whole-API unit deadline and an
explicit dependency on the controller's user unit; closing a remote build
client alone is never the stop mechanism.
Restart recovery identifies only the configured instance's owned job resources,
stops interrupted work and does not replay it. Unconfirmed cancellation or
cleanup remains an explicit failure requiring reconciliation.

Before an image import, the controller writes a protected per-job checkpoint
containing only the candidate's project/target, source revision, image identity
and owning instance/job. This permits exact runtime candidate cleanup after a
crash without restarting or promoting the application. A replacement image or
foreign resource sharing the expected name must not be removed. The checkpoint
is cleared only after cleanup succeeds. Unresolved cleanup history is retained
past the normal history window so retention cannot erase the recovery evidence.

Image rollback is not database rollback. Remote IIS/SQL operations may already
have committed changes when a connection is cancelled; inspect their approved
locks, files and migration state before retrying. Keep initial concurrency one
while existing scripts still shut down shared .NET build servers.

Container packaging does **not** make every old saved script snapshot-safe.
Preserve project migration/configuration requirements and unfinished work.
Rootful control-plane promotion, Git-writing publication and mutable live-asset
workflows need separately reviewed constrained capabilities. There is no generic
rootful or arbitrary root-script fallback.

The previous host subordinate-ID overlap is still an operator issue, not a
reason to reuse a conflicting block. The contained service and its image can be
prepared without changing that host, but production activation requires approved
accounts/mappings and runtime access.
