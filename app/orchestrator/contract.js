// The ProjectWorkbench side of the orchestration contract, version 1.0.
//
// This module is the shared vocabulary: schema version, bounded primitive patterns, every enum, the
// job-state families, and the §5 lane-naming derivations. It is a direct transcription of the
// normative Pydantic contracts in PVICodingOrchestrator (contracts/*.py, workbench/protocol.py).
// Anything that differs here is a defect on the ProjectWorkbench side, so the test suite asserts
// these vocabularies member-for-member rather than merely spot-checking them.
//
// Nothing in this file is environment-specific. No path, hostname, instance id, or project name
// appears; those all live in config.js and are supplied by the operator.

import crypto from 'crypto';

/** The wire/storage contract version this build speaks. */
export const SCHEMA_VERSION = '1.0';

/**
 * Contract versions accepted on inbound payloads. A different *major* is refused, not probed.
 *
 * Attestation provenance is native to 1.0: `SessionVerificationResponse` carries a
 * `SettingsAttestation` whose fields each declare how they are known, and `effective` is derived
 * from it rather than sent. A payload carrying `effective` with no attestation is refused on the
 * other side rather than read as an observation.
 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(new Set(['1.0']));

/**
 * The attestation contract version this build implements, carried on every LaunchAttestation.
 *
 * A peer below the current version never made these checks, so its payload cannot be read as though
 * it had — which is why the version travels with the evidence rather than with the envelope.
 */
export const PROVENANCE_SCHEMA_VERSION = '1.1';

/**
 * How ProjectWorkbench knows an effective setting.
 *
 * The whole point of naming this is that the two are not equivalent, and a consumer deciding
 * whether to trust a job should be able to tell them apart:
 *
 *   * `runtime_reported` — the running backend reported the value in its own structured output, and
 *     it was normalised through an explicit alias mapping. This is an observation.
 *   * `launch_enforced` — ProjectWorkbench owns the argv, verified against the exact configured
 *     binary's fingerprint that it declares the option and the value, saw no warning that the
 *     option was ignored, and bound the evidence to this run. This is control, not observation.
 *     It is weaker: it says what was asked for and that the program said it understood, not what
 *     the program then did.
 *   * `unavailable` — neither. The setting is not effective and the job blocks.
 */
export const Provenance = Object.freeze({
  RUNTIME_REPORTED: 'runtime_reported',
  LAUNCH_ENFORCED: 'launch_enforced',
  UNAVAILABLE: 'unavailable',
});

/**
 * Weakest first. A record is described by its WEAKEST field, never its strongest — describing it by
 * the strongest would let one observed value launder an unobserved one. Mirrors `_PROVENANCE_STRENGTH`
 * and `weaker()` in the orchestrator's policy contracts.
 */
const PROVENANCE_STRENGTH = Object.freeze({
  [Provenance.UNAVAILABLE]: 0,
  [Provenance.LAUNCH_ENFORCED]: 1,
  [Provenance.RUNTIME_REPORTED]: 2,
});

export function weakerProvenance(left, right) {
  return PROVENANCE_STRENGTH[left] <= PROVENANCE_STRENGTH[right] ? left : right;
}

/** How the coding CLI is authenticated. `api_key` exists so it can be named and refused. */
export const AuthMode = Object.freeze({ SUBSCRIPTION: 'subscription', API_KEY: 'api_key' });

/** The attestation contract this build implements, as carried on LaunchAttestation. */
export const ATTESTATION_CONTRACT_VERSION = '1.1';

/**
 * Identifies the fixed server-side argv builder that produced a command line.
 *
 * Not a free-form name: the orchestrator holds an allowlist (`TRUSTED_ARGV_BUILDERS`) and refuses a
 * launch attestation naming anything outside it, because "a fixed builder produced this" is only
 * worth something if the party being told knows which builder. A locally chosen id was schema-valid
 * and refused by the policy validator, so every enforced attestation would have been rejected in
 * production while every shape-level test passed. Changing it is a coordinated contract change.
 */
export const ARGV_BUILDER_ID = 'pw-fixed-argv-v1';

/** Default cap on repeated contract fields. */
export const MAX_LIST_ITEMS = 50;

/** Bounded text lengths, matching contracts/common.py. */
export const TEXT_LIMITS = Object.freeze({
  shortText: 200,
  mediumText: 2_000,
  longText: 20_000,
  criterionText: 1_000,
  slug: 100,
  identifier: 128,
  relativePath: 512,
  modelAlias: 120,
  branch: 200,
});

/** Bounded scalar patterns, matching contracts/common.py and publication.py. */
export const PATTERNS = Object.freeze({
  // Deliberately excludes '/' and '\' so a slug can never be joined into a traversing path.
  slug: /^[A-Za-z0-9._-]+$/,
  identifier: /^[A-Za-z0-9:._-]+$/,
  modelAlias: /^[A-Za-z0-9._-]+$/,
  gitSha: /^[a-f0-9]{40}$/,
  branch: /^[A-Za-z0-9._/-]+$/,
  mediaType: /^[\w.+-]+\/[\w.+-]+$/,
  schemaVersion: /^\d+\.\d+$/,
  idPrefix: /^[a-z][a-z0-9_]{0,15}$/,
  // The envelope constrains the nonce to an ASCII alphabet, not merely to a length: a non-ASCII
  // value reaching `hmac.compare_digest` on the far side raises TypeError, which escaped every
  // handler and stranded the job mid-verification. This service echoes the caller's nonce, so it
  // must refuse anything it cannot legally echo. Length is enforced alongside, in TEXT_LIMITS.
  verificationNonce: /^[A-Za-z0-9_-]+$/,
});

/** The nonce length the contract accepts. Below it a value is guessable; above it, refused. */
export const VERIFICATION_NONCE_LENGTH = Object.freeze({ min: 16, max: 128 });

// ---------------------------------------------------------------------------
// Job lifecycle vocabulary (contracts/states.py)
// ---------------------------------------------------------------------------

export const JobStatus = Object.freeze({
  RECEIVED: 'received',
  VALIDATING: 'validating',
  QUEUED: 'queued',
  ENSURING_PROJECT_SESSION: 'ensuring_project_session',
  VERIFYING_BACKEND: 'verifying_backend',
  DISCOVERING: 'discovering',
  PLANNING: 'planning',
  WAITING_FOR_PLAN_APPROVAL: 'waiting_for_plan_approval',
  IMPLEMENTING: 'implementing',
  VERIFYING_TARGETED: 'verifying_targeted',
  VERIFYING_FULL: 'verifying_full',
  REVIEWING: 'reviewing',
  REVISION_REQUIRED: 'revision_required',
  WAITING_FOR_PUBLICATION_APPROVAL: 'waiting_for_publication_approval',
  PUBLISHING: 'publishing',

  WAITING_FOR_INPUT: 'waiting_for_input',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  BLOCKED_AUTHENTICATION: 'blocked_authentication',
  BLOCKED_RATE_LIMIT: 'blocked_rate_limit',
  BLOCKED_USAGE_LIMIT: 'blocked_usage_limit',
  BLOCKED_CONFIGURATION: 'blocked_configuration',
  BLOCKED_PROJECT_STATE: 'blocked_project_state',
  BLOCKED_VERIFICATION: 'blocked_verification',
  BLOCKED_REVIEW: 'blocked_review',
  BLOCKED_CONNECTIVITY: 'blocked_connectivity',

  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
});

export const PROGRESS_STATES = Object.freeze(new Set([
  JobStatus.RECEIVED, JobStatus.VALIDATING, JobStatus.QUEUED,
  JobStatus.ENSURING_PROJECT_SESSION, JobStatus.VERIFYING_BACKEND, JobStatus.DISCOVERING,
  JobStatus.PLANNING, JobStatus.IMPLEMENTING, JobStatus.VERIFYING_TARGETED,
  JobStatus.VERIFYING_FULL, JobStatus.REVIEWING, JobStatus.REVISION_REQUIRED,
  JobStatus.PUBLISHING,
]));

// The approval waits sit in the progress chain visually but are classified blocked: nothing
// advances until a human decides. This mirrors states.py exactly.
export const BLOCKED_STATES = Object.freeze(new Set([
  JobStatus.WAITING_FOR_PLAN_APPROVAL, JobStatus.WAITING_FOR_PUBLICATION_APPROVAL,
  JobStatus.WAITING_FOR_INPUT, JobStatus.WAITING_FOR_APPROVAL,
  JobStatus.BLOCKED_AUTHENTICATION, JobStatus.BLOCKED_RATE_LIMIT, JobStatus.BLOCKED_USAGE_LIMIT,
  JobStatus.BLOCKED_CONFIGURATION, JobStatus.BLOCKED_PROJECT_STATE,
  JobStatus.BLOCKED_VERIFICATION, JobStatus.BLOCKED_REVIEW, JobStatus.BLOCKED_CONNECTIVITY,
]));

export const TERMINAL_STATES = Object.freeze(new Set([
  JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.EXPIRED,
  JobStatus.SUPERSEDED,
]));

/** States in which a write lease may be held. Cancellation from one of these preserves the tree. */
export const WORKSPACE_ACTIVE_STATES = Object.freeze(new Set([
  JobStatus.ENSURING_PROJECT_SESSION, JobStatus.VERIFYING_BACKEND, JobStatus.DISCOVERING,
  JobStatus.PLANNING, JobStatus.IMPLEMENTING, JobStatus.VERIFYING_TARGETED,
  JobStatus.VERIFYING_FULL, JobStatus.REVIEWING, JobStatus.PUBLISHING,
]));

// Import-time invariant: a status added without being classified is a bug that must fail loudly
// rather than silently behave as "active".
{
  const classified = new Set([...PROGRESS_STATES, ...BLOCKED_STATES, ...TERMINAL_STATES]);
  const unclassified = Object.values(JobStatus).filter((s) => !classified.has(s));
  if (unclassified.length) throw new Error(`unclassified job states: ${unclassified.sort().join(', ')}`);
}

export function statusClass(status) {
  if (TERMINAL_STATES.has(status)) return 'terminal';
  if (BLOCKED_STATES.has(status)) return 'blocked';
  return 'active';
}

export const isTerminal = (status) => TERMINAL_STATES.has(status);
export const isBlocked = (status) => BLOCKED_STATES.has(status);
export const isActive = (status) => PROGRESS_STATES.has(status);

// ---------------------------------------------------------------------------
// Events (contracts/events.py)
// ---------------------------------------------------------------------------

export const EventType = Object.freeze({
  JOB_SUBMITTED: 'job_submitted',
  STATE_CHANGED: 'state_changed',
  SESSION_READY: 'session_ready',
  MODEL_VERIFIED: 'model_verified',
  MODEL_MISMATCH: 'model_mismatch',
  PHASE_STARTED: 'phase_started',
  PHASE_COMPLETED: 'phase_completed',
  CHECK_COMPLETED: 'check_completed',
  DIFF_OBSERVED: 'diff_observed',
  REVIEW_COMPLETED: 'review_completed',
  QUESTION_RAISED: 'question_raised',
  QUESTION_ANSWERED: 'question_answered',
  APPROVAL_REQUESTED: 'approval_requested',
  APPROVAL_DECIDED: 'approval_decided',
  ARTIFACT_RECORDED: 'artifact_recorded',
  PUBLICATION_RECORDED: 'publication_recorded',
  DEPLOYMENT_RECORDED: 'deployment_recorded',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  COMPLETED: 'completed',
  HEARTBEAT: 'heartbeat',
});

/** Event types that assert forward progress and therefore require corroboration. */
export const EVIDENCE_REQUIRING_EVENTS = Object.freeze(new Set([
  EventType.CHECK_COMPLETED, EventType.DIFF_OBSERVED, EventType.REVIEW_COMPLETED,
  EventType.PUBLICATION_RECORDED, EventType.DEPLOYMENT_RECORDED,
]));

// ---------------------------------------------------------------------------
// Policy, backend, capability (contracts/policy.py, workbench.py, protocol.py)
// ---------------------------------------------------------------------------

export const Effort = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  // Advertised by Claude Code 2.1.220 between `high` and `max`. Added on the orchestrator side for
  // the same reason it is accepted here: a policy that cannot name a level the binary supports
  // would silently round down.
  XHIGH: 'xhigh',
  MAX: 'max',
});

export const RiskClass = Object.freeze({ LOW: 'low', NORMAL: 'normal', HIGH: 'high', CRITICAL: 'critical' });

export const PlanPolicy = Object.freeze({ AUTO: 'auto', REQUIRED: 'required', SKIP: 'skip' });

export const ApprovalPolicy = Object.freeze({
  NOT_REQUESTED: 'not_requested',
  APPROVAL_REQUIRED: 'approval_required',
  ALLOWED: 'allowed',
});

export const PhaseClass = Object.freeze({
  DISCOVERY: 'discovery',
  PLANNING: 'planning',
  IMPLEMENTATION: 'implementation',
  MECHANICAL_CORRECTION: 'mechanical_correction',
  HIGH_RISK_DESIGN: 'high_risk_design',
  ROUTINE_REVIEW: 'routine_review',
  HIGH_RISK_REVIEW: 'high_risk_review',
});

export const ModelVerificationOutcome = Object.freeze({
  VERIFIED: 'verified',
  MISMATCH: 'mismatch',
  UNVERIFIABLE: 'unverifiable',
});

// There is deliberately no API-key backend. Adding one would violate the product's core constraint,
// so the enum — not configuration — is the enforcement point.
export const CodingBackend = Object.freeze({ CLAUDE_CODE: 'claude-code', CODEX_CLI: 'codex-cli' });

export const OrchestratorSessionStatus = Object.freeze({
  UNKNOWN: 'unknown', READY: 'ready', STALE: 'stale', MISSING: 'missing', FAILED: 'failed',
});

export const CapabilityFlag = Object.freeze({
  PLANNING: 'planning',
  IMPLEMENTATION: 'implementation',
  TARGETED_TESTS: 'targeted_tests',
  FULL_TEST_SUITE: 'full_test_suite',
  TYPE_CHECK: 'type_check',
  LINT: 'lint',
  BUILD: 'build',
  INDEPENDENT_REVIEW: 'independent_review',
  PUBLICATION: 'publication',
  DEPLOYMENT: 'deployment',
});

// ---------------------------------------------------------------------------
// Evidence (contracts/evidence.py)
// ---------------------------------------------------------------------------

export const ArtifactKind = Object.freeze({
  LOG: 'log', DIFF: 'diff', TEST_REPORT: 'test_report', REVIEW_REPORT: 'review_report',
  SCREENSHOT: 'screenshot', PLAN: 'plan', OTHER: 'other',
});

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 64 * 1024;

export const CheckKind = Object.freeze({
  TARGETED_TEST: 'targeted_test',
  FULL_TEST_SUITE: 'full_test_suite',
  CANONICAL_VERIFICATION: 'canonical_verification',
  BUILD: 'build',
  TYPE_CHECK: 'type_check',
  LINT: 'lint',
  FORMAT: 'format',
  DIFF_CHECK: 'diff_check',
  SECRET_SCAN: 'secret_scan',
  CONTRACT_CHECK: 'contract_check',
  UI_VERIFICATION: 'ui_verification',
});

export const CheckOutcome = Object.freeze({
  PASSED: 'passed', FAILED: 'failed', NOT_RUN: 'not_run', ERRORED: 'errored',
});

export const ReviewVerdict = Object.freeze({
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REJECTED: 'rejected',
  INCONCLUSIVE: 'inconclusive',
});

// ---------------------------------------------------------------------------
// Interaction (contracts/interaction.py)
// ---------------------------------------------------------------------------

export const DecisionScope = Object.freeze({
  CLARIFICATION: 'clarification',
  PRODUCT: 'product',
  ARCHITECTURE: 'architecture',
  SECURITY: 'security',
  DEPLOYMENT: 'deployment',
  DESTRUCTIVE: 'destructive',
});

/** Scopes the orchestrator may never self-answer, however clear the request seems. */
export const HUMAN_ONLY_SCOPES = Object.freeze(new Set([
  DecisionScope.SECURITY, DecisionScope.DEPLOYMENT, DecisionScope.DESTRUCTIVE,
]));

export const QuestionStatus = Object.freeze({ OPEN: 'open', ANSWERED: 'answered', VOIDED: 'voided' });

// There is deliberately no "proceed with a guess" option.
export const TimeoutAction = Object.freeze({
  REMAIN_BLOCKED: 'remain_blocked', FAIL: 'fail', CANCEL: 'cancel',
});

export const ApprovalType = Object.freeze({
  PLAN: 'plan',
  SCOPE_EXPANSION: 'scope_expansion',
  SECURITY_DECISION: 'security_decision',
  ARCHITECTURE_DECISION: 'architecture_decision',
  PUBLICATION: 'publication',
  MERGE: 'merge',
  DEPLOYMENT: 'deployment',
  DESTRUCTIVE_ACTION: 'destructive_action',
});

export const ApprovalStatus = Object.freeze({
  PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', VOIDED: 'voided',
});

export const ActorKind = Object.freeze({
  HUMAN: 'human', ORCHESTRATOR: 'orchestrator', WORKBENCH: 'workbench', AGENT: 'agent',
  SYSTEM: 'system',
});

// ---------------------------------------------------------------------------
// Publication and health (contracts/publication.py, health.py)
// ---------------------------------------------------------------------------

export const CiState = Object.freeze({
  NOT_STARTED: 'not_started', RUNNING: 'running', PASSED: 'passed', FAILED: 'failed',
  NOT_CONFIGURED: 'not_configured',
});

export const DeploymentStatus = Object.freeze({
  NOT_REQUESTED: 'not_requested', PENDING_APPROVAL: 'pending_approval', RUNNING: 'running',
  SUCCEEDED: 'succeeded', FAILED: 'failed', ROLLED_BACK: 'rolled_back',
});

export const HealthState = Object.freeze({ OK: 'ok', DEGRADED: 'degraded', DOWN: 'down' });

// No api_key member: API-billed inference is not representable in this product.
export const AuthMethod = Object.freeze({ SUBSCRIPTION_OAUTH: 'subscription_oauth', UNKNOWN: 'unknown' });

// ---------------------------------------------------------------------------
// Errors (contracts/common.py)
// ---------------------------------------------------------------------------

export const ErrorCode = Object.freeze({
  VALIDATION_FAILED: 'validation_failed',
  UNSUPPORTED_SCHEMA_VERSION: 'unsupported_schema_version',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN_SCOPE: 'forbidden_scope',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  INVALID_TRANSITION: 'invalid_transition',
  LEASE_LOST: 'lease_lost',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSAFE_PATH: 'unsafe_path',
  PROJECT_NOT_AUTHORIZED: 'project_not_authorized',
  WORKBENCH_UNAVAILABLE: 'workbench_unavailable',
  MODEL_POLICY_VIOLATION: 'model_policy_violation',
  DIRECT_CODING_FORBIDDEN: 'direct_coding_forbidden',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
});

// ---------------------------------------------------------------------------
// Identifiers and lane naming (§5)
// ---------------------------------------------------------------------------

/** Return a collision-resistant identifier such as `pwjob_3f2a…`. */
export function newId(prefix) {
  if (!PATTERNS.idPrefix.test(prefix)) throw new Error(`invalid identifier prefix: ${JSON.stringify(prefix)}`);
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

/** Deterministic durable registry key: `<orchestrator>:<workbench>:<project>:<role>`. */
export function deriveSessionKey(orchestratorInstanceId, workbenchInstanceId, projectId, role) {
  return `${orchestratorInstanceId}:${workbenchInstanceId}:${projectId}:${role}`;
}

/** The reserved coding-CLI display name for a project's orchestrator lane. */
export function deriveCliDisplayName(projectId, prefix = 'pvibot-orchestrator-') {
  return `${prefix}${String(projectId).toLowerCase()}`;
}

/**
 * The tmux session name for a project.
 *
 * Non-alphanumerics collapse to `_`, matching the existing `tmuxSession()` helper in server.js so
 * the orchestrator lane lands in the *same* session a human would open rather than a parallel one.
 *
 * This diverges from the orchestrator's `derive_tmux_session`, which is a plain `f"pw_{project_id}"`
 * — for a project id like `PVH-Gateway` the two disagree. ProjectWorkbench reports the name of the
 * session that actually exists, because reporting a name that does not exist would be worse. The
 * orchestrator only stores and displays this value; it has no shell and never constructs a tmux
 * target from it. Recorded in the contract fixture's `known_gaps` for coordination.
 */
export function deriveTmuxSession(projectId, prefix = 'pw_') {
  return prefix + String(projectId).replace(/[^A-Za-z0-9_]/g, '_');
}
