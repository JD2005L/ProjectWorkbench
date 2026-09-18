// SSH client for the runtime-relay connector (deploy/container/runtime-relay.py)
// that runs on the existing application host under the existing non-root
// runtime account. The SSH invocation is fixed: no argv variability, no
// interactive prompts, and it always requests the same forced remote
// command. Requests and responses are exchanged as length-prefixed JSON
// frames; only the image_import action appends a raw, size-bounded OCI byte
// stream after its request frame. This module never shells out to anything
// other than the pinned ssh binary, and never logs request or response
// bodies (they may carry resource names and health data, not secrets, but
// are kept out of persistent logs regardless).
import { DeploymentError } from './protocol.js';
import { spawnChild, pipeBounded, terminateAndReap } from './container-process.js';

const HEADER_BYTES = 10;
const MAX_REQUEST_FRAME_BYTES = 65536;
const MAX_RESPONSE_BYTES = 262144;
const DEFAULT_SSH_PATH = '/usr/bin/ssh';
const REMOTE_COMMAND = 'pw-deploy-runtime';

const KNOWN_ERROR_CODES = new Set([
  'invalid_request', 'action_not_allowed', 'resource_not_allowed', 'resource_conflict',
  'runtime_policy_invalid', 'health_host_not_allowed', 'health_failed', 'invalid_image',
  'process_failed', 'privilege_refused',
]);

export function runtimeSshArgv(runtime, sshPath = DEFAULT_SSH_PATH) {
  if (!runtime || typeof runtime !== 'object') {
    throw new DeploymentError('Runtime connection is not configured', 500, 'runtime_unavailable');
  }
  const { host, port, user, keyFile, knownHostsFile } = runtime;
  if (typeof host !== 'string' || !host || typeof user !== 'string' || !user
      || typeof keyFile !== 'string' || !keyFile || typeof knownHostsFile !== 'string' || !knownHostsFile
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DeploymentError('Runtime connection is not configured', 500, 'runtime_unavailable');
  }
  return [
    sshPath,
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=no',
    '-o', 'ProxyCommand=none',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-i', keyFile,
    '-p', String(port),
    '-l', user,
    host,
    REMOTE_COMMAND,
  ];
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_REQUEST_FRAME_BYTES) {
    throw new DeploymentError('Runtime relay request is too large', 500, 'runtime_protocol_error');
  }
  return Buffer.concat([Buffer.from(String(body.length).padStart(HEADER_BYTES, '0'), 'ascii'), body]);
}

function decodeFrame(buffer) {
  if (buffer.length < HEADER_BYTES) {
    throw new DeploymentError('Runtime relay response was truncated', 502, 'runtime_protocol_error');
  }
  const header = buffer.subarray(0, HEADER_BYTES).toString('ascii');
  if (!/^\d{10}$/.test(header)) {
    throw new DeploymentError('Runtime relay response framing is invalid', 502, 'runtime_protocol_error');
  }
  const body = buffer.subarray(HEADER_BYTES);
  if (body.length !== Number(header)) {
    throw new DeploymentError('Runtime relay response length mismatch', 502, 'runtime_protocol_error');
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new DeploymentError('Runtime relay response was not valid JSON', 502, 'runtime_protocol_error');
  }
}

// Sends one bounded request/response exchange to the runtime connector over
// a single fixed SSH invocation. `ociStream`, when present, is piped
// straight through to the remote process after the JSON frame; it is never
// buffered whole in this process.
export async function runtimeRequest(runtime, request, {
  signal, ociStream, maxOciBytes = 2 * 1024 * 1024 * 1024, spawnProcess, sshPath, timeoutMs = 60000,
} = {}) {
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  const argv = runtimeSshArgv(runtime, sshPath);
  const child = spawnChild(argv[0], argv.slice(1), { env: { PATH: '/usr/bin:/bin' }, spawnProcess });

  let spawnError;
  child.on('error', error => { spawnError = error; });
  const close = new Promise(resolve => child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal })));
  const closePromises = new Map([[child, close]]);
  child.stderr.resume(); // drained but discarded: never surfaced to logs verbatim

  const collected = [];
  let size = 0, overflow = false;
  let abort = () => {};
  child.stdout.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      overflow = true;
      abort();
    }
    else collected.push(chunk);
  });

  let termination;
  abort = () => {
    if (!termination) termination = terminateAndReap([child], { closePromises });
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    child.stdin.on('error', () => {});
    child.stdin.write(encodeFrame(request));
    if (ociStream) {
      await Promise.race([
        pipeBounded(ociStream, child.stdin, maxOciBytes),
        close.then(() => {
          throw new DeploymentError('Runtime connector closed before image transfer completed', 502, 'runtime_protocol_error');
        }),
      ]);
    }
    else child.stdin.end();
  } catch (error) {
    abort();
    await termination;
    signal?.removeEventListener('abort', abort);
    throw error;
  }

  const timedOut = await Promise.race([
    close.then(() => false),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timedOut) {
    abort();
    await termination;
    signal?.removeEventListener('abort', abort);
    if (new Set(['image_tag', 'image_remove_candidate', 'image_import', 'service_restart']).has(request?.action)) {
      throw new DeploymentError('Runtime mutation outcome is uncertain', 503, 'runtime_mutation_uncertain');
    }
    throw new DeploymentError('Runtime connector timed out', 504, 'runtime_unavailable');
  }
  const { code: exitCode } = await close;
  signal?.removeEventListener('abort', abort);
  if (termination) await termination;
  if (spawnError) throw new DeploymentError('Runtime connector could not start', 503, 'runtime_unavailable');
  if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
  if (overflow) throw new DeploymentError('Runtime relay response exceeded its limit', 502, 'runtime_protocol_error');
  if (exitCode !== 0) {
    const mutating = new Set(['image_tag', 'image_remove_candidate', 'image_import', 'service_restart']);
    if (mutating.has(request?.action)) {
      throw new DeploymentError('Runtime mutation outcome is uncertain', 503, 'runtime_mutation_uncertain');
    }
    throw new DeploymentError('Runtime connector could not reach the runtime host', 503, 'runtime_unavailable');
  }

  const value = decodeFrame(Buffer.concat(collected));
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') {
    throw new DeploymentError('Runtime relay returned an invalid response', 502, 'runtime_protocol_error');
  }
  if (!value.ok) {
    const code = typeof value.code === 'string' && KNOWN_ERROR_CODES.has(value.code) ? value.code : 'runtime_protocol_error';
    const message = typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 500
      ? value.error : 'Runtime connector refused the request';
    throw new DeploymentError(message, 502, code);
  }
  if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    throw new DeploymentError('Runtime relay returned an invalid result', 502, 'runtime_protocol_error');
  }
  return value.result;
}

let requestCounter = 0;
export function nextRuntimeRequestId(jobId) {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${jobId}-${requestCounter}`;
}
