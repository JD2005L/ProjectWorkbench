// pw-tmux-server.service owns the shared tmux server in its OWN cgroup, so no per-project ttyd unit
// can take every project's sessions down with it.
//
// The bug this locks down (PVI2, 2026-08-03): in host mode the server had no unit, so
// `tmux new-session` inside project-terminal-start parented it to whichever
// project-terminal@<project>.service started first. Every project's panes landed in that one
// per-project cgroup; a single OOM-killed pane failed the unit and, under systemd's default
// KillMode=control-group, tore the whole cgroup down — killing the server and every project's
// sessions mid-uptime. pw-tmux-persist only restores at BOOT, and the host had been up 5 weeks, so
// nothing ever replayed it.
//
// HJ-24-1 found that adding the unit was not enough. With `Type=simple` systemd considered the unit
// started as soon as the keepalive was FORKED, so the `After=` barrier could release before the
// server existed and a cold-boot terminal could still win the race. `ExecStartPost=pw-tmux-restore`
// hid this whenever a manifest existed — restore starts the server itself, in the owner's cgroup —
// so the reproduction must use the NO-MANIFEST path, where restore returns in milliseconds.
//
// HOW OWNERSHIP IS PROVEN HERE, and what each half actually proves:
//
//   * PROCESS ownership, with real processes. The keepalive exports PW_TMUX_OWNER before creating
//     the server, so the tmux daemon inherits it and /proc/<server>/environ carries proof of which
//     process created it. The negative control — letting a client create the server first — has no
//     marker, so the assertion demonstrably discriminates rather than being vacuously true.
//   * CGROUP ownership, against a faked /proc. Every process in this test shares the runner's
//     cgroup, so a real-process cgroup comparison could not discriminate here even though it is the
//     property the incident was about. PW_TMUX_PROC_ROOT lets the cgroup branch be exercised
//     directly with controlled content — which is also how GOA can run it, with no systemd at all.
//   * INHERITANCE, with real processes: the server's cgroup is asserted to equal its CREATOR's.
//     That is the causal chain behind the incident, and it is what makes the owner unit work.
//
// Every tmux environment here is built through test/tmux-env.mjs, which strips ambient TMUX,
// TMUX_PANE and TMUX_TMPDIR (GOA-7) and keeps socket paths inside sun_path's 108-byte limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizedTmuxEnv, sockDir, HOST_SOCK_DIR, sockName, shortSockRoot, killTestSock, sockExists, waitFor,
} from './tmux-env.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEPALIVE = path.join(REPO, 'scripts', 'pw-tmux-keepalive.sh');
const ASSERT_OWNER = path.join(REPO, 'scripts', 'pw-tmux-assert-owner');
const TERMINAL_START = path.join(REPO, 'scripts', 'project-terminal-start');
const SYSTEMD = path.join(REPO, 'systemd');

/** A tmux client that resolves the same socket the script does — never the ambient one. */
async function tmux(sock, args, env = {}) {
  return execFileAsync('tmux', ['-L', sock, ...args], { env: sanitizedTmuxEnv(env) });
}
async function tmuxOut(sock, args, env = {}) {
  const { stdout } = await tmux(sock, args, env);
  return stdout.trim();
}
async function serverPid(sock, env = {}) {
  try { return await tmuxOut(sock, ['display-message', '-p', '#{pid}'], env); } catch { return ''; }
}
async function hasKeepalive(sock, env = {}) {
  try { await tmux(sock, ['has-session', '-t', '_keepalive'], env); return true; } catch { return false; }
}
async function procEnviron(pid) {
  const raw = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}
async function procCgroup(pid) {
  return (await fsp.readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
}

/**
 * The keepalive never exits by design (it holds the cgroup open), so run it detached, then kill it.
 * The tmux server is daemonized independently and outlives it — which is the whole point.
 */
function runKeepalive(env, { detached = true } = {}) {
  const proc = spawn('bash', [KEEPALIVE], {
    env: sanitizedTmuxEnv(env),
    detached,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderrText = '';
  proc.stderr.on('data', (d) => { proc.stderrText += String(d); });
  if (detached) proc.unref();
  return proc;
}
function stop(proc) {
  try { process.kill(-proc.pid); } catch { /* gone */ }
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
}

/**
 * A stand-in `systemd-notify` that records WHAT WAS TRUE at the moment readiness was signalled.
 * Asserting on its contents is what makes the readiness claim falsifiable: it is not enough that the
 * session eventually exists, it has to exist BEFORE systemd releases the ordering barrier.
 */
async function notifyStub(dir, sock) {
  const bin = path.join(dir, 'systemd-notify');
  await fsp.writeFile(bin, [
    '#!/bin/bash',
    '{',
    '  echo "argv=$*"',
    `  echo "sessions=$(command tmux -L ${sock} list-sessions -F '#{session_name}' 2>&1 | tr '\\n' ',')"`,
    `  echo "pid=$(command tmux -L ${sock} display-message -p '#{pid}' 2>&1)"`,
    '} > "$PW_NOTIFY_LOG"',
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

// --- 1. readiness, and the cold-start race it closes ----------------------------------------

test('REGRESSION (HJ-24-1): with NO manifest, readiness is signalled only after the server and _keepalive are live', { timeout: 30000 }, async (t) => {
  const sock = sockName('ready');
  const dir = await fsp.mkdtemp('/tmp/pwt-ready');
  const stateDir = path.join(dir, 'state');          // exists, deliberately EMPTY: no manifest
  await fsp.mkdir(stateDir);
  await notifyStub(dir, sock);
  const notifyLog = path.join(dir, 'notify.log');
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const proc = runKeepalive({
    PW_TMUX_HOST_MODE: '1',
    PW_TMUX_SOCKET: sock,
    PW_TMUX_STATE_DIR: stateDir,
    NOTIFY_SOCKET: '/run/systemd/notify',   // what systemd sets for Type=notify
    PW_NOTIFY_LOG: notifyLog,
    PATH: `${dir}:${process.env.PATH}`,
  });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => fs.existsSync(notifyLog), 15000),
    `readiness was never signalled; keepalive said:\n${proc.stderrText}`);
  const log = await fsp.readFile(notifyLog, 'utf8');

  assert.match(log, /argv=--ready/, 'the unit is Type=notify, so readiness must be an explicit --ready');
  assert.match(log, /sessions=[^\n]*_keepalive/,
    'THE REGRESSION: readiness fired while the server had no _keepalive session, so the After= barrier '
    + 'released terminals against a server that did not exist yet');
  const notifiedPid = /pid=(\d+)/.exec(log)?.[1];
  assert.ok(notifiedPid, `no server pid at readiness time:\n${log}`);
  assert.equal(await serverPid(sock), notifiedPid, 'the server live now must be the one that existed at readiness');
});

test('REGRESSION (HJ-24-1): a terminal released by the readiness barrier cannot become the server creator', { timeout: 30000 }, async (t) => {
  // The proof is process ownership, not unit text: the server's own /proc/<pid>/environ names the
  // process that created it. A client that attaches to a server it did not create cannot forge that.
  const sock = sockName('race');
  const dir = await fsp.mkdtemp('/tmp/pwt-race');
  const stateDir = path.join(dir, 'state');
  await fsp.mkdir(stateDir);
  await notifyStub(dir, sock);
  const notifyLog = path.join(dir, 'notify.log');
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const proc = runKeepalive({
    PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock, PW_TMUX_STATE_DIR: stateDir,
    NOTIFY_SOCKET: '/run/systemd/notify', PW_NOTIFY_LOG: notifyLog, PATH: `${dir}:${process.env.PATH}`,
  });
  t.after(() => stop(proc));

  // systemd releases After= only once readiness lands; the client below stands in for that release.
  assert.ok(await waitFor(() => fs.existsSync(notifyLog), 15000), `no readiness:\n${proc.stderrText}`);

  const before = await serverPid(sock);
  assert.ok(before, 'the owner must be holding a server by the time terminals are released');
  const ownerEnv = await procEnviron(before);
  assert.equal(ownerEnv.PW_TMUX_OWNER, 'pw-tmux-server',
    'the server must carry the dedicated owner marker it inherited at creation');

  // A terminal client doing exactly what project-terminal-start does.
  await tmux(sock, ['-u', 'new-session', '-d', '-A', '-s', 'pw_Demo', 'sleep 600']);
  const after = await serverPid(sock);
  assert.equal(after, before, 'the client must attach to the owner’s server, never replace or re-create it');
  assert.equal((await procEnviron(after)).PW_TMUX_OWNER, 'pw-tmux-server',
    'and the surviving server must still be the owner’s');

  // Inheritance: the server lives in its CREATOR's cgroup. That is the mechanism behind the
  // incident — whoever created it decides which cgroup teardown kills the sessions.
  assert.equal(await procCgroup(after), await procCgroup(proc.pid),
    'the tmux server inherits the cgroup of the process that created it');
});

test('NEGATIVE CONTROL: a server created by a terminal client carries no owner marker at all', { timeout: 20000 }, async (t) => {
  // Without this, the assertions above could pass vacuously. This is the pre-fix topology, created
  // deliberately, and it must be distinguishable.
  const sock = sockName('foreign');
  t.after(() => killTestSock(execFileAsync, sock));

  await tmux(sock, ['-u', 'new-session', '-d', '-s', 'pw_Demo', 'sleep 600']);
  const pid = await serverPid(sock);
  assert.ok(pid, 'the client did create a server — that is the bug being reproduced');
  const env = await procEnviron(pid);
  assert.equal(env.PW_TMUX_OWNER, undefined,
    'a client-created server has no owner marker: this is what makes the ownership assertion meaningful');

  const rc = await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_OWNER_CGROUP: '' });
  assert.equal(rc.code, 4, `a foreign-owned server must be reported as foreign, got ${rc.code}: ${rc.stderr}`);
});

test('the owner refuses to report ready when the server cannot be brought up', { timeout: 20000 }, async (t) => {
  // HJ-24-2's "owner start failure" and "crash before readiness": the unit start must FAIL rather
  // than sit active with nothing behind it, because an active-but-empty owner releases every
  // terminal against a server that does not exist.
  const sock = sockName('nostart');
  const dir = await fsp.mkdtemp('/tmp/pwt-nostart');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // A tmux that always fails, so the keepalive's own verification is what is under test.
  await fsp.writeFile(path.join(dir, 'tmux'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  await notifyStub(dir, sock);
  const notifyLog = path.join(dir, 'notify.log');

  const proc = runKeepalive({
    PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock,
    NOTIFY_SOCKET: '/run/systemd/notify', PW_NOTIFY_LOG: notifyLog, PATH: `${dir}:${process.env.PATH}`,
  }, { detached: false });
  t.after(() => stop(proc));

  const code = await Promise.race([
    new Promise((r) => proc.on('exit', (c) => r(c))),
    new Promise((r) => setTimeout(() => r('timeout'), 15000)),
  ]);
  assert.notEqual(code, 'timeout', 'the owner must not idle forever having failed to create the server');
  assert.notEqual(code, 0, 'a start that cannot produce a server must fail the unit');
  assert.equal(fs.existsSync(notifyLog), false, 'and it must never have claimed readiness');
  assert.match(proc.stderrText, /refusing to report ready/);
});

test('container mode never needs systemd-notify — an absent notifier must not stop supervision', { timeout: 20000 }, async (t) => {
  // A GOA constraint: there is no systemd inside the sidecar. Readiness signalling is conditional on
  // NOTIFY_SOCKET, and its absence must never become an exit path.
  const sock = sockName('nonotify');
  const root = await shortSockRoot('n');
  t.after(() => killTestSock(execFileAsync, sock, [root]));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const proc = runKeepalive({ PW_TMUX_SOCKET: sock, TMUX_TMPDIR: root });  // no PW_TMUX_HOST_MODE
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => hasKeepalive(sock, { TMUX_TMPDIR: root }), 15000),
    `the sidecar must come up with no NOTIFY_SOCKET at all:\n${proc.stderrText}`);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(proc.exitCode, null, 'and it must still be supervising, not exited');
});

// --- 2. the keepalive's own behaviour (reconciled from PR #24) ------------------------------

test('host mode: keepalive starts a server with _keepalive and exit-empty off', { timeout: 20000 }, async (t) => {
  const sock = sockName('host');
  t.after(() => killTestSock(execFileAsync, sock));
  const proc = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => hasKeepalive(sock), 15000),
    `keepalive session should exist on the shared server:\n${proc.stderrText}`);
  assert.match(await tmuxOut(sock, ['show-options', '-s']), /exit-empty off/,
    'server must not exit when the last project session closes');
});

test('host mode: keepalive is idempotent — a second run adopts, never duplicates', { timeout: 25000 }, async (t) => {
  const sock = sockName('idem');
  t.after(() => killTestSock(execFileAsync, sock));
  const first = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => stop(first));
  assert.ok(await waitFor(() => hasKeepalive(sock), 15000), `first run should bring the server up:\n${first.stderrText}`);

  const pidBefore = await serverPid(sock);
  await tmux(sock, ['new-session', '-d', '-s', 'pw_Demo', 'sleep 600']);

  const second = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => stop(second));
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(await serverPid(sock), pidBefore, 'second run must adopt the running server, not replace it');
  const names = (await tmuxOut(sock, ['list-sessions', '-F', '#{session_name}'])).split('\n').sort();
  assert.deepEqual(names, ['_keepalive', 'pw_Demo'], 'existing project session must survive; no duplicate keepalive');
});

test('keepalive exits non-zero when the server dies, so the supervisor restarts it', { timeout: 30000 }, async (t) => {
  const sock = sockName('death');
  t.after(() => killTestSock(execFileAsync, sock));
  const proc = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock, PW_TMUX_WATCH_INTERVAL: '1' }, { detached: false });
  t.after(() => stop(proc));
  assert.ok(await waitFor(() => hasKeepalive(sock), 15000), `server should come up:\n${proc.stderrText}`);

  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  await tmux(sock, ['kill-server']).catch(() => {});   // crash / OOM / stray kill-server

  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  assert.notEqual(code, 'timeout', 'keepalive must not idle forever behind a dead server');
  assert.notEqual(code, 0, 'must exit non-zero so Restart= brings it back and re-runs the restore');
});

test('REGRESSION (GOA-7): host mode ignores an adversarial ambient TMUX_TMPDIR, and the test client agrees', { timeout: 20000 }, async (t) => {
  // Both halves matter. The script must resolve the per-user default socket (the one the terminals
  // attach to) even when TMUX_TMPDIR is set, AND the test's own client must resolve the same one —
  // the original harness inherited the ambient value and timed out against a live server.
  const sock = sockName('ambient');
  const root = await shortSockRoot('a');
  t.after(() => killTestSock(execFileAsync, sock, [root]));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const proc = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock, TMUX_TMPDIR: root });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => sockExists(sock, null), 15000),
    `host mode must put the socket in tmux's default dir — the one project-terminal-start attaches to:\n${proc.stderrText}`);
  assert.equal(sockExists(sock, root), false,
    'host mode must NOT honour TMUX_TMPDIR: a second server there would be invisible to every terminal');
  assert.ok(await hasKeepalive(sock), 'and a sanitized client must reach it');
});

test('container mode still honours TMUX_TMPDIR (sidecar behaviour unchanged)', { timeout: 20000 }, async (t) => {
  const sock = sockName('cont');
  const root = await shortSockRoot('k');
  t.after(() => killTestSock(execFileAsync, sock, [root]));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const proc = runKeepalive({ PW_TMUX_SOCKET: sock, TMUX_TMPDIR: root });   // no PW_TMUX_HOST_MODE
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => sockExists(sock, root), 15000),
    `container mode must keep using the shared TMUX_TMPDIR bind mount:\n${proc.stderrText}`);
  assert.equal(sockExists(sock, null), false, 'container mode must not fall back to the host default socket dir');
  assert.ok(await hasKeepalive(sock, { TMUX_TMPDIR: root }), 'and a client pointed at the same root must reach it');
});

test('GOA-2: restore-on-start replays into the server this process owns, and never costs the instance its supervisor', { timeout: 25000 }, async (t) => {
  const sock = sockName('restore');
  const dir = await fsp.mkdtemp('/tmp/pwt-restore');
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'restore-ran');
  const failing = path.join(dir, 'restore-fails');
  await fsp.writeFile(marker, '');
  await fsp.writeFile(failing, `#!/bin/bash\necho ran >> ${marker}\nexit 78\n`, { mode: 0o755 });

  const proc = runKeepalive({
    PW_TMUX_SOCKET: sock, PW_TMUX_HOST_MODE: '1',
    PW_TMUX_RESTORE_ON_START: '1', PW_TMUX_RESTORE_BIN: failing,
  });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => hasKeepalive(sock), 15000), `the server must come up:\n${proc.stderrText}`);
  assert.match(await fsp.readFile(marker, 'utf8'), /ran/, 'the replay must actually be invoked');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(proc.exitCode, null,
    'a restore that reports a configuration failure must not stop the process whose job is to hold the server');
  assert.match(proc.stderrText, /restore-on-start exited/, 'and the failure must be visible in the journal');
});

// --- 3. the ownership assertion, including the faked-/proc cgroup branch ---------------------

async function runAssertOwner(env = {}, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(ASSERT_OWNER, args, {
      env: sanitizedTmuxEnv({ PW_ENV_FILE: '/nonexistent/pw.env', ...env }),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

/** A /proc root containing exactly what we want the assertion to read for this pid. */
async function fakeProc(dir, pid, { environ = {}, cgroup = '0::/system.slice/pw-tmux-server.service' } = {}) {
  const procDir = path.join(dir, String(pid));
  await fsp.mkdir(procDir, { recursive: true });
  await fsp.writeFile(path.join(procDir, 'environ'),
    Object.entries(environ).map(([k, v]) => `${k}=${v}`).join('\0') + (Object.keys(environ).length ? '\0' : ''));
  await fsp.writeFile(path.join(procDir, 'cgroup'), `${cgroup}\n`);
  return dir;
}

test('pw-tmux-assert-owner: no server at all is "nothing to attach to", not "foreign"', async () => {
  const rc = await runAssertOwner({ PW_TMUX_SOCKET: sockName('none'), PW_DEPLOY_MODE: 'host' });
  assert.equal(rc.code, 3);
  assert.match(rc.stderr, /no tmux server/);
});

test('pw-tmux-assert-owner: the cgroup branch, exercised against a faked /proc', { timeout: 20000 }, async (t) => {
  // Every process in this test shares the runner's cgroup, so a real-process comparison could not
  // discriminate. This is the branch that encodes the actual incident: which cgroup dies.
  const sock = sockName('cg');
  const dir = await fsp.mkdtemp('/tmp/pwt-cg');
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await tmux(sock, ['-u', 'new-session', '-d', '-s', 'pw_Demo', 'sleep 600']);
  const pid = await serverPid(sock);

  const good = await fakeProc(path.join(dir, 'good'), pid, {
    environ: { PW_TMUX_OWNER: 'pw-tmux-server' },
    cgroup: '0::/system.slice/pw-tmux-server.service',
  });
  assert.equal((await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_PROC_ROOT: good })).code, 0,
    'owner marker + owner cgroup is the only clean answer');

  const wrongCgroup = await fakeProc(path.join(dir, 'wrong'), pid, {
    environ: { PW_TMUX_OWNER: 'pw-tmux-server' },
    cgroup: '0::/system.slice/system-project\\x2dterminal.slice/project-terminal@Demo.service',
  });
  const wrong = await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_PROC_ROOT: wrongCgroup });
  assert.equal(wrong.code, 4, 'a server sitting in a per-project ttyd cgroup is exactly the 2026-08-03 topology');
  assert.match(wrong.stderr, /not in the owner cgroup/);

  const noMarker = await fakeProc(path.join(dir, 'nomarker'), pid, { environ: { HOME: '/home/admin' } });
  assert.equal((await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_PROC_ROOT: noMarker })).code, 4,
    'no owner marker means the server was not created by the owner');

  const unreadable = path.join(dir, 'empty-proc');
  await fsp.mkdir(unreadable, { recursive: true });
  assert.equal((await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_PROC_ROOT: unreadable })).code, 4,
    'a server whose provenance cannot be inspected must not be assumed to be ours');

  // Container mode: the sidecar's cgroup is the container's, not a systemd unit's, so the process
  // marker carries ownership on its own.
  assert.equal((await runAssertOwner({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'container', PW_TMUX_PROC_ROOT: noMarker })).code, 4);
  assert.equal((await runAssertOwner({
    PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'container', PW_TMUX_PROC_ROOT: await fakeProc(path.join(dir, 'sidecar'), pid, {
      environ: { PW_TMUX_OWNER: 'pw-tmux-server' }, cgroup: '0::/',
    }),
  })).code, 0, 'container mode must not demand a host unit cgroup that cannot exist there');
});

test('pw-tmux-assert-owner: an ambiguous deploy mode is a configuration refusal, not a guess', async () => {
  const rc = await runAssertOwner({ PW_TMUX_SOCKET: sockName('amb'), PW_DEPLOY_MODE: 'containr' });
  assert.equal(rc.code, 78);
  assert.match(rc.stderr, /host\|container/);
});

// --- 4. terminal creation fails closed (HJ-24-2) ---------------------------------------------

/**
 * A real registry, so the script gets past its own project lookup and actually reaches the gate.
 * Without it the run dies on "no .path in projects.json" and the gate would appear to pass while
 * never having been consulted.
 */
async function terminalStartFixture() {
  const dir = await fsp.mkdtemp('/tmp/pwt-ts');
  const projPath = path.join(dir, 'Demo');
  await fsp.mkdir(projPath);
  await fsp.writeFile(path.join(dir, 'projects.json'), JSON.stringify([{ name: 'Demo', path: projPath, port: 19731 }]));
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users: [] }));
  return {
    dir,
    env: {
      PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
      PW_USERS_PATH: path.join(dir, 'users.json'),
      PW_APP_DIR: path.join(REPO, 'app'),
      PW_HOST_TERMINAL_USER: os.userInfo().username,
      // The run must END once the gate has been consulted. Without this the script reaches its final
      // `exec ttyd`, which never returns, and a gate that correctly allowed the run would look like
      // a hang rather than a pass.
      PW_TTYD_BIN: '/bin/true',
    },
  };
}

async function runTerminalStart(env = {}, fixture = null) {
  try {
    const { stdout, stderr } = await execFileAsync(TERMINAL_START, ['Demo'], {
      env: sanitizedTmuxEnv({
        PW_ENV_FILE: '/nonexistent/pw.env',
        ...(fixture ? fixture.env : {}),
        ...env,
      }),
      timeout: 20000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

test('REGRESSION (HJ-24-2): terminal creation refuses when no owner is holding the server', { timeout: 20000 }, async (t) => {
  // Owner start failure, and owner crash before readiness, look identical from here: no server. The
  // old behaviour was to create one, which re-parents every project's panes to this ttyd's cgroup.
  const sock = sockName('gate1');
  const fx = await terminalStartFixture();
  t.after(() => fsp.rm(fx.dir, { recursive: true, force: true }));
  const r = await runTerminalStart({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host' }, fx);
  assert.notEqual(r.code, 0, 'a terminal must not start without proven ownership');
  assert.match(r.stderr, /dedicated tmux owner .* is not holding a server yet/);
  assert.match(r.stderr, /systemctl start pw-tmux-server\.service/, 'the refusal has to tell the operator what to do');
  assert.equal(fs.existsSync(path.join(HOST_SOCK_DIR, sock)), false, 'and it must not have created a server on the way out');
});

test('REGRESSION (HJ-24-2): terminal creation refuses against an already-running FOREIGN-owned server', { timeout: 20000 }, async (t) => {
  const sock = sockName('gate2');
  const fx = await terminalStartFixture();
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(fx.dir, { recursive: true, force: true }));
  await tmux(sock, ['-u', 'new-session', '-d', '-s', 'pw_Demo', 'sleep 600']);   // the legacy topology

  const r = await runTerminalStart({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_OWNER_CGROUP: '' }, fx);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not owned by pw-tmux-server\.service/);
  assert.match(r.stderr, /pw-tmux-save/, 'the migration path must be stated, since restarting the owner alone only adopts it');
});

test('the gate is host-mode-only and explicitly opt-out-able', { timeout: 60000 }, async (t) => {
  const sock = sockName('gate3');
  const fx = await terminalStartFixture();
  t.after(() => killTestSock(execFileAsync, sock));
  t.after(() => fsp.rm(fx.dir, { recursive: true, force: true }));

  // Container mode: the sidecar owns the server; there is no host owner unit to prove anything about.
  const container = await runTerminalStart({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'container' }, fx);
  assert.ok(!/dedicated tmux owner/.test(container.stderr),
    `the host ownership gate must not fire in container mode: ${container.stderr}`);

  // And an operator running deliberately without the owner unit can say so.
  const optOut = await runTerminalStart({ PW_TMUX_SOCKET: sock, PW_DEPLOY_MODE: 'host', PW_TMUX_OWNER_REQUIRED: 'false' }, fx);
  assert.ok(!/dedicated tmux owner/.test(optOut.stderr),
    `PW_TMUX_OWNER_REQUIRED=false must disable the gate: ${optOut.stderr}`);
});

// --- 5. the systemd contract ------------------------------------------------------------------

function unit(name) {
  return fs.readFileSync(path.join(SYSTEMD, name), 'utf8');
}
/** Directives may legitimately repeat (After=, Wants=, Environment=), so collect all. */
function directives(text, key) {
  return text.split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1).trim());
}

test('pw-tmux-server.service owns the server, proves readiness, and self-heals', () => {
  const u = unit('pw-tmux-server.service');
  assert.deepEqual(directives(u, 'Type'), ['notify'],
    'Type=simple marks the unit started as soon as the process forks — the HJ-24-1 race');
  assert.deepEqual(directives(u, 'NotifyAccess'), ['all'],
    'the notification comes from the keepalive script, not from the ExecStart binary itself');
  assert.deepEqual(directives(u, 'OOMPolicy'), ['continue'],
    'an OOM-killed pane must not fail the owning unit — that is the original bug one level up');
  assert.ok(directives(u, 'Environment').includes('PW_TMUX_HOST_MODE=1'),
    'must run the keepalive in host mode so it shares the terminals’ default socket');
  assert.ok(directives(u, 'ExecStart').some((v) => v.includes('pw-tmux-keepalive')));
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
      `${name}: Wants= not Requires= — the fail-closed decision belongs to pw-tmux-assert-owner, which can tell `
      + 'a missing owner apart from a foreign one; Requires= would only couple restarts');
  }
});

test('restore is ordered after the unit that owns the server', () => {
  assert.ok(directives(unit('pw-tmux-persist.service'), 'After').includes('pw-tmux-server.service'),
    'restoring before the owner exists would start the server in the WRONG cgroup');
});

test('the keepalive publishes the ownership marker before it creates anything', () => {
  const src = fs.readFileSync(KEEPALIVE, 'utf8');
  const iExport = src.indexOf('export PW_TMUX_OWNER');
  const iStart = src.indexOf('tmux -u start-server');
  assert.ok(iExport > -1 && iStart > -1);
  assert.ok(iExport < iStart,
    'the tmux daemon inherits the environment it was created with — a marker exported afterwards proves nothing');
  const iReady = src.indexOf('--ready');
  const iVerify = src.indexOf('refusing to report ready');
  assert.ok(iVerify > -1 && iVerify < iReady, 'readiness must come after the verification, not before it');
});
