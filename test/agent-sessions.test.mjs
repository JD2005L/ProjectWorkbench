// The engine behind the agent session surface (docs/agent-mcp.md).
//
// Everything is injected, so these drive the real decisions with no server, no
// tmux and no token store. The three rules the module is built on are what the
// assertions are about: address by index, type only into your own lane, paste
// rather than type.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentSessions, validSessionName, AgentSessionError,
  MARKER_TOKEN, MARKER_USER, MAX_PROMPT_BYTES, MAX_READ_LINES,
} from '../app/agent-sessions.js';

const BOT = { id: 'tok-1', label: 'PVIBot', actsAs: 'kev',
  scopes: ['sessions:read', 'sessions:prompt', 'sessions:create'] };

function harness({ windows = [], markers = {}, projects = ['Demo', 'Other'], reach = () => true } = {}) {
  const calls = { created: [], pasted: [], options: [], captured: [], audit: [] };
  const state = { windows: [...windows], markers: { ...markers } };
  const engine = createAgentSessions({
    authorize: async (project, token) => (projects.includes(project) && reach(project, token)
      ? { ok: true, project: { name: project, path: `/w/${project}` }, user: { username: token.actsAs } }
      : { ok: false, reason: `No such project: ${project}`, status: 404 }),
    listProjects: async () => projects.map((name) => ({ name })),
    listWindows: async () => state.windows,
    targetFor: (project, index) => `pw_${project}:${index}`,
    windowOption: async (target, option) => state.markers[`${target}|${option}`] || '',
    setWindowOption: async (target, option, value) => {
      calls.options.push([target, option, value]);
      state.markers[`${target}|${option}`] = value;
    },
    createWindow: async (project, name, cli, launcher) => {
      calls.created.push({ project: project.name, name, cli, launcher });
      const index = 7;
      state.windows.push({ index, name, bell: false, working: true });
      return index;
    },
    pasteToWindow: async (target, text) => calls.pasted.push([target, text]),
    capturePane: async (target, opts) => { calls.captured.push([target, opts]); return 'line1\nline2\n'; },
    audit: async (event, detail) => calls.audit.push([event, detail]),
    now: () => new Date('2026-09-23T16:00:00Z'),
  });
  return { engine, calls, state };
}

const fails = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error instanceof AgentSessionError, `expected an AgentSessionError, got ${error}`);
  assert.equal(error.code, code, error.message);
  return error;
};

test('discovery shows only what the token can reach, and an unreachable project reads as absent', async () => {
  const { engine } = harness({ reach: (project) => project === 'Demo' });
  assert.deepEqual(await engine.projects(BOT), { projects: [{ name: 'Demo' }] });
  // 404, not 403: a machine credential must not be able to enumerate the instance
  // by reading the difference between "forbidden" and "missing".
  const error = await fails(engine.sessions(BOT, 'Other'), 'project_unreachable');
  assert.equal(error.status, 404);
  assert.match(error.message, /No such project/);
});

test('a prompt into a new session creates it as the ACTING user and marks it before typing', async () => {
  const { engine, calls } = harness();
  const out = await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: 'do the thing', cli: 'claude' });

  assert.deepEqual(calls.created, [{ project: 'Demo', name: 'bot-lane', cli: 'claude', launcher: 'kev' }],
    'the window runs on the acting account, not the token label');
  // Marked before the paste: a pane must never be addressable as this token's lane
  // only after it has already been typed into.
  const markedAt = calls.options.findIndex(([, option]) => option === MARKER_TOKEN);
  assert.ok(markedAt >= 0 && calls.pasted.length === 1, 'marked and pasted');
  assert.deepEqual(calls.options.map(([, option]) => option).slice(0, 2), [MARKER_TOKEN, MARKER_USER]);
  assert.equal(calls.options[0][2], 'tok-1');
  assert.equal(calls.options[1][2], 'kev');
  assert.deepEqual(calls.pasted[0], ['pw_Demo:7', 'do the thing']);
  assert.deepEqual(out, { project: 'Demo', session: 'bot-lane', window: 7, created: true, injected_chars: 12 });

  const [event, detail] = calls.audit.at(-1);
  assert.equal(event, 'agent_prompt');
  assert.equal(detail.actsAs, 'kev');
  assert.equal(detail.promptBytes, 12);
  assert.equal(JSON.stringify(detail).includes('do the thing'), false, 'the body is never audited, only its size');
});

test('an unmarked window is a human tab and is refused without sessions:prompt:any', async () => {
  // The rule app/orchestrator/session.js is built on: a window belongs to a token
  // only if it carries the marker THIS code set. A pane running a shell would run
  // this text as a command.
  const windows = [{ index: 3, name: 'eod-commit', bell: false }];
  const { engine, calls } = harness({ windows });
  const error = await fails(engine.prompt(BOT, { project: 'Demo', session: 'eod-commit', prompt: 'hi' }), 'not_my_lane');
  assert.equal(error.status, 403);
  assert.match(error.message, /sessions:prompt:any/);
  assert.equal(calls.pasted.length, 0, 'and nothing was typed while deciding');

  // Someone else's marker is still not mine.
  const other = harness({ windows, markers: { 'pw_Demo:3|@pw_agent_token': 'tok-OTHER' } });
  await other.engine.prompt(BOT, { project: 'Demo', session: 'eod-commit', prompt: 'hi' });
  assert.equal(other.calls.pasted.length, 1, 'any agent-owned lane is allowed; only humans are fenced off');

  const elevated = { ...BOT, scopes: [...BOT.scopes, 'sessions:prompt:any'] };
  const allowed = harness({ windows });
  await allowed.engine.prompt(elevated, { project: 'Demo', session: 'eod-commit', prompt: 'hi' });
  assert.deepEqual(allowed.calls.pasted[0], ['pw_Demo:3', 'hi'], 'the separate scope is what unlocks a human tab');
});

test('an existing session keeps its own CLI; creating one without naming a CLI is refused', async () => {
  const { engine, calls } = harness({
    windows: [{ index: 2, name: 'bot-lane' }],
    markers: { 'pw_Demo:2|@pw_agent_token': 'tok-1' },
  });
  // cli is ignored for a live pane: a token cannot know what it is running and
  // must not change it.
  await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: 'next', cli: 'copilot' });
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.pasted[0], ['pw_Demo:2', 'next']);

  const fresh = harness();
  await fails(fresh.engine.prompt(BOT, { project: 'Demo', session: 'new-lane', prompt: 'x' }), 'cli_required');
  await fails(fresh.engine.prompt(BOT, { project: 'Demo', session: 'new-lane', prompt: 'x', cli: 'gpt' }), 'cli_required');
  assert.equal(fresh.calls.created.length, 0, 'no window is created while the request is invalid');

  await fails(fresh.engine.prompt(BOT, { project: 'Demo', session: 'new-lane', prompt: 'x', create_if_missing: false }),
    'no_such_session');
  const noCreate = { ...BOT, scopes: ['sessions:read', 'sessions:prompt'] };
  await fails(fresh.engine.prompt(noCreate, { project: 'Demo', session: 'new-lane', prompt: 'x', cli: 'claude' }),
    'missing_scope');
});

test('a duplicated window name is refused rather than silently delivered to one of them', async () => {
  // tmux permits duplicate names and then refuses the ambiguous target — which is
  // how a scheduled task silently stopped being delivered. Say so instead.
  const { engine, calls } = harness({ windows: [{ index: 1, name: 'dup' }, { index: 5, name: 'dup' }] });
  const error = await fails(engine.prompt(BOT, { project: 'Demo', session: 'dup', prompt: 'x' }), 'ambiguous_session');
  assert.equal(error.status, 409);
  assert.match(error.message, /rename one/);
  assert.equal(calls.pasted.length, 0);
  await fails(engine.read(BOT, { project: 'Demo', session: 'dup' }), 'ambiguous_session');
});

test('prompt size and session names are bounded', async () => {
  const { engine, calls } = harness({ windows: [{ index: 2, name: 'bot-lane' }], markers: { 'pw_Demo:2|@pw_agent_token': 'tok-1' } });
  await fails(engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: '   ' }), 'empty_prompt');
  const big = 'x'.repeat(MAX_PROMPT_BYTES + 1);
  const error = await fails(engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: big }), 'prompt_too_large');
  assert.match(error.message, /_inbox/, 'the refusal names the way to send something bigger');
  assert.equal(calls.pasted.length, 0);

  // A large-but-allowed prompt goes through in ONE paste, not in keystrokes.
  const large = 'y'.repeat(MAX_PROMPT_BYTES);
  await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: large });
  assert.equal(calls.pasted.length, 1);
  assert.equal(calls.pasted[0][1].length, MAX_PROMPT_BYTES);

  await fails(engine.prompt(BOT, { project: 'Demo', session: '../etc/passwd', prompt: 'x' }), 'invalid_session_name');
  assert.equal(validSessionName('bot-lane'), true);
  assert.equal(validSessionName('-leading'), false);
  assert.equal(validSessionName('has space'), false);
  assert.equal(validSessionName('x'.repeat(65)), false);
});

test('reading is capped and says when it capped, and reports what the pane is doing', async () => {
  const { engine, calls } = harness({
    windows: [{ index: 4, name: 'bot-lane', bell: true, working: false, hibernated: false, credUser: 'kev' }],
    markers: { 'pw_Demo:4|@pw_agent_token': 'tok-1', 'pw_Demo:4|@pw_agent_user': 'kev' },
  });
  const out = await engine.read(BOT, { project: 'Demo', session: 'bot-lane', lines: 9999 });
  assert.equal(out.lines, MAX_READ_LINES, 'one call cannot pull a pane whole history');
  assert.equal(out.truncated, true);
  assert.equal(calls.captured[0][1].lines, MAX_READ_LINES);
  assert.match(out.text, /line1/);

  const listed = await engine.sessions(BOT, 'Demo');
  assert.deepEqual(listed.sessions[0], {
    session: 'bot-lane', index: 4, working: false,
    finished_turn: true, hibernated: false, runs_as: 'kev',
    owned_by_this_token: true, agent_owned: true,
  });

  await fails(engine.read(BOT, { project: 'Demo', session: 'nope' }), 'no_such_session');
});

// ─── the turn lifecycle through the engine (phase 3) ────────────────────────

import { createAgentTurns, TurnState } from '../app/agent-turns.js';

function turnHarness({ samples = [], windows = [{ index: 2, name: 'bot-lane' }], markers = { 'pw_Demo:2|@pw_agent_token': 'tok-1' } } = {}) {
  let clock = 5_000_000;
  const taken = [];
  const turns = createAgentTurns({ now: () => clock, newId: () => 'turn-1', graceMs: 1000 });
  const queue = [...samples];
  const engine = createAgentSessions({
    authorize: async (project, token) => ({ ok: true, project: { name: project }, user: { username: token.actsAs } }),
    listProjects: async () => [{ name: 'Demo' }],
    listWindows: async () => windows,
    targetFor: (project, index) => `pw_${project}:${index}`,
    windowOption: async (target, option) => markers[`${target}|${option}`] || '',
    setWindowOption: async () => {},
    createWindow: async () => 2,
    pasteToWindow: async () => {},
    capturePane: async (target, opts) => { taken.push(opts); return 'output\n'; },
    paneMetrics: async () => { clock += 1500; return queue.length ? queue.shift() : { activity: 1, working: false }; },
    turns,
    sampleMs: 0,
  });
  return { engine, turns, taken, tick: (ms) => { clock += ms; } };
}

test('a prompt opens a turn, and waiting on it reports completion once', async () => {
  const { engine, turns } = turnHarness({ samples: [
    { activity: 10, bell: false, history: 5, rows: 40 },   // the pre-paste sample
    { activity: 11, bell: false, working: true },           // work starts
    { activity: 12, bell: true, working: false },           // the bell ends it
  ] });

  const sent = await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: 'go' });
  assert.equal(sent.turn_id, 'turn-1', 'the prompt hands back a handle to wait on');
  assert.equal(turns.get('turn-1').state, TurnState.RUNNING);

  const waited = await engine.waitForTurn(BOT, { project: 'Demo', session: 'bot-lane', turn_id: 'turn-1', timeout_ms: 30000 });
  assert.equal(waited.turn.state, TurnState.COMPLETED);
  assert.equal(waited.turn.completed_by, 'bell');
});

test('a wait that runs out of budget answers running, and is not an error', async () => {
  // "Ask again" is not a failure: a deploy outlasts any single request worth
  // holding open.
  const { engine } = turnHarness({ samples: [{ activity: 10, history: 5, rows: 40 }] });
  const sent = await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: 'go' });
  const waited = await engine.waitForTurn(BOT, { project: 'Demo', session: 'bot-lane', turn_id: sent.turn_id, timeout_ms: 1 });
  assert.equal(waited.turn.state, TurnState.RUNNING);
  assert.ok(Number.isFinite(waited.waited_ms));
});

test('a since-read asks for what has scrolled away plus the screen, and says it is approximate', async () => {
  const { engine, taken } = turnHarness({ samples: [
    { activity: 10, bell: false, history: 100, rows: 40 },  // pre-paste: 100 lines had scrolled off
    { activity: 40, bell: false, history: 160, rows: 40 },  // now: 60 more have
  ] });
  const sent = await engine.prompt(BOT, { project: 'Demo', session: 'bot-lane', prompt: 'go' });
  const out = await engine.read(BOT, { project: 'Demo', session: 'bot-lane', since_turn: sent.turn_id });

  assert.equal(out.approximate, true, 'a pane is a screen, not an append-only log, and the answer says so');
  assert.equal(out.since_turn, sent.turn_id);
  assert.equal(taken.at(-1).lines, 100, '60 scrolled away since the prompt, plus the 40 rows on screen');
  assert.equal(taken.at(-1).scrollback, true);

  await fails(engine.read(BOT, { project: 'Demo', session: 'bot-lane', since_turn: 'nope' }), 'no_such_turn');
  await fails(engine.turn(BOT, { project: 'Demo', session: 'bot-lane', turn_id: 'nope' }), 'no_such_turn');
});

test('a turn belonging to another project does not resolve', async () => {
  const { engine, turns } = turnHarness();
  turns.start({ project: 'Other', session: 'bot-lane', window: 2, tokenId: 'tok-1', actsAs: 'kev', sample: {} });
  await fails(engine.turn(BOT, { project: 'Demo', session: 'bot-lane', turn_id: 'turn-1' }), 'no_such_turn');
});

// ─── workspace reads, transcript and the one write (2026-09-24) ─────────────

function extendedHarness({ transcript = null, tree = null, file = null, inbox = null } = {}) {
  const calls = [];
  const engine = createAgentSessions({
    authorize: async (project, token) => ({ ok: true, project: { name: project, path: `/w/${project}` }, user: { username: token.actsAs } }),
    listProjects: async () => [{ name: 'Demo' }],
    listWindows: async () => [{ index: 2, name: 'bot-lane' }],
    targetFor: (project, index) => `pw_${project}:${index}`,
    windowOption: async () => 'tok-1',
    setWindowOption: async () => {},
    createWindow: async () => 2,
    pasteToWindow: async () => {},
    capturePane: async () => '',
    paneMetrics: async () => ({ activity: 1 }),
    readTranscript: async (args) => { calls.push(['transcript', args]); return transcript; },
    readWorkspaceTree: async (args) => { calls.push(['tree', args]); return tree || { path: args.relative || '', entries: [], truncated: false }; },
    readWorkspaceFile: async (args) => { calls.push(['file', args]); return file || { path: args.relative, text: 'x', size: 1, binary: false, truncated: false }; },
    writeInboxFile: async (args) => { calls.push(['inbox', args]); return inbox || { name: args.filename, bytes: args.buffer.length, path: `/w/Demo/_inbox/${args.filename}` }; },
    audit: async (event, detail) => calls.push(['audit', event, detail]),
  });
  return { engine, calls };
}

test('a transcript is read from the ACTING account and says how it found the session', async () => {
  const { engine, calls } = extendedHarness({
    transcript: { session_id: 'abc-123', resolved_by: 'most-recent',
      messages: [{ role: 'user', text: 'fix the test' }, { role: 'assistant', text: 'done' }] },
  });
  const out = await engine.transcript(BOT, { project: 'Demo', session: 'bot-lane', messages: 5 });

  assert.deepEqual(calls[0][1], { project: 'Demo', projectPath: '/w/Demo', actsAs: 'kev', sessionIdHint: '', messages: 5 },
    "one launcher's transcripts are not another's to read");
  assert.equal(out.resolved_by, 'most-recent',
    'with two lanes in one project this may be the other one: said, not hidden');
  assert.equal(out.messages.length, 2);
  const [, event, detail] = calls.find(([kind]) => kind === 'audit');
  assert.equal(event, 'agent_transcript');
  assert.equal(detail.messages, 2);
  assert.equal(JSON.stringify(detail).includes('fix the test'), false, 'the audit counts messages, it does not keep them');

  const none = extendedHarness({ transcript: null });
  await fails(none.engine.transcript(BOT, { project: 'Demo', session: 'bot-lane' }), 'no_transcript');
  const bounded = extendedHarness({ transcript: { messages: [] } });
  await bounded.engine.transcript(BOT, { project: 'Demo', session: 'bot-lane', messages: 9999 });
  assert.equal(bounded.calls[0][1].messages, 200, 'a transcript request is capped');
});

test('workspace reads pass the caller path through to the confined worker, and audit it without contents', async () => {
  const { engine, calls } = extendedHarness({ file: { path: 'app/server.js', text: 'secret-looking source', size: 21, binary: false, truncated: false } });
  await engine.tree(BOT, { project: 'Demo', path: 'app' });
  assert.deepEqual(calls[0], ['tree', { project: 'Demo', relative: 'app', maxEntries: undefined }]);

  const read = await engine.file(BOT, { project: 'Demo', path: 'app/server.js', max_bytes: 100 });
  assert.equal(read.text, 'secret-looking source');
  const audit = calls.filter(([kind]) => kind === 'audit').map(([, event, detail]) => [event, detail]);
  const [, readDetail] = audit.find(([event]) => event === 'agent_workspace_read');
  assert.deepEqual([readDetail.path, readDetail.bytes], ['app/server.js', 21]);
  assert.equal(JSON.stringify(readDetail).includes('secret-looking source'), false,
    'the audit answers what was read, not what it said');

  await fails(engine.file(BOT, { project: 'Demo', path: '' }), 'path_required');
});

test('the inbox write is the only write, is bounded, and says what to do next', async () => {
  const { engine, calls } = extendedHarness();
  const out = await engine.putInbox(BOT, { project: 'Demo', filename: 'spec.md', content: '# plan\n' });
  assert.equal(out.name, 'spec.md');
  assert.match(out.path, /_inbox\/spec\.md$/);
  assert.match(out.hint, /Tell the session to read/,
    'a file is not work until something is told to look at it');
  assert.equal(calls[0][1].buffer.toString('utf8'), '# plan\n');

  const b64 = extendedHarness();
  await b64.engine.putInbox(BOT, { project: 'Demo', filename: 'blob.bin', content: Buffer.from([1, 2, 3]).toString('base64'), base64: true });
  assert.deepEqual([...b64.calls[0][1].buffer], [1, 2, 3]);

  for (const bad of ['../escape', '/etc/passwd', 'has space', '.hidden', '']) {
    await fails(engine.putInbox(BOT, { project: 'Demo', filename: bad, content: 'x' }), 'invalid_filename');
  }
  await fails(engine.putInbox(BOT, { project: 'Demo', filename: 'empty.txt', content: '' }), 'empty_file');
  await fails(engine.putInbox(BOT, { project: 'Demo', filename: 'huge.bin', content: 'x'.repeat(9 * 1024 * 1024) }), 'file_too_large');
});
