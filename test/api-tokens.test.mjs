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
  tokenAuthority,
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

test('there is deliberately no admin scope, and every scope is narrow', () => {
  // A credential that lives on a laptop must not be able to reach the dashboard's 29 admin
  // routes. The list is pinned so adding a scope stays a deliberate, reviewable edit — the
  // session scopes below were added for docs/agent-mcp.md and are narrow on purpose: reading a
  // pane, typing into one, creating a window and typing into somebody ELSE's window are four
  // separate grants rather than one "sessions" power.
  assert.deepEqual(Object.values(SCOPES), [
    'projects:register',
    'sessions:read', 'sessions:prompt', 'sessions:create', 'sessions:prompt:any',
  ]);
  assert.equal(isKnownScope('admin'), false);
  assert.equal(isKnownScope('*'), false);
  assert.equal(isKnownScope('sessions'), false, 'a scope must name a verb, not a whole subsystem');
  for (const scope of Object.values(SCOPES)) {
    assert.match(scope, /^[a-z]+:[a-z:]+$/, `${scope} must be resource:verb`);
    assert.doesNotMatch(scope, /(^|:)(admin|all|write|\*)$/, `${scope} is too broad to be a token scope`);
  }
});

test('a session scope cannot be minted without the account it acts as', () => {
  // The window's launcher, the CLI credentials it spends and the audit line all come from
  // actsAs. There is no sensible default, and guessing one would fabricate an identity.
  for (const scope of ['sessions:read', 'sessions:prompt', 'sessions:create', 'sessions:prompt:any']) {
    assert.throws(() => mintToken({ label: 'bot', scopes: [scope] }), /must name the user it acts as/);
  }
  // projects:register acts on nobody's behalf, so it still needs nothing.
  assert.ok(mintToken({ label: 'registrar', scopes: [SCOPE] }).record.id);

  const bot = mintToken({ label: 'bot', scopes: ['sessions:prompt'], actsAs: 'kevin.charlebois',
    createdBy: 'james.levac', projects: ['AITDataHub'] }).record;
  assert.equal(bot.actsAs, 'kevin.charlebois', 'authority');
  assert.equal(bot.createdBy, 'james.levac', 'provenance, kept separate');
  assert.deepEqual(bot.projects, ['AITDataHub']);
  assert.equal(safeTokenShape(bot).actsAs, 'kevin.charlebois', 'the dashboard shows who it acts as');
  assert.equal(safeTokenShape(bot).digest, undefined, 'and never the digest');

  assert.throws(() => mintToken({ label: 'bad', scopes: ['sessions:read'], actsAs: 'a b' }), /invalid acting user/);
  assert.throws(() => mintToken({ label: 'bad', scopes: ['sessions:read'], actsAs: 'kev', projects: [] }),
    /at least one project/);
});

test('authority is the INTERSECTION of the token and the person it acts as', () => {
  const bot = mintToken({ label: 'bot', scopes: ['sessions:prompt'], actsAs: 'kev',
    projects: ['AITDataHub', 'SponsorPortal'] }).record;
  const kev = { username: 'kev', projects: ['AITDataHub'] };
  const hasProjectAccess = (user, project) => user.projects === '*' || user.projects.includes(project);

  const live = tokenAuthority(bot, { users: [kev], hasProjectAccess });
  assert.equal(live.ok, true);
  assert.equal(live.canReach('AITDataHub'), true, 'listed by the token AND reachable by the person');
  assert.equal(live.canReach('SponsorPortal'), false, 'the token lists it; the person cannot reach it');
  assert.equal(live.canReach('Bi-Tools'), false, 'the person could, if the token listed it');

  // Offboarding must revoke the robot in the same instant, with no token edit.
  assert.equal(tokenAuthority(bot, { users: [{ ...kev, disabled: true }], hasProjectAccess }).ok, false);
  assert.match(tokenAuthority(bot, { users: [], hasProjectAccess }).reason, /no longer exists/);
  assert.equal(tokenAuthority({ ...bot, disabled: true }, { users: [kev], hasProjectAccess }).ok, false);

  // '*' means "whatever that person can reach" — never more.
  const wide = mintToken({ label: 'wide', scopes: ['sessions:read'], actsAs: 'kev' }).record;
  const wideLive = tokenAuthority(wide, { users: [kev], hasProjectAccess });
  assert.equal(wideLive.canReach('AITDataHub'), true);
  assert.equal(wideLive.canReach('Bi-Tools'), false, '"*" is not a grant of its own');
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
