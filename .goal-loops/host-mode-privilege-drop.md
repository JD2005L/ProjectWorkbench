# Goal loop — host-mode privilege drop for the coding CLI

## The defect (live, CT2115)

`project-workbench.service` runs Node as **root** by design. `TmuxAdapter` already accounts for that
and execs `sudo -u admin tmux …`; `ClaudeCodeBackend` did not — it called
`execFile(config.backendExecutable, …)` directly for the fingerprint, the auth probe, verification
and the phase itself. Two consequences, both live:

* authenticated `GET /api/orchestrator/v1/health` reported `backend: down, auth method: unknown`,
  because a root process cannot see `admin`'s subscription sign-in;
* a phase that *had* run would have edited an admin-owned workspace as root, leaving root-owned
  files behind — contradicting the host-mode comments and the visible-session safety model.

Live configuration: `PW_DEPLOY_MODE=host`, `PW_ORCHESTRATOR_TMUX_USER=admin`,
`PW_ORCHESTRATOR_CLAUDE_BIN=/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
`PW_ORCHESTRATOR_CLI_SHA256=674f61f2…`, no `HOME` override on the unit.

Explicitly ruled out by the request: copying OAuth stores to root; setting `HOME=/home/admin` on a
root process.

## End state

In host mode every Claude subprocess — fingerprint `--version`/`--help`, `auth status`, verification
and the phase — runs with effective uid = the configured non-root account, `HOME` = that account's
home, `USER`/`LOGNAME` set, and every API-billing variable stripped; fingerprint and effort/model
enforcement still bind to the configured absolute binary and its SHA-256; container mode is
unchanged; a host that cannot drop privilege runs nothing at all.

## Acceptance criteria

| ID | Criterion | Status |
| --- | --- | --- |
| A1 | Host mode: auth probe, verification, phase and fingerprint all launch via `sudo -n -H -u <user> --` with fixed argv, no shell | PASS |
| A2 | Child env: `HOME`/`USER`/`LOGNAME` are the target account's; `FORBIDDEN_ENV` and `SUDO_*` stripped; unrelated vars untouched | PASS |
| A3 | `cwd`, `timeout`, `maxBuffer` and the abort `signal` survive the drop | PASS |
| B1 | Fingerprint identity (realpath, stat, ELF header, SHA-256, `--help` capabilities) still binds to the configured CLI, never to `sudo` | PASS |
| B2 | Pinned-SHA mismatch still refuses; anti-wrapper/ENOEXEC defences untouched | PASS |
| B3 | A non-absolute CLI path is refused in host mode — no PATH/`secure_path` lookup chooses the program | PASS |
| B4 | Caller-controlled argv still cannot inject options (model/effort/turns validation intact) | PASS |
| C1 | Container mode launches exactly as before (existing runner suite pinned to container) | PASS |
| D1 | Fail closed: missing / `root` / malformed account refused; host-mode instance will not boot with one | PASS |
| D2 | Fail closed: account resolving to uid/gid 0, absent from passwd, or with no absolute home | PASS |
| D3 | Fail closed: sudo missing, non-absolute, not root-owned setuid, or group/world-writable | PASS |
| D4 | A failed drop launches nothing and never falls back to root; the refusal is memoised | PASS |
| D5 | The failure is its own kind (`privilege_drop_failed` → `blocked_configuration`), not a generic phase failure | PASS |
| E1 | Real process: effective uid/gid are the account's, not root's | PASS |
| E2 | Real process: `HOME` is the account's home, so the sign-in is where the CLI looks | PASS |
| E3 | Real process: a bounded phase writing into a workspace leaves no root-owned artifact | PASS |
| E4 | Real process: cancellation kills the process behind sudo; a deadline reads as `timeout` | PASS |
| E5 | Live evidence as root: old direct exec fails auth; drop reports `ok` / `subscription_oauth` | PASS |
| F1 | Visible named tmux lane stays admin-owned; no human window touched (`session.js` untouched) | PASS |
| G1 | Node 20 and Node 22 full suites green | PASS |
| G2 | Focused HTTP / MCP / auth / attestation / fingerprint / session checks green | PASS |
| G3 | Independent skeptical security + concurrency review, findings resolved | PASS — three rounds, two reviewers |
| G4 | Clean feature branch pushed, PR open and ready, CI green | PASS |
| G5 | Contract-pin drift reported, and re-pinned to `aff7a60` once that lane pushed | PASS |

## Increment plan

1. `runner/privilege.js`: user validation, passwd resolution, sudo vetting, invocation builder. ✓
2. `config.js`: `sudoExecutable`, host-mode account validated at load (fail closed at boot). ✓
3. `runner/claude.js`: wrap the exec seam once, so all four launch sites and the fingerprint
   cache drop by construction. ✓
4. `engine.js`: `privilege_drop_failed` → `blocked_configuration`. ✓
5. `test/orch-privilege.test.mjs`: hermetic regressions, including the old behaviour. ✓
6. `test/orch-privilege-real.test.mjs`: real processes, real sudo, real ownership; skips honestly. ✓
7. Suites on Node 20 + 22, focused checks, live root evidence. ✓
8. Independent review, branch, PR, CI. ✓

## Log

### 2026-07-28 — increments 1–7

* **Change.** Added `app/orchestrator/runner/privilege.js` and wired it into `ClaudeCodeBackend` by
  wrapping the injected `exec` once (rather than at four call sites), so the fingerprint cache
  inherits the drop and a launch added later cannot forget it. `config.js` gained
  `PW_ORCHESTRATOR_SUDO_BIN` and validates `PW_ORCHESTRATOR_TMUX_USER` at load in host mode.
  `test/orch-runner.test.mjs` pinned to `PW_DEPLOY_MODE=container`, which is what makes it a
  statement about container mode rather than about whoever runs it.
* **Verification (real signal).** `npm test` — 389/389 on Node 22 and on Node 20.20.2;
  `test/orch-privilege.test.mjs` 27/27; `test/orch-privilege-real.test.mjs` 6/6 both as `admin` and,
  under `sudo`, as a genuine **root → admin** drop; focused orchestrator checks 153/153.
* **Live evidence, run as uid 0 against the real CLI:**

  ```
  OLD (direct exec as root): {"error":"Command failed: …/claude.exe auth status"}
  plan: {"mode":"sudo","sudo":"/usr/bin/sudo","target":{"name":"admin","uid":1000,"gid":1000,"home":"/home/admin"}}
  NEW (host-mode drop): {"state":"ok","method":"subscription_oauth","account_label":"Claude Max","auth_mode":"subscription"}
  fingerprint: {"ok":true,"sha256":"674f61f2…","version":"2.1.220 (Claude Code)","effort":{"declared":true,"values":[…]}}
  ```
* **Next.** Independent skeptical review, then branch/PR/CI.

### 2026-07-28 — increment 8 (independent review, round 1)

Two independent reviewers were asked to **refute** the claim, not confirm it — one on security, one
on concurrency and process lifecycle. Between them they found six things that were true, and the
loop's own tests were among them.

* **`already_target_user` skipped every control at once** (security #1). When the service already
  ran as the configured uid, the launch was returned untouched: no absolute-path requirement, no
  HOME/USER/LOGNAME correction, no billing-env scrub. `sudo -u admin node server.js` (uid 1000,
  `HOME=/root`) therefore reproduced this bug exactly and reported it as a success. Now `no_drop`:
  every host-mode control applies; only the helper is skipped.
* **sudo does not carry an environment through** (concurrency #1). `env_reset` replaces it, so
  `phaseEnv()` was dead code in host mode — proxy settings, CA bundle and locale vanished, and the
  scrub was something sudo's defaults implied rather than something that ran. The launch now names
  `env -i` explicitly and passes the environment as arguments; `dropEnv` falls back to `process.env`
  so a probe with no explicit environment is not handed one with no PATH.
* **Cancellation was reported, not confirmed** (concurrency #2, #3, #4). `execFile` rejects the
  moment it *calls* kill; an abort landing within milliseconds left sudo and the CLI running while
  the job was recorded cancelled. Now signalled, watched and escalated to SIGKILL after a bounded
  grace, with the rejection held until the process is gone. `detached: true` was tried for group
  kills and **made it worse** — an 8 ms abort left sudo alive, and the leaked child kept the runner
  alive for nine minutes; the new sweep test caught it. Attached, relying on sudo's relay.
* **sudo's own refusals read as failed phases** (concurrency #6). `sudo: a password is required`
  reached the operator as "the phase did not complete". Classified as what it is.
* **The forbidden-env list was incomplete** (security #4). `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_EFFORT` and the `ANTHROPIC_*` model family all reached the child.
  Named, plus a prefix rule.
* **The tests proved less than they claimed** (security #2, #3; concurrency #2). The real-process
  suite passed with the drop *removed* when run by the target account; `pgrep -f` matched sudo's own
  argv, so the cancellation test's pre- and post-conditions were both satisfiable with no such
  process ever existing; the fingerprint test pointed at a path that is a wrapper on this host, so
  it asserted a launch count of zero; and the fingerprint cache was injectable, which is how a test
  came to prove something the service does not do.

Also fixed: transient passwd-lookup failures are no longer memoised as permanent refusals; an
ambiguous or malformed passwd entry is refused rather than parsed positionally; the fingerprint
reports a drop failure as itself; concurrent fingerprints share one probe.

**Verification.** Node 22 and Node 20.20.2: 399 tests, 396 pass, 3 skipped (the assertions that
cannot discriminate off-root), 0 fail. Real-process harness 7/7 as root → admin, including the
abort-delay sweep. CI green at `7bd5191`.

**Live evidence, as uid 0 against the real CLI — a real bounded phase, not a stand-in:**

```
uid 0 workspace /tmp/pw-phase-evidence-NnDH36
phase: {"ok":true,"model":"claude-sonnet-5","permission_mode":"acceptEdits","turns":2,"summary":"DONE"}
artifacts: proof.txt uid=1000 gid=1000
root-owned artifacts: 0
```

### 2026-07-28 — increment 9 (independent review, round 2)

Both reviewers were sent the fixes and asked to attack them as new code. Both found that **round 1's
own fix was worse than what it fixed**, from two directions, and independently.

* **The environment was published in argv** (both reviewers). Composing it as `env -i -- NAME=value …`
  put the service's whole environment — orchestrator service tokens, directory credentials — into
  `/proc/<pid>/cmdline`, mode 0444, readable by every local user for the length of a phase. The
  channel it replaced, `/proc/<pid>/environ`, is 0400. Replaced with `--preserve-env=<fixed names>`:
  values travel in sudo's own environment, only names are on the command line, and `PATH` goes back
  to sudoers' vetted `secure_path`. The `env` helper is gone, so the trust chain is sudo again.
* **`LD_PRELOAD` was being re-applied** (security). `env_reset` had been stripping the loader family
  for free; naming the environment turned it into something this service deliberately re-applied,
  which loads code *inside* the binary the fingerprint just attested — the SHA-256 pin then
  describes a file rather than the behaviour that ran. Verified with a real compiled preload
  library, before and after.
* **A SIGTERM-ignoring CLI was orphaned and reported dead** (concurrency). SIGKILL went to the
  helper alone, reparenting the command to init — still writing to the workspace — while the caller
  was told the phase stopped. The tree is now enumerated from `/proc` before the helper is killed,
  every survivor is killed, and `false` is returned honestly when termination cannot be confirmed.
* **The refusal classifier fired on the CLI's stderr** (both). `sudo: unable to resolve host …` is a
  warning real sudo prints on every invocation on a host whose `/etc/hosts` does not name it, so on
  that host class every failed phase became a configuration fault; and reading only the first line
  traded that false positive for a false negative on the same hosts. Now the leading `sudo:` block,
  a narrow refusal pattern, and a refusal exit code.
* **The job summary had become the argv** (concurrency). `execFile`'s message is
  `Command failed: <entire argv>`, so the real error fell off the end of 200 characters and the
  command line was written into the durable record instead. Taken from the CLI's stderr now.

Also fixed: `no_drop` compares gid as well as uid; the termination poll re-checks the child's exit
status so a reaped pid is never signalled; a transient passwd-lookup failure is distinguished from a
refusal; the plan is resolved once per launch.

Accepted and documented rather than fixed: `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` stay preserved, and
the docs now state plainly that together they can redirect and intercept inference — a compatibility
trade-off, not a safe one. `PW_ORCHESTRATOR_CLAUDE_BIN` keeps its non-absolute default and fails
closed with an explicit message.

**Verification.** Node 22 and Node 20.20.2: 404 tests, 401 pass, 3 skipped, 0 fail. Real-process
harness 9/9 as root → admin, now including a world-readable-cmdline regression and a
SIGTERM-ignoring-orphan regression. Live evidence re-run after the mechanism change: `auth status`
→ ok/subscription_oauth, a real bounded phase → `proof.txt uid=1000`, zero root-owned artifacts.
Contract re-pinned to the orchestrator's release-integrity revision `aff7a60` and verified.
CI green at `458fc1d`.

### 2026-07-28 — increment 10 (independent review, round 3) — closed

Both reviewers were asked one last, narrow question: is there anything here that would stop this
shipping. Security: **no**. Concurrency: **no**, with one residual it had reproduced.

* **A tool subprocess outliving the CLI escaped the kill** (concurrency, reproduced). The descendant
  tree was enumerated once, and `ensureTerminated` is first entered *after* `execFile` has already
  sent its own SIGTERM — so by the time a single `/proc` scan finished, the direct child could
  already be gone and its own children reparented to init, unreachable from the helper. The scan
  came back as just the helper, and a live grandchild was reported dead. The tree is now re-read on
  every poll round and accumulated, which also covers anything spawned during the grace. Verified by
  reproducing the reviewer's exact shape as root: before `[2032944]`, after `[]`, confirmed `true`.
* `ensureTerminated`'s verdict is no longer discarded by `wrap()` — it rides on the error, so a
  cancellation that could not be carried out is distinguishable from one that was.
* `sudo: … command not found` added to the refusal pattern: a wrong `PW_ORCHESTRATOR_CLAUDE_BIN` is
  the likeliest misconfiguration of all, sudo reports it rather than the kernel, and it was landing
  as a failed phase. The non-absolute-path message now names the variable to fix.
* Documented: `--preserve-env` is a sudoers dependency alongside NOPASSWD, and a policy refusing it
  fails closed with sudo's own message.

Accepted, not fixed, both explicitly: `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` remain preserved (stated in
the docs as an interception risk kept for compatibility), and host and container mode no longer
compose identical environments — host gets sudo's `env_reset` set plus the fifteen preserved names,
which is the trade for not publishing the service environment in world-readable argv.

**Final verification.** Node 22 and Node 20.20.2: 405 tests, 402 pass, 3 skipped, 0 fail.
Real-process harness 10/10 as root → admin. Live evidence re-run: `auth status` →
`ok`/`subscription_oauth`/Claude Max, fingerprint still matching the pinned SHA with `--effort`
enforceable, and a real bounded phase leaving `proof.txt uid=1000` with zero root-owned artifacts.

## Known, out of scope (flagged)

`app/orchestrator/git.js` and `app/orchestrator/checks.js` also exec as root in host mode — the same
class of root-owned-artifact bug, in `git`/publication and in the project's check commands. Left out
deliberately to keep this change narrow, as agreed; both already take an injectable `exec`, so the
same `PrivilegeDropper` drops straight in. Tracked in the PR body as a follow-up.
