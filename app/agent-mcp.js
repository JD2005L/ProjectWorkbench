// The MCP façade over the agent session engine — docs/agent-mcp.md phase 4.
//
// An external AI adds this as an HTTP MCP server and gets six tools: find the
// projects and sessions it may reach, put a prompt into one, wait for that turn to
// end, and read what it produced.
//
// It is a TRANSLATION LAYER AND NOTHING ELSE. Every authorization decision lives in
// app/agent-sessions.js, which the REST routes call too — the rule
// app/orchestrator/mcp.js already states about its own adapter, and the reason is
// the same: a second copy of an authorization decision is a second thing to get
// wrong. What this file owns is the protocol, the closed tool list, and the tool
// DESCRIPTIONS — which matter more than they look, because they are the only
// documentation the calling model will ever read.
//
// Two closures are the security control rather than a description of scope:
//
//   * ALLOWED_TOOLS is compared against the exported definitions by the test
//     suite, so a capability cannot arrive quietly; adding one takes a reviewable
//     edit here.
//   * `sampling` is not merely unused, it is NOT ADVERTISED. A server that
//     declares it can ask its client to run inference on its behalf, which would
//     give ProjectWorkbench a way to trigger hidden AI calls back through the
//     caller — inverting the control direction the whole product depends on.
//
// WHAT CHANGED, AND WHY THE CLAIM IS NOW NARROWER. This header used to say no
// tool takes a filesystem path and none reads a file. Reading project source was
// added deliberately (operator decision, 2026-09-24), so the honest claim is the
// one that is still true: no tool RUNS anything, no tool writes project source,
// and the read paths are confined by app/workspace-file.js — realpath'd inside
// the project, traversals refused before any filesystem call, credential-shaped
// paths denied, sizes capped, every read audited with its path.
//
// Writing stays out on purpose, with one exception: a file placed in the
// project's _inbox, which is how a human hands a session a document too. A change
// that goes through the agent inherits the project's tests, conventions and
// review, and an audit line reading "the agent did this work" beats one reading
// "a token wrote 40 files".
//
// `path` remains on FORBIDDEN_TOOL_FRAGMENTS below: the ban is on tool NAMES that
// advertise raw filesystem access, and renaming around a guard rather than
// amending it deliberately is exactly the move that list exists to prevent.

import { MAX_PROMPT_BYTES, MAX_READ_LINES, DEFAULT_READ_LINES, SUPPORTED_CLIS, MAX_INBOX_BYTES, AgentSessionError } from './agent-sessions.js';
import { WORKSPACE_READ_MAX_BYTES, WORKSPACE_TREE_MAX_ENTRIES } from './workspace-file.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'project-workbench';

export const ALLOWED_TOOLS = Object.freeze([
  'pw_list_projects',
  'pw_list_sessions',
  'pw_send_prompt',
  'pw_get_turn',
  'pw_wait_for_turn',
  'pw_read_session',
  'pw_session_transcript',
  'pw_workspace_tree',
  'pw_workspace_file',
  'pw_put_inbox_file',
]);

/** Mirrors the orchestrator adapter's list, checked against the real exported names. */
export const FORBIDDEN_TOOL_FRAGMENTS = Object.freeze([
  'shell', 'exec', 'command', 'run_', 'read_file', 'write_file', 'list_dir', 'path',
  'clone', 'checkout', 'eval', 'script', 'secret', 'credential', 'env', 'token',
]);

/**
 * Does this tool name advertise a capability the surface refuses to have?
 *
 * Matched on snake_case SEGMENTS for single words, and as a substring for the
 * multi-word fragments that span them. A raw substring test flagged
 * `pw_session_transcript` for containing "script", and the choice then is to
 * weaken the guard, rename an honest tool to slip past it, or make the check say
 * what it means. The third is the only one that leaves the guard working: a tool
 * called `pw_run_script` is still caught, and "transcript" is still a word.
 */
export function violatesToolNaming(name) {
  const segments = new Set(String(name).split('_'));
  return FORBIDDEN_TOOL_FRAGMENTS.filter((fragment) => (fragment.includes('_')
    ? String(name).includes(fragment)
    : segments.has(fragment) || segments.has(fragment.replace(/_$/, ''))));
}

/** Which scope each tool needs. The engine enforces the rest (create, prompt:any). */
export const TOOL_SCOPES = Object.freeze({
  pw_list_projects: 'sessions:read',
  pw_list_sessions: 'sessions:read',
  pw_read_session: 'sessions:read',
  pw_get_turn: 'sessions:read',
  pw_wait_for_turn: 'sessions:read',
  pw_send_prompt: 'sessions:prompt',
  // Its own scope, not sessions:read: a transcript is everything said and
  // everything the agent read, which is a different thing to hand over than a
  // screen's worth of output.
  pw_session_transcript: 'sessions:transcript',
  pw_workspace_tree: 'workspace:read',
  pw_workspace_file: 'workspace:read',
  pw_put_inbox_file: 'workspace:inbox',
});

const closed = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const NAME = { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const TURN = { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9]+$' };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'pw_list_projects',
    description: 'List the Project Workbench projects this credential may reach. A project is a git workspace with its own terminal sessions.',
    inputSchema: closed({}),
  },
  {
    name: 'pw_list_sessions',
    description: 'List the named sessions in one project. A session is a terminal window running a coding agent. `working` means it is mid-turn, `finished_turn` that it rang the done signal, and `owned_by_this_token` that this credential created it — you may only send prompts into sessions you own unless separately authorised.',
    inputSchema: closed({ project: NAME }, ['project']),
  },
  {
    name: 'pw_send_prompt',
    description: [
      'Send a prompt to a coding agent in a named session, as if typed by the person this credential acts as.',
      `The prompt is pasted whole (up to ${MAX_PROMPT_BYTES} bytes); for anything larger, put the content in the project's _inbox/ and name the path in the prompt instead.`,
      'If the session does not exist and create_if_missing is true, it is created — and `cli` is then REQUIRED, because starting Claude and starting Copilot spend different credentials and there is no safe default.',
      'An existing session continues with whatever it is already running; `cli` is ignored for one.',
      'Returns a turn_id. Use pw_wait_for_turn to learn when that turn ends, then pw_read_session with since_turn to read what it produced.',
    ].join(' '),
    inputSchema: closed({
      project: NAME,
      session: NAME,
      prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_BYTES },
      cli: { type: 'string', enum: [...SUPPORTED_CLIS] },
      create_if_missing: { type: 'boolean' },
    }, ['project', 'session', 'prompt']),
  },
  {
    name: 'pw_get_turn',
    description: 'The state of one turn right now, without waiting: running, completed or gone (its session was closed). `completed_by` is "bell" when the agent signalled it finished, or "quiet" when it simply stopped working. IMPORTANT: completed means the agent STOPPED, not that it succeeded — a refusal, a crash and a question asked back all end a turn. Read the session output to judge what happened.',
    inputSchema: closed({ project: NAME, session: NAME, turn_id: TURN }, ['project', 'session', 'turn_id']),
  },
  {
    name: 'pw_wait_for_turn',
    description: 'Wait for a turn to end, holding the request open up to timeout_ms (10 minutes maximum). A reply of `running` means the timeout was reached, not that anything failed — call again to keep waiting. Same caveat as pw_get_turn: completed means stopped, not succeeded.',
    inputSchema: closed({
      project: NAME, session: NAME, turn_id: TURN,
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
    }, ['project', 'session', 'turn_id']),
  },
  {
    name: 'pw_read_session',
    description: [
      `Read a session's recent output, newest last, up to ${MAX_READ_LINES} lines (default ${DEFAULT_READ_LINES}).`,
      'With since_turn, the read is narrowed to what appeared after that prompt and the reply is marked approximate: a terminal is a screen with a scrollback, not an append-only log, and an agent that redraws its interface can repaint lines that were already there.',
    ].join(' '),
    inputSchema: closed({
      project: NAME, session: NAME,
      lines: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES },
      since_turn: TURN,
      include_scrollback: { type: 'boolean' },
    }, ['project', 'session']),
  },
  {
    name: 'pw_session_transcript',
    description: [
      "A session's actual conversation, newest last — what was asked, what the agent replied, which tools it used.",
      'Prefer this to pw_read_session when you want to know what happened: the screen contains spinners, box drawing and frames the agent has since redrawn over, while this is the record.',
      'The reply names the session_id it read and how it found it: "window-marker" is exact, "most-recent" means it took the newest conversation in this project — so with two sessions open in one project, it may not be the one you prompted. One agent session per project avoids the question entirely.',
    ].join(' '),
    inputSchema: closed({
      project: NAME, session: NAME,
      messages: { type: 'integer', minimum: 1, maximum: 200 },
    }, ['project', 'session']),
  },
  {
    name: 'pw_workspace_tree',
    description: `List a directory in the project's git workspace, up to ${WORKSPACE_TREE_MAX_ENTRIES} entries. Paths are relative to the project root; an entry marked denied holds credentials rather than source and cannot be read.`,
    inputSchema: closed({
      project: NAME,
      path: { type: 'string', maxLength: 512 },
      max_entries: { type: 'integer', minimum: 1, maximum: WORKSPACE_TREE_MAX_ENTRIES },
    }, ['project']),
  },
  {
    name: 'pw_workspace_file',
    description: [
      `Read one file from the project's git workspace, up to ${WORKSPACE_READ_MAX_BYTES} bytes (truncated is reported, not silent).`,
      'Relative paths only; traversals, links that leave the project, and credential files are refused.',
      'A binary file reports its size rather than returning bytes.',
      'This is read-only: to change something, prompt the session and let the coding agent do it, so the work inherits the project\'s tests and conventions.',
    ].join(' '),
    inputSchema: closed({
      project: NAME,
      path: { type: 'string', minLength: 1, maxLength: 512 },
      max_bytes: { type: 'integer', minimum: 1, maximum: WORKSPACE_READ_MAX_BYTES },
    }, ['project', 'path']),
  },
  {
    name: 'pw_put_inbox_file',
    description: [
      `Place a file in the project's _inbox (up to ${MAX_INBOX_BYTES} bytes) — the way to hand a session something too large for a prompt.`,
      'It appears in the operator\'s Files tray exactly as a human upload does.',
      'This does NOT do anything by itself: follow it with pw_send_prompt naming the returned path, which is what turns a file into work.',
      'Set base64 true for binary content.',
    ].join(' '),
    inputSchema: closed({
      project: NAME,
      filename: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      content: { type: 'string', minLength: 1 },
      base64: { type: 'boolean' },
    }, ['project', 'filename', 'content']),
  },
]);

export const JsonRpc = Object.freeze({
  PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
});

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

export function createAgentMcp({ sessions, tokenHasScope, serverVersion = '0' } = {}) {
  async function callTool(token, name, args = {}) {
    if (!ALLOWED_TOOLS.includes(name)) throw new AgentSessionError(`Unknown tool: ${name}`, 404, 'unknown_tool');
    const scope = TOOL_SCOPES[name];
    if (!tokenHasScope(token, scope)) {
      throw new AgentSessionError(`This credential lacks the scope "${scope}" that ${name} requires`, 403, 'missing_scope');
    }
    switch (name) {
      case 'pw_list_projects': return sessions.projects(token);
      case 'pw_list_sessions': return sessions.sessions(token, args.project);
      case 'pw_send_prompt': return sessions.prompt(token, {
        project: args.project, session: args.session, prompt: args.prompt,
        cli: String(args.cli || ''), create_if_missing: args.create_if_missing !== false,
      });
      case 'pw_get_turn': return sessions.turn(token, args);
      case 'pw_wait_for_turn': return sessions.waitForTurn(token, args);
      case 'pw_read_session': return sessions.read(token, args);
      case 'pw_session_transcript': return sessions.transcript(token, args);
      case 'pw_workspace_tree': return sessions.tree(token, args);
      case 'pw_workspace_file': return sessions.file(token, args);
      case 'pw_put_inbox_file': return sessions.putInbox(token, args);
      default: throw new AgentSessionError(`Unknown tool: ${name}`, 404, 'unknown_tool');
    }
  }

  /**
   * One JSON-RPC message in, one response out — or `null` for a notification,
   * which by spec gets no reply at all.
   */
  async function handle(message, token) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return failure(message?.id ?? null, JsonRpc.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
    }
    const { id, method, params } = message;
    const notification = id === undefined || id === null;

    if (method === 'initialize') {
      // Capabilities are advertised by what is served and nothing else: tools,
      // full stop. No sampling (see the header), no prompts, no resources.
      return notification ? null : result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: String(serverVersion) },
        instructions: 'Drive a coding agent inside a Project Workbench project: list what you can reach, send a prompt to a named session, wait for that turn to end, then read what it produced. A completed turn means the agent stopped, not that it succeeded.',
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return notification ? null : result(id, {});
    if (method === 'tools/list') {
      return notification ? null : result(id, { tools: TOOL_DEFINITIONS });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string') return failure(id, JsonRpc.INVALID_PARAMS, 'tools/call needs a tool name');
      try {
        const value = await callTool(token, name, params?.arguments || {});
        // Text-JSON: every MCP client can read it, and structuredContent is
        // carried alongside for those that prefer it.
        return notification ? null : result(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        });
      } catch (error) {
        if (error instanceof AgentSessionError) {
          // A tool-level refusal is a RESULT with isError, not a protocol error:
          // the model is meant to read it and adapt, not treat it as a transport
          // fault it cannot see.
          return notification ? null : result(id, {
            content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
            isError: true,
          });
        }
        return notification ? null : failure(id, JsonRpc.INTERNAL, error?.message || String(error));
      }
    }
    return notification ? null : failure(id, JsonRpc.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }

  return { handle, callTool };
}
