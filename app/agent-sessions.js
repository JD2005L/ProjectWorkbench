// Driving a project session from outside: list, prompt, read.
//
// docs/agent-mcp.md. This is the engine, and the ONLY place these decisions live —
// the REST routes and (next) the MCP façade are thin skins over it, for the reason
// app/orchestrator/mcp.js already states about its own adapter: a second copy of
// an authorization decision is a second thing to get wrong.
//
// Everything it touches is injected, so all of it is testable without a server, a
// tmux socket, or a token store.
//
// THREE RULES CARRY THE SAFETY, each because of something that has already gone
// wrong somewhere in this product:
//
//   1. ADDRESS A WINDOW BY INDEX, NEVER BY NAME. tmux permits duplicate window
//      names and then REFUSES an ambiguous `-t session:name` rather than choosing
//      — which is how the eod-commit task silently stopped being delivered once a
//      second window shared its name (see newTmuxWindow's note in server.js). A
//      name is what the caller asks for; an index is what we send to.
//   2. AN AGENT TYPES INTO ITS OWN LANE. A window belongs to a token only if it
//      carries the marker this code set, never because the name matches — the rule
//      app/orchestrator/session.js is built on. A pane running a shell turns an
//      injected "prompt" into a command run as the pane account, so an unmarked
//      window (a human's tab) is refused unless the token carries
//      sessions:prompt:any.
//   3. A PROMPT IS PASTED, NOT TYPED. send-keys types argv: a 200 KB prompt is both
//      an ARG_MAX question and a stream of keystrokes into a TUI. The paste path is
//      what a human paste is, and a CLI that collapses pastes sees one paste rather
//      than 40,000 keypresses.

export const MARKER_TOKEN = '@pw_agent_token';
export const MARKER_USER = '@pw_agent_user';
export const MARKER_CREATED = '@pw_agent_created';

/** Large and specific by design; beyond this, send a file (see the doc). */
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_READ_LINES = 2000;
export const DEFAULT_READ_LINES = 200;
export const SUPPORTED_CLIS = Object.freeze(['claude', 'copilot']);

export class AgentSessionError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'AgentSessionError';
    this.status = status;
    this.code = code;
  }
}

const refuse = (message, status, code) => { throw new AgentSessionError(message, status, code); };

/** A window name a caller may ask for. Narrow on purpose: it is a label, not a path. */
export function validSessionName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function createAgentSessions({
  authorize,             // (projectName, token) -> { ok, reason?, status?, project?, user? }
  listProjects,          // () -> [{ name }]
  listWindows,           // (projectName) -> [{ index, name, bell, working, hibernated, credUser }]
  windowOption,          // (target, option) -> string
  setWindowOption,       // (target, option, value) -> void
  createWindow,          // (project, name, cli, launcher) -> index
  pasteToWindow,         // (target, text) -> void
  capturePane,           // (target, { lines, scrollback }) -> string
  targetFor,             // (projectName, index) -> tmux target string
  audit = async () => {},
  now = () => new Date(),
} = {}) {
  async function reach(token, projectName) {
    const verdict = await authorize(projectName, token);
    // 404 rather than 403 for an unreachable project: a machine credential must not
    // be able to enumerate the instance by reading error codes.
    if (!verdict?.ok) refuse(verdict?.reason || `No such project: ${projectName}`, verdict?.status || 404, 'project_unreachable');
    return verdict;
  }

  async function resolveWindow(projectName, session) {
    if (!validSessionName(session)) refuse(`Invalid session name: ${session}`, 400, 'invalid_session_name');
    const windows = await listWindows(projectName);
    const matches = windows.filter((w) => w.name === session);
    // tmux would refuse this target anyway; saying so beats a command that vanishes.
    if (matches.length > 1) {
      refuse(`"${session}" names ${matches.length} windows in ${projectName}; rename one before addressing it`,
        409, 'ambiguous_session');
    }
    return { windows, window: matches[0] || null };
  }

  async function ownership(tmuxTarget) {
    const tokenId = await windowOption(tmuxTarget, MARKER_TOKEN);
    const user = await windowOption(tmuxTarget, MARKER_USER);
    return { tokenId: tokenId || '', user: user || '', owned: !!tokenId };
  }

  return {
    async projects(token) {
      const reachable = [];
      for (const project of await listProjects()) {
        const verdict = await authorize(project.name, token);
        if (verdict?.ok) reachable.push({ name: project.name });
      }
      return { projects: reachable };
    },

    async sessions(token, projectName) {
      await reach(token, projectName);
      const windows = await listWindows(projectName);
      const sessions = [];
      for (const w of windows) {
        const mark = await ownership(targetFor(projectName, w.index));
        sessions.push({
          session: w.name,
          index: w.index,
          working: !!w.working,
          // The bell is how this instance already knows a turn ended; see the doc.
          finished_turn: !!w.bell,
          hibernated: !!w.hibernated,
          runs_as: w.credUser || null,
          owned_by_this_token: !!mark.tokenId && mark.tokenId === token.id,
          agent_owned: mark.owned,
        });
      }
      return { project: projectName, sessions };
    },

    /**
     * `cli` is consulted only when CREATING. An existing session continues with
     * whatever it is already running, because a token cannot know what a live pane
     * is doing and must not change it. A create with no `cli` is refused rather
     * than defaulted: "start Claude" and "start Copilot" spend different
     * credentials, and choosing for the caller would spend somebody's seat on a
     * guess.
     */
    async prompt(token, { project: projectName, session, prompt, create_if_missing = true, cli = '' }) {
      const verdict = await reach(token, projectName);
      const text = typeof prompt === 'string' ? prompt : '';
      if (!text.trim()) refuse('A prompt is required', 400, 'empty_prompt');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_PROMPT_BYTES) {
        refuse(`Prompt is ${bytes} bytes; the limit is ${MAX_PROMPT_BYTES}. Put the content in the project's _inbox/ and name the path instead.`,
          413, 'prompt_too_large');
      }

      let { window } = await resolveWindow(projectName, session);
      let created = false;
      if (!window) {
        if (!create_if_missing) refuse(`No session "${session}" in ${projectName}`, 404, 'no_such_session');
        if (!token.scopes?.includes('sessions:create')) refuse('Token lacks required scope "sessions:create"', 403, 'missing_scope');
        if (!SUPPORTED_CLIS.includes(cli)) {
          refuse(`Creating a session needs cli: ${SUPPORTED_CLIS.join(' | ')} — the two spend different credentials, so there is no default`,
            400, 'cli_required');
        }
        const index = await createWindow(verdict.project, session, cli, verdict.user.username);
        const fresh = targetFor(projectName, index);
        // Marked BEFORE the prompt goes in: a pane must never become addressable as
        // this token's lane only after it has already been typed into.
        await setWindowOption(fresh, MARKER_TOKEN, token.id);
        await setWindowOption(fresh, MARKER_USER, verdict.user.username);
        await setWindowOption(fresh, MARKER_CREATED, now().toISOString());
        window = { index, name: session };
        created = true;
      } else {
        const mark = await ownership(targetFor(projectName, window.index));
        if (!mark.owned && !token.scopes?.includes('sessions:prompt:any')) {
          refuse(`"${session}" was not created by this token. A pane running a shell would execute this text as a command, so typing into somebody else's window needs the separate scope sessions:prompt:any.`,
            403, 'not_my_lane');
        }
      }

      await pasteToWindow(targetFor(projectName, window.index), text);
      // Length, never the body: a prompt carries whatever the sending agent had in
      // context, and the audit log has more readers than the pane does.
      await audit('agent_prompt', {
        tokenId: token.id, label: token.label, actsAs: verdict.user.username,
        project: projectName, session, window: window.index, created, promptBytes: bytes,
      });
      return { project: projectName, session, window: window.index, created, injected_chars: text.length };
    },

    async read(token, { project: projectName, session, lines = DEFAULT_READ_LINES, include_scrollback = false }) {
      await reach(token, projectName);
      const { window } = await resolveWindow(projectName, session);
      if (!window) refuse(`No session "${session}" in ${projectName}`, 404, 'no_such_session');
      const wanted = Number.isFinite(Number(lines)) ? Math.trunc(Number(lines)) : DEFAULT_READ_LINES;
      const capped = Math.max(1, Math.min(MAX_READ_LINES, wanted));
      const text = await capturePane(targetFor(projectName, window.index), { lines: capped, scrollback: !!include_scrollback });
      await audit('agent_read', { tokenId: token.id, label: token.label, project: projectName, session, lines: capped });
      return { project: projectName, session, window: window.index, lines: capped, truncated: wanted > capped, text };
    },
  };
}
