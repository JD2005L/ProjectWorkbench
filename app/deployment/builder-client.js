import path from 'node:path';
import { DeploymentError } from './protocol.js';
import { connectorRequest, connectorSshArgv, nextConnectorRequestId } from './connector-client.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function requireResult(condition) {
  if (!condition) throw new DeploymentError('Builder connector returned an invalid ownership or lifetime result', 502, 'builder_protocol_error');
}

export function builderUnitName(instanceId, jobId) {
  requireResult(UUID.test(instanceId) && UUID.test(jobId));
  return `pw-deploy-build-${instanceId.replaceAll('-', '')}-${jobId}.service`;
}

export function builderSshArgv(connection, sshPath) {
  return connectorSshArgv('builder', connection, sshPath);
}

export function builderRequest(connection, request, options) {
  return connectorRequest('builder', connection, request, options);
}

export function validateBuilderResult(config, request, result) {
  const instanceId = config.container.instanceId;
  requireResult(result && typeof result === 'object' && !Array.isArray(result)
    && result.instanceId === instanceId);
  if (request.action === 'builder_probe') {
    requireResult(result.ready === true);
    return result;
  }
  const unit = builderUnitName(instanceId, request.jobId);
  requireResult(result.jobId === request.jobId && (result.unit === undefined || result.unit === unit));
  if (request.action === 'job_start') {
    requireResult(result.unit === unit && result.running === true
      && result.deadlineAt === request.deadlineAt && result.socketDirectory === request.jobId);
    const cgroup = result.cgroupParent;
    requireResult(typeof cgroup === 'string' && cgroup.length <= 1024 && path.posix.normalize(cgroup) === cgroup);
    const ownedPath = new RegExp(`^/user\\.slice/user-([1-9][0-9]*)\\.slice/user@\\1\\.service/`
      + `(?:[A-Za-z0-9_.@:-]+/)*${unit.replaceAll('.', '\\.')}/payload$`);
    requireResult(ownedPath.test(cgroup));
    requireResult(typeof config.container.builderJobSockets === 'string'
      && path.posix.isAbsolute(config.container.builderJobSockets));
    return {
      ...result,
      socket: path.posix.join(config.container.builderJobSockets, request.jobId, 'api.sock'),
    };
  }
  if (request.action === 'job_status') {
    requireResult(result.unit === unit && typeof result.running === 'boolean' && typeof result.stopped === 'boolean'
      && !(result.running && result.stopped));
  } else if (request.action === 'job_stop' || request.action === 'job_remove') {
    requireResult(result.stopped === true && (request.action !== 'job_remove' || result.removed === true));
  } else requireResult(false);
  return result;
}

export class SupervisedBuilder {
  constructor(config, { spawnProcess, now = () => Date.now() } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.jobs = new Map();
  }

  has(jobId) { return this.jobs.has(jobId); }

  async request(action, jobId, properties, signal, timeoutMs = 30000) {
    const request = {
      requestId: nextConnectorRequestId(jobId ?? this.config.container.instanceId),
      action, ...(jobId ? { jobId } : {}), ...properties,
    };
    const result = await builderRequest(this.config.container.builderControl, request, {
      signal, timeoutMs, spawnProcess: this.spawnProcess,
    });
    return validateBuilderResult(this.config, request, result);
  }

  async probe(signal) {
    return this.request('builder_probe', undefined, {}, signal);
  }

  async start(control) {
    builderUnitName(this.config.container.instanceId, control.jobId);
    if (this.jobs.has(control.jobId)) {
      throw new DeploymentError('Isolated deployment builder already exists', 409, 'resource_conflict');
    }
    const deadlineAt = control.deadlineAt ?? this.now() + control.policy.timeoutSeconds * 1000;
    const remaining = deadlineAt - this.now();
    if (!Number.isSafeInteger(deadlineAt) || remaining <= 0) {
      throw new DeploymentError('Deployment deadline expired before builder startup', 504, 'timeout');
    }
    const state = { stopped: false };
    this.jobs.set(control.jobId, state);
    try {
      state.lease = await this.request('job_start', control.jobId, {
        deadlineAt,
        memoryMiB: this.config.container.maxMemoryMiB,
        pids: this.config.container.maxPids,
      }, control.signal, Math.min(30000, remaining));
      control.signal.throwIfAborted();
      return state.lease;
    } catch (error) {
      await this.stop(control.jobId);
      throw error;
    }
  }

  lease(jobId) {
    const state = this.jobs.get(jobId);
    if (!state?.lease || state.stopped) {
      throw new DeploymentError('The isolated deployment builder is not running', 503, 'builder_unavailable');
    }
    return state.lease;
  }

  socket(control) {
    if (control?.builderJob || this.has(control?.jobId)) return this.lease(control.jobId).socket;
    return this.config.container.builderSocket;
  }

  cgroupArgs(control) {
    if (!control?.builderJob && !this.has(control?.jobId)) return [];
    return [`--cgroup-parent=${this.lease(control.jobId).cgroupParent}`];
  }

  async stop(jobId) {
    builderUnitName(this.config.container.instanceId, jobId);
    let state = this.jobs.get(jobId);
    if (!state) {
      state = { stopped: false };
      this.jobs.set(jobId, state);
    }
    if (state.stopped) return;
    if (state.stopping) return state.stopping;
    const stopping = (async () => {
      try {
        await this.request('job_stop', jobId, {}, AbortSignal.timeout(30000));
        state.stopped = true;
      } catch (error) {
        const failure = new DeploymentError('Could not confirm the isolated build backend stopped', 503, 'cancellation_failed');
        failure.cause = error;
        throw failure;
      }
    })();
    state.stopping = stopping;
    try { await stopping; }
    finally { if (state.stopping === stopping) delete state.stopping; }
  }

  async remove(jobId, signal = AbortSignal.timeout(30000)) {
    await this.stop(jobId);
    try {
      await this.request('job_remove', jobId, {}, signal);
      this.jobs.delete(jobId);
    } catch (error) {
      const failure = new DeploymentError('Isolated build cleanup could not be confirmed', 503, 'cancellation_failed');
      failure.cause = error;
      throw failure;
    }
  }
}
