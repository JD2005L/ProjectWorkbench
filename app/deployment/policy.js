import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS, fields, fail, record, resourceName, targetKey, validateRecipe } from './protocol.js';

const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const DEFAULT_SETTINGS = Object.freeze({
  paused: false, maxConcurrent: 1, defaultTimeoutSeconds: 600, retentionDays: 7,
});

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be ${min}-${max}`);
  return value;
}

export function validateSettings(value, previous = DEFAULT_SETTINGS) {
  fields(value, ['paused', 'maxConcurrent', 'defaultTimeoutSeconds', 'retentionDays'], 'service settings');
  const result = { ...previous, ...value };
  if (typeof result.paused !== 'boolean') fail('paused must be boolean');
  integer(result.maxConcurrent, 1, 4, 'Concurrency');
  integer(result.defaultTimeoutSeconds, 30, 3600, 'Timeout');
  integer(result.retentionDays, 1, 90, 'Retention');
  return result;
}

export function validateTargetSettings(value, previous = {}) {
  fields(value, ['paused', 'timeoutSeconds'], 'target settings');
  const result = { ...previous, ...value };
  if (result.paused !== undefined && typeof result.paused !== 'boolean') fail('paused must be boolean');
  if (result.timeoutSeconds !== undefined) integer(result.timeoutSeconds, 30, 3600, 'Target timeout');
  return result;
}

export function validateResourceNames(value = {}) {
  if (!record(value) || Object.keys(value).length > 1000) fail('Invalid resource name bindings');
  const entries = Object.entries(value);
  const reserved = new Set();
  for (const [key, name] of entries) {
    const [project, target, ...extra] = key.split('/');
    if (extra.length || targetKey(project, target) !== key) fail('Invalid resource name binding target');
    if (typeof name !== 'string') fail('Invalid resource name binding');
    validateRecipe({ adapter: 'podman', image: name });
    if (reserved.has(name)) fail('Resource name bindings must be unique');
    reserved.add(name);
  }
  return Object.fromEntries(entries);
}

export function validateServicePolicy(value) {
  const healthHosts = value.healthHosts || ['127.0.0.1', '::1'];
  if (!Array.isArray(healthHosts) || !healthHosts.length || healthHosts.length > 32
      || healthHosts.some(host => typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(host))) {
    fail('Invalid health host allowlist');
  }
  const adapters = value.adapters || ADAPTERS;
  if (!Array.isArray(adapters) || !adapters.length || adapters.some(adapter => !ADAPTERS.includes(adapter))) fail('Invalid adapter allowlist');
  const resourceNames = validateResourceNames(value.resourceNames);
  const defaults = validateSettings(Object.fromEntries(
    ['maxConcurrent', 'defaultTimeoutSeconds', 'retentionDays'].filter(key => value[key] !== undefined).map(key => [key, value[key]])));
  return { healthHosts, adapters, resourceNames, defaults };
}

export function validateHostConfig(value) {
  fields(value, ['listen', 'tokenFile', 'stateDir', 'buildUser', 'runtimeUser', 'healthHosts',
    'unitName', 'maxConcurrent', 'defaultTimeoutSeconds', 'retentionDays', 'adapters',
    'resourceNames'], 'host policy');
  for (const field of ['tokenFile', 'stateDir']) {
    if (typeof value[field] !== 'string' || !path.posix.isAbsolute(value[field])
        || /[\0\r\n]/.test(value[field]) || path.posix.normalize(value[field]) !== value[field]
        || value[field].split('/').filter(Boolean).length < 2) fail(`Invalid ${field}`);
  }
  for (const field of ['buildUser', 'runtimeUser']) {
    if (!ACCOUNT.test(value[field] || '') || value[field] === 'root') fail(`${field} must be an approved non-root account`);
  }
  fields(value.listen, ['host', 'port', 'socketPath'], 'listener');
  if (value.listen.socketPath !== undefined) {
    if (value.listen.host !== undefined || value.listen.port !== undefined
        || typeof value.listen.socketPath !== 'string' || !path.posix.isAbsolute(value.listen.socketPath)
        || /[\0\r\n]/.test(value.listen.socketPath)) fail('Invalid Unix listener');
  } else {
    if (!['127.0.0.1', '::1'].includes(value.listen.host)) fail('The service may listen only on loopback or a Unix socket');
    integer(value.listen.port, 1024, 65535, 'Listener port');
  }
  const unitName = value.unitName || 'pw-deploy.service';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.service$/.test(unitName)) fail('Invalid supervisor unit name');
  return { ...value, unitName, ...validateServicePolicy(value) };
}

export async function readProtectedFile(file, { secret = false } = {}) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & (secret ? 0o077 : 0o022))) {
    fail('Deployment policy and credentials must be protected root-owned regular files', 'unsafe_configuration', 503);
  }
  return fs.readFile(file, 'utf8');
}

export async function readHostConfig(file) {
  const raw = await readProtectedFile(file);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail('Deployment policy is not valid JSON', 'invalid_configuration', 503); }
  return validateHostConfig(parsed);
}

export function resolveJobPolicy(config, settings, overrides, request) {
  if (!config.adapters.includes(request.recipe.adapter)) fail('Deployment adapter is disabled', 'adapter_disabled', 403);
  const key = targetKey(request.project, request.target);
  const override = overrides[key] || {};
  if (settings.paused || override.paused) fail('Deployment target is paused', 'target_paused', 423);
  const result = { key, timeoutSeconds: override.timeoutSeconds || settings.defaultTimeoutSeconds };
  if (request.recipe.adapter === 'podman') {
    const canonical = resourceName(request.project, request.target);
    const compact = `${request.project.replace(/[_.]+/g, '-').toLowerCase()}${request.target === 'dev' ? '-dev' : ''}`;
    const binding = config.resourceNames?.[key];
    const allowed = new Set(binding ? [binding] : [canonical, compact]);
    const image = request.recipe.image || binding || canonical;
    const service = request.recipe.service || binding || canonical;
    const reservedElsewhere = new Set(Object.entries(config.resourceNames || {})
      .filter(([owner]) => owner !== key).map(([, name]) => name));
    if (!allowed.has(image) || !allowed.has(service)
        || reservedElsewhere.has(image) || reservedElsewhere.has(service)) {
      fail('Container image and service must belong to the selected project and target', 'resource_not_allowed', 403);
    }
    if (request.recipe.healthUrl) {
      const host = new URL(request.recipe.healthUrl).hostname.replace(/^\[|\]$/g, '');
      if (!config.healthHosts.includes(host)) fail('Health endpoint host is not approved', 'health_host_not_allowed', 403);
    }
    Object.assign(result, { image, service, resourceKeys: [`podman-service/${service}`, `podman-image/${image}`] });
  }
  return result;
}
