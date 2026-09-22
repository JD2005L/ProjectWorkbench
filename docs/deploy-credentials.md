# Deploy credentials: instance-level, per target, overridable per project

Status: **built** for the instance level (2026-09-22). The resolver, storage,
`DEPLOY_OPERATOR`/`DEPLOY_IDENTITY_SOURCE`, the admin-only credential API with its
directory test, and the two Settings ▸ Deployment cards are in. Per-project
overrides are honoured by the resolver but have no UI yet — an administrator sets
one in `deploy-config.json`, the same treatment `runAsRoot` gets, because it is a
privilege grant. Behaviour is unchanged on any instance with no credential saved.

Chosen configuration (operator, 2026-09-22): **no AD service accounts are
available on this domain**, so the instance credential will be `GOA\james.levac`
for both targets. That choice needs no repository change in any project and no new
SQL grant — see "What the projects have to change: nothing" — and its four
consequences are worked through in "The configuration actually chosen".

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

`dev` and `prod` are always configured as separate fields, so the two can diverge
the day two accounts exist without any code change. They MAY hold the same account
— which is what this instance will do initially — and an operator choosing that
should know they are choosing it: a dev slot then authenticates with an account
that also has production rights, so a mistake in a dev slot script can reach
production. The fields staying separate is what makes that a decision rather than
an assumption.

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
| `POST` | `/api/deploy/credentials/test` | `{target, project?}` | admin only; resolves the identity for that slot and verifies it against the directory. Returns `{ok, user, source}` or a reason — never the secret. The answer to "did James's password change?" without running a deploy |

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

## What the projects have to change: nothing

This is the part that makes the chosen configuration attractive. If the instance
credential is `GOA\james.levac` — the account those two projects already pin —
then `DEPLOY_USER` arrives as exactly the name their guard demands, whoever
pressed Deploy:

```bash
DB_MIGRATION_PRINCIPAL='GOA\james.levac'   # unchanged, and now satisfied for every operator
```

No repository edit, no new SQL grant, no DBA request, and no handoff-doc revision.
AITDataHub and SponsorPortal keep their fail-fast guard and their existing
migrator-role grant; Kevin's deploys stop being refused because they are no longer
running as Kevin. TeamCanadaStrong's `deploy-dev.sh` accepts any well-formed GOA
account and refuses only the runtime app-pool identity (`GOA\AIT-DBService.S`),
so it is satisfied too.

The service-account variant below stays the better end state, but it is an
upgrade, not a prerequisite.

### Later, if service accounts become available

Pin the guard to the non-human principal instead:

```bash
DB_MIGRATION_PRINCIPAL='GOA\svc-pw-deploy-prod'
```

One SQL grant per database to one non-human principal, no person's password stored
anywhere, and a compromised web app still cannot migrate its own schema. Two AD
accounts would be needed, non-interactive, one per target, with:

| Need | Why |
|---|---|
| SMB write to each site's deployment share | `smbclient` file copy step |
| WinRM / remote PowerShell on the target web hosts | IIS stop/start, app-pool control, health probe |
| IIS app-pool control on those sites | steps 2 and 5 of every slot script |
| SQL: the project's migrator role on each database it deploys | step 3c, `dbo.__SchemaVersions` + DDL |
| **Not** interactive logon, **not** local admin, **not** the runtime app-pool identity | blast-radius containment |

## The configuration actually chosen: an operator's own account

**Decided 2026-09-22: no AD service accounts can be created here, so the instance
credential is `GOA\james.levac` for both targets.** Everything above works
unchanged — the resolver does not care whether the account it resolves is human —
but four consequences follow from it, and the design has to answer each.

**1. Attribution moves entirely into PW.** On the app servers, in the IIS logs and
in SQL, every deploy becomes `GOA\james.levac` regardless of who pressed it. PW's
audit record and `DEPLOY_OPERATOR` are then the *only* evidence of who actually
deployed, which makes `/var/log/project-workbench/audit.log` load-bearing rather
than merely useful: it needs to be retained and readable, and every slot script
worth its salt should print `DEPLOY_OPERATOR` into its own output so the Deploy
panel's history shows the human next to the run.

**2. One password expiry breaks every project at once.** A personal account's
password rotates on the domain schedule, and on the day it does, every deploy on
the instance starts failing inside SMB/WinRM with a bare authentication error
rather than anything an operator can act on. Therefore:

- `POST /api/deploy/credentials/test` (below) so an admin can confirm the stored
  credential still authenticates, without running a deploy.
- When a deploy fails and the stored instance credential no longer verifies
  against the directory, say so explicitly: *"The workbench's stored deployment
  credential for GOA\james.levac no longer authenticates — an administrator must
  re-enter it in Settings ▸ Deployment."* One re-entry fixes every project, which
  is the one operational advantage of the shared arrangement.

**3. Anyone who can press Deploy acts as that account, for whatever the slot
script does.** With a service account the blast radius is "what that account may
do"; with a personal operator account it is "what that person may do", which is
broader by construction. Slot scripts are editable by PW admins only, so the
authoring path is already admin-gated, but the *triggering* path is every user
with a project grant. Mitigations, in the order they are worth applying:
`reauth: true` on prod slots (proof the human is present, verified against *their
own* password); project grants kept tight; and — the narrowest option — setting the
credential as a **per-project override on just AITDataHub and SponsorPortal**
instead of an instance default, leaving the other projects running as whoever
clicks. That last one is a one-field difference in this design, not a redesign.

**4. It is a stored shared password, and worth naming as such.** A human
credential held by the workbench and used on behalf of others is a different
governance posture from a service account, and GoA password-handling policy has
opinions about shared credentials. The storage itself is unchanged from what PW
already does with per-user deploy passwords (AES-256-GCM under a 0600 key, never
rendered, never logged), but the *sharing* is new. Flagging it once here so the
decision is recorded, not to relitigate it.

## Security caveats, stated plainly

- **An instance prod credential is a privilege grant to everyone who can press
  Deploy on any project with a prod slot.** That is the trade: fewer personal
  grants, but a wider set of people able to act as one account. With a *human*
  account as that credential the radius is wider still — see "The configuration
  actually chosen" for the four consequences and the mitigations in the order
  they are worth applying.
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
2. **Settings ▸ Deployment UI**, the credential routes and the test route. With
   `GOA\james.levac` saved as the instance credential for both targets, this is
   the step that unblocks every operator on AITDataHub and SponsorPortal — no AD
   request, no SQL grant, no project repository change stands in front of it.
3. **Per-project override** in the slot config section. Also the narrower way to
   deploy the whole feature: set the credential on just those two projects and
   leave everything else running as whoever clicks.
4. Only if service accounts ever exist: hand the project agents the one-line
   `DB_MIGRATION_PRINCIPAL` change. Order matters then — grant first, relax the
   guard second. The reverse turns a clean pre-flight refusal into a mid-deploy
   failure that leaves SponsorPortal's site stopped (`deploy-dev.sh:207-208`).

## Decisions needed before implementation

1. ~~**Instance default, or override on just the two projects?**~~ — decided
   2026-09-22: **instance default for `dev` and `prod`.** The narrower
   override-only route stays available (the resolver checks overrides first) if
   the shared account should later be confined to the projects that need it.
2. **Operator fallback: keep or retire?** Keeping it is back-compatible and
   covers slots with no shared account; retiring it (fail with "no deploy
   credential is configured for this target") removes the last path where a
   deploy runs as a person. Recommendation: keep for now, revisit once every
   target has a credential.
3. **Who may set a project override** — admin only, as specced, or also a
   project's own maintainer?
4. ~~**Force `reauth` on prod slots**~~ — decided 2026-09-22: **no**, prod stays
   frictionless. `reauth: true` remains available per slot and still verifies the
   operator's own password; nothing forces it. Worth revisiting if the audit log
   ever has to answer for a production change, because it is the only check that
   the person pressing Deploy is who the session says once one account is on the
   wire for everyone.
5. **Password rotation drill.** When that account's domain password changes, one
   admin re-entry in Settings ▸ Deployment fixes every project — but until it
   happens, every deploy fails. Worth deciding now who does it and whether PW
   should warn before expiry (it cannot read expiry from the directory today; the
   cheap version is the test route plus a note on the Deployment settings card).
