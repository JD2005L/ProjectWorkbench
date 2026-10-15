// The host runner of "the agent asks, an admin approves" promotes
// (deploy/host/files/usr/local/sbin/pw-promote-runner), driven against disposable trees.
//
// What it must guarantee, because a promote is agent-written code running as host root:
//   * a DRY RUN snapshots the workspace without handing the agent any root power — read as the
//     workspace owner, never extracted by root's tar, and anything that is not a plain file or
//     directory (symlink, hard link, FIFO, absolute or '..' path, dash-leading name) refused;
//   * a PROMOTE runs only for an unexpired approval of exactly the digest the dry run recorded,
//     against a snapshot that still hashes to it, and runs pw-promote-app on THAT snapshot.
//
// NOTHING LIVE MAY BE TOUCHED, and that is enforced BEFORE anything runs (see
// test/deploy-local-promotion.test.mjs for why a check after the fact is not a safety
// property): runRunner refuses unless every path the runner uses is overridden into a private
// temp tree, pw-promote-app is a stub that only records its argv and environment, and podman,
// systemctl, pgrep and sudo are tripwire stubs on PATH that fail the test if anything calls them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../deploy/host/files/usr/local/sbin/pw-promote-runner', import.meta.url));
const PROMOTE_APP = fileURLToPath(new URL('../deploy/promote-app.sh', import.meta.url));
const TMP = fs.realpathSync(os.tmpdir());

function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(TMP, 'pw-promote-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spool = path.join(root, 'spool');
  for (const d of ['', 'requests', 'queue']) fs.mkdirSync(path.join(spool, d), { mode: 0o700, recursive: true });
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'app', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'app', 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'app', 'server.js'), 'console.log("server")\n');
  fs.writeFileSync(path.join(ws, 'app', 'lib', 'x.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(ws, 'app', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(ws, 'scripts', 'run.sh'), '#!/bin/bash\necho hi\n', { mode: 0o755 });
  const commit = 'a'.repeat(40);
  fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(ws, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
  // pw-promote-app stand-in: records how it was called, prints a line, exits as told.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(root, 'calls.jsonl');
  const stub = path.join(root, 'pw-promote-app-stub');
  fs.writeFileSync(stub, `#!/bin/bash\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),src:process.env.PW_PROMOTE_SRC,ssrc:process.env.PW_PROMOTE_SCRIPTS_SRC})+"\\n")' ${JSON.stringify(calls)} "$@"\necho "stub pw-promote-app $*"\nexit "\${STUB_EXIT:-0}"\n`, { mode: 0o755 });
  const tripped = path.join(root, 'tripwire.log');
  for (const name of ['podman', 'systemctl', 'pgrep', 'sudo', 'git']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(tripped)}\nexit 99\n`, { mode: 0o755 });
  }
  const audit = path.join(root, 'audit.log');
  fs.writeFileSync(audit, '');
  return { root, spool, ws, commit, calls, stub, bin, tripped, audit };
}

function envFor(w, extra = {}) {
  return {
    PATH: `${w.bin}:${process.env.PATH}`, HOME: w.root, LANG: 'C.UTF-8',
    PW_PROMOTE_SPOOL: w.spool, PW_PROMOTE_WORKSPACE: w.ws, PW_PROMOTE_BIN: w.stub,
    PW_PROMOTE_AUDIT_LOG: w.audit, PW_PROMOTE_SETPRIV: path.join(w.bin, 'setpriv-must-not-run'),
    ...extra,
  };
}

// The gate: every path the runner touches must be one of OURS, under the temp root, before it
// is allowed to execute at all.
function assertContained(w, env) {
  for (const key of ['PW_PROMOTE_SPOOL', 'PW_PROMOTE_BIN', 'PW_PROMOTE_AUDIT_LOG', 'PW_PROMOTE_SETPRIV']) {
    assert.ok(env[key] && path.resolve(env[key]).startsWith(w.root + path.sep), `${key} must point into the test tree, got ${env[key]}`);
  }
  const ws = path.resolve(env.PW_PROMOTE_WORKSPACE);
  assert.ok(ws.startsWith(TMP + path.sep) || ws === '/usr/share', `PW_PROMOTE_WORKSPACE must be a test tree (or the read-only root-owned probe), got ${ws}`);
  const src = fs.readFileSync(RUNNER, 'utf8');
  for (const key of ['PW_PROMOTE_SPOOL', 'PW_PROMOTE_WORKSPACE', 'PW_PROMOTE_BIN', 'PW_PROMOTE_SETPRIV', 'PW_PROMOTE_AUDIT_LOG', 'PW_PROMOTE_TAR', 'PW_PROMOTE_CAT']) {
    assert.match(src, new RegExp(`env\\.${key}\\b`), `the runner must route ${key} through the environment`);
  }
}

function runRunner(w, extra = {}) {
  const env = envFor(w, extra);
  assertContained(w, env);
  const r = spawnSync(process.execPath, [RUNNER], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(fs.existsSync(w.tripped) ? fs.readFileSync(w.tripped, 'utf8') : '', '', 'nothing may call podman/systemctl/pgrep/sudo/git');
  return r;
}

let seq = 0;
function newRequest(w) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const id = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(w.spool, 'requests', id);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ id, createdAt: d.toISOString(), requestedBy: 'on-box agent', note: '' }));
  const q = path.join(w.spool, 'queue', `${id}.dryrun`);
  fs.writeFileSync(q, '{}');
  const t = new Date(Date.now() + (seq++) * 10);
  fs.utimesSync(q, t, t);
  return { id, dir };
}
const status = (w, id) => JSON.parse(fs.readFileSync(path.join(w.spool, 'requests', id, 'status.json'), 'utf8'));
const calls = (w) => (fs.existsSync(w.calls) ? fs.readFileSync(w.calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function approve(w, id, patch = {}) {
  const st = status(w, id);
  fs.writeFileSync(path.join(w.spool, 'requests', id, 'approval.json'), JSON.stringify({
    id, approvedBy: 'boss', approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), digest: st.digest, ...patch,
  }));
  fs.writeFileSync(path.join(w.spool, 'queue', `${id}.promote`), '{}');
}

test('dry run: a clean tree is snapshotted (minus node_modules), digested, HEAD read from plain files, and dry-run against the snapshot', (t) => {
  const w = makeWorld(t);
  const { id, dir } = newRequest(w);
  const r = runRunner(w);
  assert.equal(r.status, 0, r.stderr);
  const st = status(w, id);
  assert.equal(st.state, 'dry-run-ok', JSON.stringify(st));
  assert.deepEqual(st.head, { ref: 'refs/heads/main', commit: w.commit });
  assert.match(st.digest, /^[0-9a-f]{64}$/);
  const snap = path.join(dir, 'snapshot');
  assert.equal(fs.readFileSync(path.join(snap, 'app', 'server.js'), 'utf8'), 'console.log("server")\n');
  assert.equal(fs.existsSync(path.join(snap, 'app', 'node_modules')), false, 'node_modules is never snapshotted');
  assert.equal(fs.statSync(path.join(snap, 'scripts', 'run.sh')).mode & 0o777, 0o755, 'an executable script stays executable');
  assert.equal(fs.statSync(path.join(snap, 'app', 'server.js')).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(path.join(dir, 'snapshot.tar')), false, 'the archive is removed once extracted');
  assert.deepEqual(calls(w), [{ args: ['--dry-run'], src: path.join(snap, 'app'), ssrc: path.join(snap, 'scripts') }],
    'pw-promote-app ran exactly once, as a dry run, against the snapshot — never the workspace');
  assert.match(fs.readFileSync(path.join(dir, 'dry-run.log'), 'utf8'), /stub pw-promote-app --dry-run/);
  assert.deepEqual(fs.readdirSync(path.join(w.spool, 'queue')), [], 'the queue is drained');
  assert.match(fs.readFileSync(w.audit, 'utf8'), /"event":"promote_dry_run".*"ok":true/);

  // A later edit to the workspace changes nothing about what was reviewed.
  fs.writeFileSync(path.join(w.ws, 'app', 'server.js'), 'EVIL\n');
  assert.equal(fs.readFileSync(path.join(snap, 'app', 'server.js'), 'utf8'), 'console.log("server")\n');
});

test('dry run: HEAD from packed-refs, and a detached HEAD', (t) => {
  const w = makeWorld(t);
  fs.rmSync(path.join(w.ws, '.git', 'refs', 'heads', 'main'));
  fs.writeFileSync(path.join(w.ws, '.git', 'packed-refs'), `# pack-refs with: peeled\n${'b'.repeat(40)} refs/heads/main\n`);
  const a = newRequest(w);
  runRunner(w);
  assert.deepEqual(status(w, a.id).head, { ref: 'refs/heads/main', commit: 'b'.repeat(40) });
  fs.writeFileSync(path.join(w.ws, '.git', 'HEAD'), `${'c'.repeat(40)}\n`);
  const b = newRequest(w);
  runRunner(w);
  assert.deepEqual(status(w, b.id).head, { ref: null, commit: 'c'.repeat(40) });
});

for (const [label, plant, reason] of [
  ['a symlink', (ws) => fs.symlinkSync('/etc/hostname', path.join(ws, 'app', 'evil.js')), /symbolic link/],
  ['a hard link', (ws) => fs.linkSync(path.join(ws, 'app', 'server.js'), path.join(ws, 'app', 'twin.js')), /hard link/],
  ['a FIFO', (ws) => execFileSync('mkfifo', [path.join(ws, 'app', 'pipe')]), /FIFO/],
]) {
  test(`ADVERSARIAL: a workspace containing ${label} is refused before anything is extracted or run`, (t) => {
    const w = makeWorld(t);
    plant(w.ws);
    const { id, dir } = newRequest(w);
    runRunner(w);
    const st = status(w, id);
    assert.equal(st.state, 'dry-run-failed');
    assert.match(st.error, reason);
    assert.equal(fs.existsSync(path.join(dir, 'snapshot')), false, 'no snapshot is left behind');
    assert.deepEqual(calls(w), [], 'pw-promote-app is never run');
  });
}

// A minimal ustar writer, for archives a real tar would never produce from a real tree.
function ustar(entries) {
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100);
    h.write('0000000\0', 108); h.write('0000000\0', 116);
    const data = Buffer.from(e.data || '');
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type || '0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

for (const [label, entries, reason] of [
  ['an absolute path', [{ name: 'app/server.js', data: 'x' }, { name: '/etc/cron.d/evil', data: 'x' }], /absolute path/],
  ['a .. path', [{ name: 'app/server.js', data: 'x' }, { name: 'app/../../evil', data: 'x' }], /'\.\.'/],
  ['a dash-leading name', [{ name: 'app/server.js', data: 'x' }, { name: 'app/-rf', data: 'x' }], /unsupported name/],
  ['an entry outside app/ and scripts/', [{ name: 'app/server.js', data: 'x' }, { name: 'etc/passwd', data: 'x' }], /outside app\/ and scripts\//],
  ['a device', [{ name: 'app/server.js', data: 'x' }, { name: 'app/null', type: '3' }], /character device/],
  ['a duplicate entry', [{ name: 'app/server.js', data: 'x' }, { name: 'app/server.js', data: 'y' }], /appears twice/],
]) {
  test(`ADVERSARIAL: an archive carrying ${label} is refused`, (t) => {
    const w = makeWorld(t);
    const crafted = path.join(w.root, 'crafted.tar');
    fs.writeFileSync(crafted, ustar(entries));
    // A tar stand-in that emits the crafted archive whatever it is asked.
    const fakeTar = path.join(w.root, 'fake-tar');
    fs.writeFileSync(fakeTar, `#!/bin/bash\ncat ${JSON.stringify(crafted)}\n`, { mode: 0o755 });
    const { id, dir } = newRequest(w);
    runRunner(w, { PW_PROMOTE_TAR: fakeTar });
    const st = status(w, id);
    assert.equal(st.state, 'dry-run-failed');
    assert.match(st.error, reason);
    assert.equal(fs.existsSync(path.join(dir, 'snapshot')), false);
    assert.deepEqual(calls(w), []);
    assert.equal(fs.existsSync('/etc/cron.d/evil'), false);
  });
}

test('ADVERSARIAL: an oversized snapshot is refused at the cap', (t) => {
  const w = makeWorld(t);
  fs.writeFileSync(path.join(w.ws, 'app', 'big.js'), 'x'.repeat(200000));
  const { id } = newRequest(w);
  runRunner(w, { PW_PROMOTE_MAX_BYTES: '50000' });
  assert.match(status(w, id).error, /larger than 50000 bytes/);
  assert.deepEqual(calls(w), []);
});

test('ADVERSARIAL: a workspace owned by root is never read', (t) => {
  const w = makeWorld(t);
  const { id } = newRequest(w);
  runRunner(w, { PW_PROMOTE_WORKSPACE: '/usr/share' });
  assert.match(status(w, id).error, /owned by root/);
  assert.deepEqual(calls(w), []);
});

test('promote: an unexpired approval of the recorded digest runs pw-promote-app on the snapshot, once', (t) => {
  const w = makeWorld(t);
  const { id, dir } = newRequest(w);
  runRunner(w);
  approve(w, id);
  runRunner(w);
  const st = status(w, id);
  assert.equal(st.state, 'promoted', JSON.stringify(st));
  assert.equal(st.approvedBy, 'boss');
  const snap = path.join(dir, 'snapshot');
  assert.deepEqual(calls(w)[1], { args: [], src: path.join(snap, 'app'), ssrc: path.join(snap, 'scripts') }, 'the real (non-dry) run, on the reviewed snapshot');
  assert.match(fs.readFileSync(path.join(dir, 'promote.log'), 'utf8'), /stub pw-promote-app $/m);
  // A second promote job for the same request does nothing.
  fs.writeFileSync(path.join(w.spool, 'queue', `${id}.promote`), '{}');
  runRunner(w);
  assert.equal(calls(w).length, 2, 'an approval is used once');
  const audit = fs.readFileSync(w.audit, 'utf8');
  assert.match(audit, /"event":"promote_start".*"approvedBy":"boss"/);
  assert.match(audit, /"event":"promote_result".*"ok":true/);
});

test('promote: a failing pw-promote-app is recorded as failed', (t) => {
  const w = makeWorld(t);
  const { id } = newRequest(w);
  runRunner(w);
  approve(w, id);
  runRunner(w, { STUB_EXIT: '1' });
  assert.equal(status(w, id).state, 'failed');
});

for (const [label, setup, reason] of [
  ['no approval', (w, id) => fs.writeFileSync(path.join(w.spool, 'queue', `${id}.promote`), '{}'), /no approval/],
  ['an expired approval', (w, id) => approve(w, id, { expiresAt: new Date(Date.now() - 1000).toISOString() }), /expired/],
  ['an approval of a different digest', (w, id) => approve(w, id, { digest: 'f'.repeat(64) }), /different content/],
  ['an approval naming another request', (w, id) => approve(w, id, { id: '20200101T000000Z-00000000' }), /different request/],
  ['a snapshot changed after review', (w, id) => { fs.writeFileSync(path.join(w.spool, 'requests', id, 'snapshot', 'app', 'server.js'), 'EVIL\n'); approve(w, id); }, /no longer matches/],
  ['a rejected request', (w, id) => { approve(w, id); fs.writeFileSync(path.join(w.spool, 'requests', id, 'rejected.json'), '{}'); }, /rejected/],
  ['a dry run approved more than a day after it ran', (w, id) => {
    const f = path.join(w.spool, 'requests', id, 'status.json');
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    st.finishedAt = new Date(Date.now() - 30 * 3600e3).toISOString();
    fs.writeFileSync(f, JSON.stringify(st));
    approve(w, id);
  }, /more than 24 hours old/],
]) {
  test(`promote is refused with ${label}`, (t) => {
    const w = makeWorld(t);
    const { id } = newRequest(w);
    runRunner(w);
    setup(w, id);
    runRunner(w);
    const st = status(w, id);
    assert.equal(st.state, 'refused', JSON.stringify(st));
    assert.match(st.error, reason);
    assert.equal(calls(w).length, 1, 'only the dry run ever ran');
  });
}

test('a request superseded before its dry run is skipped, and old requests are pruned to the newest ten', (t) => {
  const w = makeWorld(t);
  const gone = newRequest(w);
  fs.writeFileSync(path.join(gone.dir, 'superseded.json'), '{}');
  runRunner(w);
  assert.equal(fs.existsSync(path.join(gone.dir, 'status.json')), false);
  assert.equal(fs.existsSync(path.join(gone.dir, 'snapshot')), false);
  for (let i = 0; i < 12; i++) {
    const id = `2020010${i < 10 ? '1' : '2'}T0000${String(i).padStart(2, '0')}Z-0000000${i % 10}`;
    fs.mkdirSync(path.join(w.spool, 'requests', id));
    fs.writeFileSync(path.join(w.spool, 'requests', id, 'status.json'), JSON.stringify({ state: 'promoted' }));
  }
  runRunner(w);
  assert.equal(fs.readdirSync(path.join(w.spool, 'requests')).length, 10);
  assert.ok(fs.existsSync(gone.dir), 'the newest are kept');
});

test('pw-promote-app takes the snapshot through PW_PROMOTE_SRC / PW_PROMOTE_SCRIPTS_SRC and keeps every preflight', () => {
  const src = fs.readFileSync(PROMOTE_APP, 'utf8');
  assert.match(src, /^SRC=\$\{PW_PROMOTE_SRC:-\/opt\/project-workbench\/workspaces\/ProjectWorkbench\/app\}$/m);
  assert.match(src, /^SSRC=\$\{PW_PROMOTE_SCRIPTS_SRC:-\/opt\/project-workbench\/workspaces\/ProjectWorkbench\/scripts\}$/m);
  for (const guard of [/running inside a container/, /must run as root/, /PW_TURN_OUTCOME PW_TURN_OUTCOME_HERMES/, /ROLLING BACK/, /healthy\(\)/, /preflight: syntax-check the source/]) {
    assert.match(src, guard, `kept: ${guard}`);
  }
  assert.doesNotMatch(src, /persistent\/admin-home\/promote-app\.sh/, 'no longer points operators at the agent-writable copy');
});
