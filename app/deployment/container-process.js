// Shared, transport-agnostic plumbing for running an external helper process
// (the packaged Podman remote client, or the SSH runtime-relay client)
// without ever building a shell string. Every caller passes an explicit argv
// array; untrusted content only ever crosses through a bounded stdin write or
// a bounded piped stream, never through argv or environment variables.
import { spawn } from 'node:child_process';
import { DeploymentError } from './protocol.js';

const DEFAULT_GRACE_MS = 5000;
const DEFAULT_REAP_MS = 5000;

export function spawnChild(command, args, { env, spawnProcess = spawn } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new DeploymentError('Invalid helper process arguments', 500, 'invalid_process_invocation');
  }
  return spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function waitForClose(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sendSignal(child, signal) {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  let sent;
  try {
    sent = child.kill(signal);
  } catch {
    throw new DeploymentError('Could not terminate helper process', 503, 'cancellation_failed');
  }
  if (sent === false && (child.exitCode === null || child.exitCode === undefined)) {
    throw new DeploymentError('Could not terminate helper process', 503, 'cancellation_failed');
  }
}

// Every process that this boundary starts is either observed to close or
// reported as a failed cancellation. SIGTERM alone is never considered reaped.
export async function terminateAndReap(children, {
  closePromises = new Map(), graceMs = DEFAULT_GRACE_MS, reapMs = DEFAULT_REAP_MS,
} = {}) {
  const unique = [...new Set(children.filter(Boolean))];
  const closings = unique.map(child => closePromises.get(child) ?? waitForClose(child));
  for (const child of unique) sendSignal(child, 'SIGTERM');
  if (!unique.length || await Promise.race([
    Promise.all(closings).then(() => true),
    delay(graceMs).then(() => false),
  ])) return Promise.all(closings);
  for (const child of unique) sendSignal(child, 'SIGKILL');
  if (await Promise.race([
    Promise.all(closings).then(() => true),
    delay(reapMs).then(() => false),
  ])) return Promise.all(closings);
  throw new DeploymentError('Helper process did not stop after cancellation', 503, 'cancellation_failed');
}

// Runs a short-lived helper to completion with bounded stdout capture. Used
// for single-shot Podman remote / SSH relay calls (info, tag, restart,
// inspect, is-active, ...), never for the long-lived pipelines below.
export async function runProcess(command, args, {
  env, spawnProcess, signal, input, onAbort, onStdout, onStderr,
  captureStdout = false, maxStdoutBytes = 65536, allowedExitCodes = [0],
  timeoutMs = 60000, terminationOptions,
  failure = exitCode => new DeploymentError(`Helper process exited with ${exitCode}`, 502, 'step_failed'),
} = {}) {
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  const child = spawnChild(command, args, { env, spawnProcess });
  const close = waitForClose(child);
  const closePromises = new Map([[child, close]]);
  let termination;
  const abort = () => {
    if (termination) return;
    termination = Promise.resolve().then(async () => {
      if (onAbort) await onAbort(child);
      await terminateAndReap([child], { closePromises, ...terminationOptions });
    });
  };
  signal?.addEventListener('abort', abort, { once: true });
  let spawnError, overflow = false, stdoutSize = 0;
  const stdoutChunks = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    onStdout?.(chunk);
    if (!captureStdout || overflow) return;
    stdoutSize += Buffer.byteLength(chunk);
    if (stdoutSize > maxStdoutBytes) {
      overflow = true;
      abort();
    }
    else stdoutChunks.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => onStderr?.(chunk));
  child.on('error', error => { spawnError = error; });
  child.stdin.on('error', () => {}); // surfaced through the exit code, not here
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const timedOut = await Promise.race([
    close.then(() => false),
    delay(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    termination = terminateAndReap([child], { closePromises, ...terminationOptions });
    await termination;
    signal?.removeEventListener('abort', abort);
    throw new DeploymentError('Helper process timed out', 504, 'process_timeout');
  }
  const { code: exitCode, signal: exitSignal } = await close;
  signal?.removeEventListener('abort', abort);
  if (termination) await termination;
  if (spawnError) throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  if (overflow) throw new DeploymentError('Helper process output exceeded its limit', 502, 'process_output_too_large');
  if (!allowedExitCodes.includes(exitCode)) {
    throw failure(exitCode ?? `signal ${exitSignal}`);
  }
  return { exitCode, output: stdoutChunks.join('') };
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
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  const producerExit = waitForClose(producer);
  const consumerExit = waitForClose(consumer);
  const closePromises = new Map([[producer, producerExit], [consumer, consumerExit]]);
  let termination;
  const abort = () => {
    if (!termination) termination = terminateAndReap([producer, consumer], { closePromises, ...terminationOptions });
  };
  signal?.addEventListener('abort', abort, { once: true });
  producer.stderr.setEncoding('utf8');
  producer.stderr.on('data', chunk => onProducerStderr?.(chunk));
  consumer.stderr.setEncoding('utf8');
  consumer.stderr.on('data', chunk => onConsumerStderr?.(chunk));
  // consumer.stdout (e.g. `podman build`'s human-readable log) must always be
  // drained even when the caller does not care about it: an unread pipe
  // fills its OS buffer and deadlocks the consumer once it tries to write
  // past that limit, which would otherwise hang the whole transfer.
  consumer.stdout.setEncoding('utf8');
  consumer.stdout.on('data', chunk => onConsumerStdout?.(chunk));
  let producerSpawnError, consumerSpawnError;
  producer.on('error', error => { producerSpawnError = error; });
  consumer.on('error', error => { consumerSpawnError = error; });
  let transferError;
  try {
    await Promise.race([
      pipeBounded(producer.stdout, consumer.stdin, maxBytes),
      delay(timeoutMs).then(() => { throw new DeploymentError('Artifact transfer timed out', 504, 'artifact_transfer_failed'); }),
    ]);
  } catch (error) {
    transferError = error;
    abort();
  }
  const [{ code: producerCode }, { code: consumerCode }] = termination
    ? await termination
    : await Promise.all([producerExit, consumerExit]);
  signal?.removeEventListener('abort', abort);
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  if (producerSpawnError || consumerSpawnError) {
    throw new DeploymentError('Helper process could not start', 503, 'process_unavailable');
  }
  if (transferError) throw transferError;
  if (producerCode !== 0) throw producerFailure(producerCode);
  if (consumerCode !== 0) throw consumerFailure(consumerCode);
  return { producerCode, consumerCode };
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

function tarHeader(filePath, size, mode, uid, gid) {
  const { name, prefix } = splitTarPath(filePath);
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(tarOctal(mode, 8), 100, 8, 'ascii');
  header.write(tarOctal(uid, 8), 108, 8, 'ascii');
  header.write(tarOctal(gid, 8), 116, 8, 'ascii');
  header.write(tarOctal(size, 12), 124, 12, 'ascii');
  header.write(tarOctal(0, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
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
  for (const file of files) {
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
export function pipeBounded(readable, writable, maxBytes, onChunk) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      readable.removeListener('data', count);
      if (error) { readable.destroy(); writable.destroy(); reject(error); }
      else resolve(value);
    };
    function count(chunk) {
      size += chunk.length;
      onChunk?.(chunk, size);
      if (size > maxBytes) finish(new DeploymentError('Transfer exceeded its size limit', 413, 'artifact_transfer_failed'));
    }
    readable.on('data', count);
    readable.on('error', finish);
    writable.on('error', finish);
    writable.on('finish', () => finish(null, size));
    readable.pipe(writable);
  });
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
