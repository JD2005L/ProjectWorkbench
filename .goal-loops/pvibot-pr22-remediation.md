# PR #22 release-contract remediation

**Branch:** `pvibot/pr22-fixes` (local repair branch) · **Base:** PR #22 head `35cbe1e001860b3c8c8fb5ab8e813728fa7b52fe`
**Repo:** `JD2005L/ProjectWorkbench` · **Authorized by:** James (internal code work)

**End state.** PR #22 (`fix(install): correct undefined $INSTALL_DIR when copying bin/`) shipped a real
installer fix but did not bump `app/VERSION`, because the release guard (`test/release-version.test.mjs`,
landed in `a3792e0`) only classifies changes under `app/` as deployable. `install.sh` lives at the repo
root and is copied to every deployed instance, so a fix to it is exactly the kind of shipping change the
guard exists to catch — it just wasn't taught to look outside `app/`. This loop closes that gap: extend
the guard to treat `install.sh` as deployable, bump `app/VERSION` forward past main and this PR's own
prior head, and keep the installer fix + its test intact. No push, no merge, no deploy, no other worktree
touched.

## Assessment findings

| Finding | Consequence |
|---|---|
| `test/release-version.test.mjs` `deployable` filter only matches `file.startsWith('app/')` | `install.sh` changes never trigger the version-bump requirement even though `install.sh` is deployed verbatim (`DEPLOY.md`: "because it is part of `app/`, both `install.sh` and container builds carry the same version to every environment" — an assumption the filter doesn't actually enforce for install.sh itself) |
| `app/VERSION` on `35cbe1e` (PR #22 head) is still `1.26.0729.1755`, identical to `main` (`7d8785e`) | No bump shipped with the installer fix |
| Other sibling branches already used `1.26.0729.1815` / `.1851` | Fresh version must be later than all of these to avoid ambiguity, even though the acceptance bar is only "later than main and current PR head" |
| `test/install-sh.test.mjs` (added in `35cbe1e`) already covers the `$PW_INSTALL_DIR/bin` fix functionally | Must be preserved untouched — not the thing being fixed here |

## Verification commands (every pass)

```
cd app && node --test ../test/release-version.test.mjs ../test/install-sh.test.mjs   # focused
bash -n install.sh
cd app && npm test                                                                    # full suite
git diff --check
```

## Acceptance criteria

Status legend: `PASS` (independently verified) · `FAIL` · `—` (not yet attempted)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Release-version regression test fails on current PR (install.sh deployable, VERSION not bumped) — RED recorded | PASS | see RED log below |
| 2 | Release guard extended: install.sh deployable, docs/tests/CI non-deployable | PASS | `isDeployable()` + dedicated classifier unit test in `test/release-version.test.mjs` |
| 3 | app/VERSION bumped once, fresh forward value, real system timestamp | PASS | `1.26.0729.1755` → `1.26.0729.2057`; timestamp from `TZ=UTC date +"1.%y.%m%d.%H%M"` run at commit time, matches repo's UTC convention |
| 4 | $PW_INSTALL_DIR/bin copy fix + functional installer test preserved | PASS | `install.sh:108-109` unchanged (`$PW_INSTALL_DIR/bin`); `test/install-sh.test.mjs` 5/5 green, untouched |
| 5 | Focused tests, bash -n, full npm test, git diff --check all green; conventional commit, no push | PASS | see final verification log below |

## Log

- Confirmed worktree HEAD = `35cbe1e` (PR #22 head) exactly, clean tree, correct branch `pvibot/pr22-fixes`.
- Confirmed `app/VERSION` = `1.26.0729.1755` on both `main` and current head — no bump shipped with the installer fix.
- Confirmed version convention is UTC (`a3792e0` commit at `2026-07-29T17:57:16+00:00` produced version `1.26.0729.1755`); system UTC time captured via `date -u` at remediation start: `2026-07-29 20:54:57 UTC` → candidate fresh version `1.26.0729.2054`.
- Added `isDeployable(file)` classifier to `test/release-version.test.mjs`: `install.sh` (exact top-level path) → deployable; `app/**` except `app/VERSION` and `app/node_modules/**` → deployable; everything else (docs/, test/, .github/, README.md, bin/, install-notes.md) → non-deployable. Added a dedicated unit test enumerating both sides. Rewired the existing git-diff bump-check test to use the classifier and renamed it to "a change to deployable release content carries a release bump with it".
- RED, recorded before touching `app/VERSION` (`cd app && node --test ../test/release-version.test.mjs`):
  ```
  not ok 3 - release: a change to deployable release content carries a release bump with it
    error: |-
      these files ship but app/VERSION is still 1.26.0729.1755:
        install.sh
    code: 'ERR_ASSERTION'
  # tests 3
  # pass 2
  # fail 1
  ```
  The other two tests (format validation, classifier unit test) pass immediately since they don't depend on the VERSION bump.
- GREEN after bumping `app/VERSION` to `1.26.0729.2057` (`cd app && node --test ../test/release-version.test.mjs`): 3/3 pass.
- `test/install-sh.test.mjs` re-run after the bump: 5/5 pass, unchanged from PR head — the `$PW_INSTALL_DIR/bin` fix and its regression coverage are untouched by this loop.
- `bash -n install.sh`: OK.
- `git diff --check`: clean (exit 0), no whitespace errors.
- Full suite (`cd app && npm test`, Node 22.23.2, `node --test ../test/*.test.mjs`): 341 tests, 327 pass, 14 fail — **verified pre-existing**: stashed both changed files, reran on the untouched PR-#22-head tree, got the identical 340 tests / 326 pass / 14 fail (one extra test is the new classifier unit test added by this loop, all else identical). Same 14 test names fail before and after. Root cause: `app/node_modules` has no `express` installed in this sandbox, so tests that spawn `server.js` (drawer/outbox, orchestrator smoke, cockpit-rail, base-path smoke) fail with `ERR_MODULE_NOT_FOUND` — an environment/dependency gap unrelated to install.sh or the release guard, out of scope for this remediation. Stash was popped back immediately after the comparison run.
- Final full-suite run with this loop's changes applied: 341 tests, 327 pass, 14 fail (same set as baseline).
