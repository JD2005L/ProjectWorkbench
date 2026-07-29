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

## Which account owns the credential files

The dashboard process runs as root. The agent pane does **not** — in either
deploy mode:

| Mode | How the pane is spawned | Pane account |
|---|---|---|
| `container` + `PW_TERMINAL_UID` | root `tmux()` → `setpriv --reuid <uid>` | that uid |
| `container`, no `PW_TERMINAL_UID` | `tmux` as root | root (no handover needed) |
| `host` | `sudo -u admin tmux …` | `admin` |

So every level PW creates under `PW_USER_CRED_BASE` is `chown`ed to the pane's
account, or the `0700` directory would be root-owned and the pane's `claude`
could not write its login into it.

Crucially this is **not** the same question as the `setpriv` drop in
`app/terminal-priv.js`. That drop is deliberately disabled in host mode (the pane
is already unprivileged there, so there is nothing to drop), and deriving
ownership from its `enabled` flag silently skipped host mode entirely — leaving
the feature inert on every host-mode instance while appearing to work.
`app/terminal-owner.js` answers the ownership question separately:

- container mode takes the uid/gid straight from `PW_TERMINAL_UID`/`_GID`;
- host mode resolves `admin` through `getent passwd` (so directory-backed
  accounts work) and falls back to `/etc/passwd`;
- an account that resolves to uid/gid 0, to two entries, or not at all is
  **refused** — there is no fallback to root.

If ownership cannot be established, PW logs a warning and falls back to the
**shared** login rather than pointing an agent at a directory it cannot read. The
session then reports as credential-stale (below), so the misconfiguration is
visible instead of silent.

## Where the GitHub token lives

The owner's token is written to `<PW_USER_CRED_BASE>/<user>/session-env.sh`,
mode `0600`, owned by the pane account, and the pane shell sources it
(`bash --noprofile --rcfile <file>`).

It is deliberately **not** passed as an `env GH_TOKEN=… ` token on the tmux
command line. tmux retains a pane's start command for the life of the pane —
`tmux list-panes -F '#{pane_start_command}'` prints it — and every pane on a
workbench runs as the same OS account, so an argv token would publish one user's
token to every other project's terminal. This mirrors what `syncProjectCredentials`
already does for git credentials.

`CLAUDE_CONFIG_DIR` is not secret and is still passed as a normal env token.

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

- **Accountability, not isolation.** All terminals still run as one OS user.
  Per-user credential *dirs* separate whose login is used, but a user with a
  shell in any project can read another user's dir on disk. True cross-user
  isolation would require per-user OS accounts (a larger change). Keeping the
  token out of argv narrows the exposure — it is no longer readable from a
  process listing or `tmux list-panes` — but it does not close this gap.
- **Credentials are the owner's, not the actor's.** Anyone with access to a
  project uses the `primaryUser`'s account/quota, because terminals are one
  shared session per project.
- **Seats.** Each owner needs their own Claude seat (Enterprise/Max/Pro) and, for
  Copilot, their own GitHub Copilot licence.
- Specialised spawn paths (`ensureProjectTmuxSession` / PVIKPBot) are not wired
  for per-user creds; only the standard project terminals and manually-opened
  tabs are.

## Implementation

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
hostile account names) and `test/user-credentials.test.mjs` (ownership handover
in both modes, fail-closed behaviour, token placement, drift detection).
