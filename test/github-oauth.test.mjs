// Authorising GitHub per person, from the Users page.
//
// The problem it removes: one stored token per person has to be both the push credential
// pinned into every repository that person owns AND what authenticates Copilot in their
// terminals. Those need different permissions, and a hand-made PAT reliably satisfies one
// while failing the other — which has now happened in both directions on this workbench
// (a classic PAT that pushed and Copilot refused, then a fine-grained one Copilot took and
// could not push). An authorisation grants what it grants, rather than whatever somebody
// remembered to tick.
//
// Device flow, because the web flow needs an inbound redirect URL and this is a LAN host
// behind a private CA.
//
// Two things get careful treatment here, and they are the reason most of these tests
// exist: the device code is a secret that COLLECTS a token, so it must never reach a
// browser; and the flow can be started by an administrator on somebody else's row, so
// WHICH GitHub account actually authorised has to be verified and shown rather than
// assumed to be the row it was started from.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import {
  githubOauthConfig, startDeviceFlow, pollDeviceFlow, verifyToken, describeTokenCapability,
  DEVICE_CODE_PATH, ACCESS_TOKEN_PATH,
} from '../app/github-oauth.js';
import { withCockpit } from './cockpit-instance-fixture.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the feature is OFF until an operator names an OAuth app', () => {
  // No default client id on purpose. The two ways to fill it are not equivalent — an
  // org-registered app is accountable but may not be accepted by Copilot, while the
  // GitHub CLI's public id is accepted by Copilot but means authorising as another
  // vendor's app. That is an operator's decision, so an unset value must produce an
  // actionable message rather than a silent fallback.
  assert.equal(githubOauthConfig({}).enabled, false);
  assert.equal(githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: '   ' }).enabled, false);
  const on = githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: 'Iv1.test' });
  assert.equal(on.enabled, true);
  assert.equal(on.clientId, 'Iv1.test');
});

test('scopes are configurable and sent the way GitHub wants them', () => {
  // Comma-separated is friendlier in an env var; GitHub wants spaces.
  assert.equal(githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: 'x' }).scopes, 'repo read:org workflow');
  assert.equal(githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: 'x', PW_GITHUB_OAUTH_SCOPES: 'repo, gist' }).scopes, 'repo gist');
  assert.equal(githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: 'x', PW_GITHUB_OAUTH_SCOPES: '' }).scopes, '');
});

// ---------------------------------------------------------------------------
// The protocol, with fetch injected
// ---------------------------------------------------------------------------

const cfg = githubOauthConfig({ PW_GITHUB_OAUTH_CLIENT_ID: 'Iv1.test', PW_GITHUB_OAUTH_BASE: 'https://gh.test', PW_GITHUB_API_BASE: 'https://api.gh.test' });
const jsonFetch = (map) => async (url, opts = {}) => {
  const key = String(url);
  const entry = map[key];
  if (!entry) throw new Error(`unexpected request: ${key}`);
  const body = typeof entry === 'function' ? entry(opts) : entry;
  return {
    ok: body.__status ? body.__status < 400 : true,
    status: body.__status || 200,
    headers: { get: (h) => (body.__headers || {})[String(h).toLowerCase()] || '' },
    json: async () => body,
  };
};

test('starting the flow returns what the person needs, and keeps the device code server-side', async () => {
  const out = await startDeviceFlow({
    fetchImpl: jsonFetch({
      [`https://gh.test${DEVICE_CODE_PATH}`]: { device_code: 'DEV-SECRET', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 },
    }),
    config: cfg,
  });
  assert.equal(out.userCode, 'ABCD-1234');
  assert.equal(out.verificationUri, 'https://github.com/login/device');
  assert.equal(out.deviceCode, 'DEV-SECRET');
  assert.equal(out.intervalMs, 5000);
  assert.equal(out.expiresInMs, 900000);
});

test('a missing interval or expiry falls back to the spec defaults rather than NaN', async () => {
  const out = await startDeviceFlow({
    fetchImpl: jsonFetch({ [`https://gh.test${DEVICE_CODE_PATH}`]: { device_code: 'd', user_code: 'u', verification_uri: 'v' } }),
    config: cfg,
  });
  assert.equal(out.intervalMs, 5000);
  assert.equal(out.expiresInMs, 900000);
});

test('a refused client id says so, and says what to check', async () => {
  // The likeliest misconfiguration by a mile: an app without Device Flow enabled.
  await assert.rejects(startDeviceFlow({
    fetchImpl: jsonFetch({ [`https://gh.test${DEVICE_CODE_PATH}`]: { error: 'unauthorized_client', error_description: 'Device Flow is not enabled' } }),
    config: cfg,
  }), /PW_GITHUB_OAUTH_CLIENT_ID.*Device Flow|Device Flow.*enabled/s);
});

test('every polling outcome is a status, because "not yet" is the normal case', async () => {
  const poll = (body) => pollDeviceFlow({
    fetchImpl: jsonFetch({ [`https://gh.test${ACCESS_TOKEN_PATH}`]: body }),
    config: cfg, deviceCode: 'd',
  });
  assert.deepEqual(await poll({ error: 'authorization_pending' }), { status: 'pending' });
  assert.deepEqual(await poll({ error: 'access_denied' }), { status: 'denied' });
  assert.deepEqual(await poll({ error: 'expired_token' }), { status: 'expired' });
  assert.deepEqual(await poll({ error: 'slow_down', interval: 10 }), { status: 'slow-down', intervalMs: 10000 });
  assert.deepEqual(await poll({ access_token: 'gho_NEW' }), { status: 'ok', token: 'gho_NEW' });
  // Anything unrecognised is a real error rather than a silent "keep waiting", which
  // would spin forever.
  await assert.rejects(poll({ error: 'incorrect_client_credentials' }), /refused the request/);
});

test('the token is verified against the account it belongs to, with its scopes', async () => {
  const out = await verifyToken({
    fetchImpl: jsonFetch({ 'https://api.gh.test/user': { login: 'kev-goa', __headers: { 'x-oauth-scopes': 'repo, read:org, workflow' } } }),
    config: cfg, token: 'gho_NEW',
  });
  assert.equal(out.login, 'kev-goa');
  assert.deepEqual(out.scopes, ['repo', 'read:org', 'workflow']);
});

test('a token GitHub will not even identify is refused rather than stored', async () => {
  await assert.rejects(verifyToken({
    fetchImpl: jsonFetch({ 'https://api.gh.test/user': { __status: 401, message: 'Bad credentials' } }),
    config: cfg, token: 'gho_BAD',
  }), /HTTP 401/);
  await assert.rejects(verifyToken({
    fetchImpl: jsonFetch({ 'https://api.gh.test/user': { not_a_login: true } }),
    config: cfg, token: 'gho_ODD',
  }), /which account/);
});

test('capability is reported as what the token CARRIES, never as a promise', () => {
  // The failure that started this was a token with the right paperwork and no write
  // access to the repository, so this deliberately does not claim a push will work.
  const yes = describeTokenCapability(['repo', 'read:org']);
  assert.equal(yes.canPush, true);
  assert.match(yes.pushNote, /wherever this GitHub account already has write access/);
  const no = describeTokenCapability(['read:org']);
  assert.equal(no.canPush, false);
  assert.match(no.pushNote, /cannot push/);
});

// ---------------------------------------------------------------------------
// End to end, against a stub GitHub
// ---------------------------------------------------------------------------

const scryptAsync = promisify(crypto.scrypt);
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}
const PASSWORD = 'D3vice!Flow';
const ADMIN = 'james.levac';
const DEV = 'kevin.charlebois';

async function seedUsers(dir) {
  const passwordHash = await hashPassword(PASSWORD);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { id: 'u-a', username: ADMIN, role: 'admin', projects: '*', passwordHash },
    { id: 'u-d', username: DEV, role: 'developer', projects: '*', passwordHash },
  ] }, null, 2));
}
const login = async (base, username) => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal((await r.json()).ok, true, `sanity: ${username} must sign in`);
  return r.headers.get('set-cookie').split(';')[0];
};

/** A stub GitHub: one device code, a scripted sequence of poll answers, and /user. */
async function stubGithub({ pollAnswers, login: ghLogin = 'kev-goa', scopes = 'repo, read:org' }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, payload });
      const send = (obj, status = 200, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.url === DEVICE_CODE_PATH) {
        return send({ device_code: 'DEVICE-SECRET-XYZ', user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 900 });
      }
      if (req.url === ACCESS_TOKEN_PATH) return send(pollAnswers.shift() || { error: 'authorization_pending' });
      if (req.url === '/user') return send({ login: ghLogin }, 200, { 'x-oauth-scopes': scopes });
      return send({ error: 'not_found' }, 404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, close: () => new Promise((r) => server.close(r)) };
}
const ghEnv = (origin) => ({
  PW_GITHUB_OAUTH_CLIENT_ID: 'Iv1.testclient',
  PW_GITHUB_OAUTH_BASE: origin,
  PW_GITHUB_API_BASE: origin,
});

test('a person authorises from the Users page and the token lands on their record', { timeout: 120000 }, async () => {
  const gh = await stubGithub({ pollAnswers: [{ error: 'authorization_pending' }, { access_token: 'gho_FRESH_TOKEN' }] });
  try {
    await withCockpit(async ({ base, dir }) => {
      await seedUsers(dir);
      const cookie = await login(base, DEV);

      const started = await (await fetch(`${base}/api/github-oauth/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({}),
      })).json();
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(started.userCode, 'WXYZ-9876', 'the person is given a code to type');
      assert.equal(started.verificationUri, 'https://github.com/login/device');
      // The device code COLLECTS the token, so it must never reach a browser.
      assert.equal(JSON.stringify(started).includes('DEVICE-SECRET-XYZ'), false,
        'the device code must stay server-side');

      const first = await (await fetch(`${base}/api/github-oauth/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({}),
      })).json();
      assert.deepEqual(first, { ok: true, status: 'pending' }, 'waiting is a normal answer');

      const done = await (await fetch(`${base}/api/github-oauth/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({}),
      })).json();
      assert.equal(done.status, 'ok', JSON.stringify(done));
      assert.equal(done.login, 'kev-goa', 'the GitHub account is reported');
      assert.equal(done.canPush, true);
      // And never the token itself.
      assert.equal(JSON.stringify(done).includes('gho_FRESH_TOKEN'), false);

      // Stored, and visible as an OAuth token belonging to a named GitHub account.
      const admin = await login(base, ADMIN);
      const users = await (await fetch(`${base}/api/users`, { headers: { cookie: admin } })).json();
      const kev = users.users.find((u) => u.username === DEV);
      assert.equal(kev.hasToken, true);
      assert.equal(kev.tokenKind, 'oauth', 'an OAuth token, which is the point — it does both jobs');
      assert.equal(kev.ghLogin, 'kev-goa', 'and the row says which GitHub account it is');
    }, { env: ghEnv(gh.origin) });
  } finally { await gh.close(); }
});

test('an admin may start it for somebody else; a developer may not', { timeout: 120000 }, async () => {
  const gh = await stubGithub({ pollAnswers: [{ access_token: 'gho_FOR_KEV' }], login: 'kev-goa' });
  try {
    await withCockpit(async ({ base, dir }) => {
      await seedUsers(dir);
      const admin = await login(base, ADMIN);
      const dev = await login(base, DEV);
      const start = (cookie, username) => fetch(`${base}/api/github-oauth/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ username }),
      }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

      const refused = await start(dev, ADMIN);
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 403);
      assert.match(refused.error, /only connect your own/);

      const allowed = await start(admin, DEV);
      assert.equal(allowed.ok, true, JSON.stringify(allowed));
      assert.equal(allowed.target, DEV);

      // Whoever authorises is whoever was signed into GitHub, which need not be the row
      // it was started from — so the resulting account is verified and reported, and
      // that is what makes a mis-binding visible instead of silent.
      const done = await (await fetch(`${base}/api/github-oauth/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: admin }, body: JSON.stringify({ username: DEV }),
      })).json();
      assert.equal(done.status, 'ok');
      assert.equal(done.target, DEV, 'stored against the row it was started for');
      assert.equal(done.login, 'kev-goa', 'and names the GitHub account that actually authorised');
    }, { env: ghEnv(gh.origin) });
  } finally { await gh.close(); }
});

test('a declined authorisation is reported and the pending flow is dropped', { timeout: 120000 }, async () => {
  const gh = await stubGithub({ pollAnswers: [{ error: 'access_denied' }] });
  try {
    await withCockpit(async ({ base, dir }) => {
      await seedUsers(dir);
      const cookie = await login(base, DEV);
      await fetch(`${base}/api/github-oauth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
      const denied = await (await fetch(`${base}/api/github-oauth/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' })).json();
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 'denied');
      assert.match(denied.error, /declined/);
      // One authorisation, one use: polling again has nothing to poll.
      const again = await (await fetch(`${base}/api/github-oauth/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' })).json();
      assert.equal(again.ok, false);
      assert.match(again.error, /no longer in progress/);

      // And nothing was stored.
      const admin = await login(base, ADMIN);
      const users = await (await fetch(`${base}/api/users`, { headers: { cookie: admin } })).json();
      assert.equal(users.users.find((u) => u.username === DEV).hasToken, false);
    }, { env: ghEnv(gh.origin) });
  } finally { await gh.close(); }
});

test('with no OAuth app configured the routes say what to configure', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, dir }) => {
    await seedUsers(dir);
    const cookie = await login(base, DEV);
    const out = await fetch(`${base}/api/github-oauth/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}',
    }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(out.error, /PW_GITHUB_OAUTH_CLIENT_ID/);
    assert.match(out.error, /paste a token instead/, 'and names the way that still works');

    const users = await (await fetch(`${base}/api/users`, { headers: { cookie: await login(base, ADMIN) } })).json();
    assert.equal(users.githubOauth, false, 'the UI is told so it can disable the button');
  });
});
