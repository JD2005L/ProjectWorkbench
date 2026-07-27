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

import {
  SCHEMA_VERSION, ATTESTATION_CONTRACT_VERSION, PATTERNS, ErrorCode, newId,
} from './contract.js';
import { ApiError, notFound, sendError, payloadTooLarge } from './errors.js';
import {
  SCOPES, ServiceTokenStore, RateLimiter, authenticateRequest, requireScope,
  assertInstanceMatches, assertProjectGranted,
} from './auth.js';
import {
  ProjectConfigStore, resolveProject, projectPayload, capabilitiesPayload, listGrantedProjects,
} from './projects.js';
import { validate } from './validate.js';
import { buildFingerprintReport } from './bootstrap.js';
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

  /**
   * Component readiness.
   *
   * Additive to the contract: `InstanceHealth` forbids extra fields, so component detail cannot be
   * folded into /health without breaking validation on the other side. Degraded — not down — when
   * the backend is signed out, because every mutation will then fail closed and an operator needs
   * to know that before submitting work rather than after.
   */
  router.get('/readiness', handle(async (req, res) => {
    const auth = await backend.probeAuth();
    const components = [
      {
        component: 'store',
        // A store that cannot be written to is the one failure that loses evidence.
        state: store && !store._closed ? 'ok' : 'down',
        detail: store && !store._closed ? null : 'the durable store is not open',
      },
      {
        component: 'queue',
        state: 'ok',
        detail: engine ? `${engine._running.size} job(s) in flight` : 'the engine is not mounted',
      },
      { component: 'runner', state: auth.state, detail: auth.detail ?? null },
    ];

    // Attestation capability, published so an orchestrator can see what kind of evidence this
    // instance can produce BEFORE it submits work — including which settings it can only enforce
    // rather than observe.
    let attestation = null;
    if (typeof backend.fingerprint === 'function') {
      const fingerprint = await backend.fingerprint();
      attestation = {
        schema_version: SCHEMA_VERSION,
        contract_version: ATTESTATION_CONTRACT_VERSION,
        model: 'runtime_reported',
        // Effort is enforceable only when the fingerprinted binary declares the option.
        // Declared is not enough: enforcement also needs the VALUE list, because a value the
        // binary does not list can never be enforced. Claiming otherwise here would advertise a
        // capability every verification then refuses.
        effort: fingerprint.ok && Array.isArray(fingerprint.capabilities?.['--effort']?.values)
          ? 'launch_enforced'
          : 'unavailable',
        binary: fingerprint.ok
          ? {
            realpath: fingerprint.realpath,
            version: fingerprint.version,
            sha256: fingerprint.sha256,
            declared_effort_values: fingerprint.capabilities?.['--effort']?.values ?? null,
          }
          : { failure: fingerprint.failure, detail: fingerprint.detail ?? null },
      };
      components.push({
        component: 'attestation',
        state: attestation.effort === 'unavailable' ? 'degraded' : 'ok',
        detail: attestation.effort === 'unavailable'
          ? 'effective effort cannot be attested against the configured coding CLI'
          : 'effective effort is enforced at launch, not observed at runtime',
      });
    }
    const worst = components.some((c) => c.state === 'down')
      ? 'down'
      : (components.some((c) => c.state === 'degraded') ? 'degraded' : 'ok');
    res.json({
      schema_version: SCHEMA_VERSION,
      state: worst,
      service: 'project-workbench',
      version: workbenchVersion ?? 'unknown',
      instance_id: config.instanceId,
      checked_at: new Date().toISOString(),
      // No secret, no account address, no org id, no token — probeAuth already strips those.
      components: components.map((c) => ({ schema_version: SCHEMA_VERSION, ...c })),
      schema_versions_supported: ['1.0'],
      attestation,
    });
  }));

  /**
   * The capability fingerprint an administrator must pin for this instance.
   *
   * Read-only, and the counterpart to `scripts/pw-orch-fingerprint.mjs` — same report, same
   * function, so the two cannot disagree about the value being pinned. The endpoint exists for the
   * case where the administrator is not on this host; the script exists for the case where the
   * instance has no credential yet, which is the usual one at registration time.
   *
   * It publishes no secret: the report is assembled from a fixed allowlist in `bootstrap.js`, and
   * everything in it is a property of an admin-owned binary an operator could read themselves.
   */
  router.get('/instance/attestation-fingerprint', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    if (typeof backend.fingerprint !== 'function') {
      throw new ApiError(ErrorCode.WORKBENCH_UNAVAILABLE, 'this backend does not fingerprint its coding CLI');
    }
    const report = buildFingerprintReport({
      instanceId: config.instanceId,
      fingerprint: await backend.fingerprint(),
    });
    auditEvent(req, 'orchestrator.instance.fingerprint', {
      attestable: report.attestable,
      capability_fingerprint: report.capability_fingerprint,
    });
    res.json(report);
  }));

  // §4 declares the response model as `list[Project]`, so this is a bare array rather than an
  // envelope. An envelope would be friendlier to paginate later, but the contract is normative.
  router.get('/projects', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(listGrantedProjects(config, projectStore, req.token));
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
      // What the answer must bind to. The peer sends these so the attestation is stamped with the
      // run and configuration generation being asked about, which is what stops a good answer from
      // one run being replayed onto another after the binary, model or policy has drifted.
      run_id: { type: 'identifier', default: 'unbound' },
      config_generation: { type: 'int', min: 0, default: 0 },
      // The attestation contract the orchestrator speaks. A peer that asks for one this build
      // cannot meet is told so, rather than answered in a shape that implies checks never made.
      attestation_contract_version: { type: 'shortText', default: ATTESTATION_CONTRACT_VERSION },
      // Fresh for every verification. Derived from the job and phase alone, the binding repeated on
      // every retry, so an attestation captured on the first attempt stayed valid on the fifth —
      // including after the lane had been relaunched with different flags.
      //
      // Required, with no default. The contract dropped its own default for the same reason: every
      // other security-relevant default on this surface refuses, and a fixed, publicly-known nonce
      // would be the one that does not. A peer that omitted the field used to get a well-formed
      // answer whose binding was worthless.
      // A dedicated type, not `shortText` with bounds the validator silently ignored: the envelope
      // constrains the nonce to `^[A-Za-z0-9_-]+$` and 16..128 characters, and this service echoes
      // whatever the caller sent. A value it cannot legally echo is refused here.
      verification_nonce: { type: 'verificationNonce', required: true },
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
      observed_model: result.observed_model ?? null,
    });
    // `SessionVerificationResponse` at 1.0 forbids extra fields, so the ProjectWorkbench-side
    // extras are stripped rather than leaked — the engine and the audit log still need them. A 1.1
    // caller additionally receives `provenance` and the enforcement evidence, which is the whole
    // point of the version: it can tell an observation from an enforcement.
    // `SessionVerificationResponse` now carries the attestation and DERIVES `effective` from it.
    // Sending `effective` as a field is refused on the other side — deliberately, because an older
    // peer never distinguished a value it watched from one it merely passed on the command line.
    const {
      observed_model: _observed, requirement: _requirement, cli_session_id: _cli,
      provenance: _provenance, settings_attestation: settingsAttestation,
      effective: _effective, ...rest
    } = result;
    const wire = { ...rest, attestation: settingsAttestation ?? null };
    if (result.requirement) {
      // The operator-facing reason every job is blocking, where an operator will actually see it.
      // eslint-disable-next-line no-console
      console.warn('[orchestrator] effort attestation unavailable:', result.requirement);
    }
    res.json(wire);
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

  /**
   * Parse a bounded integer query parameter.
   *
   * `Number(x) || default` silently turns a malformed cursor into 0, which would replay a job's
   * whole timeline instead of reporting that the caller sent nonsense.
   */
  const intParam = (raw, { name, fallback, min, max }) => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, `the '${name}' parameter is out of range`, {
        fieldErrors: [{ field: name, message: `must be an integer between ${min} and ${max}` }],
      });
    }
    return value;
  };

  router.get('/jobs/:id/events', handle(async (req, res) => {
    requireScope(req.token, SCOPES.JOBS_READ);
    res.json(requireEngine().getEvents(req.token, req.params.id, {
      afterSequence: intParam(req.query.after_sequence, { name: 'after_sequence', fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
      limit: intParam(req.query.limit, { name: 'limit', fallback: 100, min: 1, max: config.maxEventsPerPage }),
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
    // Not jobs:write — recording a human decision is a distinct authority.
    requireScope(req.token, SCOPES.APPROVE);
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
