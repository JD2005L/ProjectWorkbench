# Deploy credentials: instance-level, per target, overridable per project

Status: **spec, not built.** Decisions needed from the operator are collected at
the end; everything before that is implementable as written.

## Why

Today a deploy runs as **the person who clicked it**. `DEPLOY_USER` /
`DEPLOY_PASSWORD` come from that user's row in Settings ▸ Users, so the Windows
account that copies files over SMB, drives IIS over WinRM and opens SQL for
migrations is a human being's own account.

That has three consequences this instance has already paid for:

1. **Only one person can deploy some projects.** AITDataHub and SponsorPortal pin
   `DB_MIGRATION_PRINCIPAL='GOA\james.levac'` in their own repositories, because
   the migration binds as the deploying user and only that account holds the
   migrator role on their databases. Every other operator is refused before
   publishing (`deploy-prod.sh:85`). On 2026-09-22 a second operator hit this on
   both projects; the only remedies were a per-person SQL grant or a repo edit.
2. **Personal grants accumulate.** Letting a second and third operator deploy
   means granting each of them `CREATE TABLE`/`ALTER` on production databases —
   standing personal privilege that outlives the deploy and the project.
3. **Read-only probes needed a credential too.** The version check in the Deploy
   panel authenticates to the app server, so it used to fall back to "the first
   user who happens to have a deploy password saved" — a colleague's account,
   invisible in the audit log. That fallback is gone (`app/server.js`
   `getDeployEnv`), which leaves operators without their own credential seeing no
   version at all. A shared credential removes the dilemma.

The goal: the **identity a deploy runs as** becomes a property of the workbench
and the target, not of the person. The **person** remains recorded, in PW's audit
log and in a new environment variable the scripts can print.

## Non-goals

- Replacing per-user credentials. A user's own deploy password stays as the
  final fallback, so nothing changes until a shared credential is saved.
- Granting anyone new access to a project. Existing project grants still decide
  who may press Deploy; this decides *what identity the press runs as*.
- Password rotation automation, AD account creation, or SQL grants. Those are
  operator/DBA actions outside this workbench.

## The model

Three levels, most specific first:

| Level | Where it is set | Scope |
|---|---|---|
| **Project override** | Deploy panel ▸ slot config (admin only) | one project, one target |
| **Instance default** | Settings ▸ Deployment (admin only) | every project, one target (`dev` or `prod`) |
| **Operator credential** | Settings ▸ Users ▸ the person's own row | whoever clicked, as today |

`dev` and `prod` are configured separately and never share a credential: a
production account must not be usable from a development slot, which is the whole
point of having two.

### Resolution

```
resolveDeployIdentity(project, target, operator):
    for candidate in [projectOverride(project, target),
                      instanceDefault(target),
                      operatorCredential(operator)]:
        if candidate is absent:            continue        # not configured: fall through
        if candidate is unreadable:        FAIL LOUDLY     # never fall through
        return candidate
    return none                                            # scripts that need no credential still run
```

Two rules make this safe:

- **Absent falls through, unreadable does not.** A saved credential this server
  cannot decrypt (rotated `.secret-key`, a config copied between instances) must
  never silently degrade to the next level, and never to an empty password — that
  exact collapse is what made a slot script report "no password supplied" while
  the Users screen showed the credential as set. Reuse
  `app/deploy-credential.js` (`readStoredDeployPassword`), whose states are
  already `none` / `stored` / `unreadable`, and fail with the level named:
  *"The production deploy credential saved for this workbench cannot be read.
  An administrator must re-enter it in Settings ▸ Deployment."*
- **No borrowing across people.** The operator level only ever reads the
  clicking user's own row — never another user's, in any code path.

### What the slot script sees

| Variable | Today | After |
|---|---|---|
| `DEPLOY_USER` | the person who clicked | the **effective** deploy account (service account, or the person if that is what resolved) |
| `DEPLOY_PASSWORD` | their password | the effective account's password |
| `DEPLOY_OPERATOR` | — | **new**: the PW username who pressed Deploy, always |
| `DEPLOY_IDENTITY_SOURCE` | — | **new**: `project` \| `instance` \| `operator` |
| `DEPLOY_PROJECT`, `DEPLOY_TARGET` | as today | unchanged |

Keeping `DEPLOY_USER` as the *effective* identity means no slot script has to
change to benefit. `DEPLOY_OPERATOR` is what a script prints into its own output
("published by kevin.charlebois as GOA\svc-pw-deploy-prod"), and what a project
that wants to restrict who may trigger a release can test — separately from what
the deploy authenticates as.

## Storage

### Instance defaults — `/etc/project-workbench/workbench.json`

Alongside the existing `deployment` block, which already carries an encrypted
service token and is validated fail-closed:

```json
{
  "deployment": { "backend": "local", "endpoint": "", "credential": "" },
  "deployCredentials": {
    "dev":  { "user": "GOA\\svc-pw-deploy-dev",  "password": "enc:…", "note": "AIT dev IIS + dev SQL" },
    "prod": { "user": "GOA\\svc-pw-deploy-prod", "password": "enc:…", "note": "AIT prod IIS + prod SQL" }
  }
}
```

- Written through `createWorkbenchSettingsStore` with its own `updateDeployCredentials()`
  under the same lifecycle lock as `updateDeployment()`, so a credential rotation
  and a general settings save cannot clobber each other. `updateGeneral()` already
  copies only keys present in `defaults` and explicitly skips `deployment`; the new
  key must be skipped the same way.
- Validated with the module's `fields()` allow-list: `user` a non-empty string
  matching `^[A-Za-z0-9._\\-]{1,128}$` (optionally `DOMAIN\user`), `password`
  either `''` or `^enc:[A-Za-z0-9+/]+={0,2}$`, `note` an optional ≤200-char
  string. Anything else is a fail-closed 503, as saved deployment settings are
  today — a malformed credential block must not silently mean "no credential".
- Encrypted with `makeSecretCrypto` (AES-256-GCM, `enc:` prefix, key
  `/etc/project-workbench/.secret-key`), identical to user deploy passwords and
  GitHub tokens.
- `publicWorkbenchSettings()` must expose **state, never the secret**:
  `{ dev: { user, note, password: 'stored' }, prod: { … } }` with `none` /
  `stored` / `unreadable` — the same vocabulary the Users screen now uses.

### Project overrides — `/etc/project-workbench/deploy-config.json`

```json
{ "AITDataHub": { "prod": { "script": "…", "versionCmd": "…",
                            "deployCredential": { "user": "GOA\\svc-aitdatahub-prod", "password": "enc:…" } } } }
```

Not `projects.json`: that file is mode **0644** (any account on the box can read
it), while `deploy-config.json` is **0600 root**. Ciphertext without the key is
not usable, but a credential does not belong in a world-readable file, and the
slot's other deploy fields already live here. The Deploy panel's slot config
section is the UI home, which is what "project settings" means to the operator.

`POST /api/deploy/config` already spreads the existing target object when saving
a script, so an override survives ordinary script edits — the same property that
keeps `runAsRoot` alive today.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/deploy/credentials` | — | admin only; returns `{dev,prod}` state + `user` + `note`, never a password |
| `POST` | `/api/deploy/credentials` | `{target, user, password?, note?}` | admin only; empty `password` keeps the stored one; `{clear:true}` removes |
| `POST` | `/api/deploy/config` | `…, deployCredential:{user,password}\|null` | existing route, extended; `null` clears the override |

All three are mutating-origin-checked like the rest of the Deploy Centre, and
each writes an audit record: `deploy_credential_set` /
`deploy_credential_cleared` with `{scope:'instance'|'project', project?, target,
user}` — the account name, never the secret. A deploy's own audit record gains
`identitySource` and the effective `deployUser`, so the log answers "who pressed
it, and what did it run as" in one line.

## UI

**Settings ▸ Deployment** gains two cards, Development and Production:

```
Development deploy account
  Account   [GOA\svc-pw-deploy-dev        ]   state: set
  Password  [••••••••  (leave blank to keep)]   [Clear]
  Note      [AIT dev IIS + dev SQL         ]
  Used by 11 dev slots · 1 project overrides this
```

**Deploy panel ▸ slot config** (admin only, per slot) gains:

```
Deploy identity  ( ) Inherit instance default — GOA\svc-pw-deploy-prod
                 (•) Override for this slot
                     Account [GOA\svc-aitdatahub-prod]  Password [•••]  [Clear]
```

State pills reuse the users table's vocabulary and colours, including the red
**unreadable** pill: a credential the server cannot decrypt must look wrong
wherever it is shown, not merely "set".

Where a slot resolves to the operator's own account (nothing configured), the
panel says so — *"runs as your own Windows account"* — because that is a
materially different thing to press.

## Re-authentication still verifies the human

`reauth: true` on a slot means "prove the person is present", and that does not
change: PW verifies the **operator's** directory password (`resolveDeployReauth`,
`authenticate()`), while the deploy authenticates to the app server as the
resolved service account. The two were the same value before only by accident.
The prompt copy needs to say which is which, or an operator typing their own
password into a prompt for a `svc-` deploy will reasonably wonder what it is for.

## Version probes

`versionCmd` uses the same resolution. That closes the gap left by removing the
borrowed-credential fallback: with an instance credential configured, every
operator sees real versions, and no probe ever runs as a colleague.

## What this lets the projects do

AITDataHub and SponsorPortal can pin their migration principal to the **service
account** instead of a person:

```bash
DB_MIGRATION_PRINCIPAL='GOA\svc-pw-deploy-prod'
```

One SQL grant per database, to one non-human principal, and every authorised
operator can deploy — no personal `CREATE TABLE` on production, no repo edit when
staff change. TeamCanadaStrong's `deploy-dev.sh` already refuses the *runtime*
app-pool account (`GOA\AIT-DBService.S`); the deploy service account must be a
third identity, distinct from both the humans and the runtime account, so a
compromised web app still cannot migrate its own schema.

## Accounts and grants to request (operator/DBA work, outside this workbench)

Two AD accounts, non-interactive, password non-expiring or rotated on a schedule
PW can follow:

| Need | Why |
|---|---|
| SMB write to each site's deployment share | `smbclient` file copy step |
| WinRM / remote PowerShell on the target web hosts | IIS stop/start, app-pool control, health probe |
| IIS app-pool control on those sites | steps 2 and 5 of every slot script |
| SQL: the project's migrator role on each database it deploys | step 3c, `dbo.__SchemaVersions` + DDL |
| **Not** interactive logon, **not** local admin, **not** the runtime app-pool identity | blast-radius containment |

Dev and prod accounts must be separate, and the prod account must have no rights
in dev or vice versa.

## Security caveats, stated plainly

- **An instance prod credential is a privilege grant to everyone who can press
  Deploy on any project with a prod slot.** That is the trade: fewer personal
  grants, but a wider set of people able to act as one powerful account.
  Mitigations already available: project grants decide who sees a slot at all;
  `reauth: true` forces a fresh password prompt per prod deploy; the audit log
  names the operator; a project can override with a narrower account. Consider
  requiring `reauth` on any prod slot that resolves to an instance credential.
- **Config backups carry the ciphertext.** `deploy/promote-app.sh` tars
  `/etc/project-workbench` before an app promote. Those tars must stay 0600, and
  a `.secret-key` rotation invalidates every stored credential at once — which
  the `unreadable` state now surfaces instead of hiding.
- **No plaintext path.** The password is decrypted in-process for exactly one
  `execFile` env and never written to disk, the deploy log, or an audit record.
  A test should assert that (`test/deploy-route.test.mjs` already boots a real
  instance and can grep the log it writes).

## Tests to write

| Test | File |
|---|---|
| precedence: project → instance → operator, per target | new `test/deploy-identity.test.mjs` (unit, pure resolver) |
| `unreadable` at any level fails loudly and never falls through | same |
| dev credential is never used for a prod slot | same |
| `GET /api/deploy/credentials` never returns a password, in any state | `test/deploy-route.test.mjs` |
| non-admin cannot read or write either scope | `test/deploy-route.test.mjs` |
| saving a slot script preserves an existing override | `test/deploy-manifest-route.test.mjs` |
| `DEPLOY_OPERATOR` is the clicker while `DEPLOY_USER` is the service account | `test/deploy-route.test.mjs` (slot script echoes both) |
| the secret appears in no log, audit line or deploy output | `test/deploy-route.test.mjs` |
| settings round-trip: malformed `deployCredentials` is a fail-closed 503 | `test/deploy-service-pw-settings.test.mjs` |

## Rollout

1. **Resolver + storage + env** (`DEPLOY_OPERATOR`, `DEPLOY_IDENTITY_SOURCE`).
   No behaviour change until a credential is saved: with none configured, every
   slot resolves to the operator exactly as today.
2. **Settings ▸ Deployment UI** and the two API routes. At this point one AD
   account per target unblocks every operator on projects whose scripts pin the
   service account.
3. **Per-project override** in the slot config section.
4. Hand the project agents the one-line `DB_MIGRATION_PRINCIPAL` change, once the
   SQL grants are in place. Order matters: grant first, then relax the guard —
   the reverse turns a clean pre-flight refusal into a mid-deploy failure that
   leaves SponsorPortal's site stopped (`deploy-dev.sh:207-208`).

## Decisions needed before implementation

1. **Account names.** `GOA\svc-pw-deploy-dev` / `GOA\svc-pw-deploy-prod`, or
   names your AD naming standard dictates? Who requests them?
2. **Operator fallback: keep or retire?** Keeping it is back-compatible and
   covers slots with no shared account; retiring it (fail with "no deploy
   credential is configured for this target") removes the last path where a
   deploy runs as a person. Recommendation: keep for now, revisit once every
   target has a credential.
3. **Who may set a project override** — admin only, as specced, or also a
   project's own maintainer?
4. **Force `reauth` on prod slots** that resolve to the instance credential?
   Recommendation: yes, and make it the default for new prod slots.
