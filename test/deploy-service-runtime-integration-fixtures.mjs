// Trusted, test-only runtime driver. Importing this module performs no I/O.
//
// This deliberately consumes a PARENT-PROVISIONED, disposable topology; it does
// not install a connector, edit policy authority, create accounts, seed a store,
// start an API daemon, or borrow the normal runtime socket. The parent owns that
// topology and its eventual teardown. Only this driver's candidate tags and its
// temporary latest/rollback changes belong to this test.
//
// Operator contract (all paths/names below are derived by fixtureLayout):
// - A non-root Linux account, existing user manager, and an independently seeded
//   private Podman graph/run/volume/tmp store and Unix API socket.
// - A pinned relay image with the UNCHANGED packaged runtime-relay.py AND real
//   /usr/bin/systemctl. The current Containerfile does not explicitly install
//   systemctl. Absence, or incompatible container-to-host D-Bus authentication,
//   is a prerequisite failure, NOT permission to add a wrapper or install tools.
// - A trusted, read-only relay container: --network=none,
//   --userns=keep-id:uid=<host UID>,gid=<host GID> --user=<host UID>:<host GID>,
//   no added capabilities, and a matching NSS entry with HOME=/workspace/home,
//   --no-healthcheck, no host namespaces. Only the three mounts in relayMounts(), all read-only,
//   plus a namespace-root-owned 0444 secret at the relay's FIXED policy path.
//   Its entrypoint is /bin/sleep, argument 600; no controller or project jobs.
// - containers.conf contains exactly runtimeContainersConf(). The relay derives
//   HOME=/workspace/home and /run/user/<host UID>/bus itself; caller HOME/proxy settings
//   cannot configure it. Mount the EXISTING account bus at that latter path.
// - An existing uniquely named, linked user unit, exactly runtimeFixtureUnit(),
//   with no drop-ins; it runs the baseline synthetic app, sharing only the
//   relay's private network namespace. No host networking/published ports.
// - Three private regular OCI archives, one descriptor per baseline/healthy/
//   unhealthy image, exported with each entry's candidate reference. Produce
//   them offline from syntheticRuntimeBuildContext() using a reviewed cached
//   Python base, no RUN/build scripts and --pull=never --network=none. The base
//   needs /usr/bin/python3, not host SDKs. The image's ID is its config digest.
//   Only baseline is initially loaded into the runtime store.
// - A running decoy container (baseline image, /bin/sleep 600, network=none,
//   --no-healthcheck, no mounts), baseline's decoy alias, and a decoy volume with keep.txt equal
//   to the decoy name plus newline. These PARENT-OWNED resources must survive.
// - Metadata JSON from the strict schema below, stored privately; an explicit
//   inventory of the eight normal container IDs/images/states. No credentials.
//   Metadata, archives, containers.conf, the unit file, and keep.txt must be
//   singly-linked, account-owned private regular files (no symlink ancestors).
// - The native private HOME must contain an owned, empty, mode-0600
//   .config/containers/mounts.conf BEFORE any private Podman provisioning.
//   This disables vendor implicit host mounts without inspecting those files.
//
// Run locally ON the approved Linux host, never via an implicit SSH connection:
// PW_DEPLOY_RUNTIME_FIXTURE=1 PW_DEPLOY_RUNTIME_FIXTURE_METADATA=<private-json>
//   node --test --test-concurrency=1 test/deploy-service-runtime-integration.test.mjs
//
// A passing live test proves actual fixed-action relay mutations, an existing
// user-unit restart, image/health/version agreement, and fixture-orchestrated
// rollback. It does NOT prove SSH, engine/API orchestration, builder cancellation,
// provisioning, production policy scope, or a deployed contained service.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ContainerExecutor } from '../app/deployment/container-executor.js';
import { buildTarArchive, runProcess } from '../app/deployment/container-process.js';
import { runtimeRequest, runtimeSshArgv } from '../app/deployment/runtime-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const ROLES = ['baseline', 'healthy', 'unhealthy'];
export const MAX_RUNTIME_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PODMAN = '/usr/bin/podman';
const RELAY = '/opt/pw-deploy/runtime-relay.py';
const LABEL = 'io.pw-deploy.runtime-fixture';
const FIXED_RUNTIME = Object.freeze({
  host: 'runtime-fixture.invalid', port: 22, user: 'fixture',
  keyFile: '/fixture-unused/key', knownHostsFile: '/fixture-unused/known-hosts',
});

function record(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing/unknown fields`);
}

function match(value, expression, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.match(value, expression, label);
  return value;
}

export function runtimeFixtureGate(env, platform) {
  if (env.PW_DEPLOY_RUNTIME_FIXTURE === undefined || env.PW_DEPLOY_RUNTIME_FIXTURE === '0') {
    return { enabled: false, reason: 'real runtime actions require PW_DEPLOY_RUNTIME_FIXTURE=1' };
  }
  assert.equal(env.PW_DEPLOY_RUNTIME_FIXTURE, '1', 'runtime opt-in must be exactly 1');
  if (platform !== 'linux') return { enabled: false, reason: 'real runtime fixture is Linux-only' };
  assert.ok(env.PW_DEPLOY_RUNTIME_FIXTURE_METADATA, 'opt-in requires private topology metadata');
  return { enabled: true };
}

export function validateRuntimeFixtureMetadata(input) {
  record(input, ['schemaVersion', 'instanceId', 'uid', 'gid', 'relay', 'images', 'decoy', 'protectedContainers'], 'metadata');
  assert.equal(input.schemaVersion, 1);
  match(input.instanceId, UUID, 'instanceId');
  for (const key of ['uid', 'gid']) {
    assert.ok(Number.isSafeInteger(input[key]) && input[key] > 0 && input[key] < 2147483647, `non-root ${key} required`);
  }
  record(input.relay, ['containerId', 'imageId', 'revision'], 'relay');
  match(input.relay.containerId, ID, 'relay container ID');
  match(input.relay.imageId, IMAGE, 'relay image ID');
  match(input.relay.revision, REVISION, 'relay source revision');
  record(input.images, ROLES, 'images');
  for (const role of ROLES) {
    const entry = input.images[role];
    record(entry, ['imageId', 'revision', 'jobId', 'archiveSha256', 'archiveBytes'], `${role} image`);
    match(entry.imageId, IMAGE, `${role} image ID`);
    match(entry.revision, REVISION, `${role} revision`);
    match(entry.jobId, UUID, `${role} job ID`);
    match(entry.archiveSha256, ID, `${role} archive hash`);
    assert.ok(Number.isSafeInteger(entry.archiveBytes) && entry.archiveBytes >= 1024
      && entry.archiveBytes <= MAX_RUNTIME_ARCHIVE_BYTES, `${role} archive exceeds fixture limit`);
  }
  for (const key of ['imageId', 'revision', 'jobId']) {
    assert.equal(new Set(ROLES.map(role => input.images[role][key])).size, 3, `distinct image ${key}s required`);
  }
  assert.ok(!ROLES.some(role => input.images[role].imageId === input.relay.imageId), 'relay cannot be a project image');
  record(input.decoy, ['containerId'], 'decoy');
  match(input.decoy.containerId, ID, 'decoy container ID');
  assert.notEqual(input.decoy.containerId, input.relay.containerId);
  assert.ok(Array.isArray(input.protectedContainers) && input.protectedContainers.length === 8,
    'explicit eight-workload inventory required');
  for (const item of input.protectedContainers) {
    record(item, ['id', 'imageId', 'state'], 'protected container');
    match(item.id, ID, 'protected container ID');
    match(item.imageId, IMAGE, 'protected image ID');
    assert.ok(['running', 'exited', 'paused', 'created', 'stopped'].includes(item.state), 'stable container state required');
    assert.ok(![input.relay.containerId, input.decoy.containerId].includes(item.id), 'private and normal IDs must differ');
  }
  assert.equal(new Set(input.protectedContainers.map(item => item.id)).size, 8, 'duplicate protected ID');
  // Copy before using metadata across awaits; callers cannot change authority.
  const clone = JSON.parse(JSON.stringify(input));
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(clone);
}

export function fixtureLayout(metadata) {
  const m = validateRuntimeFixtureMetadata(metadata);
  const stem = `pw-runtime-${m.instanceId}`;
  const storage = `/srv/containers/pw-runtime-fixture-${m.instanceId}`;
  // Conmon also needs room for its own AF_UNIX suffix, not just api.sock.
  const runtime = `/run/user/${m.uid}/pwrt-${m.instanceId.replaceAll('-', '').slice(0, 12)}`;
  return Object.freeze({
    stem, project: stem, service: `${stem}-dev`, target: 'dev',
    storage, runtime, graph: `${storage}/graph`, run: `${runtime}/r`,
    tmp: `${runtime}/t`, transfer: `${storage}/transfer`,
    volumes: `${storage}/graph/volumes`, home: `${storage}/home`,
    socket: `${runtime}/api.sock`, bus: `/run/user/${m.uid}/bus`,
    unitFile: `${storage}/${stem}-dev.service`,
    conf: `${storage}/containers.conf`,
    secret: `${stem}-policy`, decoy: `${stem}-decoy`,
    healthUrl: 'http://127.0.0.1:18080/health',
  });
}

export function candidateReference(metadata, role) {
  assert.ok(ROLES.includes(role), 'unknown fixture image role');
  return `localhost/${fixtureLayout(metadata).service}:candidate-${metadata.images[role].jobId}`;
}

export function runtimeFixturePolicy(metadata) {
  const l = fixtureLayout(metadata);
  return {
    resourceNames: { [`${l.project}/dev`]: l.service },
    healthHosts: ['127.0.0.1'],
    healthTargets: { [`${l.project}/dev`]: l.healthUrl },
    maxImageBytes: MAX_RUNTIME_ARCHIVE_BYTES,
  };
}

export function runtimeContainersConf() {
  return '[engine]\nremote = true\nactive_service = "runtime-fixture"\n'
    + '[engine.service_destinations.runtime-fixture]\nuri = "unix:///run/pw-fixture/podman.sock"\n';
}

function relayMounts(m) {
  const l = fixtureLayout(m);
  return [
    [l.socket, '/run/pw-fixture/podman.sock'],
    [l.bus, `/run/user/${m.uid}/bus`],
    [l.conf, '/workspace/home/.config/containers/containers.conf'],
  ];
}

function privateArgs(m) {
  const l = fixtureLayout(m);
  return ['--remote=false', '--root', l.graph, '--runroot', l.run, '--tmpdir', l.tmp];
}

export function runtimeUnitCommands(metadata) {
  const m = validateRuntimeFixtureMetadata(metadata);
  const l = fixtureLayout(m);
  const prefix = [PODMAN, ...privateArgs(m)];
  return {
    ExecStart: [...prefix, 'run', '--name', l.service,
      '--label', `${LABEL}=${m.instanceId}`, '--pull=never',
      '--network', `container:${m.relay.containerId}`,
      '--userns=keep-id:uid=1001,gid=1001', '--user=1001:1001', '--read-only',
      '--cap-drop=all', '--security-opt=no-new-privileges', '--no-healthcheck',
      '--log-driver=none', '--timeout=480', '--pids-limit=64',
      '--memory=128m', '--memory-swap=128m', '--sdnotify=conmon',
      `localhost/${l.service}:latest`],
    ExecStop: [...prefix, 'stop', '--time=5', l.service],
    ExecStopPost: [...prefix, 'rm', '--ignore', l.service],
  };
}

export function runtimeFixtureUnit(metadata) {
  const l = fixtureLayout(metadata);
  const commands = runtimeUnitCommands(metadata);
  return '[Unit]\nDescription=Disposable runtime relay integration fixture\n'
    + '[Service]\nType=notify\nNotifyAccess=all\nDelegate=yes\nRestart=no\n'
    + 'KillMode=control-group\nTimeoutStartSec=20\nTimeoutStopSec=20\nRuntimeMaxSec=480\n'
    + `Environment=HOME=${l.home} XDG_RUNTIME_DIR=${l.runtime} TMPDIR=${l.transfer} `
    + `DBUS_SESSION_BUS_ADDRESS=unix:path=${l.bus} DISABLE_HC_SYSTEMD=true\n`
    + 'UnsetEnvironment=CONTAINER_HOST CONTAINER_CONNECTION CONTAINERS_CONF CONTAINERS_STORAGE_CONF CONTAINERS_CONF_OVERRIDE XDG_CONFIG_HOME\n'
    + Object.entries(commands).map(([key, argv]) => `${key}=${argv.join(' ')}\n`).join('');
}

export const SYNTHETIC_RUNTIME_SERVER = [
  'import http.server,json,sys',
  'class Handler(http.server.BaseHTTPRequestHandler):',
  ' def do_GET(self):',
  '  body=json.dumps({"ok":sys.argv[2]=="healthy","version":sys.argv[1]}).encode()',
  '  self.send_response(200 if self.path=="/health" else 404)',
  '  self.send_header("Content-Type","application/json")',
  '  self.send_header("Content-Length",str(len(body)))',
  '  self.end_headers(); self.wfile.write(body)',
  ' def log_message(self,*args): pass',
  'http.server.HTTPServer(("127.0.0.1",18080),Handler).serve_forever()',
].join('\n');

export function syntheticRuntimeDockerfile({ instanceId, revision, healthy, baseImageId }) {
  match(instanceId, UUID, 'synthetic instance ID');
  match(revision, REVISION, 'synthetic revision');
  assert.equal(typeof healthy, 'boolean', 'synthetic health must be explicit');
  match(baseImageId, IMAGE, 'cached synthetic Python base image ID');
  return `FROM ${baseImageId}\nUSER 1001:1001\n`
    + `LABEL org.opencontainers.image.revision=${revision} ${LABEL}=${instanceId}\n`
    + `ENTRYPOINT ${JSON.stringify(['/usr/bin/python3', '-I', '-c', SYNTHETIC_RUNTIME_SERVER])}\n`
    + `CMD ${JSON.stringify([revision.slice(0, 12), healthy ? 'healthy' : 'unhealthy'])}\n`;
}

export function syntheticRuntimeBuildContext(options) {
  return buildTarArchive([{
    path: 'Dockerfile', executable: false,
    data: Buffer.from(syntheticRuntimeDockerfile(options)).toString('base64'),
  }]);
}

export function assertPrivateRuntimeStore(info, metadata) {
  const l = fixtureLayout(metadata);
  assert.equal(info?.host?.security?.rootless, true, 'private runtime must be rootless');
  assert.equal(info?.store?.graphRoot, l.graph, 'wrong private graph root');
  assert.equal(info?.store?.runRoot, l.run, 'wrong private run root');
  assert.equal(info?.store?.volumePath, l.volumes, 'wrong private volume root');
  assert.equal(info?.store?.imageCopyTmpDir, l.transfer, 'wrong private transfer root');
}

export function normalizeRuntimeImageId(value) {
  match(value, /^(?:sha256:)?[0-9a-f]{64}$/, 'inspected immutable image identity');
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function assertConstrainedContainer(info, imageId, user = '1001:1001') {
  assert.equal(normalizeRuntimeImageId(info?.Image), imageId);
  assert.equal(info?.Config?.User, user);
  assert.equal(info?.HostConfig?.Privileged, false);
  assert.equal(info?.HostConfig?.ReadonlyRootfs, true);
  for (const key of ['PidMode', 'IpcMode', 'UTSMode']) {
    assert.ok(['', 'private', 'none', 'shareable'].includes(info.HostConfig[key]), `${key} must be explicitly isolated`);
  }
  // Podman versions use different cgroup inspection keys; /proc is also checked
  // on the live path, so an absent presentation field never establishes isolation.
  for (const key of ['CgroupMode', 'CgroupnsMode']) assert.notEqual(info.HostConfig[key], 'host');
  assert.notEqual(info.HostConfig.UsernsMode, 'host', 'host user namespace is forbidden');
  assert.deepEqual(info.HostConfig.CapAdd ?? [], [], 'no additional capabilities');
  assert.ok(info.HostConfig.SecurityOpt?.includes('no-new-privileges'), 'no-new-privileges required');
  assert.deepEqual(info.Config.Healthcheck?.Test ?? ['NONE'], ['NONE'], 'automatic image healthchecks must be disabled');
  assert.deepEqual(info.HostConfig.PortBindings ?? {}, {}, 'no published ports');
  assert.deepEqual(info.NetworkSettings?.Ports ?? {}, {}, 'no actual published ports');
}

export function assertRuntimeRelayContainer(info, metadata) {
  const m = validateRuntimeFixtureMetadata(metadata);
  assert.equal(info?.Id, m.relay.containerId);
  assertConstrainedContainer(info, m.relay.imageId, `${m.uid}:${m.gid}`);
  assert.equal(info.State?.Running, true);
  assert.equal(info.Config?.Labels?.[LABEL], m.instanceId);
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.deepEqual(info.Config.Entrypoint, ['/bin/sleep']);
  assert.deepEqual(info.Config.Cmd, ['600']);
  assert.deepEqual(info.ExecIDs ?? [], [], 'relay has an outstanding exec session');
  const actual = (info.Mounts ?? []).map(mount => {
    assert.equal(mount.Type, 'bind', 'relay may not mount volumes or host roots');
    assert.equal(mount.RW, false, 'relay input mounts must be read-only');
    return [mount.Source, mount.Destination];
  });
  assert.deepEqual(actual.sort(), relayMounts(m).sort(), 'relay mount authority differs from fixed topology');
}

export function assertSyntheticRuntimeImage(info, metadata, role) {
  assert.ok(ROLES.includes(role));
  const entry = metadata.images[role];
  assert.equal(normalizeRuntimeImageId(info?.Id), entry.imageId);
  assert.equal(info.Config?.Labels?.[LABEL], metadata.instanceId);
  assert.equal(info.Config?.Labels?.['org.opencontainers.image.revision'], entry.revision);
  assert.equal(info.Config?.User, '1001:1001');
  assert.deepEqual(info.Config?.Entrypoint, ['/usr/bin/python3', '-I', '-c', SYNTHETIC_RUNTIME_SERVER]);
  assert.deepEqual(info.Config?.Cmd, [entry.revision.slice(0, 12), role === 'unhealthy' ? 'unhealthy' : 'healthy']);
  assert.deepEqual(info.Config?.Volumes ?? {}, {}, 'synthetic image cannot request volumes');
}

export function assertRuntimeUnitProperties(text, metadata, resolvedFragmentPath) {
  const properties = {};
  for (const line of text.trim().split('\n')) {
    const index = line.indexOf('=');
    assert.ok(index > 0, 'invalid systemctl property');
    const key = line.slice(0, index);
    assert.ok(!Object.hasOwn(properties, key), 'duplicate systemctl property');
    properties[key] = line.slice(index + 1);
  }
  const l = fixtureLayout(metadata);
  assert.equal(properties.Id, `${l.service}.service`);
  assert.equal(properties.LoadState, 'loaded');
  assert.ok(path.posix.isAbsolute(properties.FragmentPath), 'unit fragment must be an absolute path');
  assert.equal(path.posix.normalize(properties.FragmentPath), properties.FragmentPath);
  assert.equal(path.posix.basename(properties.FragmentPath), `${l.service}.service`);
  assert.equal(resolvedFragmentPath ?? properties.FragmentPath, l.unitFile,
    'loaded unit fragment must resolve to the exact protected fixture file');
  assert.equal(properties.DropInPaths, '');
  assert.equal(properties.NeedDaemonReload, 'no');
  assert.equal(properties.Type, 'notify');
  assert.equal(properties.Restart, 'no');
  assert.equal(properties.KillMode, 'control-group');
  for (const [key, argv] of Object.entries(runtimeUnitCommands(metadata))) {
    // No shell, spaces, systemd specifiers or escaping are permitted in argv.
    assert.ok(argv.every(arg => /^[A-Za-z0-9_/:=.,-]+$/.test(arg)));
    const match = /^\{ path=([^;]+) ; argv\[\]=([^;]+) ; ignore_errors=no ;[^{}]*\}$/.exec(properties[key] ?? '');
    assert.ok(match, `${key} must be one directly executed command`);
    assert.equal(match[1], PODMAN);
    assert.equal(match[2], argv.join(' '), `${key} differs from the fixed synthetic unit`);
  }
  return properties;
}

export function assertRuntimeUserMapping(text, hostId) {
  assert.ok(Number.isSafeInteger(hostId) && hostId > 0 && hostId < 2147483647);
  assert.equal(typeof text, 'string');
  const mappings = text.trim().split('\n').map(line => {
    assert.match(line, /^\s*[0-9]+\s+[0-9]+\s+[0-9]+\s*$/);
    const [inside, outside, size] = line.trim().split(/\s+/).map(Number);
    assert.ok([inside, outside, size].every(Number.isSafeInteger));
    assert.ok(inside >= 0 && outside > 0 && size > 0,
      'private rootless mappings must never include host root');
    assert.ok(inside + size <= 4294967295 && outside + size <= 4294967295);
    return { inside, outside, size };
  });
  assert.ok(mappings.some(({ inside }) => inside === 0), 'container root must have a non-host-root mapping');
  assert.ok(mappings.some(({ inside, outside, size }) =>
    hostId >= inside && hostId < inside + size && outside + hostId - inside === hostId),
  'relay must preserve the existing non-root host account numeric identity');
}

export function assertProtectedRuntimeInventory(actual, expected) {
  const sorted = value => [...value].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sorted(actual), sorted(expected), 'normal workload IDs/images/states changed');
}

export function runtimeExecArgv(metadata) {
  const m = validateRuntimeFixtureMetadata(metadata);
  return ['--remote', '--url', `unix://${fixtureLayout(m).socket}`,
    'exec', '--interactive', `--user=${m.uid}:${m.gid}`, m.relay.containerId,
    '/usr/bin/python3', '-I', RELAY];
}

export function assertFixedRuntimeTransport(command, argv) {
  const expected = runtimeSshArgv(FIXED_RUNTIME);
  assert.equal(command, expected[0], 'fixture accepts only the production fixed SSH invocation');
  assert.deepEqual(argv, expected.slice(1), 'fixture transport command must not be caller-selectable');
}

function privateEnv(m) {
  const l = fixtureLayout(m);
  return {
    PATH: '/usr/bin:/bin', HOME: l.home, XDG_CONFIG_HOME: `${l.home}/.config`, XDG_RUNTIME_DIR: l.runtime,
    TMPDIR: l.transfer, DBUS_SESSION_BUS_ADDRESS: `unix:path=${l.bus}`,
    DISABLE_HC_SYSTEMD: 'true',
  };
}

async function noSymlinkPath(filename) {
  assert.equal(path.posix.normalize(filename), filename);
  assert.equal(await fs.realpath(filename), filename, 'fixture paths must not traverse symlinks');
  return fs.lstat(filename);
}

async function privateDirectory(filename, uid) {
  const stat = await noSymlinkPath(filename);
  assert.ok(stat.isDirectory(), 'private directory required');
  assert.equal(stat.uid, uid, 'private directory has another owner');
  assert.equal(stat.mode & 0o777, 0o700, 'private directory must be 0700');
}

async function privateFile(filename, uid, maxBytes) {
  const before = await noSymlinkPath(filename);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= maxBytes, 'bounded singly-linked regular file required');
  assert.equal(before.uid, uid);
  assert.equal(before.mode & 0o077, 0, 'fixture input must be private');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.size, before.size);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function privateText(filename, uid, maxBytes) {
  const handle = await privateFile(filename, uid, maxBytes);
  try {
    const before = await handle.stat();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    assert.ok(size <= maxBytes, 'fixture input grew past its limit');
    const after = await handle.stat();
    assert.equal(size, before.size);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await handle.close(); }
}

export async function readRuntimeFixtureMetadata(filename) {
  assert.equal(process.platform, 'linux', 'metadata loading is an opt-in Linux action');
  assert.ok(process.getuid() > 0, 'root is not an allowed fixture identity');
  return validateRuntimeFixtureMetadata(JSON.parse(await privateText(filename, process.getuid(), 32768)));
}

export function runtimeRelayPreflight(metadata) {
  const m = validateRuntimeFixtureMetadata(metadata);
  return `
import hashlib,importlib.util,json,os,pwd,stat
spec=importlib.util.spec_from_file_location("fixture_relay","${RELAY}")
relay=importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
def protected_file(filename):
 s=os.lstat(filename)
 assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode & 0o022
 return hashlib.sha256(open(filename,"rb").read()).hexdigest()
assert os.getuid()==${m.uid} and os.getgid()==${m.gid}
assert pwd.getpwuid(${m.uid}).pw_dir=="/workspace/home"
assert os.access("/usr/bin/podman",os.X_OK)
protected_file("/etc/pw-deploy/runtime-policy.json")
print(json.dumps({"uid":os.getuid(),"gid":os.getgid(),"relaySha256":protected_file("${RELAY}"),
 "policy":relay.load_policy(),"environment":relay.runtime_environment(),
 "systemctlPresent":os.access("/usr/bin/systemctl",os.X_OK),
 "info":json.loads(relay.podman(["info","--format=json"]).stdout)}))
`;
}

export function relayOutcomeIsCertain(buffer, exitCode) {
  if (exitCode !== 0 || !Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.length > 262154) return false;
  const header = buffer.subarray(0, 10).toString('ascii');
  if (!/^[0-9]{10}$/.test(header) || Number(header) !== buffer.length - 10) return false;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(10))); }
  catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ok === true) return !!value.result && typeof value.result === 'object' && !Array.isArray(value.result);
  return value.ok === false && ['health_failed', 'resource_conflict', 'resource_not_allowed',
    'invalid_request', 'health_target_not_allowed', 'invalid_image'].includes(value.code);
}

// This is a real podman-exec transport, not a ChildProcess/response emulator.
// The placeholder SSH argv is checked and NEVER executed or read for credentials.
function relayTransport(m, onUncertain) {
  return (command, argv, options) => {
    assertFixedRuntimeTransport(command, argv);
    const child = spawn(PODMAN, runtimeExecArgv(m), { ...options, env: privateEnv(m) });
    const chunks = [];
    let bytes = 0;
    // Observe without altering the stream. Production waitForRuntime catches
    // health errors, so an unconfirmed helper stop must also latch here.
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 262154) chunks.push(chunk);
      else onUncertain();
    });
    child.once('error', onUncertain);
    child.once('close', code => {
      if (!relayOutcomeIsCertain(Buffer.concat(chunks), code)) onUncertain();
    });
    return child;
  };
}

async function archiveStream(m, role, signal) {
  const filename = `${fixtureLayout(m).storage}/inputs/${role}.oci.tar`;
  const handle = await privateFile(filename, m.uid, MAX_RUNTIME_ARCHIVE_BYTES);
  try {
    const entry = m.images[role];
    const before = await handle.stat();
    assert.equal(before.size, entry.archiveBytes, 'OCI archive size changed');
    const hash = crypto.createHash('sha256');
    const hashSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    for await (const chunk of handle.createReadStream({
      autoClose: false, start: 0, end: entry.archiveBytes - 1, signal: hashSignal,
    })) hash.update(chunk);
    assert.equal(hash.digest('hex'), entry.archiveSha256, 'OCI archive hash changed');
    const after = await handle.stat();
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    // Reuse the inspected descriptor; never reopen a replaceable path for import.
    return { handle, stream: createReadStream(filename, {
      fd: handle.fd, autoClose: false, start: 0, end: entry.archiveBytes - 1, signal,
    }) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function exerciseRuntimeRelayLifecycle(metadata, { signal, diagnostic = () => {} } = {}) {
  assert.equal(process.platform, 'linux', 'runtime fixture must not execute on this platform');
  assert.equal(process.env.PW_DEPLOY_RUNTIME_FIXTURE, '1', 'resource actions require explicit opt-in');
  signal = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  const m = validateRuntimeFixtureMetadata(metadata);
  assert.equal(process.getuid(), m.uid);
  assert.equal(process.getgid(), m.gid);
  const l = fixtureLayout(m);
  signal?.throwIfAborted();
  let uncertain = false;
  let mutated = false;
  let preflightComplete = false;
  const imported = new Set();
  const events = [];
  const markUncertain = () => { uncertain = true; };
  const transport = relayTransport(m, markUncertain);
  const invoke = async (command, argv, { cleanup = false, ...options } = {}) => {
    try {
      return await runProcess(command, argv, {
        env: privateEnv(m), signal: cleanup ? cleanupSignal : signal, timeoutMs: 10000,
        captureStdout: true, maxStdoutBytes: 1024 * 1024, ...options,
      });
    } catch (error) {
      // Client exit is not proof that an API mutation/exec stopped.
      if (['process_timeout', 'cancellation_failed', 'process_output_too_large'].includes(error.code)
          || signal?.aborted) markUncertain();
      throw error;
    }
  };
  const privatePodman = (argv, options) => invoke(PODMAN, ['--remote', '--url', `unix://${l.socket}`, ...argv], options);
  const inspect = async (kind, id, options) => {
    const result = JSON.parse((await privatePodman([kind, 'inspect', id], options)).output);
    assert.ok(Array.isArray(result) && result.length === 1);
    return result[0];
  };
  const exists = async (kind, id, options) => (await privatePodman(
    [kind, 'exists', id], { ...options, allowedExitCodes: [0, 1] })).exitCode === 0;
  const imageId = async (reference, options) => normalizeRuntimeImageId((await inspect('image', reference, options)).Id);
  const relay = async (action, fields = {}, { cleanup = false, ociStream } = {}) => {
    const mutation = ['image_import', 'image_tag', 'image_remove_candidate', 'service_restart'].includes(action);
    if (mutation) {
      assert.ok(preflightComplete, 'no relay mutation before independent preflight');
      assert.equal(uncertain, false, 'retain resources after an uncertain outcome');
      mutated = true;
    }
    try {
      return await runtimeRequest(FIXED_RUNTIME, {
        requestId: crypto.randomUUID(), action, project: l.project, target: 'dev', ...fields,
      }, {
        spawnProcess: transport, signal: cleanup ? cleanupSignal : signal,
        timeoutMs: action === 'image_import' ? 90000 : 20000,
        ociStream, maxOciBytes: MAX_RUNTIME_ARCHIVE_BYTES,
      });
    } catch (error) {
      if ((mutation && !(action === 'image_remove_candidate' && error.code === 'resource_conflict'))
          || !['health_failed', 'resource_conflict', 'resource_not_allowed', 'invalid_request',
        'health_target_not_allowed', 'invalid_image'].includes(error.code)) markUncertain();
      throw error;
    }
  };
  const service = { service: l.service };
  const tag = (id, suffix, options) => relay('image_tag', { image: l.service, sourceImage: id, tagSuffix: suffix }, options);
  const status = options => relay('container_status', service, options);
  const health = (role, options) => relay('health_check', {
    ...service, expectedImageId: m.images[role].imageId,
    healthUrl: l.healthUrl, versionField: 'version',
  }, options);
  const removeCandidate = (role, expectedImageId, options) => relay('image_remove_candidate', {
    image: l.service, jobId: m.images[role].jobId, expectedImageId,
  }, options);
  const readProtected = async options => {
    const result = await invoke(PODMAN, ['--remote=false', 'ps', '--all', '--no-trunc', '--format=json'], {
      ...options,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, XDG_RUNTIME_DIR: `/run/user/${m.uid}` },
    });
    const rows = JSON.parse(result.output);
    assert.ok(Array.isArray(rows));
    return rows.map(row => ({ id: row.Id, imageId: normalizeRuntimeImageId(row.ImageID), state: row.State }));
  };
  const pauseIdentity = async () => {
    const namespace = await fs.readlink('/proc/2721/ns/user');
    assert.equal(namespace, 'user:[4026532763]', 'normal rootless pause namespace changed');
    const stat = await fs.readFile('/proc/2721/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    assert.match(start, /^[0-9]+$/);
    return { namespace, start };
  };
  const unitCheck = async options => {
    assert.equal(await privateText(l.unitFile, m.uid, 16384), runtimeFixtureUnit(m), 'synthetic unit file differs');
    const properties = ['Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
      'Type', 'Restart', 'KillMode', 'ExecStart', 'ExecStop', 'ExecStopPost'];
    const result = await invoke('/usr/bin/systemctl', ['--user', 'show', `${l.service}.service`,
      `--property=${properties.join(',')}`], options);
    const fragments = [...result.output.matchAll(/^FragmentPath=(.+)$/gm)];
    assert.equal(fragments.length, 1, 'unit must report exactly one fragment');
    const fragment = fragments[0][1];
    assert.equal(path.posix.basename(fragment), `${l.service}.service`);
    assertRuntimeUnitProperties(result.output, m, await fs.realpath(fragment));
  };
  const storeCheck = async options => {
    assertPrivateRuntimeStore(JSON.parse((await privatePodman(['info', '--format=json'], options)).output), m);
    assertPrivateRuntimeStore(JSON.parse((await invoke(PODMAN,
      [...privateArgs(m), 'info', '--format=json'], options)).output), m);
  };
  const decoySnapshot = async options => {
    const container = await inspect('container', m.decoy.containerId, options);
    assertConstrainedContainer(container, m.images.baseline.imageId);
    assert.equal(container.Id, m.decoy.containerId);
    assert.equal(container.Name, l.decoy);
    assert.equal(container.State.Running, true);
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.deepEqual(container.Mounts ?? [], []);
    assert.deepEqual(container.Config.Entrypoint, ['/bin/sleep']);
    assert.deepEqual(container.Config.Cmd, ['600']);
    assert.equal(await imageId(`localhost/${l.decoy}:keep`, options), m.images.baseline.imageId);
    const volume = await inspect('volume', l.decoy, options);
    assert.equal(volume.Name, l.decoy);
    assert.equal(volume.Mountpoint, `${l.volumes}/${l.decoy}/_data`);
    assert.equal(await privateText(`${volume.Mountpoint}/keep.txt`, m.uid, 256), `${l.decoy}\n`);
    return { id: container.Id, pid: container.State.Pid, started: container.State.StartedAt,
      image: normalizeRuntimeImageId(container.Image),
      volume: { name: volume.Name, mountpoint: volume.Mountpoint, labels: volume.Labels } };
  };
  const appCheck = async (role, options) => {
    const app = await inspect('container', l.service, options);
    assertConstrainedContainer(app, m.images[role].imageId);
    assert.equal(app.Name, l.service);
    assert.equal(app.Config.Labels?.[LABEL], m.instanceId);
    assert.equal(app.State.Running, true);
    assert.equal(app.HostConfig.NetworkMode, `container:${m.relay.containerId}`);
    assert.deepEqual(app.Mounts ?? [], [], 'synthetic app must never receive host/controller mounts');
    await isolatedNamespaces(app.State.Pid);
  };
  const isolatedNamespaces = async pid => {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    for (const namespace of ['user', 'mnt', 'pid', 'net', 'cgroup']) {
      assert.notEqual(await fs.readlink(`/proc/${pid}/ns/${namespace}`), await fs.readlink(`/proc/self/ns/${namespace}`),
        `fixture container unexpectedly shares the host ${namespace} namespace`);
    }
  };
  const executor = new ContainerExecutor({ container: { runtime: FIXED_RUNTIME } }, { spawnProcess: transport });
  const waitAccepted = async (role, options = {}) => {
    await executor.waitForRuntime({
      project: l.project, target: 'dev', revision: m.images[role].revision,
      recipe: { healthUrl: l.healthUrl, versionField: 'version' },
    }, { jobId: m.images[role].jobId, signal: options.cleanup ? cleanupSignal : signal },
    l.service, m.images[role].imageId);
    await appCheck(role, options);
    assert.deepEqual(await health(role, options), { version: m.images[role].revision.slice(0, 12) });
    assert.deepEqual(await status(options), { exists: true, running: true, image: m.images[role].imageId });
  };
  let cleanupSignal, originalDecoy, originalPause, failure;
  try {
    for (const directory of [l.storage, l.runtime, l.graph, l.run, l.tmp, l.transfer, l.home, `${l.storage}/inputs`]) {
      await privateDirectory(directory, m.uid);
    }
    const mountsOverride = `${l.home}/.config/containers/mounts.conf`;
    const mountsStat = await noSymlinkPath(mountsOverride);
    assert.equal(mountsStat.mode & 0o777, 0o600, 'native private mounts override must be mode 0600');
    assert.equal(await privateText(mountsOverride, m.uid, 1), '',
      'native private HOME must disable vendor mounts before any Podman operation');
    for (const socket of [l.socket, l.bus]) {
      const stat = await noSymlinkPath(socket);
      assert.ok(stat.isSocket());
      assert.equal(stat.uid, m.uid, 'socket must belong to the existing runtime identity');
    }
    assert.equal(await privateText(l.conf, m.uid, 4096), runtimeContainersConf(), 'relay Podman connection differs');
    assertProtectedRuntimeInventory(await readProtected(), m.protectedContainers);
    originalPause = await pauseIdentity();
    await storeCheck();
    await unitCheck();
    const relayContainer = await inspect('container', m.relay.containerId);
    assertRuntimeRelayContainer(relayContainer, m);
    await isolatedNamespaces(relayContainer.State.Pid);
    const relayImage = await inspect('image', m.relay.imageId);
    assert.equal(normalizeRuntimeImageId(relayImage.Id), m.relay.imageId);
    assert.equal(relayImage.Config?.Labels?.['org.opencontainers.image.revision'], m.relay.revision);
    assert.equal(relayImage.Config?.Labels?.['io.pw-deploy.worker'], 'true');
    for (const kind of ['uid', 'gid']) {
      const mapping = await fs.readFile(`/proc/${relayContainer.State.Pid}/${kind}_map`, 'utf8');
      assertRuntimeUserMapping(mapping, m[kind]);
    }
    const relayUser = `--user=${m.uid}:${m.gid}`;
    const available = (await privatePodman(['exec', relayUser, m.relay.containerId,
      '/usr/bin/python3', '-I', '-c', 'import os; print(int(os.access("/usr/bin/systemctl",os.X_OK)))'])).output.trim();
    assert.equal(available, '1',
      'Missing prerequisite: real /usr/bin/systemctl in the pinned relay image; no install/wrapper fallback is permitted');
    assert.match((await privatePodman(['exec', relayUser, m.relay.containerId,
      '/usr/bin/systemctl', '--version'])).output, /^systemd \d+/);
    const preflight = JSON.parse((await privatePodman(['exec', relayUser, m.relay.containerId,
      '/usr/bin/python3', '-I', '-c', runtimeRelayPreflight(m)])).output);
    const source = await fs.readFile(new URL('../deploy/container/runtime-relay.py', import.meta.url));
    assert.equal(preflight.relaySha256, crypto.createHash('sha256').update(source).digest('hex'),
      'packaged relay does not match this source; no policy/relay patching allowed');
    assert.deepEqual(preflight.policy, runtimeFixturePolicy(m));
    assert.deepEqual(preflight.environment, {
      PATH: '/usr/bin:/bin', HOME: '/workspace/home', XDG_RUNTIME_DIR: `/run/user/${m.uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${m.uid}/bus`,
    });
    assert.equal(preflight.systemctlPresent, true);
    assertPrivateRuntimeStore(preflight.info, m);
    try {
      assert.deepEqual(await relay('service_preflight', service), { loadState: 'loaded' });
    } catch (error) {
      throw new Error('Real relay user-unit preflight failed; container systemctl/host D-Bus authentication must work without a shim',
        { cause: error });
    }
    assert.deepEqual(await relay('service_is_active', service), { state: 'active' });
    for (const role of ROLES) assert.equal(await exists('image', candidateReference(m, role)), false, 'candidate already exists');
    for (const role of ['healthy', 'unhealthy']) {
      assert.equal(await exists('image', m.images[role].imageId), false, 'candidate image is already loaded; import would be vacuous');
    }
    assert.equal(await exists('image', `localhost/${l.service}:rollback`), false, 'rollback reference already exists');
    assert.equal(await imageId(`localhost/${l.service}:latest`), m.images.baseline.imageId);
    assertSyntheticRuntimeImage(await inspect('image', m.images.baseline.imageId), m, 'baseline');
    await waitAccepted('baseline');
    originalDecoy = await decoySnapshot();
    preflightComplete = true;
    for (const role of ROLES) {
      const { handle, stream } = await archiveStream(m, role, signal);
      try {
        const result = await relay('image_import', {
          image: l.service, jobId: m.images[role].jobId,
          expectedImageId: m.images[role].imageId, revision: m.images[role].revision,
        }, { ociStream: stream });
        imported.add(role);
        assert.deepEqual(result, { imageId: m.images[role].imageId });
        assert.equal(await imageId(candidateReference(m, role)), m.images[role].imageId);
        assertSyntheticRuntimeImage(await inspect('image', m.images[role].imageId), m, role);
        events.push(`${role}:real_import`);
      } finally {
        stream.destroy();
        await handle.close();
      }
    }
    await assert.rejects(removeCandidate('baseline', m.images.healthy.imageId), { code: 'resource_conflict' });
    assert.equal(await imageId(candidateReference(m, 'baseline')), m.images.baseline.imageId);
    assert.deepEqual(await removeCandidate('baseline', m.images.baseline.imageId), { removed: true });
    assert.deepEqual(await removeCandidate('baseline', m.images.baseline.imageId), { removed: false });
    imported.delete('baseline');
    assert.deepEqual(await decoySnapshot(), originalDecoy, 'conditional untag damaged the decoy');
    events.push('candidate:expected_id_conflict_and_idempotent_untag');

    await tag(m.images.baseline.imageId, 'rollback');
    await tag(m.images.healthy.imageId, 'latest');
    await relay('service_restart', service);
    await waitAccepted('healthy');
    await assert.rejects(health('baseline'), { code: 'health_failed' });
    events.push('healthy:exact_running_image_health_version');

    await tag(m.images.healthy.imageId, 'rollback');
    await tag(m.images.unhealthy.imageId, 'latest');
    await relay('service_restart', service);
    // The production readiness loop must actually observe and reject the real
    // HTTP server's unhealthy body, not a transport stub or a changed URL.
    await assert.rejects(waitAccepted('unhealthy'), { code: 'health_failed' });
    assert.deepEqual(await status(), { exists: true, running: true, image: m.images.unhealthy.imageId });
    assert.equal(await imageId(`localhost/${l.service}:rollback`), m.images.healthy.imageId);
    await tag(m.images.healthy.imageId, 'latest');
    await relay('service_restart', service);
    await waitAccepted('healthy');
    events.push('unhealthy:rejected_and_real_rollback_restored');
  } catch (error) {
    failure = error;
  } finally {
    if (signal?.aborted) markUncertain();
    cleanupSignal = AbortSignal.timeout(90000);
    try {
      if (preflightComplete && mutated) {
        assert.equal(uncertain, false, 'uncertain remote outcome: retain all resources for parent reconciliation');
        await storeCheck({ cleanup: true });
        await unitCheck({ cleanup: true });
        assertRuntimeRelayContainer(await inspect('container', m.relay.containerId, { cleanup: true }), m);
        const current = await imageId(`localhost/${l.service}:latest`, { cleanup: true });
        assert.ok(ROLES.some(role => m.images[role].imageId === current), 'latest was replaced: retain resources');
        await tag(m.images.baseline.imageId, 'latest', { cleanup: true });
        await relay('service_restart', service, { cleanup: true });
        await waitAccepted('baseline', { cleanup: true });
        for (const role of imported) {
          await removeCandidate(role, m.images[role].imageId, { cleanup: true });
          assert.equal(await exists('image', candidateReference(m, role), { cleanup: true }), false);
        }
        const rollback = `localhost/${l.service}:rollback`;
        if (await exists('image', rollback, { cleanup: true })) {
          const expected = await imageId(rollback, { cleanup: true });
          assert.ok([m.images.baseline.imageId, m.images.healthy.imageId].includes(expected));
          // The relay intentionally has no rollback-tag cleanup action. This
          // trusted fixture may detach ONLY this exact tag from its checked ID.
          await privatePodman(['image', 'untag', expected, rollback], { cleanup: true });
          assert.equal(await exists('image', rollback, { cleanup: true }), false);
        }
        assert.deepEqual(await decoySnapshot({ cleanup: true }), originalDecoy);
        events.push('cleanup:baseline_restored_candidates_absent_decoy_preserved');
      }
    } catch (error) {
      diagnostic(`RETAIN parent-owned topology ${l.storage} and ${l.runtime}; no destructive fallback, parent reconciliation required`);
      failure = failure ? new AggregateError([failure, error], 'runtime fixture and safe cleanup failed') : error;
    }
    // An uncertain private mutation must not suppress the independent, read-only
    // preservation oracle for the normal account's workloads and pause holder.
    if (originalPause) {
      try {
        assert.deepEqual(await pauseIdentity(), originalPause);
        assertProtectedRuntimeInventory(await readProtected({ cleanup: true }), m.protectedContainers);
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'runtime fixture and preservation check failed') : error;
      }
    }
  }
  if (failure) throw failure;
  diagnostic(`Real relay evidence: ${events.join(', ')}. Parent retains private topology and untagged image cache.`);
  return { events, topologyRetained: true, fullServiceProven: false };
}
