# Per-user Claude / Copilot credentials (opt-in)

By default every Project Workbench terminal shares **one** Claude login and one
GitHub/Copilot login (the box's shared credentials). This feature lets each
project run on its **assigned owner's own** credentials instead, so usage is
attributed to — and billed against — that person's seat.

## Model

For repository authentication, storage and rotation, see
[GitHub authentication and credential lifecycle](git-authentication.md).

A project is owned by its `primaryUser` (the "Git identity" field in the Manage
Projects modal, already used for git-push auth). When the feature is enabled,
that project's terminal launches with the owner's private credential context:

- **Claude** — `CLAUDE_CONFIG_DIR` is pointed at the owner's per-user config dir
  (`$PW_USER_CRED_BASE/<user>/claude`). The **first** `claude` run in the project
  performs the owner's normal OAuth login (`claude /login`) into that dir; it
  then persists. Team MCP servers (teamkb/pulse/skillhub, etc.) are seeded into
  the dir from the shared `~/.claude.json` so they keep working per-user.
- **Copilot** — the owner's stored GitHub token is injected as `GH_TOKEN`, which
  Copilot CLI documents as taking precedence over any stored credential, so
  inference is billed to that user's Copilot seat. `COPILOT_HOME` is pointed at
  the owner's own Copilot dir (`$PW_USER_CRED_BASE/<user>/copilot`) as well:
  Copilot keeps its sessions, history, skills **and any `copilot /login`** in one
  directory, so without that every user would still share `~/.copilot`. The dir is
  seeded with the shared `copilot-instructions.md` and `mcp-config.json`, and
  deliberately NOT with `config.json` or the session store — those are the
  per-person state the split exists to separate.

If the feature is off, or the project intentionally has no `primaryUser`, the
terminal falls back to the shared login — nothing breaks. But if the feature is
on and the project HAS a `primaryUser`, that owner's credentials are mandatory:
a `primaryUser` that doesn't resolve to a user record, a users store that
cannot be read, an undecryptable GitHub token, or a failing credential helper
all **fail the session launch** with an actionable error rather than silently
handing the terminal the shared identity. See "Fail-closed, not fail-open"
below.

## Enabling

Set on the app container / service environment:

```
PW_PER_USER_CLAUDE=true
# optional, default /home/admin/pw-users
PW_USER_CRED_BASE=/home/admin/pw-users
```

**Host mode:** this env var (and any of the others above, if overridden from
their defaults) must be set on BOTH `project-workbench.service` (the
dashboard) AND `project-terminal@.service` (the per-project terminal), e.g.
via `systemctl edit <unit>`. Each systemd unit has its own environment — they
do not inherit from each other — and the per-project terminal's INITIAL,
systemd-launched session (`scripts/project-terminal-start`, which
`project-terminal@.service` runs) resolves credentials independently via
`app/project-terminal-credentials.mjs`, enforcing the identical fail-closed
contract described above. Sessions the dashboard itself creates or recreates
(a new project, a new tab, `POST /api/term/:project/recycle`) go through
`app/server.js` instead and only need the dashboard's own environment.

Then, per owner (one time): open a project you own and run `claude` — complete
the login in the browser. The **Settings → Users & Roles** table shows a
**Claude** column: `✓ signed in` once you've done it, `not yet` until then.

## Per-launcher mode: whose seat does a *tab* spend?

Per-user credentials alone key a terminal to the project's `primaryUser`. On a
project two people share, that means **every** teammate's Claude and Copilot work
runs on the owner's login: one person's rate limit gates the whole team, and the
audit trail names the wrong person.

`PW_PER_LAUNCHER_CLAUDE=true` (the default once `PW_PER_USER_CLAUDE` is on) keys a
cockpit tab to **the person who opened it**. Kevin clicks "+ → GitHub Copilot CLI"
in a project James owns, and that tab gets Kevin's config dirs and Kevin's token.

What stays keyed to the project owner, because no person asked for it:

| Pane | Identity |
|---|---|
| a tab opened from the cockpit's "+" menu | the signed-in user who clicked |
| the session's base window / preset tabs | the project owner |
| the boot reattach, `scripts/project-terminal-start` (host mode) | the project owner |
| a scheduled task, PVIKPBot, anything automated | the project owner |

So the **base tab of an existing project keeps running on the owner's seat** —
per-launcher mode does not retroactively re-key a live pane (a pane's environment
is fixed by tmux at creation). Open a new tab to get your own.

**Git pushes are not re-keyed.** A repository's push credential is a property of the
repository, not of a tab: `syncProjectCredentials` pins the project's remote to the
OWNER's token (see [git authentication](git-authentication.md)), and that is unchanged.
What a launcher's tab gets is their own `GH_TOKEN` in the pane environment — which is
what `gh` and Copilot read. So on a shared project, inference is attributed to whoever
is typing while commits still push as the project's owner.

### One session, several identities — recorded, not refused

Because tabs are windows in one shared tmux session, a project's strip can now hold
two people's identities at once. Each window is stamped at creation with
`@pw_cred_user` (who) and `@pw_cred_key` (the credential fingerprint), read back to
confirm the write landed; a window whose identity cannot be recorded is **closed**
rather than handed over unlabelled.

This replaces the older rule, which refused to add a window unless it matched the
session's fingerprint. That rule was right while a session could only have one
identity, and it had a visible side effect: once `PW_PER_USER_CLAUDE` was switched
on, every grandfathered session refused to open a new tab at all
(*"existing session credentials are stale … recycle required"*).

### Tab colours

The cockpit colours each tab by whose account it runs on, and names them in the
tooltip. An **uncoloured** tab is the shared box login; a coloured one is somebody's.

**Whose colour is whose** is written down in two places, because a mapping nobody can
look up is not a mapping:

* **Settings → Users** shows each person's swatch and colour name beside their username
  — that table is the legend;
* **`/me`** shows a person their own colour, and is where they change it.

**Choosing.** Every user always has a colour — a new one is assigned automatically, so
no tab is ever colourless — and the assignment can be overridden:

* a person picks their own on `/me` (`POST /api/me/tab-color`);
* an admin picks it for them in the Add/Edit user form (`tabColor` on the user record).

A colour already held by somebody else is **refused**, naming them, and shown as taken
in the picker: two people in one colour undoes the only thing the colour is for.
Choosing **Automatic** hands it back to the assignment.

Resolution order, and why each layer exists:

1. **the person's own stored choice** (`tabColor` on their record) — deliberate, and it
   travels with the record through a rename or a delete;
2. **the operator map** in `workbench.json` (`userTabColors`) — how this was configured
   before there was a UI, kept working rather than silently discarded;
3. **a stable hash** of the username, drawn only from colours nobody has claimed in 1 or
   2, so a new teammate is never colourless and never collides with an agreed colour.

Palette: `orange`, `yellow`, `violet`, `green`, `pink`, `blue`, `teal`, `lime`, `red`,
`sky` (`app/user-colors.js`). With more people than colours, later arrivals share a
hashed colour — an explicit choice always wins over a hashed one.

The mapping is resolved on every poll, so a change repaints the strip within seconds
without recycling any terminal.

### Authorising GitHub per person (instead of pasting a token)

Two routes exist. **Prefer the GitHub CLI one** — it needs no OAuth app of our own,
because gh *is* an app GitHub trusts, and the token it issues is the one kind that has
always done both jobs on this workbench: pushing and Copilot.

#### Via `gh auth login` (recommended)

Settings → Users → **connect** opens a terminal **as that person**, running:

```
gh auth login --hostname github.com --git-protocol https --web --insecure-storage --scopes repo,read:org,workflow
```

They follow gh's prompts — it prints a one-time code and a URL — in their own browser.
The modal then reads back what gh stored and adopts it: the token becomes the push
credential of every project they own and is exported as `GH_TOKEN` in their terminals,
and **gh itself stays signed in** for their own `gh pr` / `gh api` use.

Three things make that work:

* **`GH_CONFIG_DIR` is per person** (`<cred root>/gh`), so a login writes into their own
  tree rather than overwriting one shared `hosts.yml` — and PW can tell whose token it is
  reading back.
* **The terminal runs as the target**, not as whoever pressed the button. Doing it for
  somebody else therefore needs per-launcher credentials, and is refused rather than
  silently writing into the presser's directory.
* **The read-back strips `GH_TOKEN` and friends from the environment.** `gh auth token`
  *echoes an ambient token* — measured against gh 2.101.0 — and every pane already has
  one, so an unsanitised read would return the token PW already had and report a fresh
  login that never happened. With nothing stored, gh writes to stderr and leaves stdout
  empty, so the answer is decided by the shape of stdout and never by the exit code.

`--insecure-storage` is deliberate: gh uses an OS credential store when it finds one and
plain text otherwise, and this container has no keyring — so being explicit makes the
result land where `gh auth token` can always read it, instead of depending on the
continued absence of a keyring. The file is `0600` inside the person's own `0700`
directory.

If `gh` is missing, the modal says so and names `deploy/install-gh.sh`. Note that gh has
disappeared here before — see the readiness checklist entry.

#### Via our own device flow (fallback)



One stored token per person has to do two unrelated jobs here: it is the **push
credential** pinned into every repository that person owns, and it is what
**authenticates Copilot** in their terminals. A hand-made PAT reliably satisfies one and
fails the other — both directions have happened on this workbench:

* a classic `ghp_` PAT pushed perfectly and Copilot refused the type;
* replacing it with a fine-grained PAT satisfied Copilot and returned
  `403 Write access to repository not granted` on push.

**Settings → Users → _connect_** opens a modal that runs GitHub's **device flow**: the
dashboard asks GitHub for a code, the person enters that code at
`github.com/login/device` in their own browser (any device), and the dashboard polls for
the result. A person can do the same for themselves from **`/me`**. Nothing needs to
reach this box inbound, which is why the device flow and not the web flow — this is a LAN
host behind a private CA.

What the result gives you:

* the token is stored encrypted, becomes the push credential of every project that
  person owns (`syncProjectCredentials` runs immediately), and is exported as `GH_TOKEN`
  in their terminals;
* the **GitHub account that actually authorised** is verified through `GET /user` and
  shown on the row. That matters because an admin may start the flow on somebody else's
  row — a real workflow when sitting with them — and whoever is signed into GitHub in
  that browser is who gets authorised. Showing the login makes a mis-binding visible
  instead of silent;
* the granted **scopes** are shown, with a plain note about whether `repo` is present.
  That is deliberately phrased as what the token *carries*, never as a promise that a
  push will succeed: a token with `repo` still cannot push where its account has no
  write access, which is exactly the failure that prompted this.

The device code never reaches the browser (it is the secret that collects the token), the
token never appears in a response or the audit log, and each authorisation is single-use.

**From a shell instead of the UI:** `tools/pw-connect-github.py <username>` does the same
thing for people who would rather run a command — it signs in to the dashboard as you,
starts the flow for that user, prints the code they must enter, and waits. The
authorisation itself still has to be done by that person in a browser signed in as
themselves; no script can stand in for it, which is the point of using OAuth at all.

**Configuration is required and has no default** — see `PW_GITHUB_OAUTH_CLIENT_ID` in
[DEPLOY.md](../DEPLOY.md). Briefly: an org-registered OAuth app is the accountable
choice and pushes fine, but GitHub gates Copilot access and a self-registered app is not
on that list; the GitHub CLI's public client id yields a token Copilot documents it
accepts, at the cost of authorising as another vendor's app. That is an operator's
decision, so an unset value disables the button with a message rather than guessing.

### Prerequisites for Copilot specifically

Each person needs their own Copilot seat, and a token Copilot CLI will actually
accept. Per `copilot login --help`, that means a **fine-grained PAT with the
"Copilot Requests" permission**, a Copilot CLI OAuth token, or a `gh` OAuth token
(`gho_`). **Classic `ghp_` PATs are not supported** — one will authenticate `git`
perfectly well and then fail for inference, which looks like a broken tab rather
than a token problem.

The trap: `copilot login` is **not** a way around a token Copilot rejects. The
`GH_TOKEN` this feature exports into the pane takes PRECEDENCE over any stored
credential (Copilot CLI documents that order), so a stored login is ignored while an
unusable `GH_TOKEN` is present. Either give the person a token Copilot accepts, or
clear their stored GitHub token so no `GH_TOKEN` is exported and `copilot login` in
their own `COPILOT_HOME` takes effect. Clearing it does not break pushes — those use
the repository's own pinned credential, not `GH_TOKEN`.

## Who signs in, and where

Two different questions used to be answered in the same place. They are now separated,
because they have different answers and different owners:

| Question | Scope | Where |
|---|---|---|
| Which assistants does this box offer, at which version? | the machine | Settings → **CLIs** (enable / install / update) |
| Is *this person* signed in to one? | a person | Settings → **Users** (a column per offered CLI), and **`/me`** for the person themselves |

### The CLIs page has no sign-in when identity is per person

With `PW_PER_USER_CLAUDE` on, Settings → CLIs is install/update/enable only. The
sign-in button, the "Signed in" badge and the shared setup terminal section are all
removed, and `POST /api/setup/cli/auth` refuses — because that control authenticates the
box's own identity, which runs nobody's project terminals. Pressing it would have signed
in an identity the presser does not use.

With the feature **off**, all of it comes back and behaves exactly as before: in that
mode the box's login genuinely is everybody's, so it is the right place to sign in. The
shared identity still matters either way as the **seed** a new per-user config dir is
created from (`.claude.json`'s MCP servers, `settings.json`'s infrastructure keys,
`CLAUDE.md`, `copilot-instructions.md`, `mcp-config.json`) and as the fallback for a
project with no `primaryUser` — it just is not something anybody signs in to from that
page any more.

### Settings → Users: a column per offered CLI

"Offered" means enabled by the operator **and** installed — anything else has no
sign-in state worth showing. Each cell is resolved server-side by
`resolveCliAuthCell()` (`app/cli-auth-status.js`) so this table and a person's own page
can never tell different stories:

| Cell | Meaning |
|---|---|
| signed in | that person completed their own login; it lives in their own config dir |
| not signed in | they have not yet; opening a tab for it will ask them |
| ready · own token | *(Copilot)* their stored GitHub token authenticates it — nothing to sign in to |
| token type refused | *(Copilot)* a classic `ghp_` PAT. Copilot refuses the type, **and** a stored token overrides any sign-in, so signing in cannot help until it is replaced or cleared |
| token type unknown | *(Copilot)* an unrecognised token type, also overriding any sign-in |
| token unreadable | their stored token would not decrypt; it needs replacing |
| not personal yet | the CLI has no per-user config dir (Codex today), so a "personal" login would write the shared one |
| not installed | fix the machine first |
| shared login | per-user credentials are off; there is no personal sign-in to do |

The **Git token** column now shows the token's *type* rather than a bare tick, and has a
**Clear** control. It was previously write-only — an empty field meant "keep what is
there" — so a token could never be removed, which mattered because clearing is the only
fix when Copilot refuses the type.

### The sign-in means is self-service, and appears only when something is owed

A sign-in runs in a terminal, and a terminal carries the credentials of whoever opened
it. So the **sign in** action only appears on **your own row**: pressing it for someone
else would create the tab on *your* credentials and sign *you* in again.

It also only appears when there is an action outstanding — `needsSignIn`, not merely
"a login would work". A control beside a cell that already reads *signed in* makes a
reader doubt the status, so a signed-in row shows the status alone. Re-authenticating
something that already works (an expired or revoked credential still reads as signed in
on disk) is available from your own `/me` page, where it is not sitting in a list of
everybody else's states. And it never appears where a stored token would override the
login, because that is a loop that cannot succeed.

Both in-cell actions — **sign in** and the token's **clear** — are compact inline links
rather than buttons, so a status column reads as a status column.

For everyone else's rows, the admin's lever is the token: replace it, or clear it so the
person can sign in.

### `/me` — the page a non-admin needs

Settings is admin-only, so a developer would otherwise be able to see that their Copilot
did not work but not why, and not act. **`/me`** ("My CLI sign-ins") is linked from the
user chip in the status bar on every page, including the cockpit. It shows that person
their own per-CLI status and detail, a **Sign in** button where it applies, and their own
GitHub token controls:

* `POST /api/me/github-token` — store/replace their own token;
* `DELETE /api/me/github-token` — clear it;
* `POST /api/me/cli-login` — open a tab running that CLI's login as them.

All three are self-scoped: none of them takes a username, so none can be used to touch
or enumerate another person's credentials. Every change is audited, and the token itself
never appears in a response, in the audit log, or in a pane's command line.

Letting a person manage their own token is deliberate: because a stored token overrides
a Copilot login, a person whose token Copilot refuses could not sign in at all without
an admin — the self-service path would have been advice rather than a means. Storing a
new one is offered alongside clearing, so they are not left without git credentials.
Their token grants nothing on this workbench; it is their own identity, used for their
own attribution.

### Upgrading terminals that already exist

A session created before per-window identity stamps existed runs on perfectly good
per-user credentials — it simply never recorded whose, so the cockpit shows its tabs
uncoloured. **Settings → System & Updates → Heal → "Label existing terminals"**
(`POST /api/setup/heal/session-labels`, admin) fills that record in.

It writes a tmux window option, which is metadata: the pane's process is not signalled,
restarted or otherwise disturbed, and the test for this asserts the pane PID is
unchanged afterwards. That is the point — recycling would also fix the label, by killing
everything running in the session.

The care is all in what it refuses to label, because a wrong name is worse than none:

| Situation | What happens |
|---|---|
| the pane's start command names a credential directory | labelled with **that** person — the strongest evidence there is, and it survives a rotated token or a reassigned owner |
| no credential directory in the pane, but the session's stamp matches its owner | labelled with the owner (the weaker, fallback rule) |
| a window already carries a label | left alone — with per-launcher credentials a session legitimately holds several identities, and the owner is not all of them |
| neither: no credential directory **and** a stamp that does not match | **skipped and named**, with "recycle to migrate" — nothing establishes whose account those panes spend |
| owner cannot be resolved, or the stamp cannot be read | skipped and named |
| project has no `primaryUser`, or the feature is off | skipped: there is no per-person identity to record |

**Why the pane, not the fingerprint.** The fingerprint is
`sha256(username \0 configDir \0 ghToken)`, so *clearing or rotating a token changes it* —
and every session stamped with the old one stops matching, even though those panes plainly
still run on that person's directory. That happened here: clearing one user's GitHub
token made the backfill skip all of their projects as stale. A hash cannot tell "the
token changed" from "the owner was reassigned", but the pane's own start command can: it
carries `CLAUDE_CONFIG_DIR=<base>/<encoded-username>/claude`, which names the person
directly. The encoding is reversible by design (see `encodeUserName`), and the decoded
name is checked against the current roster before it is used.

It is idempotent — a second run reports everything as already labelled — so it is safe
to press again after recycling something.

One thing a label does **not** retrofit: `COPILOT_HOME`. A pane's environment is fixed
by tmux when the pane is created, so a terminal that predates that variable keeps using
the shared `~/.copilot` until it is recycled. The label is still accurate about **whose
account the tab spends** — that follows `GH_TOKEN` and `CLAUDE_CONFIG_DIR`, which those
panes do carry — but Copilot's sessions and history stay pooled until a recycle.

### Codex

Not wired for per-user identity: there is no per-user Codex config directory, so a
"login" would write the shared one. `CODEX_HOME` looks like the analogue of
`COPILOT_HOME` but has not been verified against the CLI, so the per-user sign-in route
refuses Codex with that reason rather than pretending, and its cell reads "not personal
yet". Installing and updating Codex from Settings is unaffected.

## Threat model: what this feature is and is not

> **Per-user credentials give per-user _attribution_, not cross-user _isolation_.**

Every terminal on a workbench — every project, every user — runs as the **same**
OS account (`admin`). That is a property of the product, not of this feature.
Splitting credentials into per-user directories means a project's Claude usage is
billed to its owner's seat and its git pushes are attributed to its owner. It does
**not** stop one user from reading another user's credential directory, because
they are the same UID to the kernel. Anyone with a terminal on the box can read
any owner's `session-env.sh` and Claude OAuth token.

Concretely:

| Property | Provided? |
|---|---|
| Claude usage billed to the right seat | yes |
| Git/Copilot actions attributed to the right person | yes |
| Secrets hidden from a *remote* user with no terminal | yes |
| Secrets hidden from another user **who has a terminal on this box** | **no** |
| A tab's colour prevents someone typing into another person's tab | **no** — the colour is awareness only. Anyone with a terminal can type into anyone's tab, and nothing in the browser could change that while every pane runs as one OS account |
| Root compromise from a terminal | no — see below |

Real cross-user isolation would require one OS account per person, which is a
much larger change (tmux, ttyd, workspace ownership, sudo policy). Until then,
treat "has a project terminal" as "can read every workbench credential", and
scope the tokens accordingly.

What the feature *must* not do is turn that shared-UID situation into a **root**
compromise, which is what the next section is about.

## How the credential tree is written (and why root never touches it)

The credential tree lives under `PW_USER_CRED_BASE` and is owned by the account
the panes run as. The dashboard runs as **root**. Those two facts together are
dangerous, because the pane account is shared by every user on the box:

```bash
# as any user with a project terminal
ln -s /etc/sudoers.d/pwn ~/pw-users/<victim>/session-env.sh
```

If root then wrote that path, it would follow the symlink, create a root-owned
file with attacker-chosen content, and (previously) `chown` it to the attacker —
a straight local privilege escalation from "has a terminal" to root.

So the dashboard **does not perform filesystem operations in that tree at all**.
It drops privileges and runs `app/credential-writer.mjs` as the pane account:

| Mode | Drop mechanism |
|---|---|
| `container` + `PW_TERMINAL_UID` | `setpriv --reuid <uid> --regid <gid> --init-groups` |
| `host` | `sudo -n -u admin` |
| dashboard already runs as the pane account | no drop; the work runs in-process |

The helper has exactly the authority the attacker already had, so there is no
confused deputy to exploit. No `chown` happens anywhere — files are created by
their eventual owner. The job (including the GitHub token) is passed on the
helper's **stdin**, so it never appears in its command line where `ps` would
publish it.

As defence in depth — and to cover the in-process case — the writer also:

- creates each level individually and `lstat`s it, refusing a symlink where a
  directory should be (`refusing to use a symlinked credential path`);
- opens files with `O_NOFOLLOW`, and sets the mode through the descriptor so a
  swap after `open` cannot redirect it;
- removes and recreates any non-regular file it finds in place of its own
  (`unlink` never follows a symlink);
- tightens `<base>/<user>` and `<base>/<user>/claude` to `0700` even if they
  already existed with looser modes.

Which account to drop to is resolved by `app/terminal-owner.js`: numerically from
`PW_TERMINAL_UID`/`_GID` in container mode, and via `getent passwd` (falling back
to `/etc/passwd`) in host mode, so directory-backed accounts work under
`PW_AUTH_MODE=ldap`. It **refuses** — rather than falling back to root — on
uid/gid 0, malformed or ambiguous passwd entries, a relative home, or an invalid
account name.

Note this is a different question from the `setpriv` drop in
`app/terminal-priv.js`, which is deliberately disabled in host mode because the
pane is already unprivileged there. Deriving ownership from that flag is what
made an earlier version of this feature silently inert on every host-mode
instance.

## Fail-closed, not fail-open

An earlier version of this feature fell back to the shared login whenever
anything about the owner's credentials couldn't be resolved — an unreadable
`users.json`, an undecryptable `ghToken`, a `primaryUser` that no longer names a
real user, a privilege-dropped helper that failed — logging only a
`console.warn`. That is a silent identity swap: a project configured to run on
its owner's seat would quietly run on the shared box login instead, with
nothing in the UI to say so.

When `PW_PER_USER_CLAUDE` is on and a project has a `primaryUser`, all of the
above now **fail the launch** (`ensureTmuxSession` / `newTmuxWindow` reject, and
the route returns a non-2xx response with an actionable message) instead of
falling back. Shared credentials remain available only for the two cases where
that is the actual intent: the feature is off, or the project genuinely has no
`primaryUser`. The read-only status poll (`credentialsStale`, feeding
`GET /api/projects/status`) is the one exception: it never throws, because one
project with an unresolvable owner must not take down status reporting for
every other project — instead it reports that project `credentialsStale: true`,
which is still visible/actionable rather than silently "fine".

## Directory naming

A username becomes a path segment by percent-encoding everything outside
`[A-Za-z0-9_-]`:

| Username | Directory |
|---|---|
| `james-levac_goa` | `james-levac_goa` |
| `first.last` | `first%2Elast` |
| `DOMAIN\user` | `DOMAIN%5Cuser` |
| `.` | `%2E` |
| `..` | `%2E%2E` |

The encoding is **injective** — `%` is itself escaped, so no two usernames can
land in the same directory. That matters: an earlier scheme replaced unsafe
characters with `_`, which mapped the distinct usernames `.`, `..` and `_` onto
one directory, so three people would have shared one Claude login and one GitHub
token. It also removes path traversal by construction, since `.` and `/` are
escaped and an encoded segment can never be `.` or `..`.

Empty usernames and names too long to encode within a filesystem component are
**rejected** rather than folded onto a fallback name.

## Where the GitHub token lives

The owner's token is written to `<PW_USER_CRED_BASE>/<user>/session-env.sh`,
mode `0600`, owned by the pane account, and the pane shell sources it
(`bash --noprofile --rcfile <file>`).

It is deliberately **not** passed as an `env GH_TOKEN=… ` token on the tmux
command line. tmux retains a pane's start command for the life of the pane —
`tmux list-panes -F '#{pane_start_command}'` prints it — and every pane on a
workbench runs as the same OS account, so an argv token would publish one user's
token to every other project's terminal. This mirrors what `syncProjectCredentials`
already does for git credentials, and is the same reason the credential job goes
to the helper on stdin.

`CLAUDE_CONFIG_DIR` is not secret and is still passed as a normal env token.

## Removing stale credentials

`DELETE /api/users/:username` revokes, in order, every project reference,
git credential, and the credential tree BEFORE removing the account itself —
the identity removal is deliberately the LAST, irreversible step. If any of
that cleanup fails (a locked file, an unusable `PW_USER_CRED_BASE`, ...), the
account is NOT deleted and the request reports an error rather than an
unqualified success: the failure leaves a safely retryable state instead of an
orphaned credential tree with no owner left to clean it up. The same sweep also
runs once at startup, catching trees orphaned some OTHER way — while the
service was down, or by an out-of-band edit of `users.json` — but that boot
sweep is defense in depth, not the primary cleanup contract.

The prune runs as the pane account, like every other write into that tree, and is
deliberately conservative: it only removes a directory whose name is a canonical
encoding **and** which contains this feature's own layout (a `claude/` directory
or a `session-env.sh`). `PW_USER_CRED_BASE` is operator-configurable, so a
misconfiguration must not turn the sweep into an arbitrary delete.

## Renaming a user is retryable

`PATCH /api/users/:username` with a new `username` repoints every
`project.primaryUser` that named the old one, resyncs those projects' git
credentials, and prunes the old credential-tree namespace — all as one
`effect` on the SAME serialized commit as the username change itself (see
`app/user-store.js`'s `update(mutate, effect)`).

If that reconciliation fails partway (a locked `projects.json`, a read-only
`.git`, an unusable credential base, ...), `users.json` already committed the
new username, but the record is marked with a `pendingCredentialSync:
{fromUsername, toUsername}` — surfaced as `pendingCredentialSync: true` on
`GET /api/users` so it's visible, not a hidden file-only state. Recovering
from it needs no manual file edits:

- **retry the identical PATCH** (or any other edit to the same user, or a
  literal no-op) — the marker is carried forward and the reconciliation is
  re-attempted regardless of whether this particular request changes the
  username again, or
- **`POST /api/users/:username/reconcile`** — finishes a pending
  reconciliation without reconstructing the original rename request at all;
  a no-op (`{"ok":true,"pending":false}`) if nothing is pending.

Every step (project-reference reassignment, git resync, credential-tree
prune) is safe to repeat, so retrying after a partial failure never double-
applies anything.

**No mistaken takeover.** If the OLD username is claimed by a *different*
account by the time reconciliation runs (someone created a new user reusing
the vacated name), reconciliation refuses — reassigning that name's projects
or pruning its credential tree would hand the new account's projects or
credentials to the renamed one. The marker stays pending until an admin
resolves the naming conflict. `DELETE /api/users/:username` applies the same
guard: deleting a user with an unfinished rename also revokes the lingering
OLD-name project reference, unless that name has since been reclaimed.

## Changing credentials on a running session

A pane inherits its environment when it is created, so enabling
`PW_PER_USER_CLAUDE`, reassigning a project's `primaryUser`, or rotating a token
does **not** re-key a session that is already running.

PW stamps a non-secret fingerprint of the credentials on the tmux session at
creation (`@pw_cred_key`). Every seam that would hand a terminal to a caller —
`ensureTmuxSession`, `ensureProjectTmuxSession` (the PVIKPBot base session),
and `scripts/project-terminal-start`'s host-mode equivalent — resolves the
CURRENT owner and compares it against that stamp EVERY time, not just on
`GET /api/projects/status`'s read-only poll. The underlying tmux session may
keep running either way (none of these ever kill one), but attaching to — or
handing off ttyd to — an existing session is refused, with an actionable
recycle-required error, unless the fingerprint matches exactly (or the
session was legitimately never stamped because credentials are genuinely
off/shared). A stale or unresolvable owner is never silently attached to:
attribution safety is not traded for continuity of an already-open terminal.
`GET /api/projects/status` still separately reports `credentialsStale: true`
for visibility even when nothing has tried to attach yet.

Recreating the session is destructive — it discards whatever is running in every
window — so it is never done implicitly. Reconcile it deliberately:

```bash
curl -X POST -b cookies.txt -H "Origin: $HOST" \
  "$HOST/api/term/<Project>/recycle"
```

The call is audited as `session_recycle`. New tabs opened with
`newTmuxWindow` always get current credentials (also fail-closed on
resolution failure), so a long-lived session can end up mixed; recycling is
what makes it uniform.

## Scope & limitations

- **Accountability, not isolation.** See the threat model above: all terminals
  run as one OS user, so a user with a shell in any project can read another
  user's credential dir on disk. Keeping the token out of argv narrows the
  exposure — it is no longer readable from a process listing or
  `tmux list-panes` — but it does not close this gap.
- **A rename creates a fresh (empty) credential dir; the owner logs in again.**
  Directory names are derived from the username, so the OAuth login itself
  does not carry over to the new name. Renaming a user (`PATCH
  /api/users/:username` with a new `username`) DOES actively: repoint every
  `project.primaryUser` that named the old username, resync those projects'
  git credential helpers from the freshly committed user record, and prune the
  OLD credential-tree directory in the same request — it does not wait for the
  next boot or delete. Only `PW_USER_CRED_BASE` changing out from under a
  stable username is a passive-prune-only case (an operator relocating the
  base, not a normal product action).
- **A rename's project/credential sync IS retried on failure.** See
  "Renaming a user is retryable" above — a `pendingCredentialSync` marker
  survives a partial failure, and either resending the request or
  `POST /api/users/:username/reconcile` finishes it, with no manual file
  edits. There is still no cross-file TRANSACTION across `users.json`,
  `projects.json`, and the credential tree (a flat-file store cannot offer
  one) — what this buys instead is that the reconciliation is fully
  idempotent, so retrying it is always safe and eventually completes it.
- **Credentials are the owner's, not the actor's.** Anyone with access to a
  project uses the `primaryUser`'s account/quota, because terminals are one
  shared session per project.
- **Seats.** Each owner needs their own Claude seat (Enterprise/Max/Pro) and, for
  Copilot, their own GitHub Copilot licence.
- Specialised spawn paths (`ensureProjectTmuxSession` / PVIKPBot) are not wired
  for per-user creds; only the standard project terminals (both the
  dashboard-created path AND the host-mode systemd-launched initial terminal,
  `scripts/project-terminal-start`) and manually-opened tabs are.

## Implementation

- `app/credential-writer.mjs` — the privilege-dropped helper that performs every
  write into the credential tree. Reads a JSON job on stdin, writes a JSON result
  on stdout. Shared by both entrypoints below — neither one duplicates its logic.
- `app/user-store.js` — serialized, re-reading read-modify-write for
  `users.json`, so a slow request cannot write a stale whole-file snapshot back
  over a concurrent role change, token rotation, or deletion. Its `update()`
  also accepts an `effect(users, outcome)` hook that runs inside the SAME
  serialized tail as the commit, so a caller's derived-state side effects
  (git credential resync, credential-tree prune) cannot commit in one order
  and apply in another.
- `app/terminal-owner.js` — which OS account owns pane-visible files
  (`terminalOwnerPlan`, `parsePasswdEntry`, `resolveTerminalOwner`). Also exports
  `HOST_TERMINAL_USER`, which `server.js`'s `tmux()` uses for its
  `sudo -u` argument so the two cannot drift apart.
- `app/user-credentials.js` — creating and owning the credential material
  (`ensureUserCredentials`), the non-secret session stamp
  (`credentialFingerprint`), the drift decision (`sessionCredentialState`),
  and the sign-in status check (`userSignedIn`/`checkUserSignedIn`) — the
  latter uses `lstat`, never `stat`, and runs through the SAME
  privilege-dropped helper as every write into the tree, so a symlink
  planted at `.credentials.json` can't be used to probe an arbitrary path's
  existence/size through the dashboard's (often root) filesystem access.
- `app/project-owner.js`, `app/secret-crypto.js`, `app/users-file.js` — the
  owner-resolution decision, the AES-256-GCM token encryption, and the
  users.json reader, each extracted into its own small module so BOTH
  entrypoints below use the identical implementation rather than two that
  could drift apart.
- `app/server.js` — `credentialContext(project)` returns the extra `env` tokens,
  the pane shell argv, and the fingerprint; it is used by `ensureTmuxSession` and
  `newTmuxWindow`. `credentialsStale(p)` feeds `GET /api/projects/status`;
  `POST /api/term/:project/recycle` performs the explicit reconciliation.
  Sign-in status is exposed via `GET /api/users` (`claudeSignedIn`,
  `perUserClaude`).
- `app/project-terminal-credentials.mjs` — the SAME resolution, for the
  host-mode systemd-launched initial terminal. Invoked by
  `scripts/project-terminal-start` (`project-terminal@.service`, which runs as
  `admin`, not root) before tmux/ttyd start; prints one JSON object to stdout
  (`{"shared":true}` for the two intended shared-login cases, or
  `{"configDir":...,"envFile":...,"fingerprint":...}` on success) and exits
  nonzero with `{"ok":false,"error":...}` on any other failure. The script
  stamps the returned fingerprint on the session (`@pw_cred_key`) exactly like
  `app/server.js` does, so `credentialsStale` treats sessions from either
  entrypoint identically.

Tests: `test/terminal-owner.test.mjs` (ownership resolution, passwd validation,
hostile account names), `test/user-credentials.test.mjs` (injective encoding,
planted-symlink regressions, privilege-drop planning, stdin token delivery,
pruning safety, drift detection), `test/user-store.test.mjs` (the stale
snapshot and lost-update races, plus the `effect` hook's ordering guarantee),
`test/project-owner.test.mjs`, `test/secret-crypto.test.mjs`,
`test/users-file.test.mjs` (the three shared modules), and
`test/project-terminal-credentials.test.mjs` /
`test/project-terminal-start.test.mjs` (the host-mode entrypoint, the latter
against the real script and a real, privately-socketed tmux server).
