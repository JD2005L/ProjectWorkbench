# GitHub authentication and credential lifecycle

Repository authentication is a reusable Project Workbench concern. It must not
depend on an organization-specific knowledge service, an agent's memory, or a
token copied into a repository URL.

This guide describes the existing credential mechanisms and the operating
process. It does not provision, validate, or migrate a particular credential.

## Keep identity, authorization and storage separate

- A successful GitHub login or clone does not establish permission to push.
  Confirm access to the intended repository, using the intended credential.
- Git commit author names and email addresses do not grant GitHub access.
- A user's normal GitHub login and an approved repository-maintenance
  credential are not interchangeable. Do not replace a personal credential
  globally just to make one repository writable.
- Prefer a repository-scoped credential with the minimum permissions for the
  required Git and pull-request operations. Workflow editing needs its own
  permission when that operation is actually required.
- Record an owner responsible for renewal, an expiry/review date, and an
  identifiable purpose. Do not treat a token as permanent access.

## Credential homes

| Execution location | Credential mechanism |
|---|---|
| Windows checkout | Git Credential Manager backed by Windows Credential Manager; use its protected authentication flow. |
| GitHub CLI | Its supported credential store and the intended GitHub account. Do not assume the currently active personal account can write every repository. |
| PW-managed workspace | The selected PW user's encrypted GitHub-token field and the existing project Git-credential synchronization mechanism. |

These stores are separate. Saving a token in PW does not configure a Windows
checkout, and signing into `gh` on Windows does not update PW's user store.
Choose the intended helper/account for the repository rather than installing
competing helpers or silently switching every project's identity.
Confirm that the CLI uses OS-backed storage; a plaintext fallback must not be
described as an encrypted credential vault.

Keep remote URLs credential-free:

```text
https://github.com/OWNER/REPOSITORY.git
```

Never put token values in tracked files, `.pw/deploy.json`, remote URLs, command
arguments, screenshots, audit records, chat, or documentation. Do not display
existing remote configuration until any embedded credentials have been removed
or safely redacted.

## PW configuration

An administrator configures the existing UI:

1. In **Settings -> Users & Roles**, edit the intended PW user and enter the
   credential in **GitHub token**. The authoritative `ghToken` field is
   encrypted with the app's AES-256-GCM mechanism; API responses expose only
   whether a token exists.
2. In **Manage projects -> General -> Git identity**, select that PW user for
   the project. The saved `primaryUser` identifies whose token Git uses.
3. Confirm the project is bound to the intended credential before attempting
   a push. Obey any terminal-restart or stale-credentials notice and save
   running work before changing/recreating sessions.

This is currently a **per-user token with per-project identity selection**,
not an independent token slot for every repository. Updating a user's token
affects all projects bound to that user. When `PW_PER_USER_CLAUDE` is enabled,
the project owner also controls the terminal's Claude/Copilot credential
context. Do not change this assignment merely to fix Git without considering
those other projects and identities.

### Security boundary

PW's encrypted user field is authoritative, but the existing Git helper
materializes a decrypted working credential in `.git/.pw-credentials`, mode
`0600`, and configures Git to use it. The credential writer runs as the
validated workspace owner and receives secrets through stdin, not argv.

**This is not an isolated vault.** PW terminals share an OS account, so mode
`0600` does not hide a working credential from other terminals with that same
UID. The protection against privileged writes must not be mistaken for
cross-user secret isolation. If that isolation is required, use an approved
isolated credential architecture rather than claiming the current helper
provides it. See [the existing threat model](per-user-claude-credentials.md).

## Validate before recording a credential as usable

1. Confirm the canonical repository and approved credential owner.
2. Authenticate through the chosen protected store without printing its value.
3. Check the credential's access to the exact repository and required
   operations. Read access alone is not sufficient.
4. Use a non-mutating Git push preflight for the intended branch, then perform
   only the already-authorized push/PR operation. A preflight does not replace
   branch protection, CI, or the eventual successful operation.
5. Record only the repository, credential reference, permission requirements,
   verification date/result, and renewal responsibility. A stored entry or an
   old description of its scopes is not proof that the token still works.

Stop on authentication or authorization failure. Establish the correct
approved credential or repository access; do not try unrelated identities or
repositories to get past a denial.

## Rotation and migration

Revoke a token exposed in a URL, screenshot, log, or chat even if it still
works. Install a replacement through the protected credential mechanism,
validate the intended operation, and update the non-secret maintenance record.
Never ask someone to paste the replacement into an agent conversation.

When moving from another store, keep the transfer within approved credential
management interfaces. Do not stage the value in source files or temporary
plaintext handoff files. Confirm the replacement and its consumers before
removing obsolete stored copies; exposed tokens must still be revoked promptly.

Document this operating contract with Project Workbench. Store credentials in
their runtime credential system, not in an organization-specific knowledge base.
