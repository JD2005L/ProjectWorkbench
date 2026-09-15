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

export class MemoryJobStore {
  constructor() { this.jobs = new Map(); this.settings = new Map(); }
  async init() {}
  async readSetting(name, fallback) { return structuredClone(this.settings.get(name) ?? fallback); }
  async writeSetting(name, value) { this.settings.set(name, structuredClone(value)); }
  async loadJobs() { return structuredClone([...this.jobs.values()]); }
  async saveJob(job) {
    const { id, requestId, project, target, revision, sourceDigest, adapter, state, phase,
      createdAt, startedAt, finishedAt, version, errorCode, fingerprint, events, lastSeq, completionOrder } = job;
    this.jobs.set(id, structuredClone({ id, requestId, project, target, revision, sourceDigest,
      adapter, state, phase, createdAt, startedAt, finishedAt, version, errorCode, fingerprint, events, lastSeq, completionOrder }));
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
