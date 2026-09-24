// Contract for the machine API surface and its Settings administration.
//
// Deliberately booted WITHOUT the tmux fixture. The scope refusals, the admin CRUD and the
// Settings page all work with no tmux server, and withCockpit cannot start one from inside a
// pane (the owner-cgroup gate rejects it), so using it here would make these assertions
// unrunnable in the environment where the code is actually written. The one assertion that
// genuinely needs a terminal -- a scoped token registering a real project end to end -- lives in
// test/api-tokens-register.test.mjs against the full fixture.
//
// Two defect classes are covered, both of which have happened on this instance:
//   1. "client JavaScript the server generates does not compile" -- the cockpit tab strip vanished
//      on 2026-09-14 when a typographic quote reached an inline <script>. Settings now carries a
//      token-administration script, so it gets the same guard.
//   2. "the gate does not actually gate" -- a scoped credential is only worth something if the
//      refusals are real, so they are asserted against the live route.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inlineScripts } from './cockpit-instance-fixture.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const TYPOGRAPHIC_QUOTES = /[\u2018\u2019\u201C\u201D]/;
const SCOPE = 'projects:register';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Boot a dashboard with isolated state and no tmux dependency. */
async function withDashboard(fn) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-apitok-srv-'));
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_API_TOKENS_PATH: path.join(dir, 'api-tokens.json'),
    PW_AUDIT_LOG: path.join(dir, "audit.log"),
  };
  const logs = [];
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn({ base, dir, logs });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mintViaApi = (base, body) => fetch(`${base}/api/tokens`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('REGRESSION: every inline script on the rendered Settings page compiles', { timeout: 60000 }, async () => {
  await withDashboard(async ({ base }) => {
    const res = await fetch(`${base}/settings`);
    assert.equal(res.status, 200, 'settings must render');
    const html = await res.text();

    const scripts = inlineScripts(html);
    // Guard against a vacuous pass: the token UI must actually be among what was compiled.
    const tokenScript = scripts.find((s) => s.includes('async function loadTokens(') && s.includes('tokCreate'));
    assert.ok(tokenScript, 'the token-administration script must be inline on the Settings page');

    scripts.forEach((code, i) => {
      try {
        new vm.Script(code, { filename: `settings-inline-script-${i}.js` });
      } catch (err) {
        const at = /:(\d+)/.exec(String(err.stack))?.[1];
        assert.fail(`inline script #${i} on Settings does not compile: ${err.message}${at ? ` (line ${at})` : ''}`);
      }
    });

    assert.doesNotMatch(tokenScript, TYPOGRAPHIC_QUOTES, 'the token script must use ASCII string delimiters');
    assert.match(html, /id="tab-tokens"/, 'the API tokens tab must be present');
  });
});

test('the machine surface refuses an absent, unknown or revoked token', { timeout: 60000 }, async () => {
  await withDashboard(async ({ base }) => {
    const register = (name, headers = {}) => fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify({ name, port: String(21000 + crypto.randomInt(0, 8000)) }),
    });

    assert.equal((await register('nocred')).status, 401, 'a bearer token is required');

    const bogus = 'pwat_' + crypto.randomBytes(32).toString('base64url');
    assert.equal((await register('bogus', { Authorization: `Bearer ${bogus}` })).status, 401,
      'an unknown token must not authenticate');

    const created = await mintViaApi(base, { label: 'test-laptop', scopes: [SCOPE] });
    assert.equal(created.ok, true, `token creation must succeed: ${JSON.stringify(created)}`);

    const rev = await fetch(`${base}/api/tokens/${encodeURIComponent(created.record.id)}/revoke`, { method: 'POST' })
      .then((r) => r.json());
    assert.equal(rev.ok, true);
    // No restart between revoke and retry: the store is re-read per request on purpose.
    assert.equal((await register('afterrevoke', { Authorization: `Bearer ${created.token}` })).status, 401,
      'a revoked token must stop authenticating immediately');
  });
});

test('creation returns the plaintext once and listing never hands it back', { timeout: 60000 }, async () => {
  await withDashboard(async ({ base }) => {
    const created = await mintViaApi(base, { label: 'once-only', scopes: [SCOPE] });
    assert.equal(created.ok, true);
    assert.match(created.token, /^pwat_/);

    const listed = await fetch(`${base}/api/tokens`).then((r) => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.tokens.some((t) => t.id === created.record.id), 'the token must be listed');
    assert.ok(!JSON.stringify(listed).includes(created.token),
      'listing must never return a usable credential');
    assert.ok(!JSON.stringify(listed).includes('digest'), 'the digest must not be exposed either');
  });
});

test('token creation validates label and scopes', { timeout: 60000 }, async () => {
  await withDashboard(async ({ base }) => {
    assert.equal((await mintViaApi(base, { label: '', scopes: [SCOPE] })).ok, false, 'a label is required');
    assert.equal((await mintViaApi(base, { label: 'no-scopes', scopes: [] })).ok, false, 'at least one scope is required');
    const bad = await mintViaApi(base, { label: 'bad-scope', scopes: ['admin'] });
    assert.equal(bad.ok, false, 'an unknown scope must be refused');
    assert.match(bad.error, /unknown scope/i);
  });
});

test('the advertised scope list contains no admin-equivalent scope', { timeout: 60000 }, async () => {
  // If someone later adds a broad scope, this is the test that should make them justify it. The
  // session scopes were added for docs/agent-mcp.md; each names one verb, and the list is pinned
  // so the next addition is a deliberate edit too.
  await withDashboard(async ({ base }) => {
    const listed = await fetch(`${base}/api/tokens`).then((r) => r.json());
    assert.deepEqual(listed.scopes, [
      SCOPE, 'sessions:read', 'sessions:prompt', 'sessions:create', 'sessions:prompt:any',
    ]);
    for (const scope of listed.scopes) {
      assert.doesNotMatch(scope, /(^|:)(admin|all|write|\*)$/, `${scope} is too broad for a machine token`);
    }
  });
});

test('the users table can always reach its last column', { timeout: 60000 }, async () => {
  // Measured in a real browser at release 1.26.0921.2045: below ~1400px the row was wider than its
  // card and the Delete button sat past the right edge with no way to reach it — at 1280px, an
  // ordinary laptop width. A CLI column per assistant is what pushed it over. Two causes, both
  // pinned here: nothing scrolled, and the short status pills wrapped onto three lines each, which
  // widened the columns for no gain.
  await withDashboard(async ({ base }) => {
    const html = await (await fetch(`${base}/settings`)).text();
    assert.match(html, /<div class="utable-wrap"[^>]*><table class="utable"/,
      'the table must sit in a container that can scroll to its last column');
    assert.match(html, /\.utable-wrap\{overflow-x:auto/, 'and that container must actually scroll');
    assert.match(html, /\.utable \.role-pill\{display:inline-block;white-space:nowrap;/,
      'a two-word status must not stack into three lines and widen the column that caused this');
  });
});

test('the mint form picks an account and its OWN projects, rather than free text', { timeout: 60000 }, async () => {
  // A typed username is a token that fails on first use with nothing to point at,
  // and a typed project list is a tick that silently never matches. Both are
  // pickers now, and the project picker is the intersection rule made visible:
  // you can only scope a token to projects the account it acts as can reach.
  await withDashboard(async ({ base }) => {
    const html = await (await fetch(`${base}/settings`)).text();
    assert.match(html, /<select id="tokActsAs">/, 'the acting account is chosen, not typed');
    assert.match(html, /nobody \(not a session token\)/, 'and "no account" is an explicit option');
    assert.match(html, /<fieldset id="tokProjects"[^>]*>/, 'projects are a checkbox list');
    assert.match(html, /id="tokAllProjects"/, 'with an explicit "all" rather than a magic asterisk');
    assert.doesNotMatch(html, /id="tokProjects"[^>]*>\s*<input/, 'the old free-text project field is gone');

    const listed = await fetch(`${base}/api/tokens`).then((r) => r.json());
    // Each user carries their own reachable projects, so the picker never offers a
    // project the selected account cannot open.
    assert.ok(Array.isArray(listed.users), 'the payload carries the accounts');
    for (const user of listed.users) {
      assert.equal(typeof user.username, 'string');
      assert.ok(Array.isArray(user.projects), `${user.username} must carry their own project list`);
    }
    assert.equal(JSON.stringify(listed).includes('passwordHash'), false, 'a user list is not a user record');
    assert.equal(JSON.stringify(listed).includes('digest'), false);
  });
});

test('a token can be re-scoped in place, and the secret still works afterwards', { timeout: 60000 }, async () => {
  // The point of editing: widening or narrowing a bot's authority must not mean
  // redeploying the bot. So the digest is untouched and the same plaintext keeps
  // authenticating — with the NEW scopes.
  await withDashboard(async ({ base }) => {
    const minted = await mintViaApi(base, { label: 'editable', scopes: [SCOPE] });
    assert.equal(minted.ok, true, minted.error);
    const id = minted.record.id;

    const patch = async (body) => {
      const r = await fetch(`${base}/api/tokens/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };

    // Session scopes cannot be added without naming the account they act as.
    const nameless = await patch({ scopes: [SCOPE, 'sessions:read'] });
    assert.equal(nameless.status, 400);
    assert.match(nameless.body.error, /must name the user it acts as/);

    // Nor can a token be left able to do nothing — that is what revoking is for.
    const empty = await patch({ scopes: [] });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /revoke it instead/);

    const unknown = await patch({ scopes: ['admin'] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown scope/);

    // A narrowing edit needs nothing extra.
    const narrowed = await patch({ scopes: [SCOPE], label: 'editable (narrowed)' });
    assert.equal(narrowed.status, 200);
    assert.deepEqual(narrowed.body.record.scopes, [SCOPE]);
    assert.equal(narrowed.body.record.label, 'editable (narrowed)');
    assert.ok(narrowed.body.record.updatedAt, 'an edit is stamped, because a scope change is an authority change');
    assert.equal(narrowed.body.record.createdAt, minted.record.createdAt, 'provenance is not editable history');

    // And the credential minted before the edit still authenticates.
    const stillWorks = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.token}`, Origin: base },
      body: JSON.stringify({}),
    });
    assert.notEqual(stillWorks.status, 401, 'the secret was not rolled by re-scoping');
    assert.notEqual(stillWorks.status, 403, 'and it still carries the scope it was left with');

    assert.equal((await patch({ scopes: [SCOPE] })).status, 200);
    const missing = await fetch(`${base}/api/tokens/does-not-exist`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopes: [SCOPE] }),
    });
    assert.equal(missing.status, 404);
  });
});
