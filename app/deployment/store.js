import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-file.js';
import { DeploymentError, publicJob, projectName, targetName, ADAPTERS, TERMINAL_STATES, fields } from './protocol.js';
import { deploymentVersion } from './engine.js';
import { validateBuilderStartupFailure } from './builder-diagnostics.js';

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(['queued', 'running', 'cancelling', ...TERMINAL_STATES]);
const PHASE = /^[a-z][a-z0-9_-]{0,47}$/;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateJournal(job, id) {
  const invalid = () => { throw new DeploymentError('Corrupt deployment journal', 503, 'invalid_state'); };
  fields(job, ['id', 'requestId', 'project', 'target', 'revision', 'sourceDigest', 'adapter', 'state', 'phase',
    'createdAt', 'startedAt', 'finishedAt', 'version', 'errorCode', 'fingerprint', 'events', 'lastSeq',
    'completionOrder', 'builderStartupFailure'], 'journal');
  projectName(job.project);
  targetName(job.target);
  if (job.id !== id || !/^[A-Za-z0-9_-]{8,100}$/.test(job.requestId || '')
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.revision || '')
      || !HASH.test(job.sourceDigest || '') || !HASH.test(job.fingerprint || '')
      || !ADAPTERS.includes(job.adapter) || !STATES.has(job.state) || !PHASE.test(job.phase || '')
      || !timestamp(job.createdAt) || (job.startedAt !== undefined && !timestamp(job.startedAt))
      || (job.finishedAt !== undefined && !timestamp(job.finishedAt))
      || (TERMINAL_STATES.has(job.state) && !job.finishedAt)
      || (job.errorCode !== undefined && !CODE.test(job.errorCode))
      || (job.completionOrder !== undefined && (!Number.isSafeInteger(job.completionOrder) || job.completionOrder < 1))
      || !Array.isArray(job.events) || job.events.length > 2048
      || !Number.isSafeInteger(job.lastSeq) || job.lastSeq < 0) invalid();
  deploymentVersion(job.version);
  if (job.builderStartupFailure !== undefined) validateBuilderStartupFailure(job.builderStartupFailure, id);
  let previous = 0;
  for (const event of job.events) {
    fields(event, ['seq', 'at', 'phase', 'code', 'state'], 'event');
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous || event.seq > job.lastSeq
        || !timestamp(event.at) || !PHASE.test(event.phase || '') || !STATES.has(event.state)
        || (event.code !== undefined && !CODE.test(event.code))) invalid();
    previous = event.seq;
  }
  return job;
}

async function safeDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
    throw new DeploymentError('Unsafe deployment state directory', 503, 'unsafe_state');
  }
  return stat;
}

export class JobStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.jobsDirectory = path.join(this.directory, 'jobs');
    this.writes = new Map();
  }

  jobDirectory(id) {
    if (!JOB_ID.test(id)) throw new DeploymentError('Invalid job ID');
    return path.join(this.jobsDirectory, id);
  }

  async init() {
    // Ancestors are operator-owned. Only these fresh, service-owned job
    // directories are later eligible for retention cleanup.
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    await safeDirectory(this.directory);
    await fs.mkdir(this.jobsDirectory, { mode: 0o711 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    for (const directory of [this.directory, this.jobsDirectory]) {
      await safeDirectory(directory);
      await fs.chmod(directory, 0o711);
    }
  }

  async readSetting(name, fallback) {
    if (!['settings', 'targets'].includes(name)) throw new DeploymentError('Invalid settings document');
    try {
      const file = path.join(this.directory, `${name}.json`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw new DeploymentError('Unsafe deployment state file', 503, 'unsafe_state');
      }
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async writeSetting(name, value) {
    if (!['settings', 'targets'].includes(name)) throw new DeploymentError('Invalid settings document');
    await writeFileAtomic(path.join(this.directory, `${name}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async loadJobs() {
    const jobs = [];
    for (const entry of await fs.readdir(this.jobsDirectory, { withFileTypes: true })) {
      if (!JOB_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DeploymentError('Unsafe job directory', 503, 'unsafe_state');
      const directory = this.jobDirectory(entry.name);
      await safeDirectory(directory);
      const file = path.join(directory, 'job.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || (stat.mode & 0o077) || stat.size > 1024 * 1024) {
        throw new DeploymentError('Unsafe job metadata', 503, 'unsafe_state');
      }
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      jobs.push(validateJournal(job, entry.name));
    }
    return jobs;
  }

  saveJob(job) {
    const id = job.id;
    const directory = this.jobDirectory(id);
    const retained = { ...publicJob(job), fingerprint: job.fingerprint, events: job.events,
      lastSeq: job.lastSeq, completionOrder: job.completionOrder };
    if (job.builderStartupFailure !== undefined) {
      retained.builderStartupFailure = validateBuilderStartupFailure(job.builderStartupFailure, id);
    }
    const content = `${JSON.stringify(retained)}\n`;
    const work = (this.writes.get(id) || Promise.resolve()).then(() => this.writeJob(directory, content));
    this.writes.set(id, work);
    work.finally(() => { if (this.writes.get(id) === work) this.writes.delete(id); }).catch(() => {});
    return work;
  }

  async writeJob(directory, content) {
    await fs.mkdir(directory, { mode: 0o711 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await safeDirectory(directory);
    await fs.chmod(directory, 0o711);
    await writeFileAtomic(path.join(directory, 'job.json'), content, { mode: 0o600 });
  }

  async removeJob(id) {
    const directory = this.jobDirectory(id);
    await this.writes.get(id);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
      throw new DeploymentError('Unsafe retention target', 503, 'unsafe_state');
    }
    await fs.rm(directory, { recursive: true });
  }
}
