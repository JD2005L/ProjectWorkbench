// Deploy re-authentication.
//
// A slot with `reauth` asks the operator for their domain password. A password
// saved from an earlier deploy is kept encrypted on the user record, so the
// common case must be "use the saved one silently". Both deploy surfaces used to
// prompt BEFORE calling the server, which made storing a password pointless —
// the cockpit modal was fixed and the standalone Deployment Centre was not, so
// the two UIs disagreed about the same contract.
//
// The contract: the client always requests first; the server answers
// needPassword; only then does the client prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REAUTH_PROMPT,
  REAUTH_REJECTED,
  REAUTH_STALE,
  resolveDeployReauth,
} from '../app/deploy-reauth.js';

const GOOD = 'correct horse battery staple';
const verifyGood = async (pw) => pw === GOOD;

test('no reauth on the slot: run straight through, never save', async () => {
  assert.deepEqual(
    await resolveDeployReauth({ reauth: false, stored: 'saved', verify: async () => { throw new Error('must not verify'); } }),
    { ok: true, password: 'saved', save: false },
  );
  assert.deepEqual(
    await resolveDeployReauth({ reauth: false, submitted: 'typed', stored: 'saved', savePassword: true, verify: null }),
    { ok: true, password: 'typed', save: false },
  );
});

test('REGRESSION: a valid saved password is used without prompting', async () => {
  const seen = [];
  const res = await resolveDeployReauth({
    reauth: true, stored: GOOD,
    verify: async (pw) => { seen.push(pw); return pw === GOOD; },
  });
  assert.deepEqual(res, { ok: true, password: GOOD, save: false });
  assert.deepEqual(seen, [GOOD], 'the saved password must be verified, once, with no user interaction');
});

test('a stale saved password asks for a new one and says why', async () => {
  const res = await resolveDeployReauth({ reauth: true, stored: 'old-password', verify: verifyGood });
  assert.equal(res.ok, false);
  assert.equal(res.needPassword, true);
  assert.equal(res.staleStored, true);
  assert.equal(res.error, REAUTH_STALE);
});

test('no saved password at all asks for one without implying it went stale', async () => {
  const res = await resolveDeployReauth({ reauth: true, verify: verifyGood });
  assert.equal(res.needPassword, true);
  assert.equal(res.staleStored, false);
  assert.equal(res.error, REAUTH_PROMPT);
});

test('a wrong password the user just typed is reported as rejected, not stale', async () => {
  const res = await resolveDeployReauth({ reauth: true, submitted: 'nope', stored: GOOD, verify: verifyGood });
  assert.equal(res.needPassword, true);
  assert.equal(res.staleStored, false, 'the user typed it, so the SAVED one is not what failed');
  assert.equal(res.error, REAUTH_REJECTED);
});

test('a freshly entered password is saved only when the user opted in', async () => {
  assert.deepEqual(
    await resolveDeployReauth({ reauth: true, submitted: GOOD, savePassword: true, verify: verifyGood }),
    { ok: true, password: GOOD, save: true },
  );
  assert.deepEqual(
    await resolveDeployReauth({ reauth: true, submitted: GOOD, savePassword: false, verify: verifyGood }),
    { ok: true, password: GOOD, save: false },
  );
});

test('a password that came only from storage is never re-saved', async () => {
  const res = await resolveDeployReauth({ reauth: true, stored: GOOD, savePassword: true, verify: verifyGood });
  assert.equal(res.save, false, 'nothing new was typed, so there is nothing to persist');
});

test('a typed password overrides a stale stored one, so users can self-correct', async () => {
  const res = await resolveDeployReauth({ reauth: true, submitted: GOOD, stored: 'old-password', verify: verifyGood });
  assert.deepEqual(res, { ok: true, password: GOOD, save: false });
});

test('a verifier that throws is a failure, never a pass', async () => {
  const res = await resolveDeployReauth({
    reauth: true, stored: GOOD,
    verify: async () => { throw new Error('LDAP unreachable'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.needPassword, true);
});

test('an empty candidate is never handed to the verifier', async () => {
  let called = false;
  const res = await resolveDeployReauth({ reauth: true, verify: async () => { called = true; return true; } });
  assert.equal(called, false, 'an empty password must not be able to verify');
  assert.equal(res.ok, false);
});

// ── Both client surfaces must implement the same contract ───────────────────

function extractScript(name) {
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  assert.ok(m, `${name} not found in app/server.js`);
  return m[1];
}

const SURFACES = ['deployModalScript', 'deployScript'];

test('REGRESSION: neither deploy surface prompts before asking the server', async (t) => {
  for (const name of SURFACES) {
    await t.test(name, () => {
      const script = extractScript(name);
      const prompts = [...script.matchAll(/prompt\(/g)];
      assert.equal(prompts.length, 1, 'exactly one password prompt expected');
      const promptAt = prompts[0].index;
      const needAt = script.indexOf('needPassword');
      assert.notEqual(needAt, -1, 'must react to the server needPassword answer');
      assert.ok(needAt < promptAt, 'the prompt must be a REACTION to needPassword, not a precondition');
      // The first attempt carries no password at all.
      assert.match(script, /runDeploy\('',\s*false\)/, 'must attempt the deploy with no password first');
    });
  }
});

test('both deploy surfaces offer save-on-success and share the request shape', async (t) => {
  for (const name of SURFACES) {
    await t.test(name, () => {
      const script = extractScript(name);
      assert.ok(script.includes('savePassword'), 'must be able to persist a freshly entered password');
      assert.ok(script.includes('bd.password=pw'), 'password travels in the JSON body');
      assert.ok(!script.includes('__pwHasDeployPassword'), 'the client must not second-guess the server');
    });
  }
});

test('the stale-password hint reaches the user verbatim', () => {
  for (const name of SURFACES) {
    // Both surfaces show j.error, which is where REAUTH_STALE/REAUTH_PROMPT land.
    assert.match(extractScript(name), /prompt\(j\.error\|\|/, `${name} must surface the server's reason`);
  }
});
