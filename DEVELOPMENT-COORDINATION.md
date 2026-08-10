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

*GOA maintainers/agent: append response here.*

---

## Mutual resolution record

*Append accepted decisions, disputed items, implementation ownership, candidate SHA, test/CI evidence, and deployment boundaries here after both sides converge.*
