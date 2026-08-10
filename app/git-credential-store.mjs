// The per-workspace Git credential store: created, replaced, removed, and inspected safely.
//
// WHAT WENT WRONG (GOA-6)
//
// `syncProjectCredentials` wrote `<workspace>/.git/.pw-credentials` and ran `git config --local`
// mutations from the dashboard process. The dashboard is root in BOTH deploy modes (host: root node
// -> `sudo -u admin tmux`; container: root node -> setpriv), while the workspace and its `.git`
// belong to the unprivileged pane account. GOA found the result live: a root-owned `0600` helper
// inside a pane-owned `.git`. That is a credential-boundary defect and a functional one at once —
// the pane account cannot read the file written for it, so git authentication silently fails for
// the user the credential belongs to.
//
// WHY CHOWN-AFTER-WRITE IS NOT THE REPAIR
//
// It does nothing about the window between `open` and `chown`, and nothing at all about *where the
// write landed*. An account that controls the directory can replace the target with a symlink
// first; root then follows it and writes a decrypted credential wherever the link points, and the
// chown lands on the wrong file too. `.git/config` compounds it, because Git config can name
// programs to execute (`core.pager`, `credential.helper`, `core.fsmonitor`), so a root write inside
// an account-controlled `.git` is a privilege-escalation primitive, not just an ownership mistake.
//
// THE THREE PROPERTIES THIS MODULE PROVIDES
//
//   1. It runs AS the workspace owner. Callers reach it through the vetted privilege-drop boundary
//      (app/credential-writer.mjs via credentialDropArgv), so the kernel is enforcing the account's
//      own limits rather than us trying to be careful with root's.
//   2. Nothing is ever followed. `.git` is `lstat`ed and must be a real directory owned by the
//      expected account; the target is `lstat`ed and must be a regular file with one link; the new
//      content goes to a fresh file opened `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`.
//   3. Publication is atomic. Content is written and fsynced to a temp file in the SAME directory,
//      then `rename()`d over the target. `rename` resolves the destination once, never follows a
//      symlink at the final component, and cannot leave a partial file visible. That is also what
//      makes it safe against a target swapped after validation: the pre-checks are defence in
//      depth, the rename is the guarantee.
//
// This module spawns nothing — there is no shell here to quote into, and no argv a token could
// appear in. It also never puts credential material into a return value, an error, or a message:
// callers log both.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CREDENTIAL_FILENAME = '.pw-credentials';

/** A refusal, distinguishable from a crash. `reason` is safe to log; it never carries a secret. */
export class CredentialBoundaryError extends Error {
  constructor(reason, code = 'EPWCRED') {
    super(reason);
    this.name = 'CredentialBoundaryError';
    this.reason = reason;
    this.code = code;
  }
}

const refuse = (reason) => { throw new CredentialBoundaryError(reason); };

/** Where a workspace's store lives. Pure path arithmetic; resolves nothing. */
export function credentialStorePath(projectPath) {
  return path.join(projectPath, '.git', CREDENTIAL_FILENAME);
}

/** The credential line git's `store` helper expects. Kept in one place so no caller formats it. */
function storeLine(token) {
  return `https://${token}:x-oauth-basic@github.com\n`;
}

function requireAbsolute(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') refuse('a project path is required');
  if (!path.isAbsolute(projectPath)) refuse('the project path must be absolute');
  return projectPath;
}

/**
 * Validate the containing `.git` directory without following it.
 *
 * `expectUid` is the account this work is supposed to be running as and the account that must own
 * the directory. A mismatch means either we are not who we think we are, or this is not the
 * workspace we think it is — both are refusals, never something to repair by chowning.
 */
async function validateGitDir(projectPath, expectUid) {
  const gitDir = path.join(projectPath, '.git');
  let st;
  try {
    st = await fsp.lstat(gitDir);
  } catch {
    refuse('the project has no .git directory');
  }
  if (st.isSymbolicLink()) refuse('.git is a symlink; refusing to operate through it');
  if (!st.isDirectory()) refuse('.git is not a directory');
  if (expectUid !== undefined && expectUid !== null && st.uid !== expectUid) {
    refuse(`.git is not owned by the expected workspace owner (uid ${st.uid} != ${expectUid})`);
  }
  return gitDir;
}

/**
 * What is at the target right now. Reports type, ownership and mode; never opens or reads it, so an
 * inspection can never block on a fifo or surface credential content.
 */
export async function inspectCredentialStore({ projectPath }) {
  requireAbsolute(projectPath);
  const target = credentialStorePath(projectPath);
  let st;
  try {
    st = await fsp.lstat(target);
  } catch {
    return { kind: 'absent', path: target };
  }
  const kind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'regular' : 'irregular';
  return { kind, path: target, uid: st.uid, gid: st.gid, mode: st.mode & 0o777, nlink: st.nlink };
}

/** Refusals that apply to whatever currently occupies the target. Shared by write and remediation. */
function refuseUnsafeTarget(found) {
  if (found.kind === 'symlink') {
    refuse('a symlink is planted at the credential path; refusing to write through it');
  }
  if (found.kind === 'irregular') {
    refuse('the credential path is not a regular file; refusing to open it');
  }
  if (found.kind === 'regular' && found.nlink > 1) {
    refuse(`the credential path has a link count of ${found.nlink}; another name refers to the same file`);
  }
}

/**
 * Create or replace the store, atomically, as the workspace owner.
 *
 * @param {object}  o
 * @param {string}  o.projectPath      absolute workspace path
 * @param {string}  o.token            the credential; never logged, returned, or placed in argv
 * @param {number}  [o.expectUid]      the account that must own `.git` (and this process)
 * @param {object}  [o.alreadyInspected] a prior inspection to reuse instead of re-checking. Only
 *                  for proving the rename is what guarantees safety; production callers omit it.
 * @param {number}  [o.foreignUid]     test seam: treat the existing target as owned by this uid
 * @param {boolean} [o.failBeforePublish] test seam: fail after fsync, before the rename
 * @returns {Promise<{action:'written', displacedForeign:boolean, path:string}>}
 */
export async function writeCredentialStore({
  projectPath, token, expectUid, alreadyInspected = null, foreignUid = null, failBeforePublish = false,
}) {
  requireAbsolute(projectPath);
  if (!token) refuse('a token is required to write a credential store');
  const gitDir = await validateGitDir(projectPath, expectUid);
  const target = credentialStorePath(projectPath);

  const found = alreadyInspected || await inspectCredentialStore({ projectPath });
  if (!alreadyInspected) refuseUnsafeTarget(found);

  // An existing regular file owned by somebody else is the live GOA shape. It is displaced rather
  // than refused — displacing it is the remediation — but the caller is told, because a credential
  // artifact appearing under an unexpected owner is worth an operator's attention.
  const effectiveUid = foreignUid !== null ? foreignUid : found.uid;
  const displacedForeign = found.kind === 'regular'
    && expectUid !== undefined && expectUid !== null
    && effectiveUid !== undefined && effectiveUid !== expectUid;

  // Same directory as the target, so the publish is a rename within one filesystem and therefore
  // atomic. The suffix is random so concurrent writers never collide on it.
  const tmp = path.join(gitDir, `${CREDENTIAL_FILENAME}.tmp.${crypto.randomBytes(6).toString('hex')}`);
  let handle;
  try {
    // O_EXCL: we are the only creator. O_NOFOLLOW: even our own temp name cannot be pre-planted as
    // a link. The mode is passed AND re-applied below, because the process umask can clear bits.
    handle = await fsp.open(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(storeLine(token), 'utf8');
    // Durable before it is visible: a crash between rename and flush would otherwise publish a
    // name pointing at unwritten blocks.
    await handle.sync();
    await handle.close();
    handle = null;

    if (failBeforePublish) refuse('write interrupted before publish (test seam)');

    // The publish. rename() is atomic, replaces whatever the name refers to, and never follows a
    // symlink at the final component — so a target swapped after validation is replaced, not
    // written through.
    await fsp.rename(tmp, target);
  } catch (e) {
    if (handle) { try { await handle.close(); } catch { /* already closed */ } }
    // Never leave a temp file holding a live credential behind.
    try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
    if (e instanceof CredentialBoundaryError) throw e;
    // Wrap so no underlying error message — which may quote a path or a syscall argument — can
    // carry anything unexpected out to a log.
    throw new CredentialBoundaryError(`could not publish the credential store (${e?.code || 'unknown error'})`);
  }

  return { action: 'written', displacedForeign, path: target };
}

/**
 * Remove the store. Never follows a link: unlinking a symlink removes the link itself, which is
 * both correct and the safe outcome, and is reported distinctly so an operator learns one was there.
 */
export async function removeCredentialStore({ projectPath, expectUid }) {
  requireAbsolute(projectPath);
  await validateGitDir(projectPath, expectUid);
  const found = await inspectCredentialStore({ projectPath });
  if (found.kind === 'absent') return { action: 'absent', path: found.path };
  try {
    await fsp.unlink(found.path);
  } catch (e) {
    if (e?.code === 'ENOENT') return { action: 'absent', path: found.path };
    throw new CredentialBoundaryError(`could not remove the credential store (${e?.code || 'unknown error'})`);
  }
  return { action: found.kind === 'regular' ? 'removed' : 'removed-unsafe', path: found.path };
}
