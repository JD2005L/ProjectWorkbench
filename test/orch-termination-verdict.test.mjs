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

import { runGit, repositoryBaseline, workingTreeFingerprint } from '../app/orchestrator/git.js';
import { CheckRunner, diffStat } from '../app/orchestrator/checks.js';
import { TmuxAdapter } from '../app/orchestrator/session.js';

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
