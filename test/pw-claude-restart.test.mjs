// /restart for Claude Code. scripts/pw-claude-loader keeps an interactive session's terminal, and when
// scripts/pw-claude-restart (the /restart hook) asks, it stops Claude and starts it again there, in the same
// conversation, the way GitHub Copilot CLI's loader does for its /restart.
//
// What a person relies on, checked against real tmux, a real terminal and a real process tree:
//   * /restart brings Claude back in the same pane and conversation with the options it was started with,
//     and the pane never shows a shell in between, because scheduled tasks type into a pane that does;
//   * the prompt a session was started with, and the options that picked its conversation, are not repeated;
//   * whatever /restart cannot do is refused with the reason, and nothing is stopped;
//   * everything else is what the vendor's cli-wrapper.cjs did before: exit statuses, signals, Ctrl-Z;
//   * the claude wrapper uses the loader for interactive sessions only.
//
// Claude is replaced by a stand-in that does what the loader depends on, measured on Claude Code 2.1.300:
// it runs the /restart hook as Claude does (`sh -c`, CLAUDE_PID set, the UserPromptExpansion input on stdin),
// records the hook's block notice in its transcript, and exits 143 on SIGTERM. Every tmux server is private,
// and every loader's handshake directory is inside the test's own TMPDIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureTmuxServer } from './tmux-owner-fixture.mjs';
import { taskWindowIsIdle } from '../app/scheduled-tasks.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = path.join(REPO, 'scripts', 'pw-claude-loader');
const HOOK = path.join(REPO, 'scripts', 'pw-claude-restart');
const UPDATER = path.join(REPO, 'scripts', 'update-claude-code');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESTARTING = {
  decision: 'block',
  reason: 'Restarting Claude Code…',
  hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true },
};

const FAKE_CLAUDE = (version) => `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const VERSION = ${JSON.stringify(version)};
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const sid = after('--resume') || after('--session-id') || crypto.randomUUID();
const transcript = path.join(process.env.FAKE_PROJECTS, sid + '.jsonl');
const log = (event, extra = {}) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ event, pid: process.pid, ppid: process.ppid, sid, ...extra }) + '\\n');
const marker = process.env.FAKE_IGNORE_TERM_ONCE;
const ignoresTerm = !!marker && !fs.existsSync(marker);
if (ignoresTerm) fs.writeFileSync(marker, '');
log('start', { args, version: VERSION, loader: process.env.PW_CLAUDE_LOADER_PID || '', npmWrapper: process.env.CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER || '' });

// Like Claude Code: the hook runs through sh -c with CLAUDE_PID set and the expansion on stdin, and a blocked
// expansion leaves its notice in the transcript as a system record.
function runHook(commandArgs) {
  return new Promise((resolve) => {
    const hook = spawn('/bin/sh', ['-c', process.env.FAKE_HOOK], { env: { ...process.env, CLAUDE_PID: String(process.pid) }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    hook.stdout.on('data', (d) => { out += d; });
    hook.on('close', () => {
      let decision = null;
      try { decision = JSON.parse(out); } catch { decision = out; }
      log('hook', { decision });
      if (decision?.decision === 'block' && process.env.FAKE_NO_NOTICE !== '1') fs.appendFileSync(transcript, '{"type":"system","subtype":"informational"}\\n');
      process.stdout.write('NOTICE ' + (decision?.reason ?? 'none') + '\\n');
      resolve();
    });
    hook.stdin.end(JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: process.cwd(), hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'restart', command_args: commandArgs, command_source: 'policySettings', prompt: ('/restart ' + commandArgs).trim() }));
  });
}
if (process.env.FAKE_AUTORESTART === '1') {
  runHook('').then(() => process.exit(0));
} else {
  process.stdout.write('FAKE-READY ' + VERSION + '\\n');
  process.stdin.on('data', async (d) => {
    for (const line of String(d).split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean)) {
      const m = /^\\/restart(?:\\s+(.*))?$/.exec(line);
      if (m) await runHook(m[1] ?? '');
      else if (line === '/exit') { log('exit'); process.exit(0); }
      else if (line === '/fail') { log('fail'); process.exit(7); }
      else if (line === '/nested') {
        // A claude started from inside this one, so it inherits this session's loader variables.
        const nested = spawn(process.execPath, [process.argv[1]], { env: { ...process.env, FAKE_AUTORESTART: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
        nested.on('exit', () => log('nested-done'));
      }
    }
  });
}
process.on('SIGTERM', () => {
  if (ignoresTerm) { log('term-ignored'); return; }
  log('term');
  process.stdout.write('Resume this session with:\\nclaude --resume ' + sid + '\\n');
  process.exit(143);
});
setInterval(() => {}, 1 << 30);
`;

// cli-wrapper.cjs as the vendor ships it, reduced to what matters: run the native binary, exit with its status.
const FAKE_VENDOR_WRAPPER = `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { constants } = require('os');
const r = spawnSync(process.env.FAKE_NATIVE, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER: '1' } });
if (r.signal) process.exit(128 + (constants.signals[r.signal] ?? 0));
process.exit(r.status ?? 1);
`;

async function tmux(sock, args) {
  const env = { ...process.env };
  delete env.TMUX;
  return (await execFileAsync('tmux', ['-L', sock, ...args], { env })).stdout.replace(/\n$/, '');
}
async function until(check, timeoutMs = 20000, stepMs = 100) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(stepMs)) if (await check()) return true;
  return check();
}
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-restart-'));
  const ctx = {
    dir,
    sock: `pwrestarttest-${crypto.randomBytes(4).toString('hex')}`,
    bin: path.join(dir, 'bin'),
    fake: path.join(dir, 'bin', 'fake-claude'),
    log: path.join(dir, 'fake.log'),
    projects: path.join(dir, 'projects'),
    tmp: path.join(dir, 'tmp'),
  };
  for (const d of [ctx.bin, ctx.projects, ctx.tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(ctx.fake, FAKE_CLAUDE('v1'), { mode: 0o755 });
  fs.writeFileSync(ctx.log, '');
  const paneEnv = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    HOME: dir, HISTFILE: '/dev/null', TERM: 'xterm', PS1: 'pw$ ',
    TMPDIR: ctx.tmp, FAKE_LOG: ctx.log, FAKE_PROJECTS: ctx.projects, FAKE_HOOK: HOOK,
  };
  const envArgs = Object.entries(paneEnv).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const env = { ...process.env };
  delete env.TMUX;
  ctx.server = createFixtureTmuxServer({ socket: ctx.sock, session: 't', command: `env -i ${envArgs} bash --noprofile --norc`, env });
  ctx.pane = 't:0';
  assert.ok(await until(async () => /pw\$ $/.test((await screen(ctx)).trimEnd() + ' ')), 'the shell must come up');
  return ctx;
}
async function teardown(ctx) {
  for (const e of events(ctx)) { try { process.kill(e.pid, 'SIGKILL'); } catch { /* gone */ } }
  ctx.server?.release();
  await sleep(100);
  await fsp.rm(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const screen = (ctx) => tmux(ctx.sock, ['capture-pane', '-p', '-J', '-S', '-200', '-t', ctx.pane]);
const paneCommand = (ctx) => tmux(ctx.sock, ['display-message', '-p', '-t', ctx.pane, '#{pane_current_command}']);
async function type(ctx, text) {
  await tmux(ctx.sock, ['send-keys', '-t', ctx.pane, '-l', text]);
  await tmux(ctx.sock, ['send-keys', '-t', ctx.pane, 'Enter']);
}
function events(ctx) {
  try {
    return fs.readFileSync(ctx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
async function waitEvent(ctx, pred, what, timeoutMs = 20000) {
  let found = null;
  await until(() => { found = events(ctx).find(pred) || null; return !!found; }, timeoutMs);
  assert.ok(found, `waited for ${what}; saw ${JSON.stringify(events(ctx))}`);
  return found;
}
async function waitScreen(ctx, re, timeoutMs = 20000) {
  assert.ok(await until(async () => re.test(await screen(ctx)), timeoutMs), `waited for ${re}; screen:\n${await screen(ctx)}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exits = async (ctx) => (await screen(ctx)).match(/EXIT=\d+/g) || [];
async function launch(ctx, args, { prefix = '', loader = true, entry = ctx.fake } = {}) {
  const before = events(ctx).filter((e) => e.event === 'start').length;
  const command = loader ? `node ${shq(LOADER)} ${shq(entry)}` : shq(entry);
  await type(ctx, `${prefix}${command} ${args}; echo "EXIT=$?"`.replace(/\s+;/, ';'));
  await until(() => events(ctx).filter((e) => e.event === 'start').length > before);
  const starts = events(ctx).filter((e) => e.event === 'start');
  assert.ok(starts.length > before, `the stand-in must start; screen:\n${await screen(ctx)}`);
  await waitScreen(ctx, /FAKE-READY/);
  return starts[starts.length - 1];
}
// Waits for the job started by the last launch to end, and returns the status the shell reported.
async function ended(ctx, action, status) {
  const before = (await exits(ctx)).length;
  await action();
  assert.ok(await until(async () => (await exits(ctx)).length > before), `waited for the job to end; screen:\n${await screen(ctx)}`);
  assert.equal((await exits(ctx)).at(-1), `EXIT=${status}`);
}
const conversation = (ctx, sid, body = '{"type":"user","message":{"content":"hello"}}\n') =>
  fs.writeFileSync(path.join(ctx.projects, `${sid}.jsonl`), body);

test('/restart starts Claude again in the same pane and conversation, with the options it was started with', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    conversation(ctx, sid);
    const first = await launch(ctx, `--resume ${sid} --model opus --name restart-test`);
    const loaderPid = first.ppid;
    assert.equal(first.loader, String(loaderPid), 'Claude is told which loader started it');

    const samples = [];
    let sampling = true;
    const sampler = (async () => { while (sampling) { samples.push(await paneCommand(ctx)); await sleep(40); } })();
    await type(ctx, '/restart');
    const hook = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === first.pid, 'the hook answer');
    const second = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== first.pid, 'Claude to start again');
    await sleep(300);
    sampling = false;
    await sampler;

    assert.deepEqual(hook.decision, RESTARTING, 'the expansion is blocked, so nothing reaches the model');
    assert.ok(events(ctx).some((e) => e.event === 'term' && e.pid === first.pid), 'the first Claude was stopped with SIGTERM');
    assert.equal(second.ppid, loaderPid, 'started again by the same loader, in the same terminal');
    assert.equal(second.sid, sid);
    assert.deepEqual(second.args, ['--resume', sid, '--model', 'opus', '--name', 'restart-test']);
    assert.ok(samples.length >= 5, `sampled the pane ${samples.length} times`);
    for (const cmd of samples) assert.equal(taskWindowIsIdle(cmd), false, `the pane showed ${cmd}, which scheduled tasks read as an idle shell`);
    assert.deepEqual(await exits(ctx), [], 'the shell never got its prompt back');

    await ended(ctx, () => type(ctx, '/exit'), 0);
  } finally { await teardown(ctx); }
});

test('what a restart repeats: the options, never the prompt or the options that picked the conversation', () => {
  const plan = (...args) => JSON.parse(execFileSync(process.execPath, [LOADER, '--relaunch-plan', '--', ...args], { encoding: 'utf8' }));
  const cases = [
    // What the PW wrapper itself adds, read the way Commander reads it.
    [['--dangerously-skip-permissions', '--add-dir', '/opt/pw/memory', '--remote-control', '--mcp-config', '/etc/pw/mcp.json', '--strict-mcp-config'],
      ['--dangerously-skip-permissions', '--add-dir', '/opt/pw/memory', '--remote-control', '--mcp-config', '/etc/pw/mcp.json', '--strict-mcp-config']],
    [['--model', 'opus', '--effort', 'xhigh', '--resume', 'abc', 'fix', 'the', 'bug'], ['--model', 'opus', '--effort', 'xhigh']],
    [['-c', '--fork-session', '-n', 'PVIKPBot'], ['-n', 'PVIKPBot']],
    [['--session-id', '11111111-2222-4333-8444-555555555555', '--from-pr', '12', '--verbose'], ['--verbose']],
    [['-rsearch', '--model=sonnet', 'hello'], ['--model=sonnet']],
    [['-cd', 'api,hooks'], ['-d', 'api,hooks']],
    // A variadic option keeps every word up to the next option, as Claude did: those were never the prompt.
    [['--add-dir', '/a', '/b', '--verbose', 'the', 'prompt'], ['--add-dir', '/a', '/b', '--verbose']],
    [['--remote-control', 'my-name', '--settings', '{"a":1}'], ['--remote-control', 'my-name', '--settings', '{"a":1}']],
    [['--model', 'opus', '--', '--not-an-option'], ['--model', 'opus']],
  ];
  for (const [args, kept] of cases) assert.deepEqual(plan(...args), { ok: true, args: kept }, args.join(' '));
  const refusals = [
    [['--worktree', 'feature'], /--worktree/],
    [['-w'], /--worktree/],
    [['--bg'], /background/],
    [['-p', 'hi'], /not an interactive session/],
    [['mcp', 'list'], /"mcp" command/],
    [['--frobnicate'], /--frobnicate, an option \/restart does not know/],
    [['--verbose=yes'], /cannot read/],
  ];
  for (const [args, reason] of refusals) {
    const out = plan(...args);
    assert.equal(out.ok, false, args.join(' '));
    assert.match(out.reason, reason, args.join(' '));
  }
});

test('a conversation with nothing on disk keeps its id, and one Claude Code cannot resume starts afresh', { timeout: 60000 }, async () => {
  for (const [label, prepare, expected] of [
    ['no transcript', () => {}, (sid) => ['--session-id', sid, '--model', 'opus']],
    ['a transcript with only settings', (ctx, sid) => conversation(ctx, sid, '{"type":"mode","mode":"default"}\n'), () => ['--model', 'opus']],
  ]) {
    const ctx = await setup();
    try {
      const sid = crypto.randomUUID();
      prepare(ctx, sid);
      const first = await launch(ctx, `--session-id ${sid} --model opus`, { prefix: 'FAKE_NO_NOTICE=1 ' });
      await type(ctx, '/restart');
      const second = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== first.pid, `${label}: Claude to start again`);
      assert.deepEqual(second.args, expected(sid), label);
    } finally { await teardown(ctx); }
  }
});

test('exit statuses and signals are the ones cli-wrapper.cjs gave', { timeout: 90000 }, async () => {
  const ctx = await setup();
  try {
    await launch(ctx, '');
    await ended(ctx, () => type(ctx, '/fail'), 7);

    const killed = await launch(ctx, '');
    await ended(ctx, async () => process.kill(killed.pid, 'SIGKILL'), 137);

    // Signals sent to the job, as hibernation and a closing window send them, reach Claude directly.
    for (const [signal, status] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
      const c = await launch(ctx, '');
      await ended(ctx, async () => process.kill(-c.ppid, signal), status);
      if (signal === 'SIGTERM') assert.ok(events(ctx).some((e) => e.event === 'term' && e.pid === c.pid), 'Claude received the SIGTERM itself');
      assert.ok(await until(() => !alive(c.pid), 5000), `Claude ended on ${signal}`);
    }
    assert.equal(events(ctx).filter((e) => e.event === 'start').length, 4, 'nothing was restarted that was not asked to be');
  } finally { await teardown(ctx); }
});

test('what /restart cannot do is refused with the reason, and nothing is stopped', { timeout: 90000 }, async () => {
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    conversation(ctx, sid);
    const c = await launch(ctx, `--resume ${sid}`);
    await type(ctx, '/restart now');
    const hook = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === c.pid, 'the hook answer');
    assert.equal(hook.decision.reason, 'Invalid argument "now". Usage: /restart');

    // A claude started from inside this session inherits its loader variables; it must not restart this one.
    await type(ctx, '/nested');
    const nested = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid !== c.pid, 'the nested claude\'s hook answer');
    assert.match(nested.decision.reason, /^Restart is not available/);
    await sleep(500);
    await ended(ctx, () => type(ctx, '/exit'), 0);

    // A session /restart cannot repeat.
    const w = await launch(ctx, '--worktree feature');
    await type(ctx, '/restart');
    const refused = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === w.pid, 'the hook answer');
    assert.match(refused.decision.reason, /^Restart is not available: it was started with --worktree/);
    await ended(ctx, () => type(ctx, '/exit'), 0);

    // A Claude Code started without the loader, as every session that predates it was.
    const bare = await launch(ctx, `--resume ${sid}`, { loader: false });
    await type(ctx, '/restart');
    const outside = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === bare.pid, 'the hook answer');
    assert.equal(outside.decision.reason, `Restart is not available. Claude Code was not started through the loader. To restart by hand, run /exit and then: claude --resume ${sid}`);
    await ended(ctx, () => type(ctx, '/exit'), 0);

    assert.deepEqual(events(ctx).filter((e) => e.event === 'term'), [], 'no Claude was stopped');
    assert.equal(events(ctx).filter((e) => e.event === 'start').length, 4, 'and none was started again');
  } finally { await teardown(ctx); }
});

test('REGRESSION: the stop timeout never reaches the Claude that replaced the one it was for', { timeout: 60000 }, async () => {
  // Found on a real Claude Code: the timeout read "the current child", which is the NEW Claude once the old one
  // has exited, and killed it 10 s after every restart.
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    conversation(ctx, sid);
    const first = await launch(ctx, `--resume ${sid}`, { prefix: 'PW_CLAUDE_LOADER_STOP_MS=1500 ' });
    await type(ctx, '/restart');
    const next = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== first.pid, 'Claude to start again');
    await sleep(3500); // well past the 1.5 s the first Claude was given to stop
    assert.ok(alive(next.pid), 'the new Claude is still running');
    assert.equal(events(ctx).filter((e) => e.event === 'start').length, 2);
    await ended(ctx, () => type(ctx, '/exit'), 0);
  } finally { await teardown(ctx); }
});

test('a Claude that will not stop is killed and started again; a second /restart meanwhile is refused', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    conversation(ctx, sid);
    const first = await launch(ctx, `--resume ${sid}`, { prefix: `PW_CLAUDE_LOADER_STOP_MS=4000 FAKE_IGNORE_TERM_ONCE=${shq(path.join(ctx.dir, 'ignored'))} ` });
    await type(ctx, '/restart');
    await waitEvent(ctx, (e) => e.event === 'term-ignored' && e.pid === first.pid, 'the first Claude to ignore SIGTERM');
    await type(ctx, '/restart');
    const second = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === first.pid && e.decision?.reason !== RESTARTING.reason, 'the second answer');
    assert.equal(second.decision.reason, 'Restart is not available: a restart is already in progress.');
    const next = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== first.pid, 'Claude to start again after the kill');
    assert.equal(next.ppid, first.ppid);
    assert.deepEqual(next.args, ['--resume', sid]);
    assert.ok(await until(() => !alive(first.pid), 5000), 'the Claude that would not stop is gone');
    assert.equal(events(ctx).filter((e) => e.event === 'start').length, 2);
    await ended(ctx, () => type(ctx, '/exit'), 0);
  } finally { await teardown(ctx); }
});

test('a Claude Code updated while the session ran is the one /restart brings back', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const sid = crypto.randomUUID();
    conversation(ctx, sid);
    const first = await launch(ctx, `--resume ${sid}`);
    assert.equal(first.version, 'v1');
    // npm replaces the file; the running process keeps the old one.
    const tmp = `${ctx.fake}.new`;
    fs.writeFileSync(tmp, FAKE_CLAUDE('v2'), { mode: 0o755 });
    fs.renameSync(tmp, ctx.fake);
    await type(ctx, '/restart');
    const second = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== first.pid, 'Claude to start again');
    assert.equal(second.version, 'v2');
  } finally { await teardown(ctx); }
});

test('from the npm package: the native binary runs directly, as cli-wrapper.cjs runs it, and restarts work either way', { timeout: 90000 }, async () => {
  const ctx = await setup();
  try {
    const report = process.report?.getReport?.();
    const musl = process.platform === 'linux' && report != null && report.header?.glibcVersionRuntime === undefined;
    const pkg = path.join(ctx.dir, 'npm', '@anthropic-ai', 'claude-code');
    const nativeDir = path.join(pkg, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${os.arch()}${musl ? '-musl' : ''}`);
    fs.mkdirSync(nativeDir, { recursive: true });
    const entry = path.join(pkg, 'cli-wrapper.cjs');
    fs.writeFileSync(entry, FAKE_VENDOR_WRAPPER, { mode: 0o644 });
    fs.copyFileSync(ctx.fake, path.join(nativeDir, 'claude'));
    fs.chmodSync(path.join(nativeDir, 'claude'), 0o755);

    const direct = await launch(ctx, '--model opus', { entry });
    const loaderPid = Number(direct.loader);
    assert.equal(direct.ppid, loaderPid, 'one node process, not two: the loader runs the native binary itself');
    assert.equal(direct.npmWrapper, '1', 'with the variable cli-wrapper.cjs sets');
    await type(ctx, '/restart');
    const again = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== direct.pid, 'Claude to start again');
    assert.equal(again.ppid, loaderPid);
    await ended(ctx, () => type(ctx, '/exit'), 0);

    // A layout the loader does not recognise: it runs cli-wrapper.cjs, which runs Claude as ITS child.
    fs.rmSync(path.join(nativeDir, 'claude'));
    const viaVendor = await launch(ctx, '--model opus', { entry, prefix: `FAKE_NATIVE=${shq(ctx.fake)} ` });
    assert.notEqual(viaVendor.ppid, Number(viaVendor.loader), 'Claude is the vendor launcher\'s child');
    await type(ctx, '/restart');
    const hook = await waitEvent(ctx, (e) => e.event === 'hook' && e.pid === viaVendor.pid, 'the hook answer');
    assert.deepEqual(hook.decision, RESTARTING);
    const back = await waitEvent(ctx, (e) => e.event === 'start' && e.pid !== viaVendor.pid && e.pid !== direct.pid && e.pid !== again.pid, 'Claude to start again');
    assert.deepEqual(back.args, ['--resume', viaVendor.sid, '--model', 'opus']);
    assert.ok(await until(() => !alive(viaVendor.ppid), 5000), 'the old vendor launcher ended with its Claude');
  } finally { await teardown(ctx); }
});

test('Ctrl-Z suspends the whole job and fg brings it back, as before', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const c = await launch(ctx, '');
    await tmux(ctx.sock, ['send-keys', '-t', ctx.pane, 'C-z']);
    await waitScreen(ctx, /Stopped/);
    assert.equal(taskWindowIsIdle(await paneCommand(ctx)), true, 'sanity: a suspended job gives the shell back');
    assert.equal(await until(() => /^T/.test(fs.readFileSync(`/proc/${c.pid}/stat`, 'utf8').split(') ')[1] || ''), 3000), true, 'Claude itself is stopped');
    await type(ctx, 'fg');
    assert.ok(await until(async () => !taskWindowIsIdle(await paneCommand(ctx))), 'fg puts the job back in front');
    await type(ctx, '/exit');
    await waitEvent(ctx, (e) => e.event === 'exit' && e.pid === c.pid, 'Claude to read /exit after fg');
    assert.ok(await until(async () => taskWindowIsIdle(await paneCommand(ctx))), 'and the shell has the terminal again');
  } finally { await teardown(ctx); }
});

// The wrapper is generated by update-claude-code. Run the generated text, with its fixed paths pointed into the
// test: the instance config, the loader, node, and npm's global root.
test('the claude wrapper runs interactive sessions under the loader, and nothing else', { timeout: 60000 }, async () => {
  const ctx = await setup();
  try {
    const body = fs.readFileSync(UPDATER, 'utf8');
    const start = body.indexOf("cat > /usr/local/bin/claude <<'BASH'\n");
    const end = body.indexOf('\nBASH\n', start);
    assert.ok(start > 0 && end > start, 'the wrapper heredoc is where this test expects it');
    let wrapper = body.slice(body.indexOf('\n', start) + 1, end + 1);
    const swap = (from, to) => {
      assert.ok(wrapper.includes(from), `the wrapper still contains ${from}`);
      wrapper = wrapper.split(from).join(to);
    };
    const root = path.join(ctx.dir, 'npm');
    const entry = path.join(root, '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');
    const fakeLoader = path.join(ctx.bin, 'fake-loader');
    const config = path.join(ctx.dir, 'claude-wrapper.env');
    swap('CONFIG=/etc/project-workbench/claude-wrapper.env', `CONFIG=${config}`);
    swap('PW_CLAUDE_LOADER=/usr/local/bin/pw-claude-loader', `PW_CLAUDE_LOADER=${fakeLoader}`);
    swap('/usr/bin/node', process.execPath);
    const claude = path.join(ctx.bin, 'claude');
    fs.writeFileSync(claude, wrapper, { mode: 0o755 });
    fs.writeFileSync(path.join(ctx.bin, 'npm'), `#!/bin/sh\necho ${shq(root)}\n`, { mode: 0o755 });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    const recorder = (kind) => `const fs = require('fs'); fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ event: ${JSON.stringify(kind)}, pid: process.pid, argv: process.argv.slice(2) }) + '\\n');\n`;
    fs.writeFileSync(entry, recorder('direct'));
    fs.writeFileSync(fakeLoader, recorder('loader'), { mode: 0o755 });
    fs.writeFileSync(config, 'PW_SHARED_MEMORY=/nonexistent\nPW_MCP_MODE=inherit\nPW_PERMISSION_MODE=prompt\nPW_REMOTE_CONTROL=true\n');

    const ran = async (prefix, args) => {
      const before = events(ctx).length;
      await type(ctx, `${prefix}PATH=${shq(ctx.bin)}:$PATH ${shq(claude)} ${args}`);
      assert.ok(await until(() => events(ctx).length > before), `the wrapper ran something for: ${prefix}${args}`);
      return events(ctx).at(-1);
    };
    const viaLoader = await ran('', '--model opus');
    assert.deepEqual([viaLoader.event, viaLoader.argv], ['loader', [entry, '--remote-control', '--model', 'opus']]);
    assert.deepEqual((await ran('', '-p hello')).event, 'direct', 'a print run');
    assert.deepEqual((await ran('PW_CLAUDE_RESTART=off ', '--model opus')).event, 'direct', 'turned off for one launch');
    assert.deepEqual((await ran('', '--model opus < /dev/null')).event, 'direct', 'stdin is not a terminal');
    assert.deepEqual((await ran('', '--model opus | cat')).event, 'direct', 'stdout is not a terminal');
    fs.appendFileSync(config, 'PW_CLAUDE_RESTART=off\n');
    assert.deepEqual((await ran('', '--model opus')).event, 'direct', 'turned off in claude-wrapper.env');
    fs.writeFileSync(config, 'PW_SHARED_MEMORY=/nonexistent\nPW_REMOTE_CONTROL=true\n');
    fs.rmSync(fakeLoader);
    assert.deepEqual((await ran('', '--model opus')).event, 'direct', 'a host without the loader');
  } finally { await teardown(ctx); }
});
