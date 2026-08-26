# Project Workbench — demo video script

**Audience:** technical managers and directors. They know what a directory bind and a reverse proxy are, they are judging operational risk while you talk, and they cannot ask you anything — this is prerecorded.
**Length:** 616 spoken words — about 4:01 read aloud. Cut list at the bottom if you need the room.
**Register:** describe what's on screen and what it does. Technical detail goes in where it carries weight — authentication, how completion is detected, the deployment record — and stays out of the rest. One idea per sentence; no stacked clauses.

---

## 0:00 – 0:14 · Open

**ON SCREEN:** Start on the sign-in page.

> Project Workbench is a browser front end for AI-assisted development. The problem it solves is one of
> organization: one developer running several agent sessions across several repositories, where the constraint
> isn't the model, it's tracking what's running where.

---

## 0:14 – 0:56 · Authentication and access model

**ON SCREEN:** Stay on the sign-in page. Point at the “Sign in with your GOA account” line and the firstname.lastname field, then sign in with your own AD credentials.

**The one section that stays fully technical. Nobody can ask afterwards, so it goes in whole.**

> The application stores no passwords. It authenticates by simple bind against GOA Active Directory over LDAPS,
> with the domain controller's certificate validated against the trust store, and the bind password passed as a
> private file rather than on a command line. A successful bind is necessary but the account also has to exist
> in the local access record, which carries the role and project grants. Sessions are server-side and revocable,
> administrative actions are audit-logged, and the site is HTTPS-only on the internal network. The terminal
> processes themselves bind to loopback and are only reachable through the authenticated proxy, so there is no
> unauthenticated route to a shell.

---

## 0:56 – 1:14 · The project rail

**ON SCREEN:** Hover the rail so it expands, then click between two or three projects. Let the terminal swap under each click — the speed is the point.

> Every project I have is a key down the left-hand rail. I hover to expand it, click a project, and that
> project's terminal loads in place. No new window, no reopening folders. Switching is one click, which is what
> makes running six at once practical.

---

## 1:14 – 1:41 · Sessions, named and persistent

**ON SCREEN:** Open the + menu, add a session, click a tab name and rename it. End on a strip of three or four named tabs: refactor, tests, build watcher.

> Inside a project I can open as many tmux sessions as I want, and name them: refactor, tests, build watcher.
> The plus button adds one; the tab strip keeps them in reach. They run on the server rather than in my browser,
> so I can close the tab, go home, and come back to everything still running. At a dozen sessions, the names are
> what keep it legible.

---

## 1:41 – 2:13 · Completion notices and auto-pin

**ON SCREEN:** A session that has just finished, tab pulsing amber. Then switch to a different project so the finished one is still lit in the rail. Point out the “Auto-pin on done” toggle and the pinned project at the top.

**Slow down here. This is the part that lands.**

> This is the part I use most. Tasks take minutes and I'm not going to sit and watch. When a session finishes
> the tab lights up amber, and so does the project key in the rail, so I'm told even when I'm working elsewhere.
> That signal comes from the CLI reporting the end of its own turn, not from watching the screen. And with
> auto-pin on, a finished project promotes itself to the top of the rail, so the work queues itself.

---

## 2:13 – 2:33 · Workspaces and scope

**ON SCREEN:** Manage modal → General: the workspace path and the GitHub repo. Then in a terminal, ask the assistant to read another project's implementation of something and summarise it.

> Every project has its own workspace folder on the server, backed by its own GitHub repository, so nothing here
> exists only inside the tool. The assistant works inside that folder and sees that project only. But I can also
> point it at another project and have it bring a pattern across.

---

## 2:33 – 2:55 · Assigning projects to people

**ON SCREEN:** Settings → Users & Roles: add a user, set a role, assign projects. Then a second browser or your phone on the same session, both showing the same output.

> Projects are assigned per person. In Users and Roles I add someone, set a role, and pick their projects. Roles
> differ by capability, not visibility: a content editor can hand files in without getting a terminal. And
> because the sessions live on the server, two of us can open the same one and watch the same output.

---

## 2:55 – 3:13 · Files drawer

**ON SCREEN:** Drag a screenshot onto the window, show it land in Inbox with the path dropped into the terminal. Switch to Outbox and download a file.

> Every project has a files drawer: an inbox and an outbox. I drag a screenshot or a spec in and it lands in the
> inbox, with the path handed straight to the assistant. Anything it produces for me comes back in the outbox to
> download.

---

## 3:13 – 3:24 · Preview

**ON SCREEN:** Open Preview, let the app render, reload it after a change if you can.

> Preview opens the project's running app in a window here, so I can see a change work without any local setup.
> It keeps running when I close the window.

---

## 3:24 – 3:48 · Deployment slots and history

**ON SCREEN:** Deployment Centre: the dev and prod cards with their versions and the “⬆ source newer” badge, then the History tab — time, target, result, version, user, duration.

**Hold on the history table for a couple of seconds. This is the part directors read.**

> Deployment has its own page: a dev card and a prod card for every project. Each shows the version actually
> running out there, flags it when my working copy is newer, and deploys with one button. The History tab
> records every run — who deployed, which target, which version, and whether it succeeded. That is the audit
> trail, per project.

---

## 3:48 – 4:01 · Close

**ON SCREEN:** Sweep the Settings sidebar (Users & Roles, CLIs & Sign-in, Environment, System & Updates), then back to the dashboard with the full rail visible. Hold that frame.

> It's all managed centrally: projects, deployment targets, users and settings in one place. It's built for an
> individual developer or a small team, it runs on our own infrastructure, and it was built in-house.

---

## What each section has to land

Prerecorded, so nothing can be asked live. If you cut one of these sentences, you lose the answer with it.

| The question in their head | The sentence that answers it |
|---|---|
| "Is this secured properly?" | Authentication — bind against AD over LDAPS, certificate validated, no unauthenticated route to a shell |
| "Is being in AD enough to get in?" | Authentication — the bind is necessary, but the account also has to be in the local access record |
| "What if that server dies?" | Workspaces — each one is backed by its own GitHub repository, so nothing exists only inside the tool |
| "Is the completion signal reliable?" | Completion — it comes from the CLI reporting the end of its turn, not from watching the screen |
| "Could this go near production?" | Deployment — every run records who, which target, which version, and the result |
| "Who is this for?" | Close — an individual developer or a small team |

---

## Recording notes

**Set up before you record**
- `PW_LOGIN_ORG` has to be set on the container, or the page still says *"your directory account"* while you're
  saying "GOA Active Directory" over the top of it. `set-login-org.sh` in the outbox does it.
- Five to eight projects in the rail with recognisable names. A thin rail contradicts the premise.
- One session already **finished** (amber) and one still **running** (green), so both states are on screen.
- At least one project with real deployment history. An empty History tab undercuts the audit claim.
- Preview server already warm so it isn't cold-booting on camera.
- Second viewer attached to the shared session, ready to switch to.
- Sign in with your own AD account. Don't demo the local-password fallback while describing directory auth.

**Pacing**
- Slow down on authentication, completion notices, and deployment history. Move faster through the rest.
- Don't narrate the clicking. Say what the feature is for and let the screen show the mechanic.

**If you're running long, cut in this order**
1. Preview — reduce to "and it previews the running app live."
2. The cross-project lookup — keep the sentence, don't run the prompt on camera.
3. The session-naming examples — keep "as many as I want, and they stay running."

**Claims to keep precise**
- "Stores no passwords" is true in directory mode, which is what this instance runs. A local-password mode
  exists in the code; don't say "cannot".
- The bind is necessary but not sufficient. The local record is an allowlist, not a mirror of the directory.
- Sessions survive closing the browser and restarting the app. They don't survive a host reboot — don't imply
  they do.
