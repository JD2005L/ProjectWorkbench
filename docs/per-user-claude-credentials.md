# Per-user Claude / Copilot credentials (opt-in)

By default every Project Workbench terminal shares **one** Claude login and one
GitHub/Copilot login (the box's shared credentials). This feature lets each
project run on its **assigned owner's own** credentials instead, so usage is
attributed to — and billed against — that person's seat.

## Model

A project is owned by its `primaryUser` (the "Primary user" field in the Manage
Projects modal, already used for git-push auth). When the feature is enabled,
that project's terminal launches with the owner's private credential context:

- **Claude** — `CLAUDE_CONFIG_DIR` is pointed at the owner's per-user config dir
  (`$PW_USER_CRED_BASE/<user>/claude`). The **first** `claude` run in the project
  performs the owner's normal OAuth login (`claude /login`) into that dir; it
  then persists. Team MCP servers (teamkb/pulse/skillhub, etc.) are seeded into
  the dir from the shared `~/.claude.json` so they keep working per-user.
- **Copilot** — the owner's stored GitHub token is injected as `GH_TOKEN`
  (Copilot authenticates via the GitHub CLI), so Copilot runs as that user.

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
