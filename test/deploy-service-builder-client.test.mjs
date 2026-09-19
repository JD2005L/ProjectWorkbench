import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { builderRequest, builderSshArgv, builderUnitName, SupervisedBuilder,
  validateBuilderResult } from '../app/deployment/builder-client.js';
import { connectorSshArgv } from '../app/deployment/connector-client.js';
import { DeploymentError } from '../app/deployment/protocol.js';
import { builderStartupFailure, exchangeStartupFailure } from '../app/deployment/builder-diagnostics.js';
import { builderStartupDiagnostic } from './deploy-service-fixtures.mjs';

const instanceId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const connection = {
  host: 'builder.example.test', port: 22, user: 'deploy-builder',
  keyFile: '/run/secrets/builder-key', knownHostsFile: '/etc/pw-deploy/known_hosts',
};
const config = { container: {
  instanceId, builderControl: connection, builderSocket: '/run/cache/podman.sock',
  builderJobSockets: '/run/pw-build', maxMemoryMiB: 2048, maxPids: 512,
} };
const unit = builderUnitName(instanceId, jobId);
const cgroup = `/user.slice/user-2000.slice/user@2000.service/app.slice/${unit}/payload`;
const control = (overrides = {}) => ({
  jobId, policy: { timeoutSeconds: 30 }, signal: new AbortController().signal, ...overrides,
});
const lease = (request, overrides = {}) => ({
  instanceId, jobId, unit, socketDirectory: jobId, cgroupParent: cgroup,
  deadlineAt: request.deadlineAt, running: true, ...overrides,
});

function transport(handler, responseMap = value => value) {
  const requests = [], children = [];
  function spawnProcess(command, args, options) {
    assert.equal(command, '/usr/bin/ssh');
    assert.equal(args.at(-1), 'pw-deploy-builder');
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    let closed = false;
    const finish = (code, signal = null) => {
      if (closed) return;
      closed = true;
      child.exitCode = code;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit('close', code, signal));
    };
    child.kill = signal => { finish(null, signal); return true; };
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('finish', async () => {
      const input = Buffer.concat(chunks), size = Number(input.subarray(0, 10).toString('ascii'));
      assert.equal(input.length, size + 10, 'builder control never carries source or artifact bytes');
      const request = JSON.parse(input.subarray(10));
      requests.push(request);
      let response;
      try { response = { ok: true, result: await handler(request, child) }; }
      catch (error) {
        response = { ok: false, code: error.code || 'process_failed', error: error.message };
        if (error.startupFailure !== undefined) response.startupFailure = error.startupFailure;
      }
      if (closed) return;
      const body = Buffer.from(JSON.stringify(responseMap(response)));
      child.stdout.write(Buffer.concat([Buffer.from(String(body.length).padStart(10, '0')), body]));
      finish(0);
    });
    children.push(child);
    return child;
  }
  return { spawnProcess, requests, children };
}

function handler(request) {
  if (request.action === 'builder_probe') return { instanceId, ready: true };
  if (request.action === 'job_start') return lease(request);
  if (request.action === 'job_stop') return { instanceId, jobId, stopped: true };
  if (request.action === 'job_remove') return { instanceId, jobId, stopped: true, removed: true };
  throw new Error('Unexpected fixture action');
}

test('builder SSH uses its fixed forced command and the existing pinned transport protections', () => {
  const args = builderSshArgv(connection);
  assert.equal(args.at(-1), 'pw-deploy-builder');
  for (const value of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no',
    'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'RequestTTY=no', 'ProxyCommand=none']) {
    assert.ok(args.includes(value), value);
  }
  for (const kind of ['arbitrary-command', '__proto__', 'constructor']) {
    assert.throws(() => connectorSshArgv(kind, connection), error => error.code === 'invalid_configuration');
  }
});

test('lease results bind the exact instance, job, user-manager cgroup, socket directory and deadline', () => {
  const request = { action: 'job_start', jobId, deadlineAt: 35000 };
  const good = lease(request);
  assert.equal(validateBuilderResult(config, request, good).socket, `/run/pw-build/${jobId}/api.sock`);
  for (const change of [
    { instanceId: jobId }, { jobId: instanceId }, { unit: 'foreign.service' },
    { socketDirectory: '../foreign' }, { deadlineAt: 36000 }, { running: false },
    { cgroupParent: '/' }, { cgroupParent: cgroup.replace('user@2000', 'user@2001') },
    { cgroupParent: cgroup.replace('user-2000', 'user-0') },
    { cgroupParent: cgroup.replace('/payload', '/../../foreign') },
    { cgroupParent: cgroup.replace(unit, 'foreign.service') },
    { cgroupParent: `${cgroup}\n` },
  ]) assert.throws(() => validateBuilderResult(config, request, { ...good, ...change }),
    error => error.code === 'builder_protocol_error');
});

test('backend stop and removal require affirmative matching ownership results', () => {
  for (const action of ['job_stop', 'job_remove']) {
    const request = { action, jobId }, value = { instanceId, jobId, stopped: true, removed: true };
    validateBuilderResult(config, request, value);
    for (const change of [{ stopped: false }, { jobId: instanceId }, { unit: 'foreign.service' }]) {
      assert.throws(() => validateBuilderResult(config, request, { ...value, ...change }));
    }
    if (action === 'job_remove') assert.throws(() => validateBuilderResult(config, request, { ...value, removed: false }));
  }
  assert.throws(() => validateBuilderResult(config, { action: 'job_status', jobId },
    { instanceId, jobId, unit, running: true, stopped: true }));
});

test('a supervised job cannot use the shared API before start or after confirmed stop', async () => {
  const fake = transport(handler), builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  const job = control({ builderJob: true });
  assert.equal(builder.socket({}), config.container.builderSocket);
  assert.throws(() => builder.socket(job), error => error.code === 'builder_unavailable');
  await builder.start(job);
  assert.equal(fake.requests[0].deadlineAt, 35000);
  assert.equal(fake.requests[0].memoryMiB, 2048);
  assert.equal(fake.requests[0].pids, 512);
  assert.equal(builder.socket(job), `/run/pw-build/${jobId}/api.sock`);
  assert.deepEqual(builder.cgroupArgs(job), [`--cgroup-parent=${cgroup}`]);
  await builder.stop(jobId);
  assert.throws(() => builder.socket(job), error => error.code === 'builder_unavailable');
});

test('image builds use a dedicated leaf below the owned payload cgroup', async () => {
  const fake = transport(handler), builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  const job = control({ builderJob: true });
  assert.deepEqual(builder.cgroupArgs({}, { build: true }), []);
  assert.throws(() => builder.cgroupArgs(job, { build: true }), error => error.code === 'builder_unavailable');
  await builder.start(job);
  assert.deepEqual(builder.cgroupArgs(job), [`--cgroup-parent=${cgroup}`]);
  assert.deepEqual(builder.cgroupArgs(job, { build: true }), [`--cgroup-parent=${cgroup}/build`]);
  await builder.stop(jobId);
  assert.throws(() => builder.cgroupArgs(job, { build: true }), error => error.code === 'builder_unavailable');
});

test('expired jobs are rejected without opening a connector or reserving a backend', async () => {
  const fake = transport(handler), builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await assert.rejects(builder.start(control({ deadlineAt: 4999 })), error => error.code === 'timeout');
  assert.equal(fake.requests.length, 0);
  assert.equal(builder.has(jobId), false);
});

test('invalid or lost start replies still reconcile the exact backend before failing', async () => {
  const fake = transport(request => request.action === 'job_start' ? lease(request, { unit: 'foreign.service' }) : handler(request));
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await assert.rejects(builder.start(control()), error => error.code === 'builder_protocol_error');
  assert.deepEqual(fake.requests.map(request => request.action), ['job_start', 'job_stop']);
  assert.ok(fake.requests.every(request => request.jobId === jobId));
  assert.throws(() => builder.lease(jobId), error => error.code === 'builder_unavailable');
});

test('a failed stop blocks destructive cleanup and preserves the lease for recovery', async () => {
  const fake = transport(request => {
    if (request.action === 'job_stop') throw Object.assign(new Error('Unconfirmed unit stop'), { code: 'process_failed' });
    return handler(request);
  });
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await builder.start(control());
  await assert.rejects(builder.remove(jobId), error => error.code === 'cancellation_failed' && error.cause.code === 'process_failed');
  assert.equal(builder.has(jobId), true);
  assert.equal(fake.requests.some(request => request.action === 'job_remove'), false);
});

test('concurrent stop observers share one bounded backend reconciliation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = transport(async request => {
    if (request.action === 'job_stop') await gate;
    return handler(request);
  });
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await builder.start(control());
  const first = builder.stop(jobId), second = builder.stop(jobId);
  release();
  await Promise.all([first, second]);
  assert.equal(fake.requests.filter(request => request.action === 'job_stop').length, 1);
});

test('recovery removes only the specified backend without starting or replaying a job', async () => {
  const fake = transport(handler), builder = new SupervisedBuilder(config, fake);
  await builder.remove(jobId);
  assert.deepEqual(fake.requests.map(request => request.action), ['job_stop', 'job_remove']);
  assert.ok(fake.requests.every(request => request.jobId === jobId));
  assert.equal(builder.has(jobId), false);
});

test('builder control cannot carry binary artifacts or obtain an arbitrary command', async () => {
  const stream = Readable.from(['synthetic artifact']);
  let called = false;
  await assert.rejects(builderRequest(connection, { action: 'job_start', jobId }, {
    ociStream: stream, spawnProcess: () => { called = true; },
  }), error => error.code === 'builder_protocol_error');
  assert.equal(called, false);
  assert.equal(stream.destroyed, true);
});

test('an already-aborted start still uses an independent stop request, never a fallback API', async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('Synthetic cancellation'), { code: 'cancelled' }));
  const fake = transport(handler), builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await assert.rejects(builder.start(control({ signal: controller.signal })), error => error.code === 'cancelled');
  assert.deepEqual(fake.requests.map(request => request.action), ['job_stop']);
  assert.throws(() => builder.socket({ jobId, builderJob: true }), error => error.code === 'builder_unavailable');
});

test('startup diagnostics retain relay primary, relay cleanup and bounded client stop failures separately', async () => {
  let stops = 0;
  const relay = builderStartupDiagnostic(jobId, instanceId).relay;
  relay.recordingErrors.push({ stage: 'diagnostic_final', code: 'os_error', rule: 'os_error', errno: 28 });
  const fake = transport(request => {
    if (request.action === 'job_start') {
      throw Object.assign(new Error('PRIVATE_START argv=/private env=PRIVATE_ENV'), {
        code: 'process_failed', startupFailure: relay,
      });
    }
    if (request.action === 'job_stop') {
      stops++;
      throw Object.assign(new Error('PRIVATE_STOP /private/config'), {
        code: stops === 1 ? 'privilege_refused' : 'resource_conflict',
      });
    }
    throw new Error('Unexpected mutation');
  });
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  let first;
  await assert.rejects(builder.start(control()), error => {
    first = error;
    return error.code === 'cancellation_failed';
  });
  const primary = builderStartupFailure(first).primary;
  assert.deepEqual(builderStartupFailure(first).relay, relay);
  for (let index = 0; index < 3; index++) {
    await assert.rejects(builder.stop(jobId), error => error.code === 'cancellation_failed');
  }
  const saved = builderStartupFailure(first);
  assert.deepEqual(saved.primary, primary);
  assert.deepEqual(saved.relay, relay);
  assert.deepEqual(saved.cleanup.map(item => item.failure.code), ['privilege_refused', 'resource_conflict']);
  assert.equal(JSON.stringify(saved).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(saved).includes('/private'), false);
  assert.equal(fake.requests.filter(request => request.action === 'job_start').length, 1);
  assert.ok(fake.requests.every(request => ['job_start', 'job_stop'].includes(request.action)));
  assert.throws(() => builder.lease(jobId), error => error.code === 'builder_unavailable');
});

test('a later confirmed stop updates the diagnostic without replacing the original failed startup', async () => {
  let stops = 0;
  const fake = transport(request => {
    if (request.action === 'job_start') {
      throw Object.assign(new Error('PRIVATE_PRIMARY'), { code: 'resource_not_allowed',
        startupFailure: builderStartupDiagnostic(jobId, instanceId).relay });
    }
    if (request.action === 'job_stop' && ++stops === 1) {
      throw Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'process_failed' });
    }
    return handler(request);
  });
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  let first;
  await assert.rejects(builder.start(control()), error => {
    first = error;
    return error.code === 'cancellation_failed';
  });
  await builder.stop(jobId);
  const diagnostic = builderStartupFailure(first);
  assert.equal(first.code, 'cancellation_failed');
  assert.equal(diagnostic.relay.primary.rule, 'api_peer');
  assert.deepEqual(diagnostic.cleanup.map(item => item.outcome), ['failed', 'stopped']);
  assert.equal(diagnostic.cleanup[1].failure, null);
  assert.throws(() => builder.lease(jobId), error => error.code === 'builder_unavailable');
});

test('malformed, foreign and success-shaped startup diagnostics cannot authorize a lease or leak raw data', async () => {
  const good = builderStartupDiagnostic(jobId, instanceId).relay;
  const invalid = [
    { ...good, rawError: 'PRIVATE_SECRET' },
    { ...good, version: '1' },
    { ...good, jobId: instanceId },
    { ...good, instanceId: jobId },
    { ...good, primary: { ...good.primary, stage: 'PRIVATE_STAGE' } },
    { ...good, primary: { ...good.primary, code: 'PRIVATE_CODE' } },
    { ...good, primary: { ...good.primary, rule: 'PRIVATE_RULE' } },
    { ...good, primary: { ...good.primary, errno: 4096 } },
    { ...good, primary: { ...good.primary, errno: true } },
    { ...good, cleanup: { ...good.cleanup, outcome: 'success' } },
    { ...good, recordingErrors: [good.primary, good.primary, good.primary] },
  ];
  for (const startupFailure of invalid) {
    const fake = transport(request => {
      if (request.action === 'job_start') {
        throw Object.assign(new Error('PRIVATE_RAW_EXCEPTION'), { code: 'process_failed', startupFailure });
      }
      return handler(request);
    });
    const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
    await assert.rejects(builder.start(control()), error => {
      const diagnostic = builderStartupFailure(error);
      assert.equal(diagnostic.relay, null);
      assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_'), false);
      return error.code === 'builder_protocol_error';
    });
    assert.deepEqual(fake.requests.map(request => request.action), ['job_start', 'job_stop']);
  }
  const fake = transport(handler, response => response.result?.running
    ? { ...response, startupFailure: good } : response);
  const builder = new SupervisedBuilder(config, { ...fake, now: () => 5000 });
  await assert.rejects(builder.start(control()), error => error.code === 'builder_protocol_error');
  assert.throws(() => builder.lease(jobId), error => error.code === 'builder_unavailable');
});

test('a connector teardown failure retains the fixed initiating exchange failure without its raw text', async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  child.stdin.on('finish', () => controller.abort(new DeploymentError('PRIVATE_TRANSPORT', 503, 'resource_not_allowed')));
  let failure;
  await assert.rejects(builderRequest(connection, { action: 'job_start', jobId }, {
    signal: controller.signal, spawnProcess: () => child, terminationOptions: { graceMs: 1, reapMs: 1 },
  }), error => {
    failure = error;
    return error.code === 'cancellation_failed';
  });
  child.emit('close', null, 'SIGKILL');
  const exchange = exchangeStartupFailure(failure);
  assert.equal(exchange.primary.code, 'resource_not_allowed');
  assert.equal(exchange.cleanup.code, 'cancellation_failed');
  assert.equal(JSON.stringify(exchange).includes('PRIVATE_TRANSPORT'), false);
  const builder = new SupervisedBuilder(config, { now: () => 5000 });
  builder.request = async action => {
    if (action === 'job_start') throw failure;
    assert.equal(action, 'job_stop');
    return { instanceId, jobId, stopped: true };
  };
  await assert.rejects(builder.start(control()), error => {
    assert.deepEqual(builderStartupFailure(error).exchange, exchange);
    return error.code === 'cancellation_failed';
  });
});
