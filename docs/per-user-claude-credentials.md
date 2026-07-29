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

If the feature is off, the project has no `primaryUser`, or the owner isn't in
`users.json`, the terminal falls back to the shared login — nothing breaks.

## Enabling

Set on the app container / service environment:

```
PW_PER_USER_CLAUDE=true
# optional, default /home/admin/pw-users
PW_USER_CRED_BASE=/home/admin/pw-users
```

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

If ownership cannot be established, PW logs a warning and falls back to the
**shared** login rather than pointing an agent at a directory it cannot use. The
session then reports as credential-stale (below), so the misconfiguration is
visible instead of silent.

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

Deleting a user removes their credential tree, so a departed account's Claude
OAuth login and GitHub token do not linger on disk. The same sweep runs once at
startup, catching trees orphaned while the service was down or by an out-of-band
edit of `users.json`.

The prune runs as the pane account, like every other write into that tree, and is
deliberately conservative: it only removes a directory whose name is a canonical
encoding **and** which contains this feature's own layout (a `claude/` directory
or a `session-env.sh`). `PW_USER_CRED_BASE` is operator-configurable, so a
misconfiguration must not turn the sweep into an arbitrary delete.

## Changing credentials on a running session

A pane inherits its environment when it is created, so enabling
`PW_PER_USER_CLAUDE`, reassigning a project's `primaryUser`, or rotating a token
does **not** re-key a session that is already running.

PW stamps a non-secret fingerprint of the credentials on the tmux session at
creation (`@pw_cred_key`) and compares it on every status poll.
`GET /api/projects/status` reports `credentialsStale: true` when they diverge.

Recreating the session is destructive — it discards whatever is running in every
window — so it is never done implicitly. Reconcile it deliberately:

```bash
curl -X POST -b cookies.txt -H "Origin: $HOST" \
  "$HOST/api/term/<Project>/recycle"
```

The call is audited as `session_recycle`. New tabs opened with
`newTmuxWindow` always get current credentials, so a long-lived session can end
up mixed; recycling is what makes it uniform.

## Scope & limitations

- **Accountability, not isolation.** See the threat model above: all terminals
  run as one OS user, so a user with a shell in any project can read another
  user's credential dir on disk. Keeping the token out of argv narrows the
  exposure — it is no longer readable from a process listing or
  `tmux list-panes` — but it does not close this gap.
- **Changing `PW_USER_CRED_BASE` or a username strands the old tree.** Directory
  names are derived from the username, so a rename creates a fresh (empty)
  credential dir and the owner logs in again. The old tree is removed by the
  next prune.
- **Credentials are the owner's, not the actor's.** Anyone with access to a
  project uses the `primaryUser`'s account/quota, because terminals are one
  shared session per project.
- **Seats.** Each owner needs their own Claude seat (Enterprise/Max/Pro) and, for
  Copilot, their own GitHub Copilot licence.
- Specialised spawn paths (`ensureProjectTmuxSession` / PVIKPBot) are not wired
  for per-user creds; only the standard project terminals and manually-opened
  tabs are.

## Implementation

- `app/credential-writer.mjs` — the privilege-dropped helper that performs every
  write into the credential tree. Reads a JSON job on stdin, writes a JSON result
  on stdout.
- `app/user-store.js` — serialized, re-reading read-modify-write for
  `users.json`, so a slow request cannot write a stale whole-file snapshot back
  over a concurrent role change, token rotation, or deletion.
- `app/terminal-owner.js` — which OS account owns pane-visible files
  (`terminalOwnerPlan`, `parsePasswdEntry`, `resolveTerminalOwner`). Also exports
  `HOST_TERMINAL_USER`, which `server.js`'s `tmux()` uses for its
  `sudo -u` argument so the two cannot drift apart.
- `app/user-credentials.js` — creating and owning the credential material
  (`ensureUserCredentials`), the non-secret session stamp
  (`credentialFingerprint`), and the drift decision (`sessionCredentialState`).
- `app/server.js` — `credentialContext(project)` returns the extra `env` tokens,
  the pane shell argv, and the fingerprint; it is used by `ensureTmuxSession` and
  `newTmuxWindow`. `credentialsStale(p)` feeds `GET /api/projects/status`;
  `POST /api/term/:project/recycle` performs the explicit reconciliation.
  Sign-in status is exposed via `GET /api/users` (`claudeSignedIn`,
  `perUserClaude`).

Tests: `test/terminal-owner.test.mjs` (ownership resolution, passwd validation,
hostile account names), `test/user-credentials.test.mjs` (injective encoding,
planted-symlink regressions, privilege-drop planning, stdin token delivery,
pruning safety, drift detection) and `test/user-store.test.mjs` (the stale
snapshot and lost-update races).
