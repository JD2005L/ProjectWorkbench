// Which account a deploy runs as, and the one asymmetry that matters:
// **absent falls through, unreadable does not.**
//
// A level nobody configured is not an opinion, so the next level answers. A level
// that WAS configured but cannot be decrypted is a misconfiguration, and quietly
// using the next identity would publish production as an account no administrator
// chose — or, falling all the way through, with an empty password, which is the
// collapse that had a slot script reporting "no password supplied" for a
// credential the Users screen showed as set (76f0a21).
//
// See docs/deploy-credentials.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeployIdentity, readStoredDeployPassword, resolveDeployIdentity } from '../app/deploy-credential.js';
import {
  createWorkbenchSettingsStore, publicDeployCredentials, publicWorkbenchSettings, savedDeployCredentials,
  validateDeployAccount,
} from '../app/deployment/settings.js';

// Reversible, so a test can tell "decrypted" from "passed through", and shaped
// like the real thing: `enc:` + base64 is what makeSecretCrypto writes and what
// the saved-settings validator insists on, so a fake that ignored the format
// would let a malformed-storage bug pass.
// The marker stands in for AES-GCM's auth tag: ciphertext written under another
// key decodes as bytes but fails verification, which is exactly the failure this
// file is about. A fake that merely base64-decoded would call it "stored".
const KEY_MARKER = 'pw-test-key|';
const encrypt = value => `enc:${Buffer.from(KEY_MARKER + String(value)).toString('base64')}`;
const decrypt = value => {
  const text = String(value);
  if (!text.startsWith('enc:')) throw new Error('bad key');
  const body = Buffer.from(text.slice(4), 'base64').toString('utf8');
  if (!body.startsWith(KEY_MARKER)) throw new Error('unsupported state or unable to authenticate data');
  return body.slice(KEY_MARKER.length);
};

const operator = { username: 'kevin.charlebois', deployPassword: encrypt('kevins-own') };
const instanceOf = (target, saved) => async requested => {
  assert.equal(requested, target, 'the instance default must be read for the slot\'s OWN target');
  return saved;
};

test('the first CONFIGURED level wins, most specific first', async () => {
  const identity = makeDeployIdentity({
    decrypt,
    instanceCredential: instanceOf('prod', { state: 'stored', source: 'instance', user: 'GOA\\svc-prod', password: 'shared' }),
  });

  const override = await identity.resolve(
    { deployCredential: { user: 'GOA\\svc-project', password: encrypt('project-secret') } }, 'prod', operator);
  assert.deepEqual([override.source, override.user, override.password], ['project', 'GOA\\svc-project', 'project-secret']);

  const fallsToInstance = await identity.resolve({ script: 'true' }, 'prod', operator);
  assert.deepEqual([fallsToInstance.source, fallsToInstance.user], ['instance', 'GOA\\svc-prod']);
});

test('an unconfigured level falls through; the operator is the last resort, exactly as before', async () => {
  const identity = makeDeployIdentity({
    decrypt, instanceCredential: async () => ({ state: 'none', source: 'instance', user: '', password: '' }),
  });
  const resolved = await identity.resolve({}, 'dev', operator);
  assert.deepEqual([resolved.source, resolved.user, resolved.password], ['operator', 'kevin.charlebois', 'kevins-own']);

  // Nothing anywhere: a slot that needs no credential still runs.
  const bare = await identity.resolve({}, 'dev', null);
  assert.deepEqual([bare.state, bare.source, bare.password], ['none', 'none', '']);
});

test('an UNREADABLE level stops the search instead of silently using another account', async () => {
  // Saved under a different key: a rotated .secret-key, or a config carried
  // between instances. The operator below has a perfectly good credential, and
  // must NOT be the account a production deploy quietly runs as.
  const identity = makeDeployIdentity({
    decrypt,
    instanceCredential: async () => {
      const read = readStoredDeployPassword({ deployPassword: 'enc:bm90b3Vycw' }, decrypt);
      return { state: read.state, source: 'instance', user: 'GOA\\svc-prod', password: read.password };
    },
  });
  const resolved = await identity.resolve({}, 'prod', operator);
  assert.deepEqual([resolved.state, resolved.source], ['unreadable', 'instance']);
  assert.equal(resolved.password, '', 'an unreadable credential never carries a password onwards');
  assert.equal(identity.env(resolved, 'kevin.charlebois'), null, 'and never becomes a deploy environment');

  const overrideBroken = await identity.resolve({ deployCredential: { user: 'GOA\\x', password: 'enc:bm9wZQ' } }, 'prod', operator);
  assert.deepEqual([overrideBroken.state, overrideBroken.source], ['unreadable', 'project']);
});

test('an incomplete project override is unreadable and never falls through to another account', async () => {
  const identity = makeDeployIdentity({
    decrypt,
    instanceCredential: async () => ({ state: 'stored', source: 'instance', user: 'GOA\\svc-prod', password: 'shared' }),
  });
  for (const deployCredential of [
    { user: 'GOA\\svc-project', password: '' },
    { user: '', password: encrypt('project-secret') },
  ]) {
    const resolved = await identity.resolve({ deployCredential }, 'prod', operator);
    assert.deepEqual([resolved.state, resolved.source, resolved.password], ['unreadable', 'project', '']);
    assert.equal(identity.env(resolved, 'kevin.charlebois'), null);
  }
});

test('the environment names the effective account AND the human who pressed Deploy', async () => {
  const identity = makeDeployIdentity({ decrypt, instanceCredential: async () => ({ state: 'none', source: 'instance', user: '', password: '' }) });
  const env = identity.env({ state: 'stored', source: 'instance', user: 'GOA\\svc-prod', password: 'shared' }, 'kevin.charlebois');
  assert.deepEqual(env, {
    DEPLOY_USER: 'GOA\\svc-prod', DEPLOY_PASSWORD: 'shared',
    DEPLOY_IDENTITY_SOURCE: 'instance', DEPLOY_OPERATOR: 'kevin.charlebois',
  });
  assert.equal(identity.env({ state: 'none' }, 'kevin.charlebois'), null);
});

test('a read-only version probe stays silent when the settings file is unusable', async () => {
  // Deliberately different from the deploy path: a probe that cannot authenticate
  // shows no version, while a DEPLOY refuses loudly — publishing under the wrong
  // identity is the harm, not an empty version badge.
  const identity = makeDeployIdentity({
    decrypt, instanceCredential: async () => { throw new Error('Workbench settings are unreadable.'); },
  });
  assert.equal(await identity.probeEnv({}, 'prod', operator, 'kevin.charlebois'), null);
  await assert.rejects(() => identity.resolve({}, 'prod', operator), /unreadable/);
});

test('resolveDeployIdentity is order-only: it never inspects, merges or repairs a candidate', () => {
  const candidates = [
    { state: 'none', source: 'project' },
    { state: 'stored', source: 'instance', user: 'GOA\\svc', password: 'p' },
    { state: 'stored', source: 'operator', user: 'kevin', password: 'k' },
  ];
  assert.equal(resolveDeployIdentity(candidates).source, 'instance');
  assert.equal(resolveDeployIdentity([null, undefined, ...candidates]).source, 'instance');
});

// ─── stored shape ───────────────────────────────────────────────────────────

function store(fileContents, { writes = [] } = {}) {
  return {
    writes,
    api: createWorkbenchSettingsStore({
      filePath: '/tmp/pw-test-settings.json',
      defaults: { permissionMode: 'prompt' },
      encrypt, decrypt, readCredentialState: readStoredDeployPassword,
      readFile: async () => fileContents,
      writeAtomic: async (_path, body) => { writes.push(JSON.parse(body)); },
      withLock: async (_lock, fn) => fn(),
    }),
  };
}

test('a malformed credential block is fail-closed, never "no credential configured"', () => {
  // The dangerous reading of a broken block is "nothing is configured", because
  // that deploys production as whoever pressed the button.
  for (const bad of [
    { deployCredentials: 'GOA\\james.levac' },
    { deployCredentials: { prod: { user: 'GOA\\ok', password: 'plaintext-not-enc' } } },
    { deployCredentials: { prod: { user: 'GOA\\ok', note: 'x'.repeat(201) } } },
    { deployCredentials: { staging: { user: 'GOA\\ok' } } },
    { deployCredentials: { prod: { user: 'has space' } } },
    { deployCredentials: { prod: { user: 'GOA\\only-user', password: '' } } },
    { deployCredentials: { prod: { user: '', password: encrypt('only-password') } } },
  ]) {
    assert.throws(() => savedDeployCredentials(bad), error => {
      assert.equal(error.statusCode, 503, `${JSON.stringify(bad)} must fail closed`);
      return true;
    });
  }
  assert.deepEqual(savedDeployCredentials({}).prod, { user: '', password: '', note: '' });
});

test('the password never leaves the server, in any state', async () => {
  const settings = { deployCredentials: { prod: { user: 'GOA\\james.levac', password: encrypt('real'), note: 'prod IIS + SQL' } } };
  const shown = publicDeployCredentials(settings);
  assert.deepEqual(shown.prod, { user: 'GOA\\james.levac', note: 'prod IIS + SQL', hasPassword: true });
  const exposed = JSON.stringify(publicWorkbenchSettings(settings));
  assert.equal(exposed.includes(encrypt('real')), false, 'not even the ciphertext leaves the server');
  assert.equal(exposed.includes('enc:'), false);
});

test('blank password means KEEP, clearing is explicit, and a general settings save cannot touch either', async () => {
  const initial = JSON.stringify({ deployCredentials: { prod: { user: 'GOA\\james.levac', password: encrypt('real'), note: '' } } });
  const kept = store(initial);
  await kept.api.updateDeployCredential({ target: 'prod', user: 'GOA\\james.levac', password: '', note: 'still here' });
  assert.equal(kept.writes.at(-1).deployCredentials.prod.password, encrypt('real'), 'a blank field is not a removal');
  assert.equal(kept.writes.at(-1).deployCredentials.prod.note, 'still here');

  const cleared = store(initial);
  await cleared.api.updateDeployCredential({ target: 'prod', clear: true });
  assert.deepEqual(cleared.writes.at(-1).deployCredentials.prod, { user: '', password: '', note: '' });

  const general = store(initial);
  await general.api.updateGeneral({ permissionMode: 'accept', deployCredentials: { prod: { user: 'GOA\\attacker' } } });
  assert.equal(general.writes.at(-1).deployCredentials.prod.user, 'GOA\\james.levac', 'a wizard form must not reach the credential');
  assert.equal(general.writes.at(-1).permissionMode, 'accept');
});

test('a password with no account is refused, and dev/prod stay independent', async () => {
  const only = store(JSON.stringify({}));
  await assert.rejects(() => only.api.updateDeployCredential({ target: 'prod', password: 'lonely' }), /account name/);
  await assert.rejects(() => only.api.updateDeployCredential({ target: 'prod', user: 'GOA\\lonely' }), /password/);
  await assert.rejects(() => only.api.updateDeployCredential({ target: 'staging', user: 'GOA\\x' }), /dev or prod/);

  const both = store(JSON.stringify({}));
  await both.api.updateDeployCredential({ target: 'dev', user: 'GOA\\dev.acct', password: 'devpass' });
  const written = both.writes.at(-1).deployCredentials;
  assert.equal(written.dev.password, encrypt('devpass'));
  assert.deepEqual(written.prod, { user: '', password: '', note: '' }, 'saving dev must not populate prod');
});

test('deployCredential() reports the state the resolver needs, not a boolean', async () => {
  const good = store(JSON.stringify({ deployCredentials: { dev: { user: 'GOA\\a', password: encrypt('p'), note: '' } } }));
  assert.deepEqual(await good.api.deployCredential('dev'),
    { state: 'stored', source: 'instance', user: 'GOA\\a', password: 'p', note: '' });
  assert.equal((await good.api.deployCredential('prod')).state, 'none');

  const wrongKey = store(JSON.stringify({ deployCredentials: { dev: { user: 'GOA\\a', password: 'enc:b3RoZXI', note: '' } } }));
  const unreadable = await wrongKey.api.deployCredential('dev');
  assert.deepEqual([unreadable.state, unreadable.password], ['unreadable', '']);

});

test('the domain is canonicalised, because a slot script matched GOA literally and blocked every deploy', async () => {
  // AITDataHub's identity gate tested `^GOA\\...` case-sensitively, so a
  // credential saved the way an administrator types it — `goa\james.levac` —
  // blocked every deploy of that project. Fixing it per script means fixing it in
  // every generated repository forever, so PW hands out one canonical form.
  assert.equal(validateDeployAccount('goa\\james.levac'), 'GOA\\james.levac');
  assert.equal(validateDeployAccount('Goa\\james.levac'), 'GOA\\james.levac');
  assert.equal(validateDeployAccount(' goa\\james.levac '), 'GOA\\james.levac');
  // The account name is NOT touched: scripts compare it case-insensitively, and
  // an operator reads this value back in the UI.
  assert.equal(validateDeployAccount('goa\\AIT-DBService.S'), 'GOA\\AIT-DBService.S');
  assert.equal(validateDeployAccount('james.levac'), 'james.levac', 'a bare account name is left for the script to qualify');

  // Both storage paths, not just the one that happens to be validated: a
  // lowercase value already saved resolves canonically without a re-save...
  const saved = store(JSON.stringify({ deployCredentials: { prod: { user: 'goa\\james.levac', password: encrypt('p'), note: '' } } }));
  assert.equal((await saved.api.deployCredential('prod')).user, 'GOA\\james.levac');
  await saved.api.updateDeployCredential({ target: 'prod', user: 'goa\\james.levac' });
  assert.equal(saved.writes.at(-1).deployCredentials.prod.user, 'GOA\\james.levac', '...and is stored canonically once touched');

  // ...and a hand-edited slot override, which never passes through the settings
  // validator at all, still reaches the script in the same form.
  const identity = makeDeployIdentity({ decrypt, instanceCredential: async () => ({ state: 'none', source: 'instance', user: '', password: '' }) });
  const resolved = await identity.resolve({ deployCredential: { user: 'goa\\svc-project', password: encrypt('s') } }, 'prod', operator);
  assert.equal(resolved.user, 'GOA\\svc-project');
  assert.equal(identity.env(resolved, 'kev').DEPLOY_USER, 'GOA\\svc-project');
});
