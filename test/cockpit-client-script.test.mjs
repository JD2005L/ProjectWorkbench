// REGRESSION (2026-09-14): the cockpit's tab strip and its "+" control disappeared on the live instance.
// a8ae4d5 and the commits after it wrote typographic quotes (U+2018/U+2019, around POST and Content-Type) as string
// delimiters inside spawnTab. app/server.js emits that function verbatim into the cockpit page's
// inline <script>, so the SERVER parsed perfectly and every test stayed green while the browser threw
// a SyntaxError on the whole script and never reached refreshTabs(): no tab badges, no "+".
//
// The defect class is "client JavaScript the server generates does not compile", so this renders the
// real page from a real process and compiles every inline script, then pins spawnTab's request and
// error contract with a fake fetch. test/cockpit-tabs-browser.test.mjs drives the rendered UI in a
// real browser where one is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { functionSource, inlineScripts, withCockpit } from './cockpit-instance-fixture.mjs';

const TYPOGRAPHIC_QUOTES = /[\u2018\u2019\u201C\u201D]/;

async function renderCockpit() {
  let html;
  await withCockpit(async ({ base, name }) => {
    const res = await fetch(`${base}/term/${encodeURIComponent(name)}/`);
    assert.equal(res.status, 200, 'the cockpit must render');
    html = await res.text();
  });
  return html;
}

test('REGRESSION: every inline script on the rendered cockpit page compiles', { timeout: 60000 }, async () => {
  const html = await renderCockpit();
  const scripts = inlineScripts(html);
  // Guard against a vacuous pass: the tab code must actually be among what was compiled.
  const tabScript = scripts.find((s) => s.includes('async function spawnTab(') && s.includes('function renderTabs('));
  assert.ok(tabScript, 'the tab-strip script must be inline on the cockpit page');
  scripts.forEach((code, i) => {
    try {
      new vm.Script(code, { filename: `cockpit-inline-script-${i}.js` });
    } catch (err) {
      const at = /:(\d+)/.exec(String(err.stack))?.[1];
      assert.fail(`inline script #${i} on the cockpit does not compile: ${err.message}${at ? ` (line ${at})` : ''}`);
    }
  });
  assert.doesNotMatch(functionSource(tabScript, 'async function spawnTab('), TYPOGRAPHIC_QUOTES,
    'spawnTab must use ASCII string delimiters');
});

test('spawnTab posts the tab, refreshes on success, and surfaces a failure without refreshing', { timeout: 60000 }, async () => {
  const html = await renderCockpit();
  const tabScript = inlineScripts(html).find((s) => s.includes('async function spawnTab('));
  const src = functionSource(tabScript, 'async function spawnTab(');
  const make = new Function('tabsBase', 'fetch', 'alert', 'refreshTabs',
    `let editAfterRender = 'unset'; let lastTabsKey = 'stale'; ${src};
     return { spawnTab, state: () => ({ editAfterRender, lastTabsKey }) };`);

  const harness = (response) => {
    const calls = { fetch: [], alerts: [], refreshed: 0 };
    const h = make('/api/term/demo/windows',
      async (url, init) => { calls.fetch.push({ url, init }); return response; },
      (msg) => calls.alerts.push(msg),
      () => { calls.refreshed++; });
    return { ...h, calls };
  };

  const ok = harness({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await ok.spawnTab('', '');
  assert.equal(ok.calls.fetch.length, 1);
  assert.equal(ok.calls.fetch[0].url, '/api/term/demo/windows');
  assert.equal(ok.calls.fetch[0].init.method, 'POST');
  assert.deepEqual(ok.calls.fetch[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(ok.calls.fetch[0].init.body), { name: 'new task', cmd: '' });
  assert.deepEqual({ alerts: ok.calls.alerts, refreshed: ok.calls.refreshed }, { alerts: [], refreshed: 1 });
  assert.deepEqual(ok.state(), { editAfterRender: true, lastTabsKey: '' }, 'a blank tab is opened for naming');

  const named = harness({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await named.spawnTab('build', 'npm test');
  assert.deepEqual(JSON.parse(named.calls.fetch[0].init.body), { name: 'build', cmd: 'npm test' });
  assert.equal(named.state().editAfterRender, false);

  const refused = harness({ ok: false, status: 409, json: async () => ({ ok: false, error: 'window exists' }) });
  await refused.spawnTab('build', '');
  assert.deepEqual(refused.calls.alerts, ['Tab error: window exists']);
  assert.equal(refused.calls.refreshed, 0, 'a failed spawn must not pretend to have added a tab');
  assert.deepEqual(refused.state(), { editAfterRender: false, lastTabsKey: 'stale' });

  const gateway = harness({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } });
  await gateway.spawnTab('', '');
  assert.deepEqual(gateway.calls.alerts, ['Tab error: HTTP 502']);
  assert.equal(gateway.calls.refreshed, 0);
});
