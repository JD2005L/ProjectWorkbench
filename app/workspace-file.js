// Workspace boxes (`_inbox` and `_outbox`), operated on by the account that
// owns the workspace.
//
// ============================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE — the same one app/user-credentials.js
// states for the credential tree, applied to the other trees the pane account owns:
//
//   The root dashboard must never perform a filesystem operation on a path that
//   the unprivileged terminal account controls.
//
// `<project>/_inbox` and `<project>/_outbox` are exactly such paths. The
// workspace belongs to the pane account, so replacing either with a symlink is
// entirely within that account's authority — and the dashboard runs as root.
//
// WHAT THAT REACHED, before this module. The reported vector was the upload
// chown:
//
//   fs.mkdir(box, {recursive:true})          -> traverses the link
//   fs.writeFile(box + '/' + name, bytes)    -> root-owned content, anywhere
//   chown <owner> <box> <file>               -> GNU chown follows a command-line
//                                               symlink; no -h, no -P
//
// Reproduced: with `_inbox -> /some/root/dir`, `chown 1000:1000 _inbox` converts
// the TARGET directory and leaves the link untouched. But the same substitution
// made every OTHER route on both boxes a root primitive too:
//
//   fs.readdir + fs.stat     -> names, sizes and mtimes of a root-only directory
//   res.sendFile / download  -> the BYTES of a root-only file
//   fs.rm(box + '/' + name)  -> an arbitrary root file, deleted by basename
//   fs.rm(..., recursive)    -> an arbitrary root directory, emptied
//
// Together that is a local privilege escalation from "has a project terminal" to
// arbitrary root read and arbitrary root delete.
//
// THE REPAIR IS STRUCTURAL, not defensive. The dashboard resolves the terminal
// owner, drops to it through the same vetted fixed-argv mechanism the credential
// helper uses (setpriv in container mode, `sudo -u` in host mode — see
// credentialDropArgv), and runs app/workspace-writer.mjs, which does the work
// with exactly the authority the pane account already has. Root performs no
// filesystem operation below either box. No chown is needed for a write, because
// the file is created by its eventual owner. There is no confused deputy left.
//
// Payloads travel on the helper's STDIN after a single JSON header line, and a
// download comes back on its STDOUT the same way, so bytes never reach a command
// line and an upload or download of any size is streamed rather than buffered.
//
// THE lstat REFUSALS BELOW ARE NOT THE BOUNDARY. The boundary is that root never
// runs these operations. A check-then-use lstat is still TOCTOU, and it is kept
// only so an operator gets a comprehensible error instead of a puzzling EACCES,
// and so a confused deputy cannot be built out of the worker's own authority.
// Where a single operation CAN be made race-proof it is: the write creates
// O_CREAT|O_EXCL|O_NOFOLLOW onto a private temp name and publishes with
// rename(2), the read opens O_NOFOLLOW, and the list lstats rather than stats.

import path from 'node:path';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { credentialDropArgv } from './user-credentials.js';

/** The two terminal-owned boxes, and the ONLY directories this worker will touch. */
export const INBOX_DIR = '_inbox';
export const OUTBOX_DIR = '_outbox';
export const WORKSPACE_BOXES = new Set([INBOX_DIR, OUTBOX_DIR]);

/** Readable and rewritable by the pane account that owns it; the dashboard reads it back. */
export const INBOX_FILE_MODE = 0o644;
export const INBOX_DIR_MODE = 0o755;

/** How long a worker gets to stand down politely before it is killed outright. */
export const HARD_KILL_GRACE_MS = 2000;

/** Metadata jobs are quick; a write or a download carries a whole file. */
const JOB_TIMEOUT_MS = 60 * 1000;
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

/** A payload larger than this before the header's newline is not a header at all. */
const MAX_HEADER_BYTES = 64 * 1024;

const unsafeName = (name) => new Error(`workspace worker: unsafe entry name ${JSON.stringify(String(name))}`);
function notFound(name) {
  const e = new Error(`workspace worker: no such entry ${JSON.stringify(String(name))}`);
  e.code = 'not-found';
  return e;
}

/**
 * Is this a name that can only ever address one entry directly inside a box?
 *
 * Rejects anything with a path separator, the two directory entries, NUL and
 * newline (the header framing), and leading dots — the last both because the
 * drawer's listing has no use for hidden files and because it keeps the worker's
 * own `.pw-inbox-*.part` temp namespace unreachable from a caller-supplied name.
 * Upload names are always `<ISO stamp>-<slug><ext>`, so nothing legitimate is lost.
 */
export function isSafeBoxName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (/[\0\n\r/\\]/.test(name)) return false;
  if (name.startsWith('.')) return false;
  return name === path.basename(name);
}

/**
 * argv for running the workspace worker as the terminal owner.
 *
 * Deliberately delegates to credentialDropArgv rather than growing a second
 * drop mechanism: one vetted fixed-argv abstraction, no shell, nothing secret on
 * the command line. When no drop is needed — the dashboard and the panes already
 * share an account — the worker still runs, so there is exactly ONE
 * implementation of every box operation and it is the hardened one.
 */
export function workspaceJobArgv({ plan, execPath, helperPath }) {
  if (!execPath || !helperPath) throw new Error('workspaceJobArgv: execPath and helperPath required');
  if (!plan || !plan.drop) return [execPath, helperPath];
  return credentialDropArgv({ owner: plan.owner, execPath, helperPath });
}

// ---------------------------------------------------------------------------
// Controller side
// ---------------------------------------------------------------------------

/**
 * SIGTERM asks; SIGKILL insists.
 *
 * The escalation timer deliberately OUTLIVES whatever promise is being settled:
 * a worker that ignores SIGTERM still has to be stopped, and an earlier revision
 * of this file cleared the timer from inside finish(), one line after scheduling
 * it, so the SIGKILL its own comment promised could never fire. The close
 * listener is registered BEFORE the signal because a stubbed or already-dead
 * child can emit 'close' synchronously from kill().
 */
function standDown(child) {
  let hard = null;
  let gone = false;
  child.once('close', () => { gone = true; if (hard) clearTimeout(hard); });
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  if (gone) return null;
  hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, HARD_KILL_GRACE_MS);
  hard.unref?.();
  return hard;
}

/**
 * Run one job in a dropped child and collect its single JSON reply: the job as a
 * header line, an optional payload streamed straight through, one result back.
 *
 * A payload stream that dies (client abort, connection reset) does not settle
 * this promise on its own — the child is asked to stand down and the CHILD's
 * report wins, because the child is the one that knows whether it published
 * anything. Only if the child says nothing does the stream's own error become
 * the message.
 */
function collectJob({ spawn, argv, job, source = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let sourceError = null;
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      standDown(child);
      finish(reject, new Error('workspace worker timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* the worker died before writing */ }
      if (code === 0 && parsed && parsed.ok) return finish(resolve, parsed.result);
      const error = new Error(
        parsed?.error || sourceError?.message || err.trim().split('\n').pop() || `workspace worker exited ${code}`,
      );
      if (parsed?.code) error.code = parsed.code;
      finish(reject, error);
    });
    // The worker exiting early (a refusal) closes this pipe; that EPIPE is
    // expected and must not pre-empt the worker's own explanation.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(job)}\n`);
    if (source) {
      pipeline(source, child.stdin).catch((e) => { sourceError = e; standDown(child); });
    } else {
      child.stdin.end();
    }
  });
}

/** A metadata job — list, delete, clear. Nothing streams in either direction. */
export function runWorkspaceJob({ spawn, argv, job, timeoutMs = JOB_TIMEOUT_MS }) {
  return collectJob({ spawn, argv, job, timeoutMs });
}

/** A write: the payload streams IN on the worker's stdin. */
export function runWorkspaceWrite({ spawn, argv, job, source, timeoutMs = TRANSFER_TIMEOUT_MS }) {
  return collectJob({ spawn, argv, job, source, timeoutMs });
}

/**
 * A read: the payload streams OUT on the worker's stdout, behind the same one
 * JSON header line the job itself uses.
 *
 * Resolves to `{ result, stream, child }`. The caller owns the stream and MUST
 * stand the child down (`child.kill`) if it abandons the transfer — the timeout
 * covers only the handshake, deliberately, because a legitimately large download
 * over a slow link must not be shot in the middle.
 */
export function runWorkspaceRead({ spawn, argv, job, timeoutMs = JOB_TIMEOUT_MS }) {
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return Promise.reject(e);
  }
  let err = '';
  let exit = null;
  let spawnError = null;
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { spawnError = e; });
  child.on('close', (code) => { exit = code; });
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify(job)}\n`);

  // Only the handshake is timed. A worker that never answers is stood down, its
  // stdout closes, and the header read below rejects.
  const timer = setTimeout(() => { standDown(child); }, timeoutMs);

  return readJobHeader(child.stdout).then(
    (read) => {
      clearTimeout(timer);
      const envelope = read.job;
      if (!envelope || envelope.ok !== true) {
        standDown(child);
        const e = new Error(envelope?.error || 'workspace worker refused the read');
        if (envelope?.code) e.code = envelope.code;
        throw e;
      }
      return { result: envelope.result, stream: read.source, child };
    },
    () => {
      clearTimeout(timer);
      standDown(child);
      throw spawnError || new Error(err.trim().split('\n').pop() || `workspace worker exited ${exit}`);
    },
  );
}

/**
 * Read the one JSON header line off a stream and hand the remainder back as the
 * payload. Used on the worker's stdin for a write and on its stdout for a read —
 * the framing is the same in both directions.
 *
 * The remainder matters: the header and the first payload bytes routinely arrive
 * in the SAME chunk, and a reader that discards the tail of that chunk silently
 * truncates every transfer. The stream is iterated with `destroyOnReturn: false`
 * so that leaving the header loop does not destroy the source out from under the
 * payload, and the payload continues on the very same iterator.
 */
export async function readJobHeader(stdin) {
  const unreadable = () => new Error('workspace worker: unreadable job');
  const it = stdin.iterator ? stdin.iterator({ destroyOnReturn: false }) : stdin[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await it.next();
    if (done) throw unreadable();
    buffered = Buffer.concat([buffered, Buffer.isBuffer(value) ? value : Buffer.from(value)]);
    const nl = buffered.indexOf(0x0a);
    if (nl === -1) {
      if (buffered.length > MAX_HEADER_BYTES) throw unreadable();
      continue;
    }
    let job;
    try { job = JSON.parse(buffered.subarray(0, nl).toString('utf8')); } catch { throw unreadable(); }
    if (!job || typeof job !== 'object') throw unreadable();
    const rest = buffered.subarray(nl + 1);
    const source = Readable.from((async function* payload() {
      if (rest.length) yield rest;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    })());
    return { job, source };
  }
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/**
 * The box directory, or `null` when it simply does not exist yet.
 *
 * `box` is checked against a fixed allowlist, so it can never become
 * caller-chosen traversal however the job arrived. The symlink refusal is for a
 * comprehensible error, NOT for safety — see the note at the top of this file.
 */
async function boxDir({ fsp, projectPath, box, create = false, dirMode = INBOX_DIR_MODE }) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('workspace worker: project path required');
  if (!WORKSPACE_BOXES.has(box)) throw new Error(`workspace worker: unknown workspace box ${JSON.stringify(String(box))}`);
  const dir = path.join(projectPath, box);
  let st = null;
  try { st = await fsp.lstat(dir); } catch { st = null; }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`workspace worker: ${box} is a symlink; refusing to work through it`);
    if (!st.isDirectory()) throw new Error(`workspace worker: ${box} is not a directory`);
    return dir;
  }
  if (!create) return null;
  await fsp.mkdir(dir, { recursive: true, mode: dirMode });
  return dir;
}

/**
 * Write one payload into `<projectPath>/<box>/<name>` as whoever is running.
 *
 * This is the whole worker, kept here rather than in the executable so it can be
 * driven directly — including its adversarial cases — without a privilege drop
 * or a running server.
 *
 * `allowEmpty` preserves a difference the two upload routes already had: the
 * streaming route rejects a 0-byte body (that failure mode is why it exists),
 * while the JSON route has always accepted an empty file as an ordinary, if odd,
 * thing to drop.
 *
 * `onTemp` reports the temp path as soon as it exists, so an executable wrapper
 * can unlink it from a signal handler if the controller stands it down.
 */
export async function applyBoxWrite({
  fsp, projectPath, box = INBOX_DIR, name, source, allowEmpty = false, onTemp = null,
  mode = INBOX_FILE_MODE, dirMode = INBOX_DIR_MODE,
}) {
  if (!isSafeBoxName(name)) throw unsafeName(name);
  const dir = await boxDir({ fsp, projectPath, box, create: true, dirMode });

  // A private name that cannot already exist, opened O_EXCL|O_NOFOLLOW: nothing
  // planted at this path, and nothing planted between the lstat above and here,
  // can redirect the write.
  const tmp = path.join(dir, `.pw-inbox-${process.pid}-${crypto.randomBytes(8).toString('hex')}.part`);
  const handle = await fsp.open(
    tmp,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    mode,
  );
  if (onTemp) onTemp(tmp);

  let closed = false;
  let published = false;
  let bytes = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!buf.length) continue;
      await handle.write(buf);
      bytes += buf.length;
    }
    if (bytes === 0 && !allowEmpty) {
      const empty = new Error('Received 0 bytes');
      empty.code = 'empty-payload';
      throw empty;
    }
    // Deterministic regardless of this account's umask: the pane has to be able
    // to rewrite what was dropped into its own box, and the drawer has to be
    // able to serve it back.
    await handle.chmod(mode);
    await handle.close();
    closed = true;
    // rename(2) replaces a symlink sitting at the destination rather than
    // following it, so a link planted at the entry name is defused, not obeyed.
    const full = path.join(dir, name);
    await fsp.rename(tmp, full);
    published = true;
    return { path: full, bytes };
  } finally {
    if (!closed) await handle.close().catch(() => {});
    if (!published) await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * The regular files in a box, with the metadata the drawer renders and sorts on.
 *
 * lstat rather than stat, and links are not listed: following one would be the
 * very traversal this worker exists to avoid, and the superseded route already
 * excluded links by way of readdir's d_type.
 */
export async function applyBoxList({ fsp, projectPath, box }) {
  const dir = await boxDir({ fsp, projectPath, box });
  if (!dir) return { files: [] };
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    let st;
    try { st = await fsp.lstat(path.join(dir, entry.name)); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ name: entry.name, size: st.size, mtime: st.mtime.toISOString() });
  }
  return { files };
}

/**
 * Open one entry for download. Resolves to `{ bytes, mtime, stream }`.
 *
 * O_NOFOLLOW so a link planted at the entry name is refused rather than
 * followed. Every "cannot open" outcome collapses to `not-found`, so the route
 * answers 404 without publishing whether a link, a directory or nothing at all
 * is sitting there.
 */
export async function applyBoxRead({ fsp, projectPath, box, name }) {
  if (!isSafeBoxName(name)) throw unsafeName(name);
  const dir = await boxDir({ fsp, projectPath, box });
  if (!dir) throw notFound(name);
  let handle;
  try {
    handle = await fsp.open(path.join(dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw notFound(name);
  }
  let st;
  try {
    st = await handle.stat();
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
  if (!st.isFile()) {
    await handle.close().catch(() => {});
    throw notFound(name);
  }
  return { bytes: st.size, mtime: st.mtime.toISOString(), stream: handle.createReadStream({ autoClose: true }) };
}

/**
 * Remove one entry. `force` keeps the superseded route's behaviour that deleting
 * something already gone is a success, and rm without `recursive` removes a
 * symlink itself rather than what it points at.
 */
export async function applyBoxDelete({ fsp, projectPath, box, name }) {
  if (!isSafeBoxName(name)) throw unsafeName(name);
  const dir = await boxDir({ fsp, projectPath, box });
  if (!dir) return { name };
  await fsp.rm(path.join(dir, name), { force: true });
  return { name };
}

/** Empty a box, subdirectories included — the behaviour clear-all has always had. */
export async function applyBoxClear({ fsp, projectPath, box }) {
  const dir = await boxDir({ fsp, projectPath, box });
  if (!dir) return { removed: [] };
  const names = await fsp.readdir(dir);
  await Promise.all(names.map((n) => fsp.rm(path.join(dir, n), { force: true, recursive: true })));
  return { removed: names };
}
