// scripts/pw-tmux-save is the only writer of the manifest pw-tmux-restore replays after a reboot.
// On 2026-09-14 it destroyed that manifest. On a saturated host one run sat 8.5 minutes in
// capture-pane, the timer started the next run the moment it returned, the shared tmux server
// exited, and a save that ran against the one-session server that came up in its place replaced a
// 60-row manifest with that single blank session. Hermes rebuilt the 26 sessions, 60 windows and 46
// Claude session ids from other evidence.
//
// Each test below closes one step of that sequence, and one closes a gap the incident exposed: a
// hibernated window's resume id lived only in the manifest, so the pre-hardening script would have
// dropped it on its next run.
//
// Real script, real tmux, every server on a private socket stood up through the shared fixture (which
// refuses the shared default socket, $PW_TMUX_SOCKET and whatever server $TMUX names).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureTmuxServer, installOwnerHelper, ownedTmuxFixture } from './tmux-owner-fixture.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'pw-tmux-save');
const SEP = '\x1f';
const REFUSED = 75;
const REAL_TMUX = execFileSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
const TUNABLES = [
  'PW_TMUX_ALLOW_SHRINK', 'PW_TMUX_CAPTURE_TIMEOUT', 'PW_TMUX_CAPTURE_BUDGET',
  'PW_TMUX_QUERY_TIMEOUT', 'PW_TMUX_SHRINK_PERCENT', 'PW_TMUX_SCROLLBACK_LINES',
];

const sockName = () => 'pwsavetest-' + crypto.randomBytes(4).toString('hex');

async function tmux(sock, args) {
  const env = { ...process.env };
  delete env.TMUX;
  const { stdout } = await execFileAsync('tmux', ['-L', sock, ...args], { env });
  return stdout.trim();
}

async function setup({ owned = true, foreignSession = 'pw_Recovered' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-save-'));
  const sock = sockName();
  const stateDir = path.join(dir, 'tmux-persist');
  const work = path.join(dir, 'work');
  await fsp.mkdir(path.join(stateDir, 'content'), { recursive: true });
  await fsp.mkdir(work, { recursive: true });
  let ownerEnv;
  if (owned) {
    ownerEnv = ownedTmuxFixture({ socket: sock, dir });
  } else {
    // What came up after the shared server exited: a real server with one pw_* session, which
    // answers every query, but was never stamped by the owner unit.
    createFixtureTmuxServer({ socket: sock, session: foreignSession });
    ownerEnv = {
      PATH: `${installOwnerHelper(dir)}:${process.env.PATH}`,
      PW_DEPLOY_MODE: 'host',
      PW_TMUX_REQUIRE_CGROUP: '1',
      PW_TMUX_PROC_ROOT: path.join(dir, 'proc'),
    };
  }
  const env = {
    ...process.env,
    ...ownerEnv,
    HOME: dir,
    PW_TMUX_SOCKET: sock,
    PW_TMUX_STATE_DIR: stateDir,
    PW_TMUX_LOG: path.join(stateDir, 'persist.log'),
    PW_CLAUDE_SESSIONS_DIR: path.join(dir, 'claude-sessions'),
  };
  delete env.TMUX;
  for (const k of TUNABLES) delete env[k];
  return { dir, sock, stateDir, work, env, manifest: path.join(stateDir, 'manifest.tsv'), log: path.join(stateDir, 'persist.log') };
}

async function teardown(ctx) {
  try { await tmux(ctx.sock, ['kill-server']); } catch { /* gone */ }
  await fsp.rm(ctx.dir, { recursive: true, force: true });
}

async function addSession(ctx, session, windows) {
  const [first, ...rest] = windows;
  await tmux(ctx.sock, ['new-session', '-d', '-s', session, '-n', first.name, '-c', first.cwd ?? ctx.work, first.cmd ?? 'sleep 86400']);
  for (const w of rest) {
    await tmux(ctx.sock, ['new-window', '-d', '-t', `${session}:`, '-n', w.name, '-c', w.cwd ?? ctx.work, w.cmd ?? 'sleep 86400']);
  }
}

function runSave(ctx, extra = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile('bash', [SCRIPT], { env: { ...ctx.env, ...extra }, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const line = (r) => [r.s, r.w, r.wn ?? 'win', r.cwd ?? '/tmp', r.hasc ?? (r.sid ? 1 : 0), r.sid ?? '', r.cfile ?? ''].join(SEP);
const writeManifest = (file, rows) => fs.writeFileSync(file, rows.map(line).join('\n') + '\n');
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  const f = l.split(SEP);
  return { nf: f.length, s: f[0], w: Number(f[1]), wn: f[2], cwd: f[3], hasc: f[4], sid: f[5], cfile: f[6] };
});

/** A manifest shaped like a real instance's: several sessions, several windows, resume ids. */
function richRows({ sessions, windows, sids = false }) {
  const rows = [];
  for (let s = 0; s < sessions; s++) {
    for (let w = 0; w < windows; w++) {
      rows.push({ s: `pw_Project${s}`, w, wn: `tab${w}`, cwd: '/tmp', ...(sids ? { sid: crypto.randomUUID() } : {}) });
    }
  }
  return rows;
}

const tempLeftovers = (ctx) => fs.readdirSync(ctx.stateDir).filter((f) => f.startsWith('.manifest.'));
const readLog = (ctx) => (fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '');

/** A `tmux` on PATH that stalls on one subcommand and passes everything else to the real binary. */
function stallingTmux(ctx, subcommand) {
  const bin = path.join(ctx.dir, `stall-${subcommand}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'),
    `#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == ${subcommand} ]] && exec sleep 30; done\nexec ${JSON.stringify(REAL_TMUX)} "$@"\n`,
    { mode: 0o755 });
  return `${bin}:${ctx.env.PATH}`;
}

test('writes one row per pw_* window, and never persists _keepalive or pw_setup', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_alpha', [{ name: 'main' }, { name: 'second' }]);
    await addSession(ctx, 'pw_setup', [{ name: 'setup' }]);
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    const rows = readRows(ctx.manifest);
    assert.deepEqual(rows.map((x) => `${x.s}:${x.w}:${x.wn}`), ['pw_alpha:0:main', 'pw_alpha:1:second']);
    for (const x of rows) assert.equal(x.nf, 7);
    assert.deepEqual(tempLeftovers(ctx), []);
  } finally { await teardown(ctx); }
});

test('REGRESSION (2026-09-14): a one-session server the owner unit never stamped cannot overwrite the manifest', { timeout: 20000 }, async () => {
  const ctx = await setup({ owned: false });
  try {
    writeManifest(ctx.manifest, richRows({ sessions: 24, windows: 2, sids: true }));
    const before = fs.readFileSync(ctx.manifest);
    const r = await runSave(ctx);
    assert.equal(r.code, REFUSED, `a foreign server must be a visible refusal: ${r.stderr}`);
    assert.deepEqual(fs.readFileSync(ctx.manifest), before, 'the manifest must be byte-for-byte what it was');
    assert.match(readLog(ctx), /REFUSED: the live tmux server is not the one the workbench owner unit stamped/);
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'manifest.tsv.prev')), false);
    assert.deepEqual(tempLeftovers(ctx), []);
  } finally { await teardown(ctx); }
});

test('a materially smaller snapshot is refused; PW_TMUX_ALLOW_SHRINK=1 accepts it and keeps the previous generation', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_only', [{ name: 'main' }]);
    writeManifest(ctx.manifest, richRows({ sessions: 10, windows: 1 }));
    const before = fs.readFileSync(ctx.manifest);

    const refused = await runSave(ctx);
    assert.equal(refused.code, REFUSED, refused.stderr);
    assert.deepEqual(fs.readFileSync(ctx.manifest), before);
    assert.match(readLog(ctx), /REFUSED: sessions would drop from 10 to 1/);
    assert.equal(fs.readdirSync(path.join(ctx.stateDir, 'rejected')).length, 1, 'the refused candidate is kept for diagnosis');
    assert.ok(fs.existsSync(path.join(ctx.stateDir, 'last-refusal')));

    const accepted = await runSave(ctx, { PW_TMUX_ALLOW_SHRINK: '1' });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.deepEqual(readRows(ctx.manifest).map((x) => x.s), ['pw_only']);
    assert.deepEqual(fs.readFileSync(path.join(ctx.stateDir, 'manifest.tsv.prev')), before, 'the replaced manifest is kept as the previous generation');
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'last-refusal')), false, 'a successful save clears the refusal marker');
    assert.deepEqual(tempLeftovers(ctx), []);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a save that cannot see hibernated resume ids refuses rather than erasing them', { timeout: 20000 }, async () => {
  // The shape Hermes left after the incident: every window still exists, the ids are recorded in
  // the manifest, but no process holds them and no window carries a marker yet.
  const ctx = await setup();
  try {
    const rows = [];
    for (const s of ['pw_a', 'pw_b', 'pw_c']) {
      await addSession(ctx, s, [0, 1, 2, 3].map((w) => ({ name: `tab${w}` })));
      for (let w = 0; w < 4; w++) rows.push({ s, w, wn: `tab${w}`, cwd: ctx.work, sid: crypto.randomUUID() });
    }
    writeManifest(ctx.manifest, rows);
    const before = fs.readFileSync(ctx.manifest);
    const r = await runSave(ctx);
    assert.equal(r.code, REFUSED, r.stderr);
    assert.deepEqual(fs.readFileSync(ctx.manifest), before, 'all 12 resume ids must survive');
    assert.match(readLog(ctx), /REFUSED: Claude resume ids would drop from 12 to 0/);
  } finally { await teardown(ctx); }
});

test('a hibernated window is recorded as hasc=2 with its exact resume id, and its scrollback is not captured', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_h', [{ name: 'shell' }, { name: 'claude' }]);
    const sid = crypto.randomUUID();
    const wid = await tmux(ctx.sock, ['display-message', '-p', '-t', 'pw_h:1', '#{window_id}']);
    await tmux(ctx.sock, ['set-option', '-w', '-t', 'pw_h:1', '@pw_claude_sid', sid]);
    await tmux(ctx.sock, ['set-option', '-w', '-t', 'pw_h:1', '@pw_claude_hib_win', wid]);
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    const [shell, hib] = readRows(ctx.manifest);
    assert.deepEqual({ hasc: hib.hasc, sid: hib.sid, cfile: hib.cfile }, { hasc: '2', sid, cfile: '' });
    assert.equal(shell.hasc, '0');
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'content', 'pw_h__1.txt')), false);
    assert.match(readLog(ctx), /1 hibernated/);
  } finally { await teardown(ctx); }
});

test('a stray session- or global-scope hibernation marker cannot mark windows it does not name', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_g', [{ name: 'one' }, { name: 'two' }]);
    await tmux(ctx.sock, ['set-option', '-g', '@pw_claude_sid', crypto.randomUUID()]);
    await tmux(ctx.sock, ['set-option', '-g', '@pw_claude_hib_win', '@999']);
    await tmux(ctx.sock, ['set-option', '-t', 'pw_g', '@pw_claude_sid', crypto.randomUUID()]);
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readRows(ctx.manifest).map((x) => x.hasc), ['0', '0']);
  } finally { await teardown(ctx); }
});

for (const form of ['string', 'number']) test(`a live Claude is trusted only while its registry procStart (${form}) still matches the pid`, { timeout: 20000 }, async () => {
  // Claude Code 2.1.x writes "procStart":"323267140". A reader that only accepts a bare number never
  // applies the guard to a real registry, which is how the pre-proof version of this script behaved.
  const as = (n) => (form === 'string' ? String(n) : n);
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_live', [{ name: 'claude' }]);
    const pid = await tmux(ctx.sock, ['display-message', '-p', '-t', 'pw_live:0', '#{pane_pid}']);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const procStart = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]);
    const sid = crypto.randomUUID();
    const reg = path.join(ctx.env.PW_CLAUDE_SESSIONS_DIR);
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(path.join(reg, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: sid, procStart: as(procStart) }));

    assert.equal((await runSave(ctx)).code, 0);
    assert.deepEqual((({ hasc, sid: s }) => ({ hasc, sid: s }))(readRows(ctx.manifest)[0]), { hasc: '1', sid });

    // The same file, left behind by a Claude that exited, now naming a pid the kernel reused.
    fs.writeFileSync(path.join(reg, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: sid, procStart: as(procStart + 1) }));
    assert.equal((await runSave(ctx)).code, 0);
    assert.deepEqual((({ hasc, sid: s }) => ({ hasc, sid: s }))(readRows(ctx.manifest)[0]), { hasc: '0', sid: '' });
  } finally { await teardown(ctx); }
});

test('REGRESSION (2026-09-14): a stalled capture-pane is bounded; the run finishes, keeps the previous scrollback and writes the manifest', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_s', [{ name: 'shell' }]);
    const content = path.join(ctx.stateDir, 'content', 'pw_s__0.txt');
    fs.writeFileSync(content, 'PREVIOUS SCROLLBACK\n');
    const r = await runSave(ctx, { PATH: stallingTmux(ctx, 'capture-pane'), PW_TMUX_CAPTURE_TIMEOUT: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 15000, `a stalled capture must not hold the run open (took ${r.ms} ms)`);
    assert.equal(fs.readFileSync(content, 'utf8'), 'PREVIOUS SCROLLBACK\n');
    assert.equal(readRows(ctx.manifest)[0].cfile, 'pw_s__0.txt');
    assert.match(readLog(ctx), /1 kept after a stalled capture/);
    assert.deepEqual(fs.readdirSync(path.join(ctx.stateDir, 'content')).filter((f) => f.startsWith('.')), [], 'no partial capture file is left behind');
  } finally { await teardown(ctx); }
});

test('the whole-run capture budget stops capturing and keeps previous scrollback once it is spent', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_b', [{ name: 'one' }, { name: 'two' }]);
    fs.writeFileSync(path.join(ctx.stateDir, 'content', 'pw_b__0.txt'), 'OLD 0\n');
    const r = await runSave(ctx, { PW_TMUX_CAPTURE_BUDGET: '0' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'content', 'pw_b__0.txt'), 'utf8'), 'OLD 0\n');
    assert.deepEqual(readRows(ctx.manifest).map((x) => x.cfile), ['pw_b__0.txt', '']);
    assert.match(readLog(ctx), /2 kept over budget/);
  } finally { await teardown(ctx); }
});

test('REGRESSION (2026-09-14): one run at a time; a run that finds the lock held skips and touches nothing', { timeout: 20000 }, async () => {
  const ctx = await setup();
  const lock = path.join(ctx.stateDir, '.save.lock');
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  try {
    await addSession(ctx, 'pw_l', [{ name: 'main' }]);
    for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /still holds the lock; skipping this run/);
    assert.equal(fs.existsSync(ctx.manifest), false);
  } finally {
    holder.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('a server that does not answer in time is a refusal, not "no server"', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_q', [{ name: 'main' }]);
    writeManifest(ctx.manifest, richRows({ sessions: 3, windows: 2 }));
    const before = fs.readFileSync(ctx.manifest);
    const r = await runSave(ctx, { PATH: stallingTmux(ctx, 'list-sessions'), PW_TMUX_QUERY_TIMEOUT: '1' });
    assert.equal(r.code, REFUSED, r.stderr);
    assert.deepEqual(fs.readFileSync(ctx.manifest), before);
    assert.match(readLog(ctx), /did not answer within 1s/);
  } finally { await teardown(ctx); }
});

test('a pane whose path cannot be recorded never corrupts the manifest', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    const hostile = path.join(ctx.work, 'line\nbreak');
    fs.mkdirSync(hostile);
    await addSession(ctx, 'pw_n', [{ name: 'good' }, { name: 'bad', cwd: hostile }]);
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    const rows = readRows(ctx.manifest);
    for (const x of rows) {
      assert.equal(x.nf, 7, 'every row keeps exactly seven fields');
      assert.ok(x.cwd.startsWith('/'), 'every cwd is absolute');
    }
    assert.ok(rows.some((x) => x.wn === 'good' && x.cwd === ctx.work));
  } finally { await teardown(ctx); }
});

test('a dead pane (remain-on-exit, no path) is skipped instead of refusing every save', { timeout: 20000 }, async () => {
  const ctx = await setup();
  try {
    await addSession(ctx, 'pw_d', [{ name: 'alive' }]);
    const target = (await tmux(ctx.sock, ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', 'pw_d:', '-n', 'dead', 'sleep 1'])).trim();
    await tmux(ctx.sock, ['set-option', '-w', '-t', target, 'remain-on-exit', 'on']);
    for (let i = 0; i < 40 && (await tmux(ctx.sock, ['display-message', '-p', '-t', target, '#{pane_dead}'])).trim() !== '1'; i++) await new Promise((r) => setTimeout(r, 100));
    const r = await runSave(ctx);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readRows(ctx.manifest).map((x) => x.wn), ['alive']);
  } finally { await teardown(ctx); }
});

test('REGRESSION: save reads only the socket it is told to use, never an inherited $TMUX or the real default server', { timeout: 20000 }, async () => {
  const ctx = await setup();
  const unrelated = createFixtureTmuxServer({ socket: sockName(), session: 'pw_unrelated' });
  const snapshotDefault = () => {
    const env = { ...process.env };
    delete env.TMUX;
    return execFileAsync('tmux', ['-L', 'default', 'list-sessions', '-F', '#{session_name}:#{session_windows}'], { env })
      .then((r) => r.stdout).catch(() => '');
  };
  const before = await snapshotDefault();
  try {
    await addSession(ctx, 'pw_mine', [{ name: 'main' }]);
    const r = await runSave(ctx, { TMUX: `${path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, unrelated.socket)},0,0` });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readRows(ctx.manifest).map((x) => x.s), ['pw_mine']);
    assert.equal(await tmux(unrelated.socket, ['list-sessions', '-F', '#{session_name}']), 'pw_unrelated');
  } finally {
    unrelated?.release();
    await teardown(ctx);
  }
  assert.equal(await snapshotDefault(), before, 'the real default tmux server must be untouched');
});
