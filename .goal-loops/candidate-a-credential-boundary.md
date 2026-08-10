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
