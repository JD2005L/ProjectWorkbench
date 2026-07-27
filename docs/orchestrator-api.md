# The orchestration API

ProjectWorkbench can expose a **constrained, versioned interface** that lets an external
orchestrator delegate coding work to it — submit a task contract, watch evidence arrive, answer a
question, record an approval, and request an approval-gated publication.

ProjectWorkbench remains the sole owner of repositories, worktrees, coding CLI sessions, tests,
builds, reviews, git and publication evidence. The orchestrator reasons and supervises; it never
gains arbitrary shell, file read, credential, user-admin, merge, deploy, delete, history-rewrite or
production-control powers. That boundary is structural, not a convention — see
[What this interface cannot do](#what-this-interface-cannot-do).

> **Off by default.** Nothing in this document happens unless an operator turns it on. A
> ProjectWorkbench upgrade opens no store, takes no lock, creates no directory and changes no
> existing route until `PW_ORCHESTRATOR_ENABLED=true`.

The normative specification is the orchestrator's `docs/pw-contract.md`. This document covers the
ProjectWorkbench side: how to enable it, what it guarantees, and how to upgrade and roll back.

---

## 1. Enabling it

Three things are required: an instance identity, a project grant, and a service token.

### 1.1 Instance identity

```bash
# /etc/project-workbench/orchestrator.env  (or a systemd drop-in)
PW_ORCHESTRATOR_ENABLED=true
PW_ORCHESTRATOR_INSTANCE_ID=pvi2-ct2115      # this deployment's identity — never inferred
```

The instance id has **no default and is never guessed from the hostname**. If it is missing or
malformed while the subsystem is enabled, the subsystem refuses to start and logs why; the dashboard
carries on serving human terminals regardless. Failing to boot is correct here — silently serving
under a guessed identity would let one deployment accept work intended for another.

### 1.2 Projects and capabilities

Copy [`config/orchestrator-projects.example.json`](../config/orchestrator-projects.example.json) to
`/etc/project-workbench/orchestrator-projects.json`.

An absent capability means **not offered**, never "assume yes". `verification_commands` are run with
**no shell**, so `a && b` and pipelines do not work — point at a script instead. That is deliberate:
a shell here would make every configured command an injection surface for anything that can
influence configuration.

### 1.3 The service token

```bash
TOKEN=$(openssl rand -hex 32)            # give this to the orchestrator
printf %s "$TOKEN" | sha256sum           # put this digest in the tokens file
```

Copy [`config/orchestrator-tokens.example.json`](../config/orchestrator-tokens.example.json) to
`/etc/project-workbench/orchestrator-tokens.json`, `chmod 0600`, and paste the digest. Only the
digest is stored — the token itself never touches the ProjectWorkbench filesystem.

**Scopes are separable on purpose.** `jobs:read`, `jobs:write`, `session:manage`, `publish` and
`approve`. Give the orchestrator's token everything except `approve`, and hold `approve` on a
separate credential used by whatever records human decisions — otherwise one credential can request
work, approve it, and publish it. The default configuration refuses that combination even when both
scopes are present on one token, because the submitting credential may not approve its own job.

**Rotation needs no outage.** Several live tokens are accepted at once: add the incoming token, move
the orchestrator across, then set `"disabled": true` on the outgoing entry rather than deleting it,
so the audit trail survives the rotation. The file is re-read whenever it changes on disk — no
restart, no redeploy.

### 1.4 Everything else

Every path, name, limit and identity is configurable, with the contract's §5 conventions as
defaults. A deployment with different conventions is *configured*, never patched.

| Variable | Default | Purpose |
|---|---|---|
| `PW_ORCHESTRATOR_ENABLED` | `false` | Master switch |
| `PW_ORCHESTRATOR_INSTANCE_ID` | _(none)_ | This workbench's identity. Required when enabled |
| `PW_ORCHESTRATOR_BASE_PATH` | `/api/orchestrator/v1` | HTTP mount point |
| `PW_ORCHESTRATOR_TOKENS_PATH` | `/etc/project-workbench/orchestrator-tokens.json` | Service tokens |
| `PW_ORCHESTRATOR_PROJECTS_PATH` | `/etc/project-workbench/orchestrator-projects.json` | Project grants and capabilities |
| `PW_ORCHESTRATOR_DATA_DIR` | `/var/lib/project-workbench/orchestrator` | Durable state root |
| `PW_ORCHESTRATOR_JOURNAL` | `<data>/orchestrator.journal` | Write-ahead journal |
| `PW_ORCHESTRATOR_SNAPSHOT` | `<data>/orchestrator.snapshot.json` | Compaction snapshot |
| `PW_ORCHESTRATOR_LOCK` | `<data>/orchestrator.lock` | Cross-process writer lock |
| `PW_ORCHESTRATOR_ARTIFACT_DIR` | `<data>/artifacts` | Evidence (logs, diffs, reports) |
| `PW_ORCHESTRATOR_WORKTREE_DIR` | `<data>/worktrees` | Isolated job worktrees |
| `PW_ORCHESTRATOR_AUDIT_LOG` | `/var/log/project-workbench/orchestrator-audit.log` | Audit trail |
| `PW_ORCHESTRATOR_ROLE` | `pvi2-orchestrator` | Lane role marker |
| `PW_ORCHESTRATOR_WINDOW` | `orch_pvibot` | Reserved tmux window |
| `PW_ORCHESTRATOR_TMUX_PREFIX` | `pw_` | tmux session prefix |
| `PW_ORCHESTRATOR_DISPLAY_PREFIX` | `pvibot-orchestrator-` | CLI display-name prefix |
| `PW_ORCHESTRATOR_TMUX_SOCKET` | _(empty)_ | Alternate tmux server; used by tests |
| `PW_ORCHESTRATOR_CLAUDE_BIN` | `claude` | Coding CLI executable. Must be an **absolute path to the real binary** for launch enforcement — not the PW wrapper on `PATH`, which rewrites argv |
| `PW_ORCHESTRATOR_GIT_BIN` / `_GH_BIN` | `git` / `gh` | Git and GitHub CLI |
| `PW_ORCHESTRATOR_MAX_BODY_BYTES` | `1048576` | Request body ceiling |
| `PW_ORCHESTRATOR_RATE_LIMIT` | `120` | Requests per minute per credential |
| `PW_ORCHESTRATOR_LEASE_TTL_MS` | `300000` | Project write-lease lifetime |
| `PW_ORCHESTRATOR_BACKEND_TIMEOUT_MS` | `1800000` | Per-phase ceiling |
| `PW_ORCHESTRATOR_CHECK_TIMEOUT_MS` | `900000` | Per-check ceiling |
| `PW_ORCHESTRATOR_MODEL_ALIASES` | measured defaults | JSON `alias -> [model ids]`; a `*` suffix matches a dated release. Setting it REPLACES the defaults. See [§4](#4-attestation-provenance-what-effective-actually-means) |
| `PW_ORCHESTRATOR_CLI_SHA256` | _(unpinned)_ | Pin the coding CLI's content hash; a binary that differs is refused rather than re-fingerprinted |
| `PW_ORCHESTRATOR_CONFIG_GENERATION` | `0` | Bump when the executable, aliases or enforcement policy change, so old evidence cannot be replayed across the change |
| `PW_ORCHESTRATOR_REQUIRE_SEPARATE_APPROVER` | `true` | Refuse an approval from the credential that submitted the job |

The subsystem reuses the dashboard's existing `PW_WORKSPACES` for the workspace root, so there is
one source of truth for where project checkouts live.

---

## 2. What this interface cannot do

The tool surface is **closed**, and the closure is the control rather than a description of current
scope:

- **No shell, no file read, no directory listing, no path parameter.** The only way to name remote
  content is an opaque `artifact_id` ProjectWorkbench issued. Adding a capability takes an explicit
  edit to `ALLOWED_TOOLS`, which an import-time invariant and the test suite both check.
- **Destructive git is unreachable.** `reset`, `checkout`, `restore`, `clean`, `stash`, `rebase`,
  `merge`, `revert` and history rewriting are not merely unused — `app/orchestrator/git.js` refuses
  them, along with options that would turn a permitted subcommand destructive (`--force`, `-D`, a
  deleting refspec, a leading `-c`). This is what makes "cancellation preserves the working tree" a
  guarantee rather than an intention.
- **No merge, no deploy, no delete.** Publication opens a pull request. Nothing merges it.
- **No API-billed inference.** Only subscription OAuth is representable; `claude auth status` is
  checked and an API-key or Bedrock/Vertex provider is refused outright. The child process
  environment is stripped of `ANTHROPIC_API_KEY` and friends.
- **MCP sampling is not advertised.** A server declaring the sampling capability can ask its *client*
  to run inference on its behalf, which would invert the control direction the product depends on.
  Resources and prompts are empty for the same reason.
- **Review cannot write.** Planning, discovery and review phases run in the CLI's `plan` permission
  mode; `bypassPermissions` appears nowhere.
- **One credential cannot request work and approve it.** Recording a decision needs its own
  `approve` scope, and by default the credential that submitted a job may not approve it
  (`PW_ORCHESTRATOR_REQUIRE_SEPARATE_APPROVER`). ProjectWorkbench cannot verify that a human was
  involved — it sits at the far end of a machine-to-machine interface, and the decision is recorded
  on the orchestrator side. What it can do is refuse to invent a decider, record decider and relayer
  as separate facts in the audit, and make self-approval a deliberate configuration change rather
  than the default.

---

## 3. Guarantees worth knowing before you rely on them

**Evidence, not narrative.** A phase result is the model's account of what it did. What the
orchestrator receives is exit codes, `git diff --numstat` output, and artifact references. Events
asserting progress (`check_completed`, `diff_observed`, `review_completed`, `publication_recorded`,
`deployment_recorded`) are *rejected at write time* without corroboration, so a bare claim can never
be read back later as though it had been evidenced.

**A max-turn exit is a failure.** So are timeouts and unparseable output. Each reaches a distinct
blocked state, because each needs a different operator response.

**Publication is verified, not assumed.** `remote_sha_verified` is true only after the remote ref has
been fetched and the full forty-character SHAs compared. A successful `git push` exit code is not
that comparison. Only the intended files are staged, and the staged set is compared against the
intended set *before* committing, so a pre-existing index entry cannot ride along. `git commit` is
never given `-a`.

**A blocked job is not a failed job.** Work is preserved, the lease is released, and the job can be
resumed once the condition clears — and resumption re-enters the readiness chain rather than jumping
to where it stopped, because whatever blocked it may have changed the world in the meantime.

**Publication never touches the operator's index.** Staging happens in a private copy of the index,
so a failed publication is a no-op on whatever the operator had staged. That matters because
`git.js` forbids `reset` and `restore` precisely so nothing here can discard work — which also means
nothing here could undo a partial stage. Comparison uses `-z --no-renames`, so a rename or a
non-ASCII filename (`café.txt`, which git otherwise quotes as `"caf\303\251.txt"`) publishes
correctly instead of failing as a spurious mismatch.

**Cancellation stops the work.** The running phase is signalled, not waited out, and the working-tree
fingerprints are taken either side of that — so `working_tree_preserved` reflects what happened
rather than racing a still-running writer.

**Crash safety.** State lives in an append-only write-ahead journal with a CRC per transaction. A
torn final record is discarded as a crash; a bad record with good records after it is corruption, and
the store refuses to open rather than silently losing durable evidence. On start, any job recorded as
holding the workspace is moved to `blocked_project_state` with its lease released — reconciled
against reality, never resumed on an assumption about what a dead process had finished.

**Human windows are never touched.** A window is the orchestrator's lane only if it carries the role
marker this service set. A window merely *named* `orch_pvibot` is refused — including under
`force_replace` — because killing a window the service cannot prove it owns is the exact failure the
contract exists to prevent.

---

## 4. Attestation provenance: what "effective" actually means

Contract §6 requires ProjectWorkbench to report what is *actually* active and to be able to say "I do
not know". Probing the installed CLI (Claude Code 2.1.220) shows the two halves of `ModelSettings`
are known with genuinely different strength, so the contract names the difference rather than
flattening it.

| provenance | meaning |
|---|---|
| `runtime_reported` | The running backend emitted the value in its own structured output, normalised through a recorded mapping. **An observation.** |
| `launch_enforced` | Nobody observed it. ProjectWorkbench owned the argv, the exact fingerprinted binary advertises the option *and the value*, the run emitted no ignored-option warning, and the evidence is bound to this run. **Chain of custody over an input.** |
| `unavailable` | Neither. Always blocking, never a default. |

A record is described by its **weakest** field. Describing it by the strongest would let one observed
value launder an unobserved one.

### What the installed CLI supports

**Model is `runtime_reported`.** The `system/init` event carries the live model — as a *resolved id*,
not the alias that was requested:

| requested | reported |
|---|---|
| `sonnet` | `claude-sonnet-5` |
| `opus` | `claude-opus-5` |
| `haiku` | `claude-haiku-4-5-20251001` |

so attestation goes through a configured `alias -> ids` mapping (`PW_ORCHESTRATOR_MODEL_ALIASES`),
and the normalization that produced it travels with the claim. An alias is never compared to itself.

**Effort is `launch_enforced`.** The init event has no effort field of any kind, so it cannot be
observed. But `--help` declares:

```
  --effort <level>    Effort level for the current session
                      (low, medium, high, xhigh, max)
```

which is enough to *enforce* it. Every one of these must hold, or no attestation is produced at all
and the job blocks:

1. the configured executable is an **absolute path** — a PATH lookup is the operator's environment,
   not ours;
2. it is **not a shell wrapper**. This is not hypothetical: ProjectWorkbench's own installer puts
   `/usr/local/bin/claude` on `PATH`, and that script sources `claude-wrapper.env` and appends
   `--permission-mode`, `--mcp-config` and `--strict-mcp-config` before exec'ing the real binary. A
   launch through it is not a launch we control. Configure the real binary
   (`/bin/claude` → `…/claude-code/bin/claude.exe`);
3. its content SHA-256 matches `PW_ORCHESTRATOR_CLI_SHA256` when one is pinned;
4. its own `--help` declares `--effort` **and lists the exact value** — the CLI accepts an
   unrecognised `--effort` with only a stderr warning and runs at its default, so "the option exists"
   is not enough;
5. the run emitted no ignored-option warning;
6. the argv came from the fixed server-side builder (`pw-claude-phase-argv-v1`) with no caller
   override — if a caller could put anything on the command line, the argv digest would attest to the
   caller's intent rather than to policy;
7. the session is subscription authenticated (`apiKeySource: none`);
8. the caller **bound** its request. `VerifySessionRequest` carries `run_id` and
   `config_generation`; a peer that sends the default `unbound` has not said which run it is asking
   about, so nothing can be attested to one.

`xhigh` is now a contract effort on both sides: the binary advertises it, and a policy that cannot
name a level the binary supports would silently round down to `high`.

### What is published, and where

`SessionVerificationResponse` carries a `SettingsAttestation` and **derives** `effective` from it.
ProjectWorkbench never sends `effective` as a field — the contract refuses such a payload rather than
reading it as an observation, because an older peer never distinguished a value it watched from one
it merely passed on the command line.

The `LaunchAttestation` inside it names the binary (realpath, self-reported version, a digest of its
advertised capability surface), the advertised options and values, the argv builder id and a digest
of the exact argv, `caller_controlled_argv: false`, `auth_mode`, any ignored-option warning, and the
session/run/configuration-generation binding. No credential appears in any of it. `GET /readiness`
publishes the same capability summary so an orchestrator can see the kind of evidence an instance
produces *before* submitting work.

Fingerprints are cached on the binary's own identity (realpath, device, inode, size, mtime), so the
~1 s hash of a 275 MB binary happens once and **any** change to the file misses the cache rather than
being trusted. A failed probe is never cached: it may be a partially written upgrade.

## 5. The contract fixture

[`contract/pw-contract-1.0.json`](../contract/pw-contract-1.0.json) is a machine-readable description
of the whole surface: endpoints, MCP tools, every enum, the full transition table, the error map, the
limits, and the safety guarantees. It is **generated from the implementation's own vocabularies**, so
it cannot drift:

```bash
node scripts/orch-contract-fixture.mjs --write   # regenerate after changing an enum
```

A test fails if the committed file differs from what the code produces, and further tests compare the
enums, state families, transition table, error codes and tool set member-for-member against the
orchestrator's own Pydantic models where that repository is available.

---

## 6. Install, upgrade, rollback

### Install

The subsystem ships with ProjectWorkbench; there is nothing extra to install. It has **no new runtime
dependency** — `app/package.json` still declares only `express`. Storage is a purpose-built journal
rather than SQLite because the installer bootstraps Node 20 and CI pins Node 20, while `node:sqlite`
needs 22.5+ and a native module would put a build toolchain on every deployment host.

```bash
sudo install -d -m 0750 -o admin -g admin /var/lib/project-workbench/orchestrator
sudo install -m 0600 -o admin -g admin \
  config/orchestrator-tokens.example.json /etc/project-workbench/orchestrator-tokens.json
sudo install -m 0640 -o admin -g admin \
  config/orchestrator-projects.example.json /etc/project-workbench/orchestrator-projects.json
# edit both, then set the environment variables and restart the dashboard
sudo systemctl restart project-workbench
```

Confirm it came up:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/orchestrator/v1/health
```

### Upgrade

Schema migrations live in `MIGRATIONS` in `app/orchestrator/index.js` and run inside a transaction on
open, one per migration, recording the schema version durably. An interrupted upgrade resumes at the
first migration that did not commit.

Opening a store written by a **newer** schema than the running build understands fails closed, so a
rolled-back binary refuses to start rather than writing records the newer schema would misread.

Migrations are append-only: never edit a released one.

### Rollback

1. Set `PW_ORCHESTRATOR_ENABLED=false` and restart. The dashboard is unaffected — human terminals,
   previews, the inbox and tmux persistence do not depend on any of this.
2. Durable state stays on disk. Nothing is destroyed by disabling the subsystem.
3. To roll back the ProjectWorkbench build as well, disable first, then downgrade. If the store was
   written under a newer schema the older build will refuse to open it; move
   `$PW_ORCHESTRATOR_DATA_DIR` aside to start clean, keeping the old directory for forensics.

In-flight jobs are safe across all of this: on the next start every job recorded as holding the
workspace is reconciled to `blocked_project_state` with its lease released.

### Backup

Back up `$PW_ORCHESTRATOR_DATA_DIR` (journal, snapshot, artifacts). The journal is append-only and
the snapshot is written atomically, so a copy taken while the service is running is consistent up to
the last completed transaction. Do **not** back up the tokens file alongside it into anywhere less
protected than `0600`.

---

## 7. Operating it

### Health and readiness

`GET /health` reports the instance, contract version and coding-backend authentication, with no
secrets — no account address, no org id, no token. `GET /readiness` additionally reports the store,
queue and runner components, and is degraded rather than down when the backend is signed out, because
every mutation will then fail closed and an operator needs to know before submitting work.

### Audit

Orchestration actions append to the dashboard's existing audit log with the credential's `token_id`,
the orchestrator instance, and the correlation id — never the token.

```bash
sudo tail -F /var/log/project-workbench/audit.log | grep orchestrator
```

### Watching a job

The orchestrator lane is a real tmux window inside the project's own session, so an operator watching
the dashboard sees the work in the same place they see their own:

```bash
tmux list-windows -t pw_<Project> -F '#{window_name} #{@pw_role}'
```

A window with an empty `@pw_role` is a human's and is never touched by this subsystem.

### MCP over stdio

```bash
PW_ORCHESTRATOR_ENABLED=true \
PW_ORCHESTRATOR_INSTANCE_ID=<id> \
PW_ORCHESTRATOR_SERVICE_TOKEN=<token> \
  node bin/pw-orchestrator-mcp.mjs
```

The same engine, the same authorization, the same closed tool set. Note that the HTTP surface and the
stdio adapter both take the **single-writer lock** on the durable store, so they cannot run against
the same data directory simultaneously — run the MCP adapter against its own `PW_ORCHESTRATOR_DATA_DIR`,
or reach the running instance over HTTP instead.

---

## 8. Testing

```bash
cd app && npm test                       # the whole suite, including test/orch-*.test.mjs
```

The orchestration tests use a deterministic fake backend, disposable git repositories with real
remotes, temporary stores, and a **private tmux server on its own socket**. They never touch a live
project, the live tmux server, or the operator's OAuth session, and they spend no subscription quota.
Tests that need `git` or `tmux` skip cleanly when it is absent rather than failing.
