import { snapshotDigest } from '../app/deployment/protocol.js';
import { validateHostConfig } from '../app/deployment/policy.js';

export function deploymentRequest(overrides = {}) {
  const files = [{ path: 'deploy/prod.sh', data: Buffer.from('exit 0\n').toString('base64'), executable: true }];
  return {
    apiVersion: 1, requestId: 'fixture-request-1', project: 'ExampleApp', target: 'prod',
    revision: 'a'.repeat(40), source: { files, sha256: snapshotDigest(files) },
    script: 'bash deploy/prod.sh', environment: { DEPLOY_OPTION: '' }, secrets: {}, ...overrides,
  };
}

export function deploymentConfig(overrides = {}) {
  return validateHostConfig({
    listen: { host: '127.0.0.1', port: 3800 }, tokenFile: '/etc/pw-deploy/service.token',
    stateDir: '/var/lib/pw-deploy', buildUser: 'fixture-builder', runtimeUser: 'fixture-runtime',
    ...overrides,
  });
}

export function builderStartupDiagnostic(jobId, instanceId = '11111111-1111-4111-8111-111111111111') {
  return {
    version: 1, instanceId, jobId,
    primary: { stage: 'client_start', code: 'process_failed', rule: 'client_failure', errno: null },
    relay: {
      version: 1, instanceId, jobId,
      primary: { stage: 'api_readiness', code: 'resource_not_allowed', rule: 'api_peer', errno: null },
      cleanup: { stage: 'stop', outcome: 'failed',
        failure: { stage: 'stop', code: 'process_failed', rule: 'manager_incomplete', errno: null } },
      recordingErrors: [],
    },
    exchange: null,
    cleanup: [{ outcome: 'failed',
      failure: { stage: 'client_stop', code: 'process_failed', rule: 'client_failure', errno: null } }],
    recordingFailure: null,
  };
}

export class MemoryJobStore {
  constructor() { this.jobs = new Map(); this.settings = new Map(); }
  async init() {}
  async readSetting(name, fallback) { return structuredClone(this.settings.get(name) ?? fallback); }
  async writeSetting(name, value) { this.settings.set(name, structuredClone(value)); }
  async loadJobs() { return structuredClone([...this.jobs.values()]); }
  async saveJob(job) {
    const { id, requestId, project, target, revision, sourceDigest, adapter, state, phase,
      createdAt, startedAt, finishedAt, version, errorCode, fingerprint, events, lastSeq, completionOrder,
      builderStartupFailure } = job;
    this.jobs.set(id, structuredClone({ id, requestId, project, target, revision, sourceDigest,
      adapter, state, phase, createdAt, startedAt, finishedAt, version, errorCode, fingerprint, events, lastSeq, completionOrder,
      ...(builderStartupFailure === undefined ? {} : { builderStartupFailure }) }));
  }
  async removeJob(id) { this.jobs.delete(id); }
  jobDirectory(id) { return `/fixture/jobs/${id}`; }
}

export async function until(predicate, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition was not reached');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
