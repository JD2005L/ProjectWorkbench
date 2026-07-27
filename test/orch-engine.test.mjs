// Increments 7-10 — the job engine, evidence, typed interaction, and the publication gate.
//
// Everything here runs against a *disposable* git repository, a temporary store, a private tmux
// namespace, and a deterministic fake backend. Nothing touches a live project, a live tmux server,
// or the operator's OAuth session.
//
// The contract's own acceptance list (§11) is the spine of this file: idempotent submission, stale
// fencing rejection, gapless resumable events, evidence-free progress claims refused, a question
// round-trip, cancellation leaving the tree byte-identical, publication only after a real SHA
// comparison, and survival of a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository, KIND } from '../app/orchestrator/store/repo.js';
import { OrchestrationEngine } from '../app/orchestrator/engine.js';
import { ArtifactStore, CheckRunner } from '../app/orchestrator/checks.js';
import { ProjectConfigStore } from '../app/orchestrator/projects.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { ApiError } from '../app/orchestrator/errors.js';
import { assertGitArgvAllowed, FORBIDDEN_GIT_SUBCOMMANDS } from '../app/orchestrator/git.js';
import { JobStatus, ApprovalStatus, QuestionStatus, ReviewVerdict } from '../app/orchestrator/contract.js';

const execFileAsync = promisify(execFile);
const HAVE_GIT = await execFileAsync('git', ['--version']).then(() => true).catch(() => false);
const gitTest = (name, fn) => test(name, { skip: HAVE_GIT ? false : 'git is not installed' }, fn);

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';

const TOKEN = Object.freeze({
  token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: ['jobs:read', 'jobs:write', 'session:manage', 'publish'],
});

/** A disposable repository with one commit, a remote, and a dirty file the job must not touch. */
async function makeRepo(dir) {
  const run = (args, cwd = dir) => execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  await run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const answer = 41;\n');
  await run(['add', '.']);
  await run(['commit', '-qm', 'initial']);

  // A bare remote so a push is a real push and ls-remote returns a real SHA.
  const remote = `${dir}-remote.git`;
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await run(['remote', 'add', 'origin', remote]);
  return { run, remote };
}

/** Stand up the whole engine against temporary everything. */
async function withEngine(fn, { backendOptions, projectOverrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-eng-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const repoDir = path.join(workspaceRoot, 'Demo');
  fs.mkdirSync(repoDir, { recursive: true });
  const { run: git, remote } = HAVE_GIT ? await makeRepo(repoDir) : { run: null, remote: null };

  const projectsPath = path.join(dir, 'orchestrator-projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: {
      Demo: {
        display_name: 'Demo',
        capabilities: ['implementation', 'targeted_tests', 'full_test_suite', 'independent_review', 'publication'],
        // `true` always succeeds and needs no toolchain, so a check is a real subprocess with a
        // real exit code rather than a stub.
        verification_commands: ['true'],
        default_branch: 'main',
        has_ci: false,
        ...projectOverrides,
      },
    },
  }));

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: workspaceRoot,
    PW_ORCHESTRATOR_CHECK_TIMEOUT_MS: '60000',
  });

  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 1_000,
  });
  const repo = new OrchestratorRepository(store);
  const artifacts = new ArtifactStore({ config, repo, store });
  const checkRunner = new CheckRunner({ config, repo, store, artifacts });
  const projectStore = new ProjectConfigStore(projectsPath);
  const backend = new FakeCodingBackend(backendOptions);

  // A session manager stub: lane behaviour has its own test file, and standing up tmux here would
  // couple every engine test to it.
  const sessionManager = {
    ensureSession: async () => ({ session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`, status: 'missing' }),
    verifySession: async ({ request }) => {
      const outcome = await backend.verifyConfiguration({ requested: request.requested, phaseClass: request.phase_class, sessionKey: request.session_key });
      return { session_key: request.session_key, ...outcome };
    },
  };

  const engine = new OrchestrationEngine({
    config, store, repo, backend, sessionManager, artifacts, checkRunner, projectStore,
  });

  try {
    await fn({ engine, store, repo, config, backend, artifacts, repoDir, git, remote, projectStore, dir });
  } finally {
    await engine.drain().catch(() => {});
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
}

const submission = (overrides = {}) => ({
  idempotency_key: 'req-0001',
  orchestrator_instance_id: ORCH,
  orchestrator_job_id: 'job_3f2a',
  project_id: 'Demo',
  session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`,
  task: {
    title: 'Fix the refresh-token expiry',
    goal: 'Refresh tokens stop being accepted after their expiry.',
    acceptance_criteria: ['An expired refresh token is rejected with 401.'],
    constraints: [], out_of_scope: [], likely_paths: [], required_checks: [],
  },
  requested: { model_alias: 'sonnet', effort: 'high' },
  max_phase_turns: 10,
  max_revision_cycles: 1,
  fencing_token: 7,
  ...overrides,
});

const submit = (engine, overrides = {}, idempotencyKey = 'req-0001') => engine.submitJob({
  token: TOKEN, body: submission(overrides), idempotencyKey, correlationId: 'corr-1',
});

// ---------------------------------------------------------------------------
// the git allowlist — the structural basis of "cancellation preserves the tree"
// ---------------------------------------------------------------------------

test('git: every destructive subcommand is unreachable, not merely unused', () => {
  for (const subcommand of ['reset', 'checkout', 'restore', 'clean', 'stash', 'rebase', 'merge', 'rm', 'revert', 'filter-branch', 'update-ref', 'reflog']) {
    assert.ok(FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand), `${subcommand} must be listed as forbidden`);
    assert.throws(() => assertGitArgvAllowed([subcommand]), ApiError, `git ${subcommand} must be refused`);
  }
  // Options that would turn an allowed subcommand destructive.
  assert.throws(() => assertGitArgvAllowed(['push', '--force', 'origin', 'main']), ApiError);
  assert.throws(() => assertGitArgvAllowed(['push', 'origin', ':refs/heads/main']), ApiError);
  assert.throws(() => assertGitArgvAllowed(['branch', '-D', 'main']), ApiError);
  assert.throws(() => assertGitArgvAllowed(['worktree', 'remove', 'x']), ApiError);
  assert.throws(() => assertGitArgvAllowed(['config', 'user.email', 'x@example.com']), ApiError);
  // A global option before the subcommand could relocate the repository or inject config.
  assert.throws(() => assertGitArgvAllowed(['-c', 'core.hooksPath=/tmp/evil', 'status']), ApiError);
  assert.throws(() => assertGitArgvAllowed(['--git-dir=/etc', 'status']), ApiError);
  // And the safe ones still work.
  for (const argv of [['status', '--porcelain=v1'], ['diff', '--check'], ['add', '--', 'a.js'], ['commit', '-m', 'x'], ['push', 'origin', 'HEAD:refs/heads/b'], ['config', '--get', 'remote.origin.url']]) {
    assert.doesNotThrow(() => assertGitArgvAllowed(argv), `${argv.join(' ')} should be permitted`);
  }
});

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

gitTest('engine: a duplicate submission returns the original handle and creates no second job', async () => {
  await withEngine(async ({ engine, repo }) => {
    const first = await submit(engine);
    await engine.drain();
    const second = await submit(engine);

    assert.equal(second.deduplicated, true);
    assert.equal(second.workbench_job_id, first.workbench_job_id);
    assert.equal(first.deduplicated, false);
    assert.equal(repo.listJobs().length, 1, 'a retry must not create a second job');
  });
});

gitTest('engine: the same key with different content is a conflict, not a silent overwrite', async () => {
  await withEngine(async ({ engine }) => {
    await submit(engine);
    await engine.drain();
    await assert.rejects(
      submit(engine, { task: { ...submission().task, title: 'A completely different task' } }),
      (err) => err instanceof ApiError && err.code === 'idempotency_key_reused' && err.status === 409,
    );
  });
});

gitTest('engine: a submission with a stale fencing token is refused with lease_lost', async () => {
  await withEngine(async ({ engine, repo }) => {
    await submit(engine, { fencing_token: 7 }, 'req-a');
    await engine.drain();
    // A higher token is a legitimate takeover.
    await submit(engine, { fencing_token: 8, orchestrator_job_id: 'job_b' }, 'req-b');
    await engine.drain();

    // The stalled orchestrator wakes up and tries to write with its old token.
    await assert.rejects(
      submit(engine, { fencing_token: 7, orchestrator_job_id: 'job_c' }, 'req-c'),
      (err) => err instanceof ApiError && err.code === 'lease_lost' && err.status === 409,
    );
    assert.equal(repo.listJobs().length, 2, 'a fenced-out submission must create nothing');
  });
});

gitTest('engine: a check name that is not in the catalogue is refused, never executed', async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(
      submit(engine, { task: { ...submission().task, required_checks: ['rm -rf /'] } }),
      (err) => err instanceof ApiError && err.code === 'validation_failed',
    );
    await assert.rejects(
      submit(engine, { task: { ...submission().task, required_checks: ['npm run whatever'] } }),
      (err) => err instanceof ApiError && err.code === 'validation_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// configuration gating
// ---------------------------------------------------------------------------

gitTest('engine: an unverifiable configuration blocks the job before any file is read', async () => {
  await withEngine(async ({ engine, repo, repoDir, backend }) => {
    const before = fs.readFileSync(path.join(repoDir, 'src.js'), 'utf8');
    const handle = await submit(engine);
    await engine.drain();

    const job = repo.getJob(handle.workbench_job_id);
    assert.equal(job.status, JobStatus.BLOCKED_CONFIGURATION);
    // Nothing may have been touched: the job blocked before the discovery phase.
    assert.equal(fs.readFileSync(path.join(repoDir, 'src.js'), 'utf8'), before);
    assert.ok(!backend.invocations.some((i) => i.kind === 'phase'), 'no coding phase may have run');
  }, { backendOptions: { effective: null } });
});

gitTest('engine: a drifted configuration also blocks, and never proceeds on a near-match', async () => {
  await withEngine(async ({ engine, repo }) => {
    const handle = await submit(engine);
    await engine.drain();
    assert.equal(repo.getJob(handle.workbench_job_id).status, JobStatus.BLOCKED_CONFIGURATION);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'low' } } });
});

// ---------------------------------------------------------------------------
// the full lifecycle
// ---------------------------------------------------------------------------

gitTest('engine: a job runs to the publication gate with real check evidence', async () => {
  await withEngine(async ({ engine, repo, repoDir }) => {
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    const job = repo.getJob(jobId);

    assert.equal(job.status, JobStatus.WAITING_FOR_PUBLICATION_APPROVAL);

    // Events are gapless from 1 and ordered.
    const events = engine.getEvents(TOKEN, jobId, { limit: 200 }).events;
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));

    // Checks carry real exit codes from real subprocesses.
    const checks = engine.getChecks(TOKEN, jobId).checks;
    assert.ok(checks.length >= 3, `expected several checks, saw ${checks.length}`);
    for (const check of checks) {
      assert.ok(['passed', 'failed', 'not_run', 'errored'].includes(check.outcome));
      if (check.outcome === 'passed') assert.ok((check.failed_count ?? 0) === 0);
    }
    assert.ok(checks.some((c) => c.kind === 'secret_scan'), 'the added-line secret scan must run');
    assert.ok(checks.some((c) => c.kind === 'diff_check'), 'git diff --check must run');

    // A check_completed event must carry evidence, and every one here does.
    for (const event of events.filter((e) => e.event_type === 'check_completed')) {
      assert.ok(event.evidence, 'a check_completed event must carry evidence');
      assert.ok(event.evidence.command || event.evidence.artifact_id);
    }

    // The review must be recorded as isolated from the implementation session.
    const reviews = engine.getReviews(TOKEN, jobId).reviews;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].verdict, ReviewVerdict.APPROVED);
    assert.equal(reviews[0].session_isolated, true);

    // And the publication approval is pending, not granted.
    const approvals = engine.getApprovals(TOKEN, jobId).approvals;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].approval_type, 'publication');
    assert.equal(approvals[0].status, ApprovalStatus.PENDING);
    assert.ok(approvals[0].requested_action, 'a human must be shown the exact proposed action');
    assert.ok(approvals[0].expires_at);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: an independent review that reused the implementation session is not independent', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // Every phase, including the review, comes back with the *same* session id.
    backend.phaseResults = Array.from({ length: 6 }, () => ({
      ok: true, session_id: 'same-session', effective: null, summary: 'done', questions: [],
      turns_used: 1, max_turns_reached: false,
    }));
    const handle = await submit(engine);
    await engine.drain();

    const reviews = engine.getReviews(TOKEN, handle.workbench_job_id).reviews;
    assert.equal(reviews[0].session_isolated, false);
    assert.notEqual(reviews[0].verdict, ReviewVerdict.APPROVED, 'a non-isolated review may not approve');
    assert.equal(repo.getJob(handle.workbench_job_id).status, JobStatus.BLOCKED_REVIEW);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: a max-turn exit is a failure, never a success', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    backend.phaseResults = [{
      ok: false, failure_kind: 'max_turns', max_turns_reached: true, turns_used: 10,
      session_id: 's1', summary: 'ran out of turns', questions: [],
    }];
    const handle = await submit(engine);
    await engine.drain();
    const job = repo.getJob(handle.workbench_job_id);
    assert.ok(job.status.startsWith('blocked_'), `expected a blocked state, got ${job.status}`);
    assert.notEqual(job.status, JobStatus.COMPLETED);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: backend failures reach distinct safe states, preserving work', async () => {
  const cases = [
    ['authExpired', JobStatus.BLOCKED_AUTHENTICATION],
    ['rateLimited', JobStatus.BLOCKED_RATE_LIMIT],
    ['unavailable', JobStatus.BLOCKED_CONNECTIVITY],
  ];
  for (const [flag, expected] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await withEngine(async ({ engine, repo, backend }) => {
      backend[flag] = true;
      const handle = await submit(engine);
      await engine.drain();
      assert.equal(repo.getJob(handle.workbench_job_id).status, expected, `${flag} should reach ${expected}`);
    }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
  }
});

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

gitTest('engine: a question flows out with a real id and only its own answer resolves it', async () => {
  await withEngine(async ({ engine, repo }) => {
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;

    const question = await engine.raiseQuestion(jobId, {
      question: 'Should the existing refresh-token format remain backward compatible?',
      options: ['Preserve compatibility', 'Prepare a migration plan', 'Cancel this change'],
      decisionScope: 'architecture',
    });

    // The question is retrievable with everything a human needs to decide.
    const listed = engine.getQuestions(TOKEN, jobId).questions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].question_id, question.question_id);
    assert.equal(listed[0].decision_scope, 'architecture');
    assert.equal(listed[0].default_action_on_timeout, 'remain_blocked');
    assert.equal(listed[0].blocking, true);
    assert.ok(listed[0].expires_at);
    assert.equal(listed[0].options.length, 3);

    // A fabricated id fails.
    await assert.rejects(
      engine.replyToQuestion({ token: TOKEN, jobId, body: { workbench_job_id: jobId, question_id: 'pwq_deadbeef', answer: 'yes' }, idempotencyKey: 'k' }),
      (err) => err instanceof ApiError && err.code === 'not_found',
    );
    // An out-of-range option fails.
    await assert.rejects(
      engine.replyToQuestion({ token: TOKEN, jobId, body: { workbench_job_id: jobId, question_id: question.question_id, answer: 'yes', selected_option_index: 9 }, idempotencyKey: 'k' }),
      (err) => err instanceof ApiError && err.code === 'validation_failed',
    );

    // The real answer lands once.
    await engine.replyToQuestion({
      token: TOKEN, jobId,
      body: { workbench_job_id: jobId, question_id: question.question_id, answer: 'Preserve compatibility', selected_option_index: 0 },
      idempotencyKey: 'k1',
    });
    await engine.drain();
    assert.equal(engine.getQuestions(TOKEN, jobId).questions[0].status, QuestionStatus.ANSWERED);

    // A second answer to the same question is refused: it is no longer live.
    await assert.rejects(
      engine.replyToQuestion({ token: TOKEN, jobId, body: { workbench_job_id: jobId, question_id: question.question_id, answer: 'changed my mind' }, idempotencyKey: 'k2' }),
      (err) => err instanceof ApiError && err.code === 'conflict',
    );
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest("engine: a question cannot be answered through a different job", async () => {
  await withEngine(async ({ engine }) => {
    const a = await submit(engine, {}, 'req-a');
    await engine.drain();
    const b = await submit(engine, { orchestrator_job_id: 'job_b', fencing_token: 8 }, 'req-b');
    await engine.drain();

    const question = await engine.raiseQuestion(a.workbench_job_id, { question: 'which?' });
    await assert.rejects(
      engine.replyToQuestion({
        token: TOKEN, jobId: b.workbench_job_id,
        body: { workbench_job_id: b.workbench_job_id, question_id: question.question_id, answer: 'x' },
        idempotencyKey: 'k',
      }),
      (err) => err instanceof ApiError && err.code === 'not_found',
    );
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

// ---------------------------------------------------------------------------
// cross-tenant isolation
// ---------------------------------------------------------------------------

gitTest("engine: another orchestrator's job is not found, not forbidden", async () => {
  await withEngine(async ({ engine }) => {
    const handle = await submit(engine);
    await engine.drain();
    const intruder = { ...TOKEN, orchestrator_instance_id: 'orch-other' };

    for (const call of [
      () => engine.getJob(intruder, handle.workbench_job_id),
      () => engine.getEvents(intruder, handle.workbench_job_id),
      () => engine.getChecks(intruder, handle.workbench_job_id),
      () => engine.getReviews(intruder, handle.workbench_job_id),
      () => engine.getQuestions(intruder, handle.workbench_job_id),
      () => engine.getApprovals(intruder, handle.workbench_job_id),
      () => engine.getResult(intruder, handle.workbench_job_id),
    ]) {
      assert.throws(call, (err) => err instanceof ApiError && err.code === 'not_found');
    }
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest("engine: another orchestrator's artifact is not readable even with a valid id", async () => {
  await withEngine(async ({ engine, artifacts }) => {
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    const artifact = await artifacts.write({ jobId, name: 'x.log', content: 'sensitive evidence' });

    const intruder = { ...TOKEN, orchestrator_instance_id: 'orch-other' };
    await assert.rejects(
      engine.getArtifactMetadata(intruder, artifact.artifact_id),
      (err) => err instanceof ApiError && err.code === 'not_found',
    );
    await assert.rejects(
      engine.getArtifactExcerpt(intruder, { artifact_id: artifact.artifact_id, byte_offset: 0, max_bytes: 100 }),
      (err) => err instanceof ApiError && err.code === 'not_found',
    );
    // The owner can read it, bounded.
    const excerpt = await engine.getArtifactExcerpt(TOKEN, { artifact_id: artifact.artifact_id, byte_offset: 0, max_bytes: 4 });
    assert.equal(excerpt.content.length, 4);
    assert.equal(excerpt.truncated, true);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

gitTest('engine: cancellation leaves the working tree byte-identical', async () => {
  await withEngine(async ({ engine, repo, repoDir }) => {
    // Uncommitted work an operator cares about, plus an untracked file.
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42; // in progress\n');
    fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'do not lose me\n');
    const before = {
      src: fs.readFileSync(path.join(repoDir, 'src.js'), 'utf8'),
      scratch: fs.readFileSync(path.join(repoDir, 'scratch.txt'), 'utf8'),
    };

    const handle = await submit(engine);
    await engine.drain();
    const state = await engine.cancelJob({
      token: TOKEN, jobId: handle.workbench_job_id,
      body: { workbench_job_id: handle.workbench_job_id, reason: 'director changed priority' },
    });

    assert.equal(state.status, JobStatus.CANCELLED);
    assert.equal(fs.readFileSync(path.join(repoDir, 'src.js'), 'utf8'), before.src);
    assert.equal(fs.readFileSync(path.join(repoDir, 'scratch.txt'), 'utf8'), before.scratch);
    assert.equal(repo.getJob(handle.workbench_job_id).working_tree_preserved, true);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

// ---------------------------------------------------------------------------
// publication
// ---------------------------------------------------------------------------

/** Drive a job to the publication gate and grant the approval. */
async function readyToPublish(engine, repoDir) {
  const handle = await submit(engine);
  await engine.drain();
  const jobId = handle.workbench_job_id;
  const approval = engine.getApprovals(TOKEN, jobId).approvals[0];
  return { jobId, approval };
}

gitTest('engine: publication is refused without a recorded human approval', async () => {
  await withEngine(async ({ engine, repoDir }) => {
    const { jobId, approval } = await readyToPublish(engine, repoDir);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');

    const request = {
      job_id: jobId, branch: 'orch/fix-expiry', commit_message: 'fix: expiry',
      intended_files: ['src.js'], open_pull_request: false, approval_id: null,
    };
    // No approval id at all.
    await assert.rejects(
      engine.publish({ token: TOKEN, jobId, request, idempotencyKey: 'p1', correlationId: 'c' }),
      (err) => err instanceof ApiError && err.code === 'forbidden_scope',
    );
    // A real approval that is still pending is not an approval.
    await assert.rejects(
      engine.publish({ token: TOKEN, jobId, request: { ...request, approval_id: approval.approval_id }, idempotencyKey: 'p2', correlationId: 'c' }),
      (err) => err instanceof ApiError && err.code === 'forbidden_scope',
    );
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: publication stages only the intended files and verifies the real remote SHA', async () => {
  await withEngine(async ({ engine, repo, repoDir, remote }) => {
    const { jobId, approval } = await readyToPublish(engine, repoDir);

    // Two dirty files; only one is intended. The other must not be published.
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\nunrelated edit\n');

    await engine.approveStage({
      token: TOKEN, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    const record = await engine.publish({
      token: TOKEN, jobId,
      request: {
        job_id: jobId, branch: 'orch/fix-expiry', commit_message: 'fix: reject expired refresh tokens',
        intended_files: ['src.js'], open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });

    assert.equal(record.pushed, true);
    assert.equal(record.remote_sha_verified, true, 'the local and remote SHAs must have matched');
    assert.match(record.local_commit, /^[a-f0-9]{40}$/, 'full SHAs only — abbreviations are refused');
    assert.equal(record.local_commit, record.remote_commit);
    assert.deepEqual(record.changed_files, ['src.js'], 'the unrelated edit must not have been published');

    // And the unrelated edit is still sitting in the working tree, unpublished and unharmed.
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoDir });
    assert.match(status.stdout, /README\.md/);

    // The remote genuinely has the commit.
    const lsRemote = await execFileAsync('git', ['ls-remote', remote, 'refs/heads/orch/fix-expiry']);
    assert.ok(lsRemote.stdout.startsWith(record.local_commit));

    assert.equal(repo.getJob(jobId).status, JobStatus.COMPLETED);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: a mismatch between intended and staged files aborts before committing', async () => {
  await withEngine(async ({ engine, repo, repoDir }) => {
    const { jobId, approval } = await readyToPublish(engine, repoDir);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\nunrelated\n');
    // Something already staged that was never intended.
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });

    await engine.approveStage({
      token: TOKEN, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    const record = await engine.publish({
      token: TOKEN, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });

    assert.equal(record.pushed, false);
    assert.equal(record.remote_sha_verified, false);
    assert.equal(record.local_commit, null, 'nothing may have been committed');
    assert.notEqual(repo.getJob(jobId).status, JobStatus.COMPLETED);
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: a declined approval completes the job without publishing anything', async () => {
  await withEngine(async ({ engine, repo, repoDir, remote }) => {
    const { jobId, approval } = await readyToPublish(engine, repoDir);
    await engine.approveStage({
      token: TOKEN, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: false, reason: 'not now', decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    assert.equal(engine.getApprovals(TOKEN, jobId).approvals[0].status, ApprovalStatus.REJECTED);
    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'nothing may have been pushed');
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: publication is idempotent — a retry does not produce a second commit', async () => {
  await withEngine(async ({ engine, repoDir }) => {
    const { jobId, approval } = await readyToPublish(engine, repoDir);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: TOKEN, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    const request = {
      job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
      open_pull_request: false, approval_id: approval.approval_id,
    };
    const first = await engine.publish({ token: TOKEN, jobId, request, idempotencyKey: 'p1', correlationId: 'c' });
    const second = await engine.publish({ token: TOKEN, jobId, request, idempotencyKey: 'p1', correlationId: 'c' });
    assert.equal(second.publication_id, first.publication_id);
    assert.equal(second.local_commit, first.local_commit);

    const log = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir });
    assert.equal(log.stdout.trim(), '2', 'exactly one new commit may exist');
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

// ---------------------------------------------------------------------------
// revisions and restart
// ---------------------------------------------------------------------------

gitTest('engine: revisions are bounded by the job’s own budget', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // A revision is what follows a review that found problems, so drive the job there: the
    // normative transition table does not permit revising a job that is already awaiting
    // publication approval, and it is right not to.
    backend.phaseResults = Array.from({ length: 6 }, () => ({
      ok: true, session_id: 'same-session', effective: null, summary: 'done', questions: [],
      turns_used: 1, max_turns_reached: false,
    }));
    const handle = await submit(engine, { max_revision_cycles: 1 });
    await engine.drain();
    const jobId = handle.workbench_job_id;
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_REVIEW);

    await engine.requestRevision({ token: TOKEN, jobId, body: { workbench_job_id: jobId, instructions: 'tighten the expiry check' } });
    assert.equal(repo.getJob(jobId).revision_cycles_used, 1);

    await assert.rejects(
      engine.requestRevision({ token: TOKEN, jobId, body: { workbench_job_id: jobId, instructions: 'and again' } }),
      (err) => err instanceof ApiError && err.code === 'conflict',
    );
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: a restart reconciles a job that was mid-flight rather than assuming it finished', async () => {
  await withEngine(async ({ engine, store, repo, config, backend, artifacts, projectStore }) => {
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;

    // Simulate a crash mid-implementation: the durable record says implementing, no worker exists.
    await store.transact((tx, state) => {
      const job = state.get(KIND.JOBS, jobId);
      repo.putJob(tx, { ...job, status: JobStatus.IMPLEMENTING, lease_fencing_token: 1 });
    });

    const fresh = new OrchestrationEngine({
      config, store, repo, backend, artifacts, projectStore,
      checkRunner: null,
      sessionManager: { ensureSession: async () => ({}), verifySession: async () => ({}) },
    });
    const reconciled = await fresh.reconcileOnStart();

    assert.equal(reconciled, 1);
    const job = repo.getJob(jobId);
    // Unknown partial state is blocked for reconciliation against the repository, never resumed on
    // an assumption about what the dead process had finished.
    assert.equal(job.status, JobStatus.BLOCKED_PROJECT_STATE);
    assert.equal(job.lease_fencing_token, null, 'the lease must be released');
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});

gitTest('engine: the event timeline survives a restart with its cursor intact', async () => {
  await withEngine(async ({ engine, store, repo, config }) => {
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    const before = engine.getEvents(TOKEN, jobId, { limit: 200 });
    assert.ok(before.latest_sequence > 5);

    await store.close();
    const reopened = await JournalStore.open({
      journalPath: config.journalPath, snapshotPath: config.snapshotPath,
      lockPath: config.lockPath, compactEveryRecords: 1_000,
    });
    const freshRepo = new OrchestratorRepository(reopened);
    const after = freshRepo.listEvents(jobId, { limit: 200 });
    assert.equal(after.length, before.events.length);
    assert.equal(freshRepo.latestSequence(jobId), before.latest_sequence);
    await reopened.close();

    // Leave a live store behind so the fixture's own close() is a no-op rather than an error.
    const final = await JournalStore.open({
      journalPath: config.journalPath, snapshotPath: config.snapshotPath,
      lockPath: config.lockPath, compactEveryRecords: 1_000,
    });
    Object.assign(store, { _closed: false });
    await final.close();
  }, { backendOptions: { effective: { model_alias: 'sonnet', effort: 'high' } } });
});
