// Threading `terminationConfirmed` through git.js and checks.js.
//
// `PrivilegeDropper._execTracked` attaches `terminationConfirmed` to an error only when the launch
// was actually killed by a signal — never for an ordinary non-zero exit, which every check and most
// git invocations are perfectly capable of on a red test or a missing ref. Both modules used to
// discard whatever the exec layer attached, rebuilding a plain `{exitCode, stdout, stderr}` (or
// `{ok, exitCode, ...}`) object from the caught error and dropping every other property. These tests
// assert the field survives that rebuild — `false` only when a real kill could not be confirmed,
// `null` for a check or a git command that simply failed on its own account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runGit, repositoryBaseline, workingTreeFingerprint } from '../app/orchestrator/git.js';
import { CheckRunner, diffStat } from '../app/orchestrator/checks.js';
import { TmuxAdapter } from '../app/orchestrator/session.js';
import { Publisher } from '../app/orchestrator/publish.js';

const execFileAsync = promisify(execFile);
const HAVE_GIT = await execFileAsync('git', ['--version']).then(() => true).catch(() => false);
const gitTest = (name, fn) => test(name, { skip: HAVE_GIT ? false : 'git is not installed' }, fn);

/** A fake exec that always rejects, carrying whichever termination shape the test asks for. */
function killedExec({ terminationConfirmed }) {
  return async () => {
    const err = new Error('Command failed');
    err.code = null;
    err.killed = true;
    err.signal = 'SIGTERM';
    err.terminationConfirmed = terminationConfirmed;
    throw err;
  };
}

/** A fake exec simulating an ORDINARY non-zero exit — no signal, no kill, nothing to confirm. */
function ordinaryFailureExec(exitCode = 1) {
  return async () => {
    const err = new Error('Command failed');
    err.code = exitCode;
    throw err;
  };
}

function okExec(stdout = '') {
  return async () => ({ stdout, stderr: '' });
}

// ---------------------------------------------------------------------------
// git.js
// ---------------------------------------------------------------------------

test('runGit: a killed launch propagates terminationConfirmed:false, never discarded', async () => {
  const result = await runGit(['status', '--porcelain'], { cwd: '/tmp', exec: killedExec({ terminationConfirmed: false }) });
  assert.equal(result.ok, false);
  assert.equal(result.terminationConfirmed, false);
});

test('runGit: a killed launch that WAS confirmed dead propagates true, not silently dropped either', async () => {
  const result = await runGit(['status', '--porcelain'], { cwd: '/tmp', exec: killedExec({ terminationConfirmed: true }) });
  assert.equal(result.terminationConfirmed, true);
});

test('runGit: an ordinary non-zero exit carries no termination verdict at all', async () => {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: '/tmp', exec: ordinaryFailureExec(128) });
  assert.equal(result.ok, false);
  assert.equal(result.terminationConfirmed, null, 'a plain failed exit is not a kill and has no verdict to report');
});

test('runGit: success carries no verdict either', async () => {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: '/tmp', exec: okExec('deadbeef\n') });
  assert.equal(result.ok, true);
  assert.equal(result.terminationConfirmed, null);
});

test('repositoryBaseline: one killed call among four is enough to flag the whole baseline unconfirmed', async () => {
  let call = 0;
  const exec = async (...args) => {
    call += 1;
    // The third call (git status) is the one that gets killed; the other three succeed.
    if (call === 3) return killedExec({ terminationConfirmed: false })(...args);
    return okExec('')(...args);
  };
  const baseline = await repositoryBaseline({ cwd: '/tmp', exec });
  assert.equal(baseline.terminationConfirmed, false,
    'a single unconfirmed kill among the parallel calls must not be averaged away');
});

test('repositoryBaseline: all-ordinary-failures (a directory that is not a repository) carries no verdict', async () => {
  const baseline = await repositoryBaseline({ cwd: '/tmp', exec: ordinaryFailureExec(128) });
  assert.equal(baseline.is_repository, false);
  assert.equal(baseline.terminationConfirmed, null);
});

test('workingTreeFingerprint: propagates an unconfirmed kill from either of its two calls', async () => {
  let call = 0;
  const exec = async (...args) => {
    call += 1;
    if (call === 1) return killedExec({ terminationConfirmed: false })(...args); // the status call
    return okExec('deadbeef\n')(...args); // the rev-parse HEAD call
  };
  const fp = await workingTreeFingerprint({ cwd: '/tmp', exec });
  assert.equal(fp.terminationConfirmed, false);
});

test('diffStat: propagates the verdict from its single git diff call', async () => {
  const stat = await diffStat({ cwd: '/tmp', exec: killedExec({ terminationConfirmed: false }) });
  assert.equal(stat.terminationConfirmed, false);
});

// ---------------------------------------------------------------------------
// checks.js
// ---------------------------------------------------------------------------

const PROJECT = { verification_commands: ['true'] };

function checkRunner(exec) {
  return new CheckRunner({
    config: { gitExecutable: 'git' },
    repo: null,
    store: null,
    artifacts: { write: async () => ({ artifact_id: 'pwart_test' }) },
    exec,
  });
}

test('CheckRunner.run: a killed configured command propagates terminationConfirmed:false on the outcome', async () => {
  const runner = checkRunner(killedExec({ terminationConfirmed: false }));
  const { terminationConfirmed, check } = await runner.run({ jobId: 'j1', checkName: 'targeted_test', project: PROJECT, cwd: '/tmp' });
  assert.equal(terminationConfirmed, false);
  assert.equal(check.outcome, 'failed');
});

test('CheckRunner.run: an ordinary failing test (red, not killed) carries no termination verdict', async () => {
  const runner = checkRunner(ordinaryFailureExec(1));
  const { terminationConfirmed, check } = await runner.run({ jobId: 'j1', checkName: 'targeted_test', project: PROJECT, cwd: '/tmp' });
  assert.equal(terminationConfirmed, null, 'a red test is not a kill and must not carry a termination verdict');
  assert.equal(check.outcome, 'failed');
});

test('CheckRunner.run: a passing check carries no verdict', async () => {
  const runner = checkRunner(okExec(''));
  const { terminationConfirmed, check } = await runner.run({ jobId: 'j1', checkName: 'targeted_test', project: PROJECT, cwd: '/tmp' });
  assert.equal(terminationConfirmed, null);
  assert.equal(check.outcome, 'passed');
});

test('CheckRunner.run: a not_run check (nothing configured) carries no verdict', async () => {
  const runner = checkRunner(okExec(''));
  const { terminationConfirmed, check } = await runner.run({ jobId: 'j1', checkName: 'targeted_test', project: { verification_commands: [] }, cwd: '/tmp' });
  assert.equal(terminationConfirmed, null);
  assert.equal(check.outcome, 'not_run');
});

test('CheckRunner.run: the git-shaped check (diff_check) propagates a kill', async () => {
  const runner = checkRunner(killedExec({ terminationConfirmed: false }));
  const { terminationConfirmed } = await runner.run({ jobId: 'j1', checkName: 'diff_check', project: PROJECT, cwd: '/tmp' });
  assert.equal(terminationConfirmed, false);
});

test('CheckRunner.run: the secret-scan check propagates a kill from its underlying git diff', async () => {
  const runner = checkRunner(killedExec({ terminationConfirmed: false }));
  const { terminationConfirmed } = await runner.run({ jobId: 'j1', checkName: 'secret_scan', project: PROJECT, cwd: '/tmp' });
  assert.equal(terminationConfirmed, false);
});

// ---------------------------------------------------------------------------
// TmuxAdapter.hasSession / listWindows
// ---------------------------------------------------------------------------

test('TmuxAdapter.hasSession: an ordinary "no such session" failure is swallowed to false, as always', async () => {
  const tmux = new TmuxAdapter({ exec: ordinaryFailureExec(1) });
  assert.equal(await tmux.hasSession('pw_Demo'), false);
});

test('TmuxAdapter.hasSession: a kill this module cannot confirm is re-thrown, never rounded down to false', async () => {
  const tmux = new TmuxAdapter({ exec: killedExec({ terminationConfirmed: false }) });
  await assert.rejects(
    tmux.hasSession('pw_Demo'),
    (err) => err.terminationConfirmed === false,
    'an unconfirmed kill must reach the caller, not be indistinguishable from "no such session"',
  );
});

test('TmuxAdapter.listWindows: an ordinary tmux failure is swallowed to an empty list, as always', async () => {
  const tmux = new TmuxAdapter({ exec: ordinaryFailureExec(1) });
  assert.deepEqual(await tmux.listWindows('pw_Demo'), []);
});

test('TmuxAdapter.listWindows: a kill this module cannot confirm is re-thrown, never rounded down to an empty list', async () => {
  const tmux = new TmuxAdapter({ exec: killedExec({ terminationConfirmed: false }) });
  await assert.rejects(
    tmux.listWindows('pw_Demo'),
    (err) => err.terminationConfirmed === false,
  );
});

// ---------------------------------------------------------------------------
// publish.js — every subprocess Publisher runs, not only the tracked ones
//
// `_publishWithIndex` folds most git calls through a `note()` accumulator, but three were missed
// entirely: `_privateIndex`'s `read-tree` (runs before `_publishWithIndex` is even entered), the
// post-commit real-index re-stage `add` (a "best effort" call whose result was discarded outright),
// and `_pullRequest`'s `gh pr create`/`gh pr view` (a separate exec path that never attached a
// termination verdict to its own catch at all). Each is capable of leaving a live, unaccounted-for
// descendant in the SAME workspace the project's write lease protects, exactly like commit or push
// already are. These prove all three now propagate `terminationConfirmed:false` and stop the whole
// publish attempt immediately — never completing push/gh and never reporting
// `remote_sha_verified:true` alongside an unconfirmed kill.
// ---------------------------------------------------------------------------

async function makeRepo(dir) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const run = (args, cwd = dir) => execFileAsync('git', args, { cwd, env });
  await run(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const answer = 41;\n');
  await run(['add', '.']);
  await run(['commit', '-qm', 'initial']);
  const remote = `${dir}-remote.git`;
  await execFileAsync('git', ['init', '-q', '--bare', remote]);
  await run(['remote', 'add', 'origin', remote]);
  return { run, remote };
}

/** Kills exactly the first call matching `match`; everything else runs for real. */
function killOnceMatching(match) {
  let used = false;
  return async (file, argv, options) => {
    if (!used && match(file, argv)) {
      used = true;
      const err = new Error('killed, unconfirmed');
      err.killed = true;
      err.signal = 'SIGTERM';
      err.terminationConfirmed = false;
      throw err;
    }
    return execFileAsync(file, argv, options);
  };
}

function publisherConfig() {
  return {
    gitExecutable: 'git', ghExecutable: 'gh',
    gitAuthorName: 'ProjectWorkbench Orchestrator', gitAuthorEmail: 'orchestrator@example.invalid',
  };
}

async function withPublishRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-publish-tv-'));
  try {
    const { remote } = await makeRepo(dir);
    await fn({ workspacePath: dir, remote });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}-remote.git`, { recursive: true, force: true });
  }
}

const PUB_JOB = { workbench_job_id: 'pwjob_test' };
const PUB_PROJECT = { default_branch: 'main', has_ci: false };
function pubRequest(overrides = {}) {
  return {
    branch: 'orch/x', commit_message: 'fix', intended_files: ['src.js'],
    open_pull_request: false, approval_id: 'approval-1', ...overrides,
  };
}

gitTest('Publisher.publish: an unconfirmed kill seeding the private index stops immediately, before any git ran on the real tree', async () => {
  await withPublishRepo(async ({ workspacePath, remote }) => {
    fs.writeFileSync(path.join(workspacePath, 'src.js'), 'export const answer = 42;\n');
    const exec = killOnceMatching((file, argv) => argv[0] === 'read-tree');
    const publisher = new Publisher({ config: publisherConfig(), exec });

    const record = await publisher.publish({ job: PUB_JOB, project: PUB_PROJECT, workspacePath, request: pubRequest() });

    assert.equal(record.terminationConfirmed, false);
    assert.equal(record.remote_sha_verified, false);
    assert.equal(record.pushed, false);
    assert.equal(record.local_commit, null, 'nothing may have been committed');

    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'nothing may have reached the remote');
  });
});

gitTest('Publisher.publish: an unconfirmed kill during the post-commit real-index re-stage stops immediately, never pushes', async () => {
  await withPublishRepo(async ({ workspacePath, remote }) => {
    fs.writeFileSync(path.join(workspacePath, 'src.js'), 'export const answer = 42;\n');
    // The re-stage `add` is the SECOND `add` invocation Publisher makes (the first stages into the
    // private index before the commit); killing only the second one proves the commit that already
    // landed locally is not enough to call this a success.
    let addCalls = 0;
    const exec = async (file, argv, options) => {
      if (argv[0] === 'add') {
        addCalls += 1;
        if (addCalls === 2) {
          const err = new Error('killed, unconfirmed');
          err.killed = true; err.signal = 'SIGTERM'; err.terminationConfirmed = false;
          throw err;
        }
      }
      return execFileAsync(file, argv, options);
    };
    const publisher = new Publisher({ config: publisherConfig(), exec });

    const record = await publisher.publish({ job: PUB_JOB, project: PUB_PROJECT, workspacePath, request: pubRequest() });

    assert.equal(record.terminationConfirmed, false);
    assert.equal(record.remote_sha_verified, false,
      'a local commit that already landed must never be reported as a verified remote publication');
    assert.equal(record.pushed, false, 'push must never run after an unconfirmed kill upstream of it');

    const branches = await execFileAsync('git', ['ls-remote', '--heads', remote]);
    assert.equal(branches.stdout.trim(), '', 'nothing may have reached the remote');
  });
});

gitTest('Publisher.publish: an unconfirmed kill in gh pr create/view stops the record from claiming remote verification', async () => {
  await withPublishRepo(async ({ workspacePath }) => {
    fs.writeFileSync(path.join(workspacePath, 'src.js'), 'export const answer = 42;\n');
    const exec = async (file, argv, options) => {
      if (file === 'gh') {
        const err = new Error('killed, unconfirmed');
        err.killed = true; err.signal = 'SIGTERM'; err.terminationConfirmed = false;
        throw err;
      }
      return execFileAsync(file, argv, options);
    };
    const publisher = new Publisher({ config: publisherConfig(), exec });

    const record = await publisher.publish({
      job: PUB_JOB, project: PUB_PROJECT, workspacePath, request: pubRequest({ open_pull_request: true }),
    });

    // The push and its remote-SHA verification genuinely succeeded before gh ever ran — proving the
    // record still refuses to claim it once gh's own kill could not be confirmed.
    assert.equal(record.terminationConfirmed, false);
    assert.equal(record.remote_sha_verified, false,
      'a kill in the informational gh step must still block the record from claiming remote verification');
  });
});

gitTest('Publisher.publish: an ordinary (non-kill) read-tree failure — an unborn HEAD — is still tolerated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-publish-tv-'));
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'src.js'), 'export const answer = 1;\n');
    const publisher = new Publisher({ config: publisherConfig(), exec: execFileAsync });

    const record = await publisher.publish({
      job: PUB_JOB, project: PUB_PROJECT, workspacePath: dir, request: pubRequest({ commit_message: 'first commit' }),
    });

    assert.notEqual(record.terminationConfirmed, false, 'an unborn HEAD is an ordinary case, not a kill');
    assert.match(record.local_commit ?? '', /^[a-f0-9]{40}$/, 'staging and commit must still have proceeded normally');
    assert.equal(record.pushed, false, 'there is nowhere to push in this harness, but that is a plain push failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

gitTest('Publisher.publish: an ordinary gh failure (no remote PR host) is still tolerated, not a kill', async () => {
  await withPublishRepo(async ({ workspacePath }) => {
    fs.writeFileSync(path.join(workspacePath, 'src.js'), 'export const answer = 42;\n');
    const exec = async (file, argv, options) => {
      if (file === 'gh') {
        const err = new Error('gh: command not found');
        err.code = 127;
        throw err;
      }
      return execFileAsync(file, argv, options);
    };
    const publisher = new Publisher({ config: publisherConfig(), exec });

    const record = await publisher.publish({
      job: PUB_JOB, project: PUB_PROJECT, workspacePath, request: pubRequest({ open_pull_request: true }),
    });

    assert.notEqual(record.terminationConfirmed, false, 'gh being unavailable is an ordinary case, not a kill');
    assert.equal(record.remote_sha_verified, true, 'the push itself was real and must still be reported');
    assert.equal(record.pull_request_url, null);
  });
});
