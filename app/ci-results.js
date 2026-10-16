// CI results — a finished GitHub Actions run, routed back to the PW session that
// made the commit, so the session that already has the context can fix and resubmit.
//
//   GitHub App (workflow_run: completed) -> n8n relay -> POST /api/ci/github -> here
//
// The route is the LEDGER (scripts/pw-git-hook): every commit a PW Claude window makes
// is recorded locally as <sha> <tmux session> <window id> <pane pid>. A run is delivered
// only when its head SHA is in this instance's ledger and that window still has that
// pane. The PW-Session trailer on the commit is a visible label and decides nothing — a
// commit message is text anyone can write (a fork's pull request included), while the
// ledger is what this machine saw its own sessions do. See docs/ci-results.md.
//
// Trust: n8n is only a pipe. It forwards GitHub's raw body and X-Hub-Signature-256
// untouched, and PW verifies that signature itself with the webhook secret, so
// neither the relay nor anyone on the network can forge a result. What reaches a
// session is a FIXED-FORMAT status built here from validated fields — never the
// commit message, the log, or anything else a commit author controls as free text.

import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export const FAILED = Object.freeze(['failure', 'timed_out', 'startup_failure']);
export const REPORTED = Object.freeze([...FAILED, 'success']); // cancelled/skipped/neutral: superseded or irrelevant
export const RETRY_CAP = 3;
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const SEEN_LIMIT = 2000;

// Opt-in per instance, and only an explicit yes counts (as with turn outcomes):
// an upgrade must never switch it on anywhere by itself.
export function ciResultsOptedIn(env = process.env) {
  return ['on', 'true', '1', 'yes'].includes(String(env?.PW_CI_RESULTS ?? '').trim().toLowerCase());
}

export function verifyGithubSignature(raw, header, secret) {
  if (!Buffer.isBuffer(raw) || !secret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Text that came from GitHub and is shown inside a prompt: names only, no markup,
// no newlines, bounded. A workflow or branch name is chosen by whoever can push.
function safe(text, max = 100) {
  return String(text ?? '').replace(/[^A-Za-z0-9 ._:/@#()+\-]/g, '').trim().slice(0, max);
}

/**
 * The fields of a completed workflow run that matter here, or { ignore: reason }.
 */
export function parseWorkflowRun(event, payload) {
  if (event !== 'workflow_run') return { ignore: `event ${safe(event, 40) || 'missing'}` };
  // Only runs a commit actually caused: a push, or a pull request from a branch of the SAME
  // repository. A fork's pull request, a schedule or a manual dispatch is not "your commit".
  const trigger = String(payload?.workflow_run?.event || '');
  if (trigger === 'pull_request') {
    const head = payload?.workflow_run?.head_repository?.full_name;
    if (!head || head !== payload?.repository?.full_name) return { ignore: 'pull request from another repository' };
  } else if (trigger !== 'push') return { ignore: `triggered by ${safe(trigger, 40) || 'unknown'}` };
  if (payload?.action !== 'completed') return { ignore: `action ${safe(payload?.action, 40) || 'missing'}` };
  const run = payload.workflow_run || {};
  const conclusion = String(run.conclusion || '');
  if (!REPORTED.includes(conclusion)) return { ignore: `conclusion ${safe(conclusion, 40) || 'none'}` };
  const repo = String(payload.repository?.full_name || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { ignore: 'no repository' };
  const sha = String(run.head_sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ignore: 'no head sha' };
  const url = String(run.html_url || '');
  const runId = Number(run.id);
  if (!Number.isSafeInteger(runId)) return { ignore: 'no run id' };
  return {
    repo, sha, runId,
    attempt: Number(run.run_attempt) || 1,
    branch: safe(run.head_branch, 120) || '(detached)',
    workflow: safe(run.name, 100) || 'workflow',
    conclusion,
    url: /^https:\/\/github\.com\/[A-Za-z0-9._\/-]+$/.test(url) ? url : `https://github.com/${repo}/actions/runs/${runId}`,
  };
}

/**
 * The ledger entry for a commit, newest first, or null. `text` is the ledger file's
 * content (or its tail): lines of "<sha> <tmux session> <window id> <pane pid> <epoch>".
 */
export function ledgerLookup(text, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return null;
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const f = lines[i].trim().split(/\s+/);
    if (f[0] !== sha || f.length < 5) continue;
    const [, session, windowId, panePid, at] = f;
    if (!/^pw_[A-Za-z0-9_]{1,120}$/.test(session) || !/^@[0-9]{1,9}$/.test(windowId) || !/^[0-9]{1,10}$/.test(panePid)) continue;
    return { session, windowId, panePid, at: Number(at) || 0 };
  }
  return null;
}

/** Where the git hook keeps the ledger, in the pane account's home. */
export function ledgerPath(home) { return path.join(home, '.local', 'state', 'project-workbench', 'ci-commits.log'); }

/**
 * Look a commit up in the ledger file. Runs AS the pane account (credential-writer.mjs,
 * action 'ci-ledger'): the ledger is that account's file. Only the newest 4 MB is read.
 */
export async function readLedgerEntry({ fsp, file, sha }) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const bytes = Math.min(stat.size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
    return ledgerLookup(buffer.subarray(0, bytesRead).toString('utf8'), sha);
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

export function repoMatches(projectRepo, fullName) {
  const norm = (s) => String(s || '').trim().toLowerCase()
    .replace(/^git@github\.com:/, '').replace(/^https?:\/\/(?:[^@/]+@)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return !!fullName && norm(projectRepo) === norm(fullName);
}

export function statusPrompt(run, { streak = 0, cap = RETRY_CAP } = {}) {
  const what = `${run.repo} · workflow "${run.workflow}" · branch ${run.branch} · commit ${run.sha.slice(0, 7)}`;
  if (!FAILED.includes(run.conclusion)) {
    return `[PW CI] Run passed — ${what}. Run: ${run.url}\n`
      + 'This is an automated CI status from ProjectWorkbench, not a message from James. '
      + 'Nothing is needed unless you were waiting on this run.';
  }
  return `[PW CI] Run FAILED (${run.conclusion}) — ${what}. Run: ${run.url}\n`
    + 'This is an automated CI status from ProjectWorkbench, not a message from James. A commit made in this window triggered it. '
    + `If this change is still yours: inspect it with \`gh run view ${run.runId} --repo ${run.repo} --log-failed\`, fix the cause, and push again. `
    + `Automatic retry ${streak} of ${cap}; if it fails again after that, it stops coming here and goes to James.`;
}

/**
 * The queue between "GitHub said" and "the session heard". Persisted through
 * load/save so a restart loses nothing. A run handed to receive() already carries its
 * ledger route (session, windowId, panePid). tryDeliver(item) answers 'delivered',
 * 'wait' (busy, mid-turn, someone's draft in the composer, still waking) or
 * { gone: reason } (window closed or replaced, wrong repository...), which escalates.
 */
export function createCiResults({
  load, save, tryDeliver, escalate, log = () => {}, now = () => Date.now(),
  cap = RETRY_CAP, maxWaitMs = MAX_WAIT_MS,
}) {
  let loading = null;
  let ticking = false;

  // Loaded once; every caller shares the same state object.
  function current() {
    if (!loading) {
      loading = (async () => {
        let loaded = null;
        try { loaded = await load(); } catch (error) { log(`state unreadable, starting empty: ${error?.message || error}`); }
        return {
          seen: Array.isArray(loaded?.seen) ? loaded.seen.slice(-SEEN_LIMIT) : [],
          streaks: loaded?.streaks && typeof loaded.streaks === 'object' ? loaded.streaks : {},
          queue: Array.isArray(loaded?.queue) ? loaded.queue : [],
        };
      })();
    }
    return loading;
  }
  const lane = (r) => `${r.session}|${r.windowId}|${r.repo}|${r.branch}|${r.workflow}`;

  return {
    async receive(run) {
      const s = await current();
      const id = `${run.runId}:${run.attempt}`;
      if (s.seen.includes(id)) return { accepted: false, reason: 'already received' };
      const key = lane(run);
      // All or nothing: if the save fails, the state is as if this delivery never came, so
      // GitHub/n8n retrying it is accepted rather than discarded as "already received".
      const before = { queue: s.queue, streak: s.streaks[key], seen: s.seen.length };
      const failed = FAILED.includes(run.conclusion);
      const streak = failed ? (Number(s.streaks[key]) || 0) + 1 : 0;
      if (failed) s.streaks[key] = streak; else delete s.streaks[key];
      // A newer result for the same lane supersedes one still waiting to be delivered.
      s.queue = s.queue.filter((q) => lane(q.run) !== key);
      const over = failed && streak > cap;
      if (!over) s.queue.push({ run, streak, receivedAt: now(), text: statusPrompt(run, { streak, cap }) });
      // Seen only once it is safely recorded: a save that throws leaves it retryable.
      s.seen.push(id);
      try { await save(s); }
      catch (error) {
        s.queue = before.queue;
        if (before.streak === undefined) delete s.streaks[key]; else s.streaks[key] = before.streak;
        s.seen.length = before.seen;
        throw error;
      }
      if (s.seen.length > SEEN_LIMIT) s.seen.splice(0, s.seen.length - SEEN_LIMIT);
      if (over) {
        try { await escalate({ run, reason: `failed ${streak} times in a row; automatic retries stopped after ${cap}` }); }
        catch (error) { log(`escalation failed: ${error?.message || error}`); }
        return { accepted: true, reason: 'retry limit reached: escalated instead of delivered' };
      }
      return { accepted: true, reason: 'queued for the session' };
    },
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        const s = await current();
        // Work on a snapshot, then remove ONLY what was handled from the live queue: a
        // result received meanwhile (or one that superseded an item) is never overwritten.
        const handled = new Set();
        for (const item of [...s.queue]) {
          let outcome;
          try { outcome = await tryDeliver(item); }
          catch (error) { log(`delivery check failed: ${error?.message || error}`); outcome = 'wait'; }
          if (outcome === 'delivered') { handled.add(item); continue; }
          let reason = null;
          if (outcome && typeof outcome === 'object' && outcome.gone) reason = outcome.gone;
          else if (now() - item.receivedAt > maxWaitMs) reason = 'the session did not become free to receive it within 24 hours';
          if (reason) {
            handled.add(item);
            await Promise.resolve().then(() => escalate({ run: item.run, reason })).catch((error) => log(`escalation failed: ${error?.message || error}`));
          }
        }
        if (handled.size) {
          s.queue = s.queue.filter((q) => !handled.has(q));
          await save(s).catch((error) => log(`state not saved: ${error?.message || error}`));
        }
      } finally {
        ticking = false;
      }
    },
    async pending() { return (await current()).queue.length; },
  };
}

/**
 * Is a Claude Code composer empty? `capture` is `tmux capture-pane -p -e` output
 * (escape sequences kept). The input line starts with ❯. Claude Code draws its
 * suggested next prompt there in DIM text (SGR 2), which is not input and is
 * ignored; anything drawn normally after ❯ is somebody's half-written message, and
 * a pasted status would be appended to it and submitted with it, so delivery waits.
 * Unrecognisable means "not empty".
 */
export function composerIsEmpty(capture) {
  const lines = String(capture || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i]
      .replace(/\x1b\[2m[\s\S]*?(?:\x1b\[(?:0|22)?m|$)/g, '') // dim suggestion text
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // every other escape sequence
      .replace(/\u00a0/g, ' ');
    if (/^\s*❯/.test(plain)) return plain.trim() === '❯' && !/\[(Pasted text|Image)\b/.test(lines[i]);
  }
  return false;
}

/** A turn in progress: Claude Code's footer offers to interrupt it. */
export function screenShowsBusy(capture) {
  return /esc to interrupt/i.test(String(capture || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
}
