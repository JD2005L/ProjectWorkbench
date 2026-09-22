import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindExecutionIdentity, startContainerService } from '../app/deployment/container-service.js';
import { validateContainerConfig } from '../app/deployment/container-config.js';
import { DeploymentError } from '../app/deployment/protocol.js';
import { withLifecycleLock } from '../app/lifecycle-lock.js';
import { MemoryJobStore, deploymentRequest, until } from './deploy-service-fixtures.mjs';

const token = 'synthetic-machine-service-credential-0123456789';
const uiToken = 'synthetic-console-service-credential-0123456789';
const directory = path.dirname(fileURLToPath(import.meta.url));

function config() {
  const value = validateContainerConfig({
    mode: 'container', listen: { host: '127.0.0.1', port: 3800 },
    stateDir: '/var/lib/pw-deploy', tokenFile: '/run/secrets/api',
    adapters: ['script', 'iis'],
    ui: { tokenFile: '/run/secrets/ui', publicOrigin: 'https://console.example.test' },
    container: { instanceId: '524637ea-d8d4-41b4-a2b1-b9d615961b2f',
      builderSocket: '/run/pw-deploy/podman.sock', workerImage: `sha256:${'a'.repeat(64)}` },
  });
  value.listen.port = 0;
  return value;
}

async function fixture(t, overrides = {}) {
  let initialized = false;
  const executor = {
    async init() { initialized = true; },
    async deploy() { return { version: '1.2.3' }; },
  };
  const app = await startContainerService({
    config: config(), token, uiToken, executor, store: new MemoryJobStore(), ...overrides,
  });
  t.after(async () => { if (!app.engine.fatal) await app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, initialized,
    send: (route, options) => fetch(base + route, { redirect: 'manual', ...options }) };
}

test('the combined service exposes its own console and minimal health without PW', async t => {
  const app = await fixture(t);
  assert.equal(app.initialized, true);
  for (const route of ['/health', '/deploy-service/health']) {
    const response = await app.send(route);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['apiVersion', 'ok', 'service']);
  }
  const console = await app.send('/deploy-service/');
  assert.equal(console.status, 303);
  assert.match(console.headers.get('location'), /^\/deploy-service\/login/);
  assert.equal((await app.send('/v1/jobs')).status, 401);
  assert.equal((await app.send('/v1/jobs', { headers: { Authorization: `Bearer ${uiToken}` } })).status, 401);
  const admitted = await app.send('/v1/jobs', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(deploymentRequest()),
  });
  assert.equal(admitted.status, 202);
  const { job } = await admitted.json();
  await until(() => app.engine.get(job.id).state === 'succeeded');
  await app.close();
  assert.deepEqual(await app.finished, { ok: true });
  assert.equal(app.server.listening, false);
});

test('a runtime fatal error cannot become a successful service exit after cleanup', async t => {
  const app = await fixture(t);
  const failure = new DeploymentError('Synthetic controller failure', 503, 'cancellation_failed');
  app.engine.failClosed(failure);
  const outcome = await app.finished;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, failure);
  await assert.rejects(app.close(), error => error === failure);
  assert.equal(app.server.listening, false);
});

test('failed executor startup does not install handlers or start a partial service', async () => {
  const failure = new DeploymentError('Synthetic executor initialization failure', 503, 'executor_unavailable');
  const before = ['SIGTERM', 'SIGINT'].map(name => process.listenerCount(name));
  await assert.rejects(startContainerService({
    config: config(), token, uiToken, store: new MemoryJobStore(), installSignals: true,
    executor: { async init() { throw failure; } },
  }), error => error === failure);
  assert.deepEqual(['SIGTERM', 'SIGINT'].map(name => process.listenerCount(name)), before);
});

test('programmatic startup also refuses reuse of the console credential as the machine credential', async () => {
  let called = false;
  await assert.rejects(startContainerService({
    config: config(), token, uiToken: token, store: new MemoryJobStore(),
    executor: { async init() { called = true; } },
  }), error => error.code === 'invalid_configuration');
  assert.equal(called, false);
});

async function stateFixture(t) {
  const root = await fs.mkdtemp(path.join(directory, '.container-service-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { ...config(), stateDir: root };
}

test('persistent execution identity allows image rotation but not changing execution authority', {
  skip: process.platform !== 'linux',
}, async t => {
  const original = await stateFixture(t);
  await bindExecutionIdentity(original);
  const file = path.join(original.stateDir, 'execution-identity.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))), ['fingerprint']);
  await bindExecutionIdentity(original);
  await bindExecutionIdentity({ ...original,
    container: { ...original.container, workerImage: `sha256:${'b'.repeat(64)}` } });
  for (const change of [
    { instanceId: '624637ea-d8d4-41b4-a2b1-b9d615961b2f' },
    { builderSocket: '/run/another/podman.sock' },
    { runtime: { host: 'runtime.example.test', port: 22, user: 'fixture-runtime' } },
    { builderControl: { host: 'builder.example.test', port: 22, user: 'fixture-builder' },
      builderJobSockets: '/run/pw-deploy-build' },
  ]) {
    await assert.rejects(bindExecutionIdentity({ ...original, container: { ...original.container, ...change } }),
      error => error.code === 'execution_identity_changed');
  }
  await fs.chmod(file, 0o644);
  await assert.rejects(bindExecutionIdentity(original), error => error.code === 'unsafe_state');
});

test('controller state lock rejects a concurrent lifetime and releases without deleting the lock inode', {
  skip: process.platform !== 'linux',
}, async t => {
  const value = await stateFixture(t), file = path.join(value.stateDir, 'controller.lock');
  let entered, release;
  const held = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withLifecycleLock(file, async () => {
    await bindExecutionIdentity(value);
    entered();
    await gate;
  });
  await held;
  const inode = (await fs.stat(file)).ino;
  try {
    await assert.rejects(withLifecycleLock(file, () => assert.fail('concurrent controller entered'),
      { timeoutMs: 1000 }), /timed out or failed/);
  } finally { release(); await first; }
  await withLifecycleLock(file, () => bindExecutionIdentity(value));
  assert.equal((await fs.stat(file)).ino, inode);
});
