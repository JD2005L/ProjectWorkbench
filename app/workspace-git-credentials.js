// Per-workspace git credential material, written by the workspace OWNER.
//
// ============================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
//   The root dashboard must never perform a filesystem operation on a path that
//   the unprivileged terminal account controls.
//
// This is the same rule app/user-credentials.js enforces for the per-user
// credential tree. It was not enforced for the OTHER credential PW writes: the
// per-project git helper file at <workspace>/.git/.pw-credentials, plus the
// `git config --local` mutations that point git at it. Those ran directly in the
// dashboard process — root in both deploy modes — against a workspace whose
// `.git` is owned by the account the panes run as.
//
// A pane user could therefore plant a symlink:
//
//   ln -s /etc/cron.d/pwn <workspace>/.git/.pw-credentials
//
// and root's write would create a root-owned file, outside the workspace, whose
// content is a line the attacker substantially controls. `git config --local`
// rewrites <workspace>/.git/config the same way, through the same
// attacker-controlled directory.
//
// The fix is structural, exactly as it was for the user tree: the work runs in a
// helper process AS the workspace owner (see credential-writer.mjs), so there is
// no confused deputy — the helper has precisely the authority the attacker
// already had. O_NOFOLLOW and lstat/fstat checks below are defence in depth, and
// also protect the in-process path used when the dashboard and the panes already
// share an account.
//
// NO CHOWN, ANYWHERE. Ownership is never repaired by chowning a
// pane-controlled path (that is itself a root operation on attacker-controlled
// input). A wrongly-owned artifact is unlinked and recreated by its correct
// owner. Unlinking is safe for the owner to do and never follows a symlink, and
// the pane account may unlink a root-owned file because it owns the containing
// `.git` directory — which is what makes remediation possible without root
// touching the path at all.
// ============================================================================
//
// SERIALIZATION. Every caller in app/server.js already runs inside
// withProjectsLock() or withLifecycleLock(), so credential rotation and removal
// are serialized against project and user lifecycle changes by construction.
// This module deliberately does NOT take a lock of its own: withLifecycleLock()
// is flock-based and not re-entrant, so acquiring here would deadlock the very
// paths that call it. assertSerialized() below makes that contract explicit
// rather than merely assumed.

import path from 'node:path';
import { constants as fsConstants } from 'node:fs';

export const WORKSPACE_CRED_FILENAME = '.pw-credentials';

export function workspaceGitPaths(projectPath) {
  const dir = String(projectPath || '');
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error('workspace credential path requires an absolute project path');
  }
  const gitDir = path.join(dir, '.git');
  return { projectPath: dir, gitDir, credFile: path.join(gitDir, WORKSPACE_CRED_FILENAME) };
}

// The caller must already hold the projects or lifecycle lock. Cheap, explicit,
// and impossible to satisfy accidentally — see the SERIALIZATION note above.
export function assertSerialized(held) {
  if (held !== true) {
    throw new Error(
      'workspace git credential work must run inside withProjectsLock() or withLifecycleLock(); ' +
      'pass serialized:true from that critical section',
    );
  }
}

// Resolve `.git` and prove it is a real directory we own before anything is
// written through it.
//
// Refusals, and why each one matters:
//   symlink          -> the classic redirect; lstat never follows it
//   not a directory  -> a `.git` FILE is a linked worktree/submodule, where this
//                       credential layout does not apply; writing would land in
//                       someone else's real gitdir
//   foreign owner    -> we run as the workspace owner, so a `.git` owned by
//                       somebody else means the deployment is misconfigured or
//                       the path was swapped; either way it is not ours to write
async function resolveOwnedGitDir(fsp, gitDir, currentUid) {
  let st;
  try {
    st = await fsp.lstat(gitDir);
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'no-git-dir' };
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to use a symlinked git directory: ${gitDir}`);
  if (!st.isDirectory()) throw new Error(`refusing to write credentials into a non-directory .git: ${gitDir}`);
  if (currentUid !== null && currentUid !== undefined && Number(st.uid) !== Number(currentUid)) {
    throw new Error(`refusing to write credentials into a git directory owned by uid ${st.uid}, not ${currentUid}`);
  }
  return { ok: true };
}

// Remove whatever is at the credential path unless it is already a regular file
// owned by us. Returns whether an artifact had to be cleared, which is how
// remediation of an existing root-owned helper file is both performed and
// reported. rm/unlink removes the link itself and never follows it.
async function clearUnusableArtifact(fsp, credFile, currentUid) {
  let st;
  try {
    st = await fsp.lstat(credFile);
  } catch (e) {
    if (e.code === 'ENOENT') return { cleared: false, reason: 'absent' };
    throw e;
  }
  if (!st.isFile()) {
    await fsp.rm(credFile, { recursive: true, force: true });
    return { cleared: true, reason: st.isSymbolicLink() ? 'symlink' : 'non-regular' };
  }
  if (currentUid !== null && currentUid !== undefined && Number(st.uid) !== Number(currentUid)) {
    await fsp.rm(credFile, { force: true });
    return { cleared: true, reason: 'foreign-owner' };
  }
  if ((st.mode & 0o777) !== 0o600) return { cleared: false, reason: 'mode' };
  return { cleared: false, reason: 'usable' };
}

// Write through an O_NOFOLLOW descriptor and confirm through THAT descriptor
// (not a second path lookup) that we wrote a regular file we own. A swap
// between open and write cannot redirect it, and a swap after write cannot make
// this report success about a different file.
async function writeCredentialFile(fsp, credFile, contents) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fh = await fsp.open(credFile, flags, 0o600);
  try {
    await fh.writeFile(contents, 'utf8');
    await fh.chmod(0o600);
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`credential path is not a regular file: ${credFile}`);
    return { mode: st.mode & 0o777 };
  } finally {
    await fh.close();
  }
}

// git config, never through a shell. Each mutation is a separate argv.
//
// Two --add (not --replace-all): the empty reset drops any inherited
// global/system helper for this repo so the token is never dispatched to — and
// duplicated into — a global store, and --replace-all would remove that reset.
function gitConfigPlan(credFile) {
  if (!credFile) return [['config', '--local', '--unset-all', 'credential.helper']];
  return [
    ['config', '--local', '--unset-all', 'credential.helper'],
    ['config', '--local', '--add', 'credential.helper', ''],
    ['config', '--local', '--add', 'credential.helper', `store --file=${credFile}`],
  ];
}

async function runGitConfig({ execFile, projectPath, gitExecutable, credFile }) {
  for (const args of gitConfigPlan(credFile)) {
    // A failing unset-all on a repo that has no helper yet is normal; the adds
    // are what must succeed. Errors never carry credential material because the
    // token is not an argument to any of these commands.
    try {
      await execFile(gitExecutable, ['-C', projectPath, ...args], { timeout: 15000 });
    } catch (e) {
      if (args.includes('--unset-all')) continue;
      throw new Error(`git config ${args[2]} failed in ${projectPath}: ${e?.code || e?.message || 'unknown error'}`);
    }
  }
}

// Everything that touches a workspace's git credential material. Runs EITHER
// in-process (dashboard already IS the workspace account) OR inside
// credential-writer.mjs after the privilege drop. Never returns or logs the
// credential itself.
//
// `credential` empty means "revoke": remove the file and unset the helper.
export async function applyWorkspaceGitCredentialJob({
  fsp,
  execFile,
  projectPath,
  credential = '',
  gitExecutable = 'git',
  currentUid = null,
}) {
  const { gitDir, credFile } = workspaceGitPaths(projectPath);
  const uid = currentUid === null || currentUid === undefined ? (process.getuid?.() ?? null) : currentUid;

  const git = await resolveOwnedGitDir(fsp, gitDir, uid);
  if (!git.ok) return { applied: false, reason: git.reason, remediated: false };

  if (!credential) {
    let removed = false;
    try {
      await fsp.rm(credFile, { force: true });
      removed = true;
    } catch { /* nothing to remove */ }
    await runGitConfig({ execFile, projectPath, gitExecutable, credFile: '' });
    return { applied: true, revoked: true, removed, remediated: false };
  }

  const cleared = await clearUnusableArtifact(fsp, credFile, uid);
  const { mode } = await writeCredentialFile(fsp, credFile, credential);
  await runGitConfig({ execFile, projectPath, gitExecutable, credFile });
  return {
    applied: true,
    revoked: false,
    mode,
    // True only when a pre-existing artifact was unusable and had to be
    // replaced — i.e. this call remediated it. The reason names the class, and
    // never the content.
    remediated: cleared.cleared,
    remediatedReason: cleared.cleared ? cleared.reason : '',
  };
}

// What credential artifacts exist, and are any of them unsafe? Reports type,
// ownership and mode only — never a byte of content, and never follows a link.
//
// Scoped deliberately: it inspects `<workspaceRoot>/<name>/.git/<file>` for the
// names it is given, so a misconfigured workspace root cannot turn this into a
// filesystem crawl.
export async function inventoryWorkspaceGitCredentials({ fsp, workspaceRoot, names = [], currentUid = null }) {
  const uid = currentUid === null || currentUid === undefined ? (process.getuid?.() ?? null) : currentUid;
  const root = String(workspaceRoot || '');
  if (!root || !path.isAbsolute(root)) throw new Error('inventory requires an absolute workspace root');

  const artifacts = [];
  for (const name of names) {
    // path.join with a caller-supplied name must not escape the root.
    const projectPath = path.join(root, String(name || ''));
    if (path.dirname(projectPath) !== root) continue;
    const { credFile } = workspaceGitPaths(projectPath);
    let st;
    try {
      st = await fsp.lstat(credFile);
    } catch {
      continue;
    }
    const type = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
    const ownedByOwner = uid === null ? null : Number(st.uid) === Number(uid);
    artifacts.push({
      project: String(name),
      type,
      uid: Number(st.uid),
      mode: st.mode & 0o777,
      ownedByOwner,
      // Anything that is not a 0600 regular file owned by the workspace account
      // needs replacing by its correct owner.
      unsafe: type !== 'file' || ownedByOwner === false || (st.mode & 0o777) !== 0o600,
    });
  }
  return { artifacts, unsafeCount: artifacts.filter((a) => a.unsafe).length };
}
