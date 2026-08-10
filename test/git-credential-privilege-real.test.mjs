// A31-6 / Round 8 — REAL privilege evidence: the process doing the work and the
// account that must end up owning the artifact are genuinely different.
//
// The finding this answers: an ownership assertion of the form
// `st.uid === process.getuid()` passes identically whether the boundary works or
// is completely broken — run as root it simply confirms root-wrote-it-as-root.
// An assertion that cannot fail is not evidence.
//
// So every check here compares against a workspace owner resolved INDEPENDENTLY
// from passwd, and the test only counts when the running uid and that owner's uid
// actually differ. Where that cannot be arranged (ordinary CI: no root, no
// non-interactive sudo) each case reports **not run** — never a pass.
//
// Nothing outside a throwaway temp directory is touched: no live workspace, no
// service, no real credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const SENTINEL = 'ghp_SYNTHETIC_PRIVILEGE_SENTINEL';
const ME = process.getuid();
const MY_NAME = os.userInfo().username;

async function canSudoNonInteractively() {
  try {
    await execFileAsync('sudo', ['-n', 'true'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Root is what makes the uids differ: the work runs as root, and the artifact
// must still come out owned by the unprivileged workspace account.
async function rootCapability() {
  if (ME === 0) return { ok: true, how: 'already root' };
  if (await canSudoNonInteractively()) return { ok: true, how: 'sudo -n' };
  return { ok: false, why: 'requires root, or non-interactive sudo to become root' };
}

function makeTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-priv-')));
  const projectPath = path.join(root, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  return { root, projectPath, gitDir: path.join(projectPath, '.git') };
}

// A driver that runs INSIDE the privileged process and does exactly what the
// dashboard does: resolve the owner from passwd, plan the drop, and hand the job
// to the privilege-dropped helper.
function driverSource(tree, { apply = false, audit = false } = {}) {
  return `
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { makePasswdLookup, resolveTerminalOwner } from '${APP_DIR}terminal-owner.js';
import { credentialDropArgv, credentialExecutionPlan, spawnCredentialJob } from '${APP_DIR}user-credentials.js';

const execFileAsync = promisify(execFile);
const owner = await resolveTerminalOwner(process.env, makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile }));
const currentUid = process.getuid();
const plan = credentialExecutionPlan({ owner, currentUid });
const expectedUid = Number(owner.uid);
const job = ${audit}
  ? { action: 'git-credential-audit', workspaceRoot: ${JSON.stringify(tree.root)}, projects: [{ name: 'demo', path: ${JSON.stringify(tree.projectPath)} }], expectedUid, apply: ${apply} }
  : { action: 'git-credential', workspaceRoot: ${JSON.stringify(tree.root)}, projectPath: ${JSON.stringify(tree.projectPath)}, registeredPaths: [${JSON.stringify(tree.projectPath)}], token: ${JSON.stringify(SENTINEL)}, expectedUid };
const argv = plan.drop
  ? credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath: '${APP_DIR}credential-writer.mjs' })
  : [process.execPath, '${APP_DIR}credential-writer.mjs'];
const result = await spawnCredentialJob({ spawn, argv, job, timeoutMs: 60000 });
process.stdout.write(JSON.stringify({ currentUid, expectedUid, ownerUser: owner.user, drop: plan.drop, argv0: argv[0], result }));
`;
}

function runPrivileged(tree, driver, extraEnv = {}) {
  const file = path.join(tree.root, 'driver.mjs');
  fs.writeFileSync(file, driver);
  const env = ['PW_HOST_TERMINAL_USER=' + MY_NAME, 'PW_DEPLOY_MODE=host', 'HOME=' + (process.env.HOME || '/root'),
    'PATH=' + process.env.PATH, ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`)];
  const argv = ME === 0
    ? ['env', ...env, process.execPath, file]
    : ['sudo', '-n', 'env', ...env, process.execPath, file];
  const out = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(out);
}

function cleanup(tree) {
  try {
    if (ME === 0) fs.rmSync(tree.root, { recursive: true, force: true });
    else execFileSync('sudo', ['-n', 'rm', '-rf', tree.root], { timeout: 30000 });
  } catch { /* a leftover temp dir is not worth failing a test over */ }
}

test('REAL: a privileged process produces an artifact owned by the UNPRIVILEGED workspace owner', { timeout: 180000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) {
    t.skip(`not run: ${cap.why} — PVI2 owns this evidence; this is reported as NOT RUN, never as a pass`);
    return;
  }
  if (ME === 0) {
    t.skip('not run: this runner is already root, so no distinct unprivileged workspace owner can be resolved from it');
    return;
  }

  const tree = makeTree();
  try {
    const out = runPrivileged(tree, driverSource(tree));

    // The whole point: the process doing the work is NOT the account that must
    // own the result. If these were equal the assertions below could not fail.
    assert.equal(out.currentUid, 0, 'the driver must genuinely run as root');
    assert.notEqual(out.currentUid, out.expectedUid, 'actual and expected uid must differ, or this proves nothing');
    assert.equal(out.expectedUid, ME, 'the expected owner is resolved from passwd, not from the running process');
    assert.equal(out.drop, true, 'root must drop privileges to do repository work');
    assert.match(out.argv0, /sudo|setpriv/, 'the drop must go through the vetted abstraction');

    const artifact = path.join(tree.gitDir, '.pw-credentials');
    const st = fs.lstatSync(artifact);
    assert.equal(st.uid, out.expectedUid, 'the artifact must be owned by the resolved workspace owner, not by root');
    assert.notEqual(st.uid, 0, 'a root-owned artifact is exactly the defect this boundary removes');
    assert.equal(st.mode & 0o777, 0o600);

    const helpers = execFileSync('git', ['config', '--file', path.join(tree.gitDir, 'config'), '--get-all', 'credential.helper'], { encoding: 'utf8' })
      .split('\n').slice(0, -1);
    assert.deepEqual(helpers, ['', `store --file=${artifact}`]);
    assert.equal(fs.lstatSync(path.join(tree.gitDir, 'config')).uid, out.expectedUid, 'git config must not become root-owned either');
    assert.equal(JSON.stringify(out.result).includes(SENTINEL), false, 'no credential value may cross the helper boundary');
  } finally {
    cleanup(tree);
  }
});

// ---------------------------------------------------------------------------
// A31-5, against the REAL historical shape
// ---------------------------------------------------------------------------
//
// What base `app/server.js` actually left behind is a ROOT-OWNED, mode 0600
// credential inside an owner-controlled `.git`, with the local
// `store --file=...` helper active. That shape is hostile to conversion:
//
//   read(2)   EACCES  — the workspace owner cannot read it
//   link(2)   EPERM   — protected_hardlinks forbids even snapshotting it
//   unlink(2) ok      — but only because the owner owns the DIRECTORY
//
// So remediation may not copy, compare, or even open the old bytes. It has to
// reach a usable safe state from the AUTHORITATIVE current credential instead —
// which is what the bounded operator command below is driven to prove.

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

const OLD_ROOT_SENTINEL = 'ghp_SYNTHETIC_OLD_ROOT_OWNED_VALUE';
const CURRENT_SENTINEL = 'ghp_SYNTHETIC_CURRENT_AUTHORITATIVE';

// A registry-listed, owner-controlled workspace carrying the exact base shape.
function makeManagedTree({ withCurrentToken }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-a315-')));
  const workspaces = path.join(dir, 'workspaces');
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(workspaces, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  const projectPath = path.join(workspaces, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  const gitDir = path.join(projectPath, '.git');
  const artifact = path.join(gitDir, '.pw-credentials');

  const secretKey = crypto.randomBytes(32).toString('hex');
  const secretKeyPath = path.join(dir, '.secret-key');
  fs.writeFileSync(secretKeyPath, `${secretKey}\n`);

  fs.writeFileSync(path.join(registryDir, 'projects.json'),
    JSON.stringify([{ name: 'demo', path: projectPath, port: 7300, primaryUser: 'alice' }]));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({
    users: [{
      id: 'u-a', username: 'alice', role: 'developer', projects: '*',
      ...(withCurrentToken ? { ghToken: encryptToken(secretKey, CURRENT_SENTINEL) } : {}),
    }],
  }));

  // THE EXACT BASE SHAPE: root-owned, 0600, with the helper actively pointing at it.
  execFileSync('sudo', ['-n', 'sh', '-c',
    `printf '%s\\n' 'https://${OLD_ROOT_SENTINEL}:x-oauth-basic@github.com' > ${JSON.stringify(artifact)}` +
    ` && chown 0:0 ${JSON.stringify(artifact)} && chmod 600 ${JSON.stringify(artifact)}`], { timeout: 30000 });
  execFileSync('git', ['--git-dir', gitDir, 'config', '--local', '--add', 'credential.helper', '']);
  execFileSync('git', ['--git-dir', gitDir, 'config', '--local', '--add', 'credential.helper', `store --file=${artifact}`]);

  return { dir, workspaces, registryDir, projectPath, gitDir, artifact, secretKeyPath };
}

// Run the ACTUAL bounded operator command, as root — not a helper seam.
function runAudit(t, args) {
  const env = [
    `PW_REGISTRY_PATH=${path.join(t.registryDir, 'projects.json')}`,
    `PW_WORKSPACES=${t.workspaces}`,
    `PW_USERS_PATH=${path.join(t.dir, 'users.json')}`,
    `PW_SECRET_KEY_PATH=${t.secretKeyPath}`,
    `PW_PROJECTS_LOCK_PATH=${path.join(t.registryDir, '.pw-projects.lock')}`,
    `PW_LIFECYCLE_LOCK_PATH=${path.join(t.dir, '.pw-lifecycle.lock')}`,
    `PW_CREDENTIAL_LOCK_PATH=${path.join(t.registryDir, '.pw-credential.lock')}`,
    `PW_HOST_TERMINAL_USER=${MY_NAME}`,
    'PW_DEPLOY_MODE=host',
    `HOME=${process.env.HOME || '/root'}`,
    `PATH=${process.env.PATH}`,
  ];
  const cli = fileURLToPath(new URL('../scripts/pw-git-credential-audit.mjs', import.meta.url));
  return execFileSync('sudo', ['-n', 'env', ...env, process.execPath, cli, ...args], { encoding: 'utf8', timeout: 180000 });
}

function helpersOf(gitDir) {
  try {
    return execFileSync('git', ['config', '--file', path.join(gitDir, 'config'), '--get-all', 'credential.helper'], { encoding: 'utf8' })
      .split('\n').slice(0, -1);
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

test('REAL A31-5: the operator command converts a root-owned 0600 artifact to the CURRENT owner-owned credential', { timeout: 240000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2 owns this evidence; reported as NOT RUN, never as a pass`); return; }
  if (ME === 0) { t.skip('not run: already root, so no distinct unprivileged workspace owner can be resolved'); return; }

  const tree = makeManagedTree({ withCurrentToken: true });
  try {
    assert.equal(fs.lstatSync(tree.artifact).uid, 0, 'the base shape must be reproduced');
    assert.equal(fs.lstatSync(tree.artifact).mode & 0o777, 0o600, 'the base shape is 0600, not 0644');
    assert.deepEqual(helpersOf(tree.gitDir), ['', `store --file=${tree.artifact}`], 'the helper must be active');

    const out = runAudit(tree, ['--apply']);

    const st = fs.lstatSync(tree.artifact);
    assert.notEqual(st.uid, 0, 'the root-owned artifact must not survive remediation');
    assert.equal(st.uid, ME, 'the artifact must end up owned by the resolved workspace owner');
    assert.equal(st.mode & 0o777, 0o600);

    const body = fs.readFileSync(tree.artifact, 'utf8');
    assert.match(body, new RegExp(`https://${CURRENT_SENTINEL}:x-oauth-basic@github\\.com`),
      'the pair must be rebuilt from the AUTHORITATIVE current credential');
    assert.equal(body.includes(OLD_ROOT_SENTINEL), false, 'the old root-owned value must not be carried forward');
    assert.deepEqual(helpersOf(tree.gitDir), ['', `store --file=${tree.artifact}`], 'the helper must remain usable');

    assert.equal(out.includes(OLD_ROOT_SENTINEL), false, 'no old secret byte may be printed');
    assert.equal(out.includes(CURRENT_SENTINEL), false, 'no current secret may be printed');
    assert.equal(fs.readdirSync(tree.gitDir).some((n) => /\.(staged|rollback|restore)-/.test(n)), false, 'no leftovers');
  } finally { cleanup(tree); }
});

test('REAL A31-5: with no authoritative credential, the operator command reaches a safe revoked state', { timeout: 240000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2 owns this evidence; reported as NOT RUN, never as a pass`); return; }
  if (ME === 0) { t.skip('not run: already root, so no distinct unprivileged workspace owner can be resolved'); return; }

  const tree = makeManagedTree({ withCurrentToken: false });
  try {
    const out = runAudit(tree, ['--apply']);
    assert.equal(fs.existsSync(tree.artifact), false, 'the unusable root-owned credential must be gone');
    assert.deepEqual(helpersOf(tree.gitDir), [], 'git must not be left pointing at a credential it cannot have');
    assert.equal(out.includes(OLD_ROOT_SENTINEL), false);
  } finally { cleanup(tree); }
});

test('REAL A31-5: a dry run reports the root-owned artifact and changes nothing', { timeout: 240000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2 owns this evidence; reported as NOT RUN, never as a pass`); return; }
  if (ME === 0) { t.skip('not run: already root, so no distinct unprivileged workspace owner can be resolved'); return; }

  const tree = makeManagedTree({ withCurrentToken: true });
  try {
    const out = runAudit(tree, []);
    assert.match(out, /dry run \(nothing changed\)/);
    assert.match(out, /demo\s+needs-repair/);
    assert.equal(fs.lstatSync(tree.artifact).uid, 0, 'a dry run must not convert anything');
    assert.equal(out.includes(OLD_ROOT_SENTINEL), false);
  } finally { cleanup(tree); }
});
