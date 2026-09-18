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
import { spawnChild, pipeBounded, terminateTransfer, observeProcess, processDeadline } from './container-process.js';

const HEADER_BYTES = 10;
const MAX_REQUEST_FRAME_BYTES = 65536;
const MAX_RESPONSE_BYTES = 262144;
const DEFAULT_SSH_PATH = '/usr/bin/ssh';
const REMOTE_COMMAND = 'pw-deploy-runtime';
const MUTATING_ACTIONS = new Set(['image_tag', 'image_remove_candidate', 'image_import', 'service_restart']);

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
  if (body.length !== Number(header) || body.length > MAX_RESPONSE_BYTES) {
    throw new DeploymentError('Runtime relay response length mismatch', 502, 'runtime_protocol_error');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
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
  terminationOptions,
} = {}) {
  let child, state, scope, upload, size = 0;
  const collected = [];
  const receive = chunk => {
    size += chunk.length;
    if (size > HEADER_BYTES + MAX_RESPONSE_BYTES) {
      scope.abort(new DeploymentError('Runtime relay response exceeded its limit', 502, 'runtime_protocol_error'));
    } else if (!scope.signal.aborted) collected.push(chunk);
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
    const frame = encodeFrame(request);
    const argv = runtimeSshArgv(runtime, sshPath);
    const timeout = MUTATING_ACTIONS.has(request?.action)
      ? new DeploymentError('Runtime mutation outcome is uncertain', 503, 'runtime_mutation_uncertain')
      : new DeploymentError('Runtime connector timed out', 504, 'runtime_unavailable');
    scope = processDeadline(signal, timeoutMs, timeout);
    child = spawnChild(argv[0], argv.slice(1), { env: { PATH: '/usr/bin:/bin' }, spawnProcess });
    state = observeProcess(child);
    child.stderr.resume();
    child.stdout.on('data', receive);
    child.stdin.on('error', () => scope.abort(
      new DeploymentError('Runtime connector input could not be delivered', 502, 'runtime_protocol_error')));
    scope.signal.throwIfAborted();
    let outcome;
    if (ociStream) {
      child.stdin.write(frame);
      let transferred = false;
      upload = pipeBounded(ociStream, child.stdin, maxOciBytes, undefined, { signal: scope.signal })
        .then(() => { transferred = true; });
      const closing = state.promise.then(result => {
        if (!transferred) {
          throw new DeploymentError('Runtime connector closed before image transfer completed', 502, 'runtime_protocol_error');
        }
        return result;
      });
      [, outcome] = await scope.wait(Promise.all([upload, closing]));
    } else {
      child.stdin.end(frame);
      outcome = await scope.wait(state.promise);
    }
    scope.signal.throwIfAborted();
    if (state.error) throw new DeploymentError('Runtime connector could not start', 503, 'runtime_unavailable');
    if (outcome.code !== 0) {
      if (MUTATING_ACTIONS.has(request?.action)) {
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
  } catch (error) {
    scope?.abort(error);
    ociStream?.destroy();
    child?.stdin.destroy();
    if (child) await terminateTransfer([child], upload, terminationOptions);
    if (state?.error) throw new DeploymentError('Runtime connector could not start', 503, 'runtime_unavailable');
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'EPIPE') {
      throw new DeploymentError('Runtime connector closed before image transfer completed', 502, 'runtime_protocol_error');
    }
    throw error;
  } finally {
    scope?.dispose();
    ociStream?.destroy();
    child?.stdout.removeListener('data', receive);
  }
}

let requestCounter = 0;
export function nextRuntimeRequestId(jobId) {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${jobId}-${requestCounter}`;
}
