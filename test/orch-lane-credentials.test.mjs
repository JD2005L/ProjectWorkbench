// app/orchestrator/lane-credentials.js resolves the per-user credential
// context for an orchestrator-managed project's shared tmux session — a
// THIRD entrypoint alongside app/server.js's credentialContext() and
// app/project-terminal-credentials.mjs, but STRICTER than either: those two
// (human dashboard/terminal paths) treat "feature on, project intentionally
// has no primaryUser" as a second legitimate shared/off case. The
// orchestrator lane is unattended — no human is present to notice a wrong
// attribution — so here "off" is legitimate ONLY when PW_PER_USER_CLAUDE is
// disabled outright. Enabled but missing a primaryUser, a resolvable user,
// working credentials, or a working helper all fail closed identically; none
// of them resolve to shared/off.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLaneCredentials } from '../app/orchestrator/lane-credentials.js';
import { userClaudeConfigDir, CREDENTIALS_OFF } from '../app/user-credentials.js';

function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-lane-cred-'));
}
function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
async function seed(dir, { registry = [], users = [], secretKey = crypto.randomBytes(32).toString('hex') } = {}) {
  await fsp.writeFile(path.join(dir, 'projects.json'), JSON.stringify(registry));
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({ users }));
  await fsp.writeFile(path.join(dir, '.secret-key'), secretKey);
  return secretKey;
}
function opts(dir, overrides = {}) {
  return {
    registryPath: path.join(dir, 'projects.json'),
    usersPath: path.join(dir, 'users.json'),
    secretKeyPath: path.join(dir, '.secret-key'),
    credBase: path.join(dir, 'pw-users'),
    sharedClaudeJson: path.join(dir, '.claude.json'),
    ...overrides,
  };
}

test('disabled feature: shared credentials, zero filesystem side effects', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [{ name: 'demo', primaryUser: 'alice' }], users: [{ username: 'alice' }] });
  const result = await resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: false });
  assert.equal(result.key, CREDENTIALS_OFF);
  assert.deepEqual(result.tokens, []);
  assert.equal(fs.existsSync(path.join(dir, 'pw-users')), false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: no primaryUser with the feature ON fails closed — never resolves to shared/off', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [{ name: 'demo' }], users: [] });
  await assert.rejects(
    resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: true }),
    /no primaryUser configured/i,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('enabled + valid owner: materializes real credentials and returns a real fingerprint', async () => {
  const dir = await tmpDir();
  const secretKey = crypto.randomBytes(32).toString('hex');
  await seed(dir, {
    registry: [{ name: 'demo', primaryUser: 'alice' }],
    users: [{ username: 'alice', ghToken: encryptToken(secretKey, 'ghp_realtoken') }],
    secretKey,
  });
  const result = await resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: true });
  assert.match(result.key, /^[0-9a-f]{16}$/);
  assert.deepEqual(result.tokens, ['CLAUDE_CONFIG_DIR=' + userClaudeConfigDir(path.join(dir, 'pw-users'), 'alice')]);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: no current project maps to the orchestrator project id — fails closed, not shared', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [], users: [] });
  await assert.rejects(
    resolveLaneCredentials({ ...opts(dir), projectId: 'ghost-project', perUserEnabled: true }),
    /credential owner/i,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a primaryUser that does not resolve to any user record fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [{ name: 'demo', primaryUser: 'ghost' }], users: [] });
  await assert.rejects(
    resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: true }),
    /ghost/,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: an unreadable registry fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [{ name: 'demo', primaryUser: 'alice' }], users: [{ username: 'alice' }] });
  fs.writeFileSync(path.join(dir, 'projects.json'), '{ not valid json');
  await assert.rejects(
    resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: true }),
    /cannot read the project registry/i,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a materialization failure (cred base unusable) fails closed', async () => {
  const dir = await tmpDir();
  await seed(dir, { registry: [{ name: 'demo', primaryUser: 'alice' }], users: [{ username: 'alice' }] });
  fs.writeFileSync(path.join(dir, 'pw-users'), 'not a directory');
  await assert.rejects(
    resolveLaneCredentials({ ...opts(dir), projectId: 'demo', perUserEnabled: true }),
    /credential materialization failed/i,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});
