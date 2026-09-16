import crypto from 'node:crypto';
import path from 'node:path';

export const API_VERSION = 1;
export const SERVICE_NAME = 'pw-deploy';
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
export const MAX_SOURCE_FILES = 10000;
export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const ADAPTERS = ['script', 'iis', 'podman'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const HEX = /^[a-f0-9]{64}$/;
const ENV_NAME = /^DEPLOY_[A-Z][A-Z0-9_]{0,63}$/;
const PRIVATE_ENV = new Set(['DEPLOY_USER', 'DEPLOY_PASSWORD', 'DEPLOY_TOKEN', 'DEPLOY_API_KEY']);

export class DeploymentError extends Error {
  constructor(message, statusCode = 400, code = 'invalid_request') {
    super(message);
    this.name = 'DeploymentError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function fail(message, code = 'invalid_request', statusCode = 400) {
  throw new DeploymentError(message, statusCode, code);
}

export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function fields(value, allowed, label) {
  if (!record(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key)) fail(`Unknown ${label} field: ${key}`);
  }
}

export function projectName(value) {
  if (typeof value !== 'string' || !NAME.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail('Invalid project name');
  }
  return value;
}

export function targetName(value) {
  if (!['dev', 'prod'].includes(value)) fail('Target must be dev or prod');
  return value;
}

export function targetKey(project, target) {
  return `${projectName(project)}/${targetName(target)}`;
}

export function resourceName(project, target) {
  const name = projectName(project).replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_.]+/g, '-').toLowerCase();
  return `${name}${targetName(target) === 'dev' ? '-dev' : ''}`;
}

export function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\0-\x1f\\:]/.test(value)
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail('Invalid source path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part === '.git')) {
    fail('Source path escapes its snapshot');
  }
  if (parts.some(part => part === 'node_modules') || /(?:^|\/)\.env(?:$|\.(?!example$|sample$))/i.test(value)
      || /\.(?:sqlite(?:-wal|-shm|-journal)?|pfx|p12|key)$/i.test(value)) {
    fail('Runtime data and private configuration are not deployment source');
  }
  return value;
}

export function snapshotDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(JSON.stringify([file.path, !!file.executable, file.data]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function validateSnapshot(value) {
  fields(value, ['sha256', 'files'], 'source');
  if (!HEX.test(value.sha256 || '')) fail('Invalid source digest');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_SOURCE_FILES) {
    fail(`Source must contain 1-${MAX_SOURCE_FILES} regular files`);
  }
  const seen = new Set();
  let total = 0;
  const files = value.files.map(file => {
    fields(file, ['path', 'data', 'executable'], 'source file');
    const name = sourcePath(file.path);
    if (seen.has(name)) fail('Duplicate source path');
    seen.add(name);
    if (typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4
        || file.data.length % 4 || /[^A-Za-z0-9+/=]/.test(file.data)) {
      fail('Invalid source file encoding');
    }
    const decoded = Buffer.from(file.data, 'base64');
    if (decoded.toString('base64') !== file.data) fail('Invalid source file encoding');
    if (file.executable !== undefined && typeof file.executable !== 'boolean') fail('Invalid executable flag');
    total += decoded.length;
    if (total > MAX_SOURCE_BYTES) fail('Deployment source is too large', 'source_too_large', 413);
    return { path: name, data: file.data, executable: !!file.executable };
  });
  for (const name of seen) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) fail('Source file conflicts with a directory');
    }
  }
  if (snapshotDigest(files) !== value.sha256) fail('Source digest does not match its contents');
  return { sha256: value.sha256, files };
}

export function validateEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('Invalid deployment service endpoint');
  if (value.startsWith('unix:')) {
    const socketPath = value.slice(5);
    if (!path.posix.isAbsolute(socketPath) || /[\0\r\n?#]/.test(socketPath)) fail('Invalid deployment socket path');
    return { endpoint: value, socketPath };
  }
  let url;
  try { url = new URL(value); }
  catch { fail('Deployment endpoint must be HTTPS, loopback HTTP, or unix:/absolute/socket'); }
  if (url.username || url.password || url.search || url.hash) fail('Endpoint must not contain credentials, query or fragment');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('Remote deployment endpoints require HTTPS');
  }
  return { endpoint: url.href.replace(/\/$/, ''), url };
}

export function validateEnvironment(value = {}, { secrets = false } = {}) {
  if (!record(value) || Object.keys(value).length > 32) fail('Invalid deployment environment');
  const env = {};
  for (const [key, content] of Object.entries(value)) {
    if (!ENV_NAME.test(key) || PRIVATE_ENV.has(key) !== secrets
        || typeof content !== 'string' || content.length > 16384 || content.includes('\0')) {
      fail('Invalid deployment environment entry');
    }
    env[key] = content;
  }
  return env;
}

export function validateRecipe(value = {}) {
  fields(value, ['adapter', 'image', 'service', 'dockerfile', 'healthUrl', 'versionField',
    'versionFile', 'versionFormat'], 'recipe');
  const adapter = value.adapter || 'script';
  if (!ADAPTERS.includes(adapter)) fail('Unsupported deployment adapter');
  const recipe = { adapter };
  if (adapter !== 'podman' && Object.keys(value).some(key => key !== 'adapter')) {
    fail('Container options require the podman adapter');
  }
  for (const key of ['image', 'service']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(value[key])) fail(`Invalid ${key}`);
      recipe[key] = value[key];
    }
  }
  if (value.dockerfile !== undefined) recipe.dockerfile = sourcePath(value.dockerfile);
  if (value.versionFile !== undefined) {
    recipe.versionFile = sourcePath(value.versionFile);
    recipe.versionFormat = value.versionFormat || 'text';
    if (!['text', 'json'].includes(recipe.versionFormat)) fail('Version format must be text or json');
  } else if (value.versionFormat !== undefined) fail('Version format requires a version file');
  if (value.healthUrl !== undefined) {
    let url;
    try { url = new URL(value.healthUrl); }
    catch { fail('Invalid container health URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      fail('Invalid container health URL');
    }
    recipe.healthUrl = url.href;
  }
  if (value.versionField !== undefined) {
    if (typeof value.versionField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.versionField)) {
      fail('Invalid version field');
    }
    recipe.versionField = value.versionField;
  }
  return recipe;
}

export function validateJob(value) {
  fields(value, ['apiVersion', 'requestId', 'project', 'target', 'revision', 'source',
    'script', 'versionCommand', 'environment', 'secrets', 'recipe'], 'job');
  if (value.apiVersion !== API_VERSION) fail('Unsupported deployment API version');
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value.requestId)) fail('Invalid request ID');
  const project = projectName(value.project);
  const target = targetName(value.target);
  if (typeof value.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision)) {
    fail('Deployment source must identify an exact Git commit');
  }
  const recipe = validateRecipe(value.recipe);
  const script = value.script ?? '';
  const versionCommand = value.versionCommand ?? '';
  for (const text of [script, versionCommand]) {
    if (typeof text !== 'string' || text.length > 65536 || text.includes('\0')) fail('Invalid deployment script');
  }
  if (recipe.adapter !== 'podman' && !script.trim()) fail('A deployment script is required');
  const source = validateSnapshot(value.source);
  if (recipe.versionFile && source.files.some(file => file.path.startsWith(`${recipe.versionFile}/`)
      || recipe.versionFile.startsWith(`${file.path}/`))) fail('Version file conflicts with source');
  return {
    apiVersion: API_VERSION, requestId: value.requestId, project, target,
    revision: value.revision, source,
    script, versionCommand, environment: validateEnvironment(value.environment),
    secrets: validateEnvironment(value.secrets, { secrets: true }), recipe,
  };
}

// Only these operational fields are retained. Script bodies, environment values,
// source contents and raw command output never enter the job journal.
export function publicJob(job) {
  const result = {};
  for (const key of ['id', 'requestId', 'project', 'target', 'revision', 'sourceDigest',
    'adapter', 'state', 'phase', 'createdAt', 'startedAt', 'finishedAt', 'version', 'errorCode']) {
    if (job[key] !== undefined) result[key] = job[key];
  }
  return result;
}
