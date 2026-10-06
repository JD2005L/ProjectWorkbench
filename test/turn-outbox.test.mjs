// Turn outbox (app/turn-outbox.js): the durable, cross-process delivery ledger for turns that need
// a person, and the strict MCP client that is the only thing allowed to mark one delivered.
//
// The invariants:
//   * one correlation ID is one ledger entry, however many producers or restarts see the turn;
//   * an entry is `delivered` only on a strict receiver acknowledgement — never on a 2xx alone;
//   * every retry resends the SAME correlation ID with byte-identical arguments, so a receiver
//     that committed before the reply was lost answers the retry with the event it already has.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTurnOutbox, createHermesRelay, createTurnLog } from '../app/turn-outbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'app');

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-outbox-'));
  made.push(dir);
  return { dir, file: path.join(dir, 'turn-outcome-outbox.json') };
}
const cid = (n) => `pwt1-${String(n).padStart(32, '0')}`;
const item = (n, extra = {}) => ({
  id: cid(n), project: 'Proj', windowId: `@${n}`, windowIndex: n, outcome: 'needs_input', intervention: 'answer', band: 'high',
  args: { project: 'Proj', session: `w${n}-claude`, event_type: 'question', summary: `Proj › claude: waiting (${n})`, evidence: `{"n":${n}}`, correlation_id: cid(n), urgency: 'normal' },
  ...extra,
});
const noTimers = { setTimer: () => null, clearTimer: () => {} };

function harness({ file, send, recheck = null, clock = { t: 1_000_000 }, ...opts }) {
  const logs = [];
  const outbox = createTurnOutbox({
    file, send, recheck, now: () => clock.t, log: (event, fields) => logs.push({ event, ...fields }), ...noTimers, ...opts,
  });
  return { outbox, logs, clock };
}
const ledger = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// Wait for the ledger to show a state, rather than for a fixed time: a claim is a flock(1) spawn
// plus an fsync'd write, which a loaded host can make arbitrarily slow.
async function ledgerState(file, id, state, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (ledger(file).entries[id]?.state === state) return; } catch { /* not written yet */ }
    if (Date.now() > until) throw new Error(`${id} never reached ${state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- the ledger

test('enqueue is idempotent per correlation ID and the ledger is private', async () => {
  const { file } = tmpLedger();
  const { outbox, logs } = harness({ file, send: async () => ({ ok: true, eventId: 'wbr-1' }) });
  assert.equal((await outbox.enqueue(item(1))).status, 'enqueued');
  assert.equal((await outbox.enqueue(item(1))).status, 'deduplicated');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const e = ledger(file).entries[cid(1)];
  assert.equal(e.state, 'pending');
  assert.equal(e.attempts, 0);
  assert.deepEqual(logs.map((l) => l.event), ['enqueued', 'deduplicated']);
});

test('restart between detection and delivery: a new process delivers what the old one recorded', async () => {
  const { file } = tmpLedger();
  const before = harness({ file, send: async () => { throw new Error('the old process never got this far'); } });
  await before.outbox.enqueue(item(7));
  // The old process is gone. A new one boots on the same ledger.
  const sent = [];
  const after = harness({ file, send: async (args) => { sent.push(args); return { ok: true, eventId: 'wbr-7' }; } });
  await after.outbox.drain();
  assert.deepEqual(sent, [item(7).args], 'the exact recorded arguments, same correlation ID');
  const e = ledger(file).entries[cid(7)];
  assert.equal(e.state, 'delivered');
  assert.equal(e.receiverEventId, 'wbr-7');
  assert.equal(e.args, undefined, 'the message excerpt is not retained once delivered');
});

test('two producer instances on one ledger enqueue once and deliver exactly once', async () => {
  const { file } = tmpLedger();
  const sent = [];
  const send = async (args) => { sent.push(args.correlation_id); await new Promise((r) => setTimeout(r, 5)); return { ok: true, eventId: `wbr-${args.correlation_id.slice(-4)}` }; };
  const a = harness({ file, send, ownerId: 'A' });
  const b = harness({ file, send, ownerId: 'B' });
  const statuses = await Promise.all([a.outbox.enqueue(item(1)), b.outbox.enqueue(item(1))]);
  assert.deepEqual(statuses.map((s) => s.status).sort(), ['deduplicated', 'enqueued']);
  for (let n = 2; n <= 12; n++) await Promise.all([a.outbox.enqueue(item(n)), b.outbox.enqueue(item(n))]);
  await Promise.all([a.outbox.drain(), b.outbox.drain()]);
  assert.equal(sent.length, 12, `sent ${sent.length}`);
  assert.equal(new Set(sent).size, 12);
  assert.ok(Object.values(ledger(file).entries).every((e) => e.state === 'delivered'));
});

test('two real processes on one ledger deliver each turn exactly once (kernel flock)', async () => {
  const { dir, file } = tmpLedger();
  const sentLog = path.join(dir, 'sent.log');
  const script = `
    import fs from 'node:fs';
    import { createTurnOutbox } from ${JSON.stringify(path.join(APP, 'turn-outbox.js'))};
    const file = ${JSON.stringify(file)};
    const outbox = createTurnOutbox({ file, setTimer: () => null, clearTimer: () => {}, log: () => {},
      send: async (args) => { fs.appendFileSync(${JSON.stringify(sentLog)}, args.correlation_id + '\\n'); await new Promise((r) => setTimeout(r, Math.random() * 8)); return { ok: true, eventId: 'wbr-x' }; } });
    const ids = Array.from({ length: 20 }, (_, i) => 'pwt1-' + String(i).padStart(32, '0'));
    for (const id of ids) await outbox.enqueue({ id, project: 'P', windowId: '@1', windowIndex: 1, outcome: 'blocked', intervention: 'deployment', band: 'high',
      args: { project: 'P', session: 'w1', event_type: 'blocker', summary: 's', evidence: 'e', correlation_id: id, urgency: 'high' } });
    await outbox.drain();
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${err}`))));
  });
  await Promise.all([run(), run()]);
  const lines = fs.readFileSync(sentLog, 'utf8').trim().split('\n');
  assert.equal(lines.length, 20, `sends: ${lines.length}`);
  assert.equal(new Set(lines).size, 20);
});

test('more than 500 delivered turns never let an old turn be relayed again', async () => {
  const { file } = tmpLedger();
  let sends = 0;
  const { outbox } = harness({ file, send: async () => { sends++; return { ok: true, eventId: 'wbr-a' }; }, lock: serialLock() });
  for (let n = 1; n <= 520; n++) { await outbox.enqueue(item(n)); await outbox.drain(); }
  assert.equal(sends, 520);
  assert.equal((await outbox.enqueue(item(1))).status, 'deduplicated');
  await outbox.drain();
  assert.equal(sends, 520);
});

// An in-process stand-in for the flock, for tests about the ledger's contents rather than its locking.
function serialLock() {
  let tail = Promise.resolve();
  return (_path, fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}

test('transport failures back off exponentially and recover with the same correlation ID', async () => {
  const { file } = tmpLedger();
  const seen = [];
  let failures = 3;
  const { outbox, clock, logs } = harness({ file, send: async (args) => { seen.push(JSON.stringify(args)); return failures-- > 0 ? { ok: false, error: 'network' } : { ok: true, eventId: 'wbr-9' }; } });
  await outbox.enqueue(item(9));
  const t0 = clock.t;
  await outbox.drain(); // attempt 1 fails
  assert.equal(ledger(file).entries[cid(9)].nextAttemptAt, t0 + 5000);
  clock.t = t0 + 4999; await outbox.drain();
  assert.equal(seen.length, 1, 'not before the backoff');
  clock.t = t0 + 5000; await outbox.drain(); // attempt 2 fails
  assert.equal(ledger(file).entries[cid(9)].nextAttemptAt, t0 + 5000 + 10000);
  clock.t = t0 + 15000; await outbox.drain(); // attempt 3 fails
  assert.equal(ledger(file).entries[cid(9)].nextAttemptAt, t0 + 15000 + 20000);
  clock.t = t0 + 35000; await outbox.drain(); // attempt 4 succeeds
  const e = ledger(file).entries[cid(9)];
  assert.equal(e.state, 'delivered');
  assert.equal(e.attempts, 4);
  assert.equal(new Set(seen).size, 1, 'every attempt sent byte-identical arguments');
  assert.deepEqual(logs.filter((l) => l.event === 'retried').map((l) => l.attempt), [1, 2, 3]);
  const accepted = logs.find((l) => l.event === 'accepted');
  assert.equal(accepted.receiver_event_id, 'wbr-9');
  assert.equal(accepted.correlation_id, cid(9));
  assert.equal(accepted.attempt, 4);
  assert.equal(typeof accepted.latency_ms, 'number');
});

test('attempts are bounded: the entry fails terminally and is never marked delivered', async () => {
  const { file } = tmpLedger();
  let sends = 0;
  const { outbox, clock, logs } = harness({ file, maxAttempts: 4, send: async () => { sends++; return { ok: false, error: 'not_accepted' }; } });
  await outbox.enqueue(item(3));
  for (let i = 0; i < 10; i++) { await outbox.drain(); clock.t += 600_000; }
  assert.equal(sends, 4);
  const e = ledger(file).entries[cid(3)];
  assert.equal(e.state, 'failed');
  assert.equal(e.lastError, 'not_accepted');
  assert.equal(logs.filter((l) => l.event === 'terminal_failure').length, 1);
  assert.equal(logs.some((l) => l.event === 'accepted'), false);
  // the delay is capped
  const delays = logs.filter((l) => l.event === 'retried').map((l) => l.next_retry_ms);
  assert.deepEqual(delays, [5000, 10000, 20000]);
});

test('a backoff never exceeds its cap', async () => {
  const { file } = tmpLedger();
  const { outbox, clock, logs } = harness({ file, maxAttempts: 12, send: async () => ({ ok: false, error: 'timeout' }) });
  await outbox.enqueue(item(4));
  for (let i = 0; i < 12; i++) { await outbox.drain(); clock.t += 10_000_000; }
  const delays = logs.filter((l) => l.event === 'retried').map((l) => l.next_retry_ms);
  assert.equal(Math.max(...delays), 300_000);
});

test('the delivery-time recheck suppresses a turn the person is now watching', async () => {
  const { file } = tmpLedger();
  let sends = 0;
  const { outbox, logs } = harness({ file, send: async () => { sends++; return { ok: true, eventId: 'wbr' }; }, recheck: async () => ({ deliver: false, reason: 'watched' }) });
  await outbox.enqueue(item(5));
  await outbox.drain();
  assert.equal(sends, 0);
  const e = ledger(file).entries[cid(5)];
  assert.equal(e.state, 'suppressed');
  assert.equal(e.suppressedReason, 'watched');
  assert.deepEqual(logs.filter((l) => l.event === 'suppressed').map((l) => l.reason), ['watched']);
});

test('a crashed sender\'s lease expires and the turn is retried with the same arguments', async () => {
  const { file } = tmpLedger();
  const clock = { t: 5_000_000 };
  const hung = harness({ file, clock, ownerId: 'dead', send: () => new Promise(() => {}) });
  await hung.outbox.enqueue(item(6));
  hung.outbox.drain(); // claims, then hangs forever: the process "crashed" mid-send
  await ledgerState(file, cid(6), 'sending');
  const sent = [];
  const fresh = harness({ file, clock, ownerId: 'new', send: async (args) => { sent.push(args); return { ok: true, eventId: 'wbr-6' }; } });
  await fresh.outbox.drain();
  assert.equal(sent.length, 0, 'not while the lease is live');
  clock.t += 61_000;
  await fresh.outbox.drain();
  assert.deepEqual(sent, [item(6).args]);
  assert.equal(ledger(file).entries[cid(6)].state, 'delivered');
});

test('shutdown hands this process\'s in-flight lease back so a restart retries at once', async () => {
  const { file } = tmpLedger();
  const clock = { t: 9_000_000 };
  const old = harness({ file, clock, ownerId: 'old', send: () => new Promise(() => {}) });
  await old.outbox.enqueue(item(8));
  old.outbox.drain();
  await ledgerState(file, cid(8), 'sending');
  await old.outbox.shutdown();
  const e = ledger(file).entries[cid(8)];
  assert.equal(e.state, 'pending');
  assert.equal(e.nextAttemptAt, clock.t);
  const sent = [];
  const next = harness({ file, clock, ownerId: 'next', send: async (args) => { sent.push(args); return { ok: true, eventId: 'wbr-8' }; } });
  await next.outbox.drain();
  assert.equal(sent.length, 1);
});

test('a late success after the lease moved on still records proof once, keeping the first event ID', async () => {
  const { file } = tmpLedger();
  const clock = { t: 1 };
  let release;
  const slow = harness({ file, clock, ownerId: 'slow', send: () => new Promise((r) => { release = () => r({ ok: true, eventId: 'wbr-late' }); }) });
  await slow.outbox.enqueue(item(2));
  const pending = slow.outbox.drain();
  await ledgerState(file, cid(2), 'sending');
  while (!release) await new Promise((r) => setTimeout(r, 5)); // the send has started
  clock.t += 61_000;
  const fast = harness({ file, clock, ownerId: 'fast', send: async () => ({ ok: true, eventId: 'wbr-first' }) });
  await fast.outbox.drain();
  release(); await pending;
  assert.equal(ledger(file).entries[cid(2)].receiverEventId, 'wbr-first');
});

test('terminal entries are pruned by age and count; pending ones never are', async () => {
  const { file } = tmpLedger();
  const clock = { t: 0 };
  const { outbox } = harness({ file, clock, maxEntries: 5, retentionMs: 1000, lock: serialLock(), send: async () => ({ ok: true, eventId: 'w' }) });
  for (let n = 1; n <= 8; n++) { await outbox.enqueue(item(n)); await outbox.drain(); clock.t += 10; }
  await outbox.enqueue(item(99)); // stays pending: no drain
  let entries = ledger(file).entries;
  assert.ok(Object.keys(entries).length <= 6);
  assert.equal(entries[cid(99)].state, 'pending');
  clock.t += 5000;
  await outbox.enqueue(item(100));
  entries = ledger(file).entries;
  assert.deepEqual(Object.keys(entries).sort(), [cid(100), cid(99)].sort());
});

test('a symlinked ledger is refused, not followed', async () => {
  const { dir, file } = tmpLedger();
  const target = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(target, '{"version":1,"entries":{}}');
  fs.symlinkSync(target, file);
  const { outbox } = harness({ file, send: async () => ({ ok: true, eventId: 'x' }) });
  await assert.rejects(outbox.enqueue(item(1)));
  assert.equal(fs.readFileSync(target, 'utf8'), '{"version":1,"entries":{}}');
});

test('logs are structured and never carry the message text', () => {
  const lines = [];
  const tlog = createTurnLog({ write: (line) => lines.push(line) });
  tlog.log('accepted', { correlation_id: cid(1), attempt: 2, latency_ms: 31, receiver_event_id: 'wbr-1', band: 'high', summary: 'SECRET-SUMMARY', evidence: 'SECRET-EVIDENCE', text: 'SECRET-TEXT' });
  tlog.log('retried', { correlation_id: cid(1), error: 'timeout', attempt: 1, next_retry_ms: 5000 });
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0].replace(/^\[turn-outcome\] /, ''));
  assert.deepEqual(first, { event: 'accepted', correlation_id: cid(1), attempt: 2, latency_ms: 31, receiver_event_id: 'wbr-1', band: 'high' });
  assert.ok(!lines.join('').includes('SECRET'));
  assert.equal(tlog.stats().accepted, 1);
  assert.equal(tlog.stats().retried, 1);
  // probabilities keep their precision; counters are summarised only when they moved
  tlog.log('evaluated', { probability: 0.97, confidence: 0.951234, model: 'typesafe-ai/jev', schema: 'pw-turn-decision/2#abc', latency_ms: 312.6 });
  assert.deepEqual(JSON.parse(lines[2].replace(/^\[turn-outcome\] /, '')), { event: 'evaluated', probability: 0.97, confidence: 0.951, model: 'typesafe-ai/jev', schema: 'pw-turn-decision/2#abc', latency_ms: 312.6 });
  tlog.logStats();
  assert.deepEqual(JSON.parse(lines[3].replace(/^\[turn-outcome\] /, '')), { event: 'stats', counts: { accepted: 1, retried: 1, evaluated: 1 } });
  tlog.logStats();
  assert.equal(lines.length, 4, 'nothing moved, nothing written');
});

test('a delivered entry keeps who decided it and how surely, and nothing of the message', async () => {
  const { file } = tmpLedger();
  const { outbox } = harness({ file, send: async () => ({ ok: true, eventId: 'wbr-77' }) });
  await outbox.enqueue(item(77, { decidedBy: 'typesafe-ai/jev', decisionSchema: 'pw-turn-decision/2#0123456789ab', probability: 0.97 }));
  await outbox.drain();
  const e = ledger(file).entries[cid(77)];
  assert.deepEqual(
    { decidedBy: e.decidedBy, decisionSchema: e.decisionSchema, probability: e.probability, receiverEventId: e.receiverEventId },
    { decidedBy: 'typesafe-ai/jev', decisionSchema: 'pw-turn-decision/2#0123456789ab', probability: 0.97, receiverEventId: 'wbr-77' },
  );
  for (const gone of ['args', 'leaseOwner', 'leaseUntil', 'nextAttemptAt', 'windowId']) assert.equal(Object.hasOwn(e, gone), false, gone);
});

test('an idle poll reads the ledger without taking the lock', async () => {
  const { file } = tmpLedger();
  let locks = 0;
  const counting = (p, fn) => { locks++; return serialLock()(p, fn); };
  const { outbox, clock } = harness({ file, lock: counting, send: async () => ({ ok: false, error: 'network' }) });
  await outbox.enqueue(item(5));
  await outbox.drain(); // attempt 1 fails: claim + finish
  const after = locks;
  for (let i = 0; i < 5; i++) await outbox.drain(); // nothing due yet
  assert.equal(locks, after, 'no lock while nothing is due');
  clock.t += 5000;
  await outbox.drain();
  assert.ok(locks > after);
});

// ---------------------------------------------------------------- the strict MCP client

// A pvi-authority stand-in: FastMCP's streamable HTTP in JSON-response mode, storing each event once
// per correlation ID. `mutate[phase](response, message, signal)` bends one reply out of shape.
function mcpServer({ session = 'sess-1', sse = false, structured = false, mutate = {}, store = new Map() } = {}) {
  const calls = [];
  let seq = 0;
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ url, init, msg });
    const headers = new Map([['content-type', sse ? 'text/event-stream' : 'application/json']]);
    if (session) headers.set('mcp-session-id', session);
    let phase; let reply = null; let status = 200;
    if (msg.method === 'initialize') {
      phase = 'initialize';
      reply = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pvi-authority', version: '1' } } };
    } else if (msg.method === 'notifications/initialized') {
      phase = 'initialized'; status = 202;
    } else if (msg.method === 'tools/call') {
      phase = 'call';
      const args = msg.params.arguments;
      let ev = store.get(args.correlation_id);
      const duplicate = !!ev;
      if (!ev) { ev = { event_id: `wbr-${(++seq).toString(16).padStart(20, '0')}`, args }; store.set(args.correlation_id, ev); }
      const payload = { ok: true, accepted: true, event_id: ev.event_id, duplicate, stored: true, correlation_id: args.correlation_id };
      reply = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false, ...(structured ? { structuredContent: { result: JSON.stringify(payload, null, 2) } } : {}) } };
    }
    const response = { status, headers, reply, body: undefined };
    if (mutate[phase]) await mutate[phase](response, msg, init.signal);
    const body = response.body !== undefined ? response.body
      : response.reply === null ? ''
      : sse ? `event: message\ndata: ${JSON.stringify(response.reply)}\n\n` : JSON.stringify(response.reply);
    return {
      status: response.status, ok: response.status >= 200 && response.status < 300, redirected: false, type: 'basic',
      headers: { get: (k) => response.headers.get(String(k).toLowerCase()) ?? null },
      text: async () => body,
    };
  };
  return { fetchImpl, calls, store };
}
const ARGS = item(42).args;
const relayWith = (server, opts = {}) => createHermesRelay({ fetchImpl: server.fetchImpl, url: 'http://authority.test/mcp', authorization: 'Bearer t', timeoutMs: 2000, ...opts });

test('a strict acknowledgement is proof: JSON or SSE, stateful or stateless, text or structured content', async () => {
  for (const variant of [{}, { sse: true }, { session: '' }, { structured: true }]) {
    const server = mcpServer(variant);
    const out = await relayWith(server)(ARGS);
    assert.equal(out.ok, true, JSON.stringify({ variant, out }));
    assert.match(out.eventId, /^wbr-[0-9a-f]{20}$/);
    const call = server.calls.find((c) => c.msg.method === 'tools/call');
    assert.equal(call.msg.params.name, 'relay_workbench_event_to_hermes');
    assert.deepEqual(call.msg.params.arguments, ARGS);
    assert.equal(call.init.headers.Authorization, 'Bearer t');
    assert.equal(call.init.redirect, 'manual', 'redirects are never followed');
    if (variant.session === '') assert.equal(call.init.headers['Mcp-Session-Id'], undefined);
    else assert.equal(call.init.headers['Mcp-Session-Id'], 'sess-1');
    assert.equal(call.init.headers['MCP-Protocol-Version'], '2025-06-18');
  }
});

const set = (fn) => fn;
const MALFORMED = [
  ['redirect on the tool call', { call: set((r) => { r.status = 307; r.headers.set('location', 'http://elsewhere/'); }) }, 'redirect'],
  ['204 for the tool call', { call: set((r) => { r.status = 204; r.reply = null; }) }, 'empty_body'],
  ['empty 200 body', { call: set((r) => { r.body = ''; }) }, 'empty_body'],
  ['non-JSON body', { call: set((r) => { r.body = 'OK'; }) }, 'bad_json'],
  ['html content type', { call: set((r) => { r.headers.set('content-type', 'text/html'); }) }, 'bad_content_type'],
  ['batch array', { call: set((r) => { r.body = JSON.stringify([r.reply]); }) }, 'not_jsonrpc'],
  ['jsonrpc 1.0', { call: set((r) => { r.reply.jsonrpc = '1.0'; }) }, 'not_jsonrpc'],
  ['wrong id', { call: set((r) => { r.reply.id = 'someone-else'; }) }, 'id_mismatch'],
  ['error object', { call: set((r) => { delete r.reply.result; r.reply.error = { code: -32603, message: 'boom' }; }) }, 'jsonrpc_error'],
  ['result and error both', { call: set((r) => { r.reply.error = { code: 1, message: 'x' }; }) }, 'not_jsonrpc'],
  ['MCP isError', { call: set((r) => { r.reply.result.isError = true; }) }, 'tool_error'],
  ['tool text not JSON', { call: set((r) => { r.reply.result.content = [{ type: 'text', text: 'stored' }]; }) }, 'bad_payload'],
  ['no content at all', { call: set((r) => { r.reply.result.content = []; }) }, 'bad_payload'],
  ['accepted missing', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); delete p.accepted; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'not_accepted'],
  ['accepted false', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.accepted = false; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'not_accepted'],
  ['accepted "true" as a string', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.accepted = 'true'; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'not_accepted'],
  ['another correlation ID', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.correlation_id = cid(43); r.reply.result.content[0].text = JSON.stringify(p); }) }, 'correlation_mismatch'],
  ['no correlation ID', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); delete p.correlation_id; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'correlation_mismatch'],
  ['no event ID', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); delete p.event_id; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'bad_event_id'],
  ['empty event ID', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.event_id = ''; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'bad_event_id'],
  ['numeric event ID', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.event_id = 42; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'bad_event_id'],
  ['event ID with spaces', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.event_id = 'wbr 1\n'; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'bad_event_id'],
  ['ok:false beside accepted', { call: set((r) => { const p = JSON.parse(r.reply.result.content[0].text); p.ok = false; r.reply.result.content[0].text = JSON.stringify(p); }) }, 'not_ok'],
  ['initialize HTTP 500', { initialize: set((r) => { r.status = 500; }) }, 'http_500'],
  ['initialize JSON-RPC error', { initialize: set((r) => { delete r.reply.result; r.reply.error = { code: -32600, message: 'no' }; }) }, 'jsonrpc_error'],
  ['unsupported protocol version', { initialize: set((r) => { r.reply.result.protocolVersion = '1999-01-01'; }) }, 'bad_protocol_version'],
  ['initialized refused', { initialized: set((r) => { r.status = 400; }) }, 'initialized_failed'],
  ['initialized redirected', { initialized: set((r) => { r.status = 307; }) }, 'initialized_failed'],
  ['session changes mid-exchange', { call: set((r) => { r.headers.set('mcp-session-id', 'sess-2'); }) }, 'session_mismatch'],
  ['session expired', { call: set((r) => { r.status = 404; r.reply = null; }) }, 'http_404'],
  ['oversized body', { call: set((r) => { r.body = JSON.stringify({ ...r.reply, pad: 'x'.repeat(2_000_000) }); }) }, 'body_too_large'],
];

test('every malformed or unproven reply is a retryable failure, never a delivery', async () => {
  for (const [label, mutate, code] of MALFORMED) {
    const server = mcpServer({ mutate });
    const out = await relayWith(server)(ARGS);
    assert.equal(out.ok, false, label);
    assert.equal(out.error, code, label);
  }
});

test('an SSE stream that never answers this request is a failure', async () => {
  const server = mcpServer({ sse: true, mutate: { call: (r) => { r.body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`; } } });
  const out = await relayWith(server)(ARGS);
  assert.deepEqual([out.ok, out.error], [false, 'no_response']);
});

test('refused before sending: arguments the receiver would reject are never posted', async () => {
  const server = mcpServer();
  for (const bad of [{ ...ARGS, correlation_id: '' }, { ...ARGS, project: '../x' }, { ...ARGS, session: 'has space' }]) {
    const out = await relayWith(server)(bad);
    assert.deepEqual([out.ok, out.error], [false, 'bad_args']);
  }
  assert.equal(server.calls.length, 0);
});

test('timeout after the receiver committed: the retry reuses the correlation ID and lands on the same event', async () => {
  const { file } = tmpLedger();
  let stall = true;
  const server = mcpServer({
    mutate: {
      call: async (_r, _msg, signal) => {
        if (!stall) return;
        stall = false; // the event is already stored; the reply never arrives in time
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      },
    },
  });
  // The first attempt gives up quickly (the receiver stalls after committing); the retry is patient,
  // so a loaded host cannot turn the retry into a second timeout.
  const quick = relayWith(server, { timeoutMs: 250 });
  const patient = relayWith(server, { timeoutMs: 10000 });
  let attempt = 0;
  const { outbox, clock, logs } = harness({ file, send: (args) => (attempt++ === 0 ? quick(args) : patient(args)) });
  await outbox.enqueue(item(42));
  await outbox.drain();
  let e = ledger(file).entries[cid(42)];
  assert.equal(e.state, 'pending');
  assert.equal(e.lastError, 'timeout');
  assert.equal(server.store.size, 1, 'the receiver had committed');
  clock.t += 5000;
  await outbox.drain();
  e = ledger(file).entries[cid(42)];
  assert.equal(e.state, 'delivered');
  assert.equal(e.receiverEventId, server.store.get(cid(42)).event_id);
  assert.equal(server.store.size, 1, 'one event, not two');
  const calls = server.calls.filter((c) => c.msg.method === 'tools/call').map((c) => JSON.stringify(c.msg.params.arguments));
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1], 'byte-identical arguments on the retry');
  assert.deepEqual(logs.map((l) => l.event), ['enqueued', 'retried', 'accepted']);
});

test('a network error is a retryable failure, not an exception', async () => {
  const out = await createHermesRelay({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, url: 'http://a/mcp' })(ARGS);
  assert.deepEqual([out.ok, out.error], [false, 'network']);
});
