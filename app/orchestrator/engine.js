// The job engine: submission, the phase pipeline, evidence, human interaction, and cancellation.
//
// Three ideas run through the whole file.
//
//   1. **Nothing is a success unless something other than the agent says so.** A phase returns the
//      model's account of what it did. What the orchestrator receives is exit codes, diff stats and
//      git facts. A max-turn exit, a timeout, and an unparseable result are failures — the states
//      exist precisely so they cannot be rounded up to "done".
//
//   2. **A blocked job is not a failed job.** Work is preserved, the lease is released, and the job
//      can be resumed once the condition clears. That is why `blocked_configuration` is reached
//      *before* any file is read: a job that cannot prove its model and effort must not have touched
//      the repository at all.
//
//   3. **Cancellation preserves the working tree.** No reset, no stash, no clean. This is structural
//      rather than intentional: every git call goes through the allowlist in git.js, where the
//      destructive subcommands are unreachable.

import crypto from 'crypto';

import {
  SCHEMA_VERSION, JobStatus, EventType, ActorKind, PhaseClass, CheckOutcome, ReviewVerdict,
  QuestionStatus, ApprovalStatus, ApprovalType, DecisionScope, TimeoutAction, ArtifactKind,
  ErrorCode, WORKSPACE_ACTIVE_STATES, TERMINAL_STATES, TEXT_LIMITS, newId,
} from './contract.js';
import { ApiError, notFound } from './errors.js';
import { redactText } from './redact.js';
import { assertTransition, canTransition } from './statemachine.js';
import { validate } from './validate.js';
import { KIND } from './store/repo.js';
import { SCOPES } from './auth.js';
import { attestModel } from './attestation.js';
import { resolveWorkspacePath } from './projects.js';
import { repositoryBaseline, workingTreeFingerprint, workingTreePreserved } from './git.js';
import { diffStat, canonicaliseCheckName, CHECK_CATALOGUE } from './checks.js';
import {
  SUBMIT_JOB_SCHEMA, REPLY_SCHEMA, APPROVE_SCHEMA, REVISE_SCHEMA, REVIEW_SCHEMA, CANCEL_SCHEMA,
  HEARTBEAT_SCHEMA,
} from './schemas.js';
import { Publisher, assertPublicationApproved } from './publish.js';

/** How long an unanswered question or undecided approval stays open before it expires. */
const DEFAULT_INTERACTION_TTL_MS = 24 * 60 * 60 * 1_000;

function hashContent(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class OrchestrationEngine {
  constructor({
    config, store, repo, backend, sessionManager, artifacts, checkRunner, projectStore,
    clock = () => new Date(), audit = null, exec = undefined,
  }) {
    this.config = config;
    this.store = store;
    this.repo = repo;
    this.backend = backend;
    this.sessionManager = sessionManager;
    this.artifacts = artifacts;
    this.checkRunner = checkRunner;
    this.projectStore = projectStore;
    this.clock = clock;
    this.audit = audit;
    this.exec = exec;
    this.publisher = new Publisher({ config, exec, clock });

    /** In-flight job workers, so tests and shutdown can wait for quiescence. */
    this._running = new Map();
    /** Jobs asked to stop. Checked between phases, and used to abort the phase in flight. */
    this._cancelRequested = new Set();
    /** One abort controller per running job, so a cancel reaches the child process. */
    this._aborts = new Map();
    /** Jobs whose cancellation could not confirm all descendants are dead. */
    this._terminationUnconfirmed = new Set();
  }

  now() { return this.clock().toISOString(); }

  actor() { return { kind: ActorKind.WORKBENCH, identifier: this.config.instanceId }; }

  /** Wait for every in-flight job worker. Used by tests and by graceful shutdown. */
  async drain() {
    while (this._running.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([...this._running.values()].map((entry) => entry.promise));
    }
  }

  // -------------------------------------------------------------------------
  // authorization helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a job this credential is entitled to see.
   *
   * A job belonging to another orchestrator instance is reported as `not_found`, not as forbidden.
   * Distinguishing the two would confirm the job exists, which is the classic IDOR disclosure.
   */
  requireJob(token, jobId) {
    const job = this.repo.getJob(jobId);
    if (!job) throw notFound('no such job');
    if (job.orchestrator_instance_id !== token.orchestrator_instance_id) throw notFound('no such job');
    if (!token.projects.includes(job.project_id)) throw notFound('no such job');
    return job;
  }

  _resolveProjectOrThrow(projectId) {
    const project = this.projectStore.load().get(projectId);
    if (!project) throw notFound('no such project on this workbench instance');
    return project;
  }

  _auditEvent(event, detail) {
    if (this.audit) this.audit(event, detail);
  }

  // -------------------------------------------------------------------------
  // submission
  // -------------------------------------------------------------------------

  /**
   * Accept a task contract.
   *
   * Order is load-bearing: validate, then check the fencing token, then check idempotency, then
   * create. Checking the fence first means a stale orchestrator cannot even register an idempotency
   * key, and checking idempotency before creation means a retry returns the original handle rather
   * than a second job.
   */
  async submitJob({ token, body, idempotencyKey, correlationId }) {
    const request = validate(SUBMIT_JOB_SCHEMA, body ?? {});

    // The contract puts the key in the body (§7); HTTP also carries it as a header, and MCP has no
    // header at all. Two sources that can disagree is one source too many — a retry with the same
    // body but a fresh header would create a duplicate job.
    if (idempotencyKey && request.idempotency_key !== idempotencyKey) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the idempotency key in the body and the transport disagree', {
        fieldErrors: [{ field: 'idempotency_key', message: 'must match the Idempotency-Key header' }],
      });
    }

    if (request.orchestrator_instance_id !== token.orchestrator_instance_id) {
      throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, 'the payload claims a different orchestrator instance than this credential');
    }
    if (!token.projects.includes(request.project_id)) {
      throw new ApiError(ErrorCode.PROJECT_NOT_AUTHORIZED, 'this project is not owned by this workbench instance');
    }
    const project = this._resolveProjectOrThrow(request.project_id);

    for (const name of request.task.required_checks) canonicaliseCheckName(name);

    const contentHash = hashContent(request);
    const scope = `submit:${token.orchestrator_instance_id}`;
    const jobId = newId('pwjob');
    const acceptedAt = this.now();

    // The idempotency check and the record it guards must be in ONE transaction. Reading first and
    // writing later leaves a window in which two concurrent requests carrying the same key both see
    // a miss and both create a job — which is exactly the retry the contract anticipates.
    const handle = await this.store.transact((tx, state) => {
      const existing = state.get(KIND.IDEMPOTENCY, `${scope}:${idempotencyKey}`);
      if (existing) {
        if (existing.content_hash !== contentHash) {
          throw new ApiError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'the idempotency key was reused with different content');
        }
        // A repeat returns the original outcome and produces no second side effect.
        return { ...existing.outcome, deduplicated: true };
      }

      // A submission carrying a token lower than one already accepted for this project is a
      // revived orchestrator writing after its lease was taken over.
      this.repo.acceptOrchestratorFencing(tx, state, {
        projectId: request.project_id, token: request.fencing_token,
      });

      const job = {
        schema_version: SCHEMA_VERSION,
        workbench_job_id: jobId,
        orchestrator_job_id: request.orchestrator_job_id,
        orchestrator_instance_id: request.orchestrator_instance_id,
        workbench_instance_id: this.config.instanceId,
        project_id: request.project_id,
        session_key: request.session_key,
        task: request.task,
        requested: request.requested,
        effective: null,
        max_phase_turns: request.max_phase_turns,
        max_revision_cycles: request.max_revision_cycles,
        revision_cycles_used: 0,
        fencing_token: request.fencing_token,
        status: JobStatus.RECEIVED,
        phase: null,
        detail: null,
        submitted_at: acceptedAt,
        updated_at: acceptedAt,
        ended_at: null,
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
        // Kept so an approval can be refused when it comes from the same credential.
        submitted_by_token: token.token_id ?? null,
        lease_fencing_token: null,
        baseline: null,
        publication_id: null,
        review_id: null,
        cli_session_id: null,
      };
      this.repo.putJob(tx, job);
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.JOB_SUBMITTED, status: JobStatus.RECEIVED,
        actor: this.actor(), message: `accepted task: ${request.task.title}`,
        correlation_id: correlationId,
      });

      const outcome = {
        schema_version: SCHEMA_VERSION,
        workbench_job_id: jobId,
        orchestrator_job_id: request.orchestrator_job_id,
        accepted_at: acceptedAt,
        deduplicated: false,
      };
      this.repo.recordIdempotency(tx, scope, idempotencyKey, contentHash, outcome);
      return outcome;
    });

    // A deduplicated submission must not start a second worker for the original job.
    if (handle.deduplicated) return handle;

    this._auditEvent('orchestrator.job.accepted', { workbench_job_id: jobId, project_id: request.project_id });
    this._startWorker(jobId, project);
    return handle;
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  getJob(token, jobId) {
    return this._jobState(this.requireJob(token, jobId));
  }

  _jobState(job) {
    return {
      schema_version: SCHEMA_VERSION,
      workbench_job_id: job.workbench_job_id,
      orchestrator_job_id: job.orchestrator_job_id,
      status: job.status,
      phase: job.phase,
      effective: job.effective,
      updated_at: job.updated_at,
      detail: job.detail,
    };
  }

  listJobs(token, { projectId = null, limit = 50, offset = 0 } = {}) {
    const jobs = this.repo
      .listJobs((j) => j.orchestrator_instance_id === token.orchestrator_instance_id
        && token.projects.includes(j.project_id)
        && (!projectId || j.project_id === projectId))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
    return {
      schema_version: SCHEMA_VERSION,
      jobs: jobs.slice(offset, offset + Math.min(limit, 200)).map((j) => this._jobState(j)),
      total: jobs.length,
    };
  }

  getEvents(token, jobId, { afterSequence = 0, limit = 100 } = {}) {
    const job = this.requireJob(token, jobId);
    const bounded = Math.min(Math.max(1, limit), this.config.maxEventsPerPage);
    return {
      schema_version: SCHEMA_VERSION,
      workbench_job_id: job.workbench_job_id,
      events: this.repo.listEvents(jobId, { afterSequence, limit: bounded })
        .map((e) => this._publicEvent(e)),
      latest_sequence: this.repo.latestSequence(jobId),
    };
  }

  /** `counts_as_progress` is ProjectWorkbench bookkeeping, not part of the wire contract. */
  _publicEvent(event) {
    const { counts_as_progress: _ignored, ...rest } = event;
    return rest;
  }

  /**
   * Project a stored question to the exact `Question` contract shape.
   *
   * The stored record carries bookkeeping the contract does not model — an expiry, the answer, when
   * it was answered. The contract models use `extra="forbid"`, so returning the raw record fails
   * validation on the other side. Everything that leaves this service is projected deliberately.
   */
  _publicQuestion(record) {
    return {
      schema_version: SCHEMA_VERSION,
      question_id: record.question_id,
      job_id: record.job_id,
      workbench_question_id: record.question_id,
      question: record.question,
      options: record.options,
      blocking: record.blocking,
      decision_scope: record.decision_scope,
      default_action_on_timeout: record.default_action_on_timeout,
      status: record.status,
      asked_at: record.asked_at,
      phase: record.phase,
    };
  }

  /** Project a stored approval to the exact `Approval` contract shape. */
  _publicApproval(record) {
    return {
      schema_version: SCHEMA_VERSION,
      approval_id: record.approval_id,
      job_id: record.job_id,
      approval_type: record.approval_type,
      requested_action: record.requested_action,
      evidence_summary: record.evidence_summary,
      artifact_ids: record.artifact_ids,
      status: record.status,
      requested_at: record.requested_at,
      decided_at: record.decided_at,
      // `Actor` carries no schema_version, and extra="forbid" would reject one.
      decided_by: record.decided_by
        ? { kind: record.decided_by.kind, identifier: record.decided_by.identifier }
        : null,
      decision_reason: record.decision_reason,
    };
  }

  getQuestions(token, jobId) {
    this.requireJob(token, jobId);
    return {
      schema_version: SCHEMA_VERSION,
      questions: this.repo.listForJob(KIND.QUESTIONS, jobId)
        .sort((a, b) => (a.asked_at < b.asked_at ? -1 : 1))
        .map((q) => this._publicQuestion(q)),
    };
  }

  getApprovals(token, jobId) {
    this.requireJob(token, jobId);
    return {
      schema_version: SCHEMA_VERSION,
      approvals: this.repo.listForJob(KIND.APPROVALS, jobId)
        .sort((a, b) => (a.requested_at < b.requested_at ? -1 : 1))
        .map((a) => this._publicApproval(a)),
    };
  }

  getChecks(token, jobId) {
    this.requireJob(token, jobId);
    return {
      schema_version: SCHEMA_VERSION,
      checks: this.repo.listForJob(KIND.CHECKS, jobId).sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1)),
    };
  }

  getReviews(token, jobId) {
    this.requireJob(token, jobId);
    return {
      schema_version: SCHEMA_VERSION,
      reviews: this.repo.listForJob(KIND.REVIEWS, jobId).sort((a, b) => (a.reviewed_at < b.reviewed_at ? -1 : 1)),
    };
  }

  getResult(token, jobId) {
    const job = this.requireJob(token, jobId);
    const publication = job.publication_id ? this.store.get(KIND.PUBLICATIONS, job.publication_id) : null;
    return {
      schema_version: SCHEMA_VERSION,
      job_id: job.workbench_job_id,
      status: job.status,
      project_id: job.project_id,
      workbench_instance_id: job.workbench_instance_id,
      summary: job.detail ?? `job ${job.status}`,
      checks: this.repo.listForJob(KIND.CHECKS, jobId).map((c) => c.check_id),
      review_id: job.review_id,
      publication,
      deployment: null,
      completed_at: job.ended_at,
    };
  }

  // -------------------------------------------------------------------------
  // state transitions
  // -------------------------------------------------------------------------

  /** Move a job, recording the transition and its timeline event in one atomic batch. */
  async _transition(jobId, nextStatus, { message, phase = null, detail = null, evidence = null, artifactIds = [], eventType = EventType.STATE_CHANGED, patch = {} }) {
    return this.store.transact((tx, state) => {
      const job = state.get(KIND.JOBS, jobId);
      if (!job) throw notFound('no such job');
      assertTransition(job.status, nextStatus);

      const updated = {
        ...job, ...patch,
        status: nextStatus,
        phase: phase ?? job.phase,
        // Every other free-text field is redacted; this one was not, and `_blockWith` puts raw
        // execFile failure text — `Command failed: <full argv>\n<stderr>` — straight into it.
        detail: detail === null || detail === undefined
          ? job.detail
          : redactText(String(detail), { maxLength: TEXT_LIMITS.shortText }),
        updated_at: this.now(),
        ended_at: TERMINAL_STATES.has(nextStatus) ? this.now() : job.ended_at,
      };
      this.repo.putJob(tx, updated);
      this.repo.appendEvent(tx, state, {
        job_id: jobId,
        event_type: eventType,
        status: nextStatus,
        previous_status: eventType === EventType.STATE_CHANGED ? job.status : null,
        phase: updated.phase,
        actor: this.actor(),
        message,
        evidence,
        artifact_ids: artifactIds,
        correlation_id: job.correlation_id,
      });
      return updated;
    });
  }

  /** Record an event without changing state. */
  async _emit(jobId, event) {
    return this.store.transact((tx, state) => {
      const job = state.get(KIND.JOBS, jobId);
      if (!job) throw notFound('no such job');
      return this.repo.appendEvent(tx, state, {
        job_id: jobId, status: job.status, phase: job.phase, actor: this.actor(),
        correlation_id: job.correlation_id, ...event,
      });
    });
  }

  // -------------------------------------------------------------------------
  // the phase pipeline
  // -------------------------------------------------------------------------

  /**
   * Start the single worker for a job.
   *
   * Two guards, both learned from a repro: a job that already has a worker must not get a second
   * one — two coding sessions would write the same workspace, and the project write lease does not
   * stop them because both would hold it under the same owner. And the `finally` must only evict
   * *its own* map entry, or a finishing worker deletes a newer worker's registration and `drain()`
   * returns while work is still in flight — which is what made the cancellation tree-preservation
   * comparison unsound.
   */
  _startWorker(jobId, project, options = {}) {
    if (this._running.has(jobId)) return this._running.get(jobId);

    this._aborts.set(jobId, new AbortController());
    const entry = {};
    entry.promise = this._run(jobId, project, options)
      .catch(async (err) => {
        // A worker must never die silently: an unexplained stall is worse than a recorded failure.
        await this._failSafely(jobId, `the job stopped unexpectedly (${err?.code ?? 'internal'})`, err?.terminationConfirmed);
      })
      .finally(() => {
        if (this._running.get(jobId) === entry) {
          this._running.delete(jobId);
          this._aborts.delete(jobId);
        }
      });
    this._running.set(jobId, entry);
    return entry.promise;
  }

  /**
   * Whether this job's termination must be treated as unconfirmed — an explicit verdict from the
   * IMMEDIATE error is not the only source of truth here. `_terminationUnconfirmed` (set the moment
   * ANY step observes a real `false`) and the job's own durably persisted `termination_confirmed`
   * field are both consulted as a backstop, so a LATER, unrelated exception — one that carries no
   * verdict of its own, because it has nothing to do with any kill (a full disk, a transaction race)
   * — can never downgrade an already-observed `false` back to "unknown" and release a project a live
   * descendant might still be writing to. Once `false` is observed anywhere in this job's lifecycle,
   * it is monotonic: nothing later may un-observe it.
   */
  _terminationIsUnconfirmed(jobId, explicitVerdict = null) {
    if (explicitVerdict === false) return true;
    if (this._terminationUnconfirmed.has(jobId)) return true;
    return this.repo.getJob(jobId)?.termination_confirmed === false;
  }

  /**
   * Record an unexpected worker death.
   *
   * Blocked, not failed. `failed` is terminal, and an internal error says nothing about whether the
   * work is salvageable — the repository is untouched and an operator may well be able to resume.
   * Spending the job's only remaining state on a bug in this service is the wrong trade.
   *
   * `terminationConfirmed` is accepted here for the same reason `_runPhase` checks it before
   * concluding a phase was merely cancelled: an internal error unrelated to any kill (a bug, a full
   * disk) is the overwhelming majority of what reaches this method, and for those, releasing is
   * correct — but `_runChecks`/`_runPublication` do not wrap every internal call in a try/catch of
   * their own, on the assumption that nothing on that path throws with a termination verdict
   * attached. If that assumption is ever wrong — a check runner or the publisher throwing directly
   * rather than returning a result, exactly as an unrelated bug could — `_terminationIsUnconfirmed`'s
   * backstop is what stands between that and silently releasing a project a live descendant might
   * still be writing to.
   */
  async _failSafely(jobId, message, terminationConfirmed = null) {
    try {
      const job = this.repo.getJob(jobId);
      if (!job || TERMINAL_STATES.has(job.status)) return;
      const unconfirmed = this._terminationIsUnconfirmed(jobId, terminationConfirmed);
      if (unconfirmed) {
        await this._fenceLease(jobId, message);
      } else {
        await this._releaseLease(jobId);
      }
      await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, {
        message, detail: message, eventType: EventType.BLOCKED,
        patch: unconfirmed ? { termination_confirmed: false } : {},
      });
    } catch {
      /* nothing further can be done safely */
    }
  }

  _cancelled(jobId) { return this._cancelRequested.has(jobId); }

  async _run(jobId, project, options = {}) {
    const workspacePath = resolveWorkspacePath(this.config, project);

    // Intake runs once, on a freshly received job. A resumed job is already past it — re-entering
    // at `validating` is not a legal edge from `queued`, and treating that as a worker crash sent
    // every resumed job to `failed`, which is terminal. A blocked job is not a failed job.
    const entry = this.repo.getJob(jobId);
    // A revision re-enters the pipeline directly: `revision_required -> implementing` is the only
    // legal edge out of that state, so it cannot go back through the queue.
    if (entry.status === JobStatus.REVISION_REQUIRED) {
      return this._runRevision(jobId, project, workspacePath);
    }
    if (entry.status === JobStatus.RECEIVED) {
      await this._transition(jobId, JobStatus.VALIDATING, { message: 'validating the task contract' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      await this._transition(jobId, JobStatus.QUEUED, { message: 'queued for the project lane' });
    } else if (entry.status !== JobStatus.QUEUED) {
      // Any other starting point is a bug in the caller, not something to guess about.
      throw new ApiError(ErrorCode.INVALID_TRANSITION, `a worker cannot start from '${entry.status}'`);
    }

    // One writer per project. Everything from here to release is workspace-active.
    const lease = await this._acquireLeaseOrBlock(jobId, project.project_id);
    if (!lease) return;

    // The lease TTL (default 5 minutes) is far shorter than a phase budget (default 30), so without
    // renewal it lapsed mid-implementation and a second job walked into the same checkout. The
    // renewal is driven by the worker's own liveness — it stops the moment the worker does, which
    // is what keeps a dead worker from holding the project forever.
    const renewal = setInterval(() => {
      this._renewLease(jobId, project.project_id).catch(() => {});
    }, Math.max(1_000, Math.floor(this.config.leaseTtlMs / 3)));
    if (typeof renewal.unref === 'function') renewal.unref();

    try {
      const job = this.repo.getJob(jobId);

      // ---- session ----
      await this._transition(jobId, JobStatus.ENSURING_PROJECT_SESSION, { message: 'ensuring the orchestrator lane', phase: 'session' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;

      const token = { orchestrator_instance_id: job.orchestrator_instance_id, projects: [job.project_id] };
      let session;
      try {
        session = await this.sessionManager.ensureSession({
          token, project, request: { orchestrator_instance_id: job.orchestrator_instance_id, project_id: job.project_id, cli_backend: 'claude-code', force_replace: false },
          correlationId: job.correlation_id,
        });
      } catch (err) {
        // `TmuxAdapter.hasSession`/`listWindows` re-throw rather than swallow when tmux itself was
        // killed without confirmation (as opposed to its ordinary "no such session" exit) — `_blockWith`
        // below releases the lease unconditionally, which is exactly wrong here.
        if (await this._guardTermination(jobId, err?.terminationConfirmed, `preparing the orchestrator lane could not confirm tmux was actually killed after it timed out: ${err.message}`)) return;
        await this._blockWith(jobId, JobStatus.BLOCKED_PROJECT_STATE, `the orchestrator lane could not be prepared: ${err.message}`);
        return;
      }
      await this._emit(jobId, { event_type: EventType.SESSION_READY, message: `lane ${session.session_key} is available` });

      // ---- backend verification, before any file is read ----
      await this._transition(jobId, JobStatus.VERIFYING_BACKEND, { message: 'verifying the effective model and effort', phase: 'verification' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;

      // A backend that cannot be queried is a blocked job, not a crashed one: the work is
      // untouched and the condition may clear.
      let verification;
      try {
        verification = await this.sessionManager.verifySession({
          token, project,
          request: {
            session_key: session.session_key,
            phase_class: PhaseClass.IMPLEMENTATION,
            requested: job.requested,
            // The engine is the caller here and knows exactly which run it is asking about, so it
            // binds the request. Without this the attestation would be stamped `unbound` and no
            // launch enforcement could be claimed — every job would block at blocked_configuration
            // even though the binary supports the option.
            run_id: jobId,
            config_generation: this.config.configGeneration,
            // Fresh per verification, not derived from the job and phase: a nonce that repeated on
            // every retry would let an attestation captured on the first attempt stay valid on the
            // fifth, after the lane had been relaunched with different flags.
            verification_nonce: crypto.randomBytes(16).toString('hex'),
          },
          correlationId: job.correlation_id,
        });
      } catch (err) {
        if (await this._guardTermination(jobId, err?.terminationConfirmed, `verifying the effective configuration could not confirm a kill was actually dead after it timed out: ${err.message}`)) return;
        const target = {
          auth_expired: JobStatus.BLOCKED_AUTHENTICATION,
          rate_limited: JobStatus.BLOCKED_RATE_LIMIT,
          usage_limited: JobStatus.BLOCKED_USAGE_LIMIT,
          unavailable: JobStatus.BLOCKED_CONNECTIVITY,
        }[err?.kind] ?? JobStatus.BLOCKED_CONFIGURATION;
        await this._blockWith(jobId, target, `the effective configuration could not be verified (${err?.kind ?? 'unknown'})`);
        return;
      }

      // `verifySession` runs a real, bounded CLI launch in the same workspace this job's lease
      // protects — as capable of leaving an unconfirmed descendant as any other launch. It reports
      // its own failures as a normal (non-throwing) response rather than an exception, so the guard
      // belongs here too, not only in the catch above.
      if (await this._guardTermination(jobId, verification.terminationConfirmed, 'verifying the effective configuration could not confirm a kill was actually dead after it timed out')) return;

      // The verdict is the attestation's, not this function's. An earlier version compared only
      // effort here — and compared it against a value copied from the request, so the check always
      // passed. Re-deriving a verdict at the call site is how that happened; it is not done again.
      if (!verification.effective) {
        await this._emit(jobId, {
          event_type: EventType.MODEL_MISMATCH,
          message: verification.detail ?? 'the effective configuration could not be attested',
        });
        await this._blockWith(
          jobId, JobStatus.BLOCKED_CONFIGURATION,
          verification.detail ?? 'the effective model and effort could not be attested',
        );
        return;
      }
      // A second, independent check against the OBSERVED model rather than the reported alias.
      // Comparing `effective.model_alias` to the request would be `requested === requested`, since
      // the attestation sets that field from the request by construction — it could not catch the
      // adapter bug its predecessor claimed to.
      const observedModel = attestModel({
        requestedAlias: job.requested.model_alias,
        observedModel: verification.observed_model,
        aliases: this.config.modelAliases,
      });
      if (!observedModel.verified || verification.effective.effort !== job.requested.effort) {
        await this._emit(jobId, { event_type: EventType.MODEL_MISMATCH, message: 'the attested configuration differs from the requested one' });
        await this._blockWith(jobId, JobStatus.BLOCKED_CONFIGURATION, observedModel.reason ?? 'the attested model or effort differs from the requested one');
        return;
      }
      await this._emit(jobId, { event_type: EventType.MODEL_VERIFIED, message: `verified ${verification.effective.model_alias} at ${verification.effective.effort} effort` });
      await this.store.transact((tx, state) => {
        const current = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...current, effective: verification.effective, cli_session_id: verification.cli_session_id ?? null, updated_at: this.now() });
      });

      // ---- baseline ----
      const { terminationConfirmed: baselineVerdict, ...baseline } = await repositoryBaseline({
        cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec,
      });
      if (await this._guardTermination(jobId, baselineVerdict, 'capturing the repository baseline could not confirm a git command was actually killed after it timed out')) return;
      await this.store.transact((tx, state) => {
        const current = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...current, baseline, updated_at: this.now() });
      });

      // ---- discovery ----
      await this._transition(jobId, JobStatus.DISCOVERING, { message: 'exploring the repository', phase: 'discovery' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      const discovery = await this._runPhase(jobId, {
        project, workspacePath, phaseClass: PhaseClass.DISCOVERY, session,
        prompt: this._discoveryPrompt(job),
      });
      if (!discovery) return;
      if (await this._handleQuestions(jobId, discovery, 'discovery')) return;

      // ---- implementation ----
      await this._transition(jobId, JobStatus.IMPLEMENTING, { message: 'implementing the change', phase: 'implementation' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      const implementation = await this._runPhase(jobId, {
        project, workspacePath, phaseClass: PhaseClass.IMPLEMENTATION, session,
        prompt: this._implementationPrompt(job),
      });
      if (!implementation) return;
      if (await this._handleQuestions(jobId, implementation, 'implementation')) return;

      // What actually changed, according to git rather than the model.
      const observed = await diffStat({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });
      if (await this._guardTermination(jobId, observed.terminationConfirmed, 'observing the diff could not confirm a git command was actually killed after it timed out')) return;
      const diffArtifact = await this.artifacts.write({
        jobId, kind: ArtifactKind.DIFF, name: 'implementation.diff',
        content: observed.changed_files.join('\n'),
        summary: `${observed.stat.files} file(s), +${observed.stat.insertions}/-${observed.stat.deletions}`,
      });
      await this._emit(jobId, {
        event_type: EventType.DIFF_OBSERVED,
        message: `${observed.stat.files} file(s) changed, +${observed.stat.insertions}/-${observed.stat.deletions}`,
        evidence: { command: 'git diff HEAD --numstat', exit_code: 0, artifact_id: diffArtifact.artifact_id },
        artifact_ids: [diffArtifact.artifact_id],
      });

      // ---- verification ----
      await this._transition(jobId, JobStatus.VERIFYING_TARGETED, { message: 'running targeted verification', phase: 'verification' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      const targeted = await this._runChecks(jobId, project, workspacePath, this._targetedChecks(job));
      if (await this._guardTermination(jobId, targeted.terminationConfirmed, 'targeted verification could not confirm a command was actually killed after it timed out or was aborted')) return;
      if (targeted.failed) {
        await this._transition(jobId, JobStatus.BLOCKED_VERIFICATION, {
          message: 'targeted verification failed', detail: 'targeted verification failed', eventType: EventType.BLOCKED,
        });
        await this._releaseLease(jobId);
        return;
      }

      await this._transition(jobId, JobStatus.VERIFYING_FULL, { message: 'running full verification', phase: 'verification' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      const full = await this._runChecks(jobId, project, workspacePath, this._fullChecks(job));
      if (await this._guardTermination(jobId, full.terminationConfirmed, 'full verification could not confirm a command was actually killed after it timed out or was aborted')) return;
      if (full.failed) {
        await this._transition(jobId, JobStatus.BLOCKED_VERIFICATION, {
          message: 'full verification failed', detail: 'full verification failed', eventType: EventType.BLOCKED,
        });
        await this._releaseLease(jobId);
        return;
      }

      // ---- independent review ----
      await this._transition(jobId, JobStatus.REVIEWING, { message: 'running an independent review', phase: 'review' });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;
      const review = await this._runReview(jobId, { project, workspacePath, session, job: this.repo.getJob(jobId) });
      if (!review) return;

      if (review.verdict !== ReviewVerdict.APPROVED) {
        await this._transition(jobId, JobStatus.BLOCKED_REVIEW, {
          message: `review verdict: ${review.verdict}`, detail: `review verdict: ${review.verdict}`, eventType: EventType.BLOCKED,
        });
        await this._releaseLease(jobId);
        return;
      }

      // ---- publication gate ----
      // Publication is a separate, approval-gated operation. The job waits; it does not publish
      // itself, and it never merges or deploys.
      await this._requestApproval(jobId, {
        approvalType: ApprovalType.PUBLICATION,
        requestedAction: `publish ${observed.stat.files} changed file(s) from ${project.project_id} as a pull request`,
        evidenceSummary: `checks: ${targeted.records.length + full.records.length} recorded; review ${review.review_id} approved`,
        artifactIds: [diffArtifact.artifact_id],
      });
      await this._transition(jobId, JobStatus.WAITING_FOR_PUBLICATION_APPROVAL, {
        message: 'waiting for a recorded human decision before publishing',
        detail: 'publication requires a recorded approval',
      });
      await this._releaseLease(jobId);
    } catch (err) {
      // An uncaught exception this far in is exactly as capable of carrying an unconfirmed kill as
      // any other rejection this engine handles — `_startWorker`'s own catch cannot tell, since by
      // the time it sees this error the lease would already be gone. Fence here, before re-throwing,
      // rather than release over a kill nobody confirmed. `_terminationIsUnconfirmed` also consults
      // `_terminationUnconfirmed`/the durable job record, so a SECOND, unrelated exception arriving
      // after an earlier step already observed `false` cannot downgrade it back to unknown just
      // because this particular error carries no verdict of its own.
      if (this._terminationIsUnconfirmed(jobId, err?.terminationConfirmed)) {
        await this._fenceLease(jobId, `an unexpected error could not confirm a kill: ${err.message}`);
      } else {
        await this._releaseLease(jobId);
      }
      throw err;
    } finally {
      clearInterval(renewal);
    }
  }

  /**
   * Work a bounded correction.
   *
   * Previously `requestRevision` moved the job to `revision_required` and stopped there — no worker,
   * no phases, forever, and `revision_required -> queued` is not a legal edge so nothing could
   * rescue it either.
   */
  async _runRevision(jobId, project, workspacePath) {
    const lease = await this._acquireLeaseOrBlock(jobId, project.project_id);
    if (!lease) return;
    // The same renewal the main pipeline installs. Without it the lease (5 minutes by default)
    // lapsed inside a revision phase (30 minutes) and a second job walked into the same checkout.
    const renewal = setInterval(() => {
      this._renewLease(jobId, project.project_id).catch(() => {});
    }, Math.max(1_000, Math.floor(this.config.leaseTtlMs / 3)));
    if (typeof renewal.unref === 'function') renewal.unref();

    try {
      const job = this.repo.getJob(jobId);
      await this._transition(jobId, JobStatus.IMPLEMENTING, {
        message: 'applying the requested revision', phase: 'implementation',
      });
      if (await this._stopIfCancelled(jobId, workspacePath)) return;

      const outcome = await this._runPhase(jobId, {
        project, workspacePath, phaseClass: PhaseClass.MECHANICAL_CORRECTION, session: null,
        prompt: [
          `Task: ${job.task.title}`,
          `Apply exactly this correction, and nothing beyond it:`,
          job.revision_instructions ?? 'address the review findings',
          'Do not redesign, do not expand scope, and do not commit or push.',
        ].join('\n'),
      });
      if (!outcome) return;
      if (await this._handleQuestions(jobId, outcome, 'implementation')) return;

      await this._transition(jobId, JobStatus.VERIFYING_TARGETED, { message: 'verifying the revision', phase: 'verification' });
      const targeted = await this._runChecks(jobId, project, workspacePath, this._targetedChecks(job));
      if (await this._guardTermination(jobId, targeted.terminationConfirmed, 'verification after the revision could not confirm a command was actually killed after it timed out or was aborted')) return;
      if (targeted.failed) {
        await this._blockWith(jobId, JobStatus.BLOCKED_VERIFICATION, 'verification failed after the revision');
        return;
      }
      await this._transition(jobId, JobStatus.VERIFYING_FULL, { message: 'running full verification', phase: 'verification' });
      const full = await this._runChecks(jobId, project, workspacePath, this._fullChecks(job));
      if (await this._guardTermination(jobId, full.terminationConfirmed, 'full verification after the revision could not confirm a command was actually killed after it timed out or was aborted')) return;
      if (full.failed) {
        await this._blockWith(jobId, JobStatus.BLOCKED_VERIFICATION, 'full verification failed after the revision');
        return;
      }
      await this._transition(jobId, JobStatus.REVIEWING, { message: 're-reviewing after the revision', phase: 'review' });
      const review = await this._runReview(jobId, { project, workspacePath, job: this.repo.getJob(jobId) });
      if (!review) return;
      if (review.verdict !== ReviewVerdict.APPROVED) {
        await this._blockWith(jobId, JobStatus.BLOCKED_REVIEW, `review verdict after revision: ${review.verdict}`);
        return;
      }
      await this._requestApproval(jobId, {
        approvalType: ApprovalType.PUBLICATION,
        requestedAction: `publish the revised change in ${project.project_id} as a pull request`,
        evidenceSummary: `revision applied; review ${review.review_id} approved`,
      });
      await this._transition(jobId, JobStatus.WAITING_FOR_PUBLICATION_APPROVAL, {
        message: 'waiting for a recorded human decision before publishing',
        detail: 'publication requires a recorded approval',
      });
    } catch (err) {
      // Mirrors `_run`'s own catch: an uncaught exception here is exactly as capable of carrying an
      // unconfirmed kill as any other rejection, and `_startWorker`'s catch cannot fence what this
      // method has already released. `_terminationIsUnconfirmed` backstops against a secondary,
      // unrelated exception downgrading an already-observed `false`.
      if (this._terminationIsUnconfirmed(jobId, err?.terminationConfirmed)) {
        await this._fenceLease(jobId, `an unexpected error could not confirm a kill: ${err.message}`);
      } else {
        await this._releaseLease(jobId);
      }
      throw err;
    } finally {
      clearInterval(renewal);
    }
  }

  /** Extend this job's lease while its worker is alive. Silent when the lease was already lost. */
  async _renewLease(jobId, projectId) {
    const job = this.repo.getJob(jobId);
    if (!job?.lease_fencing_token) return;
    const resource = `project-write:${this.config.instanceId}:${projectId}`;
    await this.store.transact((tx, state) => this.repo.renewLease(tx, state, {
      resource, owner: jobId, fencingToken: job.lease_fencing_token, ttlMs: this.config.leaseTtlMs,
    }));
  }

  // -- phase execution -------------------------------------------------------

  async _runPhase(jobId, { project, workspacePath, phaseClass, session, prompt }) {
    const job = this.repo.getJob(jobId);
    await this._emit(jobId, { event_type: EventType.PHASE_STARTED, message: `${phaseClass} phase started` });

    let result;
    try {
      result = await this.backend.runPhase({
        prompt,
        model: job.effective?.model_alias ?? job.requested.model_alias,
        effort: job.requested.effort,
        maxTurns: job.max_phase_turns,
        phaseClass,
        cwd: workspacePath,
        resumeSessionId: job.cli_session_id ?? null,
        // Cancelling must actually stop the agent. Without this the child kept editing while the
        // caller waited out the phase budget — up to half an hour — and the "working tree
        // preserved" comparison was taken around a still-running writer.
        signal: this._aborts.get(jobId)?.signal ?? null,
      });
    } catch (err) {
      if (err?.kind === 'cancelled' || err?.name === 'AbortError' || this._cancelled(jobId)) {
        // The phase was stopped on purpose. Cancellation records the terminal state itself.
        // Surface terminationConfirmed so cancelJob knows whether descendants are dead.
        if (err?.terminationConfirmed === false) {
          this._terminationUnconfirmed.add(jobId);
        }
        return null;
      }
      await this._blockWith(jobId, JobStatus.BLOCKED_CONNECTIVITY, `the coding backend failed: ${err.message}`);
      return null;
    }

    if (result.session_id) {
      await this.store.transact((tx, state) => {
        const current = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...current, cli_session_id: result.session_id, updated_at: this.now() });
      });
    }

    // An ordinary backend timeout or process death — nothing to do with a user cancellation, so it
    // never reaches the `cancelled` branch above — is exactly as capable of leaving an unconfirmed
    // descendant behind as a cancelled one. `_blockWith` below releases unconditionally; this must
    // run first, or a genuine kill nobody could confirm quietly frees the project for the next job.
    if (await this._guardTermination(
      jobId, result.terminationConfirmed,
      `the ${phaseClass} phase could not confirm a kill was actually dead after it timed out`,
    )) {
      return null;
    }

    if (!result.ok) {
      // Each failure kind reaches a different safe state: they need different operator responses,
      // and only some are worth retrying.
      const target = {
        auth_expired: JobStatus.BLOCKED_AUTHENTICATION,
        rate_limited: JobStatus.BLOCKED_RATE_LIMIT,
        usage_limited: JobStatus.BLOCKED_USAGE_LIMIT,
        unavailable: JobStatus.BLOCKED_CONNECTIVITY,
        // The launch was refused before it started: this host cannot run the CLI as the
        // unprivileged account it is configured to use. Nothing about the project or the job is
        // wrong, and a retry changes nothing until an operator fixes the configuration.
        privilege_drop_failed: JobStatus.BLOCKED_CONFIGURATION,
        timeout: JobStatus.BLOCKED_PROJECT_STATE,
        process_died: JobStatus.BLOCKED_PROJECT_STATE,
        malformed_output: JobStatus.BLOCKED_VERIFICATION,
        // A max-turn exit is a failure. It is emphatically not a success with a caveat.
        max_turns: JobStatus.BLOCKED_VERIFICATION,
      }[result.failure_kind] ?? JobStatus.BLOCKED_PROJECT_STATE;

      await this._blockWith(jobId, target, `the ${phaseClass} phase did not complete (${result.failure_kind})`);
      return null;
    }

    // Attest the model of the session that actually did the work. Verification runs a separate
    // probe session, so without this a run degraded mid-job — an Opus usage limit falling back to
    // Sonnet, say — would complete while the job still reported the model it verified. That is a
    // guess reported as fact, which is the thing §1.4 forbids.
    if (result.model) {
      const attested = attestModel({
        requestedAlias: job.requested.model_alias,
        observedModel: result.model,
        aliases: this.config.modelAliases,
      });
      if (!attested.verified) {
        await this._emit(jobId, {
          event_type: EventType.MODEL_MISMATCH,
          message: `the ${phaseClass} phase ran under an unattested model: ${attested.reason}`,
        });
        await this._blockWith(
          jobId, JobStatus.BLOCKED_CONFIGURATION,
          `the ${phaseClass} phase ran under a model that could not be attested`,
        );
        return null;
      }
    }

    await this._emit(jobId, {
      event_type: EventType.PHASE_COMPLETED,
      message: `${phaseClass} phase completed in ${result.turns_used} turn(s)`,
    });
    return result;
  }

  _discoveryPrompt(job) {
    return [
      'You are exploring a repository in read-only mode for a delegated task. Do not modify files.',
      `Task: ${job.task.title}`,
      `Goal: ${job.task.goal}`,
      job.task.likely_paths.length ? `Likely paths: ${job.task.likely_paths.join(', ')}` : '',
      'Report the files that must change and any question that genuinely blocks the work.',
    ].filter(Boolean).join('\n');
  }

  _implementationPrompt(job) {
    return [
      `Task: ${job.task.title}`,
      `Goal: ${job.task.goal}`,
      `Acceptance criteria:\n${job.task.acceptance_criteria.map((c) => `- ${c}`).join('\n')}`,
      job.task.constraints.length ? `Constraints:\n${job.task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      job.task.out_of_scope.length ? `Out of scope:\n${job.task.out_of_scope.map((c) => `- ${c}`).join('\n')}` : '',
      'Implement the change. Do not commit, push, merge, or deploy: publication is handled separately and requires an approval.',
    ].filter(Boolean).join('\n');
  }

  // -- checks ----------------------------------------------------------------

  _targetedChecks(job) {
    const requested = job.task.required_checks.map(canonicaliseCheckName);
    return requested.length ? requested.filter((c) => c !== 'full_test_suite') : ['targeted_test'];
  }

  _fullChecks() {
    return ['full_test_suite', 'diff_check', 'secret_scan'];
  }

  async _runChecks(jobId, project, workspacePath, checkNames) {
    const records = [];
    let failed = false;
    // `null` unless some check in this batch reports an unconfirmed kill — the caller must fence and
    // stop rather than treat it as an ordinary check failure the moment this is `false`.
    let terminationConfirmed = null;
    for (const checkName of checkNames) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.checkRunner.run({ jobId, checkName, project, cwd: workspacePath });
      const { check, artifact } = outcome;
      if (outcome.terminationConfirmed === false) terminationConfirmed = false;
      // eslint-disable-next-line no-await-in-loop
      await this.store.transact((tx) => { tx.put(KIND.CHECKS, check.check_id, check); });
      // eslint-disable-next-line no-await-in-loop
      await this._emit(jobId, {
        event_type: EventType.CHECK_COMPLETED,
        message: `${check.name}: ${check.outcome}`,
        evidence: {
          command: check.command, exit_code: check.exit_code,
          passed: check.passed_count, failed: check.failed_count,
          duration_seconds: check.duration_seconds, artifact_id: check.artifact_id,
        },
        artifact_ids: artifact ? [artifact.artifact_id] : [],
      });
      records.push(check);
      if (check.outcome === CheckOutcome.FAILED || check.outcome === CheckOutcome.ERRORED) failed = true;
      // An unconfirmed kill takes priority over continuing the batch: whatever it left behind in the
      // workspace matters more than whichever check was scheduled to run next.
      if (terminationConfirmed === false) break;
    }
    return { records, failed, terminationConfirmed };
  }

  // -- review ----------------------------------------------------------------

  /**
   * Run an independent review.
   *
   * The reviewing session is deliberately *not* resumed from the implementation session. A review
   * that inherited the implementation's context is not independent, and `session_isolated` records
   * exactly that — it is false unless the reviewing session provably did not implement the change.
   */
  async _runReview(jobId, { project, workspacePath, job }) {
    const implementationSessionId = job.cli_session_id ?? null;

    let result;
    try {
      result = await this.backend.runPhase({
        prompt: [
          'You are reviewing a change you did not write. Do not modify any file.',
          `Task: ${job.task.title}`,
          `Acceptance criteria:\n${job.task.acceptance_criteria.map((c) => `- ${c}`).join('\n')}`,
          'Report blocking findings only. If you cannot complete the review, say so explicitly.',
        ].join('\n'),
        model: job.effective?.model_alias ?? job.requested.model_alias,
        effort: job.requested.effort,
        maxTurns: job.max_phase_turns,
        phaseClass: PhaseClass.ROUTINE_REVIEW,
        cwd: workspacePath,
        // No resume: a fresh session id is what makes the isolation claim true.
        resumeSessionId: null,
      });
    } catch (err) {
      // The review launch runs in the same workspace the project's lease protects and is exactly as
      // capable of an unconfirmed kill as `_runPhase`'s own coding-phase launch — `_blockWith` below
      // releases unconditionally, which is wrong here for the same reason it is everywhere else.
      if (await this._guardTermination(jobId, err?.terminationConfirmed, `the review could not confirm a kill was actually dead after it timed out: ${err.message}`)) return null;
      await this._blockWith(jobId, JobStatus.BLOCKED_REVIEW, `the review could not run: ${err.message}`);
      return null;
    }

    // An ordinary backend timeout during review — reported as a normal `{ ok: false, ... }` return,
    // never a throw — is just as capable of leaving an unconfirmed descendant as one that throws.
    if (await this._guardTermination(jobId, result.terminationConfirmed, 'the review could not confirm a kill was actually dead after it timed out')) return null;

    const isolated = Boolean(result.session_id) && result.session_id !== implementationSessionId;
    const verdict = !result.ok
      ? ReviewVerdict.INCONCLUSIVE
      : (isolated ? ReviewVerdict.APPROVED : ReviewVerdict.INCONCLUSIVE);

    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.REVIEW_REPORT, name: 'review.txt',
      content: result.summary ?? '', summary: `verdict: ${verdict}`,
    });

    const review = {
      schema_version: SCHEMA_VERSION,
      review_id: newId('pwrev'),
      job_id: jobId,
      verdict,
      review_session_id: result.session_id ?? null,
      session_isolated: isolated,
      findings: [],
      reviewed_at: this.now(),
      artifact_id: artifact.artifact_id,
    };

    await this.store.transact((tx, state) => {
      tx.put(KIND.REVIEWS, review.review_id, review);
      const current = state.get(KIND.JOBS, jobId);
      this.repo.putJob(tx, { ...current, review_id: review.review_id, updated_at: this.now() });
    });
    await this._emit(jobId, {
      event_type: EventType.REVIEW_COMPLETED,
      message: `review verdict: ${verdict}`,
      evidence: { artifact_id: artifact.artifact_id, exit_code: result.ok ? 0 : 1 },
      artifact_ids: [artifact.artifact_id],
    });
    return review;
  }

  // -------------------------------------------------------------------------
  // human interaction
  // -------------------------------------------------------------------------

  async _handleQuestions(jobId, phaseResult, phase) {
    const raised = phaseResult.questions ?? [];
    if (!raised.length) return false;

    for (const question of raised) {
      // eslint-disable-next-line no-await-in-loop
      await this.raiseQuestion(jobId, { ...question, phase });
    }
    await this._transition(jobId, JobStatus.WAITING_FOR_INPUT, {
      message: 'blocked on a question from the coding session',
      detail: 'a question is awaiting an answer',
    });
    await this._releaseLease(jobId);
    return true;
  }

  /**
   * Record a question raised by the coding session.
   *
   * The identifier is issued here and is what an answer must match. That is the whole mechanism:
   * without a real ProjectWorkbench question id, an answer cannot be routed back to the session
   * that is waiting for it, and a stale answer would be indistinguishable from a live one.
   */
  async raiseQuestion(jobId, { question, options = [], blocking = true, decisionScope = DecisionScope.CLARIFICATION, defaultActionOnTimeout = TimeoutAction.REMAIN_BLOCKED, phase = null }) {
    const record = {
      schema_version: SCHEMA_VERSION,
      question_id: newId('pwq'),
      job_id: jobId,
      question: String(question).slice(0, 2_000),
      options: options.slice(0, 50).map((o) => String(o).slice(0, 1_000)),
      blocking,
      decision_scope: decisionScope,
      default_action_on_timeout: defaultActionOnTimeout,
      status: QuestionStatus.OPEN,
      asked_at: this.now(),
      expires_at: new Date(this.clock().getTime() + DEFAULT_INTERACTION_TTL_MS).toISOString(),
      phase,
      answer: null,
      answered_at: null,
    };
    await this.store.transact((tx) => { tx.put(KIND.QUESTIONS, record.question_id, record); });
    await this._emit(jobId, {
      event_type: EventType.QUESTION_RAISED,
      message: `question raised: ${record.question}`,
    });
    return record;
  }

  /**
   * Answer a live question.
   *
   * Only the matching, still-open, not-yet-expired question on this job may be answered, and only
   * once. A stale answer, a cross-job answer, and a second answer to an already-answered question
   * all fail — otherwise an answer intended for one decision could silently resolve another.
   */
  async replyToQuestion({ token, jobId, body, idempotencyKey }) {
    const job = this.requireJob(token, jobId);
    const request = validate(REPLY_SCHEMA, body ?? {});
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }

    // The whole check runs inside the transaction. Reading the status first and writing later let
    // two concurrent replies to one open question both succeed, last write winning — and each then
    // resumed the job, starting two workers on one workspace.
    const question = await this.store.transact((tx, state) => {
      const current = state.get(KIND.QUESTIONS, request.question_id);
      if (!current || current.job_id !== jobId) throw notFound('no such question');
      if (current.status !== QuestionStatus.OPEN) {
        throw new ApiError(ErrorCode.CONFLICT, 'this question has already been answered or withdrawn');
      }
      if (current.expires_at && new Date(current.expires_at) < this.clock()) {
        throw new ApiError(ErrorCode.CONFLICT, 'this question has expired');
      }
      if (request.selected_option_index !== null && request.selected_option_index !== undefined
        && request.selected_option_index >= current.options.length) {
        throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the selected option does not exist');
      }

      tx.put(KIND.QUESTIONS, current.question_id, {
        ...current,
        status: QuestionStatus.ANSWERED,
        answer: request.answer,
        selected_option_index: request.selected_option_index ?? null,
        answered_at: this.now(),
      });
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.QUESTION_ANSWERED, status: job.status,
        actor: { kind: ActorKind.ORCHESTRATOR, identifier: token.orchestrator_instance_id },
        message: `question ${current.question_id} answered`,
      });
      return current;
    });

    this._auditEvent('orchestrator.question.answered', { workbench_job_id: jobId, question_id: question.question_id });
    // Resumption goes back through the readiness chain rather than jumping to where it stopped:
    // whatever blocked the job may have changed the world in the meantime.
    await this._resume(jobId, 'a question was answered');
    return { schema_version: SCHEMA_VERSION, question_id: question.question_id, status: QuestionStatus.ANSWERED };
  }

  async _requestApproval(jobId, { approvalType, requestedAction, evidenceSummary, artifactIds = [] }) {
    const record = {
      schema_version: SCHEMA_VERSION,
      approval_id: newId('pwapr'),
      job_id: jobId,
      approval_type: approvalType,
      requested_action: String(requestedAction).slice(0, 2_000),
      evidence_summary: evidenceSummary ? String(evidenceSummary).slice(0, 20_000) : null,
      artifact_ids: artifactIds,
      status: ApprovalStatus.PENDING,
      requested_at: this.now(),
      expires_at: new Date(this.clock().getTime() + DEFAULT_INTERACTION_TTL_MS).toISOString(),
      decided_at: null,
      decided_by: null,
      decision_reason: null,
    };
    await this.store.transact((tx) => { tx.put(KIND.APPROVALS, record.approval_id, record); });
    await this._emit(jobId, {
      event_type: EventType.APPROVAL_REQUESTED,
      message: `approval requested: ${record.requested_action}`,
      artifact_ids: artifactIds,
    });
    return record;
  }

  /**
   * Relay a recorded human decision.
   *
   * The decision is attributed to a human actor because the orchestrator is relaying one, not making
   * one. An agent asserting `approved: true` is not an approval, and the contract's own approval
   * model rejects a decision whose actor is not human — so a mis-attributed relay would be caught on
   * the other side even if it slipped past here.
   */
  async approveStage({ token, jobId, body, idempotencyKey }) {
    const job = this.requireJob(token, jobId);
    const request = validate(APPROVE_SCHEMA, body ?? {});

    // Recording a decision needs its own scope.
    if (!token.scopes?.includes(SCOPES.APPROVE)) {
      throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, "recording a decision requires the 'approve' scope");
    }
    if (this.config.requireSeparateApprover) {
      // Separation has to rest on capability, not identity. Keying it on token_id alone is defeated
      // by the rotation the token store is explicitly designed for: one orchestrator holding
      // `submitter` and `submitter-v2` could submit with one and approve with the other. A
      // credential that can both request work and approve it is not a separated authority whatever
      // it is called.
      if (token.scopes?.includes(SCOPES.JOBS_WRITE)) {
        throw new ApiError(
          ErrorCode.FORBIDDEN_SCOPE,
          'a credential that can submit work may not also approve it',
        );
      }
      // And the specific credential that submitted this job may not approve it. A job stored before
      // this field existed has no recorded submitter, and unknown is refused rather than treated as
      // "different" — the previous behaviour silently no-opped for exactly those jobs.
      if (!job.submitted_by_token) {
        throw new ApiError(
          ErrorCode.FORBIDDEN_SCOPE,
          'this job has no recorded submitting credential, so separation of duty cannot be established',
        );
      }
      if (job.submitted_by_token === token.token_id) {
        throw new ApiError(
          ErrorCode.FORBIDDEN_SCOPE,
          'the credential that submitted this job may not approve it',
        );
      }
    }
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }

    // The decider must be named. There is no placeholder: an approval whose audit trail says
    // "recorded-human-decision" identifies nobody, and this is the record that authorises a push.
    if (!request.decided_by) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'a recorded decision must name who made it', {
        fieldErrors: [{ field: 'decided_by', message: 'required: the human who decided' }],
      });
    }

    // Compare-and-set inside the transaction: a concurrent approve and reject on one PENDING
    // approval would otherwise both pass their status check, last write winning while both emit an
    // approval_decided event.
    const decided = await this.store.transact((tx, state) => {
      const approval = state.get(KIND.APPROVALS, request.approval_id);
      if (!approval || approval.job_id !== jobId) throw notFound('no such approval');
      if (approval.status !== ApprovalStatus.PENDING) {
        throw new ApiError(ErrorCode.CONFLICT, 'this approval has already been decided or withdrawn');
      }
      if (approval.expires_at && new Date(approval.expires_at) < this.clock()) {
        throw new ApiError(ErrorCode.CONFLICT, 'this approval request has expired');
      }

      const record = {
        ...approval,
        status: request.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        decided_at: this.now(),
        // ProjectWorkbench cannot verify that a human was involved — it is at the far end of a
        // machine-to-machine interface, and the decision was recorded on the orchestrator side.
        // What it can do is refuse to invent a decider, record the relaying credential separately
        // so the audit never conflates the two, and require a distinct scope (see auth.js) so
        // granting an orchestrator the ability to approve its own work is a deliberate act.
        decided_by: { kind: ActorKind.HUMAN, identifier: request.decided_by },
        decided_via: token.orchestrator_instance_id,
        decision_reason: request.reason ?? null,
      };
      tx.put(KIND.APPROVALS, approval.approval_id, record);
      const job = state.get(KIND.JOBS, jobId);
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.APPROVAL_DECIDED, status: job.status,
        actor: { kind: ActorKind.HUMAN, identifier: record.decided_by.identifier },
        message: `approval ${approval.approval_id} ${record.status}`,
      });
      return record;
    });

    this._auditEvent('orchestrator.approval.decided', {
      workbench_job_id: jobId,
      approval_id: request.approval_id,
      status: decided.status,
      // Who decided, through which orchestrator, on which credential — three separate facts, never
      // conflated. ProjectWorkbench cannot attest the first; it can and does record all three.
      decided_by: decided.decided_by.identifier,
      relayed_by: decided.decided_via,
      relayed_by_token: token.token_id ?? null,
    });

    if (!request.approved) {
      const job = this.repo.getJob(jobId);
      if (job.status === JobStatus.WAITING_FOR_PUBLICATION_APPROVAL) {
        await this._transition(jobId, JobStatus.COMPLETED, {
          message: 'publication was declined; the work is preserved unpublished',
          detail: 'publication declined', eventType: EventType.COMPLETED,
        });
      }
    }
    return { schema_version: SCHEMA_VERSION, approval_id: request.approval_id, status: decided.status };
  }

  /** A bounded, explicit correction. Never an invitation to redesign. */
  async requestRevision({ token, jobId, body }) {
    const job = this.requireJob(token, jobId);
    const request = validate(REVISE_SCHEMA, body ?? {});
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }
    if (job.revision_cycles_used >= job.max_revision_cycles) {
      throw new ApiError(ErrorCode.CONFLICT, 'the bounded revision budget for this job is exhausted');
    }

    await this._transition(jobId, JobStatus.REVISION_REQUIRED, {
      message: `revision requested: ${request.instructions.slice(0, 160)}`,
      detail: 'a bounded revision was requested',
      patch: { revision_cycles_used: job.revision_cycles_used + 1, revision_instructions: request.instructions },
    });
    this._auditEvent('orchestrator.revision.requested', {
      workbench_job_id: jobId, cycle: job.revision_cycles_used + 1,
    });
    // Start the worker that actually applies it.
    this._startWorker(jobId, this._resolveProjectOrThrow(job.project_id));
    return this._jobState(this.repo.getJob(jobId));
  }

  async requestReview({ token, jobId, body }) {
    const job = this.requireJob(token, jobId);
    const request = validate(REVIEW_SCHEMA, body ?? {});
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }
    await this._transition(jobId, JobStatus.REVIEWING, { message: 'an independent review was requested', phase: 'review' });
    return this._jobState(this.repo.getJob(jobId));
  }

  // -------------------------------------------------------------------------
  // artifacts
  // -------------------------------------------------------------------------

  /**
   * Artifact access is scoped to a job this credential owns.
   *
   * An artifact id is opaque and unguessable, but obscurity is not authorization: the owning job is
   * resolved and checked, so another orchestrator's evidence is `not_found` even with a valid id.
   */
  _requireArtifact(token, artifactId) {
    const metadata = this.artifacts.metadata(artifactId);
    this.requireJob(token, metadata.job_id);
    return metadata;
  }

  async getArtifactMetadata(token, artifactId) {
    return this._requireArtifact(token, artifactId);
  }

  async getArtifactExcerpt(token, request) {
    this._requireArtifact(token, request.artifact_id);
    return this.artifacts.excerpt({
      artifactId: request.artifact_id,
      byteOffset: request.byte_offset,
      maxBytes: request.max_bytes,
    });
  }

  // -------------------------------------------------------------------------
  // publication
  // -------------------------------------------------------------------------

  /**
   * Strip the fields a publication record carries only for this engine's own use before it reaches
   * ANY caller — the happy path already excluded these from what gets persisted and returned;
   * `steps` (raw-ish per-command output, redacted but still internal), `failure_reason` (present on
   * every `_failed()`-shaped record but not part of the wire contract), and `terminationConfirmed`
   * (an ephemeral verdict for THIS engine's own lease-fencing decision, never a fact about the
   * publication itself) must never reach an MCP tool result or a REST response, regardless of which
   * of `publish`'s several return paths produced the record — a lease denial and a cancellation
   * raced mid-publish previously returned the raw record unstripped, on paths the happy-path
   * destructuring never touched.
   */
  _publicPublicationRecord(record) {
    const { steps: _steps, failure_reason: _failureReason, terminationConfirmed: _terminationConfirmed, ...rest } = record;
    return rest;
  }

  /**
   * Publish under a recorded approval.
   *
   * Idempotent by key, because a retried publish must not produce a second commit. The approval is
   * checked before anything is staged, so a refused publication leaves the index untouched.
   */
  async publish({ token, jobId, request, idempotencyKey, correlationId }) {
    const job = this.requireJob(token, jobId);
    const project = this._resolveProjectOrThrow(job.project_id);

    const scope = `publish:${token.orchestrator_instance_id}`;
    const contentHash = hashContent(request);

    // Reserve the key, check the approval, and claim the PUBLISHING state in ONE transaction. Doing
    // these as separate steps let two concurrent retries — which the contract explicitly
    // anticipates — both pass, interleaving two git add/commit sequences in the same working tree
    // and leaving both publications unverified.
    const claim = await this.store.transact((tx, state) => {
      const existing = state.get(KIND.IDEMPOTENCY, `${scope}:${idempotencyKey}`);
      if (existing) {
        if (existing.content_hash !== contentHash) {
          throw new ApiError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'the idempotency key was reused with different content');
        }
        return { replay: existing.outcome };
      }

      // The gate, before anything is staged.
      const approval = request.approval_id ? state.get(KIND.APPROVALS, request.approval_id) : null;
      if (approval && approval.job_id !== jobId) throw notFound('no such approval');
      assertPublicationApproved({ approval, approvalId: request.approval_id });

      const current = state.get(KIND.JOBS, jobId);
      if (current.status !== JobStatus.WAITING_FOR_PUBLICATION_APPROVAL) {
        throw new ApiError(ErrorCode.INVALID_TRANSITION, 'this job is not awaiting publication');
      }
      assertTransition(current.status, JobStatus.PUBLISHING);
      this.repo.putJob(tx, {
        ...current, status: JobStatus.PUBLISHING, phase: 'publication', updated_at: this.now(),
      });
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.STATE_CHANGED, status: JobStatus.PUBLISHING,
        previous_status: current.status, phase: 'publication', actor: this.actor(),
        message: 'publishing under a recorded approval', correlation_id: current.correlation_id,
      });
      return { replay: null };
    });

    if (claim.replay) return claim.replay;

    const workspacePath = resolveWorkspacePath(this.config, project);

    // One writer per project — exactly the same rule the coding phases obey, and for the same
    // reason: `git add`/`commit`/`push` run directly against the shared checkout. Acquired only now
    // that the claim transaction has durably moved the job to `publishing`, so a denial here is
    // reported as *this* job being blocked (a legal edge from `publishing`) rather than stranding it
    // mid-transition. `_acquireLeaseOrBlock` already tells a competing holder from a durable fence
    // apart and blocks the job itself; there is nothing left for `publish` to decide on denial.
    const lease = await this._acquireLeaseOrBlock(jobId, project.project_id);
    if (!lease) {
      const blocked = this.repo.getJob(jobId);
      return this._publicPublicationRecord(
        this.publisher.refusedRecord(blocked, blocked.detail ?? 'the project write lease could not be acquired'),
      );
    }

    // Registered exactly like a coding-phase worker: `cancelJob` finds this job in `_running` and
    // `_aborts`, aborts the signal threaded into every publisher/git command below, and races this
    // same promise against its grace window — without this, cancelling a job that is publishing was
    // a pure no-op, and `cancelJob` recorded `cancelled` while `git push` kept running unattended.
    this._aborts.set(jobId, new AbortController());
    const entry = {};
    entry.promise = this._runPublication(jobId, project, workspacePath, request, {
      scope, idempotencyKey, contentHash,
    }).catch(async (err) => {
      // `_runPublication` only wraps `this.publisher.publish` itself in a try/catch — an unrelated
      // failure in what follows (an artifact write, the recording transaction) would otherwise escape
      // straight to this method's caller with the lease still held, un-released AND un-fenced, and the
      // job stranded in `publishing` forever. `_failSafely` is the same backstop `_startWorker` uses
      // for exactly this shape of failure, and fences rather than releases when the escaping error
      // itself carries an unconfirmed kill.
      await this._failSafely(jobId, `publication stopped unexpectedly (${err?.code ?? 'internal'})`, err?.terminationConfirmed);
      throw err;
    }).finally(() => {
      if (this._running.get(jobId) === entry) {
        this._running.delete(jobId);
        this._aborts.delete(jobId);
      }
    });
    this._running.set(jobId, entry);
    return entry.promise;
  }

  /**
   * Run the publication itself: the actual git work, its evidence, and the terminal transition.
   *
   * Split out of `publish` so the whole thing — not just the git calls — is the promise `cancelJob`
   * races and `drain()` waits for, matching `_startWorker`/`_run`.
   */
  async _runPublication(jobId, project, workspacePath, request, { scope, idempotencyKey, contentHash }) {
    // The lease TTL is far shorter than a publication can legitimately take (a slow push, a large
    // diff), so without renewal it lapsed mid-push and a second job walked into the same checkout.
    const renewal = setInterval(() => {
      this._renewLease(jobId, project.project_id).catch(() => {});
    }, Math.max(1_000, Math.floor(this.config.leaseTtlMs / 3)));
    if (typeof renewal.unref === 'function') renewal.unref();

    const job = this.repo.getJob(jobId);
    let record;
    try {
      record = await this.publisher.publish({
        job, project, workspacePath, request, signal: this._aborts.get(jobId)?.signal,
      });
    } catch (err) {
      // The job is already `publishing`, so an exception escaping here would strand it there with
      // no legal way back. Any refusal becomes a recorded failed publication instead.
      record = this.publisher.refusedRecord(job, err instanceof ApiError ? err.message : 'the publication was refused');
    } finally {
      clearInterval(renewal);
    }

    // Surface terminationConfirmed so cancelJob knows whether a descendant of some git invocation is
    // still unaccounted for, exactly as `_runPhase` does for the coding backend.
    if (record.terminationConfirmed === false) this._terminationUnconfirmed.add(jobId);

    // Cancellation records its own terminal state, from its own fingerprint comparison — a worker
    // that raced ahead and recorded `completed`/`blocked_project_state` here too would either
    // overwrite that verdict or claim a publication `cancelJob` never confirmed was safe to stop,
    // whichever transition happened to land last.
    if (this._cancelled(jobId)) return this._publicPublicationRecord(record);

    // Guarded BEFORE any fallible post-publish work — the artifact write and the recording
    // transaction below both do real I/O and can throw for reasons that have nothing to do with any
    // kill (a full disk, a store contention error). An unconfirmed kill must be durably fenced FIRST,
    // immune to whatever runs after it: no artifact write, persistence, status transition, or lease
    // release may precede it, and an unrelated secondary failure must never be able to downgrade an
    // already-observed `false` back to "unknown" by racing ahead of the fence.
    if (await this._guardTermination(
      jobId, record.terminationConfirmed,
      'publication could not confirm a git command was actually killed after a timeout or abort',
    )) {
      return this._publicPublicationRecord(record);
    }

    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.LOG, name: 'publication.log',
      content: (record.steps ?? []).map((s) => `${s.step}: exit ${s.exit_code} ${s.stderr}`).join('\n'),
      summary: record.remote_sha_verified ? 'published and verified' : (record.failure_reason ?? 'publication incomplete'),
    });

    const { failure_reason: failureReason } = record;
    const publicRecord = this._publicPublicationRecord(record);

    await this.store.transact((tx, state) => {
      tx.put(KIND.PUBLICATIONS, publicRecord.publication_id, publicRecord);
      const current = state.get(KIND.JOBS, jobId);
      this.repo.putJob(tx, { ...current, publication_id: publicRecord.publication_id, updated_at: this.now() });
      this.repo.appendEvent(tx, state, {
        job_id: jobId,
        event_type: EventType.PUBLICATION_RECORDED,
        status: JobStatus.PUBLISHING,
        actor: this.actor(),
        message: publicRecord.remote_sha_verified
          ? `published ${publicRecord.branch} at ${publicRecord.local_commit}`
          : `publication did not complete: ${failureReason ?? 'the remote SHA was not verified'}`,
        evidence: {
          command: 'git push origin HEAD:refs/heads/<branch>; git ls-remote origin <branch>',
          exit_code: publicRecord.remote_sha_verified ? 0 : 1,
          artifact_id: artifact.artifact_id,
        },
        artifact_ids: [artifact.artifact_id],
      });
      this.repo.recordIdempotency(tx, scope, idempotencyKey, contentHash, publicRecord);
    });

    if (publicRecord.remote_sha_verified) {
      await this._releaseLease(jobId);
      await this._transition(jobId, JobStatus.COMPLETED, {
        message: 'the change is published and the remote SHA was verified',
        detail: 'published', eventType: EventType.COMPLETED,
      });
    } else {
      // Never claim publication from local output alone.
      await this._blockWith(
        jobId, JobStatus.BLOCKED_PROJECT_STATE,
        `publication did not complete: ${failureReason ?? 'the remote SHA was not verified'}`,
      );
    }
    return publicRecord;
  }

  // -------------------------------------------------------------------------
  // cancellation, heartbeat, resumption, reconciliation
  // -------------------------------------------------------------------------

  /**
   * Cancel a job, preserving the working tree.
   *
   * The tree is fingerprinted before and after and the two are compared, so the claim is verified
   * rather than asserted. Nothing here could discard work even if it tried: the git allowlist makes
   * reset, stash, clean and checkout unreachable from this subsystem.
   */
  async cancelJob({ token, jobId, body }) {
    const job = this.requireJob(token, jobId);
    const request = validate(CANCEL_SCHEMA, body ?? {});
    if (TERMINAL_STATES.has(job.status)) return this._jobState(job);

    this._cancelRequested.add(jobId);
    const project = this._resolveProjectOrThrow(job.project_id);
    const workspacePath = resolveWorkspacePath(this.config, project);

    // BEFORE the abort. Sampling after the worker had already stopped made the comparison a
    // tautology — the two samples were taken back to back with nothing able to happen between them,
    // so a discard during cancellation was undetectable. The contract's flagship guarantee has to
    // be checked across the window in which something could actually go wrong.
    const before = await workingTreeFingerprint({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });

    // Signal the running phase. Waiting for it to finish on its own meant a cancel could take the
    // whole phase budget while the agent carried on editing.
    this._aborts.get(jobId)?.abort();

    // Bounded, but the bound must never be mistaken for an answer. `inFlight.promise` is what
    // eventually carries the real verdict (via `_terminationUnconfirmed`, set from the worker's own
    // catch handler once `ensureTerminated` has actually run) — and that only happens once the
    // promise settles. If the grace elapses first, nothing has settled, so nothing is known: that
    // has to read as unconfirmed, not as a coin flip that happened to land on "fine". A straggler
    // finds `_cancelRequested` set and stops at its next boundary regardless.
    const inFlight = this._running.get(jobId);
    let settledInTime = !inFlight;
    if (inFlight) {
      const GRACE_ELAPSED = Symbol('cancel-grace-elapsed');
      const outcome = await Promise.race([
        inFlight.promise.then(() => 'settled', () => 'settled'),
        new Promise((resolve) => { const t = setTimeout(() => resolve(GRACE_ELAPSED), this.config.cancelGraceMs); t.unref?.(); }),
      ]);
      settledInTime = outcome !== GRACE_ELAPSED;
    }

    const after = await workingTreeFingerprint({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });
    const preserved = workingTreePreserved(before, after);
    // Confirmed only when the worker's own promise actually settled inside the grace window, it did
    // not itself report an unconfirmed kill, AND the git commands used to take the fingerprint
    // either side of the abort were not themselves killed without confirmation — a fingerprinting
    // command is exactly as capable of backgrounding something of its own as any other. Anything
    // else — including "the deadline won the race and we simply do not know yet" — is unconfirmed,
    // never rounded up to cancelled.
    const terminationConfirmed = settledInTime && !this._terminationUnconfirmed.has(jobId)
      && before.terminationConfirmed !== false && after.terminationConfirmed !== false;

    const current = this.repo.getJob(jobId);
    if (!TERMINAL_STATES.has(current.status)) {
      if (!terminationConfirmed) {
        // Descendants may still be alive, or we simply do not yet know. The lease is fenced, not
        // released: a plain release would let a later job acquire this project the moment the lease
        // would otherwise have expired, exactly the window a live, unconfirmed writer needs to stay
        // undetected in. Only an explicit, evidenced operator action (clearFence) takes the fence
        // down — never a timer, and never this job settling late on its own.
        await this._fenceLease(jobId, `cancellation could not confirm termination: ${request.reason}`);
        await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, {
          message: 'cancellation could not confirm all descendant processes are dead',
          detail: `cancelled: ${request.reason} (termination unconfirmed — descendants may still be running)`,
          eventType: EventType.BLOCKED,
          patch: { working_tree_preserved: false, termination_confirmed: false },
        });
      } else {
        await this._releaseLease(jobId);
        await this._transition(jobId, JobStatus.CANCELLED, {
          message: `cancelled: ${request.reason}`,
          detail: `cancelled: ${request.reason}`,
          eventType: EventType.CANCELLED,
          patch: { working_tree_preserved: preserved, termination_confirmed: true },
        });
      }
    }
    this._cancelRequested.delete(jobId);
    if (terminationConfirmed) this._terminationUnconfirmed.delete(jobId);
    this._auditEvent('orchestrator.job.cancelled', {
      workbench_job_id: jobId, working_tree_preserved: preserved, termination_confirmed: terminationConfirmed,
    });
    return this._jobState(this.repo.getJob(jobId));
  }

  async _stopIfCancelled(jobId, workspacePath) {
    if (!this._cancelled(jobId)) return false;
    await this._releaseLease(jobId);
    return true;
  }

  /** Renew the project write lease while a job is genuinely progressing. */
  async heartbeat({ token, jobId, body }) {
    const job = this.requireJob(token, jobId);
    const request = validate(HEARTBEAT_SCHEMA, body ?? {});
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }
    if (!WORKSPACE_ACTIVE_STATES.has(job.status)) {
      throw new ApiError(ErrorCode.INVALID_TRANSITION, 'this job does not hold a workspace lease');
    }
    // A caller that names a fencing token must name the current one. Renewing purely from the
    // stored value would let a revived worker carrying a stale token keep a lease alive.
    if (request.fencing_token !== null && request.fencing_token !== job.lease_fencing_token) {
      throw new ApiError(ErrorCode.LEASE_LOST, 'the heartbeat carries a fencing token that is no longer current');
    }
    const resource = `project-write:${this.config.instanceId}:${job.project_id}`;
    const lease = await this.store.transact((tx, state) => this.repo.renewLease(tx, state, {
      resource, owner: jobId, fencingToken: job.lease_fencing_token, ttlMs: this.config.leaseTtlMs,
    }));
    // A heartbeat carries no evidence and never resets a stall timer — that is what makes it a
    // liveness signal rather than a claim of progress.
    await this._emit(jobId, { event_type: EventType.HEARTBEAT, message: 'the job is still active' });
    return {
      schema_version: SCHEMA_VERSION,
      workbench_job_id: jobId,
      fencing_token: lease.fencing_token,
      expires_at: lease.expires_at,
    };
  }

  async _acquireLease(jobId, projectId) {
    const resource = `project-write:${this.config.instanceId}:${projectId}`;
    try {
      const lease = await this.store.transact((tx, state) => {
        const acquired = this.repo.acquireLease(tx, state, { resource, owner: jobId, ttlMs: this.config.leaseTtlMs });
        const job = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...job, lease_fencing_token: acquired.fencing_token, updated_at: this.now() });
        return acquired;
      });
      return lease;
    } catch {
      return null;
    }
  }

  async _releaseLease(jobId) {
    const job = this.repo.getJob(jobId);
    if (!job?.lease_fencing_token) return;
    const resource = `project-write:${this.config.instanceId}:${job.project_id}`;
    await this.store.transact((tx, state) => {
      this.repo.releaseLease(tx, state, { resource, owner: jobId, fencingToken: job.lease_fencing_token });
      const current = state.get(KIND.JOBS, jobId);
      this.repo.putJob(tx, { ...current, lease_fencing_token: null, updated_at: this.now() });
    }).catch(() => { /* the lease was already taken over, or is fenced; nothing to release */ });
  }

  /**
   * Durably fence the project this job holds the lease for, so no later job may acquire it until an
   * operator clears the fence with evidence. A no-op if this job's lease has already lapsed and been
   * taken over legitimately — there is nothing left for it to vouch for.
   */
  async _fenceLease(jobId, reason) {
    const job = this.repo.getJob(jobId);
    if (!job?.lease_fencing_token) return;
    const resource = `project-write:${this.config.instanceId}:${job.project_id}`;
    await this.store.transact((tx, state) => {
      this.repo.fenceLease(tx, state, { resource, owner: jobId, fencingToken: job.lease_fencing_token, reason });
    }).catch(() => { /* the lease was already taken over; nothing this job can fence */ });
  }

  /**
   * Acquire the project's write lease, or block the job with the most honest reason available.
   *
   * Distinguishing "fenced" from "held by another job" matters to whoever reads the job's timeline:
   * one is routine contention that clears on its own, the other needs an operator's evidenced
   * decision before anything can write here again.
   */
  async _acquireLeaseOrBlock(jobId, projectId) {
    const lease = await this._acquireLease(jobId, projectId);
    if (lease) return lease;
    const resource = `project-write:${this.config.instanceId}:${projectId}`;
    const fenced = this.repo.getLease(resource)?.fenced;
    const message = fenced
      ? 'the project workspace is fenced pending operator review after a cancellation whose termination could not be confirmed'
      : 'another job holds the write lease for this project';
    await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, { message, detail: message, eventType: EventType.BLOCKED });
    return null;
  }

  /**
   * Fence and quarantine a job whenever a git or check operation reports a kill that could not be
   * confirmed dead — the same treatment an unconfirmed cancellation gets, because a `git` invocation
   * or a project's own verification command is exactly as capable of backgrounding something of its
   * own as the coding CLI is. `terminationConfirmed` is `null` for the overwhelming majority of
   * calls (nothing was ever killed — most git commands succeed, and most checks are simply allowed
   * to fail), so this is a no-op unless it is specifically `false`.
   *
   * Returns `true` when this handled the situation — the caller must stop immediately, exactly like
   * `_stopIfCancelled` — and `false` when there is nothing to act on.
   */
  async _guardTermination(jobId, terminationConfirmed, contextMessage) {
    if (terminationConfirmed !== false) return false;
    await this._fenceLease(jobId, contextMessage);
    const current = this.repo.getJob(jobId);
    if (!TERMINAL_STATES.has(current.status)) {
      await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, {
        message: 'a git or verification command could not be confirmed dead after a timeout or abort',
        detail: contextMessage,
        eventType: EventType.BLOCKED,
        patch: { termination_confirmed: false },
      });
    }
    return true;
  }

  /**
   * Block a job, naming the most specific reason the state machine permits from where it is.
   *
   * `blocked_verification` is only reachable from a verification phase, so a max-turn exit during
   * discovery cannot use it. Falling back to `blocked_project_state` is not a fudge: the honest
   * statement about a phase that did not complete is that the workspace is in an unknown state.
   */
  async _blockWith(jobId, status, detail) {
    const job = this.repo.getJob(jobId);
    const target = canTransition(job.status, status) ? status : JobStatus.BLOCKED_PROJECT_STATE;
    await this._transition(jobId, target, { message: detail, detail, eventType: EventType.BLOCKED });
    await this._releaseLease(jobId);
  }

  async _resume(jobId, reason) {
    const job = this.repo.getJob(jobId);
    if (!job || TERMINAL_STATES.has(job.status)) return;
    // Only resume from a state the machine says may return to the queue. A job blocked on review,
    // for instance, needs a revision or another review — answering an unrelated question must not
    // quietly restart it.
    if (!canTransition(job.status, JobStatus.QUEUED)) return;
    // A job that already has a worker must not get another one.
    if (this._running.has(jobId)) return;
    await this._transition(jobId, JobStatus.QUEUED, { message: `resuming: ${reason}` });
    const project = this._resolveProjectOrThrow(job.project_id);
    this._startWorker(jobId, project);
  }

  /**
   * Reconcile jobs left mid-flight by a restart.
   *
   * A job recorded as `implementing` when the process died is in an unknown state: the phase may
   * have completed, partly completed, or never started — and so may whatever it launched. A restart
   * is an unknown-termination case in exactly the same sense an unconfirmed cancellation is: nothing
   * in this process ever confirmed a descendant tree is dead, because the process that could have is
   * the one that just crashed. It is moved to `blocked_project_state`, but the project's lease is
   * *fenced*, not released — releasing it would let a later job start writing to a workspace a
   * pre-crash descendant might still be editing. Only an explicit, evidenced `clearFence` (via
   * `scripts/pw-orch-clear-fence.mjs`) takes it down; resuming would mean guessing, and so would
   * assuming a restart is proof of anything.
   */
  async reconcileOnStart() {
    const stranded = this.repo.listJobs((j) => WORKSPACE_ACTIVE_STATES.has(j.status));
    for (const job of stranded) {
      // eslint-disable-next-line no-await-in-loop
      await this._fenceLease(
        job.workbench_job_id,
        'the workbench restarted while this job held the workspace; termination cannot be confirmed after a crash',
      );
      // eslint-disable-next-line no-await-in-loop
      await this._transition(job.workbench_job_id, JobStatus.BLOCKED_PROJECT_STATE, {
        message: 'the workbench restarted while this job held the workspace; its state is unknown',
        detail: 'reconciled after a restart: the workspace state is unknown, and the project is fenced pending operator review',
        eventType: EventType.BLOCKED,
        patch: { termination_confirmed: false },
      }).catch(() => { /* a job that already moved on needs no reconciliation */ });
    }
    return stranded.length;
  }
}
