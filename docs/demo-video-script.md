# Project Workbench — demo video script

**Audience:** IT management / directors, either evaluating this for other teams or as a look at what we can build in-house.
**Length:** 609 spoken words — about 3:58 read aloud. The cut list at the bottom takes it under 3:30 if you need the room.
**Voice:** first person and measured. You are briefing a manager on something you already use every day, not pitching it.

---

## 0:00 – 0:14 · Open

**ON SCREEN:** Start on the sign-in page, nothing touched yet.

> This is Project Workbench. I built it so I can run every project I own out of one browser tab, with an AI
> coding assistant already set up in each one. There's nothing to install locally.

---

## 0:14 – 0:42 · Access and authentication

**ON SCREEN:** Stay on the sign-in page. Point at the “Sign in with your directory account” line and the firstname.lastname field, then sign in with your own AD credentials and let the dashboard load.

> Before I sign in — Workbench holds no passwords of its own. It authenticates against GOA Active Directory over
> an encrypted LDAPS connection, so this is my ordinary network account, and if that account is disabled in AD,
> access here goes with it. A directory account alone isn't enough, though — it also has to be granted a role
> and projects here. And the site itself is HTTPS-only, on the internal network.

---

## 0:42 – 0:58 · Every project in one place

**ON SCREEN:** Expand the project bar, then move through two or three projects so the switching speed is obvious.

> Everything I'm working on is in one place. This bar down the side is every project I have. I select one and
> I'm in it, in the right folder, with the assistant already running against that code. That's the entire
> context switch.

---

## 0:58 – 1:34 · Sessions, named, on an always-on server

**ON SCREEN:** Open the + menu, add a session, click a tab name and rename it. End on a strip of three or four clearly named tabs (refactor, tests, build watcher).

> Inside a project I can run as many tmux sessions as I want. They stay alive on the server, so I can close the
> browser and come back in the morning to find everything still running. The assistant lives on an always-on
> server rather than my laptop, so the context stays with the session and I'm not re-explaining the project
> every morning. I name them for what they're doing: a refactor, a test run, a build watcher. With this much
> going on at once, the names are what keep it manageable.

---

## 1:34 – 2:12 · Completion notices and auto-pin

**ON SCREEN:** A session that has just finished, tab pulsing amber. Switch to a different project so they can see the finished one still lit in the bar. Point out the “Auto-pin on done” toggle and the pinned project at the top.

**Slow down here. This is the part that lands.**

> This is the part I rely on most. When I hand the AI a task it takes a few minutes, and I'm not going to sit
> and watch it. So when a session finishes, it tells me. The tab lights up, and the project itself lights up
> over here. I can be off in another project and still see that this one is waiting on me. And with auto-pin on,
> any project that finishes pins itself to the top of the list. I don't have to track what I started; the work
> comes back to me.

---

## 2:12 – 2:35 · Its own workspace, its own repo

**ON SCREEN:** Manage modal → General, showing the workspace path and the GitHub repo. Then, in a terminal, ask it something like “show me how <OtherProject> handles its auth middleware” and let the answer come back.

> Every project gets its own workspace on the server, backed by its own GitHub repository. So they're separate,
> and the assistant only sees the project it's working in. But they're all on the same server, so if I know I
> already solved something in another project, I can ask it to read that code and bring the pattern across.

---

## 2:35 – 2:58 · Collaborative by design

**ON SCREEN:** Settings → Users & Roles: add a user, set a role, assign projects. Then a second browser (or your phone) attached to the same session, both showing the same output.

> It's collaborative by design. In user management I add people, give them a role, and assign them their
> projects. They only see those. And because the sessions run on the server, two of us can open the same one and
> watch the same terminal live. That's useful for pairing, and for onboarding someone without a day of
> environment setup.

---

## 2:58 – 3:15 · Files drawer

**ON SCREEN:** Drag a screenshot onto the window, show it land in Inbox and the path drop into the terminal. Switch to Outbox and download something.

> Every project has a files drawer. I drop a file in, a screenshot or a spec, and it lands in that project's
> inbox and hands the path straight to the assistant. Anything it produces for me shows up in the outbox to
> download.

---

## 3:15 – 3:25 · Preview

**ON SCREEN:** Open Preview, let the app render in the window, and reload it after a change if you can.

> The preview window runs the project's own dev server and renders it right here, so I can see a change working
> without any local setup.

---

## 3:25 – 3:44 · Dev and prod slots, with history

**ON SCREEN:** Deployment Centre. Show the dev and prod cards with their versions and the “⬆ source newer” badge, then open the History tab — time, target, result, version, user, duration.

**Hold on the history table for a couple of seconds. Directors read that one.**

> Deployment is standardised across every project. There's a dev slot and a prod slot. It shows the version
> running in each, warns me when my working copy is newer than what's deployed, and deploys from here. And it
> keeps the record: who deployed, what version, when, and whether it worked.

---

## 3:44 – 3:58 · Close

**ON SCREEN:** Sweep the Settings sidebar (Users & Roles, CLIs & Sign-in, Environment, System & Updates), then back to the dashboard with the full project bar visible. Hold that frame.

> All of it is managed in one place. Projects, deploy targets, users, assistant settings. I built it for the way
> I actually work, one person or a small team, and it's running on our own infrastructure.

---

## Recording notes

**Set up before you record**
- Set `PW_LOGIN_ORG` on the server so the sign-in page reads something like *"Sign in with your GOA account"*. It
  currently falls back to the generic *"your directory account"*, which undersells the AD point you're making over
  top of it.
- Five to eight projects in the bar, with recognisable names. A thin bar undersells the whole premise.
- One session already **finished**, so the amber completion state is on screen when you reach it.
- One session still **running**, so the live green dot is visible somewhere for contrast.
- At least one project with real deployment history. An empty History tab kills that section.
- Start the preview server before recording so it isn't cold-booting on camera.
- Second viewer already attached to the shared session, so you can switch straight to it.
- Sign in with your own AD account on camera. Don't demo the local-admin fallback.

**Pacing**
- The three sections that matter to this audience are authentication, completion notices, and deployment history.
  Slow down there and move faster through the rest.
- Don't narrate the clicking. State what it's for and let the screen show the mechanic.

**If you're running long, cut in this order**
1. Preview — reduce it to a clause: "and it previews the running app live."
2. The cross-project lookup — keep the sentence, skip running the prompt on camera.
3. The session-naming examples — keep "as many as I want, and they stay running."

**If you're running short**
- After deployment: "The deploy step is a script I set per project, so the same button works whether the target is a
  Windows server, a container, or a static site."
- After the files drawer: "I can also give someone the drawer without giving them a terminal. Roles go down to
  file-drop only, so work can be handed in without shell access."
- After authentication: "Sessions are held server-side and can be revoked, and administrative actions are written to
  an audit log."
