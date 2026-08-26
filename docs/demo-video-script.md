# Project Workbench — demo video script

**Audience:** technical managers and directors. Assume they know what a reverse proxy, a service unit and a directory bind are, that they are assessing operational risk while you talk, and that they cannot ask you anything — this is prerecorded.
**Length:** 622 spoken words — about 4:03 read aloud. Cut list at the bottom if you need to land under 3:30.
**Register:** analytical. State the constraint, name the mechanism, then the consequence. Avoid adjectives; the architecture is the argument.

---

## 0:00 – 0:14 · Open

**ON SCREEN:** Start on the sign-in page.

> Project Workbench is a browser front end for AI-assisted development. The problem it solves is fan-out: one
> developer running several agent sessions across several repositories, where the constraint isn't the model,
> it's tracking what's running where.

---

## 0:14 – 0:57 · Authentication and access model

**ON SCREEN:** Stay on the sign-in page. Point at the “Sign in with your GOA account” line and the firstname.lastname field, then sign in with your own AD credentials.

**Nobody can ask this afterwards, so it goes first and it goes in full.**

> Access first. The application stores no passwords. It authenticates by simple bind against GOA Active
> Directory over LDAPS, with the domain controller's certificate validated against the trust store, and the bind
> password passed as a private file rather than on a command line. A successful bind is necessary but not
> sufficient: the account also has to exist in the local access record, which carries the role and project
> grants. Sessions are server-side and revocable, administrative actions are audit-logged, and the site is
> HTTPS-only on the internal network. The terminal processes themselves bind to loopback and are only reachable
> through the authenticated proxy, so there is no unauthenticated route to a shell.

---

## 0:57 – 1:14 · The aggregation layer

**ON SCREEN:** Expand the project rail, then switch between two or three projects so the cost of a context switch is visibly near zero.

> This is the aggregation layer: one key per project. The switch is a route change, not a reconnect — nginx maps
> each project to its own terminal endpoint. Context switching costs nothing, which is the precondition for
> running six projects rather than two.

---

## 1:14 – 1:40 · Session model, and why the CLI runs server-side

**ON SCREEN:** Open the + menu, add a window, rename a tab. End on three or four named tabs: refactor, tests, build watcher.

> Inside a project I can open as many named tmux windows as I want. The tmux server runs in a sidecar container,
> so redeploying the dashboard doesn't disturb a single session. And because the CLI runs on an always-on server
> rather than my laptop, its context survives disconnects, and whoever picks the session up next inherits it. At
> this fan-out, naming is how thirty windows stay legible.

---

## 1:40 – 2:12 · Completion signalling

**ON SCREEN:** A window that has just finished, tab pulsing amber. Switch to a different project so the finished one is still lit in the rail. Point out the auto-pin toggle and the pinned project at the top.

**Slow down. This is the section that differentiates the tool.**

> Completion is event-driven rather than screen-scraped. The CLI's stop hook writes a marker when a turn ends,
> and the dashboard also reads each window's bell flag. The tab carries the window-level signal, the rail the
> project-level one, so I'm told a run finished in a project I'm not looking at. The bell is one-shot, so the
> poller persists it rather than trusting me to be watching. With auto-pin on, a finished project promotes
> itself to the top of the rail.

---

## 2:12 – 2:38 · Workspace isolation, and deliberate cross-project reach

**ON SCREEN:** Manage modal → General: the workspace path and the GitHub remote. Then ask the agent in a terminal to read another project's implementation of something and summarise the pattern.

> Each project is a workspace directory cloned from its own GitHub repository, with its own proxy routes and
> service units, so nothing here exists only inside the tool. The agent's working directory is that workspace,
> so scoping is the default. But the workspaces are siblings on one filesystem, so on request I can point the
> agent at another project and have it lift a pattern across.

---

## 2:38 – 2:56 · Multi-user model

**ON SCREEN:** Settings → Users & Roles: add a user, set a role, assign projects. Then a second client attached to the same session, both showing identical output.

> Authorisation is per project and role-based, and roles differentiate on capability, not visibility: a content
> editor can drop files into a project without getting a shell in it. And because the session is server-side,
> two people can attach to the same window and see the same stream.

---

## 2:56 – 3:10 · Inbox and outbox

**ON SCREEN:** Drag a screenshot onto the window, show it land in Inbox with the path injected into the terminal. Switch to Outbox and download a file.

> Each project has an inbox and an outbox: an upload lands in the inbox with its absolute path injected into the
> active terminal, and anything the agent writes to the outbox is downloadable from the same drawer.

---

## 3:10 – 3:19 · Preview

**ON SCREEN:** Open Preview, let it render, reload after a change if you can.

> Preview runs the project's own development server under its own service unit, proxied with WebSocket upgrade,
> so it survives closing the window.

---

## 3:19 – 3:45 · Deployment slots and audit history

**ON SCREEN:** Deployment Centre: the dev and prod cards with versions and the “source newer” badge, then the History tab — time, target, result, version, user, duration.

**Hold on the history table. This is the part that decides whether it gets near production.**

> Deployment is modelled as two slots per project, dev and prod. Each slot is a script plus a version-check
> command, so the target can be a Windows server, a container or a file share. It probes the deployed version,
> compares it against the working copy and flags the drift, and every run appends to a log: who ran it, which
> target, which version, and whether it succeeded.

---

## 3:45 – 4:03 · Close

**ON SCREEN:** Sweep the Settings sidebar, then back to the dashboard with the full rail visible. Hold the frame.

> Architecturally, then: one Node service, nginx in front, per-project service units, agent CLIs on an always-on
> server, and Active Directory as the single identity source. It's sized for an individual developer or a small
> team, it runs on our own infrastructure, and it was built in-house.

---

## Objections this script answers on camera

Prerecorded, so nothing can be asked live. Each of these is already carried by a sentence in the narration —
if you cut the sentence, you lose the answer.

| Objection | Where it's answered |
|---|---|
| "Is it just encrypted, or actually verified?" | Authentication — the DC certificate is validated against the trust store |
| "Can someone reach a shell without logging in?" | Authentication — terminals bind to loopback, reachable only through the authenticated proxy |
| "Is directory membership alone enough to get in?" | Authentication — the bind is necessary but not sufficient; the local record carries the grants |
| "What if the server dies?" | Workspace isolation — each workspace is a clone with its own remote |
| "Is completion detection guesswork?" | Completion signalling — stop-hook marker plus the per-window bell flag, latched by the poller |
| "Can this go near production?" | Deployment — per-run log of user, target, version and result |


---

## Recording notes

**Set up before you record**
- `PW_LOGIN_ORG` must be set on the container, or the sign-in page still reads *"your directory account"* while
  you are saying "GOA Active Directory" over the top of it. Script for that is in the outbox.
- Five to eight projects in the rail. Fan-out is the premise of the whole argument; a thin rail contradicts it.
- One window already **finished** (amber) and one still **running** (green), so both signal states are visible.
- At least one project with real deployment history. An empty History tab undercuts the audit claim.
- Preview server already warm, so it isn't cold-booting on camera.
- Second client already attached to the shared session.
- Sign in with your own AD account. Do not demo the local-password fallback while describing directory auth.

**Pacing**
- Weight the three sections this audience is actually assessing: authentication, completion signalling, and
  deployment history. Move briskly through the rest.
- Don't narrate the clicking. Name the mechanism and let the screen show the behaviour.

**If you're running long, cut in this order**
1. Preview — reduce to one clause.
2. The live cross-project prompt — keep the sentence, don't run it on camera.
3. The tmux sidecar detail — keep "the sessions survive an app redeploy," drop the reason.

**Claims to keep precise**
- "Stores no passwords" is true in directory mode, which is what this instance runs. A local-password mode
  exists; don't say "cannot".
- Say the bind is "necessary but not sufficient". The local record is an allowlist, not a mirror of the directory.
- Sessions survive a *dashboard* restart because the tmux server is in a sidecar. They do not survive a host
  reboot; don't imply they do.
