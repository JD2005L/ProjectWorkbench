// REAL privilege evidence for the read/list/delete half of the box boundary.
//
// test/box-boundary.test.mjs proves the routes disclose and delete nothing
// through a substituted box, but it runs at the runner's own uid, where every
// victim artifact belongs to the runner anyway. The defect being repaired is
// specifically what ROOT could reach: a directory root can read and the pane
// account cannot, and a file only root can delete. So the victim here is
// genuinely root-owned and mode 0700/0600, the controller genuinely runs as
// root, and the worker genuinely runs as somebody else.
//
// The superseded shape is DEMONSTRATED first, on an identical tree, so every
// assertion below is shown to be capable of failing rather than merely asserted
// to be. Where root cannot be arranged (ordinary CI: no root, no non-interactive
// sudo) each case reports **not run** — never a pass.
//
// Nothing outside a throwaway temp directory is touched.
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

const SECRET = 'ROOT-ONLY-CONTENT-4c17\n';
const SECRET_NAME = 'root-secret.txt';

async function canSudoNonInteractively() {
  try { await execFileAsync('sudo', ['-n', 'true'], { timeout: 5000 }); return true; } catch { return false; }
}

async function rootCapability() {
  if (ME === 0) return { ok: true, how: 'already root' };
  if (await canSudoNonInteractively()) return { ok: true, how: 'sudo -n' };
  return { ok: false, why: 'requires root, or non-interactive sudo to become root' };
}

/**
 * A workspace the pane account owns, with `<box>` substituted for a symlink to a
 * directory only ROOT can read or write. That asymmetry is the whole point: an
 * unprivileged worker physically cannot produce the disclosure or the delete, so
 * the assertions can only pass because the work stopped being root's.
 */
function makeTree(box) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-boxpriv-')));
  const projectPath = path.join(root, 'demo');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(path.join(victim, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(victim, SECRET_NAME), SECRET);
  fs.writeFileSync(path.join(victim, 'deep', 'inner.txt'), 'INNER\n');
  execFileSync('sudo', ['-n', 'chown', '-R', '0:0', victim], { timeout: 30000 });
  execFileSync('sudo', ['-n', 'chmod', '-R', 'go-rwx', victim], { timeout: 30000 });
  const boxPath = path.join(projectPath, box);
  fs.symlinkSync(victim, boxPath);
  return { root, projectPath, victim, box, boxPath };
}

function cleanup(tree) {
  try {
    if (ME === 0) fs.rmSync(tree.root, { recursive: true, force: true });
    else execFileSync('sudo', ['-n', 'rm', '-rf', tree.root], { timeout: 30000 });
  } catch { /* a leftover temp dir is not worth failing a test over */ }
}

/**
 * A controller that runs INSIDE the privileged process and does exactly what the
 * dashboard's box routes do: resolve the terminal owner from passwd, plan the
 * drop, and run each job in the dropped worker.
 */
function controllerSource(tree) {
  return `
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { makePasswdLookup, resolveTerminalOwner } from '${APP_DIR}terminal-owner.js';
import { credentialExecutionPlan } from '${APP_DIR}user-credentials.js';
import { workspaceJobArgv, runWorkspaceJob, runWorkspaceRead } from '${APP_DIR}workspace-file.js';

const execFileAsync = promisify(execFile);
const owner = await resolveTerminalOwner(process.env, makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile }));
const currentUid = process.getuid();
const plan = credentialExecutionPlan({ owner, currentUid });
const argv = workspaceJobArgv({ plan, execPath: process.execPath, helperPath: '${APP_DIR}workspace-writer.mjs' });
const box = ${JSON.stringify(tree.box)};
const projectPath = ${JSON.stringify(tree.projectPath)};
const report = { currentUid, expectedUid: Number(owner.uid), drop: plan.drop, argv0: argv[0], argv, jobs: {} };

async function attempt(label, run) {
  try { report.jobs[label] = { ok: true, result: await run() }; }
  catch (e) { report.jobs[label] = { ok: false, error: e && e.message ? e.message : String(e) }; }
}

await attempt('list', () => runWorkspaceJob({ spawn, argv, job: { action: 'box-list', projectPath, box }, timeoutMs: 60000 }));
await attempt('read', async () => {
  const out = await runWorkspaceRead({ spawn, argv, job: { action: 'box-read', projectPath, box, name: ${JSON.stringify(SECRET_NAME)} }, timeoutMs: 60000 });
  const chunks = [];
  for await (const c of out.stream) chunks.push(c);
  return { bytes: out.result.bytes, body: Buffer.concat(chunks).toString('utf8') };
});
await attempt('delete', () => runWorkspaceJob({ spawn, argv, job: { action: 'box-delete', projectPath, box, name: ${JSON.stringify(SECRET_NAME)} }, timeoutMs: 60000 }));
await attempt('clear', () => runWorkspaceJob({ spawn, argv, job: { action: 'box-clear', projectPath, box }, timeoutMs: 60000 }));

process.stdout.write(JSON.stringify(report));
`;
}

function runPrivileged(tree, source) {
  const file = path.join(tree.root, 'controller.mjs');
  fs.writeFileSync(file, source);
  const env = [`PW_HOST_TERMINAL_USER=${MY_NAME}`, 'PW_DEPLOY_MODE=host',
    `HOME=${process.env.HOME || '/root'}`, `PATH=${process.env.PATH}`];
  const argv = ME === 0 ? ['env', ...env, process.execPath, file] : ['sudo', '-n', 'env', ...env, process.execPath, file];
  return JSON.parse(execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 180000 }));
}

/** What the superseded root-side code did, run as root on its own identical tree. */
function legacySource(tree) {
  return `
import fs from 'node:fs/promises';
import path from 'node:path';
const box = ${JSON.stringify(tree.boxPath)};
const out = {};
const entries = await fs.readdir(box, { withFileTypes: true });
out.listed = await Promise.all(entries.filter(e => e.isFile()).map(async e => {
  const st = await fs.stat(path.join(box, e.name));
  return { name: e.name, size: st.size };
}));
out.read = await fs.readFile(path.join(box, ${JSON.stringify(SECRET_NAME)}), 'utf8');
await fs.rm(path.join(box, ${JSON.stringify(SECRET_NAME)}), { force: true });
const rest = await fs.readdir(box);
await Promise.all(rest.map(n => fs.rm(path.join(box, n), { force: true, recursive: true })));
out.leftBehind = await fs.readdir(box);
process.stdout.write(JSON.stringify(out));
`;
}

for (const BOX of ['_inbox', '_outbox']) {
  test(`REAL ADVERSARIAL ${BOX}: root discloses and deletes nothing through a substituted box`, { timeout: 240000 }, async (t) => {
    const cap = await rootCapability();
    if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2/CT2115 owns this evidence; reported as NOT RUN, never as a pass`); return; }
    if (ME === 0) { t.skip('not run: this runner is already root, so no distinct unprivileged terminal owner can be resolved from it'); return; }

    // 1. The superseded shape, demonstrated on its own tree.
    const legacy = makeTree(BOX);
    try {
      assert.equal(fs.lstatSync(legacy.victim).uid, 0, 'sanity: the victim is root-owned');
      assert.throws(() => fs.readdirSync(legacy.victim), /EACCES/, 'sanity: and this test user genuinely cannot reach it');

      const old = runPrivileged(legacy, legacySource(legacy));
      assert.ok(old.listed.some((f) => f.name === SECRET_NAME),
        'sanity: the superseded list really did enumerate a directory only root can read');
      assert.equal(old.read, SECRET, 'sanity: and really did serve its bytes');
      assert.deepEqual(old.leftBehind, [],
        'sanity: and really did empty a root-owned directory recursively, by basename and by clear-all');
    } finally { cleanup(legacy); }

    // 2. The shipped path, on an identical tree.
    const tree = makeTree(BOX);
    try {
      const out = runPrivileged(tree, controllerSource(tree));

      // If the controller were not privileged, or the worker not dropped, none
      // of the assertions below could fail.
      assert.equal(out.currentUid, 0, 'the controller must genuinely run as root');
      assert.notEqual(out.currentUid, out.expectedUid, 'actual and expected uid must differ, or this proves nothing');
      assert.equal(out.expectedUid, ME, 'the owner is resolved from passwd, not from the running process');
      assert.equal(out.drop, true, 'root must drop privileges for every box operation, not only the write');
      assert.match(out.argv0, /sudo|setpriv/, 'the drop must go through the vetted fixed-argv abstraction');
      assert.ok(!out.argv.some((a) => /^(sh|bash|-c)$/.test(a)), `no shell may appear in ${JSON.stringify(out.argv)}`);

      for (const job of ['list', 'read', 'delete', 'clear']) {
        assert.equal(out.jobs[job].ok, false, `${job} must be refused through a substituted box`);
        assert.match(out.jobs[job].error, /symlink/i, `${job} must say what it refused: ${out.jobs[job].error}`);
      }
      assert.equal(JSON.stringify(out.jobs).includes(SECRET.trim()), false, 'no victim byte may cross the worker boundary');
      assert.equal(JSON.stringify(out.jobs).includes(SECRET_NAME), false, 'nor may a victim filename');

      // And the root-owned tree is exactly as it was.
      const victimNames = execFileSync('sudo', ['-n', 'ls', '-A', tree.victim], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
      assert.deepEqual(victimNames, ['deep', SECRET_NAME].sort(), 'nothing may have been deleted');
      const secret = path.join(tree.victim, SECRET_NAME);
      assert.equal(execFileSync('sudo', ['-n', 'cat', secret], { encoding: 'utf8' }), SECRET, 'nor modified');
      assert.equal(execFileSync('sudo', ['-n', 'stat', '-c', '%u', secret], { encoding: 'utf8' }).trim(), '0',
        'nor handed to anybody else');
      assert.equal(execFileSync('sudo', ['-n', 'cat', path.join(tree.victim, 'deep', 'inner.txt'), ], { encoding: 'utf8' }), 'INNER\n');
      assert.equal(fs.lstatSync(tree.boxPath).isSymbolicLink(), true, 'the link itself is left exactly as found');
    } finally { cleanup(tree); }
  });

  test(`REAL ${BOX}: an ordinary list/read/delete/clear runs as the UNPRIVILEGED terminal owner`, { timeout: 240000 }, async (t) => {
    const cap = await rootCapability();
    if (!cap.ok) { t.skip(`not run: ${cap.why} — PVI2/CT2115 owns this evidence; reported as NOT RUN, never as a pass`); return; }
    if (ME === 0) { t.skip('not run: already root, so no distinct unprivileged terminal owner can be resolved'); return; }

    const tree = makeTree(BOX);
    try {
      // Replace the substituted box with a real one the pane account owns.
      fs.unlinkSync(tree.boxPath);
      fs.mkdirSync(tree.boxPath);
      fs.writeFileSync(path.join(tree.boxPath, SECRET_NAME), 'ordinary contents\n');
      fs.mkdirSync(path.join(tree.boxPath, 'sub'));
      fs.writeFileSync(path.join(tree.boxPath, 'sub', 'x.txt'), 'x');

      const out = runPrivileged(tree, controllerSource(tree));
      assert.equal(out.drop, true, 'root still drops even for a perfectly ordinary box');

      assert.equal(out.jobs.list.ok, true, out.jobs.list.error);
      assert.deepEqual(out.jobs.list.result.files.map((f) => f.name), [SECRET_NAME], 'sub/ is a directory, not a file');
      assert.equal(out.jobs.read.ok, true, out.jobs.read.error);
      assert.equal(out.jobs.read.result.body, 'ordinary contents\n');
      assert.equal(out.jobs.read.result.bytes, 18);
      assert.equal(out.jobs.delete.ok, true, out.jobs.delete.error);
      assert.equal(out.jobs.clear.ok, true, out.jobs.clear.error);

      assert.deepEqual(fs.readdirSync(tree.boxPath), [], 'the box really was emptied');
      assert.equal(fs.lstatSync(tree.boxPath).uid, ME, 'and it is still owned by the terminal owner, not by root');
    } finally { cleanup(tree); }
  });
}
