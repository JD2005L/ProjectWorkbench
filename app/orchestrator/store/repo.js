// Domain repositories over the durable journal store.
//
// Everything the contract calls a record — jobs, events, questions, approvals, checks, reviews,
// artifacts, publications, sessions, idempotency keys, leases, audit rows — is stored here, and the
// contract's *invariants* are enforced at write time rather than at render time. An event that
// claims a check passed without carrying evidence is rejected before it reaches the journal, so a
// bare claim can never be read back later as though it had been corroborated.
//
// All mutating helpers take `(tx, state)` from `JournalStore.transact`, so a caller composes several
// of them into one atomic batch: a state change, its timeline event, and its audit row commit
// together or not at all. That is what makes "a crash cannot leave a job in a state that no record
// explains" true rather than aspirational.

import {
  SCHEMA_VERSION,
  MAX_LIST_ITEMS,
  EventType,
  EVIDENCE_REQUIRING_EVENTS,
  ErrorCode,
  newId,
} from '../contract.js';
import { ApiError } from '../errors.js';
import { redactText, redactDeep } from '../redact.js';

/** Journal kinds. Named as constants so a typo is a reference error, not a silent empty list. */
export const KIND = Object.freeze({
  JOBS: 'jobs',
  EVENTS: 'events',
  SESSIONS: 'sessions',
  QUESTIONS: 'questions',
  APPROVALS: 'approvals',
  CHECKS: 'checks',
  REVIEWS: 'reviews',
  ARTIFACTS: 'artifacts',
  PUBLICATIONS: 'publications',
  IDEMPOTENCY: 'idempotency',
  LEASES: 'leases',
  FENCING: 'fencing',
});

const DEFAULT_LEASE_TTL_MS = 300_000;

/** Evidence corroborates something only if it actually carries a fact. */
function evidenceIsPresent(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  return ['command', 'exit_code', 'passed', 'failed', 'artifact_id', 'excerpt']
    .some((key) => evidence[key] !== undefined && evidence[key] !== null);
}

export class OrchestratorRepository {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  now() {
    return this.clock().toISOString();
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  /**
   * Append one timeline event, assigning its durable per-job sequence.
   *
   * The sequence is allocated *inside* the caller's transaction, which is what lets it double as an
   * SSE resume cursor: it is gapless because a rejected event never reaches this point, and it is
   * durable because it commits with the record it numbers.
   */
  appendEvent(tx, state, event) {
    const eventType = event.event_type;

    if (EVIDENCE_REQUIRING_EVENTS.has(eventType)) {
      const corroborated = evidenceIsPresent(event.evidence) || (event.artifact_ids?.length > 0);
      if (!corroborated) {
        throw new ApiError(
          ErrorCode.VALIDATION_FAILED,
          `event type '${eventType}' asserts progress and requires evidence or an artifact reference`,
        );
      }
    }
    if (eventType === EventType.HEARTBEAT && event.evidence != null) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'a heartbeat must not carry evidence');
    }
    if (eventType === EventType.STATE_CHANGED && !event.previous_status) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, 'a state change must record the previous status');
    }

    const sequence = tx.nextSequence(`events:${event.job_id}`);
    const previousStatus = event.previous_status ?? null;
    const evidence = event.evidence
      ? { schema_version: SCHEMA_VERSION, ...redactDeep(event.evidence) }
      : null;

    const record = {
      schema_version: SCHEMA_VERSION,
      job_id: event.job_id,
      sequence,
      timestamp: event.timestamp ?? this.now(),
      event_type: eventType,
      status: event.status,
      previous_status: previousStatus,
      phase: event.phase ?? null,
      actor: { schema_version: SCHEMA_VERSION, ...event.actor },
      // ProjectWorkbench holds the raw material, so it redacts first. The orchestrator redacts
      // again on receipt, but by then a leak has already crossed a service boundary.
      message: redactText(String(event.message ?? ''), { maxLength: 2_000 }),
      evidence,
      artifact_ids: (event.artifact_ids ?? []).slice(0, MAX_LIST_ITEMS),
      correlation_id: event.correlation_id ?? null,
      // Whether this event should reset a stall timer. A heartbeat never does; a state change or
      // real evidence always does.
      counts_as_progress:
        eventType !== EventType.HEARTBEAT
        && ((previousStatus !== null && previousStatus !== event.status) || evidenceIsPresent(evidence)),
    };

    tx.put(KIND.EVENTS, `${event.job_id}:${String(sequence).padStart(12, '0')}`, record);
    return record;
  }

  listEvents(jobId, { afterSequence = 0, limit = 100 } = {}) {
    return this.store
      .list(KIND.EVENTS, (e) => e.job_id === jobId && e.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
  }

  latestSequence(jobId) {
    return this.store.counter(`events:${jobId}`);
  }

  // -------------------------------------------------------------------------
  // generic record access
  // -------------------------------------------------------------------------

  getJob(jobId) { return this.store.get(KIND.JOBS, jobId); }

  listJobs(filter = null) { return this.store.list(KIND.JOBS, filter); }

  putJob(tx, job) { tx.put(KIND.JOBS, job.workbench_job_id, job); return job; }

  getSession(sessionKey) { return this.store.get(KIND.SESSIONS, sessionKey); }

  putSession(tx, session) { tx.put(KIND.SESSIONS, session.session_key, session); return session; }

  listForJob(kind, jobId) {
    return this.store.list(kind, (r) => r.job_id === jobId);
  }

  // -------------------------------------------------------------------------
  // idempotency
  // -------------------------------------------------------------------------

  /**
   * Look up a previous outcome for an idempotency key.
   *
   * Returns `{ match, record }`: `match: 'hit'` when the same key arrived with the same content and
   * the original outcome should be replayed, `match: 'conflict'` when the key was reused with
   * different content — which is a caller bug and must never silently create a second side effect.
   */
  checkIdempotency(scope, key, contentHash) {
    const record = this.store.get(KIND.IDEMPOTENCY, `${scope}:${key}`);
    if (!record) return { match: 'miss', record: null };
    if (record.content_hash !== contentHash) return { match: 'conflict', record };
    return { match: 'hit', record };
  }

  recordIdempotency(tx, scope, key, contentHash, outcome) {
    tx.put(KIND.IDEMPOTENCY, `${scope}:${key}`, {
      schema_version: SCHEMA_VERSION,
      scope,
      key,
      content_hash: contentHash,
      outcome,
      recorded_at: this.now(),
    });
  }

  // -------------------------------------------------------------------------
  // leases and fencing
  // -------------------------------------------------------------------------

  getLease(resource) { return this.store.get(KIND.LEASES, resource); }

  /**
   * Acquire (or re-enter) a lease.
   *
   * A plain mutex is not enough here. A holder can be paused past its expiry by a container freeze
   * or a long GC, wake believing it still holds the lease, and issue a write after someone else
   * took over. Expiry alone cannot prevent that, because the stale holder's own clock comparison
   * may be the one that is wrong. The fencing token can: it rises on every acquisition, is never
   * reused, and is carried on every side effect.
   */
  acquireLease(tx, state, { resource, owner, ttlMs = DEFAULT_LEASE_TTL_MS }) {
    const now = this.clock();
    const existing = state.get(KIND.LEASES, resource);

    if (existing && existing.owner !== owner && new Date(existing.expires_at) > now) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        `the write lease for this project is held by another owner until ${existing.expires_at}`,
      );
    }

    // A re-entrant acquire by the current holder keeps its token: burning a token on every retry
    // would fence the holder out of its own in-flight work.
    const reentrant = existing && existing.owner === owner && new Date(existing.expires_at) > now;
    const fencingToken = reentrant ? existing.fencing_token : tx.nextSequence(`lease:${resource}`);

    const lease = {
      schema_version: SCHEMA_VERSION,
      resource,
      owner,
      fencing_token: fencingToken,
      acquired_at: reentrant ? existing.acquired_at : now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      renewed_at: now.toISOString(),
    };
    tx.put(KIND.LEASES, resource, lease);
    return lease;
  }

  /** Extend a lease the caller still legitimately holds. */
  renewLease(tx, state, { resource, owner, fencingToken, ttlMs = DEFAULT_LEASE_TTL_MS }) {
    const existing = state.get(KIND.LEASES, resource);
    if (!existing || existing.owner !== owner || existing.fencing_token !== fencingToken) {
      throw new ApiError(ErrorCode.LEASE_LOST, 'the renewing worker is not the lease holder');
    }
    const now = this.clock();
    const lease = {
      ...existing,
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      renewed_at: now.toISOString(),
    };
    tx.put(KIND.LEASES, resource, lease);
    return lease;
  }

  releaseLease(tx, state, { resource, owner, fencingToken }) {
    const existing = state.get(KIND.LEASES, resource);
    if (!existing) return;
    if (existing.owner !== owner || existing.fencing_token !== fencingToken) {
      throw new ApiError(ErrorCode.LEASE_LOST, 'the releasing worker is not the lease holder');
    }
    // The record stays, marked released, so the *counter* keeps rising and a released token can
    // never be reissued to a later holder.
    tx.put(KIND.LEASES, resource, { ...existing, released_at: this.clock().toISOString(), expires_at: existing.acquired_at });
  }

  /** Reject any operation carrying a token lower than the one currently accepted. */
  assertFencing(state, resource, token) {
    const existing = (state.get ? state.get(KIND.LEASES, resource) : null);
    if (!existing) return;
    if (token < existing.fencing_token) {
      throw new ApiError(ErrorCode.LEASE_LOST, 'the operation carries a fencing token older than the accepted one');
    }
  }

  // -- the orchestrator's own submitted fencing token (contract §7) ----------

  acceptedFencingToken(projectId) {
    return this.store.get(KIND.FENCING, projectId)?.token ?? 0;
  }

  /**
   * Record the fencing token carried by an orchestrator submission.
   *
   * This is what stops a stalled orchestrator process, revived after its lease was taken over, from
   * issuing a write. Equal tokens are accepted: that is a legitimate retry of the same submission,
   * not a stale writer.
   */
  acceptOrchestratorFencing(tx, state, { projectId, token }) {
    const current = state.get(KIND.FENCING, projectId)?.token ?? 0;
    if (token < current) {
      throw new ApiError(ErrorCode.LEASE_LOST, 'the submitted fencing token is older than the accepted one');
    }
    if (token > current) {
      tx.put(KIND.FENCING, projectId, {
        schema_version: SCHEMA_VERSION,
        project_id: projectId,
        token,
        accepted_at: this.now(),
      });
    }
    return token;
  }

  // -------------------------------------------------------------------------
  // artifacts
  // -------------------------------------------------------------------------

  putArtifact(tx, artifact) {
    tx.put(KIND.ARTIFACTS, artifact.artifact_id, artifact);
    return artifact;
  }

  getArtifact(artifactId) { return this.store.get(KIND.ARTIFACTS, artifactId); }

  newArtifactId() { return newId('pwart'); }
}
