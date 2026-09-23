// The MCP façade (docs/agent-mcp.md phase 4).
//
// Two closures are the security control rather than a description of scope, and
// this file is what enforces them: the tool list cannot grow quietly, and
// `sampling` must never be advertised — a server that declares it can ask its
// CLIENT to run inference, inverting the control direction the product depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentMcp, ALLOWED_TOOLS, TOOL_DEFINITIONS, TOOL_SCOPES,
  FORBIDDEN_TOOL_FRAGMENTS, MCP_PROTOCOL_VERSION, JsonRpc,
} from '../app/agent-mcp.js';
import { AgentSessionError } from '../app/agent-sessions.js';

const BOT = { id: 'tok-1', label: 'PVIBot', actsAs: 'kev', scopes: ['sessions:read', 'sessions:prompt'] };

function harness(overrides = {}) {
  const calls = [];
  const spy = (name) => async (...args) => { calls.push([name, ...args]); return { ok: name }; };
  const sessions = {
    projects: spy('projects'), sessions: spy('sessions'), prompt: spy('prompt'),
    turn: spy('turn'), waitForTurn: spy('waitForTurn'), read: spy('read'),
    ...overrides,
  };
  const mcp = createAgentMcp({
    sessions,
    tokenHasScope: (token, scope) => (token.scopes || []).includes(scope),
    serverVersion: '1.26.0923.2230',
  });
  const send = (method, params, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method, params }, BOT);
  return { mcp, calls, send };
}

test('the advertised tool set is exactly the allow-list, and every name is safe', () => {
  // If a capability is ever added, this is the test that makes it a deliberate,
  // reviewable edit rather than a quiet one.
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), [...ALLOWED_TOOLS]);
  assert.deepEqual(Object.keys(TOOL_SCOPES).sort(), [...ALLOWED_TOOLS].sort());
  for (const tool of TOOL_DEFINITIONS) {
    for (const fragment of FORBIDDEN_TOOL_FRAGMENTS) {
      assert.equal(tool.name.includes(fragment), false, `${tool.name} contains the forbidden fragment "${fragment}"`);
    }
    // Closed and bounded: an open schema lets a client send fields nobody vetted.
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} has an open input schema`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a description the calling model can act on`);
  }
  // No tool takes a filesystem path or a command; the only nameable things are a
  // project, a session and a turn this instance issued.
  const fields = new Set(TOOL_DEFINITIONS.flatMap((t) => Object.keys(t.inputSchema.properties)));
  assert.deepEqual([...fields].sort(), ['cli', 'create_if_missing', 'include_scrollback', 'lines', 'project', 'prompt', 'session', 'since_turn', 'timeout_ms', 'turn_id']);
});

test('initialize advertises tools and NOTHING else — sampling above all', async () => {
  const { send } = harness();
  const reply = await send('initialize', { protocolVersion: MCP_PROTOCOL_VERSION });
  assert.equal(reply.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(Object.keys(reply.result.capabilities), ['tools']);
  assert.equal('sampling' in reply.result.capabilities, false, 'a server that can ask its client to infer has inverted the control direction');
  assert.equal('prompts' in reply.result.capabilities, false, 'do not advertise what is not served');
  assert.equal('resources' in reply.result.capabilities, false);
  assert.equal(reply.result.serverInfo.name, 'project-workbench');
  assert.match(reply.result.instructions, /stopped, not that it succeeded/,
    'the honest limit belongs where the model will read it');

  const listed = await send('tools/list');
  assert.deepEqual(listed.result.tools.map((t) => t.name), [...ALLOWED_TOOLS]);
});

test('each tool is gated on its own scope, and a refusal never reaches the engine', async () => {
  const readOnly = { ...BOT, scopes: ['sessions:read'] };
  const { mcp, calls } = harness();
  const denied = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'pw_send_prompt', arguments: { project: 'Demo', session: 'lane', prompt: 'x' } } }, readOnly);
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /missing_scope/);
  assert.match(denied.result.content[0].text, /sessions:prompt/);
  assert.equal(calls.length, 0, 'the engine is not consulted when the credential cannot ask');

  // The read tools work on the same credential.
  const ok = await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'pw_list_sessions', arguments: { project: 'Demo' } } }, readOnly);
  assert.equal(ok.result.isError, false);
  assert.deepEqual(calls.map(([name]) => name), ['sessions']);
});

test('every tool delegates to the engine with the caller token, and nothing else', async () => {
  const { send, calls } = harness();
  await send('tools/call', { name: 'pw_list_projects', arguments: {} });
  await send('tools/call', { name: 'pw_list_sessions', arguments: { project: 'Demo' } });
  await send('tools/call', { name: 'pw_send_prompt', arguments: { project: 'Demo', session: 'lane', prompt: 'go', cli: 'claude' } });
  await send('tools/call', { name: 'pw_get_turn', arguments: { project: 'Demo', session: 'lane', turn_id: 'abc' } });
  await send('tools/call', { name: 'pw_wait_for_turn', arguments: { project: 'Demo', session: 'lane', turn_id: 'abc', timeout_ms: 5000 } });
  await send('tools/call', { name: 'pw_read_session', arguments: { project: 'Demo', session: 'lane', lines: 10 } });

  assert.deepEqual(calls.map(([name]) => name), ['projects', 'sessions', 'prompt', 'turn', 'waitForTurn', 'read']);
  for (const [, token] of calls) assert.equal(token.id, 'tok-1', 'the engine always sees the calling credential');
  const [, , promptArgs] = calls[2];
  assert.deepEqual(promptArgs, { project: 'Demo', session: 'lane', prompt: 'go', cli: 'claude', create_if_missing: true });
});

test('an engine refusal is a tool RESULT the model can read, not a transport error', async () => {
  // A model must be able to see "that is not your lane" and adapt; a JSON-RPC
  // error is invisible to it as anything but a fault.
  const { mcp } = harness({
    prompt: async () => { throw new AgentSessionError('not your lane', 403, 'not_my_lane'); },
  });
  const reply = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'pw_send_prompt', arguments: { project: 'Demo', session: 'lane', prompt: 'x' } } }, BOT);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not_my_lane: not your lane/);

  // An unexpected fault, by contrast, IS a protocol error.
  const broken = harness({ read: async () => { throw new Error('tmux exploded'); } });
  const faulted = await broken.mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'pw_read_session', arguments: { project: 'Demo', session: 'lane' } } }, BOT);
  assert.equal(faulted.error.code, JsonRpc.INTERNAL);
});

test('protocol edges: unknown method, unknown tool, malformed request, notifications', async () => {
  const { send, mcp } = harness();
  assert.equal((await send('tools/nope')).error.code, JsonRpc.METHOD_NOT_FOUND);
  assert.equal((await send('tools/call', {})).error.code, JsonRpc.INVALID_PARAMS);
  assert.match((await send('tools/call', { name: 'pw_run_shell' })).result.content[0].text, /unknown_tool/);
  assert.equal((await mcp.handle({ method: 'initialize' }, BOT)).error.code, JsonRpc.INVALID_REQUEST);
  assert.equal((await mcp.handle('not an object', BOT)).error.code, JsonRpc.INVALID_REQUEST);

  // A notification has no id and by spec gets no reply at all.
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, BOT), null);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'ping' }, BOT), null);
  assert.deepEqual((await send('ping')).result, {});
});

test('a tool result carries both text and structured content', async () => {
  const { mcp } = harness({ projects: async () => ({ projects: [{ name: 'Demo' }] }) });
  const reply = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'pw_list_projects', arguments: {} } }, BOT);
  assert.deepEqual(reply.result.structuredContent, { projects: [{ name: 'Demo' }] });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { projects: [{ name: 'Demo' }] });
});
