// Turn outbox — the durable delivery ledger for turns that need a person, and the strict MCP
// client that is the only thing allowed to say one was delivered to Hermes.
//
// The ledger is one JSON file in the runtime-data pattern sessions.json already uses: every
// read-modify-write happens under the kernel flock of lifecycle-lock.js and lands through
// writeFileAtomic (temp file, fsync, rename, fsync of the directory), mode 0600. That is what makes
// it safe for two dashboard processes at once — an old one still draining while a new one boots —
// and what makes a restart, or the triage's in-memory caches being evicted, unable to relay a turn
// twice: an entry is keyed by the turn's correlation ID and outlives all of them.
//
// An entry moves pending → sending (a lease held by one process) → delivered | suppressed | failed,
// with its attempts, last error and next retry recorded on every move. It becomes `delivered` only
// on a strict acknowledgement from the receiver: a 2xx is not proof, a 2xx with the wrong body is
// not proof, and a timeout proves nothing either way — so it is retried, with the SAME correlation
// ID and byte-identical arguments, and a receiver that had already committed answers the retry
// with the event it already holds. Retries back off exponentially to a cap and stop after a bounded
// number of attempts. A sender that dies mid-send leaves a lease that expires, and the next process
// retries; one that is shut down hands its lease back so the next process need not wait.
//
// What is logged here never includes the message: correlation IDs, codes, counts and times only.

import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { withLifecycleLock } from './lifecycle-lock.js';
import { writeFileAtomic } from './atomic-file.js';

export const LEDGER_VERSION = 1;
const TERMINAL = new Set(['delivered', 'suppressed', 'failed']);
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The receiver's own rules for the identifiers it stores (pvi-authority workbench_relay.py).
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const EVENT_TYPES = new Set(['progress', 'question', 'blocker', 'completion', 'warning']);
const URGENCIES = new Set(['low', 'normal', 'high', 'critical']);

/** The delay before retry number `attempt` + 1: 5 s, 10 s, 20 s … capped. */
export function backoffMs(attempt, base = 5000, cap = 300000) {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Once nothing more is owed, an entry keeps only what dedupes it and what explains its end: no
// message excerpt, no leasing or retry bookkeeping.
const TERMINAL_KEEP = ['id', 'state', 'project', 'windowIndex', 'outcome', 'intervention', 'band', 'decidedBy', 'decisionSchema',
  'probability', 'createdAt', 'updatedAt', 'attempts', 'deliveredAt', 'receiverEventId', 'suppressedReason', 'lastError'];
function compact(entry) {
  for (const key of Object.keys(entry)) if (!TERMINAL_KEEP.includes(key) || entry[key] === null) delete entry[key];
}

function validArgs(a) {
  return isRecord(a)
    && PROJECT.test(String(a.project ?? '')) && SESSION.test(String(a.session ?? ''))
    && EVENT_TYPES.has(a.event_type) && URGENCIES.has(a.urgency)
    && typeof a.summary === 'string' && a.summary.trim() !== '' && a.summary.length <= 1000
    && typeof a.evidence === 'string' && a.evidence.length <= 4000
    && typeof a.correlation_id === 'string' && CORRELATION.test(a.correlation_id);
}

// ---------------------------------------------------------------- structured, secret-free logs

const LOG_FIELDS = ['correlation_id', 'project', 'window_index', 'outcome', 'intervention', 'band', 'probability', 'confidence',
  'model', 'schema', 'state', 'reason', 'error', 'attempt', 'latency_ms', 'next_retry_ms', 'receiver_event_id', 'duplicate'];

/**
 * One JSON line per event, built only from a fixed list of fields — so a caller that passes a
 * summary, evidence or any text by mistake still cannot log it — plus a counter per event name,
 * written out as one `stats` line by logStats() whenever it has moved.
 */
export function createTurnLog({ write = (line) => console.log(line), prefix = '[turn-outcome]' } = {}) {
  const counters = {};
  let reported = '';
  const put = (out) => { try { write(`${prefix} ${JSON.stringify(out)}`); } catch {} };
  return {
    log(event, fields = {}) {
      const name = String(event ?? '').replace(/[^a-z_]/g, '').slice(0, 32) || 'event';
      counters[name] = (counters[name] || 0) + 1;
      const out = { event: name };
      for (const key of LOG_FIELDS) {
        const value = fields?.[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'number') { if (Number.isFinite(value)) out[key] = Number.isInteger(value) ? value : Math.round(value * 1000) / 1000; }
        else if (typeof value === 'boolean') out[key] = value;
        else out[key] = String(value).replace(/[^\x20-\x7E]/g, '').slice(0, 128);
      }
      put(out);
    },
    logStats() {
      const now = JSON.stringify(counters);
      if (now === reported) return;
      reported = now;
      put({ event: 'stats', counts: { ...counters } });
    },
    stats: () => ({ ...counters }),
  };
}

// ---------------------------------------------------------------- the ledger

export function createTurnOutbox({
  file,
  lockFile = path.join(path.dirname(file), `.${path.basename(file)}.lock`),
  send,
  recheck = null,
  log = () => {},
  now = () => Date.now(),
  ownerId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  maxAttempts = 8,
  baseDelayMs = 5000,
  maxDelayMs = 300000,
  leaseMs = 60000,
  retentionMs = 30 * 24 * 3600 * 1000,
  maxEntries = 2000,
  maxPending = 200,
  pollMs = 30000,
  lock = withLifecycleLock,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
}) {
  let draining = null;
  let again = false;
  let closed = false;
  let timer = null;
  let nextDue = null;
  const emit = (event, fields) => { try { log(event, fields); } catch {} };

  async function load() {
    let handle;
    try {
      handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return { version: LEDGER_VERSION, entries: {} };
      throw error; // ELOOP: a planted symlink is refused, never followed
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error('turn outbox: the ledger is not a regular file');
      let data = null;
      try { data = JSON.parse(await handle.readFile('utf8')); } catch {}
      if (!isRecord(data) || data.version !== LEDGER_VERSION || !isRecord(data.entries)) {
        // Unreadable: kept aside for a person to look at, never silently overwritten in place.
        const aside = `${file}.corrupt-${Date.now()}`;
        await fsp.rename(file, aside).catch(() => {});
        emit('ledger_corrupt', { reason: 'unreadable' });
        return { version: LEDGER_VERSION, entries: {} };
      }
      return data;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function save(ledger) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  }

  // Terminal entries go after retentionMs, and the oldest of them first whenever the ledger holds
  // more than maxEntries. An entry still owed a delivery is never pruned.
  function prune(ledger, t) {
    const terminal = [];
    for (const [id, e] of Object.entries(ledger.entries)) {
      if (!TERMINAL.has(e.state)) continue;
      if (t - (e.updatedAt ?? 0) > retentionMs) delete ledger.entries[id];
      else terminal.push(e);
    }
    let excess = Object.keys(ledger.entries).length - maxEntries;
    if (excess > 0) {
      terminal.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
      for (const e of terminal) { if (excess-- <= 0) break; delete ledger.entries[e.id]; }
    }
  }

  function earliestDue(ledger) {
    let at = null;
    for (const e of Object.values(ledger.entries)) {
      const due = e.state === 'pending' ? e.nextAttemptAt : e.state === 'sending' ? e.leaseUntil : null;
      if (typeof due === 'number' && (at === null || due < at)) at = due;
    }
    return at;
  }

  async function enqueue(item) {
    if (!isRecord(item) || !CORRELATION.test(String(item.id ?? '')) || !validArgs(item.args) || item.args.correlation_id !== item.id) {
      throw new TypeError('turn outbox: malformed entry');
    }
    const result = await lock(lockFile, async () => {
      const ledger = await load();
      const existing = ledger.entries[item.id];
      if (existing) return { status: 'deduplicated', state: existing.state };
      const live = Object.values(ledger.entries).filter((e) => !TERMINAL.has(e.state)).length;
      if (live >= maxPending) return { status: 'refused', reason: 'outbox_full' };
      const t = now();
      ledger.entries[item.id] = {
        id: item.id, state: 'pending',
        project: String(item.project ?? ''), windowId: String(item.windowId ?? ''), windowIndex: Number.isInteger(item.windowIndex) ? item.windowIndex : null,
        outcome: item.outcome ?? null, intervention: item.intervention ?? null, band: item.band ?? null,
        decidedBy: item.decidedBy ?? null, decisionSchema: item.decisionSchema ?? null,
        probability: typeof item.probability === 'number' && Number.isFinite(item.probability) ? item.probability : null,
        createdAt: t, updatedAt: t, attempts: 0, nextAttemptAt: t, lastAttemptAt: null, lastError: null,
        leaseOwner: null, leaseUntil: null, deliveredAt: null, receiverEventId: null, suppressedReason: null,
        args: item.args,
      };
      prune(ledger, t);
      await save(ledger);
      return { status: 'enqueued' };
    });
    const fields = { correlation_id: item.id, project: item.project, window_index: item.windowIndex, outcome: item.outcome, intervention: item.intervention, band: item.band };
    if (result.status === 'enqueued') { emit('enqueued', fields); kick(); }
    else if (result.status === 'deduplicated') emit('deduplicated', { ...fields, state: result.state });
    else emit('refused', { ...fields, reason: result.reason });
    return result;
  }

  // A look at the ledger WITHOUT the lock, so an idle poll costs a file read rather than a flock(1)
  // spawn. Safe because the ledger is only ever replaced by an atomic rename: an unlocked read is a
  // consistent snapshot. It has no side effects — anything odd (missing, unreadable, a symlink) is
  // left to the locked path, which is the only one allowed to act on it.
  async function peek() {
    let handle;
    try {
      handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const data = JSON.parse(await handle.readFile('utf8'));
      return isRecord(data) && data.version === LEDGER_VERSION && isRecord(data.entries) ? data : null;
    } catch (error) {
      return error?.code === 'ENOENT' ? { version: LEDGER_VERSION, entries: {} } : null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // Claim the oldest due entry under the lock: pending and due, or sending with a lease that
  // expired (its sender died). An expired lease that has used every attempt fails instead.
  async function claim() {
    const snapshot = await peek();
    const t0 = now();
    if (snapshot && !Object.values(snapshot.entries).some((e) => (e.state === 'pending' && e.nextAttemptAt <= t0) || (e.state === 'sending' && (e.leaseUntil ?? 0) <= t0))) {
      nextDue = earliestDue(snapshot);
      return null;
    }
    return lock(lockFile, async () => {
      const ledger = await load();
      const t = now();
      let changed = false;
      for (;;) {
        let pick = null;
        for (const e of Object.values(ledger.entries)) {
          const due = (e.state === 'pending' && e.nextAttemptAt <= t) || (e.state === 'sending' && (e.leaseUntil ?? 0) <= t);
          if (due && (!pick || (e.nextAttemptAt ?? 0) < (pick.nextAttemptAt ?? 0))) pick = e;
        }
        if (!pick) {
          nextDue = earliestDue(ledger);
          if (changed) await save(ledger);
          return null;
        }
        if (pick.state === 'sending') {
          emit('lease_recovered', { correlation_id: pick.id, attempt: pick.attempts });
          if (pick.attempts >= maxAttempts) {
            Object.assign(pick, { state: 'failed', lastError: 'lease_expired', updatedAt: t });
            compact(pick);
            emit('terminal_failure', { correlation_id: pick.id, attempt: pick.attempts, error: 'lease_expired', band: pick.band });
            changed = true;
            continue;
          }
        }
        Object.assign(pick, { state: 'sending', leaseOwner: ownerId, leaseUntil: t + leaseMs, attempts: pick.attempts + 1, lastAttemptAt: t, updatedAt: t });
        prune(ledger, t);
        await save(ledger);
        return { ...pick };
      }
    });
  }

  // Apply an outcome to an entry. A delivered entry is final; anything else applies only while this
  // process still holds the lease, unless it is proof of delivery, which applies whoever holds it.
  async function finish(id, apply, { proof = false } = {}) {
    return lock(lockFile, async () => {
      const ledger = await load();
      const e = ledger.entries[id];
      if (!e) return null;
      if (e.state === 'delivered') return { entry: e, applied: false };
      if (!proof && (e.state !== 'sending' || e.leaseOwner !== ownerId)) return { entry: e, applied: false };
      const t = now();
      apply(e, t);
      Object.assign(e, { leaseOwner: null, leaseUntil: null, updatedAt: t });
      if (TERMINAL.has(e.state)) compact(e); // the message excerpt is not kept once nothing is owed
      prune(ledger, t);
      await save(ledger);
      return { entry: e, applied: true };
    });
  }

  async function failed(entry, error, fields) {
    const terminal = entry.attempts >= maxAttempts;
    const delay = backoffMs(entry.attempts, baseDelayMs, maxDelayMs);
    const done = await finish(entry.id, (e, t) => {
      e.lastError = String(error).slice(0, 64);
      if (terminal) e.state = 'failed';
      else { e.state = 'pending'; e.nextAttemptAt = t + delay; }
    });
    if (!done?.applied) return; // the lease moved on; its holder decides now
    if (terminal) emit('terminal_failure', { ...fields, error });
    else emit('retried', { ...fields, error, next_retry_ms: delay });
  }

  async function deliver(entry) {
    const fields = { correlation_id: entry.id, attempt: entry.attempts, band: entry.band, project: entry.project };
    if (recheck) {
      let verdict;
      try { verdict = await recheck(entry); } catch { verdict = { retry: true, reason: 'recheck_failed' }; }
      if (verdict?.deliver === false) {
        const reason = String(verdict.reason || 'suppressed').slice(0, 32);
        const done = await finish(entry.id, (e) => { e.state = 'suppressed'; e.suppressedReason = reason; });
        if (done?.applied) emit('suppressed', { ...fields, reason });
        return;
      }
      if (verdict?.retry) { await failed(entry, String(verdict.reason || 'recheck_failed'), fields); return; }
    }
    const started = now();
    let result;
    try { result = await send(entry.args); } catch { result = { ok: false, error: 'send_threw' }; }
    const latency = Math.max(0, now() - started);
    if (result?.ok === true && typeof result.eventId === 'string' && EVENT_ID.test(result.eventId)) {
      await finish(entry.id, (e, t) => { e.state = 'delivered'; e.receiverEventId = result.eventId; e.deliveredAt = t; e.lastError = null; }, { proof: true });
      emit('accepted', { ...fields, latency_ms: latency, receiver_event_id: result.eventId, duplicate: result.duplicate === true });
      return;
    }
    await failed(entry, String(result?.error || 'no_result'), { ...fields, latency_ms: latency });
  }

  function schedule() {
    if (closed) return;
    if (timer) { clearTimer(timer); timer = null; }
    const wait = nextDue === null ? pollMs : Math.min(pollMs, Math.max(1000, nextDue - now()));
    timer = setTimer(() => { timer = null; drain().catch((error) => emit('drain_failed', { error: String(error?.message || error) })); }, wait);
  }

  function kick() {
    if (closed) return;
    if (timer) { clearTimer(timer); timer = null; }
    timer = setTimer(() => { timer = null; drain().catch((error) => emit('drain_failed', { error: String(error?.message || error) })); }, 0);
  }

  /** Deliver everything that is due now, one entry at a time. */
  async function drain() {
    if (draining) { again = true; return draining; }
    draining = (async () => {
      let delivered = 0;
      try {
        do {
          again = false;
          for (;;) {
            if (closed) break;
            const entry = await claim();
            if (!entry) break;
            await deliver(entry);
            delivered++;
          }
        } while (again && !closed);
      } finally {
        draining = null;
        schedule();
      }
      return delivered;
    })();
    return draining;
  }

  return {
    enqueue,
    drain,
    kick,
    /** Start delivering: what an earlier process left pending goes first, then a poll. */
    start() { closed = false; kick(); },
    /**
     * Stop, and hand back what this process is in the middle of sending so the next process retries
     * it at once instead of waiting out the lease. Proof that lands after this is still recorded.
     */
    async shutdown({ timeoutMs = 2000 } = {}) {
      closed = true;
      if (timer) { clearTimer(timer); timer = null; }
      const release = lock(lockFile, async () => {
        const ledger = await load();
        const t = now();
        let changed = false;
        for (const e of Object.values(ledger.entries)) {
          if (e.state === 'sending' && e.leaseOwner === ownerId) {
            Object.assign(e, { state: 'pending', leaseOwner: null, leaseUntil: null, nextAttemptAt: t, updatedAt: t });
            changed = true;
          }
        }
        if (changed) await save(ledger);
      });
      let guard;
      await Promise.race([release, new Promise((resolve) => { guard = setTimeout(resolve, timeoutMs); guard.unref?.(); })]).catch(() => {});
      clearTimeout(guard);
    },
    async snapshot() { return lock(lockFile, load); },
  };
}

// ---------------------------------------------------------------- the strict MCP client

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2025-11-25']);
const REQUESTED_PROTOCOL_VERSION = '2025-06-18';
const SESSION_ID = /^[\x21-\x7E]{1,256}$/;

class Unproven extends Error {}
const unproven = (code) => { throw new Unproven(code); };

async function readBody(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); unproven('body_too_large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = typeof res.text === 'function' ? await res.text() : '';
  if (Buffer.byteLength(text, 'utf8') > max) unproven('body_too_large');
  return text;
}

// The one JSON-RPC response to request `id` in an SSE body. Notifications and server requests are
// passed over; an answer to some other id, or a second answer, is not proof of anything.
function fromEventStream(raw, id) {
  let match = null;
  for (const block of raw.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    let message;
    try { message = JSON.parse(data); } catch { unproven('bad_json'); }
    if (!isRecord(message)) unproven('not_jsonrpc');
    if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) continue;
    if (message.id !== id) unproven('id_mismatch');
    if (match) unproven('not_jsonrpc');
    match = message;
  }
  if (!match) unproven('no_response');
  return match;
}

function responseResult(message, id) {
  if (!isRecord(message) || message.jsonrpc !== '2.0') unproven('not_jsonrpc');
  const hasResult = Object.hasOwn(message, 'result');
  if (hasResult === Object.hasOwn(message, 'error')) unproven('not_jsonrpc');
  if (message.id !== id) unproven('id_mismatch');
  if (!hasResult) unproven('jsonrpc_error');
  if (!isRecord(message.result)) unproven('not_jsonrpc');
  return message.result;
}

function parseObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { unproven('bad_payload'); }
  if (!isRecord(value)) unproven('bad_payload');
  return value;
}

// The tool's typed result: structuredContent when the server gives one (FastMCP wraps a string
// return as {result: "<json>"}), else the single text content item, parsed.
function toolPayload(result) {
  const structured = result.structuredContent;
  if (isRecord(structured)) {
    if (Object.hasOwn(structured, 'accepted')) return structured;
    const keys = Object.keys(structured);
    if (keys.length === 1 && typeof structured.result === 'string') return parseObject(structured.result);
  }
  const texts = Array.isArray(result.content) ? result.content.filter((c) => c?.type === 'text' && typeof c.text === 'string') : [];
  if (texts.length !== 1) unproven('bad_payload');
  return parseObject(texts[0].text);
}

/**
 * A client for one relay_workbench_event_to_hermes call. Resolves { ok:true, eventId, duplicate }
 * ONLY on a strict acknowledgement — every step 2xx without a redirect, JSON-RPC 2.0 answers to the
 * ids sent, a consistent session, no isError, and a typed result with `accepted: true`, this exact
 * correlation ID and a durable event ID. Everything else resolves { ok:false, error } with a short
 * code; nothing throws, and nothing about the reply is copied into the code.
 */
export function createHermesRelay({ fetchImpl, url, authorization = '', timeoutMs = 15000, maxBodyBytes = 1024 * 1024 }) {
  return async function relay(args) {
    if (!validArgs(args)) return { ok: false, error: 'bad_args' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    const post = (message, session, protocol) => {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      if (authorization) headers.Authorization = authorization;
      if (session) headers['Mcp-Session-Id'] = session;
      if (protocol) headers['MCP-Protocol-Version'] = protocol;
      return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal: controller.signal });
    };
    const isRedirect = (res, status) => res.redirected === true || res.type === 'opaqueredirect' || (status >= 300 && status < 400);

    async function request(method, params, session, protocol, expectSession) {
      const id = `pw-${crypto.randomUUID()}`;
      const res = await post({ jsonrpc: '2.0', id, method, params }, session, protocol);
      const status = Number(res.status);
      if (isRedirect(res, status)) unproven('redirect');
      if (!(status >= 200 && status < 300)) unproven(`http_${status || 0}`);
      const answeredSession = res.headers?.get?.('mcp-session-id') ?? null;
      if (expectSession !== undefined && answeredSession !== null && answeredSession !== expectSession) unproven('session_mismatch');
      const raw = await readBody(res, maxBodyBytes);
      if (!raw.trim()) unproven('empty_body');
      const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
      let message;
      if (type.startsWith('application/json')) {
        try { message = JSON.parse(raw); } catch { unproven('bad_json'); }
      } else if (type.startsWith('text/event-stream')) {
        message = fromEventStream(raw, id);
      } else {
        unproven('bad_content_type');
      }
      return { result: responseResult(message, id), session: answeredSession };
    }

    try {
      const init = await request('initialize', {
        protocolVersion: REQUESTED_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pw-turn-outcome', version: '2' },
      }, '', '', undefined);
      const protocol = init.result.protocolVersion;
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) unproven('bad_protocol_version');
      const session = init.session ?? '';
      if (session && !SESSION_ID.test(session)) unproven('bad_session_id');

      const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session, protocol);
      const noteStatus = Number(note.status);
      if (isRedirect(note, noteStatus) || !(noteStatus >= 200 && noteStatus < 300)) unproven('initialized_failed');
      await readBody(note, 64 * 1024).catch(() => {});

      const call = await request('tools/call', { name: 'relay_workbench_event_to_hermes', arguments: args }, session, protocol, session);
      if (call.result.isError !== undefined && call.result.isError !== false) unproven('tool_error');
      const payload = toolPayload(call.result);
      if (Object.hasOwn(payload, 'ok') && payload.ok !== true) unproven('not_ok');
      if (payload.accepted !== true) unproven('not_accepted');
      if (payload.correlation_id !== args.correlation_id) unproven('correlation_mismatch');
      if (typeof payload.event_id !== 'string' || !EVENT_ID.test(payload.event_id)) unproven('bad_event_id');
      return { ok: true, eventId: payload.event_id, duplicate: payload.duplicate === true, latencyMs: Date.now() - started };
    } catch (error) {
      if (error instanceof Unproven) return { ok: false, error: error.message };
      return { ok: false, error: controller.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  };
}
