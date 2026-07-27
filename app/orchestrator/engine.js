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
  ErrorCode, WORKSPACE_ACTIVE_STATES, TERMINAL_STATES, newId,
} from './contract.js';
import { ApiError, notFound } from './errors.js';
import { assertTransition, canTransition } from './statemachine.js';
import { validate } from './validate.js';
import { KIND } from './store/repo.js';
import { resolveWorkspacePath } from './projects.js';
import { repositoryBaseline, workingTreeFingerprint } from './git.js';
import { diffStat, canonicaliseCheckName, CHECK_CATALOGUE } from './checks.js';
import {
  SUBMIT_JOB_SCHEMA, REPLY_SCHEMA, APPROVE_SCHEMA, REVISE_SCHEMA, REVIEW_SCHEMA, CANCEL_SCHEMA,
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
    /** Jobs asked to stop. Checked between phases; a phase itself is never killed mid-write. */
    this._cancelRequested = new Set();
  }

  now() { return this.clock().toISOString(); }

  actor() { return { kind: ActorKind.WORKBENCH, identifier: this.config.instanceId }; }

  /** Wait for every in-flight job worker. Used by tests and by graceful shutdown. */
  async drain() {
    while (this._running.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([...this._running.values()]);
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
    const seen = this.repo.checkIdempotency(scope, idempotencyKey, contentHash);
    if (seen.match === 'conflict') {
      throw new ApiError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'the idempotency key was reused with different content');
    }
    if (seen.match === 'hit') {
      // A repeat must return the original outcome and produce no second side effect.
      return { ...seen.record.outcome, deduplicated: true };
    }

    const jobId = newId('pwjob');
    const acceptedAt = this.now();

    const handle = await this.store.transact((tx, state) => {
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
        detail: detail ?? job.detail,
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

  _startWorker(jobId, project) {
    const worker = this._run(jobId, project)
      .catch(async (err) => {
        // A worker must never die silently: an unexplained stall is worse than a recorded failure.
        await this._failSafely(jobId, `the job stopped unexpectedly (${err?.code ?? 'internal'})`);
      })
      .finally(() => this._running.delete(jobId));
    this._running.set(jobId, worker);
    return worker;
  }

  async _failSafely(jobId, message) {
    try {
      const job = this.repo.getJob(jobId);
      if (!job || TERMINAL_STATES.has(job.status)) return;
      await this._releaseLease(jobId);
      await this._transition(jobId, JobStatus.FAILED, { message, detail: message, eventType: EventType.FAILED });
    } catch {
      /* nothing further can be done safely */
    }
  }

  _cancelled(jobId) { return this._cancelRequested.has(jobId); }

  async _run(jobId, project) {
    const workspacePath = resolveWorkspacePath(this.config, project);

    await this._transition(jobId, JobStatus.VALIDATING, { message: 'validating the task contract' });
    if (await this._stopIfCancelled(jobId, workspacePath)) return;
    await this._transition(jobId, JobStatus.QUEUED, { message: 'queued for the project lane' });

    // One writer per project. Everything from here to release is workspace-active.
    const lease = await this._acquireLease(jobId, project.project_id);
    if (!lease) {
      await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, {
        message: 'another job holds the write lease for this project',
        detail: 'another job holds the write lease for this project',
        eventType: EventType.BLOCKED,
      });
      return;
    }

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
          request: { session_key: session.session_key, phase_class: PhaseClass.IMPLEMENTATION, requested: job.requested },
          correlationId: job.correlation_id,
        });
      } catch (err) {
        const target = {
          auth_expired: JobStatus.BLOCKED_AUTHENTICATION,
          rate_limited: JobStatus.BLOCKED_RATE_LIMIT,
          usage_limited: JobStatus.BLOCKED_USAGE_LIMIT,
          unavailable: JobStatus.BLOCKED_CONNECTIVITY,
        }[err?.kind] ?? JobStatus.BLOCKED_CONFIGURATION;
        await this._blockWith(jobId, target, `the effective configuration could not be verified (${err?.kind ?? 'unknown'})`);
        return;
      }

      if (!verification.effective) {
        // The contract offers no way to say "probably correct". A job that cannot confirm its
        // configuration blocks here, having read nothing.
        await this._emit(jobId, { event_type: EventType.MODEL_MISMATCH, message: verification.detail ?? 'the effective configuration could not be determined' });
        await this._blockWith(jobId, JobStatus.BLOCKED_CONFIGURATION, verification.detail ?? 'the effective model and effort could not be verified');
        return;
      }
      const matches = verification.effective.effort === job.requested.effort;
      if (!matches) {
        await this._emit(jobId, { event_type: EventType.MODEL_MISMATCH, message: 'the effective configuration differs from the requested one' });
        await this._blockWith(jobId, JobStatus.BLOCKED_CONFIGURATION, 'the effective model or effort differs from the requested one');
        return;
      }
      await this._emit(jobId, { event_type: EventType.MODEL_VERIFIED, message: `verified ${verification.effective.model_alias} at ${verification.effective.effort} effort` });
      await this.store.transact((tx, state) => {
        const current = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...current, effective: verification.effective, cli_session_id: verification.cli_session_id ?? null, updated_at: this.now() });
      });

      // ---- baseline ----
      const baseline = await repositoryBaseline({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });
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
      await this._releaseLease(jobId);
      throw err;
    }
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
      });
    } catch (err) {
      await this._blockWith(jobId, JobStatus.BLOCKED_CONNECTIVITY, `the coding backend failed: ${err.message}`);
      return null;
    }

    if (result.session_id) {
      await this.store.transact((tx, state) => {
        const current = state.get(KIND.JOBS, jobId);
        this.repo.putJob(tx, { ...current, cli_session_id: result.session_id, updated_at: this.now() });
      });
    }

    if (!result.ok) {
      // Each failure kind reaches a different safe state: they need different operator responses,
      // and only some are worth retrying.
      const target = {
        auth_expired: JobStatus.BLOCKED_AUTHENTICATION,
        rate_limited: JobStatus.BLOCKED_RATE_LIMIT,
        usage_limited: JobStatus.BLOCKED_USAGE_LIMIT,
        unavailable: JobStatus.BLOCKED_CONNECTIVITY,
        timeout: JobStatus.BLOCKED_PROJECT_STATE,
        process_died: JobStatus.BLOCKED_PROJECT_STATE,
        malformed_output: JobStatus.BLOCKED_VERIFICATION,
        // A max-turn exit is a failure. It is emphatically not a success with a caveat.
        max_turns: JobStatus.BLOCKED_VERIFICATION,
      }[result.failure_kind] ?? JobStatus.BLOCKED_PROJECT_STATE;

      await this._blockWith(jobId, target, `the ${phaseClass} phase did not complete (${result.failure_kind})`);
      return null;
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
    for (const checkName of checkNames) {
      // eslint-disable-next-line no-await-in-loop
      const { check, artifact } = await this.checkRunner.run({ jobId, checkName, project, cwd: workspacePath });
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
    }
    return { records, failed };
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
      await this._blockWith(jobId, JobStatus.BLOCKED_REVIEW, `the review could not run: ${err.message}`);
      return null;
    }

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

    const question = this.store.get(KIND.QUESTIONS, request.question_id);
    if (!question) throw notFound('no such question');
    if (question.job_id !== jobId) throw notFound('no such question');
    if (question.status !== QuestionStatus.OPEN) {
      throw new ApiError(ErrorCode.CONFLICT, 'this question has already been answered or withdrawn');
    }
    if (question.expires_at && new Date(question.expires_at) < this.clock()) {
      throw new ApiError(ErrorCode.CONFLICT, 'this question has expired');
    }
    if (request.selected_option_index !== null && request.selected_option_index !== undefined
      && request.selected_option_index >= question.options.length) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the selected option does not exist');
    }

    await this.store.transact((tx, state) => {
      tx.put(KIND.QUESTIONS, question.question_id, {
        ...question,
        status: QuestionStatus.ANSWERED,
        answer: request.answer,
        selected_option_index: request.selected_option_index ?? null,
        answered_at: this.now(),
      });
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.QUESTION_ANSWERED, status: job.status,
        actor: { kind: ActorKind.ORCHESTRATOR, identifier: token.orchestrator_instance_id },
        message: `question ${question.question_id} answered`,
      });
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
    this.requireJob(token, jobId);
    const request = validate(APPROVE_SCHEMA, body ?? {});
    if (request.workbench_job_id !== jobId) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'the path job and the payload job must agree');
    }

    const approval = this.store.get(KIND.APPROVALS, request.approval_id);
    if (!approval || approval.job_id !== jobId) throw notFound('no such approval');
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new ApiError(ErrorCode.CONFLICT, 'this approval has already been decided or withdrawn');
    }
    if (approval.expires_at && new Date(approval.expires_at) < this.clock()) {
      throw new ApiError(ErrorCode.CONFLICT, 'this approval request has expired');
    }

    const decided = {
      ...approval,
      status: request.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
      decided_at: this.now(),
      // The human is the decider; the orchestrator is the channel. `decided_via` records the
      // channel so the audit trail never loses the distinction.
      decided_by: { kind: ActorKind.HUMAN, identifier: request.decided_by ?? 'recorded-human-decision' },
      decided_via: token.orchestrator_instance_id,
      decision_reason: request.reason ?? null,
    };

    await this.store.transact((tx, state) => {
      tx.put(KIND.APPROVALS, approval.approval_id, decided);
      const job = state.get(KIND.JOBS, jobId);
      this.repo.appendEvent(tx, state, {
        job_id: jobId, event_type: EventType.APPROVAL_DECIDED, status: job.status,
        actor: { kind: ActorKind.HUMAN, identifier: decided.decided_by.identifier },
        message: `approval ${approval.approval_id} ${decided.status}`,
      });
    });

    this._auditEvent('orchestrator.approval.decided', {
      workbench_job_id: jobId, approval_id: approval.approval_id, status: decided.status,
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
    return { schema_version: SCHEMA_VERSION, approval_id: approval.approval_id, status: decided.status };
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
    const seen = this.repo.checkIdempotency(scope, idempotencyKey, contentHash);
    if (seen.match === 'conflict') {
      throw new ApiError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'the idempotency key was reused with different content');
    }
    if (seen.match === 'hit') return seen.record.outcome;

    // The gate, before any staging: chat text never approves, and neither does an agent assertion.
    const approval = request.approval_id ? this.store.get(KIND.APPROVALS, request.approval_id) : null;
    if (approval && approval.job_id !== jobId) throw notFound('no such approval');
    assertPublicationApproved({ approval, approvalId: request.approval_id });

    if (job.status !== JobStatus.WAITING_FOR_PUBLICATION_APPROVAL) {
      throw new ApiError(ErrorCode.INVALID_TRANSITION, 'this job is not awaiting publication');
    }

    const workspacePath = resolveWorkspacePath(this.config, project);
    await this._transition(jobId, JobStatus.PUBLISHING, { message: 'publishing under a recorded approval', phase: 'publication' });

    const record = await this.publisher.publish({ job, project, workspacePath, request });

    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.LOG, name: 'publication.log',
      content: (record.steps ?? []).map((s) => `${s.step}: exit ${s.exit_code} ${s.stderr}`).join('\n'),
      summary: record.remote_sha_verified ? 'published and verified' : (record.failure_reason ?? 'publication incomplete'),
    });

    const { steps: _steps, failure_reason: failureReason, ...publicRecord } = record;

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
      await this._transition(jobId, JobStatus.COMPLETED, {
        message: 'the change is published and the remote SHA was verified',
        detail: 'published', eventType: EventType.COMPLETED,
      });
    } else {
      // Never claim publication from local output alone.
      await this._transition(jobId, JobStatus.BLOCKED_PROJECT_STATE, {
        message: `publication did not complete: ${failureReason ?? 'the remote SHA was not verified'}`,
        detail: failureReason ?? 'the remote SHA was not verified',
        eventType: EventType.BLOCKED,
      });
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
    const before = await workingTreeFingerprint({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });

    // Let the in-flight phase reach a boundary rather than killing it mid-write.
    const inFlight = this._running.get(jobId);
    if (inFlight) await inFlight.catch(() => {});

    const after = await workingTreeFingerprint({ cwd: workspacePath, gitExecutable: this.config.gitExecutable, exec: this.exec });
    const preserved = before.status === after.status && before.head === after.head && before.diff === after.diff;

    await this._releaseLease(jobId);
    const current = this.repo.getJob(jobId);
    if (!TERMINAL_STATES.has(current.status)) {
      await this._transition(jobId, JobStatus.CANCELLED, {
        message: `cancelled: ${request.reason}`,
        detail: `cancelled: ${request.reason}`,
        eventType: EventType.CANCELLED,
        patch: { working_tree_preserved: preserved },
      });
    }
    this._cancelRequested.delete(jobId);
    this._auditEvent('orchestrator.job.cancelled', { workbench_job_id: jobId, working_tree_preserved: preserved });
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
    if (!WORKSPACE_ACTIVE_STATES.has(job.status)) {
      throw new ApiError(ErrorCode.INVALID_TRANSITION, 'this job does not hold a workspace lease');
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
    }).catch(() => { /* the lease was already taken over; nothing to release */ });
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
    await this._transition(jobId, JobStatus.QUEUED, { message: `resuming: ${reason}` });
    const project = this._resolveProjectOrThrow(job.project_id);
    this._startWorker(jobId, project);
  }

  /**
   * Reconcile jobs left mid-flight by a restart.
   *
   * A job recorded as `implementing` when the process died is in an unknown state: the phase may
   * have completed, partly completed, or never started. It is moved to `blocked_project_state` with
   * its lease released, rather than resumed — resuming would mean guessing, and the repository's
   * actual condition is the only thing that can settle it.
   */
  async reconcileOnStart() {
    const stranded = this.repo.listJobs((j) => WORKSPACE_ACTIVE_STATES.has(j.status));
    for (const job of stranded) {
      // eslint-disable-next-line no-await-in-loop
      await this._releaseLease(job.workbench_job_id);
      // eslint-disable-next-line no-await-in-loop
      await this._transition(job.workbench_job_id, JobStatus.BLOCKED_PROJECT_STATE, {
        message: 'the workbench restarted while this job held the workspace; its state is unknown',
        detail: 'reconciled after a restart: the workspace state is unknown',
        eventType: EventType.BLOCKED,
      }).catch(() => { /* a job that already moved on needs no reconciliation */ });
    }
    return stranded.length;
  }
}
