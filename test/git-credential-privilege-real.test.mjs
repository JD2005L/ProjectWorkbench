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

test('REAL: remediation replaces a root-owned artifact with an owner-owned 0600 one', { timeout: 180000 }, async (t) => {
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
    const artifact = path.join(tree.gitDir, '.pw-credentials');
    // Reproduce the historical defect exactly: a ROOT-owned credential file,
    // written through a pathname, sitting in a workspace-owned repository.
    execFileSync('sudo', ['-n', 'sh', '-c',
      `printf '%s\\n' 'https://${SENTINEL}:x-oauth-basic@github.com' > ${JSON.stringify(artifact)} && chown 0:0 ${JSON.stringify(artifact)} && chmod 644 ${JSON.stringify(artifact)}`],
    { timeout: 30000 });
    assert.equal(fs.lstatSync(artifact).uid, 0, 'the defect must be reproduced before it can be repaired');

    const out = runPrivileged(tree, driverSource(tree, { audit: true, apply: true }));
    assert.notEqual(out.currentUid, out.expectedUid);
    const row = out.result.projects[0];
    assert.equal(row.action, 'repaired', JSON.stringify(row));

    const st = fs.lstatSync(artifact);
    assert.equal(st.uid, out.expectedUid, 'the repaired artifact must belong to the workspace owner');
    assert.notEqual(st.uid, 0);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(artifact, 'utf8'),
      `https://${SENTINEL}:x-oauth-basic@github.com\n`,
      'remediation must preserve the credential byte-for-byte',
    );
    assert.equal(JSON.stringify(out.result).includes(SENTINEL), false, 'the remediation report must carry metadata only');
  } finally {
    cleanup(tree);
  }
});
