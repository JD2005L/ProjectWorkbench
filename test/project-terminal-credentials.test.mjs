// app/project-terminal-credentials.mjs is invoked by
// scripts/project-terminal-start (the host-mode systemd-launched terminal
// startup path) to resolve/materialize a project's per-user Claude/GitHub
// credentials with the EXACT SAME fail-closed contract as app/server.js's
// credentialContext(): shared credentials only when the feature is off or
// the project has no primaryUser; every other failure (unreadable users
// store, dangling primaryUser, undecryptable token, a failing credential
// helper) exits nonzero with an actionable error on stdout, never silently
// falling back. Protocol mirrors app/credential-writer.mjs: one JSON object
// on stdout, exit code signals success/failure, never a secret in argv,
// stdout, or stderr.
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
import { userClaudeConfigDir, userSessionEnvFile } from '../app/user-credentials.js';

const execFileAsync = promisify(execFile);
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const CLI = path.join(APP_DIR, 'project-terminal-credentials.mjs');

function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-ptc-'));
}

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

async function seed(dir, { users = [], secretKey = crypto.randomBytes(32).toString('hex') } = {}) {
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users }));
  await fsp.writeFile(path.join(dir, '.secret-key'), secretKey);
  return secretKey;
}

async function run(dir, { project = 'demo', primaryUser = '', enabled = true, extraEnv = {} } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    PW_PER_USER_CLAUDE: enabled ? 'true' : '',
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    // The real terminal-owner (getent/passwd + `sudo -n -u <account>`) resolution
    // path — see app/terminal-owner.js. The literal shipped 'admin' account only
    // exists on the real PW host; pointing this at whichever account is actually
    // running this test makes the real resolution/sudo path exercisable anywhere,
    // never falling back — an unset or unresolvable name still fails closed.
    PW_HOST_TERMINAL_USER: os.userInfo().username,
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, project, primaryUser], { env });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('disabled feature: shared credentials, no filesystem side effects', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [{ username: 'alice' }] });
  const { code, stdout } = await run(dir, { primaryUser: 'alice', enabled: false });
  assert.equal(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, true);
  assert.equal(body.shared, true);
  assert.equal(fs.existsSync(path.join(dir, 'pw-users')), false, 'must not materialize anything when the feature is off');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('no primaryUser: shared credentials, feature otherwise on', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [] });
  const { code, stdout } = await run(dir, { primaryUser: '', enabled: true });
  assert.equal(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, true);
  assert.equal(body.shared, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('enabled + valid owner: materializes real credentials and reports non-secret context', async () => {
  const dir = await tmpDir();
  const secretKey = crypto.randomBytes(32).toString('hex');
  await seed(dir, { users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_realtoken') }], secretKey });
  const { code, stdout, stderr } = await run(dir, { primaryUser: 'alice', enabled: true });
  assert.equal(code, 0, stderr);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, true);
  assert.equal(body.shared, false);
  assert.equal(body.configDir, userClaudeConfigDir(path.join(dir, 'pw-users'), 'alice'));
  assert.equal(body.envFile, userSessionEnvFile(path.join(dir, 'pw-users'), 'alice'));
  assert.match(body.fingerprint, /^[0-9a-f]{16}$/);

  assert.ok(fs.existsSync(body.configDir), 'the claude config dir must be materialized');
  assert.ok(fs.existsSync(body.envFile), 'the session env file must be materialized');
  assert.ok(fs.readFileSync(body.envFile, 'utf8').includes('ghp_realtoken'));

  assert.equal(stdout.includes('ghp_realtoken'), false, 'the token must never appear on stdout');
  assert.equal(stderr.includes('ghp_realtoken'), false, 'the token must never appear on stderr');
});

test('REGRESSION: a configured terminal user that does not resolve to any real account fails closed, portably', async () => {
  const dir = await tmpDir();
  const secretKey = crypto.randomBytes(32).toString('hex');
  await seed(dir, { users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_realtoken') }], secretKey });
  const { code, stdout } = await run(dir, {
    primaryUser: 'alice', enabled: true,
    extraEnv: { PW_HOST_TERMINAL_USER: 'pw-test-nonexistent-account-793d' },
  });
  assert.notEqual(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: an unreadable users.json fails closed — exits nonzero, prints an actionable error, never a secret', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [{ username: 'alice' }] });
  fs.writeFileSync(path.join(dir, 'users.json'), '{ not valid json');
  const { code, stdout } = await run(dir, { primaryUser: 'alice', enabled: true });
  assert.notEqual(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, false);
  assert.ok(body.error);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a primaryUser that does not resolve to any user record fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [] });
  const { code, stdout } = await run(dir, { primaryUser: 'ghost', enabled: true });
  assert.notEqual(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, false);
  assert.match(body.error, /ghost/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a corrupt (non-decryptable) GitHub token fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [{ username: 'alice', ghToken: 'enc:' + Buffer.alloc(40, 1).toString('base64') }] });
  const { code, stdout } = await run(dir, { primaryUser: 'alice', enabled: true });
  assert.notEqual(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a materialization failure (cred base unusable) fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { users: [{ username: 'alice' }] });
  fs.writeFileSync(path.join(dir, 'pw-users'), 'not a directory');
  const { code, stdout } = await run(dir, { primaryUser: 'alice', enabled: true });
  assert.notEqual(code, 0);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, false);
  await fsp.rm(dir, { recursive: true, force: true });
});
