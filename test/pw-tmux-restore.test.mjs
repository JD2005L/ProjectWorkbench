// scripts/pw-tmux-restore recreates project tmux sessions/windows after a
// reboot from a saved manifest (scripts/pw-tmux-save), ordered before the
// per-project ttyd terminals so project-terminal-start finds them already
// there. It must apply the SAME fail-closed per-user credential contract as
// project-terminal-start / app/server.js (AC1 of the PR #20 remediation) —
// round 6 found it did not: it recreated every session/window with a single
// fixed shared ENVBASH, no owner resolution, no fingerprint at all, then
// resumed Claude conversations under that shared identity regardless of
// PW_PER_USER_CLAUDE or a project's primaryUser. A reboot silently downgraded
// every restored project back to the shared login — the exact silent
// identity swap the whole feature exists to prevent.
//
// Runs the REAL script + REAL tmux, isolated onto a private tmux socket
// (PW_TMUX_SOCKET, the same isolation mechanism project-terminal-start and
// app/server.js already use) so this can never collide with — or touch — any
// real project terminal, or any OTHER tmux server on the host (including one
// the test harness itself might be running inside of). See the final test in
// this file for a direct regression proving that.
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
const SCRIPT = path.join(REPO, 'scripts', 'pw-tmux-restore');
const APP_DIR = path.join(REPO, 'app');
const SEP = '\x1f';

function tmuxSock() {
  return 'pw20restoretest-' + crypto.randomBytes(4).toString('hex');
}
async function tmux(sock, args) {
  return execFileAsync('tmux', ['-L', sock, ...args]);
}
async function tmuxOk(sock, args) {
  try { await tmux(sock, args); return true; } catch { return false; }
}
async function killSock(sock) {
  try { await tmux(sock, ['kill-server']); } catch { /* already gone */ }
  try { await fsp.rm(`/tmp/tmux-${process.getuid()}/${sock}`, { force: true }); } catch { /* fine */ }
}
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

function writeManifest(manifestPath, rows) {
  const lines = rows.map((r) => [r.s, r.w, r.wn, r.cwd, r.hasc, r.sid || '', r.cfile || ''].join(SEP));
  fs.writeFileSync(manifestPath, lines.join('\n') + '\n');
}

async function setup({ primaryUser = null, users = [], enabled = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-restore-'));
  const name = 'pw20restore_' + crypto.randomBytes(4).toString('hex');
  const projPath = path.join(dir, 'workspaces', name);
  await fsp.mkdir(projPath, { recursive: true });
  const port = 19000 + crypto.randomInt(0, 4000);
  const registry = [{ name, path: projPath, port, ...(primaryUser ? { primaryUser } : {}) }];
  await fsp.writeFile(path.join(dir, 'projects.json'), JSON.stringify(registry));
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users }));
  await fsp.writeFile(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex'));
  const stateDir = path.join(dir, 'tmux-persist');
  await fsp.mkdir(stateDir, { recursive: true });
  const sock = tmuxSock();
  const session = 'pw_' + name;
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
    PW_TMUX_STATE_DIR: stateDir,
    PW_TMUX_LOG: path.join(stateDir, 'persist.log'),
    PW_CLAUDE_SESSIONS_DIR: path.join(dir, 'claude-sessions'), // absent dir: no live-sid guard entries, fine
    PW_CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-projects'),
    PW_TMUX_RESTORE_CLAUDE: '1',
  };
  return { dir, name, projPath, port, sock, env, session, stateDir };
}

async function teardown(ctx) {
  await killSock(ctx.sock);
  await fsp.rm(ctx.dir, { recursive: true, force: true });
}

async function runScript(ctx) {
  return execFileAsync(SCRIPT, [], { env: ctx.env, timeout: 15000 });
}

test('attributed user: a restored session carries the owner\'s CLAUDE_CONFIG_DIR and a stamped real fingerprint', { timeout: 15000 }, async () => {
  const secretKey = crypto.randomBytes(32).toString('hex');
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_SECRET_KEY_PATH, secretKey);
  await fsp.writeFile(ctx.env.PW_USERS_PATH, JSON.stringify({ users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_realtoken') }] }));
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    const { stdout, stderr } = await runScript(ctx);
    assert.doesNotThrow(() => {}, `sanity: script must exit 0\n${stdout}\n${stderr}`);
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), 'the session must have been created');
    const env = await paneEnviron(ctx.sock, ctx.session);
    assert.match(env.CLAUDE_CONFIG_DIR || '', /pw-users.*alice.*claude/);
    const key = (await tmux(ctx.sock, ['show-options', '-t', ctx.session, '-v', '@pw_cred_key'])).stdout.trim();
    assert.match(key, /^[0-9a-f]{16}$/, 'the session must be stamped with the real per-user fingerprint');
  } finally { await teardown(ctx); }
});

test('disabled mode: a restored session carries the shared login with fingerprint stamped exactly "off"', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]));
    const env = await paneEnviron(ctx.sock, ctx.session);
    assert.equal('CLAUDE_CONFIG_DIR' in env, false, 'shared-login sessions must not carry a per-user config dir');
    const key = (await tmux(ctx.sock, ['show-options', '-t', ctx.session, '-v', '@pw_cred_key'])).stdout.trim();
    assert.equal(key, 'off', 'disabled mode must stamp the exact "off" sentinel, never a real fingerprint');
  } finally { await teardown(ctx); }
});

test('REGRESSION: enabled but no primaryUser configured fails closed — never resolves to shared/off (stricter than the human terminal path)', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: null });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false,
      'no session (and therefore no shared-login fallback) may be created when per-user credentials are on but no primaryUser is configured');
    const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
    assert.match(log, /no primaryUser configured/i);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a dangling primaryUser (missing owner) refuses to restore the session under shared credentials', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'ghost', users: [] });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false,
      'no session (and therefore no shared-login fallback) may be created when the owner cannot be resolved');
    const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
    assert.match(log, /refusing to create session|credential resolution failed/i);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a corrupt users.json refuses to restore the session under shared credentials', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_USERS_PATH, '{ not valid json');
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false);
  } finally { await teardown(ctx); }
});

test('REGRESSION: no current project maps to a manifest session name — refuses rather than restoring under shared credentials', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true });
  // Empty registry: the session in the manifest belongs to a project that no
  // longer exists (deleted since the last save, or renamed).
  await fsp.writeFile(ctx.env.PW_REGISTRY_PATH, '[]');
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false);
    const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
    assert.match(log, /no current project maps to session/i);
  } finally { await teardown(ctx); }
});

// Item 3-style hardening (round 5), applied to this script too: a tmux
// control-plane failure while stamping/reading the fingerprint must fail
// closed, never be silently treated as success or as "unstamped".
function makeTmuxShim(dir) {
  const shimDir = fs.mkdtempSync(path.join(dir, 'tmux-shim-'));
  const markerPath = path.join(dir, 'tmux-fail.marker');
  fs.writeFileSync(path.join(shimDir, 'tmux'), `#!/usr/bin/env bash
target=""
prev=""
subcmd=""
for arg in "$@"; do
  if [[ "$prev" == "-t" ]]; then target="$arg"; fi
  if [[ "$arg" == "show-options" || "$arg" == "set-option" ]]; then subcmd="$arg"; fi
  prev="$arg"
done
if [[ -n "$subcmd" ]] \\
   && [[ -n "\${PW_TEST_TMUX_FAIL_SESSION:-}" && "$target" == "$PW_TEST_TMUX_FAIL_SESSION" ]] \\
   && [[ -n "\${PW_TEST_TMUX_FAIL_MARKER:-}" && -f "$PW_TEST_TMUX_FAIL_MARKER" ]]; then
  echo "injected test failure: simulated tmux control-plane error" >&2
  exit 1
fi
exec "$PW_TEST_REAL_TMUX" "$@"
`, { mode: 0o755 });
  return { shimDir, markerPath };
}

test('REGRESSION: a tmux control-plane failure stamping a FRESH session fails closed — no window/resume added for it', { timeout: 15000 }, async () => {
  const secretKey = crypto.randomBytes(32).toString('hex');
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  await fsp.writeFile(ctx.env.PW_SECRET_KEY_PATH, secretKey);
  await fsp.writeFile(ctx.env.PW_USERS_PATH, JSON.stringify({ users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_x') }] }));
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
    { s: ctx.session, w: 1, wn: 'Second', cwd: ctx.projPath, hasc: 0 },
  ]);
  const { shimDir, markerPath } = makeTmuxShim(ctx.dir);
  const realTmux = await execFileAsync('bash', ['-c', 'command -v tmux']).then((r) => r.stdout.trim());
  fs.writeFileSync(markerPath, '1'); // armed before the very first set-option (fresh-session stamp)
  ctx.env.PATH = `${shimDir}:${ctx.env.PATH}`;
  ctx.env.PW_TEST_REAL_TMUX = realTmux;
  ctx.env.PW_TEST_TMUX_FAIL_SESSION = ctx.session;
  ctx.env.PW_TEST_TMUX_FAIL_MARKER = markerPath;
  try {
    await runScript(ctx);
    // The shim's own tmux binary lacks -L socket awareness quirks, so has-session below
    // still goes through the shim (which passes through to the real tmux for anything
    // that isn't the injected failure) — this is fine, has-session is not the failing call.
    const stillHasSession = await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]);
    if (stillHasSession) {
      // Never-kill policy: the freshly created (but unverifiable) session may still exist,
      // but must NOT have received the second window or a Claude resume.
      const { stdout } = await tmux(ctx.sock, ['list-windows', '-t', ctx.session, '-F', '#{window_name}']);
      assert.equal(stdout.trim().split('\n').filter(Boolean).length, 1, 'no further windows may be added once the stamp cannot be verified');
    }
    const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
    assert.match(log, /could not verify credential fingerprint stamp/i);
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// REGRESSION: restore must NEVER touch a tmux server other than the one it
// was explicitly told to use — not the real per-user default socket, not
// another isolated instance, and not one the CALLING environment happens to
// be running inside of (a wrapping tmux client sets $TMUX, which a bare tmux
// invocation would otherwise silently target). This is exactly the failure
// mode that matters in practice: this script's own harness (systemd, or an
// interactive dev/test session) must never have an unrelated tmux server
// disrupted by a restore run.
// ---------------------------------------------------------------------------
test('REGRESSION: restore never touches an unrelated tmux server, including one implied by an inherited $TMUX', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);

  // An "unrelated" server, standing in for the real default socket / a
  // wrapping harness session / any other isolated instance — deliberately
  // NOT the socket PW_TMUX_SOCKET points restore at.
  const unrelatedSock = tmuxSock();
  const unrelatedSession = 'unrelated_' + crypto.randomBytes(4).toString('hex');
  await tmux(unrelatedSock, ['new-session', '-d', '-s', unrelatedSession, '-c', '/tmp']);
  assert.ok(await tmuxOk(unrelatedSock, ['has-session', '-t', unrelatedSession]), 'sanity: the unrelated server must be up before restore runs');

  try {
    // Simulate exactly the hazard: the calling environment is itself inside a
    // tmux client whose $TMUX points at the "unrelated" server's socket path
    // — the natural state of an interactive dev shell, or (as happened during
    // this remediation) an agent's own wrapping session. A correctly isolated
    // script must ignore this entirely because PW_TMUX_SOCKET is explicit.
    const unrelatedSocketPath = `/tmp/tmux-${process.getuid()}/${unrelatedSock}`;
    ctx.env.TMUX = `${unrelatedSocketPath},0,0`;

    await runScript(ctx);

    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), 'the session must have been created on the EXPLICIT isolated socket');
    // The core assertion: the unrelated server's session must be completely
    // untouched — still present, not killed, not renamed, no stray windows.
    assert.ok(await tmuxOk(unrelatedSock, ['has-session', '-t', unrelatedSession]), 'an unrelated tmux server must survive a restore run completely untouched');
    const { stdout } = await tmux(unrelatedSock, ['list-windows', '-t', unrelatedSession, '-F', '#{window_name}']);
    assert.equal(stdout.trim().split('\n').filter(Boolean).length, 1, 'the unrelated server must gain no extra windows from the restore run');
  } finally {
    await killSock(unrelatedSock);
    await teardown(ctx);
  }
});

// The concrete instance of the above that actually matters on a real host:
// the per-user REAL DEFAULT tmux socket (no -L at all) is not an abstraction
// — on a host running an actual Project Workbench instance it carries real,
// live project sessions. A properly PW_TMUX_SOCKET-isolated restore run must
// leave that socket's session list byte-for-byte unchanged, whether or not
// anything happens to be on it.
test('REGRESSION: a properly isolated restore run leaves the REAL default tmux socket exactly as it found it', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  // Explicitly targets the literal "default" socket (tmux's own name for "no
  // -L/-S/$TMUX given") regardless of what this TEST RUNNER's own environment
  // happens to be inside of — this check is about the production-shape
  // ambient socket, not about whatever the test process itself is wrapped in.
  const snapshotDefault = () => execFileAsync('tmux', ['-L', 'default', 'list-sessions', '-F', '#{session_name}:#{session_windows}'], { env: { ...process.env, TMUX: '' } }).then((r) => r.stdout).catch(() => '');
  const before = await snapshotDefault();
  try {
    await runScript(ctx); // ctx.env carries PW_TMUX_SOCKET and no TMUX — exactly production shape
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), 'sanity: the isolated session must still have been created');
  } finally {
    await teardown(ctx);
  }
  const after = await snapshotDefault();
  assert.equal(after, before, 'the real default tmux socket\'s session list must be byte-for-byte unchanged by an isolated restore run');
});
