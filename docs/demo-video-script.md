# Project Workbench — demo video script

**Audience:** IT management / directors, either evaluating this for other teams or as a look at what we can build in-house.
**Length:** ~580 spoken words, which is about 3:50 at a normal talking pace. Let the screen fill the gaps.
**Voice:** first person, plain, no pitch. You're walking a manager through something you already use every day.

---

## 0:00 – 0:20 · Open

**ON SCREEN:** Log in, land on the dashboard with the project bar showing several projects.

> So this is Project Workbench. I built it so I can run all of my projects out of one browser tab, with an
> AI coding assistant already set up in each one. Nothing to install on your machine. You log in and you
> get the projects you've been given.

---

## 0:20 – 0:40 · Everything in one place

**ON SCREEN:** Expand the project bar, then click through two or three projects so the swap speed is obvious.

> Everything I'm working on is in one place. This bar down the side is every project I have. I click one and
> I'm in it, in the right folder, with the assistant already running against that code. That's the whole
> switch.

---

## 0:40 – 1:16 · As many sessions as I want, named

**ON SCREEN:** Open the **+** menu, add a session, click a tab name and rename it. End on a strip of three
or four clearly named tabs (`refactor`, `tests`, `build watcher`).

> Inside a project I can run as many tmux sessions as I want. They stay alive on the server, so I can close
> the browser, come back in the morning, and it's all still running. I name them for whatever they're doing,
> so this one's a refactor, that one's running tests, that one's a build watcher. When you've got this much
> going on, the names are what keep it manageable. And because the assistant runs on an always-on server
> instead of my laptop, the context stays with the session. I'm not re-explaining the project to it every
> morning.

---

## 1:16 – 1:52 · Completion notices and auto-pin

**ON SCREEN:** A session that just finished, tab pulsing amber. Then switch to a *different* project so they
can see the finished one still lit up in the bar. Point out the "Auto-pin on done" toggle and the pinned
project sitting at the top.

**Slow down here — this is the part that lands.**

> This next part is the bit I use the most. When I hand the AI a task it takes a few minutes, and I'm not
> going to sit and watch it. So when a session finishes, it tells me. The tab lights up, and the project
> itself lights up over here. So I can be off in another project and still see this one's waiting on me.
> And if I turn auto-pin on, any project that finishes pins itself to the top of the list. I don't have to
> keep track of what I started. It comes back to me.

---

## 1:52 – 2:19 · Own workspace, own repo, and looking sideways

**ON SCREEN:** Manage modal → General, showing the workspace path and the GitHub repo. Then in a terminal,
ask it something like *"go look at how \<OtherProject\> does its auth middleware and show me the pattern"*
and let the answer come back.

> Every project gets its own workspace on the server, backed by its own GitHub repo. So they're separate,
> and the assistant only sees the project it's in. But they're all on the same box, so if I already solved
> something in another project, I can ask it to go read that code and bring the pattern over. I do that a
> lot.

---

## 2:19 – 2:45 · Built to be shared

**ON SCREEN:** Settings → Users & Roles: add a user, set a role, assign projects. Then a second browser (or
your phone) attached to the *same* session, both showing the same output.

> It's built to be shared. In user management I add people, give them a role, and assign them their
> projects. They only see those. And because the sessions run on the server, two of us can open the same
> session and watch the same terminal at the same time. That's good for pairing, or for bringing someone new
> on without a day of environment setup.

---

## 2:45 – 3:03 · Files drawer

**ON SCREEN:** Drag a screenshot onto the window, show it land in **Inbox** and the path drop into the
terminal. Switch to **Outbox** and download something.

> Every project has a files drawer. I drag a file in, a screenshot or a spec, and it lands in that project's
> inbox and hands the path straight to the assistant. Anything it makes for me shows up in the outbox and I
> pull it down from there.

---

## 3:03 – 3:15 · Preview

**ON SCREEN:** Click Preview, let the app render in the window, reload it after a change if you can.

> The preview window runs the project's own dev server and shows it right here, so I can see a change
> working without setting anything up locally.

---

## 3:15 – 3:37 · Dev and prod slots, with history

**ON SCREEN:** Deployment Centre. Show the **dev** and **prod** cards with their versions and the
"⬆ source newer" badge, then open the **History** tab — time, target, result, version, user, duration.

**Hold on the history table for a couple of seconds. Directors read that one.**

> Deploys work the same way for every project. There's a dev slot and a prod slot. It tells me what version
> is running in each one, it warns me when my working copy is newer than what's deployed, and I deploy from
> here. And it keeps the history: who deployed, what version, when, and whether it worked.

---

## 3:37 – 3:52 · Close

**ON SCREEN:** Sweep the Settings sidebar (Users & Roles, CLIs & Sign-in, Environment, System & Updates),
then back to the dashboard with the full project bar visible. Hold that frame.

> All of it is managed in one place. Projects, deploy targets, users, assistant settings. I built it for how
> I actually work, one person or a small team, and it's running on our own infrastructure.

---

## Recording notes

**Set up before you record**
- Get five to eight projects in the bar with recognisable names. A thin bar undersells the whole point.
- Have one session already **finished** so the amber state is there when you get to 1:16.
- Have one session still **running** so the green dot is visible somewhere for contrast.
- Make sure at least one project has real deployment history. An empty History tab kills that section.
- Start the preview server before you record so it isn't cold-booting on camera.
- Get the second viewer attached to the shared session ahead of time so you can just switch to it.

**Pacing**
- The two parts that matter to a director are the completion notices at 1:16 and the deployment history at
  3:15. Slow down there, move faster everywhere else.
- Don't say what you're clicking. Say why it matters and let the screen show the click.

**If you're running long, cut in this order**
1. Preview at 3:03 — drop it to "and it previews the running app live."
2. The cross-project lookup at 1:52 — keep the sentence, skip running the prompt live.
3. The naming detail at 0:40 — keep "as many as I want, and they stay running."

**If you're running short**
- After the deploy section: "The deploy step is just a script I set per project, so the same button works
  whether it's going to a Windows server, a container, or a static site."
- After the files drawer: "And I can give someone the drawer without giving them a terminal — roles go down
  to file-drop only, so someone can hand work in without getting shell access at all."
