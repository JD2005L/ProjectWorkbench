// Both connectors use fixed SSH commands and the same bounded, supervised
// exchange. Only the runtime connector accepts an appended OCI byte stream.
import { DeploymentError } from './protocol.js';
import { spawnChild, pipeBounded, terminateTransfer, observeProcess, processDeadline } from './container-process.js';

const HEADER_BYTES = 10;
const MAX_REQUEST_FRAME_BYTES = 65536;
const MAX_RESPONSE_BYTES = 262144;
const DEFAULT_SSH_PATH = '/usr/bin/ssh';
const CONNECTORS = {
  runtime: {
    name: 'Runtime', command: 'pw-deploy-runtime',
    mutating: new Set(['image_tag', 'image_remove_candidate', 'image_import', 'service_restart']),
  },
  builder: {
    name: 'Builder', command: 'pw-deploy-builder',
    mutating: new Set(['job_start', 'job_stop', 'job_remove']),
  },
};

const KNOWN_ERROR_CODES = new Set([
  'invalid_request', 'action_not_allowed', 'resource_not_allowed', 'resource_conflict',
  'runtime_policy_invalid', 'builder_policy_invalid', 'health_host_not_allowed', 'health_target_not_allowed', 'health_failed', 'invalid_image',
  'process_failed', 'privilege_refused', 'cancelled',
]);

function connectorSpec(kind) {
  if (!Object.hasOwn(CONNECTORS, kind)) {
    throw new DeploymentError('Unknown deployment connector', 500, 'invalid_configuration');
  }
  return { ...CONNECTORS[kind], kind };
}

export function connectorSshArgv(kind, runtime, sshPath = DEFAULT_SSH_PATH) {
  const spec = connectorSpec(kind);
  if (!runtime || typeof runtime !== 'object') {
    throw new DeploymentError(`${spec.name} connection is not configured`, 500, `${kind}_unavailable`);
  }
  const { host, port, user, keyFile, knownHostsFile } = runtime;
  if (typeof host !== 'string' || !host || typeof user !== 'string' || !user
      || typeof keyFile !== 'string' || !keyFile || typeof knownHostsFile !== 'string' || !knownHostsFile
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DeploymentError(`${spec.name} connection is not configured`, 500, `${kind}_unavailable`);
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
    spec.command,
  ];
}

function encodeFrame(payload, spec) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_REQUEST_FRAME_BYTES) {
    throw new DeploymentError(`${spec.name} relay request is too large`, 500, `${spec.kind}_protocol_error`);
  }
  return Buffer.concat([Buffer.from(String(body.length).padStart(HEADER_BYTES, '0'), 'ascii'), body]);
}

function decodeFrame(buffer, spec) {
  if (buffer.length < HEADER_BYTES) {
    throw new DeploymentError(`${spec.name} relay response was truncated`, 502, `${spec.kind}_protocol_error`);
  }
  const header = buffer.subarray(0, HEADER_BYTES).toString('ascii');
  if (!/^\d{10}$/.test(header)) {
    throw new DeploymentError(`${spec.name} relay response framing is invalid`, 502, `${spec.kind}_protocol_error`);
  }
  const body = buffer.subarray(HEADER_BYTES);
  if (body.length !== Number(header) || body.length > MAX_RESPONSE_BYTES) {
    throw new DeploymentError(`${spec.name} relay response length mismatch`, 502, `${spec.kind}_protocol_error`);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new DeploymentError(`${spec.name} relay response was not valid JSON`, 502, `${spec.kind}_protocol_error`);
  }
}

// Sends one bounded request/response exchange to the runtime connector over
// a single fixed SSH invocation. `ociStream`, when present, is piped
// straight through to the remote process after the JSON frame; it is never
// buffered whole in this process.
export async function connectorRequest(kind, runtime, request, {
  signal, ociStream, maxOciBytes = 2 * 1024 * 1024 * 1024, spawnProcess, sshPath, timeoutMs = 60000,
  terminationOptions,
} = {}) {
  const spec = connectorSpec(kind);
  let child, state, scope, upload, size = 0;
  const collected = [];
  const receive = chunk => {
    size += chunk.length;
    if (size > HEADER_BYTES + MAX_RESPONSE_BYTES) {
      scope.abort(new DeploymentError(`${spec.name} relay response exceeded its limit`, 502, `${kind}_protocol_error`));
    } else if (!scope.signal.aborted) collected.push(chunk);
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new DeploymentError('Deployment cancelled', 409, 'cancelled');
    if (kind !== 'runtime' && ociStream) {
      throw new DeploymentError('Builder control does not accept artifact input', 500, 'builder_protocol_error');
    }
    const frame = encodeFrame(request, spec);
    const argv = connectorSshArgv(kind, runtime, sshPath);
    const timeout = spec.mutating.has(request?.action)
      ? new DeploymentError(`${spec.name} mutation outcome is uncertain`, 503, `${kind}_mutation_uncertain`)
      : new DeploymentError(`${spec.name} connector timed out`, 504, `${kind}_unavailable`);
    scope = processDeadline(signal, timeoutMs, timeout);
    child = spawnChild(argv[0], argv.slice(1), { env: { PATH: '/usr/bin:/bin' }, spawnProcess });
    state = observeProcess(child);
    child.stderr.resume();
    child.stdout.on('data', receive);
    child.stdin.on('error', () => scope.abort(
      new DeploymentError(`${spec.name} connector input could not be delivered`, 502, `${kind}_protocol_error`)));
    scope.signal.throwIfAborted();
    let outcome;
    if (ociStream) {
      child.stdin.write(frame);
      let transferred = false;
      upload = pipeBounded(ociStream, child.stdin, maxOciBytes, undefined, { signal: scope.signal })
        .then(() => { transferred = true; });
      const closing = state.promise.then(result => {
        if (!transferred) {
          throw new DeploymentError(`${spec.name} connector closed before image transfer completed`, 502, `${kind}_protocol_error`);
        }
        return result;
      });
      [, outcome] = await scope.wait(Promise.all([upload, closing]));
    } else {
      child.stdin.end(frame);
      outcome = await scope.wait(state.promise);
    }
    scope.signal.throwIfAborted();
    if (state.error) throw new DeploymentError(`${spec.name} connector could not start`, 503, `${kind}_unavailable`);
    if (outcome.code !== 0) {
      if (spec.mutating.has(request?.action)) {
        throw new DeploymentError(`${spec.name} mutation outcome is uncertain`, 503, `${kind}_mutation_uncertain`);
      }
      throw new DeploymentError(`${spec.name} connector could not reach the ${kind} host`, 503, `${kind}_unavailable`);
    }
    const value = decodeFrame(Buffer.concat(collected), spec);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') {
      throw new DeploymentError(`${spec.name} relay returned an invalid response`, 502, `${kind}_protocol_error`);
    }
    if (!value.ok) {
      const code = typeof value.code === 'string' && KNOWN_ERROR_CODES.has(value.code) ? value.code : `${kind}_protocol_error`;
      const message = typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 500
        ? value.error : `${spec.name} connector refused the request`;
      throw new DeploymentError(message, 502, code);
    }
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw new DeploymentError(`${spec.name} relay returned an invalid result`, 502, `${kind}_protocol_error`);
    }
    return value.result;
  } catch (error) {
    scope?.abort(error);
    ociStream?.destroy();
    child?.stdin.destroy();
    if (child) await terminateTransfer([child], upload, terminationOptions);
    if (state?.error) throw new DeploymentError(`${spec.name} connector could not start`, 503, `${kind}_unavailable`);
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'EPIPE') {
      throw new DeploymentError(`${spec.name} connector closed before image transfer completed`, 502, `${kind}_protocol_error`);
    }
    throw error;
  } finally {
    scope?.dispose();
    ociStream?.destroy();
    child?.stdout.removeListener('data', receive);
  }
}

let requestCounter = 0;
export function nextConnectorRequestId(jobId) {
  requestCounter = (requestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${jobId}-${requestCounter}`;
}
