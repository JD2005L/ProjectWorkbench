# Canonical main release blockers: pane autoupdater env + a release gate that could not fail

**Branch:** `fix/release-portability` · **Base:** `main` @ `d1118494e3087488662f1ff9b1303ddf47055439`
**Worktree:** `.worktrees/fix-release-portability` (isolated; the dirty `candidate-a` worktree and the
live runtime were not touched) · **Repo:** `JD2005L/ProjectWorkbench`
**Authorized by:** James — implementation, PR/merge and PVI deployment; review/merge/deploy performed
independently by Hermes-James, not by this loop.

`PVI-DEV-v1 | Tier: 3 (deployment controls, release gating) mixed with Tier 2 (pane env) | Operator: James-direct | Gate budget: focused tests during RED/GREEN, one canonical app suite at frozen head, no nested reviewers`

## End state

Two blockers on canonical `main`, both of the same shape — a control that looks like it is applied
everywhere but is applied in exactly one place:

1. **`DISABLE_AUTOUPDATER=1` reached one pane out of five.** A tmux pane's environment is fixed at
   creation, from the `env KEY=VAL … bash` command the creating seam hands tmux. Only
   `ensureTmuxSession` (container-mode first window) spelled the token out. Every window opened
   afterwards, every host-mode systemd terminal, the PVIKPBot session and every session recreated
   after a reboot came up without it — so Claude Code kept nagging and could still self-update
   underneath a running agent. `deploy/patch-autoupdater.sh` patched the one live literal it knew
   about, which is why this kept looking fixed on the instance and broken in the terminal.
2. **The release-version guard could not fail on the event that ships a release.** It asked "what
   does this branch change relative to its base?" and resolved the base as `origin/main`. On a push
   to `main` that is HEAD, the merge base is HEAD, and the guard returned early with "nothing
   proposed". Deployable content landed on main with `app/VERSION` untouched and CI went green.

## Assessment findings

| Finding | Consequence |
|---|---|
| `app/server.js` built three separate canonical token lists; only `ensureTmuxSession`'s carried the token | `ensureProjectTmuxSession` (PVIKPBot) and `newTmuxWindow` (every window an operator opens) created nagging panes |
| `scripts/project-terminal-start` `base_tab_env` is assembled independently of the dashboard's list | **Every** host-mode PVI project terminal (started by `project-terminal@.service`) nagged, in both the shared-login and per-user-credential variants |
| `scripts/pw-tmux-restore` assembles a third independent copy (`ENVBASH` + two `cred_env_prefix` strings) | Every reboot restored every project session without the token — so any fix limited to the four named seams would have been undone by the next restart. In scope by AC2's own wording ("every new project pane/session"); recorded here because it is beyond the four seams the brief enumerates |
| `test/release-version.test.mjs` resolved its comparison range from branch topology only | On `push` to `main`: `merge-base(HEAD, origin/main) === HEAD` → early return → **vacuous pass** |
| The guard's range decision was inline in the test and only ever ran against the real checkout | The one case that mattered could not be exercised by any test, which is why it survived review |
| The test suite's tmux harnesses stand their private server up from the runner's own environment | A pane inherits the tmux **server**'s environment: run from a PW terminal (which exports `DISABLE_AUTOUPDATER=1`), the first version of the new regression passed on a completely unpatched tree. Fixed before it could be trusted — see `test/pane-env-fixture.mjs` |

## Deliberate exclusions

- **`scripts/setup-terminal-start`** (the `_setup` auth terminal) — not a project pane; per the brief,
  no token added to unrelated setup/auth terminals.
- **`app/orchestrator/session.js`** lane panes — build no canonical env baseline at all and pass *no*
  command when there is nothing per-user to apply ("byte-identical to before this existed", asserted
  by `test/orch-session-credentials.test.mjs`). Adding a token there would change that contract, so
  it is left for a separate decision rather than folded in here.
- **`deploy/patch-autoupdater.sh`** — an instance-specific adapter, left as-is. It now no-ops
  ("already patched") against the shipped source, which is correct and idempotent.

## Verification commands

```
cd app && node --test ../test/autoupdater-env.test.mjs ../test/project-terminal-start.test.mjs \
                      ../test/pw-tmux-restore.test.mjs ../test/release-version.test.mjs   # focused
node --check app/server.js && bash -n scripts/project-terminal-start && bash -n scripts/pw-tmux-restore
cd app && npm test          # canonical suite, once, at frozen head
git diff --check
```

## Acceptance criteria

Status legend: `PASS` (verified by a run recorded below) · `FAIL` · `—` (not attempted)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `app/VERSION` advances from `1.26.0811.1605` by the `1.YY.MMDD.hhmm` convention, because `app/server.js` is deployable | PASS | `1.26.0811.1605` → `1.26.0820.1620` (UTC `date`, matching the repo convention); `app/version.js` accepts it; the repaired guard verifies it forwards against the merge base |
| 2 | `DISABLE_AUTOUPDATER=1` reaches every new project pane/session in both deploy modes — `project-terminal-start` `base_tab_env`, `ensureTmuxSession`, `ensureProjectTmuxSession`, `newTmuxWindow` — preserving credential isolation and env/drop semantics | PASS | 5 seams carry it (3 in `app/server.js`, `base_tab_env`, and `pw-tmux-restore`'s 3 strings); per-user `CLAUDE_CONFIG_DIR`/`--rcfile` handling unchanged; `wrapAgentEnv` carries it through the setpriv drop exactly once (asserted) |
| 3 | Focused real-process/argv or source-contract regressions that fail before the fix and prove the variable reaches each path after it | PASS | 4 real-process `/proc/<pane_pid>/environ` regressions + 4 source-contract tests; RED/GREEN logged below; harness proven non-vacuous by `assertNoAmbientPaneEnv` |
| 4 | Release-version CI logic cannot compare main to itself and pass vacuously; event-aware before/after; PR behaviour, local fallback, `--no-renames`, shallow handling, explicit non-vacuous tests all preserved | PASS | `test/release-guard-lib.mjs` reads `GITHUB_EVENT_PATH`; superseded vs repaired guard run against the *same* defect repository, opposite results (below); 15 preserved-behaviour/non-vacuity tests. **Round 2 replaced the `HEAD^` fallback with fail-closed — see below** |
| 5 | GOA container mode and PVI host mode both stay supported; no forked product logic, no hardcoded PVI assumptions | PASS | Both dashboard modes and both shell entrypoints changed in the same shape; no mode conditionals added; default branch read from the CI event payload rather than hardcoded; deploy adapters untouched |
| 6 | Only scoped tests/docs updated; this loop record created | PASS | changed files list below; `.github/workflows/test.yml` comment only (no behaviour change) |
| 7 | Focused tests during RED/GREEN, canonical app suite once at frozen head; `node --check` and `git diff --check` clean | PASS | logs below |
| 8 | Conventional commit, new branch pushed, PR opened against main; no merge, no deploy | PASS | see "Release" below |

## RED → GREEN log

### Pane environment (AC2/AC3)

RED, before any source change — `node --test` on the three focused files:

```
not ok 1 - every dashboard pane-creation seam spells out the autoupdater token
not ok 2 - NO DRIFT: no agentEnvTokens() pane environment anywhere omits the token
not ok 3 - the shell pane-creation seams spell out the autoupdater token in every env prefix
not ok 5 - REAL PROCESS: a project session AND every window opened in it carry DISABLE_AUTOUPDATER=1
             a window opened in an existing session must carry the autoupdater token too
             expected: '1'
not ok 5 - REGRESSION: the host-mode terminal pane carries DISABLE_AUTOUPDATER=1
not ok 6 - REGRESSION: an owned project's host-mode pane carries DISABLE_AUTOUPDATER=1 alongside its credentials
not ok 64 - REGRESSION: a restored shared-login pane carries DISABLE_AUTOUPDATER=1
not ok 65 - REGRESSION: a restored OWNED pane carries DISABLE_AUTOUPDATER=1 alongside its credentials
```

**A false green caught on the way in.** The first version of the real-process test passed on the
unpatched tree, because the harness's private tmux server inherited `DISABLE_AUTOUPDATER=1` from the
ProjectWorkbench terminal running the suite, and panes inherit the server's environment (verified
against tmux 3.4: the client's environment does not reach a new session's panes). `test/pane-env-fixture.mjs`
now starts the private server from a scrubbed environment *and* asserts a baseline pane comes back
without the names under test — so the assertion can fail, which is the only reason it is worth making.

GREEN, after the fix: `71 pass, 0 fail, 0 skipped` across
`autoupdater-env.test.mjs` + `project-terminal-start.test.mjs` + `pw-tmux-restore.test.mjs`
(62 of those pre-existing tests in the two shell suites still pass with the scrubbed harness).

### Release guard (AC4)

A throwaway repository built with exactly the defect: `app/server.js` shipped to `main` in a second
commit, `app/VERSION` left at `1.26.0101.0000`, driven with a real `push`-to-`main` event payload.

Superseded guard (`git show d111849:test/release-version.test.mjs`), same repo, same event:

```
ok 4 - release: a change to deployable release content carries a release bump with it
# tests 4 # pass 4 # fail 0          <- the vacuous pass, on shipped content with no bump
```

Repaired guard (`test/release-version.test.mjs` + `test/release-guard-lib.mjs`), same repo, same event:

```
not ok 14 - release: a change to deployable release content carries a release bump with it
    these files ship but app/VERSION is still 1.26.0101.0000:
      app/server.js
# tests 14 # pass 13 # fail 1
```

What the repair does: on `push` to the repository's default branch (read from the event payload, not
hardcoded) the range is the event's own `before` → `HEAD`. An unusable `before` — the all-zero
new-branch sentinel, a force-pushed-away commit, a shallow checkout, an absent payload — **fails the
run** (round 2, below). Pull requests, pushes to any other branch and local runs keep the
merge-base-with-base-branch resolution unchanged.

## Changed files

| File | Change |
|---|---|
| `app/VERSION` | `1.26.0811.1605` → `1.26.0820.1620` |
| `app/server.js` | `DISABLE_AUTOUPDATER=1` added to `ensureProjectTmuxSession` and `newTmuxWindow` pane environments (+ one comment naming every seam that must carry it) |
| `scripts/project-terminal-start` | `base_tab_env` carries the token (host-mode systemd terminal) |
| `scripts/pw-tmux-restore` | `ENVBASH` and both per-user `cred_env_prefix` strings carry the token (post-reboot restore) |
| `test/autoupdater-env.test.mjs` | **new** — real-process dashboard regressions + source contract across all five seams |
| `test/pane-env-fixture.mjs` | **new** — scrubbed private tmux server + baseline assertion, so pane-env claims can fail |
| `test/release-guard-lib.mjs` | **new** — event-aware comparison range and verdict, testable against a fixture repo; round 2 made an unresolvable release range fail closed; round 3 made push ranges two-dot |
| `test/release-version.test.mjs` | rewritten onto the lib; adds the non-vacuity regression, the round 2 multi-commit fail-closed regression, the round 3 divergent-force-push regression, and the preserved-behaviour set |
| `test/project-terminal-start.test.mjs` | + 2 real-process pane-env regressions; harness server scrubbed |
| `test/pw-tmux-restore.test.mjs` | + 2 real-process pane-env regressions; harness server scrubbed |
| `.github/workflows/test.yml` | comment only: why full history is needed for the push event too, and (round 2) why that depth is load-bearing rather than defensive |
| `.goal-loops/fix-release-portability.md` | this record |

### The same defect, on this repository's own history

Not hypothetical. The push whose head was `d111849` (CI run 2026-08-20T15:07:50Z, **success**) carried
`8a97238 fix(ui): lift drawer contrast…`, which changes `app/server.js`, and `app/VERSION` was
untouched across the whole push. Replaying that exact range through the repaired guard:

```
range chosen: push-to-release-branch e99a81b -> HEAD   (HEAD of that run: d111849)
verdict: violation
these files ship but app/VERSION is still 1.26.0811.1605:
  app/server.js
```

So canonical `main` is currently shipping an `app/server.js` newer than the identifier it reports —
`1.26.0811.1605` dates from 2026-08-11, the change from 2026-08-19. The bump in this branch corrects
that drift as well as covering its own change.

## Round 2 follow-up: the narrower fallback was itself a release-control blocker

**Reported by James, and correct.** Round 1 answered an unresolvable `before` by narrowing the range
to `HEAD^`. A push carries as many commits as the pusher had locally, so that inspects only the LAST
of them:

```
A  base
B  ships app/server.js, no version bump
C  docs only            <- main
```

`HEAD^..HEAD` is `B..C` — docs only — so the guard reports success while B ships to every instance
under a stale release identifier. A narrower range is worse than no range, because it looks like a
check. A skip is no better: a skipped test is a green run, and this is the event that ships.

**RED**, on a fixture built to exactly that shape (`multiCommitPushFixture`), before any change:

```
not ok 7 - REGRESSION: a multi-commit release push with an unresolvable range FAILS CLOSED …
    before="0000…0000" must not resolve to a range:
      {"kind":"push-to-release-branch-parent","from":"HEAD^","to":"HEAD",
       "note":"no usable push 'before' SHA (0000…0000); compared against HEAD's first parent instead"}
not ok 9 - a release push with no parent at all fails closed too — a root commit is not an excuse to skip
```

The fixture proves the hole rather than asserting it: it first checks that
`changedFiles(HEAD^, HEAD).filter(isDeployable)` really is empty while `changedFiles(A, C)` really is
`['app/server.js']`. That is the whole defect, in two assertions.

**Repair.** `pushRange({ release: true })` no longer has a fallback. An unavailable `before` returns
`{ unresolved: true, reason }`, and `evaluateRelease` turns that into
`{ status: 'violation', code: 'unresolvable-release-range' }` **before** any skip is considered, so it
fails the CI test with an actionable message (give the run the pushed range — `fetch-depth: 0` plus an
event payload carrying before/after; if the branch really was just created, audit its release content
deliberately). Only the release branch fails closed this way:

| Case | Behaviour | Changed in round 2? |
|---|---|---|
| Release push, `before` resolvable | gated `before` → HEAD | no |
| Release push, `before` unavailable | **fails the run** (was: narrowed to `HEAD^`) | **yes** |
| Release push, root commit | **fails the run** (was: skipped out loud) | **yes** |
| Pull request | merge base with base branch | no |
| Push to a non-default branch | branch vs base; the event range if the base is absent | no |
| Local run (no CI event) | base branch; nothing proposed on the base branch itself | no |

**GREEN:** `node --test ../test/release-version.test.mjs` → **17 tests, 17 pass, 0 fail, 0 skipped**.

`app/VERSION` is deliberately NOT bumped again: round 2 touches `test/`, `.github/` and this record
only, none of which is deployable content — the guard's own classifier says so — and the branch's
existing bump still covers the `app/server.js` change it carries.

## Round 3 follow-up: the push range was three-dot, which forgives a rollback

**Found by independent immutable review of `9a92454`, and correct.** `resolveComparison` picked the
right endpoints for a release push, but `changedFiles` always diffed `before...HEAD`. Three dots means
"merge-base(before, HEAD) → HEAD" — what has been ADDED since the two tips last agreed. For a push
that is the wrong question: `before` and `after` are the branch's OLD and NEW tips, and a force-push
REPLACES the tree rather than adding to it.

```
A  server.js=v1, VERSION 1.26.0101.0000
B  old release tip, from A — server.js=v2, VERSION 1.26.0102.0000
C  force-pushed replacement, from A — docs only          <- main, event before=B
```

`B...C` is measured from A, so it reports only what C added since A: docs, and a VERSION that moved
*forward*. The rollback of `app/server.js` from v2 back to v1 — a real change to what every instance
runs — is not in the diff at all, and the guard returned `no-deployable-change`.

**RED**, on that exact shape, before any change:

```
not ok 12 - REGRESSION: a divergent force-push is measured old tree -> new tree, not from the merge base
    sanity: old tree -> new tree DOES contain the rollback
not ok 13 - a force-push that rolls the release identifier BACKWARDS is a violation
not ok 19 - PRESERVED: proposal comparisons stay three-dot, so a branch is never blamed for what landed on its base
```

The first sanity assertion in that test — `changedFiles(B, C, 'three-dot').filter(isDeployable)` is
`[]` — PASSED while RED. That is the defect, measured rather than described.

**Repair.** `changedFiles` takes an explicit `diffMode` (`'two-dot' | 'three-dot'`, unknown values
throw), and every comparison carries the one it means:

| Comparison | Range | Why |
|---|---|---|
| Release push, and the non-default-branch push fallback | **two-dot** `before..HEAD` | the endpoints are the old and new tips; a replaced tree must be diffed against the tree it replaced |
| Pull request, branch, local run | **three-dot** `mergeBase...HEAD` | a proposal, which must not be blamed for what landed on its base without it |

A fast-forward push is unaffected — when `before` is an ancestor, the two forms are identical, and a
test asserts exactly that so the change cannot quietly alter the ordinary case. Backwards/rollback
identifiers on a force-push are now violations by both signals independently: the rolled-back
`app/server.js` appears in the deployable list (proved with the replacement carrying B's identifier
unchanged), and the identifier moving `1.26.0102.0000` → `1.26.0101.0000` fails the forwards check.

Proposal semantics are proved rather than assumed: a docs-only branch cut before somebody else's
`app/server.js` landed on main is shown to be blamed for that file under an old-tree/new-tree diff
against main's tip, and not blamed under the three-dot comparison the guard actually uses — across the
pull-request, branch-push and local forms.

**GREEN:** `node --test ../test/release-version.test.mjs` → **21 tests, 21 pass, 0 fail, 0 skipped**.

No `app/VERSION` bump: like round 2, this round touches `test/`, `.github/` and this record only.

## Final verification

Recorded after the last code change of each round; this file is the only edit made after each
canonical run, and it never ships and is never executed.

Both rounds:

- `node --check` on every file under `app/` (including `app/server.js`) — clean
- `bash -n scripts/project-terminal-start`, `bash -n scripts/pw-tmux-restore` — clean
- `git diff --check` — clean

| Round | Frozen head | Canonical `cd app && npm test` | GOA leg (`PW_DEPLOY_MODE=container`) |
|---|---|---|---|
| 1 | `9f815a3` | 1097 tests, 1094 pass, 0 fail, 3 skipped (118s) | 96/96 over the touched suites + `tmux-seam-gate` |
| 2 | the follow-up commit on this branch | 1098 tests, 1095 pass, 0 fail, 3 skipped (160s) | 17/17 on `release-version.test.mjs`, both `PW_DEPLOY_MODE` legs |
| 3 | the second follow-up commit on this branch | 1102 tests, 1099 pass, 0 fail, 3 skipped (264s) | 21/21 on `release-version.test.mjs`, both `PW_DEPLOY_MODE` legs |

The 3 local skips are pre-existing and environmental — `orch-privilege-real` assertions that cannot
fail when the suite already runs as the account it drops to (they ask for root, or
`PW_TEST_DROP_USER`). On a GitHub runner the count is 20: the same 3, plus 17 that need the
orchestrator repository and its venv, which no runner has.

Round 1 CI on `9f815a3`: `node-test (host)` and `node-test (container)` **pass** on both the push and
pull_request runs; 1097 tests, 1077 pass, 0 fail, 20 skipped per leg. Log-verified that the new gates
RAN rather than skipped.

## Release

Committed and pushed to `fix/release-portability`; PR #50 against `main`, with the round 2 follow-up
pushed to the same branch. **Not merged, not deployed** — Hermes-James reviews and performs both.
