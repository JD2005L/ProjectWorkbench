# Turn outcomes: real Jev decisions, privacy-minimised context, durable strict-ack Hermes delivery

**Branch:** `fix/turn-outcome-context-durability` · **Base:** `origin/main` @ `bbb8ec9`
**Worktree:** `/opt/project-workbench/worktrees/ProjectWorkbench-turn-outcome-20261006` (isolated)
**Authorized by:** James (relayed by Hermes) — implement + commit only. No push, no PR, no merge, no deploy.

`PVI-DEV-v1 | Tier: 3 (privacy, idempotency/concurrency, cross-service contract) | Operator: James-direct (Hermes-relayed) | Gate budget: focused RED/GREEN per criterion; one full canonical host gate (cd app && npm test) at the frozen candidate; no nested reviewers`

## Corrections recorded before work started

- The brief's sentence "the current code defaults to `alibaba/qwen3.5-9b` through chat completions" is
  **superseded and false** (Hermes correction, 2026-10-06; independently confirmed): `bbb8ec9` and the
  live `/opt/project-workbench/app/turn-outcome.js` (byte-identical) call
  `POST https://ai-gateway.vercel.sh/v1/evaluate` with `model: "typesafe-ai/jev"` and
  `providerOptions.gateway = { zeroDataRetention: true, only: ["typesafe-ai"] }`. No `qwen` string exists
  anywhere in the repo, its history, the live app or `/etc/project-workbench`.
- **Contract verified against current official docs** (vercel.com/docs/ai-gateway/modalities/decision,
  last updated 2026-10-05): `/v1/evaluate` is the documented HTTP API for decisions ("If you are not
  using the AI SDK, post to `/v1/evaluate` with the same `model`, `state`, and `questions` fields"); the
  response reports `model`, `answers`, `usage`, `providerMetadata.gateway.routing`; the docs' own
  provider-options example is exactly `{ zeroDataRetention: true, only: ["typesafe-ai"] }`.
- **AI SDK decision: not adopted.** `ai@7.0.128` `experimental_decide` was read at source (npm tarball,
  scratchpad only): it posts the same `state`/`questions` to the SDK-internal
  `https://ai-gateway.vercel.sh/v4/ai/decision-model` path. It would not make the request more correct, and it does not
  fit the repo: `engines.node >= 22` while CI runs Node 20; peer `zod` + `@ai-sdk/gateway`,
  `@ai-sdk/provider`, `@ai-sdk/provider-utils` would be the first non-express dependencies; and
  `deploy/promote-app.sh` (GOA's only deploy path) refuses any static or dynamic import missing from the
  live `node_modules` — so shipping it would force a Jev SDK onto GOA, which must never run Jev. What
  *does* improve correctness — the SDK's answer validation (`validateDecisionAnswers`: exact answer
  keys, type match, known option, complete finite [0,1] distribution summing to 1 within
  1e-6 + n·½·10^-decimals, selected option maximal) — is ported into `app/turn-outcome.js` and tested.

## End state

1. A finished Claude turn is decided by TypeSafe AI's Jev with **two finite typed questions** over
   **bounded structured state** `{ latest_user_request, final_assistant_message }`: `outcome`
   (needs_input/blocked/failed/working/done) and `intervention`
   (answer/approval/credential_holder/deployment/manual_action/investigation/none). The resolved model,
   decision-schema version, validated selected-option probability and TypeSafe confidence are recorded.
   Anything invalid, out of range, not-Jev or uncertain is plain amber and authorizes nothing.
2. Every text that leaves the pane account's helper is **redacted first** (on the full message), then
   cut at paragraph → sentence → grapheme boundaries with an explicit `…[truncated]` marker.
   Hermes gets a deterministic **action contract** — never the transcript tail.
3. Actionable turns go through a **durable outbox** (`/var/lib/project-workbench/turn-outcome-outbox.json`,
   0600, flock-serialised via `withLifecycleLock`, atomic `writeFileAtomic`) keyed by an opaque
   correlation ID = H(instance, project, Claude session, assistant UUID, normalised-text digest).
   pending → sending(lease) → delivered | suppressed | failed, with attempts / last error / next retry,
   bounded exponential backoff, same correlation ID on every retry.
4. **Delivered only on strict MCP proof**: 2xx, JSON-RPC 2.0, matching id + session, no `isError`, typed
   payload with `accepted: true`, the exact correlation ID echoed, a durable `event_id`.
5. Suppression is re-checked against a fresh tmux read immediately before enqueue and before every
   delivery; identifiers are shape-checked; the tab/rail tooltip shows the safe requested-action excerpt
   to people who can already open that terminal.
6. Structured, secret-free logs + counters; leases released on SIGTERM/SIGINT when the outbox is active.

## Acceptance criteria (each must be shown RED before the production change, then GREEN)

| # | Criterion | Measured by |
|---|---|---|
| AC1 | Request is `/v1/evaluate`, `typesafe-ai/jev`, ZDR + only typesafe-ai, `redirect: 'error'`, state = `{latest_user_request, final_assistant_message}`, questions `outcome` + `intervention` with exactly the listed options | `test/turn-outcome.test.mjs` request-shape test |
| AC2 | Response validation: wrong/missing `model`, non-typesafe `finalProvider`, missing/extra answers, unknown option, missing/incomplete/non-finite/out-of-range distribution, bad sum, non-argmax choice, bad rounding, out-of-range TypeSafe confidence ⇒ no outcome; p<0.8 or TypeSafe confidence<0.6 ⇒ `uncertain`; calm outcome contradicted by a confident non-`none` intervention ⇒ uncertain; resolved model + schema + band recorded | decision-validation table test |
| AC3 | Context: latest genuine user request found past tool calls/meta/command echoes; redaction precedes truncation; secrets (≥12 formats) placed across BOTH truncation boundaries never appear even partially; marker present; Unicode (surrogates, ZWJ emoji, combining marks, CJK) never split; unrelated paragraphs absent from the Hermes excerpt | context tests in `test/turn-context.test.mjs` |
| AC4 | Hermes contract is deterministic JSON with project/window, outcome, intervention, requested_action, source_time, confidence_band, schema, correlation_id; no transcript tail; receiver-valid `session`/`correlation_id` | contract test |
| AC5 | Outbox: enqueue is idempotent per correlation ID; survives a restart between detection and delivery; two producer instances on one ledger deliver exactly once; >500 turns never re-relay an old turn; backoff is bounded exponential; terminal after max attempts; lease recovery after a crash | `test/turn-outbox.test.mjs` |
| AC6 | Strict ack: each malformed case (redirect, 204, empty, non-JSON, batch, wrong jsonrpc/id, error object, isError, initialized ≠ 2xx, session mismatch, missing/false/string `accepted`, wrong/missing correlation, missing/bad event_id, `ok:false`, oversize, SSE without match) is a retryable failure; never logged as accepted; timeout-after-receiver-commit retries the same correlation and ends delivered with the receiver's original event ID | strict-ack tests |
| AC7 | Suppression re-check at enqueue and delivery (watched, viewed, window gone, superseded turn); invalid identifiers never enqueue; UI keeps existing colours, adds the excerpt to tab title / rail title only for terminal roles | triage + server-source tests |
| AC8 | Structured logs carry event, correlation_id, band, latency_ms, attempt, receiver_event_id and never message text; counters exposed | observability test |
| AC9 | Opt-in unchanged (`PW_TURN_OUTCOME` + key file; Hermes needs `PW_TURN_OUTCOME_HERMES=on`); transcript reads still O_NOFOLLOW as the pane account; `app/VERSION` bumped; full canonical gate green | existing opt-in/no-follow tests + `npm test` |

## Verification commands

```
cd app && node --test ../test/turn-outcome.test.mjs ../test/turn-context.test.mjs ../test/turn-outbox.test.mjs   # focused
node --check app/server.js app/turn-outcome.js app/turn-context.js app/turn-outbox.js
cd app && npm test        # canonical host gate, once, at the frozen candidate
git diff --check
```

## Design decisions (made during the loop)

- **Modules.** `app/turn-context.js` (sanitize → redact → cut; requested-action selection; digest),
  `app/turn-outbox.js` (ledger, delivery worker, strict MCP client, structured log), and
  `app/turn-outcome.js` (transcript reading, the Jev decision and its validation, identity, contract,
  per-window triage). The privilege-dropped helper (`credential-writer.mjs` → `readTurnTails`) now
  returns only redacted, bounded excerpts plus a digest, never the raw message.
- **Gating.** Outcome shown iff the selected-option probability ≥ 0.8 (the pilot's calibrated measure)
  and TypeSafe's own confidence, when reported, ≥ 0.6 (Vercel's routing guide floor). A calm outcome
  (done/working) additionally needs the independent intervention question to give P(`none`) ≥ 0.5,
  because a calm tab stops pulsing. Intervention kind reported only at ≥ 0.8 and consistent with the
  outcome, else `unknown`. Band: high ≥ 0.95, medium ≥ 0.8, else uncertain.
- **Resolved model.** `model` must be the Jev family and `routing.finalProvider` (when present) must be
  `typesafe-ai`; anything else is `not_jev` → amber. Live response (2026-10-06) confirmed
  `model: "typesafe-ai/jev"`, complete per-question distributions, `providerMetadata.typesafe.confidence`.
- **Identity.** `pwt1-` + 32 hex of SHA-256(["pw-turn/1", instance, project, sessionId, uuid, digest]);
  instance = `PW_INSTANCE_ID` || hostname (stable across restarts, shared by overlapping processes).
- **Ledger.** `/var/lib/project-workbench/turn-outcome-outbox.json` (`PW_TURN_OUTCOME_OUTBOX_PATH`),
  lock `.turn-outcome-outbox.json.lock` beside it. Backoff 5 s × 2^(n−1) capped at 300 s, 8 attempts
  (~10 min span), lease 60 s, ≤ 200 owed entries, terminal entries compacted (no excerpt kept) and
  pruned after 30 days / beyond 2000. Idle polls read without the lock (atomic-rename snapshot).
- **Excerpt reach.** `outcomeAsk` on `/api/term/:project/windows` (already terminal-gated) and on
  `/api/projects/status` only for `TERMINAL_ROLES`; the agent API projects its own fields, so it does
  not gain it. Tooltips are set as DOM properties, never HTML.

## Evidence

**RED before production changes** (2026-10-06 ~18:45Z, `bbb8ec9` code):
- The three new/rewritten test files fail at import (`turn-context.js`/`turn-outbox.js` absent).
- Behavioural probe on the unchanged module — 13/14 defects confirmed: unredacted fragment of a
  token cut at the 2500-char boundary in the Jev state; unredacted password sent to Jev; no
  intervention question / no structured state; a non-Jev, incomplete-distribution answer accepted;
  Hermes evidence carrying unrelated paragraphs; four malformed MCP replies (204/empty, wrong id, no
  `accepted`, `accepted:false`) counted as "told Hermes"; the same turn re-relayed after a restart and
  after >500 turns; identity = bare message uuid (project Q never told); no fresh re-check.
  (The 14th probe was green only because the old 1500-char slice happened to exclude the token.)
- Late regression (redaction marker mistaken for the block): RED with the pre-fix matcher
  (picked "For the record, the old value was [redacted token]."), GREEN after.

**GREEN (focused):** `turn-context` 18/18, `turn-outbox` 23/23, `turn-outcome` 48/48; adjacent suites
(api-tokens-register, cockpit-hibernation-recovery, user-lifecycle, cockpit-client-script,
completion-latch, agent-sessions, env-contract) 85/85; `release-version` 21/21; `git diff --check` clean.

**End-to-end smoke** (scratchpad script, not committed; isolated dashboard from this worktree): real
tmux bell → real credential helper reading a synthetic transcript from a temp per-user tree → real
Jev (`blocked`/`credential_holder`, p=1, 605 ms) → outbox → strict MCP client → local fake
pvi-authority → `delivered` on attempt 1 with the receiver's event id; ledger 0600; contract carried
the redacted requested action only; real headless Chromium tab tooltip showed the excerpt with the
existing red `out-blocked` styling; no secret anywhere.

## Remaining risks

- **Receiver rollout order (cross-service).** pvi-authority at `14d00ae` returns `ok/event_id/
  correlation_id/duplicate` but **not `accepted: true`**. Until the receiver returns it, every relay
  is retried 8 times over ~10 min and ends `failed`, and because the current receiver dedupes on
  exact content only inside a 300–600 s window, late retries can create duplicate Hermes events.
  Deploy the receiver change (accepted + correlation-ID idempotency) first.
- **Accuracy re-baseline.** The pilot's figures were measured on the old single-question,
  message-only state. The new state and second question are validated for shape and gating, not
  re-scored against the 197-turn reference set.

## Progress log

- 2026-10-06 18:25Z — Read AGENTS.md, shared memory (CLAUDE/DEVELOPMENT_STANDARD), package.json, CI
  workflow, promote-app.sh guard, receiver (`PVIAuthority` worktree, read-only) contract. Baseline
  `test/turn-outcome.test.mjs` 32/32 at `bbb8ec9`. Host load ~42, memory pressure 0.
- 2026-10-06 18:40Z — Official docs + `ai@7.0.128` source read; live Jev contract smoke (3 synthetic
  requests). SDK not adopted (see above). RED recorded.
- 2026-10-06 19:05Z — All criteria GREEN on focused tests; end-to-end smoke passed; `app/VERSION`
  1.26.1006.1904; candidate frozen; full canonical host gate started.
- 2026-10-06 19:07Z — Gate STOPPED at ~870 tests (no failures so far) to fix three things found while
  it ran: three lease tests waited a fixed 100–200 ms for a claim (flock spawn + fsync) instead of
  polling the ledger; the timeout-after-commit test used one 60 ms timeout for the retry too; the
  helper protocol comment in `credential-writer.mjs` still described the raw `text` output. The
  interrupted run had orphaned three test tmux servers (`pwhibtest-`, `pw20test-`,
  `pw20restoretest-`, cwd = this worktree) and one `pw-claude-wait` placeholder; killed by their own
  sockets — the production `default` server untouched. Focused 89/89; outbox file 3× stable at load 46.
  Re-frozen and the full gate restarted on the exact tree to be committed.
- 2026-10-06 19:13Z — **Full canonical host gate** (`cd app && npm test`, frozen candidate, load ~42):
  2321 tests, **2302 pass, 1 fail, 18 skipped**, 3m50s. The one failure,
  `per-launcher-cockpit` "a tab opened by a person runs on THEIR credentials, labelled and
  coloured", is **pre-existing and environmental**: it fails 3/3 alone on this candidate and 2/2 on a
  pristine `git archive bbb8ec9`. Root cause, shown with `remain-on-exit` + `list-panes -a`: the
  launcher's tab is alive with the launcher's `CLAUDE_CONFIG_DIR`, but this host's **tmux 3.4 prints
  the test's literal tab in a `-F` format as `_`** (`0_"sleep 30"` under `od -c`), so the test's
  `startsWith('1\t')` can never match here. Turn outcomes are off in that fixture and the
  window-creation path is untouched by this change.
