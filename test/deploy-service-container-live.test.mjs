import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { deploymentRequest } from './deploy-service-fixtures.mjs';
import { snapshotDigest, validateJob } from '../app/deployment/protocol.js';

const PODMAN = '/usr/bin/podman';
const LIVE = process.env.PW_DEPLOY_LIVE_FIXTURE === '1';
const IMAGE_ID = /^(?:sha256:)?([a-f0-9]{64})$/;
const JOB_ID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const WORKER_NAME = new RegExp(`^pw-deploy-job-(${JOB_ID})-(dependencies|script|version|smoke)$`);
const WORKER_VOLUME = new RegExp(`^pw-deploy-job-(${JOB_ID})-workspace$`);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const COMMAND_TIMEOUT_MS = 30_000;
const PREFIX = 'pw-contained-fixture-';

function normalizeImageId(value, description) {
  const match = IMAGE_ID.exec(String(value).trim());
  if (!match) throw new Error(`${description} was not a bare or sha256: 64-hex image ID`);
  return `sha256:${match[1]}`;
}

function boundedCapture(stream, maximum = 4 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  stream.on('data', chunk => {
    const value = Buffer.from(chunk);
    if (bytes + value.length <= maximum) {
      chunks.push(value);
      bytes += value.length;
    } else {
      overflow = true;
    }
  });
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    overflow: () => overflow,
  };
}

function childCompletion(child) {
  let settled = false;
  let outcome;
  let childError;
  const finish = value => {
    if (settled) return;
    settled = true;
    outcome = value;
  };
  const promise = new Promise(resolve => {
    child.once('error', error => {
      childError = error;
      if (child.pid) return;
      finish({ error });
      resolve(outcome);
    });
    child.once('close', (code, signal) => {
      finish({ code, signal, ...(childError ? { error: childError } : {}) });
      resolve(outcome);
    });
  });
  return { promise, settled: () => settled, outcome: () => outcome };
}

function ownChild(child, registry) {
  const completion = childCompletion(child);
  const handle = {
    child, completion, closed: completion.promise,
    exited: completion.settled, outcome: completion.outcome,
  };
  registry?.add(handle);
  return handle;
}

async function boundedOutcome(completion, timeoutMs) {
  if (completion.settled()) return completion.outcome();
  let timer;
  try {
    return await Promise.race([
      completion.promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function terminateOwned(child, completion, timeoutMs = 5000) {
  if (completion.settled()) return completion.outcome();
  child.kill('SIGKILL');
  const outcome = await boundedOutcome(completion, timeoutMs);
  if (!outcome) throw new Error(`Owned process ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
  return outcome;
}

async function run(command, args, {
  env = process.env, input, timeoutMs = COMMAND_TIMEOUT_MS, allowedExitCodes = [0],
  maxOutputBytes = 4 * 1024 * 1024, signal, ownedProcesses,
} = {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const { completion } = ownChild(child, ownedProcesses);
  const stdout = boundedCapture(child.stdout, maxOutputBytes);
  const stderr = boundedCapture(child.stderr, maxOutputBytes);
  let inputError;
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') inputError = error;
  });
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  let abortListener;
  const interrupted = new Promise(resolve => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    timer.unref();
    completion.promise.finally(() => clearTimeout(timer));
    if (signal) {
      abortListener = () => resolve({ kind: 'abort', reason: signal.reason });
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
  });
  const winner = await Promise.race([
    completion.promise.then(outcome => ({ kind: 'closed', outcome })),
    interrupted,
  ]);
  if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  if (winner.kind !== 'closed') {
    await terminateOwned(child, completion);
    if (winner.kind === 'abort') throw winner.reason ?? new Error(`${path.basename(command)} command aborted`);
    throw new Error(`${path.basename(command)} command exceeded ${timeoutMs}ms`);
  }
  const result = winner.outcome;
  signal?.throwIfAborted();
  if (result.error) throw result.error;
  if (inputError) throw inputError;
  if (stdout.overflow() || stderr.overflow()) throw new Error(`${path.basename(command)} command output exceeded its fixture limit`);
  if (!allowedExitCodes.includes(result.code)) {
    const detail = stderr.text().trim().slice(0, 1000);
    throw new Error(`${path.basename(command)} exited ${result.code ?? result.signal}${detail ? `: ${detail}` : ''}`);
  }
  return { stdout: stdout.text(), stderr: stderr.text(), ...result };
}

function startOwned(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = ownChild(child);
  const stdout = boundedCapture(child.stdout);
  const stderr = boundedCapture(child.stderr);
  return {
    ...handle, stdout, stderr,
  };
}

async function reap(processHandle, timeoutMs = 10_000) {
  if (!processHandle) return null;
  let outcome = await boundedOutcome(processHandle.completion, timeoutMs);
  if (!outcome) outcome = await terminateOwned(processHandle.child, processHandle.completion);
  if (outcome.error) throw outcome.error;
  return outcome;
}

async function waitFor(description, timeoutMs, probe, intervalMs = 100, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs, undefined, signal ? { signal } : undefined);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON`, { cause: error });
  }
}

async function streamImage(sourceImage, privateArgs, privateEnv, signal, {
  spawnProcess = spawn, timeoutMs = 120_000, ownedProcesses,
} = {}) {
  signal?.throwIfAborted();
  const save = spawnProcess(PODMAN, ['--remote=false', 'save', '--format=docker-archive', sourceImage], {
    env: { ...process.env, TMPDIR: privateEnv.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { completion: saveCompletion } = ownChild(save, ownedProcesses);
  const load = spawnProcess(PODMAN, [...privateArgs, 'load'], {
    env: privateEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const { completion: loadCompletion } = ownChild(load, ownedProcesses);
  const saveError = boundedCapture(save.stderr);
  const loadOutput = boundedCapture(load.stdout);
  const loadError = boundedCapture(load.stderr);
  let rejectPipe;
  const pipeFailure = new Promise(resolve => { rejectPipe = error => resolve({ kind: 'pipe', error }); });
  load.stdin.on('error', rejectPipe);
  save.stdout.on('error', rejectPipe);
  save.stdout.pipe(load.stdin);
  let abortListener;
  let timer;
  const interrupted = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    timer.unref();
    if (signal) {
      abortListener = () => resolve({ kind: 'abort', reason: signal.reason });
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
  });
  const terminatePipeline = async failure => {
    save.stdout.unpipe(load.stdin);
    load.stdin.destroy();
    const stopped = await Promise.allSettled([
      terminateOwned(save, saveCompletion),
      terminateOwned(load, loadCompletion),
    ]);
    const terminationErrors = stopped
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (terminationErrors.length) {
      throw new AggregateError([failure, ...terminationErrors], 'Podman image pipeline did not terminate cleanly');
    }
    throw failure;
  };
  let saveOutcome;
  let loadOutcome;
  try {
    while (!saveOutcome || !loadOutcome) {
      const candidates = [interrupted, pipeFailure];
      if (!saveOutcome) candidates.push(saveCompletion.promise.then(outcome => ({ kind: 'save', outcome })));
      if (!loadOutcome) candidates.push(loadCompletion.promise.then(outcome => ({ kind: 'load', outcome })));
      const result = await Promise.race(candidates);
      if (result.kind === 'timeout' || result.kind === 'abort' || result.kind === 'pipe') {
        const failure = result.kind === 'pipe' ? result.error : result.kind === 'abort'
          ? result.reason ?? new Error('Podman image transfer aborted')
          : new Error(`Podman image transfer exceeded ${timeoutMs}ms`);
        await terminatePipeline(failure);
      }
      if (result.kind === 'save') saveOutcome = result.outcome;
      else loadOutcome = result.outcome;
      const outcome = result.outcome;
      if (outcome.error || outcome.code !== 0) {
        const failure = outcome.error
          ?? new Error(`Podman image ${result.kind} exited ${outcome.code ?? outcome.signal}`);
        await terminatePipeline(failure);
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
  signal?.throwIfAborted();
  if (saveError.overflow() || loadOutput.overflow() || loadError.overflow()) {
    throw new Error('Podman image transfer output exceeded its fixture limit');
  }
  if (saveOutcome?.error) throw saveOutcome.error;
  if (loadOutcome?.error) throw loadOutcome.error;
  if (saveOutcome?.code !== 0 || loadOutcome?.code !== 0) {
    throw new Error(`Podman image transfer failed (save=${saveOutcome?.code ?? saveOutcome?.signal}, load=${loadOutcome?.code ?? loadOutcome?.signal})`);
  }
}

function unixPing(socketPath, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/_ping', method: 'GET', timeout: 2000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(response.statusCode === 200 && body.trim() === 'OK'));
    });
    request.on('timeout', () => request.destroy(new Error('Podman socket ping timed out')));
    request.on('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(error);
    });
    const abort = () => request.destroy(signal.reason ?? new Error('Podman socket ping aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.end();
  });
}

function source(files) {
  return { files, sha256: snapshotDigest(files) };
}

function sourceFile(filePath, contents, executable = false) {
  return { path: filePath, data: Buffer.from(contents).toString('base64'), executable };
}

function livePayloads(instanceId, syntheticSecret) {
  const project = `ContainedFixture${instanceId.replaceAll('-', '').slice(0, 12)}`;
  const cancellationScript = [
    'set -euo pipefail',
    'trap "" TERM INT',
    'printf "READY_CANCEL\\n"',
    'while :; do /usr/bin/sleep 1; done',
  ].join('\n');
  return {
    project,
    success: deploymentRequest({
      requestId: `fixture-success-${instanceId}`,
      project,
      target: 'dev',
      revision: 'a'.repeat(40),
      source: source([sourceFile('nested/input.txt', 'before\n')]),
      recipe: { adapter: 'script' },
      environment: { DEPLOY_FIXTURE_MODE: 'live' },
      secrets: { DEPLOY_TOKEN: syntheticSecret },
      script: [
        'set -euo pipefail',
        'test "$(id -u)" = 1001',
        'test "$(id -g)" = 1001',
        'test "$(awk \'/^CapEff:/ { print $2 }\' /proc/self/status)" = 0000000000000000',
        'test "$(awk \'/^CapBnd:/ { print $2 }\' /proc/self/status)" = 0000000000000000',
        'test "$(awk \'/^NoNewPrivs:/ { print $2 }\' /proc/self/status)" = 1',
        'test "$PWD" = /workspace/source',
        'test ! -e /run/pw-deploy/podman.sock',
        'test ! -e /etc/pw-deploy/config.json',
        'test ! -e /run/secrets/pw-deploy-api',
        'test ! -e /run/secrets/pw-deploy-ui',
        '! mountpoint -q /var/lib/pw-deploy',
        'test ! -r /var/lib/pw-deploy',
        'test "$(cat nested/input.txt)" = before',
        'printf "after\\n" >> nested/input.txt',
        'umask 077',
        'printf "private\\n" > nested/private.txt',
        'test "$(stat -c %a nested/private.txt)" = 600',
        'export SHELL_ONLY_STATE=must-not-cross-worker-boundary',
        'printf "SCRIPT_PROBE_OK\\n"',
        'printf "secret=%s\\n" "$DEPLOY_TOKEN"',
      ].join('\n'),
      versionCommand: [
        'set -euo pipefail',
        'test "$PWD" = /workspace/source',
        'test "$(tail -n 1 nested/input.txt)" = after',
        'test "$(cat nested/private.txt)" = private',
        'test "${SHELL_ONLY_STATE+x}" != x',
        'printf "1.2.3\\n"',
      ].join('\n'),
    }),
    cancellation: deploymentRequest({
      requestId: `fixture-cancel-${instanceId}`,
      project: `${project}Cancel`,
      target: 'dev',
      source: source([sourceFile('nested/input.txt', 'cancel\n')]),
      recipe: { adapter: 'script' },
      secrets: { DEPLOY_TOKEN: syntheticSecret },
      script: cancellationScript,
      versionCommand: '',
    }),
    recovery: deploymentRequest({
      requestId: `fixture-recovery-${instanceId}`,
      project: `${project}Recovery`,
      target: 'dev',
      source: source([sourceFile('nested/input.txt', 'recovery\n')]),
      recipe: { adapter: 'script' },
      script: [
        'set -euo pipefail',
        'trap "" TERM INT',
        'printf "READY_RECOVERY\\n"',
        'while :; do /usr/bin/sleep 1; done',
      ].join('\n'),
      versionCommand: '',
    }),
  };
}

for (const mode of ['success', 'receiver failure', 'timeout', 'abort']) {
  test(`live fixture image transfer reaps both actual children on ${mode}`, { timeout: 10_000 }, async t => {
    const children = [];
    t.after(async () => {
      for (const handle of children) await terminateOwned(handle.child, handle.completion);
    });
    const controller = new AbortController();
    const spawnProcess = (_command, args, options) => {
      let script = 'setInterval(() => {}, 1000)';
      if (mode === 'success') {
        script = args.includes('save') ? 'process.stdout.write("fixture archive")'
          : 'let data=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => data+=chunk); process.stdin.on("end", () => process.exit(data==="fixture archive" ? 0 : 23))';
      } else if (args.includes('load') && mode === 'receiver failure') {
        script = 'process.exit(23)';
      }
      const child = spawn(process.execPath, ['-e', script], options);
      const completion = childCompletion(child);
      children.push({ child, completion });
      return child;
    };
    const timer = mode === 'abort'
      ? setTimeout(() => controller.abort(new Error('Fixture transfer aborted')), 100) : undefined;
    try {
      const transferred = streamImage('fixture-image', [], process.env, controller.signal, {
        spawnProcess, timeoutMs: mode === 'timeout' ? 150 : 2000,
      });
      if (mode === 'success') await transferred;
      else await assert.rejects(transferred, /image load exited 23|image transfer exceeded|Fixture transfer aborted/);
      assert.equal(children.length, 2);
      assert.ok(children.every(handle => handle.completion.settled()), 'both children must be reaped before rejection');
    } finally {
      clearTimeout(timer);
    }
  });
}

test('live fixture payloads remain valid deployment protocol requests', () => {
  const syntheticSecret = 'synthetic-live-fixture-token-0123456789';
  const payloads = livePayloads('11111111-1111-4111-8111-111111111111', syntheticSecret);
  for (const name of ['success', 'cancellation', 'recovery']) {
    const validated = validateJob(payloads[name]);
    assert.equal(validated.recipe.adapter, 'script');
    assert.equal(validated.target, 'dev');
  }
  assert.deepEqual(payloads.success.secrets, { DEPLOY_TOKEN: syntheticSecret });
  assert.deepEqual(payloads.cancellation.secrets, { DEPLOY_TOKEN: syntheticSecret });
  assert.deepEqual(payloads.recovery.secrets, {});
});

test('isolated live container controller proves script execution, cancellation, and owned-only recovery', {
  skip: !LIVE,
  timeout: 300_000,
}, async t => {
  assert.equal(process.platform, 'linux', 'PW_DEPLOY_LIVE_FIXTURE=1 requires Linux');
  assert.equal(typeof process.getuid, 'function', 'PW_DEPLOY_LIVE_FIXTURE=1 requires a Unix UID');
  const uid = process.getuid();
  assert.notEqual(uid, 0, 'The live fixture must run as the ordinary rootless Podman user');
  const suppliedImage = process.env.PW_DEPLOY_TEST_IMAGE;
  const imageMatch = IMAGE_ID.exec(suppliedImage || '');
  assert.ok(imageMatch, 'PW_DEPLOY_TEST_IMAGE must be a bare or sha256: 64-hex local image ID');
  const imageId = `sha256:${imageMatch[1]}`;
  await fs.access(PODMAN, fsConstants.X_OK);
  const realBus = `/run/user/${uid}/bus`;
  const busStat = await fs.lstat(realBus);
  assert.ok(busStat.isSocket(), `Expected the real user D-Bus socket at ${realBus}`);

  const instanceId = crypto.randomUUID();
  const otherInstanceId = crypto.randomUUID();
  const fixtureStem = `${PREFIX}${instanceId}`;
  const controllerAName = `${fixtureStem}-controller-a`;
  const controllerBName = `${fixtureStem}-controller-b`;
  const decoyName = `${fixtureStem}-decoy`;
  const configSecret = `${fixtureStem}-config`;
  const apiSecret = `${fixtureStem}-api`;
  const uiSecret = `${fixtureStem}-ui`;
  const stateVolume = `${fixtureStem}-state`;
  const intendedContainers = new Set([controllerAName, controllerBName, decoyName]);
  const intendedSecrets = new Set([configSecret, apiSecret, uiSecret]);
  const importedReferences = new Set();
  const processHandles = new Set();
  let storageBase;
  let xdgRuntimeDir;
  let graphRoot;
  let runRoot;
  let tmpDir;
  let socketPath;
  let privateEnv;
  let privateArgs;
  let privatePodmanTouched = false;
  let privateIdentityVerified = false;
  let serviceProcess;
  let decoyProcess;

  const privatePodman = (args, { cleanup = false, ...options } = {}) => {
    if (!privateArgs || !privateEnv) throw new Error('Private Podman paths are not initialized');
    privatePodmanTouched = true;
    return run(PODMAN, [...privateArgs, ...args], {
      env: privateEnv,
      signal: cleanup ? undefined : t.signal,
      ownedProcesses: processHandles,
      ...options,
    });
  };
  const resourceNames = async (kind, labels, { cleanup = false } = {}) => {
    const command = kind === 'container' ? ['ps', '-a'] : ['volume', 'ls'];
    const format = kind === 'container' ? '{{.Names}}' : '{{.Name}}';
    const result = await privatePodman([
      ...command,
      ...labels.flatMap(label => ['--filter', `label=${label}`]),
      '--format', format,
    ], { cleanup });
    return result.stdout.split('\n').map(value => value.trim()).filter(Boolean);
  };
  const exists = async (kind, name, { cleanup = false } = {}) => (await privatePodman(
    [kind, 'exists', name], { cleanup, allowedExitCodes: [0, 1] },
  )).code === 0;
  const containerStatus = async (name, { cleanup = false } = {}) => {
    if (!(await exists('container', name, { cleanup }))) return null;
    return (await privatePodman([
      'container', 'inspect', '--format', '{{.State.Status}}', name,
    ], { cleanup })).stdout.trim();
  };
  const stopAndRemoveContainer = async name => {
    if (!(await exists('container', name, { cleanup: true }))) return;
    const labels = parseJson((await privatePodman([
      'container', 'inspect', '--format', '{{json .Config.Labels}}', name,
    ], { cleanup: true })).stdout, `labels for ${name}`);
    const ownedController = labels?.['io.pw-deploy.live-fixture'] === instanceId
      && intendedContainers.has(name);
    const worker = WORKER_NAME.exec(name);
    const ownedWorker = worker
      && labels?.['io.pw-deploy.instance'] === instanceId
      && labels?.['io.pw-deploy.job'] === worker[1];
    assert.ok(ownedController || ownedWorker, `Refusing cleanup of unowned container ${name}`);
    const status = await containerStatus(name, { cleanup: true });
    if (status === 'running' || status === 'paused') {
      await privatePodman(['stop', '--time=3', name], { cleanup: true, timeoutMs: 15_000 });
    }
    const stopped = await containerStatus(name, { cleanup: true });
    assert.ok(stopped === null || ['created', 'exited', 'stopped'].includes(stopped),
      `Container ${name} did not reach a stopped state`);
    if (stopped !== null) await privatePodman(['rm', name], { cleanup: true });
    assert.equal(await exists('container', name, { cleanup: true }), false,
      `Container ${name} still exists after removal`);
  };
  const removeOwnedVolumes = async names => {
    for (const name of names) {
      if (!(await exists('volume', name, { cleanup: true }))) continue;
      const labels = parseJson((await privatePodman([
        'volume', 'inspect', '--format', '{{json .Labels}}', name,
      ], { cleanup: true })).stdout, `labels for volume ${name}`);
      assert.equal(labels?.['io.pw-deploy.instance'], instanceId);
      if (name === stateVolume) {
        assert.equal(labels?.['io.pw-deploy.live-fixture'], instanceId);
      } else {
        const worker = WORKER_VOLUME.exec(name);
        assert.ok(worker, `Refusing cleanup of unexpected volume ${name}`);
        assert.equal(labels?.['io.pw-deploy.job'], worker[1]);
      }
      await privatePodman(['volume', 'rm', name], { cleanup: true });
      assert.equal(await exists('volume', name, { cleanup: true }), false,
        `Volume ${name} still exists after removal`);
    }
  };
  const removeProvenEmptyDirectory = async (directory, parent, prefix) => {
    if (!directory) return null;
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith(prefix));
    const inspect = async current => {
      const stat = await fs.lstat(current);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(stat.uid, uid);
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
        if (!(await inspect(path.join(current, entry.name)))) return false;
      }
      return true;
    };
    if (!(await inspect(directory))) return directory;
    await fs.rm(directory, { recursive: true });
    return null;
  };
  const cleanupFixture = async () => {
    const errors = [];
    const retained = [];
    const attempt = async operation => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    if (privateIdentityVerified) {
      let labelledContainers = [];
      await attempt(async () => {
        labelledContainers = await resourceNames('container',
          [`io.pw-deploy.instance=${instanceId}`], { cleanup: true });
      });
      for (const name of new Set([...intendedContainers, ...labelledContainers])) {
        await attempt(() => stopAndRemoveContainer(name));
      }
      let labelledVolumes = [];
      await attempt(async () => {
        labelledVolumes = await resourceNames('volume',
          [`io.pw-deploy.instance=${instanceId}`], { cleanup: true });
      });
      for (const name of new Set([stateVolume, ...labelledVolumes])) {
        await attempt(() => removeOwnedVolumes([name]));
      }
      for (const name of intendedSecrets) {
        await attempt(async () => {
          if (!(await exists('secret', name, { cleanup: true }))) return;
          await privatePodman(['secret', 'rm', name], { cleanup: true });
          assert.equal(await exists('secret', name, { cleanup: true }), false,
            `Secret ${name} still exists after removal`);
        });
      }
      for (const reference of importedReferences) {
        await attempt(async () => {
          if (!(await exists('image', reference, { cleanup: true }))) return;
          await privatePodman(['image', 'rm', '--no-prune', reference], { cleanup: true });
          assert.equal(await exists('image', reference, { cleanup: true }), false,
            `Image reference ${reference} still exists after removal`);
        });
      }
      await attempt(async () => {
        if (await exists('image', imageId, { cleanup: true })) {
          await privatePodman(['image', 'rm', '--no-prune', imageId], { cleanup: true });
          assert.equal(await exists('image', imageId, { cleanup: true }), false,
            `Imported image ${imageId} still exists after removal`);
        }
      });
    }
    for (const handle of processHandles) await attempt(() => reap(handle));
    await attempt(async () => {
      if (serviceProcess && !serviceProcess.exited()) serviceProcess.child.kill('SIGTERM');
      if (serviceProcess) await reap(serviceProcess);
    });
    const childrenStopped = [...processHandles, serviceProcess].filter(Boolean).every(handle => handle.exited());
    // Podman's namespace helper can outlive its API process. Preserve initialized
    // runtime/storage state until the parent has reconciled that exact namespace.
    const mayRemoveDirectories = errors.length === 0 && childrenStopped && !privatePodmanTouched;
    if (mayRemoveDirectories) {
      await attempt(async () => {
        const retainedXdg = await removeProvenEmptyDirectory(xdgRuntimeDir, `/run/user/${uid}`, 'pwdf-');
        if (retainedXdg) retained.push(retainedXdg);
      });
      await attempt(async () => {
        const retainedStorage = await removeProvenEmptyDirectory(storageBase, '/srv/containers', fixtureStem);
        if (retainedStorage) retained.push(retainedStorage);
      });
    } else {
      if (xdgRuntimeDir) retained.push(xdgRuntimeDir);
      if (storageBase) retained.push(storageBase);
    }
    if (errors.length) {
      if (xdgRuntimeDir && !retained.includes(xdgRuntimeDir)) retained.push(xdgRuntimeDir);
      if (storageBase && !retained.includes(storageBase)) retained.push(storageBase);
    }
    if (retained.length) t.diagnostic(`Retained namespace-owned fixture paths for parent cleanup: ${retained.join(', ')}`);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Live fixture cleanup failed');
  };
  t.after(cleanupFixture);

  storageBase = await fs.mkdtemp(`/srv/containers/${fixtureStem}-`);
  await fs.chmod(storageBase, 0o700);
  graphRoot = path.join(storageBase, 'graph');
  await fs.mkdir(graphRoot, { mode: 0o700 });
  const transferTemp = path.join(storageBase, 'transfer');
  await fs.mkdir(transferTemp, { mode: 0o700 });
  xdgRuntimeDir = await fs.mkdtemp(`/run/user/${uid}/pwdf-`);
  await fs.chmod(xdgRuntimeDir, 0o700);
  runRoot = path.join(xdgRuntimeDir, 'r');
  tmpDir = path.join(xdgRuntimeDir, 't');
  socketPath = path.join(xdgRuntimeDir, 'p.sock');
  await fs.mkdir(runRoot, { mode: 0o700 });
  await fs.mkdir(tmpDir, { mode: 0o700 });
  assert.ok(Buffer.byteLength(socketPath) <= 90,
    `Private Podman socket path is too long for safe AF_UNIX use: ${socketPath}`);
  assert.ok(Buffer.byteLength(runRoot) <= 64,
    `Private Podman runroot is too long for safe AF_UNIX use: ${runRoot}`);
  assert.ok(Buffer.byteLength(tmpDir) <= 64,
    `Private Podman tmpdir is too long for safe AF_UNIX use: ${tmpDir}`);
  privateEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    TMPDIR: transferTemp,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${realBus}`,
    // Podman's generated healthcheck units omit custom store arguments. Run the
    // real image healthcheck explicitly in this isolated store instead.
    DISABLE_HC_SYSTEMD: 'true',
  };
  privateArgs = ['--remote=false', '--root', graphRoot, '--runroot', runRoot, '--tmpdir', tmpDir];
  console.log(`PW_DEPLOY_FIXTURE_RESOURCES=${JSON.stringify({ instanceId, storageBase, xdgRuntimeDir, graphRoot, runRoot, tmpDir, socketPath })}`);

  const normalIdentity = normalizeImageId((await run(PODMAN, [
    '--remote=false', 'image', 'inspect', '--format', '{{.Id}}', suppliedImage,
  ], { signal: t.signal, ownedProcesses: processHandles })).stdout, 'Normal-store image inspection');
  assert.equal(normalIdentity, imageId, 'The supplied normal-store reference must resolve to that exact image ID');
  const normalLabels = parseJson((await run(PODMAN, [
    '--remote=false', 'image', 'inspect', '--format', '{{json .Config.Labels}}', imageId,
  ], { signal: t.signal, ownedProcesses: processHandles })).stdout, 'normal-store image labels');
  assert.equal(normalLabels?.['io.pw-deploy.worker'], 'true');
  assert.equal(normalLabels?.['io.pw-deploy.api-version'], '1');
  const expectedHealthcheck = ['CMD', 'node', '/opt/pw-deploy/health.mjs'];
  const normalHealthcheck = parseJson((await run(PODMAN, [
    '--remote=false', 'image', 'inspect', '--format', '{{json .Config.Healthcheck}}', imageId,
  ], { signal: t.signal, ownedProcesses: processHandles })).stdout, 'normal-store image healthcheck');
  assert.deepEqual(normalHealthcheck?.Test, expectedHealthcheck);

  const info = parseJson((await privatePodman(['info', '--format=json'])).stdout, 'private podman info');
  assert.equal(info?.host?.security?.rootless, true);
  assert.equal(info?.store?.graphRoot, graphRoot);
  assert.equal(info?.store?.runRoot, runRoot);
  assert.equal(info?.store?.volumePath, path.join(graphRoot, 'volumes'));
  assert.equal(info?.store?.imageCopyTmpDir, transferTemp);
  assert.equal((await privatePodman(['ps', '-a', '--format', '{{.ID}}'])).stdout.trim(), '');
  privateIdentityVerified = true;

  await streamImage(imageId, privateArgs, privateEnv, t.signal, { ownedProcesses: processHandles });
  const privateIdentity = normalizeImageId((await privatePodman([
    'image', 'inspect', '--format', '{{.Id}}', imageId,
  ])).stdout, 'Private-store image inspection');
  assert.equal(privateIdentity, imageId, 'Private load must preserve the exact source image ID');
  const privateLabels = parseJson((await privatePodman([
    'image', 'inspect', '--format', '{{json .Config.Labels}}', imageId,
  ])).stdout, 'private-store image labels');
  assert.equal(privateLabels?.['io.pw-deploy.worker'], 'true');
  assert.equal(privateLabels?.['io.pw-deploy.api-version'], '1');
  const privateHealthcheck = parseJson((await privatePodman([
    'image', 'inspect', '--format', '{{json .Config.Healthcheck}}', imageId,
  ])).stdout, 'private-store image healthcheck');
  assert.deepEqual(privateHealthcheck?.Test, expectedHealthcheck);
  assert.deepEqual(privateHealthcheck, normalHealthcheck,
    'docker-archive transfer must preserve the complete healthcheck metadata');
  const fixtureImageReference = `localhost/${fixtureStem}:worker`;
  await privatePodman(['tag', imageId, fixtureImageReference]);
  importedReferences.add(fixtureImageReference);
  const repoTagsText = (await privatePodman([
    'image', 'inspect', '--format', '{{json .RepoTags}}', imageId,
  ])).stdout.trim();
  for (const reference of parseJson(repoTagsText || '[]', 'private image references') || []) {
    if (reference === fixtureImageReference) continue;
    importedReferences.add(reference);
    await privatePodman(['image', 'rm', '--no-prune', reference]);
    assert.equal(await exists('image', reference), false,
      `Imported source image reference ${reference} still exists after untagging`);
  }

  serviceProcess = startOwned(PODMAN, [
    ...privateArgs, 'system', 'service', '--time=300', `unix://${socketPath}`,
  ], privateEnv);
  const wait = (description, timeoutMs, probe, intervalMs = 100) => waitFor(
    description, timeoutMs, probe, intervalMs, t.signal,
  );
  await wait('the private Podman API socket', 15_000, async () => {
    if (serviceProcess.exited()) {
      throw new Error(`Private Podman API service exited before becoming ready: ${serviceProcess.stderr.text().slice(-1000)}`);
    }
    return unixPing(socketPath, t.signal);
  });

  const apiToken = `fixture-api-${crypto.randomBytes(32).toString('base64url')}`;
  const uiToken = `fixture-ui-${crypto.randomBytes(32).toString('base64url')}`;
  const syntheticSecret = `fixture-job-${crypto.randomBytes(32).toString('base64url')}`;
  const config = {
    mode: 'container',
    listen: { host: '0.0.0.0', port: 3800 },
    tokenFile: '/run/secrets/pw-deploy-api',
    stateDir: '/var/lib/pw-deploy',
    healthHosts: ['127.0.0.1', '::1'],
    adapters: ['script'],
    maxConcurrent: 1,
    defaultTimeoutSeconds: 30,
    retentionDays: 1,
    resourceNames: {},
    ui: {
      basePath: '/deploy-service',
      publicOrigin: 'https://fixture.example.test',
      tokenFile: '/run/secrets/pw-deploy-ui',
      sessionMinutes: 30,
    },
    container: {
      instanceId,
      builderSocket: '/run/pw-deploy/podman.sock',
      workerImage: imageId,
      maxMemoryMiB: 512,
      maxPids: 128,
    },
  };
  for (const [name, value] of [
    [configSecret, `${JSON.stringify(config)}\n`],
    [apiSecret, `${apiToken}\n`],
    [uiSecret, `${uiToken}\n`],
  ]) {
    await privatePodman(['secret', 'create', name, '-'], { input: value });
    assert.equal(await exists('secret', name), true, `Secret ${name} was not created`);
  }
  await privatePodman([
    'volume', 'create',
    '--label', `io.pw-deploy.instance=${instanceId}`,
    '--label', `io.pw-deploy.live-fixture=${instanceId}`,
    stateVolume,
  ]);
  assert.equal(await exists('volume', stateVolume), true, `State volume ${stateVolume} was not created`);
  const stateLabels = parseJson((await privatePodman([
    'volume', 'inspect', '--format', '{{json .Labels}}', stateVolume,
  ])).stdout, 'state volume labels');
  assert.equal(stateLabels?.['io.pw-deploy.instance'], instanceId);
  assert.equal(stateLabels?.['io.pw-deploy.live-fixture'], instanceId);

  const controllerArgs = name => [
    'create', '--name', name,
    '--label', 'io.pw-deploy.controller=true',
    '--label', `io.pw-deploy.instance=${instanceId}`,
    '--label', `io.pw-deploy.live-fixture=${instanceId}`,
    '--publish', '127.0.0.1::3800',
    '--read-only',
    '--user=0:0',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--log-driver=none',
    '--timeout=180',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=512m',
    '--volume', `${stateVolume}:/var/lib/pw-deploy`,
    '--volume', `${socketPath}:/run/pw-deploy/podman.sock:ro`,
    '--secret', `${configSecret},type=mount,target=/etc/pw-deploy/config.json,uid=0,gid=0,mode=0400`,
    '--secret', `${apiSecret},type=mount,target=/run/secrets/pw-deploy-api,uid=0,gid=0,mode=0400`,
    '--secret', `${uiSecret},type=mount,target=/run/secrets/pw-deploy-ui,uid=0,gid=0,mode=0400`,
    '--pull=never',
    imageId,
  ];
  const controllerLogs = [];
  const controllerFailure = (name, handle) => {
    let detail = `${handle.stdout.text().slice(-2000)}\n${handle.stderr.text().slice(-4000)}`;
    for (const value of [apiToken, uiToken, syntheticSecret]) detail = detail.replaceAll(value, '[redacted]');
    return new Error(`${name} exited during startup: ${detail}`);
  };
  const startController = async suffix => {
    const name = suffix === 'a' ? controllerAName : controllerBName;
    await privatePodman(controllerArgs(name));
    assert.equal(await exists('container', name), true, `Controller ${name} was not created`);
    const processHandle = startOwned(PODMAN, [...privateArgs, 'start', '--attach', name], privateEnv);
    processHandles.add(processHandle);
    controllerLogs.push(processHandle);
    await wait(`${name} to enter running state`, 15_000, async () => {
      if (processHandle.exited()) throw controllerFailure(name, processHandle);
      return (await containerStatus(name)) === 'running';
    });
    const port = await wait(`${name} loopback port`, 10_000, async () => {
      const output = (await privatePodman(['port', name, '3800/tcp'])).stdout.trim();
      const match = /^127\.0\.0\.1:(\d+)$/.exec(output);
      return match ? Number(match[1]) : false;
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await wait(`${name} health`, 45_000, async () => {
      try {
        if (processHandle.exited()) throw controllerFailure(name, processHandle);
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(2000)]),
        });
        await response.arrayBuffer();
        return response.status === 200;
      } catch (error) {
        if (['AbortError', 'TimeoutError'].includes(error.name)
            || ['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return false;
        throw error;
      }
    });
    await privatePodman(['healthcheck', 'run', name], { timeoutMs: 15_000 });
    return { name, baseUrl, processHandle };
  };
  const request = async (baseUrl, route, {
    method = 'GET', token, body, redirect = 'manual',
  } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      redirect,
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    if (text) json = parseJson(text, `${method} ${route}`);
    return { response, text, json };
  };
  const api = (controller, route, options = {}) => request(controller.baseUrl, route, {
    token: apiToken, ...options,
  });
  const submit = async (controller, value) => {
    const result = await api(controller, '/v1/jobs', { method: 'POST', body: value });
    assert.equal(result.response.status, 202, result.text);
    return result.json.job;
  };
  const job = async (controller, id) => {
    const result = await api(controller, `/v1/jobs/${id}`);
    assert.equal(result.response.status, 200, result.text);
    return result.json.job;
  };
  const jobLog = async (controller, id) => {
    const result = await api(controller, `/v1/jobs/${id}/log`);
    assert.equal(result.response.status, 200, result.text);
    return result.json;
  };
  const waitForJob = (controller, id, predicate, description, timeoutMs = 40_000) => waitFor(
    description, timeoutMs, async () => {
      const current = await job(controller, id);
      return predicate(current) ? current : false;
    }, 150, t.signal,
  );
  const waitForLog = (controller, id, marker, timeoutMs = 15_000) => waitFor(
    `job ${id} log marker ${marker}`, timeoutMs, async () => {
      const log = await jobLog(controller, id);
      return JSON.stringify(log).includes(marker) ? log : false;
    }, 150, t.signal,
  );
  const assertNoJobResources = async id => {
    const labels = [`io.pw-deploy.instance=${instanceId}`, `io.pw-deploy.job=${id}`];
    assert.deepEqual(await resourceNames('container', labels), []);
    assert.deepEqual(await resourceNames('volume', labels), []);
  };

  let controller = await startController('a');
  for (const route of ['/health', '/deploy-service/health']) {
    const health = await request(controller.baseUrl, route);
    assert.equal(health.response.status, 200);
    assert.deepEqual(Object.keys(health.json).sort(), ['apiVersion', 'ok', 'service']);
  }
  assert.equal((await request(controller.baseUrl, '/v1/jobs')).response.status, 401);
  assert.equal((await request(controller.baseUrl, '/v1/jobs', { token: uiToken })).response.status, 401);
  const consoleRoot = await request(controller.baseUrl, '/deploy-service/');
  assert.equal(consoleRoot.response.status, 303);
  assert.match(consoleRoot.response.headers.get('location') || '', /^\/deploy-service\/login(?:\?|$)/);

  const payloads = livePayloads(instanceId, syntheticSecret);
  const { project } = payloads;
  const succeeded = await submit(controller, payloads.success);
  const completed = await waitForJob(
    controller, succeeded.id, current => TERMINAL.has(current.state),
    'the real script job to finish',
  );
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.version, '1.2.3');
  const version = await api(controller, `/v1/version/${encodeURIComponent(project)}/dev`);
  assert.equal(version.response.status, 200);
  assert.equal(version.json.version, '1.2.3');
  assert.equal(version.json.revision, 'a'.repeat(40));
  const completedLog = await jobLog(controller, succeeded.id);
  const completedLogText = JSON.stringify(completedLog);
  assert.match(completedLogText, /SCRIPT_PROBE_OK/);
  assert.doesNotMatch(completedLogText, new RegExp(syntheticSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(completedLogText, /\[redacted\]/);
  for (const logs of controllerLogs) {
    assert.equal(logs.stdout.overflow(), false);
    assert.equal(logs.stderr.overflow(), false);
    assert.equal(logs.stdout.text().includes(syntheticSecret), false);
    assert.equal(logs.stderr.text().includes(syntheticSecret), false);
  }
  await wait('successful worker resource cleanup', 15_000, async () => {
    const labels = [`io.pw-deploy.instance=${instanceId}`, `io.pw-deploy.job=${succeeded.id}`];
    return (await resourceNames('container', labels)).length === 0
      && (await resourceNames('volume', labels)).length === 0;
  });
  await assertNoJobResources(succeeded.id);

  const cancellationJob = await submit(controller, payloads.cancellation);
  await waitForLog(controller, cancellationJob.id, 'READY_CANCEL');
  const liveWorker = `pw-deploy-job-${cancellationJob.id}-script`;
  assert.equal(await containerStatus(liveWorker), 'running');
  const workerEnv = parseJson((await privatePodman([
    'container', 'inspect', '--format', '{{json .Config.Env}}', liveWorker,
  ])).stdout, 'worker environment');
  const workerCommand = parseJson((await privatePodman([
    'container', 'inspect', '--format', '{{json .Config.Cmd}}', liveWorker,
  ])).stdout, 'worker command');
  const workerEntrypoint = parseJson((await privatePodman([
    'container', 'inspect', '--format', '{{json .Config.Entrypoint}}', liveWorker,
  ])).stdout, 'worker entrypoint');
  const workerOpenStdin = (await privatePodman([
    'container', 'inspect', '--format', '{{.Config.OpenStdin}}', liveWorker,
  ])).stdout.trim();
  const workerLogDriver = (await privatePodman([
    'container', 'inspect', '--format', '{{.HostConfig.LogConfig.Type}}', liveWorker,
  ])).stdout.trim();
  const inspectedWorkerCreateData = JSON.stringify({ workerEnv, workerCommand, workerEntrypoint });
  assert.equal(inspectedWorkerCreateData.includes(syntheticSecret), false);
  assert.equal(inspectedWorkerCreateData.includes(payloads.cancellation.script), false);
  assert.equal(workerOpenStdin, 'true');
  assert.equal(workerLogDriver, 'none');
  const cancel = await api(controller, `/v1/jobs/${cancellationJob.id}/cancel`, {
    method: 'POST', body: {},
  });
  assert.equal(cancel.response.status, 200, cancel.text);
  const cancelled = await waitForJob(
    controller, cancellationJob.id, current => TERMINAL.has(current.state),
    'the signal-ignoring job to become terminal after cancellation', 35_000,
  );
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.errorCode, 'cancelled');
  await wait('cancelled worker disappearance', 20_000, async () => {
    const labels = [`io.pw-deploy.instance=${instanceId}`, `io.pw-deploy.job=${cancellationJob.id}`];
    return (await resourceNames('container', labels)).length === 0
      && (await resourceNames('volume', labels)).length === 0;
  });
  await assertNoJobResources(cancellationJob.id);

  const recoveryJob = await submit(controller, payloads.recovery);
  await waitForLog(controller, recoveryJob.id, 'READY_RECOVERY');
  const recoveryWorker = `pw-deploy-job-${recoveryJob.id}-script`;
  assert.equal(await containerStatus(recoveryWorker), 'running');

  await privatePodman([
    'create', '--name', decoyName,
    '--label', `io.pw-deploy.instance=${otherInstanceId}`,
    '--label', `io.pw-deploy.live-fixture=${instanceId}`,
    '--read-only',
    '--user=1001:1001',
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--network=none',
    '--no-healthcheck',
    '--timeout=180',
    '--entrypoint=/usr/bin/sleep',
    '--pull=never',
    imageId, '170',
  ]);
  assert.equal(await exists('container', decoyName), true, `Decoy ${decoyName} was not created`);
  decoyProcess = startOwned(PODMAN, [...privateArgs, 'start', '--attach', decoyName], privateEnv);
  processHandles.add(decoyProcess);
  await wait('the labelled decoy to run', 10_000, async () => (await containerStatus(decoyName)) === 'running');

  await privatePodman(['kill', '--signal', 'KILL', controller.name]);
  await wait('the killed controller to stop', 10_000, async () => {
    const status = await containerStatus(controller.name);
    return status !== 'running' && status !== 'paused';
  });
  await reap(controller.processHandle);
  assert.equal(await containerStatus(recoveryWorker), 'running', 'SIGKILL of the controller must leave a real worker for recovery');
  controller = await startController('b');
  const interrupted = await waitForJob(
    controller, recoveryJob.id, current => TERMINAL.has(current.state),
    'the restarted controller to interrupt the prior job', 45_000,
  );
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.errorCode, 'worker_restarted');
  const recoveryLog = await jobLog(controller, recoveryJob.id);
  assert.equal(recoveryLog.events.filter(event => event.phase === 'deploying').length, 1,
    'restart recovery must not run the deployment script a second time');
  await wait('recovered worker resource cleanup', 20_000, async () => {
    const labels = [`io.pw-deploy.instance=${instanceId}`, `io.pw-deploy.job=${recoveryJob.id}`];
    return (await resourceNames('container', labels)).length === 0
      && (await resourceNames('volume', labels)).length === 0;
  });
  await assertNoJobResources(recoveryJob.id);
  assert.equal(await containerStatus(decoyName), 'running', 'owned-only recovery must not stop another instance');

  await privatePodman(['stop', '--time=3', decoyName], { timeoutMs: 15_000 });
  await wait('the decoy to stop', 10_000, async () => {
    const status = await containerStatus(decoyName);
    return status !== 'running' && status !== 'paused';
  });
  await reap(decoyProcess);
  await privatePodman(['rm', decoyName]);
  assert.equal(await exists('container', decoyName), false, `Decoy ${decoyName} still exists after removal`);
  decoyProcess = undefined;

  for (const logs of controllerLogs) {
    assert.equal(logs.stdout.overflow(), false);
    assert.equal(logs.stderr.overflow(), false);
    assert.equal(logs.stdout.text().includes(syntheticSecret), false);
    assert.equal(logs.stderr.text().includes(syntheticSecret), false);
  }
});
