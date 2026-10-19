// The deploy route's upstream gate, at the route seam.
//
// A deploy never pulls. Before anything runs, the route compares the workspace's commit with its
// branch's upstream (deployment/source.js checkUpstream — real Git, covered in
// deploy-service-client-source.test.mjs). Here: a stale workspace is refused before any password
// prompt, run claim or script; a warning-only state still deploys and says so in the output, the
// history and the audit; the external backend carries the warning in its queued response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestWorkspace } from './deploy-manifest-fixtures.mjs';
import { deployRouteHarness } from './deploy-manifest-harness.mjs';
import { describeUpstream } from '../app/deployment/source.js';

const deployRoute = '/api/deploy/:project/:target';
const params = { project: 'demo', target: 'prod' };
const slotProject = { deploySlots: { prod: { label: 'Publish' } } };
const gate = check => ({ check, refuse: ['behind', 'diverged'].includes(check.state), message: describeUpstream(check, '/ws/demo') });
const behind = { state: 'behind', head: 'a'.repeat(40), remoteTip: 'b'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 2, branch: 'main' };
const ahead = { state: 'ahead', head: 'a'.repeat(40), remoteTip: 'b'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0, branch: 'main' };

test('a workspace behind its upstream is refused before reauth, run claim or script', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, upstream: gate(behind),
  config: { demo: { prod: { script: 'publish.sh', reauth: true } } } });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.statusCode, 409);
 assert.equal(result.body.code, 'deployment_workspace_behind');
 assert.match(result.body.error, /2 commits behind origin\/main.*git pull --ff-only` in \/ws\/demo.*Nothing was deployed/s);
 assert.equal(result.body.needPassword, undefined, 'a stale workspace must not cost the operator a password prompt first');
 assert.deepEqual(h.executions, []);
 assert.deepEqual(h.history, []);
 assert.deepEqual(h.upstreamChecks, [root]);
 const refused = h.audit.find(entry => entry.event === 'deploy_upstream_refused');
 assert.equal(refused?.upstream, 'behind');
 assert.equal(refused?.behind, 2);
 assert.equal(h.audit.some(entry => entry.event === 'deploy_execute'), false);
});

test('a diverged workspace is refused the same way', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, upstream: gate({ ...behind, state: 'diverged', ahead: 1, behind: 1 }),
  config: { demo: { prod: { script: 'publish.sh', reauth: false } } } });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.statusCode, 409);
 assert.equal(result.body.code, 'deployment_workspace_diverged');
 assert.deepEqual(h.executions, []);
});

test('unpushed local commits still deploy, and the warning reaches the output, history and audit', async t => {
 const { root } = manifestWorkspace(t);
 const h = deployRouteHarness(root, { project: slotProject, upstream: gate(ahead),
  config: { demo: { prod: { script: 'publish.sh', reauth: false } } },
  onExec: async () => ({ stdout: 'deploy said this', stderr: '' }) });
 const result = await h.call('POST', deployRoute, { params, body: {} });
 assert.equal(result.body.ok, true, result.body.output);
 assert.match(result.body.output, /^Warning: 1 local commit is not pushed to origin\/main[^\n]*\n\ndeploy said this/);
 assert.equal(h.executions.length, 1);
 assert.equal(h.history.at(-1).upstream, 'ahead');
 assert.equal(h.audit.find(entry => entry.event === 'deploy_execute')?.upstream, 'ahead');
});

test('an in-sync or unchecked workspace deploys with its output untouched', async t => {
 for (const check of [{ state: 'in_sync', head: 'a'.repeat(40), remoteTip: 'a'.repeat(40), upstream: 'origin/main' }, { state: 'skipped' }]) {
  const { root } = manifestWorkspace(t);
  const h = deployRouteHarness(root, { project: slotProject, upstream: gate(check),
   config: { demo: { prod: { script: 'publish.sh', reauth: false } } },
   onExec: async () => ({ stdout: 'deploy said this', stderr: '' }) });
  const result = await h.call('POST', deployRoute, { params, body: {} });
  assert.equal(result.body.ok, true, check.state);
  assert.equal(result.body.output, 'deploy said this', check.state);
 }
});

test('a successful deploy records the commit it finished on and nudges the PROD status; a failed one records none', async t => {
 const { root } = manifestWorkspace(t);
 const head = 'c'.repeat(40);
 const ok = deployRouteHarness(root, { project: slotProject, workspaceHead: head,
  config: { demo: { prod: { script: 'publish.sh', reauth: false } } }, onExec: async () => ({ stdout: 'done', stderr: '' }) });
 assert.equal((await ok.call('POST', deployRoute, { params, body: {} })).body.ok, true);
 assert.equal(ok.history.at(-1).commit, head);
 assert.deepEqual(ok.headReads, [root]);
 assert.equal(ok.prodRefreshes.length, 1);

 const bad = deployRouteHarness(root, { project: slotProject, workspaceHead: head,
  config: { demo: { prod: { script: 'publish.sh', reauth: false } } }, onExec: async () => { throw Object.assign(new Error('boom'), { code: 1 }); } });
 assert.equal((await bad.call('POST', deployRoute, { params, body: {} })).body.ok, false);
 assert.equal(bad.history.at(-1).commit, undefined);
 assert.deepEqual(bad.headReads, []);
 assert.equal(bad.prodRefreshes.length, 1);
});

test("a tool's successful PROD publish brings its hub's workspace up to date, and says so", async t => {
 const { root } = manifestWorkspace(t);
 const run = (opts) => deployRouteHarness(root, { project: slotProject, hubOf: { demo: 'Hub' },
  config: { demo: { prod: { script: 'publish.sh', reauth: false }, dev: { script: 'check.sh', reauth: false } } },
  onExec: async () => ({ stdout: 'published', stderr: '' }), ...opts });
 const ok = run({ hubSync: { state: 'fast_forwarded', from: 'a'.repeat(40), to: 'b'.repeat(40), upstream: 'origin/main', count: 1 } });
 const r = await ok.call('POST', deployRoute, { params, body: {} });
 assert.equal(r.body.ok, true, r.body.output);
 assert.deepEqual(ok.hubSyncs, ['Hub']);
 assert.match(r.body.output, /Hub Hub: workspace fast-forwarded to origin\/main \(1 commit, aaaaaaa\.\.bbbbbbb\), so deploying Hub needs no git pull\./);
 assert.deepEqual(ok.history.at(-1).hubSync, { hub: 'Hub', state: 'fast_forwarded', to: 'b'.repeat(40) });

 const dirty = run({ hubSync: { state: 'skipped', reason: 'uncommitted changes to tracked files (1)' } });
 const d = await dirty.call('POST', deployRoute, { params, body: {} });
 assert.equal(d.body.ok, true, 'a hub that cannot be updated never fails the publish itself');
 assert.match(d.body.output, /Hub Hub: workspace NOT updated — uncommitted changes to tracked files \(1\)\. Run `git pull --ff-only` in Hub/);

 const check = run({});
 await check.call('POST', deployRoute, { params: { project: 'demo', target: 'dev' }, body: {} });
 assert.deepEqual(check.hubSyncs, [], 'a check (dev) pushes nothing, so nothing is synced');

 const failed = run({ onExec: async () => { throw Object.assign(new Error('boom'), { code: 1 }); } });
 await failed.call('POST', deployRoute, { params, body: {} });
 assert.deepEqual(failed.hubSyncs, [], 'nor after a failed publish');

 const app = deployRouteHarness(root, { project: slotProject, config: { demo: { prod: { script: 'publish.sh', reauth: false } } },
  onExec: async () => ({ stdout: 'x', stderr: '' }) });
 await app.call('POST', deployRoute, { params, body: {} });
 assert.deepEqual(app.hubSyncs, [], 'nor for a project that is not a tool');
});
