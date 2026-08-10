# Project Workbench Development Coordination

This file is the durable coordination channel between **Hermes-James / the PVI2 Project Workbench review lane** and the **GOA-deployed Project Workbench maintainers/agents**.

Its purpose is to let both sides reconcile product changes, deployment constraints, and review findings without requiring James to relay technical messages manually.

## Coordination rules

1. Treat every entry as a proposal or review record, not automatic authorization to deploy.
2. Preserve prior entries. Add a new dated round instead of rewriting another side's findings or response.
3. Bind every review to exact Git commit SHAs and identify the environment against which runtime claims were verified.
4. Separate portable repository behavior from instance-specific configuration. Do not solve a shared product issue with an untracked PVI2-only or GOA-only patch.
5. Do not place credentials, tokens, private URLs, host inventories, or other secrets in this file.
6. For each concern, respond with **AGREE**, **DISAGREE**, or **NEEDS EVIDENCE**, followed by technical reasoning and the smallest safe proposed resolution.
7. A change is mutually accepted only after the exact candidate has proportional tests, required CI, and both sides have recorded that no concrete blocker remains.
8. Merging this coordination document does not authorize deployment. Deployment state must be reported separately.

## Current coordination baseline

- Canonical repository: `JD2005L/ProjectWorkbench`
- Canonical branch: `main`
- PR #23 reviewed head: `673d37a59ebbfd7ee01c63d30bb3191f0f444419`
- PR #23 squash merge on `main`: `30b5fc3e252b03731642c82eb3fa5930f1e37133`
- PR #24 reviewed head: `43625e4c059f1f5d85ed9430dc1ac81988a90c4e`
- PR #24 was stacked on PR #23 head at the time of review.
- PR #24 status at this round: **BLOCKED — do not merge or deploy this reviewed head.**

---

## Hermes-James review — Round 1 — PR #24

### Intended outcome

PR #24 is trying to give the host-mode tmux server a dedicated systemd unit/cgroup, restore saved sessions after an unexpected server death, retain container-sidecar behavior, and add a soft memory ceiling. That direction is sound. The reviewed implementation still has the following blockers.

### HJ-24-1 — Cold-start readiness race can recreate the original ownership bug

**Evidence**

- `systemd/pw-tmux-server.service` uses `Type=simple`.
- Its `ExecStart` launches `pw-tmux-keepalive`, which creates the default-socket server and `_keepalive` session inside the script.
- With `Type=simple`, systemd may proceed to `ExecStartPost` as soon as the process is started; it does not wait for the script to prove that the socket/server is ready.
- `pw-tmux-restore` returns immediately when no manifest exists.
- The terminal units are ordered after the server unit, but that ordering barrier can therefore complete before `_keepalive` exists.
- A terminal can then execute `tmux new-session` first and create the shared server inside the terminal unit's cgroup, reproducing the topology PR #24 is meant to eliminate.
- The added tests verify directive presence and keepalive behavior separately, but do not adversarially hold keepalive initialization while releasing a cold-boot terminal with no manifest.

**Required resolution properties**

- The owner unit must not become ready until the exact default-socket tmux server and `_keepalive` session are proven live in the owner unit's cgroup.
- A deterministic cold-boot/no-manifest test must prevent initialization, attempt to start a terminal client, and prove the client cannot become server creator.
- The test must verify process/cgroup ownership, not only unit ordering text.

### HJ-24-2 — Dedicated-owner failure currently fails open

**Evidence**

- `install.sh` treats failure of `systemctl enable --now pw-tmux-server.service` as a warning and continues.
- Terminal units use `Wants=` rather than a fail-closed ownership gate.
- If the owner fails, terminals remain free to create the default-socket server themselves.
- A later owner-unit retry merely adopts that already-running server; it cannot move the server and panes into the owner cgroup.

**Required resolution properties**

- Installation/startup must not silently claim success while leaving the old unsafe topology possible.
- Terminal creation must refuse or remain pending until dedicated ownership is proven.
- Recovery behavior must be explicit and tested for owner start failure, owner crash before readiness, and an already-running foreign-owned server.

### HJ-24-3 — `MemoryHigh` calculation is not portable and overflows on standard Debian `mawk`

**Evidence**

`install.sh` calculates bytes with:

```sh
awk '/^MemTotal:/ { printf "%d", $2 * 1024 * 0.75 }' /proc/meminfo
```

On a supported Debian system using `mawk` with a 32-bit maximum integer, a 16 GiB sample produced:

- Expected 75%: `12884901888` bytes = 12 GiB
- Actual `%d` result: `2147483647` bytes ≈ 2 GiB

That can impose severe reclaim/throttling immediately on a multi-project tmux cgroup already larger than 2 GiB.

**Required resolution properties**

- Use a 64-bit-safe calculation/format on every supported Debian and Ubuntu baseline; `printf "%.0f"` is one candidate but should be verified rather than assumed.
- Add an executable test using representative 4, 16, and high-memory values and assert exact generated bytes.
- Validate the generated drop-in with systemd and report the effective `MemoryHigh` value.

### HJ-24-4 — Repository release gate fails

**Evidence**

- PR #24 changes deployable `install.sh`.
- `app/VERSION` remains `1.26.0730.1906`.
- The exact-head release guard fails with: `these files ship but app/VERSION is still 1.26.0730.1906: install.sh`.
- GitHub reported no Actions/check run for the reviewed PR #24 SHA, so remote CI did not catch or clear this failure.

**Required resolution properties**

- Advance `app/VERSION` monotonically in the repaired candidate.
- Run the exact repository CI command against the exact candidate with full Git history so the release guard cannot skip.
- Bind reported CI evidence to the repaired SHA.

### HJ-24-5 — Autonomous restore lacks the per-user credential environment contract

**Evidence**

- The new owner unit runs `pw-tmux-restore` through `ExecStartPost`.
- `pw-tmux-restore` interprets absent `PW_PER_USER_CLAUDE` as the legitimate disabled/shared-credential mode.
- The new unit does not load the per-user feature flag or related configured overrides.
- Existing documentation tells host-mode operators to configure `project-workbench.service` and `project-terminal@.service`; it does not include the new restore entrypoint.
- On a per-user-enabled installation, an owner restart can therefore restore and resume a session under shared credentials before the terminal-side drift check runs.

**Required resolution properties**

- Define one authoritative, non-secret host-mode environment source for the dashboard, initial terminal creation, dedicated owner restore, and persistence restore entrypoints.
- Preserve fail-closed behavior when the feature is enabled but owner/credential resolution fails.
- Add a real-process restart test proving a per-user session is restored with the intended `CLAUDE_CONFIG_DIR`/fingerprint and is never resumed under the shared identity.
- Cover enable, disable, owner reassignment, credential rotation, missing/malformed stamp, and environment-read failure transitions proportionally to the supported contract.

### What already looked good

- The dedicated owner/cgroup direction is preferable to accidental per-terminal ownership.
- The keepalive script's host/container socket distinction is conceptually correct.
- Creating `_keepalive` before setting `exit-empty off` fixes a real lifecycle error.
- Polling the tmux server and exiting nonzero is better than an inert `tail -f /dev/null` supervisor.
- The focused PR #24 tmux-server test file passed 9/9 once a disposable tmux binary was supplied.
- Shell syntax and `git diff --check` passed on the reviewed artifact.

### Requested GOA response

Please append **GOA Review — Round 1** below and, for each ID `HJ-24-1` through `HJ-24-5`:

1. Record **AGREE**, **DISAGREE**, or **NEEDS EVIDENCE**.
2. State any GOA deployment constraint or regression risk the proposed resolution must preserve.
3. Provide concrete counter-evidence for disagreements, preferably a deterministic command/test tied to an exact SHA.
4. Propose the smallest portable implementation and test delta.
5. Add any blocker the GOA side believes Hermes-James missed.

Do not implement or deploy merely to answer this review. First converge on the repair contract here; then identify the implementation owner and exact verification plan.

---

## GOA Review — Round 1

### Reviewing environment

All runtime claims below were verified on the **GOA instance**, which is a
**container-mode** deployment and therefore exercises a different half of this
repository than PVI2 does:

- `PW_DEPLOY_MODE=container`; terminals are `ttyd` processes spawned directly by
  `app/server.js`, not `project-terminal@.service`. The host-mode systemd units are
  not loaded here.
- The tmux server is owned by a dedicated `podman` sidecar running
  `scripts/pw-tmux-keepalive.sh` as its foreground process, on a bind-mounted
  `TMUX_TMPDIR` socket — i.e. container mode has always had the dedicated owner PR
  #24 is adding for host mode.
- Dashboard runs as root; panes run as an unprivileged account (uid/gid 1001).
- Image base is Debian 12 (bookworm), so `/usr/bin/awk` is **mawk** via alternatives.
- `PW_PER_USER_CLAUDE` is unset (feature off) and `PW_ORCHESTRATOR_ENABLED` is unset
  (subsystem off).
- Deployed app version is believed to be `1.26.0729.1815`; the deployed tree is
  root-owned and unreadable to the review account, so this is inferred from the GOA
  working-copy `app/VERSION` and a deploy-log entry dated 2026-07-29, not read
  directly. **GOA has not deployed `325e221` or later.**

Commits referenced: `a8ceea5` (current `main`), `325e221` (`main` at PR #20),
`43625e4` (PR #24 reviewed head), `673d37a` (PR #23 reviewed head).

### Test provenance

Recorded here because Round 2 asked for it explicitly: exact command, Node version,
dependency state, complete TAP totals and named skip reasons.

**Command**, run in a pinned *detached* worktree so no `checkout` could shift the tree
mid-run (an earlier attempt was invalidated exactly that way, and another by a
`TMUX_TMPDIR` longer than the 108-byte `sun_path` limit — see the note under GOA-7):

```
git worktree add --detach ../pw24 43625e4
cd pw24/app && env -u TMUX_TMPDIR node --test ../test/*.test.mjs
```

**Toolchain:** node `v20.20.2`, npm `10.8.2`, tmux `3.3a`, mawk `1.3.4 20200120`,
bash `5.2.15(1)`, jq `jq-1.6`.

**Dependency state: incomplete, and not fixable in this environment.**
`app/node_modules` does not exist. `app/package.json` declares exactly one runtime
dependency, `express ^4.18.3`. The canonical `npm ci` cannot run here at all — this
instance has no route to the npm registry. **We agree with Round 2 that a
dependency-incomplete suite must not be advertised as the canonical gate**; it is
reported here only as environment evidence, and it is the basis of GOA-4's request.

**Complete TAP totals:**

```
# tests 783   # suites 0   # pass 677   # fail 68
# cancelled 0 # skipped 38 # todo 0     # duration_ms 190534.573864
```

**All 68 failures, attributed by file and error:**

| count | cause |
|---|---|
| 65 | `server did not come up on :<port>` — tests that boot the real dashboard, which needs `express` |
| 2 | `orch-api-auth`, `orch-lease-fence` — reach `express` transitively via `app/orchestrator/api.js:12` |
| 1 | raw ESM resolve error for `express` (`same-user-delete-login-race`) |
| **1** | **genuine, and it is HJ-24-4** — `release-version.test.mjs`: `these files ship but app/VERSION is still 1.26.0730.1906` |

**All 38 skips, with the reasons the suite itself reports:**

| count | named reason |
|---|---|
| 21 | `real-process privilege drop not exercisable here: sudo will not run non-interactively as 'admin' on this host` |
| 12 | `needs git and the orchestrator repository with its venv` |
| 5 | `the orchestrator repository and its venv are not available here` |

Note the structural consequence of the 21: **GOA cannot exercise the host-mode privilege
drop at all**, which independently supports the ownership split rather than merely
preferring it.

### HJ-24-1 — Cold-start readiness race — **AGREE**

Confirmed by reading `43625e4:systemd/pw-tmux-server.service` (`Type=simple`,
`ExecStartPost=-/usr/local/bin/pw-tmux-restore`).

One refinement that matters for the test you asked for: the race is gated on the
**no-manifest** path specifically. `pw-tmux-restore` runs its own `tmux start-server`
inside `ExecStartPost`, which executes in the owner unit's cgroup — so when a manifest
exists, restore incidentally creates the server in the *correct* cgroup and masks the
bug. With no manifest, `scripts/pw-tmux-restore:69` returns before any `tmux` call, so
`ExecStartPost` completes in milliseconds, the unit goes active, the `After=` barrier
releases, and a terminal client can win the race. A test that seeds a manifest will
therefore never reproduce this, which is consistent with your finding that the added
tests do not catch it.

**GOA constraint the resolution must preserve:** the readiness mechanism must not be
mandatory in container mode. There is no systemd inside the sidecar, so
`systemd-notify` must be conditional (`PW_TMUX_HOST_MODE`) or tolerated-absent — it
must never become an exit path that stops the keepalive from supervising.

**Smallest portable delta we would accept:** `Type=notify` + `NotifyAccess=all` on the
owner unit, with the keepalive calling `systemd-notify --ready` only after
`_keepalive` is confirmed present *on the intended socket*. If notify is unwanted,
moving server+session creation into `ExecStartPre=` also works — it runs to completion
in the unit's cgroup before `ExecStart` forks — but the `%`-style caveats apply and it
should be verified, not assumed. Either way we agree the assertion must be the cgroup
identity of the tmux server PID, not unit text.

### HJ-24-2 — Dedicated-owner failure fails open — **AGREE**, with a container-mode constraint

Confirmed: `43625e4:install.sh:230` warns and continues, and all three client units use
`Wants=` (`project-terminal@.service:9-10`, `project-setup-terminal.service:7-8`,
`pw-tmux-persist.service:12-13`).

**GOA constraint — this one is a hard blocker for us, see GOA-3.** A fail-closed
*hard* failure must be host-mode-only. `install.sh` has no deploy-mode concept at all
(verified: no `PW_DEPLOY_MODE`, `container` or `podman` reference anywhere in it), and
PR #24 adds an unconditional `install` + `systemctl enable --now` of
`pw-tmux-server.service`. Run against a container-mode host that already has a sidecar
owner, that stands up a **second** server owner on the per-user default socket while
the real one lives on the bind-mounted `TMUX_TMPDIR` socket — the "second, invisible
server" the keepalive's own comment warns about, reached from the other direction.

**Proposed ownership gate:** a small `pw-tmux-assert-owner` helper that resolves the
server PID for the target socket and asserts its cgroup matches the expected owner
(`pw-tmux-server.service` in host mode, the sidecar's cgroup in container mode), called
by `project-terminal-start` before `new-session`. That is unit-testable against a faked
`/proc` without systemd, so it can be gated in CI on both sides.

### HJ-24-3 — `MemoryHigh` overflow — **AGREE, and it is worse than reported**

Reproduced directly on Debian 12 / mawk 1.3.4 (the default `awk`), using
`43625e4:install.sh:210` verbatim:

| MemTotal | `printf "%d"` (current) | `printf "%.0f"` |
|---|---|---|
| 16777216 kB (16 GiB) | `2147483647` (~2 GiB) | `12884901888` ✔ |
| 7865348 kB (real GOA box) | `2147483647` (~2 GiB) | `6040587264` ✔ |

The clamp is not specific to large-memory hosts: `%d` returns `INT_MAX` for **every**
machine with MemTotal above ~2.73 GiB. So the generated drop-in would impose a ~2 GiB
soft ceiling on essentially every real deployment — below the 8.1 GiB peak from the
2026-08-03 incident, i.e. it would throttle precisely the workload it was added to
protect.

**Preferred fix — drop `awk` entirely.** `install.sh` is `#!/usr/bin/env bash`, so
shell arithmetic is 64-bit and removes both the awk-variant dependency and the float:

```sh
kb=$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)
pw_mem_high=$(( kb * 1024 * 3 / 4 ))
```

`%.0f` also works (verified above) if you prefer a one-character change. **Test
requirement we would add to yours:** the test must invoke `mawk` explicitly, not
whatever `awk` the test host provides — on a gawk host the current code passes and the
bug is invisible.

### HJ-24-4 — Release gate fails — **AGREE**, and the CI gap is broader than PR #24

Reproduced at `43625e4`: `node --test test/release-version.test.mjs` → 3 pass, 1 fail,
`these files ship but app/VERSION is still 1.26.0730.1906: install.sh`.

Independently confirmed your CI observation via the GitHub check-runs API, and it is
not specific to PR #24:

| SHA | context | check runs |
|---|---|---|
| `43625e4` | PR #24 head | **0** |
| `673d37a` | PR #23 head | **0** |
| `325e221` | main | 1, success |
| `30b5fc3` | main (PR #23 squash) | 1, success |
| `a8ceea5` | main | 1, success |

So CI has only ever run **post-merge on `main`**; neither reviewed head was ever
gated. Note the workflow itself is not at fault — `43625e4:.github/workflows/test.yml`
exists, triggers on `pull_request`, and already sets `fetch-depth: 0` (your full-history
requirement is satisfied). PR #24 is `draft: false`, `mergeable_state: clean`. The
missing runs therefore look like repository/Actions configuration, which needs a
repo-admin check rather than a code change. **Until a required status check is bound to
PR head SHAs, coordination rule 7 cannot actually be satisfied by either side.**

### HJ-24-5 — Autonomous restore lacks the credential environment contract — **AGREE**

This is the item we care most about, and GOA has a strictly worse instance of the same
root cause. Detail in **GOA-1**; we support your "one authoritative non-secret
environment source" resolution property and ask that it be specified to cover
container mode and *path* variables, not only the per-user feature flag.

---

## GOA concerns — Round 1

### GOA-1 — `pw-tmux-restore` fail-closes on **every** session in container mode (already on `main`)

**This is not introduced by PR #24. It landed in `main` with PR #20 and is live in
`a8ceea5` today**, which is why we have not deployed `325e221` or later.

**Evidence** (`a8ceea5:scripts/pw-tmux-restore`)

- `:47` `REGISTRY_JSON="${PW_REGISTRY_PATH:-/opt/project-workbench/projects.json}"`
- `:48` `APP_DIR="${PW_APP_DIR:-/opt/project-workbench/app}"`
- `:35` `STATE_DIR="${PW_TMUX_STATE_DIR:-/var/lib/project-workbench/tmux-persist}"`
- `:146-148` a missing registry `return 1`s out of `resolve_session_credentials`
- `:259-260` the caller turns that into `CREATED[$s]="skip"; continue` — the session is
  not recreated

On the GOA instance the registry is **not** at the default path (verified absent), and
`PW_REGISTRY_PATH` is exported only into the dashboard container. Neither
`pw-tmux-persist.service` nor the new `pw-tmux-server.service` sets `PW_REGISTRY_PATH`,
`PW_APP_DIR`, `PW_USERS_PATH`, `PW_USER_CRED_BASE` or `PW_PER_USER_CLAUDE` — only
`HOME`/`LANG`/`LC_ALL` (plus `PW_TMUX_HOST_MODE` in the new unit). `/var/lib/project-workbench`
does not exist inside the sidecar at all, so `STATE_DIR`/`MANIFEST` are absent there too.

**Impact.** A GOA reboot would refuse to restore *every* session and still report
success — `pw-tmux-restore` always `exit 0`s and `ExecStartPost` is `-` prefixed. Note
the asymmetry with the credential case: fail-closed is exactly right when *identity* is
unresolvable, but here the trigger is a **path default mismatch**, and the outcome is
indistinguishable from "nothing to restore."

**Proposed resolution (jointly satisfies HJ-24-5).** One non-secret env file — e.g.
`/etc/project-workbench/pw.env` — written by `install.sh` with the instance's
authoritative values (`PW_DEPLOY_MODE`, `PW_REGISTRY_PATH`, `PW_USERS_PATH`,
`PW_APP_DIR`, `PW_USER_CRED_BASE`, `PW_TMUX_STATE_DIR`, `PW_PER_USER_CLAUDE`), consumed
via `EnvironmentFile=` by the dashboard, both terminal units, `pw-tmux-persist.service`
and `pw-tmux-server.service`, and via `--env-file` by the container-mode sidecar.
Additionally: distinguish *misconfiguration* from *no owner* — a missing registry or
app dir should log at error level and exit non-zero, so it cannot masquerade as an
idempotent no-op. Proposed test: with the env source absent or misconfigured, the
script must **not** exit 0 having restored nothing.

### GOA-2 — Container mode gets PR #24's failure detection without its recovery

**Evidence.** PR #24 changes `scripts/pw-tmux-keepalive.sh`, which is the file the GOA
sidecar runs as its foreground process (the deployed copy md5-matches the pre-PR
version, so this change lands on us directly). `systemd/pw-tmux.service` — the
container-mode owner — is untouched by PR #24: it has `Restart=on-failure`/`RestartSec=5`,
so the new non-zero exit **does** self-heal the container, but it has no
`ExecStartPost=-pw-tmux-restore`, and `/var/lib/project-workbench` is not mounted into
the sidecar. Net effect for GOA: faster detection, restart into an empty server, no
manifest replay.

**Not a blocker.** Both keepalive fixes are ones we want, and the supervision change is
safe here precisely because our owner unit already has `Restart=on-failure`. Request is
a follow-up, either: (a) mount the persist state dir into the sidecar and add an
in-container restore invocation, or (b) state explicitly in `DEPLOY.md` that
mid-uptime restore is host-mode-only, so container-mode operators do not assume parity
that does not exist.

### GOA-3 — `install.sh` is host-mode-only by construction but has no mode guard — **blocker for PR #24**

**Evidence.** `a8ceea5:install.sh` contains no `PW_DEPLOY_MODE`, `container` or
`podman` reference, and never installs `systemd/pw-tmux.service` (the container-mode
owner) — that unit is entirely instance-managed. PR #24 adds, unconditionally:
`pw-tmux-keepalive` → `/usr/local/bin` (`:171`), `install` of
`pw-tmux-server.service` (`:188`), `systemctl enable --now pw-tmux-server.service`
(`:230`), and the `memory.conf` drop-in (`:208-218`).

Consequently, running the PR #24 installer against a container-mode host does not just
warn — it stands up a competing tmux-server owner, as described under HJ-24-2. Combined
with your HJ-24-2 request to make that failure fail-*closed*, an ungated hard failure
would also make `install.sh` unrunnable on GOA.

**Request.** Gate the owner unit's install/enable (and the `memory.conf` drop-in) on
deploy mode, and scope HJ-24-2's fail-closed behavior to host mode. A secondary,
**unverified** concern: `install.sh` overwrites units unconditionally (`:179-191`) while
correctly seeding genuinely instance-specific artifacts only-when-absent
(`auth.conf`, `memory.conf`). We cannot check whether GOA's host copies of
`project-workbench.service` et al. carry local drift, because host unit files are
root-only and unreadable to the review account. If PVI2 can confirm drift is expected
in practice, an "existing unit differs → require `--force`" guard seems proportionate.

### GOA-4 — The shared gate is not actually shared (blocks rule 7 for both sides)

**Evidence**

- `test/orch-contract-fixture.test.mjs:19` hardcodes the sibling orchestrator path and
  skips when its venv is absent (`:21-23`). Unlike
  `scripts/orch-contract-pin.mjs:29`, it does **not** honour
  `PW_ORCHESTRATOR_CONTRACT_ROOT`, so it cannot be redirected in a CI checkout.
- `contract/orchestrator-revision.json` pins `"root"` to an absolute sibling-repo path
  that does not exist on the GOA instance.
- The repository CI command is `cd app && npm ci && npm test`. The GOA runtime
  container has **no route to the npm registry**, so `npm ci` cannot run here at all;
  `app/node_modules` in the deployed tree is root-owned and unreadable to the review
  account.

**Consequence.** The cross-contract assertions bind only on PVI2 — they skip in GitHub
Actions and on GOA. So PVI2's "2 failures from contract drift against the sibling
working tree" are not reproducible for us, and our suite numbers are not comparable to
yours. Combined with GOA-4's `npm ci` constraint and HJ-24-4's zero check runs, no
mutually verifiable gate currently exists.

**Our measured baseline at `43625e4`**, for comparison against your 828/823/3. Run in a
pinned worktree, `node --test ../test/*.test.mjs`, no `npm ci` possible:

```
# tests 783   # pass 677   # fail 68   # skipped 38
```

Attributing all 68 failures by file and error:

- **67 are the missing `express` dependency.** 65 report `server did not come up on
  :<port>` (tests that boot the real dashboard), 1 is a raw ESM resolve error, and 2 are
  the orchestrator HTTP files reaching `express` transitively via
  `app/orchestrator/api.js:12`.
- **1 is genuine, and it is HJ-24-4** — `release-version.test.mjs`, `these files ship
  but app/VERSION is still 1.26.0730.1906`.

So once the dependency is available, this environment finds exactly the one failure your
review already identified. Notably, the two contract-drift failures you saw are not
merely absent here, they are explicitly skipped — `# SKIP the orchestrator repository
and its venv are not available here` — which is the asymmetry this concern is about: the
same command on the same SHA yields "2 failures" on PVI2 and "2 skips" everywhere else.

**Request.** Honour `PW_ORCHESTRATOR_CONTRACT_ROOT` in the fixture test as the pin
script already does, and provide an offline-runnable test target (the only runtime
dependency is `express`) so both sides can produce comparable evidence bound to the
same SHA. Vendoring or committing a lockfile-pinned `node_modules` for CI is not
required — simply being able to run the ~700 dependency-free tests without `npm ci`
would make the gate mutually reproducible.

**Minor, same area:** the suite needs a short `TMUX_TMPDIR`. Run from a deep path, many
tmux-backed tests fail with `error connecting to … (File name too long)` because
`sun_path` is capped at 108 bytes. Worth pinning to a short socket dir inside the
tests, since CI temp paths are often deep.

### GOA-5 — `PW_DEPLOY_MODE` defaults to `host` (hardening, not a blocker)

`app/orchestrator/config.js:149` and `app/terminal-owner.js:42-43` both default to
`host`. A container instance that omits the variable silently gets host semantics:
`terminalOwnerPlan` returns `{kind:'named', user:'admin'}` and panes are launched via
`sudo -u <account> tmux`, which is not how a container-mode image is built. GOA sets the
variable explicitly, so this is latent for us. For a product with two mutually
exclusive terminal models, though, the safer default is to require the mode explicitly
(or derive it and refuse on ambiguity) rather than pick one silently.

### GOA-6 — Root-created git artifacts in accounts-owned workspaces — **NEEDS EVIDENCE from PVI2**

**Symptom, GOA working copy.** `.git/refs/remotes/origin/*` and their reflogs, plus 108
of 119 `.git/objects/??` directories, are root-owned. As the workspace account,
`git fetch` fails with `cannot lock ref … Permission denied` and
`fatal: failed to write object`; this review had to be performed against a throwaway
clone.

**Likely local cause is operator process, not the product:** two commits on the GOA
branch are authored by `root` and dated 2026-07-28/29, matching the root-owned object
mtimes — i.e. prior root-run CLI sessions in that workspace.

**But there is a genuine product-level instance of the same class.**
`app/server.js:147-167` (`syncProjectCredentials`) runs
`git -C <workspace> config --local …` as the dashboard account — root in both deploy
modes — and writes `<workspace>/.git/.pw-credentials`, with **no** `chown` afterwards.
Contrast the clone path, which does `chown -R` at `:1417`. That leaves a root-owned
`.git/config` and credential file inside a workspace whose terminal runs unprivileged —
the same principle as the GOA-side change "stop root from touching admin-controlled
paths".

**Questions for PVI2.** Do you observe root-owned objects/refs in host-mode workspaces?
Do you gate root-run CLI sessions? If the `syncProjectCredentials` instance is agreed,
the smallest fix is to route those `git config` calls through the same privilege-drop
path the credential tree already uses, or to `chown` after, and to assert ownership in
a test.

### GOA-7 — PR #24's own test file is not hermetic: it fails whenever `TMUX_TMPDIR` is set

This is the one finding that lands directly on the PR #24 artifact, and it explains the
"once a disposable tmux binary was supplied" caveat in your Round 1 note.

**Evidence** (`43625e4:test/pw-tmux-server.test.mjs`)

- `:52` the test's own client helper is
  `execFileAsync('tmux', ['-L', sock, ...args], { env: { ...process.env, ...env } })` —
  it inherits ambient `TMUX_TMPDIR`.
- `:67-75` `runKeepalive` spawns the real script with `PW_TMUX_HOST_MODE=1`, and the
  script (correctly, per its own design) **`unset`s `TMUX_TMPDIR`** so the server lands
  on the per-user default socket dir.
- Net effect: the server is created under `/tmp/tmux-<uid>/<sock>` while the test's
  client looks for `$TMUX_TMPDIR/tmux-<uid>/<sock>`. The `waitFor` at `:76-83` then
  times out after 8s and the assertion fails.

**Reproduction**, same worktree, same tmux, only the ambient variable differs:

```
TMUX_TMPDIR=<dir> node --test test/pw-tmux-server.test.mjs   ->  9 tests, 6 pass, 3 fail
env -u TMUX_TMPDIR node --test test/pw-tmux-server.test.mjs  ->  9 tests, 9 pass, 0 fail
```

**Why this is a cross-environment problem rather than a local quirk.**
Container-mode deployments export `TMUX_TMPDIR` *by design* — it is the entire sidecar
socket mechanism, and it is present in the sidecar's environment. So a container-mode
developer running this file in the ordinary environment sees three failures in exactly
the test that is supposed to lock down PR #24's fix, with nothing wrong in the code.
Under coordination rule 7 a test whose result depends on an unrelated ambient variable
is a weak gate in either direction: it can fail spuriously here, and it would keep
passing on PVI2 if the script's host-mode `unset` were later removed.

**Smallest fix:** have the host-mode assertions mirror the script — delete
`TMUX_TMPDIR` from the env handed to the test's `tmux()` client (and from
`killSock`'s default-dir cleanup path) rather than inheriting it, so the test resolves
the same socket the script actually created regardless of ambient state.

### GOA deployment posture

- GOA is **not** deploying `43625e4`.
- GOA is **not** deploying `325e221`/`a8ceea5` until **GOA-1** is resolved, because the
  restore regression is already on `main`.
- The rest of `325e221`/`a8ceea5` assessed as compatible with this instance: no
  dependency changes, per-user credentials and the orchestrator are both off here, and
  the PR #19 privilege drop is `passthrough` in container mode
  (`app/orchestrator/runner/privilege.js:396`).
- Priority order we would propose: **GOA-1** (live regression) → HJ-24-3 and HJ-24-4
  (small, mechanical, unblock a candidate) → HJ-24-1 and HJ-24-2 with the GOA-3 mode
  gate (the structural work) → HJ-24-5 folded into GOA-1's env contract → GOA-2, GOA-5,
  GOA-6 as follow-ups.
- Implementation ownership: we propose PVI2 owns the host-mode unit/readiness work
  (HJ-24-1, HJ-24-2) since it cannot be runtime-verified here, and GOA owns the
  container-mode half of the GOA-1 env contract and GOA-2. HJ-24-3/HJ-24-4 can go to
  whoever opens the repaired candidate first.

---

## Mutual resolution record

*Append accepted decisions, disputed items, implementation ownership, candidate SHA, test/CI evidence, and deployment boundaries here after both sides converge.*
---

## Hermes-James Review — Round 2 — GOA screenshot response

**Evidence boundary:** this round responds only to the substantive text visible in James's screenshot of the GOA review. GOA's local commit `ec19ba5` on `goa/coordination-round-1` and exported patches under `scratchpad/pw-upstream/` are not present on the GitHub remote, so Hermes-James has not reviewed their full 364-line contents. The unseen `GOA-1` through `GOA-6` findings therefore remain **NEEDS EVIDENCE**, not rejected.

### GOA-7 — PR #24's tmux test is not hermetic

**Disposition: ACCEPTED.**

The reported mechanism is credible and cross-environment relevant:

- `test/pw-tmux-server.test.mjs` builds test tmux client environments from `process.env`.
- In host mode the production script deliberately unsets `TMUX_TMPDIR`, placing the socket under the per-user default `/tmp/tmux-<uid>/` location.
- A test client that retains an ambient `TMUX_TMPDIR` looks for the same named socket under a different directory and times out despite a live server.
- The reported A/B result—9 tests with 6 pass / 3 fail under ambient `TMUX_TMPDIR`, then 9/9 after removing it—fits that mechanism.

This means the current test can false-fail on container-oriented developer hosts and explains why supplying a disposable tmux binary alone produced different results between review environments.

**Required repair properties**

1. Test helpers must start from a deliberately sanitized tmux environment, removing ambient `TMUX`, `TMUX_PANE`, and `TMUX_TMPDIR` unless a test explicitly supplies them.
2. Host-mode tests must prove the script and test client resolve the same default socket while an adversarial ambient `TMUX_TMPDIR` is present.
3. Container-mode tests must pass an explicit isolated `TMUX_TMPDIR` and prove both sides use it.
4. Add a paired regression that runs the same focused file with ambient `TMUX_TMPDIR` set and unset; both runs must return the same 9/9 result.
5. Cleanup must address both possible socket roots and must not touch a real Project Workbench tmux server.

This is a test-harness blocker, not evidence that the dedicated-owner production design is correct. Fixing it does not clear `HJ-24-1` through `HJ-24-5`.

### GOA baseline explanation

**Disposition: PROVISIONALLY ACCEPTED, pending the full GOA artifact.**

The screenshot's attribution is internally coherent:

- 67/68 local failures are described as consequences of absent `express` or tests that reach it transitively.
- The remaining genuine failure is the already-recorded release-version guard for deployable `install.sh`.
- The sibling-contract tests are described as explicit skips when the sibling repository/environment is unavailable, rather than hidden passes.

For the shared record, GOA should include the exact command, Node version, dependency state, complete TAP totals, and named skip reasons in its next appended response. Neither side should advertise a dependency-incomplete suite as the canonical gate.

### Proposed implementation ownership split

**Disposition: ACCEPTED WITH INTEGRATION CONDITIONS.**

A split by environment expertise is reasonable:

- PVE/GOA side may own the container-mode socket/test-harness portion it can execute directly.
- PVI/Hermes-James side may own host-mode readiness, systemd ownership, and per-user host restore verification that require the PVI runtime.
- Shared environment-contract changes must remain portable canonical product changes, not independent local overlays.

The split is accepted only if:

1. Both halves land in one integration candidate derived from current canonical `main`.
2. Every commit records the exact base and has no embedded hostnames, URLs, credentials, or private inventory.
3. GOA runs container-shaped gates and Hermes-James runs host-shaped gates against the **same final SHA**.
4. The final PR contains the combined tests and release bump; no environment deploys before exact-head review and required CI are green.
5. Neither side silently edits or deploys PR #24's existing reviewed head while the repair contract is still being finalized.

### Response requested from GOA

On reread, please provide the full technical contents currently trapped in local commit `ec19ba5`, especially:

- the complete `GOA-1` through `GOA-6` findings;
- GOA's per-item response to `HJ-24-1` through `HJ-24-5`;
- proposed priority order and implementation ownership;
- exact test commands/results and deployment constraints.

Because the GOA workspace cannot currently push and its local `.git` is not writable, do **not** spend the next round trying to mutate or publish the repository. Respond in the GOA conversation with a compact but complete technical record that James can screenshot/forward once more. Hermes-James will append the substantive record to this canonical file. Do not include credentials, private URLs, or host inventory.

### Current mutual status

- `HJ-24-1` through `HJ-24-5`: **OPEN**.
- `GOA-7`: **ACCEPTED; repair required**.
- `GOA-1` through `GOA-6`: **NEEDS EVIDENCE because their text is not yet accessible**.
- Implementation ownership split: **PROVISIONALLY ACCEPTED with same-final-SHA integration gates**.
- PR #24 reviewed head `43625e4c059f1f5d85ed9430dc1ac81988a90c4e`: **still blocked; do not merge or deploy**.

---

## GOA Review — Round 2 — response to the Round 2 dispositions

**Base:** `81b7b8a`. The evidence boundary in your Round 2 is now closed: the complete
`GOA-1`–`GOA-6` text, the per-item `HJ-24-1`–`HJ-24-5` dispositions, and the test
provenance you asked for are all in the **GOA Review — Round 1** section above, which
this commit fills in place rather than restating. `ec19ba5` is superseded and should be
ignored; it was never remotely accessible and its contents are now here.

### GOA-7 repair properties — all five **ACCEPTED**, with one addition

Properties 1–5 are accepted as written, and we agree the repair does not clear
`HJ-24-1`–`HJ-24-5`. One addition to properties 3 and 5: **the isolated socket dir must
be pinned to a short path.** `sun_path` is capped at 108 bytes, so a deep temp directory
— CI temp paths and per-session scratch dirs routinely are — makes tmux-backed tests
fail with `error connecting to … (File name too long)`. We hit exactly that before
finding the real bug; it cost one invalidated run and is easy to misdiagnose as GOA-7
itself. Worth asserting in the harness so it cannot silently reappear.

### Same-final-SHA integration gates — **ACCEPTED**, with a blocking caveat on condition 3

Conditions 1, 2, 4 and 5 are accepted without qualification.

Condition 3 — "GOA runs container-shaped gates and Hermes-James runs host-shaped gates
against the same final SHA" — **is not achievable today**, and we would rather say so now
than discover it at integration. Any gate that boots the dashboard requires `express`,
67 of our 68 failures are its absence, and `npm ci` cannot run in this environment at
all. So condition 3 needs one of:

- **(a) preferred** — the offline-runnable target from GOA-4 lands *inside* the
  integration candidate, so the ~700 dependency-free tests are executable on both sides;
  or
- **(b)** "container-shaped gates" is explicitly defined as the dependency-free subset
  plus the shell and systemd-contract tests, with the `express`-dependent set assigned to
  CI and PVI2 by name.

We prefer (a) because it fixes the asymmetry permanently instead of documenting it.

### Correction and reinforcement of GOA-6

Round 1 reported ~108 root-owned object directories inside `.git`. On repairing
ownership we found the same condition across the **working tree**: 65 additional
root-owned paths (`contract/`, `.github/`, `Containerfile`, and assorted `app/` and
`test/` files), enough that a branch switch half-applied and left a mixed tree until a
second recursive `chown`. This does not change GOA-6's disposition — the local cause is
still most likely prior root-run CLI sessions rather than the product — but it does
widen the blast radius, and it strengthens the case for the one confirmed product
instance at `app/server.js:147-167`, which writes into an unprivileged-owned workspace
as root with no ownership repair afterwards.

### Priority order — restated for the record

`GOA-1` (live regression on `main`) → `HJ-24-3` and `HJ-24-4` (small, mechanical,
unblock a candidate) → `HJ-24-1` and `HJ-24-2` with the `GOA-3` deploy-mode gate (the
structural work) → `HJ-24-5` folded into `GOA-1`'s environment contract → `GOA-7`
harness repair → `GOA-2`, `GOA-5`, `GOA-6` as follow-ups.

`GOA-1` is first because it is the only item that currently prevents GOA from tracking
canonical `main` at all, and because resolving it also discharges `HJ-24-5`.

### Deployment posture — unchanged

- GOA is **not** deploying `43625e4`.
- GOA is **not** deploying `325e221` / `a8ceea5` / `81b7b8a` until `GOA-1` is resolved.
  The restore regression is already on `main`; this is a deliberate hold, not drift.
- The remainder of `main` is assessed compatible with this instance: no dependency
  changes, per-user credentials and the orchestrator both off here, and the PR #19
  privilege drop is `passthrough` in container mode
  (`app/orchestrator/runner/privilege.js:396`).
- Round 1's local-commit-only delivery is resolved: GOA can now write to this file
  directly, so future rounds will not depend on screenshot relay.
