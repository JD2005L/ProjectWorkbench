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
