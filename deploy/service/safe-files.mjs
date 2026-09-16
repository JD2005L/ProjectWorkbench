import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export async function statOptional(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function checkMetadata(stat, {
  kind = 'file', owner = 0, privateFile = false, writable = false, platform = process.platform,
} = {}) {
  if (stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`Expected a real ${kind}, not a link or special file`);
  }
  if (owner !== null && stat.uid !== owner) throw new Error('Unexpected filesystem owner');
  if (kind === 'file' && stat.nlink !== 1) throw new Error('Hard-linked files are not supported');
  if (platform !== 'win32' && !writable && (stat.mode & (privateFile ? 0o077 : 0o022))) {
    throw new Error('Filesystem permissions are too permissive');
  }
}

function components(file, anchor) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\0-\x1f\x7f]/.test(file)) {
    throw new Error('A normalized absolute filesystem path is required');
  }
  const root = anchor || path.parse(file).root;
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path escapes its trusted directory');
  }
  const result = [root];
  for (const part of relative.split(path.sep).filter(Boolean)) result.push(path.join(result.at(-1), part));
  return result;
}

export async function inspectPath(file, {
  kind = 'file', owner = 0, parentsOwner = 0, privateFile = false,
  writable = false, writableParents = false, optional = false, anchor,
} = {}) {
  const paths = components(file, anchor);
  for (let i = 0; i < paths.length; i++) {
    const stat = await statOptional(paths[i]);
    if (!stat) {
      if (optional) return null;
      throw new Error(`Missing filesystem path: ${paths[i]}`);
    }
    const last = i === paths.length - 1;
    checkMetadata(stat, {
      kind: last ? kind : 'directory', owner: last ? owner : parentsOwner,
      privateFile: last && privateFile, writable: last ? writable : writableParents,
    });
    if (last) return stat;
  }
}

export async function ensureDirectory(directory, mode = 0o755, policy = {}) {
  const paths = components(directory, policy.anchor);
  for (let i = 0; i < paths.length; i++) {
    const current = paths[i];
    if (!(await statOptional(current))) {
      await fs.mkdir(current, { mode: i === paths.length - 1 ? mode : 0o755 });
      await fs.chmod(current, i === paths.length - 1 ? mode : 0o755);
    }
    await inspectPath(current, { ...policy, kind: 'directory' });
  }
}

// NTFS change time is not a stable POSIX ctime in Windows fixtures. Linux
// host operations retain the ctime check; all platforms compare bytes too.
const IDENTITY_FIELDS = ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs',
  ...(process.platform === 'win32' ? [] : ['ctimeMs'])];
function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every(key => left[key] === right[key]);
}

export async function readSnapshot(file, { maxBytes = 4 * 1024 * 1024, ...policy } = {}) {
  const before = await inspectPath(file, policy);
  if (!before) return null;
  if (before.size > maxBytes) throw new Error('Input file exceeds the size limit');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    checkMetadata(opened, policy);
    if (!sameIdentity(before, opened)) throw new Error('Input changed while being opened');
    const bytes = await handle.readFile();
    const after = await inspectPath(file, policy);
    if (bytes.length > maxBytes || !after || !sameIdentity(opened, after)
        || !sameIdentity(opened, await handle.stat())) throw new Error('Input changed while being read');
    return { bytes, stat: opened };
  } finally { await handle.close(); }
}

export async function assertUnchanged(file, expected, policy = {}) {
  const actual = await readSnapshot(file, { ...policy, optional: true });
  if (expected === null ? actual !== null
    : !actual || !sameIdentity(expected.stat, actual.stat) || !expected.bytes.equals(actual.bytes)) {
    const reason = !expected || !actual ? 'existence'
      : !expected.bytes.equals(actual.bytes) ? 'content'
        : IDENTITY_FIELDS.filter(key => expected.stat[key] !== actual.stat[key]).join(', ');
    throw new Error(`File changed (${reason}); refusing to overwrite it: ${file}`);
  }
}

export async function syncDirectory(directory) {
  // Windows fixtures cannot fsync directory handles. The human-run tools require Linux.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicFile(file, bytes, {
  expected = null, mode = 0o600, uid = expected?.stat.uid ?? 0, gid = expected?.stat.gid ?? 0,
  policy = {},
} = {}) {
  const directory = path.dirname(file);
  await inspectPath(directory, { ...policy, owner: policy.parentsOwner ?? 0, kind: 'directory' });
  const temporary = path.join(directory, `.${path.basename(file)}.pw-deploy-${crypto.randomUUID()}`);
  const handle = await fs.open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      if (process.platform !== 'win32') await handle.chown(uid, gid);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await assertUnchanged(file, expected, policy);
    if (expected) await fs.rename(temporary, file);
    else {
      // link() publishes a complete file without clobbering a concurrently created destination.
      await fs.link(temporary, file);
      await fs.unlink(temporary);
    }
    await syncDirectory(directory);
  } finally {
    try { await fs.unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function withDirectoryLock(directory, callback, policy = {}) {
  await inspectPath(path.dirname(directory), { ...policy, kind: 'directory' });
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Operation lock already exists; inspect it before retrying: ${directory}`);
    throw error;
  }
  try { return await callback(); }
  finally { await fs.rmdir(directory); }
}

export function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

export function requireLinuxRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('This host-changing command requires a human running as root on Linux');
  }
}
