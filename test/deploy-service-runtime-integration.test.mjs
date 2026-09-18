import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RUNTIME_ARCHIVE_BYTES, SYNTHETIC_RUNTIME_SERVER,
  runtimeFixtureGate, validateRuntimeFixtureMetadata, fixtureLayout, candidateReference,
  runtimeFixturePolicy, runtimeContainersConf, runtimeFixtureUnit, runtimeUnitCommands,
  syntheticRuntimeDockerfile, syntheticRuntimeBuildContext, assertPrivateRuntimeStore,
  assertRuntimeRelayContainer, assertSyntheticRuntimeImage, assertRuntimeUnitProperties, assertRuntimeUserMapping,
  assertProtectedRuntimeInventory, runtimeExecArgv, assertFixedRuntimeTransport,
  relayOutcomeIsCertain, runtimeRelayPreflight,
  normalizeRuntimeImageId,
  readRuntimeFixtureMetadata, exerciseRuntimeRelayLifecycle,
} from './deploy-service-runtime-integration-fixtures.mjs';
import { runtimeSshArgv } from '../app/deployment/runtime-client.js';

// Portable tests exercise validators/argv generation ONLY. No modeled mutation
// responses count as integration evidence; the last test is the sole live path.
function metadata() {
  return {
    schemaVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', uid: 1234, gid: 1234,
    relay: { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`, revision: 'c'.repeat(40) },
    images: Object.fromEntries(['baseline', 'healthy', 'unhealthy'].map((role, index) => [role, {
      imageId: `sha256:${String(index + 1).repeat(64)}`, revision: String(index + 1).repeat(40),
      jobId: `${String(index + 2).repeat(8)}-1111-4111-8111-111111111111`,
      archiveSha256: String(index + 4).repeat(64), archiveBytes: 10240,
    }])),
    decoy: { containerId: 'd'.repeat(64) },
    protectedContainers: Array.from({ length: 8 }, (_, i) => ({
      id: (i + 16).toString(16).repeat(32), imageId: `sha256:${'e'.repeat(64)}`, state: 'running',
    })),
  };
}

function storeInfo(m) {
  const l = fixtureLayout(m);
  return { host: { security: { rootless: true } }, store: {
    graphRoot: l.graph, runRoot: l.run, volumePath: l.volumes, imageCopyTmpDir: l.transfer,
  } };
}

function relayInfo(m) {
  const l = fixtureLayout(m);
  return {
    Id: m.relay.containerId, Image: m.relay.imageId, State: { Running: true }, ExecIDs: [],
    Config: { User: `${m.uid}:${m.gid}`, Labels: { 'io.pw-deploy.runtime-fixture': m.instanceId },
      Entrypoint: ['/bin/sleep'], Cmd: ['600'] },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none',
      PidMode: 'private', IpcMode: 'private', UTSMode: 'private', CgroupMode: 'private',
      CapAdd: [], SecurityOpt: ['no-new-privileges'], PortBindings: {} },
    NetworkSettings: { Ports: {} },
    Mounts: [
      [l.socket, '/run/pw-fixture/podman.sock'],
      [l.bus, `/run/user/${m.uid}/bus`],
      [l.conf, '/workspace/home/.config/containers/containers.conf'],
    ].map(([Source, Destination]) => ({ Type: 'bind', Source, Destination, RW: false })),
  };
}

function unitProperties(m) {
  const l = fixtureLayout(m);
  return [
    `Id=${l.service}.service`, 'LoadState=loaded', `FragmentPath=${l.unitFile}`,
    'DropInPaths=', 'NeedDaemonReload=no', 'Type=notify', 'Restart=no', 'KillMode=control-group',
    ...Object.entries(runtimeUnitCommands(m)).map(([key, argv]) =>
      `${key}={ path=/usr/bin/podman ; argv[]=${argv.join(' ')} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`),
  ].join('\n');
}

test('runtime fixture is inert by default, explicitly gated and Linux-only', () => {
  assert.equal(runtimeFixtureGate({}, 'linux').enabled, false);
  assert.equal(runtimeFixtureGate({ PW_DEPLOY_RUNTIME_FIXTURE: '0' }, 'linux').enabled, false);
  assert.equal(runtimeFixtureGate({ PW_DEPLOY_RUNTIME_FIXTURE: '1' }, 'win32').enabled, false);
  assert.throws(() => runtimeFixtureGate({ PW_DEPLOY_RUNTIME_FIXTURE: 'true' }, 'linux'));
  assert.throws(() => runtimeFixtureGate({ PW_DEPLOY_RUNTIME_FIXTURE: '1' }, 'linux'));
  assert.equal(runtimeFixtureGate({
    PW_DEPLOY_RUNTIME_FIXTURE: '1', PW_DEPLOY_RUNTIME_FIXTURE_METADATA: '/private/metadata.json',
  }, 'linux').enabled, true);
});

test('metadata is strict, non-root, pinned and immutable', () => {
  const input = metadata();
  const valid = validateRuntimeFixtureMetadata(input);
  input.relay.containerId = 'f'.repeat(64);
  assert.equal(valid.relay.containerId, 'a'.repeat(64));
  assert.ok(Object.isFrozen(valid.images.baseline));
  for (const mutate of [
    m => { m.uid = 0; }, m => { m.gid = -1; }, m => { m.uid = '1234'; },
    m => { m.instanceId = '../production'; }, m => { m.schemaVersion = 2; },
    m => { m.socket = '/run/podman/podman.sock'; }, m => { m.unit = 'production.service'; },
    m => { m.relay.imageId = 'latest'; }, m => { m.relay.revision = 'main'; },
    m => { m.relay.command = '/bin/sh'; },
    m => { m.images.healthy.imageId = m.images.baseline.imageId; },
    m => { m.images.healthy.jobId = m.images.baseline.jobId; },
    m => { m.images.unhealthy.revision = m.images.baseline.revision; },
    m => { m.images.baseline.archivePath = '/etc/shadow'; },
    m => { m.images.baseline.archiveBytes = MAX_RUNTIME_ARCHIVE_BYTES + 1; },
    m => { m.images.baseline.archiveBytes = NaN; },
    m => { m.images.baseline.archiveSha256 = 'not-a-hash'; },
    m => { m.protectedContainers.pop(); },
    m => { m.protectedContainers[1] = m.protectedContainers[0]; },
    m => { m.protectedContainers[0].id = m.relay.containerId; },
    m => { m.protectedContainers[0].state = 'Up 2 minutes'; },
  ]) {
    const invalid = metadata();
    mutate(invalid);
    assert.throws(() => validateRuntimeFixtureMetadata(invalid));
  }
});

test('derived topology confines paths, policy, names and health to one synthetic target', () => {
  const m = metadata(), l = fixtureLayout(m);
  assert.ok(l.socket.length < 108);
  assert.ok(l.tmp.length <= 64);
  assert.ok(l.run.length <= 64);
  assert.equal(l.volumes, `${l.graph}/volumes`);
  assert.equal(l.unitFile, `${l.storage}/${l.service}.service`);
  assert.deepEqual(runtimeFixturePolicy(m), {
    resourceNames: { [`${l.project}/dev`]: l.service },
    healthHosts: ['127.0.0.1'], healthTargets: { [`${l.project}/dev`]: l.healthUrl },
    maxImageBytes: MAX_RUNTIME_ARCHIVE_BYTES,
  });
  assert.equal(candidateReference(m, 'healthy'), `localhost/${l.service}:candidate-${m.images.healthy.jobId}`);
  assert.throws(() => candidateReference(m, 'production'));
  assert.match(runtimeContainersConf(), /unix:\/\/\/run\/pw-fixture\/podman\.sock/);
  assert.match(runtimeContainersConf(), /^remote = true$/m);
  assert.doesNotMatch(runtimeContainersConf(), /ssh:|tcp:|host/);
});

test('independent store validation rejects rootful and mismatched private roots', () => {
  const m = metadata();
  assertPrivateRuntimeStore(storeInfo(m), m);
  for (const key of ['graphRoot', 'runRoot', 'volumePath', 'imageCopyTmpDir']) {
    const info = storeInfo(m);
    info.store[key] = '/normal-store';
    assert.throws(() => assertPrivateRuntimeStore(info, m));
  }
  const rootful = storeInfo(m);
  rootful.host.security.rootless = false;
  assert.throws(() => assertPrivateRuntimeStore(rootful, m));
});

test('relay inspect validation refuses host authority and unconfirmed exec sessions', () => {
  const m = metadata();
  assertRuntimeRelayContainer(relayInfo(m), m);
  const bare = relayInfo(m);
  bare.Image = m.relay.imageId.slice(7);
  assertRuntimeRelayContainer(bare, m);
  for (const mutate of [
    i => { i.Id = 'f'.repeat(64); }, i => { i.Image = m.images.baseline.imageId; },
    i => { i.Config.User = '0:0'; }, i => { i.Config.User = '1001:1001'; },
    i => { i.HostConfig.Privileged = true; },
    i => { i.HostConfig.PidMode = 'host'; }, i => { i.HostConfig.IpcMode = 'host'; },
    i => { i.HostConfig.UTSMode = 'host'; }, i => { i.HostConfig.CgroupMode = 'host'; },
    i => { i.HostConfig.UsernsMode = 'host'; },
    i => { i.HostConfig.NetworkMode = 'host'; }, i => { i.HostConfig.ReadonlyRootfs = false; },
    i => { i.HostConfig.CapAdd = ['CAP_SYS_ADMIN']; }, i => { i.HostConfig.SecurityOpt = []; },
    i => { i.HostConfig.PortBindings = { '18080/tcp': [{ HostPort: '18080' }] }; },
    i => { i.Config.Entrypoint = ['/bin/sh']; },
    i => { i.Config.Healthcheck = { Test: ['CMD', 'automatic-unreviewed-helper'] }; },
    i => { i.ExecIDs = ['outstanding-exec']; },
    i => { i.Mounts[0].Source = '/run/podman/podman.sock'; },
    i => { i.Mounts[1].RW = true; },
    i => { i.Mounts.push({ Type: 'bind', Source: '/', Destination: '/host', RW: false }); },
  ]) {
    const info = relayInfo(m);
    mutate(info);
    assert.throws(() => assertRuntimeRelayContainer(info, m));
  }
});

test('unit verification requires exact existing unit and fixed commands, never a shell or replace', () => {
  const m = metadata(), unit = runtimeFixtureUnit(m);
  assertRuntimeUnitProperties(unitProperties(m), m);
  assert.match(unit, /--network container:[a-f0-9]{64}/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1234\/bus/);
  assert.doesNotMatch(unit, /--privileged|--replace|--force|--publish|--network=host|--pid=host|prune|reset|migrate/);
  for (const text of [
    unitProperties(m).replace('DropInPaths=', 'DropInPaths=/etc/systemd/override.conf'),
    unitProperties(m).replace('NeedDaemonReload=no', 'NeedDaemonReload=yes'),
    unitProperties(m).replace('LoadState=loaded', 'LoadState=not-found'),
    unitProperties(m).replace('argv[]=/usr/bin/podman', 'argv[]=/bin/sh -c podman'),
    unitProperties(m).replace('--pull=never', '--pull=always'),
    unitProperties(m).replace('ignore_errors=no', 'ignore_errors=yes'),
    `${unitProperties(m)}\nRestart=always`,
  ]) assert.throws(() => assertRuntimeUnitProperties(text, m));
});

test('synthetic source contains a real versioned unhealthy-capable loopback HTTP server', () => {
  const m = metadata();
  const options = { instanceId: m.instanceId, revision: m.images.healthy.revision,
    healthy: true, baseImageId: `sha256:${'f'.repeat(64)}` };
  const good = syntheticRuntimeDockerfile(options);
  const bad = syntheticRuntimeDockerfile({ ...options, revision: m.images.unhealthy.revision, healthy: false });
  assert.match(good, /USER 1001:1001/);
  assert.ok(good.includes(JSON.stringify(['/usr/bin/python3', '-I', '-c', SYNTHETIC_RUNTIME_SERVER])));
  assert.ok(good.includes(JSON.stringify([m.images.healthy.revision.slice(0, 12), 'healthy'])));
  assert.ok(bad.includes(JSON.stringify([m.images.unhealthy.revision.slice(0, 12), 'unhealthy'])));
  assert.doesNotMatch(good, /\nRUN |curl|wget|\.git|\.env|secret|ssh/i);
  assert.ok(syntheticRuntimeBuildContext(options).includes(Buffer.from('Dockerfile')));
  assert.throws(() => syntheticRuntimeDockerfile({ ...options, baseImageId: 'python:latest' }));
  const info = { Id: m.images.healthy.imageId, Config: {
    User: '1001:1001', Labels: { 'io.pw-deploy.runtime-fixture': m.instanceId,
      'org.opencontainers.image.revision': m.images.healthy.revision },
    Entrypoint: ['/usr/bin/python3', '-I', '-c', SYNTHETIC_RUNTIME_SERVER],
    Cmd: [m.images.healthy.revision.slice(0, 12), 'healthy'],
  } };
  assertSyntheticRuntimeImage(info, m, 'healthy');
  info.Id = info.Id.slice(7);
  assertSyntheticRuntimeImage(info, m, 'healthy');
  info.Config.Cmd[0] = 'wrong-version';
  assert.throws(() => assertSyntheticRuntimeImage(info, m, 'healthy'));
});

test('linked unit paths require the exact resolved private fragment and unchanged command authority', () => {
  const m = metadata(), l = fixtureLayout(m);
  const linked = unitProperties(m).replace(`FragmentPath=${l.unitFile}`,
    `FragmentPath=/fixture-links/${l.service}.service`);
  assert.throws(() => assertRuntimeUnitProperties(linked, m));
  assertRuntimeUnitProperties(linked, m, l.unitFile);
  assert.throws(() => assertRuntimeUnitProperties(linked, m, '/another/private/unit.service'));
  assert.throws(() => assertRuntimeUnitProperties(linked.replace('--pull=never', '--pull=always'), m, l.unitFile));
  assert.throws(() => assertRuntimeUnitProperties(linked.replace('/fixture-links/', '/fixture-links/../'), m, l.unitFile));
  assert.throws(() => assertRuntimeUnitProperties(
    linked.replace(`FragmentPath=/fixture-links/${l.service}.service`, 'FragmentPath=/fixture-links/other.service'), m, l.unitFile));
});

test('same-number relay mapping rejects initial namespaces and every host-root exposure', () => {
  const large = 135567826;
  assertRuntimeUserMapping(`0 100000 65536\n${large} ${large} 1\n`, large);
  assertRuntimeUserMapping('0 100000 1001\n1001 1001 1\n1002 101001 64535\n', 1001);
  for (const text of [
    '0 0 4294967295\n', `0 100000 65536\n${large} ${large} 1\n200000000 0 1\n`,
    `${large} ${large} 1\n`, `0 100000 65536\n${large} ${large + 1} 1\n`,
    `0 100000 65536\n${large} ${large} 0\n`, '0 100000 -1\n', '',
    `0 100000 65536\n${large} ${large} 4294967295\n`,
  ]) assert.throws(() => assertRuntimeUserMapping(text, large));
});

test('Podman inspection identities normalize only exact bare or sha256 digests', () => {
  assert.equal(normalizeRuntimeImageId('a'.repeat(64)), `sha256:${'a'.repeat(64)}`);
  assert.equal(normalizeRuntimeImageId(`sha256:${'a'.repeat(64)}`), `sha256:${'a'.repeat(64)}`);
  for (const value of ['latest', 'abc123', `sha512:${'a'.repeat(64)}`, ` ${'a'.repeat(64)}`,
    'A'.repeat(64), null, undefined, 1]) assert.throws(() => normalizeRuntimeImageId(value));
});

test('transport can select only the immutable relay exec, never execute SSH or caller argv', () => {
  const m = metadata(), argv = runtimeExecArgv(m);
  assert.deepEqual(argv, ['--remote', '--url', `unix://${fixtureLayout(m).socket}`,
    'exec', '--interactive', '--user=1234:1234', m.relay.containerId,
    '/usr/bin/python3', '-I', '/opt/pw-deploy/runtime-relay.py']);
  const ssh = runtimeSshArgv({
    host: 'runtime-fixture.invalid', port: 22, user: 'fixture',
    keyFile: '/fixture-unused/key', knownHostsFile: '/fixture-unused/known-hosts',
  });
  assertFixedRuntimeTransport(ssh[0], ssh.slice(1));
  assert.throws(() => assertFixedRuntimeTransport('/bin/sh', ssh.slice(1)));
  assert.throws(() => assertFixedRuntimeTransport(ssh[0], [...ssh.slice(1), 'rm']));
  assert.throws(() => assertFixedRuntimeTransport(ssh[0], ssh.slice(1).map(v => v === 'runtime-fixture.invalid' ? 'live-host' : v)));
});

test('relay identity preserves distinct host UID and GID without widening application identity', () => {
  const m = metadata();
  m.uid = 135567826;
  m.gid = 135567827;
  assertRuntimeRelayContainer(relayInfo(m), m);
  assert.ok(runtimeExecArgv(m).includes('--user=135567826:135567827'));
  assert.match(runtimeRelayPreflight(m), /os\.getuid\(\)==135567826 and os\.getgid\(\)==135567827/);
  assert.match(runtimeRelayPreflight(m), /pwd\.getpwuid\(135567826\)\.pw_dir=="\/workspace\/home"/);
  assert.ok(runtimeUnitCommands(m).ExecStart.includes('--user=1001:1001'));
  assert.ok(runtimeUnitCommands(m).ExecStart.includes('--userns=keep-id:uid=1001,gid=1001'));
  const substituted = relayInfo(m);
  substituted.Mounts[1].Destination = '/run/user/1001/bus';
  assert.throws(() => assertRuntimeRelayContainer(substituted, m));
  assert.throws(() => runtimeRelayPreflight({ ...m, uid: 0 }));
});

test('protected inventory compares exact identities and states, independent of ordering', () => {
  const expected = metadata().protectedContainers;
  assertProtectedRuntimeInventory([...expected].reverse(), expected);
  for (const key of ['id', 'imageId', 'state']) {
    const changed = structuredClone(expected);
    changed[0][key] = 'changed';
    assert.throws(() => assertProtectedRuntimeInventory(changed, expected));
  }
});

test('observed relay framing latches uncertainty instead of equating client exit with server stop', () => {
  const frame = value => {
    const body = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from(String(body.length).padStart(10, '0')), body]);
  };
  assert.equal(relayOutcomeIsCertain(frame({ ok: true, result: {} }), 0), true);
  assert.equal(relayOutcomeIsCertain(frame({ ok: false, code: 'health_failed' }), 0), true);
  assert.equal(relayOutcomeIsCertain(frame({ ok: false, code: 'resource_conflict' }), 0), true);
  for (const [body, code] of [
    [frame({ ok: false, code: 'process_failed' }), 0],
    [frame({ ok: false, code: 'cancelled' }), 0],
    [frame({ ok: false, code: 'unknown' }), 0],
    [frame({ ok: true, result: {} }), 125],
    [frame({ ok: true, result: {} }), null],
    [frame({ ok: true }), 0],
    [frame({ ok: true, result: [] }), 0],
    [Buffer.from('0000000002{}trailing'), 0],
    [Buffer.from('0000000001{'), 0],
    [Buffer.alloc(262155), 0],
  ]) assert.equal(relayOutcomeIsCertain(body, code), false);
});

const gate = runtimeFixtureGate(process.env, process.platform);
test('REAL runtime relay import, existing-unit activation, health/version, rollback and owned untag',
  { skip: gate.enabled ? false : gate.reason, timeout: 420000 }, async t => {
    const m = await readRuntimeFixtureMetadata(process.env.PW_DEPLOY_RUNTIME_FIXTURE_METADATA);
    const result = await exerciseRuntimeRelayLifecycle(m, {
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(300000)]),
      diagnostic: value => t.diagnostic(value),
    });
    assert.deepEqual(result.events, [
      'baseline:real_import', 'healthy:real_import', 'unhealthy:real_import',
      'candidate:expected_id_conflict_and_idempotent_untag',
      'healthy:exact_running_image_health_version',
      'unhealthy:rejected_and_real_rollback_restored',
      'cleanup:baseline_restored_candidates_absent_decoy_preserved',
    ]);
    assert.equal(result.fullServiceProven, false);
  });
