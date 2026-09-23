import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  createDeploymentApi, createSubmissionFollower, deploymentPageBrowser, renderDeploymentPage,
  renderDeploymentSettings, deploymentSettingsScript, renderStandaloneLogin,
} from '../app/deployment/ui.js';
import { TERMINAL_STATES } from '../app/deployment/protocol.js';

class Element {
  constructor(document, tag = 'div') {
    this.document = document; this.tagName = tag; this.children = []; this.listeners = new Map();
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.className = '';
    this._text = ''; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 100;
  }
  set innerHTML(_value) { throw new Error('UI tried to render untrusted HTML'); }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children = []; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  async emit(name, event = {}) {
    for (const handler of this.listeners.get(name) || []) await handler({ target: this, currentTarget: this, preventDefault() {}, ...event });
  }
  async click() { if (!this.disabled) await this.emit('click'); }
  querySelector(selector) { return this.children.find(child => selector === `.${child.className}`) || null; }
  focus() { this.document.activeElement = this; }
}

const jobFixture = () => ({ id: 'job-fixture-001', project: 'ExampleApp', target: 'prod', state: 'running', phase: 'building',
  adapter: 'script', revision: 'a'.repeat(40), createdAt: '2026-09-15T12:00:00Z', startedAt: '2026-09-15T12:00:01Z' });
const flush = () => new Promise(resolve => setImmediate(resolve));

function environment(html, { search = '', respond } = {}) {
  const document = new Element(null); document.document = document;
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element(document)]));
  document.createElement = tag => new Element(document, tag);
  document.getElementById = id => elements.get(id) || null;
  document.activeElement = new Element(document, 'input');
  const window = new Element(document);
  const history = [];
  window.location = { search }; window.history = { replaceState(_state, _title, url) { history.push(url); } };
  const confirms = []; let confirmAnswer = true;
  window.confirm = message => { confirms.push(message); return confirmAnswer; };
  const requests = [], timers = new Map(); let timerId = 0;
  const sandbox = {
    document, window, URLSearchParams, AbortController, console,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const value = await respond(request);
      return { status: value.status || 200, ok: !value.status || value.status < 400, redirected: !!value.redirected,
        headers: { get: () => value.contentType || 'application/json' },
        json: async () => value.body || value };
    },
  };
  return {
    ...sandbox, sandbox, requests, timers, confirms, history, el: id => elements.get(id),
    set confirmAnswer(value) { confirmAnswer = value; },
    async tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'expected a scheduled refresh');
      timers.delete(entry[0]); await entry[1].callback(); await flush();
    },
  };
}

async function page(options = {}) {
  let job = jobFixture(), fail = false;
  const base = options.base || '/pw';
  const standalone = options.standalone ? { nonce: 'fixture-nonce', csrfToken: 'fixture-csrf', logoutPath: `${base}/logout` } : undefined;
  const html = renderDeploymentPage({ base, admin: false, projects: [{ name: 'ExampleApp' }], standalone });
  const e = environment(html, { search: options.search ?? '?job=job-fixture-001', respond: async request => {
    if (fail) throw new Error('Synthetic connection failure');
    const route = request.url.replace(`${base}/api/deploy-service`, '');
    if (route.startsWith('/jobs?')) return { ok: true, jobs: [job] };
    if (route.endsWith('/cancel')) { job = { ...job, state: 'cancelled', phase: 'cancelled', finishedAt: '2026-09-15T12:00:02Z' }; return { ok: true, job }; }
    if (route.includes('/log?')) {
      const after = Number(new URLSearchParams(route.split('?')[1]).get('after') || 0);
      const entries = [
        { seq: 1, at: '2026-09-15T12:00:01Z', phase: 'building', message: '<img src=x onerror=alert(1)>' },
        { seq: 3, at: '2026-09-15T12:00:02Z', phase: job.state },
      ];
      return { ok: true, events: entries.filter(event => event.seq > after),
        live: after < 2 ? [{ seq: 2, at: '2026-09-15T12:00:01Z', text: '<script>malicious()</script>\n' }] : [], nextSeq: 3 };
    }
    if (route === '/jobs/job-fixture-001') return { ok: true, job };
    throw new Error(`Unexpected UI request ${route}`);
  } });
  e.el('ds-follow').checked = true;
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the rendered page must contain its browser wiring');
  vm.runInNewContext(script, e.sandbox);
  await flush();
  return { ...e, get job() { return job; }, set job(value) { job = value; }, set fail(value) { fail = value; } };
}

test('UI: standalone job links and browser history use the actual standalone page path', async () => {
  const ui = await page({ base: '/deploy-service', standalone: true });
  const link = ui.el('ds-jobs').children[0].children[0].children[0];
  assert.equal(link.href, '/deploy-service?job=job-fixture-001');
  await link.click();
  await flush();
  assert.equal(ui.history.at(-1), link.href);
  let prevented = false;
  const count = ui.history.length;
  await link.emit('click', { ctrlKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'modified clicks must retain native new-tab navigation');
  assert.equal(ui.history.length, count);
});

test('UI: a redirected target selector applies to the first jobs request', async () => {
  const ui = await page({ search: '?project=ExampleApp&target=dev' });
  assert.equal(ui.el('ds-target').value, 'dev');
  const first = ui.requests.find(request => request.url.includes('/jobs?'));
  const filter = new URLSearchParams(first.url.split('?')[1]);
  assert.equal(filter.get('project'), 'ExampleApp');
  assert.equal(filter.get('target'), 'dev');
});

test('UI: renders labels, project/target/state filters, pinned revisions, accessible status and memory-only logs', () => {
  const html = renderDeploymentPage({ base: '/pw', admin: true, projects: [{ name: '<script>unsafe()</script>' }] });
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<option value="<script>'));
  for (const id of ['ds-project', 'ds-target', 'ds-state', 'ds-concurrency', 'ds-timeout', 'ds-retention']) assert.match(html, new RegExp(`for="${id}"`));
  assert.match(html, /Pinned revision/);
  assert.match(html, /id="ds-status" role="status" aria-live="polite"/);
  assert.match(html, /<pre id="ds-live"[^>]+aria-live="off"/);
  assert.match(html, /No target activity yet/);
  assert.match(html, /without enrollment or privilege setup/);
  assert.ok(!renderDeploymentPage({ base: '/pw', admin: false, projects: [] }).includes('id="ds-service-settings"'));
});

test('UI: operational events and malicious live output are text, with no HTML interpretation or focus theft', async () => {
  const ui = await page();
  assert.match(ui.el('ds-live').textContent, /<script>malicious/);
  assert.ok(ui.el('ds-history').children.some(child => child.textContent.includes('<img src=x')));
  assert.equal(ui.el('ds-live').scrollTop, 0, 'polling must not pull a reader down from old log text');
  assert.equal(ui.document.activeElement.tagName, 'input');
  assert.equal(ui.el('ds-jobs').children.length, 1);
  assert.ok(ui.el('ds-job-meta').textContent.includes('a'.repeat(40)));
  assert.ok(ui.requests.every(request => request.options.redirect === 'error' && request.options.cache === 'no-store'));
  await ui.el('ds-follow').emit('change');
  assert.equal(ui.el('ds-live').scrollTop, ui.el('ds-live').scrollHeight);
  assert.equal(ui.document.activeElement.tagName, 'input');
});

test('UI: polling stops on page hide, resumes when visible, and stops at a terminal job outcome', async () => {
  const ui = await page();
  assert.equal(ui.timers.size, 1);
  ui.document.hidden = true; await ui.document.emit('visibilitychange');
  assert.equal(ui.timers.size, 0);
  const count = ui.requests.length;
  await flush(); assert.equal(ui.requests.length, count);
  ui.document.hidden = false; await ui.document.emit('visibilitychange'); await flush();
  assert.ok(ui.requests.length > count);
  ui.job = { ...ui.job, state: 'succeeded', phase: 'succeeded', version: '1.2.3', finishedAt: '2026-09-15T12:00:02Z' };
  await ui.tick();
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.el('ds-cancel').disabled, true);
  assert.match(ui.el('ds-status').textContent, /refresh has stopped/);
  await ui.window.emit('pagehide');
  assert.equal(ui.timers.size, 0);
});

test('UI: connection errors stop polling; reconnecting is explicit and never resubmits a job', async () => {
  const ui = await page();
  ui.fail = true; await ui.tick();
  assert.equal(ui.timers.size, 0);
  assert.match(ui.el('ds-status').textContent, /Polling stopped/);
  assert.ok(ui.requests.every(request => !request.options.method || request.options.method === 'GET'));
  ui.fail = false; await ui.el('ds-refresh').click(); await flush();
  assert.equal(ui.timers.size, 1);
});

test('UI: cancelling keeps outcome polling active without offering a duplicate cancellation', async () => {
  const ui = await page();
  ui.job = { ...ui.job, state: 'cancelling', phase: 'cancelling' };
  await ui.tick();
  assert.equal(ui.el('ds-cancel').disabled, true);
  assert.equal(ui.timers.size, 1);
  assert.match(ui.el('ds-status').textContent, /cancelling/);
  await ui.el('ds-cancel').click();
  assert.ok(!ui.requests.some(request => request.options.method === 'POST'));
  assert.match(renderDeploymentPage({ base: '/pw', admin: false, projects: [] }), /value="cancelling"/);
});

test('UI: cancellation is human-confirmed, production is explicit, and terminal jobs disable the action', async () => {
  const ui = await page();
  // The real browser confirmation is invoked only by this button click.
  ui.window.confirm = message => { ui.confirms.push(message); return false; };
  await ui.el('ds-cancel').click();
  assert.ok(!ui.requests.some(request => request.options.method === 'POST'));
  ui.window.confirm = message => { ui.confirms.push(message); return true; };
  await ui.el('ds-cancel').click(); await flush();
  const cancel = ui.requests.find(request => request.options.method === 'POST');
  assert.deepEqual(cancel.body, { confirmProduction: true });
  assert.ok(ui.confirms.every(message => message.includes('PRODUCTION') && message.includes('ExampleApp')));
  assert.equal(ui.el('ds-cancel').disabled, true);
  assert.equal(ui.timers.size, 0);
});

test('UI: existing Deploy response follower keeps a durable link, polls only GET, and returns host outcome', async () => {
  const e = environment('<div id="card"></div><div id="output"></div>', { respond: async () => ({ ok: true,
    job: { ...jobFixture(), state: 'succeeded', phase: 'succeeded', version: '1.2.3', finishedAt: '2026-09-15T12:00:03Z' } }) });
  const follow = createSubmissionFollower([...TERMINAL_STATES], e.sandbox);
  const promise = follow({ ok: true, backend: 'external', queued: true, job: jobFixture() }, { base: '/pw', card: e.el('card'), output: e.el('output') });
  assert.match(e.el('card').children[0].href, /^\/pw\/deploy-service\?job=/);
  await e.tick();
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.queued, false);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.duration, '2.0');
  assert.equal(e.requests.length, 1);
  assert.equal(e.requests[0].options.method, undefined);
  assert.equal(e.timers.size, 0);
});

test('UI: deployment follower keeps a connection-lost host job queued without retrying or claiming success', async () => {
  const e = environment('<div id="card"></div><div id="output"></div>', { respond: async () => { throw new Error('Synthetic offline service'); } });
  const follow = createSubmissionFollower([...TERMINAL_STATES], e.sandbox);
  const promise = follow({ ok: true, backend: 'external', queued: true, job: jobFixture() }, { base: '/pw', card: e.el('card'), output: e.el('output') });
  await e.tick(); const result = await promise;
  assert.equal(result.queued, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.job.state, 'running');
  assert.match(result.error, /job may still be running/);
  assert.equal(e.requests.length, 1);
  assert.equal(e.timers.size, 0);
  assert.equal(e.el('card').children[0].className, 'deploy-service-job-link');
});

test('UI: public API client refuses a successful HTML login redirect as service health', async () => {
  const api = createDeploymentApi('/pw', { fetch: async () => ({ ok: true, redirected: true, headers: { get: () => 'text/html' } }) });
  await assert.rejects(api('/health'), /did not return deployment JSON/);
});

test('UI: createDeploymentApi attaches the session CSRF token header only when a standalone ds-csrf-token meta tag is present, never on ordinary PW pages', async () => {
  let seenHeaders;
  const fetchStub = async (_url, options) => {
    seenHeaders = options.headers;
    return { ok: true, redirected: false, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  // Standalone console page: renderDeploymentPage's `standalone` option puts a
  // ds-csrf-token meta tag in <head>; the browser API picks it up as a header.
  const withCsrf = createDeploymentApi('/deploy-service', {
    fetch: fetchStub,
    document: { querySelector: selector => (selector === 'meta[name="ds-csrf-token"]' ? { content: 'csrf-abc' } : null) },
  });
  await withCsrf('/jobs');
  assert.equal(seenHeaders['X-CSRF-Token'], 'csrf-abc');

  // Ordinary PW page: no such meta tag ever exists there, so the request
  // shape is exactly as before this change -- no CSRF header is added.
  const withoutMeta = createDeploymentApi('/pw', { fetch: fetchStub, document: { querySelector: () => null } });
  await withoutMeta('/jobs');
  assert.ok(!('X-CSRF-Token' in seenHeaders));

  // No `document` at all (e.g. a non-browser environment) must not throw.
  const withoutDocument = createDeploymentApi('/pw', { fetch: fetchStub });
  await withoutDocument('/jobs');
  assert.ok(!('X-CSRF-Token' in seenHeaders));
});

test('UI: renderDeploymentSettings exposes an optional, empty-by-default standalone console URL field that never carries a value server-side', () => {
  const html = renderDeploymentSettings('/pw');
  assert.match(html, /<label for="ds-console-url">Standalone console URL \(optional\)<\/label>/);
  assert.match(html, /<input id="ds-console-url" type="text" maxlength="2048" autocomplete="off"/);
  assert.doesNotMatch(html, /id="ds-console-url"[^>]*\svalue=/, 'must never inline a saved URL (let alone a token) into static markup');
});

test('UI: Settings round-trips the optional standalone console URL alongside the existing backend fields, without ever touching a token, and never sends it on a connection test', async () => {
  const html = renderDeploymentSettings('/pw');
  const e = environment(html, { respond: async request => {
    if (request.url.endsWith('/connection/test')) return { ok: true, health: { ready: true } };
    if (request.options.method === 'PUT') {
      return { ok: true, deployment: { backend: request.body.backend, endpoint: request.body.endpoint, hasCredential: true, consoleUrl: request.body.consoleUrl } };
    }
    return { ok: true, deployment: { backend: 'local', endpoint: '', hasCredential: false, consoleUrl: 'https://deploy.example.test/deploy-service' } };
  } });
  vm.runInNewContext(deploymentSettingsScript('/pw').replace(/^<script>|<\/script>$/g, ''), e.sandbox);
  await flush();
  // A previously saved console URL is reflected on load like any other field.
  assert.equal(e.el('ds-console-url').value, 'https://deploy.example.test/deploy-service');

  // Testing a draft connection must never send the console URL: it is a
  // settings-save-only field, not part of the connection-probe payload.
  e.el('ds-endpoint').value = 'https://draft.example.test';
  await e.el('ds-test-connection').click();
  const tested = e.requests.at(-1);
  assert.deepEqual(Object.keys(tested.body).sort(), ['endpoint', 'token']);
  assert.ok(!('consoleUrl' in tested.body));

  e.el('ds-backend').value = 'external';
  e.el('ds-endpoint').value = 'https://deploy.example.test';
  e.el('ds-console-url').value = 'https://console.example.test/deploy-service';
  await e.el('ds-backend-form').emit('submit');
  const saved = e.requests.at(-1);
  assert.equal(saved.body.consoleUrl, 'https://console.example.test/deploy-service');
  assert.equal(e.el('ds-console-url').value, 'https://console.example.test/deploy-service');
  assert.ok(!e.el('ds-backend-status').textContent.includes('http'), 'status text must not echo back the URL either');
});

test('UI: renderDeploymentSettings without a saved console URL stays backward compatible (empty field, existing behavior otherwise unaffected)', async () => {
  const html = renderDeploymentSettings('/pw');
  const e = environment(html, { respond: async () => ({ ok: true, deployment: { backend: 'local', endpoint: '', hasCredential: false } }) });
  vm.runInNewContext(deploymentSettingsScript('/pw').replace(/^<script>|<\/script>$/g, ''), e.sandbox);
  await flush();
  assert.equal(e.el('ds-console-url').value, '', 'an absent consoleUrl (old saved settings) must render as empty, not "undefined"');
});

test('UI: renderDeploymentSettings includes a direct link to the PW-hosted connection-only page that always stays inside Project Workbench, even when jobs/service controls redirect to a standalone console', () => {
  const html = renderDeploymentSettings('/pw');
  assert.match(html, /<a class="button secondary" href="\/pw\/deploy-service">Jobs and service controls<\/a>/, 'existing link is unchanged');
  assert.match(html, /<a class="button secondary" href="\/pw\/deploy-service\/connection">Deployment connection settings<\/a>/);
});

test('UI: renderDeploymentPage keeps its existing PW navigation, with no CSRF meta tag or CSP nonce, when standalone is omitted', () => {
  const html = renderDeploymentPage({ base: '/pw', admin: true, projects: [] });
  assert.match(html, /<a href="\/pw\/">Dashboard<\/a>/);
  assert.match(html, /<a href="\/pw\/deploy">Deploy projects<\/a>/);
  assert.match(html, /<a href="\/pw\/settings#deployment">Deployment settings<\/a>/);
  // (createDeploymentApi's serialized source, always inlined for the browser
  // API, mentions the meta tag's selector by name -- check for an actual
  // rendered <meta> tag, not just that substring anywhere on the page.)
  assert.ok(!html.includes('<meta name="ds-csrf-token"'));
  assert.ok(!html.includes('class="ds-brand"'));
  assert.ok(!html.includes('<form class="ds-logout"'));
  assert.doesNotMatch(html, /<style nonce=/);
  assert.doesNotMatch(html, /<script nonce=/);
});

test('UI: renderDeploymentPage renders standalone navigation, a CSRF meta tag and matching CSP nonces (all escaped) when standalone is supplied', () => {
  const html = renderDeploymentPage({
    base: '/deploy-service', admin: true, projects: [],
    standalone: { nonce: 'n0nce"<script>', csrfToken: 'csrf"<>&value', logoutPath: '/deploy-service/logout' },
  });
  assert.match(html, /<meta name="ds-csrf-token" content="csrf&quot;&lt;&gt;&amp;value">/);
  assert.match(html, /<span class="ds-brand">Deployment console<\/span>/);
  assert.match(html, /<form class="ds-logout" method="post" action="\/deploy-service\/logout">/);
  assert.match(html, /<input type="hidden" name="csrf" value="csrf&quot;&lt;&gt;&amp;value">/);
  assert.ok(!html.includes('>Dashboard<'), 'standalone console has no PW dashboard link');
  assert.ok(!html.includes('>Deploy projects<'));
  const escapedNonce = 'n0nce&quot;&lt;script&gt;';
  assert.ok(html.includes(`<style nonce="${escapedNonce}">`));
  assert.ok(html.includes(`<script nonce="${escapedNonce}">(`));
});

test('UI: renderDeploymentPage supports a connectionOnly option that renders just the PW connection settings (its own heading, the exact settings markup/script, and a Dashboard link), never the host job list or admin controls', () => {
  // Exact call shape the parent's admin route uses: renderDeploymentPage({
  // base, admin: true, connectionOnly: true }).
  const html = renderDeploymentPage({ base: '/pw', admin: true, connectionOnly: true });
  // Exact contract the parent's admin route test asserts on: a heading
  // matching /Deployment connection/i, with nothing that looks like a
  // redirect (no meta-refresh/Location, just a rendered page).
  assert.match(html, /<h1>Deployment connection settings<\/h1>/);
  assert.match(html, /Deployment connection/i);
  assert.ok(!/<meta[^>]+http-equiv="refresh"/i.test(html));
  // Reuses the exact same connection settings markup/script as the Settings
  // tab verbatim, rather than reimplementing it.
  assert.ok(html.includes(renderDeploymentSettings('/pw')));
  assert.ok(html.includes(deploymentSettingsScript('/pw')));
  // No host job list, filters, detail panel or admin service-policy controls.
  assert.ok(!html.includes('id="ds-filters"'));
  assert.ok(!html.includes('id="ds-jobs"'));
  assert.ok(!html.includes('id="ds-detail"'));
  assert.ok(!html.includes('Service controls (admin)'));
  assert.ok(!html.includes('id="ds-concurrency"'));
  // Nor the host job-list page's own bootstrap script/data (terminalStates
  // is only ever passed into that script's config, never used here).
  assert.ok(!html.includes('terminalStates'));
  assert.ok(!html.includes(deploymentPageBrowser.toString()));
  // A same-origin, non-secret way back into PW; the standalone console
  // itself never infers or depends on any PW URL.
  assert.match(html, /<a href="\/pw\/">Dashboard<\/a>/);
});

test("UI: renderDeploymentPage's connectionOnly option escapes its base path and ignores admin/projects/standalone entirely (so projects need not even be supplied)", () => {
  const html = renderDeploymentPage({
    base: '/pw"<x>', connectionOnly: true, admin: true,
    standalone: { nonce: 'n', csrfToken: 'c', logoutPath: '/x' },
  });
  assert.match(html, /<a href="\/pw&quot;&lt;x&gt;\/">Dashboard<\/a>/, 'base path must be escaped, never inlined raw');
  assert.ok(!html.includes('Service controls (admin)'), 'admin must be ignored in connectionOnly mode');
  assert.ok(!html.includes('class="ds-brand"'), 'standalone nav must be ignored in connectionOnly mode');
  assert.ok(!html.includes('<form class="ds-logout"'));
});

test('UI: renderStandaloneLogin renders a plain sign-in form with no error banner when there is nothing to report', () => {
  const html = renderStandaloneLogin({ basePath: '/deploy-service', nonce: 'abc123' });
  // (deploymentUiCss unconditionally styles [role="alert"], so check for the
  // actual rendered element, not just that attribute substring anywhere.)
  assert.ok(!html.includes('<p role="alert">'), 'no error means no alert region at all, not an empty one');
  assert.match(html, /action="\/deploy-service\/login"/);
  assert.match(html, /name="token" type="password"/);
  assert.match(html, /Project Workbench does not serve it, authenticate it, or ever receive this token/);
});

test('UI: Settings supports local/external selection and draft diagnostics without readback of a saved token', async () => {
  const html = renderDeploymentSettings('/pw');
  assert.match(html, /CURRENT \/ LOCAL/);
  assert.match(html, /EXTERNAL deployment service/);
  assert.match(html, /id="ds-token" type="password"/);
  assert.ok(!/id="ds-token"[^>]*\bvalue=/.test(html));
  const e = environment(html, { respond: async request => {
    if (request.url.endsWith('/connection/test')) return { ok: true, health: { ready: false } };
    return { ok: true, deployment: { backend: 'local', endpoint: 'https://deploy.example.test', hasCredential: true } };
  } });
  vm.runInNewContext(deploymentSettingsScript('/pw').replace(/^<script>|<\/script>$/g, ''), e.sandbox);
  await flush();
  assert.equal(e.el('ds-token').value, '');
  assert.match(e.el('ds-credential-state').textContent, /never returned/);
  e.el('ds-endpoint').value = 'https://draft.example.test';
  await e.el('ds-test-connection').click();
  assert.equal(e.requests.at(-1).body.endpoint, 'https://draft.example.test');
  assert.match(e.el('ds-backend-status').textContent, /not ready/);
  e.el('ds-token').value = 'synthetic-entered-credential';
  await e.el('ds-backend-form').emit('submit');
  assert.equal(e.el('ds-token').value, '');
  assert.ok(!e.el('ds-backend-status').textContent.includes('synthetic-entered-credential'));
});
