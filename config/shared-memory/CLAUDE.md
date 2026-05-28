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
