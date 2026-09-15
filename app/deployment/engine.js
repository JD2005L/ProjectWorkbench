import crypto from 'node:crypto';
import {
  DeploymentError, TERMINAL_STATES, MAX_SOURCE_BYTES, validateJob, publicJob,
  projectName, targetName, targetKey, record,
} from './protocol.js';
import { resolveJobPolicy, validateSettings, validateTargetSettings } from './policy.js';
import { lineRedactor } from './output.js';

function fingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify({
    project: request.project, target: request.target, revision: request.revision,
    digest: request.source.sha256, script: request.script, versionCommand: request.versionCommand,
    environment: request.environment, recipe: request.recipe,
  })).digest('hex');
}

export function deploymentVersion(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128
      || !/^(?:[a-f0-9]{7,64}|V?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?)$/.test(value)) {
    throw new DeploymentError('Deployment returned an invalid version', 502, 'invalid_version');
  }
  return value;
}

export class DeploymentEngine {
  constructor({ config, store, executor, now = () => new Date(), onFatal = () => {} }) {
    this.config = config;
    this.store = store;
    this.executor = executor;
    this.now = now;
    this.onFatal = onFatal;
    this.jobs = new Map();
    this.requests = new Map();
    this.idempotency = new Map();
    this.active = new Map();
    this.locks = new Set();
    this.live = new Map();
    this.queue = [];
    this.stopping = false;
    this.pumping = false;
    this.settingsWrites = Promise.resolve();
    this.submissions = Promise.resolve();
    this.completionOrder = 0;
  }

  async init() {
    await this.store.init();
    this.settings = validateSettings(await this.store.readSetting('settings', {}), this.config.defaults);
    this.targets = await this.store.readSetting('targets', {});
    if (!record(this.targets)) throw new DeploymentError('Invalid target settings', 503, 'invalid_state');
    for (const [key, value] of Object.entries(this.targets)) {
      const [project, target, extra] = key.split('/');
      if (extra !== undefined || targetKey(project, target) !== key) throw new DeploymentError('Invalid stored target');
      this.targets[key] = validateTargetSettings(value);
    }
    for (const job of await this.store.loadJobs()) {
      targetKey(job.project, job.target);
      this.completionOrder = Math.max(this.completionOrder, job.completionOrder || 0);
      this.jobs.set(job.id, job);
      this.idempotency.set(job.requestId, job.id);
      const terminal = TERMINAL_STATES.has(job.state);
      const cleanupPending = job.phase !== 'recovery_complete' && (job.errorCode === 'cancellation_failed'
        || job.events.some(event => ['cleanup_deferred', 'cleanup_failed'].includes(event.phase)));
      if (terminal && cleanupPending) {
        if (!this.executor.recover) throw new DeploymentError('Executor cannot recover deferred cleanup', 503, 'recovery_unavailable');
        await this.executor.recover(job, this.store.jobDirectory(job.id));
        await this.event(job, 'recovery_complete');
      }
      if (!terminal) {
        await this.executor.recover?.(job, this.store.jobDirectory(job.id));
        job.state = 'interrupted';
        job.errorCode = 'worker_restarted';
        job.finishedAt = this.now().toISOString();
        await this.event(job, 'interrupted', { code: 'worker_restarted' });
      }
    }
    await this.prune();
  }

  async event(job, phase, { code, state } = {}) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(phase)) throw new DeploymentError('Invalid worker phase');
    if (code !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(code)) throw new DeploymentError('Invalid worker event code');
    job.phase = phase;
    const event = { seq: ++job.lastSeq, at: this.now().toISOString(), phase };
    if (code) event.code = code;
    if (state || job.state) event.state = state || job.state;
    job.events.push(event);
    if (job.events.length > 2048) job.events.shift();
    try { await this.store.saveJob(job); }
    catch (error) { this.failClosed(error); throw error; }
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new DeploymentError('Deployment job not found', 404, 'job_not_found');
    return job;
  }

  list({ project, target, limit = 50 } = {}) {
    if (project !== undefined) projectName(project);
    if (target !== undefined) targetName(target);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DeploymentError('Invalid job limit');
    return [...this.jobs.values()]
      .filter(job => (!project || job.project === project) && (!target || job.target === target))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit).map(publicJob);
  }

  logs(id, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new DeploymentError('Invalid log cursor');
    const job = this.get(id);
    return {
      events: job.events.filter(event => event.seq > after),
      live: (this.live.get(id) || []).filter(event => event.seq > after),
      nextSeq: Math.max(after, job.lastSeq),
    };
  }

  version(project, target) {
    targetKey(project, target);
    const job = [...this.jobs.values()].filter(item => item.project === project
      && item.target === target && item.state === 'succeeded')
      .sort((a, b) => (b.completionOrder || 0) - (a.completionOrder || 0)
        || b.finishedAt.localeCompare(a.finishedAt))[0];
    return { version: job?.version || null, revision: job?.revision || null, deployedAt: job?.finishedAt || null };
  }

  targetList() {
    const targets = new Map();
    for (const job of this.jobs.values()) {
      targets.set(targetKey(job.project, job.target), { project: job.project, target: job.target, adapter: job.adapter });
    }
    for (const key of Object.keys(this.targets)) {
      const [project, target] = key.split('/');
      if (!targets.has(key)) targets.set(key, { project, target });
    }
    return [...targets].map(([key, target]) => ({
      ...target, paused: false, timeoutSeconds: this.settings.defaultTimeoutSeconds, ...this.targets[key],
    })).sort((a, b) => targetKey(a.project, a.target).localeCompare(targetKey(b.project, b.target)));
  }

  async updateSettings(value) {
    const work = this.settingsWrites.then(async () => {
      const next = validateSettings(value, this.settings);
      await this.store.writeSetting('settings', next);
      this.settings = next;
      this.schedule();
      return { ...next };
    });
    this.settingsWrites = work.catch(() => {});
    return work;
  }

  async updateTarget(project, target, value) {
    const key = targetKey(project, target);
    const work = this.settingsWrites.then(async () => {
      const next = { ...this.targets, [key]: validateTargetSettings(value, this.targets[key]) };
      await this.store.writeSetting('targets', next);
      this.targets = next;
      this.schedule();
      return this.targetList().find(item => item.project === project && item.target === target);
    });
    this.settingsWrites = work.catch(() => {});
    return work;
  }

  submit(value) {
    const work = this.submissions.then(() => this.submitOne(value));
    this.submissions = work.catch(() => {});
    return work;
  }

  async submitOne(value) {
    if (this.stopping) throw new DeploymentError('Deployment service is stopping', 503, 'service_stopping');
    const request = validateJob(value);
    const hash = fingerprint(request);
    const previous = this.idempotency.get(request.requestId);
    if (previous) {
      const job = this.get(previous);
      if (job.fingerprint !== hash) throw new DeploymentError('Request ID was already used for another deployment', 409, 'request_conflict');
      return publicJob(job);
    }
    resolveJobPolicy(this.config, this.settings, this.targets, request);
    const retainedBytes = [...this.requests.values()].reduce((sum, item) =>
      sum + item.source.files.reduce((size, file) => size + Buffer.byteLength(file.data, 'base64'), 0), 0);
    const incomingBytes = request.source.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0);
    if (this.requests.size >= 8 || retainedBytes + incomingBytes > MAX_SOURCE_BYTES * 2) {
      throw new DeploymentError('Deployment queue is full', 429, 'queue_full');
    }
    const job = {
      id: crypto.randomUUID(), requestId: request.requestId, project: request.project, target: request.target,
      revision: request.revision, sourceDigest: request.source.sha256, adapter: request.recipe.adapter,
      state: 'queued', phase: 'queued', createdAt: this.now().toISOString(),
      version: null, fingerprint: hash, events: [], lastSeq: 0,
    };
    try { await this.event(job, 'queued'); }
    catch (error) { this.failClosed(error); throw error; }
    this.jobs.set(job.id, job);
    this.idempotency.set(job.requestId, job.id);
    this.requests.set(job.id, request);
    this.queue.push(job.id);
    this.schedule();
    return publicJob(job);
  }

  schedule() {
    queueMicrotask(() => {
      if (this.pumping || this.stopping || this.settings.paused) return;
      this.pumping = true;
      try {
        for (const id of [...this.queue]) {
          if (this.active.size >= this.settings.maxConcurrent) break;
          const job = this.get(id);
          if (job.state !== 'queued') continue;
          const key = targetKey(job.project, job.target);
          if (this.targets[key]?.paused) continue;
          const request = this.requests.get(id);
          const policy = resolveJobPolicy(this.config, this.settings, this.targets, request);
          const resources = new Set([key, ...(policy.resourceKeys || [])]);
          if ([...resources].some(resource => this.locks.has(resource))) continue;
          this.queue.splice(this.queue.indexOf(id), 1);
          for (const resource of resources) this.locks.add(resource);
          const controller = new AbortController();
          const promise = this.run(job, request, policy, controller).catch(error => {
            this.failClosed(error);
            throw error;
          }).finally(() => {
            this.active.delete(id);
            for (const resource of resources) this.locks.delete(resource);
            this.requests.delete(id);
            this.schedule();
          });
          this.active.set(id, { controller, promise });
          promise.catch(() => {});
        }
      } catch (error) {
        this.failClosed(error);
      } finally { this.pumping = false; }
    });
  }

  failClosed(error) {
    this.stopping = true;
    if (!this.fatal) {
      this.fatal = true;
      this.onFatal(error);
    }
  }

  async run(job, request, policy, controller) {
    job.state = 'running';
    job.startedAt = this.now().toISOString();
    const timer = setTimeout(() => controller.abort(
      new DeploymentError('Deployment deadline exceeded', 504, 'timeout')), policy.timeoutSeconds * 1000);
    const ring = [];
    this.live.set(job.id, ring);
    const redactor = lineRedactor(Object.values(request.secrets), text => {
      ring.push({ seq: ++job.lastSeq, at: this.now().toISOString(), text: text.slice(0, 16384) });
      if (ring.length > 256) ring.shift();
    });
    let outcome = 'succeeded', completedVersion = null, errorCode;
    try {
      await this.event(job, 'starting');
      const result = await this.executor.deploy(request, {
        jobId: job.id, jobDirectory: this.store.jobDirectory(job.id), policy, signal: controller.signal,
        onEvent: phase => this.event(job, phase),
        onOutput: text => redactor.write(text),
      });
      controller.signal.throwIfAborted();
      const version = deploymentVersion(result?.version);
      if (version && Object.values(request.secrets).some(secret => secret && version.includes(secret))) {
        throw new DeploymentError('Deployment returned private data as a version', 502, 'invalid_version');
      }
      completedVersion = version;
    } catch (error) {
      const reason = error?.code === 'cancellation_failed' ? error
        : controller.signal.aborted ? controller.signal.reason : error;
      const code = reason instanceof DeploymentError ? reason.code : 'execution_failed';
      errorCode = code;
      outcome = code === 'cancelled' ? 'cancelled' : code === 'interrupted' ? 'interrupted' : 'failed';
      if (code === 'cancellation_failed') {
        this.failClosed(reason);
      }
    } finally {
      clearTimeout(timer);
      redactor.end();
    }
    job.finalizing = true;
    const completed = { ...job, events: [...job.events], state: outcome, version: completedVersion,
      errorCode, finishedAt: this.now().toISOString(), completionOrder: ++this.completionOrder };
    await this.event(completed, outcome, { code: errorCode });
    Object.assign(job, completed);
    this.live.delete(job.id);
    this.live.set(job.id, ring);
    for (const id of this.live.keys()) {
      if (this.live.size <= 20) break;
      if (TERMINAL_STATES.has(this.jobs.get(id)?.state)) this.live.delete(id);
    }
  }

  async cancel(id) {
    const job = this.get(id);
    if (TERMINAL_STATES.has(job.state) || job.finalizing) throw new DeploymentError('Deployment already finished', 409, 'job_finished');
    if (job.state === 'queued') {
      this.queue = this.queue.filter(queued => queued !== id);
      this.requests.delete(id);
      job.state = 'cancelled';
      job.errorCode = 'cancelled';
      job.finishedAt = this.now().toISOString();
      await this.event(job, 'cancelled', { code: 'cancelled' });
    } else {
      job.state = 'cancelling';
      await this.event(job, 'cancelling');
      this.active.get(id)?.controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled'));
    }
    return publicJob(job);
  }

  async prune() {
    const cutoff = this.now().getTime() - this.settings.retentionDays * 86400000;
    for (const job of [...this.jobs.values()]) {
      if (this.active.has(job.id) || !TERMINAL_STATES.has(job.state)
          || !job.finishedAt || Date.parse(job.finishedAt) >= cutoff) continue;
      await this.store.removeJob(job.id);
      this.jobs.delete(job.id);
      this.idempotency.delete(job.requestId);
      this.live.delete(job.id);
    }
  }

  async close() {
    this.stopping = true;
    for (const id of [...this.queue]) {
      const job = this.get(id);
      job.state = 'interrupted';
      job.errorCode = 'service_stopping';
      job.finishedAt = this.now().toISOString();
      await this.event(job, 'interrupted', { code: 'service_stopping' });
      this.requests.delete(id);
    }
    this.queue = [];
    for (const active of this.active.values()) {
      active.controller.abort(new DeploymentError('Deployment worker is stopping', 503, 'interrupted'));
    }
    await Promise.all([...this.active.values()].map(active => active.promise));
  }
}
