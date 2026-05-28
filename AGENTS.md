# AGENTS.md — Project Workbench for external AI agents

This file is for **AI agents and automation** that need to discover, observe,
or send prompts into the Claude Code sessions running on this Project
Workbench instance. It is served unauthenticated at
`http://<workbench-host>/agents.md` so a remote agent can fetch it directly:

```bash
curl -fsSL http://workbench.example.com/agents.md
```

If you are a human, the README (top-level) is what you want.

---

## The mental model

A Project Workbench instance hosts one or more **projects**. Each project is:

- a workspace directory under `/opt/project-workbench/workspaces/<Name>/`
  (typically a git clone of the project's repo)
- a persistent `tmux` session named `pw_<NormalizedName>` (non-alphanumeric
  characters in `<Name>` get replaced with `_`)
- one or more `tmux` **windows** inside that session — each window runs an
  interactive shell or a CLI such as Claude Code
- a browser-accessible terminal at `http://<workbench>/term/<Name>/` (ttyd
  inside an iframe, attached to the same tmux session)

When the user "is in a project terminal", they are typing into one window
of `pw_<Name>` via the dashboard. The Claude Code process running in that
window has access to the project's workspace as its cwd.

Project workspaces are owned by a shared Linux user (typically `admin`) so
**any agent with shell access on the box can `cd` into any project**. The
app-level role/permission system gates the HTTP dashboard, not the
filesystem. Treat the box as a shared trusted environment.

---

## Discover what's running

### List all PW tmux sessions

```bash
tmux list-sessions -F '#{session_name}'
# pw_AmrikPublic
# pw_HarmaniPublic
# pw_ProjectWorkbench
# pw_setup
```

`pw_setup` is the shared CLI-sign-in terminal (not a project).

### List windows inside a project session

```bash
tmux list-windows -t pw_AmrikPublic \
  -F '#{window_index}|#{window_name}|#{pane_current_command}|#{window_active}'
# 0|bash|claude.exe|1
# 1|dev|npm|0
```

Match `pane_current_command=claude.exe` to find windows where Claude Code
is currently the foreground process — that's the window where the user is
interacting with Claude.

### List Claude Code Remote Control sessions

Project Workbench launches every interactive Claude with `--remote-control`
by default (controlled by `PW_REMOTE_CONTROL` in
`/etc/project-workbench/claude-wrapper.env`). Live sessions are exposed by:

```bash
claude agents --json
```

Returns a JSON array of `{pid, cwd, kind, startedAt, sessionId, status, name?}`.
Match on `cwd` to find the project. `status` is `busy` or `idle`.

The raw daemon roster is at `/home/admin/.claude/daemon/roster.json` if you
need to read it directly.

---

## Inject a prompt into the user's session

There are three paths, ordered by directness.

### 1. `tmux send-keys` (shell access on the box)

Lowest-level, most reliable, works regardless of what's running in the window:

```bash
# Send a single line and press Enter
tmux send-keys -t 'pw_AmrikPublic:0' 'investigate the failing test in src/foo.test.ts' Enter

# Send a multi-line prompt (use a heredoc — tmux will type literal \n if you embed newlines incorrectly)
TEXT=$(cat <<'EOF'
Look at the build failure from this morning.
The relevant file is src/foo.test.ts. Compare against last week's passing run.
EOF
)
tmux send-keys -t 'pw_AmrikPublic:0' "$TEXT" Enter
```

**Etiquette:** check `pane_current_command` and `#{window_activity_flag}`
before sending — if the window's busy with another agent's turn, queue
your message instead of stomping on it. The user should not see the cursor
jump mid-keystroke.

### 2. `claude --print` with `--resume` (one-shot reply, no UI)

If you want a one-shot answer **without** typing into the user's interactive
window:

```bash
# 1. find the session you want to resume (match cwd or sessionId)
SID=$(claude agents --json | jq -r '.[] | select(.cwd=="/opt/project-workbench/workspaces/AmrikPublic" and .status=="idle" and .kind=="interactive") | .sessionId' | head -1)

# 2. fork a new transcript from that session with your prompt
claude --resume "$SID" --fork-session --print "your one-shot prompt here"
```

`--fork-session` keeps your one-shot turn from contaminating the user's
ongoing conversation. Output goes to stdout; the user's terminal is
untouched.

### 3. Dashboard HTTP API (no shell access)

If you can only reach the dashboard over HTTP (e.g., a remote agent that
isn't on the box):

```bash
# Sign in. Origin header must match the dashboard host (CSRF guard).
HOST=http://workbench.example.com
curl -fsS -c jar.txt -X POST "$HOST/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"username":"my-agent","password":"..."}'

# List windows in a project
curl -fsS -b jar.txt "$HOST/api/term/AmrikPublic/windows"
# {"ok":true,"windows":[{"index":0,"name":"claude.exe","active":true}, ...]}

# Spawn a NEW window with a starting command — useful for "open a side
# conversation with Claude in this project" patterns. The cmd is typed
# into the new window via send-keys after the shell starts.
curl -fsS -b jar.txt -X POST "$HOST/api/term/AmrikPublic/windows" \
  -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d '{"name":"agent-side","cmd":"claude"}'
```

**There is no HTTP endpoint to send keystrokes into an existing window**
in Phase 1. If you need that pattern, SSH in and use `tmux send-keys`, or
spawn a new window per turn.

To get an agent user with the right role:

```bash
sudo /usr/local/sbin/pw-user add my-agent --role developer --projects 'AmrikPublic,HarmaniPublic'
# (interactive password prompt; or pass --password '...' if scripting)
```

Roles for agents:

| Role             | Use when an agent should…                                   |
|------------------|-------------------------------------------------------------|
| `admin`          | …have full control (project CRUD, settings, users).         |
| `developer`      | …open terminals + run Claude + upload + start preview.      |
| `content_editor` | …drop files into `_inbox/` only; no shell.                  |
| `viewer`         | …observe dashboard + preview status only; no writes.        |

---

## Hand a file to the user

Push a file into a project's inbox; the user's interactive Claude session
sees it land in the prompt (drawer auto-opens with the path inserted).

```bash
# As shell user
cp /path/to/report.pdf /opt/project-workbench/workspaces/AmrikPublic/_inbox/

# Or via HTTP (any role with admin/developer/content_editor + project grant)
B64=$(base64 -w0 /path/to/report.pdf)
curl -fsS -b jar.txt -X POST "$HOST/api/upload/AmrikPublic" \
  -H 'Content-Type: application/json' -H "Origin: $HOST" \
  -d "{\"filename\":\"report.pdf\",\"mime\":\"application/pdf\",\"data\":\"$B64\"}"
```

---

## Shared instance memory

Before doing durable work in any project, read
`/opt/project-workbench/memory/CLAUDE.md`. It documents:

- **`CLAUDE.md`** — index and rules for this PW instance's shared memory
- **`TOOLS.md`** — reusable tools, install paths, gotchas (e.g., the
  shared tmux server lives in whichever terminal cgroup booted first;
  killing that service kills every PW Claude session)
- **`DECISIONS.md`** — cross-project decisions and standing instructions
- **`CREDENTIALS.md`** — local credential pointers (never echo to chat)

Update these files when you learn something reusable.

---

## Audit log

Every dashboard login, terminal open, upload, project CRUD, user-management
action, and settings change is appended as JSONL to
`/var/log/project-workbench/audit.log`. If you write an agent that calls
the HTTP API, your actions appear there with the username + role + IP.

Read it from a shell:

```bash
sudo tail -F /var/log/project-workbench/audit.log
```

---

## Etiquette

- **Don't interrupt a busy session.** Check `claude agents --json` for
  `status: "busy"` before sending a prompt; queue or back off.
- **Identify yourself** in prompts — `[agent-name]` prefix, or a system
  prompt the user pre-loaded. The user can't see your name otherwise.
- **Respect role boundaries.** If you have `viewer`, don't try to brute
  the upload endpoint — it'll 403 and log.
- **Use `--fork-session`** for one-shot `--print` resumes so the user's
  conversation doesn't get your noise.
- **Don't run destructive ops without explicit user authorization** —
  `rm -rf`, `git push --force`, schema changes, etc. Same rules as the
  user gives their own Claude sessions.

---

## Quick reference

| I want to…                                 | Run                                                           |
|--------------------------------------------|---------------------------------------------------------------|
| List all PW projects                       | `tmux list-sessions -F '#{session_name}'`                     |
| List windows in a project                  | `tmux list-windows -t pw_<Name> -F '#{window_index} ...'`     |
| Inject text into a window                  | `tmux send-keys -t 'pw_<Name>:<idx>' 'text' Enter`            |
| Discover live Claude sessions              | `claude agents --json`                                        |
| One-shot reply, don't touch user's window  | `claude --resume <id> --fork-session --print 'prompt'`        |
| Spawn a new side window via HTTP           | `POST /api/term/<Name>/windows {name, cmd}`                   |
| Drop a file into a project inbox via HTTP  | `POST /api/upload/<Name> {filename, mime, data: base64}`      |
| List PW users / roles                      | `sudo /usr/local/sbin/pw-user list`                           |
| Add an agent user                          | `sudo /usr/local/sbin/pw-user add ... --role ... --projects ...` |
| Tail the audit log                         | `sudo tail -F /var/log/project-workbench/audit.log`           |
| Read shared instance memory                | `cat /opt/project-workbench/memory/CLAUDE.md`                 |
