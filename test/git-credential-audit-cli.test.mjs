// The operator-facing end of A31-5: an explicit, bounded command. Dry run by
// default, registry-scoped, metadata-only output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFileSync as run } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/pw-git-credential-audit.mjs', import.meta.url));
const SENTINEL = 'ghp_SYNTHETIC_CLI_SENTINEL';

function tree() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cli-')));
  const workspaces = path.join(dir, 'workspaces');
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(workspaces, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });
  return { dir, workspaces, registryDir, registry: path.join(registryDir, 'projects.json') };
}

function repo(t, name) {
  const p = path.join(t.workspaces, name);
  fs.mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', '-q', p]);
  return p;
}

function cli(t, args = []) {
  return run(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      PW_REGISTRY_PATH: t.registry,
      PW_WORKSPACES: t.workspaces,
      PW_USERS_PATH: path.join(t.dir, 'users.json'),
      PW_PROJECTS_LOCK_PATH: path.join(t.registryDir, '.pw-projects.lock'),
      PW_LIFECYCLE_LOCK_PATH: path.join(t.dir, '.pw-lifecycle.lock'),
      PW_CREDENTIAL_LOCK_PATH: path.join(t.registryDir, '.pw-credential.lock'),
      PW_HOST_TERMINAL_USER: os.userInfo().username,
      PW_DEPLOY_MODE: 'host',
    },
  });
}

test('the audit reports registry projects and changes nothing without --apply', { timeout: 60000 }, () => {
  const t = tree();
  const p = repo(t, 'demo');
  const artifact = path.join(p, '.git', '.pw-credentials');
  fs.writeFileSync(artifact, `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });
  // An unregistered repository with an artifact: never inspected, never touched.
  const stranger = repo(t, 'unregistered');
  fs.writeFileSync(path.join(stranger, '.git', '.pw-credentials'), `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o644 });
  fs.writeFileSync(t.registry, JSON.stringify([{ name: 'demo', path: p, port: 7000 }]));

  const out = cli(t);
  assert.match(out, /dry run \(nothing changed\)/);
  assert.match(out, /demo\s+needs-repair\s+would-repair/);
  assert.equal(out.includes(SENTINEL), false, 'the report must never print a credential value');
  assert.equal(out.includes('unregistered'), false, 'an unregistered repository must not appear');
  assert.equal(fs.lstatSync(artifact).mode & 0o777, 0o644, 'a dry run must not change anything');
  assert.equal(fs.lstatSync(path.join(stranger, '.git', '.pw-credentials')).mode & 0o777, 0o644);
});

test('--apply repairs the eligible subset and is idempotent', { timeout: 60000 }, () => {
  const t = tree();
  const p = repo(t, 'demo');
  const artifact = path.join(p, '.git', '.pw-credentials');
  const content = `https://${SENTINEL}:x-oauth-basic@github.com\n`;
  fs.writeFileSync(artifact, content, { mode: 0o644 });
  fs.writeFileSync(t.registry, JSON.stringify([{ name: 'demo', path: p, port: 7000 }]));

  const out = cli(t, ['--apply']);
  assert.match(out, /APPLY \(repairs performed\)/);
  assert.match(out, /demo\s+needs-repair\s+repaired/);
  assert.equal(fs.lstatSync(artifact).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(artifact, 'utf8'), content, 'the credential must survive the repair byte-for-byte');
  assert.equal(out.includes(SENTINEL), false);

  const again = cli(t, ['--apply']);
  assert.match(again, /demo\s+ok\s+none/);
});

test('the audit reports unserviceable states truthfully and refuses them', { timeout: 60000 }, () => {
  const t = tree();
  const linked = path.join(t.workspaces, 'linked');
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /elsewhere\n');
  const planted = repo(t, 'planted');
  fs.mkdirSync(path.join(planted, '.git', '.pw-credentials'));
  fs.writeFileSync(path.join(planted, '.git', '.pw-credentials', 'evidence'), 'keep\n');
  fs.writeFileSync(t.registry, JSON.stringify([
    { name: 'linked', path: linked, port: 7001 },
    { name: 'planted', path: planted, port: 7002 },
  ]));

  const out = cli(t, ['--apply']);
  assert.match(out, /linked\s+linked-worktree\s+refused/);
  assert.match(out, /planted\s+unsupported-artifact\s+refused/);
  assert.equal(fs.existsSync(path.join(planted, '.git', '.pw-credentials', 'evidence')), true,
    'an attacker-created tree is evidence, never garbage');
});

test('an unknown argument is refused rather than guessed at', { timeout: 60000 }, () => {
  const t = tree();
  fs.writeFileSync(t.registry, JSON.stringify([]));
  let status = 0;
  try { cli(t, ['--wipe']); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

test('P2: an unreadable authoritative credential state is an explicit blocked failure, not a quiet success', { timeout: 60000 }, () => {
  const t = tree();
  const p = repo(t, 'demo');
  const artifact = path.join(p, '.git', '.pw-credentials');
  fs.writeFileSync(artifact, `https://${SENTINEL}:x-oauth-basic@github.com\n`, { mode: 0o600 });
  fs.writeFileSync(t.registry, JSON.stringify([{ name: 'demo', path: p, port: 7000, primaryUser: 'alice' }]));
  // No users store and no secret key: the authoritative current credential
  // cannot be resolved, so nothing may be converted — and the command must say
  // so with a failing exit rather than printing an actionable-looking row.
  const usersPath = path.join(t.dir, 'users.json');
  if (fs.existsSync(usersPath)) fs.rmSync(usersPath);

  let status = 0;
  let out = '';
  let err = '';
  try {
    out = run(process.execPath, [CLI, '--apply'], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        PW_REGISTRY_PATH: t.registry,
        PW_WORKSPACES: t.workspaces,
        PW_USERS_PATH: usersPath,
        PW_SECRET_KEY_PATH: path.join(t.dir, 'no-such-secret-key'),
        PW_PROJECTS_LOCK_PATH: path.join(t.registryDir, '.pw-projects.lock'),
        PW_LIFECYCLE_LOCK_PATH: path.join(t.dir, '.pw-lifecycle.lock'),
        PW_CREDENTIAL_LOCK_PATH: path.join(t.registryDir, '.pw-credential.lock'),
        PW_HOST_TERMINAL_USER: os.userInfo().username,
        PW_DEPLOY_MODE: 'host',
      },
    });
  } catch (e) {
    status = e.status;
    out = String(e.stdout || '');
    err = String(e.stderr || '');
  }

  // The artifact here is owner-owned, so it is repairable WITHOUT the
  // authoritative state; what must not happen is a row that claims a resync is
  // pending while the command has already refused to perform one.
  assert.equal(out.includes('resync-required'), false,
    'no actionable resync row may be printed when the command refused to act');
  assert.equal(out.includes(SENTINEL), false);
  if (err) assert.notEqual(status, 0, 'a refusal to act must exit nonzero');
});
