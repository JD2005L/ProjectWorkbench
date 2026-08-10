// A31-1 (confirmed, fail-closed revocation) and A31-2 (failure-atomic
// credential + Git-helper transitions) at the level of the whole operation.
//
// Every failure case here injects a failure at ONE real step and then inspects
// the REAL file on disk and the REAL local Git config afterwards. A job that
// returns success without both halves of the transition actually being true is
// the exact defect this file exists to prevent.
//
// Synthetic token sentinels only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runGitCredentialJob, nodeJobDeps, nodeRunGit } from '../app/git-credentials.js';

const OLD = 'ghp_SYNTHETIC_JOB_SENTINEL_OLD1';
const NEW = 'ghp_SYNTHETIC_JOB_SENTINEL_NEW2';
const ME = process.getuid();

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-job-')));
}

function makeWorkspace(name = 'demo') {
  const root = tmpRoot();
  const projectPath = path.join(root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  return { root, projectPath, gitDir: path.join(projectPath, '.git') };
}

function job(ws, extra = {}) {
  return {
    deps: nodeJobDeps(),
    runGit: nodeRunGit(),
    workspaceRoot: ws.root,
    projectPath: ws.projectPath,
    registeredPaths: [ws.projectPath],
    expectedUid: ME,
    ...extra,
  };
}

// Real on-disk state, read directly rather than from the job's own report.
function onDisk(ws) {
  const file = path.join(ws.gitDir, '.pw-credentials');
  let helpers = [];
  try {
    helpers = execFileSync('git', ['config', '--file', path.join(ws.gitDir, 'config'), '--get-all', 'credential.helper'], { encoding: 'utf8' })
      .split('\n').slice(0, -1);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  const present = fs.existsSync(file);
  return {
    present,
    content: present ? fs.readFileSync(file, 'utf8') : null,
    mode: present ? fs.lstatSync(file).mode & 0o777 : null,
    uid: present ? fs.lstatSync(file).uid : null,
    helpers,
    leftovers: fs.readdirSync(ws.gitDir).filter((n) => /\.(staged|rollback|restore)-/.test(n) || n === 'config.lock'),
  };
}

function line(token) {
  return `https://${token}:x-oauth-basic@github.com\n`;
}

// Fail exactly one filesystem operation, by name and by target suffix.
function failingDeps(op, match) {
  const real = nodeJobDeps();
  return {
    ...real,
    [op]: async (...args) => {
      if (String(args[0]).endsWith(match) || String(args[1] ?? '').endsWith(match)) {
        const err = new Error(`injected ${op} failure`);
        err.code = 'EIO';
        throw err;
      }
      return real[op](...args);
    },
  };
}

// Fail the Nth `git config` invocation (1 = --unset-all, 2 = --add reset, 3 = --add store).
function failingGitAt(n) {
  const real = nodeRunGit();
  let calls = 0;
  return async (args) => {
    calls += 1;
    if (calls === n) return { code: 129, stdout: '', stderr: 'injected git failure' };
    return real(args);
  };
}

async function seed(ws) {
  const result = await runGitCredentialJob(job(ws, { token: OLD }));
  assert.equal(result.applied, true);
  return result;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('a first credential write publishes the artifact and the helper together', async () => {
  const ws = makeWorkspace();
  const result = await runGitCredentialJob(job(ws, { token: OLD }));
  const state = onDisk(ws);
  assert.equal(result.action, 'set');
  assert.equal(result.applied, true);
  assert.equal(state.content, line(OLD));
  assert.equal(state.mode, 0o600);
  assert.equal(state.uid, ME);
  assert.deepEqual(state.helpers, ['', `store --file=${path.join(ws.gitDir, '.pw-credentials')}`]);
  assert.deepEqual(state.leftovers, []);
});

test('the job report carries metadata only — never the credential', async () => {
  const ws = makeWorkspace();
  const result = await runGitCredentialJob(job(ws, { token: OLD }));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(OLD), false, 'the report must not carry the credential value');
  assert.equal(serialized.includes('x-oauth-basic'), false, 'the report must not carry the credential line');
});

test('rotation replaces the credential and leaves the helper pair correct and idempotent', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  await runGitCredentialJob(job(ws, { token: NEW }));
  const after = onDisk(ws);
  assert.equal(after.content, line(NEW));
  assert.equal(after.mode, 0o600);
  assert.deepEqual(after.helpers, before.helpers, 'a rotation must not disturb the helper pair');
  assert.deepEqual(after.leftovers, []);

  await runGitCredentialJob(job(ws, { token: NEW }));
  assert.deepEqual(onDisk(ws), after, 'a repeated rotation must be a no-op on disk');
});

// ---------------------------------------------------------------------------
// A31-1 — revocation must be CONFIRMED, and must fail closed otherwise
// ---------------------------------------------------------------------------

test('revocation removes the artifact and the helper, and reports confirmed removal', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const result = await runGitCredentialJob(job(ws, { token: '' }));
  const state = onDisk(ws);
  assert.equal(result.action, 'clear');
  assert.equal(result.revoked, true);
  assert.equal(result.confirmedAbsent, true);
  assert.equal(state.present, false);
  assert.deepEqual(state.helpers, []);
  assert.deepEqual(state.leftovers, []);
});

test('revoking a project that never had a credential is idempotent success by PROVEN absence', async () => {
  const ws = makeWorkspace();
  const result = await runGitCredentialJob(job(ws, { token: '' }));
  assert.equal(result.revoked, true);
  assert.equal(result.confirmedAbsent, true);
  assert.equal(result.removed, false, 'nothing was removed — absence was proven, not performed');
  assert.deepEqual(onDisk(ws).helpers, []);
});

test('revocation FAILS when the credential cannot be removed, and never claims success', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: '', deps: failingDeps('unlink', '.pw-credentials') })),
    /injected unlink failure|could not/i,
  );
  const state = onDisk(ws);
  assert.equal(state.present, true, 'the credential is still there, so the operation must have failed');
  assert.equal(state.content, line(OLD));
  assert.deepEqual(state.helpers, ['', `store --file=${path.join(ws.gitDir, '.pw-credentials')}`], 'the prior usable pair must be preserved');
  assert.deepEqual(state.leftovers, []);
});

test('revocation FAILS when the helper cannot be unset, leaving the prior usable pair intact', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: '', runGit: failingGitAt(1) })),
    /injected git failure|git config/i,
  );
  const state = onDisk(ws);
  assert.equal(state.content, line(OLD), 'the credential must not be removed when the helper could not be unset');
  assert.deepEqual(state.helpers, ['', `store --file=${path.join(ws.gitDir, '.pw-credentials')}`]);
  assert.deepEqual(state.leftovers, []);
});

test('revocation FAILS rather than succeeding against an unsupported artifact type', async () => {
  const ws = makeWorkspace();
  const planted = path.join(ws.gitDir, '.pw-credentials');
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, 'evidence'), 'keep me\n');
  await assert.rejects(runGitCredentialJob(job(ws, { token: '' })), /directory|not a credential file/i);
  assert.equal(fs.existsSync(path.join(planted, 'evidence')), true, 'never remove an attacker-created tree');
});

// ---------------------------------------------------------------------------
// A31-2 — every injected step failure leaves a usable prior pair on disk
// ---------------------------------------------------------------------------

test('a failure on the second --add restores the exact prior credential and helper pair', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: NEW, runGit: failingGitAt(3) })),
    /injected git failure|git config/i,
  );
  const after = onDisk(ws);
  assert.equal(after.content, before.content, 'the prior credential must survive byte-for-byte');
  assert.equal(after.content, line(OLD));
  assert.equal(after.mode, 0o600);
  assert.deepEqual(after.helpers, before.helpers, 'the helper must not be left half-configured');
  assert.deepEqual(after.leftovers, []);
});

test('a failure on the first --add restores the exact prior credential and helper pair', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW, runGit: failingGitAt(2) })), /injected git failure|git config/i);
  const after = onDisk(ws);
  assert.equal(after.content, line(OLD));
  assert.deepEqual(after.helpers, before.helpers);
  assert.deepEqual(after.leftovers, []);
});

test('a first-ever write that fails at the helper step publishes NOTHING', async () => {
  const ws = makeWorkspace();
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW, runGit: failingGitAt(3) })), /injected git failure|git config/i);
  const state = onDisk(ws);
  assert.equal(state.present, false, 'no credential may be left behind by a failed first write');
  assert.deepEqual(state.helpers, []);
  assert.deepEqual(state.leftovers, []);
});

test('a failure while publishing the staged credential leaves the prior pair untouched', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: NEW, deps: failingDeps('rename', '.pw-credentials') })),
    /injected rename failure/i,
  );
  const after = onDisk(ws);
  assert.equal(after.content, before.content);
  assert.deepEqual(after.helpers, before.helpers);
  assert.deepEqual(after.leftovers, []);
});

test('a failure while staging the new credential leaves the prior pair untouched', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  const real = nodeJobDeps();
  const deps = {
    ...real,
    async open(name, flags, mode) {
      const fh = await real.open(name, flags, mode);
      if (String(name).includes('.staged-')) fh.writeFile = async () => { throw new Error('injected staging failure'); };
      return fh;
    },
  };
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW, deps })), /injected staging failure/i);
  const after = onDisk(ws);
  assert.equal(after.content, before.content);
  assert.deepEqual(after.helpers, before.helpers);
  assert.deepEqual(after.leftovers, []);
});

test('a final verification failure rolls the credential and helper back', async () => {
  const ws = makeWorkspace();
  await seed(ws);
  const before = onDisk(ws);
  // The published artifact is tampered with between publication and
  // verification: the job must not accept it, and must restore the prior pair.
  const real = nodeJobDeps();
  const deps = {
    ...real,
    async rename(from, to) {
      const out = await real.rename(from, to);
      if (String(from).includes('.staged-')) fs.chmodSync(path.join(ws.gitDir, '.pw-credentials'), 0o644);
      return out;
    },
  };
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW, deps })), /mode 644, expected 600/i);
  const after = onDisk(ws);
  assert.equal(after.content, before.content, 'the prior credential must be restored after a failed verification');
  assert.equal(after.mode, 0o600);
  assert.deepEqual(after.helpers, before.helpers);
  assert.deepEqual(after.leftovers, []);
});

// ---------------------------------------------------------------------------
// Fail-closed refusals
// ---------------------------------------------------------------------------

test('a symlink at the credential path is refused and nothing is written through it', async () => {
  const ws = makeWorkspace();
  const bait = path.join(ws.root, 'bait');
  fs.writeFileSync(bait, 'untouched\n');
  fs.symlinkSync(bait, path.join(ws.gitDir, '.pw-credentials'));
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW })), /symlink|not a regular file/i);
  assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched\n');
  assert.deepEqual(onDisk(ws).helpers, []);
});

test('the job refuses when it is not running as the resolved workspace owner', async () => {
  const ws = makeWorkspace();
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: NEW, expectedUid: ME + 1 })),
    /owner|ownership/i,
  );
  assert.equal(onDisk(ws).present, false);
});

test('the job refuses a project path that is not registered', async () => {
  const ws = makeWorkspace();
  await assert.rejects(
    runGitCredentialJob(job(ws, { token: NEW, registeredPaths: [path.join(ws.root, 'something-else')] })),
    /not a registered project/i,
  );
  assert.equal(onDisk(ws).present, false);
});

test('the job refuses a repository whose .git is a linked-worktree file', async () => {
  const ws = makeWorkspace();
  fs.rmSync(ws.gitDir, { recursive: true, force: true });
  fs.writeFileSync(ws.gitDir, 'gitdir: /elsewhere/.git/worktrees/demo\n');
  await assert.rejects(runGitCredentialJob(job(ws, { token: NEW })), /not a directory/i);
});
