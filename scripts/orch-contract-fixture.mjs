#!/usr/bin/env node
// Generate the machine-readable contract fixture.
//
// The fixture is produced *from the implementation's own vocabularies* rather than hand-written, so
// it cannot drift from what the service actually does. A test asserts the committed file matches
// what this script produces; changing an enum without regenerating fails the build.
//
// The fixture exists so the orchestrator side can assert compatibility without importing JavaScript
// and without a live ProjectWorkbench instance. It is the artefact both repositories can diff.
//
//   node scripts/orch-contract-fixture.mjs            # print to stdout
//   node scripts/orch-contract-fixture.mjs --write    # write contract/pw-contract-1.0.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SCHEMA_VERSION, JobStatus, PROGRESS_STATES, BLOCKED_STATES, TERMINAL_STATES,
  WORKSPACE_ACTIVE_STATES, EventType, EVIDENCE_REQUIRING_EVENTS, Effort, RiskClass, PlanPolicy,
  ApprovalPolicy, PhaseClass, ModelVerificationOutcome, CodingBackend, OrchestratorSessionStatus,
  CapabilityFlag, ArtifactKind, CheckKind, CheckOutcome, ReviewVerdict, DecisionScope,
  HUMAN_ONLY_SCOPES, QuestionStatus, TimeoutAction, ApprovalType, ApprovalStatus, ActorKind,
  CiState, DeploymentStatus, HealthState, AuthMethod, ErrorCode, TEXT_LIMITS, PATTERNS,
  MAX_LIST_ITEMS, MAX_ARTIFACT_BYTES, MAX_EXCERPT_BYTES,
} from '../app/orchestrator/contract.js';
import { ALLOWED_TRANSITIONS } from '../app/orchestrator/statemachine.js';
import { ALLOWED_TOOLS, TOOL_DEFINITIONS, FORBIDDEN_TOOL_FRAGMENTS } from '../app/orchestrator/mcp.js';
import { statusForCode } from '../app/orchestrator/errors.js';
import { ALLOWED_CHECK_NAMES } from '../app/orchestrator/checks.js';
import { ALLOWED_GIT_SUBCOMMANDS, FORBIDDEN_GIT_SUBCOMMANDS } from '../app/orchestrator/git.js';
import { EFFORT_ATTESTATION_REQUIREMENT } from '../app/orchestrator/attestation.js';
import { SCOPES } from '../app/orchestrator/auth.js';

const sorted = (values) => [...values].sort();

/** The HTTP surface, transcribed from pw-contract.md §3 plus the §9 Milestone 2 additions. */
const ENDPOINTS = [
  { method: 'GET', path: '/health', purpose: 'instance health and coding-backend authentication health', contract: '1.0' },
  { method: 'GET', path: '/readiness', purpose: 'component readiness; additive to the contract', contract: 'additive' },
  { method: 'GET', path: '/projects', purpose: 'projects this instance owns', contract: '1.0' },
  { method: 'GET', path: '/projects/{project}/capabilities', purpose: "what the project's lane can do", contract: '1.0' },
  { method: 'POST', path: '/projects/{project}/session/ensure', purpose: 'create or adopt the named orchestrator lane', contract: '1.0' },
  { method: 'POST', path: '/projects/{project}/session/verify', purpose: 'report the effective model and effort', contract: '1.0' },
  { method: 'POST', path: '/jobs', purpose: 'submit a task contract', contract: '1.0' },
  { method: 'GET', path: '/jobs', purpose: 'list jobs; additive to the contract', contract: 'additive' },
  { method: 'GET', path: '/jobs/{id}', purpose: 'job snapshot', contract: '1.0' },
  { method: 'GET', path: '/jobs/{id}/events', purpose: 'ordered, sequenced events after a cursor', contract: '1.0' },
  { method: 'GET', path: '/jobs/{id}/events/stream', purpose: 'the same as Server-Sent Events', contract: '1.0' },
  { method: 'POST', path: '/jobs/{id}/reply', purpose: 'answer a question', contract: '1.0' },
  { method: 'POST', path: '/jobs/{id}/approve', purpose: 'relay a recorded human decision', contract: '1.0' },
  { method: 'POST', path: '/jobs/{id}/revise', purpose: 'request one bounded correction', contract: '1.0' },
  { method: 'POST', path: '/jobs/{id}/review', purpose: 'request an independent review', contract: '1.0' },
  { method: 'POST', path: '/jobs/{id}/cancel', purpose: 'cancel, preserving the working tree', contract: '1.0' },
  { method: 'GET', path: '/jobs/{id}/result', purpose: 'the final evidence-backed result', contract: '1.0' },
  { method: 'GET', path: '/artifacts/{id}/metadata', purpose: 'artifact metadata', contract: '1.0' },
  { method: 'GET', path: '/artifacts/{id}/excerpt', purpose: 'a bounded, redacted window into an artifact', contract: '1.0' },
  // -- §9 additions, designed with the orchestrator side --
  { method: 'GET', path: '/jobs/{id}/questions', purpose: 'typed questions (§9.1)', contract: '1.0+m2' },
  { method: 'GET', path: '/jobs/{id}/approvals', purpose: 'typed approvals (§9.2)', contract: '1.0+m2' },
  { method: 'GET', path: '/jobs/{id}/checks', purpose: 'Check records (§9.3)', contract: '1.0+m2' },
  { method: 'GET', path: '/jobs/{id}/reviews', purpose: 'Review records (§9.3)', contract: '1.0+m2' },
  { method: 'POST', path: '/jobs/{id}/publish', purpose: 'PublicationRequest → PublicationRecord (§9.4)', contract: '1.0+m2' },
  { method: 'POST', path: '/jobs/{id}/heartbeat', purpose: 'lease heartbeat (§9.5)', contract: '1.0+m2' },
];

export function buildFixture() {
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: '1.0',
    generated_by: 'scripts/orch-contract-fixture.mjs',
    description:
      'Machine-readable description of the ProjectWorkbench orchestration surface. Generated from '
      + "the implementation's own vocabularies so it cannot drift. The orchestrator repository can "
      + 'diff this file to detect an incompatible change without importing JavaScript.',
    base_path: '/api/orchestrator/v1',

    endpoints: ENDPOINTS,

    mcp: {
      tools: sorted(ALLOWED_TOOLS),
      forbidden_name_fragments: sorted(FORBIDDEN_TOOL_FRAGMENTS),
      sampling_enabled: false,
      resources_offered: false,
      prompts_offered: false,
      tool_input_schemas: Object.fromEntries(
        [...TOOL_DEFINITIONS].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.inputSchema]),
      ),
    },

    enums: {
      JobStatus: sorted(Object.values(JobStatus)),
      EventType: sorted(Object.values(EventType)),
      Effort: sorted(Object.values(Effort)),
      RiskClass: sorted(Object.values(RiskClass)),
      PlanPolicy: sorted(Object.values(PlanPolicy)),
      ApprovalPolicy: sorted(Object.values(ApprovalPolicy)),
      PhaseClass: sorted(Object.values(PhaseClass)),
      ModelVerificationOutcome: sorted(Object.values(ModelVerificationOutcome)),
      CodingBackend: sorted(Object.values(CodingBackend)),
      OrchestratorSessionStatus: sorted(Object.values(OrchestratorSessionStatus)),
      CapabilityFlag: sorted(Object.values(CapabilityFlag)),
      ArtifactKind: sorted(Object.values(ArtifactKind)),
      CheckKind: sorted(Object.values(CheckKind)),
      CheckOutcome: sorted(Object.values(CheckOutcome)),
      ReviewVerdict: sorted(Object.values(ReviewVerdict)),
      DecisionScope: sorted(Object.values(DecisionScope)),
      QuestionStatus: sorted(Object.values(QuestionStatus)),
      TimeoutAction: sorted(Object.values(TimeoutAction)),
      ApprovalType: sorted(Object.values(ApprovalType)),
      ApprovalStatus: sorted(Object.values(ApprovalStatus)),
      ActorKind: sorted(Object.values(ActorKind)),
      CiState: sorted(Object.values(CiState)),
      DeploymentStatus: sorted(Object.values(DeploymentStatus)),
      HealthState: sorted(Object.values(HealthState)),
      AuthMethod: sorted(Object.values(AuthMethod)),
      ErrorCode: sorted(Object.values(ErrorCode)),
    },

    state_families: {
      progress: sorted(PROGRESS_STATES),
      blocked: sorted(BLOCKED_STATES),
      terminal: sorted(TERMINAL_STATES),
      workspace_active: sorted(WORKSPACE_ACTIVE_STATES),
    },

    transitions: Object.fromEntries(
      sorted(Object.values(JobStatus)).map((status) => [status, sorted(ALLOWED_TRANSITIONS.get(status))]),
    ),

    event_rules: {
      evidence_required: sorted(EVIDENCE_REQUIRING_EVENTS),
      heartbeat_carries_no_evidence: true,
      state_changed_records_previous_status: true,
      sequences_are_per_job_gapless_from_one: true,
    },

    interaction_rules: {
      human_only_decision_scopes: sorted(HUMAN_ONLY_SCOPES),
      approval_requires_human_actor: true,
      answer_matches_one_live_question_once: true,
    },

    errors: Object.fromEntries(sorted(Object.values(ErrorCode)).map((code) => [code, statusForCode(code)])),

    limits: {
      text: TEXT_LIMITS,
      max_list_items: MAX_LIST_ITEMS,
      max_artifact_bytes: MAX_ARTIFACT_BYTES,
      max_excerpt_bytes: MAX_EXCERPT_BYTES,
      max_events_per_page: 200,
      max_phase_turns: 60,
      max_revision_cycles: 3,
      max_intended_files: 200,
    },

    patterns: Object.fromEntries(Object.entries(PATTERNS).map(([name, regex]) => [name, regex.source])),

    safety: {
      // Named here so the orchestrator side can assert the guarantees it is relying on.
      allowed_check_names: sorted(ALLOWED_CHECK_NAMES),
      scopes: sorted(Object.values(SCOPES)),
      allowed_git_subcommands: sorted(ALLOWED_GIT_SUBCOMMANDS),
      forbidden_git_subcommands: sorted(FORBIDDEN_GIT_SUBCOMMANDS),
      cancellation_preserves_working_tree: true,
      cancellation_signals_the_running_phase: true,
      publication_uses_a_private_index: true,
      effort_attestation_available: false,
      approval_requires_separate_scope: true,
      approval_requires_separate_credential_by_default: true,
      api_key_authentication_representable: false,
      publication_requires_recorded_human_approval: true,
      remote_sha_verified_requires_full_sha_match: true,
    },

    known_gaps: [
      {
        id: 'effective-effort-unattestable',
        summary:
          'Measured against Claude Code 2.1.220: the stream-json system/init event carries model, '
          + 'permissionMode and apiKeySource but NO effort field of any kind, and an unrecognised '
          + '--effort value is silently ignored (stderr warning, exit 0, running at the default). '
          + 'Effective effort therefore cannot be attested against this CLI at all.',
        behaviour:
          'ProjectWorkbench reports effective: null and moves the job to blocked_configuration. '
          + 'There is no configuration that relaxes this — an earlier argv-attestation mode made '
          + 'the check requested === requested and has been removed. Jobs will not run against a '
          + 'CLI that cannot report effort.',
        requirement: EFFORT_ATTESTATION_REQUIREMENT,
        needs_coordination: true,
      },
      {
        id: 'model-alias-namespace',
        summary:
          'The orchestrator requests a model by alias (sonnet); the CLI reports the resolved id '
          + '(claude-sonnet-5, or a dated id such as claude-haiku-4-5-20251001). The two are in '
          + 'different namespaces and can never compare equal directly.',
        behaviour:
          'ProjectWorkbench attests the model through an explicit configured alias -> id mapping '
          + '(PW_ORCHESTRATOR_MODEL_ALIASES, defaults measured from the installed CLI). An alias '
          + 'with no mapping is unverifiable and blocks; an alias is never compared to itself.',
        needs_coordination: false,
      },
      {
        id: 'tmux-session-name-normalisation',
        summary:
          "The orchestrator's derive_tmux_session is a plain f\"pw_{project_id}\", while "
          + 'ProjectWorkbench collapses non-alphanumerics to underscore to match the session name its '
          + 'existing human terminals already use. For a project id such as PVH-Gateway the two '
          + 'disagree (pw_PVH-Gateway vs pw_PVH_Gateway).',
        workaround:
          'ProjectWorkbench reports the session that actually exists in '
          + 'OrchestratorSession.project_tmux_session. The orchestrator stores and displays that '
          + 'value and never constructs a tmux target from it, so the divergence is observable but '
          + 'not load-bearing. Either side may adopt the other convention.',
        needs_coordination: true,
      },
    ],
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(HERE, '..', 'contract', 'pw-contract-1.0.json');

/** Stable serialisation: the committed file must be byte-comparable across runs. */
export function serialiseFixture(fixture = buildFixture()) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const body = serialiseFixture();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, body);
    process.stdout.write(`wrote ${FIXTURE_PATH}\n`);
  } else {
    process.stdout.write(body);
  }
}
