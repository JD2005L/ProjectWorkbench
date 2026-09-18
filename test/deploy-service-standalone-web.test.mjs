// Tests for the standalone deployment console (app/deployment/standalone-web.js
// + standalone-auth.js). These exercise a real node:http server built from a
// FAKE engine only -- no Project Workbench server, settings store or project
// registry is ever created or imported here, proving the console is fully
// independent of PW. Requests use node:http directly (not fetch) so that
// Set-Cookie/Location headers on 303 redirects are always inspectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStandaloneWeb } from '../app/deployment/standalone-web.js';
import { createDeploymentServer } from '../app/deployment/service.js';
import { renderStandaloneLogin } from '../app/deployment/ui.js';
import { DeploymentError, TERMINAL_STATES, publicJob, targetKey } from '../app/deployment/protocol.js';
import { validateSettings, validateTargetSettings } from '../app/deployment/policy.js';

const BASE_PATH = '/deploy-service';
const ORIGIN = 'https://console.example.test';
// Clearly-synthetic fixture credentials only; never read from any real
// keystore/secret store and never asserted to resemble a production value.
const UI_TOKEN = `fixture-ui-console-token-${'a'.repeat(24)}`;
const API_TOKEN = `fixture-machine-api-token-${'b'.repeat(24)}`;

function job(overrides) {
  return {
    requestId: `req-${overrides.id}`, revision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), adapter: 'script',
    startedAt: null, finishedAt: null, version: null, errorCode: null, events: [], ...overrides,
  };
}

// Mirrors app/deployment/engine.js's public surface and reuses the real
// policy.js validators so "immutable fields refused" proves standalone-web.js's
// passthrough is correct, not a hand-rolled fake validator.
class FakeEngine {
  constructor() {
    this.stopping = false;
    this.active = new Map([['job-running-2', {}], ['job-prod-running-5', {}]]);
    this.queue = ['queued-x'];
    this.settings = { paused: false, maxConcurrent: 2, defaultTimeoutSeconds: 600, retentionDays: 7 };
    this.targets = { [targetKey('ExampleApp', 'prod')]: { paused: false, timeoutSeconds: 600 } };
    this.live = new Map([['job-running-2', [{ seq: 2, at: '2026-01-01T00:05:05.000Z', text: 'deploying...\n' }]]]);
    this.jobs = new Map([
      ['job-succeeded-1', job({
        id: 'job-succeeded-1', project: 'ExampleApp', target: 'prod', state: 'succeeded', phase: 'succeeded',
        createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:02.000Z',
        version: '1.0.0', events: [{ seq: 1, at: '2026-01-01T00:00:02.000Z', phase: 'succeeded', state: 'succeeded' }],
      })],
      ['job-cancelled-4', job({
        id: 'job-cancelled-4', project: 'OtherApp', target: 'dev', state: 'cancelled', phase: 'cancelled',
        createdAt: '2026-01-01T00:02:00.000Z', startedAt: '2026-01-01T00:02:01.000Z', finishedAt: '2026-01-01T00:02:30.000Z',
        errorCode: 'cancelled', events: [{ seq: 1, at: '2026-01-01T00:02:30.000Z', phase: 'cancelled', state: 'cancelled' }],
      })],
      ['job-running-2', job({
        id: 'job-running-2', project: 'ExampleApp', target: 'dev', state: 'running', phase: 'deploying',
        createdAt: '2026-01-01T00:05:00.000Z', startedAt: '2026-01-01T00:05:01.000Z',
        events: [
          { seq: 1, at: '2026-01-01T00:05:01.000Z', phase: 'starting', state: 'running' },
          { seq: 2, at: '2026-01-01T00:05:05.000Z', phase: 'deploying', state: 'running' },
        ],
      })],
      ['job-failed-3', job({
        id: 'job-failed-3', project: 'OtherApp', target: 'dev', state: 'failed', phase: 'failed',
        createdAt: '2026-01-01T00:10:00.000Z', startedAt: '2026-01-01T00:10:01.000Z', finishedAt: '2026-01-01T00:10:20.000Z',
        errorCode: 'script_failed', events: [{ seq: 1, at: '2026-01-01T00:10:20.000Z', phase: 'failed', state: 'failed' }],
      })],
      ['job-prod-running-5', job({
        id: 'job-prod-running-5', project: 'ExampleApp', target: 'prod', state: 'running', phase: 'deploying',
        createdAt: '2026-01-01T00:15:00.000Z', startedAt: '2026-01-01T00:15:01.000Z',
        events: [{ seq: 1, at: '2026-01-01T00:15:01.000Z', phase: 'deploying', state: 'running' }],
      })],
    ]);
    this.cancelCalls = [];
  }

  list({ project, target, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DeploymentError('Invalid job limit');
    return [...this.jobs.values()]
      .filter(item => (!project || item.project === project) && (!target || item.target === target))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit).map(publicJob);
  }

  get(id) {
    const item = this.jobs.get(id);
    if (!item) throw new DeploymentError('Deployment job not found', 404, 'job_not_found');
    return item;
  }

  logs(id, after = 0) {
    const item = this.get(id);
    const live = (this.live.get(id) || []).filter(entry => entry.seq > after);
    return { events: item.events.filter(entry => entry.seq > after), live, nextSeq: item.events.at(-1)?.seq || 0 };
  }

  async cancel(id) {
    const item = this.get(id);
    if (TERMINAL_STATES.has(item.state)) throw new DeploymentError('Deployment already finished', 409, 'job_finished');
    item.state = 'cancelled'; item.phase = 'cancelled'; item.errorCode = 'cancelled';
    item.finishedAt = '2026-01-01T00:20:00.000Z';
    this.cancelCalls.push(id);
    return publicJob(item);
  }

  targetList() {
    const targets = new Map();
    for (const item of this.jobs.values()) {
      const key = `${item.project}/${item.target}`;
      targets.set(key, { project: item.project, target: item.target, adapter: item.adapter });
    }
    for (const key of Object.keys(this.targets)) {
      const [project, target] = key.split('/');
      if (!targets.has(key)) targets.set(key, { project, target });
    }
    return [...targets].map(([key, value]) => ({
      ...value, paused: false, timeoutSeconds: this.settings.defaultTimeoutSeconds, ...this.targets[key],
    })).sort((a, b) => `${a.project}/${a.target}`.localeCompare(`${b.project}/${b.target}`));
  }

  async updateTarget(project, target, value) {
    const key = targetKey(project, target);
    this.targets = { ...this.targets, [key]: validateTargetSettings(value, this.targets[key]) };
    return this.targetList().find(item => item.project === project && item.target === target);
  }

  async updateSettings(value) {
    this.settings = validateSettings(value, this.settings);
    return { ...this.settings };
  }

  async submit() { throw new Error('FakeEngine.submit must never be called by the standalone console'); }
}

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const finalHeaders = { ...headers };
    if (payload !== undefined && finalHeaders['Content-Length'] === undefined) {
      finalHeaders['Content-Length'] = String(payload.length);
    }
    const clientRequest = http.request(`${base}${path}`, { method, headers: finalHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    clientRequest.on('error', reject);
    clientRequest.end(payload);
  });
}

function cookieValue(setCookie) {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first ? first.split(';')[0] : undefined;
}

function csrfFromHtml(html) {
  return html.match(/<meta name="ds-csrf-token" content="([^"]*)">/)?.[1];
}

async function fixture(t, { overrides = {}, engine = new FakeEngine() } = {}) {
  let clock = Date.parse('2026-01-01T01:00:00.000Z');
  const web = createStandaloneWeb({
    engine, token: UI_TOKEN, basePath: BASE_PATH, publicOrigin: ORIGIN, sessionMinutes: 30,
    now: () => clock, ...overrides,
  });
  const server = createDeploymentServer({ engine, token: API_TOKEN, web, publicHealthPath: `${BASE_PATH}/health` });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    web.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function login(token = UI_TOKEN, { origin = ORIGIN } = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin) headers.Origin = origin;
    return request(base, `${BASE_PATH}/login`, { method: 'POST', headers, body: new URLSearchParams({ token }).toString() });
  }
  async function loggedIn() {
    const response = await login();
    assert.equal(response.status, 303, 'fixture login must succeed to seed a session');
    const cookie = cookieValue(response.headers['set-cookie']);
    const page = await request(base, `${BASE_PATH}/`, { headers: { Cookie: cookie } });
    return { cookie, csrf: csrfFromHtml(page.text), page };
  }
  return {
    engine, base, login, loggedIn, advance: ms => { clock += ms; },
    request: (path, options) => request(base, path, options),
  };
}

test('createStandaloneWeb validates its own bounded session/login-limit options at construction, the same way it already validates the credential/origin/basePath', () => {
  const engine = new FakeEngine();
  const base = { engine, token: UI_TOKEN, basePath: BASE_PATH, publicOrigin: ORIGIN };
  const create = overrides => createStandaloneWeb({ ...base, ...overrides });

  for (const maxSessions of [0, -1, 1.5, NaN, Infinity, 10001]) {
    assert.throws(() => create({ maxSessions }), /Invalid console session capacity/, `maxSessions=${maxSessions}`);
  }
  for (const maxLoginAttempts of [0, -1, 1.5, NaN, 1001]) {
    assert.throws(() => create({ maxLoginAttempts }), /Invalid console login attempt bound/, `maxLoginAttempts=${maxLoginAttempts}`);
  }
  for (const loginWindowMs of [0, 999, -5000, NaN, 24 * 60 * 60000 + 1]) {
    assert.throws(() => create({ loginWindowMs }), /Invalid console login throttle window/, `loginWindowMs=${loginWindowMs}`);
  }
  for (const maxConcurrentLogins of [-1, 1.5, NaN, 1001]) {
    assert.throws(() => create({ maxConcurrentLogins }), /Invalid console login concurrency bound/, `maxConcurrentLogins=${maxConcurrentLogins}`);
  }
  // Unlike the other three (which need at least 1), 0 is a legitimate,
  // deliberate "refuse all sign-ins" configuration for maxConcurrentLogins
  // and must not be rejected (the earlier "hard bounds" test above relies on
  // this exact value to force a busy console).
  create({ maxConcurrentLogins: 0 }).close();
  // A representative in-range value for every option together still
  // constructs successfully.
  create({ maxSessions: 500, maxLoginAttempts: 20, loginWindowMs: 60000, maxConcurrentLogins: 8 }).close();
});

test('createStandaloneWeb refuses a base path that collides with the native /v1 or /health routes, mirroring container-config.js\'s validateUiLocation, so a direct factory call can never shadow the bearer API', () => {
  const engine = new FakeEngine();
  const create = basePath => createStandaloneWeb({ engine, token: UI_TOKEN, publicOrigin: ORIGIN, basePath });

  for (const basePath of ['/v1', '/v1/jobs', '/v1/jobs/deep', '/health', '/health/deep']) {
    assert.throws(() => create(basePath), /Invalid console base path/, `basePath=${basePath}`);
  }
  // Only the exact reserved segment collides; a base path that merely starts
  // with the same letters is a distinct, legitimate mount point.
  for (const basePath of ['/v1beta-console', '/healthcheck-console', '/deploy-service']) {
    create(basePath).close();
  }
});

test('the standalone console serves engine-derived job/project/target data end to end, with no PW server or project registry involved', async t => {
  const app = await fixture(t);
  const { cookie, page } = await app.loggedIn();
  assert.match(page.text, /Deployment console/);
  // Projects come only from engine.targetList(); nothing enrolls separately.
  assert.match(page.text, /<option value="ExampleApp">ExampleApp<\/option>/);
  assert.match(page.text, /<option value="OtherApp">OtherApp<\/option>/);
  assert.doesNotMatch(page.text, /NeverDeployed/);

  const jobs = (await app.request(`${BASE_PATH}/api/deploy-service/jobs`, { headers: { Cookie: cookie } })).json();
  assert.equal(jobs.ok, true);
  assert.equal(jobs.jobs.length, 5);
  assert.equal(jobs.jobs[0].id, 'job-prod-running-5', 'newest job first');

  const targets = (await app.request(`${BASE_PATH}/api/deploy-service/targets`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(targets.targets.map(item => `${item.project}/${item.target}`), ['ExampleApp/dev', 'ExampleApp/prod', 'OtherApp/dev']);

  const empty = (await app.request(`${BASE_PATH}/api/deploy-service/jobs?project=NoSuchProject`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(empty.jobs, [], 'explicit empty state for a project with no activity');

  const diagnostics = (await app.request(`${BASE_PATH}/api/deploy-service/diagnostics`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(diagnostics.health, { ok: true, service: 'pw-deploy', apiVersion: 1, ready: true, running: 2, queued: 1 });

  // Log gap: operational history survives, raw live text may not (memory-only).
  const finishedLog = (await app.request(`${BASE_PATH}/api/deploy-service/jobs/job-succeeded-1/log`, { headers: { Cookie: cookie } })).json();
  assert.equal(finishedLog.events.length, 1);
  assert.deepEqual(finishedLog.live, []);
  const runningLog = (await app.request(`${BASE_PATH}/api/deploy-service/jobs/job-running-2/log`, { headers: { Cookie: cookie } })).json();
  assert.equal(runningLog.live.length, 1);
});

test('GET jobs honors the shared UI state filter exactly like the PW route: a valid state narrows results and an invalid one is a real validation error', async t => {
  const app = await fixture(t);
  const { cookie } = await app.loggedIn();
  const byQuery = async query => (await app.request(`${BASE_PATH}/api/deploy-service/jobs?${query}`, { headers: { Cookie: cookie } })).json();

  assert.deepEqual((await byQuery('state=failed')).jobs.map(item => item.id), ['job-failed-3']);
  assert.deepEqual((await byQuery('state=cancelled')).jobs.map(item => item.id), ['job-cancelled-4']);
  // Two running jobs exist; newest (createdAt) first, exactly as the
  // unfiltered list is already ordered.
  assert.deepEqual((await byQuery('state=running')).jobs.map(item => item.id), ['job-prod-running-5', 'job-running-2']);
  // Combines with project/target the same way engine.list()'s own filters do.
  assert.deepEqual((await byQuery('state=running&project=ExampleApp&target=prod')).jobs.map(item => item.id), ['job-prod-running-5']);
  // A state with no matching job is an explicit empty result, not an error.
  assert.deepEqual((await byQuery('state=queued')).jobs, []);

  const invalidState = await app.request(`${BASE_PATH}/api/deploy-service/jobs?state=not-a-real-state`, { headers: { Cookie: cookie } });
  assert.equal(invalidState.status, 400);
  assert.match(invalidState.text, /Invalid deployment job state/);

  const invalidLimit = await app.request(`${BASE_PATH}/api/deploy-service/jobs?limit=0`, { headers: { Cookie: cookie } });
  assert.equal(invalidLimit.status, 400);
  assert.match(invalidLimit.text, /Job limit must be 1-200/);

  const invalidTarget = await app.request(`${BASE_PATH}/api/deploy-service/jobs?target=staging`, { headers: { Cookie: cookie } });
  assert.equal(invalidTarget.status, 400);
  assert.match(invalidTarget.text, /Target must be dev or prod/);

  const invalidProject = await app.request(`${BASE_PATH}/api/deploy-service/jobs?project=${encodeURIComponent('../etc')}`, { headers: { Cookie: cookie } });
  assert.equal(invalidProject.status, 400);
  assert.match(invalidProject.text, /Invalid project name/);
});

test('GET /login renders a sign-in form for anonymous visitors; an already-authenticated visitor is redirected straight to the console', async t => {
  const app = await fixture(t);
  const anonymous = await app.request(`${BASE_PATH}/login`);
  assert.equal(anonymous.status, 200);
  assert.match(anonymous.text, /name="token"/);
  assert.match(anonymous.text, /action="\/deploy-service\/login"/);

  const { cookie } = await app.loggedIn();
  const redirected = await app.request(`${BASE_PATH}/login`, { headers: { Cookie: cookie } });
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.location, `${BASE_PATH}/`);
});

test('missing, wrong and oversized administrator credentials are all rejected without a session, and repeated failures are throttled', async t => {
  // maxLoginAttempts counts the *rejected* attempts already recorded before a
  // call is refused, so 3 lets exactly the three credential attempts below
  // through and throttles the 4th (createLoginLimiter.hit() allows exactly
  // maxAttempts calls and blocks the next one).
  const app = await fixture(t, { overrides: { maxLoginAttempts: 3 } });
  const noToken = await app.login('');
  assert.equal(noToken.status, 401);
  assert.match(noToken.text, /Invalid administrator token/);
  assert.equal(noToken.headers['set-cookie'], undefined);

  const wrong = await app.login('not-the-real-token');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const oversized = await app.login(`${UI_TOKEN}${'x'.repeat(600)}`);
  assert.equal(oversized.status, 401);

  const throttled = await app.login('another-wrong-guess');
  assert.equal(throttled.status, 429);
  assert.match(throttled.text, /Too many sign-in attempts/);

  // Bounded request body and content-type checks are independent of the
  // credential-throttling above: the rate limiter is keyed by remote address
  // and is hit before the body is even read, so re-using `app` here (already
  // over its attempt budget) would always yield 429 regardless of body shape.
  // A fresh fixture isolates these two checks from that throttled state.
  const bodyApp = await fixture(t);
  const huge = await bodyApp.request(`${BASE_PATH}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: `token=${'y'.repeat(5000)}`,
  });
  assert.match(huge.text, /Request is too large/);

  // Bounded/well-formed content type: a non-form submission is rejected too.
  const wrongType = await bodyApp.request(`${BASE_PATH}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ token: UI_TOKEN }),
  });
  assert.match(wrongType.text, /form submission is required/);
});

test('a sign-in attempt from any origin other than the configured public origin is rejected before the credential is even read', async t => {
  const app = await fixture(t);
  const wrongOrigin = await app.login(UI_TOKEN, { origin: 'https://evil.example.test' });
  assert.equal(wrongOrigin.status, 403);
  assert.match(wrongOrigin.text, /direct, same-origin sign-in request/);

  // `{ origin: undefined }` would not work here: login()'s destructured
  // default (`{ origin = ORIGIN } = {}`) applies to an explicit `undefined`
  // property value too, silently resupplying the correct Origin. `null` is
  // falsy but not `undefined`, so it defeats the default and truly omits
  // the header.
  const noOrigin = await app.login(UI_TOKEN, { origin: null });
  assert.equal(noOrigin.status, 403);

  // The correct token was supplied both times, yet no session was created.
  const stillNoCookie = await app.request(`${BASE_PATH}/`);
  assert.equal(stillNoCookie.status, 303);
  assert.equal(stillNoCookie.headers.location, `${BASE_PATH}/login`);
});

test('login concurrency and total session capacity are hard bounds, not just soft limits', async t => {
  const busy = await fixture(t, { overrides: { maxConcurrentLogins: 0 } });
  const rejected = await busy.login();
  assert.equal(rejected.status, 429);
  assert.match(rejected.text, /console is busy/);

  const bounded = await fixture(t, { overrides: { maxSessions: 2 } });
  assert.equal((await bounded.login()).status, 303);
  assert.equal((await bounded.login()).status, 303);
  const overCapacity = await bounded.login();
  assert.equal(overCapacity.status, 503);
  assert.match(overCapacity.text, /Too many active console sessions/);
});

test('a successful sign-in issues a scoped HttpOnly/Secure/SameSite=Strict cookie and never discloses the administrator token anywhere', async t => {
  const app = await fixture(t);
  const response = await app.login();
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `${BASE_PATH}/`);
  const rawCookie = response.headers['set-cookie'][0];
  const attributes = rawCookie.split('; ');
  assert.match(attributes[0], /^ds_session=[^;]+$/);
  assert.ok(attributes.includes('HttpOnly'));
  assert.ok(attributes.includes('Secure'));
  assert.ok(attributes.includes('SameSite=Strict'));
  assert.ok(attributes.includes(`Path=${BASE_PATH}`));
  assert.ok(attributes.includes('Max-Age=1800'), 'sessionMinutes=30 -> 1800 second Max-Age');

  const { cookie } = await app.loggedIn();
  const bodies = [
    (await app.request(`${BASE_PATH}/`, { headers: { Cookie: cookie } })).text,
    (await app.request(`${BASE_PATH}/api/deploy-service/jobs`, { headers: { Cookie: cookie } })).text,
    (await app.request(`${BASE_PATH}/api/deploy-service/settings`, { headers: { Cookie: cookie } })).text,
    (await app.request(`${BASE_PATH}/login`)).text,
  ];
  for (const body of bodies) assert.ok(!body.includes(UI_TOKEN), 'administrator token must never appear in a response body');

  // Never accepted via a query string, and the cookie is an opaque session id
  // (not the credential itself, or a derivative an attacker could compute).
  const viaQuery = await app.request(`${BASE_PATH}/api/deploy-service/jobs?token=${encodeURIComponent(UI_TOKEN)}`);
  assert.equal(viaQuery.status, 401);
  const forgedCookie = await app.request(`${BASE_PATH}/`, { headers: { Cookie: `ds_session=${UI_TOKEN}` } });
  assert.equal(forgedCookie.status, 303);
  assert.equal(forgedCookie.headers.location, `${BASE_PATH}/login`);
});

test('session state is bounded in time: an expired session is treated as signed out on both the console page and the JSON API', async t => {
  const app = await fixture(t, { overrides: { sessionMinutes: 5 } });
  const { cookie } = await app.loggedIn();
  const stillValid = await app.request(`${BASE_PATH}/`, { headers: { Cookie: cookie } });
  assert.equal(stillValid.status, 200);

  app.advance(5 * 60000 + 1000);
  const expiredPage = await app.request(`${BASE_PATH}/`, { headers: { Cookie: cookie } });
  assert.equal(expiredPage.status, 303);
  assert.equal(expiredPage.headers.location, `${BASE_PATH}/login`);
  const expiredApi = await app.request(`${BASE_PATH}/api/deploy-service/jobs`, { headers: { Cookie: cookie } });
  assert.equal(expiredApi.status, 401);
  assert.match(expiredApi.text, /Sign in to the deployment console/);
});

test('reading jobs, targets, settings and diagnostics needs only the session cookie; GETs require no Origin or CSRF token', async t => {
  const app = await fixture(t);
  const { cookie } = await app.loggedIn();
  for (const path of ['/jobs', '/targets', '/settings', '/diagnostics']) {
    const response = await app.request(`${BASE_PATH}/api/deploy-service${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${path} should not require Origin/CSRF for a read`);
  }
  const settings = (await app.request(`${BASE_PATH}/api/deploy-service/settings`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(Object.keys(settings.settings).sort(), ['defaultTimeoutSeconds', 'maxConcurrent', 'paused', 'retentionDays']);
});

test("mutating settings or a target requires the exact configured Origin and the session's own CSRF token", async t => {
  const app = await fixture(t);
  const { cookie, csrf } = await app.loggedIn();
  const put = (headers, body) => app.request(`${BASE_PATH}/api/deploy-service/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify(body),
  });

  const noOrigin = await put({ 'X-CSRF-Token': csrf }, { paused: true });
  assert.equal(noOrigin.status, 403);
  assert.match(noOrigin.text, /direct, same-origin request/);

  const wrongOrigin = await put({ Origin: 'https://evil.example.test', 'X-CSRF-Token': csrf }, { paused: true });
  assert.equal(wrongOrigin.status, 403);

  const noCsrf = await put({ Origin: ORIGIN }, { paused: true });
  assert.equal(noCsrf.status, 403);
  assert.match(noCsrf.text, /valid session CSRF token/);

  const wrongCsrf = await put({ Origin: ORIGIN, 'X-CSRF-Token': 'not-the-real-csrf-token' }, { paused: true });
  assert.equal(wrongCsrf.status, 403);

  const ok = await put({ Origin: ORIGIN, 'X-CSRF-Token': csrf }, { paused: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().settings.paused, true);
});

test('settings and target updates keep pause/timeout/concurrency/retention mutable but reject any other field, keeping execution identities and adapters immutable', async t => {
  const app = await fixture(t);
  const { cookie, csrf } = await app.loggedIn();
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf };

  const badSettings = await app.request(`${BASE_PATH}/api/deploy-service/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ paused: true, maxConcurrent: 2, defaultTimeoutSeconds: 600, retentionDays: 7, adapters: ['script'] }),
  });
  assert.equal(badSettings.status, 400);
  assert.match(badSettings.text, /Unknown service settings field: adapters/);

  const goodTarget = await app.request(`${BASE_PATH}/api/deploy-service/targets/ExampleApp/prod`, {
    method: 'PUT', headers, body: JSON.stringify({ paused: true, timeoutSeconds: 120 }),
  });
  assert.equal(goodTarget.status, 200);
  assert.equal(goodTarget.json().target.timeoutSeconds, 120);

  const badTarget = await app.request(`${BASE_PATH}/api/deploy-service/targets/ExampleApp/prod`, {
    method: 'PUT', headers, body: JSON.stringify({ paused: true, image: 'ghcr.io/example/evil:latest' }),
  });
  assert.equal(badTarget.status, 400);
  assert.match(badTarget.text, /Unknown target settings field: image/);
});

test('cancelling a production job needs explicit confirmation, a finished job cannot be cancelled twice, and an unknown job is a real 404', async t => {
  const app = await fixture(t);
  const { cookie, csrf } = await app.loggedIn();
  const headers = { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf };
  const cancel = (id, body) => app.request(`${BASE_PATH}/api/deploy-service/jobs/${id}/cancel`, { method: 'POST', headers, body: JSON.stringify(body) });

  const withoutConfirm = await cancel('job-prod-running-5', {});
  assert.equal(withoutConfirm.status, 400);
  assert.match(withoutConfirm.text, /Explicit production cancellation confirmation is required/);

  const withExtraField = await cancel('job-running-2', { force: true });
  assert.equal(withExtraField.status, 400);
  assert.match(withExtraField.text, /Unknown cancellation field: force/);

  const confirmed = await cancel('job-prod-running-5', { confirmProduction: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json().job.state, 'cancelled');

  const alreadyFinished = await cancel('job-succeeded-1', {});
  assert.equal(alreadyFinished.status, 409);
  assert.match(alreadyFinished.text, /already finished/);

  const unknown = await cancel('no-such-job', {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /Deployment job not found/);
});

test('the console API exposes no job-submission route; only the documented read/management endpoints exist', async t => {
  const app = await fixture(t);
  const { cookie, csrf } = await app.loggedIn();
  const submit = await app.request(`${BASE_PATH}/api/deploy-service/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ project: 'ExampleApp', target: 'prod' }),
  });
  assert.equal(submit.status, 404);
  assert.match(submit.text, /Deployment console endpoint not found/);
});

test('logout requires Origin and CSRF to actually end the session; a rejected attempt preserves the session behind an explicit 403 notice, never a success-shaped redirect, and a genuine logout still invalidates the cookie', async t => {
  const app = await fixture(t);

  const noSession = await app.request(`${BASE_PATH}/logout`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(noSession.status, 303, 'logout is idempotent, not a raw JSON error, for an absent session');
  assert.equal(noSession.headers.location, `${BASE_PATH}/login`);

  const { cookie, csrf } = await app.loggedIn();
  const wrongOrigin = await app.request(`${BASE_PATH}/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: 'https://evil.example.test' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  // A forged cross-site logout must never look like a success: no redirect
  // at all (so it can't land on the login page as if signed out), an
  // explicit 403 notice instead, and the session/cookie left completely
  // untouched.
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.location, undefined, 'not a redirect that could read as a completed sign-out');
  assert.equal(wrongOrigin.headers['set-cookie'], undefined, 'the session cookie is not touched');
  assert.match(wrongOrigin.headers['content-type'], /text\/html/, 'a real notice page, not a raw JSON error');
  assert.match(wrongOrigin.text, /Sign-out not completed/);
  assert.match(wrongOrigin.text, /still signed in/);
  assert.ok(!wrongOrigin.text.includes(csrf), 'the CSRF token itself is never echoed back');
  assert.ok(!wrongOrigin.text.includes(UI_TOKEN), 'the administrator token is never disclosed');
  assert.equal(wrongOrigin.headers['x-frame-options'], 'DENY');
  assert.equal(wrongOrigin.headers['cache-control'], 'no-store');
  assert.match(wrongOrigin.headers['content-security-policy'], /script-src 'nonce-/, 'still a nonce-scoped CSP, not a bare error page');

  const wrongCsrf = await app.request(`${BASE_PATH}/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: ORIGIN },
    body: new URLSearchParams({ csrf: 'not-the-real-token' }).toString(),
  });
  assert.equal(wrongCsrf.status, 403);
  assert.equal(wrongCsrf.headers.location, undefined);
  assert.equal(wrongCsrf.headers['set-cookie'], undefined);
  assert.match(wrongCsrf.text, /Sign-out not completed/);
  assert.ok(!wrongCsrf.text.includes(csrf), 'the CSRF token itself is never echoed back');

  // The session (and its original CSRF token) survived both rejected
  // attempts unchanged.
  const stillIn = await app.request(`${BASE_PATH}/`, { headers: { Cookie: cookie } });
  assert.equal(stillIn.status, 200);

  const success = await app.request(`${BASE_PATH}/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: ORIGIN },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.equal(success.status, 303);
  assert.equal(success.headers.location, `${BASE_PATH}/login`);
  const clearedCookie = success.headers['set-cookie'][0];
  assert.match(clearedCookie, /^ds_session=;/);
  assert.match(clearedCookie, /Max-Age=0/);

  const afterLogout = await app.request(`${BASE_PATH}/`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 303);
  assert.equal(afterLogout.headers.location, `${BASE_PATH}/login`, 'the old cookie authorizes nothing after logout');
});

test('the console session cookie never authorizes the machine /v1 API, and a valid machine bearer token never authorizes the console, even together; /health stays public', async t => {
  const app = await fixture(t);
  const { cookie } = await app.loggedIn();

  const cookieOnMachineApi = await app.request('/v1/jobs', { headers: { Cookie: cookie } });
  assert.equal(cookieOnMachineApi.status, 401);
  assert.match(cookieOnMachineApi.text, /Deployment service authentication required/);

  const bearerOnConsoleApi = await app.request(`${BASE_PATH}/api/deploy-service/jobs`, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  assert.equal(bearerOnConsoleApi.status, 401);
  assert.match(bearerOnConsoleApi.text, /Sign in to the deployment console/);

  const bothTogether = await app.request('/v1/jobs', { headers: { Cookie: cookie, Authorization: `Bearer ${API_TOKEN}` } });
  assert.equal(bothTogether.status, 200, 'the machine API still works via its own bearer, independent of the UI cookie');

  const rootHealth = await app.request('/health');
  assert.equal(rootHealth.status, 200);
  assert.deepEqual(Object.keys(rootHealth.json()).sort(), ['apiVersion', 'ok', 'service']);
  const scopedHealth = await app.request(`${BASE_PATH}/health`);
  assert.equal(scopedHealth.status, 200);
});

test("a path that only shares a text prefix with the console's base path is left untouched for the machine API's own handling", async t => {
  const app = await fixture(t);
  const response = await app.request(`${BASE_PATH}-extra/login`);
  // Not captured by the console router at all: falls through to the plain
  // machine-API bearer check (proven by service.js's own message), not the
  // console's login page or its 404.
  assert.equal(response.status, 401);
  assert.match(response.text, /Deployment service authentication required/);
});

test('rendered console and login pages carry a strict nonce-scoped CSP and no-store/frame/content-type headers, and untrusted-looking text is escaped, never interpreted as markup', async t => {
  const app = await fixture(t);
  const { page } = await app.loggedIn();
  for (const [name, value] of [
    ['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'],
    ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'],
  ]) assert.equal(page.headers[name], value);
  const nonce = page.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'a nonce must be present in the CSP');
  assert.match(page.headers['content-security-policy'], /style-src 'nonce-/);
  assert.ok(page.text.includes(`nonce="${nonce}"`), 'the CSP nonce must match the nonce actually applied to the inline tags');

  const login = await app.request(`${BASE_PATH}/login`);
  assert.equal(login.headers['x-frame-options'], 'DENY');
  assert.equal(login.headers['cache-control'], 'no-store');

  // A target/project whose name looks like markup (bypassing the real
  // projectName() validator on purpose, at the fake-engine layer only) must
  // still come out escaped through the reused rendering path.
  const evilEngine = new FakeEngine();
  evilEngine.targets = { ...evilEngine.targets, '<img src=x onerror=alert(1)>/dev': { paused: false, timeoutSeconds: 600 } };
  const evilApp = await fixture(t, { engine: evilEngine });
  const { page: evilPage } = await evilApp.loggedIn();
  assert.ok(!evilPage.text.includes('<img src=x onerror=alert(1)>'));
  assert.match(evilPage.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('renderStandaloneLogin escapes an error message and never inlines the console base path unescaped', () => {
  const html = renderStandaloneLogin({ basePath: BASE_PATH, error: '<script>alert(1)</script>', nonce: 'abc123' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /nonce="abc123"/);
  assert.match(html, /action="\/deploy-service\/login"/);
});
