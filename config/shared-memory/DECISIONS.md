# PW Decisions

Permanent cross-project decisions and standing instructions for ProjectWorkbench on PVI2.

## 2026-07-15 — STANDING: Force animations regardless of OS "reduce motion" (all web projects)

Every PW **web** project displays its animations regardless of the OS "reduce motion" preference —
that toggle is spuriously ON for RDP sessions, most VMs, and Windows "Adjust for best performance",
so visitors who never opted out otherwise see a static-looking site. Include the canonical drop-in
(one inline `<script>`, first in `<head>`) from the ProjectWorkbench repo `standards/force-motion/`:
it patches `matchMedia` for JS motion libs and strips `@media (prefers-reduced-motion: reduce)`
blocks from same-origin CSS. Never self-gate animations; never "restore" motion with a CSS `revert`
(it reverts to 0s). Apply it in every new project's first-pass build by default.

## 2026-08-19 - STANDING: ASP.NET Core shared-hosting defaults (all new ASP.NET Core sites)

James declared this universal for new ASP.NET Core sites hosted on memory-constrained shared
IIS/SmarterASP environments. New web projects must explicitly set workstation GC and Out-of-Process
hosting from the first scaffold, in the project file (or `Directory.Build.props` for a multi-project
solution):

```xml
<PropertyGroup>
  <ServerGarbageCollection>false</ServerGarbageCollection>
  <AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>
</PropertyGroup>
```

Why: the Web SDK defaults to server GC, which reserves a heap per core and is the usual reason a
shared app pool gets recycled for memory. In-process hosting runs the app inside the IIS worker
process, so one site can take the pool down with it; Out-of-Process runs Kestrel behind the ASP.NET
Core Module and keeps the memory and failure boundary at the site.

Never hand-edit the generated `*.runtimeconfig.json` or the published `web.config`. Both are build
outputs and are overwritten on the next publish; set the MSBuild properties instead.

Verification is required for both properties before a site is called done. Check the resolved
MSBuild values and the published artifacts, because they can disagree:

```bash
dotnet msbuild <Project>.csproj -getProperty:ServerGarbageCollection -getProperty:AspNetCoreHostingModel
dotnet publish -c Release -o out
grep -i '"System.GC.Server"' out/<App>.runtimeconfig.json   # expect false
grep -i 'hostingModel'       out/web.config                 # expect OutOfProcess (case can vary by SDK)
```

The published values must literally read `"System.GC.Server": false` and a `hostingModel` of
OutOfProcess. A `true` value, or the key missing altogether, both mean server GC is still in effect.
The `web.config` attribute is written from the MSBuild property verbatim, so its case follows what
you set; the unset in-process default publishes as `hostingModel="inprocess"`.

Verified against the .NET SDK 10.0.111 `dotnet new web` template on 2026-08-19: unset, it resolves
to `ServerGarbageCollection=true` / `AspNetCoreHostingModel=inprocess` and publishes
`"System.GC.Server": true` with `hostingModel="inprocess"`, which is exactly the configuration this
decision exists to prevent.

A different setting requires measured evidence from a dedicated or high-throughput workload plus the
reason documented here.

## 2026-10-05 — STANDING: turn outcomes (Jev) are opt-in per instance; GOA stays on the old method

James: "it's imperative that the GOA side not run JEV, and continue to utilize the old method, as
the GOA does not approve of JEV internally." Turn outcomes (`app/turn-outcome.js`: each finished
Claude turn's final message classified by TypeSafe AI's Jev through Vercel AI Gateway) are
therefore STRICTLY OPT-IN:
- On only when the dashboard's environment sets `PW_TURN_OUTCOME=on` (also `true`/`1`/`yes`)
  AND the root-only key file `/etc/project-workbench/ai-gateway.key` exists. Unset, a typo, or
  `off` is off: no helper job runs, nothing is sent to the gateway, and the tab strip and rail
  show the plain amber "finished" signal exactly as before.
- install.sh never sets it and never creates the key, so an upgrade — GOA's included — keeps the
  old method with no action needed. Do not add it to any GOA profile, drop-in or installer default.
- PVI2 opts in with the drop-in `/etc/systemd/system/project-workbench.service.d/turn-outcome.conf`
  (`PW_TURN_OUTCOME=on`, `PW_TURN_OUTCOME_HERMES=on`).
- GOA enforces it at deploy time: `deploy/promote-app.sh` (GOA-only) aborts before changing
  anything if either variable is opted in in the dashboard container's env.

## 2026-09-30 — STANDING: a project may read its OWN production database to investigate (amends 2026-09-01)

James: "Projects should be allowed to access their production databases for investigative purposes."
Every project may connect to the production (or staging) database its own application uses, to
investigate a problem — read-only queries, schema inspection, data checks — as standing permission
with no per-query approval. Limits:
- Its own database only (named by the app's configuration or its credential-store entry); never
  another project's database, and never the database server's host.
- Read-only. Changing data or schema (inserts/updates/deletes, DDL, migrations, data fixes, writing
  procedures) still needs James to ask for that specific change. Prefer a read-only login; otherwise
  run queries in a transaction that is rolled back.
- Sanctioned credentials only (the project's config or the PVI credential store).
- Query results with customer or personal data never go into the repo, commits, or off the box.
- A refused connection (auth failure, firewall, missing grant) is still a block: stop and summarize,
  per 2026-09-01. Everything else in 2026-09-01 is unchanged.

Why: the 2026-09-01 boundary listed production databases as out of scope, so a ProVisionIPortal
session was blocked from a read-only investigation James wanted. Delivered as `pw-workspace-boundary v3`
in `~/.claude/CLAUDE.md`, `~/.copilot/copilot-instructions.md`, `~/.codex/AGENTS.md` (install.sh
replaces an older block in place), and in the repo-root `AGENTS.md`. Running sessions read the new
text only after a restart.

## 2026-09-01 — STANDING: Stay inside your workspace; never investigate external systems (all projects)

PW agents work on the code in their project's workspace (the git repo at their cwd and below) and
nothing else. Systems outside the workspace — production/staging servers, their databases,
identity/directory servers, file shares, other network hosts — are out of scope for every project.
When a task needs an external system and hits a block (permission denied, auth failure, missing
grant, firewall/connectivity, a failed prod migration/deploy), the agent STOPS and writes a plain
summary of the block (what it was doing, the exact command + target, the error, and what
access/decision a human needs), then hands it to the user for a human to investigate. Summarizing a
blocker is the successful outcome, not a failure to work around.

NEVER install, download, or run offensive-security, penetration-testing, reconnaissance,
credential-harvesting, or identity/directory attack tooling of any kind to get past an access
problem, and never reconfigure a remote host. If a task appears to require that class of tool, that
is itself the signal to stop and hand it to a human.

Exception — THIS host only, ProjectWorkbench only: the one project allowed to troubleshoot this
workbench host (vnl2422) more deeply is the ProjectWorkbench project itself
(`/opt/project-workbench/workspaces/ProjectWorkbench`), because maintaining the workbench is its job.
Every other project stays in its workspace. The exception covers only the local host; external
prod/staging servers and the identity/directory domain stay off-limits to every project,
ProjectWorkbench included.

Why: declared after a project's agent, blocked on prod-DB deploy permissions, escalated into
installing offensive/attack tooling on the workbench (2026-09-01, endpoint-security alerts on
vnl2422). Delivered live to every CLI via `~/.claude/CLAUDE.md`, `~/.copilot/copilot-instructions.md`,
`~/.codex/AGENTS.md`, and baked by install.sh (grep marker `pw-workspace-boundary`); also in the
repo-root `AGENTS.md`. IMPORTANT: describe the tool CATEGORY, never specific product names — naming
products plants endpoint-security detection strings across the box and the repo (learned 2026-09-01).
