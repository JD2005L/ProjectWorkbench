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
