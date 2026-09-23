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
// There is no tool that takes a filesystem path, no tool that runs a command, and
// no tool that reads a file. The only way to name anything is a project name, a
// session name, and a turn id this instance issued.

import { MAX_PROMPT_BYTES, MAX_READ_LINES, DEFAULT_READ_LINES, SUPPORTED_CLIS, AgentSessionError } from './agent-sessions.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'project-workbench';

export const ALLOWED_TOOLS = Object.freeze([
  'pw_list_projects',
  'pw_list_sessions',
  'pw_send_prompt',
  'pw_get_turn',
  'pw_wait_for_turn',
  'pw_read_session',
]);

/** Mirrors the orchestrator adapter's list, checked against the real exported names. */
export const FORBIDDEN_TOOL_FRAGMENTS = Object.freeze([
  'shell', 'exec', 'command', 'run_', 'read_file', 'write_file', 'list_dir', 'path',
  'clone', 'checkout', 'eval', 'script', 'secret', 'credential', 'env', 'token',
]);

/** Which scope each tool needs. The engine enforces the rest (create, prompt:any). */
export const TOOL_SCOPES = Object.freeze({
  pw_list_projects: 'sessions:read',
  pw_list_sessions: 'sessions:read',
  pw_read_session: 'sessions:read',
  pw_get_turn: 'sessions:read',
  pw_wait_for_turn: 'sessions:read',
  pw_send_prompt: 'sessions:prompt',
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
