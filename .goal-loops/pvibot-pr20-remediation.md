# PR #20 security/lifecycle remediation

**Branch:** `pvibot/pr20-fixes` · **Base:** PR head `71d4805ce461fb904e868b5e1135425ad365dd6d`
**Round 1 commit:** `941ebe7` (AC1-AC8 below). **Round 2 (this section's addendum):** follow-up
fixing two production blockers an independent acceptance review found in round 1's own
completion notes, plus a test-methodology correction it also flagged.

**End state.** The per-user Claude/GitHub credential feature (opt-in via `PW_PER_USER_CLAUDE`)
fails closed instead of silently degrading to shared credentials; renaming or deleting a user
leaves no dangling `project.primaryUser` reference, no orphaned credential tree, and no
unqualified "success" when required cleanup fails; the user-mutation + credential-side-effect
lifecycle is fully serialized (not just the `users.json` write); the existing root-out-of-pane-
paths, saved-deploy-password and CSRF properties are unregressed and locked in by tests.

---

## Assessment (read-only pass over 71d4805)

| # | Finding | File / lines |
|---|---|---|
| AC1 | `projectCredentialOwner()` swallows a `loadUsers()` throw and a `decrypt(ghToken)` throw, returning `null` (⇒ shared login) instead of failing closed. A `primaryUser` that doesn't resolve to a user record also returns `null` instead of throwing. `credentialContext()` wraps `ensureUserCredentials()` in try/catch and falls back to `off` (shared) on ANY failure, logging only a `console.warn`. This is the literal bug AC1 targets. | `app/server.js:212-251` |
| AC2 | `PATCH /api/users/:username` mutates `u.username` in place but never updates `project.primaryUser` for any project that named the old username; `syncProjectCredentials` is only invoked when `newToken !== undefined`, never on a pure rename; the old credential-tree directory (keyed by old username) is never pruned at rename time — only at boot / on delete. Docs (`docs/per-user-claude-credentials.md:209-212`) explicitly document this as accepted behavior ("the old tree is removed by the next prune"). | `app/server.js:2668-2712` |
| AC3 | The `users.json` write is serialized via `userStore` (`app/user-store.js`), but the credential side effects that follow it (`syncProjectCredentials`, future prune) run as detached, unserialized promises after `userStore.update()` resolves. Two concurrent token updates can commit to `users.json` in order A-then-B but finish their file-writing side effects in either order, so a slow effect for an earlier commit can clobber a later commit's derived state. | `app/server.js:2703-2708` |
| AC4 | `DELETE /api/users/:username` removes the user from `users.json` FIRST (irreversible), then best-effort/silently swallows failures in: project-reference cleanup, git credential resync, credential-tree prune (`console.warn` only), and session purge (`catch{}`). Always responds `{ok:true}` regardless. A failed cleanup cannot be retried once the identity is gone, and boot pruning is the only backstop — which AC4 says must remain defense-in-depth, not the contract. | `app/server.js:2732-2772` |
| AC5 | Already correctly implemented in 71d4805 (root never touches the credential tree; helper takes the job on stdin; O_NOFOLLOW/lstat guards; injective `encodeUserName`; default-off). Verified by existing `test/user-credentials.test.mjs`. Task is to *not regress* this while touching `server.js`, and add one source-guard test tying the fail-closed change to it. | `app/user-credentials.js`, `app/credential-writer.mjs` |
| AC6 | `resolveDeployReauth` + the deploy route are untouched by this remediation; no existing route-level test locks in CSRF + saved-password-reuse end-to-end. Adding one. | `app/deploy-reauth.js`, `app/server.js:2950-3007` |
| Host-mode gap (pre-existing, OUT OF SCOPE) | `scripts/project-terminal-start` (the systemd-launched initial session in host mode) never calls into per-user credential logic at all — it always uses the shared login. This is a separate, pre-existing architecture gap (per-user creds only ever applied to the Node-managed session paths: `ensureTmuxSession`/`newTmuxWindow`/`recycle`), not a "failure" in the AC1 sense, and is not one of the 8 acceptance criteria. Left untouched; documented here and in the final report. | `scripts/project-terminal-start` |

## Design decisions

1. **AC3 first, AC2 depends on it.** Extend `createUserStore.update(mutate, effect)` so `effect(users, outcome)`
   runs inside the SAME serialized tail, after a successful save. This guarantees effect-execution order
   matches commit order, which is what makes AC2's rename resync/prune race-free.
2. **AC2 reuses existing primitives.** "Migrate or remove old namespace" → remove, via the already-tested
   `pruneUserCredentialTrees()` (used today at boot + delete), invoked from the rename `effect` with the
   freshly-committed user list as `keep`. No new credential-writer protocol needed.
3. **AC4 reorders instead of adding a compensation ledger.** Cleanup (project refs + git resync, session
   purge, credential-tree prune) runs BEFORE the final `userStore.update` that actually splices the record
   out. Any cleanup failure aborts the request without having touched `users.json` — safe to retry, and
   satisfies AC4's "fail before irreversible identity deletion" branch directly instead of a partial-success
   ledger.
4. **AC1 fail-closed errors are actionable and scoped.** `credentialContext()` no longer catches; errors
   propagate to `ensureTmuxSession`/`newTmuxWindow`, which are already wrapped by route-level try/catch →
   the operator gets a real error instead of a silent shared-login fallback. `credentialsStale()` (read-only
   status polling, not a launch path) instead treats an unresolvable owner as "stale" so one broken project
   cannot 500 the whole `/api/projects/status` response for every project.
5. **AC3 test strategy.** Exact "delayed A / newer B, B must win" ordering is proven deterministically at the
   `user-store.js` unit level (controlled `setTimeout` delays — no real-time race). At the HTTP/route level
   (AC7), the assertion is the weaker-but-100%-deterministic invariant "the derived git-credential file is
   never inconsistent with whatever users.json ends up holding" — real-time HTTP race order can't be forced
   without a test-only hook, so "must equal B" isn't asserted there.

## Verification commands (every pass)

```
cd app && npm test                                   # node --test ../test/*.test.mjs
node --check <each changed file>
git diff --check
```

## Acceptance criteria

Status legend: `PASS` (independently re-run and green) · `FAIL` · `—` (not yet attempted)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Fail-closed credential resolution | PASS | `projectCredentialOwner`/`credentialContext` (`app/server.js`) throw on read/decrypt/owner/materialization failure instead of returning `off`; `credentialsStale` reports visible `true` rather than crashing `/api/projects/status`. RED→GREEN in `test/user-lifecycle.test.mjs` tests 1-7. |
| 2 | Coherent user rename lifecycle | PASS | `PATCH /api/users/:username` effect repoints every `project.primaryUser`, resyncs git credentials, actively prunes the old credential namespace. RED→GREEN in `test/user-lifecycle.test.mjs` tests 8-11 (+ drift/restart test). |
| 3 | Serialized mutation + side-effect lifecycle | PASS | `createUserStore.update(mutate, effect)` (`app/user-store.js`) chains the effect onto the same serialized tail. RED→GREEN unit tests in `test/user-store.test.mjs` (deterministic delayed-A/newer-B ordering); route-level consistency test in `test/user-lifecycle.test.mjs`. |
| 4 | Bounded, fail-safe user deletion | PASS | `DELETE /api/users/:username` rewritten into validate → cleanup (fails closed, nothing persisted on failure) → irreversible removal. RED→GREEN in `test/user-lifecycle.test.mjs` (cleanup-failure-then-retry test). |
| 5 | Root-out-of-pane-paths etc. unregressed | PASS | Full `test/user-credentials.test.mjs` + `test/terminal-owner.test.mjs` + `test/terminal-priv.test.mjs` green; new source-guard test ties the AC1 rewrite to "never return the shared/off credentials from a catch"; live root-to-admin probe (see below). |
| 6 | Deploy password / CSRF unregressed | PASS | `test/deploy-reauth.test.mjs` (unit, untouched) + new `test/deploy-route.test.mjs` (route-level CSRF + saved-password-reuse) all green. |
| 7 | Route/domain test coverage | PASS | `test/user-lifecycle.test.mjs` (18 tests) + `test/deploy-route.test.mjs` (2 tests), covering fail-closed fallback, rename/delete lifecycle, delayed-effect consistency, restart/drift (recycle + credentialsStale). |
| 8 | Self-review + full suite + root probe + commit | PASS | See "Self-review" and "Verification evidence" below. |

## Self-review

- **File-store atomicity/crash windows.** `saveUsers`/`saveProjects`/`saveSessions` remain plain
  `writeFile` (no write-then-rename), pre-existing and unchanged by this remediation — a crash mid-write
  can still truncate one of those files. Out of scope for this pass (not named in the 8 criteria); noted
  here rather than silently left undocumented.
- **Cross-store rollback.** There is no transaction spanning `users.json` + `projects.json` + the
  credential tree. AC2's rename and AC3's serialization make the ORDER safe (derived effects always
  observe the freshly committed user list, never a stale one), but a rename whose *effect* fails after
  `users.json` already committed is not automatically rolled back or retried by an identical follow-up
  request (documented in `docs/per-user-claude-credentials.md`). AC4's delete is stronger by construction:
  every fallible step runs and succeeds BEFORE anything is persisted, so its failure mode is a clean no-op,
  not a partial commit.
- **Stale sessions.** Sessions are keyed by the user's immutable `id`, not username, so a rename cannot
  orphan a session (verified by reading `attachUser`, not just tests). Deletion purges sessions by `id` as
  part of the same bounded, fail-closed operation (AC4).
- **Shared-UID claims.** `docs/per-user-claude-credentials.md`'s threat-model table ("accountability, not
  isolation") is unchanged and still accurate — this remediation does not and cannot make per-user
  credentials mean per-user OS isolation; it only removes the SILENT degradation to shared credentials.
- **GOA compatibility.** `users-compat.js`/`normalizeUserRecord` untouched; `test/users-compat.test.mjs`
  still green. Default-off (`PW_PER_USER_CLAUDE` unset) behavior is unchanged and covered by a dedicated
  regression test.
- **Pre-existing, out-of-scope gap (documented, not fixed):** `scripts/project-terminal-start` (the
  systemd-launched initial session in HOST mode) never calls into per-user credential logic at all — it
  always uses the shared login. This is a separate, pre-existing architecture limitation (per-user creds
  only ever applied to the Node-managed paths: `ensureTmuxSession`/`newTmuxWindow`/`recycle`), not a
  "failure" in the AC1 sense, and is not one of the 8 acceptance criteria — left untouched.

## Verification evidence

- Focused security suite (`user-credentials`, `terminal-owner`, `terminal-priv`, `user-store`,
  `users-compat`, `deploy-reauth`, `deploy-route`, `user-lifecycle`): **108/108 pass**.
- Full suite (`cd app && npm test`): **453/453 pass**, 0 failures (baseline at 71d4805 was 428/428).
- Production-shaped root-to-admin helper probe: dashboard spawned as uid 0 (root) via `sudo -n`, host mode,
  `PW_PER_USER_CLAUDE=true`. `POST /api/term/demo/recycle` succeeded; the resulting credential tree
  (`pw-users/alice/claude/.claude.json`) was owned by `admin:admin` (0700/0600), never root; the tmux
  server for the session ran as a `sudo -u admin tmux …` process, not root; `ps`/`lsof` showed no root
  process touching the credential tree directly. Confirms the privilege-drop path (`credentialDropArgv` →
  `sudo -n -u admin` → `credential-writer.mjs`) is real, not just unit-tested. Temp instance and stray tmux
  socket cleaned up afterward.
- `app/VERSION` bumped to `1.26.0729.2130` per the repo's release-bump convention
  (`test/release-version.test.mjs`).

---

## Round 2: two production blockers + a test-methodology fix (independent acceptance review)

### Blocker 1 — `scripts/project-terminal-start` bypassed the fail-closed contract entirely

Round 1's AC1 fix only covered sessions `app/server.js` creates directly (`ensureTmuxSession` /
`newTmuxWindow` / recycle). The HOST-MODE, systemd-launched INITIAL terminal
(`project-terminal@.service` → `scripts/project-terminal-start`) never called into that logic at
all — with `PW_PER_USER_CLAUDE=true` it always used the shared login, silently, for the very first
session of every project. Fixed by extracting the shared decision logic out of `server.js` into
three small modules so a SECOND entrypoint can enforce the identical contract without duplicating
it (drift risk is exactly how this class of bug happens):

- `app/project-owner.js` — `resolveProjectCredentialOwner()`, extracted pure from `server.js`'s
  `projectCredentialOwner()`.
- `app/secret-crypto.js` — `makeSecretCrypto()`, extracted from `server.js`'s inline AES-256-GCM
  `encrypt`/`decrypt`.
- `app/users-file.js` — `loadUsersFile()`, extracted from `server.js`'s `loadUsers()`.
- `app/project-terminal-credentials.mjs` — new CLI, same stdin/stdout-JSON protocol shape as the
  existing `credential-writer.mjs`, reusing `ensureUserCredentials`/`terminal-owner.js` verbatim (no
  new privilege-drop mechanism). Prints `{"shared":true}` for the two intended shared-login cases,
  materialized-context JSON on success, or `{"ok":false,"error":...}` + nonzero exit on any other
  failure.
- `scripts/project-terminal-start` now calls that CLI before tmux/ttyd start, aborts on nonzero exit
  (before any session exists), builds `tab_env` with `CLAUDE_CONFIG_DIR`/`--rcfile` when a real
  owner resolved, and stamps `@pw_cred_key` on the session so `credentialsStale` treats it
  identically to a dashboard-created one. Added `PW_TMUX_SOCKET`/`PW_REGISTRY_PATH`/`PW_APP_DIR` env
  overrides (all no-ops when unset) purely so the real script can be tested against a real, privately
  socketed tmux server without ever touching the shared default socket or the production registry.

RED→GREEN: `test/project-owner.test.mjs`, `test/secret-crypto.test.mjs`, `test/users-file.test.mjs`,
`test/project-terminal-credentials.test.mjs` (7 tests against the real CLI as a child process),
`test/project-terminal-start.test.mjs` (7 tests against the REAL bash script + a REAL, isolated tmux
server — enabled/valid-owner, disabled, no-owner, dangling-owner, corrupt-store, corrupt-token,
materialization-failure, no-secret-in-output).

### Blocker 2 — rename reconciliation was not retryable

Round 1 documented (rather than fixed) that a rename whose post-commit effect failed could not be
recovered without a manual file edit, because retrying the identical PATCH found the username
already changed and treated it as a no-op. Fixed with a durable `pendingCredentialSync:
{fromUsername, toUsername}` marker recorded on the user record inside the SAME commit as the
rename:

- The PATCH mutator sets/extends the marker (chaining through an unfinished PRIOR rename's original
  `fromUsername` if one exists) and carries it forward on a no-op retry.
- The effect reconciles via a new `reconcileRenameCredentials()` (shared by the PATCH effect, a new
  `POST /api/users/:username/reconcile` recovery endpoint, and `DELETE`), then clears the marker.
- **No mistaken takeover**: `reconcileRenameCredentials()` refuses (leaves the marker pending) if the
  OLD username is now held by a *different* current user — proceeding would hand that person's
  projects or credential tree to the renamed account.
- `DELETE` now also revokes a lingering OLD-name project reference left by an unfinished rename,
  guarded by the same no-takeover check.
- `pendingCredentialSync` surfaced on `GET /api/users` so a stuck reconciliation is visible, not a
  hidden file-only state.

**Self-caught bug during implementation:** the first version of the effect cleared the marker via a
second `userStore.updateUser()` call from INSIDE the effect itself — which re-enters the store's own
serialization tail (the effect is already running as part of it) and deadlocks. Caught by a
timeout-guarded regression test (`test/user-store.test.mjs`) before it ever reached the full test
run silently. Fixed by giving `effect` a third `resave()` argument that persists a follow-up mutation
to the in-memory array directly, without re-queuing — see `app/user-store.js`.

RED→GREEN: 7 new tests in `test/user-lifecycle.test.mjs` (visibility, retry-after-failure at each of
the three effect stages — project-reference reassignment, git-credential resync, credential-tree
prune — the explicit recovery endpoint, no-mistaken-takeover, and DELETE sweeping a lingering
old-name reference) + 1 in `test/user-store.test.mjs` (the deadlock regression).

### Test-methodology fix — the concurrent-token-order test

The prior version accepted "either A or B" as the final token and used a mutating "verification"
PATCH as its consistency check — which could itself paper over a real divergence between two
racing requests. Replaced with a test that (a) asserts token B (the one fired second) specifically
and deterministically — proven reliable across repeated runs because `update()`'s effect is
serialized on the same tail as the commit, so the second request's entire pipeline cannot even
start until the first's has fully finished — and (b) verifies by independently decrypting
`users.json`'s own ciphertext off disk and reading the credential file directly, with no write in
the check itself. The exact "delayed-A-must-not-clobber-newer-B" ordering claim remains proven with
a fully controlled clock at the unit level in `test/user-store.test.mjs`.

### Round 2 verification evidence

- Focused security suite (13 files incl. all round-2 additions): **146/146 pass**.
- Full suite (`cd app && npm test`): **491/491 pass**, 0 failures (round 1 was 453/453; round 2 added
  38 new tests across 6 new files + extensions to 2 existing ones).
- Second production-shaped root-to-admin probe: dashboard spawned as uid 0 again, this time ALSO
  exercising a rename (`alice` → `alicia`) through the live HTTP API while running as root —
  `pendingCredentialSync: false` in the response, `alicia`'s new credential dir created and owned by
  `admin:admin` on the next recycle, `alice`'s old namespace actively pruned, `/api/projects/status`
  correctly reporting `credentialsStale: true` in between (session env baked at creation, as
  documented) and `false` again after a reconciling recycle. Cleaned up afterward; production
  instance at `/opt/project-workbench/app/server.js` (pid unrelated, untouched) verified unaffected
  throughout.
- `app/VERSION` bumped again to `1.26.0729.2217` (round 2 is a second substantive change to `app/`
  since the round-1 bump).

### Remaining out-of-scope observation (not requested, not fixed)

`ensureTmuxSession()` in `app/server.js` calls `credentialContext(p)` — which can now throw — BEFORE
checking whether the session already exists. For an EXISTING session (e.g. a container-mode boot
loop reattaching after a dashboard restart), a currently-broken credential owner would block ttyd
from reattaching to a session that is otherwise running fine, since a live session's env is fixed at
creation and doesn't need fresh credentials at all. This is a real latent gap introduced by round
1's fail-closed fix, but it is not either of the two named blockers and was not fixed here to avoid
further scope expansion; flagging it explicitly rather than leaving it silently undiscovered.

**Round 3 note:** the round-2 observation above was superseded — round 3's adversarial review (item 6)
explicitly required the OPPOSITE of what round 2 assumed: an existing session must be fail-closed too
(verified every attach, not just every create). See below; the "out-of-scope" framing no longer applies.

---

## Round 3: 9-item adversarial review — lifecycle concurrency, durability, and session-attach correctness

Independent adversarial review blocked commit `ec163bd`. Nine items across three tiers (P0 lifecycle
protocol, P1 launch/session protocol, durability/security). Full detail in code comments at each site
named below; this is the map + the evidence.

### P0-1 — immutable opId + one serialized lifecycle (was: read marker → effects outside userStore → clear by id)

`pendingCredentialSync` now carries an `opId` (`crypto.randomUUID()`). `app/lifecycle-lock.js` is a new
cross-process lockfile (O_EXCL create, PID-liveness-based stale-break — never a bare timer, so a live-but-
slow holder's lock is never broken out from under it, only a genuinely dead PID's is, immediately). PATCH/
POST-create/DELETE/POST-reconcile each run their ENTIRE body — read, validate, mutate users.json, repoint
`project.primaryUser`, resync git credentials, prune the old credential-tree namespace, clear the marker —
inside ONE `withLifecycleLock()` acquisition. `app/user-lifecycle.js` holds the extracted pure decisions
(`resolveLifecycleTarget`, `reservedUsernameConflict`, `reconciliationStillCurrent`) so the ABA guard is
unit-tested in isolation, not just implied by the lock.

**Self-caught during implementation:** the first cut cleared the marker via a second `userStore` call
from inside the same `update()`'s effect — re-entering the store's OWN serialization tail while still
inside it, a self-deadlock. A timeout-guarded test in `test/user-store.test.mjs` caught it before it
reached a silent hang. Fixed by giving `effect()` a `resave()` callback that persists a follow-up mutation
without re-queuing (see `app/user-store.js`). Once the cross-process lock existed, `userStore` (round 1/2's
in-process-only serialization) was retired from `server.js` ENTIRELY — not just for rename/delete, but for
password-change, login's `lastLoginAt`, and the deploy-password save too (`withUsersLock()`), because
leaving those on the OLD mechanism while lifecycle ops moved to the NEW one would have reintroduced the
exact split-brain race both were built to prevent. `app/user-store.js` itself is untouched and still
tested standalone — just no longer wired into `server.js`.

**Also caught by the production probe (see below), not by a written test first:** the PATCH route's
immediate JSON response echoed a stale, already-cleared `pendingCredentialSync` marker when reconciliation
succeeded within the SAME request (the returned record was a closure over the pre-reconciliation object,
never updated to match what was just persisted). RED confirmed by reverting the two-line fix and re-running
`test/user-lifecycle.test.mjs`; fixed by syncing the in-memory record with the on-disk one at the exact
point the marker is cleared.

RED→GREEN: `test/user-lifecycle-core.test.mjs` (10 unit tests for the 3 pure functions, including the ABA
guard with a deliberately mismatched opId), `test/user-store.test.mjs` (+1 deadlock regression),
`test/atomic-file.test.mjs` (5), `test/lifecycle-lock.test.mjs` (6, including two REAL node processes
racing the same lock with a deliberate read-then-write window — zero lost increments across 40×2 iterations).

### P0-2 — literal-URL/body replay must be idempotent

`resolveLifecycleTarget(users, target)` resolves the EXACT current username first (unambiguous); only
when there is no current match does it fall back to a user whose unfinished rename's ORIGINAL name was
`target`. `test/user-lifecycle-locking.test.mjs`'s first two tests replay the VERBATIM original
`PATCH /api/users/alice {"username":"alicia"}` and `DELETE /api/users/alice` — same URL, same body, no
adjustment for the rename that already happened — after a forced post-commit failure, and both succeed.

### P0-3 — DELETE reworked as an immutable-ID staged operation

Phase 1 (snapshot by `resolveLifecycleTarget`, still keyed to `victim.id` from there on) → phase 2
(cleanup: project refs + git resync + credential-tree prune, all pre-persistence; project-ref commit
under `withProjectsLock`, session purge under `withSessionsLock` — NOT bypassed anymore) → phase 3 (the
irreversible splice, re-read fresh and matched by `victim.id`, never by username again). All three phases
run inside the SAME `withLifecycleLock()` acquisition as phase 1's snapshot.

RED→GREEN (`test/user-lifecycle-locking.test.mjs`): rename+recreate race (DELETE by the renamed identity's
current name never touches the new account that reclaimed the old one), a concurrent login racing DELETE's
session purge (10 concurrent login attempts + a delete, `withSessionsLock` serializes correctly, no lost/
corrupt session), project-save-stage failure + replay, credential-prune-stage failure + replay, and a
replay after full success (clean 404, no resurrection/double-act).

### P0-4 — username reuse must not inherit a prior identity's credential tree

Chose "reserve names while pending" over full ID-keyed credential namespace re-migration — documented
tradeoff: the codebase has exactly two ways a username becomes free (rename-away, delete), both already
actively prune the vacated name's tree at the SAME commit as freeing it (round 2), so reservation only
needs to close the WINDOW while a rename is pending-but-unreconciled. Re-keying the entire credential tree
by immutable id would be strictly more robust but requires a live-migration path for every already-deployed
username-keyed tree — assessed as disproportionate additional risk/scope for the marginal safety gap it
would close beyond what reservation + active-prune-at-free-time already covers for this codebase's actual
mutation paths. `reservedUsernameConflict()` rejects CREATE/RENAME into any username that is the `from` side
of a DIFFERENT account's still-pending marker; `reconcileRenameCredentials()`'s existing claimant check
(round 2) remains as a defense-in-depth backstop for a reservation-layer bypass (an out-of-band edit).

RED→GREEN: reservation rejection at CREATE, the defense-in-depth claimant check via an out-of-band edit
(the round-2 "no mistaken takeover" test, kept but its setup corrected — see below), and an end-to-end
test seeding a departed user's real OAuth (`.credentials.json`), GitHub token (`session-env.sh`), and MCP
config, deleting them, recreating the SAME username, and asserting NONE of the old material — not the
OAuth token string, not the GitHub token, not even the stale files' presence — survives into the new
identity's directory after her own materialization.

**Self-caught while adjusting round-2's takeover test:** with reservation now enforced, that test's OWN
premise (create a conflicting account via the API) started failing CORRECTLY — the create is now rejected,
which is the fix working, not a regression. Split into two tests: one asserting the create IS rejected
(the new primary defense), and one exercising the claimant-check backstop via an out-of-band file edit
(what the original test was actually trying to prove, now with an accurate setup).

### P1-5/6 — unified credential + existing-session-attach policy

`ensureProjectTmuxSession()` (the PVIKPBot base session) now routes through `credentialContext()` (fail-
closed materialization) and stamps `@pw_cred_key`, exactly like `ensureTmuxSession()` — round 1 left it on
static shared-login env unconditionally; item 5 closed that.

**Correction mid-round, from the user directly:** round 3's first pass at item 6 misread "never alternately
block valid sessions and attach stale identities" as "never block an existing session" — i.e., the
underlying tmux session is fine to KEEP RUNNING, which is true, but a live test I'd just written asserted
that RE-ATTACHING to it after credentials broke should still succeed, which is the wrong half of the
sentence. The user corrected this directly: continuity of an already-open terminal is not a reason to
attach under an unverified or stale identity — attribution safety comes first. Both `ensureTmuxSession()`
and `ensureProjectTmuxSession()` (and `scripts/project-terminal-start`, in bash) now resolve the CURRENT
owner UNCONDITIONALLY (not gated on session existence) and, for an existing session, compare its stamped
fingerprint against that current owner EXACTLY — matching or the legitimate "never stamped, genuinely
shared" case attaches; anything else (unresolvable owner, or a resolved owner whose fingerprint no longer
matches — a rotated token, a reassignment) refuses to attach with an actionable recycle-required error,
WITHOUT killing the underlying session. The wrongly-designed test was inverted into the correct one (plus
a sibling for the fingerprint-mismatch case) before being kept.

RED→GREEN: `test/project-terminal-start.test.mjs` (+3: unchanged-owner-reattaches, unresolvable-owner-
refuses, rotated-token-refuses, all against the real script + a real tmux server), plus 4 new server-side
tests in `test/user-lifecycle-locking.test.mjs` (a `/manage/update` fail-closed-create-path check — that
route always kills the session first via `stopProject`, so it cannot exercise the existing-session branch
itself, and is labeled accordingly; a genuinely existing-session test via the PVIKPBot handoff endpoint,
which does NOT kill first, discriminating a fast fail-closed refusal from reaching the ~30s
no-real-claude-binary wait by elapsed time).

### P2-7 — crash-safe files + cross-process lock (see P0-1 above for the lock; this is the write path)

`app/atomic-file.js`: temp file in the SAME directory + `fsync` + atomic `rename()` + directory `fsync`,
mode set explicitly (not left to umask). `saveUsers`/`saveProjects`/`saveSessions` all route through it now
— a source-guard test asserts none of them ALSO plain-`fs.writeFile`s. `withProjectsLock`/`withSessionsLock`
are UNCHANGED and still used for their existing (now also lock-nested-under-the-lifecycle-lock, where
relevant) purposes — not weakened, not replaced.

RED→GREEN: `test/atomic-file.test.mjs` (5, including a real child process SIGKILLed mid-write with the
original file surviving byte-for-byte).

### P2-8 — root traversal in `userClaudeSignedIn`

`fs.stat()` follows a symlink at the final path component; a pane user could plant one at
`<base>/<victim>/claude/.credentials.json` pointing anywhere root-readable and use the boolean
`claudeSignedIn` API field as a 1-bit oracle for an arbitrary path's existence/size. `userSignedIn()`
(`lstat`, never follows) + `checkUserSignedIn()` (same in-process-or-dropped-helper shape as
`ensureUserCredentials`/`pruneCredentials`) replace it; `credential-writer.mjs` gained a `"status"` action
on the SAME stdin/stdout protocol — no new privilege-drop mechanism, the existing one reused.

RED→GREEN: `test/user-credentials.test.mjs` (+6: value correctness, planted-symlink regression, drop-vs-
in-process delegation, the helper's new protocol action, a source guard that server.js no longer
`fs.stat()`s inside the tree), `test/user-lifecycle.test.mjs` (+1 HTTP-level: real completed login reported
true, a planted symlink at a DIFFERENT user's path reported false, through `GET /api/users`).

### Round 3 verification evidence

- Focused security suite (17 files incl. all round-3 additions): **192/192 pass**.
- Full suite (`cd app && npm test`): **538/538 pass**, 0 failures (round 2 was 491/491; round 3 added 47
  new tests across 5 new files + extensions to 4 existing ones, plus the 1 test that caught the
  same-request stale-marker bug above).
- Third production-shaped root-to-admin probe: dashboard spawned as uid 0 again, exercising recycle,
  rename (under the cross-process lock, `pendingCredentialSync` with a real `opId` in the live response),
  `GET /api/users` (through `checkUserSignedIn`'s dropped-helper path), and DELETE (immutable-ID staged) —
  all against a REAL lifecycle lock file at a real path (confirmed released — absent — between requests).
  Credential tree and its ownership verified admin-owned throughout (never root), pruned correctly on
  delete. users.json/projects.json confirmed root:root-owned (root owning ITS OWN files is correct and
  expected; only the shared pane-credential tree must avoid root touches) with no stray atomic-write temp
  artifacts left behind and correct modes (`users.json` 0600). This probe is what actually caught the
  same-request stale-marker bug fixed above — an unscripted, real-request exploration, not a pre-written
  test. Production instance at `/opt/project-workbench/app/server.js` (different PID, untouched) verified
  unaffected throughout; probe temp dir and its private tmux socket cleaned up afterward.
- `app/VERSION` bumped to `1.26.0730.0018` (round 3 is a third substantive change to `app/` since the
  round-2 bump; date rolled over to 2026-07-30 during this round).

### Self-review (crash windows, marker ABA, PID/process boundaries, migration, stale sessions, GOA compat)

- **Crash windows.** users/projects/sessions files are now atomic-write crash-safe. A process crashing
  WHILE HOLDING the lifecycle lock leaves a lock file stamped with its (now-dead) PID — the very next
  acquisition attempt detects non-liveness and breaks it immediately (no `staleMs` wait for this, the
  common case). A crash between the lock file's `open()` and its pid/timestamp `write()` landing leaves an
  unparseable lock; that path falls back to `lockFileAgeMs` against a bounded `staleMs` (default 60s) — an
  extremely narrow window, and still self-healing, just slower.
- **Marker ABA.** Closed structurally by the single cross-process lock (two lifecycle operations on the
  same identity literally cannot interleave anymore) AND redundantly by the `opId` equality check
  (`reconciliationStillCurrent`), unit-tested against a deliberately mismatched marker so the guard's
  correctness doesn't rest on the lock alone.
- **PID/process boundaries.** `process.kill(pid, 0)` distinguishes dead (ESRCH, break immediately) from
  alive-but-inaccessible (EPERM, treated as alive — never guess a foreign process is dead). Residual,
  undocumented-elsewhere limitation: PID reuse racing the exact staleness-check window (an extremely
  low-probability event on a single admin-panel host) could make a live unrelated process look like the
  original holder; the failure mode is a bounded `timeoutMs` error on the NEW acquisition attempt, not
  silent corruption.
- **Backward migration.** None required — item 4's reservation approach deliberately keeps the existing
  username-keyed credential-tree layout unchanged; every already-deployed `pw-users/<username>/` directory
  continues to work exactly as before.
- **Stale sessions.** tmux sessions: covered by items 5/6's stricter attach policy end to end. Auth
  sessions (`sessions.json`): DELETE's purge now goes through `withSessionsLock`, closing the exact
  concurrent-login-vs-delete race a bypass would have allowed; login/logout are unaffected.
- **GOA compatibility.** `pendingCredentialSync`'s API shape changed (boolean → object-or-null) but is not
  referenced anywhere in the embedded admin UI's client-side JS (`renderUsers` and friends) — confirmed by
  grep — so this is additive, not breaking, for the current UI. `PW_PER_USER_CLAUDE` remains default-off;
  none of the atomic-write/lifecycle-lock changes are gated by it (they apply unconditionally, as a general
  durability/correctness improvement, transparent to a GOA deployment that never touches per-user
  credentials at all).

## Round 4: a real lost-update bug in the lifecycle lock itself, found by final combined integration

Final combined integration testing (PR20 HEAD `3b0021e`, the merge of round 3 with PR19's
`3ac9212` installer fix from `origin/main`) exposed a genuine, reproducible correctness failure:
`test/lifecycle-lock.test.mjs`'s two-real-process race test returned 79 instead of 80 increments
under `node --test --test-concurrency=1`. The lock this whole remediation depends on for AC3/AC4's
serialization guarantee had a lost-update bug of its own. This section documents the root cause,
the fix, and the evidence that it's actually closed — not just less likely.

### Root cause (empirically confirmed, not just reasoned about)

v1's release and stale-reclaim paths both ended in a **blind, path-based unlink**
(`fsp.rm(lockPath, { force: true })`) with no check that the file currently at that path was still
the instance being acted on. That's a textbook ABA/TOCTOU: the staleness *decision* (read the path,
judge dead-or-old) and the unlink *action* were two separate steps with an unbounded gap between
them.

Reproduced directly (not just inferred) by instrumenting a copy of the module with per-event,
high-resolution logging and racing two real `node` processes against the same lock file. The
captured trace (`/tmp/pw-lock-debug/fail-debug-2.log` during this session; not preserved in the
repo) shows the exact sequence:

1. Process **A** releases its lock (unlinks the path), then immediately starts its next loop
   iteration's acquisition.
2. Process **B**, still mid-retry from an earlier `EEXIST`, hits the brief gap where the path is
   momentarily absent — its `readLockInfo` returns `null` and its age-based fallback
   (`lockFileAgeMs`) also observes `ENOENT`, which the v1 code treated as `Infinity` age ⇒
   `stale = true`.
3. Between B's staleness *decision* and its `fsp.rm(lockPath)` *action*, A's `open()` + `writeFile()`
   for its NEW (successor) lock lands — a fully valid, live lock.
4. B's delayed `rm()` executes anyway (it's unconditional and path-based) and deletes A's brand-new
   successor lock. Both A and B now believe they hold the lock. A's critical section and B's
   critical section run concurrently — the exact mechanism that loses an update.

A 15-run local reproduction loop hit this on run 3 with a WORSE loss than the user's original
report (`73 !== 80`, i.e. 7 lost increments, not 1), confirming this was a fairly easily triggered
systemic flaw, not a rare one-off tied to the specific "combined stack" CI environment.

### Fix: an ownership-token, claim-then-verify protocol (`app/lifecycle-lock.js` v2)

Kept fully in userspace — no native deps, no shelling out to `flock(1)` — because the redesign
below closes the race without it:

1. **Atomic publication.** Every acquisition writes its full record — `{pid, startTicks, token,
   acquiredAt}` — to a private temp file first, then makes it visible at the lock path with a
   single `link()` call (exclusive, atomic, fails `EEXIST` if already locked). A lock file is
   therefore **never observable half-written**: any reader sees either nothing or a complete,
   parseable record. This directly closes the "empty/ambiguous file during acquisition" trigger
   that step 2 of the root cause above depended on.
2. **Unguessable owner identity per acquisition**, not just per process: `crypto.randomBytes(16)` token
   generated fresh every single call to `withLifecycleLock()`, so even the SAME process's own 40
   sequential re-acquisitions of the same lock (exactly what the race test's worker loop does) are
   distinguishable instances, not just distinguishable processes.
3. **PID + start-time identity**, not bare PID liveness. `getStartTicks(pid)` reads
   `/proc/<pid>/stat` field 22 (ticks since boot; comm-field parsing matches the existing
   `scripts/pw-tmux-save` convention) so a dead PID recycled by an unrelated live process is
   correctly still treated as dead, closing the PID-reuse gap round 3's own self-review had already
   flagged as a residual, undocumented risk.
4. **Removal is claim-then-verify, never a blind unlink.** Both a holder's own release
   (`releaseOwned`) and a waiter's stale-lock reclaim (`tryReclaim`) start by calling
   `claimExclusive()`, which does `rename(lockPath, privateClaimPath)`. `rename()` on a shared
   source path is atomic — of any number of concurrent renamers, exactly one succeeds and the rest
   get `ENOENT` — so exactly one actor ever ends up holding the file that WAS at the path,
   decoupled from whatever gets published there next. Only then is the claimed content inspected:
   `releaseOwned` deletes it only if its token matches the exact instance being released;
   `tryReclaim` re-decides staleness fresh on the exact claimed content (never on an earlier,
   separately-read snapshot). Anything that doesn't check out is restored via `restoreIfFree()`
   (itself an atomic, exclusive `link()`), which can never clobber a fresh successor a legitimate
   new holder published in the meantime.

`app/server.js`'s `withUsersLock`/route usage of `withLifecycleLock()` is unchanged — the function
signature is identical; only the internal protocol and on-disk record format changed. The on-disk
format is a purely internal implementation detail (confirmed via grep: nothing outside
`lifecycle-lock.js` itself reads or writes the lock file), so changing it from the v1 plaintext
`"pid\ntimestamp\n"` to v2's JSON record required no migration.

### RED → GREEN

`test/lifecycle-lock.test.mjs` grew from 6 to 13 tests (net +7), rewritten against the new
protocol/format so RED was "does not satisfy the v2 contract at all" (the new tests reference an
`_internal` test-only export the v1 file didn't have) rather than a narrower single-assertion
failure — appropriate for a full protocol redesign, not an incremental patch. New tests: two real
processes racing at high iteration (150 each, up from 40, `150*2=300` expected), three real
processes racing (100 each, `300` expected), a start-time-mismatch (simulated PID-reuse) reclaim
test, a real crash-recovery test (a child process acquires and `process.exit()`s mid-critical-
section, never reaching the release), two `_internal`-driven deterministic tests that directly
reconstruct the exact race found above (a stale instance is claimed away and discarded while a
fresh successor is published at the same path in between — the successor must survive untouched;
`tryReclaim()` and `releaseOwned()` each get a direct exact-ownership assertion), an 8-contender
concurrent-stale-breaker race (asserts `maxConcurrent === 1`), and every test now asserts no stray
`.tmp-*`/`.claim-*` bookkeeping files survive. All 13 pass on the v2 implementation; running against
the reverted v1 file fails immediately with a missing-export `SyntaxError` (confirmed RED before
implementing v2).

### Verification evidence

- `test/lifecycle-lock.test.mjs` alone, sequential (`node --test --test-concurrency=1`), run
  **93 times in a row: 0 failures** (33 runs interactively, then 60 more in a single unattended
  loop) — this is the exact reproduction harness and flag the originally-reported failure used.
- Additional standalone adversarial stress (outside the test file, real OS processes, no test
  framework overhead): 5-process/300-iteration and 8-process/150-iteration races (3 rounds each),
  a 16-process/60-iteration thundering-herd race, and 5 rounds of an 6-process race where one
  worker deliberately hard-crashes (`process.exit()`) mid-critical-section at iteration 30 to force
  the stale-reclaim path under live contention — every round's counter matched the exact expected
  total, zero stray lock-directory debris in any round.
- A dedicated real-process liveness test: a holder is `SIGSTOP`'d mid-hold (genuinely alive, merely
  frozen — not a crash); a concurrent waiter correctly times out rather than reclaiming; `SIGCONT`
  lets the original holder finish and release normally.
- Downstream consumers unaffected: `test/user-lifecycle-locking.test.mjs` (24 tests, includes the
  round-3 rename/delete/reconcile lifecycle-lock-dependent tests) and
  `test/project-terminal-start.test.mjs` (10 tests) both still fully green against v2.
- Full sequential suite (`cd app && npm test`, i.e. `node --test --test-concurrency=1
  ../test/*.test.mjs`): **552/552 pass**, 0 failures (545 baseline per the round-4 report + 7 net
  new lifecycle-lock tests this round added).
- `app/VERSION` bumped `1.26.0730.0018` → `1.26.0730.0151` (only `app/lifecycle-lock.js` and
  `test/lifecycle-lock.test.mjs` changed this round; `test/release-version.test.mjs` confirms the
  bump satisfies the forward-motion + deployable-content-requires-a-bump guard from PR19).
