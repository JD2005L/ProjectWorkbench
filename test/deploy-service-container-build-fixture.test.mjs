import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  createContainerBuildFixturePayload,
  createFixtureRuntimePeer,
  parseBuildCancellationIdentity,
} from './deploy-service-container-build-fixtures.mjs';
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
  assert.match(files['Dockerfile.cancel'], /sed -n 's\/\^0::\/\/p' \/proc\/self\/cgroup/);
});

test('build cancellation evidence requires a complete emitted line, not a Dockerfile echo', () => {
  const marker = 'PW_BUILD_CANCEL_READY_11111111111141118111111111111111';
  const id = 'a'.repeat(64);
  const cgroup = `/user.slice/user-1001.slice/user@1001.service/libpod-${id}.scope`;
  assert.throws(() => parseBuildCancellationIdentity(`STEP 3: RUN printf '${marker} %s\\n' "$cgroup"\n`, marker),
    error => error.code === 'fixture_oracle_unavailable');
  assert.throws(() => parseBuildCancellationIdentity(`${marker} ${cgroup}`, marker),
    error => error.code === 'fixture_oracle_unavailable');
  assert.throws(() => parseBuildCancellationIdentity(`${marker} /\n`, marker),
    error => error.code === 'fixture_oracle_unavailable');
  assert.deepEqual(parseBuildCancellationIdentity(`${marker} ${cgroup}\n`, marker), {
    id, cgroupPath: cgroup, directory: `/sys/fs/cgroup${cgroup}`,
  });
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
