// pw-tmux-server.service owns the shared tmux server in its OWN cgroup, so no
// per-project ttyd unit can take every project's sessions down with it.
//
// The bug this locks down (PVI2, 2026-08-03): in host mode the server had no unit,
// so `tmux new-session` inside project-terminal-start parented it to whichever
// project-terminal@<project>.service started first. Every project's panes landed
// in that one per-project cgroup; a single OOM-killed pane failed the unit and,
// under systemd's default KillMode=control-group, tore the whole cgroup down —
// killing the server and every project's sessions mid-uptime. pw-tmux-persist only
// restores at BOOT, and the host had been up 5 weeks, so nothing ever replayed it.
//
// Two halves are tested here:
//   1. scripts/pw-tmux-keepalive.sh really brings up a server the terminals can
//      reach in host mode — in particular that it does NOT redirect TMUX_TMPDIR
//      the way the container sidecar does, which would silently stand up a SECOND
//      server on a different socket that no terminal ever attaches to (the
//      sessions would look exactly as "lost" as before the fix).
//   2. The systemd contract itself — the ownership + ordering + OOM/kill settings
//      are the entire fix, so they are asserted as invariants rather than left to
//      a future edit to quietly undo.
//
// The script half runs the REAL script and REAL tmux, isolated onto a private
// socket via PW_TMUX_SOCKET (the same mechanism pw-tmux-restore and server.js use)
// so it can never touch a real project terminal — including the one this test may
// itself be running inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEPALIVE = path.join(REPO, 'scripts', 'pw-tmux-keepalive.sh');
const SYSTEMD = path.join(REPO, 'systemd');
// tmux does not put the socket directly in $TMUX_TMPDIR — it nests a per-uid
// `tmux-<uid>` directory underneath it. That is exactly why the default socket
// dir is /tmp/tmux-<uid>: TMUX_TMPDIR defaults to /tmp.
function sockDir(tmpdir) {
  return path.join(tmpdir ?? '/tmp', `tmux-${process.getuid()}`);
}
const DEFAULT_TMUX_DIR = sockDir(null);

function sockName() {
  return 'pwtmuxsrvtest-' + crypto.randomBytes(4).toString('hex');
}
async function tmux(sock, args, env = {}) {
  return execFileAsync('tmux', ['-L', sock, ...args], { env: { ...process.env, ...env } });
}
async function killSock(sock, tmpdir) {
  const envs = tmpdir ? [{ TMUX_TMPDIR: tmpdir }, {}] : [{}];
  for (const env of envs) {
    try { await tmux(sock, ['kill-server'], env); } catch { /* already gone */ }
  }
  for (const dir of [tmpdir ? sockDir(tmpdir) : null, DEFAULT_TMUX_DIR].filter(Boolean)) {
    try { await fsp.rm(path.join(dir, sock), { force: true }); } catch { /* fine */ }
  }
}

// The keepalive never exits by design (it idles in the foreground to hold the
// cgroup open), so run it detached, wait for the server it spawned to come up,
// then kill it. The tmux server is daemonized independently and outlives it.
async function runKeepalive(env) {
  const proc = spawn('bash', [KEEPALIVE], {
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return proc;
}
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// --- 1. the keepalive brings up a reachable server in host mode ---------------

test('host mode: keepalive starts a server with _keepalive and exit-empty off', async (t) => {
  const sock = sockName();
  t.after(() => killSock(sock));
  const proc = await runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => { try { process.kill(-proc.pid); } catch { /* gone */ } try { proc.kill(); } catch { /* gone */ } });

  const up = await waitFor(async () => {
    try { await tmux(sock, ['has-session', '-t', '_keepalive']); return true; } catch { return false; }
  });
  assert.ok(up, 'keepalive session should exist on the shared server');

  const { stdout } = await tmux(sock, ['show-options', '-s']);
  assert.match(stdout, /exit-empty off/, 'server must not exit when the last project session closes');
});

test('host mode: keepalive is idempotent — a second run adopts, never duplicates', async (t) => {
  const sock = sockName();
  t.after(() => killSock(sock));
  const first = await runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => { try { first.kill(); } catch { /* gone */ } });
  assert.ok(await waitFor(async () => {
    try { await tmux(sock, ['has-session', '-t', '_keepalive']); return true; } catch { return false; }
  }), 'first run should bring the server up');

  const { stdout: pidBefore } = await tmux(sock, ['display-message', '-p', '#{pid}']);
  // A real project session, to prove a second start cannot disturb existing work.
  await tmux(sock, ['new-session', '-d', '-s', 'pw_Demo', 'sleep 600']);

  const second = await runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => { try { second.kill(); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 1500));

  const { stdout: pidAfter } = await tmux(sock, ['display-message', '-p', '#{pid}']);
  assert.equal(pidAfter.trim(), pidBefore.trim(), 'second run must adopt the running server, not replace it');

  const { stdout: sessions } = await tmux(sock, ['list-sessions', '-F', '#{session_name}']);
  const names = sessions.trim().split('\n').sort();
  assert.deepEqual(names, ['_keepalive', 'pw_Demo'], 'existing project session must survive; no duplicate keepalive');
});

test('keepalive exits non-zero when the server dies, so the supervisor restarts it', async (t) => {
  const sock = sockName();
  t.after(() => killSock(sock));
  const proc = spawn('bash', [KEEPALIVE], {
    env: { ...process.env, PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock, PW_TMUX_WATCH_INTERVAL: '1' },
    stdio: 'ignore',
  });
  t.after(() => { try { proc.kill(); } catch { /* gone */ } });

  assert.ok(await waitFor(async () => {
    try { await tmux(sock, ['has-session', '-t', '_keepalive']); return true; } catch { return false; }
  }), 'server should come up');

  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  // Simulate the server dying underneath us (crash / OOM / kill-server).
  await tmux(sock, ['kill-server']).catch(() => {});

  const code = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r('timeout'), 15000)),
  ]);
  assert.notEqual(code, 'timeout', 'keepalive must not idle forever behind a dead server');
  assert.notEqual(code, 0, 'must exit non-zero so Restart= brings it back and re-runs the restore');
});

// The regression that would silently recreate the original symptom.
test('host mode ignores an inherited TMUX_TMPDIR so it shares the terminals’ socket', async (t) => {
  const sock = sockName();
  const tmpdir = await fsp.mkdtemp('/tmp/pw-tmux-hostmode-');
  t.after(() => killSock(sock, tmpdir));
  t.after(() => fsp.rm(tmpdir, { recursive: true, force: true }));

  const proc = await runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock, TMUX_TMPDIR: tmpdir });
  t.after(() => { try { proc.kill(); } catch { /* gone */ } });

  assert.ok(await waitFor(() => fs.existsSync(path.join(DEFAULT_TMUX_DIR, sock))),
    'host mode must put the socket in tmux’s default dir — the one project-terminal-start attaches to');
  assert.ok(!fs.existsSync(path.join(sockDir(tmpdir), sock)),
    'host mode must NOT honour TMUX_TMPDIR: a second server there would be invisible to every terminal');
});

test('container mode still honours TMUX_TMPDIR (sidecar behaviour unchanged)', async (t) => {
  const sock = sockName();
  const tmpdir = await fsp.mkdtemp('/tmp/pw-tmux-container-');
  t.after(() => killSock(sock, tmpdir));
  t.after(() => fsp.rm(tmpdir, { recursive: true, force: true }));

  // No PW_TMUX_HOST_MODE → the sidecar path.
  const proc = await runKeepalive({ PW_TMUX_SOCKET: sock, TMUX_TMPDIR: tmpdir });
  t.after(() => { try { proc.kill(); } catch { /* gone */ } });

  assert.ok(await waitFor(() => fs.existsSync(path.join(sockDir(tmpdir), sock))),
    'container mode must keep using the shared TMUX_TMPDIR bind mount');
  assert.ok(!fs.existsSync(path.join(DEFAULT_TMUX_DIR, sock)),
    'container mode must not fall back to the host default socket dir');
});

// --- 2. the systemd contract -------------------------------------------------

function unit(name) {
  return fs.readFileSync(path.join(SYSTEMD, name), 'utf8');
}
// Directives may legitimately repeat (After=, Wants=, Environment=), so collect all.
function directives(text, key) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(key + '='))
    .map((l) => l.slice(key.length + 1).trim());
}

test('pw-tmux-server.service owns the server and self-heals', () => {
  const u = unit('pw-tmux-server.service');
  assert.deepEqual(directives(u, 'OOMPolicy'), ['continue'],
    'an OOM-killed pane must not fail the owning unit — that is the original bug one level up');
  assert.ok(directives(u, 'Environment').includes('PW_TMUX_HOST_MODE=1'),
    'must run the keepalive in host mode so it shares the terminals’ default socket');
  assert.ok(directives(u, 'ExecStart').some((v) => v.includes('pw-tmux-keepalive')),
    'must hold the server open via the keepalive');
  assert.ok(directives(u, 'ExecStartPost').some((v) => v.includes('pw-tmux-restore')),
    'a server coming back mid-uptime must replay the manifest, not just at boot');
  assert.ok(directives(u, 'ExecStartPost').every((v) => v.startsWith('-')),
    'a restore failure must never fail the server unit');
  assert.deepEqual(directives(u, 'Restart'), ['always']);
  assert.deepEqual(directives(u, 'MemoryAccounting'), ['yes']);
  assert.equal(directives(u, 'MemoryHigh').length, 0,
    'MemoryHigh belongs in the install-time drop-in: a percentage is wrong under LXC and a literal is wrong on a smaller box');
});

test('terminal units attach as clients and never reap the server', () => {
  for (const name of ['project-terminal@.service', 'project-setup-terminal.service']) {
    const u = unit(name);
    assert.deepEqual(directives(u, 'OOMPolicy'), ['continue'], `${name}: OOM-killed pane must not fail the unit`);
    assert.deepEqual(directives(u, 'KillMode'), ['process'], `${name}: stopping ttyd must not tear down the cgroup`);
    assert.ok(directives(u, 'After').includes('pw-tmux-server.service'), `${name}: must start after the server owner`);
    assert.ok(directives(u, 'Wants').includes('pw-tmux-server.service'), `${name}: must pull in the server owner`);
    assert.ok(!directives(u, 'Requires').includes('pw-tmux-server.service'),
      `${name}: Wants= not Requires= — a server problem must never block the terminal`);
  }
});

test('restore is ordered after the unit that owns the server', () => {
  const u = unit('pw-tmux-persist.service');
  assert.ok(directives(u, 'After').includes('pw-tmux-server.service'),
    'restoring before the owner exists would start the server in the WRONG cgroup');
});

test('install.sh ships the keepalive and enables the owner before the restore', () => {
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.match(sh, /pw-tmux-keepalive\.sh"?\s+\/usr\/local\/bin\/pw-tmux-keepalive/,
    'the unit’s ExecStart is useless if the script is not installed');
  assert.match(sh, /systemd\/pw-tmux-server\.service"?\s+\/etc\/systemd\/system\/pw-tmux-server\.service/);
  const iServer = sh.indexOf('enable --now pw-tmux-server.service');
  const iPersist = sh.indexOf('enable --now pw-tmux-persist.service');
  assert.ok(iServer > -1 && iPersist > -1, 'both units must be enabled');
  assert.ok(iServer < iPersist, 'the server owner must be enabled before the restore that depends on it');
  assert.match(sh, /pw-tmux-server\.service\.d\/memory\.conf/, 'MemoryHigh drop-in must be seeded at install time');
  assert.match(sh, /MemTotal/, 'the drop-in must be sized from the real MemTotal, not a percentage');
});
