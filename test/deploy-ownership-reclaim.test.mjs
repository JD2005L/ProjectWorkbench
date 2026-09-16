// The deploy route's workspace-ownership reclaim, at the route seam.
//
// 5d17c94 added reclaimWorkspaceOwnership() so a runAsRoot deploy cannot leave root-owned drift in
// a workspace (VisualIdentity's publish `git commit`s, and the pane account then cannot commit).
// The tool itself is covered by pw-fix-workspace-ownership.test.mjs; NOTHING covered the route's
// side of it — whether the deploy actually calls it, with which arguments, only when the slot runs
// as root, and whether a failure stays non-fatal.
//
// That gap is also how the canonical gate went red: the route grew a call to a server function the
// VM harness did not declare, and four runAsRoot route tests began throwing "ReferenceError:
// reclaimWorkspaceOwnership is not defined" from a synthesized filename with no hint of the cause.
// The first test below closes the class — it holds the harness's dependency list to the real
// deployment source — and the rest make the reclaim itself load-bearing, so removing it from the
// harness fails with a sentence instead of a ReferenceError.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { manifestWorkspace } from './deploy-manifest-fixtures.mjs';
import { deploymentSectionCallees, deployRouteHarness, FIX_OWNERSHIP_HELPER } from './deploy-manifest-harness.mjs';

const deployRoute = '/api/deploy/:project/:target';
const params = { project: 'demo', target: 'prod' };
// A plain saved script slot, deliberately not the manifest-managed one: what is under test here is
// the reclaim, not manifest resolution, and the legacy slot reaches deployExec with the least setup.
const slotProject = { deploySlots: { prod: { label: 'Publish' } } };
const rootSlot = { demo: { prod: { script: 'publish.sh', runAsRoot: true, reauth: false } } };
const paneSlot = { demo: { prod: { script: 'publish.sh', reauth: false } } };

test('every server function the deployment section calls is declared to the harness', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, config: rootSlot });
 const callees = deploymentSectionCallees();
 // Guard against a vacuous pass: the list is derived from the real source, so it must contain the
 // call that broke, and be a plausible size rather than an empty regex result.
 assert.ok(callees.includes('reclaimWorkspaceOwnership'), 'the derived list must see the reclaim call');
 assert.ok(callees.length > 20, `expected the deployment section's real callee list, got ${callees.length}`);
 const missing = callees.filter(name => vm.runInContext(`typeof ${name}`, h.context) === 'undefined');
 assert.deepEqual(missing, [],
  `app/server.js's deployment section calls these, but deploy-manifest-harness.mjs neither executes their source nor doubles them: ${missing.join(', ')}. ` +
  'Add functionSource(<name>) to its helpers, or a double to its context.');
});

test('a runAsRoot deploy hands that one workspace back to the pane account', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, config: rootSlot });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, true, result.body.output);
 assert.equal(h.reclaims.length, 1, 'a root deploy must reclaim exactly once');
 const [reclaim] = h.reclaims;
 assert.equal(reclaim.file, FIX_OWNERSHIP_HELPER, 'the real sibling tool, not an arbitrary command');
 assert.deepEqual(reclaim.args, ['--apply', 'demo'],
  'scoped to the ONE project being deployed, and applying rather than dry-running');
 assert.equal(reclaim.options.env.PW_WORKSPACES, root, 'the tool must walk this instance\'s workspaces');
 assert.ok(reclaim.options.env.PW_TERMINAL_USER, 'ownership is handed to the pane account, which must be named');
 assert.ok(reclaim.options.timeout > 0, 'a hung repair must not hold the deploy open forever');
});

test('an ordinary pane-account deploy never invokes the repair', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, config: paneSlot });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, true, result.body.output);
 assert.deepEqual(h.reclaims, [],
  'a deploy that never ran as root leaves no root-owned drift, so chowning a workspace after it would be unrequested privilege');
});

test('what the repair reports is surfaced in the deploy output', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, {
  project: slotProject,
  config: rootSlot,
  onExec: async () => ({ stdout: 'deploy said this', stderr: '' }),
  onReclaim: async () => ({ stdout: 'demo: root-owned: 3, repaired: 3\n', stderr: '' }),
 });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, true);
 assert.match(result.body.output, /deploy said this/, 'the deploy output is kept');
 assert.match(result.body.output, /demo: root-owned: 3, repaired: 3/,
  'an operator must be able to see the repair ran and what it touched');
});

test('a repair that fails leaves the deploy successful and says so', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, {
  project: slotProject,
  config: rootSlot,
  onReclaim: async () => { throw Object.assign(new Error('chown: Operation not permitted'), { code: 1 }); },
 });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, true, 'the deploy itself succeeded; a best-effort repair must not undo that');
 assert.equal(h.history[0].status, 'success', 'nor may it rewrite history into a failure');
 assert.match(result.body.output, /reclaim failed \(non-fatal\)/, 'but it must never fail silently');
 assert.match(result.body.output, /Operation not permitted/, 'and must carry the real reason');
});

test('a FAILED root deploy is reclaimed too', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, {
  project: slotProject,
  config: rootSlot,
  onExec: async () => { throw Object.assign(new Error('publish exploded'), { stdout: 'wrote half of it', stderr: '' }); },
 });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, false);
 assert.equal(h.reclaims.length, 1,
  'a deploy that died midway can have written just as much root-owned drift as one that finished');
});
