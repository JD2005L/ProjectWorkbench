import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDeployManifest } from '../app/deploy-manifest.js';
import { addIdentity, manifestWorkspace, writeJson } from './deploy-manifest-fixtures.mjs';
import { deployRouteHarness, serverSource } from './deploy-manifest-harness.mjs';

const deployRoute = '/api/deploy/:project/:target';
const params = { project: 'demo', target: 'dev' };
const bodyFor = (manifest, identity = 'alpha', bump = 'patch') => ({ inputs: { identity, bump }, manifestRevision: manifest.revision });
function targetHtml(html, target) {
 return html.split('data-target="').find(part => part.startsWith(`${target}"`));
}
function manifestAttribute(html) {
 const encoded = /data-manifest="([^"]*)"/.exec(html)?.[1];
 assert.ok(encoded, 'resolved manifest must be embedded in the card');
 return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}
function requireBash(t) {
 try { execFileSync('bash', ['--version'], { stdio: 'ignore' }); return true; }
 catch (error) {
  if (error.code === 'ENOENT') { t.skip('Bash not on PATH; run with the existing Git Bash bin directory on Windows'); return false; }
  throw error;
 }
}

test('VI contract: exact identity versions and malformed publishing history leave server deployment independent', async t => {
 const { root, document, save } = manifestWorkspace(t);
 fs.rmSync(path.join(root, 'identities'), { recursive: true });
 fs.rmSync(path.join(root, 'releases'), { recursive: true });
 addIdentity(root, 'default', { label: 'Default', initial: '1.0.1', published: '1.0.1' });
 addIdentity(root, 'internal-dark', { label: 'Internal dark', initial: '1.0.0' });
 document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
 save();
 const h = deployRouteHarness(root, { config: {} });
 const versionRoute = '/api/deploy/:project/:target/version';
 const prodParams = { project: 'demo', target: 'prod' };
 const dev = (await h.call('GET', versionRoute, { params })).body.manifest;
 assert.deepEqual(dev.inputs[0].choices.map(choice => [choice.value, choice.version, choice.initialVersion]), [
  ['default', '1.0.1', '1.0.1'], ['internal-dark', null, '1.0.0'],
 ]);
 assert.equal(dev.inputs[0].choices[0].targetVersions.patch, '1.0.2');
 assert.deepEqual(dev.inputs[0].choices[1].targetVersions, { patch: '1.0.0', minor: '1.0.0', major: '1.0.0' });
 const normalCard = (await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body.html;
 assert.match(normalCard, /name="identity" required><option value="">Choose Visual identity<\/option><option value="default">/);
 assert.doesNotMatch(normalCard, /<option[^>]*\sselected[=>\s]/);
 const initialProd = (await h.call('GET', versionRoute, { params: prodParams })).body.manifest;
 const index = path.join(root, 'releases', 'default', 'index.json');
 const corruptions = [
  ['missing index', () => fs.unlinkSync(index)],
  ['malformed JSON', () => fs.writeFileSync(index, '{')],
  ['missing latest', () => writeJson(root, ['releases', 'default', 'index.json'], {})],
  ['null latest', () => writeJson(root, ['releases', 'default', 'index.json'], { latest: null })],
  ['invalid latest', () => writeJson(root, ['releases', 'default', 'index.json'], { latest: 'invalid' })],
 ];
 for (const [name, corrupt] of corruptions) {
  await t.test(name, async () => {
   corrupt();
   const before = h.executions.length;
   assert.equal((await h.call('GET', versionRoute, { params })).statusCode, 400);
   const prod = await h.call('GET', versionRoute, { params: prodParams });
   assert.equal(prod.body.ok, true);
   assert.equal(prod.body.manifest.revision, initialProd.revision);
   assert.deepEqual(prod.body.manifest.inputs, []);
   const card = (await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body.html;
   assert.match(targetHtml(card, 'dev'), /role="alert"/);
   assert.match(targetHtml(card, 'prod'), /Deploy MCP server/);
   assert.doesNotMatch(targetHtml(card, 'prod'), /<button[^>]*class="[^"]*deploy-btn"[^>]*\bdisabled/);
   const status = await h.call('GET', '/api/deploy/status');
   assert.equal(status.body.projects[0].dev.configured, false);
   assert.equal(status.body.projects[0].prod.configured, true);
   assert.equal(h.executions.length, before, 'metadata GET must never execute either script');
   const result = await h.call('POST', deployRoute, { params: prodParams, body: { inputs: {}, manifestRevision: initialProd.revision } });
   assert.equal(result.body.ok, true);
   assert.equal(h.executions.length, before + 1);
   assert.ok(h.executions.at(-1).args.includes('bash deploy/deploy-mcp.sh'));
  });
 }
 assert.equal(h.saves, 0);
 assert.deepEqual(h.config, {});
 assert.equal(fs.existsSync(path.join(root, 'releases', 'internal-dark')), false, 'discovery must not pre-create first-publication history');
});

test('script-only routes: prod is discoverable and executable without saved host configuration or identity metadata', async t => {
 const { root, document, save } = manifestWorkspace(t);
 document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
 save();
 fs.unlinkSync(path.join(root, 'identities', 'alpha', 'tokens.json'));
 const h = deployRouteHarness(root, { config: {} });
 const page = await h.call('GET', '/deploy');
 const modal = await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
 for (const html of [page.html, modal.body.html]) {
  const prod = targetHtml(html, 'prod');
  assert.match(prod, /Deploy MCP server/);
  assert.match(prod, /No input selections required/);
  assert.match(prod, /<textarea class="deploy-script" readonly>bash deploy\/deploy-mcp\.sh/);
  assert.doesNotMatch(prod, /<select\b|class="selection-version"|class="[^"]*save-config"/);
  assert.doesNotMatch(prod, /<button[^>]*class="[^"]*deploy-btn"[^>]*\bdisabled/);
  assert.match(targetHtml(html, 'dev'), /role="alert"/, 'bad publishing metadata only disables its own slot');
 }
 const status = await h.call('GET', '/api/deploy/status');
 assert.equal(status.body.projects[0].prod.configured, true);
 assert.deepEqual(status.body.projects[0].prod.manifest.inputs, []);
 const prodParams = { project: 'demo', target: 'prod' };
 const version = await h.call('GET', '/api/deploy/:project/:target/version', { params: prodParams });
 assert.equal(version.body.managed, true);
 assert.equal(version.body.version, null);
 assert.equal(version.body.manifest.version, null);
 assert.equal(h.executions.length, 0);
 assert.equal(h.credentialReads, 0);
 assert.equal(h.sourceReads, 0);
 assert.equal(h.saves, 0);
 const result = await h.call('POST', deployRoute, { params: prodParams, body: { inputs: {}, manifestRevision: version.body.manifest.revision } });
 assert.equal(result.body.ok, true);
 assert.equal(h.executions.length, 1);
 assert.equal(h.executions[0].file, '/usr/bin/setpriv', 'discoverability is not a grant to run as root');
 assert.equal(h.executions[0].options.cwd, root);
 assert.ok(h.executions[0].args.includes('bash deploy/deploy-mcp.sh'));
 assert.equal(Object.hasOwn(h.executions[0].options.env, 'DEPLOY_OPTION'), false);
 assert.deepEqual(h.history[0].inputs, {});
 assert.equal(h.history[0].target, 'prod');
 assert.equal(h.history[0].currentVersion, null);
 assert.equal(h.history[0].targetVersion, null);
 const after = (await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body.html;
 assert.match(targetHtml(after, 'prod'), /class="last-deploy-info">[^<]* by operator<\/span>/, 'empty inputs must not add a dangling history separator');
 assert.deepEqual(h.config, {});
});

test('script-only routes: required contract freshness and saved reauth are not bypassed by empty selections', async t => {
 const { root, document, save } = manifestWorkspace(t);
 document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
 save();
 const slot = await resolveDeployManifest(root, 'prod');
 const prodParams = { project: 'demo', target: 'prod' };
 const body = { inputs: {}, manifestRevision: slot.revision };
 const h = deployRouteHarness(root, {
  config: { demo: { prod: { script: 'stale-saved-server-script', reauth: true } } },
 });
 for (const bad of [{}, { ...body, inputs: { bump: 'patch' } }, { ...body, option: 'patch' }, { ...body, manifestRevision: 'stale' }]) {
  const result = await h.call('POST', deployRoute, { params: prodParams, body: bad });
  assert.ok([400, 409].includes(result.statusCode));
 }
 assert.equal(h.credentialReads, 0);
 const first = await h.call('POST', deployRoute, { params: prodParams, body });
 assert.equal(first.statusCode, 401);
 assert.equal(first.body.needPassword, true);
 assert.equal(h.executions.length, 0);
 const second = await h.call('POST', deployRoute, { params: prodParams, body: { ...body, password: 'good-password', savePassword: true } });
 assert.equal(second.body.ok, true);
 assert.equal(h.users[0].deployPassword, 'sealed:good-password');
 const stored = await h.call('POST', deployRoute, { params: prodParams, body });
 assert.equal(stored.body.ok, true);
 assert.equal(stored.body.needPassword, undefined);
 assert.equal(h.executions.length, 2);
 document.slots.prod.script = 'bash deploy/changed.sh';
 save();
 const stale = await h.call('POST', deployRoute, { params: prodParams, body });
 assert.equal(stale.statusCode, 409);
 assert.equal(h.executions.length, 2);
});

test('managed routes: real page, modal, status and version handlers read only data, never saved providers or credentials', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root);
 const page = await h.call('GET', '/deploy');
 const modal = await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
 for (const html of [page.html, modal.body.html]) {
  const dev = targetHtml(html, 'dev');
  assert.match(dev, /data-managed="1"/);
  assert.match(dev, /Repository-managed/);
  assert.match(dev, /<textarea class="deploy-script" readonly>/);
  assert.doesNotMatch(dev, /save-config|legacy-saved-script|legacy-version-command|src-newer|deploy-option/);
  const slot = manifestAttribute(dev);
  assert.equal(slot.inputs.length, 2);
  for (const name of ['identity', 'bump']) {
   assert.match(dev, new RegExp(`<label[^>]*for="deploy-demo-dev-${name}"`));
   assert.match(dev, new RegExp(`<select[^>]*id="deploy-demo-dev-${name}"[^>]*name="${name}" required><option value="">Choose `));
  }
  assert.doesNotMatch(dev, /<option[^>]*\sselected[=>\s]/);
  assert.match(dev, /aria-live="polite"/);
  assert.match(dev, /deploy-btn" type="button" disabled/);
 }
 const status = await h.call('GET', '/api/deploy/status');
 assert.equal(status.body.projects[0].dev.managed, true);
 assert.equal(status.body.projects[0].dev.version, null);
 const version = await h.call('GET', '/api/deploy/:project/:target/version', { params });
 assert.equal(version.body.manifest.inputs[0].choices[0].version, '2.3.4');
 assert.equal(h.executions.length, 0, 'no versionCmd, discovery command, or deploy command on managed GET');
 assert.equal(h.credentialReads, 0, 'data-only GET does not even load/decrypt deploy credentials');
 assert.equal(h.sourceReads, 0, 'independent versions do not run the application source probe');
 assert.equal(h.saves, 0, 'GET must not migrate saved configuration');
});

test('managed routes: new identities appear on reopening with no registry/config edits', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { config: {} });
 const open = () => h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
 const before = manifestAttribute((await open()).body.html);
 addIdentity(root, 'next-identity', { initial: '4.0.0' });
 const after = manifestAttribute((await open()).body.html);
 assert.equal(after.inputs[0].choices.length, before.inputs[0].choices.length + 1);
 assert.ok(after.inputs[0].choices.some(choice => choice.value === 'next-identity'));
 assert.deepEqual(h.config, {});
 assert.equal(h.saves, 0);
 assert.match(serverSource, /hasDeployConfigFor\(p\.name, dCfg\) \|\| \(await getProjectDeployStates\(p, dCfg\)\)/, 'manifest-only projects must get the cockpit deployment affordance');
});

test('managed routes: selectors, script and metadata render as text, not active HTML', async t => {
 const { root, document, save } = manifestWorkspace(t);
 document.slots.dev.label = '<img src=x onerror=bad>';
 save();
 addIdentity(root, 'alpha', { label: '</option><script>bad</script>', published: '2.3.4' });
 const result = await deployRouteHarness(root).call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
 assert.doesNotMatch(result.body.html, /<script>bad|<img src=x/);
 assert.match(result.body.html, /&lt;script&gt;bad/);
});

test('managed routes: manifest script overrides stale root-saved script, passes selected env/cwd, and persists versions', async t => {
 const { root } = manifestWorkspace(t);
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root, {
  config: { demo: { dev: { script: 'must-not-run', versionCmd: 'must-not-probe', reauth: true } } },
  storedUser: { deployPassword: 'sealed:good-password' },
  onExec: async execution => {
   assert.equal(execution.options.env.DEPLOY_IDENTITY, 'alpha');
   assert.equal(execution.options.env.DEPLOY_BUMP, 'minor');
   writeJson(root, ['releases', 'alpha', 'index.json'], { latest: '2.4.0' });
   return { stdout: 'published alpha 2.4.0', stderr: '' };
  },
 });
 const result = await h.call('POST', deployRoute, { params, body: bodyFor(manifest, 'alpha', 'minor') });
 assert.equal(result.body.ok, true);
 assert.equal(result.body.needPassword, undefined);
 assert.equal(h.executions.length, 1, 'no stale saved versionCmd after publication');
 const execution = h.executions[0];
 assert.equal(execution.file, '/usr/bin/setpriv', 'manifest does not bypass the pane-account drop');
 assert.ok(execution.args.includes(manifest.script));
 assert.ok(!execution.args.includes('alpha') && !execution.args.includes('minor'), 'selected values travel via env, not interpolated shell text');
 assert.equal(execution.options.cwd, root);
 assert.equal(execution.options.env.DEPLOY_PASSWORD, 'good-password');
 assert.equal(execution.options.env.USER, 'pane');
 assert.notEqual(execution.options.env.HOME, '/root');
 assert.equal(Object.hasOwn(execution.options.env, 'DEPLOY_OPTION'), false);
 assert.deepEqual(result.body.inputs, { identity: 'alpha', bump: 'minor' });
 assert.equal(result.body.currentVersion, '2.3.4');
 assert.equal(result.body.targetVersion, '2.4.0');
 assert.equal(result.body.version, '2.4.0');
 assert.equal(result.body.sourceNewer, false);
 assert.equal(result.body.sourceVersion, null);
 assert.notEqual(result.body.manifest.revision, manifest.revision);
 assert.equal(h.history[0].currentVersion, '2.3.4');
 assert.equal(h.history[0].targetVersion, '2.4.0');
 assert.deepEqual(h.history[0].inputs, result.body.inputs);
 assert.equal(h.audit.at(-1).manifestRevision, manifest.revision);
 assert.equal(h.sourceReads, 0);
 const history = (await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } })).body.html;
 assert.match(history, /identity=alpha, bump=minor/);
 assert.match(history, /2\.3\.4 -&gt; 2\.4\.0/);
});

test('managed routes: first release uses metadata version and retains explicit operator root/reauth grants', async t => {
 const { root } = manifestWorkspace(t);
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root, {
  config: { demo: { dev: { script: 'old', runAsRoot: true, reauth: true } } },
  onExec: async () => {
   writeJson(root, ['releases', 'bravo', 'index.json'], { latest: '1.2.0' });
   return { stdout: 'initial release', stderr: '' };
  },
 });
 const body = bodyFor(manifest, 'bravo', 'major');
 const first = await h.call('POST', deployRoute, { params, body });
 assert.equal(first.statusCode, 401);
 assert.equal(first.body.needPassword, true);
 assert.equal(h.executions.length, 0);
 const second = await h.call('POST', deployRoute, { params, body: { ...body, password: 'good-password', savePassword: true } });
 assert.equal(second.body.ok, true);
 assert.equal(h.executions[0].file, 'bash', 'only saved runAsRoot authorizes the existing escape hatch');
 assert.equal(second.body.currentVersion, null);
 assert.equal(second.body.targetVersion, '1.2.0');
 assert.equal(h.users[0].deployPassword, 'sealed:good-password');
});

test('managed routes: missing/unknown/extra choices and fields fail before reauth, history, or execution', async t => {
 const { root } = manifestWorkspace(t);
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root, { config: { demo: { dev: { script: 'old', reauth: true } } } });
 for (const body of [
  {}, { option: 'patch' }, { inputs: { bump: 'patch' }, manifestRevision: manifest.revision },
  bodyFor(manifest, 'missing'), bodyFor(manifest, 'alpha', 'draft'),
  { ...bodyFor(manifest), inputs: { identity: 'alpha', bump: 'patch', extra: 'injected' } },
  { ...bodyFor(manifest), option: 'patch' }, { ...bodyFor(manifest), script: 'override' },
  { ...bodyFor(manifest), runAsRoot: true }, { ...bodyFor(manifest), manifestRevision: 'old' },
 ]) {
  const result = await h.call('POST', deployRoute, { params, body });
  assert.ok([400, 409].includes(result.statusCode), JSON.stringify(result.body));
  assert.equal(result.body.ok, false);
 }
 assert.equal(h.executions.length, 0);
 assert.equal(h.history.length, 0);
 assert.equal(h.credentialReads, 0);
});

test('managed routes: deleted/stale identity and deleted manifest never invoke legacy inference', async t => {
 for (const change of ['identity', 'version', 'manifest', 'slot']) {
  await t.test(change, async sub => {
   const { root, document, save } = manifestWorkspace(sub);
   const manifest = await resolveDeployManifest(root, 'dev');
   const h = deployRouteHarness(root);
   if (change === 'identity') fs.rmSync(path.join(root, 'identities', 'alpha'), { recursive: true });
   if (change === 'version') writeJson(root, ['releases', 'alpha', 'index.json'], { latest: '2.3.5' });
   if (change === 'manifest') fs.unlinkSync(path.join(root, '.pw', 'deploy.json'));
   if (change === 'slot') { delete document.slots.dev; save(); }
   const result = await h.call('POST', deployRoute, { params, body: bodyFor(manifest) });
   assert.equal(result.statusCode, 409);
   assert.equal(result.body.staleManifest, true);
   assert.equal(h.executions.length, 0);
  });
 }
});

test('managed routes: contract changes during reauth are rechecked before saving or executing', async t => {
 const { root } = manifestWorkspace(t);
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root, {
  config: { demo: { dev: { script: 'old', reauth: true } } },
  onAuthenticate: async () => writeJson(root, ['releases', 'alpha', 'index.json'], { latest: '2.3.5' }),
 });
 const result = await h.call('POST', deployRoute, { params, body: { ...bodyFor(manifest), password: 'good-password', savePassword: true } });
 assert.equal(result.statusCode, 409);
 assert.equal(h.executions.length, 0);
 assert.equal(h.saves, 0);
});

test('managed routes: broken contract is visible and blocks config/POST/probes, without disabling legacy prod', async t => {
 const { root } = manifestWorkspace(t);
 fs.unlinkSync(path.join(root, 'identities', 'alpha', 'tokens.json'));
 const h = deployRouteHarness(root, {
  config: { demo: { dev: { script: 'old-dev', versionCmd: 'old-dev-version' }, prod: { script: 'legacy-prod' } } },
 });
 const page = await h.call('GET', '/deploy');
 const modal = await h.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
 for (const html of [page.html, modal.body.html]) {
  const dev = targetHtml(html, 'dev');
  assert.match(dev, /role="alert"/);
  assert.doesNotMatch(dev, /class="deploy-script"|deploy-btn|save-config|old-dev-version/);
  assert.match(targetHtml(html, 'prod'), /legacy-prod/);
 }
 for (const [method, route, body] of [
  ['POST', deployRoute, {}],
  ['POST', '/api/deploy/config', { ...params, script: 'try to overwrite' }],
  ['GET', '/api/deploy/:project/:target/version', {}],
 ]) assert.equal((await h.call(method, route, { params, body })).statusCode, 400);
 assert.equal(h.executions.length, 0);
 assert.equal(h.saves, 0);
 const prod = await h.call('POST', deployRoute, { params: { project: 'demo', target: 'prod' } });
 assert.equal(prod.body.ok, true);
 assert.ok(h.executions[0].args.includes('legacy-prod'));
});

test('managed routes: unchanged publication metadata cannot be reported as success', async t => {
 const { root } = manifestWorkspace(t);
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root);
 const result = await h.call('POST', deployRoute, { params, body: bodyFor(manifest) });
 assert.equal(result.body.ok, false);
 assert.equal(result.body.status, 'failed');
 assert.match(result.body.error, /2\.3\.4.*2\.3\.5 was anticipated/);
 assert.equal(h.history[0].status, 'failed');
 assert.equal(h.history[0].targetVersion, '2.3.5');
});

test('managed routes: managed Save is refused, ordinary Save/options/URLs and middleware remain intact', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, {
  project: { deploySlots: { prod: { label: 'Existing production', options: [{ value: 'patch', label: 'Patch' }, { value: 'minor', label: 'Minor' }] } } },
  config: { demo: { dev: { script: 'stale' }, prod: { script: 'legacy', versionCmd: 'legacy-version', runAsRoot: true, reauth: false } } },
 });
 const managed = await h.call('POST', '/api/deploy/config', { body: { ...params, script: 'no' } });
 assert.equal(managed.statusCode, 409);
 assert.equal(h.saves, 0);
 const ordinary = await h.call('POST', '/api/deploy/config', { body: { project: 'demo', target: 'prod', script: 'still-legacy', versionCmd: 'legacy-version' } });
 assert.equal(ordinary.body.ok, true);
 assert.equal(h.config.demo.prod.runAsRoot, true);
 assert.equal(h.config.demo.prod.reauth, false);
 const result = await h.call('POST', deployRoute, { params: { project: 'demo', target: 'prod' }, body: {} });
 assert.equal(result.body.ok, true);
 assert.equal(h.executions[0].options.env.DEPLOY_OPTION, 'patch', 'legacy default-first option remains unchanged');
 assert.equal(h.executions[0].args.at(-1), 'patch', 'legacy positional option remains unchanged');
 assert.equal(h.executions[0].options.cwd, undefined, 'legacy saved scripts retain their own cwd semantics');
 assert.equal(h.history[0].option, 'patch');
 assert.equal(h.history[0].inputs, undefined);
 for (const route of [deployRoute, '/api/deploy/:project/:target/version', '/api/deploy/:project/card', '/api/deploy/:project/log']) {
  const method = route === deployRoute ? 'POST' : 'GET';
  const handlers = h.routes.get(`${method} /pw${route}`);
  assert.equal(handlers[0], h.middleware.requireAuth);
  assert.equal(handlers[1], h.middleware.requireProjectAccess);
 }
 assert.equal(h.routes.get('POST /pw/api/deploy/config')[0], h.middleware.requireAdmin);
 assert.equal((await h.call('POST', deployRoute, { params, caller: null })).statusCode, 401);
 assert.equal((await h.call('POST', deployRoute, { params, caller: { role: 'developer', projects: ['another'] } })).statusCode, 403);
 assert.equal((await h.call('POST', '/api/deploy/config', { caller: { role: 'developer' } })).statusCode, 403);
});

test('managed routes: actual Bash receives literal named inputs and workspace cwd through the existing deployExec seam', async t => {
 if (!requireBash(t)) return;
 const { root, document, save } = manifestWorkspace(t);
 const identity = '$(touch injected); "quoted" \'single\' & %PATH%';
 document.slots.dev.inputs[0] = {
  name: 'identity', type: 'select', label: 'Identity', env: 'DEPLOY_IDENTITY', required: true,
  choices: [{ value: identity, label: 'Literal value' }],
 };
 delete document.slots.dev.version;
 save();
 fs.mkdirSync(path.join(root, 'deploy'));
 fs.writeFileSync(path.join(root, 'deploy', 'publish.sh'), 'node -e \'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))\' "$1" "$2"\n');
 const manifest = await resolveDeployManifest(root, 'dev');
 const h = deployRouteHarness(root, { config: { demo: { dev: { script: 'stale', runAsRoot: true } } }, nativeExec: true });
 const result = await h.call('POST', deployRoute, { params, body: bodyFor(manifest, identity, 'major') });
 assert.equal(result.body.ok, true, result.body.output);
 assert.equal(h.executions[0].options.env.HOME, root);
 assert.deepEqual(h.executions[0].nativeArgs.slice(0, 2), ['--noprofile', '--norc']);
 assert.equal(h.executions[0].result.stderr, '', 'native fixture must not emit startup diagnostics');
 const output = JSON.parse(result.body.output);
 assert.deepEqual(output.args, [identity, 'major']);
 assert.equal(path.resolve(output.cwd).toLowerCase(), path.resolve(root).toLowerCase());
 assert.equal(fs.existsSync(path.join(root, 'injected')), false);
 assert.deepEqual(h.history[0].inputs, { identity, bump: 'major' });
});

test('script-only routes: actual Bash receives no implicit option or identity arguments', async t => {
 if (!requireBash(t)) return;
 const { root, document, save } = manifestWorkspace(t);
 document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
 save();
 fs.mkdirSync(path.join(root, 'deploy'));
 fs.writeFileSync(path.join(root, 'deploy', 'deploy-mcp.sh'), 'node -e \'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),option:process.env.DEPLOY_OPTION??null}))\' "$@"\n');
 const slot = await resolveDeployManifest(root, 'prod');
 const h = deployRouteHarness(root, { config: { demo: { prod: { runAsRoot: true } } }, nativeExec: true });
 const result = await h.call('POST', deployRoute, { params: { project: 'demo', target: 'prod' }, body: { inputs: {}, manifestRevision: slot.revision } });
 assert.equal(result.body.ok, true, result.body.output);
 assert.equal(h.executions[0].options.env.HOME, root);
 assert.deepEqual(h.executions[0].nativeArgs.slice(0, 2), ['--noprofile', '--norc']);
 assert.equal(h.executions[0].result.stderr, '', 'native fixture must not emit startup diagnostics');
 const output = JSON.parse(result.body.output);
 assert.deepEqual(output.args, []);
 assert.equal(output.option, null);
 assert.equal(path.resolve(output.cwd).toLowerCase(), path.resolve(root).toLowerCase());
});
