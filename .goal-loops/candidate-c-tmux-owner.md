# Candidate C — dedicated host tmux owner unit (replacement for PR #24)

`PVI-DEV-v1 | Tier: 3 | Operator: Hermes-supervised | Gate budget: focused + mutation/revert proof
per safety criterion; one canonical gate at frozen head; immutable review — not self-declared.`

- Base (canonical main, exact): `fb42c320ae7b1cea658dc43826b0c7d9947f8d7e` (PR #37 merge; A and B in)
- Branch: `fix/tmux-owner-candidate-c`, worktree `.worktrees/candidate-c-tmux-owner`
- PR #24 head `43625e4` is **reference-only**: never merged, amended, or cherry-picked.
- Candidate C is **greenfield** on this base — `grep` confirms no `pw-tmux-server`, `MemoryHigh` or
  `PW_TMUX_HOST_MODE` anywhere in `install.sh`, `systemd/` or `scripts/`.

## Verification commands (real, from this repo)

- canonical gate: `cd app && npm ci && npm test`
- focused: `node --test ../test/<file>.test.mjs`
- syntax: `node --check <file>`, `bash -n <script>`
- release guard: `node --test ../test/release-version.test.mjs`
- no linter exists in this repo; `node --check` / `bash -n` is the syntax gate.

## Server-creation seams (surveyed, complete)

| Seam | Location |
|---|---|
| project terminal entrypoint | `scripts/project-terminal-start:229,265` |
| setup terminal entrypoint | `scripts/setup-terminal-start:15,31` |
| dashboard create / new-window / recycle | `app/server.js:1115,1147` via the single `tmux()` helper |
| restore | `scripts/pw-tmux-restore:166` |
| orchestrator adapter | `app/orchestrator/session.js:168` |
| the owner itself | `scripts/pw-tmux-keepalive.sh:29,32` (creates by design; must PROVE, not gate) |

## Acceptance criteria

| # | Criterion | How it is checked |
|---|---|---|
| C1 | Host owner unit with `Type=notify`/`NotifyAccess=all`; readiness signalled only after the live server exists AND its owner marker AND its actual cgroup ownership are proven | unit file assertions + keepalive readiness tests |
| C2 | A foreign/pre-existing server makes owner start FAIL, with the save/kill/restart migration documented | focused test; refusal is nonzero, not a warning |
| C3 | Cold-start race test is NON-VACUOUS: client driven from inside the readiness notification with the marker cleared, and it FAILS against unrepaired `Type=simple` behaviour | mutation proof — revert readiness to pre-creation and show the test fails |
| C4 | Every seam fails closed on a missing ownership helper (refusal, never skip) and on a foreign server; no dashboard bypass | per-seam tests + source guard test |
| C5 | `install.sh` stays host-only: fatal on `PW_DEPLOY_MODE=container` or a detected sidecar owner; owner enable/readiness failure fatal; no container topology invented | focused install.sh tests |
| C6 | GOA-2 disposition preserved: container supervision retained, replay deferred; no opt-in restore-on-start added | source assertion + diff review |
| C7 | GOA-5 withdrawal preserved: documented host default retained; no new ambiguity refusal | source assertion |
| C8 | `MemoryHigh` from 64-bit shell arithmetic, no `awk`/`printf` clamp; test invokes `mawk` explicitly | focused test with real `mawk` |
| C9 | CI triggers for every PR/head; required-check enforcement NOT overclaimed | workflow assertion + honest wording |
| C10 | tmux tests hermetic against `TMUX`, `TMUX_PANE`, `TMUX_TMPDIR`, `PW_TMUX_*`, `PW_DEPLOY_MODE`, `PW_ENV_FILE`, `NOTIFY_SOCKET`; short/private socket root; dependency-free/offline | harness test that pollutes the environment and still passes |
| C11 | No environment-specific path/identity/hostname in product code; one SHA serves PVI/PVE and GOA | portability guard test (pattern already established by Candidate A) |
| C12 | Canonical gate green, `app/VERSION` bumped, secret scan clean, exact-head CI green, ledger evidence appended | gate output + CI run |

## Ordered increment plan

1. `app/tmux-owner.js` — shared, injectable ownership logic (server PID -> cgroup, owner marker),
   unit-tested against a **faked `/proc`**, per the Round 8 note that a same-cgroup comparison is not
   proof. [C4, C11]
2. `scripts/pw-tmux-assert-owner` — thin CLI over that module, so shell and JS seams cannot drift. [C4]
3. Shell seams fail closed: `project-terminal-start`, `setup-terminal-start`, `pw-tmux-restore`. [C4]
4. JS seams fail closed: `app/server.js` `tmux()` (covers create/new-window/recycle) and
   `app/orchestrator/session.js`. [C4]
5. Keepalive: stamp the owner marker, prove ownership, refuse a foreign server, and notify readiness
   host-only / tolerated-absent in container. [C1, C2, C6]
6. `systemd/pw-tmux-server.service` — `Type=notify`, `NotifyAccess=all`. [C1]
7. Cold-start race test + its mutation proof. [C3]
8. `install.sh` — host-only guard, sidecar detection, fatal enable, 64-bit `MemoryHigh` + `mawk` test. [C5, C8]
9. CI trigger for every PR/head. [C9]
10. Hermeticity sweep of the tmux harnesses. [C10]
11. Freeze: VERSION, secret scan, canonical gate, ledger + GOA same-SHA requests, PR, exact-head CI. [C12]

## Assumptions recorded

- The ownership marker is a **tmux server option** (`@pw_owner`), readable via `show-options -sv`,
  because it lives with the server rather than with any client's environment — which is what makes
  the marker-cleared race client meaningful.
- Expected owner in host mode is the `pw-tmux-server.service` cgroup; in container mode the sidecar's
  cgroup. Both are resolved from configuration, never hard-coded to a deployment.
- `systemd-notify` is never on an exit path: in container mode its absence is tolerated, per the
  GOA constraint recorded in Round 2.

## Log

- 2026-08-11 — assessed at `fb42c32`; contract read from `DEVELOPMENT-COORDINATION.md`
  (Round 2 HJ-24-1/2/3, Round 8 items 1-3, GOA-2/3/5 dispositions). Worktree cut, tree identical to
  main. Greenfield confirmed.

- 2026-08-11 — increments 1-4 done. `app/tmux-owner.js` (12/12 vs a faked /proc),
  `scripts/pw-tmux-assert-owner` + `app/tmux-owner-gate.js` (7/7), all five seams gated (6/6):
  project-terminal-start, setup-terminal-start, pw-tmux-restore, app/server.js `tmux()`
  (covers create/new-window/recycle — the Round 8 dashboard bypass) and orchestrator session.js.
  Missing helper proven to be a REFUSAL behaviourally, not a source claim. C4 evidence complete.

- 2026-08-11 — increments 5-10 done; increment 11 (freeze) BLOCKED. Status per criterion:

  | # | Status | Evidence |
  |---|---|---|
  | C1 owner unit + proven readiness | PASS | `tmux-owner-readiness` 4/4; unit asserts `Type=notify`/`NotifyAccess=all` |
  | C2 foreign server refused + migration documented | PASS | refusal is nonzero and names the save/kill/restart path |
  | C3 non-vacuous cold-start race | PASS | MUTATION-PROVED: fails against readiness-before-creation, passes after |
  | C4 all seams fail closed, no dashboard bypass | PASS | `tmux-owner` 12/12, `tmux-assert-owner` 7/7, `tmux-seam-gate` 6/6 |
  | C5 installer host-only + fatal | PASS | `tmux-owner-install` 11/11 incl. a real container-mode invocation |
  | C6 GOA-2 preserved | PASS | `tmux-owner-dispositions` |
  | C7 GOA-5 preserved | PASS | `tmux-owner-dispositions` |
  | C8 64-bit MemoryHigh | PASS | source + value assertions |
  | C9 CI triggers every PR/head | PASS | allow-list removed; no enforcement overclaim |
  | C10 hermetic tmux harnesses | PASS (new suites) | short socket root, all listed vars scrubbed |
  | C11 no environment-specific literals | PASS | portability guard over all new sources |
  | C12 canonical gate / PR / CI | **BLOCKED** | 1009 tests, 953 pass, **53 fail**, 3 skipped |

  The 53 failures are NOT the product: they are five pre-existing harnesses
  (`pw-tmux-restore` 27, `project-terminal-start` 11, `user-lifecycle-locking` 8,
  `user-lifecycle` 6, `projects-lock` 1) that stand up a private tmux server carrying no owner
  marker, and in restore's case with the gate helper absent from PATH. The gate refuses exactly
  as designed — an unmarked server IS the misconfiguration it exists to catch — so the correct
  repair is to make those fixtures represent a valid deployment (stamp `@pw_owner` on the private
  server they create; put `pw-tmux-assert-owner` on PATH for the restore harness), the same shape
  as Candidate B's real-git-repository fixture migration.

  Explicitly REJECTED as repairs, because each is a fail-open the contract forbids:
  an enforcement flag defaulting to off; reusing `PW_TMUX_OWNER_BOOTSTRAP` as a test bypass;
  scoping the dashboard gate away from private sockets (production isolates with the same
  variable, so it would exempt production too).

  Stopping here rather than freezing a head with a red gate or a rushed fixture migration.
