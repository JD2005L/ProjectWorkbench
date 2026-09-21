import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeSecretCrypto } from '../app/secret-crypto.js';
import { createWorkbenchSettingsStore, publicWorkbenchSettings, publicDeploymentSettings, validateConsoleUrl } from '../app/deployment/settings.js';
import { createDeploymentService } from '../app/deployment/pw.js';

const TOKEN = 'synthetic-service-credential-0123456789';
const endpoint = 'https://deploy.example.test';
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function fixture(t, initial) {
  const root = await fs.mkdtemp(path.join(testDirectory, '.deploy-settings-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secretKeyPath = path.join(root, 'synthetic-key');
  await fs.writeFile(secretKeyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = makeSecretCrypto({ secretKeyPath });
  let raw = initial, readError = null, writeError = null, lock = Promise.resolve();
  const writes = [];
  const store = createWorkbenchSettingsStore({ filePath: path.join(root, 'settings.json'),
    defaults: { permissionMode: 'prompt', mcpMode: 'isolated', defaultProject: '' }, ...secret,
    readFile: async () => {
      if (readError) throw readError;
      if (raw === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return raw;
    },
    writeAtomic: async (file, data, options) => {
      if (writeError) throw writeError;
      writes.push({ file, data, options }); raw = data;
    },
    withLock: (_file, operation) => {
      const result = lock.then(operation); lock = result.catch(() => {}); return result;
    },
  });
  return { store, writes, secret, get raw() { return raw; }, set raw(value) { raw = value; },
    set readError(value) { readError = value; }, set writeError(value) { writeError = value; } };
}

test('settings: only a missing file selects the backward-compatible local default', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.connection(), null);
  assert.deepEqual(publicDeploymentSettings(await f.store.load()), { backend: 'local', endpoint: '', hasCredential: false });
  f.raw = '{}';
  assert.equal(await f.store.connection(), null);
  f.raw = '{broken json';
  await assert.rejects(f.store.connection(), error => error.code === 'deployment_settings_invalid');
  f.readError = Object.assign(new Error('private path detail'), { code: 'EACCES' });
  await assert.rejects(f.store.load(), error => error.code === 'deployment_settings_invalid' && !error.message.includes('private path'));
});

test('settings: encrypted token, atomic 0600 writes, and redacted settings readbacks', async t => {
  const f = await fixture(t);
  const saved = await f.store.updateDeployment({ backend: 'external', endpoint, token: TOKEN });
  assert.deepEqual(saved, { backend: 'external', endpoint, hasCredential: true });
  assert.ok(!f.raw.includes(TOKEN));
  assert.match(JSON.parse(f.raw).deployment.credential, /^enc:/);
  assert.equal(f.writes[0].options.mode, 0o600);
  assert.deepEqual(await f.store.connection(), { endpoint, token: TOKEN });
  const publicSettings = publicWorkbenchSettings(await f.store.load());
  assert.equal(publicSettings.permissionMode, 'prompt');
  assert.ok(!JSON.stringify(publicSettings).includes(TOKEN));
  assert.ok(!JSON.stringify(publicSettings).includes('enc:'));
});

test('settings: concurrent old-form saves preserve rotated credentials and independent workbench fields', async t => {
  const f = await fixture(t);
  await f.store.updateDeployment({ backend: 'external', endpoint, token: TOKEN });
  const stale = await f.store.load();
  const rotated = `${TOKEN}-rotated`;
  await Promise.all([
    f.store.updateDeployment({ token: rotated }),
    f.store.updateGeneral({ permissionMode: 'skip', deployment: stale.deployment }),
    f.store.updateGeneral({ defaultProject: 'NewProject' }),
  ]);
  assert.equal((await f.store.connection()).token, rotated);
  assert.equal((await f.store.load()).permissionMode, 'skip');
  assert.equal((await f.store.load()).defaultProject, 'NewProject');
});

test('settings: switching local retains endpoint/token; clearing is explicit and cannot leave active external mode credentialless', async t => {
  const f = await fixture(t);
  await f.store.updateDeployment({ backend: 'external', endpoint, token: TOKEN });
  await assert.rejects(f.store.updateDeployment({ clearToken: true }), /credential/);
  await f.store.updateDeployment({ backend: 'local', token: '' });
  assert.equal(await f.store.connection(), null);
  assert.deepEqual(await f.store.connection({}), { endpoint, token: TOKEN });
  assert.deepEqual(await f.store.externalConnection(), { endpoint, token: TOKEN });
  assert.equal(publicDeploymentSettings(await f.store.load()).hasCredential, true);
  await f.store.updateDeployment({ clearToken: true });
  assert.equal(publicDeploymentSettings(await f.store.load()).hasCredential, false);
  assert.equal(publicDeploymentSettings(await f.store.load()).endpoint, endpoint);
});

test('settings: draft connection supports current and replacement endpoints without saving or echoing tokens', async t => {
  const f = await fixture(t);
  await f.store.updateDeployment({ backend: 'local', endpoint, token: TOKEN });
  const before = f.raw;
  const draft = await f.store.connection({ endpoint: 'https://draft.example.test', token: '' });
  assert.deepEqual(draft, { endpoint: 'https://draft.example.test', token: TOKEN });
  assert.equal(f.raw, before);
  await assert.rejects(f.store.connection({ endpoint: 'http://remote.example.test' }), /HTTPS/);
  assert.equal(f.raw, before);
});

test('settings: PW client preserves an empty connection-test draft separately from slot backend selection', async t => {
  const f = await fixture(t);
  await f.store.updateDeployment({ backend: 'local', endpoint, token: TOKEN });
  const before = f.raw;
  class Client {
    constructor(connection) { this.connection = connection; }
  }
  const service = createDeploymentService({ settingsStore: f.store, Client });
  assert.equal(await service.client(), null);
  await assert.rejects(service.requiredClient(), error => error.code === 'deployment_local');
  const draft = await service.client({});
  assert.ok(draft instanceof Client);
  assert.deepEqual(draft.connection, { endpoint, token: TOKEN });
  const selected = await service.requiredClient({ forceExternal: true });
  assert.deepEqual(selected.connection, draft.connection);
  await assert.rejects(service.client({ forceExternal: true }), /Unknown/);
  assert.equal(f.raw, before);
  assert.equal(await service.client(), null);
});

test('settings: malformed saved external mode, missing credentials, and invalid ciphertext fail closed', async t => {
  const f = await fixture(t);
  const values = [
    { backend: 'other' }, null, { backend: 'external' }, { backend: 'external', endpoint },
    { backend: 'external', endpoint, credential: TOKEN },
    { backend: 'external', endpoint, credential: 'enc:bm90LXZhbGlk' },
    { backend: 'external', endpoint: 'http://remote.example.test', credential: 'enc:bm90LXZhbGlk' },
  ];
  for (const deployment of values) {
    f.raw = JSON.stringify({ deployment });
    await assert.rejects(f.store.connection());
  }
});

test('settings: invalid writes and encryption failures remain errors rather than success-shaped fallbacks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.updateDeployment({ backend: 'external', endpoint }), /credential/);
  await assert.rejects(f.store.updateDeployment({ backend: 'external', endpoint, token: `${TOKEN}\r\nInjected: yes` }), /credential/);
  await assert.rejects(f.store.updateDeployment({ backend: 'external', endpoint, token: TOKEN, runAsRoot: true }), /Unknown/);
  await assert.rejects(f.store.updateDeployment({ token: TOKEN, clearToken: true }), /either/);
  f.writeError = Object.assign(new Error(TOKEN), { code: 'ENOSPC' });
  await assert.rejects(f.store.updateDeployment({ backend: 'external', endpoint, token: TOKEN }), error => {
    assert.equal(error.code, 'deployment_settings_write_failed');
    assert.ok(!error.message.includes(TOKEN)); return true;
  });
  assert.equal(f.raw, undefined);
});

test('settings: standalone console destination is explicit, optional, and independent of LOCAL selection', async t => {
  const f = await fixture(t);
  const consoleUrl = 'https://deploy.example.test/deploy-service';
  await f.store.updateDeployment({ backend: 'local', endpoint, token: TOKEN, consoleUrl: `${consoleUrl}/` });
  assert.equal(await f.store.connection(), null);
  assert.equal(publicDeploymentSettings(await f.store.load()).consoleUrl, consoleUrl);
  await f.store.updateGeneral({ permissionMode: 'skip' });
  assert.equal(publicDeploymentSettings(await f.store.load()).consoleUrl, consoleUrl);
  await f.store.updateDeployment({ backend: 'external', token: '' });
  assert.deepEqual(await f.store.connection(), { endpoint, token: TOKEN });
  await f.store.updateDeployment({ consoleUrl: '' });
  assert.equal(Object.hasOwn(publicDeploymentSettings(await f.store.load()), 'consoleUrl'), false);
  assert.equal((await f.store.connection()).token, TOKEN);
});

test('settings: console redirects reject unsafe destinations without changing saved settings', async t => {
  const f = await fixture(t);
  for (const consoleUrl of ['http://localhost/console', '//host/console', 'javascript:alert(1)',
    'https://user:password@host/console', 'https://host/console?token=example',
    'https://host/console#example', 'https://host/a/../console', 'https://host/%2e%2e/console',
    'https://host/console\n', 'https://host\\console', null, 42]) {
    assert.throws(() => validateConsoleUrl(consoleUrl), /console URL/);
  }
  await assert.rejects(f.store.updateDeployment({ consoleUrl: 'https://host/console?token=example' }), /console URL/);
  assert.equal(f.raw, undefined);
});
