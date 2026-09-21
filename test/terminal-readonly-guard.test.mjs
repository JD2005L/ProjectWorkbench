// Typing into a tab that belongs to somebody else.
//
// A tab now carries the identity whose Claude/Copilot account it spends, and the tab
// strip is shared by everyone in the project — so typing into a teammate's tab spends
// their seat and lands in their agent's conversation, by accident, with nothing to
// stop it.
//
// What stops it is a guard in front of the websocket in app/terminal-preload.js. It is
// explicitly a GUARDRAIL and not a boundary: tmux can make a whole CLIENT read-only but
// has no per-window notion of writability, so per-tab is only expressible client-side,
// and anyone can step around it with devtools or by running `tmux attach` in a shell.
// Every pane on the box runs as one OS account regardless.
//
// Which makes the behaviour under FAILURE the most important thing here: it must fail
// OPEN. A guardrail that locks people out of their own terminal when a poll fails is
// worse than the mistake it prevents.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPreload } from './preload-harness.mjs';

const ME = 'kevin.charlebois';
const THEM = 'james.levac';

/** A fetch stub answering the two calls the guard makes, from a scripted state. */
function stubFetch(state) {
  return async (url) => {
    const json = () => {
      if (String(url).includes('/api/auth/me')) {
        if (state.whoFails) throw new Error('auth check unreachable');
        return { ok: true, user: { username: state.me, implicit: !!state.implicit } };
      }
      if (String(url).includes('/windows')) {
        if (state.windowsFail) throw new Error('window list unreachable');
        return { ok: true, windows: [{ index: 0, active: true, credUser: state.activeOwner }] };
      }
      throw new Error(`unexpected request: ${url}`);
    };
    return { json: async () => json() };
  };
}

async function harness(state) {
  const intervals = [];
  const h = loadPreload({ fetchImpl: stubFetch(state), intervals });
  // loadPreload runs the IIFE, which kicks off one immediate refresh; await the
  // microtasks it queued.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { ...h, intervals, refresh: () => h.window.__pwRefreshLock() };
}

test('input is dropped in a tab that belongs to somebody else', async () => {
  const h = await harness({ me: ME, activeOwner: THEM });
  assert.equal(h.window.__pwLockedBy(), THEM, 'the guard knows whose tab this is');

  const before = h.ws.sent.length;
  h.ws.send('0hello');                       // ttyd INPUT frame
  assert.equal(h.ws.sent.length, before, 'the keystrokes never reach the socket');

  // The drawer's paste path writes straight to the native send, so it has to be
  // gated separately rather than assumed to go through ws.send.
  assert.equal(h.window.__pwSendToTerminal('pasted text'), false, 'paste is refused too');
  assert.equal(h.ws.sent.length, before);
});

test('everything that is NOT input keeps flowing, or the terminal breaks instead of locking', async () => {
  const h = await harness({ me: ME, activeOwner: THEM });
  const before = h.ws.sent.length;
  h.ws.send('1{"columns":80,"rows":24}');    // RESIZE
  h.ws.send('2');                            // PAUSE
  h.ws.send('{"AuthToken":""}');             // ttyd handshake
  assert.equal(h.ws.sent.length, before + 3, 'resize, pause and handshake must pass through');
});

test('the page says WHY the typing went nowhere', async () => {
  // A swallowed keystroke with no explanation reads as a broken terminal, which is a
  // worse bug report than the accident this prevents.
  const h = await harness({ me: ME, activeOwner: THEM });
  const bar = h.bars.find((b) => String(b.textContent).includes('Read-only'));
  assert.ok(bar, `a read-only notice must be shown: ${h.bars.map((b) => b.textContent).join('|')}`);
  assert.match(bar.textContent, new RegExp(THEM), 'and name whose tab it is');
  assert.match(bar.textContent, /Open your own tab/, 'and say what to do instead');
  assert.equal(bar.style.display, 'block');
});

test('your own tab is never locked', async () => {
  const h = await harness({ me: ME, activeOwner: ME });
  assert.equal(h.window.__pwLockedBy(), '');
  const before = h.ws.sent.length;
  h.ws.send('0typing in my own tab');
  assert.equal(h.ws.sent.length, before + 1);
});

test('an unlabelled tab belongs to nobody, so it stays writable', async () => {
  // The shared box login, and any terminal that predates per-window labels. Locking
  // those would break every pre-upgrade session on the box.
  const h = await harness({ me: ME, activeOwner: '' });
  assert.equal(h.window.__pwLockedBy(), '');
  const before = h.ws.sent.length;
  h.ws.send('0still writable');
  assert.equal(h.ws.sent.length, before + 1);
});

test('FAILS OPEN: an unreadable window list or identity blocks nothing', async () => {
  for (const state of [
    { me: ME, activeOwner: THEM, windowsFail: true },
    { me: ME, activeOwner: THEM, whoFails: true },
    { me: '', activeOwner: THEM },                      // no identity resolved
    { me: ME, activeOwner: THEM, implicit: true },       // anonymous session
  ]) {
    const h = await harness(state);
    assert.equal(h.window.__pwLockedBy(), '', `must not lock when ${JSON.stringify(state)}`);
    const before = h.ws.sent.length;
    h.ws.send('0typing');
    assert.equal(h.ws.sent.length, before + 1, 'typing must still work');
  }
});

test('with no fetch at all the guard stays inert rather than throwing', async () => {
  // The guard loads on every terminal page; a browser or a test environment without
  // fetch must get a working terminal, not a dead script.
  const h = loadPreload({});
  assert.equal(h.window.__pwLockedBy(), '');
  const before = h.ws.sent.length;
  h.ws.send('0typing');
  assert.equal(h.ws.sent.length, before + 1);
});

test('the lock is re-evaluated as the active tab changes', async () => {
  // Selecting a tab is a shared action, so the lock has to follow the strip rather
  // than be decided once at load.
  const state = { me: ME, activeOwner: ME };
  const intervals = [];
  const h = loadPreload({ fetchImpl: stubFetch(state), intervals });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.window.__pwLockedBy(), '');
  assert.ok(intervals.length >= 1, 'the guard must keep polling, not decide once');

  state.activeOwner = THEM;
  await h.window.__pwRefreshLock();
  assert.equal(h.window.__pwLockedBy(), THEM, 'switching to their tab locks');

  state.activeOwner = ME;
  await h.window.__pwRefreshLock();
  assert.equal(h.window.__pwLockedBy(), '', 'and switching back unlocks');
});
