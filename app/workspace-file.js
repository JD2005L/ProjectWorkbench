// Workspace file drops (project inbox uploads), done by the account that owns
// the workspace.
//
// ============================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE — the same one app/user-credentials.js
// states for the credential tree, applied to the other tree the pane account owns:
//
//   The root dashboard must never perform a filesystem operation on a path that
//   the unprivileged terminal account controls.
//
// `<project>/_inbox` is exactly such a path: the workspace belongs to the pane
// account, so replacing `_inbox` with a symlink is entirely within that
// account's authority. The superseded upload routes then did three privileged
// operations on it, each of which follows a link at the final component:
//
//   fs.mkdir(inbox, {recursive:true})        -> traverses the link
//   fs.writeFile(inbox + '/' + name, bytes)  -> root-owned content, anywhere
//   chown <owner> <inbox> <file>             -> GNU chown follows a command-line
//                                               symlink; no -h, no -P
//
// Reproduced: with `_inbox -> /some/root/dir`, `chown 1000:1000 _inbox` converts
// the TARGET directory and leaves the link untouched. That is a straight local
// privilege escalation from "has a project terminal" to root.
//
// THE REPAIR IS STRUCTURAL, not defensive. The dashboard resolves the terminal
// owner, drops to it through the same vetted fixed-argv mechanism the credential
// helper uses (setpriv in container mode, `sudo -u` in host mode — see
// credentialDropArgv), and runs app/workspace-writer.mjs, which does the write
// with exactly the authority the pane account already has. No chown is needed,
// because the file is created by its eventual owner. There is no confused deputy
// left to exploit.
//
// The payload travels on the helper's STDIN, after a single JSON header line, so
// it never reaches a command line and a multi-gigabyte upload is streamed rather
// than buffered.
//
// The worker is hardened in its own right even though it is unprivileged, because
// "unprivileged" is a bound on the damage, not a licence to follow links:
// the create is O_CREAT|O_EXCL|O_NOFOLLOW onto a private temp name and the
// publish is rename(2). Neither follows a symlink at the final component, so
// neither can be raced — the lstat below refuses a link by NAME, for a clear
// error, but it is deliberately not what makes the write safe.

import path from 'node:path';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { credentialDropArgv } from './user-credentials.js';

/** Where project file drops land, relative to the project path. */
export const INBOX_DIR = '_inbox';
/** Readable and rewritable by the pane account that owns it; the dashboard reads it back as root. */
export const INBOX_FILE_MODE = 0o644;
export const INBOX_DIR_MODE = 0o755;

/** A payload larger than this before the header's newline is not a header at all. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Is this a name that can only ever address one entry directly inside `_inbox`?
 *
 * Rejects anything with a path separator, the two directory entries, NUL and
 * newline (the header framing), and leading dots — the last both because the
 * drawer's listing has no use for hidden files and because it keeps the worker's
 * own `.pw-inbox-*.part` temp namespace unreachable from a caller-supplied name.
 * Upload names are always `<ISO stamp>-<slug><ext>`, so nothing legitimate is lost.
 */
export function isSafeInboxName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (/[\0\n\r/\\]/.test(name)) return false;
  if (name.startsWith('.')) return false;
  return name === path.basename(name);
}

/**
 * argv for running the workspace writer as the terminal owner.
 *
 * Deliberately delegates to credentialDropArgv rather than growing a second
 * drop mechanism: one vetted fixed-argv abstraction, no shell, nothing secret on
 * the command line. When no drop is needed — the dashboard and the panes already
 * share an account — the helper still runs, so there is exactly ONE
 * implementation of the write and it is the hardened one.
 */
export function inboxWriteArgv({ plan, execPath, helperPath }) {
  if (!execPath || !helperPath) throw new Error('inboxWriteArgv: execPath and helperPath required');
  if (!plan || !plan.drop) return [execPath, helperPath];
  return credentialDropArgv({ owner: plan.owner, execPath, helperPath });
}

/**
 * Run one inbox write in a dropped child: the job as a JSON header line, then
 * the payload streamed straight through, then one JSON result back.
 *
 * A payload stream that dies (client abort, connection reset) does not settle
 * this promise on its own — the child is asked to stand down with SIGTERM and
 * the CHILD's report wins, because the child is the one that knows whether it
 * published anything. Only if the child says nothing does the stream's own error
 * become the message.
 */
export function runInboxWrite({ spawn, argv, job, source, timeoutMs = 15 * 60 * 1000 }) {
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
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(hardTimer); fn(arg); } };
    let hardTimer = null;
    const timer = setTimeout(() => {
      // SIGTERM first so the worker can unlink its temp; SIGKILL only if it does
      // not go, which is the one case that can leave a `.part` file behind.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      hardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
      finish(reject, new Error('workspace writer timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* the worker died before writing */ }
      if (code === 0 && parsed && parsed.ok) return finish(resolve, parsed.result);
      const error = new Error(
        parsed?.error || sourceError?.message || err.trim().split('\n').pop() || `workspace writer exited ${code}`,
      );
      if (parsed?.code) error.code = parsed.code;
      finish(reject, error);
    });
    // The worker exiting early (a refusal) closes this pipe; that EPIPE is
    // expected and must not pre-empt the worker's own explanation.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(job)}\n`);
    pipeline(source, child.stdin).catch((e) => {
      sourceError = e;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    });
  });
}

/**
 * Read the one JSON header line off a stream and hand the remainder back as the
 * payload.
 *
 * The remainder matters: the header and the first payload bytes routinely arrive
 * in the SAME chunk, and a reader that discards the tail of that chunk silently
 * truncates every upload. The stream is iterated with `destroyOnReturn: false`
 * so that leaving the header loop does not destroy the source out from under the
 * payload, and the payload continues on the very same iterator.
 */
export async function readJobHeader(stdin) {
  const unreadable = () => new Error('workspace writer: unreadable job');
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

/**
 * Write one payload into `<projectPath>/_inbox/<name>` as whoever is running.
 *
 * This is the whole worker, kept here rather than in the executable so it can be
 * driven directly — including its adversarial cases — without a privilege drop
 * or a running server.
 *
 * `allowEmpty` exists to preserve a difference the two upload routes already
 * had: the streaming route rejects a 0-byte body (that failure mode is why it
 * exists), while the JSON route has always accepted an empty file as an
 * ordinary, if odd, thing to drop.
 *
 * `onTemp` reports the temp path as soon as it exists, so an executable wrapper
 * can unlink it from a signal handler if the controller stands it down.
 */
export async function applyInboxWrite({
  fsp, projectPath, name, source, allowEmpty = false, onTemp = null,
  mode = INBOX_FILE_MODE, dirMode = INBOX_DIR_MODE,
}) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('workspace writer: project path required');
  if (!isSafeInboxName(name)) throw new Error(`workspace writer: unsafe upload name ${JSON.stringify(String(name))}`);
  const inbox = path.join(projectPath, INBOX_DIR);

  // Refuse a substituted `_inbox` by name, so an operator gets a comprehensible
  // error rather than a mysterious EACCES. This is NOT the security boundary —
  // a check-then-use lstat is still TOCTOU; the open below is what cannot be raced.
  let st = null;
  try { st = await fsp.lstat(inbox); } catch { st = null; }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`workspace writer: ${INBOX_DIR} is a symlink; refusing to write through it`);
    if (!st.isDirectory()) throw new Error(`workspace writer: ${INBOX_DIR} is not a directory`);
  } else {
    await fsp.mkdir(inbox, { recursive: true, mode: dirMode });
  }

  // A private name that cannot already exist, opened O_EXCL|O_NOFOLLOW: nothing
  // planted at this path, and nothing planted between the lstat above and here,
  // can redirect the write.
  const tmp = path.join(inbox, `.pw-inbox-${process.pid}-${crypto.randomBytes(8).toString('hex')}.part`);
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
    // to rewrite what was dropped into its own inbox, and the drawer has to be
    // able to serve it back.
    await handle.chmod(mode);
    await handle.close();
    closed = true;
    // rename(2) replaces a symlink sitting at the destination rather than
    // following it, so a link planted at the upload name is defused, not obeyed.
    const full = path.join(inbox, name);
    await fsp.rename(tmp, full);
    published = true;
    return { path: full, bytes };
  } finally {
    if (!closed) await handle.close().catch(() => {});
    if (!published) await fsp.unlink(tmp).catch(() => {});
  }
}
