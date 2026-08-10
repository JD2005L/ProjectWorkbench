// A31-4 — descriptor-pinned protection against parent `.git` substitution.
//
// The contract under test: once the job has validated and OPENED the repository's
// `.git` directory, every later file operation AND the `git config` subprocess
// must address that open descriptor, not the pathname. Renaming, replacing or
// symlinking any parent afterwards must be incapable of redirecting a single
// write — proven positively here by performing the swap and then showing the
// bytes landed in the original inode and NOT in the attacker's replacement.
//
// Synthetic token sentinels only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  planGitCredentialTarget,
  nodeJobDeps,
  nodeRunGit,
  openPinnedGitDir,
  revalidatePin,
  pinnedPath,
  writeStagedCredential,
  promoteStaged,
  applyLocalCredentialHelper,
  readLocalHelpers,
} from '../app/git-credentials.js';

const SENTINEL = 'ghp_SYNTHETIC_PIN_SENTINEL_0001';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pin-')));
}

function realRepo(root, name) {
  const projectPath = path.join(root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  return projectPath;
}

async function withPin(fn, { name = 'demo', expectedUid = process.getuid() } = {}) {
  const root = tmpRoot();
  const projectPath = realRepo(root, name);
  const plan = planGitCredentialTarget({ workspaceRoot: root, projectPath, registeredPaths: [projectPath] });
  const before = process.cwd();
  const deps = nodeJobDeps();
  let pin;
  try {
    pin = await openPinnedGitDir({ deps, rootAbs: plan.rootAbs, components: plan.components, expectedUid });
    return await fn({ root, projectPath, plan, pin, deps });
  } finally {
    if (pin) await pin.close().catch(() => {});
    process.chdir(before);
  }
}

// Rename the whole project directory away and drop an attacker-controlled
// replacement (with its own `.git`) at the exact path that was validated.
function substituteParent(root, projectPath) {
  const stashed = path.join(root, 'stashed-original');
  fs.renameSync(projectPath, stashed);
  const decoyGit = path.join(projectPath, '.git');
  fs.mkdirSync(decoyGit, { recursive: true });
  return { originalGitDir: path.join(stashed, '.git'), decoyGitDir: decoyGit };
}

test('openPinnedGitDir returns a descriptor-addressed directory matching the real .git', async () => {
  await withPin(async ({ plan, pin }) => {
    const real = fs.statSync(plan.gitDirAbs);
    assert.equal(pin.dev, real.dev);
    assert.equal(pin.ino, real.ino);
    assert.equal(pin.uid, process.getuid());
    assert.equal(pin.dirPath, `/proc/self/fd/${pin.fd}`);
    assert.equal(fs.realpathSync(pin.dirPath), plan.gitDirAbs);
  });
});

test('openPinnedGitDir refuses a .git whose owner is not the expected workspace owner', async () => {
  const root = tmpRoot();
  const projectPath = realRepo(root, 'demo');
  const plan = planGitCredentialTarget({ workspaceRoot: root, projectPath, registeredPaths: [projectPath] });
  const before = process.cwd();
  try {
    await assert.rejects(
      openPinnedGitDir({
        deps: nodeJobDeps(),
        rootAbs: plan.rootAbs,
        components: plan.components,
        // Resolved independently of the running process — the whole point of the
        // Round 8 finding is that an assertion against process.getuid() cannot fail.
        expectedUid: process.getuid() + 1,
      }),
      /owner|ownership/i,
    );
  } finally {
    process.chdir(before);
  }
});

test('a parent swapped AFTER pinning cannot redirect the credential write', async () => {
  await withPin(async ({ root, projectPath, plan, pin, deps }) => {
    const { originalGitDir, decoyGitDir } = substituteParent(root, projectPath);

    const staged = await writeStagedCredential({ deps, pin, token: SENTINEL });
    await promoteStaged({ deps, pin, stagedName: staged.stagedName });

    const landed = path.join(originalGitDir, '.pw-credentials');
    assert.equal(fs.existsSync(landed), true, 'the write must land in the pinned inode');
    assert.equal(fs.lstatSync(landed).mode & 0o777, 0o600);
    assert.equal(
      fs.existsSync(path.join(decoyGitDir, '.pw-credentials')),
      false,
      'the substituted directory must receive nothing',
    );
    assert.equal(fs.readdirSync(decoyGitDir).length, 0);
    assert.equal(plan.credFileAbs, path.join(projectPath, '.git', '.pw-credentials'));
  });
});

test('a parent swapped AFTER pinning cannot redirect the git config update', async () => {
  await withPin(async ({ root, projectPath, plan, pin, deps }) => {
    const { originalGitDir, decoyGitDir } = substituteParent(root, projectPath);

    await applyLocalCredentialHelper({ deps, pin, runGit: nodeRunGit(), credFileAbs: plan.credFileAbs });

    const originalConfig = fs.readFileSync(path.join(originalGitDir, 'config'), 'utf8');
    assert.match(originalConfig, /credential/, 'the pinned repository must be the one configured');
    assert.match(originalConfig, /store --file=/);
    assert.equal(
      fs.existsSync(path.join(decoyGitDir, 'config')),
      false,
      'the substituted directory must never be configured',
    );
    assert.deepEqual(await readLocalHelpers({ deps, pin, runGit: nodeRunGit() }), ['', `store --file=${plan.credFileAbs}`]);
  });
});

test('revalidatePin fails closed once the pinned directory has been unlinked', async () => {
  await withPin(async ({ plan, pin, deps }) => {
    await revalidatePin({ deps, pin, expectedUid: process.getuid() });
    fs.rmSync(plan.gitDirAbs, { recursive: true, force: true });
    await assert.rejects(revalidatePin({ deps, pin, expectedUid: process.getuid() }), /no longer|removed|unlinked/i);
  });
});

test('revalidatePin fails closed when the pinned directory stops being owned by the expected owner', async () => {
  await withPin(async ({ pin, deps }) => {
    await assert.rejects(revalidatePin({ deps, pin, expectedUid: process.getuid() + 1 }), /owner|ownership/i);
  });
});

test('pinnedPath addresses names through the descriptor, never through the pathname', async () => {
  await withPin(async ({ pin }) => {
    assert.equal(pinnedPath(pin, 'config'), `/proc/self/fd/${pin.fd}/config`);
    assert.throws(() => pinnedPath(pin, 'a/b'), /single path component/i);
    assert.throws(() => pinnedPath(pin, '..'), /single path component/i);
    assert.throws(() => pinnedPath(pin, ''), /single path component/i);
  });
});

// ---------------------------------------------------------------------------
// A31-4 — exact registered workspace path
// ---------------------------------------------------------------------------

test('planGitCredentialTarget refuses a path that is not the exact registered workspace path', () => {
  const root = tmpRoot();
  const registered = path.join(root, 'demo');
  for (const impostor of [path.join(root, 'other'), path.join(root, 'demo', 'nested'), path.join(root, 'demo2')]) {
    assert.throws(
      () => planGitCredentialTarget({ workspaceRoot: root, projectPath: impostor, registeredPaths: [registered] }),
      /registered/i,
      `expected refusal for ${impostor}`,
    );
  }
  assert.doesNotThrow(() => planGitCredentialTarget({ workspaceRoot: root, projectPath: registered, registeredPaths: [registered] }));
});

test('planGitCredentialTarget refuses a registered path that escapes the workspace boundary', () => {
  const root = tmpRoot();
  assert.throws(
    () => planGitCredentialTarget({ workspaceRoot: root, projectPath: '/etc/demo', registeredPaths: ['/etc/demo'] }),
    /outside the configured workspace/i,
  );
});

test('planGitCredentialTarget requires a registry to compare against', () => {
  const root = tmpRoot();
  assert.throws(
    () => planGitCredentialTarget({ workspaceRoot: root, projectPath: path.join(root, 'demo') }),
    /registered/i,
  );
});
