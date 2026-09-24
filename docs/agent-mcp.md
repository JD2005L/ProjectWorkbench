# An MCP surface for driving a project session from an external AI

Status: **built.** Phases 1–4 (token model, REST engine, turn latch, MCP façade)
landed 2026-09-23; workspace reads, session transcripts and the `_inbox` write
landed 2026-09-24. Ten tools. `AGENTS.md` — served unauthenticated to external
agents — documents the surface for them.

## What already exists, so this builds rather than duplicates

Three of the four pieces are in the tree today:

| Piece | Where | State |
|---|---|---|
| Machine tokens: `pwat_` prefix, SHA-256 digests, explicit scopes, revoke-not-delete | `app/api-tokens.js` | live, one scope (`projects:register`) |
| A closed MCP tool adapter — no shell tool, no path-taking tool, sampling deliberately unadvertised | `app/orchestrator/mcp.js` | **written, served by nothing** (only `test/orch-mcp.test.mjs` imports it) |
| Creating a named tmux window in a project, as a named user's launcher, with that person's CLI credentials | `newTmuxWindow(project, name, cmd, launcher)` in `app/server.js` | live — it is what the cockpit's "+" does |
| HTTPS in front of all of it | nginx + `app/tls-config.js` | live |

What does **not** exist is the thing asked for: a tool that takes a prompt and
puts it into a named session. The orchestrator is a different shape — jobs,
stages, approvals, questions, artifacts, publication — and it is inert unless an
operator configures it. This spec is the small surface: type this, read that.

It also does not replace the orchestrator. If the goal is governed multi-stage
work with approvals and attestation, that subsystem is the answer and this one
should not grow into it.

## The tools

Six, closing the loop the feature exists for — **decide, send, wait, read** — plus
discovery. The closure of the set is the security control — the same rule
`app/orchestrator/mcp.js` states: a capability is added by an explicit, reviewable
edit to an allow-list that a test compares against the exported set.

### `pw_list_projects`
No input. Returns the projects this token may reach: `[{ name, sessions: n }]`.
Discovery only, so an agent does not have to be told the instance's layout.

### `pw_list_sessions`
`{ project }` → `[{ session, kind, busy, hibernated, owned }]`, where `owned` says
whether this token created the session (see the marker rule). A human's windows
appear, because hiding them would invite an agent to create a colliding name.

### `pw_send_prompt`
`{ project, session, prompt, create_if_missing = true, cli = "claude" }`
→ `{ session, window, created, injected_chars, turn_id, cursor }`

Injects the text into that session's pane as keystrokes, exactly as the documented
`tmux send-keys` path does. If the named session does not exist and
`create_if_missing`, it is created through `newTmuxWindow()` under the token's
acting user, so the tab spends **that person's** Claude/Copilot credentials and
carries their tab colour — which is what makes the audit trail and the CLI
identity agree.

The `turn_id` is what makes this usable by a decision-making agent: it names the
turn this prompt started, so the caller waits for *that* turn rather than guessing
from output that stopped changing.

### `pw_wait_for_turn`
`{ project, session, turn_id, timeout_ms = 60000 }`
→ `{ state: "completed" | "running", waited_ms }`

Long-polls, server-side, up to a bounded timeout (≤ 10 min). `running` on timeout
is not an error and not a failure — it means "ask again", and an agent that wants
to keep waiting calls it again. See *Completion* below for what `completed`
actually asserts.

### `pw_get_turn`
`{ project, session, turn_id }` → the same shape without blocking, for an agent
that would rather drive its own loop.

### `pw_read_session`
`{ project, session, lines = 200, since_turn = null, include_scrollback = false }`
→ `{ session, lines, text, truncated, cursor }`

`tmux capture-pane -p` over the session's pane, tail-first, capped. `lines` is
bounded (≤ 2000) because an agent asking for "everything" on a long-running pane
would otherwise pull megabytes through a tool result. With `since_turn`, the text
is trimmed to what appeared after that turn's prompt was injected — which is the
"what was the result" half of the loop the caller is trying to close.

### `pw_session_transcript`
`{ project, session, messages = 20 }` → the conversation, newest last, with
`session_id` and `resolved_by`.

The screen is not the record. `pw_read_session` returns whatever the TUI painted —
spinners, box drawing, frames since redrawn over — while this is what was actually
said and which tools ran. It reads from the **acting account's own** Claude config
tree (`<config>/projects/<cwd>/<session-id>.jsonl`), so one launcher's
conversations are not another's to read.

`resolved_by` is `window-marker` when the window carries `@pw_claude_sid` (exact)
or `most-recent` when it took the newest conversation for that project — which,
with two sessions open in one project, may not be the one you prompted. Said
rather than hidden; one agent lane per project avoids the question.

Its own scope, `sessions:transcript`, never implied by `sessions:read`: a
transcript is everything the operator said and everything the agent read, which is
a different thing to hand over than a screenful of output.

### `pw_workspace_tree` / `pw_workspace_file`
`{ project, path?, max_entries? }` and `{ project, path, max_bytes? }`, scope
`workspace:read`.

Read-only, and confined by `app/workspace-file.js` through the same
privilege-dropped worker the Files tray uses — the dashboard performs no
filesystem operation in a pane-owned tree as root, because the superseded upload
path proved what a planted symlink does to one that does. Three controls, in the
order they matter:

1. **The request cannot describe an escape.** Absolute paths and `..` are refused
   before any filesystem call.
2. **Realpath confinement.** Both ends are resolved and the target must sit inside
   the project root, so a link pointing out of the workspace is a refusal rather
   than a read.
3. **A credential deny-list** (`.git/.pw-credentials`, `.env*`, keys, `.ssh`,
   `.claude`), which is the *weakest* of the three and is not relied on: the real
   protection is that a token only reaches projects its acting user reaches, and
   that every read is audited with its path and size — never its contents.

Reads are capped (256 KB, truncation reported), a binary reports its size instead
of returning bytes, and a listing marks denied entries rather than hiding them —
hiding one only invites a caller to keep guessing at it.

### `pw_put_inbox_file`
`{ project, filename, content, base64? }`, scope `workspace:inbox`.

The one write, and it writes to the project's `_inbox` — where a human hands a
session a document too. It appears in the operator's Files tray exactly as an
upload does, and it does nothing by itself: the reply carries the path and says to
follow with `pw_send_prompt` naming it, because a file is not work until something
is told to look at it.

**Project source stays read-only on purpose.** A change made through the agent
inherits the project's tests, conventions and review; an audit line reading "the
agent did this work" beats one reading "a token wrote 40 files".

## Authority: a token acts as a person, and can never exceed them

Today a token record carries `createdBy` — provenance, who minted it. That is not
authority, and reusing it as authority would be the bug. The record gains:

```json
{
  "id": "…", "label": "PVIBot", "digest": "…",
  "scopes": ["sessions:read", "sessions:prompt", "sessions:create"],
  "actsAs": "kevin.charlebois",
  "projects": ["AITDataHub", "SponsorPortal"],
  "createdBy": "james.levac",
  "createdAt": "…", "lastUsedAt": null, "disabled": false
}
```

- **`actsAs` is required for any `sessions:*` scope.** Minting one without it is
  refused, because a session has to run as somebody: the window's launcher, the
  CLI credentials it spends, and the audit line all come from this field.
- **Authority is the INTERSECTION of the token and the person**, never the union.
  If `actsAs` loses access to a project (or is disabled, or deleted), every token
  acting as them loses it in the same instant, with no token edit. A token is a
  delegation of an existing account's reach, not a parallel grant — otherwise
  offboarding a person would leave their robots running.
- **`projects` narrows further**, so a token for one integration cannot wander the
  instance. `'*'` is allowed and means "whatever `actsAs` can reach".
- New scopes: `sessions:read`, `sessions:prompt`, `sessions:create`. Separate,
  because reading somebody's pane and typing into it are different powers, and
  creating windows is different again.
- There is still **no `admin` scope**, for the reason already written into
  `app/api-tokens.js`: a credential that lives on somebody's laptop must not reach
  the dashboard's 29 admin routes.

## What may be prompted (revised 2026-09-24)

The first version of this refused any window the token had not created, borrowing
`app/orchestrator/session.js`'s marker rule. In use that read as *"Bi-Tools is
Kevin's, my token acts as Kevin, why can I not type into it?"* — a fair
complaint, because **ownership was never the hazard.** Two things are:

- a pane running a **shell**, where injected text is executed as a command;
- a pane spending **somebody else's** Claude/Copilot seat, which would bill their
  credentials for this token's turn and put the wrong name on it.

So the decision is made on what the pane is running and whose credentials it
carries. Project access — already required, and already the intersection of the
token and the account it acts as — covers the rest:

| Pane | Prompt allowed? |
|---|---|
| `claude` / `copilot` | yes, created by this token or not |
| `node` **and** PW created it as an agent tab (credential stamp or Claude marker) | yes |
| `node` with no such marker (a dev server, say) | no — ambiguous, and guessing means executing a prompt in a shell |
| `bash`, `vim`, anything else | no — the text would be executed |
| hibernated | no — it must be resumed first, and the error says so |
| runs on another account's CLI credentials | no — that spends their seat |

`sessions:prompt:any` overrides all of it, which is its entire purpose: an
operator wiring an assistant into a tab it does not own, decided deliberately and
granted separately.

Windows this surface creates are still marked (`@pw_agent_token`,
`@pw_agent_user`) and still started on a CLI rather than a shell — the marker is
now a fast path and an audit aid rather than the gate. And `pw_list_sessions`
answers `promptable` per session with `not_promptable_because`, so a caller reads
the answer instead of inferring it and getting it wrong in both directions.

## Completion: how PW already knows a turn ended

This is the part not to reinvent. The dashboard does not guess from output
quiescence — it reads tmux's `window_bell_flag` (`parseTmuxWindows` /
`projectSignals` in `app/server.js`), which is how a finished turn lights the tab's
attention dot today:

- **Claude Code** rings the bell itself: `preferredNotifChannel=terminal_bell`.
- **Copilot CLI** has no bell setting, so `scripts/pw-agent-done.sh` rings it from
  Copilot's `agentStop` hook — a script whose header documents the three routes
  that do *not* work in this topology, and which exists precisely so Copilot panes
  signal like Claude's.
- **Claude's `Stop` hook** additionally writes `/var/lib/project-workbench/pending/<Project>`
  for the landing page's unread indicator.

A turn record therefore stores the window's bell generation at injection time, and
`completed` means **a new bell arrived for that window after this turn's prompt**.

Two properties that have to be built deliberately:

- **A human must not complete an agent's turn.** The cockpit clears the *unread*
  marker when somebody opens the terminal (`test/completion-latch.test.mjs` pins
  exactly when that is allowed to happen). The agent's turn latch is separate
  state: opening the tab acknowledges the human indicator and must leave every
  in-flight `turn_id` alone.
- **A bell that predates the prompt does not count.** The cursor is taken before
  the keystrokes go in, so a turn cannot complete on somebody else's earlier bell.

And one honest limit, which belongs in the tool description the agent reads:
**`completed` asserts the agent stopped, not that it succeeded.** A refusal, a
crash, a question asked back to the operator and a finished task all ring the same
bell. The calling AI decides what happened by reading the output — which is why
`pw_read_session` takes `since_turn`. A CLI that rings no bell at all (a plain
shell, an unhooked tool) has no completion signal; `pw_wait_for_turn` says so
rather than waiting out its timeout pretending.

## Transport

`POST {BASE}/api/mcp`, JSON-RPC 2.0, bearer token in `Authorization`. Methods:
`initialize`, `tools/list`, `tools/call`, `ping`. Protocol version follows the
in-tree adapter (`2024-11-05`), and **`sampling` is not advertised** — for the
reason already documented in `app/orchestrator/mcp.js`: a server that can ask its
client to run inference has inverted the control direction the product depends on.

An external agent adds it the way it adds any HTTP MCP server:

```json
{ "mcpServers": { "project-workbench": {
  "type": "http",
  "url": "https://vnl2422.rm.gov.ab.ca/workbench/api/mcp",
  "headers": { "Authorization": "Bearer pwat_…" }
} } }
```

The same four operations are also plain REST — `POST {BASE}/api/agent/prompt`,
`GET {BASE}/api/agent/session`, `GET {BASE}/api/agent/projects` — because a shell
script or a cron job should not have to speak JSON-RPC, and because the REST twin
is what the tests drive. One engine, two façades: the MCP adapter owns no
authorization logic of its own, which is the rule the orchestrator's adapter
already follows.

CSRF does not apply (bearer, not cookie), and the existing gate already
recognises `looksLikeApiToken()` to decide a request is a machine call. Rate
limit: per token, per project, enough to stop a loop hammering a pane.

## What gets logged

Every call writes an audit record: token id and label, `actsAs`, the effective
project and session, the tool, whether a window was created, and the **length** of
the injected text.

Not the prompt body. A prompt can carry anything the sending agent had in context,
and `/var/log/project-workbench/audit.log` is read by more people than the pane
is. The pane itself is the record of what was said; the audit is the record of who
said it and where.

## Reuse, explicitly

| Need | Existing thing |
|---|---|
| authenticate the caller | `presentedToken()`, `resolveToken()`, `tokenHasScope()` |
| create a named window under a person | `newTmuxWindow(project, name, cmd, launcher)` |
| list windows with busy/hibernated state | `listTmuxWindows(project)` |
| inject keystrokes | `tmux send-keys` (the path `AGENTS.md` documents) |
| read a pane | `tmux capture-pane -p -S -<n>` |
| project visibility for a person | `userHasProjectAccess()`, `filterProjectsForUser()` |
| MCP tool-surface conventions | `app/orchestrator/mcp.js` (`ALLOWED_TOOLS`, forbidden fragments, no sampling) |

## Tests to write

| Test | Why |
|---|---|
| a `sessions:*` token without `actsAs` cannot be minted | authority must have a subject |
| token authority is the intersection: `actsAs` losing a project revokes it live | delegation, not a parallel grant |
| a disabled or deleted `actsAs` fails every call | offboarding must not leave robots running |
| each scope is checked independently (read ≠ prompt ≠ create) | separate powers |
| an unmarked (human) window is refused without `sessions:prompt:any` | the incident this prevents |
| a created window is marked, runs a CLI, and never a bare shell | ditto |
| the created window's launcher is `actsAs`, not `createdBy` | the CLI identity and the audit must agree |
| `tools/list` equals the allow-list exactly | a capability cannot be added quietly |
| `sampling` is absent from `initialize` | control direction |
| the audit line carries who/where and the injected LENGTH, never the text | log hygiene |
| `pw_read_session` caps its output | one tool call cannot pull a pane's whole history |
| a human opening the tab does not complete an in-flight `turn_id` | the human indicator and the agent latch are separate state |
| a bell that arrived BEFORE the prompt does not complete the turn | the cursor is taken before injection |
| a timeout answers `running`, never `failed` | "ask again" is not an error |
| a pane with no completion signal says so instead of waiting out the timeout | an agent must not be left guessing |
| `since_turn` returns only what appeared after that prompt | the result half of the loop |
| a cookie session cannot call `/api/mcp`, and a token cannot call a dashboard route | the two surfaces share no credential material |

## Rollout

1. ~~**Token model**~~ — built (`1a602f1`): `actsAs`, `projects`, the four session
   scopes, `tokenAuthority()`'s intersection rule, and the Settings ▸ API tokens
   fields to mint one.
2. ~~**REST engine**~~ — built: `app/agent-sessions.js` plus four routes under
   `{BASE}/api/agent/`. Usable with curl today:

   ```bash
   TOKEN=pwat_…
   curl -fsS -H "Authorization: Bearer $TOKEN" https://host/workbench/api/agent/projects
   curl -fsS -H "Authorization: Bearer $TOKEN" https://host/workbench/api/agent/AITCtrl/sessions
   curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"prompt":"summarise the last deploy failure","cli":"claude"}' \
     https://host/workbench/api/agent/AITCtrl/sessions/bot-lane/prompt
   curl -fsS -H "Authorization: Bearer $TOKEN" \
     'https://host/workbench/api/agent/AITCtrl/sessions/bot-lane/output?lines=120'
   ```
3. ~~**Turn latch**~~ — built: `app/agent-turns.js`, `turn_id` on every prompt,
   and one route that answers now or holds the request open:

   ```bash
   TURN=$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"prompt":"run the tests and summarise failures","cli":"claude"}' \
     https://host/workbench/api/agent/AITCtrl/sessions/bot-lane/prompt | jq -r .turn_id)

   # hold the request open until it finishes (bounded; `running` means ask again)
   curl -fsS -H "Authorization: Bearer $TOKEN" \
     "https://host/workbench/api/agent/AITCtrl/sessions/bot-lane/turns/$TURN?wait_ms=120000"

   # and read just what that turn produced
   curl -fsS -H "Authorization: Bearer $TOKEN" \
     "https://host/workbench/api/agent/AITCtrl/sessions/bot-lane/output?since_turn=$TURN"
   ```

   `completed_by` says which signal ended it — `bell` (unambiguous) or `quiet`
   (the cadence fallback) — because those are different levels of confidence and a
   caller may care.
4. ~~**MCP façade**~~ — built: `app/agent-mcp.js` at `POST {BASE}/api/mcp`.
   Six tools, a closed allow-list a test compares against the exported
   definitions, closed input schemas, and `sampling` unadvertised. An engine
   refusal comes back as a tool RESULT with `isError` rather than a JSON-RPC
   error, so the calling model can read "that is not your lane" and adapt instead
   of seeing an opaque transport fault.

## Decisions — settled 2026-09-23

1. **`sessions:prompt:any` exists, granted to nobody by default.** It has to be
   set explicitly per token, so typing into a human's tab is a visible decision.
2. **The CLI is named by the REQUEST, not configured** — `cli: "claude" | "copilot"`,
   and it applies only when a session is being created. An existing session
   continues with whatever it is already running; the field is ignored rather than
   enforced, because a token cannot know (and must not change) what a live pane is.
   A create with no `cli` is refused rather than defaulted: "start a Claude
   session" and "start a Copilot session" spend different credentials.
3. **One token per bot.** A bot holds a single credential and therefore acts as a
   single person — everything it does is attributed to that `actsAs`, and two
   people wanting separately-attributed work means two bots.
4. **Prompt cap 256 KB**, which is roughly 40–60,000 words: "large and specific"
   was the requirement, and the mechanism below makes it safe. Above that, send a
   file instead (see *Sending something big*).
5. **10-minute ceiling per `pw_wait_for_turn`**, the agent free to call again.
6. **`pw_read_session` on human windows: allowed** where the acting user could
   already open that project in the dashboard — they can read the pane there
   anyway — and refused otherwise.

## Sending something big, and how the text actually gets in

`send-keys` is the wrong instrument for a large prompt: it types argv, and a
several-hundred-kilobyte argument is both an ARG_MAX question and a stream of
keystrokes into a TUI's input handling. The injection therefore uses tmux's paste
path, which is what a human paste is:

1. write the prompt to a mode-0600 temp file (the tmux server runs as root);
2. `load-buffer -b pw-agent-<turn>` that file;
3. `paste-buffer -d -p -b pw-agent-<turn> -t <pane>` — `-p` for bracketed paste, so
   a CLI that collapses pastes into "[Pasted text]" sees one paste rather than
   40,000 keystrokes, and `-d` so the buffer does not linger in the server;
4. `send-keys -t <pane> Enter` to submit;
5. delete the temp file, whatever happened.

Beyond 256 KB the right shape is a file, not a prompt: the caller puts the content
in the project's `_inbox/` (the upload endpoint already exists and the Files tray
already surfaces it) and sends a short prompt naming the path. That is how a human
hands a large document to a session, and it keeps the pane's history readable
instead of burying it under a novel.
