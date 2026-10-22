# Environments — corporate, personal, common

Project Workbench runs in more than one place, and those places disagree about
auth, terminal model, URL prefix, deploy targets and which optional subsystems
may ship at all. This directory is where that disagreement is **declared**, in
exactly three categories:

| Category | What it is | Today |
|---|---|---|
| `common/` | Everything identical everywhere — the trunk that is developed against | the shared code trees, plus every config value that is the same in all environments |
| `corporate/` | The GOA side | container terminal model, directory (LDAP) auth, `/workbench` prefix, Windows Deploy Centre |
| `personal/` | The PVI/PVE side | bare-metal host model, local password auth, served at root, orchestrator + turn outcomes |

`common` is not an environment. It is what every environment inherits.

## The rules, and where they are enforced

All four are checked by `test/env-profiles.test.mjs` against
`app/env-profile.js`. They fail in CI, not in a deploy.

1. **The trunk never knows where it is running.** No file under a `sharedTrees`
   entry may branch on an environment identity — a site, host or organisation
   name. Differences reach shared code as `PW_*` variables only. (Comments
   explaining history are fine; code is not.)
2. **Same everywhere ⇒ `common/`, once.** A value identical in every environment
   lives in the common profile and no environment profile may repeat it.
3. **Different ⇒ the environments, not the trunk.** A value that diverges is
   declared by each environment that sets it and must be absent from `common/`.
4. **A standing "never ship X here" is data.** `forbiddenEnv` in a profile makes
   a decision enforceable: a knob listed there may not appear in that
   environment's own env, nor in `common/` (which it would inherit).

Two supporting rules keep the profiles honest: every `PW_*` name in a profile
must actually be read somewhere in the source tree (no dead configuration), and
no profile may carry a secret **value** — a credential's name is declared in
`secretEnv`, and the value stays in its protected store. This mirrors the
non-secret rule in `app/env-schema.js`.

The gate found three real problems the first time it ran, which is the argument
for it existing: `PW_AUTH_ENFORCE` was declared identically in both environments
(now in `common/`), `PW_DOTNET_CHANNELS` looked dead because the scan did not
cover the Containerfile, and `app/deployment/ui.js` shipped a `GOA\account.name`
placeholder in shared UI (now `DOMAIN\account.name`).

## Evidence levels — read this before trusting a value

Each profile declares `evidence`:

- **`personal` is `verified`** — read on 2026-10-16 from the live instance
  (`systemctl show project-workbench`, the `project-workbench.service.d`
  drop-ins, and `/etc/project-workbench/pw.env`).
- **`corporate` is `reconstructed`** — this workspace cannot reach the GOA
  instance, so its values come from repo source, `DEPLOY.md`'s knob table and
  `DECISIONS.md`. It is a **proposal to confirm**, not a record. Do not generate
  a GOA environment file from it. One `systemctl show project-workbench -p
  Environment` from a GOA operator promotes it to `verified`; the knobs that are
  plausible but unknown are listed separately in `unconfirmedEnv` rather than
  guessed.

## Adding a fourth environment

Add a directory with a `profile.json`, add its category to `CATEGORIES` in
`app/env-profile.js`, and run the test. The gate then tells you what you have
declared twice, what you have left undeclared, and what you are inheriting that
you should not be. Nothing in `app/` changes — that is the whole point of rule 1.

## What is declared here but has not moved yet

This directory currently classifies; it does not yet own the files. The
remaining physical overlaps, in the order worth doing them:

1. **`install.sh` (38 KB) is the personal installer in all but name.** It hard
   refuses `PW_DEPLOY_MODE=container` at `install.sh:34`. Split it into a common
   installer plus `environments/personal/install`, which passes this profile.
   Tier 3 (deployment controls) — the one step that needs real gates.
2. **`deploy/host/` is the corporate overlay, misleadingly named.** Its README
   opens "GOA deployment — host hooks"; it holds the podman-host hooks that strip
   the image's `NOPASSWD` sudo grant and restore the .NET/smbclient toolchain.
   It should become `environments/corporate/hooks/`. The name collision — a
   directory called `host` serving the *container*-mode environment — is the
   clearest evidence the current split is by technology rather than by
   environment.
3. **Render the environment file from the profiles.** `/etc/project-workbench/pw.env`
   is already generated and non-secret; generating it from
   `environments/<category>/profile.json` via `mergedEnv()` closes the last gap
   between what the repo says an instance runs and what it runs.
4. **`app/orchestrator/config.js` defaults `role` to `pvi2-orchestrator`** — a
   live instance name in shared code, and the single exemption in the trunk test.
   Neutralising it changes a running value, so it wants its own change, not a
   drive-by.
5. **`deploy/` is a mixed tree, and this is the next real overlap.** Alongside
   `deploy/host/` (item 2), `deploy/migrate-tmux-owner.sh` is a corporate-only
   migration, and `deploy/promote-app.sh` hard-codes the preflight "turn outcomes
   must stay off on GOA" — a standing rule about one environment, written in shell,
   in a script that ships to all of them. That rule is **already** `forbiddenEnv`
   in `environments/corporate/profile.json`, so it is now stated twice in two
   languages and only one copy is gated. `deploy/` cannot join `enforcedTrees`
   until the corporate parts move out; that is what makes it worth doing.

## Decided: the container artifacts are common mechanism (2026-10-22)

James-direct, after the question was put badly the first time. The root
`Containerfile`, `systemd/` and `deploy/container/` **stay in the trunk.**

`PW_DEPLOY_MODE` is a *mechanism* axis — how an instance is hosted — and
corporate/personal is an *environment* axis. They correlate today, because the
corporate instance runs container mode and the personal one runs host mode, but
that is a fact about two deployments, not a property of the code. Rule 1 forbids
the trunk branching on **who** is running it; branching on **how** it is deployed
is what the trunk is for, and it already does so deliberately: CI runs the whole
suite in both modes on every push, eleven container test files live in the shared
`test/` tree, and `install.sh:34` refuses container mode out loud rather than
inventing a partial topology. Moving these under `environments/corporate/` would
make CI test an overlay from the trunk, orphan those tests, and freeze today's
correlation into the structure the model exists to prevent.

Two corrections to the question as originally posed:

- **`deploy/container/` was never a candidate.** It is the client-app deploy
  service — `builder-relay.py`, `runtime-relay.py`, podman, the .NET channels —
  a product capability for deploying *projects* into containers. It has nothing
  to do with how PW itself is hosted.
- **Both remaining files already said so.** `Containerfile:8` calls itself "the
  generic base. Environment-specific extras ... are optional and left commented
  below"; `systemd/pw-tmux.service` says "HOST ALIASES ARE CONFIGURATION, NOT
  CONTENT. This unit ships to every deployment, so it carries the MECHANISM and
  none of the values." The structure was right; the enforcement was not.

So the artifacts stayed and the **gate** moved instead: `systemd/` is now a
shared *and* enforced tree, and the trunk identity scan no longer looks only at
`.js`/`.mjs` — it reads units, Containerfiles and shell hooks too. That narrower
filter is why `systemd/pw-tmux.service` sat here pointing `Documentation=` at one
environment's fork, in the very unit that claims to carry no values; it now
points at the canonical origin, and the gate fails if it drifts back.

One thing deliberately left alone: `Containerfile:52` keeps a commented, clearly
labelled `Example (GOA):` Kerberos realm. The scan strips comments by design — a
comment does not make the trunk *branch* on anything — and that example is a
useful recipe sitting exactly where someone configuring it would look. Removing
it would cost a reader something and gain nothing.
