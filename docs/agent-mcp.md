# An MCP surface for driving a project session from an external AI

Status: **spec, not built.** Decisions for the operator are at the end.

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

## The marker rule: an agent types into its OWN lane

`pw_send_prompt` refuses a window this service did not create, unless the token
carries `sessions:prompt:any`.

This is `app/orchestrator/session.js`'s rule, and it is worth restating because it
is the difference between a feature and an incident: **a window belongs to a token
only if it carries the role marker this code set** — not because the name matches.
A tmux window whose pane is running `bash` turns an injected "prompt" into a shell
command executed as the pane account. So:

- windows this surface creates are marked (`@pw_agent_token`, `@pw_agent_user`) and
  are started on a CLI (`claude`, `copilot`), never a bare shell;
- an unmarked window — a human's tab — is refused by default, with an error that
  names the alternative ("create your own session, or ask an operator for
  `sessions:prompt:any`");
- `sessions:prompt:any` exists because there IS a legitimate case (an operator
  wiring an assistant into their own working tab) and it should be a visible,
  separately-granted decision rather than the default.

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

1. **Token model**: `actsAs`, `projects`, the three scopes, intersection rule, and
   the Users/Tokens UI fields to mint one. Nothing else changes.
2. **REST engine**: projects / send-prompt / read-session, with the marker rule and
   the audit line. Usable immediately with curl.
3. **Turn latch**: `turn_id`, the bell-generation cursor, `pw_wait_for_turn` /
   `pw_get_turn`, and `since_turn` on the read. This is what closes the loop the
   feature exists for — decide, send, wait, read — so it is not a later phase.
4. **MCP façade** over that engine at `POST /api/mcp`, plus the config snippet
   above in the docs.

## Decisions needed

1. **Is `sessions:prompt:any` allowed to exist on this instance?** It permits an
   agent to type into a human's tab. My recommendation: build it, grant it to
   nobody by default, and require it to be set per token.
2. **Default CLI for a created session** — `claude`, or follow the project's
   configured default launcher?
3. **One token per bot, or per bot-and-person?** `actsAs` makes a token personal;
   two people wanting the same bot means two tokens. That is my recommendation
   (it keeps the audit honest), but it means the bot holds several credentials.
4. **Prompt size cap** — a sensible default is 8 KB; a pane is not a file upload.
5. **Longest single wait** — I suggest a 10-minute ceiling per `pw_wait_for_turn`
   call, with the agent free to call again. A deploy or a long refactor outlasts
   any single HTTP request worth holding open.
6. **Should `pw_read_session` be allowed on unmarked (human) windows?** Reading is
   less dangerous than typing, but it is still somebody's screen. My
   recommendation: yes for windows in projects the acting user can already open
   (they can read them in the dashboard anyway), and no for anything else.
