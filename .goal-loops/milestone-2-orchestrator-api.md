# Milestone 2 — ProjectWorkbench orchestration API + constrained MCP adapter

**Branch:** `milestone-2-orchestrator-api` · **Repo:** `JD2005L/ProjectWorkbench` ·
**Normative contract:** `/opt/project-workbench/workspaces/PVICodingOrchestrator/docs/pw-contract.md` (read-only)

**End state.** A portable, configuration-driven orchestration subsystem — durable job engine, HTTP API
at `/api/orchestrator/v1`, constrained MCP adapter, subscription-backed Claude runner, approval-gated
publication — serving every operation in the contract §3/§4 plus the §9 Milestone-2 additions, with
payloads that validate against the orchestrator's Pydantic contracts, `npm test` green on Node 20, and
every existing PW feature untouched. Disabled by default so existing installs are inert.

---

## Assessment findings (read-only pass)

| Finding | Consequence |
|---|---|
| Orchestrator ships **no HTTP client** — only `FakeWorkbenchClient` + Pydantic models | "Exact wire compatibility" = PW JSON must validate against `contracts/*.py` + `workbench/protocol.py`. Proven by a committed fixture and a venv-python cross-check. |
| PW Node floor is **20** (`install.sh` → `setup_20.x`; CI `node-version: '20'`) | `node:sqlite` (≥22.5) is out. Durable store is a purpose-built append-only WAL journal in pure Node. |
| Claude CLI exposes `--model --effort --output-format json --max-turns --permission-mode --session-id --resume --fork-session` | Contract §6 verification mechanism is implementable exactly as specified. |
| PW deps: `express` only; tests `node --test ../test/*.test.mjs` (flat glob) | New tests land flat as `test/orch-*.test.mjs`; no package.json/CI change needed. |
| Existing patterns to reuse | `resolveIsolation()`, `test/smoke.test.mjs` spawn harness, `withProjectsLock` idiom, `audit()` JSONL, `tmuxSession()`, `requireAuth`/`requireProjectAccess` shape. |

## Assumptions

1. Storage = append-only WAL journal + snapshot, **not** SQLite (Node 20 floor).
2. No real OAuth-backed Claude run in the suite (requirement 10 forbids touching live OAuth). Real
   adapter proven by argv/parse tests + one documented opt-in manual smoke. One small real
   `claude -p --output-format json` probe in increment 6 to confirm the effective-model field exists.
3. Subsystem **disabled by default** (`PW_ORCHESTRATOR_ENABLED=false`).
4. Publication PR fetch via `gh`, capability-detected; absent `gh` degrades explicitly.

## Verification commands (every pass)

```
cd app && npm test                 # node --test ../test/*.test.mjs
node --check <each new file>
git diff --check
scripts/orch-secret-scan (added lines)
PVICodingOrchestrator/.venv/bin/python  # cross-contract validation, read-only, skip-if-absent
```

---

## Acceptance criteria

Status legend: `PASS` (independently verified) · `FAIL` · `—` (not yet attempted)

### A. Wire contract
| # | Criterion | Status | Evidence |
|---|---|---|---|
| A1 | All contract endpoints + M2 additions served at exact paths | — | |
| A2 | Responses validate against orchestrator Pydantic **and** committed fixture | — | |
| A3 | `schema_version` 1.0; wrong major → `unsupported_schema_version`; unknown fields rejected | — | |
| A4 | §10 error envelope + exact status/code table; no trace/env/credential/unredacted command | — | |
| A5 | Bounded types, list caps, pagination ≤200, oversize → 413 | — | |

### B. Durable engine
| # | Criterion | Status | Evidence |
|---|---|---|---|
| B1 | Crash mid-write reconciles on restart; no state without a record | — | |
| B2 | Gapless per-job sequences from 1, durable, SSE-resumable across restart | — | |
| B3 | Idempotent submit → `deduplicated: true`; different body → 409 `idempotency_key_reused` | — | |
| B4 | Illegal transition → 409 `invalid_transition`; families match orchestrator `states.py` | — | |
| B5 | Fencing tokens monotone; lower → 409 `lease_lost`; heartbeat renews; takeover raises | — | |
| B6 | Evidence rules enforced at record time | — | |

### C. Ownership & isolation
| # | Criterion | Status | Evidence |
|---|---|---|---|
| C1 | Explicit configured resolution, no hostname inference; unowned → 403 | — | |
| C2 | Lane naming exactly per §5; second ensure reuses | — | |
| C3 | Human tmux window provably untouched across ensure and `force_replace` | — | |
| C4 | Naming config-driven with contract defaults | — | |
| C5 | No traversal/symlink escape/worktree collision; one write lease per project | — | |
| C6 | Cancel leaves tree byte-identical; git argv allowlist forbids reset/stash/clean/checkout-- | — | |

### D. Runner & verification
| # | Criterion | Status | Evidence |
|---|---|---|---|
| D1 | Exact claude argv, reapplied on every resume | — | |
| D2 | Real effective settings; unqueryable → `effective: null` + `blocked_configuration` pre-read | — | |
| D3 | No API-key path; only subscription OAuth representable | — | |
| D4 | Auth/rate/malformed/death/timeout/cancel → distinct safe states preserving work | — | |
| D5 | Checks allowlisted + canonicalized; real exit codes/counts + artifact | — | |
| D6 | Review in a fresh session that provably didn't implement; fail-closed | — | |

### E. Interaction & publication
| # | Criterion | Status | Evidence |
|---|---|---|---|
| E1 | Real question ids/options/scope/expiry; stale/cross/double answers fail | — | |
| E2 | Typed approvals; recorded decision required; chat text never approves | — | |
| E3 | `pw_publish` intended-files-only, SHA parity, live PR, explicit no-CI; no merge/deploy/delete/rewrite path | — | |
| E4 | Revisions bounded by `max_revision_cycles` and audited | — | |

### F. Authorization
| # | Criterion | Status | Evidence |
|---|---|---|---|
| F1 | Scoped bearer; 401/403 table; instance mismatch refused; cross-instance job → 404 | — | |
| F2 | Orchestrator routes separated from browser CSRF/session, both directions | — | |
| F3 | MCP closed tool set, sampling disabled, no forbidden name fragments | — | |
| F4 | Rate limits, replay, oversized/malformed, unsafe error reflection | — | |
| F5 | Planted synthetic secrets redacted everywhere | — | |

### G. Portability
| # | Criterion | Status | Evidence |
|---|---|---|---|
| G1 | Config-driven; grep proves no CT2115/PVI2/live-path constants outside examples+docs | — | |
| G2 | Node 20 clean; no native/experimental deps | — | |
| G3 | `/health` reports db/queue/runner/auth + degraded, secret-free | — | |
| G4 | Migrations + install/upgrade/rollback documented; no live-config mutation | — | |
| G5 | All existing tests pass; existing features unchanged | — | |

### H. Verification discipline
| # | Criterion | Status | Evidence |
|---|---|---|---|
| H1 | Full lifecycle test on fake backend + temp repo/DB/tmux namespace | — | |
| H2 | Restart/cancel/failure/cross-project-attack tests | — | |
| H3 | Alternate-port HTTP+MCP smoke; teardown leaves nothing behind | — | |
| H4 | `git diff --check` clean; secret scan clean; no runtime artefacts committed | — | |
| H5 | Independent reviews (security+concurrency, lifecycle, wire, non-regression); P0/P1 resolved | — | |

---

## Increment plan

1. Config + contract vocabulary + strict validator + error envelope + redaction
2. Durable journal store + repositories + restart reconciliation
3. State machine + durable event log + leases/fencing
4. HTTP surface: router, bearer auth, scoping, idempotency, correlation, limits, CSRF separation, discovery
5. Session lane: tmux ensure/reuse/replace, human-window safety
6. Runner: backend abstraction, Claude adapter, deterministic fake, session verification
7. Job engine: phases, events, cancellation preserving the tree, heartbeat/stall
8. Checks & artifacts
9. Questions / approvals / reviews / revisions (§9 additions)
10. Publication gate
11. MCP adapter
12. Cross-contract fixtures, lifecycle/restart/attack tests, smoke, docs, reviews, PR

---

## Iteration log

### 2026-07-27 — Increment 1: contract vocabulary, validation, errors, redaction, config
- **Added** `app/orchestrator/{contract,validate,errors,redact,config}.js`, `test/orch-contract.test.mjs` (33 tests).
- **RED** `ERR_MODULE_NOT_FOUND` on all five modules.
- **GREEN** 33/33; full suite 100/100.
- **Notes** Two assertions initially used `assert.throws()`'s return value (always `undefined`); replaced with a `caught()` helper. A raw NUL byte landed in `validate.js` source and was replaced with `'\0'`.
- **Criteria advanced** A3, A4, A5 (module level), G1 (config-driven, no environment constants).

### 2026-07-27 — Increment 2: durable journal store
- **Added** `app/orchestrator/store/journal.js`, `test/orch-store.test.mjs`, `test/fixtures/orch-store-writer.mjs`.
- **RED** module not found.
- **GREEN** 14/14 on first run — then **mutation-tested rather than trusted**: disabling CRC verification killed 1 test, delta-counters killed 3, but *applying ops before the durable append* and *removing write serialisation* both survived. Added three tests (failed-append leaves memory untouched; async transaction callbacks refused; closed store refuses writes). Re-run: mutations 2 and 5 now caught. **17/17.**
- **Notes** The write chain is defence-in-depth: with synchronous transaction callbacks, JS single-threading already serialises batches. The load-bearing invariant is the sync guard, so that is what is tested — no test claims to prove more than it does.
- **Criteria advanced** B1 (crash-safe), part of B2 (durable sequences).

### 2026-07-27 — Increment 3: state machine, event log, leases and fencing
- **Added** `app/orchestrator/statemachine.js`, `app/orchestrator/store/repo.js`, `test/orch-engine-state.test.mjs`.
- **RED** module not found.
- **GREEN** 20/20 (one test fixture fix: a frozen clock made `ttlMs: 1` non-expiring; changed to `ttlMs: 0`).
- **Mutations caught** dropping the evidence requirement (−2), accepting stale orchestrator fencing tokens (−1), burning a token on re-entrant acquire (−1).
- **Notes** The transition table mirrors the orchestrator's `state/machine.py` edge for edge, so both sides agree on `invalid_transition`. Asserted structurally: every status has an entry, terminals are sinks, `blocked_configuration` cannot reach any coding phase, `verifying_backend`'s only forward edge is `discovering`, and `implementing` can never reach `publishing`.
- **Criteria advanced** B2, B4, B5, B6.

### 2026-07-27 — Increment 4: HTTP surface, auth, scoping, limits
- **Added** `auth.js`, `projects.js`, `api.js`, `runner/fake.js`, `test/orch-api-auth.test.mjs`.
- **GREEN** 22/22. Mutations caught: ignoring instance match, accepting disabled tokens, ignoring scopes, ignoring project grants.
- **One mutation initially survived** — the `.`/`..` project-id guard. URL normalisation means those never reach the route param, so the guard is only load-bearing for the MCP adapter's typed args. Tested it directly instead, which then exposed a **real bug**: `isSafeProjectId` had no length bound, so a 101-character id passed. Fixed.
- **Criteria advanced** A1 (partial), A4, A5, C1, F1, F2, C5 (path containment incl. symlink escape).

### 2026-07-27 — Increment 5: the named orchestrator lane
- **Added** `session.js`, `test/orch-session.test.mjs` (private tmux server per test).
- **GREEN** 12/12.
- **Notes** tmux escapes control characters in `-F` output (a 0x1F separator returns as the literal four characters `\037`), so the field separator had to be printable. Teardown initially leaked socket *files* after `kill-server`; now unlinked, verified zero left behind.
- **Criteria advanced** C2, C3, C4, D2 (partial).

### 2026-07-27 — Increment 6: the subscription-backed runner
- **Added** `runner/claude.js`, `test/orch-runner.test.mjs`.
- **GREEN** 22/22.
- **Measured the real CLI** (one small `-p` probe, as flagged in the plan) and found a **contract gap**: `stream-json` init reports the live `model` and `permissionMode`, but no effort — and `--effort bogus` is *silently ignored* (stderr warning, exit 0, runs at default). Effort is therefore not verifiable. Default is `effective: null` (fail closed); `PW_ORCHESTRATOR_EFFORT_ATTESTATION=argv` is an explicit opt-in labelled `argv-attested`. Recorded in the fixture's `known_gaps` and in the docs for coordination.
- **Also found by test** `--dangerously-skip-permissions` satisfies the model-alias pattern; execFile prevents shell injection, not argv injection. Leading `-` now refused.
- **Criteria advanced** D1, D2, D3, D4 (partial).

### 2026-07-27 — Increments 7-10: engine, checks, interaction, publication
- **Added** `git.js`, `checks.js`, `engine.js`, `schemas.js`, `publish.js`, `test/orch-engine.test.mjs` (disposable git repo + real bare remote).
- **RED→GREEN** 15/24 → 24/24. **Four real defects the tests caught:**
  1. `blocked_verification` is unreachable from `discovering`, so a phase failure there crashed the worker. Now names the most specific state the machine permits from where the job is.
  2. A backend that could not be queried during verification propagated as an unhandled error and *failed* the job; it now blocks.
  3. Answering a question tried to re-queue a job blocked on review, which the table rightly forbids.
  4. The fake returned one constant session id for every phase, making an independent review look non-independent. It now models the real CLI.
- **One test expectation was wrong, not the code**: revising from `waiting_for_publication_approval` is illegal per the normative table. Test rewritten to revise from `blocked_review`.
- **Criteria advanced** B3, C6, D4, D5, D6, E1, E2, E3, E4, F1 (IDOR), H1, H2 (partial).

### 2026-07-27 — Increment 11: constrained MCP adapter
- **Added** `mcp.js`, `index.js` (bootstrap + mount), `test/orch-mcp.test.mjs`; ~20-line mount in `server.js`.
- **GREEN** 12/12; full suite 229/229 — no regression, subsystem inert by default.
- **Criteria advanced** F3, G5 (pending independent confirmation).

### 2026-07-27 — Increment 12: fixture, docs, portability sweep
- **Added** `contract/pw-contract-1.0.json` (generated), `scripts/orch-contract-fixture.mjs`, `test/orch-contract-fixture.test.mjs`, `bin/pw-orchestrator-mcp.mjs`, `docs/orchestrator-api.md`, two config examples, `.gitignore` entries, `/readiness`.
- **GREEN** 7/7 fixture tests including **5 cross-contract checks against the orchestrator's real Pydantic** (enums, state families, transition table, error codes, tool set) — all match member-for-member. Full suite 236/236.
- **Sweep** no CT2115/PVI2/live-path constants outside config defaults; no >Node-20 API used; `git diff --check` clean; no secrets in added lines.
- **Residual** no Node 20 runtime available locally to execute the suite against CI's pinned version; delegated to the non-regression reviewer.
- **Criteria advanced** A2, G1, G3, G4, H3 (partial), H4.

### Next
Independent reviews (security+concurrency, session/worktree lifecycle, wire compatibility, non-regression) are running. Resolve findings, then open the PR.
