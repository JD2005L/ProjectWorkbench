// The job state machine.
//
// The transition table is the single authority on what a job may do next, and it is declared
// explicitly rather than derived from convenience rules, because "what is this job allowed to do" is
// a safety question. The edge that matters most: `blocked_configuration` may only resume through
// session setup and backend verification, never straight into a coding phase — that is what stops
// work beginning on a model and effort nobody verified.
//
// This table mirrors PVICodingOrchestrator's `state/machine.py` edge for edge. Both sides must agree
// on what `invalid_transition` means, or a legal orchestrator request would be refused here (or
// worse, an illegal one accepted).

import { ApiError } from './errors.js';
import { ErrorCode, JobStatus, TERMINAL_STATES } from './contract.js';

/** Terminal outcomes reachable from *any* non-terminal state. */
export const UNIVERSAL_TERMINAL_TARGETS = Object.freeze(new Set([
  JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.EXPIRED, JobStatus.SUPERSEDED,
]));

/**
 * Conditions that can interrupt any phase talking to a coding backend.
 *
 * `blocked_project_state` belongs here because the workspace can become unusable at any point — a
 * lease lost to another writer, a dirty tree discovered mid-phase, or a restart that leaves the
 * workspace state unknown. Restart reconciliation depends on that edge existing from every phase
 * that could have been holding the workspace.
 */
const INTERRUPTIONS = [
  JobStatus.WAITING_FOR_INPUT, JobStatus.WAITING_FOR_APPROVAL,
  JobStatus.BLOCKED_AUTHENTICATION, JobStatus.BLOCKED_RATE_LIMIT, JobStatus.BLOCKED_USAGE_LIMIT,
  JobStatus.BLOCKED_CONNECTIVITY, JobStatus.BLOCKED_CONFIGURATION, JobStatus.BLOCKED_PROJECT_STATE,
];

/** Phases a job may be resumed into once a block clears. Resumption never jumps forward. */
const RESUME_TARGETS = [
  JobStatus.QUEUED, JobStatus.ENSURING_PROJECT_SESSION, JobStatus.VERIFYING_BACKEND,
];

const EXPLICIT = new Map([
  // ---- intake ----
  [JobStatus.RECEIVED, [JobStatus.VALIDATING]],
  [JobStatus.VALIDATING, [
    JobStatus.QUEUED, JobStatus.BLOCKED_CONFIGURATION, JobStatus.BLOCKED_PROJECT_STATE,
    JobStatus.WAITING_FOR_INPUT,
  ]],
  [JobStatus.QUEUED, [JobStatus.ENSURING_PROJECT_SESSION, ...INTERRUPTIONS]],

  // ---- session and backend readiness ----
  [JobStatus.ENSURING_PROJECT_SESSION, [
    JobStatus.VERIFYING_BACKEND, JobStatus.BLOCKED_PROJECT_STATE, ...INTERRUPTIONS,
  ]],
  // The only forward edge out of verification is discovery, taken solely when the effective model
  // and effort matched policy. A mismatch or an unverifiable answer goes to blocked_configuration.
  [JobStatus.VERIFYING_BACKEND, [JobStatus.DISCOVERING, ...INTERRUPTIONS]],

  // ---- exploration and planning ----
  [JobStatus.DISCOVERING, [
    JobStatus.PLANNING, JobStatus.IMPLEMENTING, JobStatus.BLOCKED_PROJECT_STATE, ...INTERRUPTIONS,
  ]],
  [JobStatus.PLANNING, [JobStatus.WAITING_FOR_PLAN_APPROVAL, JobStatus.IMPLEMENTING, ...INTERRUPTIONS]],
  [JobStatus.WAITING_FOR_PLAN_APPROVAL, [JobStatus.IMPLEMENTING, JobStatus.PLANNING, JobStatus.QUEUED]],

  // ---- implementation and verification ----
  [JobStatus.IMPLEMENTING, [JobStatus.VERIFYING_TARGETED, JobStatus.BLOCKED_PROJECT_STATE, ...INTERRUPTIONS]],
  [JobStatus.VERIFYING_TARGETED, [
    JobStatus.VERIFYING_FULL, JobStatus.REVISION_REQUIRED, JobStatus.BLOCKED_VERIFICATION, ...INTERRUPTIONS,
  ]],
  [JobStatus.VERIFYING_FULL, [
    JobStatus.REVIEWING, JobStatus.REVISION_REQUIRED, JobStatus.BLOCKED_VERIFICATION, ...INTERRUPTIONS,
  ]],
  [JobStatus.BLOCKED_VERIFICATION, [JobStatus.REVISION_REQUIRED, JobStatus.QUEUED]],

  // ---- independent review ----
  // Review may complete a job outright when publication was never requested.
  [JobStatus.REVIEWING, [
    JobStatus.WAITING_FOR_PUBLICATION_APPROVAL, JobStatus.PUBLISHING, JobStatus.REVISION_REQUIRED,
    JobStatus.BLOCKED_REVIEW, JobStatus.COMPLETED, ...INTERRUPTIONS,
  ]],
  [JobStatus.BLOCKED_REVIEW, [JobStatus.REVISION_REQUIRED, JobStatus.REVIEWING]],
  // A bounded correction cycle re-enters implementation; the cycle counter, not the state machine,
  // is what stops it looping forever.
  [JobStatus.REVISION_REQUIRED, [JobStatus.IMPLEMENTING, ...INTERRUPTIONS]],

  // ---- publication ----
  [JobStatus.WAITING_FOR_PUBLICATION_APPROVAL, [JobStatus.PUBLISHING, JobStatus.COMPLETED]],
  [JobStatus.PUBLISHING, [JobStatus.COMPLETED, ...INTERRUPTIONS]],

  // ---- blocked conditions and their resumptions ----
  [JobStatus.WAITING_FOR_INPUT, [
    ...RESUME_TARGETS, JobStatus.DISCOVERING, JobStatus.PLANNING, JobStatus.IMPLEMENTING,
    JobStatus.VERIFYING_TARGETED, JobStatus.VERIFYING_FULL, JobStatus.REVIEWING, JobStatus.PUBLISHING,
  ]],
  [JobStatus.WAITING_FOR_APPROVAL, [
    ...RESUME_TARGETS, JobStatus.IMPLEMENTING, JobStatus.VERIFYING_FULL, JobStatus.REVIEWING,
    JobStatus.PUBLISHING,
  ]],
  [JobStatus.BLOCKED_AUTHENTICATION, RESUME_TARGETS],
  [JobStatus.BLOCKED_RATE_LIMIT, RESUME_TARGETS],
  [JobStatus.BLOCKED_USAGE_LIMIT, RESUME_TARGETS],
  [JobStatus.BLOCKED_CONNECTIVITY, RESUME_TARGETS],
  // A configuration block — including a model/effort mismatch — may only resume through session
  // setup and backend verification. It can never reach a coding phase directly.
  [JobStatus.BLOCKED_CONFIGURATION, RESUME_TARGETS],
  [JobStatus.BLOCKED_PROJECT_STATE, RESUME_TARGETS],

  // ---- terminal ----
  [JobStatus.COMPLETED, []],
  [JobStatus.FAILED, []],
  [JobStatus.CANCELLED, []],
  [JobStatus.EXPIRED, []],
  [JobStatus.SUPERSEDED, []],
]);

function buildTable() {
  const table = new Map();
  for (const status of Object.values(JobStatus)) {
    const explicit = EXPLICIT.get(status);
    if (explicit === undefined) throw new Error(`job state '${status}' has no transition entry`);
    if (TERMINAL_STATES.has(status)) {
      if (explicit.length) throw new Error(`terminal state '${status}' must have no outgoing edges`);
      table.set(status, Object.freeze(new Set()));
    } else {
      table.set(status, Object.freeze(new Set([...explicit, ...UNIVERSAL_TERMINAL_TARGETS])));
    }
  }
  return table;
}

/** `current status -> permitted next statuses`. Terminal states map to the empty set. */
export const ALLOWED_TRANSITIONS = buildTable();

export function canTransition(current, requested) {
  if (current === requested) return true; // an idempotent re-assertion of the same state
  return Boolean(ALLOWED_TRANSITIONS.get(current)?.has(requested));
}

/** Assert a transition, raising the contract's `invalid_transition` (409) when it is not legal. */
export function assertTransition(current, requested) {
  if (!ALLOWED_TRANSITIONS.has(requested)) {
    throw new ApiError(ErrorCode.INVALID_TRANSITION, `unknown target state '${requested}'`);
  }
  if (!canTransition(current, requested)) {
    throw new ApiError(
      ErrorCode.INVALID_TRANSITION,
      `a job in '${current}' may not move to '${requested}'`,
    );
  }
}

/** The states a job may legally reach right now — used by the API to explain a refusal safely. */
export function allowedFrom(current) {
  return [...(ALLOWED_TRANSITIONS.get(current) ?? [])].sort();
}
