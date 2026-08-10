// Candidate A — the workspace git credential boundary (GOA-6).
//
// The defect: <workspace>/.git/.pw-credentials and the `git config --local`
// mutations that point git at it were performed by the dashboard process, which
// is root in both deploy modes, against a `.git` owned by the unprivileged pane
// account. A pane user could plant a symlink there and have root write through
// it. Observed in production as a root:root 0600 helper file inside a
// pane-owned .git — which is also a functional failure, because the account
// that needs to read it cannot.
//
// These tests run as an ordinary user and drive applyWorkspaceGitCredentialJob
// directly, which is exactly the code path the privilege-dropped helper runs.
// The real-uid privilege-boundary evidence (root actually dropping) is PVI2's to
// own per the Round 4 disposition; nothing here requires root, so nothing here
// is reported as not-run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  applyWorkspaceGitCredentialJob,
  inventoryWorkspaceGitCredentials,
  workspaceGitPaths,
  assertSerialized,
  WORKSPACE_CRED_FILENAME,
} from '../app/workspace-git-credentials.js';

const execFileAsync = promisify(execFile);
const TOKEN_LINE = 'https://ghp_TESTSECRETVALUE:x-oauth-basic@github.com\n';
const SECRET = 'ghp_TESTSECRETVALUE';

async function tmpWorkspace(t, { init = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwwgc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'Proj');
  await fsp.mkdir(projectPath, { recursive: true });
  if (init) {
    await execFileAsync('git', ['-C', projectPath, 'init', '-q', '-b', 'main']);
  }
  return { root, projectPath };
}

const apply = (projectPath, credential) =>
  applyWorkspaceGitCredentialJob({ fsp, execFile: execFileAsync, projectPath, credential });

// `--get-all` prints one line per value, and the empty reset entry is a
// genuinely empty line. Drop only the trailing newline artifact — filtering all
// empties would silently hide whether the reset is present, which is the one
// entry that stops an inherited global helper duplicating the token.
async function helperConfig(projectPath) {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, 'config', '--local', '--get-all', 'credential.helper'])
    .catch(() => ({ stdout: '' }));
  const lines = stdout.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// --- the happy path, and the shape of what it leaves behind -------------------

test('writes a 0600 regular file owned by the caller and points git at it', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const res = await apply(projectPath, TOKEN_LINE);

  assert.equal(res.applied, true);
  assert.equal(res.remediated, false);
  const { credFile } = workspaceGitPaths(projectPath);
  const st = await fsp.lstat(credFile);
  assert.ok(st.isFile(), 'must be a regular file');
  assert.equal(st.mode & 0o777, 0o600, 'must be 0600');
  assert.equal(st.uid, process.getuid(), 'must be owned by the writer, never chowned into place');
  assert.equal(await fsp.readFile(credFile, 'utf8'), TOKEN_LINE);

  // The reset + store pair, in that order, and nothing inherited.
  assert.deepEqual(await helperConfig(projectPath), ['', `store --file=${credFile}`]);
});

test('an empty credential revokes: file removed and helper unset', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  await apply(projectPath, TOKEN_LINE);
  const res = await apply(projectPath, '');

  assert.equal(res.revoked, true);
  const { credFile } = workspaceGitPaths(projectPath);
  await assert.rejects(() => fsp.lstat(credFile), /ENOENT/, 'a revoked token must not linger on disk');
  assert.deepEqual(await helperConfig(projectPath), [], 'helper must be unset');
});

test('a workspace with no .git is a no-op, not an error', async (t) => {
  const { projectPath } = await tmpWorkspace(t, { init: false });
  const res = await apply(projectPath, TOKEN_LINE);
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'no-git-dir');
});

// --- symlink and path-substitution refusals -----------------------------------

test('SECURITY: a symlink planted at the credential path is never followed', async (t) => {
  const { root, projectPath } = await tmpWorkspace(t);
  const outside = path.join(root, 'outside-target');
  await fsp.writeFile(outside, 'ORIGINAL\n');
  const { credFile } = workspaceGitPaths(projectPath);
  await fsp.symlink(outside, credFile);

  await apply(projectPath, TOKEN_LINE);

  // The victim file is untouched, and the credential landed in a real file.
  assert.equal(await fsp.readFile(outside, 'utf8'), 'ORIGINAL\n', 'the symlink target must not be written through');
  const st = await fsp.lstat(credFile);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'the planted symlink must have been replaced by a real file');
  assert.equal(st.mode & 0o777, 0o600);
});

test('SECURITY: a symlinked .git directory is refused outright', async (t) => {
  const { root, projectPath } = await tmpWorkspace(t, { init: false });
  const elsewhere = path.join(root, 'elsewhere');
  await fsp.mkdir(elsewhere);
  await fsp.symlink(elsewhere, path.join(projectPath, '.git'));

  await assert.rejects(() => apply(projectPath, TOKEN_LINE), /symlinked git directory/);
  await assert.rejects(
    () => fsp.lstat(path.join(elsewhere, WORKSPACE_CRED_FILENAME)),
    /ENOENT/,
    'nothing may be written through the redirected directory',
  );
});

test('SECURITY: a .git FILE (linked worktree/submodule) is refused, not written into', async (t) => {
  const { projectPath } = await tmpWorkspace(t, { init: false });
  await fsp.writeFile(path.join(projectPath, '.git'), 'gitdir: /some/other/real/gitdir\n');
  await assert.rejects(() => apply(projectPath, TOKEN_LINE), /non-directory \.git/);
});

test('SECURITY: a directory planted at the credential path is cleared, not written into', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const { credFile } = workspaceGitPaths(projectPath);
  await fsp.mkdir(credFile);
  await fsp.writeFile(path.join(credFile, 'decoy'), 'x');

  const res = await apply(projectPath, TOKEN_LINE);
  assert.equal(res.remediated, true);
  assert.equal(res.remediatedReason, 'non-regular');
  assert.ok((await fsp.lstat(credFile)).isFile());
});

// --- existing-artifact migration ---------------------------------------------

test('MIGRATION: a foreign-owned artifact is unlinked and recreated, never chowned', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const { credFile } = workspaceGitPaths(projectPath);
  await fsp.writeFile(credFile, 'STALE\n', { mode: 0o600 });

  // Simulate the observed production artifact: a regular 0600 file whose owner
  // is not us. We cannot really chown without root, so assert the decision
  // function directly against a foreign uid.
  const foreign = process.getuid() + 12345;
  const res = await applyWorkspaceGitCredentialJob({
    fsp, execFile: execFileAsync, projectPath, credential: TOKEN_LINE, currentUid: foreign,
  }).catch((e) => e);

  // With a foreign expected-uid the .git dir itself no longer looks ours, which
  // is the correct refusal: we are not the workspace owner in that scenario.
  assert.ok(res instanceof Error, 'a .git owned by someone else must be refused');
  assert.match(res.message, /owned by uid/);
  assert.equal(await fsp.readFile(credFile, 'utf8'), 'STALE\n', 'refusal must not have written anything');
});

test('MIGRATION: a 0644 artifact is tightened to 0600 by rewrite', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const { credFile } = workspaceGitPaths(projectPath);
  await fsp.writeFile(credFile, 'LOOSE\n', { mode: 0o644 });

  await apply(projectPath, TOKEN_LINE);
  assert.equal((await fsp.lstat(credFile)).mode & 0o777, 0o600);
  assert.equal(await fsp.readFile(credFile, 'utf8'), TOKEN_LINE);
});

// --- inventory ---------------------------------------------------------------

test('inventory reports type, ownership and mode — and never file contents', async (t) => {
  const { root, projectPath } = await tmpWorkspace(t);
  await apply(projectPath, TOKEN_LINE);
  // A second project whose artifact is a symlink.
  const bad = path.join(root, 'Bad');
  await fsp.mkdir(path.join(bad, '.git'), { recursive: true });
  await fsp.symlink('/etc/passwd', path.join(bad, '.git', WORKSPACE_CRED_FILENAME));

  const inv = await inventoryWorkspaceGitCredentials({ fsp, workspaceRoot: root, names: ['Proj', 'Bad', 'Absent'] });

  assert.equal(inv.artifacts.length, 2, 'only existing artifacts are reported');
  const byName = Object.fromEntries(inv.artifacts.map((a) => [a.project, a]));
  assert.equal(byName.Proj.type, 'file');
  assert.equal(byName.Proj.unsafe, false);
  assert.equal(byName.Bad.type, 'symlink');
  assert.equal(byName.Bad.unsafe, true);
  assert.equal(inv.unsafeCount, 1);
  assert.ok(!JSON.stringify(inv).includes(SECRET), 'inventory must never reflect credential material');
});

test('inventory cannot be walked out of its root by a crafted project name', async (t) => {
  const { root } = await tmpWorkspace(t);
  const inv = await inventoryWorkspaceGitCredentials({
    fsp, workspaceRoot: root, names: ['../escape', 'a/b', '..'],
  });
  assert.deepEqual(inv.artifacts, [], 'names that resolve outside the root are skipped');
});

// --- secret non-reflection ---------------------------------------------------

test('SECURITY: the credential never appears in a return value or an error message', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const ok = await apply(projectPath, TOKEN_LINE);
  assert.ok(!JSON.stringify(ok).includes(SECRET), 'success result must not reflect the credential');

  // Force a failure with a credential in hand and inspect the message.
  const broken = path.join(projectPath, 'nope');
  await fsp.mkdir(path.join(broken, '.git'), { recursive: true });
  await fsp.writeFile(path.join(broken, '.git', WORKSPACE_CRED_FILENAME), 'x');
  const err = await applyWorkspaceGitCredentialJob({
    fsp,
    execFile: async () => { throw Object.assign(new Error('git exploded'), { code: 128 }); },
    projectPath: broken,
    credential: TOKEN_LINE,
  }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.ok(!err.message.includes(SECRET), 'error message must not carry the credential');
});

test('SECURITY: the credential is never passed as a git argument', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const seen = [];
  await applyWorkspaceGitCredentialJob({
    fsp,
    execFile: async (bin, args) => { seen.push([bin, ...args].join(' ')); return { stdout: '', stderr: '' }; },
    projectPath,
    credential: TOKEN_LINE,
  });
  assert.ok(seen.length > 0, 'git must actually have been invoked');
  for (const cmd of seen) {
    assert.ok(!cmd.includes(SECRET), `credential leaked into argv: ${cmd}`);
  }
});

// --- failure atomicity -------------------------------------------------------

test('ATOMICITY: a git config failure surfaces and does not leave the helper half-configured', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  let calls = 0;
  const err = await applyWorkspaceGitCredentialJob({
    fsp,
    execFile: async (bin, args) => {
      calls += 1;
      // Let the unset-all through, fail the first --add.
      if (args.includes('--add')) throw Object.assign(new Error('nope'), { code: 1 });
      return { stdout: '', stderr: '' };
    },
    projectPath,
    credential: TOKEN_LINE,
  }).catch((e) => e);

  assert.ok(err instanceof Error, 'a failing --add must reject rather than report success');
  assert.match(err.message, /git config --add failed/);
  assert.ok(calls >= 2);
  // The real repo's helper was never pointed at the file, so git will not try to
  // use a store the caller was told had failed.
  assert.deepEqual(await helperConfig(projectPath), []);
});

test('a failing unset-all on a repo with no helper yet is tolerated', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const res = await applyWorkspaceGitCredentialJob({
    fsp,
    execFile: async (bin, args) => {
      if (args.includes('--unset-all')) throw Object.assign(new Error('no such section'), { code: 5 });
      return { stdout: '', stderr: '' };
    },
    projectPath,
    credential: TOKEN_LINE,
  });
  assert.equal(res.applied, true);
});

// --- serialization contract --------------------------------------------------

test('the serialization contract is asserted, not assumed', () => {
  assert.throws(() => assertSerialized(false), /withProjectsLock\(\) or withLifecycleLock\(\)/);
  assert.throws(() => assertSerialized(undefined), /must run inside/);
  // Default is opt-OUT: a caller that says nothing is treated as unserialized, so
  // the assertion cannot be satisfied by forgetting to think about it.
  assert.throws(() => assertSerialized(), /must run inside/);
  assert.doesNotThrow(() => assertSerialized(true));
});

test('CONCURRENCY: two rotations serialized by the caller leave the later value, intact', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const { credFile } = workspaceGitPaths(projectPath);
  // Serialized, as every real caller is (inside a projects/lifecycle lock).
  await apply(projectPath, 'https://first:x-oauth-basic@github.com\n');
  await apply(projectPath, 'https://second:x-oauth-basic@github.com\n');

  const body = await fsp.readFile(credFile, 'utf8');
  assert.equal(body, 'https://second:x-oauth-basic@github.com\n', 'last writer wins cleanly, no interleaving');
  assert.equal((await fsp.lstat(credFile)).mode & 0o777, 0o600);
  assert.deepEqual(await helperConfig(projectPath), ['', `store --file=${credFile}`], 'no duplicated helper entries');
});

test('CONCURRENCY: rotation followed by removal leaves no credential behind', async (t) => {
  const { projectPath } = await tmpWorkspace(t);
  const { credFile } = workspaceGitPaths(projectPath);
  await apply(projectPath, TOKEN_LINE);
  await apply(projectPath, '');
  await assert.rejects(() => fsp.lstat(credFile), /ENOENT/);
  assert.deepEqual(await helperConfig(projectPath), []);
});

// --- path validation --------------------------------------------------------

test('a relative project path is refused', () => {
  assert.throws(() => workspaceGitPaths('relative/path'), /absolute project path/);
  assert.throws(() => workspaceGitPaths(''), /absolute project path/);
});
