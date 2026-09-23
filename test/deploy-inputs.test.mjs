import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeployManifest } from '../app/deploy-manifest.js';
import { addIdentity, manifestWorkspace, writeJson } from './deploy-manifest-fixtures.mjs';
import { deployRouteHarness, serverTemplate } from './deploy-manifest-harness.mjs';
import { loadDeployBrowser } from './deploy-inputs-harness.mjs';

const surfaces = ['deployScript', 'deployModalScript'];
const posts = browser => browser.requests.filter(request => request.method === 'POST');

for (const surface of surfaces) {
 test(`${surface}: script-only prod needs no selections but still confirms, validates, and records the deployment`, async t => {
  const { root, document, save } = manifestWorkspace(t);
  document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
  save();
  const slot = await resolveDeployManifest(root, 'prod');
  const server = deployRouteHarness(root, { config: {} });
  const browser = await loadDeployBrowser(surface, slot, {
   respond: async request => request.method === 'GET'
    ? (await server.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body
    : (await server.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'prod' }, body: request.body })).body,
  });
  assert.equal(browser.card.selects.length, 0);
  assert.equal(browser.card.button.disabled, false);
  assert.match(browser.card.notice.textContent, /No input selections required/);
  assert.equal(posts(browser).length, 0, 'opening a script-only slot is still read-only');
  await browser.click();
  assert.deepEqual(posts(browser)[0].body, { inputs: {}, manifestRevision: slot.revision });
  assert.equal(posts(browser)[0].url, '/pw/api/deploy/demo/prod');
  assert.equal(browser.confirms.length, 1);
  assert.match(browser.confirms[0], /Deploy MCP server/);
  assert.equal(browser.prompts.length, 0);
  assert.match(browser.card.querySelector('.deploy-status').textContent, /SUCCESS/);
  assert.match(browser.card.output.textContent, /deployed-ok/);
  assert.equal(browser.card.button.disabled, false);
  assert.deepEqual(server.history[0].inputs, {});
  assert.equal(server.history[0].target, 'prod');
  delete document.slots.prod;
  save();
  await browser.click();
  assert.match(browser.card.output.textContent, /missing|disappeared/);
  assert.equal(browser.card.button.disabled, true);
  assert.equal(server.executions.length, 1, 'removed script-only contract cannot fall back to a saved script');
 });

 test(`${surface}: both required selects start empty; selected versions and first release are explicit`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const browser = await loadDeployBrowser(surface, slot);
  assert.deepEqual(browser.card.selects.map(select => select.value), ['', '']);
  assert.equal(browser.card.button.disabled, true);
  await browser.click();
  assert.equal(posts(browser).length, 0);
  await browser.choose('identity', 'alpha');
  assert.equal(browser.card.current.textContent, '2.3.4');
  assert.equal(browser.card.button.disabled, true);
  await browser.choose('bump', 'minor');
  assert.equal(browser.card.target.textContent, '2.4.0');
  assert.equal(browser.card.button.disabled, false);
  await browser.choose('identity', 'bravo');
  assert.match(browser.card.current.textContent, /Not published.*1\.2\.0/);
  assert.equal(browser.card.target.textContent, '1.2.0');
  await browser.choose('bump', 'major');
  assert.equal(browser.card.target.textContent, '1.2.0');
  await browser.choose('identity', '');
  assert.equal(browser.card.button.disabled, true);
  assert.match(browser.card.current.textContent, /Choose Visual identity/);
 });

 test(`${surface}: actual client and route agree on payload, versions, history, and no reauth prompt with valid saved password`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const server = deployRouteHarness(root, {
   config: { demo: { dev: { script: 'old', reauth: true } } },
   storedUser: { deployPassword: 'sealed:good-password' },
   onExec: async () => {
    writeJson(root, ['releases', 'alpha', 'index.json'], { latest: '2.4.0' });
    return { stdout: 'published selected identity', stderr: '' };
   },
  });
  const browser = await loadDeployBrowser(surface, slot, {
   respond: async request => request.method === 'GET'
    ? (await server.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body
    : (await server.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' }, body: request.body })).body,
  });
  await browser.choose('identity', 'alpha');
  await browser.choose('bump', 'minor');
  await browser.click();
  assert.deepEqual(posts(browser)[0].body, { inputs: { identity: 'alpha', bump: 'minor' }, manifestRevision: slot.revision });
  assert.equal(posts(browser)[0].url, '/pw/api/deploy/demo/dev');
  assert.equal(browser.prompts.length, 0);
  assert.equal(browser.confirms.length, 1);
  assert.match(browser.confirms[0], /identity=alpha, bump=minor.*2\.3\.4 -> 2\.4\.0/);
  assert.match(browser.card.querySelector('.deploy-status').textContent, /SUCCESS/);
  assert.match(browser.card.output.textContent, /published selected identity/);
  assert.equal(browser.card.current.textContent, '2.4.0');
  assert.equal(browser.card.target.textContent, '2.5.0', 'anticipation is refreshed from newly published metadata');
  assert.equal(browser.card.button.disabled, false);
  assert.deepEqual(browser.card.selects.map(select => select.value), ['alpha', 'minor'], 'only the operator-selected values survive a refresh');
  assert.match(browser.card.last.textContent, /2\.3\.4 -> 2\.4\.0/, 'last deployment must not show the next anticipated version');
  assert.equal(server.history[0].targetVersion, '2.4.0');
 });

 test(`${surface}: password prompt follows needPassword and preserves the exact manifest selection`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const browser = await loadDeployBrowser(surface, slot, {
   responses: [
    { ok: false, needPassword: true, error: 'Saved password is stale.' },
    { ok: true, duration: '1.0', output: 'published', user: 'operator' },
   ],
  });
  await browser.choose('identity', 'bravo'); await browser.choose('bump', 'major'); await browser.click();
  assert.equal(posts(browser).length, 2);
  assert.deepEqual(posts(browser)[0].body, { inputs: { identity: 'bravo', bump: 'major' }, manifestRevision: slot.revision });
  assert.deepEqual(posts(browser)[1].body, { ...posts(browser)[0].body, password: 'good-password', savePassword: true });
  assert.deepEqual(browser.prompts, ['Saved password is stale.']);
 });

 test(`${surface}: rejected stale choices remain disabled rather than re-enabled by finally`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const browser = await loadDeployBrowser(surface, slot, {
   responses: [{ ok: false, staleManifest: true, error: 'Choices changed; reopen the deployment panel.' }],
  });
  await browser.choose('identity', 'alpha'); await browser.choose('bump', 'patch'); await browser.click();
  assert.equal(browser.card.button.disabled, true);
  assert.match(browser.card.output.textContent, /Choices changed/);
  assert.match(browser.card.notice.textContent, /Reopen this panel/);
  await browser.choose('bump', 'major'); await browser.click();
  assert.equal(posts(browser).length, 1, 'changing bump does not bless an expired manifest');
 });

 test(`${surface}: confirmation cancellation executes nothing and legacy option payload stays unchanged`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const cancelled = await loadDeployBrowser(surface, slot, { confirm: false });
  await cancelled.choose('identity', 'alpha'); await cancelled.choose('bump', 'patch'); await cancelled.click();
  assert.equal(posts(cancelled).length, 0);
  assert.equal(cancelled.card.button.disabled, false);
  const legacy = await loadDeployBrowser(surface, null, { legacyOption: 'minor' });
  await legacy.click();
  assert.deepEqual(posts(legacy)[0].body, { option: 'minor' });
  assert.equal(legacy.card.button.disabled, false);
 });

 test(`${surface}: every request outcome leaves a truthful, usable deployment card`, async t => {
  const { root } = manifestWorkspace(t);
  const slot = await resolveDeployManifest(root, 'dev');
  const selected = async browser => {
   await browser.choose('identity', 'alpha');
   await browser.choose('bump', 'patch');
   await browser.click();
  };

  await t.test('immediate terminal success becomes a finished log view', async () => {
   const browser = await loadDeployBrowser(surface, slot, {
    responses: [{ ok: true, status: 'success', runId: 'fast-1', duration: '0.0', version: '2.3.5', user: 'operator', output: 'done' }],
   });
   await selected(browser);
   assert.equal(browser.card.classList.contains('deploy-running'), false);
   assert.equal(browser.card.classList.contains('deploy-finished'), true);
   assert.ok(browser.card.querySelector('.deploy-reset'), 'the operator can deliberately return to the form');
  });

  await t.test('password cancellation restores the form without claiming a deployment result', async () => {
   const browser = await loadDeployBrowser(surface, slot, {
    password: null,
    responses: [{ ok: false, needPassword: true, error: 'Enter your password.' }],
   });
   await selected(browser);
   assert.equal(browser.card.classList.contains('deploy-running'), false);
   assert.equal(browser.card.classList.contains('deploy-finished'), false);
   assert.equal(browser.card.button.disabled, false);
   assert.match(browser.card.output.textContent, /cancelled/i);
  });

  await t.test('password retry starts a second follower and terminalizes its result', async () => {
   const browser = await loadDeployBrowser(surface, slot, {
    responses: [
     { ok: false, needPassword: true, error: 'Saved password is stale.' },
     { ok: true, status: 'success', runId: 'retry-1', duration: '1.0', version: '2.3.5', user: 'operator', output: 'published' },
    ],
   });
   await selected(browser);
   const runGets = browser.requests.filter(request => request.method === 'GET' && /\/run(?:\?|$)/.test(request.url));
   assert.equal(runGets.length, 2, 'each POST attempt gets its own chance to adopt the run it starts');
   assert.equal(browser.card.classList.contains('deploy-running'), false);
   assert.equal(browser.card.classList.contains('deploy-finished'), true);
  });

  await t.test('validation refusal restores the form', async () => {
   const browser = await loadDeployBrowser(surface, slot, {
    responses: [{ ok: false, error: 'Choices changed; reopen the deployment panel.', staleManifest: true }],
   });
   await selected(browser);
   assert.equal(browser.card.classList.contains('deploy-running'), false);
   assert.equal(browser.card.classList.contains('deploy-finished'), false);
   assert.match(browser.card.output.textContent, /Choices changed/);
  });

  await t.test('request failure restores the form', async () => {
   const browser = await loadDeployBrowser(surface, slot, { responses: [new Error('network unavailable')] });
   await selected(browser);
   assert.equal(browser.card.classList.contains('deploy-running'), false);
   assert.equal(browser.card.classList.contains('deploy-finished'), false);
   assert.match(browser.card.output.textContent, /network unavailable/);
  });

  await t.test('external polling interruption keeps the active slot locked', async () => {
   const job = { id: 'external-1', state: 'running', phase: 'deploying', revision: 'a'.repeat(40) };
   const browser = await loadDeployBrowser(surface, slot, { immediateTimers: true,
    responses: [{ ok: true, backend: 'external', queued: true, job }],
    externalPollError: 'deployment service offline' });
   await selected(browser);
   assert.equal(browser.card.classList.contains('deploy-running'), true, 'a possibly active host job keeps the slot locked');
   assert.equal(browser.card.classList.contains('deploy-finished'), false);
   assert.ok(browser.card.querySelector('.deploy-service-job-link'), 'the durable host-job link remains available');
   assert.match(browser.card.output.textContent, /may still be running/i);
  });
 });
}

test('modal: reopening discovers identities, resets explicit selections, and restores keyboard focus on Escape', async t => {
 const { root } = manifestWorkspace(t);
 const slot = await resolveDeployManifest(root, 'dev');
 const browser = await loadDeployBrowser('deployModalScript', slot, { loadManifest: () => resolveDeployManifest(root, 'dev') });
 assert.equal(browser.document.activeElement, browser.card.selects[0]);
 await browser.choose('identity', 'alpha'); await browser.choose('bump', 'patch');
 await browser.document.emit('keydown', { key: 'Escape' });
 assert.equal(browser.backdrop.classList.contains('hidden'), true);
 assert.equal(browser.document.activeElement, browser.opener);
 addIdentity(root, 'new-style');
 await browser.window.pwDeploy.open('demo');
 assert.equal(JSON.parse(browser.card.dataset.manifest).inputs[0].choices.length, 3);
 assert.deepEqual(browser.card.selects.map(select => select.value), ['', '']);
 assert.equal(browser.card.button.disabled, true);
 assert.ok(browser.requests.filter(request => request.method === 'GET').every(request => request.cache === 'no-store'));
 const last = browser.card.script;
 last.focus();
 let prevented = false;
 await browser.backdrop.emit('keydown', { key: 'Tab', preventDefault: () => { prevented = true; } });
 assert.equal(prevented, true);
 assert.equal(browser.document.activeElement, browser.close);
 await browser.backdrop.emit('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
 assert.equal(browser.document.activeElement, last);
 assert.match(serverTemplate('deployModalHtml'), /aria-labelledby="deployModalTitle"/);
});

test('page history and modal both use the named-selection and planned-version history formatter', () => {
 assert.match(serverTemplate('deployScript'), /Inputs \/ anticipated/);
 assert.match(serverTemplate('deployScript'), /deployInputs\.history\(e\)/);
});

// A failed run used to leave the "Last:" line exactly as the page rendered it,
// which on a shared instance is usually somebody ELSE's successful deploy — shown
// directly above the failure text. Two operators read the colleague's name there
// as the owner of their own failure. Both surfaces now name the run that ran.
for (const surface of surfaces) {
 test(`${surface}: a failed run names itself in the output and in the Last line`, async () => {
  const browser = await loadDeployBrowser(surface, null, {
   responses: [{ ok: false, duration: '0.8', version: 'V1.26.0922.1555', user: 'kevin.charlebois',
    error: 'DEPLOY BLOCKED - only the approved principal may migrate this database.' }],
  });
  await browser.click();
  const status = browser.card.querySelector('.deploy-status');
  assert.match(status.textContent, /FAILED \(0\.8s\)/);
  assert.match(status.textContent, /kevin\.charlebois/, 'the fixed verdict must name the run it belongs to');
  assert.match(browser.card.output.textContent, /DEPLOY BLOCKED/, 'the pane remains the deployment output, not a duplicate verdict');
  assert.match(browser.card.last.textContent, /kevin\.charlebois/, 'the Last line must follow a failed run too');
  assert.match(browser.card.last.textContent, /FAILED/, 'and must not keep advertising an earlier success');
 });
}
