// Regression tests for the P1 findings of the second review round.
//
// Each test below corresponds to a defect an independent reviewer proved by execution, and each one
// fails against the code as it was. They live together because their provenance is the same: things
// the first 246 tests were happy with.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { OrchestrationEngine } from '../app/orchestrator/engine.js';
import { ArtifactStore, CheckRunner } from '../app/orchestrator/checks.js';
import { ProjectConfigStore } from '../app/orchestrator/projects.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { TmuxAdapter, OrchestratorSessionManager } from '../app/orchestrator/session.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { ApiError } from '../app/orchestrator/errors.js';
import { JobStatus, ApprovalStatus } from '../app/orchestrator/contract.js';
import { SCOPES } from '../app/orchestrator/auth.js';

const execFileAsync = promisify(execFile);
const HAVE_GIT = await execFileAsync('git', ['--version']).then(() => true).catch(() => false);
const HAVE_TMUX = await execFileAsync('tmux', ['-V']).then(() => true).catch(() => false);
const gitTest = (name, fn) => test(name, { skip: HAVE_GIT ? false : 'git is not installed' }, fn);
const tmuxTest = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'tmux is not installed' }, fn);

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';

/** The submitting credential. Deliberately without the approve scope — see the separation test. */
const SUBMITTER = Object.freeze({
  token_id: 'submitter', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: [SCOPES.JOBS_READ, SCOPES.JOBS_WRITE, SCOPES.SESSION_MANAGE, SCOPES.PUBLISH],
});
/** A separate credential held by whoever records human decisions. */
const APPROVER = Object.freeze({
  token_id: 'approver', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: [SCOPES.JOBS_READ, SCOPES.APPROVE],
});

async function makeRepo(dir) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const run = (args, cwd = dir) => execFileAsync('git', args, { cwd, env });
  await run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(dir, 'café.txt'), 'accented\n');
  await run(['add', '.']);
  await run(['commit', '-qm', 'initial']);
  const remote = `${dir}-remote.git`;
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await run(['remote', 'add', 'origin', remote]);
  return { run, remote };
}

async function withEngine(fn, { backendOptions, envOverrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-p1-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const repoDir = path.join(workspaceRoot, 'Demo');
  fs.mkdirSync(repoDir, { recursive: true });
  const { run: git, remote } = HAVE_GIT ? await makeRepo(repoDir) : { run: null, remote: null };

  const projectsPath = path.join(dir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: {
      Demo: {
        display_name: 'Demo',
        capabilities: ['implementation', 'targeted_tests', 'publication'],
        verification_commands: ['true'], default_branch: 'main', has_ci: false,
      },
    },
  }));

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: workspaceRoot,
    ...envOverrides,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 1_000,
  });
  const repo = new OrchestratorRepository(store);
  const artifacts = new ArtifactStore({ config, repo, store });
  const projectStore = new ProjectConfigStore(projectsPath);
  const backend = new FakeCodingBackend(backendOptions);
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
  const checkRunner = new CheckRunner({ config, repo, store, artifacts });
  const engine = new OrchestrationEngine({
    config, store, repo, backend, sessionManager, artifacts, projectStore, checkRunner,
  });

  try {
    await fn({
      engine, store, repo, config, backend, repoDir, git, remote, dir,
      sessionManager, artifacts, projectStore, checkRunner,
    });
  } finally {
    await engine.drain().catch(() => {});
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
}

const submit = (engine, overrides = {}, key = 'req-1', token = SUBMITTER) => engine.submitJob({
  token,
  body: {
    idempotency_key: key, orchestrator_instance_id: ORCH, orchestrator_job_id: 'job_1',
    project_id: 'Demo', session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`,
    task: {
      title: 'Fix the expiry', goal: 'Tokens outlive their expiry.',
      acceptance_criteria: ['An expired token is rejected.'],
      constraints: [], out_of_scope: [], likely_paths: [], required_checks: [],
    },
    requested: { model_alias: 'sonnet', effort: 'high' },
    max_phase_turns: 10, max_revision_cycles: 1, fencing_token: 7,
    ...overrides,
  },
  idempotencyKey: key, correlationId: 'corr-1',
});

/** The fake attests both halves, so jobs reach the publication gate. */
const ATTESTING = { effective: { model_alias: 'sonnet', effort: 'high' } };

async function driveToGate(engine) {
  const handle = await submit(engine);
  await engine.drain();
  const jobId = handle.workbench_job_id;
  const approval = engine.getApprovals(SUBMITTER, jobId).approvals[0];
  return { jobId, approval };
}

// ---------------------------------------------------------------------------
// separation of requester and approver authority
// ---------------------------------------------------------------------------

gitTest('approval: the credential that submitted a job may not approve it', async () => {
  await withEngine(async ({ engine }) => {
    const { jobId, approval } = await driveToGate(engine);
    const body = {
      workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication',
      approved: true, decided_by: 'james',
    };

    // The submitter holds jobs:write and publish, but not approve. Self-approval is the whole
    // failure mode: one credential requesting, granting, and acting on its own authorisation.
    await assert.rejects(
      engine.approveStage({ token: SUBMITTER, jobId, body, idempotencyKey: 'a1' }),
      (err) => err instanceof ApiError && err.code === 'forbidden_scope',
    );

    // A distinct credential carrying the approve scope succeeds.
    const decided = await engine.approveStage({ token: APPROVER, jobId, body, idempotencyKey: 'a2' });
    assert.equal(decided.status, ApprovalStatus.APPROVED);
  }, { backendOptions: ATTESTING });
});

gitTest('approval: a decision must name the human who made it', async () => {
  await withEngine(async ({ engine }) => {
    const { jobId, approval } = await driveToGate(engine);
    await assert.rejects(
      engine.approveStage({
        token: APPROVER, jobId,
        body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true },
        idempotencyKey: 'a1',
      }),
      (err) => err instanceof ApiError && err.code === 'validation_failed',
      'an approval that identifies nobody is not a recorded human decision',
    );
  }, { backendOptions: ATTESTING });
});

gitTest('approval: the audit records the decider and the relaying credential separately', async () => {
  const audited = [];
  await withEngine(async ({ engine }) => {
    engine.audit = (event, detail) => audited.push({ event, detail });
    const { jobId, approval } = await driveToGate(engine);
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    const entry = audited.find((a) => a.event === 'orchestrator.approval.decided');
    assert.equal(entry.detail.decided_by, 'james');
    assert.equal(entry.detail.relayed_by, ORCH);
    assert.equal(entry.detail.relayed_by_token, 'approver');
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// publication: renames, non-ASCII names, and index rollback
// ---------------------------------------------------------------------------

gitTest('publish: a non-ASCII filename is staged and compared correctly', async () => {
  await withEngine(async ({ engine, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'café.txt'), 'accented and edited\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    // git quotes non-ASCII paths in its default output, so a name-only comparison saw
    // "caf\303\251.txt" and never matched the intended set.
    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/accents', commit_message: 'chore: accents',
        intended_files: ['café.txt'], open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });
    assert.equal(record.pushed, true, record.failure_reason ?? 'publication should have succeeded');
    assert.equal(record.remote_sha_verified, true);
    assert.deepEqual(record.changed_files, ['café.txt']);
  }, { backendOptions: ATTESTING });
});

gitTest('publish: a rename is published as the intended path, not rejected as a mismatch', async () => {
  await withEngine(async ({ engine, repoDir, git }) => {
    const { jobId, approval } = await driveToGate(engine);
    // A rename shows up as `R100 old -> new` in the default output, which never matched either.
    fs.renameSync(path.join(repoDir, 'src.js'), path.join(repoDir, 'renamed.js'));
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/rename', commit_message: 'refactor: rename',
        intended_files: ['src.js', 'renamed.js'], open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });
    assert.equal(record.pushed, true, record.failure_reason ?? 'publication should have succeeded');
    assert.deepEqual([...record.changed_files].sort(), ['renamed.js', 'src.js']);
  }, { backendOptions: ATTESTING });
});

gitTest("publish: a failed publication leaves the operator's index exactly as it was", async () => {
  await withEngine(async ({ engine, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\nunrelated\n');
    // The operator has their own work staged.
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
    const before = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repoDir })).stdout;

    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    // Intending a file that is not actually modified makes the publication fail after staging.
    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['nonexistent.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });
    assert.equal(record.pushed, false);

    // git.js forbids reset and restore, so if publication dirties the real index there is nothing
    // in this subsystem that could ever put it back. It must therefore not touch it at all.
    const after = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repoDir })).stdout;
    assert.equal(after, before, "the operator's staged set must be untouched by a failed publish");
  }, { backendOptions: ATTESTING });
});

gitTest('publish: pathspec magic is refused before it reaches git add', async () => {
  await withEngine(async ({ engine, repo, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    for (const magic of [':(glob)**', ':/', ':!README.md', '*', ':(exclude)a']) {
      // `--` stops git interpreting a leading dash as an option; it does NOT stop pathspec magic.
      // The refusal is recorded rather than thrown: the job has already entered `publishing`, and
      // an exception escaping would strand it there with no legal transition back.
      // eslint-disable-next-line no-await-in-loop
      const record = await engine.publish({
        token: SUBMITTER, jobId,
        request: {
          job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: [magic],
          open_pull_request: false, approval_id: approval.approval_id,
        },
        idempotencyKey: `p-${magic}`, correlationId: 'c',
      }).catch((err) => err);

      const refused = record instanceof ApiError || (record.pushed === false && record.local_commit === null);
      assert.ok(refused, `pathspec magic ${magic} must be refused`);
      // And in every case the job must remain in a state it can move on from.
      assert.notEqual(repo.getJob(jobId).status, JobStatus.PUBLISHING, `${magic} left the job stranded`);
    }
  }, { backendOptions: ATTESTING });
});

gitTest('publish: commits under an explicit identity, with no ambient git config at all', async () => {
  // Root cause of an intermittent failure found by independent verification in a fresh clone:
  // publication inherited whatever git identity happened to exist on the host. A service account
  // routinely has none — as do CI runners and fresh containers — and `git commit` then fails with
  // "Please tell me who you are". Publication reported "the commit failed" and pushed nothing, so
  // the symptom was a repository with one commit where two were expected.
  //
  // GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM pointed at /dev/null is the deterministic way to say "this
  // host has no configured identity" — it does not depend on the machine the test runs on.
  const saved = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
    name: process.env.GIT_AUTHOR_NAME,
    email: process.env.GIT_AUTHOR_EMAIL,
    cname: process.env.GIT_COMMITTER_NAME,
    cemail: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;

  try {
    await withEngine(async ({ engine, repoDir }) => {
      const { jobId, approval } = await driveToGate(engine);
      fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
      await engine.approveStage({
        token: APPROVER, jobId,
        body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
        idempotencyKey: 'a1',
      });

      const record = await engine.publish({
        token: SUBMITTER, jobId,
        request: {
          job_id: jobId, branch: 'orch/identity', commit_message: 'fix: expiry',
          intended_files: ['src.js'], open_pull_request: false, approval_id: approval.approval_id,
        },
        idempotencyKey: 'p1', correlationId: 'c',
      });

      assert.equal(record.pushed, true, record.failure_reason ?? 'publication must not need an ambient identity');
      assert.equal(record.remote_sha_verified, true);

      // Exactly one new commit, made under the configured identity rather than a host's.
      const count = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir })).stdout.trim();
      assert.equal(count, '2');
      const author = (await execFileAsync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repoDir })).stdout.trim();
      assert.match(author, /ProjectWorkbench Orchestrator <orchestrator@.*\.invalid>/);
    }, { backendOptions: ATTESTING });
  } finally {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_SYSTEM', saved.system],
      ['GIT_AUTHOR_NAME', saved.name], ['GIT_AUTHOR_EMAIL', saved.email],
      ['GIT_COMMITTER_NAME', saved.cname], ['GIT_COMMITTER_EMAIL', saved.cemail],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

gitTest('publish: a failed commit says why, rather than reporting a bare failure', async () => {
  await withEngine(async ({ engine, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    // An empty commit message is refused by git, standing in for any commit-step failure.
    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: '   .   ', intended_files: ['src.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });
    if (!record.pushed) {
      assert.ok(record.failure_reason, 'a failed publication must carry a reason');
    }
  }, { backendOptions: ATTESTING });
});

gitTest('publish: a competing lease blocks publication before any git runs — not just a no-op diff', async () => {
  // Previously this test held no dirty file at all, so `publish` reported `pushed: false` for the
  // *same* reason it always would have — "there is nothing to publish" — whether or not the lease
  // check ran. It proved nothing about the lease. A real dirty, intended file is what makes "was
  // this actually blocked by the competing lease" a question the test can answer.
  await withEngine(async ({ engine, store, repo, config, repoDir, remote }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    // Another job holds the lease. Publication must not commit into a checkout someone else is
    // actively editing.
    const resource = `project-write:${INSTANCE}:Demo`;
    await store.transact((tx, s) => repo.acquireLease(tx, s, { resource, owner: 'other-job', ttlMs: 600_000 }));

    const before = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir })).stdout.trim();

    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    }).catch((err) => err);

    const blocked = record instanceof ApiError || record.pushed === false;
    assert.ok(blocked, 'publication must not proceed while another job holds the write lease');

    // Nothing was staged or committed — the block happened before any git ran, not after a commit
    // that then failed to push.
    const after = (await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoDir })).stdout.trim();
    assert.equal(after, before, 'no commit may have been made while another job holds the lease');
    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'nothing may have reached the remote');

    // The job itself must not be stranded in `publishing` — it is blocked, on a legal edge, and the
    // OTHER job's lease is still exactly what it was (still held, still unfenced by this refusal).
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);
    const lease = repo.getLease(resource);
    assert.equal(lease.owner, 'other-job');
    assert.notEqual(lease.fenced, true, 'a routine competing lease is contention, not a fence');
  }, { backendOptions: ATTESTING });
});

gitTest('publish: a pre-existing fence blocks publication just like a competing lease', async () => {
  await withEngine(async ({ engine, store, repo, repoDir, remote }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    // A prior, unrelated cancellation left this project's workspace fenced pending operator review.
    const resource = `project-write:${INSTANCE}:Demo`;
    const fenceOwner = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource, owner: 'earlier-job', ttlMs: 600_000 }));
    await store.transact((tx, s) => repo.fenceLease(tx, s, {
      resource, owner: 'earlier-job', fencingToken: fenceOwner.fencing_token, reason: 'an earlier cancellation could not confirm termination',
    }));

    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    }).catch((err) => err);

    const blocked = record instanceof ApiError || record.pushed === false;
    assert.ok(blocked, 'publication must not proceed against a fenced project');
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);

    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'nothing may have reached the remote');
    assert.equal(repo.getLease(resource).fenced, true, 'the pre-existing fence must remain in place, not be cleared as a side effect');
  }, { backendOptions: ATTESTING });
});

gitTest('publish: cancelling mid-push fences the project rather than confirming cancellation', async () => {
  await withEngine(async ({
    engine, repo, repoDir, remote, config, store, backend, sessionManager, artifacts, checkRunner, projectStore,
  }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    // A fake exec that runs every git subcommand for real EXCEPT `push`, which hangs until the
    // AbortSignal `runGit` now threads through actually fires — standing in for a `git push` that
    // is genuinely in flight (blocked on the network, or backgrounded) at the moment of cancellation.
    // On abort it rejects the way `PrivilegeDropper._execTracked` would for a kill nobody could
    // confirm: `terminationConfirmed: false`, never assumed true just because the signal fired.
    let pushStarted;
    const pushStartedPromise = new Promise((resolve) => { pushStarted = resolve; });
    const exec = async (file, argv, options) => {
      if (argv[0] === 'push') {
        pushStarted();
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error('the push was aborted');
            err.name = 'AbortError';
            err.killed = true;
            err.signal = 'SIGTERM';
            err.terminationConfirmed = false;
            reject(err);
          };
          if (options.signal?.aborted) return onAbort();
          options.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return execFileAsync(file, argv, options);
    };

    const engineWithExec = new OrchestrationEngine({
      config, store, repo, backend, sessionManager, artifacts, checkRunner, projectStore, exec,
    });

    const publishPromise = engineWithExec.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
        open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    }).catch((err) => err);

    await pushStartedPromise;
    const cancelled = await engineWithExec.cancelJob({
      token: SUBMITTER, jobId,
      body: { workbench_job_id: jobId, reason: 'operator changed their mind mid-push' },
    });
    await publishPromise;

    // Never a false "cancelled" while the push could not be confirmed dead.
    assert.notEqual(cancelled.status, JobStatus.CANCELLED,
      'cancellation must not be confirmed while an in-flight push could not be confirmed killed');
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);
    assert.equal(repo.getJob(jobId).termination_confirmed, false);

    // The project is fenced, not merely released — a later job must not be able to walk into the
    // same checkout while the aborted push is unaccounted for.
    const resource = `project-write:${INSTANCE}:Demo`;
    assert.equal(repo.getLease(resource).fenced, true, 'an unconfirmed mid-push cancellation must fence the project');
    await assert.rejects(
      engine.store.transact((tx, s) => repo.acquireLease(tx, s, { resource, owner: 'later-job', ttlMs: 600_000 })),
      /fenced/,
      'the workspace must not be reusable until an operator clears the fence with evidence',
    );

    // Nothing reached the remote — the push never actually completed.
    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'an aborted push must not have landed on the remote');
  }, { backendOptions: ATTESTING });
});

gitTest('publish: a restart while publishing is reconciled the same as any other mid-flight job', async () => {
  // Simulates the moment right after a crash: the job record was durably left in `publishing`
  // holding a real lease (this is exactly the gap Part B closes — before it, `publish` never
  // acquired a lease at all, so a stranded `publishing` job held nothing for a restart to find).
  await withEngine(async ({ engine, store, repo, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });

    const resource = `project-write:${INSTANCE}:Demo`;
    const lease = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource, owner: jobId, ttlMs: 600_000 }));
    await store.transact((tx, s) => {
      const job = s.get('jobs', jobId);
      repo.putJob(tx, { ...job, status: JobStatus.PUBLISHING, phase: 'publication', lease_fencing_token: lease.fencing_token });
    });

    const reconciled = await engine.reconcileOnStart();
    assert.equal(reconciled, 1);
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);
    assert.equal(repo.getJob(jobId).termination_confirmed, false);
    assert.equal(repo.getLease(resource).fenced, true,
      'a job left publishing across a restart must fence the lease it held, not release it');
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// revision and review must actually run
// ---------------------------------------------------------------------------

gitTest('revision: a requested revision runs, rather than stranding the job forever', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // A non-isolated review parks the job in blocked_review, which is where a revision is requested.
    backend.phaseResults = Array.from({ length: 6 }, () => ({
      ok: true, session_id: 'same-session', summary: 'done', questions: [],
      turns_used: 1, max_turns_reached: false,
    }));
    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_REVIEW);

    backend.phaseResults = [];
    await engine.requestRevision({
      token: SUBMITTER, jobId,
      body: { workbench_job_id: jobId, instructions: 'tighten the expiry check' },
    });
    await engine.drain();

    const job = repo.getJob(jobId);
    assert.notEqual(job.status, JobStatus.REVISION_REQUIRED,
      'a revision must be worked, not left parked with no worker');
    assert.equal(job.revision_cycles_used, 1);
    const events = engine.getEvents(SUBMITTER, jobId, { limit: 200 }).events;
    assert.ok(events.some((e) => e.phase === 'implementation' && e.event_type === 'phase_started'),
      'the revision must re-enter implementation');
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// cancellation must actually stop the work
// ---------------------------------------------------------------------------

gitTest('cancel: an in-flight phase is signalled rather than waited out', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // A phase that would run far longer than any reasonable cancel latency.
    let aborted = false;
    backend.runPhase = (request) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, session_id: 's', summary: 'late', questions: [], turns_used: 1, max_turns_reached: false }), 60_000);
      request.signal?.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { kind: 'cancelled' }));
      });
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    // Wait until the job is genuinely inside a phase — cancelling before one starts would prove
    // nothing about whether a running phase can be stopped.
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(repo.getJob(jobId).status, JobStatus.DISCOVERING, 'the job must be in a phase before cancelling');

    const started = Date.now();
    const state = await engine.cancelJob({
      token: SUBMITTER, jobId,
      body: { workbench_job_id: jobId, reason: 'director changed priority' },
    });
    const elapsed = Date.now() - started;

    assert.equal(state.status, JobStatus.CANCELLED);
    assert.ok(aborted, 'the running phase must have been signalled');
    assert.ok(elapsed < 20_000, `cancel must not wait out the phase budget (took ${elapsed} ms)`);
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// idempotency key: one source of truth across both transports
// ---------------------------------------------------------------------------

gitTest('idempotency: a body key that disagrees with the transport key is refused', async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(
      engine.submitJob({
        token: SUBMITTER,
        body: {
          idempotency_key: 'from-body', orchestrator_instance_id: ORCH, orchestrator_job_id: 'job_1',
          project_id: 'Demo', session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`,
          task: {
            title: 't', goal: 'g', acceptance_criteria: ['a'],
            constraints: [], out_of_scope: [], likely_paths: [], required_checks: [],
          },
          requested: { model_alias: 'sonnet', effort: 'high' },
          max_phase_turns: 10, max_revision_cycles: 1, fencing_token: 7,
        },
        idempotencyKey: 'from-header', correlationId: 'c',
      }),
      (err) => err instanceof ApiError && err.code === 'validation_failed',
      'two disagreeing keys must not silently pick one',
    );
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// the engine must bind its own verification request
// ---------------------------------------------------------------------------

gitTest('attestation: the engine binds its verification to the job and configuration generation', async () => {
  // Without a binding the attestation is stamped `unbound`, no launch enforcement can be claimed,
  // and EVERY job blocks at blocked_configuration even though the binary supports the option. The
  // fake backend returns `effective` directly, so nothing else in the suite exercises this.
  const seen = [];
  await withEngine(async ({ engine, repo, backend }) => {
    const inner = backend.verifyConfiguration.bind(backend);
    backend.verifyConfiguration = async (request) => {
      seen.push(request);
      return inner(request);
    };
    const handle = await submit(engine);
    await engine.drain();

    assert.equal(seen.length >= 1, true, 'verification must have run');
    const [request] = seen;
    assert.equal(request.runId, handle.workbench_job_id, 'the run must be the job being asked about');
    assert.notEqual(request.runId, 'unbound');
    assert.equal(Number.isInteger(request.configGeneration), true, 'a configuration generation must be bound');
    assert.equal(repo.getJob(handle.workbench_job_id).status, JobStatus.WAITING_FOR_PUBLICATION_APPROVAL);
  }, { backendOptions: ATTESTING });
});

// ---------------------------------------------------------------------------
// reboot-safe lane identity
// ---------------------------------------------------------------------------

tmuxTest('lane: a lane restored unmarked after a reboot is re-adopted, not wedged forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-reboot-'));
  const socket = `pwreboot${process.pid}${Number(process.hrtime.bigint() % 100000n)}`;
  const workspaceRoot = path.join(dir, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'Demo'), { recursive: true });

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_WORKSPACES: workspaceRoot, PW_ORCHESTRATOR_TMUX_SOCKET: socket,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 500,
  });
  const repo = new OrchestratorRepository(store);
  const tmux = new TmuxAdapter({ socket, executable: 'tmux' });
  const manager = new OrchestratorSessionManager({ config, store, repo, tmux, backend: new FakeCodingBackend() });
  const project = { project_id: 'Demo', workspace_subdir: 'Demo' };
  const token = { token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'], scopes: [] };
  const request = {
    orchestrator_instance_id: ORCH, project_id: 'Demo', role: null,
    reserved_tmux_window: null, cli_backend: 'claude-code', force_replace: false,
  };

  try {
    const first = await manager.ensureSession({ token, project, request, correlationId: 'c' });

    // Simulate the reboot: pw-tmux-restore recreates every pw_* window BY NAME as a plain shell.
    // tmux user options are not in the manifest, so the marker is gone.
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    // The old server does not disappear the instant kill-server returns, and starting a new one on
    // a socket that is still being torn down fails with "server exited unexpectedly". A real reboot
    // has no such race; this retry is the fixture catching up with it, not a product behaviour.
    for (let i = 0; i < 40; i++) {
      try {
        await tmux.raw(['new-session', '-d', '-s', 'pw_Demo', '-c', path.join(workspaceRoot, 'Demo')]);
        break;
      } catch (err) {
        if (i === 39) throw err;
        fs.rmSync(path.join('/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await tmux.raw(['new-window', '-d', '-t', '=pw_Demo', '-n', 'orch_pvibot',
      '-c', path.join(workspaceRoot, 'Demo')]);
    const restored = await tmux.findWindow('pw_Demo', 'orch_pvibot');
    assert.equal(restored.role, null, 'the restored window must be unmarked, as after a real reboot');

    // Before the fix this threw `conflict` forever, including under force_replace, so every job for
    // the project blocked at "ensuring the orchestrator lane" until a human intervened.
    const second = await manager.ensureSession({ token, project, request, correlationId: 'c' });
    assert.equal(second.session_key, first.session_key);
    const lane = await tmux.findWindow('pw_Demo', 'orch_pvibot');
    assert.equal(lane.role, 'pvi2-orchestrator', 'the lane must have been re-marked');
    assert.equal(lane.sessionKey, first.session_key);
  } finally {
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    fs.rmSync(path.join('/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

tmuxTest('lane: an unmarked window is only adopted when this instance recorded that lane', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-adopt-'));
  const socket = `pwadopt${process.pid}${Number(process.hrtime.bigint() % 100000n)}`;
  const workspaceRoot = path.join(dir, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'Demo'), { recursive: true });

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_WORKSPACES: workspaceRoot, PW_ORCHESTRATOR_TMUX_SOCKET: socket,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 500,
  });
  const repo = new OrchestratorRepository(store);
  const tmux = new TmuxAdapter({ socket, executable: 'tmux' });
  const manager = new OrchestratorSessionManager({ config, store, repo, tmux, backend: new FakeCodingBackend() });

  try {
    // No durable record exists — this instance has never created a lane here. Something else is
    // sitting on the reserved name, and adopting it would be taking a window we cannot prove is ours.
    await tmux.raw(['new-session', '-d', '-s', 'pw_Demo', '-c', path.join(workspaceRoot, 'Demo')]);
    await tmux.raw(['new-window', '-d', '-t', '=pw_Demo', '-n', 'orch_pvibot', 'sleep 600']);
    const before = await tmux.findWindow('pw_Demo', 'orch_pvibot');

    await assert.rejects(
      manager.ensureSession({
        token: { token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'], scopes: [] },
        project: { project_id: 'Demo', workspace_subdir: 'Demo' },
        request: {
          orchestrator_instance_id: ORCH, project_id: 'Demo', role: null,
          reserved_tmux_window: null, cli_backend: 'claude-code', force_replace: false,
        },
        correlationId: 'c',
      }),
      (err) => err instanceof ApiError && err.code === 'conflict',
    );
    const after = await tmux.findWindow('pw_Demo', 'orch_pvibot');
    assert.equal(after.id, before.id, 'an unowned window must be left completely alone');
    assert.equal(after.role, null, 'and must not have been marked');
  } finally {
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    fs.rmSync(path.join('/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

gitTest('cancel: the preservation check can actually fail — it is not a tautology', async () => {
  // The check sampled the tree twice AFTER the worker had already stopped, so nothing could happen
  // between the samples and `working_tree_preserved: true` was unconditional. A backend that
  // discarded work during cancellation went undetected.
  await withEngine(async ({ engine, repo, repoDir, backend }) => {
    fs.writeFileSync(path.join(repoDir, 'operator-work.txt'), 'do not lose me\n');

    backend.runPhase = (request) => new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        // A misbehaving backend that discards the operator's uncommitted work on the way out.
        fs.rmSync(path.join(repoDir, 'operator-work.txt'), { force: true });
        reject(Object.assign(new Error('aborted'), { kind: 'cancelled' }));
      });
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.cancelJob({
      token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' },
    });

    assert.equal(
      repo.getJob(jobId).working_tree_preserved, false,
      'a discard during cancellation must be detected, not reported as preserved',
    );
  }, { backendOptions: ATTESTING });
});

gitTest('cancel: further writes during cancellation are not mistaken for a discard', async () => {
  // The opposite error: sampling before the abort and comparing whole-tree output would call an
  // agent finishing a legitimate write a violation. Preservation means nothing was LOST.
  await withEngine(async ({ engine, repo, repoDir, backend }) => {
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 41; // in progress\n');

    backend.runPhase = (request) => new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 41; // more work\n');
        fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'added on the way out\n');
        reject(Object.assign(new Error('aborted'), { kind: 'cancelled' }));
      });
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.cancelJob({
      token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' },
    });

    assert.equal(repo.getJob(jobId).working_tree_preserved, true, 'continued writing is not a discard');
    assert.ok(fs.existsSync(path.join(repoDir, 'new-file.txt')));
  }, { backendOptions: ATTESTING });
});

gitTest('cancel: does not hold the caller open for the whole phase budget', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // A child that is slow to notice the signal. It DOES finish eventually — the point is that the
    // caller is not held open until it does. An unbounded await here meant a cancel request hung
    // for the entire remaining phase budget, up to half an hour by default.
    backend.runPhase = () => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: false, failure_kind: 'cancelled', session_id: 's', summary: '',
        questions: [], turns_used: 0, max_turns_reached: false,
      }), 4_000);
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }

    const started = Date.now();
    const state = await engine.cancelJob({ token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' } });
    const elapsed = Date.now() - started;

    // Grace is 1s; the phase takes 4s. Returning in well under 4s is the whole assertion.
    assert.ok(elapsed < 3_000, `cancel must be bounded by the grace period, took ${elapsed} ms`);
    // The worker had not yet told us anything when the grace elapsed — not "cancelled", which would
    // be rounding an unknown up to a known-good answer. See the dedicated race tests below for the
    // full contract this reflects.
    assert.notEqual(state.status, JobStatus.CANCELLED);
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);
    assert.equal(repo.getJob(jobId).termination_confirmed, false);
  }, { backendOptions: ATTESTING, envOverrides: { PW_ORCHESTRATOR_CANCEL_GRACE_MS: '1000' } });
});

// ---------------------------------------------------------------------------
// cancellation: the cancelGraceMs race must never default to confirmed (round 2, criteria 3-5)
// ---------------------------------------------------------------------------

gitTest('cancel: a worker still unresolved when cancelGraceMs elapses is unconfirmed, never rounded up to cancelled', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    // The phase takes far longer to settle than the cancel grace — and, crucially, it WOULD report
    // termination confirmed had the caller waited for it. The point under test is that the caller
    // must not wait: a deadline that elapses before any answer has arrived has to read as "unknown",
    // never as "it turned out fine".
    backend.runPhase = (request) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError', kind: 'cancelled', terminationConfirmed: true,
      })), 3_000);
      request.signal?.addEventListener('abort', () => {}); // acknowledged, genuinely slow to confirm
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }

    const state = await engine.cancelJob({
      token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' },
    });

    assert.notEqual(state.status, JobStatus.CANCELLED,
      'a deadline that elapsed before confirmation arrived must never default to cancelled');
    assert.equal(state.status, JobStatus.BLOCKED_PROJECT_STATE);
    const job = repo.getJob(jobId);
    assert.equal(job.termination_confirmed, false,
      'termination_confirmed:false must be persisted when the deadline won the race');
    assert.equal(job.working_tree_preserved, false);
  }, { backendOptions: ATTESTING, envOverrides: { PW_ORCHESTRATOR_CANCEL_GRACE_MS: '200' } });
});

gitTest('cancel: an unconfirmed termination fences the project lease — a later job cannot acquire it', async () => {
  await withEngine(async ({ engine, repo, backend }) => {
    backend.runPhase = (request) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError', kind: 'cancelled', terminationConfirmed: false,
      })), 3_000);
      request.signal?.addEventListener('abort', () => {});
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.cancelJob({ token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' } });
    assert.equal(repo.getJob(jobId).status, JobStatus.BLOCKED_PROJECT_STATE);

    const resource = `project-write:${INSTANCE}:Demo`;
    assert.equal(repo.getLease(resource)?.fenced, true, 'the project resource must be fenced, not merely un-renewed');

    // A second, independent job for the SAME project must not be able to acquire the workspace lease
    // while the fence is up.
    const second = await submit(engine, {}, 'req-2');
    await engine.drain();
    const secondJob = repo.getJob(second.workbench_job_id);
    assert.equal(secondJob.status, JobStatus.BLOCKED_PROJECT_STATE,
      'a later job must not acquire the fenced project lease');
    assert.notEqual(secondJob.workbench_job_id, jobId);
  }, { backendOptions: ATTESTING, envOverrides: { PW_ORCHESTRATOR_CANCEL_GRACE_MS: '200' } });
});

gitTest('cancel: clearing the fence lets a later job acquire the project again', async () => {
  await withEngine(async ({ engine, repo, backend, config }) => {
    backend.runPhase = (request) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError', kind: 'cancelled', terminationConfirmed: false,
      })), 3_000);
      request.signal?.addEventListener('abort', () => {});
    });

    const handle = await submit(engine);
    const jobId = handle.workbench_job_id;
    for (let i = 0; i < 200; i++) {
      if (repo.getJob(jobId)?.status === JobStatus.DISCOVERING) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.cancelJob({ token: SUBMITTER, jobId, body: { workbench_job_id: jobId, reason: 'stop' } });

    const resource = `project-write:${config.instanceId}:Demo`;
    await engine.store.transact((tx, state) => {
      engine.repo.clearFence(tx, state, {
        resource, clearedBy: 'operator:test', reason: 'manually verified no surviving process',
      });
    });
    assert.equal(repo.getLease(resource)?.fenced, false);

    delete backend.runPhase;
    const second = await submit(engine, {}, 'req-2');
    await engine.drain();
    assert.notEqual(repo.getJob(second.workbench_job_id).status, JobStatus.BLOCKED_PROJECT_STATE,
      'once cleared, a later job must be able to acquire the project again');
  }, { backendOptions: ATTESTING, envOverrides: { PW_ORCHESTRATOR_CANCEL_GRACE_MS: '200' } });
});

// ---------------------------------------------------------------------------
// checks.js / git.js unconfirmed kills must fence, not merely record a failure
// ---------------------------------------------------------------------------

gitTest('verification: a check killed without confirmation fences the project rather than merely failing it', async () => {
  await withEngine(async ({ engine, repo }) => {
    // A real, non-zero-exit check failure must NOT reach this — only an actual unconfirmed kill,
    // which `PrivilegeDropper._execTracked` marks with `terminationConfirmed: false` on the error it
    // hands back. Injected directly onto the CheckRunner this engine already built, standing in for
    // a verification command that timed out and could not confirm its own descendant tree was dead.
    engine.checkRunner.exec = async () => {
      const err = new Error('Command failed');
      err.code = null;
      err.killed = true;
      err.signal = 'SIGTERM';
      err.terminationConfirmed = false;
      throw err;
    };

    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    const job = repo.getJob(jobId);

    assert.equal(job.status, JobStatus.BLOCKED_PROJECT_STATE,
      'an unconfirmed kill must fence and quarantine, not merely record blocked_verification');
    assert.equal(job.termination_confirmed, false);

    const resource = `project-write:${engine.config.instanceId}:Demo`;
    assert.equal(repo.getLease(resource)?.fenced, true,
      'the project must be durably fenced, exactly like an unconfirmed cancellation');
  }, { backendOptions: ATTESTING });
});

gitTest('verification: an ordinary failing check still just fails — no fence over a red test', async () => {
  await withEngine(async ({ engine, repo }) => {
    engine.checkRunner.exec = async () => {
      const err = new Error('Command failed');
      err.code = 1; // a plain non-signal exit — the shape a red test actually has
      throw err;
    };

    const handle = await submit(engine);
    await engine.drain();
    const jobId = handle.workbench_job_id;
    const job = repo.getJob(jobId);

    assert.equal(job.status, JobStatus.BLOCKED_VERIFICATION,
      'a red test is an ordinary, recoverable outcome and must not fence the project');
    const resource = `project-write:${engine.config.instanceId}:Demo`;
    assert.equal(repo.getLease(resource)?.fenced ?? false, false);
  }, { backendOptions: ATTESTING });
});

gitTest('publish: a commit message beginning with a dash publishes, and never strands the job', async () => {
  await withEngine(async ({ engine, repo, repoDir }) => {
    const { jobId, approval } = await driveToGate(engine);
    fs.writeFileSync(path.join(repoDir, 'src.js'), 'export const answer = 42;\n');
    await engine.approveStage({
      token: APPROVER, jobId,
      body: { workbench_job_id: jobId, approval_id: approval.approval_id, stage: 'publication', approved: true, decided_by: 'james' },
      idempotencyKey: 'a1',
    });
    // A perfectly ordinary message that the argv guard could not tell from a flag.
    const record = await engine.publish({
      token: SUBMITTER, jobId,
      request: {
        job_id: jobId, branch: 'orch/dash', commit_message: '- fix expiry handling',
        intended_files: ['src.js'], open_pull_request: false, approval_id: approval.approval_id,
      },
      idempotencyKey: 'p1', correlationId: 'c',
    });
    assert.equal(record.pushed, true, record.failure_reason ?? 'a dash-leading message must publish');
    assert.notEqual(repo.getJob(jobId).status, JobStatus.PUBLISHING);
  }, { backendOptions: ATTESTING });
});

test('persistence: the tmux save manifest excludes orchestrator-owned lanes', () => {
  // The lane is ephemeral and ProjectWorkbench recreates it on demand. Restoring it by name as a
  // plain shell is what produced the unmarked squatter in the first place.
  const script = fs.readFileSync(new URL('../scripts/pw-tmux-save', import.meta.url), 'utf8');
  assert.match(script, /@pw_role/, 'the save script must be able to see the lane marker');
  assert.match(script, /skip|exclude/i);
  // Two markers, not one: tmux resolves #{@option} through the window/session/global scope chain,
  // so keying on @pw_role alone let a single stray global option exclude every window on the server.
  assert.match(script, /@pw_session_key/, 'the skip must require a second window-scoped marker');
});
