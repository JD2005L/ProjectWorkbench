# The session board

Every Claude session on this host writes a small status row; every session can
read the whole board. It exists because two sessions editing the same file found
out by accident, twice:

- `provisioniportal-86` and `pvibot-orchestrator-bi-control-plane` both edited
  `Allocation.cshtml` in ProVisionIPortal.
- In this repo, another session modified `app/server.js`, `app/ci-results.js` and
  `app/credential-writer.mjs` under a session that only noticed because it
  diffed before staging.

26 sessions were live on this host when that happened, out of 160 reachable
peers. `ListAgents` says a session exists; the board says what it is doing.

## Using it

```
pw-session-status show                  # the whole board, grouped by project
pw-session-status show --project Foo    # just one project
pw-session-status claims <path>         # who else is holding this file  (exit 3 = conflict)
pw-session-status set --task "..." [--waiting-on "..."]
pw-session-status set --done            # clear task, waiting-on and files in flight
pw-session-status prune [--apply]       # drop sidecars whose session is gone
```

**Check `claims` before you start editing shared code** — a file outside your own
project, or anything in a repo another session is also in. `claims` exits 3 when
another live session holds that exact path, and it also tells you which sessions
are working anywhere in the same project, because that matters before a branch
change or a push even when the file lists do not intersect.

**Set a task when you start work.** A row that says `(no task set)` tells a
colliding session nothing, so it cannot route around you.

## How it is stored

Two files per session, joined at read time:

| | Owner | Holds |
|---|---|---|
| `~/.claude/sessions/<pid>.json` | Claude Code | pid, sessionId, cwd, startedAt, version, peerFeatures, kind, tmux pane |
| `/opt/project-workbench/state/sessions/<pid>.json` | Project Workbench | project, branch, task, waiting-on, files in flight, updatedAt |

The registry is never written by PW — those files belong to Claude Code. The
sidecar directory is `PW_SESSION_BOARD_DIR` (declared in
`environments/common/profile.json`, since it is the same in every environment).

**Liveness is a process question.** A sidecar counts only while its pid is
running *and* its `/proc` start time still matches the one the registry recorded.
Without that second check a recycled pid would make a dead session's claims look
current — worse than no board, because it would route work away from a file
nobody holds. A session that is running but has never reported still appears, as
`(not reporting)`; omitting it would make the board look authoritative when it is
merely quiet.

**Every field is bounded** (`LIMITS` in `app/session-board.js`): the board is
written by a hook on every edit by every session, so unbounded strings and an
unbounded file list would eventually cost more to read than the board saves.

## What keeps it current

Two hooks in `~/.claude/settings.json`, both `async` so they can never add
latency to an edit or block one:

| Hook | Matcher | Effect |
|---|---|---|
| `PreToolUse` | `Edit\|Write\|NotebookEdit` | records the file as in flight |
| `Stop` | — | clears files in flight at the end of a turn |

`pw-session-status hook` always exits 0 and swallows its own errors. A status
board must never be the reason a tool call fails.

### Known gap: edits made through Bash

PW sessions in bypass mode are told to edit with `sed`/heredocs through the Bash
tool, and the `PreToolUse` matcher above does not see those. The fix is a
`PostToolUse` hook on `Bash`, which receives the list of files a command changed
in `tool_response` (that list is produced by `bashEditDiffEnabled`, on by default
when the Bash tool handles edits). That is not wired yet — the field name has to
be confirmed against a real payload first rather than guessed. Until then, a
Bash-driven edit does not auto-register, so `set --task` and a deliberate
`claims` check are what cover shared work.

## Not built yet

Deliberately out of scope for this first version, pending a decision:

- **Orchestrator by assignment.** James names an orchestrator per project, or a
  lock file records it; workers claim tasks and report back. Worth doing once the
  board shows it is needed, not before.
- **Rate-limited chatter.** Peer messaging is now auto-accepted
  (`crossSessionInbound: accept`, DECISIONS.md 2026-10-21), so a chatty
  orchestrator costs tokens in every session it talks to.
- **A sender filter on peer messages.** `crossSessionInbound` has none; it is
  accept-all or hold-all. "Same project only" would need a PW convention or a
  wrapper.
