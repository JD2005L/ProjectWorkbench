// The constrained MCP adapter.
//
// The tool surface is *closed*, and that closure is the security control rather than a description
// of current scope. There is no `pw_run_shell`, no `read_file`, no `list_directory`, and no tool
// taking a filesystem path — the only way to name remote content is an opaque `artifact_id` this
// instance issued. `ALLOWED_TOOLS` below is compared against the exported tool set by the test
// suite, so a capability cannot be added quietly: it takes an explicit, reviewable edit here.
//
// Sampling is not merely unused, it is not advertised. An MCP server that declares the sampling
// capability can ask its *client* to run inference on its behalf — which would give ProjectWorkbench
// a way to trigger hidden AI calls back through the orchestrator, inverting the control direction
// the whole product depends on.
//
// The adapter is a thin translation layer over the same engine the HTTP API uses. It deliberately
// owns no state and makes no authorization decisions of its own: those live in one place, and a
// second copy would be a second thing to get wrong.

import { SCHEMA_VERSION, ErrorCode } from './contract.js';
import { ApiError, errorEnvelope } from './errors.js';
import { validate } from './validate.js';
import { ARTIFACT_EXCERPT_SCHEMA, PUBLICATION_REQUEST_SCHEMA } from './schemas.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * The complete, intentional tool set — the contract's sixteen operations plus the five Milestone 2
 * additions (§9.1-§9.5).
 */
export const ALLOWED_TOOLS = Object.freeze([
  'pw_health',
  'pw_list_projects',
  'pw_get_project_capabilities',
  'pw_ensure_orchestrator_session',
  'pw_verify_session_configuration',
  'pw_submit_job',
  'pw_get_job',
  'pw_get_events',
  'pw_stream_events',
  'pw_reply_to_question',
  'pw_approve_stage',
  'pw_request_revision',
  'pw_request_review',
  'pw_cancel_job',
  'pw_get_result',
  'pw_get_artifact_metadata',
  'pw_get_artifact_excerpt',
  // -- Milestone 2 additions --
  'pw_get_questions',
  'pw_get_approvals',
  'pw_get_checks',
  'pw_get_reviews',
  'pw_publish',
]);

/**
 * Name fragments that must never appear on a tool.
 *
 * Mirrors `FORBIDDEN_METHOD_FRAGMENTS` in the orchestrator's protocol.py. Checked against the
 * actual exported names, not just intentions.
 */
export const FORBIDDEN_TOOL_FRAGMENTS = Object.freeze([
  'shell', 'exec', 'command', 'run_', 'read_file', 'write_file', 'list_dir', 'path',
  'clone', 'checkout', 'eval', 'script', 'secret', 'credential', 'env',
]);

const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const JOB_ID = { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9:._-]+$' };
const SLUG = { type: 'string', maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' };

/** Tool definitions. Every input schema is closed (`additionalProperties: false`) and bounded. */
export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'pw_health', description: 'Instance health and coding-backend authentication health.', inputSchema: object({}) },
  { name: 'pw_list_projects', description: 'Projects this credential may route work to.', inputSchema: object({}) },
  {
    name: 'pw_get_project_capabilities',
    description: "What a project's orchestrator lane can do. An absent flag means not offered.",
    inputSchema: object({ project_id: SLUG }, ['project_id']),
  },
  {
    name: 'pw_ensure_orchestrator_session',
    description: 'Create or adopt the project\'s dedicated named lane. Never adopts a human session.',
    inputSchema: object({
      orchestrator_instance_id: JOB_ID, project_id: SLUG,
      role: { ...SLUG }, reserved_tmux_window: { ...SLUG },
      cli_backend: { type: 'string', enum: ['claude-code', 'codex-cli'] },
      force_replace: { type: 'boolean' },
    }, ['orchestrator_instance_id', 'project_id']),
  },
  {
    name: 'pw_verify_session_configuration',
    description: 'Report the effective model and effort. Returns null when it cannot be determined.',
    inputSchema: object({
      project_id: SLUG, session_key: JOB_ID,
      phase_class: { type: 'string', enum: ['discovery', 'planning', 'implementation', 'mechanical_correction', 'high_risk_design', 'routine_review', 'high_risk_review'] },
      requested: object({
        model_alias: { type: 'string', maxLength: 120, pattern: '^[A-Za-z0-9._-]+$' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
      }, ['model_alias', 'effort']),
    }, ['project_id', 'session_key', 'phase_class', 'requested']),
  },
  { name: 'pw_submit_job', description: 'Delegate a task contract. Idempotent; carries a lease fencing token.', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'pw_get_job', description: 'A snapshot of a remote job.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  {
    name: 'pw_get_events',
    description: 'Ordered, gapless events after a cursor.',
    inputSchema: object({
      workbench_job_id: JOB_ID,
      after_sequence: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, ['workbench_job_id']),
  },
  {
    name: 'pw_stream_events',
    description: 'A bounded poll of the same cursor. MCP has no server-push, so this returns a batch; the HTTP endpoint offers true SSE.',
    inputSchema: object({
      workbench_job_id: JOB_ID,
      after_sequence: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, ['workbench_job_id']),
  },
  {
    name: 'pw_reply_to_question',
    description: 'Answer one live question. Stale, cross-job and repeat answers are refused.',
    inputSchema: object({
      workbench_job_id: JOB_ID, question_id: JOB_ID,
      answer: { type: 'string', maxLength: 2000 },
      selected_option_index: { type: 'integer', minimum: 0 },
    }, ['workbench_job_id', 'question_id', 'answer']),
  },
  {
    name: 'pw_approve_stage',
    description: 'Relay a recorded human decision. An agent assertion is not an approval.',
    inputSchema: object({
      workbench_job_id: JOB_ID, approval_id: JOB_ID, stage: SLUG,
      approved: { type: 'boolean' },
      reason: { type: 'string', maxLength: 2000 },
      decided_by: JOB_ID,
    }, ['workbench_job_id', 'approval_id', 'stage', 'approved']),
  },
  {
    name: 'pw_request_revision',
    description: 'Request one bounded correction. Not an invitation to redesign.',
    inputSchema: object({
      workbench_job_id: JOB_ID,
      instructions: { type: 'string', maxLength: 2000 },
      blocking_finding_ids: { type: 'array', maxItems: 50, items: JOB_ID },
    }, ['workbench_job_id', 'instructions']),
  },
  {
    name: 'pw_request_review',
    description: 'Request an independent review in a session that did not implement the change.',
    inputSchema: object({
      workbench_job_id: JOB_ID,
      require_fresh_session: { type: 'boolean' },
      requested: object({
        model_alias: { type: 'string', maxLength: 120, pattern: '^[A-Za-z0-9._-]+$' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
      }, ['model_alias', 'effort']),
    }, ['workbench_job_id', 'requested']),
  },
  {
    name: 'pw_cancel_job',
    description: 'Cancel a job. The working tree is preserved: no reset, stash, clean or discard.',
    inputSchema: object({ workbench_job_id: JOB_ID, reason: { type: 'string', maxLength: 200 } }, ['workbench_job_id', 'reason']),
  },
  { name: 'pw_get_result', description: 'The final evidence-backed result.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  { name: 'pw_get_artifact_metadata', description: 'Metadata for an artifact this instance issued.', inputSchema: object({ artifact_id: JOB_ID }, ['artifact_id']) },
  {
    name: 'pw_get_artifact_excerpt',
    description: 'A bounded, redacted window into an artifact. There is no filename or path parameter.',
    inputSchema: object({
      artifact_id: JOB_ID,
      byte_offset: { type: 'integer', minimum: 0 },
      max_bytes: { type: 'integer', minimum: 1, maximum: 65536 },
    }, ['artifact_id']),
  },
  { name: 'pw_get_questions', description: 'Typed questions raised by the coding session.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  { name: 'pw_get_approvals', description: 'Typed approval requests and their recorded decisions.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  { name: 'pw_get_checks', description: 'Deterministic verification records.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  { name: 'pw_get_reviews', description: 'Independent review records, carrying session_isolated.', inputSchema: object({ workbench_job_id: JOB_ID }, ['workbench_job_id']) },
  {
    name: 'pw_publish',
    description: 'Publish under a recorded approval. Stages only the intended files; never merges or deploys.',
    inputSchema: object({
      job_id: JOB_ID,
      branch: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._/-]+$' },
      commit_message: { type: 'string', maxLength: 2000 },
      intended_files: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 512 } },
      open_pull_request: { type: 'boolean' },
      approval_id: JOB_ID,
    }, ['job_id', 'branch', 'commit_message', 'intended_files']),
  },
]);

// Import-time invariant: the definitions and the allowlist must not drift apart, and no tool may
// carry a forbidden name fragment. Failing at import is the point — a mismatch must not ship.
{
  const defined = TOOL_DEFINITIONS.map((t) => t.name).sort();
  const allowed = [...ALLOWED_TOOLS].sort();
  if (JSON.stringify(defined) !== JSON.stringify(allowed)) {
    throw new Error('the MCP tool definitions and the allowlist disagree');
  }
  for (const name of defined) {
    for (const fragment of FORBIDDEN_TOOL_FRAGMENTS) {
      if (name.includes(fragment)) throw new Error(`forbidden fragment '${fragment}' in MCP tool '${name}'`);
    }
  }
}

/**
 * Dispatch a tool call to the engine.
 *
 * The credential is resolved once by the transport and passed in; the adapter never derives
 * authority from the tool arguments.
 */
export function createToolDispatcher({ engine, sessionManager, backend, config, projectStore, resolveProject }) {
  const requireArg = (args, name) => {
    const value = args?.[name];
    if (value === undefined || value === null) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, `the '${name}' argument is required`);
    }
    return value;
  };

  const handlers = {
    pw_health: async () => ({
      schema_version: SCHEMA_VERSION,
      instance_id: config.instanceId,
      contract_version: '1.0',
      reachable: true,
      backends: [await backend.probeAuth()],
      checked_at: new Date().toISOString(),
    }),

    pw_list_projects: async (token) => ({
      schema_version: SCHEMA_VERSION,
      projects: resolveProject.list(config, projectStore, token),
    }),

    pw_get_project_capabilities: async (token, args) => resolveProject.capabilities(
      config, projectStore, token, requireArg(args, 'project_id'),
    ),

    pw_ensure_orchestrator_session: async (token, args, ctx) => sessionManager.ensureSession({
      token,
      project: resolveProject.resolve(config, projectStore, token, requireArg(args, 'project_id')),
      request: {
        orchestrator_instance_id: requireArg(args, 'orchestrator_instance_id'),
        project_id: args.project_id,
        role: args.role ?? null,
        reserved_tmux_window: args.reserved_tmux_window ?? null,
        cli_backend: args.cli_backend ?? 'claude-code',
        force_replace: args.force_replace === true,
      },
      correlationId: ctx.correlationId,
    }),

    pw_verify_session_configuration: async (token, args, ctx) => sessionManager.verifySession({
      token,
      project: resolveProject.resolve(config, projectStore, token, requireArg(args, 'project_id')),
      request: {
        session_key: requireArg(args, 'session_key'),
        phase_class: requireArg(args, 'phase_class'),
        requested: requireArg(args, 'requested'),
      },
      correlationId: ctx.correlationId,
    }),

    pw_submit_job: async (token, args, ctx) => engine.submitJob({
      token, body: args, idempotencyKey: ctx.idempotencyKey, correlationId: ctx.correlationId,
    }),

    pw_get_job: async (token, args) => engine.getJob(token, requireArg(args, 'workbench_job_id')),

    pw_get_events: async (token, args) => engine.getEvents(token, requireArg(args, 'workbench_job_id'), {
      afterSequence: args.after_sequence ?? 0, limit: args.limit ?? 100,
    }),

    // MCP has no server-initiated push, so "stream" is a bounded poll of the same durable cursor.
    // Presenting it as anything else would be a lie about what the transport can do.
    pw_stream_events: async (token, args) => engine.getEvents(token, requireArg(args, 'workbench_job_id'), {
      afterSequence: args.after_sequence ?? 0, limit: args.limit ?? 100,
    }),

    pw_reply_to_question: async (token, args, ctx) => engine.replyToQuestion({
      token, jobId: requireArg(args, 'workbench_job_id'), body: args, idempotencyKey: ctx.idempotencyKey,
    }),

    pw_approve_stage: async (token, args, ctx) => engine.approveStage({
      token, jobId: requireArg(args, 'workbench_job_id'), body: args, idempotencyKey: ctx.idempotencyKey,
    }),

    pw_request_revision: async (token, args) => engine.requestRevision({
      token, jobId: requireArg(args, 'workbench_job_id'), body: args,
    }),

    pw_request_review: async (token, args) => engine.requestReview({
      token, jobId: requireArg(args, 'workbench_job_id'), body: args,
    }),

    pw_cancel_job: async (token, args) => engine.cancelJob({
      token, jobId: requireArg(args, 'workbench_job_id'), body: args,
    }),

    pw_get_result: async (token, args) => engine.getResult(token, requireArg(args, 'workbench_job_id')),

    pw_get_artifact_metadata: async (token, args) => engine.getArtifactMetadata(token, requireArg(args, 'artifact_id')),

    pw_get_artifact_excerpt: async (token, args) => engine.getArtifactExcerpt(
      token, validate(ARTIFACT_EXCERPT_SCHEMA, {
        artifact_id: requireArg(args, 'artifact_id'),
        byte_offset: args.byte_offset ?? 0,
        max_bytes: args.max_bytes ?? 8_192,
      }),
    ),

    pw_get_questions: async (token, args) => engine.getQuestions(token, requireArg(args, 'workbench_job_id')),
    pw_get_approvals: async (token, args) => engine.getApprovals(token, requireArg(args, 'workbench_job_id')),
    pw_get_checks: async (token, args) => engine.getChecks(token, requireArg(args, 'workbench_job_id')),
    pw_get_reviews: async (token, args) => engine.getReviews(token, requireArg(args, 'workbench_job_id')),

    pw_publish: async (token, args, ctx) => {
      const request = validate(PUBLICATION_REQUEST_SCHEMA, args);
      return engine.publish({
        token, jobId: request.job_id, request, idempotencyKey: ctx.idempotencyKey,
        correlationId: ctx.correlationId,
      });
    },
  };

  return async function dispatch(name, token, args, ctx) {
    // Membership is checked against the allowlist, not merely against the handler map: a handler
    // added without an allowlist entry must not become callable.
    if (!ALLOWED_TOOLS.includes(name) || !Object.hasOwn(handlers, name)) {
      throw new ApiError(ErrorCode.NOT_FOUND, `no such tool: ${String(name).slice(0, 64)}`);
    }
    return handlers[name](token, args ?? {}, ctx ?? {});
  };
}

/**
 * A JSON-RPC handler implementing the MCP methods this adapter supports.
 *
 * Note the capability declaration: `tools` only. `sampling` is absent, so a client has nothing to
 * honour even if this server were compromised into asking.
 */
export function createMcpHandler({ dispatch, token, serverName = 'project-workbench-orchestrator', serverVersion = '1.0' }) {
  return async function handle(message) {
    const { id = null, method, params = {} } = message ?? {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, err) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: err.message ?? 'the request was refused', data: errorEnvelope(err) },
    });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: MCP_PROTOCOL_VERSION,
            // Tools only. Declaring `sampling` would let this server ask its client to run
            // inference on its behalf, inverting the control direction the product depends on.
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: serverVersion },
          });

        case 'notifications/initialized':
          return null;

        case 'tools/list':
          return reply({ tools: TOOL_DEFINITIONS });

        case 'tools/call': {
          const result = await dispatch(params.name, token, params.arguments, {
            correlationId: params._meta?.correlationId ?? null,
            idempotencyKey: params.arguments?.idempotency_key ?? params._meta?.idempotencyKey ?? null,
          });
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }],
            isError: false,
          });
        }

        // Resources and prompts are deliberately not offered: a resource surface would be a second
        // way to name remote content, and the artifact id is meant to be the only one.
        case 'resources/list':
          return reply({ resources: [] });
        case 'prompts/list':
          return reply({ prompts: [] });

        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
      }
    } catch (err) {
      if (err instanceof ApiError) return fail(-32000, err);
      // An unexpected exception is reported as a fixed internal error: its message routinely
      // carries paths and occasionally secrets.
      return {
        jsonrpc: '2.0', id,
        error: { code: -32603, message: 'an internal error occurred', data: errorEnvelope(err) },
      };
    }
  };
}
