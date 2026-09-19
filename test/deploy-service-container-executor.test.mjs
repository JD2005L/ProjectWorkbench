// Tests for app/deployment/container-executor.js: the container-mode
// deployment executor that must build, promote and roll back candidate
// images entirely through its dedicated rootless Podman builder socket and
// the fixed runtime-relay SSH connector - never in this process, never on
// the host, and never through a rootful/local fallback. No real Podman, SSH
// or systemd infrastructure is touched anywhere in this file: every child
// process container-executor.js would spawn is replaced with an in-memory
// fake driven by each test's own scenario, built from real Node streams
// (PassThrough) so the executor's actual pipe/backpressure code paths
// (container-process.js's pipeProcesses/pipeBounded) run for real against
// fake endpoints.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ContainerExecutor as ProductionContainerExecutor } from '../app/deployment/container-executor.js';
import { builderUnitName } from '../app/deployment/builder-client.js';
import { snapshotDigest } from '../app/deployment/protocol.js';
import { deploymentRequest, until } from './deploy-service-fixtures.mjs';

const PODMAN = '/usr/bin/podman';
const SSH = '/usr/bin/ssh';
const WORKER_ENTRYPOINT = '/opt/pw-deploy/app/deployment/container-worker.js';
const HEADER_BYTES = 10;
const fixtureDirectory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.container-executor-fixture-'));
after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));

class MemoryCandidateJournal {
  values = new Map();
  async write(directory, value) { this.values.set(directory, structuredClone(value)); }
  async read(directory) { return structuredClone(this.values.get(directory) || null); }
  async remove(directory) { this.values.delete(directory); }
}

class ContainerExecutor extends ProductionContainerExecutor {
  constructor(config, options = {}) {
    super(config, { candidateJournal: new MemoryCandidateJournal(), ...options });
  }
}

// -- fixtures -----------------------------------------------------------------

function containerConfig(overrides = {}) {
  // Destructure `container` out first: spreading the raw `overrides` object
  // at the top level afterwards would otherwise clobber the carefully
  // merged `container` object with the caller's (usually partial) override.
  const { container: containerOverrides, ...rest } = overrides;
  return {
    mode: 'container',
    adapters: ['script', 'iis', 'podman'],
    container: {
      instanceId: '11111111-1111-4111-8111-111111111111',
      builderSocket: '/run/pw-deploy/builder.sock',
      builderJobSockets: '/run/pw-deploy-build',
      workerImage: `sha256:${'a'.repeat(64)}`,
      maxMemoryMiB: 2048,
      maxPids: 512,
      runtime: {
        host: 'runtime.internal', port: 22, user: 'deploysvc',
        keyFile: '/etc/pw-deploy/runtime.key', knownHostsFile: '/etc/pw-deploy/known_hosts',
      },
      builderControl: {
        host: 'builder.internal', port: 22, user: 'deploy-builder',
        keyFile: '/etc/pw-deploy/builder.key', knownHostsFile: '/etc/pw-deploy/known_hosts',
      },
      ...containerOverrides,
    },
    ...rest,
  };
}

function makeControl({
  jobId = crypto.randomUUID(), policy = {}, signal, onOutput, onEvent, jobDirectory,
} = {}) {
  const events = [];
  const output = [];
  return {
    jobId,
    jobDirectory: jobDirectory ?? path.join(fixtureDirectory, jobId),
    policy: { timeoutSeconds: 30, ...policy },
    signal: signal || new AbortController().signal,
    onOutput: onOutput || (text => output.push(text)),
    onEvent: onEvent || (async name => { events.push(name); }),
    // test-only inspection handles, unused by production code
    _events: events,
    _output: output,
  };
}

function podmanRequest(overrides = {}) {
  return deploymentRequest({
    recipe: { adapter: 'podman', image: 'exampleapp', service: 'exampleapp' },
    script: '', ...overrides,
  });
}

// -- fake child process / stream plumbing -------------------------------------

// Builds a bare fake child process object matching exactly the surface
// container-process.js and runtime-client.js rely on: stdin/stdout/stderr as
// real streams (so real .pipe()/backpressure code exercises for real),
// .exitCode (null until close), .kill(signal), and standard 'error'/'close'
// events. Closing is idempotent and always asynchronous (never in the same
// tick as spawn), matching how a real child process behaves and exercising
// the exitCode-race checks production code performs (e.g. transferImage).
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  let closed = false;
  child._close = (code, signal = null) => {
    if (closed) return;
    closed = true;
    setImmediate(() => { child.exitCode = code; child.emit('close', code, signal); });
  };
  child._fail = error => {
    if (closed) return;
    closed = true;
    // Real Node child processes emit 'error' and still follow up with a
    // 'close' (code/signal both null) once spawning fails; runProcess()
    // only resolves by awaiting 'close', so a fake that skips it deadlocks.
    setImmediate(() => {
      child.emit('error', error);
      child.emit('close', null, null);
    });
  };
  child.kill = signal => {
    child._killedWith = signal;
    child._close(null, signal || 'SIGTERM');
    return true;
  };
  return child;
}

function respond(child, { stdout = '', stderr = '', exitCode = 0, onInput } = {}) {
  // Always drain stdin regardless of whether the test cares about its
  // content: a real subprocess's stdin is a pipe with a finite OS buffer,
  // and a fake that never reads it would let a larger write (e.g. a tar
  // archive) deadlock production code that is correctly waiting on backpressure.
  const chunks = [];
  child.stdin.on('data', chunk => chunks.push(chunk));
  child.stdin.on('end', () => onInput?.(Buffer.concat(chunks)));
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child._close(exitCode);
  });
}

function stripRemote(args) {
  // container-executor.js always prepends ['--remote', '--url', 'unix://<socket>'].
  return args[0] === '--remote' ? args.slice(3) : args;
}

function decodeSshFrame(buffer) {
  const header = buffer.subarray(0, HEADER_BYTES).toString('ascii');
  const size = Number(header);
  const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + size);
  return { request: JSON.parse(body.toString('utf8')), extraBytes: buffer.length - HEADER_BYTES - size };
}

function encodeSshFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from(String(body.length).padStart(HEADER_BYTES, '0'), 'ascii'), body]);
}

// Simulates a disposable worker container's PID1 guardian for one `podman
// start --attach --interactive` call: reads the bounded stdin envelope (the
// only channel scripts/credentials ever travel through), then responds
// exactly as configured. `hold: true` lets a test keep the container "running"
// until it explicitly calls the returned `release()`, for realistic
// cancellation-path testing (stop -> confirm -> the attached process closing
// as a result, not independently).
function workerReply({ stdout = '', stderr = '', exitCode = 0, onEnvelope, hold = false } = {}) {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  return {
    run(child) {
      const chunks = [];
      child.stdin.on('data', c => chunks.push(c));
      child.stdin.on('finish', async () => {
        let envelope;
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (error) { child._fail(error); return; }
        onEnvelope?.(envelope, child);
        if (hold) await held;
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        child._close(exitCode);
      });
    },
    release: () => release(),
  };
}

// The full fake spawnProcess: routes every call to either the podman
// builder-socket handler or the SSH runtime-relay handler based on which
// fixed binary path container-executor.js invoked, records every call for
// inspection, and fails closed (never silently succeeds) on anything else.
function fakeSpawn({ podman, ssh, builderControl } = {}) {
  const calls = [];
  function spawnProcess(command, args, options) {
    calls.push({ command, args: [...args], env: options?.env });
    const child = fakeChild();
    if (command === PODMAN) {
      const rest = stripRemote(args);
      // Dispatched synchronously (not deferred): some handlers (the
      // long-lived `start --attach --interactive` worker simulation) must
      // attach their stdin listeners before the caller writes to it in the
      // same tick, exactly like a real spawn() call returns a child whose
      // streams are already wired up.
      try { (podman || defaultPodman)(rest, child); }
      catch (error) { child._fail(error); }
    } else if (command === SSH) {
      const chunks = [];
      child.stdin.on('data', c => chunks.push(c));
      child.stdin.on('finish', async () => {
        const all = Buffer.concat(chunks);
        let decoded;
        try { decoded = decodeSshFrame(all); }
        catch (error) { child._fail(error); return; }
        let value;
        try {
          const handler = args.at(-1) === 'pw-deploy-builder'
            ? builderControl || podman?.builderControl || defaultBuilderControl : ssh || defaultSsh;
          const result = await handler(decoded.request, { extraBytes: decoded.extraBytes, child });
          value = { ok: true, result: result || {} };
        } catch (error) {
          value = { ok: false, code: error.code || 'process_failed', error: error.message || String(error) };
        }
        child.stdout.end(encodeSshFrame(value));
        child._close(0);
      });
    } else {
      child._fail(new Error(`fakeSpawn: unexpected command invoked: ${command} ${args.join(' ')}`));
    }
    return child;
  }
  return { spawnProcess, calls };
}
function defaultPodman(args, child) {
  if (args[0] === 'container' && args[1] === 'exists') { respond(child, { exitCode: 1 }); return; }
  if (args[0] === 'volume' && args[1] === 'exists') { respond(child, { exitCode: 1 }); return; }
  if (args[0] === 'image' && args[1] === 'exists') { respond(child, { exitCode: 1 }); return; }
  respond(child, { exitCode: 0 });
}
function defaultSsh() { return {}; }
function defaultBuilderControl(request) {
  if (request.action === 'builder_probe') return { instanceId: containerConfig().container.instanceId, ready: true };
  throw new Error(`Unexpected builder control action: ${request.action}`);
}

function rootlessInfo() { return JSON.stringify({ host: { security: { rootless: true } } }); }

function labelsFromArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--label') {
      const pair = args[index + 1];
      const eq = pair.indexOf('=');
      labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return labels;
}

function filterValues(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--filter' && args[index + 1]?.startsWith('label=')) {
      const rest = args[index + 1].slice('label='.length);
      const eq = rest.indexOf('=');
      values[rest.slice(0, eq)] = rest.slice(eq + 1);
    }
  }
  return values;
}

function matchesFilters(labels, filters) {
  return Object.entries(filters).every(([key, value]) => labels[key] === value);
}

function shortId(name) {
  return crypto.createHash('sha1').update(name).digest('hex').slice(0, 12);
}

// A realistic, in-memory Podman builder: tracks created containers, volumes
// and images (with their labels/status), so multi-call scenarios - cancel
// then confirm-stopped, cleanup, crash recovery - exercise the same state
// machine a real rootless daemon would rather than a single canned response.
// `workers` maps a phase name ('script'/'version'/'dependencies') or an
// exact container name to a workerReply() controlling what that particular
// disposable worker does once started.
function fakeBuilder({
  workers = {}, stopEffective = () => true, smokeExitCode = 0, buildExitCode = 0, onCall,
} = {}) {
  const containers = new Map();
  const volumes = new Map();
  const images = new Map();
  const activeWorkers = new Map();
  const seedArchives = [];
  const controlCalls = [];
  const stoppedJobs = new Set();

  function workerFor(name, container) {
    return workers[name] || (container?.phase && workers[container.phase]) || workers.default || workerReply({ exitCode: 0 });
  }

  // Real Podman accepts either a resource's full name/tag or its short ID
  // anywhere a reference is expected. recover() specifically works from the
  // short ID column of `podman ps -a`/`podman images` output, while every
  // other call site here uses the exact name/tag - so lookups must resolve
  // either form against the same underlying map.
  function resolveContainerKey(key) {
    if (containers.has(key)) return key;
    for (const name of containers.keys()) { if (shortId(name) === key) return name; }
    return undefined;
  }
  function resolveImageKey(key) {
    if (images.has(key)) return key;
    for (const tag of images.keys()) { if (shortId(tag) === key) return tag; }
    return undefined;
  }

  function podman(args, child) {
    onCall?.(args, child);
    const [a, b, c] = args;
    if (a === 'info') { respond(child, { stdout: rootlessInfo(), exitCode: 0 }); return; }
    if (a === 'volume' && b === 'create') {
      volumes.set(args[args.length - 1], { labels: labelsFromArgs(args) });
      respond(child, { exitCode: 0 }); return;
    }
    if (a === 'volume' && b === 'exists') { respond(child, { exitCode: volumes.has(c) ? 0 : 1 }); return; }
    if (a === 'volume' && b === 'inspect') {
      const volume = volumes.get(args.at(-1));
      respond(child, { stdout: JSON.stringify(volume?.labels || {}), exitCode: volume ? 0 : 125 }); return;
    }
    if (a === 'volume' && b === 'rm') { volumes.delete(c); respond(child, { exitCode: 0 }); return; }
    if (a === 'volume' && b === 'ls') {
      const filters = filterValues(args);
      const names = [...volumes.entries()].filter(([, v]) => matchesFilters(v.labels, filters)).map(([name]) => name);
      respond(child, { stdout: names.map(name => `${name}\n`).join(''), exitCode: 0 }); return;
    }
    if (a === 'create' && b === '--name') {
      const labels = labelsFromArgs(args);
      containers.set(c, { status: 'created', labels, phase: labels['io.pw-deploy.phase'] });
      respond(child, { exitCode: 0 }); return;
    }
    if (a === 'start' && b === '--attach' && c === '--interactive') {
      const name = args[3];
      const container = containers.get(name);
      if (container) container.status = 'running';
      const worker = workerFor(name, container);
      const originalClose = child._close;
      child._close = (code, signal) => {
        // Disconnecting the local client does not prove the daemon stopped the worker.
        if (container && !child._killedWith) container.status = 'exited';
        if (container?.status === 'exited') activeWorkers.delete(name);
        originalClose(code, signal);
      };
      activeWorkers.set(name, { worker, child });
      worker.run(child);
      return;
    }
    if (a === 'stop') {
      const name = resolveContainerKey(args[args.length - 1]);
      const container = containers.get(name);
      if (container && stopEffective(name, container)) {
        container.status = 'exited';
        // A real `podman stop` ends the container's PID1 at the daemon
        // side; any `start --attach` session still attached to it observes
        // that as its own process closing, not as something the attached
        // CLI decides locally. Mirror that here rather than only updating
        // status, so a cancellation test can observe the worker's promise
        // actually settling as a direct result of the stop.
        const active = activeWorkers.get(name);
        if (active) active.child._close(null, 'SIGTERM');
      }
      respond(child, { exitCode: 0 }); return;
    }
    if (a === 'container' && b === 'exists') { respond(child, { exitCode: resolveContainerKey(c) ? 0 : 1 }); return; }
    if (a === 'container' && b === 'inspect') {
      const name = resolveContainerKey(args[args.length - 1]);
      const container = containers.get(name);
      respond(child, { stdout: args.includes('{{json .Config.Labels}}')
        ? JSON.stringify(container?.labels || {}) : container?.status || '', exitCode: container ? 0 : 125 });
      return;
    }
    if (a === 'rm') { containers.delete(resolveContainerKey(args[args.length - 1]) || args[args.length - 1]); respond(child, { exitCode: 0 }); return; }
    if (a === 'ps' && b === '-a') {
      const filters = filterValues(args);
      const lines = [...containers.entries()].filter(([, v]) => matchesFilters(v.labels, filters))
        .map(([name]) => `${shortId(name)} ${name}`);
      respond(child, { stdout: lines.map(line => `${line}\n`).join(''), exitCode: 0 }); return;
    }
    if (a === 'cp') {
      const operands = args.slice(1).filter(value => !value.startsWith('--'));
      const reference = operands.find(value => value !== '-');
      const container = reference?.split(':')[0];
      if (!resolveContainerKey(container)) { respond(child, { exitCode: 125 }); return; }
      if (operands[0] === '-' && reference.split(':')[1] !== '/workspace') {
        respond(child, { stderr: 'destination must be a directory when copying from stdin', exitCode: 125 });
        return;
      }
      respond(child, {
        stdout: operands[1] === '-' ? 'FAKE-BUILD-CONTEXT' : '', exitCode: 0,
        onInput: input => { if (operands[0] === '-') seedArchives.push(input); },
      });
      return;
    }
    if (a === 'build') {
      const tagIndex = args.indexOf('-t');
      if (tagIndex !== -1) images.set(args[tagIndex + 1], { labels: labelsFromArgs(args) });
      respond(child, { stdout: 'Successfully built\n', exitCode: buildExitCode }); return;
    }
    if (a === 'run') { respond(child, { exitCode: smokeExitCode }); return; }
    if (a === 'save') { respond(child, { stdout: 'FAKE-OCI-BYTES', exitCode: 0 }); return; }
    if (a === 'image' && b === 'exists') { respond(child, { exitCode: resolveImageKey(c) ? 0 : 1 }); return; }
    if (a === 'image' && b === 'inspect') {
      const image = images.get(resolveImageKey(args.at(-1)));
      const stdout = args.includes('{{json .Config.Labels}}') ? JSON.stringify(image?.labels || {})
        : image ? `sha256:${'c'.repeat(64)} ${image.labels['org.opencontainers.image.revision']}` : '';
      respond(child, { stdout,
        exitCode: image ? 0 : 125 });
      return;
    }
    if (a === 'image' && b === 'rm') { images.delete(resolveImageKey(args[args.length - 1]) || args[args.length - 1]); respond(child, { exitCode: 0 }); return; }
    if (a === 'images') {
      const filters = filterValues(args);
      const lines = [...images.entries()].filter(([, v]) => matchesFilters(v.labels, filters))
        .map(([tag]) => `${shortId(tag)} ${tag}`);
      respond(child, { stdout: lines.map(line => `${line}\n`).join(''), exitCode: 0 }); return;
    }
    child._fail(new Error(`fakeBuilder: unhandled podman command ${JSON.stringify(args)}`));
  }
  podman.builderControl = request => {
    controlCalls.push(request);
    const instanceId = containerConfig().container.instanceId;
    if (request.action === 'builder_probe') return { instanceId, ready: true };
    const { jobId } = request;
    const unit = builderUnitName(instanceId, jobId);
    const owned = value => value.labels['io.pw-deploy.instance'] === instanceId && value.labels['io.pw-deploy.job'] === jobId;
    if (request.action === 'job_start') {
      if (stoppedJobs.has(jobId)) throw new Error('A cancelled builder cannot be replayed');
      return { instanceId, jobId, unit, socketDirectory: jobId, running: true, deadlineAt: request.deadlineAt,
        cgroupParent: `/user.slice/user-2000.slice/user@2000.service/app.slice/${unit}/payload` };
    }
    if (request.action === 'job_stop') {
      for (const [name, value] of containers) {
        if (!owned(value)) continue;
        if (!stopEffective(name, value)) throw new Error('Synthetic backend did not stop');
        value.status = 'exited';
        activeWorkers.get(name)?.child._close(null, 'SIGKILL');
      }
      stoppedJobs.add(jobId);
      return { instanceId, jobId, stopped: true };
    }
    if (request.action === 'job_remove') {
      assert.ok(stoppedJobs.has(jobId), 'whole backend must stop before its private store is removed');
      for (const resources of [containers, volumes, images]) {
        for (const [name, value] of resources) if (owned(value)) resources.delete(name);
      }
      return { instanceId, jobId, stopped: true, removed: true };
    }
    throw new Error(`Unexpected builder control action: ${request.action}`);
  };
  return {
    podman, containers, volumes, images, activeWorkers, seedArchives, controlCalls,
  };
}

// The runtime-relay's 8 actions with sensible, overridable defaults. Each
// test supplies only the handlers its scenario cares about; unlisted
// actions fall back to a successful, inert response so unrelated bookkeeping
// calls (e.g. image_remove_candidate during cleanup) don't need restating
// in every test.
function fakeRuntime(overrides = {}) {
  const calls = [];
  const handlers = {
    service_preflight: () => ({ loadState: 'loaded' }),
    image_tag: () => ({ ok: true }),
    service_restart: () => ({ ok: true }),
    image_import: () => ({ imageId: `sha256:${'b'.repeat(64)}` }),
    container_status: () => ({ exists: false, running: false, image: null }),
    service_is_active: () => ({ state: 'active' }),
    health_check: () => ({ healthy: true }),
    image_remove_candidate: () => ({ ok: true }),
    ...overrides,
  };
  async function ssh(request, context) {
    calls.push(request);
    const handler = handlers[request.action];
    if (!handler) throw Object.assign(new Error(`fakeRuntime: unhandled action ${request.action}`), { code: 'action_not_allowed' });
    return handler(request, context);
  }
  return { ssh, calls };
}

// =============================================================================
// init(): rootless daemon probing, fails closed, never falls back
// =============================================================================

test('init() accepts a genuinely rootless builder daemon whose pinned worker image is present', async () => {
  const config = containerConfig();
  const { spawnProcess, calls } = fakeSpawn({
    podman: (args, child) => {
      if (args[0] === 'info') { respond(child, { stdout: rootlessInfo(), exitCode: 0 }); return; }
      if (args[0] === 'image' && args[1] === 'inspect') {
        respond(child, { stdout: JSON.stringify({ 'io.pw-deploy.worker': 'true', 'io.pw-deploy.api-version': '1' }) });
        return;
      }
      assert.deepEqual(args, ['image', 'exists', config.container.workerImage]);
      respond(child, { exitCode: 0 });
    },
  });
  const executor = new ContainerExecutor(config, { spawnProcess });
  await executor.init();
  assert.equal(calls.length, 4);
  assert.equal(calls[0].command, PODMAN);
  assert.deepEqual(calls[0].args.slice(0, 3), ['--remote', '--url', 'unix:///run/pw-deploy/builder.sock']);
  assert.deepEqual(stripRemote(calls[0].args), ['info', '--format', 'json']);
  assert.deepEqual(stripRemote(calls[1].args), ['image', 'exists', config.container.workerImage]);
  assert.equal(calls[3].args.at(-1), 'pw-deploy-builder');
});

test('init() refuses a rootful daemon rather than silently using it', async () => {
  const { spawnProcess } = fakeSpawn({
    podman: (args, child) => respond(child, { stdout: JSON.stringify({ host: { security: { rootless: false } } }) }),
  });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.init(), error => {
    assert.equal(error.code, 'rootful_daemon_refused');
    return true;
  });
});

test('init() refuses when rootless status is missing entirely, never assumes it', async () => {
  const { spawnProcess } = fakeSpawn({ podman: (args, child) => respond(child, { stdout: JSON.stringify({}) }) });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.init(), error => {
    assert.equal(error.code, 'rootful_daemon_refused');
    return true;
  });
});

test('init() fails closed (never falls back to local storage) when the builder is unreachable', async () => {
  const { spawnProcess } = fakeSpawn({ podman: (args, child) => child._fail(new Error('ECONNREFUSED')) });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.init(), error => {
    assert.equal(error.code, 'builder_unavailable');
    return true;
  });
});

test('init() refuses to start when the pinned packaged worker image is missing from the builder, never pulling or substituting one', async () => {
  const { spawnProcess, calls } = fakeSpawn({
    podman: (args, child) => {
      if (args[0] === 'info') { respond(child, { stdout: rootlessInfo(), exitCode: 0 }); return; }
      // exitCode 1 == `podman image exists` reports "not found".
      respond(child, { exitCode: 1 });
    },
  });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.init(), error => {
    assert.equal(error.code, 'worker_image_unavailable');
    return true;
  });
  assert.ok(!calls.some(call => stripRemote(call.args)[0] === 'pull'),
    'a missing pinned image must never trigger an implicit pull - the exact image must already be loaded');
});

test('init() fails closed when the builder returns non-JSON output', async () => {
  const { spawnProcess } = fakeSpawn({ podman: (args, child) => respond(child, { stdout: 'not json' }) });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.init(), error => {
    assert.equal(error.code, 'builder_unavailable');
    return true;
  });
});

test('init() refuses an existing image without the packaged-worker contract', async () => {
  const { spawnProcess } = fakeSpawn({
    podman: (args, child) => respond(child, {
      stdout: args[0] === 'info' ? rootlessInfo() : args[1] === 'inspect' ? '{}' : '',
    }),
  });
  await assert.rejects(new ContainerExecutor(containerConfig(), { spawnProcess }).init(),
    error => error.code === 'worker_image_unavailable');
});

// =============================================================================
// createWorkerContainer(): exact security-relevant argv, no secrets anywhere
// =============================================================================

test('createWorkerContainer emits exactly the required security argv', async () => {
  const { spawnProcess, calls } = fakeSpawn({ podman: (args, child) => respond(child, { exitCode: 0 }) });
  const config = containerConfig();
  const executor = new ContainerExecutor(config, { spawnProcess });
  const control = makeControl({ jobId: 'job-1' });
  const name = await executor.createWorkerContainer(control, 'script', 'pw-deploy-job-job-1-workspace');
  assert.equal(name, 'pw-deploy-job-job-1-script');
  const call = calls.find(entry => stripRemote(entry.args)[0] === 'create');
  assert.deepEqual(stripRemote(call.args), [
    'create', '--name', 'pw-deploy-job-job-1-script',
    '--label', `io.pw-deploy.instance=${config.container.instanceId}`,
    '--label', 'io.pw-deploy.job=job-1',
    '--label', 'io.pw-deploy.phase=script',
    '--interactive', '--read-only', '--user=0:0',
    '--cap-drop=all', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=KILL', '--cap-add=SETPCAP',
    '--security-opt=no-new-privileges',
    '--pull=never',
    '--memory=2048m', '--memory-swap=2048m',
    '--pids-limit=512',
    '--timeout=33',
    '--log-driver=none',
    '--no-healthcheck',
    '--tmpfs=/tmp',
    '--volume', 'pw-deploy-job-job-1-workspace:/workspace',
    '--entrypoint=/usr/bin/node',
    config.container.workerImage, WORKER_ENTRYPOINT,
  ]);
  // The env passed to the builder CLI call itself must be the fixed minimal
  // PATH only - never request/job data - and the create call carries no
  // request data in argv either (asserted above via deepEqual).
  assert.deepEqual(call.env, { PATH: '/usr/local/bin:/usr/bin:/bin' });
});

test('createWorkerContainer honours configured memory/pids limits from parent config', async () => {
  const { spawnProcess, calls } = fakeSpawn({ podman: (args, child) => respond(child, { exitCode: 0 }) });
  const config = containerConfig({ container: { maxMemoryMiB: 4096, maxPids: 256 } });
  const executor = new ContainerExecutor(config, { spawnProcess });
  await executor.createWorkerContainer(makeControl({ jobId: 'job-2' }), 'version', 'vol');
  const args = stripRemote(calls[0].args);
  assert.ok(args.includes('--memory=4096m'));
  assert.ok(args.includes('--memory-swap=4096m'));
  assert.ok(args.includes('--pids-limit=256'));
});

// =============================================================================
// Whole-deploy properties: only PODMAN/SSH ever run, secrets/scripts never
// reach argv, env, labels or any disk/journal log configuration - only the
// bounded worker stdin envelope carries them.
// =============================================================================

test('a full script() deploy never executes anything except the packaged podman/ssh clients', async () => {
  const builder = fakeBuilder({
    workers: {
      script: workerReply({ stdout: 'deployed ok\n', exitCode: 0 }),
    },
  });
  const runtime = fakeRuntime();
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const request = deploymentRequest({
    recipe: { adapter: 'script' },
    script: 'echo TOP-SECRET-SCRIPT-BODY && npm run build',
    secrets: { DEPLOY_TOKEN: 'super-secret-value' },
  });
  const control = makeControl({ jobId: 'job-secrets' });
  const result = await executor.deploy(request, control);
  assert.deepEqual(result, { version: null });

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(call.command === PODMAN || call.command === SSH,
      `unexpected command executed directly: ${call.command}`);
  }
});

test('secrets and script bodies never appear in any podman argv or controller env, only the worker stdin envelope', async () => {
  let capturedEnvelope;
  const builder = fakeBuilder({
    workers: {
      script: workerReply({
        exitCode: 0,
        onEnvelope: envelope => { capturedEnvelope = envelope; },
      }),
    },
  });
  const runtime = fakeRuntime();
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const SECRET = 'super-secret-value-xyz';
  const SCRIPT_MARKER = 'TOP-SECRET-SCRIPT-MARKER';
  const request = deploymentRequest({
    recipe: { adapter: 'script' },
    script: `echo ${SCRIPT_MARKER}`,
    secrets: { DEPLOY_TOKEN: SECRET },
  });
  await executor.deploy(request, makeControl({ jobId: 'job-secrets-2' }));

  for (const call of calls) {
    const flat = JSON.stringify(call.args);
    assert.ok(!flat.includes(SECRET), `secret leaked into argv: ${flat}`);
    assert.ok(!flat.includes(SCRIPT_MARKER), `script body leaked into argv: ${flat}`);
    if (call.command === PODMAN) {
      assert.deepEqual(call.env, { PATH: '/usr/local/bin:/usr/bin:/bin' },
        'podman builder calls must only ever see the fixed minimal env, never request secrets');
    }
  }
  // The secret and script body must have reached the worker - just only
  // through its bounded stdin envelope, never anywhere else.
  assert.ok(capturedEnvelope, 'worker envelope was never captured');
  assert.equal(capturedEnvelope.env.DEPLOY_TOKEN, SECRET);
  assert.ok(capturedEnvelope.input.includes(SCRIPT_MARKER));
});

test('no host bind-mount paths are ever used - only the named per-job workspace volume', async () => {
  const builder = fakeBuilder({ workers: { script: workerReply({ exitCode: 0 }) } });
  const runtime = fakeRuntime();
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await executor.deploy(deploymentRequest({ recipe: { adapter: 'script' } }), makeControl({ jobId: 'job-vol' }));

  const volumeArgs = calls.filter(call => call.command === PODMAN).map(call => stripRemote(call.args))
    .filter(args => args.includes('--volume'));
  assert.ok(volumeArgs.length > 0, 'expected at least one worker container to mount the workspace volume');
  for (const args of volumeArgs) {
    const value = args[args.indexOf('--volume') + 1];
    assert.match(value, /^pw-deploy-job-job-vol-workspace:\/workspace$/, `unexpected volume mount: ${value}`);
    assert.ok(!value.startsWith('/'), 'volume source must never be a host path');
  }
  // Source enters the workspace via a piped tar archive (`cp -`), never a
  // host bind path.
  const cpArgs = calls.map(call => stripRemote(call.args)).find(args => args[0] === 'cp'
    && args[1] === '--archive=false' && args[2] === '-');
  assert.ok(cpArgs, 'expected source to be copied in via `podman cp -`');
  assert.equal(cpArgs.at(-1), 'pw-deploy-job-job-vol-script:/workspace');
  assert.equal(builder.seedArchives.length, 1);
  const header = builder.seedArchives[0].subarray(0, 512);
  assert.equal(header.toString('utf8', 0, 100).replace(/\0.*$/, ''), 'source');
  assert.equal(header.toString('ascii', 156, 157), '5');
  assert.equal(Number.parseInt(header.toString('ascii', 108, 115), 8), 1001);
});

// =============================================================================
// Separate-step environment: script and version commands run as separate
// Bash processes in separate disposable containers, sharing the same
// per-job files/environment contract but never any inherited shell state.
// =============================================================================

test('script() runs the deployment script and version command in two separate containers with no shared shell state, preserving the required env contract', async () => {
  const envelopes = {};
  const builder = fakeBuilder({
    workers: {
      script: workerReply({ exitCode: 0, onEnvelope: envelope => { envelopes.script = envelope; } }),
      version: workerReply({ stdout: 'v1.2.3', exitCode: 0, onEnvelope: envelope => { envelopes.version = envelope; } }),
    },
  });
  const runtime = fakeRuntime();
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const request = deploymentRequest({
    recipe: { adapter: 'script' },
    script: 'deploy-step-body',
    versionCommand: 'version-step-body',
    environment: { DEPLOY_OPTION: 'fast' },
    secrets: { DEPLOY_TOKEN: 'tok-123' },
    project: 'ExampleApp',
    target: 'prod',
  });
  const result = await executor.deploy(request, makeControl({ jobId: 'job-steps' }));
  assert.equal(result.version, 'v1.2.3');

  // Two distinct disposable containers, not one process invoking the other.
  const createCalls = calls.filter(call => stripRemote(call.args)[0] === 'create');
  const createdNames = createCalls.map(call => stripRemote(call.args)[2]);
  assert.deepEqual(createdNames, ['pw-deploy-job-job-steps-script', 'pw-deploy-job-job-steps-version']);
  assert.equal(builder.containers.has('pw-deploy-job-job-steps-script'), false,
    'the script-phase container must be removed once its phase completes');
  assert.equal(builder.containers.has('pw-deploy-job-job-steps-version'), false,
    'the version-phase container must be removed once its phase completes');

  for (const [phase, envelope] of Object.entries(envelopes)) {
    assert.deepEqual(envelope.argv, ['/usr/bin/bash', '--noprofile', '--norc', '-s'],
      `${phase} must run as its own no-profile/no-rc bash process, never inheriting shell state`);
    assert.equal(envelope.env.PW_SOURCE_REVISION, request.revision);
    assert.equal(envelope.env.PW_WORKSPACE_DIR, '/workspace/source');
    assert.equal(envelope.env.PW_PROJECT_DIR, '/workspace/source');
    assert.equal(envelope.env.DEPLOY_PROJECT, 'ExampleApp');
    assert.equal(envelope.env.DEPLOY_TARGET, 'prod');
    assert.equal(envelope.env.DOTNET_CLI_HOME, '/workspace/home');
    assert.match(envelope.env.NODE_OPTIONS, /--dns-result-order=ipv4first/);
    assert.equal(envelope.env.DEPLOY_OPTION, 'fast');
    assert.equal(envelope.env.DEPLOY_TOKEN, 'tok-123');
  }
  assert.equal(envelopes.script.input, 'deploy-step-body\n');
  assert.equal(envelopes.version.input, 'version-step-body\n');
});

// =============================================================================
// Hard deadline / cancellation / tree stop
// =============================================================================

test('cancelling mid-deploy stops and confirms the actual worker container, not merely a local kill', async () => {
  const held = workerReply({ hold: true, exitCode: 0 });
  const builder = fakeBuilder({ workers: { script: held } });
  const runtime = fakeRuntime();
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const controller = new AbortController();
  const control = makeControl({ jobId: 'job-cancel', signal: controller.signal });
  const request = deploymentRequest({ recipe: { adapter: 'script' } });
  const name = 'pw-deploy-job-job-cancel-script';

  const deployPromise = executor.deploy(request, control);
  await until(() => builder.containers.get(name)?.status === 'running');
  controller.abort();

  await assert.rejects(() => deployPromise);
  // The post-cancellation finally-block cleanup stops, confirms, and then
  // removes the container entirely (mirroring recover()'s own teardown) -
  // so the end state is that it no longer exists at all, never merely
  // abandoned locally while still actually running on the builder.
  assert.equal(builder.containers.has(name), false,
    'the actual container must be stopped, confirmed, and removed - not just locally abandoned while still running');
  const stopCalls = calls.filter(call => call.command === PODMAN && stripRemote(call.args)[0] === 'stop');
  assert.ok(stopCalls.length > 0, 'expected an explicit stop against the running container');
  const confirmCalls = calls.filter(call => call.command === PODMAN
    && stripRemote(call.args)[0] === 'container' && stripRemote(call.args)[1] === 'inspect');
  assert.ok(confirmCalls.length > 0,
    'expected the stop to be verified via container inspect, not just assumed after issuing it');
});

test('cancellation surfaces cancellation_failed and defers cleanup when the container cannot be confirmed stopped', async () => {
  const held = workerReply({ hold: true, exitCode: 0 });
  // stopEffective always returns false: the daemon accepts the stop call
  // but the container never actually transitions out of "running", so the
  // confirmStopped() polling loop in container-process.js must eventually
  // give up rather than silently declaring victory.
  const builder = fakeBuilder({ workers: { script: held }, stopEffective: () => false });
  const runtime = fakeRuntime();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const controller = new AbortController();
  const events = [];
  const control = makeControl({
    jobId: 'job-cancel-stuck', signal: controller.signal, onEvent: async name => { events.push(name); },
  });
  const name = 'pw-deploy-job-job-cancel-stuck-script';

  const deployPromise = executor.deploy(deploymentRequest({ recipe: { adapter: 'script' } }), control);
  await until(() => builder.containers.get(name)?.status === 'running');
  controller.abort();

  await assert.rejects(() => deployPromise, error => {
    assert.equal(error.code, 'cancellation_failed');
    return true;
  });
  assert.ok(events.includes('cleanup_deferred'), 'an unconfirmed stop must defer cleanup, never pretend it happened');
}, { timeout: 20000 });

// =============================================================================
// Owned-only recovery
// =============================================================================

const RECOVER_JOB_ID = '22222222-2222-4222-8222-222222222222';

test('recover() validates the job id shape before making any podman call', async () => {
  const { spawnProcess, calls } = fakeSpawn({ podman: () => { throw new Error('must not be called'); } });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(() => executor.recover({ id: '../not-a-uuid' }, '/tmp/whatever'), error => {
    assert.equal(error.code, 'invalid_state');
    return true;
  });
  assert.equal(calls.length, 0, 'no podman call should ever be made for a malformed recovery identity');
});

test('recover() removes only the exact instance/job-labelled resources it finds', async () => {
  const builder = fakeBuilder();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman });
  const config = containerConfig();
  const executor = new ContainerExecutor(config, { spawnProcess });
  // Seed the builder with resources exactly as createVolume/createWorkerContainer
  // and a completed build would have left them for this job...
  const jobLabels = { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': RECOVER_JOB_ID };
  builder.containers.set(`pw-deploy-job-${RECOVER_JOB_ID}-script`, { status: 'exited', labels: { ...jobLabels, 'io.pw-deploy.phase': 'script' } });
  builder.volumes.set(`pw-deploy-job-${RECOVER_JOB_ID}-workspace`, { labels: jobLabels });
  builder.images.set(`localhost/exampleapp:candidate-${RECOVER_JOB_ID}`, { labels: jobLabels });
  // ...alongside another instance/job's resources, which must be left alone.
  const otherLabels = { 'io.pw-deploy.instance': 'other-instance', 'io.pw-deploy.job': 'other-job' };
  builder.containers.set('pw-deploy-job-other-job-script', { status: 'exited', labels: otherLabels });
  builder.volumes.set('pw-deploy-job-other-job-workspace', { labels: otherLabels });

  await executor.recover({ id: RECOVER_JOB_ID }, undefined);

  assert.equal(builder.containers.has(`pw-deploy-job-${RECOVER_JOB_ID}-script`), false, 'owned container must be removed');
  assert.equal(builder.volumes.has(`pw-deploy-job-${RECOVER_JOB_ID}-workspace`), false, 'owned volume must be removed');
  assert.equal(builder.images.has(`localhost/exampleapp:candidate-${RECOVER_JOB_ID}`), false, 'owned candidate image must be removed');
  assert.equal(builder.containers.has('pw-deploy-job-other-job-script'), true, 'unrelated container must be left alone');
  assert.equal(builder.volumes.has('pw-deploy-job-other-job-workspace'), true, 'unrelated volume must be left alone');
});

test('recover() refuses and never broadly prunes when a label-matched resource has an unexpected name', async () => {
  const builder = fakeBuilder();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman });
  const config = containerConfig();
  const executor = new ContainerExecutor(config, { spawnProcess });
  const jobLabels = { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': RECOVER_JOB_ID };
  // Same instance+job labels as a legitimate resource, but a name that does
  // not match this job's fixed naming scheme - e.g. a labelling mistake or
  // a maliciously crafted resource. Recovery must refuse rather than guess.
  builder.containers.set('totally-unexpected-name', { status: 'exited', labels: { ...jobLabels, 'io.pw-deploy.phase': 'script' } });

  await assert.rejects(() => executor.recover({ id: RECOVER_JOB_ID }, undefined), error => {
    assert.equal(error.code, 'cancellation_failed');
    return true;
  });
  assert.equal(builder.containers.has('totally-unexpected-name'), true, 'an unexpected resource must never be silently removed');
});

// =============================================================================
// podman() adapter: exact image identity, rollback snapshot, and
// unit-aware activation/confirmation lifecycle.
// =============================================================================

// A stateful runtime-relay simulation purpose-built for the podman
// adapter's full promote/confirm/rollback lifecycle: tracks which image the
// target unit is "actually" running and reacts to image_tag/service_restart
// the way the real runtime-relay + systemd unit would, rather than
// returning one canned response regardless of call order. `serviceIsActive`
// can be overridden per-call-count to simulate a unit that fails to (re)join
// "active" after a particular restart, without needing real retry sleeps.
function fakeRuntimeLifecycle({ initialImage = null, serviceIsActive, healthy = true } = {}) {
  const calls = [];
  let runningImage = initialImage;
  let pendingLatest;
  let activeCallCount = 0;
  async function ssh(request) {
    calls.push(request);
    switch (request.action) {
      case 'service_preflight': return { loadState: 'loaded' };
      case 'container_status':
        return { exists: runningImage !== null, running: runningImage !== null, image: runningImage };
      case 'image_tag':
        if (request.tagSuffix === 'latest') pendingLatest = request.sourceImage;
        return { ok: true };
      case 'service_restart':
        runningImage = pendingLatest ?? runningImage;
        return { ok: true };
      case 'service_is_active':
        activeCallCount += 1;
        return serviceIsActive ? serviceIsActive(activeCallCount) : { state: 'active' };
      case 'health_check': return { healthy };
      case 'image_import': return { imageId: `sha256:${'c'.repeat(64)}` };
      case 'image_remove_candidate': return { ok: true };
      default: throw Object.assign(new Error(`fakeRuntimeLifecycle: unhandled action ${request.action}`), { code: 'action_not_allowed' });
    }
  }
  return { ssh, calls, get runningImage() { return runningImage; } };
}

test('podman() builds, transfers and promotes a candidate image when there is no previous image to snapshot', async () => {
  const builder = fakeBuilder();
  const runtime = fakeRuntimeLifecycle({ initialImage: null });
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const config = containerConfig();
  const executor = new ContainerExecutor(config, { spawnProcess });
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });
  const request = podmanRequest({
    recipe: { adapter: 'podman', image: 'exampleapp', service: 'exampleapp', healthUrl: 'http://127.0.0.1:4321/health' },
  });

  const result = await executor.deploy(request, control);

  assert.equal(result.version, request.revision.slice(0, 12));
  assert.equal(runtime.runningImage, `sha256:${'c'.repeat(64)}`, 'the runtime must end up running the freshly imported image');

  const buildCall = calls.find(call => stripRemote(call.args)[0] === 'build');
  const buildArgs = stripRemote(buildCall.args);
  const labels = labelsFromArgs(buildArgs);
  assert.equal(labels['io.pw-deploy.instance'], config.container.instanceId);
  assert.equal(labels['io.pw-deploy.job'], control.jobId);
  assert.equal(labels['org.opencontainers.image.revision'], request.revision);

  const smokeCall = calls.find(call => stripRemote(call.args)[0] === 'run');
  const smoke = stripRemote(smokeCall.args);
  for (const value of ['--rm', '--pull=never', '--network=none', '--read-only', '--user=1001:1001',
    '--cap-drop=all', '--security-opt=no-new-privileges', '--log-driver=none', '--no-healthcheck',
    '--memory=2048m', '--pids-limit=512', '--entrypoint=/bin/true']) assert.ok(smoke.includes(value), value);
  assert.equal(smoke[smoke.indexOf('--name') + 1], `pw-deploy-job-${control.jobId}-smoke`);
  assert.equal(labelsFromArgs(smoke)['io.pw-deploy.job'], control.jobId);
  assert.match(smoke.find(value => value.startsWith('--timeout=')), /^--timeout=[1-9][0-9]*$/);
  assert.equal(smoke.at(-1), executor.candidateTag('exampleapp', control.jobId));
  for (const call of calls.filter(call => call.command === PODMAN)) {
    assert.equal(call.args[2], `unix:///run/pw-deploy-build/${control.jobId}/api.sock`,
      'Podman jobs must never use the shared worker/cache API');
    if (['build', 'run', 'create'].includes(stripRemote(call.args)[0])) {
      const leaf = stripRemote(call.args)[0] === 'build' ? '/build' : '';
      assert.deepEqual(call.args.filter(arg => arg.startsWith('--cgroup-parent=')),
        [`--cgroup-parent=/user.slice/user-2000.slice/user@2000.service/app.slice/`
          + `${builderUnitName(config.container.instanceId, control.jobId)}/payload${leaf}`]);
    }
  }
  assert.deepEqual(builder.controlCalls.map(call => call.action), ['job_start', 'job_stop', 'job_remove']);
  const transfer = runtime.calls.find(call => call.action === 'image_import');
  assert.equal(transfer.expectedImageId, `sha256:${'c'.repeat(64)}`);
  assert.equal(transfer.revision, request.revision);
  const health = runtime.calls.find(call => call.action === 'health_check');
  assert.equal(health.project, request.project);
  assert.equal(health.target, request.target);
  assert.equal(health.service, control.policy.service);
  assert.equal(health.expectedImageId, `sha256:${'c'.repeat(64)}`);

  assert.equal(runtime.calls.some(call => call.action === 'image_tag' && call.tagSuffix === 'rollback'), false,
    'no rollback snapshot should be taken when there was no previous image');
  assert.equal(control._events.includes('rollback_saved'), false);
});

test('podman() snapshots the previously running image as a rollback tag before promoting the new one', async () => {
  const previousImage = `sha256:${'d'.repeat(64)}`;
  const builder = fakeBuilder();
  const runtime = fakeRuntimeLifecycle({ initialImage: previousImage });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });

  const result = await executor.deploy(podmanRequest(), control);
  assert.ok(result.version);

  const rollbackTag = runtime.calls.find(call => call.action === 'image_tag' && call.tagSuffix === 'rollback');
  assert.ok(rollbackTag, 'expected the previous running image to be snapshotted as a rollback tag before promotion');
  assert.equal(rollbackTag.sourceImage, previousImage);
  const latestTag = runtime.calls.find(call => call.action === 'image_tag' && call.tagSuffix === 'latest');
  assert.equal(latestTag.sourceImage, runtime.runningImage);
  assert.ok(control._events.includes('rollback_saved'));
  assert.ok(runtime.calls.indexOf(rollbackTag) < runtime.calls.indexOf(latestTag),
    'the rollback snapshot must be taken before the new image is promoted, never after');
});

test('podman() installs dependencies in a separate disposable worker before building when a lockfile is present', async () => {
  const depsEnvelopes = [];
  const builder = fakeBuilder({
    workers: { dependencies: workerReply({ exitCode: 0, onEnvelope: envelope => depsEnvelopes.push(envelope) }) },
  });
  const runtime = fakeRuntimeLifecycle({ initialImage: null });
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });
  const files = [
    { path: 'package.json', data: Buffer.from('{}').toString('base64'), executable: false },
    { path: 'package-lock.json', data: Buffer.from('{}').toString('base64'), executable: false },
  ];
  const request = podmanRequest({ source: { files, sha256: snapshotDigest(files) } });

  await executor.deploy(request, control);

  assert.equal(depsEnvelopes.length, 1);
  assert.deepEqual(depsEnvelopes[0].argv, ['/usr/bin/npm', 'ci', '--omit=dev', '--no-audit', '--no-fund']);
  const dependencyName = `pw-deploy-job-${control.jobId}-dependencies`;
  assert.equal(builder.containers.has(dependencyName), false,
    'the dependencies worker must be removed with its stopped private backend');

  const cpArgs = calls.map(call => stripRemote(call.args)).find(args => args[0] === 'cp'
    && args[1] === `${dependencyName}:/workspace/source/.` && args[2] === '-');
  assert.ok(cpArgs, 'expected the build context to stream directly from the dependency container via `podman cp`, never local disk');
  const payload = `/user.slice/user-2000.slice/user@2000.service/app.slice/`
    + `${builderUnitName(executor.config.container.instanceId, control.jobId)}/payload`;
  const buildArgs = calls.map(call => stripRemote(call.args)).find(args => args[0] === 'build');
  assert.deepEqual(buildArgs.filter(arg => arg.startsWith('--cgroup-parent=')), [`--cgroup-parent=${payload}/build`],
    'Buildah RUN must not join the payload parent after the dependency container enabled its subtree controllers');
  for (const call of calls.filter(call => call.command === PODMAN && ['create', 'run'].includes(stripRemote(call.args)[0]))) {
    assert.deepEqual(call.args.filter(arg => arg.startsWith('--cgroup-parent=')), [`--cgroup-parent=${payload}`]);
  }
  assert.deepEqual(builder.controlCalls.map(call => call.action), ['job_start', 'job_stop', 'job_remove']);
  assert.equal(calls.some(call => call.command === PODMAN && stripRemote(call.args)[0] === 'rm'), false,
    'private Buildah/container storage is removed only after whole-backend stop');
});

for (const dependencies of [false, true]) {
  test(`Podman cancellation stops the private backend, not only ${dependencies ? 'the copy/build pipeline' : 'the build client'}`, async () => {
    const builder = fakeBuilder(), runtime = fakeRuntimeLifecycle();
    const controller = new AbortController();
    const control = makeControl({ signal: controller.signal, policy: { image: 'exampleapp', service: 'exampleapp' } });
    let backendRunning = false, buildChild;
    const { spawnProcess } = fakeSpawn({
      podman: (args, child) => {
        if (args[0] !== 'build') return builder.podman(args, child);
        backendRunning = true;
        buildChild = child;
        child.stdin.resume();
      },
      builderControl: request => {
        const result = builder.podman.builderControl(request);
        if (request.action === 'job_stop') {
          backendRunning = false;
          buildChild?._close(125);
        }
        return result;
      },
      ssh: runtime.ssh,
    });
    const files = dependencies ? [
      { path: 'package.json', executable: false, data: Buffer.from('{}').toString('base64') },
      { path: 'package-lock.json', executable: false, data: Buffer.from('{}').toString('base64') },
    ] : undefined;
    const request = podmanRequest(files ? { source: { files, sha256: snapshotDigest(files) } } : {});
    const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
    const deploying = executor.deploy(request, control);
    const failed = assert.rejects(deploying, error => error.code === 'cancelled');
    await until(() => backendRunning);
    controller.abort(Object.assign(new Error('Synthetic build cancellation'), { code: 'cancelled' }));
    await failed;
    assert.equal(backendRunning, false);
    assert.deepEqual(builder.controlCalls.map(call => call.action), ['job_start', 'job_stop', 'job_remove']);
    assert.equal(runtime.calls.some(call => ['image_import', 'image_tag', 'service_restart'].includes(call.action)), false);
  });
}

test('uncertain private backend termination defers all store cleanup and runtime activation', async () => {
  const builder = fakeBuilder(), runtime = fakeRuntimeLifecycle(), controller = new AbortController();
  const control = makeControl({ signal: controller.signal, policy: { image: 'exampleapp', service: 'exampleapp' } });
  let started = false, removed = false;
  const { spawnProcess } = fakeSpawn({
    podman: (args, child) => {
      if (args[0] !== 'build') return builder.podman(args, child);
      started = true;
      child.stdin.resume();
    },
    builderControl: request => {
      if (request.action === 'job_stop') throw Object.assign(new Error('Synthetic unconfirmed stop'), { code: 'process_failed' });
      if (request.action === 'job_remove') removed = true;
      return builder.podman.builderControl(request);
    },
    ssh: runtime.ssh,
  });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const deploying = executor.deploy(podmanRequest(), control);
  const failed = assert.rejects(deploying, error => error.code === 'cancellation_failed');
  await until(() => started);
  controller.abort(Object.assign(new Error('Synthetic build cancellation'), { code: 'cancelled' }));
  await failed;
  assert.equal(removed, false);
  assert.equal(executor.builds.has(control.jobId), true);
  assert.ok(control._events.includes('cleanup_deferred'));
  assert.equal(runtime.calls.some(call => ['image_import', 'image_tag', 'service_restart'].includes(call.action)), false);
});

test('podman() restores the previous image when activation fails to become healthy, then rethrows the original error', async () => {
  const previousImage = `sha256:${'d'.repeat(64)}`;
  const builder = fakeBuilder();
  const runtime = fakeRuntimeLifecycle({
    initialImage: previousImage,
    // Fails only the FIRST service_is_active call (the primary promotion's
    // confirmation); the rollback's own recovery confirmation must succeed.
    serviceIsActive: count => {
      if (count === 1) throw Object.assign(new Error('unit failed to restart'), { code: 'process_failed' });
      return { state: 'active' };
    },
  });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });

  await assert.rejects(() => executor.deploy(podmanRequest(), control), error => {
    assert.equal(error.code, 'process_failed');
    return true;
  });

  assert.equal(runtime.runningImage, previousImage,
    'the runtime must be left running the previous image after a failed promotion is rolled back');
  assert.ok(control._events.includes('restoring_previous_image'));
  assert.ok(control._events.includes('rollback_restored'));
  assert.ok(!control._events.includes('rollback_failed'));
});

test('podman() surfaces cancellation_failed when even the rollback cannot be confirmed, never pretending success', async () => {
  const previousImage = `sha256:${'d'.repeat(64)}`;
  const builder = fakeBuilder();
  const runtime = fakeRuntimeLifecycle({
    initialImage: previousImage,
    // Every confirmation attempt fails - both the primary promotion and the
    // rollback's own recovery attempt.
    serviceIsActive: () => { throw Object.assign(new Error('unit permanently broken'), { code: 'process_failed' }); },
  });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });

  await assert.rejects(() => executor.deploy(podmanRequest(), control), error => {
    assert.equal(error.code, 'cancellation_failed');
    return true;
  });
  assert.ok(control._events.includes('rollback_failed'),
    'a rollback that cannot be confirmed must be reported explicitly, never silently treated as success');
  assert.deepEqual(builder.controlCalls.map(call => call.action), ['job_start', 'job_stop'],
    'deferred destructive cleanup must not leave the completed backend running');
  assert.ok(control._events.includes('cleanup_deferred'));
});

test('a completed image cannot be promoted when whole-backend stop is unconfirmed', async () => {
  const builder = fakeBuilder(), runtime = fakeRuntimeLifecycle(), journal = new MemoryCandidateJournal();
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });
  let stopped = false;
  const { spawnProcess } = fakeSpawn({
    podman: builder.podman, ssh: runtime.ssh,
    builderControl: request => {
      if (request.action === 'job_stop') {
        stopped = true;
        throw Object.assign(new Error('Synthetic post-transfer stop refusal'), { code: 'process_failed' });
      }
      return builder.podman.builderControl(request);
    },
  });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess, candidateJournal: journal });
  await assert.rejects(executor.deploy(podmanRequest(), control), error => error.code === 'cancellation_failed');
  assert.equal(stopped, true);
  assert.deepEqual(runtime.calls.map(call => call.action), ['service_preflight', 'image_import']);
  assert.equal(builder.controlCalls.some(call => call.action === 'job_remove'), false);
  assert.equal(journal.values.size, 1, 'the imported but unpromoted candidate must remain recoverable');
  assert.ok(control._events.includes('cleanup_deferred'));
});

test("transferImage() refuses a runtime relay response with a malformed image identity", async () => {
  const builder = fakeBuilder();
  const runtime = fakeRuntime({ image_import: () => ({ imageId: 'not-a-valid-sha' }) });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ jobId: 'job-badimage' });
  await assert.rejects(
    () => executor.transferImage(control, 'localhost/exampleapp:candidate-job-badimage', podmanRequest(), 'exampleapp',
      `sha256:${'c'.repeat(64)}`),
    error => { assert.equal(error.code, 'invalid_image'); return true; },
  );
});

test('transferImage() rejects a well-formed but different imported image identity', async () => {
  const builder = fakeBuilder(), runtime = fakeRuntime();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(executor.transferImage(makeControl(), 'localhost/exampleapp:candidate-fixture',
    podmanRequest(), 'exampleapp', `sha256:${'c'.repeat(64)}`), error => error.code === 'invalid_image');
  assert.equal(runtime.calls.some(call => call.action === 'image_tag'), false);
});

test('candidate identity must contain the exact requested source revision before transfer', async () => {
  const { spawnProcess } = fakeSpawn({ podman: (_args, child) => respond(child, {
    stdout: `sha256:${'c'.repeat(64)} ${'b'.repeat(40)}`,
  }) });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  await assert.rejects(executor.candidateIdentity(makeControl(), 'localhost/exampleapp:candidate-fixture', 'a'.repeat(40)),
    error => error.code === 'invalid_image');
});

test('paused containers do not count as confirmed stopped', async () => {
  const config = containerConfig(), control = makeControl();
  const builder = fakeBuilder({ stopEffective: (_name, container) => { container.status = 'paused'; return false; } });
  const name = `pw-deploy-job-${control.jobId}-script`;
  builder.containers.set(name, { status: 'running',
    labels: { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': control.jobId } });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman });
  await assert.rejects(new ContainerExecutor(config, { spawnProcess }).stopContainer(control, name),
    error => error.code === 'cancellation_failed');
  assert.equal(builder.containers.get(name).status, 'paused');
});

test('a matching container name never authorizes stopping another job resource', async () => {
  const config = containerConfig(), control = makeControl(), builder = fakeBuilder();
  const name = `pw-deploy-job-${control.jobId}-script`;
  builder.containers.set(name, { status: 'running',
    labels: { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': 'foreign-job' } });
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman });
  await assert.rejects(new ContainerExecutor(config, { spawnProcess }).removeContainer(control, name),
    error => error.code === 'cancellation_failed');
  assert.equal(builder.containers.get(name).status, 'running');
  assert.equal(calls.some(call => ['stop', 'rm'].includes(stripRemote(call.args)[0])), false);
});

test('controller interruption records deferred cleanup for owned-only restart recovery', async () => {
  const controller = new AbortController();
  const worker = workerReply({ hold: true });
  const builder = fakeBuilder({ workers: { script: worker } });
  const runtime = fakeRuntime();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ signal: controller.signal });
  const deployment = executor.deploy(deploymentRequest({ recipe: { adapter: 'script' } }), control);
  await until(() => builder.activeWorkers.size === 1);
  controller.abort(Object.assign(new Error('Synthetic controller stop'), { code: 'interrupted' }));
  await assert.rejects(deployment, error => error.code === 'interrupted');
  assert.ok(control._events.includes('cleanup_deferred'));
  assert.equal(builder.volumes.has(executor.volumeName(control.jobId)), true);
  await executor.recover({ id: control.jobId });
  assert.equal(builder.volumes.size, 0);
  assert.equal(runtime.calls.length, 0);
});

test('an oversized runtime relay response is refused rather than buffered without bound', async () => {
  const builder = fakeBuilder();
  // 300KB comfortably exceeds runtime-client.js's own 256KB response cap
  // (MAX_RESPONSE_BYTES); the overflow must be detected and refused before
  // any JSON parsing is even attempted, never silently truncated or hung.
  const runtime = fakeRuntime({ service_preflight: () => ({ loadState: 'loaded', padding: 'x'.repeat(300000) }) });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const control = makeControl({ jobId: 'job-oversized-relay', policy: { image: 'exampleapp', service: 'exampleapp' } });
  await assert.rejects(() => executor.deploy(podmanRequest(), control), error => {
    assert.equal(error.code, 'runtime_protocol_error');
    return true;
  });
});

test('script() refuses an oversized version-command response instead of buffering it without bound', async () => {
  const builder = fakeBuilder({
    workers: {
      script: workerReply({ exitCode: 0 }),
      // 70000 bytes exceeds container-executor.js's own 65536-byte capture
      // limit for the version command's response.
      version: workerReply({ stdout: 'x'.repeat(70000), exitCode: 0 }),
    },
  });
  const runtime = fakeRuntime();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const executor = new ContainerExecutor(containerConfig(), { spawnProcess });
  const request = deploymentRequest({ recipe: { adapter: 'script' }, versionCommand: 'print-version' });
  await assert.rejects(() => executor.deploy(request, makeControl({ jobId: 'job-oversized-version' })), error => {
    assert.equal(error.code, 'step_output_too_large');
    return true;
  });
});

// =============================================================================
// cleanupJobResources(): exact, job-scoped teardown after every deploy
// =============================================================================

test("cleanupJobResources leaves every other job's resources untouched after a deploy completes", async () => {
  const builder = fakeBuilder({ workers: { script: workerReply({ exitCode: 0 }) } });
  const runtime = fakeRuntime();
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const config = containerConfig();
  const executor = new ContainerExecutor(config, { spawnProcess });
  // A decoy resource belonging to a completely different job, present
  // throughout this job's entire deploy+cleanup lifecycle.
  const decoyLabels = { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': 'other-job-untouched' };
  builder.containers.set('pw-deploy-job-other-job-untouched-script', { status: 'exited', labels: decoyLabels });
  builder.volumes.set('pw-deploy-job-other-job-untouched-workspace', { labels: decoyLabels });

  await executor.deploy(deploymentRequest({ recipe: { adapter: 'script' } }), makeControl({ jobId: 'job-clean' }));

  assert.equal(builder.containers.has('pw-deploy-job-job-clean-script'), false, "this job's own container must be cleaned up");
  assert.equal(builder.volumes.has('pw-deploy-job-job-clean-workspace'), false, "this job's own volume must be cleaned up");
  assert.equal(builder.containers.has('pw-deploy-job-other-job-untouched-script'), true,
    "a different job's container must never be touched by this job's cleanup");
  assert.equal(builder.volumes.has('pw-deploy-job-other-job-untouched-workspace'), true,
    "a different job's volume must never be touched by this job's cleanup");
});

test('an exact-name foreign workspace is neither adopted nor removed', async () => {
  const config = containerConfig(), control = makeControl(), builder = fakeBuilder();
  const name = `pw-deploy-job-${control.jobId}-workspace`;
  const foreign = { labels: { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': 'another-job' } };
  builder.volumes.set(name, foreign);
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman });
  await assert.rejects(new ContainerExecutor(config, { spawnProcess }).deploy(
    deploymentRequest({ recipe: { adapter: 'script' } }), control), error => error.code === 'resource_conflict');
  assert.equal(builder.volumes.get(name), foreign);
  assert.equal(calls.some(call => stripRemote(call.args)[0] === 'create'), false);
  assert.equal(calls.some(call => stripRemote(call.args).slice(0, 2).join(' ') === 'volume rm'), false);
});

test('an exact-name foreign candidate image survives a failed deployment', async () => {
  const config = containerConfig(), builder = fakeBuilder(), runtime = fakeRuntime();
  const control = makeControl({ policy: { image: 'exampleapp', service: 'exampleapp' } });
  const candidate = `localhost/exampleapp:candidate-${control.jobId}`;
  const foreign = { labels: { 'io.pw-deploy.instance': config.container.instanceId, 'io.pw-deploy.job': 'another-job' } };
  builder.images.set(candidate, foreign);
  const { spawnProcess, calls } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  await assert.rejects(new ContainerExecutor(config, { spawnProcess }).deploy(podmanRequest(), control),
    error => error.code === 'resource_conflict');
  assert.equal(builder.images.get(candidate), foreign);
  assert.equal(calls.some(call => stripRemote(call.args)[0] === 'build'), false);
  assert.equal(calls.some(call => stripRemote(call.args).slice(0, 2).join(' ') === 'image rm'), false);
  assert.deepEqual(runtime.calls.map(call => call.action), ['service_preflight']);
});

test('a fresh executor recovers an interrupted runtime import from its durable candidate checkpoint', async () => {
  const config = containerConfig(), builder = fakeBuilder(), journal = new MemoryCandidateJournal();
  const controller = new AbortController();
  const control = makeControl({ signal: controller.signal, policy: { image: 'exampleapp', service: 'exampleapp' } });
  let imported = false;
  const expectedImageId = `sha256:${'c'.repeat(64)}`;
  const runtime = fakeRuntime({
    image_import: () => {
      imported = true;
      controller.abort(Object.assign(new Error('Synthetic controller interruption'), { code: 'interrupted' }));
      return { imageId: expectedImageId };
    },
    image_remove_candidate: request => {
      assert.equal(request.jobId, control.jobId);
      assert.equal(request.expectedImageId, expectedImageId);
      imported = false;
      return { removed: true };
    },
  });
  const { spawnProcess } = fakeSpawn({ podman: builder.podman, ssh: runtime.ssh });
  const request = podmanRequest();
  await assert.rejects(new ContainerExecutor(config, { spawnProcess, candidateJournal: journal }).deploy(request, control),
    error => error.code === 'interrupted');
  assert.equal(imported, true);
  assert.equal(journal.values.size, 1);
  const restarted = new ContainerExecutor(config, { spawnProcess, candidateJournal: journal });
  await restarted.recover({
    id: control.jobId, project: request.project, target: request.target, revision: request.revision, adapter: 'podman',
  }, control.jobDirectory);
  assert.equal(imported, false);
  assert.equal(journal.values.size, 0);
  assert.equal(builder.images.size, 0);
  assert.equal(runtime.calls.some(call => ['image_tag', 'service_restart'].includes(call.action)), false);
});

test('failed runtime candidate cleanup retains its checkpoint for the next recovery', async () => {
  const config = containerConfig(), journal = new MemoryCandidateJournal(), control = makeControl();
  const request = podmanRequest(), job = { ...request, id: control.jobId };
  await journal.write(control.jobDirectory, {
    jobId: job.id, instanceId: config.container.instanceId, project: job.project, target: job.target,
    revision: job.revision, image: 'exampleapp', imageId: `sha256:${'c'.repeat(64)}`,
  });
  const runtime = fakeRuntime({ image_remove_candidate: () => {
    throw Object.assign(new Error('Synthetic candidate replacement'), { code: 'resource_conflict' });
  } });
  const { spawnProcess } = fakeSpawn({ ssh: runtime.ssh });
  const executor = new ContainerExecutor(config, { spawnProcess, candidateJournal: journal });
  await assert.rejects(executor.cleanupRuntimeCandidate(job, control.jobDirectory, control.signal),
    error => error.code === 'resource_conflict');
  assert.equal(journal.values.size, 1);
});
