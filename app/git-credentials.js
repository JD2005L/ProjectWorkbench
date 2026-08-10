// The git credential-helper artifact, behind the workspace-owner boundary.
//
// ============================================================================
// WHY THIS MODULE EXISTS
//
// A project's git authentication lives in two places inside the project's OWN
// repository:
//
//   <project>/.git/.pw-credentials   the decrypted token, as a git-credential
//                                    store line
//   <project>/.git/config            `credential.helper = store --file=<that>`
//
// Both paths are inside a tree owned by the account the terminal panes run as —
// `admin` on a host deployment, PW_TERMINAL_UID in a container. Until this
// module existed the ROOT dashboard wrote them itself, which is the exact
// confused-deputy shape app/user-credentials.js was written to eliminate for the
// per-user credential tree:
//
//   ln -s /etc/cron.d/pwn <project>/.git/.pw-credentials
//
// and root's writeFile() would follow the link and create an attacker-chosen
// root-owned file — or, pointed somewhere world-readable, hand one user's
// decrypted GitHub token to every other pane on the box.
//
// The fix is structural, not defensive: the dashboard performs NO filesystem or
// git operation on a repository. It hands a job to app/credential-writer.mjs
// running as the validated workspace owner (setpriv in container mode, `sudo -n
// -u` in host mode — see credentialDropArgv in app/user-credentials.js), and the
// work happens there with exactly the authority the pane account already had.
//
// The token travels in the job on stdin, never argv: every pane shares one OS
// account, and `ps` would otherwise publish one user's token to all of them.
// ============================================================================
//
// DESCRIPTOR PINNING (why a pathname is never used twice)
//
// Dropping privileges removes the root escalation, but the workspace account is
// itself SHARED between panes, so user A can still plant or swap directories in
// user B's repository. A pathname check cannot close that: any `lstat(p)` then
// `open(p)` pair can be raced by renaming a parent in between, and `O_NOFOLLOW`
// on the FINAL component says nothing about the components above it.
//
// So the job:
//   1. walks down to `.git` one component at a time, refusing a symlink at each
//      step and confirming after each `chdir` that `stat('.')` is the inode that
//      was just approved (a swap changes the inode and is caught);
//   2. OPENS that directory `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and keeps the
//      descriptor for the whole operation;
//   3. addresses every later file operation as `/proc/self/fd/<n>/<name>`, which
//      the kernel resolves through the open description rather than by walking
//      the path — so renaming, replacing or symlinking any parent afterwards
//      cannot redirect a single byte;
//   4. runs `git config` with the process working directory re-anchored through
//      that same descriptor, so the subprocess inherits the pinned directory by
//      file description too (a child's own `/proc/self` would be useless here);
//   5. revalidates the descriptor between phases — same (dev, ino), still a
//      directory, still owned by the expected owner, and `nlink > 0` so a
//      repository deleted underneath us fails closed instead of writing into a
//      detached inode.
//
// This is why the job always runs in a one-shot child process: `chdir` is
// process-global and the dashboard must never move.
//
// Node exposes no openat(2)/mkdirat(2); `/proc/self/fd` is the portable-enough
// equivalent on the supported Linux deployment and needs no native dependency,
// matching the rest of this codebase.
//
// LIMIT, STATED PLAINLY: `credential.helper = store --file=<absolute path>` is a
// PATH — git resolves it later, on its own, and nothing here can pin that. What
// this module guarantees is that the privileged dashboard never writes through a
// substitutable path, and that the artifact it creates lands in the repository
// that was actually validated. An account that can swap directories inside its
// own workspace can still confuse its own later `git` runs; that account already
// owns those files, so no privilege boundary is crossed.
import path from 'node:path';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';

export const CREDENTIAL_BASENAME = '.pw-credentials';
export const GIT_DIR_NAME = '.git';
export const GIT_CONFIG_NAME = 'config';
export const CREDENTIAL_MODE = 0o600;

// The descriptor-addressing mechanism is an ADAPTER, not an assumption.
//
// Node exposes no openat(2)/mkdirat(2), so directory-relative operations are
// expressed as `<procfs>/self/fd/<n>/<name>`, which the kernel resolves through
// the open file description. Every supported deployment mounts a procfs, but a
// hardened container can mount it elsewhere or not at all — so the location is
// configuration, and its usability is VERIFIED against the live descriptor
// before anything is written, with a diagnostic that names the setting to fix.
// No environment-specific path is compiled in.
export const DEFAULT_PROCFS_PATH = '/proc';

export function resolveProcfsPath(env = {}) {
  return env.PW_PROCFS_PATH || DEFAULT_PROCFS_PATH;
}

const GIT_CONFIG_LOCK_NAME = `${GIT_CONFIG_NAME}.lock`;
// `git config` reports 5 for "you tried to unset an option which does not
// exist" and 1 for "the key you asked for is not there". For an idempotent
// apply and for reading back a repository that has no helper, both are the
// ordinary case rather than a failure.
const GIT_CONFIG_NOTHING_TO_UNSET = 5;
const GIT_CONFIG_KEY_ABSENT = 1;

// ---------------------------------------------------------------------------
// Target planning
// ---------------------------------------------------------------------------

// Where the artifact for `projectPath` must live, and the exact component path
// the job is allowed to walk to reach it.
//
// `registeredPaths` is mandatory: an absolute path is only acceptable when it is
// the EXACT workspace path of a registered project, so a caller cannot hand this
// module an arbitrary directory that merely happens to sit under the workspace
// root. Containment beneath the configured root is checked as well — neither
// check substitutes for the other.
export function planGitCredentialTarget({ workspaceRoot, projectPath, registeredPaths } = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) {
    throw new Error('git credential boundary: a workspace root is required');
  }
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('git credential boundary: a project path is required');
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error(`git credential boundary: workspace root must be an absolute path: ${workspaceRoot}`);
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error(`git credential boundary: project path must be an absolute path: ${projectPath}`);
  }
  if (!Array.isArray(registeredPaths)) {
    throw new Error('git credential boundary: the set of registered project paths is required — an unregistered path is never eligible');
  }

  const rootAbs = path.resolve(workspaceRoot);
  const projectAbs = path.resolve(projectPath);

  const registered = new Set(
    registeredPaths.filter((p) => typeof p === 'string' && p && path.isAbsolute(p)).map((p) => path.resolve(p)),
  );
  if (!registered.has(projectAbs)) {
    throw new Error(`git credential boundary: ${projectAbs} is not a registered project workspace path`);
  }

  if (projectAbs === rootAbs) {
    throw new Error(`git credential boundary: ${projectAbs} is the workspace root itself, not a project inside it`);
  }
  // `path.sep` is what stops `/w/rootevil` from passing as a child of `/w/root`.
  if (!projectAbs.startsWith(rootAbs + path.sep)) {
    throw new Error(`git credential boundary: ${projectAbs} is outside the configured workspace root ${rootAbs}`);
  }

  const components = path.relative(rootAbs, projectAbs).split(path.sep);
  // path.resolve() has already collapsed these, so reaching one means the input
  // was malformed in a way resolve() could not normalise. Refuse rather than guess.
  if (components.some((c) => !c || c === '.' || c === '..')) {
    throw new Error(`git credential boundary: refusing an unresolvable project path: ${projectPath}`);
  }
  components.push(GIT_DIR_NAME);

  return {
    rootAbs,
    projectAbs,
    components,
    gitDirAbs: path.join(projectAbs, GIT_DIR_NAME),
    credFileAbs: path.join(projectAbs, GIT_DIR_NAME, CREDENTIAL_BASENAME),
  };
}

// ---------------------------------------------------------------------------
// Job dependencies
// ---------------------------------------------------------------------------

// The real process/filesystem surface the job runs against, in one injectable
// bag so a test can wrap any single operation — to fail an exact step, or to
// simulate a race — without monkey-patching globals.
export function nodeJobDeps() {
  return {
    chdir: (dir) => process.chdir(dir),
    cwd: () => process.cwd(),
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    lstat: (p) => fsp.lstat(p),
    statPath: (p) => fsp.stat(p),
    statCwd: () => fsp.stat('.'),
    open: (p, flags, mode) => fsp.open(p, flags, mode),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (p) => fsp.unlink(p),
    link: (from, to) => fsp.link(from, to),
    readdir: (p) => fsp.readdir(p),
  };
}

// Run git with the job's PINNED working directory inherited — deliberately no
// `cwd` option, because a path would reintroduce exactly the substitution the
// pin exists to close. argv only; never a shell string; the token is never an
// argument (the helper only ever learns a FILE name).
export function nodeRunGit({ timeoutMs = 20000 } = {}) {
  return (args) => new Promise((resolve, reject) => {
    execFile('git', args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' },
    }, (err, stdout, stderr) => {
      // A numeric err.code is the child's exit status; a string one (ENOENT,
      // ETIMEDOUT) means git never ran, which is not a git-level result.
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? err.code : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// ---------------------------------------------------------------------------
// Descent and pinning
// ---------------------------------------------------------------------------

// Walk `rootAbs` -> ... -> `<project>/.git`, one component at a time, leaving
// the process on the final directory. Each step: lstat the component RELATIVE to
// the current directory (refusing a symlink and anything that is not a
// directory), chdir into it, then confirm `stat('.')` is the same (dev, ino)
// that was just approved. A rename landing between the lstat and the chdir
// changes the inode we end up on, and that comparison — not the lstat — catches it.
export async function descendPinned({ deps, rootAbs, components }) {
  deps.chdir(rootAbs);
  let reached = await deps.statCwd();
  if (!reached.isDirectory()) {
    throw new Error(`git credential boundary: workspace root is not a directory: ${rootAbs}`);
  }

  const walked = [];
  for (const component of components) {
    const where = () => path.join(rootAbs, ...walked, component);
    let checked;
    try {
      checked = await deps.lstat(component);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // "There is no repository here" is a DIFFERENT answer from "the
        // repository could not be used", and the caller must be able to tell
        // them apart: the first proves there is no credential artifact and no
        // git config to correct, the second is a failure.
        const absent = new Error(`git credential boundary: ${where()} does not exist (ENOENT)`);
        absent.code = 'PW_PATH_ABSENT';
        absent.absentPath = where();
        throw absent;
      }
      throw e;
    }
    if (checked.isSymbolicLink()) {
      const e = new Error(`git credential boundary: refusing a symlinked path component: ${where()}`);
      e.code = 'PW_SYMLINK_COMPONENT';
      e.componentType = 'symlink';
      throw e;
    }
    if (!checked.isDirectory()) {
      const e = new Error(`git credential boundary: path component is not a directory: ${where()}`);
      e.code = 'PW_NOT_A_DIRECTORY';
      // A regular file at `.git` is git's linked-worktree pointer. That is a real,
      // supported git layout that this module cannot service — and it must be
      // REPORTED as such, never quietly dropped from an inventory.
      e.componentType = checked.isFile() ? 'file' : 'other';
      throw e;
    }
    deps.chdir(component);
    reached = await deps.statCwd();
    if (reached.dev !== checked.dev || reached.ino !== checked.ino) {
      throw new Error(`git credential boundary: path substitution detected at ${where()} — the directory changed between the check and the use`);
    }
    walked.push(component);
  }
  return reached;
}

// Descend, then take and validate the descriptor everything else is addressed
// through. `expectedUid` is the workspace owner resolved INDEPENDENTLY of
// whoever is running this process — an assertion against `process.getuid()`
// passes identically for the correct and the defective outcome and is therefore
// not evidence.
export async function openPinnedGitDir({ deps, rootAbs, components, expectedUid, procfs = resolveProcfsPath(process.env) }) {
  const reached = await descendPinned({ deps, rootAbs, components });
  const handle = await deps.open('.', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) {
      throw new Error('git credential boundary: the pinned repository descriptor is not a directory');
    }
    if (st.dev !== reached.dev || st.ino !== reached.ino) {
      throw new Error('git credential boundary: path substitution detected while pinning the repository descriptor');
    }
    const pin = {
      fd: handle.fd,
      handle,
      dev: st.dev,
      ino: st.ino,
      uid: st.uid,
      gid: st.gid,
      gitDirAbs: path.join(rootAbs, ...components),
      dirPath: `${procfs}/self/fd/${handle.fd}`,
      close: () => handle.close(),
    };
    await assertDescriptorAddressingWorks({ deps, pin, st, procfs });
    assertPinOwnership(pin, st, expectedUid);
    return pin;
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
}

// Prove the adapter actually works on THIS host before relying on it: the
// descriptor path must resolve to the very inode the descriptor refers to. A
// missing, restricted or differently-mounted procfs fails here, loudly and
// early, instead of silently degrading to pathname resolution.
async function assertDescriptorAddressingWorks({ deps, pin, st, procfs }) {
  let resolved;
  try {
    resolved = await deps.statPath(pin.dirPath);
  } catch (e) {
    throw new Error(
      `git credential boundary: descriptor-addressed paths are unavailable here (${pin.dirPath}: ${e.code || e.message}). ` +
      `This deployment needs a readable procfs; set PW_PROCFS_PATH if it is mounted somewhere other than ${DEFAULT_PROCFS_PATH}.`,
    );
  }
  if (resolved.dev !== st.dev || resolved.ino !== st.ino) {
    throw new Error(
      `git credential boundary: ${procfs} does not address open descriptors correctly on this host — ` +
      `${pin.dirPath} resolves to a different directory than the descriptor it names. Set PW_PROCFS_PATH to a real procfs mount.`,
    );
  }
}

function assertPinOwnership(pin, st, expectedUid) {
  if (expectedUid === null || expectedUid === undefined) return;
  if (st.uid !== Number(expectedUid)) {
    const e = new Error(
      `git credential boundary: refusing ${pin.gitDirAbs}: its owner (uid ${st.uid}) is not the resolved workspace owner (uid ${expectedUid}) — repository ownership does not match the account this operation runs as`,
    );
    e.code = 'PW_FOREIGN_REPOSITORY';
    e.actualUid = st.uid;
    throw e;
  }
}

// Confirm the pinned descriptor still refers to the same live, correctly owned
// directory. Called between phases so a long operation cannot be finished
// against a repository that was deleted or handed to someone else halfway.
export async function revalidatePin({ deps, pin, expectedUid }) {
  const st = await pin.handle.stat();
  if (!st.isDirectory()) {
    throw new Error(`git credential boundary: the pinned repository ${pin.gitDirAbs} is no longer a directory`);
  }
  if (st.dev !== pin.dev || st.ino !== pin.ino) {
    throw new Error(`git credential boundary: path substitution detected — the pinned repository ${pin.gitDirAbs} changed identity`);
  }
  if (st.nlink === 0) {
    throw new Error(`git credential boundary: the pinned repository ${pin.gitDirAbs} was removed while the operation was in progress`);
  }
  assertPinOwnership(pin, st, expectedUid);
  return st;
}

// Address a name THROUGH the descriptor. Only a single path component is ever
// allowed: a name containing a separator would be resolved by walking, which is
// the thing the pin exists to avoid.
export function pinnedPath(pin, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/')) {
    throw new Error(`git credential boundary: a pinned name must be a single path component, got ${JSON.stringify(name)}`);
  }
  return `${pin.dirPath}/${name}`;
}

// Re-anchor the process working directory through the pinned descriptor, so a
// spawned `git` inherits the pinned directory by file description rather than by
// path. Verified after the move, because this is the one place a path string is
// unavoidable.
async function anchorProcessToPin({ deps, pin }) {
  deps.chdir(pin.dirPath);
  const here = await deps.statCwd();
  if (here.dev !== pin.dev || here.ino !== pin.ino) {
    throw new Error(`git credential boundary: failed to anchor the working directory to the pinned repository ${pin.gitDirAbs}`);
  }
}

async function syncPin(pin) {
  await pin.handle.sync().catch(() => {});
}

// ---------------------------------------------------------------------------
// The credential value
// ---------------------------------------------------------------------------

// Anything that would let a credential value stop being ONE credential for ONE
// host: a newline starts a second store entry, whitespace and control characters
// corrupt the line, and `@ : / \ # ?` carry meaning in the URL the value is
// interpolated into. `[^\x21-\x7E]` is everything that is not a printable,
// non-space ASCII byte. A real GitHub token contains none of them.
const UNSAFE_CREDENTIAL_VALUE = /[^\x21-\x7E]|[@:/\\#?]/;

// The single git-credential-store line the helper reads back. The diagnostic
// describes the shape of the problem and never echoes the value — an error
// message travels into logs and HTTP responses.
export function gitCredentialLine(token) {
  const value = String(token ?? '');
  if (!value) throw new Error('git credential boundary: refusing to write an empty credential value');
  if (UNSAFE_CREDENTIAL_VALUE.test(value)) {
    throw new Error('git credential boundary: refusing a credential value that contains a line break, whitespace, or a URL-significant character');
  }
  return `https://${value}:x-oauth-basic@github.com\n`;
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

function classifyStat(st) {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'regular';
  return 'other';
}

// What is at a pinned name right now — TYPE AND OWNERSHIP ONLY. This is the
// input to every fail-closed decision and to the operator inventory, so it never
// opens or reads the file: the thing sitting there may be a symlink someone else
// planted, and the report may be printed.
export async function inspectArtifact({ deps, pin, name = CREDENTIAL_BASENAME }) {
  let st;
  try {
    st = await deps.lstat(pinnedPath(pin, name));
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false, type: 'absent', mode: null, uid: null, gid: null };
    throw e;
  }
  return { present: true, type: classifyStat(st), mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
}

// Write the new credential to a fresh name. Nothing observable changes yet: the
// staged file is not the name git reads, so a failure at any later step can be
// undone by deleting it.
export async function writeStagedCredential({ deps, pin, token }) {
  // Validate BEFORE anything exists on disk, so a rejected value cannot even
  // briefly create a file.
  const line = gitCredentialLine(token);
  const stagedName = `${CREDENTIAL_BASENAME}.staged-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fh = await deps.open(
    pinnedPath(pin, stagedName),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    CREDENTIAL_MODE,
  );
  try {
    await fh.writeFile(line, 'utf8');
    // Through the descriptor, so umask cannot loosen it and no later swap can
    // redirect the change.
    await fh.chmod(CREDENTIAL_MODE);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await deps.unlink(pinnedPath(pin, stagedName)).catch(() => {});
    throw e;
  }
  await fh.close();
  return { stagedName };
}

// Publish the staged credential with ONE rename(2). rename replaces the
// destination ENTRY — it never follows a symlink sitting there — so this is
// atomic for readers and cannot be redirected.
export async function promoteStaged({ deps, pin, stagedName }) {
  await deps.rename(pinnedPath(pin, stagedName), pinnedPath(pin, CREDENTIAL_BASENAME));
  await syncPin(pin);
}

export async function discardStaged({ deps, pin, stagedName }) {
  await deps.unlink(pinnedPath(pin, stagedName)).catch(() => {});
}

// Take a CONTENT-BLIND snapshot of the existing artifact by hard-linking it to a
// second name. link(2) does not follow symlinks and copies no bytes, so the
// prior credential can be restored exactly without this process ever reading it.
export async function snapshotArtifact({ deps, pin, expectedUid }) {
  const seen = await inspectArtifact({ deps, pin });
  if (!seen.present || seen.type !== 'regular') return null;
  // Only a credential WE own can be snapshotted, and only that one should be.
  // `link(2)` against a root-owned 0600 file fails EPERM under
  // fs.protected_hardlinks, and a credential written by the old root path is
  // precisely the thing that must not be preserved or reused.
  if (expectedUid !== null && expectedUid !== undefined && seen.uid !== Number(expectedUid)) return null;
  const snapshotName = `${CREDENTIAL_BASENAME}.rollback-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await deps.link(pinnedPath(pin, CREDENTIAL_BASENAME), pinnedPath(pin, snapshotName));
  return { snapshotName, mode: seen.mode, uid: seen.uid };
}

export async function restoreSnapshot({ deps, pin, snapshot }) {
  if (!snapshot) return;
  await deps.rename(pinnedPath(pin, snapshot.snapshotName), pinnedPath(pin, CREDENTIAL_BASENAME));
  // POSIX rename() is defined to succeed and DO NOTHING when both names resolve
  // to the same existing file — exactly the case when the operation failed
  // before publishing anything, so the snapshot is still just a second name for
  // the live artifact. Without this the rollback link would survive as litter
  // holding a copy of the credential.
  await deps.unlink(pinnedPath(pin, snapshot.snapshotName)).catch(() => {});
  await syncPin(pin);
}

export async function discardSnapshot({ deps, pin, snapshot }) {
  if (!snapshot) return;
  await deps.unlink(pinnedPath(pin, snapshot.snapshotName)).catch(() => {});
}

// Remove the artifact and say WHY the answer is what it is.
//
// unlink(2) removes the directory entry and never follows a symlink, so a
// planted link is deleted rather than its target. A directory (or any other
// non-regular type that cannot be unlinked) is REFUSED — never removed
// recursively — because an attacker-created tree at that name is evidence, not
// garbage.
export async function removeArtifact({ deps, pin }) {
  const seen = await inspectArtifact({ deps, pin });
  if (!seen.present) return { removed: false, provenAbsent: true, type: 'absent' };
  if (seen.type === 'directory' || seen.type === 'other') {
    throw new Error(
      `git credential boundary: refusing to remove ${pin.gitDirAbs}/${CREDENTIAL_BASENAME}: it is a ${seen.type}, not a credential file — remove it deliberately after inspecting it`,
    );
  }
  try {
    await deps.unlink(pinnedPath(pin, CREDENTIAL_BASENAME));
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: false, provenAbsent: true, type: 'absent' };
    throw e;
  }
  await syncPin(pin);
  return { removed: true, provenAbsent: true, type: seen.type };
}

// Prove the artifact is absent, by descriptor, rather than assuming the unlink
// meant what we hoped. Any error other than a definitive ENOENT is a failure.
export async function confirmArtifactAbsent({ deps, pin }) {
  try {
    await deps.lstat(pinnedPath(pin, CREDENTIAL_BASENAME));
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw new Error(`git credential boundary: could not confirm the credential is gone from ${pin.gitDirAbs}: ${e.code || e.message}`);
  }
  throw new Error(`git credential boundary: the credential file still exists in ${pin.gitDirAbs} after removal`);
}

// Final descriptor verification: open the published artifact WITHOUT following a
// link and check the properties from the descriptor itself — regular file, the
// resolved workspace owner, exactly 0600, still linked. This is the check that
// makes "we wrote it correctly" an observation rather than an assumption.
export async function verifyArtifact({ deps, pin, expectedUid }) {
  let fh;
  try {
    fh = await deps.open(pinnedPath(pin, CREDENTIAL_BASENAME), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') {
      throw new Error(`git credential boundary: the published credential in ${pin.gitDirAbs} is a symlink, not a regular file`);
    }
    throw new Error(`git credential boundary: could not verify the published credential in ${pin.gitDirAbs}: ${e.code || e.message}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`git credential boundary: the published credential in ${pin.gitDirAbs} is not a regular file`);
    }
    if (st.nlink === 0) {
      throw new Error(`git credential boundary: the published credential in ${pin.gitDirAbs} was removed before it could be verified`);
    }
    if ((st.mode & 0o777) !== CREDENTIAL_MODE) {
      throw new Error(`git credential boundary: the published credential in ${pin.gitDirAbs} has mode ${(st.mode & 0o777).toString(8)}, expected 600`);
    }
    if (expectedUid !== null && expectedUid !== undefined && st.uid !== Number(expectedUid)) {
      throw new Error(`git credential boundary: the published credential in ${pin.gitDirAbs} is owned by uid ${st.uid}, expected the resolved workspace owner uid ${expectedUid}`);
    }
    return { mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
  } finally {
    await fh.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// .git/config
// ---------------------------------------------------------------------------

export async function readLocalHelpers({ deps, pin, runGit }) {
  await anchorProcessToPin({ deps, pin });
  const result = await runGit(['config', '--file', GIT_CONFIG_NAME, '--get-all', 'credential.helper']);
  if (result.code === GIT_CONFIG_KEY_ABSENT) return [];
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').pop();
    throw new Error(`git credential boundary: could not read credential.helper from ${pin.gitDirAbs}/config (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  const lines = result.stdout.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Capture the config exactly as found, so any later failure can put it back
// byte-for-byte. `present: false` is itself part of the state to restore.
export async function captureGitConfig({ deps, pin }) {
  const seen = await inspectArtifact({ deps, pin, name: GIT_CONFIG_NAME });
  if (seen.present && seen.type !== 'regular') {
    throw new Error(`git credential boundary: refusing to update ${pin.gitDirAbs}/${GIT_CONFIG_NAME}: it is a ${seen.type}, not a regular file`);
  }
  if (!seen.present) return { present: false, bytes: null, mode: 0o644 };
  const fh = await deps.open(pinnedPath(pin, GIT_CONFIG_NAME), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return { present: true, bytes: await fh.readFile('utf8'), mode: seen.mode };
  } finally {
    await fh.close().catch(() => {});
  }
}

// Put the captured config back. Atomic in both directions: a config that did not
// exist is removed again rather than left behind as a half-written artifact.
export async function restoreGitConfig({ deps, pin, captured }) {
  if (!captured) return;
  if (!captured.present) {
    await deps.unlink(pinnedPath(pin, GIT_CONFIG_NAME)).catch(() => {});
    await syncPin(pin);
    return;
  }
  const tmpName = `${GIT_CONFIG_NAME}.restore-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fh = await deps.open(
    pinnedPath(pin, tmpName),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    captured.mode,
  );
  try {
    await fh.writeFile(captured.bytes, 'utf8');
    await fh.chmod(captured.mode);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await deps.unlink(pinnedPath(pin, tmpName)).catch(() => {});
    throw e;
  }
  await fh.close();
  await deps.rename(pinnedPath(pin, tmpName), pinnedPath(pin, GIT_CONFIG_NAME));
  await syncPin(pin);
}

// Take git's OWN lock and stage the current config into it.
//
// `config.lock` is not a lock we invented: it is the exact file `git config`
// creates with O_EXCL before it rewrites the config, so holding it makes this
// update mutually exclusive with a concurrent `git config` run from a pane, and
// publishing it with rename() is atomic for readers. Refusing when it already
// exists — without touching it — is what keeps us from stealing another writer's
// lock.
async function stageGitConfig({ deps, pin, captured }) {
  let lockFh;
  try {
    lockFh = await deps.open(
      pinnedPath(pin, GIT_CONFIG_LOCK_NAME),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      captured.mode,
    );
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new Error(`git credential boundary: another git process is updating ${pin.gitDirAbs}/${GIT_CONFIG_NAME} (${GIT_CONFIG_LOCK_NAME} exists) — retry once it finishes`);
    }
    throw e;
  }
  try {
    await lockFh.writeFile(captured.present ? captured.bytes : '', 'utf8');
    await lockFh.chmod(captured.mode);
  } catch (e) {
    await lockFh.close().catch(() => {});
    await deps.unlink(pinnedPath(pin, GIT_CONFIG_LOCK_NAME)).catch(() => {});
    throw e;
  }
  await lockFh.close();
}

// Publish the staged config. `git config --file` does its own atomic replace of
// the staged file, so the inode behind that name has changed by now — re-assert
// the mode on whatever is there before renaming it into place.
async function commitGitConfig({ deps, pin, mode }) {
  const fh = await deps.open(pinnedPath(pin, GIT_CONFIG_LOCK_NAME), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await fh.chmod(mode);
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  await deps.rename(pinnedPath(pin, GIT_CONFIG_LOCK_NAME), pinnedPath(pin, GIT_CONFIG_NAME));
  await syncPin(pin);
}

// Drop the staged config, leaving the repository exactly as it was found.
async function abortGitConfig({ deps, pin }) {
  await deps.unlink(pinnedPath(pin, `${GIT_CONFIG_LOCK_NAME}.lock`)).catch(() => {});
  await deps.unlink(pinnedPath(pin, GIT_CONFIG_LOCK_NAME)).catch(() => {});
}

async function gitConfigStep(runGit, args, { tolerate = [] } = {}) {
  const result = await runGit(['config', '--file', GIT_CONFIG_LOCK_NAME, ...args]);
  if (result.code === 0 || tolerate.includes(result.code)) return result;
  const detail = result.stderr.trim().split('\n').pop();
  throw new Error(`git credential boundary: git config ${args.join(' ')} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
}

// Set the repository's local credential.helper list to exactly `values`, or
// clear it entirely when `values` is empty. Either the whole new config is
// published or none of it is, and a failure leaves the repository byte-identical
// to how it was found.
async function setLocalCredentialHelpers({ deps, pin, runGit, values, expectedUid }) {
  await revalidatePin({ deps, pin, expectedUid });
  await anchorProcessToPin({ deps, pin });
  const captured = await captureGitConfig({ deps, pin });
  await stageGitConfig({ deps, pin, captured });
  try {
    await gitConfigStep(runGit, ['--unset-all', 'credential.helper'], { tolerate: [GIT_CONFIG_NOTHING_TO_UNSET] });
    for (const value of values) {
      await gitConfigStep(runGit, ['--add', 'credential.helper', value]);
    }
    await commitGitConfig({ deps, pin, mode: captured.mode });
  } catch (e) {
    await abortGitConfig({ deps, pin });
    throw e;
  }
  return captured;
}

// Point the repository at OUR store and nothing else.
//
// The empty first value is a reset: it discards every helper inherited from
// global/system config for this repository, so the token is never dispatched to
// — and duplicated into — a helper someone else configured. Two `--add`s rather
// than `--replace-all`, which would drop the reset.
export async function applyLocalCredentialHelper({ deps, pin, runGit, credFileAbs, expectedUid }) {
  if (!credFileAbs || !path.isAbsolute(credFileAbs)) {
    throw new Error('git credential boundary: the credential helper file must be an absolute path');
  }
  return setLocalCredentialHelpers({ deps, pin, runGit, values: ['', `store --file=${credFileAbs}`], expectedUid });
}

export async function clearLocalCredentialHelper({ deps, pin, runGit, expectedUid }) {
  return setLocalCredentialHelpers({ deps, pin, runGit, values: [], expectedUid });
}

export function expectedHelperValues(credFileAbs) {
  return ['', `store --file=${credFileAbs}`];
}

// ---------------------------------------------------------------------------
// The whole operation
// ---------------------------------------------------------------------------

// Undo everything an apply managed to do, so a failure leaves the repository
// exactly as it was found.
//
// The credential is restored from the CONTENT-BLIND hard-link snapshot taken
// before anything moved: link(2) copies no bytes, so the prior secret comes back
// byte-for-byte without this process ever having read it. If the restore itself
// fails the snapshot link is deliberately LEFT in place — it is the only
// remaining copy, and an operator can recover from it.
async function rollbackApply({ deps, pin, runGit, snapshot, captured, published, hadArtifact, expectedUid }) {
  if (published) {
    if (snapshot) {
      try { await restoreSnapshot({ deps, pin, snapshot }); } catch { /* keep the link as the last copy */ }
      try { await restoreGitConfig({ deps, pin, captured }); } catch { /* the original error is what matters */ }
      return;
    }
    // Either there was nothing here before, or what was here was a credential we
    // did not own and could not snapshot (the historical root-written artifact).
    // Removing what we published restores the prior state in the first case and
    // reaches an explicit SAFE state in the second: no usable credential, and no
    // helper pointing at one. It cannot expose the old value — we never read it —
    // and the next authoritative sync completes deterministically from the
    // current credential state.
    await deps.unlink(pinnedPath(pin, CREDENTIAL_BASENAME)).catch(() => {});
    if (hadArtifact) {
      try { await clearLocalCredentialHelper({ deps, pin, runGit, expectedUid }); } catch { /* best effort */ }
      return;
    }
  } else if (snapshot) {
    await discardSnapshot({ deps, pin, snapshot });
  }
  try { await restoreGitConfig({ deps, pin, captured }); } catch { /* the original error is what matters */ }
}

// Create or rotate. Nothing is observable until a single rename publishes the
// staged credential, and nothing is reported as done until the artifact has been
// verified through its descriptor and the helper pair read back from git.
async function applyCredential({ deps, runGit, pin, plan, token, expectedUid }) {
  const before = await inspectArtifact({ deps, pin });
  if (before.present && before.type !== 'regular') {
    throw new Error(
      `git credential boundary: refusing to replace ${plan.credFileAbs}: it is a ${before.type}, not a regular file — inspect and remove it deliberately`,
    );
  }

  const snapshot = await snapshotArtifact({ deps, pin, expectedUid });
  const captured = await captureGitConfig({ deps, pin });
  let staged = null;
  let published = false;
  try {
    staged = await writeStagedCredential({ deps, pin, token });
    await promoteStaged({ deps, pin, stagedName: staged.stagedName });
    published = true;

    await applyLocalCredentialHelper({ deps, pin, runGit, credFileAbs: plan.credFileAbs, expectedUid });

    const artifact = await verifyArtifact({ deps, pin, expectedUid });
    const helpers = await readLocalHelpers({ deps, pin, runGit });
    const wanted = expectedHelperValues(plan.credFileAbs);
    if (helpers.length !== wanted.length || helpers.some((v, i) => v !== wanted[i])) {
      throw new Error(`git credential boundary: ${plan.gitDirAbs}/${GIT_CONFIG_NAME} does not carry exactly the expected credential.helper pair after the update`);
    }

    await discardSnapshot({ deps, pin, snapshot });
    return {
      action: 'set',
      applied: true,
      gitDir: plan.gitDirAbs,
      artifactBefore: before,
      artifact,
      helperCount: helpers.length,
    };
  } catch (e) {
    await rollbackApply({ deps, pin, runGit, snapshot, captured, published, hadArtifact: before.present, expectedUid });
    if (staged) await discardStaged({ deps, pin, stagedName: staged.stagedName });
    throw e;
  }
}

// Revoke. The helper is unset FIRST so git is never pointed at a file that has
// already been removed, and success is reported only once absence has been
// PROVEN by descriptor and the helper list read back empty. Anything else — a
// permission error, an I/O error, a timeout, an unsupported artifact — is a
// failure that restores the prior usable pair.
async function revokeCredential({ deps, runGit, pin, plan, expectedUid }) {
  const before = await inspectArtifact({ deps, pin });
  if (before.present && (before.type === 'directory' || before.type === 'other')) {
    throw new Error(
      `git credential boundary: refusing to revoke ${plan.credFileAbs}: it is a ${before.type}, not a credential file — inspect and remove it deliberately`,
    );
  }

  const snapshot = await snapshotArtifact({ deps, pin, expectedUid });
  const captured = await captureGitConfig({ deps, pin });
  let cleared = false;
  try {
    await clearLocalCredentialHelper({ deps, pin, runGit, expectedUid });
    cleared = true;

    const removal = await removeArtifact({ deps, pin });
    const confirmedAbsent = await confirmArtifactAbsent({ deps, pin });
    const helpers = await readLocalHelpers({ deps, pin, runGit });
    if (helpers.length) {
      throw new Error(`git credential boundary: ${plan.gitDirAbs}/${GIT_CONFIG_NAME} still carries a credential.helper after revocation`);
    }

    await discardSnapshot({ deps, pin, snapshot });
    return {
      action: 'clear',
      applied: true,
      revoked: true,
      confirmedAbsent,
      removed: removal.removed,
      gitDir: plan.gitDirAbs,
      artifactBefore: before,
    };
  } catch (e) {
    if (snapshot) {
      try { await restoreSnapshot({ deps, pin, snapshot }); } catch { /* keep the link as the last copy */ }
    }
    if (cleared) {
      try { await restoreGitConfig({ deps, pin, captured }); } catch { /* the original error is what matters */ }
    }
    throw e;
  }
}

// The single entry point the privilege-dropped helper calls.
//
// An empty token means REVOKE — that is the only difference between the two
// transitions, and both are all-or-nothing.
export async function runGitCredentialJob({
  deps,
  runGit,
  workspaceRoot,
  projectPath,
  registeredPaths,
  token = '',
  expectedUid,
}) {
  if (expectedUid === null || expectedUid === undefined) {
    throw new Error('git credential boundary: the independently resolved workspace-owner uid is required');
  }
  const plan = planGitCredentialTarget({ workspaceRoot, projectPath, registeredPaths });

  // Prove the privilege drop actually landed. Comparing the process against an
  // owner resolved elsewhere (passwd) is what makes this assertion able to fail;
  // comparing it against itself never could.
  const runningUid = deps.uid();
  if (runningUid !== null && runningUid !== Number(expectedUid)) {
    throw new Error(
      `git credential boundary: refusing to act on ${plan.projectAbs}: running as uid ${runningUid}, not the resolved workspace owner (uid ${expectedUid}) — the privilege drop did not land`,
    );
  }

  // The descent and the git subprocess both move the process working directory;
  // put it back so an in-process caller (a test) is unaffected.
  let restoreCwd = null;
  try { restoreCwd = deps.cwd(); } catch { /* cwd already gone */ }

  const wants = String(token || '');
  let pin = null;
  try {
    try {
      pin = await openPinnedGitDir({ deps, rootAbs: plan.rootAbs, components: plan.components, expectedUid });
    } catch (e) {
      if (e.code !== 'PW_PATH_ABSENT') throw e;
      // No repository (or no workspace directory) at the registered path. There
      // is provably nothing to write into and provably no artifact to revoke, so
      // this is reported as a skip rather than silently ignored — and for a
      // revocation it is a PROVEN absence, which is the only kind of idempotent
      // success this module allows.
      return {
        action: wants ? 'set' : 'clear',
        applied: false,
        skipped: 'no-repository',
        absentPath: e.absentPath,
        gitDir: plan.gitDirAbs,
        ...(wants ? {} : { revoked: true, confirmedAbsent: true, removed: false }),
      };
    }
    return wants
      ? await applyCredential({ deps, runGit, pin, plan, token, expectedUid })
      : await revokeCredential({ deps, runGit, pin, plan, expectedUid });
  } finally {
    if (pin) await pin.close().catch(() => {});
    if (restoreCwd) { try { deps.chdir(restoreCwd); } catch { /* the caller's cwd is gone */ } }
  }
}

// ---------------------------------------------------------------------------
// Existing-artifact inventory and remediation (bounded, explicit, registry-scoped)
// ---------------------------------------------------------------------------

// Artifacts written before this boundary existed are root-owned, and a repository
// may also have been left in a state this module refuses to service. An operator
// needs to be able to SEE that, and to fix the safe subset deliberately, without
// the fix itself becoming a new way to damage a workspace.
//
// The rules that make this bounded:
//   * scope is the REGISTRY — the projects the dashboard already manages. There
//     is no filesystem walk, so an unregistered repository is never touched, or
//     even looked at.
//   * every project is validated exactly as a normal credential write is:
//     registered path, containment under the configured workspace root, pinned
//     no-follow descent, repository ownership.
//   * a state that cannot be serviced is REPORTED, never swallowed and never
//     "cleaned up". A directory or any other non-regular artifact is refused,
//     never removed — an attacker-created tree is evidence.
//   * the report carries file METADATA only. It is printed by operators.
//   * one project's problem never aborts the run or leaks into another's row.

const INVENTORY_REFUSALS = new Map([
  ['PW_PATH_ABSENT', { status: 'no-repository', detail: 'no workspace directory or no .git at the registered path' }],
  ['PW_NOT_A_DIRECTORY', { status: 'linked-worktree', detail: '.git is not a directory (a .git file / linked worktree is a real git layout this boundary cannot service)' }],
  ['PW_SYMLINK_COMPONENT', { status: 'unsupported-repository', detail: 'a path component on the way to .git is a symlink' }],
  ['PW_FOREIGN_REPOSITORY', { status: 'foreign-git', detail: '.git is not owned by the resolved workspace owner' }],
  ['PW_SUBSTITUTION', { status: 'unsupported-repository', detail: 'the repository changed identity while it was being inspected' }],
]);

function refusalRow(project, projectPath, e) {
  const known = INVENTORY_REFUSALS.get(e?.code);
  if (known) {
    return { project, path: projectPath, status: known.status, detail: known.detail, eligible: false };
  }
  // An unrecognised failure is still reported — as a failure, not as "fine".
  return { project, path: projectPath, status: 'error', detail: e?.message || String(e), eligible: false };
}

async function inspectOneProject({ deps, runGit, workspaceRoot, registeredPaths, project, expectedUid }) {
  const name = project?.name || project?.path || '(unnamed)';
  const projectPath = project?.path || '';
  let plan;
  try {
    plan = planGitCredentialTarget({ workspaceRoot, projectPath, registeredPaths });
  } catch (e) {
    return { project: name, path: projectPath, status: 'unsupported-workspace', detail: e.message, eligible: false };
  }

  let pin;
  try {
    pin = await openPinnedGitDir({ deps, rootAbs: plan.rootAbs, components: plan.components, expectedUid });
  } catch (e) {
    return refusalRow(name, projectPath, e);
  }

  try {
    const artifact = await inspectArtifact({ deps, pin });
    const base = { project: name, path: projectPath, gitDir: plan.gitDirAbs, artifact };

    if (artifact.present && artifact.type !== 'regular') {
      return { ...base, status: 'unsupported-artifact', detail: `the credential path holds a ${artifact.type}`, eligible: false };
    }

    const helpers = await readLocalHelpers({ deps, pin, runGit });
    const wanted = expectedHelperValues(plan.credFileAbs);
    const helperOk = helpers.length === wanted.length && helpers.every((v, i) => v === wanted[i]);

    if (!artifact.present) {
      // Nothing to migrate. A helper pointing at a file that is not there is
      // reported, but it is the normal sync path's job to create one.
      return { ...base, status: 'absent', detail: helperOk ? 'no credential; a helper is configured for one' : 'no credential', eligible: false, helperConfigured: helperOk };
    }

    const wrongMode = artifact.mode !== CREDENTIAL_MODE;
    const wrongOwner = artifact.uid !== Number(expectedUid);
    if (wrongMode || wrongOwner || !helperOk) {
      const reasons = [];
      if (wrongOwner) reasons.push(`owned by uid ${artifact.uid}, expected the workspace owner uid ${expectedUid}`);
      if (wrongMode) reasons.push(`mode ${artifact.mode.toString(8)}, expected 600`);
      if (!helperOk) reasons.push('the local credential.helper pair does not match');
      // An artifact owned by somebody else cannot be converted in place without
      // reading a secret we must not read. It needs the authoritative current
      // credential re-applied over it instead.
      return { ...base, status: 'needs-repair', detail: reasons.join('; '), eligible: true, resyncRequired: wrongOwner };
    }
    return { ...base, status: 'ok', detail: 'owner-owned 0600 credential with a matching helper pair', eligible: false };
  } catch (e) {
    return refusalRow(name, projectPath, e);
  } finally {
    await pin.close().catch(() => {});
  }
}

// Restore the caller's working directory: reading a repository's helper list
// anchors the process to that repository (see anchorProcessToPin).
async function inEachProject({ deps, runGit, workspaceRoot, projects, expectedUid }, visit) {
  const list = Array.isArray(projects) ? projects : [];
  const registeredPaths = list.map((p) => p?.path).filter(Boolean);
  let restoreCwd = null;
  try { restoreCwd = deps.cwd(); } catch { /* cwd already gone */ }
  const rows = [];
  try {
    for (const project of list) {
      const row = await inspectOneProject({ deps, runGit, workspaceRoot, registeredPaths, project, expectedUid });
      rows.push(await visit(row, { registeredPaths, project }));
    }
  } finally {
    if (restoreCwd) { try { deps.chdir(restoreCwd); } catch { /* the caller's cwd is gone */ } }
  }
  return { workspaceRoot: path.resolve(workspaceRoot), inspected: rows.length, projects: rows };
}

export async function inventoryGitCredentials({ deps, runGit, workspaceRoot, projects, expectedUid }) {
  return inEachProject({ deps, runGit, workspaceRoot, projects, expectedUid }, (row) => row);
}

// Tighten an artifact WE ALREADY OWN. Content-blind in the strict sense: the
// mode is changed through a descriptor and not one byte is ever read.
//
// There is deliberately no path here for an artifact owned by somebody else. The
// historical root-written credential is 0600 and root-owned, so the workspace
// owner can neither read it (EACCES) nor even hard-link it (EPERM, under
// fs.protected_hardlinks) — and converting it by copying would mean reading a
// secret this process has no business seeing. Such an artifact is reported as
// requiring an AUTHORITATIVE RESYNC, which the operator command performs by
// rewriting the pair from the current credential state and discarding the old
// value unread. See scripts/pw-git-credential-audit.mjs.
async function repairOwnedArtifactMode({ deps, pin }) {
  const fh = await deps.open(pinnedPath(pin, CREDENTIAL_BASENAME), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await fh.chmod(CREDENTIAL_MODE);
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  return 'chmod';
}

export async function remediateGitCredentials({ deps, runGit, workspaceRoot, projects, expectedUid, apply = false }) {
  const report = await inEachProject({ deps, runGit, workspaceRoot, projects, expectedUid }, async (row, { registeredPaths, project }) => {
    if (row.status === 'ok' || row.status === 'absent') return { ...row, action: 'none' };
    if (!row.eligible) return { ...row, action: 'refused' };
    if (!apply) return { ...row, action: 'would-repair' };

    const plan = planGitCredentialTarget({ workspaceRoot, projectPath: project.path, registeredPaths });
    const pin = await openPinnedGitDir({ deps, rootAbs: plan.rootAbs, components: plan.components, expectedUid });
    try {
      const artifact = await inspectArtifact({ deps, pin });
      if (!artifact.present || artifact.type !== 'regular') {
        // It changed under us between the inventory and the repair. Refuse.
        return { ...row, action: 'refused', detail: `the credential path is now a ${artifact.type}` };
      }
      if (artifact.uid !== Number(expectedUid)) {
        // Reported, never guessed at: the caller holds the authoritative
        // credential state and must rewrite the pair from it.
        return {
          ...row,
          action: 'resync-required',
          resyncRequired: true,
          detail: `owned by uid ${artifact.uid}; it cannot be converted without reading it, so the current credential must be re-applied over it`,
        };
      }
      const how = await repairOwnedArtifactMode({ deps, pin });
      await applyLocalCredentialHelper({ deps, pin, runGit, credFileAbs: plan.credFileAbs, expectedUid });
      const verified = await verifyArtifact({ deps, pin, expectedUid });
      return { ...row, action: 'repaired', how, artifact: verified };
    } catch (e) {
      return { ...row, action: 'failed', detail: e.message };
    } finally {
      await pin.close().catch(() => {});
    }
  });
  return { ...report, applied: !!apply };
}
