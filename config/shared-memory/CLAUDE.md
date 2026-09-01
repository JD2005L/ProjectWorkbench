# PW Shared Memory

This is the local permanent memory for ProjectWorkbench on PVI2. It replaces account-level MCP memory for this instance.

Rules:
- Do not rely on external/account MCP memory from this PW instance.
- Read this shared memory when starting work in any PW workspace.
- Record reusable tools, APIs, access paths, and operational notes in `TOOLS.md`.
- Record credentials/secrets only in `CREDENTIALS.md`; never commit them to project repositories.
- Record cross-project decisions or standing instructions in `DECISIONS.md`.
- Keep project-specific implementation details in the project repo unless they are useful across multiple PW workspaces.

For external AI agents (automation, collaborator agents that need to inject
prompts into the user's interactive Claude session): see `AGENTS.md` at the
PW repo root, or fetch it unauthenticated from any live instance at
`http://<workbench-host>/agents.md`.

## ASP.NET Core shared-hosting defaults

For every new ASP.NET Core site targeting memory-constrained shared IIS/SmarterASP hosting, apply this during the initial scaffold:

```xml
<ServerGarbageCollection>false</ServerGarbageCollection>
<AspNetCoreHostingModel>OutOfProcess</AspNetCoreHostingModel>
```

Do not edit generated runtimeconfig files by hand. Verify the resolved MSBuild properties and published runtime configuration. Deviate only for a measured dedicated/high-throughput workload, with the reason documented.

## Workspace boundary (all projects)

Work only inside your project's workspace. External systems (prod/staging servers, their databases,
Active Directory / domain controllers, other hosts) are out of scope: when blocked, summarize the
block for a human instead of working around it, and never install/run security or AD tooling to get
past an access problem. Only the ProjectWorkbench project may troubleshoot this host
(vnl2422.rm.gov.ab.ca) more deeply. Full policy: `DECISIONS.md` (2026-09-01 STANDING).
