// Shared, transport-agnostic plumbing for running an external helper process
// (the packaged Podman remote client, or the SSH runtime-relay client)
// without ever building a shell string. Every caller passes an explicit argv
// array; untrusted content only ever crosses through a bounded stdin write or
// a bounded piped stream, never through argv or environment variables.
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeploymentError } from './protocol.js';

const DEFAULT_GRACE_MS = 5000;
const DEFAULT_REAP_MS = 5000;
const observations = new WeakMap();

export function observeProcess(child) {
  if (observations.has(child)) return observations.get(child);
  let resolve;
  const state = { closed: false, error: null, promise: new Promise(done => { resolve = done; }) };
  const finish = (code, signal) => {
    if (state.closed) return;
    state.closed = true;
    resolve({ code, signal });
  };
  child.once('error', error => {
    state.error = error;
    if (!child.pid) finish(null, null);
  });
  child.once('close', finish);
  observations.set(child, state);
  return state;
}

export function spawnChild(command, args, { env, spawnProcess = spawn } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new DeploymentError('Invalid helper process arguments', 500, 'invalid_process_invocation');
  }
  const child = spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  observeProcess(child);
  return child;
}

async function settledWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function processDeadline(signal, timeoutMs, timeoutError) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new DeploymentError('Invalid helper deadline', 500, 'invalid_process_invocation');
  }
  const controller = new AbortController();
  const stopped = new Promise(resolve => controller.signal.addEventListener('abort',
    () => resolve(controller.signal.reason), { once: true }));
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const onAbort = () => abort(signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled'));
  const timer = setTimeout(() => abort(timeoutError), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    signal: controller.signal, abort,
    wait: promise => Promise.race([promise, stopped.then(error => { throw error; })]),
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

// Every process that this boundary starts is either observed to close or
// reported as a failed cancellation. SIGTERM alone is never considered reaped.
export async function terminateAndReap(children, {
  closePromises = new Map(), graceMs = DEFAULT_GRACE_MS, reapMs = DEFAULT_REAP_MS,
} = {}) {
  const unique = [...new Set(children.filter(Boolean))];
  const closings = unique.map(child => closePromises.get(child) ?? observeProcess(child).promise);
  const failures = [];
  const send = signal => {
    for (const child of unique) {
      if (observeProcess(child).closed || child.exitCode != null || child.signalCode != null) continue;
      try {
        if (child.kill(signal) === false) failures.push(new Error(`Helper refused ${signal}`));
      } catch (error) { failures.push(error); }
    }
  };
  const closed = Promise.all(closings);
  send('SIGTERM');
  if (!unique.length || await settledWithin(closed, graceMs)) return closed;
  send('SIGKILL');
  if (await settledWithin(closed, reapMs)) return closed;
  const failure = new DeploymentError('Helper process did not stop after cancellation', 503, 'cancellation_failed');
  if (failures.length) failure.cause = new AggregateError(failures, 'Helper termination failed');
  throw failure;
}

export async function terminateTransfer(children, transfer, options = {}) {
  const outcomes = Promise.allSettled([terminateAndReap(children, options), transfer]);
  const budget = (options.graceMs ?? DEFAULT_GRACE_MS) + (options.reapMs ?? DEFAULT_REAP_MS) + 1000;
  if (!(await settledWithin(outcomes, budget))) {
    throw new DeploymentError('Transfer cleanup did not complete', 503, 'cancellation_failed');
  }
  const [reaped] = await outcomes;
  if (reaped.status === 'rejected') throw reaped.reason;
}

// Runs a short-lived helper to completion with bounded stdout capture. Used
// for single-shot Podman remote / SSH relay calls (info, tag, restart,
// inspect, is-active, ...), never for the long-lived pipelines below.
export async function runProcess(command, args, {
  env, spawnProcess, signal, input, onAbort, onStdout, onStderr,
  captureStdout = false, maxStdoutBytes = 65536, allowedExitCodes = [0],
  timeoutMs = 60000, terminationOptions, onAbortTimeoutMs = 30000,
  failure = exitCode => new DeploymentError(`Helper process exited with ${exitCode}`, 502, 'step_failed'),
} = {}) {
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  const scope = processDeadline(signal, timeoutMs,
    new DeploymentError('Helper process timed out', 504, 'process_timeout'));
  let child, state, stdoutSize = 0;
  const stdoutChunks = [];
  const output = chunk => {
    try {
      onStdout?.(chunk);
      if (!captureStdout || scope.signal.aborted) return;
      stdoutSize += Buffer.byteLength(chunk);
      if (stdoutSize > maxStdoutBytes) {
        scope.abort(new DeploymentError('Helper process output exceeded its limit', 502, 'process_output_too_large'));
      } else stdoutChunks.push(chunk);
    } catch (error) { scope.abort(error); }
  };
  const stderr = chunk => {
    try { onStderr?.(chunk); } catch (error) { scope.abort(error); }
  };
  const inputError = () => {
    if (input !== undefined && input.length) {
      scope.abort(new DeploymentError('Helper input could not be delivered', 502, 'artifact_transfer_failed'));
    }
  };
  try {
    child = spawnChild(command, args, { env, spawnProcess });
    state = observeProcess(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', output);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', stderr);
    child.stdin.on('error', inputError);
    scope.signal.throwIfAborted();
    child.stdin.end(input);
    const { code: exitCode, signal: exitSignal } = await scope.wait(state.promise);
    scope.signal.throwIfAborted();
    if (state.error) throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
    if (!allowedExitCodes.includes(exitCode)) throw failure(exitCode ?? `signal ${exitSignal}`);
    return { exitCode, output: stdoutChunks.join('') };
  } catch (error) {
    if (child && (!state.closed || scope.signal.aborted)) {
      const cleanup = [terminateAndReap([child], terminationOptions)];
      if (onAbort) cleanup.push((async () => {
        if (!(await settledWithin(Promise.resolve().then(() => onAbort(child)), onAbortTimeoutMs))) {
          throw new DeploymentError('Owned execution cleanup timed out', 503, 'cancellation_failed');
        }
      })());
      const results = await Promise.allSettled(cleanup);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) {
        const failed = new DeploymentError('Could not confirm owned execution stopped', 503, 'cancellation_failed');
        failed.cause = new AggregateError(errors, 'Execution cleanup failed');
        throw failed;
      }
    }
    throw error;
  } finally {
    scope.dispose();
    child?.stdout.removeListener('data', output);
    child?.stderr.removeListener('data', stderr);
  }
}

// Wires producer.stdout straight into consumer.stdin without ever buffering
// the transfer in this process (a populated build context or an OCI image
// archive can be far larger than any single captured response). Used for the
// worker-cp-out -> build-stdin and save-stdout -> ssh-relay-stdin pipelines.
export async function pipeProcesses(producer, consumer, {
  signal, maxBytes = 512 * 1024 * 1024, onProducerStderr, onConsumerStderr, onConsumerStdout,
  timeoutMs = 10 * 60 * 1000, terminationOptions,
  producerFailure = () => new DeploymentError('Source transfer failed', 502, 'artifact_transfer_failed'),
  consumerFailure = () => new DeploymentError('Destination process failed', 502, 'step_failed'),
} = {}) {
  const producerState = observeProcess(producer);
  const consumerState = observeProcess(consumer);
  let scope, transfer;
  const outputs = [];
  const drain = (stream, callback) => {
    const listener = chunk => {
      try { callback?.(chunk); } catch (error) { scope.abort(error); }
    };
    stream.setEncoding('utf8');
    stream.on('data', listener);
    outputs.push([stream, listener]);
  };
  try {
    scope = processDeadline(signal, timeoutMs,
      new DeploymentError('Artifact transfer timed out', 504, 'artifact_transfer_failed'));
    scope.signal.throwIfAborted();
    drain(producer.stderr, onProducerStderr);
    drain(consumer.stderr, onConsumerStderr);
    drain(consumer.stdout, onConsumerStdout);
    const checked = (state, failed) => state.promise.then(result => {
      if (state.error) throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
      if (result.code !== 0) throw failed(result.code);
      return result;
    });
    transfer = pipeBounded(producer.stdout, consumer.stdin, maxBytes, undefined, { signal: scope.signal });
    const [, produced, consumed] = await scope.wait(Promise.all([
      transfer, checked(producerState, producerFailure), checked(consumerState, consumerFailure),
    ]));
    scope.signal.throwIfAborted();
    if (producerState.error || consumerState.error) {
      throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
    }
    if (produced.code !== 0) throw producerFailure(produced.code);
    if (consumed.code !== 0) throw consumerFailure(consumed.code);
    return { producerCode: produced.code, consumerCode: consumed.code };
  } catch (error) {
    scope?.abort(error);
    producer.stdout.destroy();
    consumer.stdin.destroy();
    await terminateTransfer([producer, consumer], transfer, terminationOptions);
    if (producerState.error || consumerState.error) {
      throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
    }
    throw error;
  } finally {
    scope?.dispose();
    for (const [stream, listener] of outputs) stream.removeListener('data', listener);
  }
}

const TAR_BLOCK = 512;

function tarOctal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) throw new DeploymentError('Path or size is too large to package', 500, 'artifact_transfer_failed');
  return `${text.padStart(length - 1, '0')}\0`;
}

function splitTarPath(filePath) {
  if (Buffer.byteLength(filePath) <= 100) return { name: filePath, prefix: '' };
  const parts = filePath.split('/');
  for (let split = parts.length - 1; split > 0; split--) {
    const prefix = parts.slice(0, split).join('/');
    const name = parts.slice(split).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new DeploymentError('Source path is too long to package', 400, 'artifact_transfer_failed');
}

function tarHeader(filePath, size, mode, uid, gid, type = '0') {
  const { name, prefix } = splitTarPath(filePath);
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(tarOctal(mode, 8), 100, 8, 'ascii');
  header.write(tarOctal(uid, 8), 108, 8, 'ascii');
  header.write(tarOctal(gid, 8), 116, 8, 'ascii');
  header.write(tarOctal(size, 12), 124, 12, 'ascii');
  header.write(tarOctal(0, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index++) sum += header[index];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

// Builds a minimal POSIX ustar archive from already-validated source file
// records ({path, data (base64), executable}), with no dependency beyond
// node:buffer. Used both to seed a worker's workspace volume (`podman cp -`)
// and, when no dependency install is needed, as a build context piped
// directly into `podman build -f Dockerfile -`.
export function buildTarArchive(files, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DeploymentError('Tar ownership is invalid', 400, 'artifact_transfer_failed');
  }
  const { uid = 0, gid = 0 } = options;
  for (const value of [uid, gid]) {
    if (!Number.isInteger(value) || value < 0 || value > 0o7777777) {
      throw new DeploymentError('Tar ownership is invalid', 400, 'artifact_transfer_failed');
    }
  }
  const parts = [];
  const directories = new Set();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      const directory = segments.slice(0, end).join('/');
      if (directories.has(directory)) continue;
      parts.push(tarHeader(directory, 0, 0o755, uid, gid, '5'));
      directories.add(directory);
    }
    const content = Buffer.from(file.data, 'base64');
    parts.push(tarHeader(file.path, content.length, file.executable ? 0o755 : 0o644, uid, gid));
    parts.push(content);
    const padding = (TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

// Streams a producer's stdout directly into a consumer's stdin without ever
// buffering the whole transfer in the controller (a build context tar or an
// OCI image archive can be far larger than any single captured response).
export async function pipeBounded(readable, writable, maxBytes, onChunk, { signal } = {}) {
  let size = 0;
  const count = new Transform({
    transform(chunk, encoding, callback) {
      try {
        size += Buffer.byteLength(chunk, encoding);
        if (size > maxBytes) {
          throw new DeploymentError('Transfer exceeded its size limit', 413, 'artifact_transfer_failed');
        }
        onChunk?.(chunk, size);
        callback(null, chunk);
      } catch (error) { callback(error); }
    },
  });
  try {
    await pipeline(readable, count, writable, { signal });
    return size;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

// Confirms a Podman-managed resource actually stopped before the caller
// proceeds to remove or reuse it. Mirrors executor.js's stopUnit contract:
// silence after the stop attempt is never treated as success.
export async function confirmStopped(check, { attempts = 10, delayMs = 200 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new DeploymentError('Could not confirm the deployment resource stopped', 503, 'cancellation_failed');
}
