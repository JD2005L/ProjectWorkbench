// Regression tests for the four security-review blockers on PR #19.
//
// Each test reproduces the specific issue the reviewer identified and verifies the fix:
//   1. Privilege boundary incomplete — git/checks/publish/gh run as root
//   2. Cancellation evidence lost — terminationConfirmed not propagated
//   3. Boot gate wording overstates enforcement — lazy validation
//   4. Claude path default is a bare name (now absolute)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PrivilegeDropper, PrivilegeDropError, PrivilegeFailure,
  privilegeDropperFor,
} from '../app/orchestrator/runner/privilege.js';
import { ClaudeCodeBackend, classifyBackendFailure } from '../app/orchestrator/runner/claude.js';
import { TmuxAdapter } from '../app/orchestrator/session.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { PhaseClass, Effort } from '../app/orchestrator/contract.js';

const CLI = '/usr/local/bin/claude';

const GOOD_SUDO = { isFile: () => true, uid: 0, mode: 0o104755 };
const REAL_HELPERS = Object.freeze({ '/usr/bin/sudo': GOOD_SUDO });
const PASSWD = 'admin:x:1001:1001:admin:/home/admin:/bin/bash\n';

function fakeStat(byPath) {
  return async (candidate) => {
    const info = byPath[candidate];
    if (!info) {
      const err = new Error(`ENOENT: ${candidate}`);
      err.code = 'ENOENT';
      throw err;
    }
    return info;
  };
}

function makeDropper({ deployMode = 'host', currentUid = 0, currentGid = 0 } = {}) {
  return new PrivilegeDropper({
    deployMode,
    user: 'admin',
    sudoExecutable: '',
    forbiddenEnv: [],
    forbiddenEnvPrefixes: [],
    exec: async () => ({ stdout: PASSWD, stderr: '' }),
    stat: fakeStat(REAL_HELPERS),
    currentUid: () => currentUid,
    currentGid: () => currentGid,
  });
}

// ---------------------------------------------------------------------------
// Blocker 1: Privilege boundary for system commands (git, checks, gh)
// ---------------------------------------------------------------------------

test('wrapCommand routes git through sudo in host mode when running as root', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const wrapped = dp.wrapCommand(fakeExec);

  await wrapped('git', ['status', '--porcelain'], { cwd: '/workspace' });

  assert.equal(calls.length, 1);
  const call = calls[0];
  // Must go through sudo, not directly as git
  assert.equal(call.file, '/usr/bin/sudo');
  assert.ok(call.argv.includes('git'), 'argv includes git');
  assert.ok(call.argv.includes('status'), 'argv includes status');
  assert.ok(call.argv.includes('--porcelain'), 'argv includes --porcelain');
  // Must drop to admin uid
  assert.ok(call.argv.includes('#1001'), 'drops to uid 1001');
});

test('wrapCommand does NOT require absolute path (unlike wrap for CLI)', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const wrapped = dp.wrapCommand(fakeExec);

  // A bare name like 'git' or 'gh' should work — resolved by sudo's secure_path
  await wrapped('gh', ['pr', 'view'], { cwd: '/workspace' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/sudo');
  assert.ok(calls[0].argv.includes('gh'));
});

test('wrapCommand is a no-op in container mode', async () => {
  const dp = makeDropper({ deployMode: 'container' });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const wrapped = dp.wrapCommand(fakeExec);

  await wrapped('git', ['status'], { cwd: '/workspace' });

  assert.equal(calls.length, 1);
  // In container mode, the command runs directly without sudo
  assert.equal(calls[0].file, 'git');
});

test('wrapCommand is a no-op when already running as target user', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 1001, currentGid: 1001 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const wrapped = dp.wrapCommand(fakeExec);

  await wrapped('git', ['status'], { cwd: '/workspace' });

  assert.equal(calls.length, 1);
  // Already the right user — no sudo needed
  assert.equal(calls[0].file, 'git');
});

test('wrapCommand sets HOME and USER for the target account', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const wrapped = dp.wrapCommand(fakeExec);

  await wrapped('git', ['commit', '-m', 'test'], { cwd: '/workspace', env: { HOME: '/root', USER: 'root' } });

  const env = calls[0].options.env;
  assert.equal(env.HOME, '/home/admin');
  assert.equal(env.USER, 'admin');
});

// ---------------------------------------------------------------------------
// Blocker 1 regression: an artifact created by a check must NOT be uid 0
// ---------------------------------------------------------------------------

test('commandInvocation produces uid-dropped argv preventing root-owned artifacts', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const inv = await dp.commandInvocation('git', ['add', '--', 'file.js'], { cwd: '/workspace' });

  // The invocation must go through sudo with the target uid
  assert.equal(inv.file, '/usr/bin/sudo');
  assert.ok(inv.argv.includes('#1001'), 'uid drop to 1001');
  // This is the control that prevents root-owned workspace artifacts
  assert.notEqual(inv.file, 'git', 'git must not run directly as root');
});

// ---------------------------------------------------------------------------
// Round 2, blocker 1: TmuxAdapter must share the same validated privilege-drop plan
// ---------------------------------------------------------------------------
//
// TmuxAdapter used to build its own `sudo -u <name> tmux …` invocation by hand: both `sudo` and
// `tmux` resolved through PATH, keyed on the account *name* rather than the numeric uid the rest of
// the system resolves once and pins. It must instead run through the identical
// PrivilegeDropper.wrapCommand plan that git.js and checks.js already use — never a second,
// independently-resolved drop that could in principle disagree with it and address a different
// tmux socket namespace.

test('TmuxAdapter routes through the shared privilege-drop plan in host mode, not a bare PATH sudo', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const tmux = new TmuxAdapter({ executable: 'tmux', exec: dp.wrapCommand(fakeExec) });

  await tmux.raw(['list-windows', '-t', '=pw_Demo']);

  assert.equal(calls.length, 1);
  const call = calls[0];
  // Must go through the vetted, absolute sudo helper — never a bare 'sudo' resolved through PATH.
  assert.equal(call.file, '/usr/bin/sudo');
  assert.notEqual(call.file, 'sudo');
  // Must drop to the validated numeric uid, never the bare account name.
  assert.ok(call.argv.includes('#1001'), 'drops to uid 1001, not the name');
  assert.ok(!call.argv.some((a) => a === 'admin'), 'the account name never appears in argv');
  assert.ok(call.argv.includes('tmux'), 'tmux itself is still the command run');
});

test('TmuxAdapter is unchanged in container mode', async () => {
  const dp = makeDropper({ deployMode: 'container' });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const tmux = new TmuxAdapter({ executable: 'tmux', exec: dp.wrapCommand(fakeExec) });

  await tmux.raw(['list-windows', '-t', '=pw_Demo']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'tmux');
});

test('TmuxAdapter shares the identical plan git/checks use — same dropper, same uid, one namespace', async () => {
  const dp = makeDropper({ deployMode: 'host', currentUid: 0 });
  const calls = [];
  const fakeExec = async (file, argv, options) => {
    calls.push({ file, argv, options });
    return { stdout: '', stderr: '' };
  };
  const droppedExec = dp.wrapCommand(fakeExec);
  const tmux = new TmuxAdapter({ executable: 'tmux', exec: droppedExec });

  await droppedExec('git', ['status'], { cwd: '/workspace' });
  await tmux.raw(['list-windows', '-t', '=pw_Demo']);

  const [gitCall, tmuxCall] = calls;
  const uidArg = (argv) => argv.find((a) => /^#\d+$/.test(a));
  assert.equal(uidArg(gitCall.argv), uidArg(tmuxCall.argv), 'git and tmux must drop to the exact same uid');
});

// ---------------------------------------------------------------------------
// Round 2, blocker 2: wrapCommand must track and confirm termination too
// ---------------------------------------------------------------------------
//
// `wrap` (the coding-CLI path) already enumerates the whole descendant tree and confirms it dead
// before letting a timeout or abort reach the caller. `wrapCommand` (git.js, checks.js) launched the
// exact same shape of command — a check script can time out, or be aborted, having backgrounded or
// setsid'd something of its own — but never called `ensureTerminated` at all, so that descendant was
// simply left running with nothing left in the system able to say so.

test('wrapCommand confirms termination of the tracked child on failure, exactly like wrap', async () => {
  const dp = makeDropper({ deployMode: 'container' });
  const fakeChild = { pid: 999999, exitCode: null, signalCode: null };
  let seenChild = null;
  dp.ensureTerminated = async (child) => {
    seenChild = child;
    return true;
  };
  const fakeExec = (file, argv, options) => {
    // A genuinely killed launch, not merely a non-zero exit: `killed`/`signal` are what Node itself
    // sets when a signal ended the process, and are exactly the discriminator `_execTracked` uses to
    // decide whether a termination verdict applies at all — a check that simply exits non-zero (a
    // failing test, `git rev-parse` outside a repository) must not reach `ensureTerminated`, or every
    // ordinary failure would fence a project on nothing resembling a live, unaccounted-for process.
    const err = new Error('Command failed');
    err.code = null;
    err.killed = true;
    err.signal = 'SIGTERM';
    const promise = Promise.reject(err);
    promise.child = fakeChild;
    return promise;
  };
  const wrapped = dp.wrapCommand(fakeExec);

  const err = await wrapped('some-check', [], {}).then(() => null, (e) => e);

  assert.ok(err, 'the failed command must reject');
  assert.equal(seenChild, fakeChild,
    'wrapCommand must hand the tracked child to ensureTerminated, exactly like wrap does');
  assert.equal(err.terminationConfirmed, true, 'the confirmed verdict must ride on the error');
});

test('wrapCommand reports an unconfirmed kill rather than hiding it, exactly like wrap', async () => {
  const dp = makeDropper({ deployMode: 'container' });
  const fakeChild = { pid: 999999, exitCode: null, signalCode: null };
  dp.ensureTerminated = async () => false;
  const fakeExec = (file, argv, options) => {
    const err = new Error('Command failed');
    err.code = null;
    err.killed = true;
    err.signal = 'SIGTERM';
    const promise = Promise.reject(err);
    promise.child = fakeChild;
    return promise;
  };
  const wrapped = dp.wrapCommand(fakeExec);

  const err = await wrapped('some-check', [], {}).then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.terminationConfirmed, false);
});

test('wrapCommand does not invoke ensureTerminated for an ordinary non-zero exit — a failing check is not a kill', async () => {
  // execFile rejects on ANY non-zero exit, not only a signal-killed one — and a check failing (a red
  // test, `git diff --check` finding a whitespace error) is exactly that: a normal, expected,
  // non-zero exit with no signal at all. If this reached `ensureTerminated` the way a real kill does,
  // every ordinary check failure would report an (unconditionally false, per this module's own
  // design) termination verdict, and an engine that fences on that verdict would fence the project on
  // a red test rather than on anything resembling a live, unaccounted-for process.
  const dp = makeDropper({ deployMode: 'container' });
  let ensureTerminatedCalled = false;
  dp.ensureTerminated = async () => { ensureTerminatedCalled = true; return false; };
  const fakeExec = (file, argv, options) => {
    const err = new Error('Command failed');
    err.code = 1; // a plain, non-signal exit code — the shape a failing check actually has
    const promise = Promise.reject(err);
    promise.child = { pid: 999998, exitCode: 1, signalCode: null };
    return promise;
  };
  const wrapped = dp.wrapCommand(fakeExec);

  const err = await wrapped('some-check', [], {}).then(() => null, (e) => e);

  assert.ok(err, 'a non-zero exit must still reject');
  assert.equal(ensureTerminatedCalled, false, 'an ordinary non-zero exit must never reach ensureTerminated');
  assert.equal(err.terminationConfirmed, undefined,
    'no termination verdict applies at all to an exit that was never a kill');
});

test('production wiring: index.js constructs the tmux lane with the same droppedExec as checks/git, never its own dropper', () => {
  // A hermetic unit test cannot exercise buildSubsystem end to end (it resolves a real sudo/passwd
  // in host mode with no injection point), so this asserts the wiring the source actually commits
  // to: TmuxAdapter must be built from the SAME `droppedExec` the CheckRunner receives, not a second
  // `privilegeDropperFor(...)` call, and not the old `deployMode`/`user` constructor shape that let
  // it resolve its own (unshared, PATH-based) drop.
  const source = fs.readFileSync(new URL('../app/orchestrator/index.js', import.meta.url), 'utf8');
  assert.match(
    source, /new TmuxAdapter\(\{[^}]*exec:\s*droppedExec/,
    'TmuxAdapter must be constructed with the shared droppedExec',
  );
  assert.doesNotMatch(
    source, /new TmuxAdapter\(\{[^}]*deployMode/,
    'TmuxAdapter must not resolve its own deployMode-keyed drop again',
  );
  // Exactly one PrivilegeDropper is built for the whole subsystem.
  const dropperConstructions = source.match(/privilegeDropperFor\(/g) ?? [];
  assert.equal(dropperConstructions.length, 1, 'there must be exactly one shared privilege-drop plan per subsystem');
});

// ---------------------------------------------------------------------------
// Blocker 2: terminationConfirmed must propagate through claude.js
// ---------------------------------------------------------------------------

test('runPhase propagates terminationConfirmed=false on cancelled phase', async () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: CLI,
    PW_DEPLOY_MODE: 'container',
  });

  let thrown = null;
  const fakeExec = async (file, argv, options) => {
    // Simulate a cancelled launch where termination was NOT confirmed
    const err = new Error('signal');
    err.name = 'AbortError';
    err.kind = 'cancelled';
    err.terminationConfirmed = false;
    throw err;
  };

  const backend = new ClaudeCodeBackend({ config, exec: fakeExec });

  try {
    await backend.runPhase({
      prompt: 'test', model: 'sonnet', effort: Effort.HIGH,
      maxTurns: 5, phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/workspace',
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'should have thrown');
  assert.equal(thrown.kind, 'cancelled');
  // The critical assertion: terminationConfirmed must be preserved, not lost
  assert.equal(thrown.terminationConfirmed, false,
    'terminationConfirmed=false must be preserved through the backend boundary');
});

test('runPhase propagates terminationConfirmed=true on cancelled phase', async () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: CLI,
    PW_DEPLOY_MODE: 'container',
  });

  const fakeExec = async () => {
    const err = new Error('signal');
    err.name = 'AbortError';
    err.kind = 'cancelled';
    err.terminationConfirmed = true;
    throw err;
  };

  const backend = new ClaudeCodeBackend({ config, exec: fakeExec });

  let thrown = null;
  try {
    await backend.runPhase({
      prompt: 'test', model: 'sonnet', effort: Effort.HIGH,
      maxTurns: 5, phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/workspace',
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown);
  assert.equal(thrown.terminationConfirmed, true);
});

// ---------------------------------------------------------------------------
// Blocker 3: Boot gate — eager validation
// ---------------------------------------------------------------------------

test('privilegeDropperFor resolves plan eagerly when plan() is awaited', async () => {
  // A dropper configured with a non-existent user must fail at plan time
  const dp = new PrivilegeDropper({
    deployMode: 'host',
    user: 'nonexistent_user_xyz',
    sudoExecutable: '',
    forbiddenEnv: [],
    forbiddenEnvPrefixes: [],
    exec: async (file, args) => {
      // getent exits 2 for missing user
      const err = new Error('not found');
      err.code = 2;
      throw err;
    },
    stat: fakeStat(REAL_HELPERS),
    currentUid: () => 0,
    currentGid: () => 0,
  });

  // If we await plan() at boot, the error surfaces immediately — this is what the fix does
  await assert.rejects(
    () => dp.plan(),
    (err) => err instanceof PrivilegeDropError && err.failure === PrivilegeFailure.USER_UNRESOLVABLE,
    'eager validation must surface unresolvable user at plan time',
  );
});

test('loadOrchestratorConfig refuses a host-mode config with an invalid user at load time', () => {
  assert.throws(
    () => loadOrchestratorConfig({
      PW_ORCHESTRATOR_ENABLED: 'true',
      PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
      PW_DEPLOY_MODE: 'host',
      PW_ORCHESTRATOR_TMUX_USER: 'root',
    }),
    /not usable in host mode/,
    'a superuser tmux user must be refused at config load (boot) time',
  );
});

// ---------------------------------------------------------------------------
// Blocker 4: Claude CLI path default is now absolute
// ---------------------------------------------------------------------------

test('default backendExecutable is an absolute path', () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'host',
  });
  assert.ok(
    config.backendExecutable.startsWith('/'),
    `default backendExecutable must be absolute, got: ${config.backendExecutable}`,
  );
});

test('backendExecutable is overridable by env', () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'host',
    PW_ORCHESTRATOR_CLAUDE_BIN: '/usr/bin/claude',
  });
  assert.equal(config.backendExecutable, '/usr/bin/claude');
});

// The review asked for the default to be `/usr/bin/claude`. On the instance it was asked for, that
// path does not exist — the CLI is an npm global exposed at `/usr/local/bin/claude`. Hardcoding
// either one bakes a single site's layout into the source, and the failure mode is bad in both
// directions: the fingerprint attests nothing, or every job blocks on a missing binary. So the
// default is resolved against the filesystem instead of asserted.
test('default backendExecutable resolves to a CLI that actually exists', () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'host',
  });
  const candidates = ['/usr/local/bin/claude', '/usr/bin/claude'];
  const present = candidates.filter((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (present.length === 0) {
    // Nothing installed here: the default must still name a concrete path, never a bare word.
    assert.equal(config.backendExecutable, candidates[0]);
    return;
  }
  assert.equal(
    config.backendExecutable, present[0],
    'the default must prefer an installed CLI over a path that is merely conventional',
  );
});

// An operator who names a path is entitled to that path. Probing the override would let a typo be
// silently replaced by a different binary, and the fingerprint would then attest something the
// operator never asked to run.
test('an explicit backendExecutable is never silently swapped for one that exists', () => {
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'host',
    PW_ORCHESTRATOR_CLAUDE_BIN: '/nonexistent/path/to/claude',
  });
  assert.equal(config.backendExecutable, '/nonexistent/path/to/claude');
});

// A raw NUL byte in a source file makes git and GitHub treat it as binary, which hides the diff
// from exactly the review these tests exist to satisfy. Hostile-input vectors must use an escape.
test('test sources use escapes, not raw NUL bytes, for hostile input vectors', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.test.mjs')) continue;
    const bytes = fs.readFileSync(path.join(dir, entry));
    assert.equal(
      bytes.includes(0), false,
      `${entry} contains a raw NUL byte, so its diff renders as binary and cannot be reviewed`,
    );
  }
});

// ---------------------------------------------------------------------------
// Blocker 2 additional: classifyBackendFailure correctly identifies cancellations
// ---------------------------------------------------------------------------

test('classifyBackendFailure preserves terminationConfirmed on AbortError', () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  err.terminationConfirmed = false;

  const kind = classifyBackendFailure(err);
  assert.equal(kind, 'cancelled');
  // The error object still carries terminationConfirmed after classification
  assert.equal(err.terminationConfirmed, false);
});
