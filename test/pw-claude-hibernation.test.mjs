// scripts/pw-claude-hibernate stops idle Claude Code processes to give their memory back. Every
// guarantee it makes is about what the user does NOT lose, so this suite checks those guarantees
// against real tmux and a real process tree:
//
//   * the window survives with the same window id, pane id, name and cwd, and a shell at its prompt;
//   * the exact conversation id is recorded on the window and in the manifest (hasc=2);
//   * opening the window again resumes that same conversation, in that same pane, exactly once;
//   * a session it must not touch (busy, recently used, doing background work, run as the pane's own
//     process, an orchestrator lane, a reused pid) is left running, and the reason is reported.
//
// Claude itself is replaced by a small stand-in that behaves the way the hibernator depends on: it
// writes a registry entry naming its pid, procStart and pane, honours --resume, and exits on SIGTERM.
// Every tmux server is private and created through the shared fixture.
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
import { taskWindowIsIdle } from '../app/scheduled-tasks.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIBERNATE = path.join(REPO, 'scripts', 'pw-claude-hibernate');
const SAVE = path.join(REPO, 'scripts', 'pw-tmux-save');
const WAIT = path.join(REPO, 'scripts', 'pw-claude-wait');
const WAKE = path.join(REPO, 'scripts', 'pw-claude-wake');
// The placeholder the live windows were armed with before refresh existed (pw-claude-wait at c819d9a).
const WAIT_C819D9A = path.join(REPO, 'test', 'fixtures', 'pw-claude-wait-c819d9a');
const REFUSED = 75;
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in for Claude Code.
const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
const args = process.argv.slice(2);
const sid = args[args.indexOf('--resume') + 1 || args.indexOf('--session-id') + 1];
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const procStart = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]);
const tmuxRef = execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}:#{window_id}.#{pane_id}'], { encoding: 'utf8' }).trim();
const reg = path.join(process.env.PW_CLAUDE_SESSIONS_DIR, process.pid + '.json');
// Like Claude Code 2.1.270 on a conversation it cannot load: says so and exits 1 before registering.
if (args.includes('--resume') && process.env.FAKE_FAIL_FILE && fs.existsSync(process.env.FAKE_FAIL_FILE)) {
  fs.appendFileSync(process.env.FAKE_LOG, 'failed-resume ' + sid + '\\n');
  if (process.env.FAKE_FOREIGN === '1') {
    // Dead registry entries that appear during the attempt but were never this window's conversation. Their pids
    // are above pid_max, so no process can have them.
    const nobody = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8')) + 1000;
    const [, windowPane] = tmuxRef.split(':');
    const foreign = {
      print: { kind: 'print', tmux: tmuxRef, procStart: String(procStart) },         // a nested claude -p in this pane
      otherWindow: { kind: 'interactive', tmux: 'pw_elsewhere:@9999.' + windowPane.split('.')[1], procStart: String(procStart) }, // same pane id, another window
      older: { kind: 'interactive', tmux: tmuxRef, procStart: '1' },                   // started before this placeholder
    };
    Object.entries(foreign).forEach(([name, e], i) => {
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(process.env.PW_CLAUDE_PROJECTS_DIR, 'proj', id + '.jsonl'), '{"type":"user"}\\n');
      fs.writeFileSync(path.join(process.env.PW_CLAUDE_SESSIONS_DIR, (nobody + i) + '.json'), JSON.stringify({ pid: nobody + i, sessionId: id, ...e }));
      fs.appendFileSync(process.env.FAKE_LOG, 'foreign ' + name + ' ' + id + '\\n');
    });
  }
  process.stdout.write('No conversation found with session ID: ' + sid + '\\r\\n');
  process.exit(1);
}
if (args.includes('--resume')) fs.appendFileSync(process.env.FAKE_LOG, 'resume ' + sid + ' pane=' + process.env.TMUX_PANE + '\\n');
if (process.env.FAKE_CHILD === '1') spawn('sleep', ['300'], { stdio: 'ignore' });
if (process.env.FAKE_CHATTER === '1') setInterval(() => process.stdout.write('.'), 300);
// Anything typed into a resumed conversation is recorded: a stray Enter would show up here.
// Like the real TUI: the terminal in raw mode, which a Claude killed outright cannot undo.
if (args.includes('--resume') && process.env.FAKE_RAW === '1' && process.stdin.isTTY) process.stdin.setRawMode(true);
if (args.includes('--resume')) process.stdin.on('data', (d) => {
  fs.appendFileSync(process.env.FAKE_LOG, 'input ' + JSON.stringify(String(d)) + '\\n');
  if (String(d).trim() === '/exit') { try { fs.rmSync(reg); } catch {} process.exit(0); } // ended on purpose
  if (String(d).trim() === '/clear') { // like Claude Code 2.1.270: a new conversation, and the registry entry follows it
    entry.sessionId = crypto.randomUUID();
    fs.writeFileSync(path.join(process.env.PW_CLAUDE_PROJECTS_DIR, 'proj', entry.sessionId + '.jsonl'), '{"type":"user","message":{"content":"/clear"}}\\n');
    fs.writeFileSync(reg, JSON.stringify(entry));
    fs.appendFileSync(process.env.FAKE_LOG, 'clear ' + entry.sessionId + '\\n');
  }
});
const entry = { pid: process.pid, sessionId: sid, procStart, status: process.env.FAKE_STATUS || 'idle', kind: 'interactive', tmux: tmuxRef };
if (process.env.FAKE_PROCSTART_OFFSET) entry.procStart += Number(process.env.FAKE_PROCSTART_OFFSET);
entry.procStart = String(entry.procStart); // Claude Code 2.1.x writes it as a JSON string
fs.writeFileSync(reg, JSON.stringify(entry));
const bye = () => { try { fs.rmSync(reg); } catch {} process.exit(0); };
if (process.env.FAKE_IGNORE_TERM === '1') { process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); }
else if (process.env.FAKE_EXIT_NOISE === '1') {
  // Real Claude Code: the wrapper (job leader) exits first, bash prints its prompt, then Claude's own
  // late exit message lands on top of that prompt.
  const late = () => setTimeout(() => { process.stdout.write('\\r\\x1b[2KResume this session with:\\r\\nclaude --resume ' + sid + '\\r\\n\\x1b[2K'); bye(); }, 400);
  process.on('SIGTERM', late); process.on('SIGINT', late);
} else { process.on('SIGTERM', bye); process.on('SIGINT', bye); }
setInterval(() => {}, 1 << 30);
`;

async function tmux(sock, args) {
  const env = { ...process.env };
  delete env.TMUX;
  return (await execFileAsync('tmux', ['-L', sock, ...args], { env })).stdout.replace(/\n$/, '');
}
const opt = (ctx, target, name) => tmux(ctx.sock, ['show-options', '-wqv', '-t', target, name]);

async function until(check, timeoutMs = 10000, stepMs = 100) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(stepMs)) if (await check()) return true;
  return check();
}

async function setup({ owned = true } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-hib-'));
  const sock = 'pwhibtest-' + crypto.randomBytes(4).toString('hex');
  const paths = {
    reg: path.join(dir, 'claude-sessions'),
    projects: path.join(dir, 'claude-projects'),
    state: path.join(dir, 'tmux-persist'),
    work: path.join(dir, 'work'),
    fake: path.join(dir, 'bin', 'fake-claude'),
    fakeLog: path.join(dir, 'fake-claude.log'),
  };
  for (const d of [paths.reg, path.join(paths.projects, 'proj'), path.join(paths.state, 'content'), paths.work, path.dirname(paths.fake)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(paths.fake, FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(paths.fakeLog, '');
  let ownerEnv;
  if (owned) {
    ownerEnv = ownedTmuxFixture({ socket: sock, dir });
  } else {
    createFixtureTmuxServer({ socket: sock, session: 'pw_Recovered' });
    ownerEnv = { PATH: `${installOwnerHelper(dir)}:${process.env.PATH}`, PW_DEPLOY_MODE: 'host', PW_TMUX_REQUIRE_CGROUP: '1', PW_TMUX_PROC_ROOT: path.join(dir, 'proc') };
  }
  const env = {
    ...process.env, ...ownerEnv,
    HOME: dir,
    PW_TMUX_SOCKET: sock,
    PW_CLAUDE_SESSIONS_DIR: paths.reg,
    PW_CLAUDE_PROJECTS_DIR: paths.projects,
    PW_TMUX_STATE_DIR: paths.state,
    PW_TMUX_LOG: path.join(paths.state, 'persist.log'),
    PW_CLAUDE_WAIT_BIN: WAIT,
    PW_CLAUDE_WAKE_BIN: WAKE,
  };
  delete env.TMUX;
  return { dir, sock, env, ...paths };
}
async function teardown(ctx) {
  // Stop every stand-in this test started, then the server (whose shells exit as it goes).
  try {
    for (const f of fs.readdirSync(ctx.reg)) {
      try { process.kill(JSON.parse(fs.readFileSync(path.join(ctx.reg, f), 'utf8')).pid, 'SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* no registry */ }
  try { await tmux(ctx.sock, ['kill-server']); } catch { /* gone */ }
  await sleep(200);
  await fsp.rm(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function transcript(ctx, sid, ageMs) {
  const at = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(path.join(ctx.projects, 'proj', `${sid}.jsonl`),
    `{"type":"user","timestamp":"${at}","message":{"content":"hello"}}\n{"type":"assistant","timestamp":"${at}"}\n`);
}

/** A project window whose shell runs the stand-in Claude, exactly like a PW pane running `claude`. */
async function claudeWindow(ctx, { session, name = 'claude', sid = crypto.randomUUID(), idleMs = 10 * DAY, fake = {}, paneRoot = false, lane = false, wrapped = false, nonInteractive = false, interactiveCommand = false, shellArgs = null, jobControlOff = false, shellFlags = '' } = {}) {
  transcript(ctx, sid, idleMs);
  const paneEnv = {
    PATH: process.env.PATH, HOME: ctx.dir, HISTFILE: '/dev/null',
    PW_CLAUDE_SESSIONS_DIR: ctx.reg, PW_CLAUDE_PROJECTS_DIR: ctx.projects,
    PW_CLAUDE_BIN: ctx.fake, FAKE_LOG: ctx.fakeLog, ...fake,
  };
  const envArgs = Object.entries(paneEnv).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ');
  const command = paneRoot ? `env ${envArgs} ${ctx.fake} --session-id ${sid}`
    : nonInteractive ? `env ${envArgs} bash -c '${ctx.fake} --session-id ${sid}; echo after'`
      : interactiveCommand ? `env ${envArgs} bash --norc -ic '${ctx.fake} --session-id ${sid}; echo after'`
      : shellArgs ? `env ${envArgs} bash ${shellArgs} '${ctx.fake} --session-id ${sid}; echo after'`
      : `env ${envArgs} bash --noprofile --norc${shellFlags ? ` ${shellFlags}` : ''}`;
  let exists = false;
  try { await tmux(ctx.sock, ['has-session', '-t', `=${session}`]); exists = true; } catch { /* new */ }
  const target = exists
    ? await tmux(ctx.sock, ['new-window', '-d', '-P', '-F', '#{session_name}:#{window_index}', '-t', `${session}:`, '-n', name, '-c', ctx.work, command])
    : await tmux(ctx.sock, ['new-session', '-d', '-P', '-F', '#{session_name}:#{window_index}', '-s', session, '-n', name, '-c', ctx.work, command]);
  const [windowId, paneId] = (await tmux(ctx.sock, ['display-message', '-p', '-t', target, '#{window_id} #{pane_id}'])).split(' ');
  if (lane) {
    await tmux(ctx.sock, ['set-option', '-w', '-t', windowId, '@pw_role', 'lane']);
    await tmux(ctx.sock, ['set-option', '-w', '-t', windowId, '@pw_session_key', 'k']);
  }
  if (!paneRoot && !nonInteractive && !interactiveCommand && !shellArgs) {
    await until(async () => /\$$/.test((await tmux(ctx.sock, ['capture-pane', '-p', '-t', paneId])).trimEnd()));
    // wrapped: a job leader that dies on the signal at once, with Claude as its child, like the real wrapper.
    // jobControlOff: `set +m` puts Claude in the shell's own process group, so stopping it would signal the shell.
    const launch = wrapped ? `sh -c '${ctx.fake} --session-id ${sid} & wait'`
      : jobControlOff ? `set +m; ${ctx.fake} --session-id ${sid}` : `${ctx.fake} --session-id ${sid}`;
    await tmux(ctx.sock, ['send-keys', '-t', paneId, '-l', launch]);
    await tmux(ctx.sock, ['send-keys', '-t', paneId, 'Enter']);
  }
  assert.ok(await until(() => registryFor(ctx, sid)), `the stand-in Claude for ${sid} must register`);
  const { pid } = registryFor(ctx, sid);
  return { sid, pid, target, windowId, paneId, session };
}
function registryFor(ctx, sid) {
  for (const f of fs.readdirSync(ctx.reg)) {
    try { const d = JSON.parse(fs.readFileSync(path.join(ctx.reg, f), 'utf8')); if (d.sessionId === sid) return d; } catch { /* partial write */ }
  }
  return null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const logLines = (ctx) => fs.readFileSync(ctx.fakeLog, 'utf8').split('\n').filter(Boolean);
const resumes = (ctx) => logLines(ctx).filter((l) => l.startsWith('resume '));
const inputs = (ctx) => logLines(ctx).filter((l) => l.startsWith('input '));
const failedResumes = (ctx) => logLines(ctx).filter((l) => l.startsWith('failed-resume '));
const paneText = (ctx, c) => tmux(ctx.sock, ['capture-pane', '-p', '-J', '-S', '-200', '-t', c.paneId]);
const waiterPid = (value) => Number(/^(\d+)(?::\d+)?$/.exec(value || '')?.[1] || 0);
const clears = (ctx) => logLines(ctx).filter((l) => l.startsWith('clear ')).map((l) => l.slice(6));
const ttyOf = (pid) => fs.readlinkSync(`/proc/${pid}/fd/0`);
const stateOf = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(') ') + 2)[0]; } catch { return ''; } };
async function resumedPid(ctx, c) {
  let pid = null;
  await until(() => { const r = registryFor(ctx, c.sid); pid = r && r.pid !== c.pid && alive(r.pid) ? r.pid : null; return !!pid; }, 15000);
  return pid;
}

function run(ctx, script, args = [], extra = {}) {
  return new Promise((resolve) => {
    execFile(script === SAVE ? 'bash' : process.execPath, script === SAVE ? [SAVE, ...args] : [script, ...args],
      { env: { ...ctx.env, ...extra }, timeout: 90000 }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }));
  });
}
const hibernate = (ctx, args = [], extra) => run(ctx, HIBERNATE, [...args, '--json'], extra).then((r) => ({ ...r, out: r.stdout ? JSON.parse(r.stdout) : null }));

/** A real tmux client, as a person opening the tab would be. */
function attachClient(ctx, session) {
  // A terminal type tmux can drive, as ttyd's xterm.js reports. A CI runner has none, and tmux then refuses
  // to attach ("open terminal failed: terminal does not support clear"), so no client, so no hook.
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.TMUX;
  // stdin stays an open pipe: `script` turns end-of-input into Ctrl-D and would type it into the pane.
  return spawn('script', ['-qfec', `tmux -L ${ctx.sock} attach -t ${session}`, '/dev/null'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
}

async function hibernated(ctx, c) {
  // --idle-minutes 0: the stand-in was started seconds ago, which the in-use rules would otherwise refuse.
  const r = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.acted[0]?.action, 'hibernated', JSON.stringify(r.out));
  assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0), 'the placeholder must be waiting');
  return r;
}

test('dry run: a dormant session is reported and nothing is touched', { timeout: 30000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_dry' });
    const r = await hibernate(ctx, ['--idle-minutes', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out.acted.map((a) => [a.action, a.sid]), [['would-hibernate', c.sid]]);
    assert.ok(alive(c.pid), 'a dry run must not stop anything');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '');
  } finally { await teardown(ctx); }
});

test('hibernating keeps the window, pane, name and cwd, stamps the exact id, and save records it as hasc=2', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_keep', name: 'research' });
    await hibernated(ctx, c);
    assert.equal(alive(c.pid), false, 'the idle Claude process must be gone');
    const [wid, pane, name, cwd, cmd] = (await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{window_id}|#{pane_id}|#{window_name}|#{pane_current_path}|#{pane_current_command}'])).split('|');
    assert.deepEqual({ wid, pane, name, cwd }, { wid: c.windowId, pane: c.paneId, name: 'research', cwd: ctx.work });
    assert.equal(cmd, 'claude-resume', 'the pane is back in the shell that launched Claude, which now runs the placeholder');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), c.windowId);

    const save = await run(ctx, SAVE);
    assert.equal(save.code, 0, save.stderr);
    const row = fs.readFileSync(path.join(ctx.state, 'manifest.tsv'), 'utf8').split('\n').find((l) => l.startsWith('pw_keep\x1f'));
    assert.deepEqual(row.split('\x1f').slice(2, 6), ['research', ctx.work, '2', c.sid]);
    const logged = fs.readFileSync(path.join(ctx.state, 'hibernation.log'), 'utf8');
    assert.match(logged, new RegExp(`"event":"hibernated","sid":"${c.sid}"`));
  } finally { await teardown(ctx); }
});

test('REGRESSION (session safety): opening the window resumes the SAME conversation in the SAME pane, exactly once', { timeout: 40000 }, async () => {
  const ctx = await setup();
  let client;
  try {
    const c = await claudeWindow(ctx, { session: 'pw_visit' });
    await hibernated(ctx, c);
    assert.deepEqual(resumes(ctx), []);
    for (const [h, scope] of [['client-attached', '-g'], ['client-session-changed', '-g'], ['session-window-changed', '-g'], ['pane-focus-in', '-gw']]) {
      assert.match(await tmux(ctx.sock, ['show-hooks', scope, h]), new RegExp(`^${h}\\[\\d+\\] run-shell -b .*pw-claude-wake`), `${h} must be installed at the scope tmux fires it from`);
    }

    client = attachClient(ctx, 'pw_visit');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim().length > 0, 10000), 'sanity: a real client must be attached');
    assert.ok(await until(() => resumes(ctx).length > 0, 15000), 'attaching a client must resume the conversation');
    await sleep(2000); // several hooks fire for one visit; none of them may resume a second time
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
    assert.deepEqual(inputs(ctx), [], 'no hook may press Enter into the conversation it just resumed');
    assert.ok(await until(() => registryFor(ctx, c.sid)?.tmux === `pw_visit:${c.windowId}.${c.paneId}`), 'the resumed conversation is live in the same window and pane');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_waiting'), '', 'nothing is waiting to press Enter while the conversation runs');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid, 'the window keeps its conversation id until it is ended on purpose');
  } finally {
    client?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('REGRESSION (real Claude proof): the placeholder is armed even when Claude\'s late exit output overwrites the shell prompt', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_noisy', wrapped: true, fake: { FAKE_EXIT_NOISE: '1' } });
    const r = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.out.acted[0]?.action, r.out.acted[0]?.waiter], ['hibernated', true], JSON.stringify(r.out.acted));
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0));
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1));
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a failed resume keeps the markers and the exact id, and opening the tab retries the same conversation', { timeout: 60000 }, async () => {
  const ctx = await setup();
  let client;
  try {
    const failFlag = path.join(ctx.dir, 'resume-fails');
    fs.writeFileSync(failFlag, '');
    const c = await claudeWindow(ctx, { session: 'pw_retry', fake: { FAKE_FAIL_FILE: failFlag } });
    await hibernated(ctx, c);
    const waiter = await opt(ctx, c.windowId, '@pw_claude_waiting');

    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => /Resuming did not work: Claude Code exited with status 1/.test(await paneText(ctx, c))), 'the failure is reported');
    assert.deepEqual(failedResumes(ctx), [`failed-resume ${c.sid}`]);
    assert.deepEqual(resumes(ctx), []);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid, 'the window still holds the exact conversation id');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), c.windowId);
    assert.ok(await until(async () => { const now = await opt(ctx, c.windowId, '@pw_claude_waiting'); return waiterPid(now) === waiterPid(waiter) && now !== waiter; }), 'the same placeholder is waiting again, for the next attempt');
    assert.match(await paneText(ctx, c), new RegExp(`This window still holds conversation ${c.sid}`));

    const save = await run(ctx, SAVE);
    assert.equal(save.code, 0, save.stderr);
    const row = fs.readFileSync(path.join(ctx.state, 'manifest.tsv'), 'utf8').split('\n').find((l) => l.startsWith('pw_retry\x1f'));
    assert.deepEqual(row.split('\x1f').slice(4, 6), ['2', c.sid], 'the snapshot keeps the id after a failed resume');

    fs.rmSync(failFlag); // whatever broke the resume is fixed
    client = attachClient(ctx, 'pw_retry');
    assert.ok(await until(() => resumes(ctx).length === 1, 15000), 'opening the tab retries on its own');
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
    assert.ok(await resumedPid(ctx, c), 'the same conversation is live in the same pane');
  } finally {
    client?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('automatic retries stop after PW_CLAUDE_WAKE_RETRIES failures, Enter still retries, and the id is never lost', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const failFlag = path.join(ctx.dir, 'resume-fails');
    fs.writeFileSync(failFlag, '');
    const c = await claudeWindow(ctx, { session: 'pw_capped', fake: { FAKE_FAIL_FILE: failFlag, PW_CLAUDE_WAKE_RETRIES: '2' } });
    await hibernated(ctx, c);
    for (let i = 1; i <= 2; i++) {
      await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
      assert.ok(await until(() => failedResumes(ctx).length === i));
    }
    assert.ok(await until(async () => /Automatic retries stopped after 2 failures/.test(await paneText(ctx, c))));
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_waiting'), '', 'no hook may keep retrying a resume that keeps failing');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    const socketPath = await tmux(ctx.sock, ['display-message', '-p', '#{socket_path}']);
    execFileSync('bash', [WAKE, socketPath, c.windowId]);
    await sleep(800);
    assert.equal(failedResumes(ctx).length, 2, 'the wake hook no longer triggers a retry');
    fs.rmSync(failFlag);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1), 'Enter still retries');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
  } finally { await teardown(ctx); }
});

test('ending the resumed conversation on purpose (exit 0) clears the markers and gives the shell back', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_done' });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    const pid = await resumedPid(ctx, c);
    assert.ok(pid);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, '-l', '/exit']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => !alive(pid)));
    assert.ok(await until(async () => (await opt(ctx, c.windowId, '@pw_claude_sid')) === ''), 'a conversation ended on purpose is not resumed again');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), '');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{pane_current_command}'])) === 'bash'));
    assert.doesNotMatch(await paneText(ctx, c), /Resuming did not work/);
  } finally { await teardown(ctx); }
});

test('hibernating a resumed conversation again: it never looks like an idle shell, and its placeholder steps aside quietly', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_again2' });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    const pid = await resumedPid(ctx, c);
    assert.ok(pid);
    // Scheduled tasks type into a pane whose foreground command is a shell; the PVIKPBot handoff recycles a
    // window whose command does not end in "claude". The placeholder's name satisfies both.
    const command = await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{pane_current_command}']);
    assert.equal(command, 'claude-resume');
    assert.equal(taskWindowIsIdle(command), false, 'a resumed conversation must not look like an idle shell to scheduled tasks');
    assert.equal(/claude(\.exe)?$/.test(command), false, 'nor like a bare Claude to the PVIKPBot handoff check');
    const r = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.out.acted[0]?.action, r.out.acted[0]?.waiter], ['hibernated', true], JSON.stringify(r.out));
    assert.equal(alive(pid), false);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    assert.doesNotMatch(await paneText(ctx, c), /Resuming did not work/, 'being hibernated is not a failed resume');
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('Ctrl-Z suspends a resumed conversation like any shell job, and fg continues it with the markers intact', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_ctrlz' });
    await hibernated(ctx, c);
    const waiter = waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting'));
    assert.equal(await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{pane_current_command}']), 'claude-resume', 'a waiting placeholder is not an idle shell either');
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    const pid = await resumedPid(ctx, c);
    assert.ok(pid);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-z']);
    assert.ok(await until(() => stateOf(pid) === 'T' && stateOf(waiter) === 'T'), 'the whole job stops, as Claude and its placeholder are one job');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{pane_current_command}'])) === 'bash'), 'the shell is back');
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, '-l', 'fg']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => stateOf(pid) === 'S' && stateOf(waiter) === 'S'), 'fg continues both');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
    assert.doesNotMatch(await paneText(ctx, c), /Resuming did not work/);
  } finally { await teardown(ctx); }
});

test('an OOM-style kill of the resumed Claude keeps the markers, puts the terminal back, and Enter retries', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_oom', fake: { FAKE_RAW: '1' } });
    await hibernated(ctx, c);
    const waiter = await opt(ctx, c.windowId, '@pw_claude_waiting');
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    const pid = await resumedPid(ctx, c);
    assert.ok(pid);
    assert.ok(await until(() => /-icrnl/.test(execFileSync('stty', ['-a', '-F', ttyOf(pid)], { encoding: 'utf8' }))), 'sanity: the stand-in put the terminal in raw mode');
    process.kill(pid, 'SIGKILL');
    assert.ok(await until(async () => /Resuming did not work: Claude Code exited with status 137/.test(await paneText(ctx, c))));
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) === waiterPid(waiter)), 'the same placeholder waits again');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    const save = await run(ctx, SAVE);
    assert.equal(save.code, 0, save.stderr);
    const row = fs.readFileSync(path.join(ctx.state, 'manifest.tsv'), 'utf8').split('\n').find((l) => l.startsWith('pw_oom\x1f'));
    assert.deepEqual(row.split('\x1f').slice(4, 6), ['2', c.sid]);
    // Enter is a carriage return; only a terminal back in its normal mode turns it into the end of a line.
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 2), 'Enter retries after Claude was killed in raw mode');
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`, `resume ${c.sid} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('after /clear, a crash keeps the conversation the window was really in, and retrying resumes that one', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_clear', fake: { FAKE_RAW: '1' } });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    const pid = await resumedPid(ctx, c);
    assert.ok(pid);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, '-l', '/clear']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => clears(ctx).length === 1));
    const cleared = clears(ctx)[0];
    assert.notEqual(cleared, c.sid);
    assert.ok(await until(() => registryFor(ctx, cleared)?.pid === pid), 'sanity: the registry entry follows /clear');
    process.kill(pid, 'SIGKILL');
    assert.ok(await until(async () => /Resuming did not work: Claude Code exited with status 137/.test(await paneText(ctx, c))));
    assert.ok(await until(async () => (await opt(ctx, c.windowId, '@pw_claude_sid')) === cleared), 'the window now holds the conversation Claude was in when it died');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), c.windowId);
    assert.match(await paneText(ctx, c), new RegExp(`This window still holds conversation ${cleared}`));
    const save = await run(ctx, SAVE);
    assert.equal(save.code, 0, save.stderr);
    const row = fs.readFileSync(path.join(ctx.state, 'manifest.tsv'), 'utf8').split('\n').find((l) => l.startsWith('pw_clear\x1f'));
    assert.deepEqual(row.split('\x1f').slice(4, 6), ['2', cleared]);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 2));
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`, `resume ${cleared} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('after a failure, a dead registry entry that was never this window\'s conversation is not adopted', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const failFlag = path.join(ctx.dir, 'resume-fails');
    fs.writeFileSync(failFlag, '');
    const c = await claudeWindow(ctx, { session: 'pw_foreign', fake: { FAKE_FAIL_FILE: failFlag, FAKE_FOREIGN: '1' } });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => /Resuming did not work: Claude Code exited with status 1/.test(await paneText(ctx, c))));
    assert.equal(logLines(ctx).filter((l) => l.startsWith('foreign ')).length, 3, 'sanity: the foreign entries were written during the attempt');
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0));
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid, 'a nested claude -p, another window with the same pane id, or an older Claude must not take the window over');
    assert.match(await paneText(ctx, c), new RegExp(`This window still holds conversation ${c.sid}`));
  } finally { await teardown(ctx); }
});

test('Ctrl-C right after a failure, while the next attempt is not yet offered, still cancels cleanly', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_settlecancel', fake: { PW_CLAUDE_WAKE_SETTLE: '5' } });
    await hibernated(ctx, c);
    fs.rmSync(path.join(ctx.projects, 'proj', `${c.sid}.jsonl`));
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => /Resuming did not work: no transcript/.test(await paneText(ctx, c)), 10000, 20));
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-c']);
    assert.ok(await until(async () => /Resume cancelled; this window is a plain shell again/.test(await paneText(ctx, c))), 'the cancel path runs');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), '');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_waiting'), '');
  } finally { await teardown(ctx); }
});

test('one visit makes at most one automatic attempt, however many hooks it fires; the next visit tries again', { timeout: 60000 }, async () => {
  const ctx = await setup();
  let client;
  try {
    const c = await claudeWindow(ctx, { session: 'pw_burst', fake: { PW_CLAUDE_WAKE_SETTLE: '4' } });
    await hibernated(ctx, c);
    // The quickest failure there is: no transcript, so no Claude is even started.
    const file = path.join(ctx.projects, 'proj', `${c.sid}.jsonl`);
    const saved = fs.readFileSync(file);
    fs.rmSync(file);
    const failures = async () => ((await paneText(ctx, c)).match(/Resuming did not work: no transcript/g) || []).length;
    client = attachClient(ctx, 'pw_burst');
    assert.ok(await until(async () => (await failures()) === 1, 15000), 'opening the tab tries once');
    await sleep(3000);
    assert.equal(await failures(), 1, 'the other hooks of the same visit must not try again');
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0), 'still waiting for the next visit');
    client.kill('SIGKILL');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim() === ''));
    fs.writeFileSync(file, saved);
    client = attachClient(ctx, 'pw_burst');
    assert.ok(await until(() => resumes(ctx).length === 1, 15000), 'the next visit tries again');
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
  } finally {
    client?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('a wake cannot use up a retry: not one arriving just after a failure, nor a slow one read before it', { timeout: 90000 }, async () => {
  const ctx = await setup();
  let client;
  let slow;
  try {
    // A settle long enough for a loaded runner; the slow wake below acts well after it.
    const c = await claudeWindow(ctx, { session: 'pw_stale', fake: { PW_CLAUDE_WAKE_SETTLE: '3' } });
    await hibernated(ctx, c);
    for (const [h, scope] of [['client-attached', '-gu'], ['client-session-changed', '-gu'], ['session-window-changed', '-gu'], ['pane-focus-in', '-gwu']]) await tmux(ctx.sock, ['set-hook', scope, h]);
    client = attachClient(ctx, 'pw_stale');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim().length > 0, 10000));
    fs.rmSync(path.join(ctx.projects, 'proj', `${c.sid}.jsonl`)); // fails at once, before any Claude starts
    const failures = async () => ((await paneText(ctx, c)).match(/Resuming did not work: no transcript/g) || []).length;
    const socketPath = await tmux(ctx.sock, ['display-message', '-p', '#{socket_path}']);

    // Another hook of the same visit, landing right after the attempt failed.
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => (await failures()) === 1, 10000, 20));
    execFileSync('bash', [WAKE, socketPath, c.windowId]);
    await sleep(2000);
    assert.equal(await failures(), 1, 'a wake in the moment after a failure must not start another attempt');

    // A wake that read the placeholder's claim before the attempt, and acts only after it failed.
    const shim = path.join(ctx.dir, 'slow-tmux');
    fs.mkdirSync(shim);
    const realTmux = execFileSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    const shimLog = path.join(ctx.dir, 'slow-tmux.log');
    fs.writeFileSync(path.join(shim, 'tmux'), `#!/bin/bash\necho "$*" >> ${shimLog}\ncase " $* " in *" if-shell "*) sleep 6 ;; esac\nexec ${realTmux} "$@"\n`, { mode: 0o755 });
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0));
    slow = spawn('bash', [WAKE, socketPath, c.windowId], { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: 'ignore' });
    assert.ok(await until(() => fs.existsSync(shimLog) && /if-shell/.test(fs.readFileSync(shimLog, 'utf8')), 10000, 20), 'sanity: the slow wake read the claim and is about to act on it');
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => (await failures()) === 2, 10000, 20));
    await new Promise((resolve) => slow.on('exit', resolve));
    await sleep(1500);
    assert.equal(await failures(), 2, 'a wake for an attempt that already failed must not start the next one');
    assert.ok(await until(async () => waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0), 'the next attempt is still offered');
  } finally {
    client?.kill('SIGKILL');
    slow?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('the wake hook never presses Enter into a shell whose placeholder was stopped with Ctrl-Z', { timeout: 40000 }, async () => {
  const ctx = await setup();
  let client;
  try {
    const c = await claudeWindow(ctx, { session: 'pw_zwait' });
    await hibernated(ctx, c);
    const waiter = waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting'));
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-z']);
    assert.ok(await until(() => stateOf(waiter) === 'T'));
    assert.ok(await until(async () => (await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{pane_current_command}'])) === 'bash'));
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, '-l', 'echo HALF-TYPED-$((6*7))']);
    await tmux(ctx.sock, ['set-hook', '-gu', 'client-attached']); // this test drives the wake itself
    client = attachClient(ctx, 'pw_zwait');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim().length > 0, 10000));
    const socketPath = await tmux(ctx.sock, ['display-message', '-p', '#{socket_path}']);
    execFileSync('bash', [WAKE, socketPath, c.windowId]);
    await sleep(1000);
    assert.doesNotMatch(await paneText(ctx, c), /HALF-TYPED-42/, 'the half-typed line must not run');
    assert.deepEqual(resumes(ctx), []);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-u']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, '-l', 'fg']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => stateOf(waiter) === 'S'), 'fg puts the placeholder back');
    execFileSync('bash', [WAKE, socketPath, c.windowId]);
    assert.ok(await until(() => resumes(ctx).length === 1), 'and the wake works again');
  } finally {
    client?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('a Claude stopped from outside (SIGSTOP) is left running by the hibernator', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_stopped' });
    process.kill(c.pid, 'SIGSTOP');
    assert.ok(await until(() => stateOf(c.pid) === 'T'));
    const r = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0', '--stop-timeout', '2']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out.acted, []);
    assert.match(r.out.skipped.find((s) => s.sid === c.sid)?.reason || '', /suspended/);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '');
    process.kill(c.pid, 'SIGCONT');
  } finally { await teardown(ctx); }
});

test('refresh: a placeholder still running the c819d9a script is swapped for the current one, keeping the id', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const bin = path.join(ctx.dir, 'installed');
    fs.mkdirSync(bin);
    const installed = path.join(bin, 'pw-claude-wait');
    fs.copyFileSync(WAIT_C819D9A, installed);
    fs.chmodSync(installed, 0o755);
    const c = await claudeWindow(ctx, { session: 'pw_refresh' });
    const h = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0'], { PW_CLAUDE_WAIT_BIN: installed });
    assert.equal(h.out.acted[0]?.waiter, true, JSON.stringify(h.out));
    const oldWaiter = await opt(ctx, c.windowId, '@pw_claude_waiting');

    // What `install` does on deploy: a new file renamed over the old name, so the running copy keeps the old inode.
    const staged = path.join(bin, '.pw-claude-wait.new');
    fs.copyFileSync(WAIT, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, installed);

    const env = { PW_CLAUDE_WAIT_BIN: installed };
    const dry = await hibernate(ctx, ['--refresh-placeholders'], env);
    assert.deepEqual(dry.out.acted.map((a) => [a.action, a.sid]), [['would-refresh', c.sid]]);
    const r = await hibernate(ctx, ['--refresh-placeholders', '--apply'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.acted[0]?.action, 'refreshed', JSON.stringify(r.out.acted));
    const newWaiter = waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting'));
    assert.ok(newWaiter > 0 && newWaiter !== Number(oldWaiter), 'a new placeholder is waiting');
    assert.equal(alive(Number(oldWaiter)), false);
    assert.equal(fs.readFileSync(`/proc/${newWaiter}/cmdline`, 'utf8').split('\0')[0], 'claude-resume', 'it runs the current script');
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), c.windowId);
    const again = await hibernate(ctx, ['--refresh-placeholders'], env);
    assert.deepEqual(again.out.acted, []);
    assert.match(again.out.skipped.find((s) => s.sid === c.sid)?.reason || '', /already runs the current script/);

    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1));
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('refresh leaves alone a placeholder it could not replace safely: resumed, stopped, beside other work, or in view', { timeout: 90000 }, async () => {
  const ctx = await setup();
  let client;
  let besideShell = 0;
  try {
    const bin = path.join(ctx.dir, 'installed');
    fs.mkdirSync(bin);
    const installed = path.join(bin, 'pw-claude-wait');
    fs.copyFileSync(WAIT_C819D9A, installed);
    fs.chmodSync(installed, 0o755);
    const old = { PW_CLAUDE_WAIT_BIN: installed };
    const armOld = async (c) => {
      const h = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0'], old);
      assert.equal(h.out.acted[0]?.waiter, true, JSON.stringify(h.out));
      return waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting'));
    };

    // Resumed under the current placeholder: markers set, nothing waiting.
    const resumed = await claudeWindow(ctx, { session: 'pw_refkeep', name: 'resumed' });
    await hibernated(ctx, resumed);
    await tmux(ctx.sock, ['send-keys', '-t', resumed.paneId, 'Enter']);
    const resumedClaude = await resumedPid(ctx, resumed);
    assert.ok(resumedClaude);
    // Stopped at its prompt.
    const stopped = await claudeWindow(ctx, { session: 'pw_refkeep', name: 'stopped' });
    const stoppedWaiter = await armOld(stopped);
    process.kill(stoppedWaiter, 'SIGSTOP');
    assert.ok(await until(() => stateOf(stoppedWaiter) === 'T'));
    // Beside other work: the shell started a background job before the placeholder.
    const beside = await claudeWindow(ctx, { session: 'pw_refkeep', name: 'beside' });
    const besideWaiter = await armOld(beside);
    process.kill(besideWaiter, 'SIGTERM'); // make room at the prompt, then arm it by hand next to a background job
    assert.ok(await until(() => !alive(besideWaiter)));
    besideShell = Number(await tmux(ctx.sock, ['display-message', '-p', '-t', beside.paneId, '#{pane_pid}']));
    await tmux(ctx.sock, ['send-keys', '-t', beside.paneId, '-l', `sleep 600 & ${installed} ${beside.sid}`]);
    await tmux(ctx.sock, ['send-keys', '-t', beside.paneId, 'Enter']);
    let besideNow = 0;
    assert.ok(await until(async () => { besideNow = waiterPid(await opt(ctx, beside.windowId, '@pw_claude_waiting')); return besideNow > 0 && besideNow !== besideWaiter; }));
    // In view: a client is attached and it is the active window (the wake hooks are off, so nothing resumes).
    const inView = await claudeWindow(ctx, { session: 'pw_refview' });
    const inViewWaiter = await armOld(inView);
    for (const [h, scope] of [['client-attached', '-gu'], ['client-session-changed', '-gu'], ['session-window-changed', '-gu'], ['pane-focus-in', '-gwu']]) await tmux(ctx.sock, ['set-hook', scope, h]);
    client = attachClient(ctx, 'pw_refview');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim().length > 0, 10000));

    const staged = path.join(bin, '.pw-claude-wait.new');
    fs.copyFileSync(WAIT, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, installed);
    const current = { PW_CLAUDE_WAIT_BIN: installed };
    const expect = [[resumed, /no placeholder is waiting/], [stopped, /stopped/], [beside, /other processes beside the placeholder/], [inView, /someone is looking/]];
    for (const args of [['--refresh-placeholders'], ['--refresh-placeholders', '--apply']]) {
      const r = await hibernate(ctx, args, current);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.out.acted, [], JSON.stringify(r.out.acted));
      for (const [c, reason] of expect) assert.match(r.out.skipped.find((s) => s.sid === c.sid)?.reason || '(not reported)', reason, c.windowId);
    }
    for (const [c, pid] of [[stopped, stoppedWaiter], [beside, besideNow], [inView, inViewWaiter]]) {
      assert.ok(alive(pid), `${c.windowId}: the old placeholder is untouched`);
      assert.equal(waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')), pid);
    }
    assert.ok(alive(resumedClaude), 'the resumed conversation is untouched');
    for (const c of [resumed, stopped, beside, inView]) {
      assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
      assert.equal(await opt(ctx, c.windowId, '@pw_claude_hib_win'), c.windowId);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(ctx.state, 'hibernation.log'), 'utf8'), /refresh-start/);
    process.kill(stoppedWaiter, 'SIGCONT');
  } finally {
    client?.kill('SIGKILL');
    for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        if (besideShell && st.includes(' (sleep) ') && Number(st.slice(st.lastIndexOf(') ') + 2).split(' ')[1]) === besideShell) process.kill(Number(d), 'SIGKILL');
      } catch { /* gone */ }
    }
    await teardown(ctx);
  }
});

test('a waiting placeholder whose script is overwritten in place still resumes its conversation exactly once', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const bin = path.join(ctx.dir, 'installed');
    fs.mkdirSync(bin);
    const installed = path.join(bin, 'pw-claude-wait');
    fs.copyFileSync(WAIT, installed);
    fs.chmodSync(installed, 0o755);
    const c = await claudeWindow(ctx, { session: 'pw_rewrite' });
    const h = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--idle-minutes', '0'], { PW_CLAUDE_WAIT_BIN: installed });
    assert.equal(h.out.acted[0]?.waiter, true, JSON.stringify(h.out));
    // bash reads a script as it goes: a copy rewritten under it (cp, an editor) shifts every later line.
    const ino = fs.statSync(installed).ino;
    fs.writeFileSync(installed, `#!/bin/bash\n${'# shifted\n'.repeat(40)}echo REWRITTEN-SCRIPT-RAN; exit 0\n`);
    assert.equal(fs.statSync(installed).ino, ino, 'sanity: overwritten in place');
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1), 'the conversation is resumed');
    await sleep(500);
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
    assert.doesNotMatch(await paneText(ctx, c), /REWRITTEN-SCRIPT-RAN|syntax error|command not found/);
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), c.sid);
  } finally { await teardown(ctx); }
});

test('pressing Enter in the window resumes it even with no hook', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_enter' });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['set-hook', '-gu', 'client-attached']);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1));
    assert.deepEqual(resumes(ctx), [`resume ${c.sid} pane=${c.paneId}`]);
  } finally { await teardown(ctx); }
});

test('nobody looking: the wake hook does nothing for a window whose session has no client', { timeout: 30000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_unseen' });
    await hibernated(ctx, c);
    const socketPath = await tmux(ctx.sock, ['display-message', '-p', '#{socket_path}']);
    execFileSync('bash', [WAKE, socketPath, c.windowId]);
    await tmux(ctx.sock, ['select-window', '-t', c.windowId]);
    await sleep(1500);
    assert.deepEqual(resumes(ctx), []);
    assert.ok(waiterPid(await opt(ctx, c.windowId, '@pw_claude_waiting')) > 0, 'the placeholder is still waiting');
  } finally { await teardown(ctx); }
});

test('Ctrl-C in the placeholder gives the shell back and clears the markers; nothing is resumed', { timeout: 30000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_cancel' });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-c']);
    assert.ok(await until(async () => (await opt(ctx, c.windowId, '@pw_claude_sid')) === ''));
    assert.ok(await until(async () => new RegExp(`claude --resume ${c.sid}`).test(await tmux(ctx.sock, ['capture-pane', '-p', '-J', '-t', c.paneId]))), 'the id is shown so it can be resumed by hand');
    await sleep(500);
    assert.deepEqual(resumes(ctx), []);
  } finally { await teardown(ctx); }
});

test('Ctrl-D in the placeholder cancels exactly like Ctrl-C: no window is left marked with nothing waiting', { timeout: 30000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_eof' });
    await hibernated(ctx, c);
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'C-d']);
    assert.ok(await until(async () => (await opt(ctx, c.windowId, '@pw_claude_sid')) === '' && (await opt(ctx, c.windowId, '@pw_claude_waiting')) === ''));
    await sleep(500);
    assert.deepEqual(resumes(ctx), []);
    assert.equal(await tmux(ctx.sock, ['display-message', '-p', '-t', c.paneId, '#{window_id}']), c.windowId, 'the window and its shell remain');
  } finally { await teardown(ctx); }
});

test('a conversation already running in another window is not resumed a second time', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_twice' });
    await hibernated(ctx, c);
    // Someone resumed the same conversation somewhere else in the meantime.
    const other = await claudeWindow(ctx, { session: 'pw_other', sid: c.sid, idleMs: 0 });
    await tmux(ctx.sock, ['send-keys', '-t', c.paneId, 'Enter']);
    assert.ok(await until(async () => /already open in another window/.test(await tmux(ctx.sock, ['capture-pane', '-p', '-t', c.paneId]))));
    assert.deepEqual(resumes(ctx), []);
    assert.ok(alive(other.pid));
  } finally { await teardown(ctx); }
});

test('sessions that must not be hibernated are left running, each with its reason', { timeout: 90000 }, async () => {
  const ctx = await setup();
  try {
    const cases = {
      busy: await claudeWindow(ctx, { session: 'pw_busy', fake: { FAKE_STATUS: 'busy' } }),
      recent: await claudeWindow(ctx, { session: 'pw_recent', idleMs: 60000 }),
      background: await claudeWindow(ctx, { session: 'pw_bg', fake: { FAKE_CHILD: '1' } }),
      reused: await claudeWindow(ctx, { session: 'pw_reused', fake: { FAKE_PROCSTART_OFFSET: '7' } }),
      paneRoot: await claudeWindow(ctx, { session: 'pw_root', paneRoot: true }),
      lane: await claudeWindow(ctx, { session: 'pw_lane', lane: true }),
      notProject: await claudeWindow(ctx, { session: 'scratch' }),
    };
    const r = await hibernate(ctx, ['--apply', '--idle-days', '1']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out.acted, [], 'nothing here may be hibernated');
    const reason = (c) => r.out.skipped.find((s) => s.sid === c.sid)?.reason || '(not reported)';
    assert.match(reason(cases.busy), /session is busy/);
    assert.match(reason(cases.recent), /last message .* ago/);
    assert.match(reason(cases.background), /child process\(es\) started within the idle window/);
    assert.match(reason(cases.reused), /procStart mismatch/);
    assert.match(reason(cases.paneRoot), /pane's own process; stopping it would close the window/);
    assert.match(reason(cases.lane), /orchestrator lane/);
    assert.match(reason(cases.notProject), /not a project session/);
    for (const [name, c] of Object.entries(cases)) {
      assert.ok(alive(c.pid), `${name}: must still be running`);
      assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '', `${name}: must carry no markers`);
    }
  } finally { await teardown(ctx); }
});

test('REGRESSION (review P1): a window someone is using is left running, however old its conversation', { timeout: 90000 }, async () => {
  const ctx = await setup();
  let client;
  try {
    const looking = await claudeWindow(ctx, { session: 'pw_look' });
    const scrolling = await claudeWindow(ctx, { session: 'pw_scroll' });
    const chatty = await claudeWindow(ctx, { session: 'pw_chatty', fake: { FAKE_CHATTER: '1' } });
    const oneShot = await claudeWindow(ctx, { session: 'pw_oneshot', nonInteractive: true });
    // Job control on, so it passes the foreground-job rule, but the shell still exits after its command.
    const interactiveOneShot = await claudeWindow(ctx, { session: 'pw_ioneshot', interactiveCommand: true });
    // Found by review of #64: a denylist missed these, and each closed its window when hibernated.
    const plusX = await claudeWindow(ctx, { session: 'pw_plusx', shellArgs: '--norc +x -ic' });
    const plusC = await claudeWindow(ctx, { session: 'pw_plusc', shellArgs: '--norc +c' });
    const clusterO = await claudeWindow(ctx, { session: 'pw_clustero', shellArgs: '--norc -io vi -c' });
    const noJobControl = await claudeWindow(ctx, { session: 'pw_nojobs', jobControlOff: true });
    // Found by review of b456b9f: interactive shells that still exit when the Claude job ends, Claude typed at the prompt.
    const exitsWith = {};
    for (const [key, flags] of [['e', '-e'], ['errexit', '-o errexit'], ['t', '-t'], ['onecmd', '-o onecmd']]) {
      exitsWith[key] = await claudeWindow(ctx, { session: `pw_exits_${key}`, shellFlags: flags });
    }
    client = attachClient(ctx, 'pw_look');
    assert.ok(await until(async () => (await tmux(ctx.sock, ['list-clients'])).trim().length > 0, 10000), 'sanity: a client is attached');
    await tmux(ctx.sock, ['copy-mode', '-t', scrolling.paneId]);
    await sleep(4000);
    // A threshold of 3s: long enough that only the in-use rules can refuse these, every conversation is 10 days old.
    const r = await hibernate(ctx, ['--apply', '--idle-minutes', '0.05']);
    assert.equal(r.code, 0, r.stderr);
    const reason = (c) => r.out.skipped.find((x) => x.sid === c.sid)?.reason || `(acted: ${JSON.stringify(r.out.acted.find((x) => x.sid === c.sid))})`;
    assert.match(reason(looking), /someone is looking at this window/);
    assert.match(reason(scrolling), /copy mode/);
    assert.match(reason(chatty), /showed output .* ago/);
    const notPlainShell = /not a plain interactive shell/;
    assert.match(reason(oneShot), notPlainShell);
    assert.match(reason(interactiveOneShot), notPlainShell);
    for (const c of [plusX, plusC, clusterO, ...Object.values(exitsWith)]) assert.match(reason(c), notPlainShell);
    // The foreground-job rule's own case: an ordinary interactive shell, but job control switched off.
    assert.match(reason(noJobControl), /not the foreground job of an interactive shell/);
    assert.equal(await tmux(ctx.sock, ['display-message', '-p', '-t', interactiveOneShot.windowId, '#{window_id}']), interactiveOneShot.windowId, 'its window must still exist');
    for (const c of [plusX, plusC, clusterO, ...Object.values(exitsWith)]) {
      assert.equal(await tmux(ctx.sock, ['display-message', '-p', '-t', c.windowId, '#{window_id}']), c.windowId, 'its window must still exist');
    }
    for (const c of [looking, scrolling, chatty, oneShot, interactiveOneShot, plusX, plusC, clusterO, noJobControl, ...Object.values(exitsWith)]) {
      assert.ok(alive(c.pid));
      assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '');
    }
  } finally {
    client?.kill('SIGKILL');
    await teardown(ctx);
  }
});

test('REGRESSION (review P1): a conversation resumed moments ago is not hibernated again by the default threshold', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_again', idleMs: 30 * DAY });
    const r = await hibernate(ctx, ['--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out.acted, []);
    assert.match(r.out.skipped.find((x) => x.sid === c.sid).reason, /showed output .* ago|started or resumed .* ago/);
    assert.ok(alive(c.pid));
  } finally { await teardown(ctx); }
});

test('a Claude that does not exit is left running and unmarked', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const c = await claudeWindow(ctx, { session: 'pw_stubborn', fake: { FAKE_IGNORE_TERM: '1' } });
    const r = await hibernate(ctx, ['--apply', '--session-id', c.sid, '--stop-timeout', '2', '--idle-minutes', '0']);
    assert.equal(r.code, 1);
    assert.equal(r.out.acted[0].action, 'left-running');
    assert.match(r.out.acted[0].reason, /did not exit/);
    assert.ok(alive(c.pid));
    assert.equal(await opt(ctx, c.windowId, '@pw_claude_sid'), '');
  } finally {
    try { const d = fs.readdirSync(ctx.reg).map((f) => JSON.parse(fs.readFileSync(path.join(ctx.reg, f), 'utf8'))); for (const e of d) process.kill(e.pid, 'SIGKILL'); } catch { /* gone */ }
    await teardown(ctx);
  }
});

test('a session that becomes busy while an earlier candidate is being stopped is re-judged and left running', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    // Oldest first: the stubborn one holds the run for --stop-timeout, the other goes busy meanwhile.
    const slow = await claudeWindow(ctx, { session: 'pw_slow', idleMs: 20 * DAY, fake: { FAKE_IGNORE_TERM: '1' } });
    const later = await claudeWindow(ctx, { session: 'pw_later', idleMs: 10 * DAY });
    const run = hibernate(ctx, ['--apply', '--stop-timeout', '2', '--idle-minutes', '0']);
    await sleep(700);
    const file = path.join(ctx.reg, `${later.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'busy' }));
    const r = await run;
    const byId = Object.fromEntries(r.out.acted.map((a) => [a.sid, a]));
    assert.equal(byId[slow.sid].action, 'left-running');
    assert.equal(byId[later.sid].action, 'left-running', JSON.stringify(r.out.acted));
    assert.match(byId[later.sid].reason, /changed before it could be hibernated: session is busy/);
    assert.ok(alive(later.pid), 'a session someone started using must not be stopped');
    assert.equal(await opt(ctx, later.windowId, '@pw_claude_sid'), '');
  } finally { await teardown(ctx); }
});

test('refuses to act on a tmux server the owner unit never stamped', { timeout: 30000 }, async () => {
  const ctx = await setup({ owned: false });
  try {
    const c = await claudeWindow(ctx, { session: 'pw_foreign' });
    const r = await run(ctx, HIBERNATE, ['--apply']);
    assert.equal(r.code, REFUSED, r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.ok(alive(c.pid));
  } finally { await teardown(ctx); }
});

test('backfill: a window hibernated by hand gets its markers and placeholder from the manifest; mismatched rows are left alone', { timeout: 40000 }, async () => {
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    const mismatched = crypto.randomUUID();
    transcript(ctx, sid, 20 * DAY);
    transcript(ctx, mismatched, 20 * DAY);
    const shell = `env PATH=${JSON.stringify(process.env.PATH)} HOME=${ctx.dir} HISTFILE=/dev/null PW_CLAUDE_SESSIONS_DIR=${ctx.reg} PW_CLAUDE_PROJECTS_DIR=${ctx.projects} PW_CLAUDE_BIN=${ctx.fake} FAKE_LOG=${ctx.fakeLog} bash --noprofile --norc`;
    await tmux(ctx.sock, ['new-session', '-d', '-s', 'pw_hand', '-n', 'old', '-c', ctx.work, shell]);
    await tmux(ctx.sock, ['new-window', '-d', '-t', 'pw_hand:', '-n', 'renamed', '-c', ctx.work, shell]);
    await until(async () => /\$$/.test((await tmux(ctx.sock, ['capture-pane', '-p', '-t', 'pw_hand:0'])).trimEnd()));
    await until(async () => /\$$/.test((await tmux(ctx.sock, ['capture-pane', '-p', '-t', 'pw_hand:1'])).trimEnd()));
    fs.writeFileSync(path.join(ctx.state, 'manifest.tsv'), [
      ['pw_hand', '0', 'old', ctx.work, '1', sid, ''],
      ['pw_hand', '1', 'something-else', ctx.work, '1', mismatched, ''],
    ].map((f) => f.join('\x1f')).join('\n') + '\n');

    const dry = await hibernate(ctx, ['--backfill-from-manifest', '--idle-minutes', '0']);
    assert.deepEqual(dry.out.acted.map((a) => [a.action, a.sid]), [['would-hibernate', sid]]);
    const r = await hibernate(ctx, ['--backfill-from-manifest', '--apply', '--idle-minutes', '0']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out.acted.map((a) => [a.action, a.sid, a.waiter]), [['backfilled', sid, true]]);
    assert.match(r.out.skipped.find((s) => s.sid === mismatched).reason, /name or cwd differs/);
    const wid0 = await tmux(ctx.sock, ['display-message', '-p', '-t', 'pw_hand:0', '#{window_id}']);
    const wid1 = await tmux(ctx.sock, ['display-message', '-p', '-t', 'pw_hand:1', '#{window_id}']);
    assert.equal(await opt(ctx, wid0, '@pw_claude_sid'), sid);
    assert.equal(await opt(ctx, wid1, '@pw_claude_sid'), '');
    await tmux(ctx.sock, ['send-keys', '-t', 'pw_hand:0', 'Enter']);
    assert.ok(await until(() => resumes(ctx).length === 1));
    assert.match(resumes(ctx)[0], new RegExp(`^resume ${sid} `));
  } finally { await teardown(ctx); }
});

test('wake hooks are installed once and never replace hooks that were already there', { timeout: 30000 }, async () => {
  const ctx = await setup();
  try {
    await tmux(ctx.sock, ['set-hook', '-g', 'client-attached', 'run-shell -b "true existing"']);
    for (let i = 0; i < 2; i++) assert.equal((await run(ctx, HIBERNATE, ['--install-hooks'])).code, 0);
    const attached = (await tmux(ctx.sock, ['show-hooks', '-g', 'client-attached'])).split('\n');
    assert.equal(attached.length, 2);
    assert.match(attached[0], /true existing/);
    assert.equal(attached.filter((l) => l.includes('pw-claude-wake')).length, 1);
  } finally { await teardown(ctx); }
});
