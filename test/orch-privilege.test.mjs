// Host-mode privilege drop for the coding CLI.
//
// The bug this file exists for was live: `project-workbench.service` runs as root by design, and
// `ClaudeCodeBackend` exec'd the CLI directly, so the CLI ran as root too. A subscription sign-in
// lives in the operator's home directory, so `claude auth status` reported signed-out and the
// instance published `backend: down, auth method: unknown` while the subscription was healthy — and
// a phase that had run would have written root-owned files into an admin-owned workspace.
//
// The first two tests reproduce exactly that, and the rest hold the fix in place. Everything here is
// hermetic: the process runner, the passwd lookup and the stat of the sudo binary are all injected,
// so the suite asserts the same thing on a developer's box, in CI and on the live host. The real
// processes — actual uid, actual HOME, actual file ownership, actual cancellation — are exercised
// separately in orch-privilege-real.test.mjs, which spawns for real or skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { ClaudeCodeBackend, classifyBackendFailure } from '../app/orchestrator/runner/claude.js';
import {
  PrivilegeDropper, PrivilegeDropError, PrivilegeFailure,
  validateDropUser, resolveDropUser, resolveSudo, privilegeDropperFor,
} from '../app/orchestrator/runner/privilege.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { probeBinaryFingerprint } from '../app/orchestrator/runner/fingerprint.js';
import { HealthState, AuthMethod, PhaseClass, Effort } from '../app/orchestrator/contract.js';

const CLI = '/usr/local/bin/claude';

const HOST_CONFIG = loadOrchestratorConfig({
  PW_ORCHESTRATOR_ENABLED: 'true',
  PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
  PW_ORCHESTRATOR_CLAUDE_BIN: CLI,
  PW_DEPLOY_MODE: 'host',
  PW_ORCHESTRATOR_TMUX_USER: 'admin',
});

const CONTAINER_CONFIG = loadOrchestratorConfig({
  PW_ORCHESTRATOR_ENABLED: 'true',
  PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
  PW_ORCHESTRATOR_CLAUDE_BIN: CLI,
  PW_DEPLOY_MODE: 'container',
});

/** A passwd entry for the unprivileged account, answered the way `getent` answers. */
const PASSWD = 'admin:x:1000:1000:admin:/home/admin:/bin/bash\n';

/** A stat of a genuine sudo: regular file, root-owned, setuid, not writable by anyone else. */
const GOOD_SUDO = { isFile: () => true, uid: 0, mode: 0o104755 };

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

/**
 * A dropper whose passwd lookup, sudo stat and idea of "who am I" are all injected.
 *
 * `currentUid: 0` is the live host's situation — the service is root — and is stated explicitly so
 * the suite does not quietly test something else when run by a user who happens to be `admin`.
 */
function dropper({
  deployMode = 'host', user = 'admin', sudoExecutable = '',
  passwd = PASSWD, stats = { '/usr/bin/sudo': GOOD_SUDO }, currentUid = 0,
  forbiddenEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'],
} = {}) {
  const lookups = [];
  const exec = async (file, args) => {
    lookups.push({ file, args });
    if (passwd instanceof Error) throw passwd;
    return { stdout: passwd, stderr: '' };
  };
  const instance = new PrivilegeDropper({
    deployMode, user, sudoExecutable, forbiddenEnv,
    exec, stat: fakeStat(stats), currentUid: () => currentUid,
  });
  instance._lookups = lookups;
  return instance;
}

/** The recorded init/result lines a phase produces, so the parse path is exercised end to end. */
const INIT_LINE = JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits', apiKeySource: 'none', claude_code_version: '2.1.220',
});
const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2,
  session_id: 'sess-1', result: 'done', duration_ms: 10,
});

/**
 * A backend whose process runner records every launch.
 *
 * `auth status` is answered from the child's own HOME, because that is the mechanism of the live
 * failure: the sign-in is a file in the operator's home directory, and a process running with
 * root's HOME cannot see it however healthy the subscription is.
 */
function backendWith({ config = HOST_CONFIG, privilege = null, script = null } = {}) {
  const calls = [];
  const exec = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (script) {
      const scripted = script({ file, args, options });
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
    }
    if (args.includes('--version')) return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    if (args.includes('--help')) {
      return {
        stdout: [
          '  --effort <level>   Effort level for the current session',
          '                     (low, medium, high, xhigh, max)',
          '  --model <model>    Model for the current session',
        ].join('\n'),
        stderr: '',
      };
    }
    if (args.includes('auth') && args.includes('status')) {
      // The service is root, so a launch with nothing in front of it inherits root's HOME whatever
      // the caller passed — reading it from the injected environment would make this a test of
      // whoever runs the suite. Only a dropped launch has an environment of its own.
      const home = file === '/usr/bin/sudo' ? (options.env?.HOME ?? '/root') : '/root';
      // Only the account that actually signed in has the OAuth store.
      return home === '/home/admin'
        ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', version: '2.1.220' }), stderr: '' }
        : { stdout: JSON.stringify({ loggedIn: false }), stderr: '' };
    }
    return { stdout: `${INIT_LINE}\n${RESULT_LINE}\n`, stderr: '' };
  };
  const backend = new ClaudeCodeBackend({
    config, exec, privilege: privilege ?? dropper(), clock: () => new Date('2026-07-28T12:00:00.000Z'),
  });
  return { backend, calls };
}

const PHASE = Object.freeze({
  prompt: 'do the thing', model: 'sonnet', effort: Effort.HIGH, maxTurns: 3,
  phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/opt/project-workbench/workspaces/Demo',
});

// ---------------------------------------------------------------------------
// the live blocker, reproduced
// ---------------------------------------------------------------------------

test('regression: launching the CLI directly from a root service reports the subscription as down', async () => {
  // Container mode is the direct path — the same launch the host-mode backend used to make. Run
  // with root's environment it cannot see the operator's sign-in, which is precisely what the live
  // instance reported after the host-mode rollout.
  const { backend, calls } = backendWith({
    config: CONTAINER_CONFIG,
    privilege: dropper({ deployMode: 'container' }),
  });

  const health = await backend.probeAuth();

  assert.equal(calls[0].file, CLI, 'the direct path puts nothing in front of the CLI');
  assert.equal(health.state, HealthState.DOWN, 'the subscription is invisible to the process that asked');
  assert.match(health.detail, /signed out/);
  assert.equal(health.auth_mode, null);
});

test('host mode runs the auth probe as the unprivileged account, and the subscription is visible', async () => {
  const { backend, calls } = backendWith();

  const health = await backend.probeAuth();

  assert.equal(calls[0].file, '/usr/bin/sudo');
  assert.deepEqual(calls[0].args, ['-n', '-H', '-u', 'admin', '--', CLI, 'auth', 'status']);
  assert.equal(calls[0].options.env.HOME, '/home/admin');
  assert.equal(health.state, HealthState.OK);
  assert.equal(health.method, AuthMethod.SUBSCRIPTION_OAUTH);
  assert.equal(health.account_label, 'Claude Max');
});

// ---------------------------------------------------------------------------
// every launch, not just the probe
// ---------------------------------------------------------------------------

test('the phase, the verification and the fingerprint all launch through the drop', async () => {
  const { backend, calls } = backendWith();

  await backend.fingerprint().catch(() => {});
  await backend.runPhase(PHASE);
  await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: Effort.HIGH },
    cwd: PHASE.cwd,
  }).catch(() => {});

  assert.ok(calls.length >= 3, 'every path launched something');
  for (const call of calls) {
    assert.equal(call.file, '/usr/bin/sudo', 'no launch bypasses the drop');
    assert.deepEqual(call.args.slice(0, 5), ['-n', '-H', '-u', 'admin', '--']);
    assert.ok(path.isAbsolute(call.args[5]), 'the program is named absolutely, never through PATH');
  }
});

test('the CLI argv is passed through unchanged behind the drop', async () => {
  const { backend, calls } = backendWith();

  await backend.runPhase(PHASE);

  const launch = calls.at(-1);
  const cliArgv = launch.args.slice(6);
  assert.deepEqual(cliArgv, backend.buildPhaseArgv(PHASE));
  assert.ok(cliArgv.includes('--model') && cliArgv.includes('sonnet'));
  assert.ok(cliArgv.includes('--effort') && cliArgv.includes('high'));
  assert.ok(cliArgv.includes('--permission-mode') && cliArgv.includes('acceptEdits'));
});

test('cwd, timeout, buffer limit and the abort signal survive the drop', async () => {
  const { backend, calls } = backendWith();
  const controller = new AbortController();

  await backend.runPhase({ ...PHASE, timeoutMs: 4_242, signal: controller.signal });

  const launch = calls.at(-1);
  assert.equal(launch.options.cwd, PHASE.cwd);
  assert.equal(launch.options.timeout, 4_242);
  assert.equal(launch.options.maxBuffer, 32 * 1024 * 1024);
  assert.equal(launch.options.signal, controller.signal, 'cancellation still reaches the child');
});

// ---------------------------------------------------------------------------
// the child's environment
// ---------------------------------------------------------------------------

test('the child gets the account it runs as, and no route back to API billing', async () => {
  const instance = dropper();
  const invocation = await instance.invocation(CLI, ['auth', 'status'], {
    env: {
      HOME: '/root', USER: 'root', LOGNAME: 'root', PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-should-not-survive',
      ANTHROPIC_BASE_URL: 'https://proxy.invalid',
      CLAUDE_CODE_USE_BEDROCK: '1',
      SUDO_USER: 'someone-else',
    },
  });

  assert.equal(invocation.options.env.HOME, '/home/admin');
  assert.equal(invocation.options.env.USER, 'admin');
  assert.equal(invocation.options.env.LOGNAME, 'admin');
  assert.equal(invocation.options.env.PATH, '/usr/bin', 'unrelated variables are left alone');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'SUDO_USER']) {
    assert.equal(key in invocation.options.env, false, `${key} must not reach the child`);
  }
});

test('a caller cannot smuggle billing variables in through the phase environment', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-injected-by-the-environment';
  try {
    const { backend, calls } = backendWith();
    await backend.runPhase(PHASE);
    assert.equal('ANTHROPIC_API_KEY' in calls.at(-1).options.env, false);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// fingerprint identity still binds to the CLI, not to sudo
// ---------------------------------------------------------------------------

test('the fingerprint hashes the configured CLI and launches its realpath, never sudo', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-priv-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // A minimal file the kernel would load: ELF64, little-endian, version 1, ET_EXEC.
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header, 0);
  header.writeUInt16LE(2, 16);
  const binary = path.join(dir, 'claude.exe');
  await fsp.writeFile(binary, header);
  const sha256 = crypto.createHash('sha256').update(header).digest('hex');

  const launches = [];
  const instance = dropper();
  const exec = instance.wrap(async (file, args) => {
    launches.push({ file, args });
    if (args.includes('--version')) return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    return { stdout: '  --effort <level>  Effort\n                    (low, high)\n', stderr: '' };
  });

  const fingerprint = await probeBinaryFingerprint({
    executable: binary, options: ['--effort'], expectedSha256: sha256, exec,
  });

  assert.equal(fingerprint.ok, true);
  assert.equal(fingerprint.realpath, await fsp.realpath(binary));
  assert.equal(fingerprint.sha256, sha256, 'the hash is of the CLI, not of the helper that launches it');
  assert.deepEqual(fingerprint.capabilities['--effort'].values, ['low', 'high']);
  for (const launch of launches) {
    assert.equal(launch.file, '/usr/bin/sudo');
    assert.equal(launch.args[5], await fsp.realpath(binary), 'the fingerprinted file is the one that ran');
  }

  // And the pin still refuses a substituted binary, drop or no drop.
  await fsp.writeFile(binary, Buffer.concat([header, Buffer.from('extra')]));
  const substituted = await probeBinaryFingerprint({
    executable: binary, options: ['--effort'], expectedSha256: sha256, exec,
  });
  assert.equal(substituted.ok, false);
  assert.equal(substituted.failure, 'pinned_mismatch');
});

test('host mode refuses to launch a CLI that is not an absolute path', async () => {
  const relativeConfig = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'host',
    // The default: a bare name, which sudo would resolve through its own secure_path.
  });
  const { backend, calls } = backendWith({ config: relativeConfig });

  const outcome = await backend.runPhase(PHASE);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure_kind, 'privilege_drop_failed');
  assert.equal(calls.length, 0, 'nothing was launched at all');
});

// ---------------------------------------------------------------------------
// fail closed
// ---------------------------------------------------------------------------

test('a configured account that is missing, superuser or malformed is refused', () => {
  assert.throws(() => validateDropUser(''), (err) => err.failure === PrivilegeFailure.USER_MISSING);
  assert.throws(() => validateDropUser(undefined), (err) => err.failure === PrivilegeFailure.USER_MISSING);
  assert.throws(() => validateDropUser('root'), (err) => err.failure === PrivilegeFailure.USER_IS_ROOT);
  for (const hostile of [
    '-u', '--preserve-env', 'ad min', 'admin;id', 'admin\nroot', 'admin$(id)', '../../etc/passwd',
    'Admin', 'admin!', '0', 'a'.repeat(64), 'admin ', 'ADMIN', 'admin$',
  ]) {
    assert.throws(
      () => validateDropUser(hostile),
      (err) => err instanceof PrivilegeDropError && err.failure === PrivilegeFailure.USER_MALFORMED,
      `expected '${hostile}' to be refused`,
    );
  }
  assert.equal(validateDropUser(' admin '), 'admin');
});

test('a host-mode instance will not boot with an unusable drop account', () => {
  for (const user of ['root', '-u', 'ad min', 'ADMIN']) {
    assert.throws(
      () => loadOrchestratorConfig({
        PW_ORCHESTRATOR_ENABLED: 'true',
        PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
        PW_DEPLOY_MODE: 'host',
        PW_ORCHESTRATOR_TMUX_USER: user,
      }),
      /PW_ORCHESTRATOR_TMUX_USER is not usable in host mode/,
      `expected '${user}' to stop the instance booting`,
    );
  }
  // Container mode has nothing to drop, and an install that is not running the subsystem at all is
  // not made to care about a variable it never uses.
  assert.doesNotThrow(() => loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_DEPLOY_MODE: 'container',
    PW_ORCHESTRATOR_TMUX_USER: 'root',
  }));
  assert.doesNotThrow(() => loadOrchestratorConfig({ PW_ORCHESTRATOR_TMUX_USER: 'root' }));
});

test('an account that resolves to a superuser id, or to no id at all, is refused', async () => {
  const backdoor = dropper({ passwd: 'admin:x:0:0:root by another name:/root:/bin/bash\n' });
  await assert.rejects(backdoor.plan(), (err) => err.failure === PrivilegeFailure.USER_RESOLVES_TO_ROOT);

  const rootGroup = dropper({ passwd: 'admin:x:1000:0:admin:/home/admin:/bin/bash\n' });
  await assert.rejects(rootGroup.plan(), (err) => err.failure === PrivilegeFailure.USER_RESOLVES_TO_ROOT);

  const absent = dropper({ passwd: '' });
  await assert.rejects(absent.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);

  const noGetent = dropper({ passwd: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(noGetent.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);

  const noHome = dropper({ passwd: 'admin:x:1000:1000:admin::/bin/bash\n' });
  await assert.rejects(noHome.plan(), (err) => err.failure === PrivilegeFailure.USER_HOME_INVALID);

  const relativeHome = dropper({ passwd: 'admin:x:1000:1000:admin:home/admin:/bin/bash\n' });
  await assert.rejects(relativeHome.plan(), (err) => err.failure === PrivilegeFailure.USER_HOME_INVALID);
});

test('a passwd entry for a different account is never mistaken for the answer', async () => {
  // `getent passwd admin` on a host with no such account can still print other entries when the
  // NSS backend is loose; only a line for the account asked about counts.
  const instance = dropper({ passwd: 'administrator:x:1001:1001::/home/administrator:/bin/sh\n' });
  await assert.rejects(instance.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);
});

test('the privilege helper must be an absolute, root-owned, unwritable setuid binary', async () => {
  await assert.rejects(
    resolveSudo('sudo', { stat: fakeStat({}) }),
    (err) => err.failure === PrivilegeFailure.SUDO_NOT_ABSOLUTE,
  );
  await assert.rejects(
    resolveSudo('', { stat: fakeStat({}) }),
    (err) => err.failure === PrivilegeFailure.SUDO_UNRESOLVABLE,
  );
  await assert.rejects(
    resolveSudo('/usr/bin/sudo', { stat: fakeStat({ '/usr/bin/sudo': { isFile: () => true, uid: 0, mode: 0o100755 } }) }),
    (err) => err.failure === PrivilegeFailure.SUDO_NOT_PRIVILEGED,
  );
  await assert.rejects(
    resolveSudo('/usr/bin/sudo', { stat: fakeStat({ '/usr/bin/sudo': { isFile: () => true, uid: 1000, mode: 0o104755 } }) }),
    (err) => err.failure === PrivilegeFailure.SUDO_NOT_PRIVILEGED,
  );
  await assert.rejects(
    resolveSudo('/usr/bin/sudo', { stat: fakeStat({ '/usr/bin/sudo': { isFile: () => true, uid: 0, mode: 0o104777 } }) }),
    (err) => err.failure === PrivilegeFailure.SUDO_WRITABLE,
  );
  assert.equal(await resolveSudo('', { stat: fakeStat({ '/bin/sudo': GOOD_SUDO }) }), '/bin/sudo');
  assert.equal(
    await resolveSudo('/opt/pw/sudo', { stat: fakeStat({ '/opt/pw/sudo': GOOD_SUDO }) }),
    '/opt/pw/sudo',
  );
});

test('a host that cannot drop privilege runs nothing, rather than running as root', async () => {
  const unusable = dropper({ stats: {} });
  const { backend, calls } = backendWith({ privilege: unusable });

  const health = await backend.probeAuth();
  assert.equal(health.state, HealthState.DOWN);
  assert.match(health.detail, /could not be run as the unprivileged account/);

  const phase = await backend.runPhase(PHASE);
  assert.equal(phase.ok, false);
  assert.equal(phase.failure_kind, 'privilege_drop_failed');

  await assert.rejects(
    backend.verifyConfiguration({ requested: { model_alias: 'sonnet', effort: Effort.HIGH }, cwd: PHASE.cwd }),
    (err) => err.kind === 'privilege_drop_failed',
  );

  assert.equal(calls.length, 0, 'not one launch escaped as root');
});

test('a failed drop stays failed rather than being re-probed until it succeeds', async () => {
  const instance = dropper({ passwd: '' });
  await assert.rejects(instance.plan());
  await assert.rejects(instance.plan());
  await assert.rejects(instance.invocation(CLI, ['auth', 'status']));
  assert.equal(instance._lookups.length, 1, 'the refusal is decided once and held');
});

test('the failure is classified as a configuration fault, not as a failed phase', () => {
  assert.equal(classifyBackendFailure(new PrivilegeDropError(PrivilegeFailure.USER_MISSING, 'x')), 'privilege_drop_failed');
  // Ordering matters: the refusal has no exit code and no signal, so every later rule would have
  // classified it as a generic phase failure.
  assert.equal(classifyBackendFailure(Object.assign(new Error('x'), { kind: 'privilege_drop_failed', signal: 'SIGTERM' })), 'privilege_drop_failed');
});

// ---------------------------------------------------------------------------
// container mode, unchanged
// ---------------------------------------------------------------------------

test('container mode launches the CLI exactly as before', async () => {
  const instance = dropper({ deployMode: 'container', stats: {}, passwd: '' });
  const { backend, calls } = backendWith({ config: CONTAINER_CONFIG, privilege: instance });

  await backend.runPhase(PHASE);
  await backend.probeAuth();

  assert.equal(instance._lookups.length, 0, 'container mode never looks a drop account up');
  for (const call of calls) assert.equal(call.file, CLI);
  assert.deepEqual(calls.at(-1).args, ['auth', 'status']);
  assert.equal(calls[0].options.env.HOME, process.env.HOME, 'the environment is the process environment');
});

test('a host-mode process that is already the target account does not need a helper', async () => {
  // Not a fallback to root: the ids must be equal, and the account is validated and resolved first.
  const instance = dropper({ currentUid: 1000, stats: {} });
  const plan = await instance.plan();
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.reason, 'already_target_user');

  const asRoot = dropper({ currentUid: 0, stats: {} });
  await assert.rejects(asRoot.plan(), (err) => err.failure === PrivilegeFailure.SUDO_UNRESOLVABLE);
});

// ---------------------------------------------------------------------------
// hostile argv
// ---------------------------------------------------------------------------

test('argv injection is still refused before anything is launched', async () => {
  const { backend, calls } = backendWith();
  for (const model of ['--dangerously-skip-permissions', '-p', '--permission-mode=bypassPermissions']) {
    assert.throws(() => backend.buildPhaseArgv({ ...PHASE, model }), /invalid model alias/);
  }
  assert.throws(() => backend.buildPhaseArgv({ ...PHASE, effort: 'maximum' }), /invalid effort/);
  assert.equal(calls.length, 0);
});

test('a prompt full of shell metacharacters is one argv element, because there is no shell', async () => {
  const { backend, calls } = backendWith();
  const prompt = '"; rm -rf / #$(id) `whoami` && echo pwned';

  await backend.runPhase({ ...PHASE, prompt });

  const args = calls.at(-1).args;
  assert.equal(args.filter((a) => a === prompt).length, 1);
  assert.equal(args.indexOf('--'), 4, 'sudo option parsing ends before the program name');
  assert.ok(args.indexOf(prompt) > args.indexOf('--'), 'the prompt cannot be read as a sudo option');
});

// ---------------------------------------------------------------------------
// cancellation and deadlines
// ---------------------------------------------------------------------------

test('an aborted phase behind the drop is a cancellation, not a backend failure', async () => {
  const { backend } = backendWith({
    script: ({ args }) => (args.includes('-p')
      ? Object.assign(new Error('aborted'), { name: 'AbortError' })
      : null),
  });

  await assert.rejects(
    backend.runPhase({ ...PHASE, signal: new AbortController().signal }),
    (err) => err.kind === 'cancelled',
  );
});

test('a deadline reached behind the drop is a timeout, not a cancellation', async () => {
  const { backend } = backendWith({
    script: ({ args }) => (args.includes('-p')
      ? Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
      : null),
  });

  const outcome = await backend.runPhase({ ...PHASE, timeoutMs: 1_000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure_kind, 'timeout');
});

// ---------------------------------------------------------------------------
// the passwd lookup itself
// ---------------------------------------------------------------------------

test('the passwd lookup asks getent with fixed argv and no shell', async () => {
  const seen = [];
  const target = await resolveDropUser('admin', {
    exec: async (file, args, options) => {
      seen.push({ file, args, options });
      return { stdout: PASSWD, stderr: '' };
    },
  });
  assert.deepEqual(seen, [{ file: '/usr/bin/getent', args: ['passwd', 'admin'], options: { timeout: 10_000 } }]);
  assert.deepEqual(target, { name: 'admin', uid: 1000, gid: 1000, home: '/home/admin' });
});

test('a malformed account name never reaches the passwd lookup', async () => {
  let called = false;
  await assert.rejects(
    resolveDropUser('-u root', { exec: async () => { called = true; return { stdout: '' }; } }),
    (err) => err.failure === PrivilegeFailure.USER_MALFORMED,
  );
  assert.equal(called, false);
});

test('the dropper is built from the deployment configuration it is given', () => {
  const built = privilegeDropperFor(HOST_CONFIG, { forbiddenEnv: ['ANTHROPIC_API_KEY'] });
  assert.equal(built.deployMode, 'host');
  assert.equal(built.user, 'admin');
  assert.equal(built.sudoExecutable, '');
  assert.deepEqual(built.forbiddenEnv, ['ANTHROPIC_API_KEY']);
  assert.equal(privilegeDropperFor(CONTAINER_CONFIG).deployMode, 'container');
});

test('the real sudo on this host, when present, satisfies the helper checks', async (t) => {
  if (!fs.existsSync('/usr/bin/sudo')) return t.skip('no sudo on this host');
  assert.equal(await resolveSudo(''), '/usr/bin/sudo');
});
