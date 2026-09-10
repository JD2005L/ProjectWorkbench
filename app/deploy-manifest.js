import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TARGETS = ['dev', 'prod'];
const BUMPS = ['patch', 'minor', 'major'];
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_ENV = new Set(['DEPLOY_PROJECT', 'DEPLOY_TARGET', 'DEPLOY_USER', 'DEPLOY_PASSWORD', 'DEPLOY_OPTION']);
const MAX_JSON_BYTES = 1024 * 1024;

export class DeployManifestError extends Error {
 constructor(message, statusCode = 400) {
  super(`Deployment manifest: ${message}`);
  this.name = 'DeployManifestError';
  this.statusCode = statusCode;
  this.staleManifest = statusCode === 409;
 }
}

function fail(message) { throw new DeployManifestError(message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed, where) {
 if (!record(value)) fail(`${where} must be an object`);
 for (const key of Object.keys(value)) {
  if (!allowed.includes(key) || RESERVED.has(key)) fail(`unknown field ${where}.${key}`);
 }
}
function text(value, where, max = 200) {
 if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(`${where} must be non-empty text`);
 return value;
}
function relativeParts(value, where) {
 text(value, where, 500);
 if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail(`${where} must be a relative repository path`);
 const parts = value.split(/[\\/]/);
 if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..' || RESERVED.has(part))) {
  fail(`${where} contains an unsafe path component`);
 }
 return parts;
}
function metadataPath(value, where) {
 if (!Array.isArray(value) || !value.length || value.length > 12 || value.some(part => typeof part !== 'string' || !part || RESERVED.has(part))) {
  fail(`${where} must be an array of JSON property names`);
 }
 return value;
}
function metadataValue(data, keys, where) {
 let value = data;
 for (const key of keys) {
  if (!record(value) || !Object.hasOwn(value, key)) fail(`${where} is missing ${keys.join('.')}`);
  value = value[key];
 }
 return value;
}
function versionParts(value, where) {
 if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail(`${where} must be a numeric major.minor.patch version`);
 const parts = value.split('.').map(Number);
 if (parts.some(part => !Number.isSafeInteger(part))) fail(`${where} has an out-of-range version component`);
 return parts;
}

export function anticipateVersion(currentVersion, initialVersion, bump) {
 if (!BUMPS.includes(bump)) fail('version bump must be patch, minor, or major');
 versionParts(initialVersion, 'initial version');
 if (currentVersion === null) return initialVersion;
 const parts = versionParts(currentVersion, 'published version');
 const index = { major: 0, minor: 1, patch: 2 }[bump];
 parts[index]++;
 if (!Number.isSafeInteger(parts[index])) fail('anticipated version is out of range');
 for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
 return parts.join('.');
}

async function statOrMissing(file) {
 try { return await fs.lstat(file); }
 catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
}

// Walk every component, not just the final JSON file: an intermediate directory
// link can escape the workspace even when the filename itself is innocuous.
async function safePath(root, parts, { optional = false, directory = false } = {}) {
 let file = root;
 let stat;
 for (let i = 0; i < parts.length; i++) {
  file = path.join(file, parts[i]);
  stat = await statOrMissing(file);
  const label = parts.slice(0, i + 1).join('/');
  if (!stat) {
   if (optional) return null;
   fail(`missing ${label}`);
  }
  if (stat.isSymbolicLink()) fail(`symbolic links are not allowed: ${label}`);
  if (i < parts.length - 1 || directory) {
   if (!stat.isDirectory()) fail(`${label} must be a directory`);
  } else if (!stat.isFile()) fail(`${label} must be a regular file`);
 }
 const real = await fs.realpath(file);
 const relative = path.relative(root, real);
 if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`path escapes the repository: ${parts.join('/')}`);
 return { file, stat };
}

async function readJson(root, parts, fingerprints, optional = false) {
 const before = await safePath(root, parts, { optional });
 if (!before) return null;
 const label = parts.join('/');
 const handle = await fs.open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
 let raw;
 try {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) fail(`${label} must be a regular JSON file no larger than 1 MiB`);
  if (stat.ino !== before.stat.ino || stat.dev !== before.stat.dev) fail(`${label} changed while being read; reopen the deployment panel`);
  raw = await handle.readFile('utf8');
  const after = await safePath(root, parts);
  if (after.stat.ino !== stat.ino || after.stat.dev !== stat.dev) fail(`${label} changed while being read; reopen the deployment panel`);
 } finally { await handle.close(); }
 let parsed;
 try { parsed = JSON.parse(raw); }
 catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  fail(`${label} is not valid JSON`);
 }
 fingerprints.push([label, crypto.createHash('sha256').update(raw).digest('hex')]);
 return { data: parsed };
}

function validateSource(source, where) {
 fields(source, ['directory', 'file', 'labelPath', 'initialVersionPath', 'version'], where);
 relativeParts(source.directory, `${where}.directory`);
 relativeParts(source.file, `${where}.file`);
 metadataPath(source.labelPath, `${where}.labelPath`);
 if (source.version !== undefined || source.initialVersionPath !== undefined) {
  metadataPath(source.initialVersionPath, `${where}.initialVersionPath`);
  fields(source.version, ['directory', 'file', 'valuePath'], `${where}.version`);
  relativeParts(source.version.directory, `${where}.version.directory`);
  relativeParts(source.version.file, `${where}.version.file`);
  metadataPath(source.version.valuePath, `${where}.version.valuePath`);
 }
}

async function sourceChoices(root, source, fingerprints, where) {
 validateSource(source, where);
 const directory = relativeParts(source.directory, `${where}.directory`);
 const metadataFile = relativeParts(source.file, `${where}.file`);
 const parent = await safePath(root, directory, { directory: true });
 const entries = await fs.readdir(parent.file, { withFileTypes: true });
 const choices = [];
 for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
  if (entry.isSymbolicLink()) fail(`symbolic links are not allowed: ${source.directory}/${entry.name}`);
  if (!entry.isDirectory()) continue;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(entry.name) || RESERVED.has(entry.name)) fail(`unsafe choice directory in ${source.directory}`);
  if (choices.length >= 1024) fail(`${where} has more than 1024 choices`);
  const meta = await readJson(root, [...directory, entry.name, ...metadataFile], fingerprints);
  const choice = {
   value: entry.name,
   label: text(metadataValue(meta.data, source.labelPath, `${source.directory}/${entry.name}`), `${where} choice label`),
  };
  if (source.version) {
   choice.initialVersion = metadataValue(meta.data, source.initialVersionPath, `${source.directory}/${entry.name}`);
   versionParts(choice.initialVersion, `${entry.name} initial version`);
   const publishedDir = [...relativeParts(source.version.directory, `${where}.version.directory`), entry.name];
   const published = await safePath(root, publishedDir, { optional: true, directory: true });
   choice.version = null;
   if (published) {
    // An absent release directory means "not published". An existing directory
    // with a broken/missing index is NOT permission to infer a first release.
    const index = await readJson(root, [...publishedDir, ...relativeParts(source.version.file, `${where}.version.file`)], fingerprints);
    choice.version = metadataValue(index.data, source.version.valuePath, `${source.version.directory}/${entry.name}`);
    versionParts(choice.version, `${entry.name} published version`);
   }
   choice.targetVersions = Object.fromEntries(BUMPS.map(bump => [bump, anticipateVersion(choice.version, choice.initialVersion, bump)]));
  }
  choices.push(choice);
 }
 if (!choices.length) fail(`${where} has no choices`);
 return choices;
}

async function resolveManifest(workspace, target) {
 if (!TARGETS.includes(target)) fail('target must be dev or prod');
 const absolute = path.resolve(workspace);
 const pw = await statOrMissing(path.join(absolute, '.pw'));
 if (!pw) return null;
 if (pw.isSymbolicLink() || !pw.isDirectory()) fail('.pw must be a real directory, not a symbolic link');
 const workspaceStat = await fs.lstat(absolute);
 if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) fail('workspace must be a real directory, not a symbolic link');
 const root = await fs.realpath(absolute);
 const fingerprints = [];
 const file = await readJson(root, ['.pw', 'deploy.json'], fingerprints, true);
 if (!file) return null;
 const manifest = file.data;
 fields(manifest, ['schemaVersion', 'slots'], 'manifest');
 if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
 fields(manifest.slots, TARGETS, 'slots');
 if (!Object.hasOwn(manifest.slots, target)) return null;
 const slot = manifest.slots[target];
 fields(slot, ['label', 'script', 'inputs', 'version'], `slots.${target}`);
 const label = text(slot.label, `slots.${target}.label`);
 if (typeof slot.script !== 'string' || !slot.script.trim() || slot.script.length > 65536 || slot.script.includes('\0')) fail(`slots.${target}.script must be non-empty bash text`);
 const declaredInputs = slot.inputs === undefined ? [] : slot.inputs;
 if (!Array.isArray(declaredInputs) || declaredInputs.length > 8) fail(`slots.${target}.inputs must be an array of at most 8 required selects`);
 const names = new Set();
 const envs = new Set();
 const inputs = [];
 for (const input of declaredInputs) {
  const where = `slots.${target}.inputs`;
  fields(input, ['name', 'type', 'label', 'env', 'required', 'choices', 'source'], where);
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(input.name) || RESERVED.has(input.name) || names.has(input.name)) fail(`${where} has an invalid or duplicate name`);
  names.add(input.name);
  if (input.type !== 'select' || input.required !== true) fail(`${where}.${input.name} must be a required select`);
  text(input.label, `${where}.${input.name}.label`);
  if (typeof input.env !== 'string' || !/^DEPLOY_[A-Z][A-Z0-9_]{0,47}$/.test(input.env) || RESERVED_ENV.has(input.env) || envs.has(input.env)) fail(`${where}.${input.name} has an invalid, reserved, or duplicate env name`);
  envs.add(input.env);
  if (Object.hasOwn(input, 'source') === Object.hasOwn(input, 'choices')) fail(`${where}.${input.name} needs exactly one of source or choices`);
  let choices;
  if (Object.hasOwn(input, 'source')) choices = await sourceChoices(root, input.source, fingerprints, `${where}.${input.name}.source`);
  else {
   if (!Array.isArray(input.choices) || !input.choices.length || input.choices.length > 1024) fail(`${where}.${input.name}.choices must be a non-empty array`);
   choices = input.choices.map(choice => {
    fields(choice, ['value', 'label'], `${where}.${input.name}.choices`);
    return { value: text(choice.value, 'choice value'), label: text(choice.label, 'choice label') };
   });
  }
  if (new Set(choices.map(choice => choice.value)).size !== choices.length) fail(`${where}.${input.name} has duplicate choices`);
  inputs.push({ name: input.name, type: 'select', label: input.label, env: input.env, required: true, choices });
 }
 let version = null;
 if (slot.version !== undefined) {
  fields(slot.version, ['input', 'bumpInput'], `slots.${target}.version`);
  const identity = inputs.find(input => input.name === slot.version.input);
  const bump = inputs.find(input => input.name === slot.version.bumpInput);
  if (!identity || !identity.choices.every(choice => choice.initialVersion !== undefined)) fail('version.input must name a source with version and initialVersionPath metadata');
  if (!bump || bump === identity || bump.choices.length !== 3 || !BUMPS.every(value => bump.choices.some(choice => choice.value === value))) fail('version.bumpInput must name the patch/minor/major select');
  version = { input: identity.name, bumpInput: bump.name };
 }
 const resolved = { schemaVersion: 1, target, label, script: slot.script, inputs, version };
 const revision = crypto.createHash('sha256').update(JSON.stringify({ resolved, fingerprints })).digest('hex');
 return { ...resolved, revision };
}

export async function resolveDeployManifest(workspace, target) {
 try { return await resolveManifest(workspace, target); }
 catch (error) {
  if (error instanceof DeployManifestError) throw error;
  if (typeof error.code === 'string') throw new DeployManifestError(`cannot read repository deployment data (${error.code})`);
  throw error;
 }
}

export function validateDeployInputs(slot, inputs, revision) {
 if (revision !== slot.revision) throw new DeployManifestError('choices or versions changed; reopen the deployment panel or reload this page', 409);
 fields(inputs, slot.inputs.map(input => input.name), 'inputs');
 const selected = {};
 const env = {};
 for (const input of slot.inputs) {
  if (!Object.hasOwn(inputs, input.name) || typeof inputs[input.name] !== 'string' || !input.choices.some(choice => choice.value === inputs[input.name])) {
   fail(`select a valid ${input.label}`);
  }
  selected[input.name] = inputs[input.name];
  env[input.env] = inputs[input.name];
 }
 let currentVersion = null, targetVersion = null;
 if (slot.version) {
  const identity = slot.inputs.find(input => input.name === slot.version.input);
  const choice = identity.choices.find(item => item.value === selected[identity.name]);
  currentVersion = choice.version;
  targetVersion = anticipateVersion(choice.version, choice.initialVersion, selected[slot.version.bumpInput]);
 }
 return { inputs: selected, env, currentVersion, targetVersion };
}
