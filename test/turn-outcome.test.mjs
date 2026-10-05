// Turn outcomes (app/turn-outcome.js): reading how a Claude turn ended, asking the
// evaluation model, and turning that into tab/rail state and Hermes events.
//
// The invariant every test here protects in one way or another: an outcome only
// ever REFINES the amber bell. Anything undecided, unconfident or failed must come
// out as null, which the UI renders exactly as it did before outcomes existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lastAssistantTurn, transcriptDirName, readTurnTails, evaluateTurn, createTurnTriage,
  redactForRelay, hermesEvent, createHermesRelay, CRITERIA, MIN_CONFIDENCE, STATE_CHARS, turnOutcomeOptedIn,
} from '../app/turn-outcome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const line = (o) => JSON.stringify(o);
const assistantText = (uuid, text) => line({ type: 'assistant', uuid, timestamp: '2026-10-05T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const assistantTool = (uuid) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const toolResult = () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const human = (text) => line({ type: 'user', message: { role: 'user', content: text } });

// ---------------------------------------------------------------- opt-in

test('turn outcomes are off unless an instance explicitly says yes (GOA must never get them by upgrading)', () => {
  for (const off of [undefined, '', 'off', 'OFF', 'no', 'false', '0', 'onn', ' maybe ']) {
    assert.equal(turnOutcomeOptedIn({ PW_TURN_OUTCOME: off }), false, String(off));
  }
  assert.equal(turnOutcomeOptedIn({}), false);
  for (const on of ['on', 'ON', ' on ', 'true', '1', 'yes']) assert.equal(turnOutcomeOptedIn({ PW_TURN_OUTCOME: on }), true, on);
});

test('the dashboard gates every turn-outcome path on the explicit opt-in, not on the key file', () => {
  const src = fs.readFileSync(path.join(here, '..', 'app', 'server.js'), 'utf8');
  assert.match(src, /const TURN_OUTCOME_ENABLED = turnOutcomeOptedIn\(process\.env\);/);
  assert.match(src, /async function readGatewayKey\(\)\{\n if\(!TURN_OUTCOME_ENABLED\) return '';/);
  assert.match(src, /function turnOutcomeOn\(\)\{\n if\(!TURN_OUTCOME_ENABLED\) return false;/);
  // every caller goes through turnOutcomeOn(); nothing observes or annotates without it
  const observes = src.match(/turnTriage\.(observe|annotate|projectOutcome)\(/g) || [];
  assert.equal(observes.length, 3);
  for (const call of ['turnTriage.observe(project, windows)', 'turnTriage.projectOutcome(p.name, ws)']) {
    const at = src.indexOf(call);
    assert.ok(at > 0 && src.lastIndexOf('turnOutcomeOn()', at) > at - 200, `${call} must sit behind turnOutcomeOn()`);
  }
});

// ---------------------------------------------------------------- transcript reading

test('a transcript ending on assistant text yields that turn', () => {
  const raw = [human('fix it'), assistantTool('a1'), toolResult(), assistantText('a2', 'Fixed. Want me to deploy?')].join('\n') + '\n';
  assert.deepEqual(lastAssistantTurn(raw), { uuid: 'a2', text: 'Fixed. Want me to deploy?', at: '2026-10-05T00:00:00Z' });
});

test('a turn still mid-tool-call has no outcome yet', () => {
  assert.equal(lastAssistantTurn([human('go'), assistantTool('a1')].join('\n')), null);
  assert.equal(lastAssistantTurn([human('go'), assistantTool('a1'), toolResult()].join('\n')), null);
});

test('once the person has spoken again, the old turn is not the current one', () => {
  assert.equal(lastAssistantTurn([assistantText('a1', 'Done.'), human('now do X')].join('\n')), null);
});

test('records that are not conversation turns are looked past', () => {
  const raw = [
    assistantText('a1', 'All finished.'),
    line({ type: 'system', subtype: 'stop_hook_summary' }),
    line({ type: 'assistant', uuid: 'a0', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>…' } }),
    line({ type: 'user', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } }),
    'not json',
  ].join('\n');
  assert.equal(lastAssistantTurn(raw)?.uuid, 'a1');
});

test('a thinking-only record after the final text does not hide it; the state is the tail of a long message', () => {
  const long = 'x'.repeat(STATE_CHARS + 100) + 'END?';
  const raw = [assistantText('a1', long), line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'thinking', thinking: '…' }] } })].join('\n');
  const turn = lastAssistantTurn(raw);
  assert.equal(turn.uuid, 'a1');
  assert.equal(turn.text.length, STATE_CHARS);
  assert.ok(turn.text.endsWith('END?'));
});

test('transcript directories follow Claude\'s cwd rule', () => {
  assert.equal(transcriptDirName('/opt/project-workbench/workspaces/ProjectWorkbench'), '-opt-project-workbench-workspaces-ProjectWorkbench');
  assert.equal(transcriptDirName('/opt/x/.worktrees/a_b'), '-opt-x--worktrees-a-b');
});

// A fake /proc and Claude config dir: pane 100 -> shell 101 -> claude 102.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-outcome-'));
  const procfs = path.join(root, 'proc');
  const child = (pid, kids) => {
    fs.mkdirSync(path.join(procfs, pid, 'task', pid), { recursive: true });
    fs.writeFileSync(path.join(procfs, pid, 'task', pid, 'children'), kids.join(' '));
  };
  child('100', ['101']); child('101', ['102']); child('102', []);
  const claude = path.join(root, 'home', '.claude');
  const sid = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'sessions', '102.json'), line({ pid: 102, sessionId: sid, cwd: '/opt/ws/Proj' }));
  const dir = path.join(claude, 'projects', '-opt-ws-Proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [human('q'), assistantText('u9', 'Blocked: I need the PAT rotated.')].join('\n') + '\n');
  return { root, procfs, claude, sid, dir };
}

test('a pane is traced to its Claude through the process tree and the session registry', async () => {
  const fx = fixture();
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }, { key: 'none', panePid: '999' }, { key: 'bad', panePid: '1;rm' }] });
  assert.equal(out.k.sessionId, fx.sid);
  assert.equal(out.k.uuid, 'u9');
  assert.equal(out.none, null);
  assert.equal(out.bad, null);
});

test('a transcript the cwd rule does not find is looked for rather than guessed', async () => {
  const fx = fixture();
  fs.renameSync(fx.dir, path.join(fx.claude, 'projects', 'somewhere-else'));
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }] });
  assert.equal(out.k?.uuid, 'u9');
});

test('a pane with a credential identity is read from that person\'s own tree first', async () => {
  const fx = fixture();
  const mine = path.join(fx.root, 'pw-users', 'alice', 'claude');
  fs.mkdirSync(path.join(mine, 'sessions'), { recursive: true });
  const sid = '99999999-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(mine, 'sessions', '102.json'), line({ sessionId: sid, cwd: '/opt/ws/Proj' }));
  fs.mkdirSync(path.join(mine, 'projects', '-opt-ws-Proj'), { recursive: true });
  fs.writeFileSync(path.join(mine, 'projects', '-opt-ws-Proj', `${sid}.jsonl`), assistantText('mine', 'Done.') + '\n');
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], perUserDir: () => mine, panes: [{ key: 'k', panePid: '100', credUser: 'alice' }] });
  assert.equal(out.k.uuid, 'mine');
});

test('a symlinked transcript is not followed', async () => {
  const fx = fixture();
  const file = path.join(fx.dir, `${fx.sid}.jsonl`);
  const elsewhere = path.join(fx.root, 'target.jsonl');
  fs.renameSync(file, elsewhere);
  fs.symlinkSync(elsewhere, file);
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }] });
  assert.equal(out.k, null);
});

// ---------------------------------------------------------------- the model call

test('the evaluation request asks for zero retention, TypeSafe only, and the pilot\'s criteria', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ answers: { outcome: { type: 'choice', choice: 'needs_input', probabilities: { needs_input: 0.97, done: 0.03 } } } }) };
  };
  const out = await evaluateTurn({ fetchImpl, apiKey: 'k1', text: 'Should I deploy?' });
  assert.deepEqual(out, { outcome: 'needs_input', confidence: 0.97 });
  assert.equal(seen.url, 'https://ai-gateway.vercel.sh/v1/evaluate');
  assert.equal(seen.init.headers.Authorization, 'Bearer k1');
  assert.equal(seen.body.model, 'typesafe-ai/jev');
  assert.equal(seen.body.state, 'Should I deploy?');
  assert.deepEqual(seen.body.questions.outcome.criteria, CRITERIA);
  assert.deepEqual(seen.body.providerOptions, { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } });
});

test('no key, a refused call, a malformed answer or a network error all come back without an outcome', async () => {
  assert.equal(await evaluateTurn({ fetchImpl: async () => { throw new Error('never called'); }, apiKey: '', text: 'x' }), null);
  const refused = await evaluateTurn({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Free tier' } }) }), apiKey: 'k', text: 'x' });
  assert.deepEqual(refused, { error: 'Free tier' });
  const odd = await evaluateTurn({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: { outcome: { choice: 'maybe' } } }) }), apiKey: 'k', text: 'x' });
  assert.ok(odd.error);
  const down = await evaluateTurn({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, apiKey: 'k', text: 'x' });
  assert.deepEqual(down, { error: 'ECONNREFUSED' });
});

// ---------------------------------------------------------------- the per-window state

const settle = () => new Promise((r) => setImmediate(r));
async function flush() { for (let i = 0; i < 5; i++) await settle(); }

function triageHarness({ tails = {}, answers = {}, relay = null, minConfidence } = {}) {
  const calls = { tails: 0, evaluate: [], relay: [], logs: [] };
  let clock = 1000;
  const triage = createTurnTriage({
    readTails: async (panes) => { calls.tails++; return Object.fromEntries(panes.map((p) => [p.key, typeof tails === 'function' ? tails(p) : tails[p.panePid] || null])); },
    evaluate: async (text) => { calls.evaluate.push(text); return answers[text] || null; },
    relay: relay ? async (info) => { calls.relay.push(info); return relay(info); } : null,
    log: (m) => calls.logs.push(m),
    now: () => clock,
    ...(minConfidence ? { minConfidence } : {}),
  });
  return { triage, calls, tick: (ms) => { clock += ms; } };
}
const win = (o) => ({ windowId: '@1', index: 1, name: 'claude', panePid: '100', bell: true, active: false, attached: 0, ...o });

test('a confident outcome refines the bell; an unconfident one leaves plain amber', async () => {
  const { triage } = triageHarness({
    tails: { 100: { uuid: 'u1', text: 'Q?' }, 200: { uuid: 'u2', text: 'meh' } },
    answers: { 'Q?': { outcome: 'needs_input', confidence: 0.96 }, meh: { outcome: 'done', confidence: MIN_CONFIDENCE - 0.01 } },
  });
  const ws = [win({}), win({ windowId: '@2', panePid: '200' })];
  triage.observe('P', ws); await flush();
  const [a, b] = triage.annotate('P', ws);
  assert.equal(a.outcome, 'needs_input');
  assert.equal(b.outcome, null);
});

test('a window is read once per bell, and the next bell is a new turn', async () => {
  let text = 'first';
  const { triage, calls } = triageHarness({
    tails: () => ({ uuid: text, text }),
    answers: { first: { outcome: 'done', confidence: 0.99 }, second: { outcome: 'blocked', confidence: 0.99 } },
  });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', [win({})]); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 1);
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'done');
  triage.observe('P', [win({ bell: false })]); // viewed, then a new turn rings again
  assert.equal(triage.annotate('P', [win({ bell: false })])[0].outcome, null, 'no bell, no outcome');
  text = 'second';
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 2);
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'blocked');
});

test('a turn read mid-tool-call is retried a bounded number of times, spaced out', async () => {
  let ready = false;
  const { triage, calls, tick } = triageHarness({ tails: () => (ready ? { uuid: 'u', text: 'ok' } : null), answers: { ok: { outcome: 'done', confidence: 0.9 } } });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 1, 'not retried before the gap');
  tick(6000); ready = true;
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 2);
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'done');
  // a pane that never yields a turn stops being read after three tries
  const never = triageHarness({ tails: () => null });
  for (let i = 0; i < 6; i++) { never.triage.observe('P', [win({})]); await flush(); never.tick(6000); }
  assert.equal(never.calls.tails, 3);
});

test('the same message is never sent to the model twice', async () => {
  const { triage, calls } = triageHarness({ tails: () => ({ uuid: 'same', text: 'T' }), answers: { T: { outcome: 'done', confidence: 0.9 } } });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', [win({ bell: false })]);
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 2);
  assert.equal(calls.evaluate.length, 1);
});

test('a hibernated window is never read', async () => {
  const { triage, calls } = triageHarness({ tails: () => ({ uuid: 'u', text: 'T' }) });
  triage.observe('P', [win({ hibernated: true })]); await flush();
  assert.equal(calls.tails, 0);
});

test('a project shows its most urgent tab, and nothing calmer than an undecided one', async () => {
  const { triage } = triageHarness({
    tails: (p) => ({ uuid: p.panePid, text: p.panePid }),
    answers: { 1: { outcome: 'done', confidence: 0.99 }, 2: { outcome: 'blocked', confidence: 0.99 }, 3: { outcome: 'working', confidence: 0.99 } },
  });
  const ws = [win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' }), win({ windowId: '@3', panePid: '3' })];
  triage.observe('P', ws); await flush();
  assert.equal(triage.projectOutcome('P', ws), 'blocked');
  assert.equal(triage.projectOutcome('P', [ws[0], ws[2]]), 'done');
  assert.equal(triage.projectOutcome('P', [ws[2]]), 'working');
  assert.equal(triage.projectOutcome('P', [...ws, win({ windowId: '@4', panePid: '4' })]), null, 'an undecided rung tab makes it plain amber');
  // REVIEW P1-2: with no rung tab (a stray attach cleared the bells, the pending marker stands)
  // nothing remembered may make the project look calmer than plain amber.
  assert.equal(triage.projectOutcome('P', ws.map((w) => ({ ...w, bell: false }))), null);
});

test('Hermes hears once per turn that needs someone, never while it is being watched, never for the rest', async () => {
  const { triage, calls } = triageHarness({
    tails: (p) => ({ uuid: `u${p.panePid}`, text: p.panePid }),
    answers: { 1: { outcome: 'needs_input', confidence: 0.95 }, 2: { outcome: 'blocked', confidence: 0.95 }, 3: { outcome: 'done', confidence: 0.99 }, 4: { outcome: 'blocked', confidence: 0.5 }, 5: { outcome: 'needs_input', confidence: 0.99 } },
    relay: async () => true,
  });
  const ws = [
    win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' }), win({ windowId: '@3', panePid: '3' }),
    win({ windowId: '@4', panePid: '4' }), win({ windowId: '@5', panePid: '5', active: true, attached: 1 }),
  ];
  triage.observe('P', ws); await flush();
  triage.observe('P', ws.map((w) => ({ ...w, bell: false })));
  triage.observe('P', ws); await flush();
  assert.deepEqual(calls.relay.map((r) => r.outcome).sort(), ['blocked', 'needs_input']);
});

test('a failing relay is logged, never thrown into the window poll', async () => {
  const { triage, calls } = triageHarness({ tails: () => ({ uuid: 'u', text: 'Q' }), answers: { Q: { outcome: 'needs_input', confidence: 0.99 } }, relay: async () => { throw new Error('relay down'); } });
  triage.observe('P', [win({})]); await flush();
  assert.ok(calls.logs.some((m) => m.includes('relay down')));
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'needs_input');
});

test('one window that throws does not strand the others in its batch', async () => {
  const logs = [];
  let first = true;
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, { uuid: p.panePid, text: p.panePid }])),
    evaluate: async (text) => { if (text === '1' && first) { first = false; throw new Error('boom'); } return { outcome: 'done', confidence: 0.99 }; },
    log: (m) => logs.push(m),
  });
  const ws = [win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' })];
  triage.observe('P', ws); await flush();
  assert.equal(triage.annotate('P', ws)[1].outcome, 'done', 'the second window was still decided');
  assert.ok(logs.some((m) => m.includes('boom')));
});

test('REVIEW P1-1: a paused turn that resumes and ends again is re-read while its bell stays up', async () => {
  let tail = { uuid: 'u1', text: 'CI is running; I will report back.' };
  const { triage, calls, tick } = triageHarness({
    tails: () => tail,
    answers: { 'CI is running; I will report back.': { outcome: 'working', confidence: 0.97 }, 'CI failed. Should I revert?': { outcome: 'needs_input', confidence: 0.98 } },
    relay: async () => true,
  });
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'working');
  tail = { uuid: 'u2', text: 'CI failed. Should I revert?' }; // resumed and ended again; nobody viewed the tab
  tick(5000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 1, 'not re-read before the recheck interval');
  tick(11000); triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'needs_input');
  assert.deepEqual(calls.relay.map((r) => r.uuid), ['u2']);
  tick(16000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.evaluate.length, 2, 'an unchanged turn is not re-evaluated');
});

test('REVIEW (f448be0): a newer turn that cannot be decided falls back to amber, not the old outcome', async () => {
  let tail = { uuid: 'u1', text: 'paused' };
  let up = true;
  let clock = 0;
  const asked = [];
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tail])),
    evaluate: async (text) => { asked.push(text); return up ? { outcome: 'working', confidence: 0.97 } : { error: 'gateway down' }; },
    now: () => clock,
  });
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'working');
  up = false; tail = { uuid: 'u2', text: 'Should I revert?' }; // resumed, ended on a question; the gateway is down
  clock += 16000; triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, null, 'the old "working" is gone');
  for (let i = 0; i < 6; i++) { clock += 6000; triage.observe('P', [win({})]); await flush(); }
  assert.equal(asked.filter((x) => x === 'Should I revert?').length, 3, 'retries stop at the cap');
});

test('a window closed while its bell was up is forgotten', async () => {
  const { triage, calls } = triageHarness({ tails: () => ({ uuid: 'u', text: 'T' }), answers: { T: { outcome: 'done', confidence: 0.9 } } });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', []); // the tab was closed
  triage.observe('P', [win({})]); await flush(); // a new window reusing the id is a new turn
  assert.equal(calls.tails, 2);
});

test('REVIEW P2-3: a decision that lands after its bell moved is dropped, not attached to the new bell', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let tail = { uuid: 'old', text: 'old' };
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tail])),
    evaluate: async (text) => { if (text === 'old') await gate; return { outcome: text === 'old' ? 'done' : 'blocked', confidence: 0.99 }; },
  });
  triage.observe('P', [win({})]); await flush();          // reading turn 1; the model is slow
  triage.observe('P', [win({ bell: false })]);              // viewed and replied
  tail = { uuid: 'new', text: 'new' };
  triage.observe('P', [win({})]);                           // turn 2 rings while turn 1 is still with the model
  release(); await flush();
  // Turn 2 is read on its own (queued as soon as turn 1's read left flight); turn 1's
  // late "done" must never be what turn 2 shows.
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'blocked');
});

test('one pane that cannot be read does not cost the others their answer', async () => {
  const fx = fixture();
  const out = await readTurnTails({
    fsp, procfs: fx.procfs, claudeDirs: [fx.claude], perUserDir: (u) => { if (u === 'bad') throw new Error('odd name'); return fx.claude; },
    panes: [{ key: 'bad', panePid: '100', credUser: 'bad' }, { key: 'ok', panePid: '100' }],
  });
  assert.equal(out.bad, null);
  assert.equal(out.ok?.uuid, 'u9');
});

// ---------------------------------------------------------------- what reaches Hermes

test('credential shapes are removed before a message tail leaves the box', () => {
  const out = redactForRelay([
    'key vck_6Jn2UArVbZVYITvDOgndAskb and ghp_abcdefghijklmnopqrstuvwxyz0123',
    'password: hunter2  token=abc123',
    'Data Source=x;Password=2#gN=uVeL;Encrypt=True',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  ].join('\n'));
  for (const leaked of ['vck_6Jn2', 'ghp_abc', 'hunter2', 'abc123', '2#gN', 'BEGIN OPENSSH', 'eyJhbGci']) assert.ok(!out.includes(leaked), leaked);
});

test('a Hermes event names the project, tab and ask, and carries a stable correlation id', () => {
  const ev = hermesEvent({ project: 'P', window: 'claude', outcome: 'blocked', text: 'need password: x1', uuid: 'abc' });
  assert.equal(ev.event_type, 'blocker');
  assert.equal(ev.urgency, 'high');
  assert.equal(ev.correlation_id, 'pw-turn-abc');
  assert.ok(ev.summary.includes('P › claude'));
  assert.ok(!ev.evidence.includes('x1'));
  assert.equal(hermesEvent({ project: 'P', window: 'w', outcome: 'needs_input', text: '', uuid: 'u' }).event_type, 'question');
});

function fakeMcp({ sse = false, result = { content: [{ type: 'text', text: 'stored' }] } } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    seen.push({ url, msg, headers: init.headers });
    const reply = msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { protocolVersion: '2025-06-18' } : result };
    const body = reply === null ? '' : sse ? `event: message\ndata: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply);
    return { status: reply ? 200 : 202, headers: new Map([['content-type', sse ? 'text/event-stream' : 'application/json'], ['mcp-session-id', 's1']]), text: async () => body };
  };
  return { seen, fetchImpl };
}

test('the relay calls relay_workbench_event_to_hermes over MCP, JSON or SSE', async () => {
  for (const sse of [false, true]) {
    const { seen, fetchImpl } = fakeMcp({ sse });
    await createHermesRelay({ fetchImpl, url: 'http://authority/mcp', authorization: 'Bearer t' })({ project: 'P', session: 's', event_type: 'question', summary: 'x' });
    const call = seen.find((s) => s.msg.method === 'tools/call');
    assert.equal(call.msg.params.name, 'relay_workbench_event_to_hermes');
    assert.equal(call.msg.params.arguments.project, 'P');
    assert.equal(call.headers.Authorization, 'Bearer t');
    assert.equal(call.headers['Mcp-Session-Id'], 's1');
  }
  const { fetchImpl } = fakeMcp({ result: { isError: true, content: [{ type: 'text', text: 'refused: JWT' }] } });
  await assert.rejects(createHermesRelay({ fetchImpl, url: 'http://a/mcp', authorization: '' })({}), /refused: JWT/);
});

// ---------------------------------------------------------------- the helper job

test('the credential helper answers a turn-tail job (and a pane it cannot trace is null)', () => {
  const res = spawnSync(process.execPath, [path.join(here, '..', 'app', 'credential-writer.mjs')], {
    input: JSON.stringify({ action: 'turn-tail', panes: [{ key: 'k', panePid: '2147483646' }] }), encoding: 'utf8',
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true, res.stdout + res.stderr);
  assert.deepEqual(out.result, { k: null });
});
