import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { DeploymentError, validateJob, validateRecipe } from '../app/deployment/protocol.js';
import { validateSettings, validateTargetSettings, resolveJobPolicy } from '../app/deployment/policy.js';
import { lineRedactor } from '../app/deployment/output.js';
import { deploymentConfig, deploymentRequest, MemoryJobStore, until } from './deploy-service-fixtures.mjs';

async function fixture(t, deploy, config = deploymentConfig(), store = new MemoryJobStore()) {
  const fatal = [];
  const engine = new DeploymentEngine({ config, store, executor: { deploy }, onFatal: error => fatal.push(error) });
  await engine.init();
  t.after(async () => { await engine.close(); assert.deepEqual(fatal, []); });
  return { engine, store };
}

test('two simultaneous submissions with one idempotency key execute exactly once', async t => {
  let starts = 0;
  const { engine } = await fixture(t, async () => { starts++; return { version: 'a'.repeat(12) }; });
  const [first, second] = await Promise.all([engine.submit(deploymentRequest()), engine.submit(deploymentRequest())]);
  assert.equal(first.id, second.id);
  await until(() => engine.get(first.id).state === 'succeeded');
  assert.equal(starts, 1);
  await assert.rejects(engine.submit(deploymentRequest({ script: 'exit 1' })), /already used/);
});

test('target lock serializes one target while independent targets use permitted concurrency', async t => {
  const starts = [];
  const releases = [];
  const { engine } = await fixture(t, (request, control) => new Promise((resolve, reject) => {
    starts.push(request.requestId);
    releases.push(() => resolve({ version: '1.0.0' }));
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
  }), deploymentConfig({ maxConcurrent: 2 }));
  const first = await engine.submit(deploymentRequest());
  const second = await engine.submit(deploymentRequest({ requestId: 'fixture-request-2' }));
  const third = await engine.submit(deploymentRequest({ requestId: 'fixture-request-3', target: 'dev' }));
  await until(() => starts.length === 2);
  assert.deepEqual(starts, ['fixture-request-1', 'fixture-request-3']);
  assert.equal(engine.get(second.id).state, 'queued');
  releases[0]();
  await until(() => starts.length === 3);
  releases[1]();
  releases[2]();
  await until(() => [first, second, third].every(job => engine.get(job.id).state === 'succeeded'));
});

test('queued cancellation never starts the command; running cancellation signals only that job', async t => {
  const starts = [];
  const { engine } = await fixture(t, (request, control) => new Promise((resolve, reject) => {
    starts.push(request.requestId);
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
  }));
  const first = await engine.submit(deploymentRequest());
  await until(() => starts.length === 1);
  const second = await engine.submit(deploymentRequest({ requestId: 'fixture-request-2' }));
  await engine.cancel(second.id);
  assert.equal(engine.get(second.id).state, 'cancelled');
  await engine.cancel(first.id);
  await until(() => engine.get(first.id).state === 'cancelled');
  assert.deepEqual(starts, ['fixture-request-1']);
});

test('container aliases sharing an image serialize even when service names differ', async t => {
  const starts = [], releases = [];
  const { engine } = await fixture(t, (request, control) => new Promise((resolve, reject) => {
    starts.push(request.requestId);
    releases.push(() => resolve({ version: '1.0.0' }));
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
  }), deploymentConfig({ maxConcurrent: 2 }));
  const first = await engine.submit(deploymentRequest({
    project: 'TeamKB', recipe: { adapter: 'podman', image: 'teamkb', service: 'team-kb' },
  }));
  const second = await engine.submit(deploymentRequest({
    requestId: 'fixture-alias-two', project: 'teamkb', recipe: { adapter: 'podman' },
  }));
  await until(() => starts.length === 1);
  assert.equal(engine.get(second.id).state, 'queued');
  releases[0]();
  await until(() => starts.length === 2);
  releases[1]();
  await until(() => [first, second].every(item => engine.get(item.id).state === 'succeeded'));
});

test('failure stores an operational code, never private command output or exception content', async t => {
  const { engine, store } = await fixture(t, async (request, control) => {
    control.onOutput('password=fixture-');
    control.onOutput('secret\nAuthorization: Bearer fixture-secret\n');
    throw new Error('fixture-secret must never be retained');
  });
  const job = await engine.submit(deploymentRequest({ secrets: { DEPLOY_PASSWORD: 'fixture-secret' } }));
  await until(() => engine.get(job.id).finishedAt);
  assert.equal(engine.get(job.id).state, 'failed');
  assert.equal(engine.get(job.id).errorCode, 'execution_failed');
  assert.equal(JSON.stringify(store.jobs.get(job.id)).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(engine.logs(job.id)).includes('fixture-secret'), false);
  assert.equal(engine.version(job.project, job.target).version, null);
});

test('worker restart interrupts unfinished jobs without replaying or retaining their credentials', async t => {
  const store = new MemoryJobStore();
  const first = await fixture(t, (request, control) => new Promise((resolve, reject) => {
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
  }), deploymentConfig(), store);
  const job = await first.engine.submit(deploymentRequest({ secrets: { DEPLOY_PASSWORD: 'fixture-secret' } }));
  await until(() => first.engine.get(job.id).state === 'running');
  const recoveredStore = new MemoryJobStore();
  recoveredStore.jobs = structuredClone(store.jobs);
  let replayed = false;
  const second = await fixture(t, async () => { replayed = true; }, deploymentConfig(), recoveredStore);
  assert.equal(second.engine.get(job.id).state, 'interrupted');
  assert.equal(second.engine.get(job.id).errorCode, 'worker_restarted');
  assert.equal(replayed, false);
  assert.equal(JSON.stringify(await recoveredStore.loadJobs()).includes('fixture-secret'), false);
  await first.engine.cancel(job.id);
});

test('global settings and target overrides persist without requiring enrollment for another project', async t => {
  const { engine, store } = await fixture(t, async () => ({ version: '1.0.0' }));
  await engine.updateTarget('ExampleApp', 'prod', { paused: true, timeoutSeconds: 120 });
  await assert.rejects(engine.submit(deploymentRequest()), error => error.code === 'target_paused');
  const other = await engine.submit(deploymentRequest({ project: 'NewProject', requestId: 'new-project-request' }));
  await until(() => engine.get(other.id).state === 'succeeded');
  await engine.updateSettings({ paused: true });
  await assert.rejects(engine.submit(deploymentRequest({ project: 'AnotherNewProject' })), /paused/);
  assert.equal(store.settings.get('settings').paused, true);
  assert.equal(engine.targetList().find(target => target.project === 'NewProject').paused, false);
});

test('privileged identity and command overrides cannot be set through admin runtime settings', () => {
  for (const value of [{ buildUser: 'root' }, { runtimeUser: 'root' }, { runAsRoot: true }, { maxConcurrent: 100 }]) {
    assert.throws(() => validateSettings(value));
  }
  assert.throws(() => validateTargetSettings({ command: 'arbitrary root shell' }));
  const config = deploymentConfig();
  assert.throws(() => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
    recipe: { adapter: 'podman', service: 'another-service' },
  })), /must belong/);
  assert.throws(() => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
    recipe: { adapter: 'podman', healthUrl: 'http://169.254.169.254/' },
  })), /not approved/);
});

test('operator-owned legacy names preserve an existing destination without enrolling other projects', () => {
  const config = deploymentConfig({ resourceNames: { 'ExampleDashboard/prod': 'legacy-dashboard' } });
  const resolve = overrides => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
    project: 'ExampleDashboard', recipe: { adapter: 'podman' }, ...overrides,
  }));
  const defaulted = resolve({});
  assert.equal(defaulted.image, 'legacy-dashboard');
  assert.equal(defaulted.service, 'legacy-dashboard');
  assert.deepEqual(defaulted.resourceKeys, ['podman-service/legacy-dashboard', 'podman-image/legacy-dashboard']);
  assert.equal(resolve({
    recipe: { adapter: 'podman', image: 'legacy-dashboard', service: 'legacy-dashboard' },
  }).service, 'legacy-dashboard');
  assert.throws(() => resolve({
    recipe: { adapter: 'podman', service: 'example-dashboard' },
  }), error => error.code === 'resource_not_allowed');
  assert.equal(resolve({ target: 'dev' }).service, 'example-dashboard-dev');
  assert.equal(resolve({ project: 'NewProject' }).service, 'new-project');
});

test('a legacy binding reserves its name even against another project canonical or compact name', () => {
  for (const name of ['legacy-dashboard', 'legacydashboard']) {
    const config = deploymentConfig({ resourceNames: { 'ExampleDashboard/prod': name } });
    for (const recipe of [{ adapter: 'podman', image: name }, { adapter: 'podman', service: name }]) {
      assert.throws(() => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
        project: 'LegacyDashboard', recipe,
      })), error => error.code === 'resource_not_allowed');
    }
    assert.throws(() => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
      project: name, recipe: { adapter: 'podman' },
    })), error => error.code === 'resource_not_allowed');
  }
  const config = deploymentConfig({ resourceNames: { 'ExampleDashboard/prod': 'legacy-dashboard-dev' } });
  assert.throws(() => resolveJobPolicy(config, config.defaults, {}, deploymentRequest({
    project: 'LegacyDashboard', target: 'dev', recipe: { adapter: 'podman' },
  })), error => error.code === 'resource_not_allowed');
});

test('invalid, duplicate or runtime-editable legacy bindings are refused', () => {
  for (const resourceNames of [
    null, [], 'legacy',
    { 'ExampleDashboard': 'legacy-dashboard' },
    { 'ExampleDashboard/staging': 'legacy-dashboard' },
    { 'ExampleDashboard/prod/extra': 'legacy-dashboard' },
    { '__proto__/prod': 'legacy-dashboard' },
    { 'ExampleDashboard/prod': '' },
    { 'ExampleDashboard/prod': undefined },
    { 'ExampleDashboard/prod': '../legacy-dashboard' },
    { 'ExampleDashboard/prod': 'registry.example/app:latest' },
    { 'ExampleDashboard/prod': 12 },
    { 'ExampleDashboard/prod': 'legacy-dashboard', 'AnotherProject/prod': 'legacy-dashboard' },
    Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`Example${index}/prod`, `legacy-${index}`])),
  ]) assert.throws(() => deploymentConfig({ resourceNames }));
  const resourceNames = { 'ExampleDashboard/prod': 'legacy-dashboard' };
  assert.throws(() => validateSettings({ resourceNames }));
  assert.throws(() => validateTargetSettings({ resourceNames }));
  assert.throws(() => validateJob(deploymentRequest({ resourceNames })));
  assert.throws(() => validateRecipe({ adapter: 'podman', resourceNames }));
});

test('split secrets and overlong log lines cannot bypass live-output redaction', () => {
  const lines = [];
  const logger = lineRedactor(['fixture-secret'], line => lines.push(line));
  logger.write('build: fixture-');
  logger.write('secret\n');
  logger.write('x'.repeat(70000) + 'fixture-');
  logger.write('secret\nnext\n');
  logger.end();
  assert.deepEqual(lines, ['build: [redacted]', '[oversized output line omitted]', 'next']);
  const multiline = [];
  const logger2 = lineRedactor(['fixture-first\nfixture-second'], line => multiline.push(line));
  logger2.write('fixture-first\nfixture-sec');
  logger2.write('ond\n');
  logger2.end();
  assert.deepEqual(multiline, ['[redacted]', '[redacted]']);
});

test('an invalid version or a secret-shaped version cannot create a successful deployment', async t => {
  const { engine } = await fixture(t, async () => ({ version: '1.2.3' }));
  const job = await engine.submit(deploymentRequest({ secrets: { DEPLOY_PASSWORD: '1.2.3' } }));
  await until(() => engine.get(job.id).finishedAt);
  assert.equal(engine.get(job.id).state, 'failed');
  assert.equal(engine.get(job.id).errorCode, 'invalid_version');
});

test('completed log retention never evicts the live output of an active older job', async t => {
  let active;
  const { engine } = await fixture(t, (request, control) => {
    if (request.project === 'LongRunning') {
      active = control;
      control.onOutput('still running\n');
      return new Promise((resolve, reject) => {
        control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
      });
    }
    control.onOutput('finished\n');
    return Promise.resolve({ version: '1.0.0' });
  }, deploymentConfig({ maxConcurrent: 2 }));
  const first = await engine.submit(deploymentRequest({ project: 'LongRunning' }));
  await until(() => active);
  for (let index = 0; index < 20; index++) {
    const job = await engine.submit(deploymentRequest({
      requestId: `fixture-short-${index}`, project: `Short${index}`,
    }));
    await until(() => engine.get(job.id).finishedAt);
  }
  active.onOutput('still observable\n');
  assert.equal(engine.get(first.id).state, 'running');
  assert.ok(engine.logs(first.id).live.some(line => line.text === 'still observable'));
  assert.ok(engine.live.size <= 20);
  await engine.cancel(first.id);
});

test('known timeout failures are explicit rather than successful fallbacks', async t => {
  const { engine } = await fixture(t, async () => {
    throw new DeploymentError('Synthetic timeout', 504, 'timeout');
  });
  const job = await engine.submit(deploymentRequest());
  await until(() => engine.get(job.id).finishedAt);
  assert.equal(engine.get(job.id).state, 'failed');
  assert.equal(engine.get(job.id).errorCode, 'timeout');
});

test('the actual job deadline aborts execution and persists a timeout outcome', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { engine, store } = await fixture(t, (request, control) => new Promise((resolve, reject) => {
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
    started();
  }), deploymentConfig({ defaultTimeoutSeconds: 30 }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const job = await engine.submit(deploymentRequest());
  await ready;
  const finished = engine.active.get(job.id).promise;
  t.mock.timers.tick(30000);
  await finished;
  assert.equal(engine.get(job.id).state, 'failed');
  assert.equal(store.jobs.get(job.id).errorCode, 'timeout');
});

test('latest successful version survives equal timestamps and reversed journal load order', async t => {
  const store = new MemoryJobStore();
  const engine = new DeploymentEngine({
    config: deploymentConfig(), store, now: () => new Date('2026-01-01T00:00:00.000Z'),
    executor: { deploy: async request => ({ version: request.environment.DEPLOY_OPTION }) },
  });
  await engine.init();
  t.after(() => engine.close());
  for (const version of ['1.0.0', '2.0.0']) {
    const job = await engine.submit(deploymentRequest({
      requestId: `fixture-version-${version.replaceAll('.', '-')}`, environment: { DEPLOY_OPTION: version },
    }));
    await until(() => engine.get(job.id).finishedAt);
  }
  assert.equal(engine.version('ExampleApp', 'prod').version, '2.0.0');
  const loaded = await store.loadJobs();
  store.loadJobs = async () => [...loaded].reverse();
  const restored = new DeploymentEngine({
    config: deploymentConfig(), store, now: () => new Date('2026-01-01T00:00:00.000Z'), executor: {},
  });
  await restored.init();
  t.after(() => restored.close());
  assert.equal(restored.version('ExampleApp', 'prod').version, '2.0.0');
});

test('a failed cancellation overrides the abort reason and stops all further scheduling', async t => {
  const fatal = [];
  let starts = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const engine = new DeploymentEngine({
    config: deploymentConfig(), store: new MemoryJobStore(),
    executor: { deploy: (request, control) => new Promise((resolve, reject) => {
      starts++;
      control.signal.addEventListener('abort', () => {
        reject(new DeploymentError('Synthetic supervisor failure', 503, 'cancellation_failed'));
      }, { once: true });
      started();
    }) },
    onFatal: error => fatal.push(error),
  });
  await engine.init();
  t.after(() => engine.close());
  const first = await engine.submit(deploymentRequest());
  await ready;
  await engine.submit(deploymentRequest({ requestId: 'fixture-waiting-2' }));
  const finished = engine.active.get(first.id).promise;
  await engine.cancel(first.id);
  await finished;
  assert.equal(engine.get(first.id).errorCode, 'cancellation_failed');
  assert.equal(engine.get(first.id).state, 'failed');
  assert.equal(engine.stopping, true);
  assert.equal(fatal.length, 1);
  assert.equal(starts, 1);
  await assert.rejects(engine.submit(deploymentRequest({ requestId: 'fixture-refused-3' })),
    error => error.code === 'service_stopping');
});

test('a journal failure cannot release a queued deployment into an unsupervised worker', async t => {
  const store = new MemoryJobStore();
  const save = store.saveJob.bind(store);
  store.saveJob = async job => {
    if (job.phase === 'succeeded') throw new Error('Synthetic journal failure');
    return save(job);
  };
  const fatal = [];
  let release, started, starts = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const engine = new DeploymentEngine({
    config: deploymentConfig(), store, onFatal: error => fatal.push(error),
    executor: { deploy: () => new Promise(resolve => {
      starts++;
      release = resolve;
      started();
    }) },
  });
  await engine.init();
  t.after(() => engine.close());
  const first = await engine.submit(deploymentRequest());
  await ready;
  await engine.submit(deploymentRequest({ requestId: 'fixture-waiting-2' }));
  const finished = engine.active.get(first.id).promise;
  release({ version: '1.0.0' });
  await assert.rejects(finished, /journal failure/);
  assert.equal(engine.stopping, true);
  assert.equal(fatal.length, 1);
  assert.equal(starts, 1);
});
