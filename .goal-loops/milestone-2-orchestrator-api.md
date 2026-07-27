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
| A1 | All contract endpoints + M2 additions served at exact paths | PASS | all 17 §3 paths + 6 M2 additions, verified by the wire reviewer |
| A2 | Responses validate against orchestrator Pydantic **and** committed fixture | PASS | test/orch-wire.test.mjs validates every emitted payload against real Pydantic |
| A3 | `schema_version` 1.0; wrong major → `unsupported_schema_version`; unknown fields rejected | PASS | orch-contract.test.mjs |
| A4 | §10 error envelope + exact status/code table; no trace/env/credential/unredacted command | PASS | §10 table asserted both sides |
| A5 | Bounded types, list caps, pagination ≤200, oversize → 413 | PASS | orch-api-auth.test.mjs |

### B. Durable engine
| # | Criterion | Status | Evidence |
|---|---|---|---|
| B1 | Crash mid-write reconciles on restart; no state without a record | PASS | kill -9 test + mutation-tested |
| B2 | Gapless per-job sequences from 1, durable, SSE-resumable across restart | PASS | gapless, durable, restart-verified |
| B3 | Idempotent submit → `deduplicated: true`; different body → 409 `idempotency_key_reused` | PASS | races fixed; reserve-in-transaction |
| B4 | Illegal transition → 409 `invalid_transition`; families match orchestrator `states.py` | PASS | table matches orchestrator edge for edge |
| B5 | Fencing tokens monotone; lower → 409 `lease_lost`; heartbeat renews; takeover raises | PASS | fencing + renewal |
| B6 | Evidence rules enforced at record time | PASS | enforced at write time |

### C. Ownership & isolation
| # | Criterion | Status | Evidence |
|---|---|---|---|
| C1 | Explicit configured resolution, no hostname inference; unowned → 403 | PASS | config-driven; no hostname inference |
| C2 | Lane naming exactly per §5; second ensure reuses | PASS | orch-session.test.mjs |
| C3 | Human tmux window provably untouched across ensure and `force_replace` | PASS | fingerprints unchanged; numeric-name P0 fixed |
| C4 | Naming config-driven with contract defaults | PASS | laneNaming tests |
| C5 | No traversal/symlink escape/worktree collision; one write lease per project | PASS | realpath containment + symlink test |
| C6 | Cancel leaves tree byte-identical; git argv allowlist forbids reset/stash/clean/checkout-- | PASS | git guard sound; cancel signals the phase and fingerprints either side of it |

### D. Runner & verification
| # | Criterion | Status | Evidence |
|---|---|---|---|
| D1 | Exact claude argv, reapplied on every resume | PASS | argv asserted incl. resume |
| D2 | Real effective settings; unqueryable → `effective: null` + `blocked_configuration` pre-read | PASS | attestation.js — fail-closed, explicit alias mapping, never requested===requested |
| D3 | No API-key path; only subscription OAuth representable | PASS | auth status + env stripping |
| D4 | Auth/rate/malformed/death/timeout/cancel → distinct safe states preserving work | PASS | distinct blocked states |
| D5 | Checks allowlisted + canonicalized; real exit codes/counts + artifact | PASS | allowlisted, real exit codes |
| D6 | Review in a fresh session that provably didn't implement; fail-closed | PASS | session_isolated enforced |

### E. Interaction & publication
| # | Criterion | Status | Evidence |
|---|---|---|---|
| E1 | Real question ids/options/scope/expiry; stale/cross/double answers fail | PASS | real ids; stale/cross/double refused |
| E2 | Typed approvals; recorded decision required; chat text never approves | PASS | separate approve scope; submitter may not approve; decider named and audited |
| E3 | `pw_publish` intended-files-only, SHA parity, live PR, explicit no-CI; no merge/deploy/delete/rewrite path | PASS | private index, -z --no-renames, pathspec magic refused, lease held |
| E4 | Revisions bounded by `max_revision_cycles` and audited | PASS | bounded and audited |

### F. Authorization
| # | Criterion | Status | Evidence |
|---|---|---|---|
| F1 | Scoped bearer; 401/403 table; instance mismatch refused; cross-instance job → 404 | PASS | IDOR verified by the security reviewer |
| F2 | Orchestrator routes separated from browser CSRF/session, both directions | PASS | both directions, in the smoke |
| F3 | MCP closed tool set, sampling disabled, no forbidden name fragments | PASS | closed set, no sampling |
| F4 | Rate limits, replay, oversized/malformed, unsafe error reflection | PASS | limits/replay/malformed covered |
| F5 | Planted synthetic secrets redacted everywhere | PASS | redaction verified; detail gap closed |

### G. Portability
| # | Criterion | Status | Evidence |
|---|---|---|---|
| G1 | Config-driven; grep proves no CT2115/PVI2/live-path constants outside examples+docs | PASS | grep clean |
| G2 | Node 20 clean; no native/experimental deps | PASS | Node 20 clean clone, 236/236, verified by reviewer |
| G3 | `/health` reports db/queue/runner/auth + degraded, secret-free | PASS | /readiness |
| G4 | Migrations + install/upgrade/rollback documented; no live-config mutation | PASS | docs/orchestrator-api.md |
| G5 | All existing tests pass; existing features unchanged | PASS | inertness verified by execution on a 17-request matrix |

### H. Verification discipline
| # | Criterion | Status | Evidence |
|---|---|---|---|
| H1 | Full lifecycle test on fake backend + temp repo/DB/tmux namespace | PASS | full lifecycle on fake backend + temp everything |
| H2 | Restart/cancel/failure/cross-project-attack tests | PASS | restart/cancel/failure/cross-project |
| H3 | Alternate-port HTTP+MCP smoke; teardown leaves nothing behind | PASS | orch-smoke.test.mjs; teardown verified |
| H4 | `git diff --check` clean; secret scan clean; no runtime artefacts committed | PASS | diff --check + secret scan clean |
| H5 | Independent reviews (security+concurrency, lifecycle, wire, non-regression); P0/P1 resolved | PASS | four reviews round 1 (all P0/P1 fixed), three round 2 |

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

### 2026-07-27 — Independent reviews (four, fresh context, read-only)

All four ran against the branch with real execution, not reading alone. **They found defects the
246-test suite did not.** That is the single most important outcome of this run.

| Reviewer | Verdict |
|---|---|
| Wire compatibility | **3 × P0** — every payload validated against real Pydantic. `Actor` given a `schema_version` it does not have (broke *every* event, so `EventBatch` and SSE were unusable wholesale); `Question` and `Approval` returned as raw stored records leaking internal fields. Plus P1 envelope/argument mismatches. |
| Security + concurrency | **5 × P1** with working repros — idempotency read outside the transaction (two jobs, two commits from one key); `canTransition` same→same defeating every CAS; `_resume` starting a second worker; catastrophic regex backtracking (63 s on 200 k spaces, on the shared event loop); the approval gate self-certified by the machine credential. |
| Session/worktree lifecycle | **2 × P0** — a numeric reserved-window name marks and then **kills a human's window**; every resumption drove the job to `failed` (terminal). Plus 15 proven `git` allowlist bypasses including `push -fu` and forced refspecs. |
| Non-regression | **1 × P0** — `deploy-local.sh` hot-copies only `server.js`, so the live app could not start. Everything else verified clean by execution, including Node 20 (229/229 then 236/236 on a clean clone) and full inertness when disabled. |

**Resolved in `0997b4f` and `36b07ec`** (all with regression tests; the git guard has 32 verified
cases, the wire guard fails if either P0 is reintroduced): all 3 wire P0s, both lifecycle P0s, the
deployment P0, the git bypasses, the ReDoS (63 s → 9 ms), the idempotency races, the same→same
transition, the double worker and `drain()` race, question/approval compare-and-set, lease renewal,
heartbeat fencing, `detail` redaction, base-path hijack, tmux socket/user inheritance,
`ensureSession` mutual exclusion, and the bootstrap lock leak.

### 2026-07-27 (round 2) — every remaining P1 resolved

**Model/effort attestation, rebuilt fail-closed** (`app/orchestrator/attestation.js`, new). Settled by
*probing the installed CLI*, not by reasoning about it:

| requested | `init.model` reports |
|---|---|
| `--model sonnet` | `claude-sonnet-5` |
| `--model opus` | `claude-opus-5` |
| `--model haiku` | `claude-haiku-4-5-20251001` (dated) |

Full `system/init` key set: `agents, analytics_disabled, apiKeySource, capabilities,
claude_code_version, cwd, fast_mode_disabled_reason, fast_mode_state, mcp_servers, memory_paths,
model, output_style, permissionMode, plugins, product_feedback_disabled, session_id, skills,
slash_commands, subtype, tools, type, uuid`. **No effort field of any kind.**

So: model attests through an explicit `alias -> ids` mapping (an alias is *never* compared to itself;
an unmapped alias is unverifiable). Effort is **not attestable** → `effective: null` →
`blocked_configuration`. The `PW_ORCHESTRATOR_EFFORT_ATTESTATION=argv` mode is **removed** — it made
the check `requested === requested`. No configuration relaxes this; the requirement for a compatible
CLI is stated in code, docs and the fixture's `known_gaps`, and the capability is probed per session
so a CLI that gains the field is picked up with no configuration change. `apiKeySource` is also now
checked, so an API-billed session is refused however well it otherwise attests.

**Separation of requester and approver authority.** `approve` is its own scope, and by default the
credential that submitted a job may not approve it. PW cannot verify a human was involved — it is at
the far end of a machine interface — but it refuses to invent a decider, records decider/relayer/
credential as three separate audit facts, and makes self-approval a deliberate configuration change.

**Reboot-safe lane identity.** `pw-tmux-save` now skips windows carrying the role marker. For lanes
restored by an older manifest, an unmarked window is re-adopted only when this instance's own durable
record proves ownership, and re-adoption resets the verified settings.

**Publication.** `-z --no-renames` comparison (renames and `café.txt` now publish correctly); staging
into a **private copy of the index**, so a failed publication is a no-op on the operator's staged
work — which matters because `git.js` forbids `reset`/`restore`, so nothing here could undo a partial
stage; pathspec magic refused; the write lease held.

**Also:** a requested revision now runs instead of stranding the job; cancellation signals the phase
through an `AbortController` and fingerprints either side of it; one idempotency key, with a
disagreement between body and transport refused.

**Verification:** 277/277 on **Node 20.19.0 (CI's pin) and Node 22**; contract fixture regenerated
with the new gaps and safety facts; isolated HTTP/MCP smoke green; a single suite run leaves no
socket, process or temp directory behind.

### Superseded findings — resolved in round 2

**P1 · §6 verification is not a real check.** `engine.js` compares only `effort`, never the model;
and with `PW_ORCHESTRATOR_EFFORT_ATTESTATION=argv` the effective effort is *copied from the request*,
so the comparison is `requested === requested` — always true. Worse, `init.model` returns the
*resolved* id (`claude-sonnet-5`) while the request carries an alias (`sonnet`), so the two can never
compare equal even if compared. The default (`effective: null`, job blocks) is honest; the only mode
in which a job can actually run performs no verification. **This is the contract's central control
and it does not currently hold.** Needs a resolution designed with the orchestrator side.

**P1 · A reboot wedges the lane permanently.** `pw-tmux-save` does not persist tmux user options, so
`pw-tmux-restore` recreates `orch_pvibot` as a plain *unmarked* window. `ensureSession` then refuses
it forever — correctly, since it cannot prove ownership — including under `force_replace`. Needs
either exclusion from the persistence manifest or a narrow, recorded recovery path.

**P1 · The approval gate is still satisfiable by one credential.** Partly addressed: the decider must
now be named, and the audit records decider and relayer separately. But `approveStage` still attributes
`kind: human` on any caller's word, so `assertPublicationApproved`'s human check cannot fail. A separate
scope (not granted alongside `publish` by default) is designed but not implemented.

**P2 · Publication staging is a string comparison.** A rename (`R100 old → new`) or a non-ASCII
filename makes the staged/intended comparison always fail — and the `git add` has already happened, so
a failed publication leaves the operator's index staged with no way to unstage it (`reset`/`restore`
are correctly forbidden). Needs `-z --no-renames` and an index-restoring failure path.
Related: pathspec magic (`:(glob)**`) passes `validateRelativePath` and reaches `git add`.

**P2 · `requestRevision` / `requestReview` strand the job** in `revision_required` / `reviewing` with
no worker. **P2 · `publish()` takes no lease.** **P2 · Cancel does not signal the child process**, and
the "before" tree fingerprint is taken while a phase may still be writing, so
`working_tree_preserved: false` can be a false alarm. **P2 · Per-poll full-store event scan** and
unbounded SSE stream lifetime. **P2 · Idempotency key is the header on HTTP but a body field on MCP,**
never compared.

### 2026-07-27 (round 3) — reported blocker diagnosed; every P1 closed

**The reported intermittent failure had TWO independent causes, both product bugs.**

1. **No ambient git identity.** Publication inherited whatever identity existed on the host. A
   service account routinely has none — as do CI runners and fresh containers — so `git commit`
   failed with "Please tell me who you are", publication reported a bare "the commit failed", and the
   repository was left with one commit where two were expected. Reproduced deterministically with an
   empty `HOME`. Publication now commits under a configured identity; the regression test pins it
   with `GIT_CONFIG_GLOBAL=/dev/null`, verified RED without the fix.
2. **A stale-stat private index.** The private index was *copied* from the repository's own, so it
   carried git's cached stat data and `git add` trusted it: `git add` exited 0 having staged nothing
   while `git status` still showed the file modified — "there is nothing to publish", ~1 in 20. Found
   by capturing the publication *event* rather than the returned record, which strips the reason. The
   index is now *seeded* with `read-tree HEAD`, so it has no stat data and git must hash the file.
   **0 failures in 80 diagnostic iterations**, and committing from a private index no longer leaves
   the real one stale relative to the new HEAD.

**Round-3 independent reviews found a P0 I had introduced and four more P1s**, all fixed:

- **P0** `working_tree_preserved` was a tautology — both fingerprints were taken after the worker had
  stopped. A reviewer proved a backend deleting the operator's files during cancellation still
  reported `preserved: true`. Now sampled before the abort, and defined as *nothing lost* rather than
  *nothing changed*, with tests for both directions.
- **P1** `_runRevision` never renewed the write lease → a second job reached `discovering` in the same
  checkout. **P1** `cancelJob` awaited unboundedly → a request could hang for the whole phase budget.
  **P1** a commit message beginning with `-` wedged the job in `publishing` forever. **P1** separation
  of duty keyed on `token_id` was defeated by the token store's own rotation design; it now rests on
  capability. **P1** the phases that do the work were never attested — only the probe session was.
- Plus: base-path guard ignored `PW_BASE_PATH` (a `/workbench` install could be bricked);
  `pw-tmux-save` keyed on an option tmux resolves through the global scope chain, so one stray
  `set-option -g` silently excluded the entire manifest; `bin/` was documented but shipped by no
  install path; `symbolic-ref` was an allowed write; a wildcard alias mapping verified any model.

**Verification:** 287/287 on Node 20.19.0 and Node 22, three consecutive runs each, in a **fresh
clone with `npm ci`**; 20 focused repetitions of the reported test with no git identity; contract
fixture drift + cross-contract against real Pydantic; isolated HTTP/MCP smoke; zero temp dirs,
sockets or processes left behind; live tmux (15 sessions) untouched; CT2115 undeployed.

### 2026-07-27 (round 4) — cross-repository contract increment: attestation provenance

**The orchestrator repository had moved.** Discovered by the cross-contract test failing on `Effort`,
not by being told: `contracts/policy.py` now defines `AttestationProvenance`, `LaunchAttestation`,
`SettingsAttestation`, `AuthMode` and `weaker()`; `Effort` gained `xhigh`; `VerifySessionRequest`
gained `run_id` and `config_generation`; and — the significant one — `SessionVerificationResponse`
now carries an `attestation` and **derives** `effective` from it, refusing a payload that sends
`effective` as a field. ProjectWorkbench is conformed to all of it; that repository was not edited.

**Live probes settled the design** rather than assumption:

| probe | result |
|---|---|
| `--help` | declares `--effort <level>` with `(low, medium, high, xhigh, max)` |
| init event | reports the resolved model; **no effort field of any kind** |
| `/usr/local/bin/claude` | a **bash wrapper** that appends `--permission-mode`, `--mcp-config` |
| `/bin/claude` | → `…/claude-code/bin/claude.exe`, a 275 MB ELF; sha256 recorded |

So: **model = `runtime_reported`** (observed, normalised through the alias mapping, with the
normalization carried alongside), **effort = `launch_enforced`** (chain of custody over an input, not
an observation). Jobs can now run without either overstating effort or needlessly downgrading model.
A record is described by its **weakest** field.

The wrapper finding matters: PW's own installer puts an argv-rewriting script on `PATH`, so
`launch_enforced` refuses any executable that is a shell wrapper, relative, or unpinned. Eight
preconditions must all hold or **no attestation is produced at all** and the job blocks.

Fingerprints cache on the binary's own identity, so the ~1 s hash of 275 MB happens once and any
change to the file misses the cache; a failed probe is never cached, since it may be a partially
written upgrade.

**Adversarial coverage:** forged provenance smuggled through the init event, caller-supplied argv, a
value the binary does not advertise, an undeclared option, an ignored-option warning, missing/failed
fingerprint, capability and content drift, unbound and partially bound callers, API-key auth, the
real wrapper shape, a relative executable, a pinned-hash mismatch, and cache invalidation.

**Verification:** 315/315, three consecutive runs each on Node 20.19.0 and Node 22 from a fresh clone
with `npm ci`; 20 publication-idempotency repetitions with no git identity; every emitted payload
validated against the orchestrator's real Pydantic (`SettingsAttestation`, `LaunchAttestation`,
`ModelSettings(xhigh)`, `SessionVerificationResponse`) plus a test asserting a payload carrying
`effective` is refused; `AttestationProvenance` and `AuthMode` now cross-checked member-for-member;
HTTP/MCP smoke green; no temp dirs, sockets or processes left; CT2115 undeployed.

### 2026-07-27 (round 5) — the "intermittent" failure diagnosed

**It was not flaky.** Captured on the *first* repeat, with full output written outside the
repository: `wire: the attestation payloads validate against the orchestrator's policy contracts`,
nine Pydantic errors — `envelope` required, the identity fields rejected as extra on
`LaunchAttestation`, `normalization` no longer a list of strings.

**Root cause: mutable shared state outside the repository under test.** The cross-contract tests
validate against the orchestrator's *live working tree*, a sibling repository that changes
independently. Commit `703d765` landed there at 12:03 restructuring `SettingsAttestation`, so two
runs of the same ProjectWorkbench commit genuinely disagreed — the thing being compared against had
changed underneath both. My earlier green runs validated against the pre-commit source. Not
concurrency, not ports, not tmux, not timing.

**Two pieces of work followed.**

1. **Conformed** to the restructure. `AttestationEnvelope` now carries identity, authentication and
   binding for *every* claim — the same asymmetry my own reviewer found, fixed structurally on their
   side: with those fields inside the launch record, a peer declaring both fields `runtime_reported`
   skipped the contract-version, identity, auth and binding checks and got the *stronger* provenance
   for it. `normalization` is now `NormalizedField {field, source_key, raw_value, value}` — free text
   was not evidence, since the validator could only ask whether the list was non-empty. And a
   per-verification `verification_nonce` is plumbed end to end; the sentinel default, a short nonce
   and a missing one are all treated as unbound.

2. **Removed the nondeterminism.** `contract/orchestrator-revision.json` pins the contract sources
   this repository is conformed to, and a guard compares the live tree against it. Pinning does not
   stop the contract moving — it makes the move *say so*, name the changed files and both revisions,
   and stop masquerading as flakiness. Verified three ways: fires on a simulated move (naming
   `policy.py`), passes against the pinned tree, inert where the orchestrator is absent, as in CI.

**Gate:** 325/325 × **5 consecutive runs on each of Node 20.19.0, 20.20.0 and 22** — 15 green suites
from a fresh clone with `npm ci`. Plus 20 publication-idempotency repetitions with no git identity,
contract fixture + cross-contract validation, HTTP/MCP smoke, and leak checks showing zero temp
directories, sockets, listeners or stray processes.

### Status

All P0 and P1 findings from all three review rounds are resolved with regression tests. The PR stays
a draft: the residual below is a coordination decision, not a code change.

**The previous residual is resolved.** Effort is no longer unattestable-therefore-blocking: the
contract now carries provenance, so effort is reported as `launch_enforced` and jobs run — while the
distinction from an observation is preserved in the payload rather than flattened away. What remains
is a *property* of that provenance, stated plainly in the contract and the docs: a launched flag can
still be ignored by a build nobody fingerprinted, which is exactly why it is a different word.
