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

## Interaction with non-root terminals (`PW_TERMINAL_UID`)

The dashboard process runs as root, but when `PW_TERMINAL_UID` is set in
container mode the agent panes are dropped to that uid (see
`app/terminal-priv.js`). Because the credential dirs are created by the root
dashboard and then read/written by the dropped pane, every level PW creates
under `PW_USER_CRED_BASE` is `chown`ed to the terminal uid/gid. Without that the
`0700` dir would be root-owned and the pane's `claude` could not write its login
into it. When the drop is inactive the `chown` is skipped entirely, so a
shared-root deployment behaves exactly as before.

## Scope & limitations

- **Accountability, not isolation.** All terminals still run as one OS user
  (uid 1001). Per-user credential *dirs* separate whose login is used, but a user
  with a shell in any project can read another user's dir on disk. True
  cross-user isolation would require per-user OS accounts (a larger change).
- **Credentials are the owner's, not the actor's.** Anyone with access to a
  project uses the `primaryUser`'s account/quota, because terminals are one
  shared session per project.
- **Seats.** Each owner needs their own Claude seat (Enterprise/Max/Pro) and, for
  Copilot, their own GitHub Copilot licence.
- Specialised spawn paths (`ensureProjectTmuxSession` / PVIKPBot) are not wired
  for per-user creds; only the standard project terminals and manually-opened
  tabs are.

## Implementation

`app/server.js`: `credentialSessionEnv(project)` computes the extra `env`
entries; it's spread into the tmux `env` in `ensureTmuxSession` and
`newTmuxWindow`. Helpers: `userClaudeConfigDir`, `userClaudeSignedIn`,
`ensureUserClaudeDir` (creates + MCP-seeds the dir). Status is exposed via
`GET /api/users` (`claudeSignedIn`, `perUserClaude`).
