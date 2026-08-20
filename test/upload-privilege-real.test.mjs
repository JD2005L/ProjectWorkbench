// REAL privilege evidence for the upload boundary: the process driving the
// upload and the account that must end up owning the file are genuinely
// different, and the symlink is a real one on a real filesystem.
//
// Why this file exists alongside test/upload-symlink-boundary.test.mjs: run as
// an ordinary user, every ownership assertion about an upload passes whether the
// boundary works or is entirely absent — it just confirms me-wrote-it-as-me. The
// defect being repaired is specifically what ROOT does with an admin-controlled
// symlink, so the evidence has to be produced by a root controller handing work
// to a non-root worker. Where that cannot be arranged (ordinary CI: no root, no
// non-interactive sudo) each case reports **not run** — never a pass.
//
// The superseded shape is DEMONSTRATED here rather than described, on the same
// kind of tree, so the assertions below are shown to be capable of failing.
//
// Nothing outside a throwaway temp directory is touched: no live workspace, no
// registry, no service, no session.
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
const ME = process.getuid();
const MY_NAME = os.userInfo().username;

async function canSudoNonInteractively() {
  try { await execFileAsync('sudo', ['-n', 'true'], { timeout: 5000 }); return true; } catch { return false; }
}

// Root is what makes the uids differ: the controller runs as root, and the
// upload must still come out owned by the unprivileged workspace account.
async function rootCapability() {
  if (ME === 0) return { ok: true, how: 'already root' };
  if (await canSudoNonInteractively()) return { ok: true, how: 'sudo -n' };
  return { ok: false, why: 'requires root, or non-interactive sudo to become root' };
}

/** A workspace the pane account owns, plus the root-owned directory an attacker would aim `_inbox` at. */
function makeTree({ symlinkInbox = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upriv-')));
  const projectPath = path.join(root, 'demo');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'ORIGINAL\n');
  // The victim is root's, which is exactly what makes a root chown through the
  // link a privilege boundary crossing rather than a rearrangement of my own files.
  execFileSync('sudo', ['-n', 'chown', '-R', '0:0', victim], { timeout: 30000 });
  const inbox = path.join(projectPath, '_inbox');
  if (symlinkInbox) fs.symlinkSync(victim, inbox);
  return { root, projectPath, victim, inbox };
}

function cleanup(tree) {
  try {
    if (ME === 0) fs.rmSync(tree.root, { recursive: true, force: true });
    else execFileSync('sudo', ['-n', 'rm', '-rf', tree.root], { timeout: 30000 });
  } catch { /* a leftover temp dir is not worth failing a test over */ }
}

/**
 * A controller that runs INSIDE the privileged process and does exactly what the
 * dashboard's upload routes do: resolve the terminal owner from passwd, plan the
 * drop, and stream the payload to the privilege-dropped worker.
 */
function controllerSource(tree, name) {
  return `
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { makePasswdLookup, resolveTerminalOwner } from '${APP_DIR}terminal-owner.js';
import { credentialExecutionPlan } from '${APP_DIR}user-credentials.js';
import { inboxWriteArgv, runInboxWrite } from '${APP_DIR}workspace-file.js';

const execFileAsync = promisify(execFile);
const owner = await resolveTerminalOwner(process.env, makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile }));
const currentUid = process.getuid();
const plan = credentialExecutionPlan({ owner, currentUid });
const argv = inboxWriteArgv({ plan, execPath: process.execPath, helperPath: '${APP_DIR}workspace-writer.mjs' });
const report = { currentUid, expectedUid: Number(owner.uid), ownerUser: owner.user, drop: plan.drop, argv0: argv[0], argv };
try {
  report.result = await runInboxWrite({
    spawn, argv,
    job: { action: 'inbox-write', projectPath: ${JSON.stringify(tree.projectPath)}, name: ${JSON.stringify(name)} },
    source: Readable.from([Buffer.from('REAL PAYLOAD')]),
    timeoutMs: 60000,
  });
} catch (e) {
  report.error = e && e.message ? e.message : String(e);
}
process.stdout.write(JSON.stringify(report));
`;
}

function runPrivileged(tree, source) {
  const file = path.join(tree.root, 'controller.mjs');
  fs.writeFileSync(file, source);
  const env = [`PW_HOST_TERMINAL_USER=${MY_NAME}`, 'PW_DEPLOY_MODE=host',
    `HOME=${process.env.HOME || '/root'}`, `PATH=${process.env.PATH}`];
  const argv = ME === 0 ? ['env', ...env, process.execPath, file] : ['sudo', '-n', 'env', ...env, process.execPath, file];
  return JSON.parse(execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000 }));
}

test('REAL: a root controller produces an inbox file owned by the UNPRIVILEGED terminal owner', { timeout: 180000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2/CT2115 owns this evidence; reported as NOT RUN, never as a pass`); return; }
  if (ME === 0) { t.skip('not run: this runner is already root, so no distinct unprivileged terminal owner can be resolved from it'); return; }

  const tree = makeTree();
  try {
    const out = runPrivileged(tree, controllerSource(tree, 'real.txt'));
    assert.equal(out.error, undefined, `the ordinary upload must succeed: ${out.error}`);

    // The whole point: the process doing the work is NOT the account that must
    // own the result. If these were equal the assertions below could not fail.
    assert.equal(out.currentUid, 0, 'the controller must genuinely run as root');
    assert.notEqual(out.currentUid, out.expectedUid, 'actual and expected uid must differ, or this proves nothing');
    assert.equal(out.expectedUid, ME, 'the expected owner is resolved from passwd, not from the running process');
    assert.equal(out.drop, true, 'root must drop privileges to write into a workspace');
    assert.match(out.argv0, /sudo|setpriv/, 'the drop must go through the vetted fixed-argv abstraction');
    assert.ok(!out.argv.some((a) => /^(sh|bash|-c)$/.test(a)), `no shell may appear in ${JSON.stringify(out.argv)}`);

    const full = path.join(tree.inbox, 'real.txt');
    assert.equal(out.result.path, full);
    assert.equal(fs.readFileSync(full, 'utf8'), 'REAL PAYLOAD');
    for (const p of [tree.inbox, full]) {
      const st = fs.lstatSync(p);
      assert.equal(st.uid, out.expectedUid, `${p} must be owned by the resolved terminal owner, not by root`);
      assert.notEqual(st.uid, 0, 'a root-owned upload artifact is exactly the defect this boundary removes');
    }
    assert.equal(fs.lstatSync(full).mode & 0o777, 0o644);
    // Owner-writable in practice, not just by mode bits: the agent has to be
    // able to rewrite and delete what was dropped into its own inbox.
    fs.writeFileSync(full, 'rewritten by the owner');
    fs.unlinkSync(full);
  } finally { cleanup(tree); }
});

test('REAL ADVERSARIAL: root refuses a symlinked _inbox — no ownership or content outside the terminal owner changes', { timeout: 180000 }, async (t) => {
  const cap = await rootCapability();
  if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2/CT2115 owns this evidence; reported as NOT RUN, never as a pass`); return; }
  if (ME === 0) { t.skip('not run: already root, so no distinct unprivileged terminal owner can be resolved'); return; }

  // First, the superseded shape, on its own tree, so the assertions that follow
  // are shown to be capable of failing rather than merely asserted to be.
  const legacy = makeTree({ symlinkInbox: true });
  try {
    assert.equal(fs.lstatSync(legacy.victim).uid, 0, 'sanity: the victim starts out root-owned');
    const target = path.join(legacy.victim, 'keep.txt');
    // Exactly what app/server.js did: a root mkdir/write through the link, then
    // `chown <owner> <_inbox> <file>` with no -h and no -P.
    execFileSync('sudo', ['-n', process.execPath, '-e',
      `const fs=require('fs');fs.mkdirSync(${JSON.stringify(legacy.inbox)},{recursive:true});`
      + `fs.writeFileSync(${JSON.stringify(path.join(legacy.inbox, 'legacy.txt'))},'root payload');`], { timeout: 30000 });
    execFileSync('sudo', ['-n', 'chown', `${ME}:${os.userInfo().gid}`, legacy.inbox, path.join(legacy.inbox, 'legacy.txt')], { timeout: 30000 });

    assert.equal(fs.lstatSync(legacy.victim).uid, ME,
      'sanity: the superseded form really does convert the root-owned directory the link chose');
    assert.equal(fs.existsSync(path.join(legacy.victim, 'legacy.txt')), true,
      'sanity: and really does write root content into it');
    assert.equal(fs.lstatSync(legacy.inbox).isSymbolicLink(), true, 'sanity: while the link itself is untouched');
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL\n');
  } finally { cleanup(legacy); }

  // Now the shipped path, on an identical tree.
  const tree = makeTree({ symlinkInbox: true });
  try {
    const before = fs.lstatSync(tree.victim);
    const out = runPrivileged(tree, controllerSource(tree, 'evil.txt'));

    assert.ok(out.error, 'a symlinked _inbox must be refused, not written through');
    assert.match(out.error, /symlink/i, `the refusal must name what it refused: ${out.error}`);

    const after = fs.lstatSync(tree.victim);
    assert.equal(after.uid, 0, 'the root-owned directory the link chose must STILL be root-owned');
    assert.equal(after.gid, before.gid, 'and its group must not have moved either');
    assert.deepEqual(fs.readdirSync(tree.victim), ['keep.txt'], 'nothing may have been created inside it');
    const keep = path.join(tree.victim, 'keep.txt');
    assert.equal(fs.lstatSync(keep).uid, 0, 'and the file inside it must still belong to root');
    assert.equal(fs.readFileSync(keep, 'utf8'), 'ORIGINAL\n');
    assert.equal(fs.lstatSync(tree.inbox).isSymbolicLink(), true, 'the link itself is left exactly as found');
  } finally { cleanup(tree); }
});
