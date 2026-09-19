import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateHostConfig } from '../../app/deployment/policy.js';
import {
  atomicFile, assertUnchanged, ensureDirectory, inspectPath, parseJson, readSnapshot,
  requireLinuxRoot, statOptional, syncDirectory, withDirectoryLock,
} from './safe-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const UNIT = 'pw-deploy.service';
const MANAGED = '# Managed by Project Workbench deployment service installer.';
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/;
export const PAYLOAD = Object.freeze([
  'app/atomic-file.js',
  ...['service', 'protocol', 'policy', 'store', 'engine', 'executor', 'step', 'output', 'builder-diagnostics']
    .map(name => `app/deployment/${name}.js`),
  ...['install.sh', 'install.mjs', 'safe-files.mjs', 'dashboard-card.mjs', 'inventory.mjs',
    'config.example.json', 'pw-deploy.service.in'].map(name => `deploy/service/${name}`),
  'docs/deployment-service.md',
]);

export function validateSystemdRunHelp(help) {
  if (typeof help !== 'string') throw new Error('Host systemd-run returned invalid help text');
  for (const flag of ['--wait', '--pipe', '--collect', '--uid', '--property',
    '--working-directory', '--service-type']) {
    if (!help.includes(flag)) throw new Error(`Host systemd-run lacks required supervision option ${flag}`);
  }
}

export function hostPath(value, label = 'Path') {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(value)
      || path.posix.normalize(value) !== value || value.endsWith('/')
      || value.split('/').some(part => part === '.git')
      || value.split('/').filter(Boolean).length < 2) {
    throw new Error(`${label} must be a normalized absolute Linux path with at least two components and no spaces`);
  }
  return value;
}

export function parseOptions(args) {
  const options = {
    prefix: '/opt/pw-deploy', configDir: '/etc/pw-deploy', stateDir: '/var/lib/pw-deploy',
    buildUser: 'pw-deploy-build', host: '127.0.0.1', port: 3800, provided: new Set(),
  };
  const values = {
    '--prefix': 'prefix', '--config-dir': 'configDir', '--state-dir': 'stateDir',
    '--build-user': 'buildUser', '--runtime-user': 'runtimeUser', '--build-home': 'buildHome',
    '--host': 'host', '--port': 'port', '--subuid-range': 'subuidRange', '--subgid-range': 'subgidRange',
  };
  const flags = {
    '--create-build-user': 'createBuildUser', '--enable-linger': 'enableLinger',
    '--socket': 'socket', '--activate': 'activate', '--restart': 'restart', '--check': 'check', '--help': 'help',
  };
  for (let i = 0; i < args.length; i++) {
    const name = values[args[i]] || flags[args[i]];
    if (!name || options.provided.has(name)) throw new Error('Unknown or duplicate installation option');
    options.provided.add(name);
    if (values[args[i]]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Installation option needs a value');
      options[name] = value;
    } else options[name] = true;
  }
  for (const field of ['prefix', 'configDir', 'stateDir']) hostPath(options[field], field);
  options.runtimeUser ??= options.buildUser;
  options.buildHome ??= `/var/lib/${options.buildUser}`;
  hostPath(options.buildHome, 'buildHome');
  for (const field of ['buildUser', 'runtimeUser']) {
    if (!ACCOUNT.test(options[field]) || options[field] === 'root') throw new Error('Execution accounts must be named non-root accounts');
  }
  options.port = Number(options.port);
  if (!['127.0.0.1', '::1'].includes(options.host)
      || !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error('Listener must use loopback and an unprivileged port');
  }
  if (options.socket && (options.provided.has('host') || options.provided.has('port'))) {
    throw new Error('Choose a Unix socket or a loopback host/port, not both');
  }
  if (options.activate && options.restart) throw new Error('Choose --activate or --restart, not both');
  return options;
}

export function defaultConfiguration(options) {
  return {
    listen: options.socket ? { socketPath: '/run/pw-deploy/control.sock' } : { host: options.host, port: options.port },
    tokenFile: `${options.configDir}/service.token`, stateDir: options.stateDir,
    buildUser: options.buildUser, runtimeUser: options.runtimeUser, healthHosts: ['127.0.0.1', '::1'],
    unitName: UNIT, adapters: ['script', 'iis', 'podman'], resourceNames: {},
    maxConcurrent: 1, defaultTimeoutSeconds: 600, retentionDays: 7,
  };
}

export function parseRange(value) {
  if (typeof value !== 'string' || !/^\d+:\d+$/.test(value)) throw new Error('Subordinate range must be START:COUNT');
  const [start, count] = value.split(':').map(Number);
  if (!Number.isSafeInteger(start) || start < 65536 || !Number.isSafeInteger(count) || count < 65536
      || start + count - 1 > 4294967294) throw new Error('Subordinate range must contain at least 65536 IDs above 65535');
  return { start, count, end: start + count - 1 };
}

export function parseSubordinateIds(text) {
  const ranges = [];
  for (const line of text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))) {
    const parts = line.split(':');
    const start = Number(parts[1]), count = Number(parts[2]);
    if (parts.length !== 3 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(parts[0])
        || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !Number.isSafeInteger(start)
        || !Number.isSafeInteger(count) || count < 1 || start + count - 1 > 4294967294) {
      throw new Error('Malformed subordinate-ID database; ask the operator to repair it');
    }
    const range = { owner: parts[0], start, count, end: start + count - 1 };
    if (ranges.some(other => range.start <= other.end && other.start <= range.end)) {
      throw new Error('Overlapping subordinate-ID allocations; operator review is required');
    }
    ranges.push(range);
  }
  return ranges;
}

export function planSubordinateIds(ranges, account, requested, allocatedIds = []) {
  const owns = range => range.owner === account.name
    || (account.uid !== undefined && range.owner === String(account.uid));
  const existing = ranges.filter(owns);
  if (!requested) {
    if (!existing.some(range => range.count >= 65536)) {
      throw new Error('Missing subordinate-ID allocation; supply an explicitly reviewed START:COUNT range');
    }
    if (existing.some(range => allocatedIds.some(id => id >= range.start && id <= range.end))) {
      throw new Error('Subordinate IDs overlap an enumerated account or group ID');
    }
    return null;
  }
  const range = parseRange(requested);
  if (allocatedIds.some(id => id >= range.start && id <= range.end)) {
    throw new Error('Requested subordinate IDs overlap an enumerated account or group ID');
  }
  const overlap = ranges.filter(other => range.start <= other.end && other.start <= range.end);
  if (overlap.length === 1 && owns(overlap[0]) && overlap[0].start === range.start && overlap[0].count === range.count) return null;
  if (overlap.length) throw new Error('Requested subordinate IDs conflict with an existing allocation');
  return range;
}

export function parseAccount(text, name) {
  const entries = text.trim().split('\n');
  const parts = entries[0].split(':');
  const uid = Number(parts[2]), gid = Number(parts[3]);
  if (entries.length !== 1 || parts.length !== 7 || parts[0] !== name
      || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])
      || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0
      || !path.posix.isAbsolute(parts[5])) throw new Error('Execution identity must resolve to a non-root UID and GID');
  return { name, uid, gid, home: parts[5], shell: parts[6] };
}

function run(command, args, allowed = [0]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/root' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || !allowed.includes(result.status)) {
    throw new Error(`Prerequisite command failed: ${path.basename(command)} (output suppressed)`);
  }
  return { status: result.status, output: result.stdout.trim() };
}

async function executable(file) {
  const real = await fs.realpath(file);
  await inspectPath(real);
  await fs.access(real, constants.X_OK);
}

async function findTool(name) {
  for (const directory of ['/usr/sbin', '/usr/bin']) {
    const file = `${directory}/${name}`;
    if (await statOptional(file)) { await executable(file); return file; }
  }
  throw new Error(`Required host tool is missing: ${name}; installation is an operator task`);
}

export async function lookupAccount(name, { optional = false, runCommand = run } = {}) {
  const result = runCommand('/usr/bin/getent', ['passwd', name], optional ? [0, 2] : [0]);
  return result.status === 2 ? null : parseAccount(result.output, name);
}

async function checkBuilder(identity) {
  const local = (await readSnapshot('/etc/passwd')).bytes.toString('utf8').split('\n');
  if (!local.some(line => line.split(':')[0] === identity.name)
      || !['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/false', '/bin/false'].includes(identity.shell)) {
    throw new Error('Builder must be a dedicated local account with a nologin/false shell');
  }
  const shadow = run('/usr/bin/getent', ['shadow', identity.name]).output.split(':');
  if (shadow[0] !== identity.name || !/^[!*]/.test(shadow[1] || '')) throw new Error('Builder password must be locked');
  const groups = run('/usr/bin/id', ['-G', identity.name]).output.split(/\s+/).map(Number);
  if (!groups.length || groups.some(gid => gid !== identity.gid)) {
    throw new Error('Dedicated builder must not have supplementary groups');
  }
  for (const directory of ['/usr/bin', '/usr/sbin']) {
    const sudo = `${directory}/sudo`;
    if (await statOptional(sudo)) {
      await executable(sudo);
      if (run(sudo, ['-n', '-l', '-U', identity.name], [0, 1]).status === 0) {
        throw new Error('Builder has sudo permissions; an operator must remove those grants');
      }
      break;
    }
  }
  await inspectPath(identity.home, { kind: 'directory', owner: identity.uid });
}

export function allocatedAccountIds(passwdText, groupText, identities = []) {
  const rows = text => text.split(/\r?\n/).filter(Boolean).map(line => line.split(':'));
  const idAt = (fields, index) => {
    const value = fields[index];
    const id = Number(value);
    if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(id) || id < 0) {
      throw new Error('Cannot enumerate account IDs safely');
    }
    return id;
  };
  const passwd = rows(passwdText);
  const allocatedUids = new Set(passwd.map(fields => idAt(fields, 2)));
  const allocatedGids = new Set([...passwd.map(fields => idAt(fields, 3)),
    ...rows(groupText).map(fields => idAt(fields, 2))]);
  // NSS may resolve a user's passwd entry without exposing a group entry or
  // enumerating that user. Its known primary GID still reserves an actual ID.
  for (const identity of identities) {
    if (!identity || !Number.isSafeInteger(identity.uid) || identity.uid <= 0
        || !Number.isSafeInteger(identity.gid) || identity.gid <= 0) {
      throw new Error('Known execution identities must have non-root UID/GID values');
    }
    allocatedUids.add(identity.uid);
    allocatedGids.add(identity.gid);
  }
  return { allocatedUids: [...allocatedUids], allocatedGids: [...allocatedGids] };
}

async function readSubordinateState(identities = []) {
  const [uids, gids] = await Promise.all(['/etc/subuid', '/etc/subgid'].map(file => readSnapshot(file)));
  const allocated = allocatedAccountIds(run('/usr/bin/getent', ['passwd']).output,
    run('/usr/bin/getent', ['group']).output, identities);
  return {
    uids: parseSubordinateIds(uids.bytes.toString('utf8')), gids: parseSubordinateIds(gids.bytes.toString('utf8')),
    ...allocated,
  };
}

function disjoint(paths) {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[i] === paths[j] || paths[i].startsWith(`${paths[j]}/`) || paths[j].startsWith(`${paths[i]}/`)) {
        throw new Error('Code, configuration, service state, builder home, and source checkout must be separate directories');
      }
    }
  }
}

async function requireStepTraversal(directory) {
  for (let current = directory; current !== '/'; current = path.posix.dirname(current)) {
    const stat = await statOptional(current);
    if (stat && !(stat.mode & 0o001)) {
      throw new Error('Code and stage/home parent directories must be traversable by the non-root execution accounts');
    }
  }
}

export function validateCodeDirectoryMode(mode, { platform = process.platform } = {}) {
  if (!Number.isInteger(mode)) throw new Error('Invalid installed code directory mode');
  if (platform !== 'win32' && (mode & 0o555) !== 0o555) {
    throw new Error('Installed code directories must remain readable/traversable by step accounts');
  }
}

export function activationCommands(options) {
  const commands = [['daemon-reload']];
  if (options.activate) commands.push(['enable', '--now', UNIT]);
  if (options.restart) commands.push(['restart', UNIT]);
  return commands;
}

export function renderUnit(template, release, configFile) {
  hostPath(release, 'Release');
  hostPath(configFile, 'Configuration');
  template = template.replace(/\r\n/g, '\n');
  if (!template.startsWith(`${MANAGED}\n`) || !template.includes('@RELEASE@') || !template.includes('@CONFIG@')) {
    throw new Error('Unexpected deployment unit template');
  }
  return template.replaceAll('@RELEASE@', release).replaceAll('@CONFIG@', configFile);
}

function managedUnit(snapshot) {
  return !snapshot || snapshot.bytes.toString('utf8').split(/\r?\n/, 1)[0] === MANAGED;
}

async function readPayload(repo) {
  const payload = new Map();
  for (const name of PAYLOAD) {
    const file = path.join(repo, ...name.split('/'));
    const snapshot = await readSnapshot(file, {
      anchor: repo, owner: null, parentsOwner: null, writable: true, writableParents: true,
    });
    payload.set(name, /\.(?:sh|in)$/.test(name)
      ? Buffer.from(snapshot.bytes.toString('utf8').replace(/\r\n/g, '\n')) : snapshot.bytes);
  }
  payload.set('app/package.json', Buffer.from('{"private":true,"type":"module"}\n'));
  return payload;
}

export async function stageRelease(repo, prefix, policy = {}) {
  await ensureDirectory(prefix, 0o755, policy);
  validateCodeDirectoryMode((await inspectPath(prefix, { ...policy, kind: 'directory' })).mode);
  if (await statOptional(path.join(prefix, '.git'))) throw new Error('Installation prefix must not be a Git checkout');
  const payload = await readPayload(repo);
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of [...payload].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    hash.update(`${name}\0`).update(bytes).update('\0');
  }
  const digest = hash.digest('hex');
  payload.set('release.json', Buffer.from(`${JSON.stringify({
    schemaVersion: 1, sha256: digest, files: [...payload.keys()].sort(),
  }, null, 2)}\n`));
  const releases = path.join(prefix, 'releases');
  await ensureDirectory(releases, 0o755, policy);
  validateCodeDirectoryMode((await inspectPath(releases, { ...policy, kind: 'directory' })).mode);
  const destination = path.join(releases, digest);
  if (await statOptional(destination)) {
    const found = [];
    async function visit(directory, relative = '') {
      const directoryStat = await inspectPath(directory, { ...policy, kind: 'directory' });
      validateCodeDirectoryMode(directoryStat.mode);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (![...payload.keys()].some(file => file.startsWith(`${name}/`))) throw new Error('Unexpected directory in installed release');
          await visit(path.join(directory, entry.name), name);
        }
        else {
          const expected = payload.get(name);
          const snapshot = await readSnapshot(path.join(directory, entry.name), policy);
          if (!expected || !snapshot.bytes.equals(expected)) {
            throw new Error('Existing release differs from its package; refusing to replace it');
          }
          if (process.platform !== 'win32' && (snapshot.stat.mode & 0o777) !== (name.endsWith('.sh') ? 0o755 : 0o644)) {
            throw new Error('Installed release has unexpected file permissions');
          }
          found.push(name);
        }
      }
    }
    await visit(destination);
    if (found.length !== payload.size) throw new Error('Existing release is incomplete; refusing to replace it');
    return { directory: destination, digest };
  }
  const temporary = path.join(releases, `.stage-${crypto.randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o755 });
  await fs.chmod(temporary, 0o755);
  try {
    for (const [name, bytes] of payload) {
      const file = path.join(temporary, ...name.split('/'));
      await ensureDirectory(path.dirname(file), 0o755, policy);
      await atomicFile(file, bytes, {
        mode: name.endsWith('.sh') ? 0o755 : 0o644,
        uid: policy.owner ?? 0, gid: process.getgid?.() ?? 0, policy,
      });
    }
    await fs.rename(temporary, destination);
    await syncDirectory(releases);
  } finally {
    // Only the freshly allocated staging directory is eligible for cleanup.
    if (await statOptional(temporary)) await fs.rm(temporary, { recursive: true });
  }
  return { directory: destination, digest };
}

export async function prepareStateDirectories(stateDir, policy = {}) {
  const directories = [stateDir, path.join(stateDir, 'jobs')];
  for (const directory of directories) {
    await inspectPath(directory, { ...policy, kind: 'directory', optional: true });
  }
  for (const directory of directories) {
    await ensureDirectory(directory, 0o711, policy);
    const stat = await inspectPath(directory, { ...policy, kind: 'directory' });
    if ((stat.mode & 0o7777) !== 0o711) await fs.chmod(directory, 0o711);
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
}

export async function installFiles(plan, policy = {}) {
  await assertUnchanged(plan.configFile, plan.configSnapshot, { ...policy, privateFile: true });
  await assertUnchanged(plan.tokenFile, plan.tokenSnapshot, { ...policy, privateFile: true });
  await assertUnchanged(plan.unitFile, plan.unitSnapshot, policy);
  if (!managedUnit(plan.unitSnapshot)) {
    throw new Error('Existing systemd unit is not managed by this installer');
  }
  const release = await stageRelease(plan.repo, plan.prefix, policy);
  await ensureDirectory(path.dirname(plan.configFile), 0o700, policy);
  await ensureDirectory(path.dirname(plan.tokenFile), 0o700, policy);
  await prepareStateDirectories(plan.stateDir, policy);
  await ensureDirectory(path.dirname(plan.unitFile), 0o755, policy);
  const ownership = { uid: policy.owner ?? 0, gid: process.getgid?.() ?? 0, policy };
  if (!plan.tokenSnapshot) {
    await atomicFile(plan.tokenFile, `${crypto.randomBytes(48).toString('base64url')}\n`, { ...ownership, mode: 0o600 });
  }
  if (!plan.configSnapshot) {
    await atomicFile(plan.configFile, `${JSON.stringify(plan.configuration, null, 2)}\n`, { ...ownership, mode: 0o600 });
  }
  const unit = plan.renderUnit
    ? plan.renderUnit(release.directory, plan.configFile)
    : renderUnit((await readSnapshot(path.join(release.directory, 'deploy', 'service', 'pw-deploy.service.in'), policy))
      .bytes.toString('utf8'), release.directory, plan.configFile);
  if (!plan.unitSnapshot?.bytes.equals(Buffer.from(unit))) {
    await atomicFile(plan.unitFile, unit, { ...ownership, expected: plan.unitSnapshot, mode: 0o644 });
  }
  return release;
}

async function preflight(options) {
  for (const file of ['/usr/bin/node', '/usr/bin/bash', '/usr/bin/npm', '/usr/bin/podman',
    '/usr/bin/setpriv', '/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/getent', '/usr/bin/id']) {
    await executable(file);
  }
  for (const tool of ['newuidmap', 'newgidmap']) await findTool(tool);
  await readPayload(REPO);
  if (Number(run('/usr/bin/node', ['--version']).output.match(/^v(\d+)\./)?.[1] || 0) < 20) {
    throw new Error('Host /usr/bin/node must be Node.js 20 or newer');
  }
  if (!run('/usr/bin/setpriv', ['--help']).output.includes('--no-new-privs')) throw new Error('setpriv lacks no-new-privileges support');
  validateSystemdRunHelp(run('/usr/bin/systemd-run', ['--help']).output);
  run('/usr/bin/systemctl', ['show', '--property=Version', '--value']);
  const configFile = `${options.configDir}/config.json`;
  const configSnapshot = await readSnapshot(configFile, { optional: true, privateFile: true });
  const configuration = configSnapshot ? parseJson(configSnapshot.bytes, 'Service configuration') : defaultConfiguration(options);
  const config = validateHostConfig(configuration);
  if (config.unitName !== UNIT) throw new Error('The packaged unit must be named pw-deploy.service');
  for (const field of ['stateDir', 'buildUser', 'runtimeUser']) {
    if (configSnapshot && options.provided.has(field) && options[field] !== config[field]) {
      throw new Error('Existing configuration is preserved; edit policy deliberately instead of overriding installation flags');
    }
  }
  if (configSnapshot && ['host', 'port', 'socket'].some(field => options.provided.has(field))
      && JSON.stringify(config.listen) !== JSON.stringify(defaultConfiguration(options).listen)) {
    throw new Error('Existing listener is preserved; edit policy deliberately');
  }
  hostPath(config.stateDir, 'stateDir');
  hostPath(config.tokenFile, 'tokenFile');
  if (config.tokenFile !== `${options.configDir}/service.token`) {
    throw new Error('Installer expects service.token beside config.json; preserve a custom policy through operator-managed packaging');
  }
  if (config.listen.socketPath && config.listen.socketPath !== '/run/pw-deploy/control.sock') {
    throw new Error('Packaged Unix transport uses /run/pw-deploy/control.sock');
  }
  const tokenSnapshot = await readSnapshot(config.tokenFile, { optional: true, privateFile: true, maxBytes: 1024 });
  if (configSnapshot && !tokenSnapshot) throw new Error('Existing configuration has no credential; refusing to silently generate a replacement');
  if (tokenSnapshot && !/^[\x21-\x7e]{32,512}$/.test(tokenSnapshot.bytes.toString('utf8').trim())) {
    throw new Error('Existing service credential has an invalid format');
  }
  const unitFile = `/etc/systemd/system/${UNIT}`;
  const unitSnapshot = await readSnapshot(unitFile, { optional: true });
  if (!managedUnit(unitSnapshot)) {
    throw new Error('An unmanaged pw-deploy.service already exists; operator review is required');
  }
  const activity = run('/usr/bin/systemctl', ['is-active', UNIT], [0, 3, 4]).output;
  if (options.activate && !['inactive', 'failed', 'unknown'].includes(activity)) {
    throw new Error('--activate is for an inactive service; use an explicit --restart during a maintenance window');
  }
  if (options.restart && !unitSnapshot) throw new Error('--restart requires an existing managed service');
  let builder = await lookupAccount(config.buildUser, { optional: true });
  if (!builder && !options.createBuildUser) throw new Error('Builder account is missing; use --create-build-user to authorize creating it');
  if (builder) {
    await checkBuilder(builder);
    if (options.provided.has('buildHome') && options.buildHome !== builder.home) throw new Error('Existing builder home is preserved');
  } else if (run('/usr/bin/getent', ['group', config.buildUser], [0, 2]).status === 0) {
    throw new Error('Builder group already exists without its account; operator review is required');
  }
  const builderHome = builder?.home || (options.provided.has('buildHome') ? options.buildHome : `/var/lib/${config.buildUser}`);
  hostPath(builderHome, 'Builder home');
  disjoint([options.prefix, options.configDir, config.stateDir, builderHome, REPO]);
  const codeDirectories = [options.prefix, path.join(options.prefix, 'releases')];
  for (const directory of [...codeDirectories, options.configDir, config.stateDir, path.join(config.stateDir, 'jobs')]) {
    const stat = await inspectPath(directory, { kind: 'directory', optional: true });
    if (stat && codeDirectories.includes(directory)) validateCodeDirectoryMode(stat.mode);
  }
  for (const directory of [options.prefix, path.dirname(config.stateDir), path.dirname(builderHome)]) {
    await requireStepTraversal(directory);
  }
  if (await statOptional(`${options.prefix}/.git`)) throw new Error('Installation prefix must not be a Git checkout');
  if (!builder) {
    await inspectPath(path.dirname(builderHome), { kind: 'directory' });
    if (await statOptional(builderHome)) throw new Error('New builder home already exists; refusing to adopt its contents');
  }
  const runtime = config.runtimeUser === config.buildUser ? builder : await lookupAccount(config.runtimeUser);
  if (runtime && runtime.name !== config.buildUser) {
    await inspectPath(runtime.home, { kind: 'directory', owner: runtime.uid });
    await requireStepTraversal(path.dirname(runtime.home));
  }
  const subids = await readSubordinateState([builder, runtime].filter(Boolean));
  const candidate = builder || { name: config.buildUser };
  const subuid = planSubordinateIds(subids.uids, candidate, options.subuidRange, subids.allocatedUids);
  const subgid = planSubordinateIds(subids.gids, candidate, options.subgidRange, subids.allocatedGids);
  if (runtime && runtime.name !== config.buildUser) {
    planSubordinateIds(subids.uids, runtime, null, subids.allocatedUids);
    planSubordinateIds(subids.gids, runtime, null, subids.allocatedGids);
  }
  const tools = {};
  if (!builder) {
    tools.useradd = await findTool('useradd');
    tools.nologin = await findTool('nologin');
  }
  if (subuid || subgid) {
    tools.usermod = await findTool('usermod');
    const help = run(tools.usermod, ['--help']).output;
    if (!help.includes('--add-subuids') || !help.includes('--add-subgids')) {
      throw new Error('Host account tools lack subordinate-ID support');
    }
  }
  for (const name of new Set([config.buildUser, config.runtimeUser])) {
    if (options.enableLinger) tools.loginctl = await findTool('loginctl');
    else if (!(await statOptional(`/var/lib/systemd/linger/${name}`))) {
      throw new Error('Rootless account lingering must be configured by the operator, or explicitly use --enable-linger');
    }
  }
  return {
    repo: REPO, prefix: options.prefix, configFile, configuration, config, configSnapshot,
    tokenFile: config.tokenFile, tokenSnapshot, stateDir: config.stateDir, unitFile, unitSnapshot,
    builder, builderHome, runtime, subuid, subgid, tools,
  };
}

async function provisionAccounts(plan, options) {
  if (!plan.builder) {
    run(plan.tools.useradd, ['--system', '--create-home', '--home-dir', plan.builderHome, '--user-group',
      '--shell', plan.tools.nologin, '--password', '!', '--key', 'SUB_UID_COUNT=0', '--key', 'SUB_GID_COUNT=0',
      plan.config.buildUser]);
  }
  const builder = await lookupAccount(plan.config.buildUser);
  await checkBuilder(builder);
  const runtime = plan.config.runtimeUser === builder.name ? builder : await lookupAccount(plan.config.runtimeUser);
  const identities = [builder, runtime];
  const latest = await readSubordinateState(identities);
  const uid = planSubordinateIds(latest.uids, builder, options.subuidRange, latest.allocatedUids);
  const gid = planSubordinateIds(latest.gids, builder, options.subgidRange, latest.allocatedGids);
  if (uid || gid) {
    if (!plan.tools.usermod) throw new Error('Subordinate-ID policy changed after preflight; repeat installation preflight');
    const args = [];
    if (uid) args.push('--add-subuids', `${uid.start}-${uid.end}`);
    if (gid) args.push('--add-subgids', `${gid.start}-${gid.end}`);
    args.push(builder.name);
    run(plan.tools.usermod, args);
  }
  const verified = await readSubordinateState(identities);
  for (const identity of identities) {
    planSubordinateIds(verified.uids, identity, null, verified.allocatedUids);
    planSubordinateIds(verified.gids, identity, null, verified.allocatedGids);
  }
  if (options.enableLinger) {
    for (const name of new Set([plan.config.buildUser, plan.config.runtimeUser])) {
      run(plan.tools.loginctl, ['enable-linger', name]);
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Human-run PW deployment service installer (Node.js 20+, Linux/systemd).
Options: --prefix PATH --config-dir PATH --state-dir PATH --build-user USER
  --runtime-user USER --build-home PATH --host LOOPBACK --port PORT | --socket
  --create-build-user --subuid-range START:COUNT --subgid-range START:COUNT
  --enable-linger --check --activate | --restart
Default: prepare files and reload unit definitions only; never start/restart a service.
Existing policy, credential, state, runtime units, and previous releases are preserved.
`);
    return;
  }
  requireLinuxRoot();
  process.umask(0o077);
  const plan = await preflight(options);
  if (options.check) {
    process.stdout.write('Installation preflight passed; no account, file, or service changes made.\n');
    return;
  }
  await ensureDirectory(plan.prefix, 0o755);
  await withDirectoryLock(`${plan.prefix}/.install-lock`, async () => {
    await assertUnchanged(plan.configFile, plan.configSnapshot, { privateFile: true });
    await assertUnchanged(plan.tokenFile, plan.tokenSnapshot, { privateFile: true });
    await assertUnchanged(plan.unitFile, plan.unitSnapshot);
    await provisionAccounts(plan, options);
    const release = await installFiles(plan);
    for (const args of activationCommands(options)) run('/usr/bin/systemctl', args);
    const endpoint = plan.config.listen.socketPath ? `unix:${plan.config.listen.socketPath}`
      : `http://${plan.config.listen.host === '::1' ? '[::1]' : plan.config.listen.host}:${plan.config.listen.port}`;
    process.stdout.write(`Prepared release: ${release.directory}\nConfiguration: ${plan.configFile}\nCredential file: ${plan.tokenFile}\nEndpoint: ${endpoint}\n`);
    process.stdout.write(options.activate || options.restart
      ? 'Requested service activation completed. PW global backend selection was not changed.\n'
      : 'Service not started or restarted. PW global backend selection was not changed.\n');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Installation refused: ${error.message}\n`); process.exitCode = 1; });
}
