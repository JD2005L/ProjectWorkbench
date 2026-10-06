// Turn outcomes (app/turn-outcome.js): reading how a Claude turn ended, asking TypeSafe AI's Jev,
// and turning the decision into tab/rail state and a Hermes action contract.
//
// The invariant every test here protects in one way or another: an outcome only ever REFINES the
// amber bell. Anything undecided, unconfident, invalid or not decided by Jev must come out as null,
// which the UI renders exactly as it did before outcomes existed — and a decision never authorizes
// anything; it only changes a colour and who is told.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lastAssistantTurn, transcriptDirName, readTurnTails, evaluateTurn, validateDecision, createTurnTriage,
  hermesEvent, turnIdentity, CRITERIA, INTERVENTION_CRITERIA, OUTCOMES, INTERVENTIONS, MIN_CONFIDENCE,
  DECISION_SCHEMA, MODEL, turnOutcomeOptedIn,
} from '../app/turn-outcome.js';
import { normalizedDigest, turnContext, requestedAction, TRUNCATION_MARKER } from '../app/turn-context.js';
import { createTurnOutbox } from '../app/turn-outbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = () => fs.readFileSync(path.join(here, '..', 'app', 'server.js'), 'utf8');
const line = (o) => JSON.stringify(o);
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SID = '11111111-2222-4333-8444-555555555555';
const assistantText = (uuid, text) => line({ type: 'assistant', uuid, timestamp: '2026-10-05T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const assistantTool = (uuid) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const toolResult = () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const human = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const ALNUM = 'aB3dE9fG2hJ7kL4mN8pQ1rS6tU5vW0xY';
const fakeGhToken = () => ['gh', 'p_', ALNUM, 'zZ9y'].join('');
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const tmpDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };

// ---------------------------------------------------------------- opt-in

test('turn outcomes are off unless an instance explicitly says yes (GOA must never get them by upgrading)', () => {
  for (const off of [undefined, '', 'off', 'OFF', 'no', 'false', '0', 'onn', ' maybe ']) {
    assert.equal(turnOutcomeOptedIn({ PW_TURN_OUTCOME: off }), false, String(off));
  }
  assert.equal(turnOutcomeOptedIn({}), false);
  for (const on of ['on', 'ON', ' on ', 'true', '1', 'yes']) assert.equal(turnOutcomeOptedIn({ PW_TURN_OUTCOME: on }), true, on);
});

test('the dashboard gates every turn-outcome path on the explicit opt-in, not on the key file', () => {
  const src = serverSrc();
  assert.match(src, /const TURN_OUTCOME_ENABLED = turnOutcomeOptedIn\(process\.env\);/);
  assert.match(src, /async function readGatewayKey\(\)\{\n if\(!TURN_OUTCOME_ENABLED\) return '';/);
  assert.match(src, /function turnOutcomeOn\(\)\{\n if\(!TURN_OUTCOME_ENABLED\) return false;/);
  // every caller goes through turnOutcomeOn(); nothing observes or annotates without it
  const observes = src.match(/turnTriage\.(observe|annotate|projectOutcome|projectAsk)\(/g) || [];
  assert.equal(observes.length, 4);
  for (const call of ['turnTriage.observe(project, windows)', 'turnTriage.projectOutcome(p.name, ws)', 'turnTriage.projectAsk(p.name, ws)']) {
    const at = src.indexOf(call);
    assert.ok(at > 0 && src.lastIndexOf('turnOutcomeOn()', at) > at - 200, `${call} must sit behind turnOutcomeOn()`);
  }
  // The outbox — and with it every Hermes delivery — exists only on an instance opted into BOTH.
  assert.match(src, /const turnOutbox = \(TURN_OUTCOME_ENABLED && TURN_OUTCOME_HERMES\) \? createTurnOutbox\(/);
});

// ---------------------------------------------------------------- transcript reading

test('a transcript ending on assistant text yields that turn and the request that started it', () => {
  const raw = [human('fix it'), assistantTool('a1'), toolResult(), assistantText('a2', 'Fixed. Want me to deploy?')].join('\n') + '\n';
  assert.deepEqual(lastAssistantTurn(raw), { uuid: 'a2', text: 'Fixed. Want me to deploy?', at: '2026-10-05T00:00:00Z', userText: 'fix it' });
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
    human('please tidy up'),
    assistantText('a1', 'All finished.'),
    line({ type: 'system', subtype: 'stop_hook_summary' }),
    line({ type: 'assistant', uuid: 'a0', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>…' } }),
    line({ type: 'user', message: { content: '<local-command-stdout>Set model</local-command-stdout>' } }),
    'not json',
  ].join('\n');
  assert.equal(lastAssistantTurn(raw)?.uuid, 'a1');
  assert.equal(lastAssistantTurn(raw)?.userText, 'please tidy up');
});

test('the latest request is the person\'s own words: past tool results, skill expansions, interrupts and compaction', () => {
  const raw = [
    human('an older request'),
    assistantText('a0', 'Done with the older one.'),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Deploy the fix.' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] } }),
    line({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: …' }] } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    line({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } }),
    assistantTool('a1'), toolResult(),
    line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'thinking', thinking: '…' }] } }),
    assistantText('a3', 'I need the deploy key rotated.'),
  ].join('\n');
  const turn = lastAssistantTurn(raw);
  assert.equal(turn.uuid, 'a3');
  assert.equal(turn.userText, 'Deploy the fix.');
  // A slash command's own arguments are the request; a bare one is not.
  const cmd = [
    human('<command-message>goal-loop is running…</command-message>\n<command-name>/goal-loop</command-name>\n<command-args>Harden the relay</command-args>'),
    assistantText('a9', 'Plan ready. Approve?'),
  ].join('\n');
  assert.equal(lastAssistantTurn(cmd).userText, '/goal-loop Harden the relay');
  const bare = [human('<command-name>/compact</command-name>\n<command-args></command-args>'), assistantText('b1', 'Compacted.')].join('\n');
  assert.equal(lastAssistantTurn(bare).userText, null);
});

test('a thinking-only record after the final text does not hide it, and the whole message is kept for redaction', () => {
  const long = 'x'.repeat(5000) + 'END?';
  const raw = [assistantText('a1', long), line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'thinking', thinking: '…' }] } })].join('\n');
  const turn = lastAssistantTurn(raw);
  assert.equal(turn.uuid, 'a1');
  assert.equal(turn.text, long, 'not cut here: cutting before redaction is what leaked half-secrets');
});

test('transcript directories follow Claude\'s cwd rule', () => {
  assert.equal(transcriptDirName('/opt/project-workbench/workspaces/ProjectWorkbench'), '-opt-project-workbench-workspaces-ProjectWorkbench');
  assert.equal(transcriptDirName('/opt/x/.worktrees/a_b'), '-opt-x--worktrees-a-b');
});

// A fake /proc and Claude config dir: pane 100 -> shell 101 -> claude 102.
function fixture({ text = 'Blocked: I need the PAT rotated.', request = 'q' } = {}) {
  const root = tmpDir('turn-outcome-');
  const procfs = path.join(root, 'proc');
  const child = (pid, kids) => {
    fs.mkdirSync(path.join(procfs, pid, 'task', pid), { recursive: true });
    fs.writeFileSync(path.join(procfs, pid, 'task', pid, 'children'), kids.join(' '));
  };
  child('100', ['101']); child('101', ['102']); child('102', []);
  const claude = path.join(root, 'home', '.claude');
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'sessions', '102.json'), line({ pid: 102, sessionId: SID, cwd: '/opt/ws/Proj' }));
  const dir = path.join(claude, 'projects', '-opt-ws-Proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [human(request), assistantText(U(9), text)].join('\n') + '\n');
  return { root, procfs, claude, sid: SID, dir };
}

test('a pane is traced to its Claude through the process tree and the session registry', async () => {
  const fx = fixture();
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }, { key: 'none', panePid: '999' }, { key: 'bad', panePid: '1;rm' }] });
  assert.equal(out.k.sessionId, fx.sid);
  assert.equal(out.k.uuid, U(9));
  assert.deepEqual(Object.keys(out.k).sort(), ['assistant', 'at', 'digest', 'sessionId', 'user', 'uuid']);
  assert.equal(out.k.assistant, 'Blocked: I need the PAT rotated.');
  assert.equal(out.k.user, 'q');
  assert.equal(out.k.digest, normalizedDigest('Blocked: I need the PAT rotated.'));
  assert.equal(out.none, null);
  assert.equal(out.bad, null);
});

test('what leaves the helper is redacted and bounded — never the raw message', async () => {
  const secret = fakeGhToken();
  const text = 'w'.repeat(4000) + ` token ${secret} was rejected.\n\nCan you rotate it?`;
  const fx = fixture({ text, request: `use password: Hunter2-Correct-Horse and ${secret}` });
  const out = (await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }] })).k;
  const leaked = JSON.stringify(out);
  assert.equal(leaked.includes(ALNUM), false);
  assert.equal(leaked.includes('Hunter2'), false);
  assert.ok(out.assistant.startsWith(TRUNCATION_MARKER));
  assert.ok(out.assistant.endsWith('Can you rotate it?'));
});

test('a transcript whose ids are not the shapes Claude writes yields nothing', async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.dir, `${fx.sid}.jsonl`), [human('q'), assistantText('not-a-uuid', 'Should I?')].join('\n') + '\n');
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }] });
  assert.equal(out.k, null);
});

test('a transcript the cwd rule does not find is looked for rather than guessed', async () => {
  const fx = fixture();
  fs.renameSync(fx.dir, path.join(fx.claude, 'projects', 'somewhere-else'));
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], panes: [{ key: 'k', panePid: '100' }] });
  assert.equal(out.k?.uuid, U(9));
});

test('a pane with a credential identity is read from that person\'s own tree first', async () => {
  const fx = fixture();
  const mine = path.join(fx.root, 'pw-users', 'alice', 'claude');
  fs.mkdirSync(path.join(mine, 'sessions'), { recursive: true });
  const sid = '99999999-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(mine, 'sessions', '102.json'), line({ sessionId: sid, cwd: '/opt/ws/Proj' }));
  fs.mkdirSync(path.join(mine, 'projects', '-opt-ws-Proj'), { recursive: true });
  fs.writeFileSync(path.join(mine, 'projects', '-opt-ws-Proj', `${sid}.jsonl`), assistantText(U(77), 'Done.') + '\n');
  const out = await readTurnTails({ fsp, procfs: fx.procfs, claudeDirs: [fx.claude], perUserDir: () => mine, panes: [{ key: 'k', panePid: '100', credUser: 'alice' }] });
  assert.equal(out.k.uuid, U(77));
  assert.equal(out.k.sessionId, sid);
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

test('one pane that cannot be read does not cost the others their answer', async () => {
  const fx = fixture();
  const out = await readTurnTails({
    fsp, procfs: fx.procfs, claudeDirs: [fx.claude], perUserDir: (u) => { if (u === 'bad') throw new Error('odd name'); return fx.claude; },
    panes: [{ key: 'bad', panePid: '100', credUser: 'bad' }, { key: 'ok', panePid: '100' }],
  });
  assert.equal(out.bad, null);
  assert.equal(out.ok?.uuid, U(9));
});

// ---------------------------------------------------------------- the Jev decision

const dist = (keys, chosen, p) => Object.fromEntries(keys.map((k) => [k, k === chosen ? p : (1 - p) / (keys.length - 1)]));
function jevBody({ outcome = 'needs_input', p = 0.97, intervention = 'approval', ip = 0.9, conf = 0.95, iconf = 0.9, model = MODEL, finalProvider = 'typesafe-ai', iProbs = null } = {}) {
  return {
    answers: {
      outcome: { type: 'choice', choice: outcome, probabilities: dist(OUTCOMES, outcome, p), confidence: conf },
      intervention: { type: 'choice', choice: intervention, probabilities: iProbs || dist(INTERVENTIONS, intervention, ip), confidence: iconf },
    },
    model,
    providerMetadata: {
      typesafe: { confidence: { outcome: conf, intervention: iconf } },
      gateway: { routing: { originalModelId: MODEL, resolvedProvider: 'typesafe-ai', canonicalSlug: MODEL, finalProvider }, generationId: 'gen_01M497HHE1HR50EZ0YQKGP7N9E' },
    },
    usage: { inputTokens: 599, outputTokens: 125 },
  };
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });

test('the decision request is the documented /v1/evaluate call: Jev, structured state, two finite questions, ZDR, TypeSafe only', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return jsonResponse(200, jevBody()); };
  const out = await evaluateTurn({ fetchImpl, apiKey: 'k1', context: { assistant: 'Should I deploy?', user: 'Fix the bug.' } });
  assert.equal(seen.url, 'https://ai-gateway.vercel.sh/v1/evaluate');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error', 'the key is never carried through a redirect');
  assert.equal(seen.init.headers.Authorization, 'Bearer k1');
  assert.equal(seen.body.model, 'typesafe-ai/jev');
  assert.deepEqual(seen.body.state, { latest_user_request: 'Fix the bug.', final_assistant_message: 'Should I deploy?' });
  assert.deepEqual(Object.keys(seen.body.questions), ['outcome', 'intervention']);
  for (const q of Object.values(seen.body.questions)) { assert.equal(q.type, 'choice'); assert.equal(typeof q.instructions, 'string'); }
  assert.deepEqual(seen.body.questions.outcome.criteria, CRITERIA, 'the pilot\'s outcome definitions are unchanged');
  assert.deepEqual(Object.keys(seen.body.questions.outcome.criteria), ['needs_input', 'blocked', 'failed', 'working', 'done']);
  assert.deepEqual(Object.keys(seen.body.questions.intervention.criteria), ['answer', 'approval', 'credential_holder', 'deployment', 'manual_action', 'investigation', 'none']);
  assert.deepEqual(seen.body.questions.intervention.criteria, INTERVENTION_CRITERIA);
  assert.deepEqual(seen.body.providerOptions, { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } });
  assert.equal(out.ok, true);
  const d = out.decision;
  assert.deepEqual(
    { outcome: d.outcome, band: d.band, probability: d.probability, confidence: d.confidence, intervention: d.intervention, model: d.model, schema: d.schema, generationId: d.generationId },
    { outcome: 'needs_input', band: 'high', probability: 0.97, confidence: 0.95, intervention: 'approval', model: 'typesafe-ai/jev', schema: DECISION_SCHEMA, generationId: 'gen_01M497HHE1HR50EZ0YQKGP7N9E' },
  );
  assert.equal(typeof d.latencyMs, 'number');
  assert.match(DECISION_SCHEMA, /^pw-turn-decision\/2#[0-9a-f]{12}$/);
});

test('the user request is sent as an explicit null when there is none', async () => {
  let body;
  await evaluateTurn({ fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return jsonResponse(200, jevBody()); }, apiKey: 'k', context: { assistant: 'Done.', user: null } });
  assert.deepEqual(body.state, { latest_user_request: null, final_assistant_message: 'Done.' });
});

test('no key, a refused call, a malformed answer, a redirect or a network error all come back without an outcome', async () => {
  assert.deepEqual(await evaluateTurn({ fetchImpl: async () => { throw new Error('never called'); }, apiKey: '', context: { assistant: 'x', user: null } }), { ok: false, error: 'no_key' });
  assert.deepEqual(await evaluateTurn({ fetchImpl: async () => { throw new Error('never called'); }, apiKey: 'k', context: { assistant: '', user: null } }), { ok: false, error: 'no_state' });
  const refused = await evaluateTurn({ fetchImpl: async () => jsonResponse(403, { error: { message: 'Free tier', type: 'restricted' } }), apiKey: 'k', context: { assistant: 'x', user: null } });
  assert.deepEqual(refused, { ok: false, error: 'http_403' });
  const odd = await evaluateTurn({ fetchImpl: async () => jsonResponse(200, { answers: { outcome: { choice: 'maybe' } } }), apiKey: 'k', context: { assistant: 'x', user: null } });
  assert.equal(odd.ok, false);
  const down = await evaluateTurn({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, apiKey: 'k', context: { assistant: 'x', user: null } });
  assert.deepEqual(down, { ok: false, error: 'network' });
});

// [label, body tweak, expected { error } or { outcome, band, intervention }]
const VALIDATION = [
  ['a clean Jev decision', (b) => b, { outcome: 'needs_input', band: 'high', intervention: 'approval' }],
  ['0.85 is medium', (b) => jevBody({ p: 0.85 }), { outcome: 'needs_input', band: 'medium', intervention: 'approval' }],
  ['below 0.8 is uncertain amber', (b) => jevBody({ p: 0.79 }), { outcome: null, band: 'uncertain' }],
  ['a low TypeSafe confidence is uncertain amber', (b) => jevBody({ p: 0.97, conf: 0.55 }), { outcome: null, band: 'uncertain' }],
  ['another model answered', () => jevBody({ model: 'openai/gpt-5.4-nano' }), { error: 'not_jev' }],
  ['no model reported', (b) => { delete b.model; return b; }, { error: 'not_jev' }],
  ['routed to another provider', () => jevBody({ finalProvider: 'openai' }), { error: 'not_jev' }],
  ['a missing answer', (b) => { delete b.answers.intervention; return b; }, { error: 'bad_answers' }],
  ['an extra answer', (b) => { b.answers.extra = b.answers.outcome; return b; }, { error: 'bad_answers' }],
  ['answers as an array', (b) => { b.answers = [b.answers.outcome]; return b; }, { error: 'bad_answers' }],
  ['a score where a choice was asked', (b) => { b.answers.outcome = { type: 'score', score: 1 }; return b; }, { error: 'bad_answers' }],
  ['an unknown option', (b) => { b.answers.outcome.choice = 'maybe'; return b; }, { error: 'unknown_option' }],
  ['no distribution', (b) => { delete b.answers.outcome.probabilities; return b; }, { error: 'bad_distribution' }],
  ['an incomplete distribution', (b) => { delete b.answers.outcome.probabilities.done; return b; }, { error: 'bad_distribution' }],
  ['an extra option in the distribution', (b) => { b.answers.outcome.probabilities.maybe = 0; return b; }, { error: 'bad_distribution' }],
  ['NaN', (b) => { b.answers.outcome.probabilities.done = NaN; return b; }, { error: 'bad_distribution' }],
  ['negative', (b) => { b.answers.outcome.probabilities.done = -0.01; b.answers.outcome.probabilities.failed += 0.01; return b; }, { error: 'bad_distribution' }],
  ['above one', (b) => { b.answers.outcome.probabilities.needs_input = 1.2; return b; }, { error: 'bad_distribution' }],
  ['a sum that is not one', (b) => { b.answers.outcome.probabilities.done += 0.02; return b; }, { error: 'bad_distribution' }],
  ['a sum within the declared rounding', (b) => { b.answers.outcome.probabilities.done += 0.02; b.rounding = { probabilityDecimals: 1 }; return b; }, { outcome: 'needs_input', band: 'high', intervention: 'approval' }],
  ['undeclarable rounding', (b) => { b.rounding = { probabilityDecimals: 16 }; return b; }, { error: 'bad_rounding' }],
  ['fractional rounding', (b) => { b.rounding = { probabilityDecimals: 1.5 }; return b; }, { error: 'bad_rounding' }],
  ['a choice that is not the most probable', (b) => { b.answers.outcome.choice = 'done'; return b; }, { error: 'not_argmax' }],
  ['a TypeSafe confidence above one', (b) => { b.providerMetadata.typesafe.confidence.outcome = 1.5; return b; }, { error: 'bad_confidence' }],
  ['an answer confidence below zero', (b) => { b.answers.intervention.confidence = -1; return b; }, { error: 'bad_confidence' }],
  ['not an object', () => null, { error: 'bad_body' }],
  ['an array', () => [], { error: 'bad_body' }],
  // A calm display ("nothing needed from you") needs the intervention question to agree.
  ['done, but a person is probably needed', () => jevBody({ outcome: 'done', p: 0.99, intervention: 'answer', ip: 0.52, iProbs: { answer: 0.52, approval: 0.17, credential_holder: 0, deployment: 0, manual_action: 0.2, investigation: 0.09, none: 0.02 } }), { outcome: null, band: 'uncertain' }],
  ['done, and nothing is needed', () => jevBody({ outcome: 'done', p: 1, intervention: 'none', ip: 0.9 }), { outcome: 'done', band: 'high', intervention: 'none' }],
  ['done, probably nothing needed, kind unsure', () => jevBody({ outcome: 'done', p: 1, intervention: 'none', ip: 0.6 }), { outcome: 'done', band: 'high', intervention: 'unknown' }],
  ['a question with a confident "none" keeps attention but no kind', () => jevBody({ outcome: 'needs_input', p: 0.95, intervention: 'none', ip: 0.9 }), { outcome: 'needs_input', band: 'high', intervention: 'unknown' }],
  ['an unsure kind is unknown', () => jevBody({ intervention: 'deployment', ip: 0.6 }), { outcome: 'needs_input', band: 'high', intervention: 'unknown' }],
  ['an unconfident kind is unknown', () => jevBody({ intervention: 'deployment', iconf: 0.5 }), { outcome: 'needs_input', band: 'high', intervention: 'unknown' }],
];

test('a decision is only what Jev validly and confidently said; everything else is plain amber', () => {
  for (const [label, tweak, want] of VALIDATION) {
    const out = validateDecision(tweak(jevBody()));
    if (want.error) {
      assert.deepEqual(out, { ok: false, error: want.error }, label);
    } else {
      assert.equal(out.ok, true, `${label}: ${JSON.stringify(out)}`);
      for (const [k, v] of Object.entries(want)) assert.equal(out.decision[k], v, `${label}: ${k}`);
      assert.equal(out.decision.model, MODEL);
      assert.equal(out.decision.schema, DECISION_SCHEMA);
    }
  }
});

// ---------------------------------------------------------------- the per-window state

const settle = () => new Promise((r) => setImmediate(r));
async function flush() { for (let i = 0; i < 8; i++) await settle(); }
async function waitFor(cond, ms = 20000) {
  const until = Date.now() + ms;
  while (!cond()) { if (Date.now() > until) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
}

const tailOf = (n, assistant, extra = {}) => ({ sessionId: SID, uuid: U(n), at: '2026-10-05T00:00:00Z', digest: normalizedDigest(assistant), assistant, user: null, ...extra });
function verdict(outcome, { p = 0.97, intervention = outcome === 'done' || outcome === 'working' ? 'none' : 'answer', band } = {}) {
  const b = band || (p >= 0.95 ? 'high' : p >= MIN_CONFIDENCE ? 'medium' : 'uncertain');
  return { ok: true, decision: { outcome: b === 'uncertain' ? null : outcome, band: b, probability: p, confidence: null, intervention, interventionProbability: 0.9, interventionConfidence: null, model: MODEL, schema: DECISION_SCHEMA, generationId: null, latencyMs: 1 } };
}

function triageHarness({ tails = {}, answers = {}, relay = null, lookup = null, minConfidence, instance = 'pvi2' } = {}) {
  const calls = { tails: 0, evaluate: [], relay: [], logs: [] };
  let clock = 1000;
  const triage = createTurnTriage({
    readTails: async (panes) => { calls.tails++; return Object.fromEntries(panes.map((p) => [p.key, typeof tails === 'function' ? tails(p) : tails[p.panePid] || null])); },
    evaluate: async (ctx) => { calls.evaluate.push(ctx.assistant); return answers[ctx.assistant] || { ok: false, error: 'no_answer' }; },
    relay: relay ? async (item) => { calls.relay.push(item); return relay(item); } : null,
    lookupWindow: lookup,
    instance,
    log: (event, fields) => calls.logs.push({ event, ...fields }),
    now: () => clock,
    ...(minConfidence ? { minConfidence } : {}),
  });
  return { triage, calls, tick: (ms) => { clock += ms; } };
}
const win = (o) => ({ windowId: '@1', index: 1, name: 'claude', panePid: '100', bell: true, active: false, attached: 0, ...o });

test('a confident outcome refines the bell; an unconfident one leaves plain amber', async () => {
  const { triage } = triageHarness({
    tails: { 100: tailOf(1, 'Q?'), 200: tailOf(2, 'meh') },
    answers: { 'Q?': verdict('needs_input', { p: 0.96 }), meh: verdict('done', { p: MIN_CONFIDENCE - 0.01 }) },
  });
  const ws = [win({}), win({ windowId: '@2', panePid: '200' })];
  triage.observe('P', ws); await flush();
  const [a, b] = triage.annotate('P', ws);
  assert.equal(a.outcome, 'needs_input');
  assert.equal(b.outcome, null);
});

test('a decision the triage did not get from validation is still held to the confidence floor', async () => {
  const forged = { ok: true, decision: { ...verdict('done').decision, probability: 0.5, band: 'high' } };
  const { triage } = triageHarness({ tails: { 100: tailOf(1, 'x') }, answers: { x: forged } });
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, null);
});

test('a window is read once per bell, and the next bell is a new turn', async () => {
  let text = 'first';
  let n = 1;
  const { triage, calls } = triageHarness({
    tails: () => tailOf(n, text),
    answers: { first: verdict('done'), second: verdict('blocked') },
  });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', [win({})]); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 1);
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'done');
  triage.observe('P', [win({ bell: false })]); // viewed, then a new turn rings again
  assert.equal(triage.annotate('P', [win({ bell: false })])[0].outcome, null, 'no bell, no outcome');
  text = 'second'; n = 2;
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 2);
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'blocked');
});

test('a turn read mid-tool-call is retried a bounded number of times, spaced out', async () => {
  let ready = false;
  const { triage, calls, tick } = triageHarness({ tails: () => (ready ? tailOf(1, 'ok') : null), answers: { ok: verdict('done', { p: 0.9 }) } });
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

test('the same turn is never sent to the model twice', async () => {
  const { triage, calls } = triageHarness({ tails: () => tailOf(5, 'T'), answers: { T: verdict('done', { p: 0.9 }) } });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', [win({ bell: false })]);
  triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 2);
  assert.equal(calls.evaluate.length, 1);
});

test('a turn is identified within its project and Claude session, not by its message id alone', async () => {
  // A forked conversation repeats its parent's message uuids; another project can too.
  const other = '22222222-2222-4333-8444-555555555555';
  const { triage, calls } = triageHarness({
    tails: (p) => (p.panePid === '100' ? tailOf(5, 'Same words') : tailOf(5, 'Same words', { sessionId: other })),
    answers: { 'Same words': verdict('needs_input') },
    relay: async () => ({ status: 'enqueued' }),
  });
  triage.observe('P', [win({})]); await flush();
  triage.observe('Q', [win({ panePid: '200' })]); await flush();
  assert.equal(calls.evaluate.length, 2);
  assert.equal(calls.relay.length, 2);
  assert.notEqual(calls.relay[0].id, calls.relay[1].id);
  const a = turnIdentity({ instance: 'pvi2', project: 'P', sessionId: SID, uuid: U(5), digest: normalizedDigest('Same words') });
  const b = turnIdentity({ instance: 'pvi2', project: 'P', sessionId: other, uuid: U(5), digest: normalizedDigest('Same words') });
  const c = turnIdentity({ instance: 'goa', project: 'P', sessionId: SID, uuid: U(5), digest: normalizedDigest('Same words') });
  const d = turnIdentity({ instance: 'pvi2', project: 'P', sessionId: SID, uuid: U(5), digest: normalizedDigest('Other words') });
  assert.equal(new Set([a.correlationId, b.correlationId, c.correlationId, d.correlationId]).size, 4);
  assert.equal(calls.relay[0].id, a.correlationId);
  assert.match(a.correlationId, /^pwt1-[0-9a-f]{32}$/);
  assert.equal(turnIdentity({ instance: 'pvi2', project: 'P', sessionId: SID, uuid: U(5), digest: normalizedDigest('Same words') }).correlationId, a.correlationId, 'stable');
});

test('identifiers of the wrong shape are never relayed', async () => {
  const { triage, calls } = triageHarness({ tails: () => tailOf(1, 'Q?'), answers: { 'Q?': verdict('needs_input') }, relay: async () => ({ status: 'enqueued' }) });
  for (const project of ['-dash', 'x'.repeat(65), 'has space', '']) { triage.observe(project, [win({})]); await flush(); }
  triage.observe('P', [win({ windowId: 'bogus' })]); await flush();
  triage.observe('P', [win({ windowId: '@2', index: -1 })]); await flush();
  assert.equal(calls.relay.length, 0);
  assert.ok(calls.logs.filter((l) => l.event === 'suppressed' && l.reason === 'invalid_identifier').length >= 5);
});

test('a hibernated window is never read', async () => {
  const { triage, calls } = triageHarness({ tails: () => tailOf(1, 'T') });
  triage.observe('P', [win({ hibernated: true })]); await flush();
  assert.equal(calls.tails, 0);
});

test('a project shows its most urgent tab, and nothing calmer than an undecided one', async () => {
  const { triage } = triageHarness({
    tails: (p) => tailOf(Number(p.panePid), p.panePid),
    answers: { 1: verdict('done'), 2: verdict('blocked'), 3: verdict('working') },
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

test('the tab and the rail carry the safe requested action for a turn that needs someone, and only then', async () => {
  const ask = 'I could not push: the deploy key was rejected with 403 Forbidden.';
  const { triage } = triageHarness({
    tails: (p) => (p.panePid === '1' ? tailOf(1, `Committed locally.\n\n${ask}`) : tailOf(2, 'All done. Tests pass.')),
    answers: { [`Committed locally.\n\n${ask}`]: verdict('blocked', { intervention: 'credential_holder' }), 'All done. Tests pass.': verdict('done') },
  });
  const ws = [win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' })];
  triage.observe('P', ws); await flush();
  const [blocked, done] = triage.annotate('P', ws);
  assert.equal(blocked.outcomeAsk, ask);
  assert.equal(done.outcomeAsk, null);
  assert.equal(triage.projectAsk('P', ws), ask);
  assert.equal(triage.projectAsk('P', [ws[1]]), null);
  assert.equal(triage.annotate('P', ws.map((w) => ({ ...w, bell: false })))[0].outcomeAsk, null);
});

test('Hermes is told once per turn that needs someone, never while it is being watched, never for the rest', async () => {
  const { triage, calls } = triageHarness({
    tails: (p) => tailOf(Number(p.panePid), `text ${p.panePid}`),
    answers: { 'text 1': verdict('needs_input'), 'text 2': verdict('blocked', { intervention: 'deployment' }), 'text 3': verdict('done'), 'text 4': verdict('blocked', { p: 0.5 }), 'text 5': verdict('needs_input') },
    relay: async () => ({ status: 'enqueued' }),
  });
  const ws = [
    win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' }), win({ windowId: '@3', panePid: '3' }),
    win({ windowId: '@4', panePid: '4' }), win({ windowId: '@5', panePid: '5', active: true, attached: 1 }),
  ];
  triage.observe('P', ws); await flush();
  triage.observe('P', ws.map((w) => ({ ...w, bell: false })));
  triage.observe('P', ws); await flush();
  assert.deepEqual(calls.relay.map((r) => r.outcome).sort(), ['blocked', 'needs_input']);
  const blocked = calls.relay.find((r) => r.outcome === 'blocked');
  assert.equal(blocked.args.event_type, 'blocker');
  assert.equal(blocked.args.urgency, 'high');
  assert.equal(blocked.args.correlation_id, blocked.id);
  assert.equal(JSON.parse(blocked.args.evidence).intervention, 'deployment');
});

test('immediately before enqueueing, a fresh look at the window can still stop the relay', async () => {
  for (const [label, fresh, reason] of [
    ['watched now', win({ active: true, attached: 2 }), 'watched'],
    ['viewed now', win({ bell: false }), 'viewed'],
    ['closed now', null, 'window_gone'],
  ]) {
    const { triage, calls } = triageHarness({ tails: () => tailOf(1, 'Q?'), answers: { 'Q?': verdict('needs_input') }, relay: async () => ({ status: 'enqueued' }), lookup: async () => fresh });
    triage.observe('P', [win({})]); await flush();
    assert.equal(calls.relay.length, 0, label);
    assert.deepEqual(calls.logs.filter((l) => l.event === 'suppressed').map((l) => l.reason), [reason], label);
  }
});

test('the delivery-time recheck reads the window and its turn afresh', async () => {
  const id = turnIdentity({ instance: 'pvi2', project: 'P', sessionId: SID, uuid: U(1), digest: normalizedDigest('Q?') }).correlationId;
  const entry = { id, project: 'P', windowId: '@1', windowIndex: 1 };
  const cases = [
    ['still current', win({}), tailOf(1, 'Q?'), { deliver: true }],
    ['window gone', null, null, { deliver: false, reason: 'window_gone' }],
    ['viewed', win({ bell: false }), tailOf(1, 'Q?'), { deliver: false, reason: 'viewed' }],
    ['watched', win({ active: true, attached: 1 }), tailOf(1, 'Q?'), { deliver: false, reason: 'watched' }],
    ['hibernated', win({ hibernated: true }), tailOf(1, 'Q?'), { deliver: false, reason: 'hibernated' }],
    ['a newer turn', win({}), tailOf(2, 'Another question?'), { deliver: false, reason: 'superseded' }],
    ['mid-turn now', win({}), null, { deliver: false, reason: 'superseded' }],
  ];
  for (const [label, w, tail, want] of cases) {
    const { triage } = triageHarness({ tails: () => tail, lookup: async () => w });
    assert.deepEqual(await triage.recheck(entry), want, label);
  }
  const broken = createTurnTriage({ readTails: async () => { throw new Error('helper down'); }, evaluate: async () => null, lookupWindow: async () => win({}), instance: 'pvi2' });
  assert.deepEqual(await broken.recheck(entry), { retry: true, reason: 'tail_unreadable' });
});

test('more than 500 turns later, a turn that rings again is not relayed again (durable, not a cache)', async () => {
  const dir = tmpDir('turn-outcome-500-');
  let sends = 0;
  const statuses = [];
  // An in-process stand-in for the flock: this test is about what the ledger remembers.
  let chain = Promise.resolve();
  const serial = (_p, fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const outbox = createTurnOutbox({ file: path.join(dir, 'outbox.json'), send: async () => { sends++; return { ok: true, eventId: 'wbr-1' }; }, setTimer: () => null, clearTimer: () => {}, lock: serial });
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tailOf(Number(p.panePid), `ask ${p.panePid}?`)])),
    evaluate: async () => verdict('needs_input'),
    relay: async (item) => { const out = await outbox.enqueue(item); statuses.push(out.status); return out; },
    instance: 'pvi2',
  });
  for (let n = 1; n <= 520; n++) {
    triage.observe('P', [win({ windowId: `@${n}`, index: n, panePid: String(n) })]); await flush();
    triage.observe('P', []); // the tab closes; its state is forgotten
    if (n % 40 === 0) { await waitFor(() => statuses.length === n); await outbox.drain(); } // delivered as it goes
  }
  await waitFor(() => statuses.length === 520);
  await outbox.drain();
  assert.ok(statuses.every((st) => st === 'enqueued'));
  assert.equal(sends, 520);
  triage.observe('P', [win({ windowId: '@1', index: 1, panePid: '1' })]); await flush();
  await waitFor(() => statuses.length === 521);
  assert.equal(statuses[520], 'deduplicated');
  await outbox.drain();
  assert.equal(sends, 520, 'the first turn was not relayed a second time');
});

test('a failing enqueue is logged, never thrown into the window poll, and tried again on the next re-read', async () => {
  let down = true;
  const { triage, calls, tick } = triageHarness({ tails: () => tailOf(1, 'Q'), answers: { Q: verdict('needs_input') }, relay: async () => { if (down) throw new Error('relay down'); return { status: 'enqueued' }; } });
  triage.observe('P', [win({})]); await flush();
  assert.ok(calls.logs.some((l) => l.event === 'enqueue_failed' && l.error.includes('relay down')));
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'needs_input');
  down = false;
  tick(16000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.relay.length, 2, 'retried with the same turn');
  assert.equal(calls.relay[1].id, calls.relay[0].id);
  tick(16000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.relay.length, 2, 'and not again once it is in');
  assert.equal(calls.evaluate.length, 1, 'without asking the model again');
});

test('one window that throws does not strand the others in its batch', async () => {
  const logs = [];
  let first = true;
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tailOf(Number(p.panePid), p.panePid)])),
    evaluate: async (ctx) => { if (ctx.assistant === '1' && first) { first = false; throw new Error('boom'); } return verdict('done'); },
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  const ws = [win({ windowId: '@1', panePid: '1' }), win({ windowId: '@2', panePid: '2' })];
  triage.observe('P', ws); await flush();
  assert.equal(triage.annotate('P', ws)[1].outcome, 'done', 'the second window was still decided');
  assert.ok(logs.some((l) => String(l.error || '').includes('boom')));
});

test('REVIEW P1-1: a paused turn that resumes and ends again is re-read while its bell stays up', async () => {
  let tail = tailOf(1, 'CI is running; I will report back.');
  const { triage, calls, tick } = triageHarness({
    tails: () => tail,
    answers: { 'CI is running; I will report back.': verdict('working'), 'CI failed. Should I revert?': verdict('needs_input') },
    relay: async () => ({ status: 'enqueued' }),
  });
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'working');
  tail = tailOf(2, 'CI failed. Should I revert?'); // resumed and ended again; nobody viewed the tab
  tick(5000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.tails, 1, 'not re-read before the recheck interval');
  tick(11000); triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'needs_input');
  assert.deepEqual(calls.relay.map((r) => r.outcome), ['needs_input']);
  tick(16000); triage.observe('P', [win({})]); await flush();
  assert.equal(calls.evaluate.length, 2, 'an unchanged turn is not re-evaluated');
});

test('REVIEW (f448be0): a newer turn that cannot be decided falls back to amber, not the old outcome', async () => {
  let tail = tailOf(1, 'paused');
  let up = true;
  let clock = 0;
  const asked = [];
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tail])),
    evaluate: async (ctx) => { asked.push(ctx.assistant); return up ? verdict('working') : { ok: false, error: 'http_502' }; },
    now: () => clock,
  });
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'working');
  up = false; tail = tailOf(2, 'Should I revert?'); // resumed, ended on a question; the gateway is down
  clock += 16000; triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, null, 'the old "working" is gone');
  for (let i = 0; i < 6; i++) { clock += 6000; triage.observe('P', [win({})]); await flush(); }
  assert.equal(asked.filter((x) => x === 'Should I revert?').length, 3, 'retries stop at the cap');
});

test('a window closed while its bell was up is forgotten', async () => {
  const { triage, calls } = triageHarness({ tails: () => tailOf(1, 'T'), answers: { T: verdict('done', { p: 0.9 }) } });
  triage.observe('P', [win({})]); await flush();
  triage.observe('P', []); // the tab was closed
  triage.observe('P', [win({})]); await flush(); // a new window reusing the id is a new turn
  assert.equal(calls.tails, 2);
});

test('REVIEW P2-3: a decision that lands after its bell moved is dropped, not attached to the new bell', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let tail = tailOf(1, 'old');
  const triage = createTurnTriage({
    readTails: async (panes) => Object.fromEntries(panes.map((p) => [p.key, tail])),
    evaluate: async (ctx) => { if (ctx.assistant === 'old') await gate; return verdict(ctx.assistant === 'old' ? 'done' : 'blocked'); },
  });
  triage.observe('P', [win({})]); await flush();          // reading turn 1; the model is slow
  triage.observe('P', [win({ bell: false })]);              // viewed and replied
  tail = tailOf(2, 'new');
  triage.observe('P', [win({})]);                           // turn 2 rings while turn 1 is still with the model
  release(); await flush();
  // Turn 2 is read on its own (queued as soon as turn 1's read left flight); turn 1's
  // late "done" must never be what turn 2 shows.
  triage.observe('P', [win({})]); await flush();
  assert.equal(triage.annotate('P', [win({})])[0].outcome, 'blocked');
});

test('the triage logs what it detected and decided, with no message text', async () => {
  const { triage, calls } = triageHarness({ tails: () => tailOf(1, 'SECRET-TEXT Should I?'), answers: { 'SECRET-TEXT Should I?': verdict('needs_input') }, relay: async () => ({ status: 'enqueued' }) });
  triage.observe('P', [win({})]); await flush();
  const events = calls.logs.map((l) => l.event);
  assert.ok(events.includes('detected') && events.includes('evaluated'), events.join(','));
  const evaluated = calls.logs.find((l) => l.event === 'evaluated');
  assert.equal(evaluated.band, 'high');
  assert.equal(evaluated.outcome, 'needs_input');
  assert.equal(evaluated.model, MODEL);
  assert.equal(evaluated.schema, DECISION_SCHEMA);
  assert.equal(evaluated.probability, 0.97);
  assert.equal(typeof evaluated.latency_ms, 'number');
  const handed = calls.relay[0];
  assert.deepEqual([handed.decidedBy, handed.decisionSchema, handed.probability], [MODEL, DECISION_SCHEMA, 0.97]);
  assert.ok(!JSON.stringify(calls.logs).includes('SECRET-TEXT'));
});

// ---------------------------------------------------------------- what reaches Hermes

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const CORRELATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

test('Hermes gets a deterministic action contract — never the transcript tail', () => {
  const message = [
    'I refactored the upload module and added retries with jitter.',
    'Unrelated: the CHANGELOG had a typo in the 1.4 entry; fixed it.',
    `Also, the old token ${fakeGhToken()} is still in the CI settings.`,
    'Should I deploy this to staging now, or wait for the review?',
  ].join('\n\n');
  const ctx = turnContext({ assistantText: message, userText: 'Ship the retry fix.' });
  const decision = verdict('needs_input', { intervention: 'approval' }).decision;
  const ask = requestedAction(ctx.assistant, { outcome: 'needs_input' });
  const correlationId = turnIdentity({ instance: 'pvi2', project: 'Proj', sessionId: SID, uuid: U(3), digest: ctx.digest }).correlationId;
  const input = { project: 'Proj', window: { index: 3, name: 'claude side\u202E' }, decision, ask, at: '2026-10-05T01:02:03Z', correlationId };
  const ev = hermesEvent(input);
  assert.deepEqual(hermesEvent(input), ev, 'deterministic');
  assert.deepEqual(Object.keys(ev).sort(), ['correlation_id', 'event_type', 'evidence', 'project', 'session', 'summary', 'urgency']);
  assert.equal(ev.event_type, 'question');
  assert.equal(ev.urgency, 'normal');
  assert.equal(ev.correlation_id, correlationId);
  assert.match(ev.project, PROJECT_RE);
  assert.match(ev.session, SESSION_RE);
  assert.equal(ev.session, 'w3-claude-side');
  assert.match(ev.correlation_id, CORRELATION_RE);
  assert.ok(ev.summary.length <= 1000 && ev.evidence.length <= 4000);
  const contract = JSON.parse(ev.evidence);
  assert.deepEqual(Object.keys(contract), [
    'schema', 'project', 'window', 'outcome', 'intervention', 'requested_action', 'source_time',
    'confidence_band', 'decision_schema', 'decided_by', 'correlation_id', 'authority',
  ]);
  assert.deepEqual(contract, {
    schema: 'pw.turn-action/1', project: 'Proj', window: { index: 3, name: 'claude side' }, outcome: 'needs_input',
    intervention: 'approval', requested_action: 'Should I deploy this to staging now, or wait for the review?',
    source_time: '2026-10-05T01:02:03.000Z', confidence_band: 'high', decision_schema: DECISION_SCHEMA,
    decided_by: 'typesafe-ai/jev', correlation_id: correlationId, authority: 'none',
  });
  const all = ev.summary + ev.evidence;
  for (const absent of ['CHANGELOG', 'refactored', 'CI settings', ALNUM, 'Ship the retry']) assert.ok(!all.includes(absent), absent);
  assert.ok(ev.summary.includes('Should I deploy this to staging now'));
});

test('a blocker is high urgency, and a missing ask or time is explicit rather than invented', () => {
  const decision = verdict('blocked', { intervention: 'credential_holder' }).decision;
  const ev = hermesEvent({ project: 'P', window: { index: 0, name: '' }, decision, ask: null, at: 'not a time', correlationId: `pwt1-${'a'.repeat(32)}` });
  assert.equal(ev.event_type, 'blocker');
  assert.equal(ev.urgency, 'high');
  assert.equal(ev.session, 'w0');
  const c = JSON.parse(ev.evidence);
  assert.equal(c.requested_action, null);
  assert.equal(c.source_time, null);
  assert.equal(c.intervention, 'credential_holder');
});

// ---------------------------------------------------------------- the dashboard wiring

test('the dashboard never claims Hermes was told without the outbox\'s proof', () => {
  const src = serverSrc();
  assert.equal(src.includes('told Hermes'), false);
  // Exactly one relay client, built inside relayTurnToHermes, which is only ever the outbox's sender.
  assert.equal((src.match(/createHermesRelay\(/g) || []).length, 1);
  const fn = src.indexOf('async function relayTurnToHermes(');
  const client = src.indexOf('createHermesRelay(', fn);
  assert.ok(fn > 0 && client > fn && client < fn + 700, 'the client is built in relayTurnToHermes');
  assert.deepEqual(src.match(/relayTurnToHermes\b[^(]/g), ['relayTurnToHermes,'], 'and handed only to the outbox');
  assert.match(src, /send: relayTurnToHermes,/);
});

test('the requested-action excerpt reaches only people who can already open that terminal', () => {
  const src = serverSrc();
  assert.match(src, /outcomeAsk: TERMINAL_ROLES\.has\(req\.user\.role\) \? \(sig\.outcomeAsk \|\| null\) : null/);
  // the per-window listing that carries outcomeAsk is behind requireTerminalAccess
  assert.match(src, /app\.get\(BASE \+ '\/api\/term\/:project\/windows', requireTerminalAccess,/);
});

test('the tab and rail tooltips show the excerpt as text, beside the colours they always had', () => {
  const src = serverSrc();
  assert.match(src, /tab\.title=[^;]*OUTCOME_TIP\[outc\]/);
  // In server.js's template literal, '\\n' becomes the tooltip's line break in the served script.
  assert.match(src, /OUTCOME_TIP\[outc\]\?OUTCOME_TIP\[outc\]\+\(w\.outcomeAsk\?'\\\\n\\u201C'\+w\.outcomeAsk\+'\\u201D':''\)/);
  assert.match(src, /if\(p\.outcomeAsk&&lit\)key\.title=/);
  assert.match(src, /else key\.removeAttribute\('title'\)/);
  assert.equal((src.match(/innerHTML[^;]*outcomeAsk/g) || []).length, 0, 'never parsed as HTML');
});

test('shutdown hands leases back only on an instance that runs the outbox', () => {
  const src = serverSrc();
  assert.match(src, /if\(turnOutbox\)\{[\s\S]{0,600}process\.once\(sig,/);
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
