import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DeploymentError } from '../app/deployment/protocol.js';

const execute = promisify(execFile);
const MAX_METADATA_BYTES = 1024 * 1024;
const STORAGE_ID = /^[a-f0-9]{64}$/;
const RUNTIME_ID = /^buildah-[A-Za-z0-9_.-]{1,100}$/;

function requireEvidence(condition, message) {
  if (!condition) throw new DeploymentError(message, 503, 'fixture_oracle_unavailable');
}

async function readMetadata(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireEvidence(stat.isFile() && stat.size <= MAX_METADATA_BYTES, 'Build observer metadata is not a bounded regular file');
    const data = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    requireEvidence(size <= MAX_METADATA_BYTES, 'Build observer metadata exceeded its bound');
    return data.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}

export function parseObservedProcess(text, expectedPid) {
  const boundary = text.lastIndexOf(') ');
  requireEvidence(Number.isSafeInteger(expectedPid) && expectedPid > 1
    && text.startsWith(`${expectedPid} (`) && boundary > 0, 'Build observer received an invalid process identity');
  const fields = text.slice(boundary + 2).trim().split(/\s+/);
  requireEvidence(fields.length >= 20 && /^[A-Za-z]$/.test(fields[0])
    && /^[1-9][0-9]*$/.test(fields[19]), 'Build observer received malformed process lifetime data');
  return { pid: expectedPid, state: fields[0], startTime: fields[19] };
}

export function bindObservedBuild({ state, specification, containerEnvironment, containers, storageBase, marker }) {
  requireEvidence(typeof marker === 'string' && /^[A-Za-z0-9_]{16,100}$/.test(marker),
    'Build observer requires its generated nonce');
  requireEvidence(RUNTIME_ID.test(state?.id || '') && state.status === 'running'
    && Number.isSafeInteger(state.pid) && state.pid > 1, 'Build observer requires a running Buildah OCI process');
  const transfer = path.posix.join(storageBase, 'transfer');
  requireEvidence(typeof state.bundle === 'string'
    && path.posix.dirname(state.bundle) === transfer
    && /^buildah[0-9]+$/.test(path.posix.basename(state.bundle)), 'Build observer bundle escaped its private transfer directory');
  requireEvidence(Array.isArray(specification?.process?.args)
    && specification.process.args.every(value => typeof value === 'string')
    && specification.process.args.some(value => new RegExp(`\\b${marker}\\b`).test(value)),
  'Build observer could not bind the OCI command to its controlled nonce');
  const pidNamespaces = specification?.linux?.namespaces?.filter(entry => entry.type === 'pid');
  requireEvidence(pidNamespaces?.length === 1 && !pidNamespaces[0].path,
    'Build observer requires a new private PID namespace');
  requireEvidence(typeof specification?.root?.path === 'string', 'Build observer received no OCI root');
  const root = path.posix.resolve(state.bundle, specification.root.path);
  requireEvidence(root === path.posix.join(state.bundle, 'mnt', 'rootfs'),
    'Build observer root escaped its private OCI bundle');
  const environmentMounts = specification.mounts?.filter(mount => mount.destination === '/run/.containerenv');
  requireEvidence(environmentMounts?.length === 1 && environmentMounts[0].type === 'bind'
    && environmentMounts[0].source === path.posix.join(state.bundle, 'run', '.containerenv'),
  'Build observer cannot bind the runtime-authored identity mount');
  requireEvidence(typeof containerEnvironment === 'string' && containerEnvironment.length <= 8192
    && /^engine="buildah-[0-9.]+"$/m.test(containerEnvironment) && /^rootless=1$/m.test(containerEnvironment),
  'Build observer received no rootless Buildah identity record');
  const ids = [...containerEnvironment.matchAll(/^id="([a-f0-9]{64})"$/gm)];
  requireEvidence(ids.length === 1, 'Build observer identity record is ambiguous');
  requireEvidence(Array.isArray(containers) && containers.every(value => STORAGE_ID.test(value?.id || '')),
    'Build observer storage catalogue is invalid');
  const matches = containers.filter(value => value.id === ids[0][1]);
  requireEvidence(matches.length === 1,
    'Build observer cannot uniquely bind OCI root to private Buildah storage');
  return {
    runtimeId: state.id, pid: state.pid, bundle: state.bundle,
    storageId: matches[0].id,
  };
}

// This observer belongs to the trusted host-side test driver, never a project
// worker or the packaged controller. It has no mutation or signal operation.
export class PrivateBuildObserver {
  constructor({ storageBase, socketPath, environment }) {
    this.storageBase = storageBase;
    this.runtimeRoot = path.posix.join(path.posix.dirname(socketPath), 'crun');
    this.environment = environment;
  }

  async states() {
    const stat = await fs.lstat(this.runtimeRoot);
    requireEvidence(stat.isDirectory() && !stat.isSymbolicLink()
      && stat.uid === process.getuid() && await fs.realpath(this.runtimeRoot) === this.runtimeRoot,
    'Build observer refuses an unowned or redirected OCI state root');
    const { stdout } = await execute('/usr/bin/crun', [
      '--root', this.runtimeRoot, 'list', '--format=json',
    ], { env: this.environment, timeout: 3000, maxBuffer: MAX_METADATA_BYTES });
    const states = JSON.parse(stdout);
    requireEvidence(Array.isArray(states), 'Build observer OCI catalogue is invalid');
    return states;
  }

  async idle() {
    const states = await this.states();
    requireEvidence(states.every(state => state.status === 'stopped' && state.pid === 0),
      'Build observer found live OCI work before its controlled build');
    return new Set(states.map(state => state.id));
  }

  async identify(marker, baseline, containers) {
    const states = (await this.states()).filter(state => !baseline.has(state.id)
      && state.status === 'running' && RUNTIME_ID.test(state.id || ''));
    const identities = [];
    for (const state of states) {
      requireEvidence(typeof state.bundle === 'string'
        && path.posix.dirname(state.bundle) === path.posix.join(this.storageBase, 'transfer')
        && /^buildah[0-9]+$/.test(path.posix.basename(state.bundle)),
      'Build observer found an unexpected OCI bundle path');
      requireEvidence(await fs.realpath(state.bundle) === state.bundle, 'Build observer refuses a redirected OCI bundle');
      const specification = JSON.parse(await readMetadata(path.posix.join(state.bundle, 'config.json')));
      if (!specification?.process?.args?.some(value => typeof value === 'string' && value.includes(marker))) continue;
      const containerEnvironment = await readMetadata(path.posix.join(state.bundle, 'run', '.containerenv'));
      const identity = bindObservedBuild({
        state, specification, containerEnvironment, containers, storageBase: this.storageBase, marker,
      });
      const proc = parseObservedProcess(await readMetadata(`/proc/${identity.pid}/stat`), identity.pid);
      requireEvidence(!['Z', 'X', 'x'].includes(proc.state), 'Controlled build process exited before observation');
      const namespace = await fs.readlink(`/proc/${identity.pid}/ns/pid`);
      requireEvidence(/^pid:\[[0-9]+\]$/.test(namespace)
        && namespace !== await fs.readlink('/proc/self/ns/pid'), 'Controlled build uses the observer host PID namespace');
      identities.push({ ...identity, startTime: proc.startTime, pidNamespace: namespace });
    }
    requireEvidence(identities.length === 1, 'Build observer requires exactly one nonce-bound live OCI process');
    return identities[0];
  }

  async stopped(identity) {
    let processStopped;
    try {
      const proc = parseObservedProcess(await readMetadata(`/proc/${identity.pid}/stat`), identity.pid);
      processStopped = proc.startTime !== identity.startTime || ['Z', 'X', 'x'].includes(proc.state);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      processStopped = true;
    }
    const state = (await this.states()).find(value => value.id === identity.runtimeId);
    requireEvidence(!state || state.bundle === identity.bundle, 'Controlled OCI runtime identity was reassigned');
    return processStopped && (!state || (state.status === 'stopped' && state.pid === 0));
  }
}
