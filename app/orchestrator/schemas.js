// Request schemas for the job endpoints.
//
// These mirror the Pydantic request models on the orchestrator side field for field, including the
// bounds. That symmetry is the point: a payload the orchestrator can construct must be one this
// side accepts, and a payload this side accepts must be one the orchestrator could have
// constructed. Anything looser here would let a malformed request through that the contract says is
// impossible; anything stricter would reject a legal one.
//
// Note what is *absent* from every schema below: no path, no command, no tool name, no shell
// fragment. `required_checks` names entries in a fixed catalogue and is canonicalised against it.

import { MAX_LIST_ITEMS, Effort, CodingBackend } from './contract.js';

const EFFORTS = Object.values(Effort);

export const MODEL_SETTINGS_SCHEMA = {
  name: 'ModelSettings',
  fields: {
    model_alias: { type: 'modelAlias', required: true },
    effort: { type: 'enum', values: EFFORTS, required: true },
  },
};

export const TASK_CONTRACT_SCHEMA = {
  name: 'TaskContract',
  fields: {
    title: { type: 'shortText', required: true },
    goal: { type: 'mediumText', required: true },
    problem_or_reproduction: { type: 'longText', nullable: true, default: null },
    acceptance_criteria: {
      type: 'list', items: { type: 'criterionText' }, minItems: 1, maxItems: MAX_LIST_ITEMS, required: true,
    },
    constraints: { type: 'list', items: { type: 'criterionText' }, maxItems: MAX_LIST_ITEMS, default: () => [] },
    out_of_scope: { type: 'list', items: { type: 'criterionText' }, maxItems: MAX_LIST_ITEMS, default: () => [] },
    // Relative paths only. The type rejects absolute, traversing and backslash forms, so this can
    // never become a way to name a file outside the workspace.
    likely_paths: { type: 'list', items: { type: 'relativePath' }, maxItems: MAX_LIST_ITEMS, default: () => [] },
    // Names from the check catalogue, canonicalised by the engine. Never a command.
    required_checks: { type: 'list', items: { type: 'shortText' }, maxItems: MAX_LIST_ITEMS, default: () => [] },
  },
};

export const SUBMIT_JOB_SCHEMA = {
  name: 'SubmitJobRequest',
  fields: {
    idempotency_key: { type: 'identifier', required: true },
    orchestrator_instance_id: { type: 'identifier', required: true },
    orchestrator_job_id: { type: 'identifier', required: true },
    project_id: { type: 'slug', required: true },
    session_key: { type: 'identifier', required: true },
    task: { type: 'object', schema: TASK_CONTRACT_SCHEMA, required: true },
    requested: { type: 'object', schema: MODEL_SETTINGS_SCHEMA, required: true },
    max_phase_turns: { type: 'int', min: 1, max: 60, required: true },
    max_revision_cycles: { type: 'int', min: 0, max: 3, required: true },
    // The orchestrator's durable project write lease. A token lower than one already accepted for
    // this project is refused with lease_lost.
    fencing_token: { type: 'int', min: 1, required: true },
  },
};

export const REPLY_SCHEMA = {
  name: 'ReplyToQuestionRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    question_id: { type: 'identifier', required: true },
    answer: { type: 'mediumText', required: true },
    selected_option_index: { type: 'int', min: 0, nullable: true, default: null },
  },
};

export const APPROVE_SCHEMA = {
  name: 'ApproveStageRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    approval_id: { type: 'identifier', required: true },
    stage: { type: 'slug', required: true },
    approved: { type: 'bool', required: true },
    reason: { type: 'mediumText', nullable: true, default: null },
    // Who actually decided. The orchestrator is the channel, not the decider.
    // Required, with no placeholder and no default. The engine already refused an approval that
    // named nobody — this is the record that authorises a push — but the declared schema said
    // "nullable, default null", so the shape and the behaviour disagreed. The contract settled it:
    // `ApproveStageRequest.decided_by` is required, and the refusal belongs at the door where it
    // can name the field.
    decided_by: { type: 'identifier', required: true },
  },
};

export const REVISE_SCHEMA = {
  name: 'RequestRevisionRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    instructions: { type: 'mediumText', required: true },
    blocking_finding_ids: { type: 'list', items: { type: 'identifier' }, maxItems: MAX_LIST_ITEMS, default: () => [] },
  },
};

export const REVIEW_SCHEMA = {
  name: 'RequestReviewRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    require_fresh_session: { type: 'bool', default: true },
    requested: { type: 'object', schema: MODEL_SETTINGS_SCHEMA, required: true },
  },
};

export const CANCEL_SCHEMA = {
  name: 'CancelJobRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    reason: { type: 'shortText', required: true },
  },
};

export const HEARTBEAT_SCHEMA = {
  name: 'HeartbeatRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    fencing_token: { type: 'int', min: 1, nullable: true, default: null },
  },
};

export const ARTIFACT_EXCERPT_SCHEMA = {
  name: 'ArtifactExcerptRequest',
  fields: {
    artifact_id: { type: 'identifier', required: true },
    byte_offset: { type: 'int', min: 0, default: 0 },
    max_bytes: { type: 'int', min: 1, max: 65_536, default: 8_192 },
  },
};

export const PUBLICATION_REQUEST_SCHEMA = {
  name: 'PublicationRequest',
  fields: {
    job_id: { type: 'identifier', required: true },
    branch: { type: 'branch', required: true },
    commit_message: { type: 'mediumText', required: true },
    // An empty list is invalid: publication needs intended content, and staging "whatever happens to
    // be dirty" is how unrelated work gets published by accident.
    intended_files: { type: 'list', items: { type: 'relativePath' }, minItems: 1, maxItems: 200, required: true },
    open_pull_request: { type: 'bool', default: true },
    approval_id: { type: 'identifier', nullable: true, default: null },
  },
};

export const ENSURE_SESSION_SCHEMA = {
  name: 'EnsureSessionRequest',
  fields: {
    orchestrator_instance_id: { type: 'identifier', required: true },
    project_id: { type: 'slug', required: true },
    role: { type: 'slug', nullable: true, default: null },
    reserved_tmux_window: { type: 'slug', nullable: true, default: null },
    cli_backend: { type: 'enum', values: Object.values(CodingBackend), default: CodingBackend.CLAUDE_CODE },
    force_replace: { type: 'bool', default: false },
  },
};
