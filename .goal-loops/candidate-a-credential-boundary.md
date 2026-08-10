# Candidate A — Git credential boundary (GOA-6, P1 security)

`PVI-DEV-v1 | Tier: 3 | Operator: Hermes-supervised | Gate budget: focused tests during
iteration; one full canonical `npm ci && npm test` at the frozen head; one immutable review
(Hermes-James) — not self-declared.`

- Base (canonical origin/main): `812c99bf16e9787c1673da85a0e4d51085cd4167`
- Branch: `fix/credential-boundary-candidate-a-r9` (fresh replacement lane)
- Superseded: base `7783ee2` / branch `fix/credential-boundary-candidate-a` (never pushed, no commits).
  `7783ee2 -> 812c99b` is documentation-only (`DEVELOPMENT-COORDINATION.md`, +159), so the
  assessment below still holds against unchanged production code.
- GOA PR #31 (`81225ea1…`) is BLOCKED and must not be modified, merged, or built on. Not inspected.
- Worktree: `.worktrees/candidate-a-credential-boundary` (re-cut from the exact SHA, parity verified)
- Out of scope / unauthorized: Candidate C, merge, deployment, service restart, runtime
  credential mutation, live-artifact remediation, edits to `DEVELOPMENT-COORDINATION.md`.

## 1. Assessment — the defect as it exists at the base SHA

`app/server.js:147-168` `syncProjectCredentials()` runs **in the root dashboard process** and:

1. `fs.writeFile(<project>/.git/.pw-credentials, "https://<decrypted token>:x-oauth-basic@github.com")`
   — a root write, following symlinks, into a directory owned by the shared pane account
   (`admin`, live host shows `.git` at `admin:admin 775`). A pane user can pre-plant
   `.git/.pw-credentials` as a symlink and (a) capture another user's decrypted GitHub token,
   (b) have root create/clobber an arbitrary file. This is the same confused-deputy class
   `app/user-credentials.js` already eliminated for the `pw-users` tree — the git credential
   artifact was simply never migrated behind that boundary.
2. Three `git config --local` mutations of `<project>/.git/config`, also as root, in the same
   pane-controlled repository.
3. Every one of those git calls is `.catch(()=>{})`, so a partial application (artifact written,
   helper not registered; helper unset, artifact still present) is silent and invisible.

Secondary instance of the same class: `cloneWorkspace()` (`app/server.js:1406-1413`) writes the
decrypted token to `<workspaceRoot>/.pw-clone-<slug>` as root. `workspaceRoot` is
`admin:admin 0755` on the live host, i.e. pane-owner-controlled and pre-plantable.

Serialization: the sync is reached from two different locks — `withProjectsLock` (`/manage/add`,
`/manage/update`) and `withLifecycleLock` (rename reconcile, token rotation, delete) — so a
rotation and a project update can interleave on the same repository, and callers pass a
**snapshot** of `users` that can be stale by the time the write lands.

Existing vetted boundary to reuse (do not reinvent): `credentialExecutionPlan()` /
`credentialDropArgv()` / `spawnCredentialJob()` in `app/user-credentials.js` +
`app/credential-writer.mjs` (one JSON job on stdin, one JSON result on stdout, argv carries no
secret, `setpriv` in container mode / `sudo -n -u` in host mode).

Repo facts that constrain the design:
- `.goal-loops/*.md` **are** tracked (`git ls-files .goal-loops` returns 6 files) → commit this log.
- Release guard `test/release-version.test.mjs` requires `app/VERSION` to move forward whenever
  anything under `app/` changes. Format `1.YY.MMDD.hhmm` (UTC).
- CI: `.github/workflows/test.yml` → `npm ci` + `npm test` in `app/`, `fetch-depth: 0`.
- No linter in the repo; `node --check` is the syntax gate.
- Tests boot real isolated `app/server.js` instances (`test/user-lifecycle.test.mjs` pattern) with
  `PW_HOST_TERMINAL_USER` pointed at the test account, so the drop resolves to `already-owner`
  and the real code path is exercised unprivileged in CI.
- `git config --file=<empty file> --unset-all <key>` exits **5** ("does not exist") — must be
  tolerated, not treated as failure.

## 2. Acceptance criteria (checkable)

| # | Criterion | Check |
|---|---|---|
| A1 | Helper create/replace/remove + every `git config --local` runs as the validated workspace owner via `credentialDropArgv`/`spawnCredentialJob`/`credential-writer.mjs`; no shell strings | no `fs.writeFile`/`execFile('git'…)` on repo paths left in `server.js`; job asserts `getuid() === requireUid` |
| A2 | Refuses symlink/non-regular helper target, mismatched repo/workspace ownership, path substitution, out-of-boundary repo | focused tests per case |
| A3 | Directory-relative creation + atomic replacement, `0600`, owned by workspace owner; failure atomic (no partial helper, no half-updated git config) | temp+rename under a pinned dir fd/cwd; `config.lock` protocol; failure-injection test |
| A4 | Rotation/removal serialized against project/user lifecycle updates and against concurrent rotations/removals; state never points git at an absent/stale/substituted helper | single lock hierarchy LIFECYCLE > PROJECTS > GITCRED; desired state re-resolved inside the lock; ordering set=file-then-config, clear=config-then-file |
| A5 | No secret in logs, API responses, thrown messages, test names/output, audit records, PR body, fixtures | secret-non-reflection test + repo-wide scan |
| A6 | Bounded inventory/remediation for existing `.git/.pw-credentials`; validates workspace, repository identity, containing-dir ownership, file type, no link following; repairs only its own artifact/config; never recursive `chown`, never traverses arbitrary workspaces; dry-run reports metadata only | `scripts/pw-git-credential-audit.mjs` + tests |
| A7 | Correct `0600` owner-owned artifacts stay correct and idempotent; unsafe ones fail closed with actionable non-secret diagnostics; safe root-owned regular artifact remediates deterministically | idempotency test, fail-closed tests, real-root test on PVI2 (skip honestly elsewhere) |
| A8 | Deterministic regressions: create, rotate, remove, existing-artifact migration, root-owned regular artifact, helper symlink, parent/path swap or rename, non-regular target, ownership mismatch, concurrent rotate/remove, failure atomicity, mode/owner, git-config consistency, secret non-reflection | one test per row |
| A9 | `app/VERSION` bumped per convention | `node --test test/release-version.test.mjs` |
| A10 | Host + container compatible; no GOA/PVI hostname, path inventory, token or env-specific secret embedded | grep the diff |

## 3. Design

New `app/git-credentials.js` — all logic, dependency-injected so it is unit-testable and so the
same code runs in-process (tests) and inside the privilege-dropped helper (production).

- `planGitCredentialTarget({workspaceRoot, projectPath})` → validated `{rootAbs, components,
  gitDirAbs, credFileAbs}`; throws on relative paths, `..`, empty components, or a project outside
  the configured workspace root.
- `descendPinned()` — `chdir(rootAbs)` then, per component, `lstat` (refuse symlink/non-dir) →
  `chdir` → `stat('.')` and compare `dev`/`ino` against what was validated. A swap between the
  check and the use changes the inode and is caught. Because the process cwd ends up **pinned to
  the `.git` inode**, every later operation uses a bare relative name and cannot be redirected by
  renaming any parent. This is why the job always runs in a one-shot child process (chdir is
  process-global — the dashboard must never chdir).
- Artifact write: `O_CREAT|O_EXCL|O_NOFOLLOW` temp in the pinned dir → write → `fchmod 0600` →
  `fsync` → `rename` over `.pw-credentials` → `fsync` dir.
- Git config: take git's own `config.lock` (`O_CREAT|O_EXCL|O_NOFOLLOW`), seed it from the current
  `config`, edit **the lock file** with `git config --file=config.lock …`, then `rename` it over
  `config` — git's exact protocol, so the update is atomic and mutually exclusive with a concurrent
  `git config` run from a pane. Cleanup unlinks the lock on any failure.
- Ordering: **set** = artifact first, then config; **clear** = config first, then artifact.
- `requireUid` travels in the job; the helper refuses if the drop did not land on that uid.

`app/credential-writer.mjs` gains `action: 'git-credential'` and `action: 'git-credential-report'`.

`app/server.js`:
- `syncProjectCredentials(project)` — resolves the desired token **from disk, inside the git
  credential lock**, then dispatches the job through the drop abstraction. Does no filesystem or
  git work itself.
- New `PW_GIT_CRED_LOCK_PATH` (default beside the registry) — innermost lock.
- Delete / rename-reconcile / token-rotation sync moved inside their `withProjectsLock` section so
  every credential mutation is serialized against project updates.
- `cloneWorkspace()` temp credential file moved from `workspaceRoot` into a root-owned `mkdtemp`
  beside the registry.

`scripts/pw-git-credential-audit.mjs` — bounded inventory (default) / `--apply` remediation over
**registered projects only**, root-run, dispatching the same dropped job. Metadata only.

## 4. Ordered plan

1. RED/GREEN `planGitCredentialTarget` boundary + traversal refusals.
2. RED/GREEN pinned descent (symlinked component, parent swap/rename).
3. RED/GREEN artifact write: create, mode/owner, atomic replace, non-regular refusal.
4. RED/GREEN git config apply/clear: consistency, exit-5 tolerance, failure atomicity.
5. RED/GREEN job end-to-end through `credential-writer.mjs` (create / rotate / remove / idempotent).
6. RED/GREEN server wiring: no root write, serialization, secret non-reflection.
7. RED/GREEN inventory/remediation + CLI.
8. Real root/workspace-owner test (PVI2, skip honestly elsewhere).
9. `app/VERSION`, docs, secret scan, freeze SHA, canonical gate, PR, exact-head CI.

## 5. Log

- 2026-08-10 — assessed at `881f62c`; instruction updated to canonical `7783ee2`; worktree
  re-cut and parity verified (tree `9bc4f6e2…` identical to `origin/main`, clean, 0/0).
  Base delta was docs-only, so the assessment above stands.


## 6. Round 9 verdict — binding requirements for this lane

Authoritative source: `DEVELOPMENT-COORDINATION.md` @ `812c99b`, section
"Hermes-James — Round 9 — Candidate A PR #31 immutable exact-head verdict", plus the Round 8
Candidate A ownership-evidence rule.

| ID | Requirement | How this lane satisfies it |
|---|---|---|
| A31-1 | Fail-closed, CONFIRMED revocation. Only proven absence is idempotent success; permission/I/O/timeout/malformed-repo/unsupported-artifact errors stay failures. Distinguish proven absence from removal/config failure. | Revocation clears the helper first, unlinks, then RE-VERIFIES (artifact absent via descriptor-relative lstat, `--get-all credential.helper` empty) before reporting `revoked`. No `.catch(()=>{})` anywhere on the path. |
| A31-2 | Failure-atomic or safely recoverable file + helper transitions; real on-disk step-failure tests. | Content-blind hard-link snapshot of the prior artifact + captured config bytes; staged temp promoted by a single final `rename`; any failure restores the exact prior pair. Tests inject a failure at each step and assert the real file and real `git config` afterwards. |
| A31-3 | One serialization domain or a proven ordered composed-lock protocol across project AND lifecycle ops. No caller-supplied boolean. Overlapping barrier tests. | `app/credential-domain-lock.js`: one canonical total order LIFECYCLE > PROJECTS > CREDENTIAL, re-entrancy scoped by `AsyncLocalStorage`, and out-of-order acquisition throws (self-checking, not convention). Barrier tests use a real external process holding the lock. |
| A31-4 | Descriptor-pinned against parent `.git` substitution across file AND git-config ops; revalidate descriptor identity; verify final descriptor (regular, owner, `0600`); reject any `projectPath` that is not the exact registered workspace path under the boundary. | Validated chdir descent, then `O_DIRECTORY|O_NOFOLLOW` fd held for the whole operation; every op addresses `/proc/self/fd/<n>/<name>`; git runs with cwd re-anchored through that fd; `fstat` revalidated between phases; planner requires an exact registry match. |
| A31-5 | Bounded EXPLICIT, content-blind remediation; report `.git`-file/linked-worktree truthfully; refuse directories/non-regular; never recursive delete. | `scripts/pw-git-credential-audit.mjs`, registry-scoped, dry-run by default, metadata-only output; `ENOTDIR`/`.git`-file surfaces as a reported state, never suppressed; directories at the artifact path are refused, never removed. |
| A31-6 | Green exact-head CI + non-vacuous real root -> workspace-owner test (actual UID != expected UID). | Lifecycle fixtures converted to REAL git repositories (keeping the `pendingCredentialSync`/retry assertions); expected owner resolved from passwd independently of `process.getuid()`; PVI2 root test asserts uid 0 process producing owner-owned `0600`. Unavailable => reported NOT RUN. |

Non-negotiables carried forward: keep production fail-closed (no blanket catch-and-ignore restored);
credential path only — no tmux/env-schema/restore/installer/deploy/service/runtime changes; no secret
value in files, argv, logs, tests, commits, or summaries.


## 7. Round 9 implementation — what was built

New product code:

| File | Role |
|---|---|
| `app/git-credentials.js` | The whole boundary: target planning (registry-exact + containment), pinned no-follow descent, descriptor pinning via a **validated** `<procfs>/self/fd` adapter, the artifact primitives (staged write, single-rename publish, content-blind hard-link snapshot/restore, confirmed removal, descriptor verification), the `config.lock` git-config protocol, the all-or-nothing job, and the registry-scoped inventory/remediation. |
| `app/credential-domain-lock.js` | ONE serialization domain: canonical order `lifecycle > projects > credential`, `AsyncLocalStorage`-scoped re-entrancy, and a refusal (not a hang) on out-of-order acquisition. |
| `scripts/pw-git-credential-audit.mjs` | The bounded explicit operator action. Dry run by default, registry-scoped, runs as the workspace owner through the existing drop, takes the domain, metadata-only output. |

Changed: `app/credential-writer.mjs` (two new actions), `app/server.js`
(`syncProjectCredentials` now decides state and delegates; all six lifecycle-lock
acquisitions and the projects lock now go through the domain; the clone-time
credential file moved out of the pane-owned workspace root), `app/VERSION`.

### How each Round 9 item is discharged

- **A31-1** Revocation clears the helper first, unlinks, then RE-VERIFIES: artifact
  absent by descriptor **and** `--get-all credential.helper` empty. `revoked` is only
  ever reported after that. Absence with no repository at all is proven absence, and
  is the one idempotent success. Removal failure, helper-unset failure, and an
  unsupported artifact type each fail and restore the prior usable pair. No
  `.catch(()=>{})` remains on the path.
- **A31-2** Prior credential preserved by a hard link (no bytes read), prior config
  captured, new credential staged and published by ONE rename, and every injected
  step failure — stage, publish, first `--add`, second `--add`, final verification —
  restores the exact prior pair. Each case asserts the real file and real
  `git config` output afterwards.
- **A31-3** No boolean anywhere. One domain, one total order, re-entrancy scoped to
  the async chain so a concurrent request still blocks on flock. Exclusion is proved
  by real second processes holding the locks, including at the HTTP level.
- **A31-4** `chdir` descent with per-component inode confirmation, then an
  `O_DIRECTORY|O_NOFOLLOW` descriptor held for the whole operation; every file
  operation addresses `<procfs>/self/fd/<n>/<name>` and `git` inherits the pinned
  cwd. Proved positively: the parent is swapped after pinning and the write and the
  config both still land in the original inode. Final verification is by descriptor
  (regular, owner, `0600`). An unregistered or non-contained path is refused.
- **A31-5** Registry-scoped (never a walk), content-blind, dry-run by default;
  `linked-worktree`, `foreign-git`, `unsupported-artifact`, `unsupported-workspace`,
  `no-repository` reported truthfully; directories refused, never removed.
- **A31-6** Lifecycle fixtures converted to real repositories with the
  `pendingCredentialSync`/retry assertions intact; PVI2 root->owner evidence is
  non-vacuous (driver uid 0, resolved owner uid 1000, artifact uid 1000 `0600`), and
  reports **not run** where the privilege cannot be arranged.

### Universal-compatibility objective (canonical `d35e2ee`)

- The descriptor mechanism is an adapter: `PW_PROCFS_PATH` with a `/proc` default,
  and its usability is VERIFIED against the live descriptor before any write, with a
  diagnostic naming the setting. No silent degradation to pathname resolution.
- Every path, identity and lock location is configuration (`PW_WORKSPACES`,
  `PW_REGISTRY_PATH`, `PW_*_LOCK_PATH`, `PW_HOST_TERMINAL_USER`/`PW_TERMINAL_UID`);
  the container/host privilege drop reuses the existing adapter unchanged.
- `test/git-credential-portability.test.mjs` fails the build if a hostname, a
  deployment path, an IP, or a hard-coded account name is ever introduced into the
  boundary sources.


## 8. Blocker delta after the immutable review of `eea352b`

Two blocking findings, both real, both repaired test-first.

### A31-5 was not discharged (primary blocker)

The reviewer reproduced the shape base `app/server.js` actually leaves behind — a
**root-owned, mode 0600** `.git/.pw-credentials` inside an owner-controlled `.git`
with the `store --file=` helper active — and found the remediation reported success
without safely converting it, and was not content-blind.

Root cause, measured rather than reasoned about:

| operation on a root-owned 0600 file, as the workspace owner | result |
|---|---|
| `read(2)` | `EACCES` |
| `link(2)` | `EPERM` (`fs.protected_hardlinks=1`) |
| `unlink(2)` | ok (the owner owns the DIRECTORY) |
| `rename(2)` over it | ok (same reason) |

So the byte-copy repair was doubly wrong: impossible against the real shape, and a
read of a secret this process must never see. My own root test had used mode
**0644**, which is why it passed — it never reproduced the true shape. That is the
defect behind the defect, and it is why the new regression builds the exact base
shape and drives the **actual operator command**, not a helper seam.

The repair removes the byte-copy entirely:

- `snapshotArtifact` refuses to snapshot anything it does not own — `link(2)` would
  fail anyway, and a root-written credential must not be preserved or reused.
- An artifact owned by somebody else is reported `resync-required`; the helper
  never opens it.
- `scripts/pw-git-credential-audit.mjs --apply` resolves the AUTHORITATIVE current
  credential (decrypted from the users store, exactly as the dashboard does) and
  rewrites the pair through the already-proven credential job: a fresh owner-owned
  `0600` file renamed over the old inode, which goes away **unread**. With no
  current credential the pair is revoked instead — an explicit safe state that
  cannot use or expose the old value.
- If a conversion fails after publishing over a foreign artifact, the rollback
  reaches that same safe revoked state rather than leaving a stale credential.

Content-blindness is now an invariant with a test behind it: a deps wrapper makes
`readFile`/`read` on the artifact throw, and remediation must still succeed.

### The canonical gate was red on contract-pin drift (secondary blocker)

`get_approvals` and `publish` had **graduated** from PW-local Milestone 2 additions
into the orchestrator's own `ALLOWED_CLIENT_METHODS` (§9.2 "since delivered"). PW
already implements both tools — every client method had a matching `pw_` tool — so
only the test's hard-coded "beyond the contract" list was stale. Every substantive
cross-contract check (state vocabulary, enums, transitions, error table) already
passed at the moved revision.

Conforming removes those two from the local list, which **tightens** the check:
they are now required by the contract's own authority instead of declared by ours,
and the undeclared-capability assertion is untouched. The pin then moved
`aff7a60` -> `5324e7c`. Nothing was skipped, relaxed, or made conditional.


## 9. Blocker delta after the second immutable review of `5e69ea7`

### P1 — I caused an availability regression, and the fix is SCOPE, not order

Widening `withProjectsLock()` to `['lifecycle','projects']` was wrong. Project
creation legitimately holds that section across `cloneWorkspace()` — a network
`git clone` with a 300s timeout — so every login and user-management route, which
waits on the lifecycle lock with a 15s timeout, queued behind a slow network and
then failed. Base `main` never had this: its projects lock and lifecycle lock were
different locks, and login only ever touched the latter.

The repair restores the base availability profile while keeping the domain:

- `withProjectsLock()` is `['projects']` again — exactly what it was on base. That
  section may span long external work precisely because nothing latency-sensitive
  waits on it.
- The credential publish moved OUT of that long section in `/manage/add` and
  `/manage/update`. It runs afterwards as its own SHORT ordered transition, and
  `syncProjectCredentials()` still takes the full chain
  `lifecycle > projects > credential` from a clean state.

Serialization is unchanged by this: credential work still excludes project
mutations (it takes `projects`) and user-lifecycle mutations (it takes
`lifecycle`). What changed is only WHEN the chain is held — around the short state
transition rather than around a clone. The ordering guard in
`app/credential-domain-lock.js` makes the old mistake unrepeatable: acquiring
`lifecycle` while holding `projects` now throws instead of deadlocking.

Regression: `test/git-credential-availability.test.mjs` stalls a real `git clone`
via a PATH shim inside a real `/manage/add` request and asserts that
`/api/auth/check`, `GET /api/users`, `POST /api/auth/login` and
`PATCH /api/users/:username` all stay successful and bounded (<5s) while it hangs.
It fails against the previous head.

### P2 — the audit CLI could refuse to act and still look successful, or worse

The reported shape was a `resync-required` row printed while stderr said it had
refused. Investigating found something worse: neither loader announces its own
absence — `loadUsersFile()` returns `[]` for a missing store, and
`makeSecretCrypto()` does not touch the key until something is decrypted. So the
guard never fired, the token resolved to `''`, and the command would have
**revoked a perfectly good credential** on the strength of missing information.

Now the authoritative state is PROVEN readable first (`fs.access` on the store, and
the key is forced to load), and revocation is a POSITIVE decision only — this
project has no owner, or its owner holds no token. Anything unresolved (no registry
entry, unresolvable `primaryUser`, undecryptable token) is reported `blocked` and
exits nonzero. No actionable row survives a refusal.


## 10. Blocker delta after the third immutable review of `3c0749d`

### The residual P1, and why my own barrier missed it

`/manage/add` still held `.pw-projects.lock` across `cloneWorkspace()`. A token
rotation takes `lifecycle` and then blocks on `projects` while syncing the owner's
projects, so it waited ~15s and returned 500 — while `users.json` already carried
the new token and the repository still had the old helper/credential.

My shipped barrier could not catch it: it patched `{role:'admin'}` against an
EMPTY registry, so `syncProjectCredentials()` never ran and nothing contended for
the projects lock. That is the third time a probe of mine passed because it could
not fail; the lesson is now encoded as a rule I apply to every barrier here —
**a barrier must be shown to fail against the defective build before it is
trusted.** This one is: mutating `withWorkspaceLock` back to `['projects']`
reproduces the exact 500, and reverting it restores green.

### The repair

A fourth lock, `workspace`, ranked between `lifecycle` and `projects`:

    lifecycle  >  workspace  >  projects  >  credential

- `withWorkspaceLock()` covers the long, external, latency-unbounded work —
  clone, chown, `rm -rf`, routing, systemd — and serializes project mutations
  against each other exactly as the projects lock used to.
- **No latency-sensitive request ever awaits it.** Rotation, revocation, user
  delete and login take `lifecycle`/`projects`/`credential` and never `workspace`.
  There is a direct test: a real second process holds `workspace` while a
  credential transition must still complete in under 2s.
- `withProjectsLock()` is now only ever a SHORT registry transaction. `/manage/add`
  clones with no registry lock held, then publishes in a short re-validated
  section; `/manage/update` and `/manage/delete` do their stop/rename/`rm -rf`
  outside it and take it only to save.
- Failure atomicity: the record is published only after the external work
  succeeds, so a failed clone leaves no partial project — asserted directly.
- The 15s lock timeout is unchanged.

### The barrier is now non-vacuous by construction

A pre-registered alice-owned project with a real repository, a gate-stalled clone
of a second project, and then — all while it hangs — login, a role-only PATCH, a
real `ghToken` rotation, a real revocation, and a user delete. Each must be
bounded (<5s) and successful, the rotation's credential must actually be on disk
at `0600`, the revocation must actually remove artifact and helper, and the
registry must never contain the project whose clone failed. The clone shim
announces its own stall with a marker file, so the test cannot pass without one.
