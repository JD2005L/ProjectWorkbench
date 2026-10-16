// CI results — a finished GitHub Actions run, routed back to the PW session that
// made the commit, so the session that already has the context can fix and resubmit.
//
//   GitHub App (workflow_run: completed) -> n8n relay -> POST /api/ci/github -> here
//
// The commit carries the route: scripts/pw-git-hook signs every commit a PW Claude
// session makes with `PW-Session: <instance>/<tmux session>/<window id>`, and the
// workflow_run payload includes the head commit's message. See docs/ci-results.md.
//
// Trust: n8n is only a pipe. It forwards GitHub's raw body and X-Hub-Signature-256
// untouched, and PW verifies that signature itself with the webhook secret, so
// neither the relay nor anyone on the network can forge a result. What reaches a
// session is a FIXED-FORMAT status built here from validated fields — never the
// commit message, the log, or anything else a commit author controls as free text.

import crypto from 'node:crypto';

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

const SIG = /^([A-Za-z0-9._-]{1,64})\/(pw_[A-Za-z0-9_]{1,120})\/(@[0-9]{1,9})$/;
export function parseSignature(value) {
  const m = SIG.exec(String(value || '').trim());
  return m ? { instance: m[1], session: m[2], windowId: m[3] } : null;
}

// The LAST PW-Session trailer wins, as git's own trailer handling would have it.
export function signatureFromMessage(message) {
  let found = null;
  for (const line of String(message || '').split('\n')) {
    const m = /^PW-Session:\s*(\S+)\s*$/.exec(line);
    if (m) found = m[1];
  }
  return found;
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
  if (payload?.action !== 'completed') return { ignore: `action ${safe(payload?.action, 40) || 'missing'}` };
  const run = payload.workflow_run || {};
  const conclusion = String(run.conclusion || '');
  if (!REPORTED.includes(conclusion)) return { ignore: `conclusion ${safe(conclusion, 40) || 'none'}` };
  const repo = String(payload.repository?.full_name || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { ignore: 'no repository' };
  const sha = String(run.head_sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ignore: 'no head sha' };
  const sig = parseSignature(signatureFromMessage(run.head_commit?.message));
  if (!sig) return { ignore: 'commit not signed by a PW session' };
  const url = String(run.html_url || '');
  const runId = Number(run.id);
  if (!Number.isSafeInteger(runId)) return { ignore: 'no run id' };
  return {
    ...sig,
    repo, sha, runId,
    attempt: Number(run.run_attempt) || 1,
    branch: safe(run.head_branch, 120) || '(detached)',
    workflow: safe(run.name, 100) || 'workflow',
    conclusion,
    url: /^https:\/\/github\.com\/[A-Za-z0-9._\/-]+$/.test(url) ? url : `https://github.com/${repo}/actions/runs/${runId}`,
  };
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
    + 'This is an automated CI status from ProjectWorkbench, not a message from James. A commit signed by this window triggered it. '
    + `If this change is still yours: inspect it with \`gh run view ${run.runId} --repo ${run.repo} --log-failed\`, fix the cause, and push again. `
    + `Automatic retry ${streak} of ${cap}; if it fails again after that, it stops coming here and goes to James.`;
}

/**
 * The queue between "GitHub said" and "the session heard". Persisted through
 * load/save so a restart loses nothing. tryDeliver(item) answers 'delivered',
 * 'wait' (busy, mid-turn, someone's draft in the composer, still waking) or
 * { gone: reason } (window closed, wrong repository...), which escalates.
 */
export function createCiResults({
  instanceId, load, save, tryDeliver, escalate, log = () => {}, now = () => Date.now(),
  cap = RETRY_CAP, maxWaitMs = MAX_WAIT_MS,
}) {
  let state = null;
  let ticking = false;

  async function current() {
    if (state) return state;
    let loaded = null;
    try { loaded = await load(); } catch (error) { log(`state unreadable, starting empty: ${error?.message || error}`); }
    state = {
      seen: Array.isArray(loaded?.seen) ? loaded.seen.slice(-SEEN_LIMIT) : [],
      streaks: loaded?.streaks && typeof loaded.streaks === 'object' ? loaded.streaks : {},
      queue: Array.isArray(loaded?.queue) ? loaded.queue : [],
    };
    return state;
  }
  const persist = () => save(state).catch((error) => log(`state not saved: ${error?.message || error}`));
  const lane = (r) => `${r.session}|${r.windowId}|${r.repo}|${r.branch}|${r.workflow}`;

  return {
    async receive(run) {
      const s = await current();
      if (run.instance !== instanceId) return { accepted: false, reason: `signed for instance ${run.instance}, this is ${instanceId}` };
      const id = `${run.runId}:${run.attempt}`;
      if (s.seen.includes(id)) return { accepted: false, reason: 'already received' };
      s.seen.push(id);
      if (s.seen.length > SEEN_LIMIT) s.seen.splice(0, s.seen.length - SEEN_LIMIT);
      const key = lane(run);
      const failed = FAILED.includes(run.conclusion);
      const streak = failed ? (Number(s.streaks[key]) || 0) + 1 : 0;
      if (failed) s.streaks[key] = streak; else delete s.streaks[key];
      // A newer result for the same lane supersedes one still waiting to be delivered.
      s.queue = s.queue.filter((q) => lane(q.run) !== key);
      if (failed && streak > cap) {
        await persist();
        await escalate({ run, reason: `failed ${streak} times in a row; automatic retries stopped after ${cap}` });
        return { accepted: true, reason: 'retry limit reached: escalated instead of delivered' };
      }
      s.queue.push({ run, streak, receivedAt: now(), text: statusPrompt(run, { streak, cap }) });
      await persist();
      return { accepted: true, reason: 'queued for the session' };
    },
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        const s = await current();
        const keep = [];
        let changed = false;
        for (const item of s.queue) {
          let outcome;
          try { outcome = await tryDeliver(item); }
          catch (error) { log(`delivery check failed: ${error?.message || error}`); outcome = 'wait'; }
          if (outcome === 'delivered') { changed = true; continue; }
          if (outcome && typeof outcome === 'object' && outcome.gone) {
            changed = true;
            await escalate({ run: item.run, reason: outcome.gone }).catch((error) => log(`escalation failed: ${error?.message || error}`));
            continue;
          }
          if (now() - item.receivedAt > maxWaitMs) {
            changed = true;
            await escalate({ run: item.run, reason: 'the session did not become free to receive it within 24 hours' }).catch(() => {});
            continue;
          }
          keep.push(item);
        }
        if (changed) { s.queue = keep; await persist(); }
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
    if (/^\s*❯/.test(plain)) return plain.trim() === '❯';
  }
  return false;
}
