import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  createDeploymentApi, createSubmissionFollower, deploymentPageBrowser, renderDeploymentPage,
  renderDeploymentSettings, deploymentSettingsScript,
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
  window.location = { search }; window.history = { replaceState() {} };
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
    ...sandbox, sandbox, requests, timers, confirms, el: id => elements.get(id),
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
  const html = renderDeploymentPage({ base: '/pw', admin: false, projects: [{ name: 'ExampleApp' }] });
  const e = environment(html, { search: options.search ?? '?job=job-fixture-001', respond: async request => {
    if (fail) throw new Error('Synthetic connection failure');
    const route = request.url.replace('/pw/api/deploy-service', '');
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
  vm.runInNewContext(`(${deploymentPageBrowser.toString()})(${JSON.stringify({ base: '/pw', admin: false, terminalStates: [...TERMINAL_STATES] })}, ${createDeploymentApi.toString()});`, e.sandbox);
  await flush();
  return { ...e, get job() { return job; }, set job(value) { job = value; }, set fail(value) { fail = value; } };
}

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

test('UI: deployment follower does not retry a submission or silently claim success on connection loss', async () => {
  const e = environment('<div id="card"></div><div id="output"></div>', { respond: async () => { throw new Error('Synthetic offline service'); } });
  const follow = createSubmissionFollower([...TERMINAL_STATES], e.sandbox);
  const promise = follow({ ok: true, backend: 'external', queued: true, job: jobFixture() }, { base: '/pw', card: e.el('card'), output: e.el('output') });
  const rejected = assert.rejects(promise, /job may still be running/);
  await e.tick(); await rejected;
  assert.equal(e.requests.length, 1);
  assert.equal(e.timers.size, 0);
  assert.equal(e.el('card').children[0].className, 'deploy-service-job-link');
});

test('UI: public API client refuses a successful HTML login redirect as service health', async () => {
  const api = createDeploymentApi('/pw', { fetch: async () => ({ ok: true, redirected: true, headers: { get: () => 'text/html' } }) });
  await assert.rejects(api('/health'), /did not return deployment JSON/);
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
