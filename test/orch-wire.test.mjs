// Cross-contract validation of what this service actually emits.
//
// An independent review found three P0 wire breaks that every other test in this suite missed —
// `Actor` given a `schema_version` it does not have, and `Question`/`Approval` returned as raw
// stored records carrying internal bookkeeping. All three were invisible from the JavaScript side
// because nothing here knew the Pydantic models use `extra="forbid"`.
//
// So this file does the only thing that would have caught them: it runs a real job, captures the
// real payloads, and feeds them to the orchestrator's own models through its own interpreter. It
// skips when that repository is absent rather than passing vacuously — a check that quietly
// succeeds when it cannot run is worse than no check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { OrchestrationEngine } from '../app/orchestrator/engine.js';
import { ArtifactStore, CheckRunner } from '../app/orchestrator/checks.js';
import { ProjectConfigStore, projectPayload, capabilitiesPayload } from '../app/orchestrator/projects.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

const execFileAsync = promisify(execFile);
const ORCHESTRATOR_ROOT = '/opt/project-workbench/workspaces/PVICodingOrchestrator';
const VENV_PYTHON = path.join(ORCHESTRATOR_ROOT, '.venv', 'bin', 'python');
const HAVE_GIT = await execFileAsync('git', ['--version']).then(() => true).catch(() => false);
const HAVE_ORCHESTRATOR = fs.existsSync(VENV_PYTHON) && fs.existsSync(path.join(ORCHESTRATOR_ROOT, 'src'));

const wireTest = (name, fn) => test(name, {
  skip: (HAVE_ORCHESTRATOR && HAVE_GIT)
    ? false
    : 'needs git and the orchestrator repository with its venv',
}, fn);

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';
const TOKEN = Object.freeze({
  token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: ['jobs:read', 'jobs:write', 'session:manage', 'publish'],
});

/**
 * Validate payloads against the orchestrator's real Pydantic models.
 *
 * `cases` is `{ label: [modelName, payload] }`. Returns `{ label: null | errorText }` so one run
 * reports every failure rather than stopping at the first.
 */
function validateAgainstContract(cases) {
  const script = `
import json, sys
from pydantic import ValidationError
import pvi_orchestrator.contracts.common as common
import pvi_orchestrator.contracts.events as events
import pvi_orchestrator.contracts.evidence as evidence
import pvi_orchestrator.contracts.interaction as interaction
import pvi_orchestrator.contracts.jobs as jobs
import pvi_orchestrator.contracts.policy as policy
import pvi_orchestrator.contracts.publication as publication
import pvi_orchestrator.contracts.workbench as workbench
import pvi_orchestrator.contracts.health as health
import pvi_orchestrator.workbench.protocol as protocol

MODULES = [common, events, evidence, interaction, jobs, policy, publication, workbench, health, protocol]

def find(name):
    for module in MODULES:
        if hasattr(module, name):
            return getattr(module, name)
    raise LookupError(name)

cases = json.load(sys.stdin)
out = {}
for label, (model_name, payload) in cases.items():
    try:
        find(model_name).model_validate(payload)
        out[label] = None
    except ValidationError as exc:
        out[label] = str(exc)
    except LookupError:
        out[label] = f"no such contract model: {model_name}"
print(json.dumps(out))
`;
  const stdout = execFileSync(VENV_PYTHON, ['-c', script], {
    cwd: ORCHESTRATOR_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(ORCHESTRATOR_ROOT, 'src') },
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return JSON.parse(stdout);
}

/**
 * Run the orchestrator's **policy** validator over an attestation, not merely its schema.
 *
 * The schema check is not sufficient and the distinction is the point of this round: a payload
 * claiming `effort_provenance: "runtime_reported"` is perfectly well-shaped, and is refused by
 * `validate_attestation` because the orchestrator's own table records that claude-code cannot
 * report effort. A shape-only check said yes to exactly the claim the contract exists to refuse.
 *
 * Returns `{ accepted, summary|error }`.
 */
function validatePolicy(attestation, { backend = 'claude-code', mayAttestLaunch = true, expectation }) {
  const script = `
import json, sys
from datetime import datetime
from pvi_orchestrator.contracts.policy import SettingsAttestation
from pvi_orchestrator.policy.attestation import validate_attestation, AttestationRejectedError

payload = json.load(sys.stdin)
attestation = SettingsAttestation.model_validate(payload["attestation"])
try:
    result = validate_attestation(
        attestation,
        instance_id=payload["instance_id"],
        may_attest_launch=payload["may_attest_launch"],
        backend=payload["backend"],
        session_key=payload["session_key"],
        run_id=payload["run_id"],
        verification_nonce=payload["verification_nonce"],
        config_generation=payload["config_generation"],
        known_fingerprint=payload["known_fingerprint"],
        now=datetime.fromisoformat(payload["now"]),
    )
    print(json.dumps({"accepted": True, "summary": result.summary}))
except AttestationRejectedError as exc:
    print(json.dumps({"accepted": False, "error": str(exc)}))
`;
  const stdout = execFileSync(VENV_PYTHON, ['-c', script], {
    cwd: ORCHESTRATOR_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(ORCHESTRATOR_ROOT, 'src') },
    input: JSON.stringify({ attestation, backend, may_attest_launch: mayAttestLaunch, ...expectation }),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return JSON.parse(stdout);
}

/** Assert every case validated, reporting all failures at once. */
function assertAllValid(results) {
  const failures = Object.entries(results).filter(([, error]) => error !== null);
  assert.deepEqual(
    failures.map(([label]) => label), [],
    `payloads rejected by the orchestrator's own models:\n\n${
      failures.map(([label, error]) => `### ${label}\n${error}`).join('\n\n')}`,
  );
}

/** Run one full job against a disposable repository and capture everything it emits. */
async function capturePayloads() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-wire-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const repoDir = path.join(workspaceRoot, 'Demo');
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (args, cwd = repoDir) => execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  await git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 41;\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'initial']);
  const remote = `${repoDir}-remote.git`;
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await git(['remote', 'add', 'origin', remote]);

  const projectsPath = path.join(dir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: {
      Demo: {
        display_name: 'Demo', capabilities: ['implementation', 'targeted_tests', 'publication'],
        verification_commands: ['true'], default_branch: 'main', has_ci: false,
      },
    },
  }));

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: workspaceRoot,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 1_000,
  });
  const repo = new OrchestratorRepository(store);
  const artifacts = new ArtifactStore({ config, repo, store });
  const projectStore = new ProjectConfigStore(projectsPath);
  const backend = new FakeCodingBackend({ effective: { model_alias: 'sonnet', effort: 'high' } });
  const sessionManager = {
    ensureSession: async () => ({ session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator` }),
    // Forwards the binding, as the real OrchestratorSessionManager does — a stub that dropped it
    // would hide the engine failing to bind its own request.
    verifySession: async ({ request }) => ({
      session_key: request.session_key,
      ...(await backend.verifyConfiguration({
        requested: request.requested,
        phaseClass: request.phase_class,
        sessionKey: request.session_key,
        runId: request.run_id ?? 'unbound',
        configGeneration: Number.isInteger(request.config_generation) ? request.config_generation : 0,
      })),
    }),
  };
  const engine = new OrchestrationEngine({
    config, store, repo, backend, sessionManager, artifacts, projectStore,
    checkRunner: new CheckRunner({ config, repo, store, artifacts }),
  });

  const handle = await engine.submitJob({
    token: TOKEN,
    body: {
      idempotency_key: 'req-1', orchestrator_instance_id: ORCH, orchestrator_job_id: 'job_1',
      project_id: 'Demo', session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`,
      task: {
        title: 'Fix the refresh-token expiry',
        goal: 'Refresh tokens stop being accepted after their expiry.',
        acceptance_criteria: ['An expired refresh token is rejected with 401.'],
        constraints: [], out_of_scope: [], likely_paths: [], required_checks: [],
      },
      requested: { model_alias: 'sonnet', effort: 'high' },
      max_phase_turns: 10, max_revision_cycles: 1, fencing_token: 7,
    },
    idempotencyKey: 'req-1', correlationId: 'corr-1',
  });
  await engine.drain();
  const jobId = handle.workbench_job_id;

  // A question, so the §9.1 payload is real rather than synthesised.
  await engine.raiseQuestion(jobId, {
    question: 'Should the existing refresh-token format remain backward compatible?',
    options: ['Preserve compatibility', 'Prepare a migration plan'],
    decisionScope: 'architecture',
  });

  const approval = engine.getApprovals(TOKEN, jobId).approvals[0];
  let decidedApproval = null;
  if (approval) {
    await engine.approveStage({
      token: { ...TOKEN, token_id: 'approver', scopes: ['jobs:read', 'approve'] }, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    decidedApproval = engine.getApprovals(TOKEN, jobId).approvals[0];
  }

  const events = engine.getEvents(TOKEN, jobId, { limit: 200 });
  const checks = engine.getChecks(TOKEN, jobId).checks;
  const reviews = engine.getReviews(TOKEN, jobId).reviews;
  const questions = engine.getQuestions(TOKEN, jobId).questions;
  const project = projectStore.load().get('Demo');
  const artifactId = checks.find((c) => c.artifact_id)?.artifact_id;

  const captured = {
    events,
    job: engine.getJob(TOKEN, jobId),
    handle,
    result: engine.getResult(TOKEN, jobId),
    checks,
    reviews,
    questions,
    approval,
    decidedApproval,
    project: projectPayload(config, project),
    capabilities: capabilitiesPayload(config, project),
    health: { ...(await backend.probeAuth()) },
    verification: await sessionManager.verifySession({
      request: { session_key: 'k', phase_class: 'implementation', requested: { model_alias: 'sonnet', effort: 'high' } },
    }),
    artifactMetadata: artifactId ? await engine.getArtifactMetadata(TOKEN, artifactId) : null,
    artifactExcerpt: artifactId
      ? await engine.getArtifactExcerpt(TOKEN, { artifact_id: artifactId, byte_offset: 0, max_bytes: 256 })
      : null,
  };

  await engine.drain();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
  return captured;
}

// ---------------------------------------------------------------------------

wireTest('wire: every payload a real job emits validates against the orchestrator’s own models', async () => {
  const p = await capturePayloads();

  const cases = {
    InstanceHealth: ['InstanceHealth', {
      schema_version: '1.0', instance_id: INSTANCE, contract_version: '1.0', reachable: true,
      workbench_version: 'test', backends: [p.health], checked_at: new Date().toISOString(),
    }],
    AuthHealth: ['AuthHealth', p.health],
    Project: ['Project', p.project],
    ProjectCapabilities: ['ProjectCapabilities', p.capabilities],
    SessionVerificationResponse: ['SessionVerificationResponse', {
      schema_version: '1.0', session_key: 'k',
      // `effective` is derived on the other side, never sent: an older peer never distinguished a
      // value it watched from one it merely passed on the command line, so its word covers neither.
      attestation: p.verification.settings_attestation ?? null,
      backend: p.verification.backend, checked_at: p.verification.checked_at,
      detail: p.verification.detail,
    }],
    WorkbenchJobHandle: ['WorkbenchJobHandle', p.handle],
    WorkbenchJobState: ['WorkbenchJobState', p.job],
    JobResult: ['JobResult', p.result],
  };

  // Every event individually, so a failure names the offending one.
  p.events.events.forEach((event, index) => {
    cases[`JobEvent[${index}] ${event.event_type}`] = ['JobEvent', event];
  });
  cases.EventBatch = ['EventBatch', {
    schema_version: '1.0', workbench_job_id: p.events.workbench_job_id,
    events: p.events.events, latest_sequence: p.events.latest_sequence,
  }];

  p.checks.forEach((check, index) => { cases[`Check[${index}] ${check.kind}`] = ['Check', check]; });
  p.reviews.forEach((review, index) => { cases[`Review[${index}]`] = ['Review', review]; });
  p.questions.forEach((question, index) => { cases[`Question[${index}]`] = ['Question', question]; });
  if (p.approval) cases['Approval(pending)'] = ['Approval', p.approval];
  if (p.decidedApproval) cases['Approval(decided)'] = ['Approval', p.decidedApproval];
  if (p.artifactMetadata) cases.ArtifactMetadata = ['ArtifactMetadata', p.artifactMetadata];
  if (p.artifactExcerpt) cases.ArtifactExcerpt = ['ArtifactExcerpt', p.artifactExcerpt];

  // The job must actually have got far enough to produce the interesting payloads, or this test
  // would pass by having nothing to check.
  assert.ok(p.events.events.length >= 10, `expected a full timeline, saw ${p.events.events.length} events`);
  assert.ok(p.checks.length >= 3, `expected several checks, saw ${p.checks.length}`);
  assert.ok(p.reviews.length >= 1, 'expected a review');
  assert.ok(p.questions.length >= 1, 'expected a question');
  assert.ok(p.approval, 'expected a publication approval');

  assertAllValid(validateAgainstContract(cases));
});

wireTest('wire: the attestation payloads validate against the orchestrator’s policy contracts', async () => {
  const { buildAttestation, DEFAULT_MODEL_ALIASES } = await import('../app/orchestrator/attestation.js');
  const fingerprint = {
    ok: true,
    realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
    version: '2.1.220 (Claude Code)',
    capabilities: {
      '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
      '--model': { declared: true, values: null },
    },
  };
  const common = {
    aliases: DEFAULT_MODEL_ALIASES,
    fingerprint,
    argvOwnedByServer: true,
    binding: {
      session_key: 'orch:wb-test-01:Demo:pvi2-orchestrator',
      run_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
      // Fresh per verification: the envelope carries it so a good answer cannot be replayed onto a
      // later verification of the same job.
      verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      config_generation: 3,
      at: '2026-07-27T12:00:00.000Z',
    },
    peerSchemaVersion: '1.1',
    instanceId: INSTANCE,
    argv: ['-p', 'x', '--model', 'sonnet', '--effort', 'high'],
    stderr: '',
  };
  const init = {
    model: 'claude-sonnet-5', apiKeySource: 'none', claude_code_version: '2.1.220',
    session_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  };

  // The combination the installed CLI actually produces: model observed, effort enforced.
  const enforced = buildAttestation({ ...common, init, requested: { model_alias: 'sonnet', effort: 'high' } });
  // A CLI that prints an effort field. It still does not make effort *observed*: that is settled by
  // the orchestrator's record of what the backend can report, not by what the payload says.
  const printsEffort = buildAttestation({
    ...common, init: { ...init, effort: 'high' }, requested: { model_alias: 'sonnet', effort: 'high' },
  });
  // xhigh, which the binary advertises and the orchestrator's Effort enum now names.
  const xhigh = buildAttestation({ ...common, init, requested: { model_alias: 'sonnet', effort: 'xhigh' } });

  assertAllValid(validateAgainstContract({
    'SettingsAttestation(model runtime, effort enforced)': ['SettingsAttestation', enforced.settings_attestation],
    'SettingsAttestation(CLI prints effort)': ['SettingsAttestation', printsEffort.settings_attestation],
    'SettingsAttestation(xhigh enforced)': ['SettingsAttestation', xhigh.settings_attestation],
    'LaunchAttestation': ['LaunchAttestation', enforced.settings_attestation.launch],
    'AttestationEnvelope': ['AttestationEnvelope', enforced.settings_attestation.envelope],
    'NormalizedField': ['NormalizedField', enforced.settings_attestation.normalization[0]],
    'ModelSettings(xhigh)': ['ModelSettings', xhigh.settings_attestation.effective],
  }));

  // The envelope applies to EVERY claim, and now carries the binary identity for all of them: with
  // those fields under `launch`, a peer skipped the whole fingerprint comparison — and the
  // administrator's may_attest_launch decision with it — by claiming to have observed both fields.
  const envelope = enforced.settings_attestation.envelope;
  assert.equal(envelope.auth_mode, 'subscription');
  assert.equal(envelope.binary_path, fingerprint.realpath);
  assert.equal(envelope.binary_version, '2.1.220 (Claude Code)');
  assert.match(envelope.capability_fingerprint, /^[a-f0-9]{64}$/);
  for (const moved of ['binary_path', 'binary_version', 'capability_fingerprint']) {
    assert.ok(!(moved in enforced.settings_attestation.launch), `${moved} is an envelope field now`);
  }

  // One structured normalization entry per runtime_reported field — and never one for effort, which
  // this backend cannot report.
  assert.deepEqual(enforced.settings_attestation.normalization.map((n) => n.field), ['model_alias']);
  assert.deepEqual(printsEffort.settings_attestation.normalization.map((n) => n.field), ['model_alias']);
  assert.equal(printsEffort.settings_attestation.effort_provenance, 'launch_enforced');
  assert.ok(printsEffort.settings_attestation.launch, 'effort still rests on the launch record');
  assert.ok(enforced.settings_attestation.launch);
});

wireTest('wire: the orchestrator’s own policy validator accepts what a real run emits', async () => {
  // Schema conformance is not acceptance. `validate_attestation` performs the checks the shape only
  // makes room for — binary identity, subscription auth, binding, and whether the backend can
  // report a field it claims to have observed — so this runs the real thing over the real payload.
  const { buildAttestation, DEFAULT_MODEL_ALIASES } = await import('../app/orchestrator/attestation.js');
  const binding = {
    session_key: 'orch:wb-test-01:Demo:pvi2-orchestrator',
    run_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
    verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    config_generation: 3,
    at: new Date().toISOString(),
  };
  const attestation = buildAttestation({
    requested: { model_alias: 'sonnet', effort: 'high' },
    aliases: DEFAULT_MODEL_ALIASES,
    init: {
      model: 'claude-sonnet-5', apiKeySource: 'none', claude_code_version: '2.1.220',
      session_id: binding.run_id,
    },
    fingerprint: {
      ok: true,
      realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
      version: '2.1.220 (Claude Code)',
      capabilities: {
        '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
        '--model': { declared: true, values: null },
      },
    },
    argvOwnedByServer: true,
    binding,
    instanceId: INSTANCE,
    argv: ['-p', 'x', '--model', 'sonnet', '--effort', 'high'],
  }).settings_attestation;

  const expectation = {
    instance_id: INSTANCE,
    session_key: binding.session_key,
    run_id: binding.run_id,
    verification_nonce: binding.verification_nonce,
    config_generation: binding.config_generation,
    // What the orchestrator has on record. PW computes it from the binary's advertised surface, so
    // an administrator registering the instance records the value PW itself produces.
    known_fingerprint: attestation.envelope.capability_fingerprint,
    now: new Date().toISOString(),
  };

  const accepted = validatePolicy(attestation, { expectation });
  assert.equal(accepted.accepted, true, `the orchestrator refused a real payload: ${accepted.error}`);

  // The bypass, stated as a payload: relabel the enforced half as an observation and hand it the
  // normalization the shape asks for. Well-formed, and refused — which is what makes the label mean
  // anything. If this is ever accepted, `runtime_reported` has become the cheap word again.
  const forged = {
    ...attestation,
    effort_provenance: 'runtime_reported',
    launch: null,
    normalization: [
      ...attestation.normalization,
      {
        schema_version: '1.0', field: 'effort', source_key: 'init.effort',
        raw_value: 'high', value: 'high',
      },
    ],
  };
  assert.equal(validateAgainstContract({ f: ['SettingsAttestation', forged] }).f, null,
    'the forgery must be schema-valid, or this proves nothing about the policy check');
  const refused = validatePolicy(forged, { expectation });
  assert.equal(refused.accepted, false, 'a claim to have observed effort must be refused');
  assert.match(refused.error, /does not report effort at runtime/);

  // And the identity check now applies to every claim, whatever its provenance.
  const unknownBinary = validatePolicy(attestation, {
    expectation: { ...expectation, known_fingerprint: null },
  });
  assert.equal(unknownBinary.accepted, false);
  assert.match(unknownBinary.error, /no capability fingerprint is on record/);
});

wireTest('wire: the orchestrator’s registry CLI accepts the report this repository produces', async () => {
  // The other half of the bootstrap, and the one this side could not previously demonstrate: the
  // report is not just well-formed, it is *consumable* by the command an administrator actually
  // runs. The orchestrator's registration doc invokes `scripts/pw-orch-fingerprint.mjs` by name and
  // pipes its JSON straight into `pin`, so the report's shape is now load-bearing on both sides.
  //
  // Runs against a throwaway database under the test's own temp directory. The orchestrator
  // repository is read-only here: nothing is written inside it, and its own database is untouched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-reg-'));
  try {
    const { buildFingerprintReport } = await import('../app/orchestrator/bootstrap.js');
    const { FakeCodingBackend } = await import('../app/orchestrator/runner/fake.js');
    const backend = new FakeCodingBackend();
    const report = buildFingerprintReport({
      instanceId: INSTANCE, fingerprint: await backend.fingerprint(),
    });
    const reportPath = path.join(dir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const registry = (...args) => {
      const result = execFileSync(VENV_PYTHON, [
        '-c', 'import sys;from pvi_orchestrator.registry_cli import main;sys.exit(main(sys.argv[1:]))', ...args,
      ], {
        cwd: ORCHESTRATOR_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: path.join(ORCHESTRATOR_ROOT, 'src'),
          PVIORCH_DATABASE_PATH: path.join(dir, 'registry.db'),
          PVIORCH_WORKBENCH_INSTANCES: JSON.stringify([{
            schema_version: '1.0', instance_id: INSTANCE,
            display_name: 'wire test', base_url: 'http://127.0.0.1:9999',
          }]),
        },
        encoding: 'utf8',
        timeout: 120_000,
      });
      return result;
    };

    // Unregistered is refused, and says how to fix itself.
    assert.match(registry('show', INSTANCE), /fingerprint\s+not pinned/);

    // The pin reads our report and records the value we would attest with.
    const pinned = registry('--operator', 'wire-test', 'pin', INSTANCE, '--report', reportPath, '--expected-version', '0');
    assert.match(pinned, /^pinned /m, pinned);
    // The prefix it prints must be a prefix of the digest, or an operator confirming a rotation by
    // eye is confirming something else.
    assert.ok(report.capability_fingerprint.startsWith(pinned.match(/pinned ([0-9a-f]+)/)[1]),
      `the CLI printed a prefix that is not ours: ${pinned}`);

    registry('--operator', 'wire-test', 'grant-launch-trust', INSTANCE, '--expected-version', '1');
    const after = registry('show', INSTANCE);
    assert.match(after, /launch trust\s+granted/);

    // Compare-and-set: a stale write is refused rather than silently winning. Two operators pinning
    // from two terminals is ordinary, and the loser needs to know they lost.
    assert.throws(
      () => registry('--operator', 'wire-test', 'pin', INSTANCE, '--report', reportPath, '--expected-version', '0'),
      /registry version/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

wireTest('wire: a verification response sends the attestation and never `effective`', async () => {
  // The contract derives `effective` from the attestation. A payload carrying `effective` is
  // refused rather than read as an observation, so sending it would be a hard incompatibility.
  const withEffective = {
    schema_version: '1.0', session_key: 'orch:wb:Demo:pvi2-orchestrator',
    effective: { schema_version: '1.0', model_alias: 'sonnet', effort: 'high' },
    backend: 'claude-code', checked_at: '2026-07-27T12:00:00.000Z', detail: null,
  };
  const rejected = validateAgainstContract({ x: ['SessionVerificationResponse', withEffective] });
  assert.ok(rejected.x, 'a payload carrying `effective` must be refused by the contract');
  assert.match(rejected.x, /extra_forbidden/);

  // A null attestation is the honest "could not determine, with any provenance".
  assertAllValid(validateAgainstContract({
    'SessionVerificationResponse(blocked)': ['SessionVerificationResponse', {
      schema_version: '1.0', session_key: 'orch:wb:Demo:pvi2-orchestrator',
      attestation: null, backend: 'claude-code',
      checked_at: '2026-07-27T12:00:00.000Z', detail: 'effort could not be attested',
    }],
  }));
});

wireTest('wire: an Actor carries no schema_version — it is a bare model on the other side', async () => {
  // The specific shape of the P0 this file exists to prevent, pinned so a well-meaning "add the
  // version everywhere" change fails here rather than in production.
  const results = validateAgainstContract({
    'Actor(correct)': ['Actor', { kind: 'workbench', identifier: 'wb-1' }],
    'Actor(with schema_version)': ['Actor', { schema_version: '1.0', kind: 'workbench', identifier: 'wb-1' }],
  });
  assert.equal(results['Actor(correct)'], null);
  assert.ok(results['Actor(with schema_version)'], 'a versioned Actor must be rejected by the contract');
  assert.match(results['Actor(with schema_version)'], /extra_forbidden/);
});

wireTest('wire: every orchestrator request model is accepted by the inbound validators', async () => {
  // The other direction: anything the orchestrator can serialise must be something this side
  // accepts, including the schema_version every VersionedContract carries.
  const script = `
import json
from datetime import datetime, timezone
from pvi_orchestrator.workbench import protocol
from pvi_orchestrator.contracts.jobs import TaskContract
from pvi_orchestrator.contracts.policy import ModelSettings, PhaseClass
from pvi_orchestrator.contracts.publication import PublicationRequest

settings = ModelSettings(model_alias="sonnet", effort="high")
task = TaskContract(
    title="Fix the refresh-token expiry",
    goal="Refresh tokens stop being accepted after their expiry.",
    acceptance_criteria=["An expired refresh token is rejected with 401."],
)
out = {
  "EnsureSessionRequest": protocol.EnsureSessionRequest(
      orchestrator_instance_id="orch-test", project_id="Demo").model_dump(mode="json"),
  # No default any more, deliberately: every other security-relevant default on this surface
  # refuses, and a fixed publicly-known nonce would be the one that does not.
  "VerifySessionRequest": protocol.VerifySessionRequest(
      session_key="orch-test:wb-test-01:Demo:pvi2-orchestrator",
      phase_class=PhaseClass.IMPLEMENTATION, requested=settings,
      verification_nonce="a1b2c3d4e5f60718293a4b5c6d7e8f90").model_dump(mode="json"),
  "SubmitJobRequest": protocol.SubmitJobRequest(
      idempotency_key="req-1", orchestrator_instance_id="orch-test", orchestrator_job_id="job_1",
      project_id="Demo", session_key="orch-test:wb-test-01:Demo:pvi2-orchestrator",
      task=task, requested=settings, max_phase_turns=10, max_revision_cycles=1,
      fencing_token=7).model_dump(mode="json"),
  "ReplyToQuestionRequest": protocol.ReplyToQuestionRequest(
      workbench_job_id="pwjob_1", question_id="pwq_1", answer="Preserve compatibility",
      selected_option_index=0).model_dump(mode="json"),
  "ApproveStageRequest": protocol.ApproveStageRequest(
      workbench_job_id="pwjob_1", approval_id="pwapr_1", stage="publication",
      approved=True, reason="looks right").model_dump(mode="json"),
  "RequestRevisionRequest": protocol.RequestRevisionRequest(
      workbench_job_id="pwjob_1", instructions="tighten the expiry check").model_dump(mode="json"),
  "RequestReviewRequest": protocol.RequestReviewRequest(
      workbench_job_id="pwjob_1", requested=settings).model_dump(mode="json"),
  "CancelJobRequest": protocol.CancelJobRequest(
      workbench_job_id="pwjob_1", reason="director changed priority").model_dump(mode="json"),
  "ArtifactExcerptRequest": protocol.ArtifactExcerptRequest(
      artifact_id="pwart_1").model_dump(mode="json"),
  "PublicationRequest": PublicationRequest(
      job_id="pwjob_1", branch="orch/fix", commit_message="fix: expiry",
      intended_files=["src.js"]).model_dump(mode="json"),
}
print(json.dumps(out))
`;
  const serialised = JSON.parse(execFileSync(VENV_PYTHON, ['-c', script], {
    cwd: ORCHESTRATOR_ROOT,
    env: { ...process.env, PYTHONPATH: path.join(ORCHESTRATOR_ROOT, 'src') },
    encoding: 'utf8', timeout: 60_000,
  }));

  const { validate } = await import('../app/orchestrator/validate.js');
  const schemas = await import('../app/orchestrator/schemas.js');
  const mapping = {
    EnsureSessionRequest: schemas.ENSURE_SESSION_SCHEMA,
    VerifySessionRequest: null, // declared inline in api.js; covered by the HTTP tests
    SubmitJobRequest: schemas.SUBMIT_JOB_SCHEMA,
    ReplyToQuestionRequest: schemas.REPLY_SCHEMA,
    ApproveStageRequest: schemas.APPROVE_SCHEMA,
    RequestRevisionRequest: schemas.REVISE_SCHEMA,
    RequestReviewRequest: schemas.REVIEW_SCHEMA,
    CancelJobRequest: schemas.CANCEL_SCHEMA,
    ArtifactExcerptRequest: schemas.ARTIFACT_EXCERPT_SCHEMA,
    PublicationRequest: schemas.PUBLICATION_REQUEST_SCHEMA,
  };

  for (const [name, schema] of Object.entries(mapping)) {
    if (!schema) continue;
    const payload = serialised[name];
    assert.ok(payload, `the orchestrator produced no ${name}`);
    assert.doesNotThrow(
      () => validate(schema, payload),
      `${name} as the orchestrator serialises it must be accepted:\n${JSON.stringify(payload, null, 2)}`,
    );
  }
});
