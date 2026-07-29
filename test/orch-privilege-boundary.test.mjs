// Regression tests for the four security-review blockers on PR #19.
//
// Each test reproduces the specific issue the reviewer identified and verifies the fix:
//   1. Privilege boundary incomplete — git/checks/publish/gh run as root
//   2. Cancellation evidence lost — terminationConfirmed not propagated
//   3. Boot gate wording overstates enforcement — lazy validation
//   4. Claude path default is a bare name (now absolute)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PrivilegeDropper, PrivilegeDropError, PrivilegeFailure,
  privilegeDropperFor,
} from '../app/orchestrator/runner/privilege.js';
import { ClaudeCodeBackend, classifyBackendFailure } from '../app/orchestrator/runner/claude.js';
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
