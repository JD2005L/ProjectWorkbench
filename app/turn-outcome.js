// Turn outcomes — what a finished Claude turn is asking of the person.
//
// Every turn end rings the pane bell (the Claude Stop hook), and the tab strip and
// the rail have always shown that as one amber "finished" signal. But "finished"
// covers very different things: a question waiting for an answer, a session stuck
// on a permission it cannot get, a failure, a turn that only paused while CI runs,
// and plain completed work. This module reads the turn's final message and asks an
// evaluation model (TypeSafe AI's Jev, through Vercel AI Gateway) which of those it
// is, so the strip can say so — and, optionally, tell Hermes when someone is
// actually needed.
//
// Failing closed is the whole design: anything not decided with confidence —
// no key, the gateway down, a turn still mid-tool-call, an answer below
// MIN_CONFIDENCE — yields NO outcome, and the UI then shows exactly the amber
// signal it showed before this existed. An outcome only ever refines the bell; it
// never invents attention where tmux saw none.
//
// Pilot (2026-10-05, 197 real turn endings from 22 projects): 89% agreement with
// two independent reference labellers against 45% for keyword rules; at
// confidence >= 0.95 it was right 99% of the time, 0.80-0.95 92%, below 0.60 50%.

import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export const OUTCOMES = Object.freeze(['needs_input', 'blocked', 'failed', 'working', 'done']);
export const MIN_CONFIDENCE = 0.8;
export const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const MODEL = 'typesafe-ai/jev';
// The tail of a long final message carries its ask; the pilot sent the last 2500
// characters and that is what the accuracy figures above were measured on.
export const STATE_CHARS = 2500;
const TAIL_BYTES = 1024 * 1024;
const CACHE_LIMIT = 500;
const RETRY_AFTER_MS = 5000;
const MAX_ATTEMPTS = 3;

// The definitions and priority order the pilot was scored with. Changing them
// changes what the accuracy figures mean.
export const CRITERIA = Object.freeze({
  needs_input: "asks the user to answer, choose, confirm or approve something in the chat, including 'Want me to...?' or 'Should I...?' offers and 'tell me when X is done'",
  blocked: 'could not proceed because of an access, permission, credential, authentication, firewall or policy block and needs a person to act outside the chat',
  failed: 'the work failed or errored or could not achieve the goal, and nothing is asked of the user',
  working: 'not finished; waiting on a background task, CI or agent and says it will continue or report back on its own',
  done: 'the work is finished or it simply answered or reported, and nothing is asked of the user',
});
export const INSTRUCTIONS = 'This is the final message an AI coding assistant wrote before handing control back to the user. How did it end its turn? Priority when several apply: blocked > needs_input > failed > working > done.';

// Most urgent first: what a project's rail key shows when several of its tabs ended.
const URGENCY = ['blocked', 'needs_input', 'failed', 'done', 'working'];

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

// Lines Claude Code writes into the conversation on the person's behalf (slash
// command echoes, local command output) are not the person speaking.
function isSyntheticUser(entry) {
  if (entry?.isMeta) return true;
  const text = textOf(entry?.message?.content).trimStart();
  return text.startsWith('<local-command') || text.startsWith('<command-name>') || text.startsWith('<command-message>');
}

/**
 * The turn-ending assistant message at the end of a transcript, or null when the
 * transcript does not end on one: a tool call still in flight, a tool result
 * awaiting its reply, or the person having already spoken again.
 */
export function lastAssistantTurn(raw) {
  const lines = String(raw || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.isSidechain) continue;
    if (entry?.type === 'assistant') {
      const content = entry?.message?.content;
      const text = textOf(content).trim();
      if (text) return { uuid: String(entry.uuid || ''), text: text.slice(-STATE_CHARS), at: entry.timestamp || null };
      if (Array.isArray(content) && content.some((part) => part?.type === 'tool_use')) return null;
      continue; // thinking-only record: the text that ended the turn is earlier
    }
    if (entry?.type === 'user') {
      const content = entry?.message?.content;
      if (Array.isArray(content) && content.some((part) => part?.type === 'tool_result')) return null;
      if (isSyntheticUser(entry)) continue;
      return null;
    }
    // system records (stop-hook summaries, compaction markers), summaries, file
    // snapshots: none of them is a turn of the conversation.
  }
  return null;
}

// Claude names a project's transcript directory after its cwd with every
// non-alphanumeric character replaced by '-'.
export function transcriptDirName(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

async function readJson(fsp, file) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    return JSON.parse(await handle.readFile('utf8'));
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function readTail(fsp, file, maxBytes = TAIL_BYTES) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const bytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function procChildren(fsp, procfs, pid) {
  try {
    const raw = await fsp.readFile(path.join(procfs, String(pid), 'task', String(pid), 'children'), 'utf8');
    return raw.trim().split(/\s+/).filter(Boolean);
  } catch { return []; }
}

/**
 * The Claude conversation running under each pane, and the message its last turn
 * ended on. Runs AS the pane account (credential-writer.mjs, action 'turn-tail'):
 * the session registry and transcripts are that account's files.
 *
 * A pane's Claude is the descendant process with a registry entry
 * (<config>/sessions/<pid>.json, written by Claude Code itself) — the only record
 * that ties a running Claude to its conversation id, and the one that follows a
 * /clear to the new id.
 *
 * @param {{key:string, panePid:string|number}[]} panes
 * @param {string[]} claudeDirs  config dirs to look in, most specific first
 * @param {(user:string)=>string} [perUserDir]  a pane's own config dir when it carries a credential identity
 * @returns {Promise<Record<string, {sessionId:string, uuid:string, text:string, at:string|null}|null>>}
 */
export async function readTurnTails({ fsp, procfs = '/proc', claudeDirs, panes, perUserDir = null }) {
  const out = {};
  for (const pane of Array.isArray(panes) ? panes : []) {
    const key = String(pane?.key || '');
    if (!key) continue;
    out[key] = null;
    const root = String(pane?.panePid || '');
    if (!/^\d+$/.test(root)) continue;
    const user = String(pane?.credUser || '');
    const dirs = user && perUserDir ? [perUserDir(user), ...claudeDirs] : claudeDirs;
    let entry = null;
    let configDir = '';
    let frontier = [root];
    const seen = new Set();
    for (let depth = 0; depth < 6 && frontier.length && !entry; depth++) {
      const next = [];
      for (const pid of frontier) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        for (const dir of dirs) {
          const reg = await readJson(fsp, path.join(dir, 'sessions', `${pid}.json`));
          if (reg && typeof reg.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(reg.sessionId)) { entry = reg; configDir = dir; break; }
        }
        if (entry) break;
        next.push(...await procChildren(fsp, procfs, pid));
      }
      frontier = next;
    }
    if (!entry) continue;
    const name = `${entry.sessionId}.jsonl`;
    const projects = path.join(configDir, 'projects');
    let raw = await readTail(fsp, path.join(projects, transcriptDirName(entry.cwd), name));
    if (raw === null) {
      // The cwd-to-directory rule is Claude's, not ours; look rather than guess.
      let dirs = [];
      try { dirs = await fsp.readdir(projects); } catch {}
      for (const dir of dirs) {
        raw = await readTail(fsp, path.join(projects, dir, name));
        if (raw !== null) break;
      }
    }
    const turn = raw === null ? null : lastAssistantTurn(raw);
    if (turn) out[key] = { sessionId: entry.sessionId, ...turn };
  }
  return out;
}

/**
 * Ask the evaluation model how a turn ended. Resolves null on any failure.
 * zeroDataRetention + only:typesafe-ai: the message is not kept by the gateway or
 * the provider, and is not routed anywhere else.
 */
export async function evaluateTurn({ fetchImpl, apiKey, text, timeoutMs = 10000 }) {
  if (!apiKey || !text) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(EVALUATE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        state: text,
        questions: { outcome: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
        providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
      }),
    });
    const body = await res.json().catch(() => null);
    const answer = body?.answers?.outcome;
    if (!res.ok || !answer || !OUTCOMES.includes(answer.choice)) {
      return { error: body?.error?.message || `HTTP ${res.status}` };
    }
    const confidence = Number(answer.probabilities?.[answer.choice]);
    return { outcome: answer.choice, confidence: Number.isFinite(confidence) ? confidence : 0 };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timed out' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// What may leave the box in a Hermes event. The relay refuses PEM keys and JWTs
// outright and inspects nothing else, so the obvious credential shapes are
// removed here rather than trusted to never appear in a final message.
export function redactForRelay(text) {
  return String(text || '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(-----END [^-]+-----|$)/g, '[redacted key]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted token]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|vck_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{12,})/g, '[redacted token]')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/(Password=)[^;'"\s]+/gi, '$1[redacted]');
}

// A minimal MCP client for one call. pvi-authority answers plain JSON over the
// streamable-HTTP transport; an SSE reply is read for its JSON-RPC message too.
async function mcpPost(fetchImpl, url, authorization, message, sessionId) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (authorization) headers.Authorization = authorization;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message) });
  const raw = await res.text();
  let body = null;
  if (/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const parsed = JSON.parse(line.slice(5)); if (parsed?.id === message.id) body = parsed; } catch {}
    }
  } else if (raw) {
    try { body = JSON.parse(raw); } catch {}
  }
  return { status: res.status, body, sessionId: res.headers.get('mcp-session-id') || sessionId || '' };
}

export function createHermesRelay({ fetchImpl, url, authorization, timeoutMs = 15000 }) {
  return async function relay(args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const f = (u, init) => fetchImpl(u, { ...init, signal: controller.signal });
    try {
      const init = await mcpPost(f, url, authorization, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pw-turn-outcome', version: '1' } },
      });
      if (init.status >= 400 || init.body?.error) throw new Error(`initialize failed (HTTP ${init.status})`);
      await mcpPost(f, url, authorization, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
      const call = await mcpPost(f, url, authorization, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'relay_workbench_event_to_hermes', arguments: args },
      }, init.sessionId);
      if (call.status >= 400 || call.body?.error || call.body?.result?.isError) {
        throw new Error(call.body?.error?.message || textOf(call.body?.result?.content) || `HTTP ${call.status}`);
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The per-window state machine. observe() is called with every window listing
 * (the cockpit polls every 2s) and must stay cheap: it only notices bells and
 * queues work. annotate() and projectOutcome() read the decided state.
 */
export function createTurnTriage({
  readTails, evaluate, relay = null, log = () => {}, now = () => Date.now(),
  minConfidence = MIN_CONFIDENCE,
}) {
  const windows = new Map(); // `${project}\u0000${windowId}` -> state
  const decided = new Map(); // message uuid -> { outcome, confidence }
  const relayed = new Map(); // message uuid -> true once sent to Hermes
  const latest = new Map(); // project -> most recent confident outcome
  let running = false;
  let pending = [];

  const keyOf = (project, w) => `${project}\u0000${w.windowId}`;
  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
  };

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const batch = pending; pending = [];
        let tails = {};
        try { tails = await readTails(batch.map(({ key, w }) => ({ key, panePid: w.panePid, credUser: w.credUser || '' }))) || {}; }
        catch (error) { log(`turn-tail failed: ${error?.message || error}`); }
        for (const { key, project, w } of batch) {
          const state = windows.get(key);
          if (!state) continue;
          state.inflight = false;
          state.attempts += 1;
          state.triedAt = now();
          // One window's failure must not strand the rest of the batch mid-flight.
          try { await decide(key, project, w, state, tails[key]); }
          catch (error) { log(`turn triage failed for ${project}: ${error?.message || error}`); }
        }
      }
    } finally {
      running = false;
    }
  }

  async function decide(key, project, w, state, tail) {
    if (!tail) return; // still mid-turn or not a Claude pane: retried while the bell stands
    let verdict = decided.get(tail.uuid);
    if (!verdict) {
      const answer = await evaluate(tail.text);
      if (!answer || answer.error) { log(`evaluate failed for ${project}: ${answer?.error || 'no answer'}`); return; }
      verdict = { outcome: answer.outcome, confidence: answer.confidence };
      if (tail.uuid) remember(decided, tail.uuid, verdict);
    }
    state.result = { ...verdict, uuid: tail.uuid, at: now() };
    state.attempts = MAX_ATTEMPTS; // decided: nothing to retry for this bell
    if (verdict.confidence >= minConfidence) latest.set(project, { outcome: verdict.outcome, at: now() });
    const ask = verdict.outcome === 'needs_input' || verdict.outcome === 'blocked';
    const watching = w.active && w.attached > 0;
    if (relay && ask && verdict.confidence >= minConfidence && !watching && tail.uuid && !relayed.has(tail.uuid)) {
      remember(relayed, tail.uuid, true);
      Promise.resolve()
        .then(() => relay({ project, window: w.name || `#${w.index}`, outcome: verdict.outcome, text: tail.text, uuid: tail.uuid }))
        .catch((error) => log(`Hermes relay failed for ${project}: ${error?.message || error}`));
    }
  }

  return {
    observe(project, list) {
      for (const w of Array.isArray(list) ? list : []) {
        if (!w?.windowId) continue;
        const key = keyOf(project, w);
        let state = windows.get(key);
        if (!w.bell || w.hibernated) {
          // The bell is gone (viewed, or a new turn started): the next bell is a new turn.
          if (state) { state.bell = false; state.attempts = 0; }
          continue;
        }
        if (!state) { state = { bell: false, inflight: false, attempts: 0, triedAt: 0, result: null }; windows.set(key, state); }
        if (!state.bell) { state.bell = true; state.attempts = 0; state.result = null; }
        if (state.inflight || state.attempts >= MAX_ATTEMPTS) continue;
        if (state.attempts > 0 && now() - state.triedAt < RETRY_AFTER_MS) continue;
        state.inflight = true;
        pending.push({ key, project, w });
      }
      if (pending.length) drain().catch((error) => log(`turn triage stopped: ${error?.message || error}`));
    },
    // The decided outcome for each window whose bell is up; null when undecided
    // or not confident, which the UI renders as the plain amber it always did.
    annotate(project, list) {
      return (Array.isArray(list) ? list : []).map((w) => {
        const state = w?.windowId ? windows.get(keyOf(project, w)) : null;
        const r = w?.bell && state?.bell ? state.result : null;
        return { ...w, outcome: r && r.confidence >= minConfidence ? r.outcome : null };
      });
    },
    // One outcome for a project's rail key: the most urgent among its rung tabs.
    // Any rung tab without a confident outcome makes the answer null (plain amber),
    // so a project is never shown calmer than one of its tabs warrants.
    projectOutcome(project, list) {
      const rung = (Array.isArray(list) ? list : []).filter((w) => w.bell && (!w.active || w.attached === 0));
      if (!rung.length) return latest.get(project)?.outcome || null;
      const outcomes = this.annotate(project, rung).map((w) => w.outcome);
      if (outcomes.some((o) => !o)) return null;
      return URGENCY.find((o) => outcomes.includes(o)) || null;
    },
    clearProject(project) { latest.delete(project); },
  };
}

// The text of a Hermes event for a turn that needs someone. The message tail is
// evidence, redacted; the summary names only the project, the tab and the ask.
export function hermesEvent({ project, window, outcome, text, uuid }) {
  const blocked = outcome === 'blocked';
  return {
    project,
    session: String(window || '').slice(0, 80) || 'claude',
    event_type: blocked ? 'blocker' : 'question',
    summary: `${project} › ${window}: Claude ${blocked ? 'is blocked and needs a person to act' : 'is waiting for your answer'}.`,
    evidence: redactForRelay(text).slice(-1500),
    correlation_id: `pw-turn-${uuid}`,
    urgency: blocked ? 'high' : 'normal',
  };
}
