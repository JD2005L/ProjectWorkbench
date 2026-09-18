import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  createContainerBuildFixturePayload,
  createFixtureRuntimePeer,
  buildCancellationReady,
  cancellationProofDeadline,
} from './deploy-service-container-build-fixtures.mjs';
import { bindObservedBuild, parseObservedProcess } from './deploy-service-build-observer.mjs';
import { snapshotDigest, validateJob } from '../app/deployment/protocol.js';
import { runtimeRequest } from '../app/deployment/runtime-client.js';

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from(String(body.length).padStart(10, '0'), 'ascii'), body]);
}

async function peerResponse(request) {
  const peer = createFixtureRuntimePeer(() => {});
  const chunks = [];
  peer.stdout.on('data', chunk => chunks.push(chunk));
  peer.stdin.end(frame(request));
  await once(peer, 'close');
  const response = Buffer.concat(chunks);
  const size = Number(response.subarray(0, 10).toString('ascii'));
  return JSON.parse(response.subarray(10, 10 + size).toString('utf8'));
}

test('container build fixture payload is protocol-valid and fully local', () => {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const payload = createContainerBuildFixturePayload({ instanceId });
  const validated = validateJob(payload);
  assert.equal(validated.recipe.adapter, 'podman');
  assert.equal(validated.source.sha256, snapshotDigest(validated.source.files));
  assert.deepEqual(validated.secrets, {});
  assert.deepEqual(validated.environment, {});
  const files = Object.fromEntries(validated.source.files.map(file => [
    file.path, Buffer.from(file.data, 'base64').toString('utf8'),
  ]));
  assert.match(files['package.json'], /"install":"node scripts\/install\.mjs"/);
  assert.match(files['package-lock.json'], /"lockfileVersion":3/);
  assert.doesNotMatch(files['package-lock.json'], /node_modules|resolved|integrity/);
  assert.match(files['.npmrc'], /offline=true/);
  assert.match(files.Dockerfile, /generated\/nested\/dependency-proof\.txt/);
  assert.match(files.Dockerfile, /test ! -e \/fixture\/source\/package\.json/);
  assert.match(files['Dockerfile.cancel'], /timeout .*90s/);
  assert.doesNotMatch(files['Dockerfile.cancel'], /\/proc\/self\/cgroup|--pid=host|--privileged/);
});

test('build cancellation evidence requires a complete emitted line, not a Dockerfile echo', () => {
  const marker = 'PW_BUILD_CANCEL_READY_11111111111141118111111111111111';
  assert.equal(buildCancellationReady(`STEP 3: RUN printf '${marker}\\n'\n`, marker), false);
  assert.equal(buildCancellationReady(marker, marker), false);
  assert.equal(buildCancellationReady(`${marker} /\n`, marker), false);
  assert.equal(buildCancellationReady(`${marker}\n`, marker), true);
  assert.equal(buildCancellationReady(`STEP 3\n${marker}\r\n`, marker), true);
});

test('cancellation uses one absolute stop budget strictly before the independent guard can act', () => {
  assert.equal(cancellationProofDeadline(1000, 2000), 22000);
  assert.equal(cancellationProofDeadline(0, 60000), 80000);
  for (const values of [[0, 65000], [0, 70000], [0, 90000], [2000, 1000], [NaN, 0], [0, Infinity]]) {
    assert.throws(() => cancellationProofDeadline(...values));
  }
});

test('trusted build observer binds the nonce, private PID namespace, OCI root and exact storage ID', () => {
  const storageBase = '/srv/containers/pw-contained-fixture-controlled';
  const marker = 'PW_BUILD_CANCEL_READY_11111111111141118111111111111111';
  const layer = 'a'.repeat(64);
  const id = 'b'.repeat(64);
  const observation = {
    storageBase, marker,
    state: { id: 'buildah-buildah12345', status: 'running', pid: 1234, bundle: `${storageBase}/transfer/buildah12345` },
    specification: {
      root: { path: `${storageBase}/transfer/buildah12345/mnt/rootfs` },
      process: { args: ['/bin/sh', '-c', `printf '${marker}\\n'; sleep 90`] },
      linux: { namespaces: [{ type: 'pid' }, { type: 'mount' }] },
      mounts: [{
        type: 'bind', destination: '/run/.containerenv',
        source: `${storageBase}/transfer/buildah12345/run/.containerenv`,
      }],
    },
    containerEnvironment: `engine="buildah-1.43.1"\nid="${id}"\nrootless=1\n`,
    containers: [{ id, layer }],
  };
  assert.deepEqual(bindObservedBuild(observation), {
    runtimeId: 'buildah-buildah12345', pid: 1234, bundle: observation.state.bundle,
    storageId: id,
  });
  for (const mutate of [
    value => { value.state.bundle = '/var/tmp/foreign-buildah12345'; },
    value => { value.state.status = 'stopped'; },
    value => { value.state.pid = 0; },
    value => { value.specification.process.args = ['/bin/sleep', '90']; },
    value => { value.specification.linux.namespaces = [{ type: 'pid', path: '/proc/1/ns/pid' }]; },
    value => { value.specification.linux.namespaces = [{ type: 'mount' }]; },
    value => { value.specification.root.path = `/shared/overlay/${layer}/merged`; },
    value => { value.containers = []; },
    value => { value.containers.push({ id, layer: 'c'.repeat(64) }); },
    value => { value.specification.mounts[0].source = '/shared/.containerenv'; },
    value => { value.containerEnvironment = `id="${id}"\nrootless=0\n`; },
    value => { value.containerEnvironment += `id="${'c'.repeat(64)}"\n`; },
  ]) {
    const invalid = structuredClone(observation);
    mutate(invalid);
    assert.throws(() => bindObservedBuild(invalid), error => error.code === 'fixture_oracle_unavailable');
  }
});

test('process observation retains the kernel start time and cannot confuse PID reuse', () => {
  const fields = Array(30).fill('0');
  fields[0] = 'S';
  fields[19] = '123456';
  const text = `1234 (process with ) space) ${fields.join(' ')}\n`;
  assert.deepEqual(parseObservedProcess(text, 1234), { pid: 1234, state: 'S', startTime: '123456' });
  assert.throws(() => parseObservedProcess(text, 5678), error => error.code === 'fixture_oracle_unavailable');
  fields[19] = '123457';
  assert.notEqual(parseObservedProcess(`1234 (name) ${fields.join(' ')}`, 1234).startTime, '123456');
});

test('fixture runtime peer permits only preflight and refuses mutation with framed responses', async () => {
  assert.deepEqual(await peerResponse({
    requestId: 'fixture-request-1',
    action: 'service_preflight',
    project: 'ContainedBuild',
    target: 'dev',
    service: 'contained-build-dev',
  }), { ok: true, result: { loadState: 'loaded' } });
  assert.deepEqual(await peerResponse({
    requestId: 'fixture-request-2',
    action: 'image_import',
    project: 'ContainedBuild',
    target: 'dev',
    image: 'contained-build-dev',
    jobId: '11111111-1111-4111-8111-111111111111',
    expectedImageId: `sha256:${'a'.repeat(64)}`,
    revision: 'b'.repeat(40),
  }), {
    ok: false,
    code: 'action_not_allowed',
    error: 'Fixture runtime refuses every mutating action',
  });

  const runtime = {
    host: 'fixture.invalid',
    port: 22,
    user: 'fixture-runtime',
    keyFile: '/run/pw-contained-fixture/runtime.key',
    knownHostsFile: '/run/pw-contained-fixture/known-hosts',
  };
  await assert.rejects(runtimeRequest(runtime, {
    requestId: 'fixture-request-3',
    action: 'image_import',
    project: 'ContainedBuild',
    target: 'dev',
    image: 'contained-build-dev',
    jobId: '11111111-1111-4111-8111-111111111111',
    expectedImageId: `sha256:${'a'.repeat(64)}`,
    revision: 'b'.repeat(40),
  }, {
    signal: AbortSignal.timeout(2000),
    timeoutMs: 2000,
    ociStream: Readable.from(Buffer.alloc(128 * 1024, 0x61)),
    spawnProcess: () => createFixtureRuntimePeer(() => {}),
  }), error => error.code === 'action_not_allowed'
    && error.message === 'Fixture runtime refuses every mutating action');
});
