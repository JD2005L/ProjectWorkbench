// The orchestration HTTP surface, mounted at `/api/orchestrator/v1`.
//
// This router owns the request envelope — authentication, scoping, correlation, limits, idempotency
// and the error contract — and delegates every decision about *state* to the engine. Keeping the
// two apart is what lets the MCP adapter reuse the same operations without going through HTTP, and
// what keeps the authorization checks in one auditable place rather than scattered across handlers.
//
// The surface is closed by construction: there is no route taking a filesystem path, no route
// taking a command, and no generic passthrough. The only way to name remote content is an opaque
// `artifact_id` this instance issued.

import express from 'express';

import { SCHEMA_VERSION, PATTERNS, ErrorCode, newId } from './contract.js';
import { ApiError, notFound, sendError, payloadTooLarge } from './errors.js';
import {
  SCOPES, ServiceTokenStore, RateLimiter, authenticateRequest, requireScope,
  assertInstanceMatches, assertProjectGranted,
} from './auth.js';
import {
  ProjectConfigStore, resolveProject, projectPayload, capabilitiesPayload, listGrantedProjects,
} from './projects.js';
import { validate } from './validate.js';
import {
  ENSURE_SESSION_SCHEMA, MODEL_SETTINGS_SCHEMA, ARTIFACT_EXCERPT_SCHEMA, PUBLICATION_REQUEST_SCHEMA,
} from './schemas.js';

/** Requests that mutate must carry an idempotency key: the relay may retry, and a retry must not
 *  produce a second side effect. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function correlationIdFrom(req) {
  const raw = req.get('x-correlation-id');
  // A correlation id is echoed back to the caller and written to the audit log, so an id that is
  // not an identifier is replaced rather than reflected.
  if (raw && raw.length <= 128 && PATTERNS.identifier.test(raw)) return raw;
  return newId('corr');
}

/**
 * Build the orchestration router.
 *
 * Dependencies are injected rather than imported so the same router can be driven against a
 * deterministic backend and a temporary store, which is what keeps the test suite away from live
 * projects, live tmux, and the operator's OAuth session.
 */
export function createOrchestratorRouter({
  config, store, repo, backend, engine = null, sessionManager = null, workbenchVersion = null, audit = null,
}) {
  const router = express.Router();
  const tokenStore = new ServiceTokenStore(config.tokensPath);
  const projectStore = new ProjectConfigStore(config.projectsPath);
  const limiter = new RateLimiter(config.rateLimitPerMinute);

  // -- envelope: correlation id ---------------------------------------------
  router.use((req, res, next) => {
    req.correlationId = correlationIdFrom(req);
    res.set('X-Correlation-Id', req.correlationId);
    next();
  });

  // -- envelope: authentication and rate limiting ---------------------------
  router.use((req, res, next) => {
    try {
      req.token = authenticateRequest(req, tokenStore);
      limiter.check(req.token.token_id);
      next();
    } catch (err) {
      sendError(res, err, req.correlationId);
    }
  });

  // -- envelope: bounded body parsing ---------------------------------------
  // The limit is enforced before the body is materialised, so an oversized payload is refused
  // rather than buffered.
  router.use(express.json({ limit: config.maxBodyBytes, strict: true }));
  router.use((err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return sendError(res, payloadTooLarge(), req.correlationId);
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return sendError(res, new ApiError(ErrorCode.VALIDATION_FAILED, 'the request body is not valid JSON'), req.correlationId);
    }
    return sendError(res, err, req.correlationId);
  });

  // -- envelope: idempotency key on mutations -------------------------------
  router.use((req, res, next) => {
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) return next();
    const key = req.get('idempotency-key');
    if (!key || !PATTERNS.identifier.test(key) || key.length > 128) {
      return sendError(res, new ApiError(ErrorCode.VALIDATION_FAILED, 'a valid Idempotency-Key header is required on mutations', {
        fieldErrors: [{ field: 'Idempotency-Key', message: 'required, and must be an identifier' }],
      }), req.correlationId);
    }
    req.idempotencyKey = key;
    return next();
  });

  /** Wrap a handler so every thrown failure becomes the contract envelope. */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        // An unexpected exception is logged where an operator can see it and reported to the caller
        // as a bare internal error: the message routinely carries paths and, occasionally, secrets.
        // eslint-disable-next-line no-console
        console.error('[orchestrator] unhandled error', { correlationId: req.correlationId, message: err?.message });
      }
      sendError(res, err, req.correlationId);
    }
  };

  const requireEngine = () => {
    if (!engine) {
      throw new ApiError(ErrorCode.WORKBENCH_UNAVAILABLE, 'the orchestration engine is not available on this instance');
    }
    return engine;
  };

  const requireSessions = () => {
    if (!sessionManager) {
      throw new ApiError(ErrorCode.WORKBENCH_UNAVAILABLE, 'session management is not available on this instance');
    }
    return sessionManager;
  };

  const auditEvent = (req, event, detail) => {
    if (!audit) return;
    audit(event, {
      token_id: req.token?.token_id ?? null,
      orchestrator_instance_id: req.token?.orchestrator_instance_id ?? null,
      correlation_id: req.correlationId,
      ...detail,
    });
  };

  // -------------------------------------------------------------------------
  // discovery
  // -------------------------------------------------------------------------

  router.get('/health', handle(async (req, res) => {
    const backends = [await backend.probeAuth()];
    res.json({
      schema_version: SCHEMA_VERSION,
      instance_id: config.instanceId,
      contract_version: '1.0',
      reachable: true,
      workbench_version: workbenchVersion,
      backends,
      checked_at: new Date().toISOString(),
    });
  }));

  router.get('/projects', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json({
      schema_version: SCHEMA_VERSION,
      projects: listGrantedProjects(config, projectStore, req.token),
    });
  }));

  router.get('/projects/:project/capabilities', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    const project = resolveProject(config, projectStore, req.token, req.params.project);
    res.json(capabilitiesPayload(config, project));
  }));

  // -------------------------------------------------------------------------
  // the named orchestrator lane
  // -------------------------------------------------------------------------

  const VERIFY_SESSION_SCHEMA = {
    name: 'VerifySessionRequest',
    fields: {
      session_key: { type: 'identifier', required: true },
      phase_class: {
        type: 'enum',
        values: ['discovery', 'planning', 'implementation', 'mechanical_correction', 'high_risk_design', 'routine_review', 'high_risk_review'],
        required: true,
      },
      requested: { type: 'object', schema: MODEL_SETTINGS_SCHEMA, required: true },
    },
  };

  router.post('/projects/:project/session/ensure', handle(async (req, res) => {
    requireScope(req.token, SCOPES.SESSION_MANAGE);
    const body = validate(ENSURE_SESSION_SCHEMA, req.body ?? {});
    assertInstanceMatches(req.token, body.orchestrator_instance_id);
    assertProjectGranted(req.token, req.params.project);
    if (body.project_id !== req.params.project) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path project and the payload project must agree', {
        fieldErrors: [{ field: 'project_id', message: 'must match the path' }],
      });
    }
    const project = resolveProject(config, projectStore, req.token, req.params.project);
    const session = await requireSessions().ensureSession({
      token: req.token, project, request: body, correlationId: req.correlationId,
      idempotencyKey: req.idempotencyKey,
    });
    auditEvent(req, 'orchestrator.session.ensure', { project_id: project.project_id, session_key: session.session_key });
    res.json(session);
  }));

  router.post('/projects/:project/session/verify', handle(async (req, res) => {
    requireScope(req.token, SCOPES.SESSION_MANAGE);
    const body = validate(VERIFY_SESSION_SCHEMA, req.body ?? {});
    assertProjectGranted(req.token, req.params.project);
    const project = resolveProject(config, projectStore, req.token, req.params.project);
    const result = await requireSessions().verifySession({
      token: req.token, project, request: body, correlationId: req.correlationId,
    });
    auditEvent(req, 'orchestrator.session.verify', {
      project_id: project.project_id,
      session_key: body.session_key,
      verified: result.effective !== null,
    });
    res.json(result);
  }));

  // -------------------------------------------------------------------------
  // jobs
  // -------------------------------------------------------------------------

  router.post('/jobs', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    const accepted = await requireEngine().submitJob({
      token: req.token, body: req.body ?? {}, idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
    });
    auditEvent(req, 'orchestrator.job.submit', {
      workbench_job_id: accepted.workbench_job_id, deduplicated: accepted.deduplicated,
    });
    // A deduplicated submission is 200: it returns the original outcome and created nothing.
    res.status(accepted.deduplicated ? 200 : 201).json(accepted);
  }));

  router.get('/jobs', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().listJobs(req.token, {
      projectId: req.query.project ? String(req.query.project) : null,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    }));
  }));

  router.get('/jobs/:id', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getJob(req.token, req.params.id));
  }));

  router.get('/jobs/:id/events', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getEvents(req.token, req.params.id, {
      afterSequence: Number(req.query.after_sequence) || 0,
      limit: Number(req.query.limit) || 100,
    }));
  }));

  /**
   * The same timeline as Server-Sent Events.
   *
   * The cursor is the durable per-job sequence, so a dropped connection resumes exactly where it
   * stopped rather than replaying or skipping.
   */
  router.get('/jobs/:id/events/stream', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    const engine_ = requireEngine();
    let cursor = Number(req.query.after_sequence) || 0;
    engine_.getJob(req.token, req.params.id); // authorises before any stream is opened

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Correlation-Id': req.correlationId,
    });

    const pump = () => {
      let batch;
      try {
        batch = engine_.getEvents(req.token, req.params.id, { afterSequence: cursor, limit: 50 });
      } catch {
        res.end();
        return;
      }
      for (const event of batch.events) {
        cursor = event.sequence;
        res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    pump();
    const timer = setInterval(pump, 1_000);
    // A comment frame keeps intermediaries from closing an idle stream, and carries no data.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => { clearInterval(timer); clearInterval(keepAlive); });
  }));

  router.get('/jobs/:id/result', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getResult(req.token, req.params.id));
  }));

  // -- the Milestone 2 record retrievals (contract §9.1-§9.3) ---------------

  router.get('/jobs/:id/questions', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getQuestions(req.token, req.params.id));
  }));

  router.get('/jobs/:id/approvals', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getApprovals(req.token, req.params.id));
  }));

  router.get('/jobs/:id/checks', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getChecks(req.token, req.params.id));
  }));

  router.get('/jobs/:id/reviews', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getReviews(req.token, req.params.id));
  }));

  // -- mutations ------------------------------------------------------------

  router.post('/jobs/:id/reply', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    res.json(await requireEngine().replyToQuestion({
      token: req.token, jobId: req.params.id, body: req.body ?? {}, idempotencyKey: req.idempotencyKey,
    }));
  }));

  router.post('/jobs/:id/approve', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    res.json(await requireEngine().approveStage({
      token: req.token, jobId: req.params.id, body: req.body ?? {}, idempotencyKey: req.idempotencyKey,
    }));
  }));

  router.post('/jobs/:id/revise', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    res.json(await requireEngine().requestRevision({ token: req.token, jobId: req.params.id, body: req.body ?? {} }));
  }));

  router.post('/jobs/:id/review', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    res.json(await requireEngine().requestReview({ token: req.token, jobId: req.params.id, body: req.body ?? {} }));
  }));

  router.post('/jobs/:id/cancel', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    const state = await requireEngine().cancelJob({ token: req.token, jobId: req.params.id, body: req.body ?? {} });
    auditEvent(req, 'orchestrator.job.cancel', { workbench_job_id: req.params.id });
    res.json(state);
  }));

  /** Lease heartbeat (contract §9.5): liveness, carrying no evidence and claiming no progress. */
  router.post('/jobs/:id/heartbeat', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_WRITE);
    res.json(await requireEngine().heartbeat({ token: req.token, jobId: req.params.id, body: req.body ?? {} }));
  }));

  /** Publication (contract §9.4): separate from implementation, and approval-gated. */
  router.post('/jobs/:id/publish', handle(async (req, res) => {
    requireScope(req.token, SCOPES.PUBLISH);
    const body = validate(PUBLICATION_REQUEST_SCHEMA, req.body ?? {});
    if (body.job_id !== req.params.id) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }
    const record = await requireEngine().publish({
      token: req.token, jobId: req.params.id, request: body, idempotencyKey: req.idempotencyKey,
      correlationId: req.correlationId,
    });
    auditEvent(req, 'orchestrator.publication', {
      workbench_job_id: req.params.id, publication_id: record.publication_id,
      remote_sha_verified: record.remote_sha_verified,
    });
    res.json(record);
  }));

  // -------------------------------------------------------------------------
  // artifacts
  // -------------------------------------------------------------------------

  router.get('/artifacts/:id/metadata', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(await requireEngine().getArtifactMetadata(req.token, req.params.id));
  }));

  router.get('/artifacts/:id/excerpt', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    const request = validate(ARTIFACT_EXCERPT_SCHEMA, {
      artifact_id: req.params.id,
      byte_offset: Number(req.query.byte_offset) || 0,
      max_bytes: Number(req.query.max_bytes) || 8_192,
    });
    res.json(await requireEngine().getArtifactExcerpt(req.token, request));
  }));

  // -------------------------------------------------------------------------
  // fallthrough
  // -------------------------------------------------------------------------

  router.use((req, res) => {
    sendError(res, notFound('no such operation'), req.correlationId);
  });

  // Express's four-argument signature is what marks this as the error handler.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (!(err instanceof ApiError)) {
      // eslint-disable-next-line no-console
      console.error('[orchestrator] unhandled router error', { correlationId: req.correlationId, message: err?.message });
    }
    sendError(res, err, req.correlationId);
  });

  return router;
}
