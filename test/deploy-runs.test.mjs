// A local deploy as a thing that outlives the request that started it.
//
// Before this, a deploy WAS the request: close the modal and the only copy of the
// output went with it, while the script kept running on the box. History kept a
// result and an unreachable snippet. These pin the three properties that fixed it
// — identity, progress, retained detail — plus the one-run-per-slot rule that
// reattaching depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeployRuns, RUN_OUTPUT_CAP } from '../app/deploy-runs.js';

function runs(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let counter = 0;
  return { dir, api: createDeployRuns({ dir, newId: () => `run${++counter}`, ...options }) };
}

test('one run per slot: a second operator is handed the first run, not a second script', async t => {
  const { api } = runs(t);
  const first = api.start({ project: 'Demo', target: 'prod', user: 'james.levac' });
  assert.equal(first.started, true);

  const second = api.start({ project: 'Demo', target: 'prod', user: 'kevin.charlebois' });
  assert.equal(second.started, false, 'the same slot must not run twice at once');
  assert.equal(second.run.id, first.id, 'and the caller is told which run to watch');
  assert.equal(second.run.user, 'james.levac');

  // A different target is a different slot, and must not be blocked by it.
  assert.equal(api.start({ project: 'Demo', target: 'dev', user: 'kevin.charlebois' }).started, true);
  assert.equal(api.start({ project: 'Other', target: 'prod', user: 'kevin.charlebois' }).started, true);
});

test('progress is readable while the script is still running', async t => {
  const { api } = runs(t);
  const started = api.start({ project: 'Demo', target: 'prod', user: 'kev' });
  api.append(started.id, '[1/5] Publishing application...\n');

  const live = await api.latest('Demo', 'prod');
  assert.equal(live.status, 'running');
  assert.equal(live.id, started.id);
  assert.match(live.output, /\[1\/5\] Publishing/);
  assert.equal(live.finishedAt, null);

  // Incremental reads are what a poller does: only the new bytes, and an offset
  // it can hand back next time.
  api.append(started.id, '[2/5] Stopping IIS...\n');
  const next = api.since(await api.latest('Demo', 'prod'), live.offset);
  assert.equal(next.chunk, '[2/5] Stopping IIS...\n');
  assert.equal(next.behind, false);
  assert.equal(api.since(await api.latest('Demo', 'prod'), next.offset).chunk, '', 'caught up means nothing new');
});

test('a finished run is retained, retrievable by id, and scoped to its project', async t => {
  const { api, dir } = runs(t);
  const started = api.start({ project: 'Demo', target: 'prod', user: 'kev', deployUser: 'GOA\\svc-prod', identitySource: 'instance' });
  api.append(started.id, 'Publish succeeded.\n');
  const finished = await api.finish(started.id, { status: 'success', version: 'V1.26.0922.1845', duration: '60.5' });
  assert.deepEqual([finished.status, finished.version, finished.duration], ['success', 'V1.26.0922.1845', '60.5']);

  const archived = await api.byId('Demo', started.id);
  assert.match(archived.output, /Publish succeeded/);
  assert.equal(archived.deployUser, 'GOA\\svc-prod', 'who it ran as survives with the output');
  assert.equal(archived.user, 'kev', 'and so does who pressed it');
  assert.equal(await api.byId('Other', started.id), null, 'an id from another project does not resolve');
  assert.equal(await api.byId('Demo', '../../etc/passwd'), null, 'and an id is not a path');

  const [file] = fs.readdirSync(dir);
  assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, 'a slot script prints hostnames and accounts');

  // The slot is free again the moment the run ends.
  assert.equal(api.activeRun('Demo', 'prod'), null);
  assert.equal(api.start({ project: 'Demo', target: 'prod', user: 'kev' }).started, true);
});

test('the last run survives a dashboard restart, because it was archived not remembered', async t => {
  const { api, dir } = runs(t);
  const started = api.start({ project: 'Demo', target: 'dev', user: 'kev' });
  api.append(started.id, 'published\n');
  await api.finish(started.id, { status: 'success', version: 'V2' });

  // A brand-new store over the same directory is what a restarted process sees.
  const afterRestart = createDeployRuns({ dir });
  const latest = await afterRestart.latest('Demo', 'dev');
  assert.equal(latest.id, started.id);
  assert.equal(latest.version, 'V2');
  assert.match(latest.output, /published/);
  assert.equal(await afterRestart.latest('Demo', 'prod'), null, 'and says nothing about a slot that never ran');
});

test('output is capped at the tail, and a poller that fell behind is told so', async t => {
  const { api } = runs(t, { cap: 64 });
  const started = api.start({ project: 'Demo', target: 'prod', user: 'kev' });
  api.append(started.id, 'a'.repeat(50));
  const early = await api.latest('Demo', 'prod');
  api.append(started.id, 'b'.repeat(100));

  const live = await api.latest('Demo', 'prod');
  assert.equal(live.output.length, 64, 'the tail is kept, not the head');
  assert.equal(live.truncated, true);
  assert.equal(live.bytes, 150, 'and the byte count still counts everything');

  const behind = api.since(live, early.offset);
  assert.equal(behind.behind, true, 'a client inside the dropped window must be told, not handed a fragment');
  assert.equal(behind.chunk, live.output);
  assert.equal(behind.offset, 150);
  assert.ok(RUN_OUTPUT_CAP > 64, 'the shipped cap is a real one; this test just uses a small one');
});

test('only the newest runs per slot are kept, and pruning is per slot', async t => {
  const { api, dir } = runs(t, { keep: 2 });
  for (const target of ['dev', 'prod']) {
    for (let index = 0; index < 4; index++) {
      const started = api.start({ project: 'Demo', target, user: 'kev' });
      api.append(started.id, `run ${target} ${index}`);
      await api.finish(started.id, { status: 'success' });
    }
  }
  const files = fs.readdirSync(dir);
  assert.equal(files.filter(name => name.includes('-Demo-dev-')).length, 2);
  assert.equal(files.filter(name => name.includes('-Demo-prod-')).length, 2);
  assert.match((await api.latest('Demo', 'prod')).output, /run prod 3/, 'the newest is the one kept');
});
