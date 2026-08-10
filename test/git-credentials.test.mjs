// Unit-level contract for app/git-credentials.js — the module that moved the git
// credential-helper artifact (`<project>/.git/.pw-credentials`) and its
// `git config --local credential.helper` wiring OUT of the root dashboard and
// behind the workspace-owner privilege boundary.
//
// Descriptor-pinning itself is covered in test/git-credential-pin.test.mjs; the
// whole-operation contract (rollback, confirmed revocation) is covered in
// test/git-credential-job.test.mjs.
//
// Everything here uses SYNTHETIC token sentinels only. No real credential value
// is ever read, written, or asserted on in this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  planGitCredentialTarget,
  descendPinned,
  nodeJobDeps,
  nodeRunGit,
  openPinnedGitDir,
  inspectArtifact,
  writeStagedCredential,
  promoteStaged,
  snapshotArtifact,
  restoreSnapshot,
  discardSnapshot,
  removeArtifact,
  confirmArtifactAbsent,
  verifyArtifact,
  gitCredentialLine,
  applyLocalCredentialHelper,
  clearLocalCredentialHelper,
  readLocalHelpers,
} from '../app/git-credentials.js';

const SENTINEL = 'ghp_SYNTHETIC_TEST_SENTINEL_0001';
const SENTINEL_2 = 'ghp_SYNTHETIC_TEST_SENTINEL_0002';
const ME = process.getuid();

function tmpRoot(prefix = 'pw-gitcred-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function plan(root, projectPath) {
  return planGitCredentialTarget({ workspaceRoot: root, projectPath, registeredPaths: [projectPath] });
}

// The descent moves the PROCESS working directory (that is the whole point — see
// the module header), so every test that runs it puts the runner back.
async function inRestoredCwd(fn) {
  const before = process.cwd();
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

function bareRepo(root, name = 'demo') {
  const projectPath = path.join(root, name);
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  return projectPath;
}

function realRepo(root, name = 'demo') {
  const projectPath = path.join(root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  return projectPath;
}

// Run `fn` with a live pinned descriptor on <root>/<name>/.git.
async function withPinned(makeRepo, fn) {
  const root = tmpRoot();
  const projectPath = makeRepo(root);
  const p = plan(root, projectPath);
  return inRestoredCwd(async () => {
    const deps = nodeJobDeps();
    const pin = await openPinnedGitDir({ deps, rootAbs: p.rootAbs, components: p.components, expectedUid: ME });
    try {
      return await fn({ root, projectPath, plan: p, pin, deps, gitDir: p.gitDirAbs });
    } finally {
      await pin.close().catch(() => {});
    }
  });
}

function leftovers(gitDir) {
  return fs.readdirSync(gitDir).filter((n) => n.includes('.staged-') || n.includes('.rollback-') || n.includes('.restore-'));
}

function gitIn(gitDir, args) {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Target planning
// ---------------------------------------------------------------------------

test('planGitCredentialTarget resolves a registered project to its .git artifact', () => {
  const root = tmpRoot();
  const p = plan(root, path.join(root, 'demo'));
  assert.deepEqual(p.components, ['demo', '.git']);
  assert.equal(p.rootAbs, root);
  assert.equal(p.gitDirAbs, path.join(root, 'demo', '.git'));
  assert.equal(p.credFileAbs, path.join(root, 'demo', '.git', '.pw-credentials'));
});

test('planGitCredentialTarget accepts a nested registered project path', () => {
  const root = tmpRoot();
  const p = plan(root, path.join(root, 'group', 'demo'));
  assert.deepEqual(p.components, ['group', 'demo', '.git']);
});

test('planGitCredentialTarget refuses a repository outside the configured workspace boundary', () => {
  const root = tmpRoot();
  for (const outside of ['/etc/project', `${root}-sibling/demo`]) {
    assert.throws(
      () => planGitCredentialTarget({ workspaceRoot: root, projectPath: outside, registeredPaths: [outside] }),
      /outside the configured workspace/i,
      `expected refusal for ${outside}`,
    );
  }
});

test('planGitCredentialTarget refuses the workspace root itself as a project', () => {
  const root = tmpRoot();
  assert.throws(
    () => planGitCredentialTarget({ workspaceRoot: root, projectPath: root, registeredPaths: [root] }),
    /not a project|outside the configured workspace/i,
  );
});

test('planGitCredentialTarget refuses traversal and non-absolute inputs', () => {
  const root = tmpRoot();
  assert.throws(() => planGitCredentialTarget({ workspaceRoot: root, projectPath: 'demo', registeredPaths: ['demo'] }), /absolute/i);
  assert.throws(() => planGitCredentialTarget({ workspaceRoot: 'workspaces', projectPath: '/x/demo', registeredPaths: ['/x/demo'] }), /absolute/i);
  assert.throws(() => planGitCredentialTarget({ workspaceRoot: root, projectPath: '', registeredPaths: [] }), /required|absolute/i);
  assert.throws(() => planGitCredentialTarget({ workspaceRoot: '', projectPath: path.join(root, 'demo'), registeredPaths: [] }), /required|absolute/i);
});

test('planGitCredentialTarget refuses a path that only looks like a prefix match of the root', () => {
  const root = tmpRoot();
  const impostor = `${root}evil/demo`;
  assert.throws(
    () => planGitCredentialTarget({ workspaceRoot: root, projectPath: impostor, registeredPaths: [impostor] }),
    /outside the configured workspace/i,
  );
});

// ---------------------------------------------------------------------------
// Descent
// ---------------------------------------------------------------------------

test('descendPinned lands on the .git directory and reports its identity', async () => {
  const root = tmpRoot();
  const projectPath = bareRepo(root);
  const p = plan(root, projectPath);
  const reached = await inRestoredCwd(async () => {
    const st = await descendPinned({ deps: nodeJobDeps(), rootAbs: p.rootAbs, components: p.components });
    assert.equal(process.cwd(), p.gitDirAbs);
    return st;
  });
  const real = fs.statSync(p.gitDirAbs);
  assert.equal(reached.ino, real.ino);
  assert.equal(reached.dev, real.dev);
});

test('descendPinned refuses a symlinked .git', async () => {
  const root = tmpRoot();
  const projectPath = path.join(root, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(projectPath, '.git'));
  const p = plan(root, projectPath);
  await inRestoredCwd(async () => {
    await assert.rejects(descendPinned({ deps: nodeJobDeps(), rootAbs: p.rootAbs, components: p.components }), /symlink/i);
  });
});

test('descendPinned refuses a symlinked intermediate component', async () => {
  const root = tmpRoot();
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, '.git'), { recursive: true });
  fs.symlinkSync(real, path.join(root, 'demo'));
  const p = plan(root, path.join(root, 'demo'));
  await inRestoredCwd(async () => {
    await assert.rejects(descendPinned({ deps: nodeJobDeps(), rootAbs: p.rootAbs, components: p.components }), /symlink/i);
  });
});

test('descendPinned refuses a .git that is a regular file (a linked worktree stub)', async () => {
  const root = tmpRoot();
  const projectPath = path.join(root, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.git'), 'gitdir: /somewhere/else\n');
  const p = plan(root, projectPath);
  await inRestoredCwd(async () => {
    await assert.rejects(descendPinned({ deps: nodeJobDeps(), rootAbs: p.rootAbs, components: p.components }), /not a directory/i);
  });
});

test('descendPinned refuses a missing repository without creating anything', async () => {
  const root = tmpRoot();
  const p = plan(root, path.join(root, 'demo'));
  await inRestoredCwd(async () => {
    await assert.rejects(descendPinned({ deps: nodeJobDeps(), rootAbs: p.rootAbs, components: p.components }), /ENOENT|no such file/i);
  });
  assert.equal(fs.existsSync(path.join(root, 'demo')), false);
});

test('descendPinned detects a directory swapped in between the check and the chdir', async () => {
  const root = tmpRoot();
  const projectPath = bareRepo(root);
  const decoy = path.join(root, 'decoy');
  fs.mkdirSync(decoy, { recursive: true });
  const p = plan(root, projectPath);

  const real = nodeJobDeps();
  const racing = {
    ...real,
    chdir(target) {
      if (target === 'demo') {
        fs.rmSync(projectPath, { recursive: true, force: true });
        fs.renameSync(decoy, projectPath);
      }
      return real.chdir(target);
    },
  };
  await inRestoredCwd(async () => {
    await assert.rejects(descendPinned({ deps: racing, rootAbs: p.rootAbs, components: p.components }), /substitut/i);
  });
});

// ---------------------------------------------------------------------------
// The credential value
// ---------------------------------------------------------------------------

test('gitCredentialLine refuses a token carrying a line break, without echoing it', () => {
  const bads = [`${SENTINEL}\nhttps://attacker:x@evil.example`, `${SENTINEL}\r\nx`, `${SENTINEL} x`];
  for (const bad of bads) {
    let caught;
    try { gitCredentialLine(bad); } catch (e) { caught = e; }
    assert.ok(caught, 'a multi-line credential value must be refused');
    assert.match(caught.message, /line break|control character/i);
    assert.equal(caught.message.includes(SENTINEL), false, 'the diagnostic must not echo the credential');
  }
  assert.equal(gitCredentialLine(SENTINEL), `https://${SENTINEL}:x-oauth-basic@github.com\n`);
});

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

test('inspectArtifact reports absence without creating anything', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const seen = await inspectArtifact({ deps, pin });
    assert.equal(seen.present, false);
    assert.equal(seen.type, 'absent');
    assert.deepEqual(fs.readdirSync(gitDir), []);
  });
});

test('inspectArtifact reports metadata only — never the credential content', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    fs.writeFileSync(path.join(gitDir, '.pw-credentials'), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });
    const seen = await inspectArtifact({ deps, pin });
    assert.deepEqual(
      { present: seen.present, type: seen.type, mode: seen.mode, uid: seen.uid },
      { present: true, type: 'regular', mode: 0o600, uid: ME },
    );
    assert.equal(JSON.stringify(seen).includes(SENTINEL), false, 'inspection must never carry the credential');
  });
});

test('inspectArtifact classifies a symlink without following it', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, root }) => {
    const bait = path.join(root, 'bait');
    fs.writeFileSync(bait, 'not ours\n');
    fs.symlinkSync(bait, path.join(gitDir, '.pw-credentials'));
    assert.equal((await inspectArtifact({ deps, pin })).type, 'symlink');
  });
});

test('inspectArtifact classifies a directory planted at the artifact path', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    fs.mkdirSync(path.join(gitDir, '.pw-credentials'));
    assert.equal((await inspectArtifact({ deps, pin })).type, 'directory');
  });
});

test('a staged credential is invisible to git until it is promoted', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const staged = await writeStagedCredential({ deps, pin, token: SENTINEL });
    assert.equal(fs.existsSync(path.join(gitDir, '.pw-credentials')), false, 'staging must not publish');
    assert.equal(fs.lstatSync(path.join(gitDir, staged.stagedName)).mode & 0o777, 0o600);

    await promoteStaged({ deps, pin, stagedName: staged.stagedName });
    const file = path.join(gitDir, '.pw-credentials');
    assert.equal(fs.readFileSync(file, 'utf8'), `https://${SENTINEL}:x-oauth-basic@github.com\n`);
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(file).uid, ME);
    assert.deepEqual(leftovers(gitDir), []);
  });
});

test('promoting replaces an existing artifact and repairs a loose mode', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const file = path.join(gitDir, '.pw-credentials');
    fs.writeFileSync(file, `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });
    const staged = await writeStagedCredential({ deps, pin, token: SENTINEL_2 });
    await promoteStaged({ deps, pin, stagedName: staged.stagedName });
    assert.equal(fs.readFileSync(file, 'utf8'), `https://${SENTINEL_2}:x-oauth-basic@github.com\n`);
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(gitDir), []);
  });
});

test('a failed staged write publishes nothing and strands no file holding the token', async () => {
  await withPinned(bareRepo, async ({ pin, gitDir }) => {
    const real = nodeJobDeps();
    const failing = {
      ...real,
      async open(name, flags, mode) {
        const fh = await real.open(name, flags, mode);
        fh.writeFile = async () => { throw new Error('injected write failure'); };
        return fh;
      },
    };
    await assert.rejects(writeStagedCredential({ deps: failing, pin, token: SENTINEL }), /injected write failure/);
    assert.equal(fs.existsSync(path.join(gitDir, '.pw-credentials')), false);
    assert.deepEqual(leftovers(gitDir), []);
  });
});

test('a content-blind snapshot restores the exact prior credential', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const file = path.join(gitDir, '.pw-credentials');
    const original = `https://${SENTINEL}:x-oauth-basic@github.com\n`;
    fs.writeFileSync(file, original, { mode: 0o600 });

    const snapshot = await snapshotArtifact({ deps, pin });
    assert.ok(snapshot, 'a regular artifact must be snapshotted');
    const staged = await writeStagedCredential({ deps, pin, token: SENTINEL_2 });
    await promoteStaged({ deps, pin, stagedName: staged.stagedName });
    assert.notEqual(fs.readFileSync(file, 'utf8'), original);

    await restoreSnapshot({ deps, pin, snapshot });
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the prior credential must come back byte-for-byte');
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(gitDir), []);
  });
});

test('snapshotArtifact declines to snapshot anything that is not a regular file', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, root }) => {
    assert.equal(await snapshotArtifact({ deps, pin }), null, 'nothing to snapshot when absent');
    fs.writeFileSync(path.join(root, 'bait'), 'x\n');
    fs.symlinkSync(path.join(root, 'bait'), path.join(gitDir, '.pw-credentials'));
    assert.equal(await snapshotArtifact({ deps, pin }), null, 'a symlink is never snapshotted');
  });
});

test('discardSnapshot removes the rollback link and leaves the artifact alone', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    fs.writeFileSync(path.join(gitDir, '.pw-credentials'), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });
    const snapshot = await snapshotArtifact({ deps, pin });
    await discardSnapshot({ deps, pin, snapshot });
    assert.deepEqual(leftovers(gitDir), []);
    assert.equal(fs.existsSync(path.join(gitDir, '.pw-credentials')), true);
  });
});

test('removeArtifact deletes a regular artifact and reports proven absence when repeated', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const file = path.join(gitDir, '.pw-credentials');
    fs.writeFileSync(file, `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });
    assert.deepEqual(await removeArtifact({ deps, pin }), { removed: true, provenAbsent: true, type: 'regular' });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await removeArtifact({ deps, pin }), { removed: false, provenAbsent: true, type: 'absent' });
    assert.equal(await confirmArtifactAbsent({ deps, pin }), true);
  });
});

test('removeArtifact unlinks a planted symlink without touching its target', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, root }) => {
    const bait = path.join(root, 'bait');
    fs.writeFileSync(bait, 'untouched\n');
    fs.symlinkSync(bait, path.join(gitDir, '.pw-credentials'));
    assert.equal((await removeArtifact({ deps, pin })).removed, true);
    assert.equal(fs.existsSync(path.join(gitDir, '.pw-credentials')), false);
    assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched\n', 'unlink must never follow the link');
  });
});

test('removeArtifact refuses a directory at the credential path instead of deleting a tree', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const planted = path.join(gitDir, '.pw-credentials');
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, 'evidence'), 'keep me\n');
    await assert.rejects(removeArtifact({ deps, pin }), /directory|not a credential file/i);
    assert.equal(fs.existsSync(path.join(planted, 'evidence')), true, 'an attacker-created tree is evidence, never garbage');
  });
});

test('confirmArtifactAbsent refuses to call a still-present artifact absent', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    fs.writeFileSync(path.join(gitDir, '.pw-credentials'), 'x\n', { mode: 0o600 });
    await assert.rejects(confirmArtifactAbsent({ deps, pin }), /still exists/i);
  });
});

test('verifyArtifact accepts only a regular, owner-owned, 0600 artifact', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir }) => {
    const file = path.join(gitDir, '.pw-credentials');
    const staged = await writeStagedCredential({ deps, pin, token: SENTINEL });
    await promoteStaged({ deps, pin, stagedName: staged.stagedName });
    assert.deepEqual(await verifyArtifact({ deps, pin, expectedUid: ME }), { mode: 0o600, uid: ME, gid: fs.lstatSync(file).gid });

    // Wrong owner — checked against an INDEPENDENTLY supplied expectation, so
    // this assertion can actually fail (see the Round 8 finding).
    await assert.rejects(verifyArtifact({ deps, pin, expectedUid: ME + 1 }), /owned by uid/i);

    fs.chmodSync(file, 0o644);
    await assert.rejects(verifyArtifact({ deps, pin, expectedUid: ME }), /mode 644, expected 600/i);
  });
});

test('verifyArtifact refuses a symlink at the published name', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, root }) => {
    fs.writeFileSync(path.join(root, 'bait'), 'x\n');
    fs.symlinkSync(path.join(root, 'bait'), path.join(gitDir, '.pw-credentials'));
    await assert.rejects(verifyArtifact({ deps, pin, expectedUid: ME }), /symlink/i);
  });
});

// ---------------------------------------------------------------------------
// .git/config — applied through git's own config.lock protocol
// ---------------------------------------------------------------------------

test('applyLocalCredentialHelper installs exactly the reset + our store, preserving other config', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    gitIn(gitDir, ['config', '--local', 'user.name', 'Someone Else']);
    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME });
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), ['', `store --file=${p.credFileAbs}`]);
    assert.equal(gitIn(gitDir, ['config', '--local', '--get', 'user.name']).trim(), 'Someone Else');
    assert.equal(fs.existsSync(path.join(gitDir, 'config.lock')), false);
  });
});

test('applyLocalCredentialHelper is idempotent — a second run does not accumulate helpers', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    const args = { deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME };
    await applyLocalCredentialHelper(args);
    const first = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    await applyLocalCredentialHelper(args);
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), ['', `store --file=${p.credFileAbs}`]);
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), first);
  });
});

test('applyLocalCredentialHelper replaces a stale helper left by an earlier rotation', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    gitIn(gitDir, ['config', '--local', '--add', 'credential.helper', 'store --file=/stale/path']);
    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME });
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), ['', `store --file=${p.credFileAbs}`]);
  });
});

test('applyLocalCredentialHelper works when the repository has no config file yet', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, plan: p }) => {
    assert.equal(fs.existsSync(path.join(gitDir, 'config')), false);
    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME });
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), ['', `store --file=${p.credFileAbs}`]);
  });
});

test('clearLocalCredentialHelper removes every local helper and keeps the rest of the config', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME });
    gitIn(gitDir, ['config', '--local', 'user.email', 'someone@example.invalid']);
    await clearLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), expectedUid: ME });
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), []);
    assert.equal(gitIn(gitDir, ['config', '--local', '--get', 'user.email']).trim(), 'someone@example.invalid');
    assert.equal(fs.existsSync(path.join(gitDir, 'config.lock')), false);
  });
});

test('clearLocalCredentialHelper is a no-op when no helper is configured', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir }) => {
    const before = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    await clearLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), expectedUid: ME });
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), before);
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), []);
  });
});

test('a failing git step leaves .git/config byte-identical and strands no lock', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    const before = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const real = nodeRunGit();
    let calls = 0;
    const flaky = async (args) => {
      calls += 1;
      if (calls === 2) return { code: 129, stdout: '', stderr: 'injected git failure' };
      return real(args);
    };
    await assert.rejects(
      applyLocalCredentialHelper({ deps, pin, runGit: flaky, credFileAbs: p.credFileAbs, expectedUid: ME }),
      /injected git failure|git config/i,
    );
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), before, 'a half-applied config must never be published');
    assert.equal(fs.existsSync(path.join(gitDir, 'config.lock')), false, 'the lock must be released on failure');
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), []);
  });
});

test('applyLocalCredentialHelper refuses a symlinked .git/config', async () => {
  await withPinned(bareRepo, async ({ deps, pin, gitDir, root, plan: p }) => {
    const bait = path.join(root, 'bait-config');
    fs.writeFileSync(bait, '[core]\n');
    fs.symlinkSync(bait, path.join(gitDir, 'config'));
    await assert.rejects(
      applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME }),
      /symlink|not a regular file/i,
    );
    assert.equal(fs.readFileSync(bait, 'utf8'), '[core]\n', 'the link target must be untouched');
  });
});

test('applyLocalCredentialHelper refuses to proceed while another writer holds config.lock', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    const lock = path.join(gitDir, 'config.lock');
    fs.writeFileSync(lock, 'someone else\n');
    const before = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    await assert.rejects(
      applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME }),
      /another git process|config\.lock/i,
    );
    assert.equal(fs.readFileSync(lock, 'utf8'), 'someone else\n', "another writer's lock must not be stolen");
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), before);
  });
});

test('applyLocalCredentialHelper preserves a tightened config mode', async () => {
  await withPinned(realRepo, async ({ deps, pin, gitDir, plan: p }) => {
    fs.chmodSync(path.join(gitDir, 'config'), 0o600);
    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: p.credFileAbs, expectedUid: ME });
    assert.equal(fs.lstatSync(path.join(gitDir, 'config')).mode & 0o777, 0o600);
  });
});
