// Increment 12 — the cross-contract fixture.
//
// Two jobs. First, a drift guard: the committed fixture must be exactly what the implementation
// generates, so an enum or a transition cannot change without the shared artefact changing with it.
// Second, a real cross-contract check: where the orchestrator's Python is available, its own
// Pydantic enums and state families are compared member-for-member against ours. That check is
// skipped rather than faked when the venv is absent, because a check that quietly passes when it
// cannot run is worse than no check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildFixture, serialiseFixture, FIXTURE_PATH } from '../scripts/orch-contract-fixture.mjs';

const ORCHESTRATOR_ROOT = '/opt/project-workbench/workspaces/PVICodingOrchestrator';
const VENV_PYTHON = path.join(ORCHESTRATOR_ROOT, '.venv', 'bin', 'python');
const HAVE_ORCHESTRATOR = fs.existsSync(VENV_PYTHON) && fs.existsSync(path.join(ORCHESTRATOR_ROOT, 'src'));
const crossTest = (name, fn) => test(name, {
  skip: HAVE_ORCHESTRATOR ? false : 'the orchestrator repository and its venv are not available here',
}, fn);

/** Run a short script against the orchestrator's own interpreter. Read-only; never mutates it. */
function orchestratorJson(script) {
  const out = execFileSync(VENV_PYTHON, ['-c', script], {
    cwd: ORCHESTRATOR_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(ORCHESTRATOR_ROOT, 'src') },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out);
}

test('fixture: the committed contract fixture is exactly what the implementation generates', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'contract/pw-contract-1.0.json must be committed');
  const committed = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(
    committed, serialiseFixture(),
    'the fixture has drifted — regenerate it with: node scripts/orch-contract-fixture.mjs --write',
  );
});

test('fixture: it describes the whole surface the orchestrator needs to check compatibility', () => {
  const fixture = buildFixture();
  assert.equal(fixture.contract_version, '1.0');
  assert.ok(fixture.endpoints.length >= 24);
  assert.ok(fixture.mcp.tools.length >= 22);
  assert.equal(fixture.mcp.sampling_enabled, false);
  assert.equal(fixture.safety.api_key_authentication_representable, false);
  assert.equal(fixture.safety.cancellation_preserves_working_tree, true);
  assert.equal(fixture.safety.publication_requires_recorded_human_approval, true);
  // Every job status must appear in the transition table.
  for (const status of fixture.enums.JobStatus) {
    assert.ok(Object.hasOwn(fixture.transitions, status), `no transitions recorded for ${status}`);
  }
  // The known gap must be declared rather than buried, so the other side can plan around it.
  assert.ok(fixture.known_gaps.some((g) => g.id === 'effective-effort-unverifiable'));
});

crossTest('cross-contract: the job state vocabulary matches the orchestrator member for member', () => {
  const remote = orchestratorJson(`
import json
from pvi_orchestrator.contracts.states import (
    JobStatus, PROGRESS_STATES, BLOCKED_STATES, TERMINAL_STATES, WORKSPACE_ACTIVE_STATES,
)
print(json.dumps({
    "all": sorted(s.value for s in JobStatus),
    "progress": sorted(s.value for s in PROGRESS_STATES),
    "blocked": sorted(s.value for s in BLOCKED_STATES),
    "terminal": sorted(s.value for s in TERMINAL_STATES),
    "workspace_active": sorted(s.value for s in WORKSPACE_ACTIVE_STATES),
}))
`);
  const fixture = buildFixture();
  assert.deepEqual(fixture.enums.JobStatus, remote.all);
  assert.deepEqual(fixture.state_families.progress, remote.progress);
  assert.deepEqual(fixture.state_families.blocked, remote.blocked);
  assert.deepEqual(fixture.state_families.terminal, remote.terminal);
  assert.deepEqual(fixture.state_families.workspace_active, remote.workspace_active);
});

crossTest('cross-contract: every shared enum matches the orchestrator member for member', () => {
  const remote = orchestratorJson(`
import json
from pvi_orchestrator.contracts.common import Effort, RiskClass, PlanPolicy, ApprovalPolicy, ActorKind, ErrorCode
from pvi_orchestrator.contracts.events import EventType, EVIDENCE_REQUIRING_EVENTS
from pvi_orchestrator.contracts.evidence import ArtifactKind, CheckKind, CheckOutcome, ReviewVerdict
from pvi_orchestrator.contracts.interaction import (
    DecisionScope, QuestionStatus, TimeoutAction, ApprovalType, ApprovalStatus, HUMAN_ONLY_SCOPES,
)
from pvi_orchestrator.contracts.policy import PhaseClass, ModelVerificationOutcome
from pvi_orchestrator.contracts.publication import CiState, DeploymentStatus
from pvi_orchestrator.contracts.health import HealthState, AuthMethod
from pvi_orchestrator.contracts.workbench import CodingBackend, OrchestratorSessionStatus
from pvi_orchestrator.workbench.protocol import CapabilityFlag

def members(enum):
    return sorted(m.value for m in enum)

print(json.dumps({
    "Effort": members(Effort), "RiskClass": members(RiskClass), "PlanPolicy": members(PlanPolicy),
    "ApprovalPolicy": members(ApprovalPolicy), "ActorKind": members(ActorKind),
    "ErrorCode": members(ErrorCode), "EventType": members(EventType),
    "ArtifactKind": members(ArtifactKind), "CheckKind": members(CheckKind),
    "CheckOutcome": members(CheckOutcome), "ReviewVerdict": members(ReviewVerdict),
    "DecisionScope": members(DecisionScope), "QuestionStatus": members(QuestionStatus),
    "TimeoutAction": members(TimeoutAction), "ApprovalType": members(ApprovalType),
    "ApprovalStatus": members(ApprovalStatus), "PhaseClass": members(PhaseClass),
    "ModelVerificationOutcome": members(ModelVerificationOutcome),
    "CiState": members(CiState), "DeploymentStatus": members(DeploymentStatus),
    "HealthState": members(HealthState), "AuthMethod": members(AuthMethod),
    "CodingBackend": members(CodingBackend),
    "OrchestratorSessionStatus": members(OrchestratorSessionStatus),
    "CapabilityFlag": members(CapabilityFlag),
    "evidence_required": sorted(e.value for e in EVIDENCE_REQUIRING_EVENTS),
    "human_only_scopes": sorted(s.value for s in HUMAN_ONLY_SCOPES),
}))
`);

  const fixture = buildFixture();
  for (const name of [
    'Effort', 'RiskClass', 'PlanPolicy', 'ApprovalPolicy', 'ActorKind', 'ErrorCode', 'EventType',
    'ArtifactKind', 'CheckKind', 'CheckOutcome', 'ReviewVerdict', 'DecisionScope', 'QuestionStatus',
    'TimeoutAction', 'ApprovalType', 'ApprovalStatus', 'PhaseClass', 'ModelVerificationOutcome',
    'CiState', 'DeploymentStatus', 'HealthState', 'AuthMethod', 'CodingBackend',
    'OrchestratorSessionStatus', 'CapabilityFlag',
  ]) {
    assert.deepEqual(fixture.enums[name], remote[name], `${name} differs from the orchestrator`);
  }
  assert.deepEqual(fixture.event_rules.evidence_required, remote.evidence_required);
  assert.deepEqual(fixture.interaction_rules.human_only_decision_scopes, remote.human_only_scopes);
});

crossTest('cross-contract: the transition table matches the orchestrator edge for edge', () => {
  const remote = orchestratorJson(`
import json
from pvi_orchestrator.state.machine import ALLOWED_TRANSITIONS
print(json.dumps({k.value: sorted(v.value for v in vs) for k, vs in ALLOWED_TRANSITIONS.items()}))
`);
  const fixture = buildFixture();
  // Both sides must agree on what invalid_transition means, or a legal orchestrator request would
  // be refused here — or, worse, an illegal one accepted.
  for (const [status, targets] of Object.entries(remote)) {
    assert.deepEqual(fixture.transitions[status], targets, `transitions from '${status}' differ`);
  }
  assert.deepEqual(Object.keys(fixture.transitions).sort(), Object.keys(remote).sort());
});

crossTest('cross-contract: the MCP tool set matches ALLOWED_CLIENT_METHODS plus the §9 additions', () => {
  const remote = orchestratorJson(`
import json
from pvi_orchestrator.workbench.protocol import ALLOWED_CLIENT_METHODS, FORBIDDEN_METHOD_FRAGMENTS
print(json.dumps({
    "methods": sorted(ALLOWED_CLIENT_METHODS),
    "forbidden": sorted(FORBIDDEN_METHOD_FRAGMENTS),
}))
`);
  const fixture = buildFixture();

  // Every client method must have a matching pw_ tool. `stream` has no client method (it is the SSE
  // endpoint) but does have an MCP tool, per the §4 table.
  for (const method of remote.methods) {
    assert.ok(
      fixture.mcp.tools.includes(`pw_${method}`),
      `no MCP tool for client method '${method}'`,
    );
  }
  assert.ok(fixture.mcp.tools.includes('pw_stream_events'));

  // Anything beyond the contract's own set must be one of the declared Milestone 2 additions.
  const milestone2 = ['pw_get_questions', 'pw_get_approvals', 'pw_get_checks', 'pw_get_reviews', 'pw_publish'];
  const extra = fixture.mcp.tools.filter(
    (t) => !remote.methods.includes(t.replace(/^pw_/, '')) && t !== 'pw_stream_events',
  );
  assert.deepEqual(extra.sort(), [...milestone2].sort(), 'undeclared capability in the MCP tool set');

  // And the forbidden fragments must match, then actually hold.
  assert.deepEqual(fixture.mcp.forbidden_name_fragments, remote.forbidden);
  for (const tool of fixture.mcp.tools) {
    for (const fragment of remote.forbidden) {
      assert.ok(!tool.includes(fragment), `tool ${tool} contains forbidden fragment '${fragment}'`);
    }
  }
});

crossTest('cross-contract: the §10 error table maps to the same statuses on both sides', () => {
  const remote = orchestratorJson(`
import json
from pvi_orchestrator.contracts.common import ErrorCode
print(json.dumps(sorted(c.value for c in ErrorCode)))
`);
  const fixture = buildFixture();
  assert.deepEqual(Object.keys(fixture.errors).sort(), remote.sort());
  // The statuses the contract's §10 table fixes explicitly.
  assert.equal(fixture.errors.unauthenticated, 401);
  assert.equal(fixture.errors.forbidden_scope, 403);
  assert.equal(fixture.errors.project_not_authorized, 403);
  assert.equal(fixture.errors.not_found, 404);
  assert.equal(fixture.errors.idempotency_key_reused, 409);
  assert.equal(fixture.errors.lease_lost, 409);
  assert.equal(fixture.errors.invalid_transition, 409);
  assert.equal(fixture.errors.payload_too_large, 413);
  assert.equal(fixture.errors.rate_limited, 429);
  assert.equal(fixture.errors.workbench_unavailable, 503);
});
