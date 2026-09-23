// The turn latch (docs/agent-mcp.md phase 3).
//
// The two properties that are requirements rather than niceties: a human opening
// the tab cannot complete somebody else's turn, and a bell that predates the
// prompt cannot complete it either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTurns, TurnState, TURN_GRACE_MS } from '../app/agent-turns.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function store(time, options = {}) {
  let n = 0;
  return createAgentTurns({ now: time.now, newId: () => `t${++n}`, ...options });
}

const open = (turns, sample = {}) => turns.start({
  project: 'Demo', session: 'bot-lane', window: 3, tokenId: 'tok-1', actsAs: 'kev', sample,
});

test('a fresh bell completes the turn outright', () => {
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 100, bell: false, history: 20 });
  assert.equal(turn.state, TurnState.RUNNING);

  assert.equal(turns.observe(turn.turn_id, { activity: 101, working: true }).state, TurnState.RUNNING);
  const done = turns.observe(turn.turn_id, { activity: 105, bell: true, working: false });
  assert.equal(done.state, TurnState.COMPLETED);
  assert.equal(done.completed_by, 'bell');
  assert.ok(done.finished_at);
});

test('a bell that was ALREADY set when the prompt went in cannot complete the turn', () => {
  // The sample is taken before the paste precisely so somebody else's unread bell
  // is not mistaken for this turn ending.
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 100, bell: true });

  assert.equal(turns.observe(turn.turn_id, { activity: 100, bell: true, working: false }).state, TurnState.RUNNING);
  time.advance(TURN_GRACE_MS + 1000);
  assert.equal(turns.observe(turn.turn_id, { activity: 100, bell: true, working: false }).state, TurnState.RUNNING,
    'no work has been seen either, so there is nothing to have finished');

  // Once the stale bell is cleared (somebody viewed the window), the NEXT bell is
  // this turn's.
  turns.observe(turn.turn_id, { activity: 101, bell: false, working: true });
  const done = turns.observe(turn.turn_id, { activity: 102, bell: true, working: false });
  assert.equal(done.completed_by, 'bell');
});

test('a human opening the tab clears the bell and must not complete the turn', () => {
  // tmux clears window_bell_flag when the window is selected. A latch that waited
  // for `bell === true` would have its event erased by somebody looking; this one
  // falls back to the activity cadence, which viewing does not reset.
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 200, bell: false });

  turns.observe(turn.turn_id, { activity: 201, bell: false, working: true });
  time.advance(2000);
  // The human opens the tab mid-turn: bell cleared, work still going.
  assert.equal(turns.observe(turn.turn_id, { activity: 202, bell: false, working: true }).state, TurnState.RUNNING);
  time.advance(2000);
  assert.equal(turns.observe(turn.turn_id, { activity: 203, bell: false, working: true }).state, TurnState.RUNNING);

  // Work stops. The grace window has to pass before it counts as finished.
  time.advance(1000);
  assert.equal(turns.observe(turn.turn_id, { activity: 203, bell: false, working: false }).state, TurnState.RUNNING);
  time.advance(TURN_GRACE_MS);
  const done = turns.observe(turn.turn_id, { activity: 203, bell: false, working: false });
  assert.equal(done.state, TurnState.COMPLETED);
  assert.equal(done.completed_by, 'quiet', 'the fallback is the cadence, not the bell');
});

test('a turn never completes before any work is observed', () => {
  // The first sample after a paste can easily look idle — the CLI has not started
  // rendering yet. Completing there would report "finished" on a prompt that had
  // not begun.
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 300, bell: false });

  for (let i = 0; i < 5; i++) {
    time.advance(TURN_GRACE_MS);
    assert.equal(turns.observe(turn.turn_id, { activity: 300, bell: false, working: false }).state, TurnState.RUNNING);
  }
  assert.equal(turns.get(turn.turn_id).saw_work, false);

  turns.observe(turn.turn_id, { activity: 301, working: true });
  time.advance(TURN_GRACE_MS + 1);
  assert.equal(turns.observe(turn.turn_id, { activity: 301, working: false }).state, TurnState.COMPLETED);
});

test('a closed window ends the turn as gone rather than leaving it running forever', () => {
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 400 });
  turns.observe(turn.turn_id, { activity: 401, working: true });
  const gone = turns.observe(turn.turn_id, { missing: true });
  assert.equal(gone.state, TurnState.GONE);
  assert.equal(gone.completed_by, 'window-closed');
  // Terminal is terminal: a later sample does not resurrect it.
  assert.equal(turns.observe(turn.turn_id, { activity: 402, working: true }).state, TurnState.GONE);
});

test('the cursor a since-read needs is the history depth at injection', () => {
  const time = clock();
  const turns = store(time);
  const turn = open(turns, { activity: 500, history: 1234 });
  assert.deepEqual(turns.cursor(turn.turn_id), { historyAtStart: 1234, window: 3, session: 'bot-lane' });
  assert.equal(turns.cursor('nope'), null);
  assert.equal(turns.get('nope'), null);
  assert.equal(turns.observe('nope', {}), null);
});

test('old turns are pruned so a long-lived process does not accumulate them', () => {
  const time = clock();
  const turns = store(time, { keep: 3 });
  const ids = [];
  for (let i = 0; i < 6; i++) { time.advance(10); ids.push(open(turns).turn_id); }
  assert.equal(turns.size(), 3);
  assert.equal(turns.get(ids[0]), null, 'the oldest went');
  assert.ok(turns.get(ids.at(-1)), 'the newest stayed');
});
