// Increment 11 — the constrained MCP adapter.
//
// The adapter's security value is entirely in what it does *not* expose, so that is what these
// tests assert: the tool set is closed and matches the contract, no tool name carries a forbidden
// fragment, sampling is not advertised, resources and prompts are empty, and authorization is
// inherited from the engine rather than re-implemented (so a cross-tenant call fails identically
// over MCP and over HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ALLOWED_TOOLS, TOOL_DEFINITIONS, FORBIDDEN_TOOL_FRAGMENTS, MCP_PROTOCOL_VERSION,
  createToolDispatcher, createMcpHandler,
} from '../app/orchestrator/mcp.js';
import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { OrchestrationEngine } from '../app/orchestrator/engine.js';
import { ArtifactStore, CheckRunner } from '../app/orchestrator/checks.js';
import {
  ProjectConfigStore, resolveProject, capabilitiesPayload, listGrantedProjects,
} from '../app/orchestrator/projects.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';
const TOKEN = Object.freeze({
  token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: ['jobs:read', 'jobs:write', 'session:manage', 'publish'],
});

async function withMcp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-mcp-'));
  const projectsPath = path.join(dir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: { Demo: { display_name: 'Demo', capabilities: ['implementation'], verification_commands: ['true'] } },
  }));
  fs.mkdirSync(path.join(dir, 'workspaces', 'Demo'), { recursive: true });

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: path.join(dir, 'workspaces'),
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 500,
  });
  const repo = new OrchestratorRepository(store);
  const artifacts = new ArtifactStore({ config, repo, store });
  const projectStore = new ProjectConfigStore(projectsPath);
  const backend = new FakeCodingBackend();
  const engine = new OrchestrationEngine({
    config, store, repo, backend, artifacts, projectStore,
    checkRunner: new CheckRunner({ config, repo, store, artifacts }),
    sessionManager: {
      ensureSession: async () => ({ session_key: 'k' }),
      verifySession: async () => ({ effective: null }),
      resolveCredentials: async () => ({ tokens: [] }),
    },
  });

  const dispatch = createToolDispatcher({
    engine, backend, config, projectStore,
    sessionManager: engine.sessionManager,
    resolveProject: {
      resolve: (c, ps, tk, id) => resolveProject(c, ps, tk, id),
      capabilities: (c, ps, tk, id) => capabilitiesPayload(c, resolveProject(c, ps, tk, id)),
      list: (c, ps, tk) => listGrantedProjects(c, ps, tk),
    },
  });
  const handle = createMcpHandler({ dispatch, token: TOKEN });

  try {
    await fn({ dispatch, handle, engine, config, store });
  } finally {
    await engine.drain().catch(() => {});
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// the closed surface
// ---------------------------------------------------------------------------

test('mcp: the tool set is exactly the contract operations plus the Milestone 2 additions', () => {
  // The contract's sixteen client methods, mapped to their MCP names (§4).
  const contractTools = [
    'pw_health', 'pw_list_projects', 'pw_get_project_capabilities',
    'pw_ensure_orchestrator_session', 'pw_verify_session_configuration',
    'pw_submit_job', 'pw_get_job', 'pw_get_events', 'pw_stream_events',
    'pw_reply_to_question', 'pw_approve_stage', 'pw_request_revision', 'pw_request_review',
    'pw_cancel_job', 'pw_get_result', 'pw_get_artifact_metadata', 'pw_get_artifact_excerpt',
  ];
  // The §9 additions Milestone 1 identified, plus publication.
  const milestone2 = ['pw_get_questions', 'pw_get_approvals', 'pw_get_checks', 'pw_get_reviews', 'pw_publish'];

  assert.deepEqual([...ALLOWED_TOOLS].sort(), [...contractTools, ...milestone2].sort());
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name).sort(), [...ALLOWED_TOOLS].sort());
});

test('mcp: there is no shell, no file read, no directory listing, and no path parameter', () => {
  for (const tool of TOOL_DEFINITIONS) {
    for (const fragment of FORBIDDEN_TOOL_FRAGMENTS) {
      assert.ok(!tool.name.includes(fragment), `tool ${tool.name} contains forbidden fragment '${fragment}'`);
    }
    // No input schema may accept a filesystem path or a command. `intended_files` on pw_publish is
    // the sole exception and is a *repository-relative* list validated by the relativePath type.
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    for (const property of properties) {
      if (tool.name === 'pw_publish' && property === 'intended_files') continue;
      assert.ok(
        !/path|dir|file|command|cmd|script|shell|exec/i.test(property),
        `tool ${tool.name} exposes a path-like parameter '${property}'`,
      );
    }
  }
});

test('mcp: every input schema is closed, so an argument cannot be smuggled past validation', () => {
  for (const tool of TOOL_DEFINITIONS) {
    // pw_submit_job forwards the whole task contract, which the engine validates strictly against
    // SUBMIT_JOB_SCHEMA; everything else is closed at the schema.
    if (tool.name === 'pw_submit_job') continue;
    assert.equal(
      tool.inputSchema.additionalProperties, false,
      `tool ${tool.name} must not accept additional properties`,
    );
  }
});

test('mcp: sampling is not advertised, so the server can never ask its client to run inference', async () => {
  await withMcp(async ({ handle }) => {
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(Object.keys(response.result.capabilities), ['tools']);
    assert.equal(response.result.capabilities.sampling, undefined);
    assert.ok(!JSON.stringify(response.result).toLowerCase().includes('sampling'));
  });
});

test('mcp: resources and prompts are empty — the artifact id is the only way to name content', async () => {
  await withMcp(async ({ handle }) => {
    assert.deepEqual((await handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).result.resources, []);
    assert.deepEqual((await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/list' })).result.prompts, []);
  });
});

test('mcp: tools/list returns the whole closed set with descriptions', async () => {
  await withMcp(async ({ handle }) => {
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(response.result.tools.length, ALLOWED_TOOLS.length);
    for (const tool of response.result.tools) {
      assert.ok(tool.description?.length > 10, `${tool.name} needs a description`);
      assert.ok(tool.inputSchema);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('mcp: a tool outside the allowlist is refused', async () => {
  await withMcp(async ({ dispatch, handle }) => {
    for (const name of ['pw_run_shell', 'pw_read_file', 'pw_list_directory', 'health', '', null, '__proto__']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(dispatch(name, TOKEN, {}, {}), /no such tool/, `${name} must not dispatch`);
    }
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pw_run_shell', arguments: { cmd: 'id' } } });
    assert.ok(response.error, 'an unknown tool must be an error, not a silent no-op');
    assert.equal(response.error.data.error, 'not_found');
  });
});

test('mcp: an unknown JSON-RPC method is method-not-found rather than an internal error', async () => {
  await withMcp(async ({ handle }) => {
    const response = await handle({ jsonrpc: '2.0', id: 1, method: 'completion/complete' });
    assert.equal(response.error.code, -32601);
  });
});

test('mcp: discovery tools return the same payloads as the HTTP surface', async () => {
  await withMcp(async ({ dispatch }) => {
    const health = await dispatch('pw_health', TOKEN, {}, {});
    assert.equal(health.instance_id, INSTANCE);
    assert.equal(health.contract_version, '1.0');

    const projects = await dispatch('pw_list_projects', TOKEN, {}, {});
    assert.deepEqual(projects.map((p) => p.project_id), ['Demo']);

    const capabilities = await dispatch('pw_get_project_capabilities', TOKEN, { project_id: 'Demo' }, {});
    assert.deepEqual(capabilities.capabilities, ['implementation']);
  });
});

test('mcp: authorization is inherited from the engine, not re-implemented in the adapter', async () => {
  await withMcp(async ({ dispatch }) => {
    const intruder = { ...TOKEN, orchestrator_instance_id: 'orch-other', projects: ['Demo'] };
    // A job that does not exist for this credential is not_found over MCP exactly as over HTTP.
    await assert.rejects(
      dispatch('pw_get_job', intruder, { workbench_job_id: 'pwjob_whatever' }, {}),
      (err) => err.code === 'not_found',
    );
    // A project this credential was not granted is refused.
    await assert.rejects(
      dispatch('pw_get_project_capabilities', { ...TOKEN, projects: [] }, { project_id: 'Demo' }, {}),
      (err) => err.code === 'project_not_authorized',
    );
  });
});

test('mcp: a missing required argument is a validation failure, not a crash', async () => {
  await withMcp(async ({ dispatch }) => {
    await assert.rejects(dispatch('pw_get_job', TOKEN, {}, {}), (err) => err.code === 'validation_failed');
    await assert.rejects(dispatch('pw_get_events', TOKEN, {}, {}), (err) => err.code === 'validation_failed');
    await assert.rejects(dispatch('pw_get_artifact_metadata', TOKEN, {}, {}), (err) => err.code === 'validation_failed');
  });
});

test('mcp: an error response carries the contract envelope and no internal detail', async () => {
  await withMcp(async ({ handle }) => {
    const response = await handle({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'pw_get_job', arguments: { workbench_job_id: 'pwjob_nope' } },
    });
    assert.equal(response.id, 7);
    assert.equal(response.error.data.schema_version, '1.0');
    assert.equal(response.error.data.error, 'not_found');
    const blob = JSON.stringify(response);
    assert.ok(!/at\s+\w+\s+\(/.test(blob), 'no stack frame may appear');
    assert.ok(!blob.includes('/tmp/'), 'no filesystem path may appear');
  });
});
