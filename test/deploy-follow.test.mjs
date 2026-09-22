// The client half of a watchable deploy: app/deploy-follow.js, driven directly.
//
// The panel's job is to attach to whatever the server says is happening, not to
// remember what it started — that is the difference between "closing the modal
// loses the deploy" and not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunFollower } from '../app/deploy-follow.js';

function harness(responses) {
  const calls = [];
  const environment = {
    document: { hidden: false, addEventListener() {} },
    setTimeout: (fn) => { fn(); return 0; },          // no real waiting in a test
    clearTimeout() {},
    async fetch(url) {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      const status = next.status || 200;
      return { status, ok: status < 400, json: async () => next.body };
    },
  };
  const output = { className: '', textContent: '' };
  return { calls, output, follower: createRunFollower(environment) };
}

const runningRun = { id: 'abc123', status: 'running', startedAt: '2026-09-22T18:45:00.000Z', user: 'kev', offset: 12, output: '[1/2] going\n' };

test('attaching to a run in flight paints what it has printed, then follows it to the end', async () => {
  const { calls, output, follower } = harness([
    { body: { ok: true, run: runningRun } },
    { body: { ok: true, run: { ...runningRun, output: undefined }, chunk: '[2/2] done\n', offset: 24 } },
    { body: { ok: true, run: { ...runningRun, status: 'success', duration: '3.1', version: 'V9', output: undefined }, chunk: '', offset: 24 } },
  ]);
  const done = [];
  const run = await follower.follow({ base: '/pw', project: 'demo', target: 'prod', output, onDone: (value, text) => done.push([value.status, text]) });

  assert.equal(run.status, 'success');
  assert.match(output.textContent, /✅ SUCCESS \(3\.1s\)/);
  assert.match(output.textContent, /by kev/);
  assert.match(output.textContent, /\[1\/2\] going[\s\S]*\[2\/2\] done/, 'the live chunks accumulate rather than replacing each other');
  assert.deepEqual(done[0], ['success', '[1/2] going\n[2/2] done\n']);
  assert.deepEqual(calls, [
    '/pw/api/deploy/demo/prod/run',
    '/pw/api/deploy/demo/prod/run?after=12',
    '/pw/api/deploy/demo/prod/run?after=24',
  ], 'each poll asks only for what it has not seen');
});

test('a slot that has finished paints its last run once, and a slot that never ran paints nothing', async () => {
  const finished = { id: 'def456', status: 'failed', startedAt: '2026-09-22T15:57:15.000Z', user: 'kevin.charlebois',
    duration: '0.8', deployUser: 'GOA\\svc-prod', identitySource: 'instance', offset: 9, output: 'BLOCKED\n' };
  const { output, follower, calls } = harness([{ body: { ok: true, run: finished } }]);
  const run = await follower.follow({ base: '', project: 'demo', target: 'prod', output });
  assert.equal(run.id, 'def456');
  assert.match(output.textContent, /❌ FAILED \(0\.8s\)/);
  assert.match(output.textContent, /by kevin\.charlebois as GOA\\svc-prod/, 'a shared credential is named, so the run is not read as that person acting');
  assert.equal(calls.length, 1, 'a terminal run needs no polling');

  const empty = harness([{ body: { ok: true, run: null } }]);
  assert.equal(await empty.follower.follow({ base: '', project: 'demo', target: 'dev', output: empty.output }), null);
  assert.equal(empty.output.textContent, '', 'and an empty panel is left empty');
});

test('the operator who just pressed Deploy waits for THEIR run, not the previous one', async () => {
  // requireRunning is what stops the panel painting the last failure over the
  // deploy the person is waiting on — and `until` stops it waiting forever when
  // the request answered 401 (password prompt) or 409 and no run ever started.
  const stale = { id: 'old', status: 'failed', startedAt: '2026-09-22T10:00:00.000Z', user: 'kev', duration: '1.0', offset: 4, output: 'old\n' };
  const { output, follower } = harness([
    { body: { ok: true, run: stale } },
    { body: { ok: true, run: stale } },
  ]);
  let resolvePost;
  const pending = new Promise(resolve => { resolvePost = resolve; });
  const following = follower.follow({ base: '', project: 'demo', target: 'prod', output, requireRunning: true, until: pending });
  resolvePost({ ok: false, needPassword: true });
  assert.equal(await following, null, 'no run of ours appeared, so nothing is claimed');
  assert.equal(output.textContent, '', 'and the stale failure is NOT painted as if it were this attempt');
});

test('a poller that fell behind the truncation window restarts its text instead of splicing a fragment', async () => {
  const { output, follower } = harness([
    { body: { ok: true, run: { ...runningRun, output: 'tail-only\n', truncated: true } } },
    { body: { ok: true, run: { ...runningRun, status: 'success', duration: '1.0', truncated: true }, chunk: 'fresh tail\n', offset: 999, behind: true } },
  ]);
  await follower.follow({ base: '', project: 'demo', target: 'prod', output });
  assert.match(output.textContent, /earlier output dropped/);
  assert.match(output.textContent, /fresh tail/);
  assert.equal(output.textContent.includes('tail-only'), false, 'the stale window is discarded, not concatenated');
});

test('History drill-in renders a retained run, and says so when it is gone', async () => {
  const into = { hidden: true, textContent: '' };
  const ok = harness([{ body: { ok: true, run: { id: 'abc123', status: 'success', duration: '60.5', startedAt: '2026-09-22T18:45:00.000Z', user: 'kev', output: 'Publish succeeded.\n' } } }]);
  await ok.follower.showArchived({ base: '/pw', project: 'demo', id: 'abc123', into });
  assert.equal(into.hidden, false);
  assert.match(into.textContent, /✅ SUCCESS \(60\.5s\)[\s\S]*Publish succeeded/);
  assert.deepEqual(ok.calls, ['/pw/api/deploy/demo/run/abc123']);

  const gone = harness([{ status: 404, body: { ok: false, error: 'That deployment run is no longer retained.' } }]);
  await gone.follower.showArchived({ base: '', project: 'demo', id: 'zzz', into });
  assert.match(into.textContent, /no longer retained/);
});

// While a deploy runs, the slot stops being a form. The screenshot that prompted
// this had the live log wedged above a script textarea, a version-check input and
// a Save button — three controls that cannot be used on a run already in flight.
function fakeCard() {
  const classes = new Set();
  const children = [];
  return {
    children,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    querySelector: selector => children.find(child => child.className?.includes(selector.slice(1))) || null,
    appendChild: child => children.push(child),
  };
}

function fakeDocument() {
  return {
    hidden: false,
    addEventListener() {},
    createElement: () => {
      const element = { type: '', className: '', textContent: '', handlers: {} };
      element.addEventListener = (type, fn) => { element.handlers[type] = fn; };
      element.remove = () => { element.removed = true; };
      return element;
    },
  };
}

function scrollableOutput(visible = 100) {
  return { className: '', textContent: '', scrollTop: 0, clientHeight: visible,
    get scrollHeight() { return visible + this.textContent.length; } };
}

test('a running slot becomes a log viewer, and hands back its controls when the operator clears it', async () => {
  const running = { id: 'abc123', status: 'running', startedAt: '2026-09-22T21:43:29.000Z', user: 'james.levac', offset: 6, output: '[1/5]\n' };
  const { output, follower, environment } = (() => {
    const responses = [
      { body: { ok: true, run: running } },
      { body: { ok: true, run: { ...running, status: 'success', duration: '61.0', version: 'V1.26.0922.2145' }, chunk: '[5/5] done\n', offset: 18 } },
    ];
    const environment = { ...fakeDocument(), setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
      async fetch() { const next = responses.shift(); return { status: 200, ok: true, json: async () => next.body }; } };
    environment.document = environment;
    return { output: scrollableOutput(), follower: createRunFollower(environment), environment };
  })();
  const card = fakeCard();

  const states = [];
  await follower.follow({ base: '', project: 'demo', target: 'prod', output, card,
    onRunning: () => states.push(card.classList.contains('deploy-running')) });

  assert.deepEqual(states, [true], 'the card is in log-viewer mode while the script runs');
  assert.equal(card.classList.contains('deploy-running'), false, 'and out of it when the run ends');
  assert.equal(card.classList.contains('deploy-finished'), true, 'but the pane keeps its height so the card does not jump');

  const reset = card.children.find(child => child.className.includes('deploy-reset'));
  assert.ok(reset, 'a finished run offers a way back to a card that can deploy again');
  assert.equal(reset.textContent, 'Start a new deployment', 'the button says what it does; the outcome is in the headline');
  reset.handlers.click();
  assert.equal(card.classList.contains('deploy-finished'), false, 'clearing restores the ordinary card');
  assert.equal(output.textContent, '');
  assert.equal(output.className, 'deploy-output', 'and hides the spent log');
  assert.equal(reset.removed, true);
  void environment;
});

test('the pane follows the tail, and stops following the moment the reader scrolls up', async () => {
  const environment = { ...fakeDocument(), setTimeout: fn => { fn(); return 0; }, clearTimeout() {} };
  environment.document = environment;
  const follower = createRunFollower(environment);
  const output = scrollableOutput();

  const run = { id: 'abc', status: 'running', startedAt: '2026-09-22T21:43:29.000Z', user: 'kev' };
  follower.paint(output, run, 'line one\n');
  assert.equal(output.scrollTop, output.scrollHeight, 'a pane at the bottom stays at the bottom');

  // The reader scrolls up to read something earlier.
  output.scrollTop = 0;
  follower.paint(output, run, 'line one\nline two\n');
  assert.equal(output.scrollTop, 0, 'new output must not yank the view away from what they are reading');

  // Scrolling back to the bottom resumes following.
  output.scrollTop = output.scrollHeight;
  follower.paint(output, run, 'line one\nline two\nline three\n');
  assert.equal(output.scrollTop, output.scrollHeight);
});

test('a failed run keeps the log view, and its outcome stays in the headline not the button', async () => {
  const failed = { id: 'def', status: 'failed', startedAt: '2026-09-22T21:43:29.000Z', user: 'kev', duration: '0.8', offset: 3, output: 'no\n' };
  const environment = { ...fakeDocument(), setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
    async fetch() { return { status: 200, ok: true, json: async () => ({ ok: true, run: failed }) }; } };
  environment.document = environment;
  const card = fakeCard();
  const output = scrollableOutput();
  await createRunFollower(environment).follow({ base: '', project: 'demo', target: 'prod', output, card });
  assert.equal(card.classList.contains('deploy-finished'), true, 'a failure keeps the log in front, not the form');
  const status = card.children.find(child => child.className.startsWith('deploy-status'));
  assert.match(status.textContent, /❌ FAILED \(0\.8s\)/, 'the outcome is stated outside the pane, where scrolling cannot hide it');
  assert.equal(status.className, 'deploy-status failed');
  assert.equal(card.children.find(child => child.className.includes('deploy-reset')).textContent, 'Start a new deployment');
});

// History is one panel with two views. Appending the log under a fifty-row table
// meant scrolling past every other release to read the run just clicked, and then
// scrolling back to find the list — so the detail REPLACES the list, and Back
// returns to it.
function fakeHistoryPanel() {
  const into = { textContent: '', hidden: false };
  const backButton = { className: 'button secondary small history-back', focused: 0, focus() { this.focused++; } };
  const list = { hidden: false };
  const detail = {
    hidden: true,
    querySelector: selector => (selector === '.run-detail-output' ? into : selector === '.history-back' ? backButton : null),
  };
  const panel = { querySelector: selector => (selector === '.history-list' ? list : selector === '.history-detail' ? detail : null) };
  const row = { dataset: { run: 'abc123', runProject: 'demo' }, focused: 0, focus() { this.focused++; },
    closest: selector => (selector === '.history-panel' ? panel : null) };
  backButton.closest = selector => (selector === '.history-panel' ? panel : null);
  return { into, backButton, list, detail, row };
}

test('clicking Output swaps the list for that run, and Back swaps it back', async () => {
  const panel = fakeHistoryPanel();
  const handlers = {};
  const responses = [{ ok: true, run: { id: 'abc123', status: 'success', duration: '135.5', startedAt: '2026-09-22T21:45:46.000Z', user: 'james.levac', output: 'Publish succeeded.\n' } }];
  const environment = {
    document: { addEventListener: (type, fn) => { handlers[type] = fn; }, createElement: () => ({ addEventListener() {} }) },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
    async fetch() { return { status: 200, ok: true, json: async () => responses.shift() }; },
  };
  const follower = createRunFollower(environment);
  follower.bindHistory({ base: '/pw', root: environment.document });

  // Click the row's Output button.
  let prevented = false;
  await handlers.click({ target: { closest: selector => (selector === '.history-back' ? null : panel.row) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'the button must not submit or navigate');
  assert.equal(panel.list.hidden, true, 'the list is replaced, not pushed down');
  assert.equal(panel.detail.hidden, false);
  assert.equal(panel.backButton.focused, 1, 'and the keyboard lands on the way back');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(panel.into.textContent, /✅ SUCCESS \(135\.5s\)[\s\S]*Publish succeeded/);

  // Click Back.
  await handlers.click({ target: { closest: selector => (selector === '.history-back' ? panel.backButton : null) }, preventDefault() {} });
  assert.equal(panel.list.hidden, false, 'Back returns to the list');
  assert.equal(panel.detail.hidden, true);
  assert.equal(panel.into.textContent, '', 'and leaves nothing stale behind the next click');
  assert.equal(panel.row.focused, 1, 'with focus back on the row that was opened');
});

test('a click outside a history panel is ignored rather than throwing', async () => {
  const handlers = {};
  const environment = {
    document: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
    async fetch() { throw new Error('must not fetch'); },
  };
  createRunFollower(environment).bindHistory({ base: '', root: environment.document });
  await handlers.click({ target: { closest: () => null }, preventDefault() {} });
  const orphan = { dataset: { run: 'abc', runProject: 'demo' }, closest: () => null };
  await handlers.click({ target: { closest: selector => (selector === '.history-back' ? null : orphan) }, preventDefault() {} });
});

// The verdict must survive the scroll. It used to be the log pane's first line,
// which a tail-following pane pushes out of view within seconds — so a deploy
// would finish and the answer was three hundred lines above the fold.
test('the result is written outside the log pane, where scrolling cannot hide it', async () => {
  const created = [];
  const pane = { className: '', textContent: '', scrollTop: 0, clientHeight: 100,
    get scrollHeight() { return 100 + this.textContent.length; } };
  const inserted = [];
  pane.parentNode = { insertBefore: (node, before) => { inserted.push([node, before === pane]); } };
  const cardNodes = [];
  const card = {
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: selector => cardNodes.find(node => node.className?.startsWith(selector.slice(1))) || null,
    appendChild: node => cardNodes.push(node),
  };
  const environment = {
    document: {
      addEventListener() {},
      createElement: () => { const el = { className: '', textContent: '', addEventListener() {}, remove() {} }; created.push(el); cardNodes.push(el); return el; },
    },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
  };
  environment.document.hidden = false;
  const follower = createRunFollower(environment);

  const running = { id: 'abc', status: 'running', startedAt: '2026-09-22T22:07:00.000Z', user: 'james.levac' };
  follower.paint(pane, running, 'lots of output\n', card);
  const status = created[0];
  assert.ok(status, 'a status element is created next to the pane');
  assert.deepEqual(inserted[0], [status, true], 'and inserted BEFORE the pane, not inside it');
  assert.match(status.textContent, /⏳ RUNNING/);
  assert.equal(status.className, 'deploy-status running');
  assert.equal(pane.textContent, 'lots of output\n', 'the pane holds the script output and nothing else');

  follower.paint(pane, { ...running, status: 'success', duration: '135.5', version: 'V1.26.0922.2207' }, 'lots of output\ndone\n', card);
  assert.match(status.textContent, /✅ SUCCESS \(135\.5s\)/);
  assert.match(status.textContent, /V1\.26\.0922\.2207/, 'with the version that was published');
  assert.equal(status.className, 'deploy-status success');
  assert.equal(created.length, 1, 'the status element is reused, not stacked');

  follower.paint(pane, { ...running, status: 'failed', duration: '0.8' }, 'nope\n', card);
  assert.equal(status.className, 'deploy-status failed');

  // A caller with no card (a bare pane) keeps the headline in the pane rather
  // than losing it.
  const bare = { className: '', textContent: '' };
  follower.paint(bare, { ...running, status: 'success', duration: '1.0' }, 'out\n');
  assert.match(bare.textContent, /✅ SUCCESS[\s\S]*out/);
});
