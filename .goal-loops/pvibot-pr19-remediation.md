# Goal loop — PR #19 security remediation (round 2)

Local repair branch `pvibot/pr19-fixes`, based exactly on PR #19 head `cf1f1fe`. Continues the work
recorded in `host-mode-privilege-drop.md`, which explicitly flagged `git.js`/`checks.js` as
out-of-scope-but-tracked and did not touch `TmuxAdapter` or the cancellation/lease path at all.

## Acceptance criteria

| ID | Criterion | Status |
| --- | --- | --- |
| 1 | Every workspace-affecting subprocess, including `TmuxAdapter`, uses the same validated privilege-drop plan; no bare PATH-resolved `sudo -u name tmux` | PASS |
| 2 | `PrivilegeDropper.wrapCommand` tracks and kills the whole descendant tree on timeout/abort, like coding-CLI launches | PASS, with a documented residual limitation — see round 3 |
| 3 | Cancellation cannot default to confirmed when `cancelGraceMs` wins the race against termination confirmation | PASS |
| 4 | Unconfirmed termination persists `termination_confirmed:false`, blocks the job, and fences the project lease durably; explicit recovery path, never auto-cleared | PASS |
| 5 | Confirmed cancellation keeps current behaviour and releases its lease; contract/provenance compatibility preserved | PASS |
| 6 | Adversarial tests: timeout descendants, cancelGrace race, lease/fence behaviour, tmux production wiring | PASS |
| 7 | Self-review: PID reuse, deadlocks, lease expiry, systemd/container portability, secret leakage | PASS |

**Round 3 (this update).** An independent acceptance review of commit `f17c793` (round 2's result)
found two more real gaps, both fixed below: `reconcileOnStart` still released leases on restart
(criterion 4 was incomplete for the crash path specifically), and the descendant-tracking poller
introduced in round 2 could itself be defeated by a launch faster than its own polling interval
(criterion 2's fix was real but not complete). See "Round 3" below.

## Findings (pre-implementation reconnaissance)

* **`TmuxAdapter.spawnArgs`** (`session.js`) composes `sudo -u <name> tmux …` with both `sudo` and
  `tmux` resolved through PATH — a completely separate, unvetted privilege-drop path from
  `PrivilegeDropper`, keyed on the account *name* rather than the numeric uid the rest of the system
  resolves once and pins. No existing test exercises this path at all.
* **`PrivilegeDropper.wrapCommand`** (used by `git.js` and `checks.js` via the shared `droppedExec`)
  never calls `ensureTerminated` — a check command that times out or is aborted leaves any
  backgrounded/`setsid`'d descendant running, unlike `wrap` (the coding-CLI path), which already
  tracks and kills the whole tree.
* **`OrchestrationEngine.cancelJob`** races the worker's promise against a `cancelGraceMs` timer, then
  computes `terminationConfirmed = !this._terminationUnconfirmed.has(jobId)`. `_terminationUnconfirmed`
  is populated only inside the worker's own catch handler, which runs only once its promise actually
  settles — so when the grace timer wins the race, nothing has been added yet and the expression
  defaults to `true`. A cancellation whose deadline elapsed before confirmation arrived is recorded as
  confirmed.
* **The same method releases the project lease unconditionally** (`await this._releaseLease(jobId)`)
  *before* branching on `terminationConfirmed`. Even on the rare path that does end up in the
  "unconfirmed" branch today, the lease has already been freed by the time that branch runs, so a new
  job can acquire the same workspace while a descendant may still be alive and writing to it. The
  unconfirmed branch also never sets `termination_confirmed: false` on the job record.
* Lease TTL-based expiry (by design, for crash recovery) means even "just don't release it" would not
  hold: the renewal interval stops the moment the worker task returns, and the lease would lapse on
  its own after `leaseTtlMs`. A durable fence, independent of expiry and only clearable by an explicit
  operator action, is needed to satisfy "no later job can acquire/write that workspace."
* `reconcileOnStart` (restart after a crash) has the same shape of problem — it unconditionally
  releases the lease for any job stranded mid-flight — but there is no descendant-tracking or pid
  record to confirm anything either way after a process restart. Fixing that is a materially larger
  feature (durable pid tracking across restarts) and is out of scope here; flagged below.

## Log

### Criterion 1 — TmuxAdapter shares the privilege-drop plan

* **Change.** `TmuxAdapter` (`session.js`) no longer builds its own `sudo -u <name> tmux …` argv
  (bare `sudo`, bare `tmux`, both PATH-resolved, keyed on the account name). It now takes an injected
  `exec`, defaulting to a bare `execFileAsync` (so container mode and every existing hermetic test are
  unchanged), and in production (`index.js`) is constructed with the *exact same* `droppedExec`
  (`commandDropper.wrapCommand(execFileAsync)`) instance already used for `git.js`/`checks.js`. One
  dropper, one resolved plan, one numeric uid — structurally impossible for the lane to address a
  different identity, and therefore a different tmux socket namespace, than everything else.
* **RED.** New tests in `orch-privilege-boundary.test.mjs` asserting the drop path constructing
  `TmuxAdapter` with a fake `exec` — failed against the old code because it ignored the injected
  `exec` entirely and shelled out to the real `tmux` binary (`can't find session: pw_Demo`).
* **GREEN.** All three new tests pass; full suite 425/428 (3 skipped, pre-existing) unaffected.

### Criterion 2 — wrapCommand descendant-tree tracking, and a deeper race it uncovered

* **Change (first pass).** `PrivilegeDropper.wrap` and `wrapCommand` now share one `_execTracked`
  helper: both track the launched child and call `ensureTerminated` in the catch path, so a
  repository-check command gets the identical tree-confirmation the coding CLI already had.
* **RED → GREEN (hermetic).** Two new fake-exec tests in `orch-privilege-boundary.test.mjs` confirmed
  `wrapCommand` now calls `ensureTerminated` and propagates `terminationConfirmed`, exactly like
  `wrap`.
* **RED (real process) — a second, deeper bug.** A new adversarial test in
  `orch-privilege-real.test.mjs` reproduced exactly what criterion 2 asks for: a check-shaped command
  (`/bin/sh -c "setsid sh -c 'trap \"\" TERM; exec sleep <marker>' & exec sleep 60"`) run through
  `wrapCommand` with `timeout: 1000`. It kept failing even after the first-pass fix above — manual
  `pgrep` confirmed the marker process was genuinely still alive. Root cause, found by instrumenting
  `ensureTerminated` directly: `execFile`'s own `timeout` (and `signal`) handling kills the *direct*
  child through a path this module cannot see, and does so *before* `ensureTerminated` is ever
  entered. By the time our catch block runs, the direct child (`sudo`, in host mode) is already
  reaped, and the kernel has already reparented its own child to init — nothing in `/proc` connects
  the survivor back to the pid that just died, seeded or not, once that has happened.
  * **Fix, part A.** `_execTracked` now polls the descendant tree every 200 ms (`DESCENDANT_POLL_MS`)
    for the whole life of the launch, *while it is still alive* — not only reactively once it has
    already failed — and hands the accumulated set into `ensureTerminated` as a seed. This closes the
    window without touching how the kill is actually delivered (native `timeout`/`signal` are still
    forwarded to `exec()` unchanged, preserving the existing, deliberately-attached, sudo-relays-the-
    signal mechanism and every test that asserts on it).
  * **Fix, part B — the bug the seed alone didn't fix.** `ensureTerminated`'s own entry guard
    (`if (child.exitCode !== null …) return true`) was written for "nothing to check", but with a
    seed present it now means "the pid died confirming a launch, so don't look any further" — exactly
    the wrong read the moment the seed exists precisely *because* the pid died. Fixed to only take
    that shortcut when there is no non-empty seed; a genuine survivor in the seed is now walked
    through the normal grace-then-SIGKILL sequence regardless of whether the top-level pid is already
    gone.
* **GREEN.** The real-process test passes (`terminationConfirmed: true`, marker process confirmed
  gone by `pgrep`, ~3.3s — grace period `1_500ms` + SIGKILL sweep). Full hermetic + real-process
  privilege suites: 68/71 pass, 3 skipped (need an actual identity change, not available running as
  the target account already). Full Node suite: 428/431 pass, 3 skipped, 0 fail.
* **Scope note.** This also transparently fixes the identical latent gap in the coding-CLI `wrap()`
  path (a phase hitting its `backendTimeoutMs` deadline, or an abort landing via the `signal` option,
  had the exact same blind spot) — in scope because `_execTracked` is now the one function both share,
  and criterion 2 explicitly requires wrapCommand reach parity with a *correct* wrap, not a
  bug-compatible one.

### Criteria 3-5 — the cancelGraceMs race, and the lease fence

* **Bug A (criterion 3).** `cancelJob` raced the worker's promise against a `cancelGraceMs` timer,
  then computed `terminationConfirmed = !this._terminationUnconfirmed.has(jobId)`.
  `_terminationUnconfirmed` is populated only inside the worker's own catch handler, which runs only
  once its promise actually *settles*. If the grace timer won the race, nothing had settled yet, so
  nothing had been added — and the expression defaulted to `true`. A cancellation whose deadline
  elapsed before any answer arrived was recorded as confirmed.
* **Bug B (criterion 4).** The same method released the project lease *unconditionally*, before
  branching on `terminationConfirmed` at all. Even on the rare path that reached "unconfirmed", the
  lease had already been freed by the time that branch ran — a new job could acquire the same
  workspace while a descendant might still be alive and writing to it. The unconfirmed branch also
  never persisted `termination_confirmed: false` on the job record, only `working_tree_preserved`.
* **Bug C, found while fixing B.** Even "just don't release the lease" would not have held: the lease
  is designed to expire (that is what lets a crashed worker's project be picked up again), and the
  renewal interval that keeps it alive stops the moment the worker's own promise settles — which,
  for an unconfirmed cancellation, could still happen. A durable **fence**, independent of expiry and
  clearable only by an explicit operator action, was added at the repository layer:
  `acquireLease`/`releaseLease` both refuse outright while a resource is fenced — regardless of TTL,
  and regardless of whether the caller is the very job that set the fence — and only `clearFence`
  (naming who cleared it and why) takes it down. `test/orch-lease-fence.test.mjs` is the hermetic,
  repo-level regression suite for all of this: fenced-past-TTL, fenced-refuses-even-the-original-
  owner, fenced-refuses-release, fenceLease-is-a-no-op-for-a-job-that-does-not-hold-the-lease (so one
  job's late confusion cannot fence a different, legitimate holder's resource), clearFence releasing
  outright, and clearFence refusing when nothing is fenced (never a silent no-op).
* **Fix.** `cancelJob` now distinguishes "the promise settled" from "the grace timer fired" with an
  explicit sentinel in the `Promise.race`, so `terminationConfirmed` is `true` only when the worker
  actually told us something *and* it was good news. The unconfirmed branch now calls `_fenceLease`
  (never `_releaseLease`) and persists `termination_confirmed: false` in the same patch as
  `working_tree_preserved: false`. `_acquireLease`'s two call sites (`_run`, `_runRevision`) were
  identical boilerplate and are now one `_acquireLeaseOrBlock` helper, which also tells a fenced block
  apart from ordinary contention in the job's own timeline message.
* **RED → GREEN.** Four new tests in `orch-p1-regressions.test.mjs`: the race defaulting to
  confirmed (fixed the pre-existing "does not hold the caller open" test's own assertion, which had
  encoded the bug — `state.status === CANCELLED` where it must now be `BLOCKED_PROJECT_STATE` with
  `termination_confirmed: false`); a dedicated race test where the phase *would* have reported
  confirmed had the caller waited, proving the response cannot depend on that; a fence test showing a
  second, independent job for the same project blocks while the fence is up; a clear-fence test
  showing a later job can proceed once an operator explicitly clears it. Full suite: 438/441 pass, 3
  skipped, 0 fail.
* **Known, out of scope (flagged).** `reconcileOnStart` (a restart after a crash) has the identical
  shape of problem — it unconditionally releases the lease for any job stranded mid-flight — but
  there is no live descendant list or persisted pid to confirm anything either way after a process
  restart; fixing that needs durable pid tracking across restarts, which is a materially larger
  feature than this loop's scope. Tracked as a follow-up, same as `git.js`/`checks.js` were in the
  previous round. (Self-review below found that this gap is at least *contained*: `releaseLease`'s
  fence guard means even `reconcileOnStart` racing a still-fencing `cancelJob` cannot un-fence a
  project by accident — see "lease expiry" below.)

### Recovery path — a bug the self-review caught before it shipped

`scripts/pw-orch-clear-fence.mjs` opened the durable store without passing the service's own
`MIGRATIONS`. Against a fresh, never-migrated store (which is what every test used) that is
invisible; against any *real* deployment — which will always be at schema v1 the moment the service
has started once — it refuses to open at all: `"the store was written by a newer schema (v1) than
this build understands (v0)"`. Found by self-review (systemd/container portability: "does this
actually work against a store that has been through what the service does to it"), reproduced by
fixing the test fixtures to open with the real `MIGRATIONS` (RED: 2 of 4 script tests failed with
exactly that message), then fixed by importing and passing `MIGRATIONS` from `index.js`. Also cleaned
up: the script called `process.exit()` from inside the same `try` its `store.close()` lived in a
`finally` for, which `process.exit()` bypasses — harmless only because the store's own `process.on(
'exit', …)` handler independently releases the lock, but misleading to read. Restructured to a single
exit point reached after `close()` actually runs.

## Self-review (criterion 7)

* **Process/PID reuse.** The continuous poller in `_execTracked` widens the window a tracked pid
  could be reused by an unrelated process compared to the original reactive-only `ensureTerminated`
  (which only ran, briefly, after a launch had already failed) — a long-running command could
  otherwise carry a pid for its whole life after whatever it named had exited. Fixed by pruning: each
  poll tick removes any tracked pid no longer running, bounding the reuse window to about one poll
  interval (200 ms) instead of the length of the launch. `stillRunning`'s own EPERM-means-alive
  reasoning (documented in place) is unchanged and is the same accepted trade-off the original code
  already made.
* **Deadlocks.** `store.transact` calls are serialised by the store itself and every repository
  callback here is synchronous (no `await` inside a transaction), so nothing new can hold that queue
  open. Traced the specific interaction the new `_fenceLease`/`_acquireLeaseOrBlock` pair intro
  between concurrent callers (a still-running lease-renewal interval racing a `cancelJob` that just
  fenced the same resource) and confirmed it is not a deadlock: `renewLease` spreads the existing
  record forward, so a stray renewal after a fence cannot clear it, and both simply queue on the
  store's existing serialisation.
* **Lease expiry.** The reason a bare "don't release on cancel" would not have been enough: the
  renewal interval that keeps a lease alive stops only once the worker's own promise settles, which
  for an unconfirmed cancellation is exactly the thing that has NOT happened — so a plain unreleased
  lease would still lapse on its own schedule. The fence is independent of `expires_at` by
  construction (checked first in `acquireLease`, before the expiry comparison). Traced one more
  interaction while self-reviewing: if the orchestrator process crashes between `_fenceLease`
  committing and the job's own `_transition` committing, `reconcileOnStart` will find the job in a
  workspace-active state on restart and call `_releaseLease` — which now *refuses* on a fenced
  resource (caught by its existing `.catch(() => {})`), so the crash cannot un-fence the project
  either. Not a scenario there is a test for (it would need killing the process mid-transaction), but
  the invariant holds by construction: every path to releasing a lease funnels through
  `repo.releaseLease`, which checks the fence first, unconditionally.
* **systemd/container portability.** `descendantsOf`'s `/proc`-based enumeration already degrades to
  `[]` on a system without `/proc` (documented in place); the new poller calls the exact same
  function, so it inherits the same degradation rather than introducing a new one. Container mode is
  unaffected by the TmuxAdapter change (verified by a dedicated test) and, as a side effect, now
  benefits from the same descendant-tracking fix as host mode, since `_execTracked` does not
  branch on deploy mode. The recovery-script migration bug above was itself a portability finding.
* **Secret leakage.** Neither `_execTracked`/`ensureTerminated` nor the TmuxAdapter change touch
  environment or argv composition at all — the existing scrub is untouched. The new fence fields
  (`fenced_reason`, `cleared_by`, `clear_reason`) are operator-supplied free text and are now run
  through `redactText` before being written to the durable store, on the same principle the rest of
  `repo.js` already applies to event messages and check commands.

## Final verification

* **Focused, as the account running the suite (admin, uid 1000):** `orch-privilege*.test.mjs`,
  `orch-lease-fence.test.mjs`, `orch-p1-regressions.test.mjs`, `orch-engine*.test.mjs`,
  `orch-session.test.mjs` — all green.
* **Full suite, as admin:** 443 pass, 3 skipped (the assertions that need a genuine uid change, not
  available when the suite already runs as the drop target), 0 fail. 446 total.
* **Full suite, as real root (`sudo`), `PW_TEST_DROP_USER=admin`, a genuine root → admin drop:** 446
  pass, **0 skipped**, 0 fail. Every real-process test — including the two new setsid-detached-
  descendant regressions and the pre-existing cancellation/environment/ownership suite — ran for
  real, not merely hermetically. No leaked processes and no stray root-owned files found afterward.

## Round 3 — two more gaps an independent review found in commit f17c793

### Gap A — `reconcileOnStart` still released leases; a restart is an unknown-termination case too

Round 2 fixed the *in-process* unconfirmed-cancellation path (`cancelJob`) but left the *restart* path
unchanged: `reconcileOnStart` unconditionally called `_releaseLease` for every job stranded in a
`WORKSPACE_ACTIVE_STATE`. A crash is, if anything, a *stronger* unknown-termination case than a
cancellation race — there is no live process left that could ever confirm a descendant tree is dead,
only a durable record saying a job was mid-flight when the service stopped existing.

* **RED.** Rewrote the existing `orch-engine.test.mjs` restart test to set up a REAL lease (via
  `repo.acquireLease`, not a hand-set `lease_fencing_token` field) before simulating the crash, and
  added three more: fence survives its own lease TTL, fence survives a genuine store close-and-reopen
  (not just a second engine instance sharing the live store), and the fence blocks both a fresh job
  submission and a revision request for the same project. All four failed against the old code
  (`lease.fenced` was `undefined`; the lease was gone or freely re-acquirable).
* **Fix.** `reconcileOnStart` now calls `_fenceLease` (the same method `cancelJob`'s unconfirmed
  branch uses) instead of `_releaseLease`, and persists `termination_confirmed: false` in the same
  transition. Nothing else about reconciliation changed — a stranded job still moves to
  `blocked_project_state`; the difference is entirely in what happens to the resource behind it.
* **GREEN.** All 5 tests in that section pass (the rewritten one plus 4 new); `orch-engine.test.mjs`
  full file 73/73 (later, with round 3's other change, unaffected).
* **Operational trade-off, stated plainly (also added to docs/orchestrator-api.md §3 and the Rollback
  section, which had the identical stale "lease released" claim in a second place):** a routine
  restart or deploy that catches a job mid-flight now blocks that project until an operator explicitly
  clears the fence with the service stopped. This is deliberately less convenient than round 2's
  behaviour and is the whole point of the fix — a restart proves nothing about whether a descendant
  survived, so it must not be treated as though it does.
* **Explicitly out of scope, and stated as such:** `reconcileOnStart` cannot do better than an
  unconditional fence, because there is no live descendant list and no persisted per-launch pid to
  check after a restart — that would need durable pid tracking across restarts, a materially larger
  feature than reconciliation itself.

### Gap B — the descendant poller can itself be beaten by a fast enough launch

Round 2's fix (continuous `/proc` polling while a launch is alive, seeding `ensureTerminated`) is real
but was not complete: if `execFile`'s own `timeout`/`signal` kills the direct child before the
poller's first tick ever fires (a timeout shorter than `DESCENDANT_POLL_MS` guarantees this), or if a
descendant forks and `setsid`-detaches in the gap between the last tick and the child's death,
`ensureTerminated` had nothing to seed from beyond the (already-dead) top pid — and reported
`terminationConfirmed: true` regardless, because an empty search against nothing worth searching is
indistinguishable, by construction, from a genuinely empty tree.

* **RED (real root → admin).** New adversarial test in `orch-privilege-real.test.mjs`: a
  `setsid`/SIGTERM-trapping descendant forked immediately, with `timeout: 50` against a
  `DESCENDANT_POLL_MS` of 200 — guaranteeing zero poll ticks before the direct child dies. Failed
  against the round-2 code: `terminationConfirmed` was `true`. Confirmed via `pgrep` that the
  descendant genuinely survived (a real leak, not merely a wrong flag) before cleaning it up.
* **Deliberately not fixed by shrinking the interval.** As instructed, and because it would not
  actually fix anything: an adversary only has to fork and detach faster than whatever interval is
  chosen, at any interval. This is a structural property of sampling, not a tuning parameter.
* **Fix chosen: conservative reporting, not containment.** `_execTracked` now counts *completed*
  live-tree observations (`liveTicks`, incremented at the end of a tick's accumulate-and-prune, not
  when the timer merely fires) and passes the count to `ensureTerminated`. When the direct pid is
  already gone AND zero live ticks ever completed, the verdict is forced to `false` — win or lose,
  regardless of what the (necessarily trivial) survivor search finds — because the only thing tracked
  in that case is the seed's own already-dead top pid, which proves nothing about anything that may
  have forked from it. An ordinary cancellation or timeout, with a normal phase budget and many poll
  cycles behind it, is completely unaffected: `liveTicks > 0`, so the existing confirmed/unconfirmed
  logic runs exactly as round 2 left it. Verified directly: the round-2 real-process suite (timeout
  1000ms, abort variant, ample polling window) still reports `terminationConfirmed: true` after
  everything is actually dead.
  * **The alternative considered and not taken: kernel-level containment** — a dedicated PID
    namespace (the kernel kills every process in it the moment the namespace's own init exits) or a
    cgroup with `cgroup.kill`/`cgroup.procs` (tracks membership independently of reparenting, unlike
    `/proc` ppid-chasing) would close this structurally rather than statistically. Not attempted:
    materially larger in scope (namespace/cgroup delegation, container-runtime interaction, a new
    dependency on kernel features not uniformly available across every host and container this
    product targets) than this fix, and explicitly offered as an alternative rather than a
    requirement. Documented in both `privilege.js` (at `ensureTerminated`) and
    `docs/orchestrator-api.md` §1.5 as a known, disclosed limitation and a candidate follow-up, per
    the instruction not to solve this silently.
* **GREEN.** New test passes, as real root → admin. Full round-2 privilege suite (71/74, 3 skipped —
  identity-required) unaffected.

### Recovery script — re-verified, and one real gap found and fixed

Re-checked against the four explicit properties asked for:

* **No side-effect imports.** `index.js`'s only additions to the script are `MIGRATIONS`, a frozen
  constant; `createOrchestratorSubsystem`/`buildSubsystem`/`mountOrchestrator` are functions the
  script never calls, and are never called at module scope in `index.js` itself. Added a test
  asserting this directly against the source (no call to any of the four bootstrap identifiers at
  column 0), rather than relying only on "the suite hasn't hung yet".
* **Refuses a running store.** Already covered in round 2 (`StoreLockedError` → exit 3, message names
  the reason); re-confirmed still passing.
* **Redacts output — found a real gap.** The script echoed the RAW `--reason`/`--by` arguments to its
  own stdout after clearing a fence, even though `repo.clearFence` had already redacted them before
  writing the durable record. A secret pasted into `--reason` by a hurried operator would therefore
  reach the terminal (and anything that captured it) unredacted, even though the store itself was
  clean. **RED**: new test pasting an `sk-…`-shaped value into `--reason` failed
  (`stdout.includes(secret)` was `true`). **Fix**: the script now prints the *returned, already-
  redacted* record from `clearFence` rather than the raw arguments. **GREEN**.
* **Leaves an auditable durable record.** New test confirms the cleared record retains the *entire*
  history, not just its ending: `fenced_at`/`fenced_by`/`fenced_reason` from the original fence
  survive alongside the new `cleared_at`/`cleared_by`/`clear_reason` — an operator reading it later
  sees who fenced it and why, and who cleared it and why, in one record.

## Final verification, round 3

App VERSION bumped `1.26.0729.1851` → `1.26.0729.2230` (forward, per `test/release-version.test.mjs`'s
format and ordering checks, both passing).

* **Full suite, as admin:** 450 pass, 3 skipped (identity-required), 0 fail. 453 total.
* **Full suite, as real root, `PW_TEST_DROP_USER=admin`:** **453 pass, 0 skipped, 0 fail.** Every
  real-process test, including both new round-3 regressions, ran for real.
* **Process hygiene.** No process matching any marker this suite's own tests use (917, 918, 932, 933,
  934, 937, 938, 939) was left running afterward. Two unrelated processes *were* found on the shared
  container (markers `948.94305.3`, `951.123.1`, using `runuser`/detached-spawn shapes) — grepped the
  entire repository (`grep -rn runuser`, excluding `node_modules`) and found no match anywhere: they
  are not spawned by any file in this worktree's test suite or source, so they were left untouched
  rather than killed, consistent with not taking destructive action on processes this session cannot
  attribute to itself on a shared host.

## Round 4 — an independent final review found a false confirmation and an unguarded publish path

### Part A — `ensureTerminated` could report `terminationConfirmed: true` with a live survivor

Round 3's fix (Gap B above) closed the *zero-poll-tick* case but was not the general fix it needed to
be: the reviewer reproduced a detached, SIGTERM-ignoring `setsid` child forked at 270ms, between two
200ms poll ticks, with the launch timing out at 340ms. One or more polls *had* run, and the tracked pid
set was empty at the end (nothing survived under a pid this module was still watching) — so the old
`liveTicks > 0` logic reported `terminationConfirmed: true`. The child was real and alive; the verdict
was wrong. Temporal `/proc` sampling cannot prove a negative in general — only the narrower fact that
*nothing currently tracked* survived, which is not the same claim.

* **RED.** Added `assertBetweenPollsUnconfirmed` to `orch-privilege-real.test.mjs`, reproducing the
  exact scenario (`(sleep 0.27; setsid sh -c 'trap "" TERM; exec sleep …') & exec sleep 60`, poll
  200ms, timeout 340ms) across all three privilege modes (container passthrough, root → admin,
  already-the-target-account) and both call shapes (`wrap`, `wrapCommand`) — 6 tests. Confirmed a live
  survivor via `pgrep` before mandatory cleanup in every case; 2 of 6 failed against round-3 code with
  `terminationConfirmed: true` and a genuinely surviving process.
* **Fix — stop trying to prove sampling can prove a negative.** `ensureTerminated` no longer counts
  ticks at all: for any launch that actually reaches this method (a real kill, past the `wasKilled`
  gate below), it now unconditionally returns `false`. A durable fence/manual clear on any timeout or
  abort after the child started is the intended, conservative behaviour from here on; normal
  successful completion is entirely unaffected, since `ensureTerminated` is never called for it.
* **PID-reuse safety.** Replaced the old `descendantsOf(pid)` ppid-walk with `procSnapshot()` (reads
  every `/proc/<pid>/stat`, capturing pid *and* kernel start-time) and `rescanTracked(tracked, roots)`
  (grows the tracked set, records each pid's start-time at first sight, then prunes any entry whose
  *current* start-time no longer matches — pid reused or gone). Signalling now always re-checks
  identity via start-time immediately before sending, never off a stale snapshot. The direct child's
  own liveness (`child.exitCode`/`child.signalCode`) is re-evaluated live each round rather than
  snapshotted once. A `pollInFlight` handle is awaited before `ensureTerminated` mutates the tracked
  map, so a tick reading `/proc` never races the very mutation the catch handler is about to perform.
* **The regression this redesign could have caused, caught before it shipped:** making
  `ensureTerminated` unconditionally `false` meant `_execTracked`'s catch handler would fence a project
  on *any* rejection — including an ordinary failing check or a `git rev-parse` outside a repository,
  neither of which is a kill. Added a `wasKilled` gate (`err.signal || err.killed ||
  options.signal?.aborted`, the same discriminator `classifyBackendFailure` already uses) so
  `ensureTerminated` only runs for launches a signal actually ended. New regression test: an ordinary
  non-zero exit does not invoke `ensureTerminated` at all, and carries no termination verdict.
* **Propagation.** `git.js` (`runGit`, `repositoryBaseline`, `workingTreeFingerprint`) and `checks.js`
  (`CheckRunner._exec`/`run`, `diffStat`) previously discarded whatever the exec layer attached,
  rebuilding a plain result object. Both now carry `terminationConfirmed` through unchanged (`false`
  only for an unconfirmed kill, `null` otherwise — never averaged or dropped when several parallel
  calls disagree). `TmuxAdapter.hasSession`/`listWindows` re-throw rather than round an unconfirmed
  kill down to their ordinary "false"/"[]" failure case. `engine.js` gained one reusable guard,
  `_guardTermination(jobId, terminationConfirmed, contextMessage)` — fences the lease and moves the
  job to `blocked_project_state` only when the verdict is exactly `false` — wired into every check run
  (targeted, full, and both revision variants), the repository baseline capture, the diff-stat capture,
  and `sessionManager.ensureSession`'s failure path (previously an unconditional `_blockWith`, which
  releases). `cancelJob`'s own `terminationConfirmed` computation now also factors in the fingerprint
  calls' own verdict, not just the worker's.
* **GREEN.** New dedicated `test/orch-termination-verdict.test.mjs` (18 tests, RED-verified by
  stashing the git.js/checks.js changes) plus 2 new engine-integration tests in
  `orch-p1-regressions.test.mjs`. Full suite 491 pass/3 skip/0 fail as admin; 494 pass/0 skip/0 fail as
  real root.

### Part B — `publish` never held a lease, never registered for cancellation, never fenced

Confirmed by direct inspection: `publish()` moved a job to `publishing` and called
`this.publisher.publish(...)` without ever calling `_acquireLease`/`_acquireLeaseOrBlock`, without a
renewal interval, without registering in `_running`/`_aborts`, and without threading any signal into a
single git or `gh` command it ran. Concretely, this meant: two jobs for the same project could both be
mid-write at once (one coding, one publishing, or two publishing); `cancelJob` on a publishing job was a
pure no-op (`_aborts.get(jobId)` was never set, `_running.get(jobId)` was never set, so its race-wait
step did nothing and it proceeded straight to recording `cancelled` while `git commit`/`push` kept
running, unobserved); and the existing "competing lease" test was vacuous — it held no dirty file, so
`publish` reported `pushed: false` for the unrelated reason "there is nothing to publish" whether or
not the lease check ever ran.

* **Fix.** `publish()` now acquires the project write lease via the same `_acquireLeaseOrBlock` used by
  `_run`/`_runRevision` — after the atomic claim transaction has already moved the job to `publishing`
  (the only edge the state machine allows into `blocked_project_state` from there), so a denial is
  reported as this job being blocked, never a stranding. On denial, `publish` returns a
  `refusedRecord`-shaped result without touching the idempotency store, so a genuine retry (new
  attempt, same key) is not permanently poisoned by a transient conflict — unlike a deterministic
  refusal (bad pathspec, empty commit), which correctly *is* cached under the key. On success, the
  work is split into `_runPublication`, registered in `_running`/`_aborts` exactly like a coding-phase
  worker (so `cancelJob` finds it, aborts it, and races its completion the same way), with its own
  lease-renewal interval. An `AbortSignal` now threads from the engine through `Publisher.publish` →
  every `_git` call → `runGit` → the underlying `exec`'s `signal` option, and into the `gh` calls inside
  `_pullRequest`. `Publisher` accumulates `terminationConfirmed` across every git call in a publication
  attempt (not just the three already wrapped in `steps`) and carries it on both the success and
  `_failed()`/`refusedRecord()` shapes. `_runPublication` surfaces an unconfirmed kill to
  `_terminationUnconfirmed` (so a racing `cancelJob` sees it), defers entirely to `cancelJob`'s own
  verdict when cancellation was requested (mirroring `_runPhase`, never both the worker and `cancelJob`
  transitioning the same job), and otherwise calls the same `_guardTermination` to fence rather than
  release on an unconfirmed kill.
* **Tests — real dirty files, not vacuous ones.** Rewrote the competing-lease test to actually dirty
  `src.js` first, and added: nothing is committed while blocked, the job lands in
  `blocked_project_state` (not stranded in `publishing`), and the *other* job's lease is untouched. New
  tests: a pre-existing fence blocks publication the same way (and the fence survives the refusal
  unchanged); cancelling mid-`push` (a fake `exec` that runs every other git subcommand for real and
  only blocks on `push` until the threaded `AbortSignal` fires, rejecting with
  `terminationConfirmed: false` the way a real kill nobody could confirm would) never reports
  `cancelled`, fences the lease, and leaves nothing on the remote; a job left `publishing` with a real
  lease held (simulating a crash) is reconciled by the existing `reconcileOnStart` exactly like any
  other stranded workspace-active job, now that `publish` actually leaves a lease for it to find.
* **A test-authoring bug caught along the way, not a product bug:** the mid-push cancellation test
  originally hung every run — traced to `store.transact()` being asynchronous (queued and serialised,
  never throwing synchronously) while the test asserted on it with `assert.throws` instead of
  `assert.rejects`, leaving the rejected promise unhandled. Separately, the same test's
  `withEngine` helper did not expose `checkRunner`/`sessionManager`/`artifacts`/`projectStore` to the
  test body at all, so a second `OrchestrationEngine` instance built to inject a custom `exec` silently
  received `undefined` for all four — `withEngine` now passes them through, which several tests can now
  make use of.
* **GREEN.** All rewritten/new tests pass; full suite 494 pass/0 skip/0 fail (this file's tests do not
  require real-root privilege dropping, so no separate root run was needed for this part specifically —
  covered by the same full-suite root run recorded below).

### Part C — `clearFence` and `fenceLease` only ever wrote the mutable lease row

`fenceLease`/`clearFence` wrote `fenced_at`/`fenced_by`/`fenced_reason` and
`cleared_at`/`cleared_by`/`clear_reason` onto the SAME lease row — the very next `acquireLease` for
that resource replaces the row outright. A resource fenced and cleared twice retained no durable trace
of the first incident at all once the second began; the durable store's own audit comment ("jobs,
events, ... audit rows") described a guarantee the code did not yet provide for fencing specifically.

* **Fix.** New `KIND.LEASE_AUDIT` kind and `_appendFenceAudit`/`listFenceAudit` on
  `OrchestratorRepository`. Every `fenceLease` and `clearFence` call now ALSO appends an immutable
  record — `resource`, a per-resource monotonic `sequence` (via `tx.nextSequence`, the same durable
  counter mechanism `appendEvent` already relies on), `action` (`fenced`/`cleared`), `fencing_token`,
  `owner`, `operator` (the job for a fence, the named human for a clear), a redacted `reason`, and
  `recorded_at` — keyed by `${resource}:${sequence}` so no later acquire/fence/clear on the same
  resource can ever overwrite an earlier entry, unlike the mutable row. `acquireLease`/`releaseLease`
  are untouched: only a fence-set or fence-clear is audited here, and the existing lease schema and
  every existing lease/fence test pass unchanged.
* **`scripts/pw-orch-clear-fence.mjs`** now prints the audit history (`history (N record(s)):` plus one
  line per record) alongside the current lease row, both for a plain status check and right before a
  `--confirm`. An operator investigating a resource fenced more than once can now see every prior
  incident, not only the one the mutable row happens to remember.
* **RED, then GREEN.** 7 new tests in `orch-lease-fence.test.mjs`: fence appends a record; clear
  appends its own, naming the operator and the same fencing token the fence used; the trail
  accumulates (never overwritten) across two full fence→clear cycles, with strictly increasing
  sequence numbers; the trail survives the lease's own TTL lapsing; survives a real store close and
  reopen; survives compaction at a low `compactEveryRecords` threshold forced mid-sequence (asserted
  all 10 records from 5 cycles survive, not just the last); and a secret pasted into either a fence or
  a clear reason is redacted in the durable record, exactly as the existing mutable-row redaction
  already required. One more test for the script's new history output. All failed against the
  pre-fix code with `repo.listFenceAudit is not a function`; all pass now.
* **GREEN.** `orch-lease-fence.test.mjs` 21/21. Full suite 502 pass/3 skip/0 fail.

## Remaining limitations (stated, not fixed)

1. **`reconcileOnStart` cannot do better than an unconditional fence.** No live descendant list, no
   persisted per-launch pid, survives a restart to check against. Durable pid tracking across
   restarts would close this; out of scope here. (Unchanged by round 4 — round 4 made `publish` itself
   leave a lease for this to find, but did not change what reconciliation can prove.)
2. **`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`** remain preserved across the privilege drop, a stated
   interception-risk-for-compatibility trade-off from the original PR #19 work, unchanged here.
3. Two unrelated, unattributed processes observed on the shared container at verification time (see
   above) — not from this codebase, left untouched, and not this session's to clean up.
4. **Kernel-level containment (PID namespace or cgroup) remains the only structural fix** for temporal
   sampling's fundamental limit — round 4 made the reporting *conservative* (unconditionally `false` on
   any real kill after the child started) rather than closing the underlying gap, which is a
   containment primitive with provably-empty membership. Explicitly out of scope, per the reviewer's
   own framing of the trade-off as intentional.
