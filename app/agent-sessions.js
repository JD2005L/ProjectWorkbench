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
//   2. A PROMPT GOES TO SOMETHING THAT TAKES PROMPTS. The first version of this
//      refused any window the token had not created, which read as "Bi-Tools is
//      Kevin's, my token acts as Kevin, why can I not type into it" — a fair
//      complaint, because ownership was never the hazard. The hazard is a pane
//      running a SHELL, where injected text is executed as a command, and a pane
//      spending SOMEBODY ELSE's Claude/Copilot seat. So the decision is made on
//      what the pane is running and whose credentials it carries; project access
//      (already required) covers the rest, and sessions:prompt:any remains the
//      override for the genuinely exceptional case.
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
/** Unambiguously a coding agent, so a prompt is the same act a human performs. */
const AGENT_COMMAND = /^(claude|copilot)(\.exe)?$/i;
/**
 * Claude Code frequently reports its pane command as `node` (server.js says so
 * where it kills and respawns a PVIKPBot window), and so does a dev server. An
 * ambiguous pane is only treated as an agent when PW itself created it as one —
 * a credential stamp or a Claude session marker — because guessing wrong here
 * means executing a prompt in a shell.
 */
const AMBIGUOUS_COMMAND = /^(node|node\.exe)$/i;

/**
 * May this token put a prompt into this window? Returns null when yes, or the
 * reason when no — and every reason names the specific thing in the way, because
 * "not authorised" sends people to the wrong fix.
 */
export function promptRefusal(window, { actsAs = '', owned = false, override = false } = {}) {
  if (override) return null;             // sessions:prompt:any is exactly this case
  if (owned) return null;                // its own lane needs no further argument
  if (window?.hibernated) {
    return { code: 'session_hibernated',
      message: 'That session is hibernated: it has to be resumed before it can take a prompt. Open it in the dashboard, or prompt a different session.' };
  }
  const command = String(window?.paneCommand || '').trim();
  const isAgent = AGENT_COMMAND.test(command)
    || (AMBIGUOUS_COMMAND.test(command) && (!!window?.credUser || !!window?.hibernationMarkers));
  if (!isAgent) {
    return { code: 'not_an_agent_pane',
      message: `That session is running ${command || 'something this surface does not recognise'}, not a coding agent — a prompt typed there would be executed as a command. Create your own session, or ask an operator for sessions:prompt:any.` };
  }
  if (window?.credUser && actsAs && window.credUser !== actsAs) {
    // Prompting here would spend somebody else's Claude/Copilot seat, and the
    // audit would name your account for their turn.
    return { code: 'other_users_credentials',
      message: `That session runs on ${window.credUser}'s account and this token acts as ${actsAs}. Prompting it would spend their CLI credentials; that needs sessions:prompt:any.` };
  }
  return null;
}
/** An _inbox file is a document, not a disk image. */
export const MAX_INBOX_BYTES = 8 * 1024 * 1024;

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
  paneMetrics,           // (target) -> { activity, bell, history, rows } | { missing:true }
  readTranscript,        // ({ project, projectPath, actsAs, sessionIdHint, messages }) -> { …, messages:[] }
  readWorkspaceFile,     // ({ project, relative, maxBytes }) -> { path, text, size, binary, truncated }
  readWorkspaceTree,     // ({ project, relative, maxEntries }) -> { path, entries, truncated }
  writeInboxFile,        // ({ project, filename, buffer }) -> { name, bytes, path }
  turns,                 // app/agent-turns.js store (optional; without it a prompt returns no turn)
  sampleMs = 1500,
  maxWaitMs = 600000,
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
        const refusal = promptRefusal(w, {
          actsAs: token.actsAs || '',
          owned: !!mark.tokenId && mark.tokenId === token.id,
          override: !!token.scopes?.includes('sessions:prompt:any'),
        });
        sessions.push({
          session: w.name,
          index: w.index,
          running: w.paneCommand || null,
          working: !!w.working,
          // The bell is how this instance already knows a turn ended; see the doc.
          finished_turn: !!w.bell,
          hibernated: !!w.hibernated,
          runs_as: w.credUser || null,
          owned_by_this_token: !!mark.tokenId && mark.tokenId === token.id,
          agent_owned: mark.owned,
          // Answered here so a caller does not have to infer it from the fields
          // above and get it wrong in both directions.
          promptable: !refusal,
          ...(refusal ? { not_promptable_because: refusal.message } : {}),
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
        const refusal = promptRefusal(window, {
          actsAs: verdict.user.username,
          owned: !!mark.tokenId && mark.tokenId === token.id,
          override: !!token.scopes?.includes('sessions:prompt:any'),
        });
        if (refusal) refuse(refusal.message, 403, refusal.code);
      }

      const tmuxTarget = targetFor(projectName, window.index);
      // Sampled BEFORE the paste: this is what makes a pre-existing bell, or
      // somebody else's earlier work, unable to complete the turn we are about to
      // open. See app/agent-turns.js.
      const before = paneMetrics ? await paneMetrics(tmuxTarget).catch(() => ({})) : {};
      await pasteToWindow(tmuxTarget, text);
      const turn = turns ? turns.start({
        project: projectName, session, window: window.index,
        tokenId: token.id, actsAs: verdict.user.username, sample: before,
      }) : null;
      // Length, never the body: a prompt carries whatever the sending agent had in
      // context, and the audit log has more readers than the pane does.
      await audit('agent_prompt', {
        tokenId: token.id, label: token.label, actsAs: verdict.user.username,
        project: projectName, session, window: window.index, created, promptBytes: bytes,
      });
      return { project: projectName, session, window: window.index, created,
        injected_chars: text.length, ...(turn ? { turn_id: turn.turn_id } : {}) };
    },

    /**
     * The state of one turn, sampled now. A turn nobody is watching has no
     * opinion until somebody looks — the same deal the cockpit's tab strip has —
     * so every status read folds a fresh observation in.
     */
    async turn(token, { project: projectName, session, turn_id }) {
      await reach(token, projectName);
      if (!turns) refuse('Turn tracking is not enabled on this instance', 501, 'turns_unavailable');
      const known = turns.get(turn_id);
      if (!known || known.project !== projectName) refuse(`No such turn: ${turn_id}`, 404, 'no_such_turn');
      const { window } = await resolveWindow(projectName, known.session);
      const sample = window
        ? await paneMetrics(targetFor(projectName, window.index)).catch(() => ({}))
        : { missing: true };
      return { turn: turns.observe(turn_id, sample) || known };
    },

    /**
     * Wait for it, bounded. A timeout answers `running`, never an error: "ask
     * again" is not a failure, and a deploy or a long refactor outlasts any single
     * HTTP request worth holding open.
     */
    async waitForTurn(token, { project: projectName, session, turn_id, timeout_ms }) {
      await reach(token, projectName);
      if (!turns) refuse('Turn tracking is not enabled on this instance', 501, 'turns_unavailable');
      const known = turns.get(turn_id);
      if (!known || known.project !== projectName) refuse(`No such turn: ${turn_id}`, 404, 'no_such_turn');
      const budget = Math.max(0, Math.min(maxWaitMs, Number(timeout_ms) || 60000));
      const started = Date.now();
      let state = known;
      while (state.state === 'running' && Date.now() - started < budget) {
        const { window } = await resolveWindow(projectName, known.session);
        const sample = window
          ? await paneMetrics(targetFor(projectName, window.index)).catch(() => ({}))
          : { missing: true };
        state = turns.observe(turn_id, sample) || state;
        if (state.state !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, sampleMs));
      }
      return { turn: state, waited_ms: Date.now() - started };
    },

    /**
     * The session's CONVERSATION rather than its screen.
     *
     * pw_read_session returns whatever the TUI painted — spinners, box drawing,
     * frames it has since redrawn over. A transcript is what was actually said,
     * which is both better signal and the single richest thing this product
     * holds, hence its own scope.
     */
    async transcript(token, { project: projectName, session, messages = 20 }) {
      const verdict = await reach(token, projectName);
      if (!readTranscript) refuse('Transcripts are not available on this instance', 501, 'transcript_unavailable');
      const { window } = await resolveWindow(projectName, session);
      if (!window) refuse(`No session "${session}" in ${projectName}`, 404, 'no_such_session');
      const wanted = Math.max(1, Math.min(200, Number(messages) || 20));
      // The window's own marker when there is one; otherwise the newest
      // transcript for this project, and the answer SAYS which — a caller acting
      // on somebody else's conversation because two lanes were open in one
      // project is exactly the confusion worth naming rather than hiding.
      const out = await readTranscript({
        project: projectName, projectPath: verdict.project.path,
        actsAs: verdict.user.username, sessionIdHint: window.claudeSid || '', messages: wanted,
      });
      if (!out) refuse(`No transcript for "${session}" — it may not be a Claude session, or it has not spoken yet`, 404, 'no_transcript');
      await audit('agent_transcript', { tokenId: token.id, label: token.label, actsAs: verdict.user.username,
        project: projectName, session, messages: out.messages?.length || 0, resolvedBy: out.resolved_by });
      return { project: projectName, session, ...out };
    },

    /** List a directory inside the project. */
    async tree(token, { project: projectName, path: relative = '', max_entries }) {
      await reach(token, projectName);
      if (!readWorkspaceTree) refuse('Workspace reads are not available on this instance', 501, 'workspace_unavailable');
      const out = await readWorkspaceTree({ project: projectName, relative, maxEntries: max_entries });
      await audit('agent_workspace_tree', { tokenId: token.id, label: token.label, project: projectName, path: out.path });
      return { project: projectName, ...out };
    },

    /** Read one file inside the project. */
    async file(token, { project: projectName, path: relative, max_bytes }) {
      await reach(token, projectName);
      if (!readWorkspaceFile) refuse('Workspace reads are not available on this instance', 501, 'workspace_unavailable');
      if (!relative) refuse('A path is required', 400, 'path_required');
      const out = await readWorkspaceFile({ project: projectName, relative, maxBytes: max_bytes });
      // Path and size, never the contents: the audit answers what was read, and
      // the file itself is not the audit log's business.
      await audit('agent_workspace_read', { tokenId: token.id, label: token.label, project: projectName,
        path: out.path, bytes: out.size, binary: !!out.binary });
      return { project: projectName, ...out };
    },

    /**
     * Put a file in the project's _inbox — the supported way to hand a session
     * something too big for a prompt. Deliberately the ONLY write: a change that
     * goes through the agent inherits the project's tests, conventions and
     * review, and _inbox is where a human hands over a document too.
     */
    async putInbox(token, { project: projectName, filename, content = '', base64 = false }) {
      await reach(token, projectName);
      if (!writeInboxFile) refuse('Inbox writes are not available on this instance', 501, 'inbox_unavailable');
      const name = String(filename || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
        refuse('A filename must be a plain name: letters, digits, dot, dash, underscore', 400, 'invalid_filename');
      }
      const buffer = base64 ? Buffer.from(String(content), 'base64') : Buffer.from(String(content), 'utf8');
      if (!buffer.length) refuse('Refusing to write an empty file', 400, 'empty_file');
      if (buffer.length > MAX_INBOX_BYTES) {
        refuse(`File is ${buffer.length} bytes; the limit is ${MAX_INBOX_BYTES}`, 413, 'file_too_large');
      }
      const out = await writeInboxFile({ project: projectName, filename: name, buffer });
      await audit('agent_inbox_write', { tokenId: token.id, label: token.label, project: projectName,
        filename: out.name, bytes: buffer.length });
      return { project: projectName, ...out,
        hint: `Tell the session to read ${out.path} — a prompt naming the path is how a file becomes work.` };
    },

    async read(token, { project: projectName, session, lines = DEFAULT_READ_LINES, include_scrollback = false, since_turn = '' }) {
      await reach(token, projectName);
      const { window } = await resolveWindow(projectName, session);
      if (!window) refuse(`No session "${session}" in ${projectName}`, 404, 'no_such_session');
      const wanted = Number.isFinite(Number(lines)) ? Math.trunc(Number(lines)) : DEFAULT_READ_LINES;
      let capped = Math.max(1, Math.min(MAX_READ_LINES, wanted));
      // `since_turn` is an APPROXIMATION and says so in the response: a pane is a
      // screen with a scrollback, not an append-only log, so "what appeared since"
      // is reconstructed from how much has scrolled away since the prompt went in
      // plus what is on screen now. A redrawing TUI can repaint lines that were
      // already there, and nothing tmux reports can separate those.
      let approximate = false;
      const cursor = since_turn && turns ? turns.cursor(since_turn) : null;
      if (since_turn && !cursor) refuse(`No such turn: ${since_turn}`, 404, 'no_such_turn');
      if (cursor) {
        const metrics = paneMetrics ? await paneMetrics(targetFor(projectName, window.index)).catch(() => ({})) : {};
        const scrolled = Math.max(0, (Number(metrics.history) || 0) - cursor.historyAtStart);
        capped = Math.max(1, Math.min(MAX_READ_LINES, scrolled + (Number(metrics.rows) || DEFAULT_READ_LINES)));
        approximate = true;
      }
      const text = await capturePane(targetFor(projectName, window.index), { lines: capped, scrollback: !!include_scrollback || approximate });
      await audit('agent_read', { tokenId: token.id, label: token.label, project: projectName, session, lines: capped });
      return { project: projectName, session, window: window.index, lines: capped,
        truncated: !approximate && wanted > capped, text,
        ...(approximate ? { since_turn, approximate: true } : {}) };
    },
  };
}
