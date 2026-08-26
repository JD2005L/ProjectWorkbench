# Project Workbench — demo video script

**Audience:** technical managers and directors. They know what a directory bind and a reverse proxy are, they are judging operational risk while you talk, and they cannot ask you anything — this is prerecorded.
**Length:** 453 spoken words — about 2:57 read aloud.
**Register:** describe what's on screen and what it does. Technical detail goes in where it carries weight — authentication above all — and stays out of the rest.

---

## 0:00 – 0:13 · Open

**ON SCREEN:** Start on the sign-in page.

> Project Workbench is a browser front end for AI-assisted development. The problem it solves is one of
> organization: developers running several agent sessions across several repositories, where the constraint is
> tracking what's running and where.

---

## 0:13 – 0:39 · Authentication and access model

**ON SCREEN:** Stay on the sign-in page. Point at the “Sign in with your GOA account” line and the firstname.lastname field, then sign in with your own AD credentials.

**The one section that stays fully technical. Nobody can ask afterwards, so it goes in whole.**

> As we're logging in, I'll mention, the application stores no passwords. It authenticates using a simple bind
> against GOA Active Directory over LDAPS, with the domain controller's certificate validated against the trust
> store, and the bind password passed as a private file. A successful bind then checks whether the account also
> exists in the local access record, which grants the role and projects for that user.

---

## 0:39 – 0:55 · The project rail

**ON SCREEN:** Hover the rail so it expands, then click between two or three projects. Let the terminal swap under each click — the speed is the point.

> Once logged in, we see every project as having its own key down the left-hand rail. Clicking a project loads
> that project's terminals in the right pane. Switching is one click, which is what makes running multiple
> projects at once practical.

---

## 0:55 – 1:18 · Sessions, named and persistent

**ON SCREEN:** Open the + menu, add a session, click a tab name and rename it. End on a strip of three or four named tabs: refactor, tests, build watcher.

> Inside each project, individual terminal sessions can be created, and they can be named as desired. I normally
> like to name them by the topic I'm working on within each. Every session runs on the server rather than in my
> browser specifically, so my context is permanently stored and accessible until I choose to close the session.

---

## 1:18 – 1:46 · Completion notices and auto-pin

**ON SCREEN:** A session that has just finished, tab pulsing amber. Then switch to a different project so the finished one is still lit in the rail. Point out the “Auto-pin on done” toggle and the pinned project at the top.

**Slow down here. This is the part that lands.**

> While sessions are working on their directives, they visually show a working indicator on both the session bar
> and the project rail. When a session finishes, both the session tab and the project key light up amber to
> indicate that the turn has completed and it's ready for my next direction. Auto-pinning also ensures projects
> actively being worked on have higher visual emphasis for the developer than other projects in the background.

---

## 1:46 – 2:04 · Files drawer

**ON SCREEN:** Drag a screenshot onto the window, show it land in Inbox with the path dropped into the terminal. Switch to Outbox and download a file.

> Every project has a files drawer: an inbox and an outbox. I can drag or paste a screenshot or file in and it
> lands in the inbox, with the path handed straight to the assistant. Anything it produces for me comes back in
> the outbox to download.

---

## 2:04 – 2:13 · Preview

**ON SCREEN:** Open Preview, let the app render, reload it after a change if you can.

> The preview pane opens the project's running app in a window here, so I can see a change without requiring a
> deployment.

---

## 2:13 – 2:36 · Deployment slots and history

**ON SCREEN:** Deployment Centre: the dev and prod cards with their versions and the “⬆ source newer” badge, then the History tab — time, target, result, version, user, duration.

**Hold on the history table for a couple of seconds. This is the part directors read.**

> The deployment pane provides auditable script slots for both dev and prod deployments for every project. Each
> shows the version actually running on the remote server, flags indicate when my working copy is newer than
> remote, and deployments run with one button click. The History tab records every run, who deployed, which
> target, which version, and whether it succeeded.

---

## 2:36 – 2:57 · Close

**ON SCREEN:** Back to the dashboard with the full rail visible — ideally with two or three projects lit, so the last frame shows the organization you just described. Hold it.

> So in a nutshell, Project Workbench provides a developer with an organized AI CLI development space, and
> provides small development teams with a centralized space to collaborate on projects and access a project's
> session contexts across workstations. Being it is completely built in-house, it is highly adaptable to a
> team's workflow preferences and requirements.

---

## Recording notes

**Set up before you record**
- `PW_LOGIN_ORG` has to be set on the container, or the page still says *"your directory account"* while you're
  saying "GOA Active Directory" over the top of it. `set-login-org.sh` in the outbox does it.
- Five to eight projects in the rail with recognisable names. Organization is the premise; a thin rail contradicts it.
- One session already **finished** (amber) and one still **running** (working indicator), so both states are on
  screen when you describe them.
- At least one project with real deployment history. An empty History tab undercuts the audit claim.
- Preview server already warm so it isn't cold-booting on camera.
- Sign in with your own AD account. Don't demo the local-password fallback while describing directory auth.

**Pacing**
- Slow down on authentication, completion notices, and deployment history. Move faster through the rest.
- Don't narrate the clicking. Say what the feature is for and let the screen show the mechanic.

**Two claims in the close that nothing on screen now proves**
The user-management section and the workspace/repository section are gone, so the close is asserting things the
video never shows. Either is a one-sentence fix if you want the cover:
- *"collaborate on projects"* — no roles, grants, or shared session appear anywhere now. Cheapest fix: while the
  rail is open, add "projects are assigned per person, and because sessions live on the server two of us can open
  the same one and watch the same output."
- *"access session contexts across workstations"* — the sessions section says context persists, which implies
  this, but nothing shows a second machine. Adding "from any workstation, and it's the same session" to that
  sentence covers it without a new shot.

**Claims to keep precise**
- "Stores no passwords" is true in directory mode, which is what this instance runs. A local-password mode
  exists in the code; don't say "cannot".
- The bind alone isn't sufficient — the local record is an allowlist, which is what your wording says. Keep that
  order (bind first, then the record), because the reverse implies AD membership grants access.
- Sessions survive closing the browser and restarting the app. They don't survive a host reboot — "permanently
  stored" is about the workspace and its git history, not the tmux session, so don't extend it if asked.
