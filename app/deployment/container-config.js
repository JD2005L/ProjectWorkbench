import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DeploymentError, fields, fail } from './protocol.js';
import { readProtectedFile, validateServicePolicy } from './policy.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]{0,220}@sha256:[a-f0-9]{64})$/;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;

function absolute(value, name) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value || /[\0-\x20\x7f]/.test(value)
      || value.split('/').filter(Boolean).length < 2) fail(`Invalid ${name}`);
  return value;
}

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`Invalid ${name}`);
  return value;
}

export function validateUiLocation({ basePath = '/deploy-service', publicOrigin }) {
  if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)
      || basePath.length > 160 || /^\/(?:v1|health)(?:\/|$)/.test(basePath)) fail('Invalid console base path');
  let origin;
  try { origin = new URL(publicOrigin); }
  catch (error) {
    if (error instanceof TypeError) fail('A valid HTTPS console origin is required');
    throw error;
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/'
      || !origin.hostname || origin.origin === 'null') fail('A valid HTTPS console origin is required');
  return { basePath, publicOrigin: origin.origin };
}

export function validateContainerConfig(value) {
  fields(value, ['mode', 'listen', 'tokenFile', 'stateDir', 'healthHosts', 'adapters',
    'maxConcurrent', 'defaultTimeoutSeconds', 'retentionDays', 'resourceNames', 'container', 'ui'], 'container service policy');
  if (value.mode !== 'container') fail('Container mode must be explicitly selected');
  absolute(value.tokenFile, 'API credential path');
  absolute(value.stateDir, 'state directory');
  fields(value.listen, ['host', 'port'], 'container listener');
  if (!['0.0.0.0', '127.0.0.1', '::1'].includes(value.listen.host)) fail('Invalid container listener');
  integer(value.listen.port, 1024, 65535, 'listener port');
  const common = validateServicePolicy(value);

  fields(value.ui, ['basePath', 'publicOrigin', 'tokenFile', 'sessionMinutes'], 'console policy');
  const ui = { ...value.ui, ...validateUiLocation(value.ui), sessionMinutes: value.ui.sessionMinutes ?? 30 };
  absolute(ui.tokenFile, 'console credential path');
  integer(ui.sessionMinutes, 5, 120, 'console session lifetime');
  if (ui.tokenFile === value.tokenFile) fail('Console and machine API credentials must be separate');

  fields(value.container, ['instanceId', 'builderSocket', 'workerImage', 'maxMemoryMiB', 'maxPids', 'runtime'], 'execution policy');
  const container = {
    ...value.container,
    maxMemoryMiB: value.container.maxMemoryMiB ?? 2048,
    maxPids: value.container.maxPids ?? 512,
  };
  if (!UUID.test(container.instanceId || '')) fail('A stable container service instance ID is required');
  absolute(container.builderSocket, 'builder socket');
  if (!IMAGE.test(container.workerImage || '')) fail('The worker image must be pinned to an immutable image ID or digest');
  integer(container.maxMemoryMiB, 256, 16384, 'job memory limit');
  integer(container.maxPids, 32, 2048, 'job process limit');
  if (container.runtime !== undefined) {
    fields(container.runtime, ['host', 'port', 'user', 'keyFile', 'knownHostsFile'], 'runtime connection');
    const runtime = { ...container.runtime, port: container.runtime.port ?? 22 };
    if (typeof runtime.host !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(runtime.host)
        || runtime.host.includes('..') || !ACCOUNT.test(runtime.user || '') || runtime.user === 'root') {
      fail('Runtime connection must name an approved non-root account and host');
    }
    integer(runtime.port, 1, 65535, 'runtime SSH port');
    absolute(runtime.keyFile, 'runtime SSH key');
    absolute(runtime.knownHostsFile, 'runtime SSH host keys');
    container.runtime = runtime;
  } else if (common.adapters.includes('podman')) {
    fail('Podman activation requires an explicitly configured runtime connection');
  }
  return { ...value, ...common, ui, container };
}

export async function readContainerConfig(file) {
  const text = await readProtectedFile(file);
  if (Buffer.byteLength(text) > 65536) fail('Container service policy is too large');
  let value;
  try { value = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) fail('Container policy is not valid JSON', 'invalid_configuration', 503);
    throw error;
  }
  return validateContainerConfig(value);
}

export function validateContainerUidMap(value) {
  const mappings = String(value).trim().split('\n').map(line => line.trim().split(/\s+/));
  if (!mappings.length || mappings.some(parts => parts.length !== 3 || parts.some(part => !/^\d+$/.test(part)))) {
    throw new DeploymentError('Container user namespace is unavailable', 503, 'unsafe_container');
  }
  const entries = mappings.map(parts => parts.map(Number));
  if (entries.some(parts => parts.some(number => !Number.isSafeInteger(number)) || parts[2] <= 0)
      || !entries.some(([inside, outside, count]) => inside === 0 && outside > 0 && count > 0)
      || entries.some(([, outside]) => outside === 0)) {
    throw new DeploymentError('The service must use a non-host-root user namespace', 503, 'unsafe_container');
  }
}

export async function assertContainerIsolation() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new DeploymentError('Use the packaged rootless service container', 503, 'container_required');
  }
  validateContainerUidMap(await fs.readFile('/proc/self/uid_map', 'utf8'));
  validateContainerUidMap(await fs.readFile('/proc/self/gid_map', 'utf8'));
}

export function validateContainerCredentials({ token, uiToken }) {
  for (const value of [token, uiToken]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/-]{32,512}=*$/.test(value) || value.length > 512) {
      throw new DeploymentError('A strong, separately provisioned service credential is required', 503, 'invalid_configuration');
    }
  }
  const hash = value => crypto.createHash('sha256').update(value).digest();
  if (crypto.timingSafeEqual(hash(token), hash(uiToken))) {
    throw new DeploymentError('Console and API credentials must not be reused', 503, 'invalid_configuration');
  }
  return { token, uiToken };
}

export async function readContainerCredentials(config) {
  const [api, ui] = await Promise.all([
    readProtectedFile(config.tokenFile, { secret: true }),
    readProtectedFile(config.ui.tokenFile, { secret: true }),
  ]);
  return validateContainerCredentials({ token: api.trim(), uiToken: ui.trim() });
}
