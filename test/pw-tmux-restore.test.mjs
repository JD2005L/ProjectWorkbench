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

// GOA-7: tmux environments come from test/tmux-env.mjs, which strips ambient TMUX, TMUX_PANE,
// TMUX_TMPDIR and the PW_TMUX_* branch switches. Without that, this file's own client inherited an
// ambient TMUX_TMPDIR while the script under test resolved a different socket root — a live server
// the test could not see — and an ambient PW_TMUX_HOST_MODE (which a developer shell inside a PW
// pane really does carry) silently changed which branch the script took. Cleanup goes through
// killTestSock, which refuses any socket name without the harness prefix, so it can never reap a
// real Project Workbench server.
import { sanitizedTmuxEnv, sockName, killTestSock } from './tmux-env.mjs';


const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'pw-tmux-restore');
const APP_DIR = path.join(REPO, 'app');
const SEP = '\x1f';

function tmuxSock() {
  return sockName('restore');
}
async function tmux(sock, args) {
  return execFileAsync('tmux', ['-L', sock, ...args], { env: sanitizedTmuxEnv() });
}
async function tmuxOk(sock, args) {
  try { await tmux(sock, args); return true; } catch { return false; }
}
async function killSock(sock) {
  return killTestSock(execFileAsync, sock);
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
    // The real terminal-owner (getent/passwd + `sudo -n -u <account>`)
    // resolution this script's credential path goes through via
    // app/project-terminal-credentials.mjs — see app/terminal-owner.js. The
    // literal shipped 'admin' account only exists on the real PW host;
    // pointing this at whichever account is actually running this test makes
    // that real path exercisable anywhere, never a fallback.
    PW_HOST_TERMINAL_USER: os.userInfo().username,
    // Hermetic against the host's real environment contract: these tests must resolve the temp
    // paths they set up, never /etc/project-workbench/pw.env. Individual tests point this at a
    // real file when the file itself is what is under test.
    PW_ENV_FILE: path.join(dir, 'no-such-pw.env'),
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
// ---------------------------------------------------------------------------
// SECURITY: the credential helper's response schema is not trusted blindly —
// mirrors test/project-terminal-start.test.mjs's identical checks for the
// same underlying gap in this script's own resolve_session_credentials().
// ---------------------------------------------------------------------------

/** Replaces the credential helper this script shells out to with one that prints an ARBITRARY
 * (possibly malformed) JSON string and exits 0. Returns a PW_APP_DIR override pointing at it. */
function makeFakeCredentialHelper(dir, jsonText) {
  const fakeAppDir = fs.mkdtempSync(path.join(dir, 'fake-app-'));
  fs.writeFileSync(
    path.join(fakeAppDir, 'project-terminal-credentials.mjs'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(jsonText)});\n`,
    { mode: 0o755 },
  );
  return fakeAppDir;
}

for (const [label, malformed] of [
  ['a completely empty object (no ok, no shared)', '{}'],
  ['ok:true but no shared field at all', '{"ok":true}'],
  ['shared:false but missing configDir AND fingerprint entirely', '{"ok":true,"shared":false}'],
  ['shared:false with a fingerprint but no configDir', '{"ok":true,"shared":false,"fingerprint":"abc123"}'],
  ['shared:false with a configDir but no fingerprint', '{"ok":true,"shared":false,"configDir":"/tmp/x"}'],
  // A `jq -r '.field // empty'` extraction silently STRINGIFIES any JSON scalar (a boolean becomes
  // "true"/"false", a number becomes its decimal digits) — a bare non-empty-string check cannot
  // tell a hijacked boolean/number apart from a real path or fingerprint.
  ['a boolean configDir instead of a string', '{"ok":true,"shared":false,"configDir":true,"fingerprint":"aaaaaaaaaaaaaaaa","envFile":""}'],
  ['a numeric configDir instead of a string', '{"ok":true,"shared":false,"configDir":42,"fingerprint":"aaaaaaaaaaaaaaaa","envFile":""}'],
  ['a numeric fingerprint instead of a string', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":12345,"envFile":""}'],
  ['an object fingerprint instead of a string', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":{"a":1},"envFile":""}'],
  ['an array fingerprint instead of a string', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":["a"],"envFile":""}'],
  // "off" is app/user-credentials.js's CREDENTIALS_OFF sentinel — shared:false already asserts a
  // real per-user owner, so a fingerprint colliding with the shared/disabled sentinel must be
  // refused explicitly: later stamp comparisons treat "off" as the shared/disabled case regardless
  // of what shared:false just asserted.
  ['the reserved "off" sentinel used as an owned fingerprint', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"off","envFile":""}'],
  ['a fingerprint of the wrong length (not the real 16 hex characters)', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"abc123","envFile":""}'],
  ['a fingerprint with non-hex characters', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"ZZZZZZZZZZZZZZZZ","envFile":""}'],
  // app/project-terminal-credentials.mjs's own contract always includes envFile as a string for
  // shared:false — possibly empty (no GitHub token), but never absent and never any other type.
  ['a non-string (numeric) envFile', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"aaaaaaaaaaaaaaaa","envFile":12345}'],
  ['a non-string (boolean) envFile', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"aaaaaaaaaaaaaaaa","envFile":false}'],
  ['envFile entirely missing (the real helper always includes it for shared:false)', '{"ok":true,"shared":false,"configDir":"/tmp/x","fingerprint":"aaaaaaaaaaaaaaaa"}'],
]) {
  test(`SECURITY REGRESSION: a zero-exit credential helper response with ${label} refuses to restore the session, never falls back to shared`, { timeout: 15000 }, async () => {
    const secretKey = crypto.randomBytes(32).toString('hex');
    const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
    await fsp.writeFile(ctx.env.PW_SECRET_KEY_PATH, secretKey);
    await fsp.writeFile(ctx.env.PW_USERS_PATH, JSON.stringify({ users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_x') }] }));
    ctx.env.PW_APP_DIR = makeFakeCredentialHelper(ctx.dir, malformed);
    writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
      { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
    ]);
    try {
      await runScript(ctx);
      assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false,
        `no session (and therefore no shared-login fallback) may be created from a malformed credential helper response (${label})`);
      const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
      assert.match(log, /credential helper|unexpected response|missing/i);
    } finally { await teardown(ctx); }
  });
}

test('a genuinely well-formed shared:true response still restores the session normally', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  ctx.env.PW_APP_DIR = makeFakeCredentialHelper(ctx.dir, '{"ok":true,"shared":true}');
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]));
    const stamped = (await tmux(ctx.sock, ['show-options', '-t', ctx.session, '-v', '@pw_cred_key'])).stdout.trim();
    assert.equal(stamped, 'off');
  } finally { await teardown(ctx); }
});

test('a genuinely well-formed shared:false response (real string types, valid fingerprint) still restores the session normally', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: true, primaryUser: 'alice', users: [{ username: 'alice' }] });
  ctx.env.PW_APP_DIR = makeFakeCredentialHelper(
    ctx.dir,
    `{"ok":true,"shared":false,"configDir":"${ctx.dir}/fake-claude-config","fingerprint":"1234567890abcdef","envFile":""}`,
  );
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    await runScript(ctx);
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]));
    const env = await paneEnviron(ctx.sock, ctx.session);
    assert.equal(env.CLAUDE_CONFIG_DIR, `${ctx.dir}/fake-claude-config`);
    const stamped = (await tmux(ctx.sock, ['show-options', '-t', ctx.session, '-v', '@pw_cred_key'])).stdout.trim();
    assert.equal(stamped, '1234567890abcdef');
  } finally { await teardown(ctx); }
});

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

// --- GOA-1: misconfiguration must not masquerade as "nothing to restore" --------------------
//
// The live regression GOA is holding `main` on. `pw-tmux-restore` resolved REGISTRY_JSON, APP_DIR
// and STATE_DIR from its own compiled-in defaults, and no persistence unit set any of them. On an
// instance whose registry is not at the default path, resolve_session_credentials returned 1 for
// EVERY session, the caller turned each into CREATED[$s]="skip", and the script still exit 0'd —
// with `ExecStartPost=-` swallowing even that. A reboot refused to restore every session and
// reported success. Fail-closed on IDENTITY is right and is unchanged; the bug was fail-closed on a
// PATH being reported as an idempotent no-op.

/** Run the script and report its exit code rather than throwing, so a refusal can be asserted. */
async function runScriptRaw(ctx, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, [], { env: { ...ctx.env, ...extraEnv }, timeout: 15000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

test('REGRESSION: a manifest with an unreachable registry exits EX_CONFIG instead of "restoring nothing"', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    const r = await runScriptRaw(ctx, { PW_REGISTRY_PATH: path.join(ctx.dir, 'moved-registry.json') });
    assert.equal(r.code, 78, `a path mismatch must be a visible configuration failure, not exit 0\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /PW_REGISTRY_PATH/);
    assert.match(r.stderr, /nothing to do/);
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false,
      'and it must still not restore anything under an unverified identity');
  } finally { await teardown(ctx); }
});

test('REGRESSION: a missing persistence state dir is a configuration failure, not an empty restore', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  try {
    const r = await runScriptRaw(ctx, { PW_TMUX_STATE_DIR: path.join(ctx.dir, 'not-mounted') });
    assert.equal(r.code, 78, `an unmounted state dir is exactly GOA's container case; it must not read as "no manifest"\n${r.stderr}`);
    assert.match(r.stderr, /PW_TMUX_STATE_DIR/);
  } finally { await teardown(ctx); }
});

test('REGRESSION: a missing app dir (the fail-closed credential helper) exits EX_CONFIG', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    const r = await runScriptRaw(ctx, { PW_APP_DIR: path.join(ctx.dir, 'no-app') });
    assert.equal(r.code, 78, `without the helper every session would be refused; that is misconfiguration, not "nothing to restore"\n${r.stderr}`);
    assert.match(r.stderr, /PW_APP_DIR/);
  } finally { await teardown(ctx); }
});

test('a correctly configured instance with no manifest is still a legitimate exit 0', { timeout: 15000 }, async () => {
  // The other half of the contract. "Nothing to restore" is a real state and must stay silent and
  // successful, or every freshly installed host would report a failure at boot.
  const ctx = await setup({ enabled: false });
  try {
    const r = await runScriptRaw(ctx);
    assert.equal(r.code, 0, `no manifest must remain a successful no-op\n${r.stderr}`);
  } finally { await teardown(ctx); }
});

test('REGRESSION (HJ-24-5): the per-user flag is read from the environment contract, not assumed off', { timeout: 15000 }, async () => {
  // The owner unit runs this script through ExecStartPost. Before the contract, that unit set only
  // HOME/LANG/LC_ALL, so PW_PER_USER_CLAUDE was absent — which this script reads as the legitimate
  // disabled/shared-credential mode. On a per-user-enabled install an owner restart could therefore
  // restore and resume a session under SHARED credentials before any terminal-side drift check ran.
  // Here the flag exists ONLY in the env file: if the file is not read, the session is created under
  // the shared login and this test fails.
  const ctx = await setup({ enabled: false, primaryUser: null });
  const envFile = path.join(ctx.dir, 'pw.env');
  await fsp.writeFile(envFile, `PW_DEPLOY_MODE=host\nPW_PER_USER_CLAUDE=true\nPW_TMUX_STATE_DIR=${ctx.stateDir}\n`);
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  const env = { ...ctx.env, PW_ENV_FILE: envFile };
  delete env.PW_PER_USER_CLAUDE; // the whole point: it must come from the contract
  try {
    await execFileAsync(SCRIPT, [], { env, timeout: 15000 });
    assert.equal(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]), false,
      'per-user credentials are ON in the contract and this project has no primaryUser — refusing is the only correct outcome');
    const log = await fsp.readFile(ctx.env.PW_TMUX_LOG, 'utf8').catch(() => '');
    assert.match(log, /no primaryUser configured/i,
      'the refusal must be the per-user one, proving the flag was actually read from the env file');
  } finally { await teardown(ctx); }
});

test('an explicit unit environment still wins over the contract file', { timeout: 15000 }, async () => {
  const ctx = await setup({ enabled: false });
  const envFile = path.join(ctx.dir, 'pw.env');
  await fsp.writeFile(envFile, `PW_REGISTRY_PATH=/definitely/not/here.json\nPW_TMUX_STATE_DIR=${ctx.stateDir}\n`);
  writeManifest(path.join(ctx.stateDir, 'manifest.tsv'), [
    { s: ctx.session, w: 0, wn: 'Base', cwd: ctx.projPath, hasc: 0 },
  ]);
  try {
    const r = await runScriptRaw(ctx, { PW_ENV_FILE: envFile });
    assert.equal(r.code, 0, `systemd applies EnvironmentFile= before the script runs; an explicit value must not be overridden\n${r.stderr}`);
    assert.ok(await tmuxOk(ctx.sock, ['has-session', '-t', ctx.session]));
  } finally { await teardown(ctx); }
});
