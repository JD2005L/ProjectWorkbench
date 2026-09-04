// A31-5 — bounded, explicit, content-blind remediation of credential artifacts
// that already exist on disk.
//
// The contract: it is scoped to the REGISTRY (never a filesystem walk), it
// validates workspace containment and ownership, it reports every state it finds
// truthfully — including the linked-worktree/`.git`-file case that must not be
// silently swallowed — it refuses directories and other non-regular artifacts
// instead of deleting trees, and its report carries metadata only.
//
// Synthetic token sentinels only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  inventoryGitCredentials,
  remediateGitCredentials,
  nodeJobDeps,
  nodeRunGit,
} from '../app/git-credentials.js';

const SENTINEL = 'ghp_SYNTHETIC_REMEDIATION_SENTINEL';
const ME = process.getuid();

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-remed-')));
}

function repo(root, name) {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', '-q', p]);
  return p;
}

function ctx(root, projects) {
  return {
    deps: nodeJobDeps(),
    runGit: nodeRunGit(),
    workspaceRoot: root,
    projects,
    expectedUid: ME,
  };
}

function artifact(projectPath) {
  return path.join(projectPath, '.git', '.pw-credentials');
}

function byName(report, name) {
  const row = report.projects.find((r) => r.project === name);
  assert.ok(row, `no row for ${name} in ${JSON.stringify(report.projects.map((r) => r.project))}`);
  return row;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

test('inventory is scoped to the registry and reports metadata only', async () => {
  const root = tmpRoot();
  const withCred = repo(root, 'has-cred');
  const without = repo(root, 'no-cred');
  fs.writeFileSync(artifact(withCred), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });
  // A fully correct project: 0600, owner-owned, AND the matching helper pair.
  // Without the helper the row would legitimately read `needs-repair`.
  execFileSync('git', ['--git-dir', path.join(withCred, '.git'), 'config', '--local', '--add', 'credential.helper', '']);
  execFileSync('git', ['--git-dir', path.join(withCred, '.git'), 'config', '--local', '--add', 'credential.helper', `store --file=${artifact(withCred)}`]);
  // An UNREGISTERED repository, also carrying an artifact. A registry-scoped
  // inventory must not even look at it.
  const stranger = repo(root, 'not-registered');
  fs.writeFileSync(artifact(stranger), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });

  const report = await inventoryGitCredentials(ctx(root, [
    { name: 'has-cred', path: withCred },
    { name: 'no-cred', path: without },
  ]));

  assert.deepEqual(report.projects.map((r) => r.project).sort(), ['has-cred', 'no-cred']);
  assert.equal(byName(report, 'has-cred').status, 'ok');
  assert.equal(byName(report, 'has-cred').artifact.mode, 0o600);
  assert.equal(byName(report, 'has-cred').artifact.uid, ME);
  assert.equal(byName(report, 'no-cred').status, 'absent');

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(SENTINEL), false, 'the report must never carry a credential value');
  assert.equal(serialized.includes('x-oauth-basic'), false);
  assert.equal(serialized.includes('not-registered'), false, 'an unregistered repository must not be inspected at all');
});

test('inventory reports a linked worktree / .git-file truthfully instead of swallowing it', async () => {
  const root = tmpRoot();
  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');

  const report = await inventoryGitCredentials(ctx(root, [{ name: 'linked', path: linked }]));
  const row = byName(report, 'linked');
  assert.equal(row.status, 'linked-worktree');
  assert.match(row.detail, /not a directory|linked worktree|\.git file/i);
  assert.equal(row.eligible, false);
});

test('inventory reports a missing workspace rather than failing the whole run', async () => {
  const root = tmpRoot();
  const present = repo(root, 'present');
  const report = await inventoryGitCredentials(ctx(root, [
    { name: 'gone', path: path.join(root, 'gone') },
    { name: 'present', path: present },
  ]));
  assert.equal(byName(report, 'gone').status, 'no-repository');
  assert.equal(byName(report, 'present').status, 'absent');
});

test('inventory refuses a project registered outside the configured workspace boundary', async () => {
  const root = tmpRoot();
  const outside = repo(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-outside-'))), 'stray');
  const report = await inventoryGitCredentials(ctx(root, [{ name: 'stray', path: outside }]));
  const row = byName(report, 'stray');
  assert.equal(row.status, 'unsupported-workspace');
  assert.equal(row.eligible, false);
  assert.match(row.detail, /outside the configured workspace/i);
});

test('inventory classifies a symlinked artifact without following it', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  const bait = path.join(root, 'bait');
  fs.writeFileSync(bait, 'untouched\n');
  fs.symlinkSync(bait, artifact(p));
  const row = byName(await inventoryGitCredentials(ctx(root, [{ name: 'demo', path: p }])), 'demo');
  assert.equal(row.status, 'unsupported-artifact');
  assert.equal(row.artifact.type, 'symlink');
  assert.equal(row.eligible, false);
  assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched\n');
});

test('inventory classifies a directory at the artifact path as unsupported, never removing it', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.mkdirSync(artifact(p));
  fs.writeFileSync(path.join(artifact(p), 'evidence'), 'keep\n');
  const row = byName(await inventoryGitCredentials(ctx(root, [{ name: 'demo', path: p }])), 'demo');
  assert.equal(row.status, 'unsupported-artifact');
  assert.equal(row.artifact.type, 'directory');
  assert.equal(fs.existsSync(path.join(artifact(p), 'evidence')), true);
});

test('inventory flags an artifact whose mode is too loose as needing repair', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.writeFileSync(artifact(p), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });
  const row = byName(await inventoryGitCredentials(ctx(root, [{ name: 'demo', path: p }])), 'demo');
  assert.equal(row.status, 'needs-repair');
  assert.equal(row.eligible, true);
  assert.equal(row.artifact.mode, 0o644);
});

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

test('remediation is a dry run by default and changes nothing', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.writeFileSync(artifact(p), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });
  const before = fs.readFileSync(artifact(p), 'utf8');

  const report = await remediateGitCredentials(ctx(root, [{ name: 'demo', path: p }]));
  assert.equal(report.applied, false);
  assert.equal(byName(report, 'demo').action, 'would-repair');
  assert.equal(fs.lstatSync(artifact(p)).mode & 0o777, 0o644, 'a dry run must not change the mode');
  assert.equal(fs.readFileSync(artifact(p), 'utf8'), before);
});

test('remediation repairs a loose-mode artifact content-blind, without reading or rewriting it', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  const content = `https://${SENTINEL}:x-oauth-basic@github.com\n`;
  fs.writeFileSync(artifact(p), content, { mode: 0o644 });

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(report.applied, true);
  assert.equal(byName(report, 'demo').action, 'repaired');
  assert.equal(fs.lstatSync(artifact(p)).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(artifact(p)).uid, ME);
  assert.equal(fs.readFileSync(artifact(p), 'utf8'), content, 'the credential itself must be preserved byte-for-byte');
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
});

test('remediation registers the helper for an artifact that has one but no config entry', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.writeFileSync(artifact(p), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(byName(report, 'demo').action, 'repaired');
  const helpers = execFileSync('git', ['config', '--file', path.join(p, '.git', 'config'), '--get-all', 'credential.helper'], { encoding: 'utf8' })
    .split('\n').slice(0, -1);
  assert.deepEqual(helpers, ['', `store --file=${artifact(p)}`]);
});

test('remediation NEVER removes a directory planted at the artifact path', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.mkdirSync(artifact(p));
  fs.writeFileSync(path.join(artifact(p), 'evidence'), 'keep\n');

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(byName(report, 'demo').action, 'refused');
  assert.equal(fs.existsSync(path.join(artifact(p), 'evidence')), true, 'an attacker-created tree is evidence, never garbage');
});

test('remediation refuses a symlinked artifact and leaves its target untouched', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  const bait = path.join(root, 'bait');
  fs.writeFileSync(bait, 'untouched\n');
  fs.symlinkSync(bait, artifact(p));

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(byName(report, 'demo').action, 'refused');
  assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched\n');
});

test('remediation leaves a correct artifact alone and is idempotent', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  const content = `https://${SENTINEL}:x-oauth-basic@github.com\n`;
  fs.writeFileSync(artifact(p), content, { mode: 0o600 });
  execFileSync('git', ['--git-dir', path.join(p, '.git'), 'config', '--local', '--add', 'credential.helper', '']);
  execFileSync('git', ['--git-dir', path.join(p, '.git'), 'config', '--local', '--add', 'credential.helper', `store --file=${artifact(p)}`]);

  const first = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(byName(first, 'demo').action, 'none');
  const configAfter = fs.readFileSync(path.join(p, '.git', 'config'), 'utf8');

  const second = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), apply: true });
  assert.equal(byName(second, 'demo').action, 'none');
  assert.equal(fs.readFileSync(path.join(p, '.git', 'config'), 'utf8'), configAfter);
  assert.equal(fs.readFileSync(artifact(p), 'utf8'), content);
});

test('remediation never traverses outside the registry, even with a hostile registry entry', async () => {
  const root = tmpRoot();
  const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-outside-')));
  const stray = repo(outsideRoot, 'stray');
  fs.writeFileSync(artifact(stray), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'stray', path: stray }]), apply: true });
  assert.equal(byName(report, 'stray').action, 'refused');
  assert.equal(fs.lstatSync(artifact(stray)).mode & 0o777, 0o644, 'nothing outside the workspace root may be touched');
});

// ---------------------------------------------------------------------------
// Content-blindness, as an invariant rather than a promise
// ---------------------------------------------------------------------------

test('remediation never reads the bytes of an existing credential', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  const content = `https://${SENTINEL}:x-oauth-basic@github.com\n`;
  fs.writeFileSync(artifact(p), content, { mode: 0o644 });

  // Opening the artifact to fstat it is legitimate — that is how type, owner and
  // mode are verified. READING it is not: the historical root-owned artifact is
  // 0600 and unreadable to the workspace owner anyway, and a repair that depends
  // on reading a secret is the defect this guards against.
  const real = nodeJobDeps();
  let reads = 0;
  const deps = {
    ...real,
    async open(name, flags, mode) {
      const fh = await real.open(name, flags, mode);
      if (String(name).endsWith('.pw-credentials')) {
        fh.readFile = async () => { reads += 1; throw new Error('remediation read the credential'); };
        fh.read = async () => { reads += 1; throw new Error('remediation read the credential'); };
      }
      return fh;
    },
  };

  const report = await remediateGitCredentials({ ...ctx(root, [{ name: 'demo', path: p }]), deps, apply: true });
  assert.equal(byName(report, 'demo').action, 'repaired');
  assert.equal(reads, 0, 'the credential bytes must never be read during remediation');
  assert.equal(fs.lstatSync(artifact(p)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(artifact(p), 'utf8'), content, 'and the credential must survive untouched');
});

test('an artifact owned by someone else is handed back for authoritative resync, never converted in place', async () => {
  const root = tmpRoot();
  const p = repo(root, 'demo');
  fs.writeFileSync(artifact(p), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });

  // Declaring a different expected owner is how this runs unprivileged: the
  // artifact is not ours, exactly as a root-written one would not be.
  const foreign = { ...ctx(root, [{ name: 'demo', path: p }]), expectedUid: ME + 1 };
  const row = byName(await remediateGitCredentials({ ...foreign, apply: true }), 'demo');
  assert.equal(row.status, 'foreign-git', 'a repository we do not own is refused before anything else');
  assert.equal(row.action, 'refused');
  assert.equal(fs.lstatSync(artifact(p)).uid, ME, 'nothing may be converted in place');
});

// --- boot-time repair of a root-owned credential artifact --------------------
//
// A root-run git operation in a workspace (an operator in a `podman exec -u root`
// shell, a deploy slot from before deployExec dropped, a root clone) makes git's
// `store` helper rewrite `<project>/.git/.pw-credentials` as root. The file is
// 0600, so the pane account can no longer read it and EVERY git command in that
// project fails with "could not read Username" — the project silently loses all
// git access while the repo itself looks perfectly fine.
//
// scripts/pw-git-credential-audit.mjs is the deliberate operator repair. This
// pins the unattended half, and in particular the rule that keeps it safe.
test('boot repair: inventories first, and NEVER revokes on a failed lookup', () => {
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function repairGitCredentialOwnership(){');
  assert.notEqual(start, -1, 'the boot credential-ownership repair is gone');
  const body = src.slice(start, src.indexOf("\n// What a project's tmux session", start));

  // Inventory must be a DRY RUN: the planner refuses to convert a foreign-owned
  // artifact and reports resyncRequired, so apply:true here would repair nothing
  // while looking like it had.
  assert.match(body, /apply: false/, 'the inventory pass must not claim to apply');
  assert.match(body, /r\.resyncRequired/, 'the repair no longer selects the wrong-owner rows');

  // THE SAFETY RULE. syncProjectCredentials() treats an empty token as REVOKE, so
  // every path that cannot positively resolve a token must fall through to
  // `blocked` and leave the artifact alone. Turning "cannot read the token" into
  // "the token is gone" would be a worse outcome than the bug.
  for (const guard of ['no longer in the registry', 'no primaryUser', 'does not resolve to a user record', 'left untouched rather than revoked']) {
    assert.ok(body.includes(guard), `missing the guard that reports instead of revoking: ${guard}`);
  }
  const syncAt = body.indexOf('syncProjectCredentials(project)');
  assert.notEqual(syncAt, -1, 'the repair no longer rewrites from the authoritative state');
  assert.ok(body.indexOf('if(!token)') < syncAt, 'the empty-token guard must precede the rewrite');

  // Only ever root->owner, and only when a drop is actually configured.
  assert.match(body, /currentUid !== 0/, 'the repair must be a no-op unless this process is root');
  assert.match(body, /if\(!plan\.drop\)/, 'the repair must be a no-op when dashboard and panes share an account');
  assert.match(body, /if\(ISOLATED\)/, 'an isolated instance must never touch real projects');

  // Locks for the inventory only: syncProjectCredentials takes the same domain
  // itself, and this domain refuses a nested/out-of-order acquisition.
  assert.ok(body.indexOf("withLocks(['lifecycle','projects','credential']") < syncAt,
    'the inventory must hold the domain, and must have released it before the rewrite');
  assert.equal((body.match(/withLocks\(/g) || []).length, 1, 'the repair must not take the domain twice');
});

test('boot repair is wired in beside the other two boot repairs, and is never fatal', () => {
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  assert.match(src, /repairGitCredentialOwnership\(\)\n\s*\.then/, 'the boot repair is defined but never called');
  const call = src.slice(src.indexOf('repairGitCredentialOwnership()\n'));
  assert.match(call.slice(0, 700), /\.catch\(/, 'a failed credential repair must not stop the dashboard booting');
  // Ordered with the precedents it copies.
  assert.ok(src.indexOf('pruneUserCredentialTrees()') < src.indexOf('repairGitCredentialOwnership()'));
  assert.ok(src.indexOf('repairLegacyBoxOwnership()') < src.indexOf('repairGitCredentialOwnership()'));
});
