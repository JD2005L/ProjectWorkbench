// Turn outcomes — what a finished Claude turn is asking of the person.
//
// Every turn end rings the pane bell (the Claude Stop hook), and the tab strip and
// the rail have always shown that as one amber "finished" signal. But "finished"
// covers very different things: a question waiting for an answer, a session stuck
// on a permission it cannot get, a failure, a turn that only paused while CI runs,
// and plain completed work. This module reads the turn — the final message and the
// request that started it — and asks TypeSafe AI's Jev, through Vercel AI Gateway's
// documented decision API, two finite typed questions about it: how did the turn
// end, and what kind of human intervention does it need. The strip can then say so,
// and Hermes can be told when someone is actually needed.
//
// Failing closed is the whole design: anything not decided with confidence —
// no key, the gateway down, a turn still mid-tool-call, an answer that is not
// valid, not from Jev, or not confident — yields NO outcome, and the UI then shows
// exactly the amber signal it showed before this existed. An outcome only ever
// refines the bell; it never invents attention where tmux saw none, and it never
// authorizes anything: it changes a colour and who is told, nothing else.
//
// Pilot (2026-10-05, 197 real turn endings from 22 projects, outcome question on the
// final message alone): 89% agreement with two independent reference labellers
// against 45% for keyword rules; at selected-option probability >= 0.95 it was right
// 99% of the time, 0.80-0.95 92%, below 0.60 50%.

import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { turnContext, requestedAction, sanitizeText, redactSecrets, ASK_CHARS } from './turn-context.js';

// The feature is opt-in per instance, and only an explicit yes switches it on: an
// unset variable, a typo or 'off' all mean off. GOA does not approve of Jev, and an
// upgrade must never turn it on there by default (DECISIONS.md 2026-10-05).
export function turnOutcomeOptedIn(env = process.env) {
  return ['on', 'true', '1', 'yes'].includes(String(env?.PW_TURN_OUTCOME ?? '').trim().toLowerCase());
}

export const OUTCOMES = Object.freeze(['needs_input', 'blocked', 'failed', 'working', 'done']);
export const INTERVENTIONS = Object.freeze(['answer', 'approval', 'credential_holder', 'deployment', 'manual_action', 'investigation', 'none']);
// The selected option's probability — the measure the pilot calibrated.
export const MIN_CONFIDENCE = 0.8;
export const HIGH_CONFIDENCE = 0.95;
// TypeSafe's own confidence statistic, when it reports one (providerMetadata.typesafe.confidence).
// It is not the selected option's probability; Vercel's routing guide uses 0.6 as its floor.
export const MIN_TYPESAFE_CONFIDENCE = 0.6;
// The documented HTTP API for decisions (vercel.com/docs/ai-gateway/modalities/decision, verified
// 2026-10-06). The AI SDK's experimental_decide sends the same state and questions to an SDK-only
// path; it is not used here because it would add the dashboard's first non-express dependency (and
// require Node 22), which GOA's promote path would refuse — and GOA must never carry Jev.
export const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const MODEL = 'typesafe-ai/jev';
const JEV_MODEL = /^typesafe-ai\/jev(?:-[a-z0-9][a-z0-9.-]{0,47})?$/;
const TAIL_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_LIMIT = 500;
const RETRY_AFTER_MS = 5000;
export const RECHECK_MS = 15000;
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
export const INSTRUCTIONS = 'The state holds the latest request the user gave an AI coding assistant (null when unknown) and the final message the assistant wrote before handing control back to the user. How did the assistant end its turn? Judge the final message; the request is context only. Priority when several apply: blocked > needs_input > failed > working > done.';
export const INTERVENTION_CRITERIA = Object.freeze({
  answer: 'a person only needs to reply in the chat: answer a question, choose between options, or supply information',
  approval: 'a person must approve or reject a specific action the assistant proposes to take itself, such as pushing, merging, deploying or deleting',
  credential_holder: 'someone holding a credential, key, token, password, account or access grant must provide, rotate or grant it',
  deployment: 'a person must run, release or promote a deployment outside the chat because the assistant cannot',
  manual_action: 'a person must do something by hand outside the chat that is not a credential or deployment step',
  investigation: 'a person must look into or diagnose a problem the assistant could not resolve',
  none: 'nothing is needed from a person for the work to continue',
});
export const INTERVENTION_INSTRUCTIONS = 'The state holds the latest request the user gave an AI coding assistant (null when unknown) and the final message the assistant wrote before handing control back to the user. What must a person do for the work to continue? When the assistant only needs a yes or no to do something itself, that is approval, even when the action is a deployment.';
export const QUESTIONS = Object.freeze({
  outcome: Object.freeze({ type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA }),
  intervention: Object.freeze({ type: 'choice', instructions: INTERVENTION_INSTRUCTIONS, criteria: INTERVENTION_CRITERIA }),
});
// The decision schema: a version plus a digest of exactly what is asked, so a recorded decision
// always says which questions and state shape produced it. pw-turn-decision/1 was the pilot's
// one question over the bare message tail.
export const DECISION_SCHEMA = `pw-turn-decision/2#${crypto.createHash('sha256')
  .update(JSON.stringify({ state: ['latest_user_request', 'final_assistant_message'], questions: QUESTIONS }))
  .digest('hex').slice(0, 12)}`;

// Most urgent first: what a project's rail key shows when several of its tabs ended.
const URGENCY = ['blocked', 'needs_input', 'failed', 'done', 'working'];
// The outcomes that ask something of the person, and so carry a requested-action excerpt.
const ATTENTION = new Set(['needs_input', 'blocked', 'failed']);

// Identifier shapes. A turn is only ever relayed under identifiers the receiver accepts as they
// are; anything else is refused here rather than "cleaned" into a different identifier.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOW_ID = /^@\d{1,10}$/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

// Lines Claude Code writes into the conversation on the person's behalf (slash
// command echoes, local command output, compaction summaries) are not the person speaking.
function isSyntheticUser(entry) {
  if (entry?.isMeta || entry?.isCompactSummary) return true;
  const text = textOf(entry?.message?.content).trimStart();
  return text.startsWith('<local-command') || text.startsWith('<command-name>') || text.startsWith('<command-message>');
}

// A slash command's own arguments are a request; a bare command is not. undefined: not a command.
function slashCommand(text) {
  if (!text.startsWith('<command-message>') && !text.startsWith('<command-name>')) return undefined;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() || '';
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() || '';
  return args ? `${name} ${args}`.trim() : '';
}

// The person's own latest words before line `from`: past tool results, skill expansions,
// interrupt markers, compaction summaries and command echoes.
function latestRequest(lines, from) {
  for (let i = from; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.isSidechain || entry?.type !== 'user') continue;
    if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) continue;
    const content = entry?.message?.content;
    if (Array.isArray(content) && content.some((part) => part?.type === 'tool_result')) continue;
    const text = textOf(content).trim();
    if (!text) continue;
    const command = slashCommand(text);
    if (command !== undefined) { if (command) return command; continue; }
    if (text.startsWith('<local-command') || /^\[Request interrupted by user/.test(text)) continue;
    return text;
  }
  return null;
}

/**
 * The turn-ending assistant message at the end of a transcript — whole, because nothing may be
 * cut before it is redacted — and the request that started the turn; or null when the transcript
 * does not end on one: a tool call still in flight, a tool result awaiting its reply, or the person
 * having already spoken again.
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
      if (text) return { uuid: String(entry.uuid || ''), text, at: entry.timestamp || null, userText: latestRequest(lines, i - 1) };
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

function isoOrNull(value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The Claude conversation running under each pane, and the turn it last ended. Runs AS the pane
 * account (credential-writer.mjs, action 'turn-tail'): the session registry and transcripts are
 * that account's files. What it returns is already privacy-minimized (turn-context.js): the final
 * message's tail and the request's head, each redacted whole before it was cut, and a digest of the
 * message's words — never the raw transcript.
 *
 * A pane's Claude is the descendant process with a registry entry
 * (<config>/sessions/<pid>.json, written by Claude Code itself) — the only record
 * that ties a running Claude to its conversation id, and the one that follows a
 * /clear to the new id.
 *
 * @param {{key:string, panePid:string|number}[]} panes
 * @param {string[]} claudeDirs  config dirs to look in, most specific first
 * @param {(user:string)=>string} [perUserDir]  a pane's own config dir when it carries a credential identity
 * @returns {Promise<Record<string, {sessionId:string, uuid:string, at:string|null, digest:string, assistant:string, user:string|null}|null>>}
 */
export async function readTurnTails({ fsp, procfs = '/proc', claudeDirs, panes, perUserDir = null }) {
  const out = {};
  for (const pane of Array.isArray(panes) ? panes : []) {
    const key = String(pane?.key || '');
    if (!key) continue;
    out[key] = null;
    // One pane that cannot be read (an odd credential name, a vanished process)
    // must not cost the others their answer.
    try { out[key] = await readOneTail({ fsp, procfs, claudeDirs, perUserDir, pane }); } catch { out[key] = null; }
  }
  return out;
}

async function readOneTail({ fsp, procfs, claudeDirs, perUserDir, pane }) {
  const root = String(pane?.panePid || '');
  if (!/^\d+$/.test(root)) return null;
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
        if (reg && typeof reg.sessionId === 'string' && UUID.test(reg.sessionId)) { entry = reg; configDir = dir; break; }
      }
      if (entry) break;
      next.push(...await procChildren(fsp, procfs, pid));
    }
    frontier = next;
  }
  if (!entry) return null;
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
  if (!turn || !UUID.test(turn.uuid)) return null;
  const context = turnContext({ assistantText: turn.text, userText: turn.userText });
  return { sessionId: entry.sessionId, uuid: turn.uuid, at: isoOrNull(turn.at), digest: context.digest, assistant: context.assistant, user: context.user };
}

// ---------------------------------------------------------------- the Jev decision

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const isProbability = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const TOLERANCE = 1e-6;
class Invalid extends Error {}
const invalid = (code) => { throw new Invalid(code); };

// A confidence statistic is optional; when given it must be a probability.
function confidenceOf(body, answer, id) {
  const meta = body.providerMetadata?.typesafe?.confidence;
  if (meta !== undefined && !isRecord(meta)) invalid('bad_confidence');
  const fromMeta = meta?.[id];
  for (const value of [fromMeta, answer.confidence]) if (value !== undefined && !isProbability(value)) invalid('bad_confidence');
  return fromMeta ?? answer.confidence ?? null;
}

// The AI SDK's own answer rules (ai@7.0.128 validateDecisionAnswers) for a choice question, made
// stricter where this use needs it: the distribution is required, because the selected option's
// probability is what decides whether anything is shown.
function checkChoice(body, id, criteria, roundingError) {
  const answer = body.answers[id];
  if (!isRecord(answer) || answer.type !== 'choice') invalid('bad_answers');
  if (typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)) invalid('unknown_option');
  const dist = answer.probabilities;
  const keys = Object.keys(criteria);
  if (!isRecord(dist) || Object.keys(dist).length !== keys.length || !keys.every((k) => Object.hasOwn(dist, k))
    || !Object.values(dist).every(isProbability)) invalid('bad_distribution');
  const sum = Object.values(dist).reduce((total, p) => total + p, 0);
  if (Math.abs(sum - 1) > TOLERANCE + keys.length * roundingError) invalid('bad_distribution');
  const selected = dist[answer.choice];
  if (Object.values(dist).some((p) => p > selected + TOLERANCE)) invalid('not_argmax');
  return { choice: answer.choice, probability: selected, distribution: dist, confidence: confidenceOf(body, answer, id) };
}

function bandOf(probability, confidence) {
  if (confidence !== null && confidence < MIN_TYPESAFE_CONFIDENCE) return 'uncertain';
  return probability >= HIGH_CONFIDENCE ? 'high' : probability >= MIN_CONFIDENCE ? 'medium' : 'uncertain';
}

/**
 * A gateway response turned into a decision, or { ok:false, error } when it is not a valid answer
 * from Jev. An uncertain decision is still a decision (outcome null, band 'uncertain'): it is
 * plain amber, and asking again would not make it surer.
 */
export function validateDecision(body) {
  try {
    if (!isRecord(body)) invalid('bad_body');
    // Decided by Jev, through TypeSafe — not by a fallback model, not by another provider.
    if (typeof body.model !== 'string' || !JEV_MODEL.test(body.model)) invalid('not_jev');
    const routing = body.providerMetadata?.gateway?.routing;
    if (routing !== undefined && (!isRecord(routing) || (routing.finalProvider !== undefined && routing.finalProvider !== 'typesafe-ai'))) invalid('not_jev');
    let roundingError = 0;
    if (body.rounding !== undefined) {
      const decimals = isRecord(body.rounding) ? body.rounding.probabilityDecimals : NaN;
      if (decimals !== undefined) {
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) invalid('bad_rounding');
        roundingError = 0.5 * 10 ** -decimals;
      }
    }
    if (!isRecord(body.answers)) invalid('bad_answers');
    const ids = Object.keys(QUESTIONS);
    if (Object.keys(body.answers).length !== ids.length || !ids.every((id) => Object.hasOwn(body.answers, id))) invalid('bad_answers');
    const outcome = checkChoice(body, 'outcome', CRITERIA, roundingError);
    const kind = checkChoice(body, 'intervention', INTERVENTION_CRITERIA, roundingError);

    let band = bandOf(outcome.probability, outcome.confidence);
    const calm = outcome.choice === 'done' || outcome.choice === 'working';
    // A calm display ("nothing needed from you") stops the tab pulsing, so it needs the second,
    // independent question to agree that nothing is needed; otherwise the tab stays amber.
    if (calm && kind.distribution.none < 0.5) band = 'uncertain';
    const consistent = calm ? kind.choice === 'none'
      : (outcome.choice === 'needs_input' || outcome.choice === 'blocked') ? kind.choice !== 'none' : true;
    const kindSure = bandOf(kind.probability, kind.confidence) !== 'uncertain';
    const generationId = body.providerMetadata?.gateway?.generationId;
    return {
      ok: true,
      decision: {
        outcome: band === 'uncertain' ? null : outcome.choice,
        band,
        probability: outcome.probability,
        confidence: outcome.confidence,
        intervention: kindSure && consistent ? kind.choice : 'unknown',
        interventionProbability: kind.probability,
        interventionConfidence: kind.confidence,
        model: body.model,
        schema: DECISION_SCHEMA,
        generationId: typeof generationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(generationId) ? generationId : null,
        latencyMs: null,
      },
    };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Ask Jev how a turn ended and what it needs. Resolves { ok:true, decision } or { ok:false, error }
 * with a short error code — never a gateway message, which could echo what was sent.
 * zeroDataRetention + only:typesafe-ai: the state is not kept by the gateway or the provider, and is
 * not routed anywhere else. `context` is turn-context.js output: already redacted and bounded.
 */
export async function evaluateTurn({ fetchImpl, apiKey, context, timeoutMs = 10000, now = () => Date.now() }) {
  if (!apiKey) return { ok: false, error: 'no_key' };
  const assistant = typeof context?.assistant === 'string' ? context.assistant : '';
  if (!assistant.trim()) return { ok: false, error: 'no_state' };
  const user = typeof context?.user === 'string' && context.user.trim() ? context.user : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetchImpl(EVALUATE_URL, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        state: { latest_user_request: user, final_assistant_message: assistant },
        questions: QUESTIONS,
        providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
      }),
    });
    if (!res.ok) return { ok: false, error: `http_${Number(res.status) || 0}` };
    const raw = await res.text();
    if (raw.length > MAX_RESPONSE_BYTES) return { ok: false, error: 'body_too_large' };
    let body;
    try { body = JSON.parse(raw); } catch { return { ok: false, error: 'bad_json' }; }
    const out = validateDecision(body);
    if (out.ok) out.decision.latencyMs = Math.max(0, now() - started);
    return out;
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- identity and the contract

/**
 * A turn's identity: instance + project + Claude session + assistant message + a digest of its
 * words. Session-scoped because a forked conversation repeats its parent's message uuids; the
 * digest because a uuid alone does not prove the words are the ones decided. The correlation ID is
 * the opaque form Hermes sees — the same on every retry, every restart and every dashboard process.
 * null when any part is not the shape it must be.
 */
export function turnIdentity({ instance, project, sessionId, uuid, digest }) {
  if (typeof instance !== 'string' || !instance || instance.length > 255) return null;
  if (!PROJECT_RE.test(String(project ?? '')) || !UUID.test(String(sessionId ?? '')) || !UUID.test(String(uuid ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(digest ?? ''))) return null;
  const key = crypto.createHash('sha256')
    .update(JSON.stringify(['pw-turn/1', instance, project, sessionId.toLowerCase(), uuid.toLowerCase(), digest]))
    .digest('hex');
  return { key, correlationId: `pwt1-${key.slice(0, 32)}` };
}

export const CONTRACT_SCHEMA = 'pw.turn-action/1';

function cleanLabel(name) {
  return redactSecrets(sanitizeText(String(name ?? ''))).replace(/\s+/g, ' ').trim().slice(0, 64);
}

function sessionName(index, name) {
  const slug = name.replace(/[^A-Za-z0-9._:@-]+/g, '-').replace(/^[-._:@]+|-+$/g, '').slice(0, 100);
  return `w${index ?? ''}${slug ? `-${slug}` : ''}`.slice(0, 128);
}

/**
 * The relay_workbench_event_to_hermes arguments for a turn that needs someone: a deterministic,
 * self-contained action contract. Same input, byte-identical output — the outbox resends exactly
 * these bytes on every retry, which is what lets the receiver recognise a retry. It carries the
 * requested action and nothing else of the conversation: no transcript tail, no other paragraph.
 */
export function hermesEvent({ project, window: win = {}, decision, ask = null, at = null, correlationId }) {
  const blocked = decision.outcome === 'blocked';
  const index = Number.isInteger(win.index) ? win.index : null;
  const name = cleanLabel(win.name);
  const label = name || (index !== null ? `#${index}` : 'claude');
  const action = typeof ask === 'string' && ask.trim() ? cleanLabelText(ask) : null;
  const contract = {
    schema: CONTRACT_SCHEMA,
    project,
    window: { index, name },
    outcome: decision.outcome,
    intervention: INTERVENTIONS.includes(decision.intervention) ? decision.intervention : 'unknown',
    requested_action: action,
    source_time: isoOrNull(at),
    confidence_band: decision.band,
    decision_schema: decision.schema,
    decided_by: decision.model,
    correlation_id: correlationId,
    authority: 'none',
  };
  const what = blocked ? 'is blocked and needs a person to act' : 'is waiting for your answer';
  return {
    project,
    session: sessionName(index, name),
    event_type: blocked ? 'blocker' : 'question',
    summary: `${project} › ${label}: Claude ${what}.${action ? ` Asks: “${action}”` : ''}`.slice(0, 1000),
    evidence: JSON.stringify(contract),
    correlation_id: correlationId,
    urgency: blocked ? 'high' : 'normal',
  };
}

function cleanLabelText(text) {
  return redactSecrets(sanitizeText(text)).replace(/\s+/g, ' ').trim().slice(0, ASK_CHARS);
}

// ---------------------------------------------------------------- the per-window state

function errText(error) {
  return String(error?.message || error || 'error').replace(/[^\x20-\x7E]/g, '').slice(0, 120);
}

/**
 * The per-window state machine. observe() is called with every window listing
 * (the cockpit polls every 2s) and must stay cheap: it only notices bells and
 * queues work. annotate(), projectOutcome() and projectAsk() read the decided state.
 *
 * A window's outcome always belongs to the turn that is current NOW:
 * - every bell edge (rise or clear) starts a new generation, and a decision that
 *   finishes for an older generation is dropped, not attached to the new bell;
 * - while the bell stays up the transcript is re-read every RECHECK_MS, because
 *   a turn that paused ("I'll report back when CI finishes") can resume and end
 *   again without anyone viewing the tab, so tmux never sees the bell fall.
 *
 * A turn that needs someone is handed to `relay` (the durable outbox) — after one more, fresh
 * look at the window, immediately before. The in-memory maps here are only caches of work already
 * done: losing one costs a re-read or a re-evaluation, never a second relay, because the outbox
 * remembers every correlation ID it has accepted.
 */
export function createTurnTriage({
  readTails, evaluate, relay = null, lookupWindow = null, instance = 'pw', log = () => {},
  now = () => Date.now(), minConfidence = MIN_CONFIDENCE, recheckMs = RECHECK_MS,
}) {
  const windows = new Map(); // `${project}\u0000${windowId}` -> state
  const decided = new Map(); // turn cache key -> decision
  const handed = new Map(); // correlation id -> true once the outbox has it
  let running = false;
  let pending = [];

  const keyOf = (project, w) => `${project}\u0000${w.windowId}`;
  const turnKeyOf = (project, tail) => JSON.stringify([project, tail.sessionId, tail.uuid, tail.digest]);
  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
  };
  const emit = (event, fields = {}) => { try { log(event, fields); } catch {} };
  // What the UI may show: the decided outcome, held to the floor here too, whatever produced it.
  const shown = (d) => (d && OUTCOMES.includes(d.outcome) && d.band !== 'uncertain'
    && typeof d.probability === 'number' && d.probability >= minConfidence ? d.outcome : null);
  const validWindow = (w) => WINDOW_ID.test(String(w?.windowId ?? '')) && Number.isInteger(w?.index) && w.index >= 0 && w.index <= 99999;
  const watchedReason = (w) => (!w ? 'window_gone' : w.hibernated ? 'hibernated' : !w.bell ? 'viewed' : (w.active && w.attached > 0) ? 'watched' : '');

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const batch = pending; pending = [];
        let tails = {};
        try { tails = await readTails(batch.map(({ key, w }) => ({ key, panePid: w.panePid, credUser: w.credUser || '' }))) || {}; }
        catch (error) { emit('read_failed', { error: errText(error) }); }
        for (const item of batch) {
          const state = windows.get(item.key);
          if (!state || state.gen !== item.gen) { if (state) state.inflight = false; continue; } // a newer bell: re-queued by observe
          state.inflight = false;
          state.triedAt = now();
          // One window's failure must not strand the rest of the batch mid-flight.
          try { await decide(item, state, tails[item.key]); }
          catch (error) {
            state.attempts += 1; // a throw is an attempt too, so a window that always throws stops being asked
            emit('evaluation_failed', { project: item.project, window_index: item.w.index, error: errText(error) });
          }
        }
      }
    } finally {
      running = false;
    }
  }

  async function decide({ project, w, gen }, state, tail) {
    if (!tail) { if (!state.result) state.attempts += 1; return; } // mid-turn or not a Claude pane
    const turnKey = turnKeyOf(project, tail);
    if (state.result && state.result.turnKey === turnKey) { // same turn, already decided
      if (state.result.relayFailed && relay) {
        state.result.relayFailed = false;
        const identity = turnIdentity({ instance, project, sessionId: tail.sessionId, uuid: tail.uuid, digest: tail.digest });
        const { decision, ask } = state.result;
        startHandOver({ project, w, gen, state, tail, decision, ask, identity, fields: { project, window_index: w.index, correlation_id: identity?.correlationId } });
      }
      return;
    }
    // A newer turn ended: the old outcome stops describing this window NOW, before
    // the model is asked. If the ask fails the window is plain amber and retries
    // under the normal cap — never left showing what the previous turn wanted.
    if (state.result) { state.result = null; state.attempts = 0; }
    const identity = turnIdentity({ instance, project, sessionId: tail.sessionId, uuid: tail.uuid, digest: tail.digest });
    const fields = { project, window_index: w.index, correlation_id: identity?.correlationId };
    let decision = decided.get(turnKey);
    if (!decision) {
      emit('detected', fields);
      const answer = await evaluate({ assistant: tail.assistant, user: tail.user ?? null });
      if (!answer || answer.ok !== true || !answer.decision) {
        state.attempts += 1;
        emit('evaluation_failed', { ...fields, error: answer?.error || 'no_answer' });
        return;
      }
      decision = answer.decision;
      remember(decided, turnKey, decision);
      const outcome = shown(decision);
      emit(outcome ? 'evaluated' : 'uncertain', {
        ...fields, outcome: outcome || undefined, intervention: decision.intervention, band: decision.band,
        probability: decision.probability, confidence: decision.confidence, model: decision.model, schema: decision.schema,
        latency_ms: decision.latencyMs,
      });
    }
    if (state.gen !== gen) return; // the bell moved while the model answered
    const outcome = shown(decision);
    const ask = outcome && ATTENTION.has(outcome) ? requestedAction(tail.assistant, { outcome }) : null;
    state.result = { turnKey, decision, ask, relayFailed: false };
    if (relay && (outcome === 'needs_input' || outcome === 'blocked')) startHandOver({ project, w, gen, state, tail, decision, ask, identity, fields });
  }

  // A hand-over that failed (a full disk, a lock that timed out) is tried again on the next re-read
  // of the same turn, for as long as its bell stays up.
  function startHandOver(job) {
    const result = job.state.result;
    handOver(job).catch((error) => {
      if (job.state.result === result) result.relayFailed = true;
      emit('enqueue_failed', { ...job.fields, error: errText(error) });
    });
  }

  // Detached from the poll: a slow disk or a held lock must never stall the window listing.
  async function handOver({ project, w, gen, state, tail, decision, ask, identity, fields }) {
    const f = { ...fields, outcome: decision.outcome, band: decision.band };
    if (!identity || !validWindow(w)) return emit('suppressed', { ...f, reason: 'invalid_identifier' });
    if (handed.has(identity.correlationId)) return; // this process already handed it over
    // Immediately before enqueueing, look at the window afresh rather than trust the listing
    // the read was queued from: the person may have opened it while Jev was answering.
    let fresh = state.w || w;
    if (lookupWindow) {
      try { fresh = await lookupWindow(project, w.windowId); }
      catch { fresh = state.w || w; }
    }
    const reason = watchedReason(fresh);
    if (reason) return emit('suppressed', { ...f, reason });
    if (state.gen !== gen) return emit('suppressed', { ...f, reason: 'superseded' });
    const args = hermesEvent({ project, window: { index: w.index, name: w.name }, decision, ask, at: tail.at, correlationId: identity.correlationId });
    await relay({
      id: identity.correlationId, project, windowId: w.windowId, windowIndex: w.index,
      outcome: decision.outcome, intervention: decision.intervention, band: decision.band,
      decidedBy: decision.model, decisionSchema: decision.schema, probability: decision.probability, args,
    });
    remember(handed, identity.correlationId, true);
  }

  return {
    observe(project, list) {
      const listed = new Set();
      for (const w of Array.isArray(list) ? list : []) if (w?.windowId) listed.add(keyOf(project, w));
      // Windows closed while their bell was up are forgotten too.
      for (const [key, state] of windows) {
        if (key.startsWith(`${project}\u0000`) && !listed.has(key) && !state.inflight) windows.delete(key);
      }
      for (const w of Array.isArray(list) ? list : []) {
        if (!w?.windowId) continue;
        const key = keyOf(project, w);
        let state = windows.get(key);
        if (!w.bell || w.hibernated) {
          // The bell is gone (viewed, or a new turn started): forget this window
          // unless a read is in flight, whose result the generation bump discards.
          if (state) { if (state.inflight) { state.bell = false; state.gen += 1; state.result = null; state.w = w; } else windows.delete(key); }
          continue;
        }
        if (!state) { state = { bell: false, gen: 0, inflight: false, attempts: 0, triedAt: 0, result: null, w }; windows.set(key, state); }
        state.w = w; // the latest listing: what "is it being watched" is judged on
        if (!state.bell) { state.bell = true; state.gen += 1; state.attempts = 0; state.result = null; state.triedAt = 0; }
        if (state.inflight) continue;
        if (state.result) {
          if (now() - state.triedAt < recheckMs) continue; // decided: re-read now and then for a newer turn
        } else {
          if (state.attempts >= MAX_ATTEMPTS) continue;
          if (state.attempts > 0 && now() - state.triedAt < RETRY_AFTER_MS) continue;
        }
        state.inflight = true;
        pending.push({ key, project, w, gen: state.gen });
      }
      if (pending.length) drain().catch((error) => emit('read_failed', { project, error: errText(error) }));
    },
    // The decided outcome for each window whose bell is up; null when undecided
    // or not confident, which the UI renders as the plain amber it always did.
    // outcomeAsk: the redacted, bounded requested action, for an outcome that asks something.
    annotate(project, list) {
      return (Array.isArray(list) ? list : []).map((w) => {
        const state = w?.windowId ? windows.get(keyOf(project, w)) : null;
        const r = w?.bell && state?.bell ? state.result : null;
        const outcome = r ? shown(r.decision) : null;
        return { ...w, outcome, outcomeAsk: outcome && ATTENTION.has(outcome) ? (r.ask || null) : null };
      });
    },
    // One outcome for a project's rail key: the most urgent among its rung tabs.
    // Any rung tab without a confident outcome — or no rung tab at all, as when a
    // stray attach cleared the bells but the pending marker stands — answers null
    // (plain amber), so a project is never shown calmer than it may warrant.
    projectOutcome(project, list) {
      const rung = (Array.isArray(list) ? list : []).filter((w) => w.bell && (!w.active || w.attached === 0));
      if (!rung.length) return null;
      const outcomes = this.annotate(project, rung).map((w) => w.outcome);
      if (outcomes.some((o) => !o)) return null;
      return URGENCY.find((o) => outcomes.includes(o)) || null;
    },
    // The requested action behind the rail's outcome: the first rung tab showing it that has one.
    projectAsk(project, list) {
      const top = this.projectOutcome(project, list);
      if (!top || !ATTENTION.has(top)) return null;
      const rung = (Array.isArray(list) ? list : []).filter((w) => w.bell && (!w.active || w.attached === 0));
      for (const w of this.annotate(project, rung)) if (w.outcome === top && w.outcomeAsk) return w.outcomeAsk;
      return null;
    },
    /**
     * Immediately before the outbox delivers: is this still a turn that nobody has seen, in a
     * window that still exists, and still the turn the window is on? Reads the window and the
     * transcript afresh — after a restart nothing in memory knows either.
     */
    async recheck(entry) {
      if (!lookupWindow) return { deliver: true };
      let w;
      try { w = await lookupWindow(entry.project, entry.windowId); }
      catch { return { retry: true, reason: 'window_unreadable' }; }
      const reason = watchedReason(w);
      if (reason) return { deliver: false, reason };
      let tails;
      try { tails = await readTails([{ key: 'recheck', panePid: w.panePid, credUser: w.credUser || '' }]); }
      catch { return { retry: true, reason: 'tail_unreadable' }; }
      const tail = tails?.recheck;
      const current = tail ? turnIdentity({ instance, project: entry.project, sessionId: tail.sessionId, uuid: tail.uuid, digest: tail.digest }) : null;
      if (!current || current.correlationId !== entry.id) return { deliver: false, reason: 'superseded' };
      return { deliver: true };
    },
    clearProject() {}, // nothing project-wide is remembered beyond the rung tabs themselves
  };
}
