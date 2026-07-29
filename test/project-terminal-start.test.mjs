// scripts/project-terminal-start is the HOST-MODE, systemd-launched terminal
// startup path (project-terminal@.service, User=admin) — a real production
// entrypoint, not a dev convenience. It must apply the SAME fail-closed
// per-user credential contract as app/server.js (AC1 of the PR #20
// remediation): when PW_PER_USER_CLAUDE is on and the project has a
// primaryUser, resolve/decrypt/materialize that owner's credentials via
// app/project-terminal-credentials.mjs and refuse to start tmux/ttyd on any
// failure; when the feature is off or the project has no primaryUser,
// behavior must be byte-identical to before this change.
//
// Runs the REAL script + REAL tmux, isolated onto a private tmux socket
// (PW_TMUX_SOCKET, the same isolation mechanism app/server.js already uses)
// so this can never collide with — or touch — any real project terminal on
// the host. Never uses the production registry path or app dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'project-terminal-start');
const APP_DIR = path.join(REPO, 'app');

function tmuxSock() {
  return 'pw20test-' + crypto.randomBytes(4).toString('hex');
}

async function tmux(sock, args) {
  return execFileAsync('tmux', ['-L', sock, ...args]);
}
async function tmuxOk(sock, args) {
  try { await tmux(sock, args); return true; } catch { return false; }
}

async function killSock(sock) {
  try { await tmux(sock, ['kill-server']); } catch { /* already gone */ }
  // tmux's kill-server does not remove its own socket file on this system —
  // without this, every run leaks an (empty, harmless, but accumulating)
  // socket special file under /tmp/tmux-<uid>/.
  try { await fsp.rm(`/tmp/tmux-${process.getuid()}/${sock}`, { force: true }); } catch { /* fine */ }
}

// tmux's own "session environment" (show-environment) is a separate tracked
// concept from what actually reaches the pane's process — the env this
// script injects arrives via the exec'd `env KEY=VAL ... bash` command
// string, not tmux -e. Read the real process environment directly.
async function paneEnviron(sock, session) {
  const { stdout: pidOut } = await tmux(sock, ['list-panes', '-t', session, '-F', '#{pane_pid}']);
  const pid = pidOut.trim().split('\n')[0];
  const raw = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

async function setup({ primaryUser = null, users = [], enabled = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-pts-'));
  const name = 'pw20test_' + crypto.randomBytes(4).toString('hex');
  const projPath = path.join(dir, 'workspaces', name);
  await fsp.mkdir(projPath, { recursive: true });
  // A random high port, far outside any real deployment's range, so a
  // real production ttyd on this host can never collide with the test.
  const port = 19000 + crypto.randomInt(0, 4000);
  const registry = [{ name, path: projPath, port, ...(primaryUser ? { primaryUser } : {}) }];
  await fsp.writeFile(path.join(dir, 'projects.json'), JSON.stringify(registry));
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users }));
  await fsp.writeFile(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex'));
  const sock = tmuxSock();
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_APP_DIR: APP_DIR,
    PW_TMUX_SOCKET: sock,
    PW_PER_USER_CLAUDE: enabled ? 'true' : '',
  };
  return { dir, name, projPath, sock, env };
}

async function teardown(ctx) {
  await killSock(ctx.sock);
  await fsp.rm(ctx.dir, { recursive: true, force: true });
}

async function runScript(ctx) {
  // The real script ends with `exec ttyd ...`, which would hang the test
  // waiting for a server that never exits. Run it with a short timeout and
  // treat ttyd actually starting (i.e. we had to kill it) as success — what
  // matters for these tests is what happened BEFORE that exec: the tmux
  // session state and the exit code on a credential failure (which returns
  // long before reaching ttyd at all).
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [ctx.name], { env: ctx.env, timeout: 4000 });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (e) {
    const timedOut = e.signal === 'SIGTERM' || e.killed === true;
    return { code: timedOut ? 0 : e.code, stdout: e.stdout || '', stderr: e.stderr || '', timedOut };
  }
}

test('disabled feature: unchanged shared-login behavior — session starts with no CLAUDE_CONFIG_DIR', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  try {
    const result = await runScript(ctx);
    assert.ok(result.timedOut || result.code === 0, JSON.stringify(result));
    const session = 'pw_' + ctx.name;
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', session]), 'the tmux session must have been created');
    const env = await paneEnviron(ctx.sock, session);
    assert.equal('CLAUDE_CONFIG_DIR' in env, false, 'shared-login sessions must not carry a per-user config dir');
  } finally { await teardown(ctx); }
});

test('no primaryUser: unchanged shared-login behavior even with the feature on', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: null });
  try {
    const result = await runScript(ctx);
    assert.ok(result.timedOut || result.code === 0, JSON.stringify(result));
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', 'pw_' + ctx.name]));
  } finally { await teardown(ctx); }
});

test('enabled + valid owner: the session carries the owner\'s CLAUDE_CONFIG_DIR and a stamped fingerprint', { timeout: 15000 }, async () => {
  const secretKey = crypto.randomBytes(32).toString('hex');
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_SECRET_KEY_PATH, secretKey);
  await fsp.writeFile(ctx.env.PW_USERS_PATH, JSON.stringify({ users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_realtoken') }] }));
  try {
    const result = await runScript(ctx);
    assert.ok(result.timedOut || result.code === 0, JSON.stringify(result));
    const session = 'pw_' + ctx.name;
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', session]));
    const env = await paneEnviron(ctx.sock, session);
    assert.match(env.CLAUDE_CONFIG_DIR || '', /pw-users.*alice.*claude/);
    const key = (await tmux(ctx.sock, ['show-options', '-t', session, '-qv', '@pw_cred_key'])).stdout.trim();
    assert.match(key, /^[0-9a-f]{16}$/, 'the session must be stamped with the real per-user fingerprint, matching app/server.js\'s contract');
  } finally { await teardown(ctx); }
});

test('REGRESSION: a dangling primaryUser fails closed — exits nonzero BEFORE any tmux session is created', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'ghost', users: [] });
  try {
    const result = await runScript(ctx);
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.equal(result.timedOut, false, 'must fail before ever reaching the ttyd exec');
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', 'pw_' + ctx.name]), false,
      'no tmux session (and therefore no shared-login fallback) may be created when the owner cannot be resolved');
    assert.match(result.stderr, /ghost|credential/i);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a corrupt users.json fails closed before tmux/ttyd', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_USERS_PATH, '{ not valid json');
  try {
    const result = await runScript(ctx);
    assert.notEqual(result.code, 0);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', 'pw_' + ctx.name]), false);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a materialization failure (cred base unusable) fails closed before tmux/ttyd', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_USER_CRED_BASE, 'not a directory');
  try {
    const result = await runScript(ctx);
    assert.notEqual(result.code, 0);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', 'pw_' + ctx.name]), false);
  } finally { await teardown(ctx); }
});

test('SECURITY: no secret ever appears in the script\'s own stdout/stderr', { timeout: 15000 }, async () => {
  const secretKey = crypto.randomBytes(32).toString('hex');
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_SECRET_KEY_PATH, secretKey);
  await fsp.writeFile(ctx.env.PW_USERS_PATH, JSON.stringify({ users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_MUST_NOT_LEAK') }] }));
  try {
    const result = await runScript(ctx);
    assert.equal(result.stdout.includes('ghp_MUST_NOT_LEAK'), false);
    assert.equal(result.stderr.includes('ghp_MUST_NOT_LEAK'), false);
  } finally { await teardown(ctx); }
});
