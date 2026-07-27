// Increment 1 — contract vocabulary, strict validation, error envelope, redaction, config.
// Mirrors the normative orchestrator contracts (PVICodingOrchestrator/src/pvi_orchestrator/
// contracts/*.py and workbench/protocol.py). Anything ProjectWorkbench does differently here is a
// defect on the ProjectWorkbench side.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  MAX_LIST_ITEMS,
  JobStatus,
  PROGRESS_STATES,
  BLOCKED_STATES,
  TERMINAL_STATES,
  WORKSPACE_ACTIVE_STATES,
  statusClass,
  EventType,
  EVIDENCE_REQUIRING_EVENTS,
  Effort,
  PhaseClass,
  CodingBackend,
  CapabilityFlag,
  OrchestratorSessionStatus,
  CheckKind,
  CheckOutcome,
  ReviewVerdict,
  DecisionScope,
  HUMAN_ONLY_SCOPES,
  TimeoutAction,
  QuestionStatus,
  ApprovalType,
  ApprovalStatus,
  ArtifactKind,
  CiState,
  ActorKind,
  HealthState,
  AuthMethod,
  ErrorCode,
  newId,
  deriveSessionKey,
  deriveCliDisplayName,
  deriveTmuxSession,
} from '../app/orchestrator/contract.js';

import { validate, ValidationError } from '../app/orchestrator/validate.js';
import { ApiError, errorEnvelope, statusForCode } from '../app/orchestrator/errors.js';
import { redactText, redactDeep } from '../app/orchestrator/redact.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

// ---------------------------------------------------------------------------
// contract vocabulary
// ---------------------------------------------------------------------------

test('contract: schema version is the normative 1.0 and is the only supported version', () => {
  assert.equal(SCHEMA_VERSION, '1.0');
  assert.deepEqual([...SUPPORTED_SCHEMA_VERSIONS].sort(), ['1.0']);
  assert.equal(MAX_LIST_ITEMS, 50);
});

test('contract: JobStatus members match the orchestrator states.py vocabulary exactly', () => {
  // Transcribed from PVICodingOrchestrator/src/pvi_orchestrator/contracts/states.py.
  const expected = [
    'received', 'validating', 'queued', 'ensuring_project_session', 'verifying_backend',
    'discovering', 'planning', 'waiting_for_plan_approval', 'implementing',
    'verifying_targeted', 'verifying_full', 'reviewing', 'revision_required',
    'waiting_for_publication_approval', 'publishing',
    'waiting_for_input', 'waiting_for_approval', 'blocked_authentication',
    'blocked_rate_limit', 'blocked_usage_limit', 'blocked_configuration',
    'blocked_project_state', 'blocked_verification', 'blocked_review', 'blocked_connectivity',
    'completed', 'failed', 'cancelled', 'expired', 'superseded',
  ];
  assert.deepEqual(Object.values(JobStatus).sort(), expected.slice().sort());
});

test('contract: every job status is classified into exactly one family', () => {
  const all = new Set(Object.values(JobStatus));
  for (const s of all) {
    const inFamilies = [PROGRESS_STATES, BLOCKED_STATES, TERMINAL_STATES].filter((f) => f.has(s));
    assert.equal(inFamilies.length, 1, `${s} must belong to exactly one family`);
  }
  // The approval waits are classified as blocked, per states.py.
  assert.ok(BLOCKED_STATES.has(JobStatus.WAITING_FOR_PLAN_APPROVAL));
  assert.ok(BLOCKED_STATES.has(JobStatus.WAITING_FOR_PUBLICATION_APPROVAL));
  assert.equal(statusClass(JobStatus.IMPLEMENTING), 'active');
  assert.equal(statusClass(JobStatus.WAITING_FOR_INPUT), 'blocked');
  assert.equal(statusClass(JobStatus.CANCELLED), 'terminal');
});

test('contract: workspace-active states are the ones where cancellation must preserve the tree', () => {
  const expected = [
    'ensuring_project_session', 'verifying_backend', 'discovering', 'planning', 'implementing',
    'verifying_targeted', 'verifying_full', 'reviewing', 'publishing',
  ];
  assert.deepEqual([...WORKSPACE_ACTIVE_STATES].sort(), expected.sort());
});

test('contract: evidence-requiring event types match the orchestrator events.py set', () => {
  assert.deepEqual(
    [...EVIDENCE_REQUIRING_EVENTS].sort(),
    ['check_completed', 'deployment_recorded', 'diff_observed', 'publication_recorded', 'review_completed'],
  );
  assert.equal(EventType.HEARTBEAT, 'heartbeat');
  assert.equal(EventType.STATE_CHANGED, 'state_changed');
});

test('contract: enum vocabularies match the orchestrator contracts', () => {
  assert.deepEqual(Object.values(Effort).sort(), ['high', 'low', 'max', 'medium']);
  assert.deepEqual(Object.values(CodingBackend).sort(), ['claude-code', 'codex-cli']);
  assert.deepEqual(Object.values(PhaseClass).sort(), [
    'discovery', 'high_risk_design', 'high_risk_review', 'implementation',
    'mechanical_correction', 'planning', 'routine_review',
  ]);
  assert.deepEqual(Object.values(CapabilityFlag).sort(), [
    'build', 'deployment', 'full_test_suite', 'implementation', 'independent_review',
    'lint', 'planning', 'publication', 'targeted_tests', 'type_check',
  ]);
  assert.deepEqual(Object.values(OrchestratorSessionStatus).sort(), [
    'failed', 'missing', 'ready', 'stale', 'unknown',
  ]);
  assert.deepEqual(Object.values(CheckOutcome).sort(), ['errored', 'failed', 'not_run', 'passed']);
  assert.deepEqual(Object.values(ReviewVerdict).sort(), [
    'approved', 'changes_requested', 'inconclusive', 'rejected',
  ]);
  assert.deepEqual(Object.values(TimeoutAction).sort(), ['cancel', 'fail', 'remain_blocked']);
  assert.deepEqual(Object.values(QuestionStatus).sort(), ['answered', 'open', 'voided']);
  assert.deepEqual(Object.values(ApprovalStatus).sort(), ['approved', 'pending', 'rejected', 'voided']);
  assert.deepEqual(Object.values(CiState).sort(), [
    'failed', 'not_configured', 'not_started', 'passed', 'running',
  ]);
  assert.deepEqual(Object.values(ActorKind).sort(), [
    'agent', 'human', 'orchestrator', 'system', 'workbench',
  ]);
  assert.deepEqual(Object.values(HealthState).sort(), ['degraded', 'down', 'ok']);
  // There is deliberately no api_key auth method: API-billed inference is not representable.
  assert.deepEqual(Object.values(AuthMethod).sort(), ['subscription_oauth', 'unknown']);
  assert.ok(!Object.values(AuthMethod).some((m) => /api[_-]?key/i.test(m)));
  assert.ok(Object.values(CheckKind).includes('secret_scan'));
  assert.ok(Object.values(ArtifactKind).includes('diff'));
  assert.ok(Object.values(ApprovalType).includes('publication'));
});

test('contract: security/deployment/destructive scopes may never be self-answered', () => {
  assert.deepEqual([...HUMAN_ONLY_SCOPES].sort(), ['deployment', 'destructive', 'security']);
  assert.ok(Object.values(DecisionScope).includes('clarification'));
});

test('contract: error codes cover the whole §10 table', () => {
  for (const code of [
    'unauthenticated', 'forbidden_scope', 'project_not_authorized', 'not_found',
    'idempotency_key_reused', 'lease_lost', 'invalid_transition', 'payload_too_large',
    'rate_limited', 'workbench_unavailable', 'validation_failed', 'unsupported_schema_version',
    'unsafe_path', 'internal_error',
  ]) {
    assert.ok(Object.values(ErrorCode).includes(code), `missing error code ${code}`);
  }
});

test('contract: identifier generation is prefixed, collision-resistant, and prefix-validated', () => {
  const id = newId('pwjob');
  assert.match(id, /^pwjob_[a-f0-9]{32}$/);
  assert.notEqual(newId('pwjob'), newId('pwjob'));
  assert.throws(() => newId('BadPrefix'), /invalid identifier prefix/);
  assert.throws(() => newId('with-dash'), /invalid identifier prefix/);
});

test('contract: lane naming follows the §5 convention exactly', () => {
  assert.equal(
    deriveSessionKey('pvi2-orch', 'wb-instance', 'PVHGateway', 'pvi2-orchestrator'),
    'pvi2-orch:wb-instance:PVHGateway:pvi2-orchestrator',
  );
  assert.equal(deriveCliDisplayName('PVHGateway'), 'pvibot-orchestrator-pvhgateway');
  assert.equal(deriveTmuxSession('PVHGateway'), 'pw_PVHGateway');
  // The tmux name must survive characters PW normalises in its own tmuxSession() helper.
  assert.equal(deriveTmuxSession('My.Project-1'), 'pw_My_Project_1');
});

// ---------------------------------------------------------------------------
// strict validation
// ---------------------------------------------------------------------------

const CANCEL_SCHEMA = {
  name: 'CancelJobRequest',
  fields: {
    workbench_job_id: { type: 'identifier', required: true },
    reason: { type: 'shortText', required: true },
  },
};

test('validate: accepts a good payload, strips whitespace, and stamps the schema version', () => {
  const out = validate(CANCEL_SCHEMA, {
    schema_version: '1.0',
    workbench_job_id: 'pwjob_0001',
    reason: '  director changed priority  ',
  });
  assert.deepEqual(out, {
    schema_version: '1.0',
    workbench_job_id: 'pwjob_0001',
    reason: 'director changed priority',
  });
});

/** assert.throws() returns undefined, so capture the error when its fields matter. */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

test('validate: schema_version defaults to 1.0 but a different major is refused', () => {
  const out = validate(CANCEL_SCHEMA, { workbench_job_id: 'pwjob_1', reason: 'x' });
  assert.equal(out.schema_version, '1.0');
  const err = caught(() => validate(CANCEL_SCHEMA, { schema_version: '2.0', workbench_job_id: 'pwjob_1', reason: 'x' }));
  assert.ok(err instanceof ValidationError);
  assert.equal(err.code, ErrorCode.UNSUPPORTED_SCHEMA_VERSION);
});

test('validate: unknown fields are rejected — extra="forbid" parity with the Pydantic contracts', () => {
  const err = caught(() => validate(CANCEL_SCHEMA, { workbench_job_id: 'pwjob_1', reason: 'x', command: 'rm -rf /' }));
  assert.ok(err instanceof ValidationError);
  assert.equal(err.code, ErrorCode.VALIDATION_FAILED);
  assert.deepEqual(err.fieldErrors.map((f) => f.field), ['command']);
});

test('validate: identifier and slug patterns reject path separators and traversal', () => {
  const schema = {
    name: 'S',
    fields: { project_id: { type: 'slug', required: true }, ref: { type: 'identifier', required: true } },
  };
  for (const bad of ['../etc', 'a/b', 'a\\b', 'a b', '', 'x'.repeat(101)]) {
    assert.throws(() => validate(schema, { project_id: bad, ref: 'ok' }), ValidationError, `slug ${bad}`);
  }
  // Identifier allows ':' (session keys are identifiers) but never '/' or '\'.
  assert.doesNotThrow(() => validate(schema, { project_id: 'Proj_1.2-3', ref: 'a:b:c.d-e' }));
  assert.throws(() => validate(schema, { project_id: 'ok', ref: 'a/b' }), ValidationError);
});

test('validate: bounded text lengths match the contract primitives', () => {
  const schema = {
    name: 'S',
    fields: {
      s: { type: 'shortText' }, m: { type: 'mediumText' },
      l: { type: 'longText' }, c: { type: 'criterionText' },
    },
  };
  assert.doesNotThrow(() => validate(schema, { s: 'x'.repeat(200), m: 'x'.repeat(2000), l: 'x'.repeat(20000), c: 'x'.repeat(1000) }));
  assert.throws(() => validate(schema, { s: 'x'.repeat(201) }), ValidationError);
  assert.throws(() => validate(schema, { m: 'x'.repeat(2001) }), ValidationError);
  assert.throws(() => validate(schema, { l: 'x'.repeat(20001) }), ValidationError);
  assert.throws(() => validate(schema, { c: 'x'.repeat(1001) }), ValidationError);
  // Constrained text has min_length 1 after stripping — an all-whitespace value is not a value.
  assert.throws(() => validate(schema, { s: '   ' }), ValidationError);
});

test('validate: relative paths reject absolute, traversing, backslash and NUL forms', () => {
  const schema = { name: 'S', fields: { p: { type: 'relativePath', required: true } } };
  assert.doesNotThrow(() => validate(schema, { p: 'app/orchestrator/api.js' }));
  for (const bad of ['/etc/passwd', '../secret', 'a/../../b', 'a\\b', 'a b', './x/../../y']) {
    assert.throws(() => validate(schema, { p: bad }), ValidationError, `path ${bad}`);
  }
});

test('validate: integer bounds, list caps, enums and nested objects are enforced', () => {
  const schema = {
    name: 'S',
    fields: {
      turns: { type: 'int', min: 1, max: 60, required: true },
      effort: { type: 'enum', values: Object.values(Effort), required: true },
      criteria: { type: 'list', items: { type: 'criterionText' }, minItems: 1, maxItems: MAX_LIST_ITEMS, required: true },
      settings: {
        type: 'object',
        schema: { name: 'ModelSettings', fields: { model_alias: { type: 'modelAlias', required: true }, effort: { type: 'enum', values: Object.values(Effort), required: true } } },
      },
    },
  };
  const ok = validate(schema, {
    turns: 10, effort: 'high', criteria: ['a'],
    settings: { model_alias: 'sonnet', effort: 'high' },
  });
  assert.equal(ok.settings.schema_version, '1.0');
  assert.throws(() => validate(schema, { turns: 0, effort: 'high', criteria: ['a'] }), ValidationError);
  assert.throws(() => validate(schema, { turns: 61, effort: 'high', criteria: ['a'] }), ValidationError);
  assert.throws(() => validate(schema, { turns: 1.5, effort: 'high', criteria: ['a'] }), ValidationError);
  assert.throws(() => validate(schema, { turns: 1, effort: 'xhigh', criteria: ['a'] }), ValidationError);
  assert.throws(() => validate(schema, { turns: 1, effort: 'high', criteria: [] }), ValidationError);
  assert.throws(
    () => validate(schema, { turns: 1, effort: 'high', criteria: Array(MAX_LIST_ITEMS + 1).fill('a') }),
    ValidationError,
  );
  // A nested object cannot smuggle an unknown field either.
  assert.throws(
    () => validate(schema, { turns: 1, effort: 'high', criteria: ['a'], settings: { model_alias: 's', effort: 'high', shell: 'x' } }),
    ValidationError,
  );
});

test('validate: type confusion is rejected rather than coerced', () => {
  const schema = { name: 'S', fields: { n: { type: 'int' }, s: { type: 'shortText' }, b: { type: 'bool' } } };
  assert.throws(() => validate(schema, { n: '5' }), ValidationError);
  assert.throws(() => validate(schema, { s: 5 }), ValidationError);
  assert.throws(() => validate(schema, { b: 'true' }), ValidationError);
  assert.throws(() => validate(schema, { s: { toString: 'x' } }), ValidationError);
  assert.throws(() => validate(schema, ['not', 'an', 'object']), ValidationError);
  assert.throws(() => validate(schema, null), ValidationError);
});

test('validate: prototype-pollution keys never reach the validated value', () => {
  const schema = { name: 'S', fields: { s: { type: 'shortText' } } };
  const payload = JSON.parse('{"s":"ok","__proto__":{"polluted":true},"constructor":{"x":1}}');
  assert.throws(() => validate(schema, payload), ValidationError);
  assert.equal({}.polluted, undefined);
});

test('validate: git sha and branch primitives refuse abbreviations and unsafe refs', () => {
  const schema = { name: 'S', fields: { sha: { type: 'gitSha' }, branch: { type: 'branch' } } };
  const full = 'a'.repeat(40);
  assert.doesNotThrow(() => validate(schema, { sha: full, branch: 'feature/x-1.2' }));
  assert.throws(() => validate(schema, { sha: 'abc1234' }), ValidationError);
  assert.throws(() => validate(schema, { sha: 'A'.repeat(40) }), ValidationError);
  assert.throws(() => validate(schema, { branch: 'a b' }), ValidationError);
  assert.throws(() => validate(schema, { branch: '--upload-pack=evil' }), ValidationError);
});

// ---------------------------------------------------------------------------
// error envelope
// ---------------------------------------------------------------------------

test('errors: the §10 condition table maps to the exact HTTP status', () => {
  assert.equal(statusForCode(ErrorCode.UNAUTHENTICATED), 401);
  assert.equal(statusForCode(ErrorCode.FORBIDDEN_SCOPE), 403);
  assert.equal(statusForCode(ErrorCode.PROJECT_NOT_AUTHORIZED), 403);
  assert.equal(statusForCode(ErrorCode.NOT_FOUND), 404);
  assert.equal(statusForCode(ErrorCode.IDEMPOTENCY_KEY_REUSED), 409);
  assert.equal(statusForCode(ErrorCode.LEASE_LOST), 409);
  assert.equal(statusForCode(ErrorCode.INVALID_TRANSITION), 409);
  assert.equal(statusForCode(ErrorCode.PAYLOAD_TOO_LARGE), 413);
  assert.equal(statusForCode(ErrorCode.RATE_LIMITED), 429);
  assert.equal(statusForCode(ErrorCode.WORKBENCH_UNAVAILABLE), 503);
  assert.equal(statusForCode(ErrorCode.VALIDATION_FAILED), 400);
  assert.equal(statusForCode(ErrorCode.UNSUPPORTED_SCHEMA_VERSION), 400);
  assert.equal(statusForCode(ErrorCode.INTERNAL_ERROR), 500);
});

test('errors: the envelope carries only contract fields and never leaks internals', () => {
  const env = errorEnvelope(new ApiError(ErrorCode.LEASE_LOST, 'the submitted fencing token is older than the accepted one'), 'corr-123');
  assert.deepEqual(Object.keys(env).sort(), ['correlation_id', 'error', 'message', 'schema_version']);
  assert.equal(env.schema_version, '1.0');
  assert.equal(env.error, 'lease_lost');
  assert.equal(env.correlation_id, 'corr-123');
});

test('errors: an unexpected exception degrades to a fixed internal error with no detail', () => {
  const boom = new TypeError('ENOENT: /etc/project-workbench/.secret-key AWSKEY=AKIAIOSFODNN7EXAMPLE');
  const env = errorEnvelope(boom, 'corr-9');
  assert.equal(env.error, 'internal_error');
  assert.equal(env.message, 'an internal error occurred');
  assert.equal(env.detail, undefined);
  const blob = JSON.stringify(env);
  assert.ok(!blob.includes('secret-key'));
  assert.ok(!blob.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!/at\s+\w+\s+\(/.test(blob), 'no stack frame may appear');
});

test('errors: field errors are bounded and redacted', () => {
  const err = new ApiError(ErrorCode.VALIDATION_FAILED, 'payload failed validation', {
    fieldErrors: Array.from({ length: 80 }, (_, i) => ({ field: `f${i}`, message: 'bad' })),
  });
  const env = errorEnvelope(err, null);
  assert.equal(env.field_errors.length, MAX_LIST_ITEMS);
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test('redact: common credential shapes are removed from free text', () => {
  const samples = [
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    'github token ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'password=hunter2trombone',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'https://user:s3cr3tpassword@github.com/org/repo.git',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END OPENSSH PRIVATE KEY-----',
  ];
  for (const s of samples) {
    const out = redactText(s);
    assert.ok(out.includes('[REDACTED]'), `expected redaction in: ${s}`);
    for (const secret of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'hunter2trombone', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 's3cr3tpassword', 'MIIEpAIBAAKCAQEA']) {
      assert.ok(!out.includes(secret), `secret survived redaction: ${secret}`);
    }
  }
});

test('redact: ordinary evidence text is left intact', () => {
  const clean = 'pytest tests/auth/test_refresh.py -q — 8 passed, 0 failed in 1.20s';
  assert.equal(redactText(clean), clean);
});

test('redact: deep redaction walks objects and arrays and drops secret-named keys', () => {
  const out = redactDeep({
    command: 'git push https://user:tokenvalue123@github.com/o/r.git',
    nested: [{ token: 'abcd1234', note: 'fine' }],
    authorization: 'Bearer abc.def.ghi',
    count: 3,
  });
  assert.equal(out.count, 3);
  assert.equal(out.nested[0].note, 'fine');
  assert.equal(out.nested[0].token, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.ok(!JSON.stringify(out).includes('tokenvalue123'));
});

test('redact: is bounded so a huge log line cannot be echoed back wholesale', () => {
  const out = redactText('x'.repeat(50_000), { maxLength: 4_000 });
  assert.ok(out.length <= 4_000 + 32);
  assert.ok(out.endsWith('…[truncated]'));
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('config: the subsystem is disabled by default so existing installs are inert', () => {
  const cfg = loadOrchestratorConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.instanceId, null, 'no instance identity may be guessed from the host');
  assert.deepEqual(cfg.tokens, []);
});

test('config: every path, name, limit and identity is configuration-driven', () => {
  const cfg = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-lab-01',
    PW_ORCHESTRATOR_DATA_DIR: '/srv/pw/orch',
    PW_ORCHESTRATOR_ARTIFACT_DIR: '/srv/pw/artifacts',
    PW_ORCHESTRATOR_WORKTREE_DIR: '/srv/pw/worktrees',
    PW_ORCHESTRATOR_AUDIT_LOG: '/srv/pw/orch-audit.log',
    PW_ORCHESTRATOR_ROLE: 'lab-orchestrator',
    PW_ORCHESTRATOR_WINDOW: 'lab_window',
    PW_ORCHESTRATOR_TMUX_PREFIX: 'lab_',
    PW_ORCHESTRATOR_DISPLAY_PREFIX: 'labbot-',
    PW_ORCHESTRATOR_MAX_BODY_BYTES: '65536',
    PW_ORCHESTRATOR_RATE_LIMIT: '30',
    PW_WORKSPACES: '/srv/workspaces',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.instanceId, 'wb-lab-01');
  assert.equal(cfg.dataDir, '/srv/pw/orch');
  assert.equal(cfg.artifactDir, '/srv/pw/artifacts');
  assert.equal(cfg.worktreeDir, '/srv/pw/worktrees');
  assert.equal(cfg.auditLogPath, '/srv/pw/orch-audit.log');
  assert.equal(cfg.role, 'lab-orchestrator');
  assert.equal(cfg.reservedWindow, 'lab_window');
  assert.equal(cfg.tmuxPrefix, 'lab_');
  assert.equal(cfg.displayNamePrefix, 'labbot-');
  assert.equal(cfg.maxBodyBytes, 65536);
  assert.equal(cfg.rateLimitPerMinute, 30);
  assert.equal(cfg.workspaceRoot, '/srv/workspaces');
});

test('config: the contract §5 conventions are the defaults', () => {
  const cfg = loadOrchestratorConfig({ PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1' });
  assert.equal(cfg.role, 'pvi2-orchestrator');
  assert.equal(cfg.reservedWindow, 'orch_pvibot');
  assert.equal(cfg.tmuxPrefix, 'pw_');
  assert.equal(cfg.displayNamePrefix, 'pvibot-orchestrator-');
  assert.equal(cfg.basePath, '/api/orchestrator/v1');
});

test('config: enabling without an instance id or with a bad one fails closed', () => {
  assert.throws(() => loadOrchestratorConfig({ PW_ORCHESTRATOR_ENABLED: 'true' }), /instance id/i);
  assert.throws(
    () => loadOrchestratorConfig({ PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'bad id/../x' }),
    /instance id/i,
  );
});

test('config: service tokens are read from a file, never from source or a literal env default', () => {
  const cfg = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_TOKENS_PATH: '/etc/project-workbench/orchestrator-tokens.json',
  });
  assert.equal(cfg.tokensPath, '/etc/project-workbench/orchestrator-tokens.json');
  assert.deepEqual(cfg.tokens, [], 'tokens are loaded at runtime from the file, not baked into config');
});
