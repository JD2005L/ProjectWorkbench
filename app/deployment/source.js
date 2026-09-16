import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { credentialDropArgv, credentialExecutionPlan } from '../user-credentials.js';
import {
  DeploymentError, MAX_SOURCE_BYTES, MAX_SOURCE_FILES, MAX_REQUEST_BYTES,
  sourcePath, snapshotDigest, validateSnapshot,
} from './protocol.js';

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HELPER = fileURLToPath(import.meta.url);

function sourceError(message, code = 'deployment_source_invalid', status = 400) {
  return new DeploymentError(message, status, code);
}

function sourceName(name) {
  sourcePath(name);
  if (/(?:^|\/)(?:_inbox|_outbox)(?:\/|$)/.test(name)
      || /\.(?:db|db3|sqlite3|sqlitedb)(?:-(?:wal|shm|journal))?$/i.test(name)
      || /(?:^|\/)(?:deploy-config|workbench|users|sessions|api-tokens)\.json$/i.test(name)
      || /(?:^|\/)(?:\.secret-key|\.git-credentials|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519)$/i.test(name)
      || /^\.pw\/(?:private|secrets|credentials|runtime)(?:[./]|$)/i.test(name)) {
    throw sourceError('The commit contains runtime data or private configuration. Remove it from deployment source.');
  }
  return name;
}

export function boundedCommand(argv, {
  input, maxBytes, env = process.env, timeoutMs = 30000, spawnProcess = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const chunks = [];
    let size = 0, stderrSize = 0;
    const child = spawnProcess(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const refuse = error => { finish(error); child.kill('SIGKILL'); };
    timer = setTimeout(() => refuse(sourceError('Committed source export timed out.', 'deployment_source_timeout', 504)), timeoutMs);
    child.on('error', () => finish(sourceError('The pane account could not run the committed source exporter.', 'deployment_source_unavailable', 503)));
    child.stdout.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) refuse(sourceError('Committed source export exceeded its output limit.', 'source_too_large', 413));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrSize += chunk.length;
      if (!settled && stderrSize > 16384) refuse(sourceError('Git produced excessive diagnostic output.', 'deployment_source_invalid'));
    });
    child.on('close', code => {
      if (code !== 0) finish(sourceError('Committed source could not be read as the pane account. Check Git access and the workspace.', 'deployment_source_unavailable', 503));
      else finish(null, Buffer.concat(chunks));
    });
    child.stdin.on('error', () => {
      if (!settled) refuse(sourceError('Committed source export input was interrupted.', 'deployment_source_unavailable', 503));
    });
    child.stdin.end(input);
  });
}

export function gitEnvironment(env = process.env, owner = null, home = '') {
  const result = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  if (env.SystemRoot) result.SystemRoot = env.SystemRoot;
  if (home || owner?.home || env.HOME) result.HOME = home || owner?.home || env.HOME;
  if (owner?.user) { result.USER = owner.user; result.LOGNAME = owner.user; }
  return result;
}

export function gitRunner(workspace, { env = gitEnvironment(), spawnProcess = spawn } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || /[\0\r\n]/.test(workspace)) {
    throw sourceError('A registered absolute workspace path is required.');
  }
  return (args, options = {}) => boundedCommand([
    'git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-C', workspace, ...args,
  ], { ...options, env, spawnProcess });
}

function utf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw sourceError('Git source names must be valid UTF-8.'); }
}

// ls-tree supplies sizes before any blob is loaded; cat-file --batch reads the
// exact object IDs without filters, hooks, a checkout, or a temporary snapshot.
export async function exportCommittedSource(runGit) {
  const revisionAtHead = async () => {
    const revision = utf8(await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { maxBytes: 256 })).trim();
    if (!REVISION.test(revision)) throw sourceError('Deployment requires an exact committed Git revision.');
    return revision;
  };
  const requireClean = async () => {
    const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBytes: 1024 * 1024 });
    if (status.length) throw sourceError('External deployment requires a clean committed workspace. Commit or remove local changes yourself; nothing was stashed, committed, or uploaded.', 'deployment_workspace_dirty', 409);
  };
  await requireClean();
  const revision = await revisionAtHead();
  const tree = utf8(await runGit(['ls-tree', '-r', '-z', '--long', '--full-tree', revision], {
    maxBytes: MAX_SOURCE_FILES * 2160,
  }));
  const rows = tree.split('\0');
  if (rows.pop() !== '') throw sourceError('Git returned an incomplete source tree.');
  if (!rows.length || rows.length > MAX_SOURCE_FILES) throw sourceError(`Deployment source must contain 1-${MAX_SOURCE_FILES} regular files.`, 'source_too_large', 413);
  let total = 0;
  const entries = rows.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +(\d+)\t([\s\S]+)$/.exec(row);
    if (!match) throw sourceError('Only committed regular files are supported. Symlinks and submodules cannot be deployed.');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw sourceError('Git returned an invalid blob size.');
    total += size;
    if (total > MAX_SOURCE_BYTES) throw sourceError('Deployment source exceeds 32 MiB.', 'source_too_large', 413);
    return { path: sourceName(match[4]), oid: match[2], size, executable: match[1] === '100755' };
  });
  const blobs = await runGit(['cat-file', '--batch'], {
    input: `${entries.map(entry => entry.oid).join('\n')}\n`,
    maxBytes: total + entries.length * 200,
  });
  let offset = 0;
  const files = entries.map(entry => {
    const newline = blobs.indexOf(10, offset);
    if (newline < offset || newline - offset > 160) throw sourceError('Git returned an invalid blob header.');
    const header = blobs.subarray(offset, newline).toString('ascii');
    if (header !== `${entry.oid} blob ${entry.size}`) throw sourceError('Git source identity changed during export.', 'deployment_source_changed', 409);
    offset = newline + 1;
    const end = offset + entry.size;
    if (end >= blobs.length || blobs[end] !== 10) throw sourceError('Git returned an incomplete blob.');
    const file = { path: entry.path, data: blobs.subarray(offset, end).toString('base64'), executable: entry.executable };
    offset = end + 1;
    return file;
  });
  if (offset !== blobs.length) throw sourceError('Git returned unexpected source data.');
  await requireClean();
  if (await revisionAtHead() !== revision) throw sourceError('HEAD changed during source export. Reopen deployment and try again.', 'deployment_source_changed', 409);
  return { revision, source: validateSnapshot({ sha256: snapshotDigest(files), files }) };
}

export function snapshotArgv({ owner, currentUid = process.getuid?.() ?? null, execPath = process.execPath }) {
  if ((owner && (!Number.isSafeInteger(owner.uid) || owner.uid <= 0 || !Number.isSafeInteger(owner.gid) || owner.gid <= 0))
      || (!owner && (currentUid === null || currentUid === 0))) {
    throw sourceError('External deployment requires a resolved non-root pane account. Source will not be read as root.', 'deployment_source_owner', 503);
  }
  const plan = credentialExecutionPlan({ owner, currentUid });
  return [...(plan.drop ? credentialDropArgv({ owner, execPath, helperPath: HELPER }) : [execPath, HELPER]), '--snapshot'];
}

export async function exportWorkspaceSnapshot({ workspace, owner, home, currentUid, env = process.env, spawnProcess = spawn }) {
  const argv = snapshotArgv({ owner, currentUid });
  const raw = await boundedCommand(argv, {
    input: JSON.stringify({ workspace }), maxBytes: MAX_REQUEST_BYTES, timeoutMs: 120000,
    env: gitEnvironment(env, owner, home), spawnProcess,
  });
  let result;
  try { result = JSON.parse(raw.toString('utf8')); }
  catch { throw sourceError('The source exporter returned an invalid response.', 'deployment_source_invalid', 502); }
  if (result.ok !== true) {
    const allowed = new Set(['deployment_workspace_dirty', 'deployment_source_changed', 'deployment_source_invalid', 'source_too_large',
      'deployment_source_unavailable', 'deployment_source_timeout', 'deployment_source_owner']);
    if (!allowed.has(result.code) || typeof result.error !== 'string' || result.error.length > 1000) throw sourceError('Committed source export failed.');
    throw sourceError(result.error, result.code, [400, 409, 413, 503, 504].includes(result.status) ? result.status : 400);
  }
  if (!REVISION.test(result.revision || '')) throw sourceError('The source exporter returned an invalid revision.');
  return { revision: result.revision, source: validateSnapshot(result.source) };
}

async function main() {
  try {
    if (!process.getuid || process.getuid() === 0) throw sourceError('The source exporter refuses to run as root.', 'deployment_source_owner', 503);
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8192) throw sourceError('Invalid source export request.');
    }
    const { workspace } = JSON.parse(raw);
    const result = await exportCommittedSource(gitRunner(workspace));
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    const known = error instanceof DeploymentError;
    process.stdout.write(JSON.stringify({ ok: false, code: known ? error.code : 'deployment_source_invalid',
      error: known ? error.message : 'Committed source export failed.', status: known ? error.statusCode : 400 }));
  }
}

if (process.argv[2] === '--snapshot' && process.argv[1] && path.resolve(process.argv[1]) === HELPER) await main();
