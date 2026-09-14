// Contract for the machine API's scoped service tokens (app/api-tokens.js).
//
// These are the security properties the feature exists to provide, so they are pinned rather
// than left to review: a stored record must never be a usable credential, a revoked token must
// stop working without being deleted, and an unnamed scope must be a refusal rather than a
// default. The alternative to a test here is trusting that nobody later "simplifies" the digest
// comparison into an equality check on a plaintext field.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  SCOPES, mintToken, loadTokens, saveTokens, safeTokenShape,
  resolveToken, presentedToken, tokenHasScope, isKnownScope, digestToken,
} from '../app/api-tokens.js';

const SCOPE = SCOPES.PROJECTS_REGISTER;

test('a minted record stores a digest and never the plaintext', () => {
  const { plaintext, record } = mintToken({ label: 'laptop', scopes: [SCOPE], createdBy: 'admin' });
  assert.match(plaintext, /^pwat_/, 'tokens carry an identifiable prefix');
  assert.ok(plaintext.length > 40, 'token must have real entropy');
  assert.equal(record.digest, digestToken(plaintext));
  // The whole point: nothing in the persisted record can be replayed as a credential.
  assert.ok(!JSON.stringify(record).includes(plaintext), 'the record must not embed the plaintext');
});

test('minting refuses an unknown scope and refuses no scopes at all', () => {
  assert.throws(() => mintToken({ label: 'x', scopes: ['admin'] }), /unknown scope/i,
    'a scope that does not exist must not be silently accepted');
  assert.throws(() => mintToken({ label: 'x', scopes: [] }), /no scopes/i);
});

test('there is deliberately no admin scope', () => {
  // A credential that lives on a laptop must not be able to reach the dashboard's 29 admin
  // routes. If someone adds one later, this test should be the thing that makes them argue for it.
  assert.deepEqual(Object.values(SCOPES), [SCOPE]);
  assert.equal(isKnownScope('admin'), false);
  assert.equal(isKnownScope('*'), false);
});

test('resolveToken matches the right token and refuses everything else', () => {
  const a = mintToken({ label: 'a', scopes: [SCOPE] });
  const b = mintToken({ label: 'b', scopes: [SCOPE] });
  const tokens = [a.record, b.record];

  assert.equal(resolveToken(tokens, a.plaintext).id, a.record.id);
  assert.equal(resolveToken(tokens, b.plaintext).id, b.record.id);

  assert.equal(resolveToken(tokens, 'pwat_not-a-real-token'), null);
  assert.equal(resolveToken(tokens, ''), null);
  assert.equal(resolveToken(tokens, null), null);
  // A value without the prefix is rejected before any comparison happens.
  assert.equal(resolveToken(tokens, a.plaintext.replace(/^pwat_/, '')), null);
});

test('revocation disables without deleting, so the audit trail survives', () => {
  const { plaintext, record } = mintToken({ label: 'revoke-me', scopes: [SCOPE] });
  assert.ok(resolveToken([record], plaintext), 'valid before revocation');
  record.disabled = true;
  assert.equal(resolveToken([record], plaintext), null, 'a disabled token must not resolve');
  assert.equal(record.label, 'revoke-me', 'the record itself is retained');
});

test('scope absence is refusal, not a default', () => {
  const { record } = mintToken({ label: 'narrow', scopes: [SCOPE] });
  assert.equal(tokenHasScope(record, SCOPE), true);
  assert.equal(tokenHasScope(record, 'projects:delete'), false);
  assert.equal(tokenHasScope({}, SCOPE), false);
  assert.equal(tokenHasScope(null, SCOPE), false);
});

test('safeTokenShape never exposes the digest', () => {
  const { record } = mintToken({ label: 'shown', scopes: [SCOPE] });
  const safe = safeTokenShape(record);
  assert.equal(safe.digest, undefined);
  assert.ok(!JSON.stringify(safe).includes(record.digest));
  assert.equal(safe.label, 'shown');
  assert.deepEqual(safe.scopes, [SCOPE]);
});

test('presentedToken reads only a bearer Authorization header', () => {
  const req = (h) => ({ get: (k) => (k.toLowerCase() === 'authorization' ? h : '') });
  assert.equal(presentedToken(req('Bearer pwat_abc')), 'pwat_abc');
  assert.equal(presentedToken(req('bearer pwat_abc')), 'pwat_abc', 'scheme is case-insensitive');
  assert.equal(presentedToken(req('Basic pwat_abc')), '', 'Basic must not be treated as a token');
  assert.equal(presentedToken(req('')), '');
});

test('the store round-trips and a missing file reads as empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-apitok-'));
  const file = path.join(dir, 'api-tokens.json');
  try {
    assert.deepEqual(await loadTokens(file), [], 'absent store is empty, not an error');
    const { record } = mintToken({ label: 'persisted', scopes: [SCOPE] });
    await saveTokens(file, [record]);
    const back = await loadTokens(file);
    assert.equal(back.length, 1);
    assert.equal(back[0].id, record.id);
    // 0600: the digests are not replayable, but the scope set still describes real authority.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
