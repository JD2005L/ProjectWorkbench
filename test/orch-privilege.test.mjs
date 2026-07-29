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
import { probeBinaryFingerprint, FingerprintCache, FingerprintFailure } from '../app/orchestrator/runner/fingerprint.js';
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

/** A stat of a genuine `env`: root-owned and unwritable, but not setuid — it needs no privilege. */
const GOOD_ENV = { isFile: () => true, uid: 0, mode: 0o100755 };

const REAL_HELPERS = Object.freeze({ '/usr/bin/sudo': GOOD_SUDO, '/usr/bin/env': GOOD_ENV });

/**
 * Take a recorded launch apart into what actually runs.
 *
 * A dropped launch is `sudo … -- env -i -- NAME=value … /abs/cli …`, so the program, its argv and
 * the environment the child will really see are all positions in one array. Reading them back out
 * here keeps every assertion about the thing it is named after rather than about an offset.
 */
function launched(call) {
  if (call.file !== '/usr/bin/sudo') {
    return { helper: null, program: call.file, argv: [...call.args], env: call.options?.env ?? {} };
  }
  const args = call.args;
  const rest = args.slice(args.indexOf('--') + 1);
  return {
    helper: call.file,
    runas: args[3],
    preserved: (args.find((arg) => arg.startsWith('--preserve-env=')) ?? '').replace('--preserve-env=', '').split(',').filter(Boolean),
    program: rest[0],
    argv: rest.slice(1),
    // The values travel in sudo's own environment, never in argv.
    env: call.options?.env ?? {},
  };
}

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
  passwd = PASSWD, stats = REAL_HELPERS, currentUid = 0, currentGid = null,
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
    currentGid: () => currentGid,
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
      const home = file === '/usr/bin/sudo' ? (launched({ file, args, options }).env.HOME ?? '/root') : '/root';
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

  const launch = launched(calls[0]);
  assert.equal(launch.helper, '/usr/bin/sudo');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-n', '-H', '-u', '#1000']);
  assert.match(calls[0].args[4], /^--preserve-env=/);
  assert.equal(calls[0].args[5], '--');
  assert.equal(launch.program, CLI);
  assert.deepEqual(launch.argv, ['auth', 'status']);
  assert.equal(launch.env.HOME, '/home/admin');
  assert.equal(health.state, HealthState.OK);
  assert.equal(health.method, AuthMethod.SUBSCRIPTION_OAUTH);
  assert.equal(health.account_label, 'Claude Max');
});

// ---------------------------------------------------------------------------
// every launch, not just the probe
// ---------------------------------------------------------------------------

/**
 * A file the kernel would load: ELF64, little-endian, version 1, ET_EXEC.
 *
 * The fingerprint refuses a script or an unloadable file *before* it launches anything, so a test
 * that points at a path which is not a real binary silently asserts nothing about launching — which
 * is exactly what an earlier version of the test below did, using this host's `/usr/local/bin/claude`
 * wrapper and passing on a launch count of zero.
 */
async function fakeCli(dir) {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header, 0);
  header.writeUInt16LE(2, 16);
  const binary = path.join(dir, 'claude.exe');
  await fsp.writeFile(binary, header);
  return { binary, sha256: crypto.createHash('sha256').update(header).digest('hex') };
}

test('the phase, the verification and the fingerprint all launch through the drop', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-priv-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { binary } = await fakeCli(dir);

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: binary, PW_DEPLOY_MODE: 'host', PW_ORCHESTRATOR_TMUX_USER: 'admin',
  });
  const { backend, calls } = backendWith({ config });

  const fingerprint = await backend.fingerprint();
  const fingerprintLaunches = calls.length;
  await backend.runPhase(PHASE);
  await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: Effort.HIGH },
    cwd: PHASE.cwd,
  }).catch(() => {});

  // Stated as counts, so the loop below cannot be satisfied by the paths that are easy to launch.
  assert.equal(fingerprint.ok, true, 'the fingerprint really ran; it did not bail before launching');
  assert.equal(fingerprintLaunches, 2, '--version and --help both launched');
  assert.ok(calls.length >= 5, 'the probe, the phase and the verification launched too');
  for (const call of calls) {
    const launch = launched(call);
    assert.equal(launch.helper, '/usr/bin/sudo', 'no launch bypasses the drop');
    assert.deepEqual(call.args.slice(0, 4), ['-n', '-H', '-u', '#1000']);
    assert.equal(launch.program, binary, 'the program is the configured CLI, named absolutely');
  }
});

test('the fingerprint cache the backend builds for itself is the dropped one', async (t) => {
  // Regression on the wiring, not the mechanism. `fingerprints` used to be injectable, and a caller
  // that supplied its own cache got one holding an undropped exec — a seam straight past the
  // control, taken by nothing but tests.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-priv-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { binary } = await fakeCli(dir);

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: binary, PW_DEPLOY_MODE: 'host', PW_ORCHESTRATOR_TMUX_USER: 'admin',
  });
  const { backend, calls } = backendWith({ config });
  await backend.fingerprint();
  assert.ok(calls.length > 0, 'the cache the backend built for itself launched something');
  assert.ok(calls.every((call) => call.file === '/usr/bin/sudo'), 'and launched it through the drop');

  // A caller offering its own, undropped cache is ignored: the parameter no longer exists.
  const smuggled = [];
  const undropped = new FingerprintCache({
    exec: async (file, args) => {
      smuggled.push({ file, args });
      return { stdout: args.includes('--version') ? '2.1.220 (Claude Code)' : '  --effort <level>\n', stderr: '' };
    },
  });
  const injected = new ClaudeCodeBackend({
    config, exec: async () => ({ stdout: '', stderr: '' }), privilege: dropper(), fingerprints: undropped,
  });
  await injected.fingerprint();
  assert.equal(smuggled.length, 0, 'the injected cache never ran');
});

test('the CLI argv is passed through unchanged behind the drop', async () => {
  const { backend, calls } = backendWith();

  await backend.runPhase(PHASE);

  const cliArgv = launched(calls.at(-1)).argv;
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
  // Deliberately attached: a detached launch measurably survived an abort in the first
  // milliseconds, where an attached one did not.
  assert.equal(launch.options.detached, undefined, 'the launch stays in this process group');
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

  // What the child will really see: `env -i` discards everything else, so these assignments are
  // the environment, not a hopeful copy of one.
  const childEnv = launched({ file: invocation.file, args: invocation.argv, options: invocation.options }).env;
  assert.equal(childEnv.HOME, '/home/admin');
  assert.equal(childEnv.USER, 'admin');
  assert.equal(childEnv.LOGNAME, 'admin');
  assert.equal(childEnv.PATH, '/usr/bin', 'unrelated variables are left alone');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'SUDO_USER']) {
    assert.equal(key in childEnv, false, `${key} must not reach the child`);
  }
});

test('a caller cannot smuggle billing variables in through the phase environment', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-injected-by-the-environment';
  try {
    const { backend, calls } = backendWith();
    await backend.runPhase(PHASE);
    assert.equal('ANTHROPIC_API_KEY' in launched(calls.at(-1)).env, false);
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
    assert.equal(
      launched({ ...launch, options: {} }).program, await fsp.realpath(binary),
      'the fingerprinted file is the one that ran',
    );
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
    PW_ORCHESTRATOR_CLAUDE_BIN: 'claude',
    // An explicitly bare name, which sudo would resolve through its own secure_path.
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

  // `getent` exits 2 for "no such key" — an answer, and a permanent one.
  const noSuchKey = dropper({ passwd: Object.assign(new Error('no such key'), { code: 2 }) });
  await assert.rejects(noSuchKey.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);

  const noHome = dropper({ passwd: 'admin:x:1000:1000:admin::/bin/bash\n' });
  await assert.rejects(noHome.plan(), (err) => err.failure === PrivilegeFailure.USER_HOME_INVALID);

  const relativeHome = dropper({ passwd: 'admin:x:1000:1000:admin:home/admin:/bin/bash\n' });
  await assert.rejects(relativeHome.plan(), (err) => err.failure === PrivilegeFailure.USER_HOME_INVALID);
});

test('a passwd entry that is not seven plain fields, or is answered twice, is refused', async () => {
  // A GECOS carrying a colon — expressible through a directory — shifts every later index, and
  // `fields[5]` then holds part of the comment. Refused rather than parsed harder.
  const shifted = dropper({ passwd: 'admin:x:1000:1000:Admin User: Ops:/home/admin:/bin/bash\n' });
  await assert.rejects(shifted.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);

  // Two sources answered and they need not agree on the uid; picking the first picks at random.
  const ambiguous = dropper({
    passwd: 'admin:x:1000:1000:admin:/home/admin:/bin/bash\nadmin:x:4242:4242:ldap:/home/admin:/bin/sh\n',
  });
  await assert.rejects(ambiguous.plan(), (err) => err.failure === PrivilegeFailure.USER_UNRESOLVABLE);
});

test('the runas target is the uid that was validated, not the name that resolved to it', async () => {
  // sudo re-resolves a name through NSS at exec time, and the plan is held for the lifetime of the
  // process. A directory change repointing the name at uid 0 in between would have been obeyed,
  // with every log line still saying the launch was unprivileged.
  const invocation = await dropper().invocation(CLI, ['auth', 'status'], {});
  assert.deepEqual(invocation.argv.slice(0, 4), ['-n', '-H', '-u', '#1000']);
  assert.equal(invocation.argv.includes('admin'), false);
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

test('the backend built the way the service builds it drops by default', async (t) => {
  // No injected privilege collaborator: exactly `new ClaudeCodeBackend({ config })`, as index.js
  // does it. The account is one that exists nowhere, so the assertion is the same on every host —
  // and what it proves is that the default construction goes through the drop machinery at all,
  // rather than launching whatever the caller asked for.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-priv-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // A real loadable binary, so the fingerprint reaches its launch instead of refusing the file
  // first — pointing at this host's `claude` would make the assertion below depend on whether that
  // path happens to hold the PW wrapper.
  const { binary } = await fakeCli(dir);

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: binary, PW_DEPLOY_MODE: 'host',
    PW_ORCHESTRATOR_TMUX_USER: 'pwnosuchaccount',
  });
  const calls = [];
  const backend = new ClaudeCodeBackend({
    config,
    exec: async (file, args) => { calls.push({ file, args }); return { stdout: '{}', stderr: '' }; },
  });

  assert.equal(backend.privilege.deployMode, 'host');
  assert.equal(backend.privilege.user, 'pwnosuchaccount');

  const health = await backend.probeAuth();
  assert.equal(health.state, HealthState.DOWN);
  assert.match(health.detail, /could not be run as the unprivileged account/);

  const phase = await backend.runPhase(PHASE);
  assert.equal(phase.failure_kind, 'privilege_drop_failed');

  const fingerprint = await backend.fingerprint();
  assert.equal(fingerprint.ok, false);
  // Not `version_unavailable`: the binary was never asked, and telling an operator their CLI is
  // broken when their account is missing sends them to look at the wrong thing entirely.
  assert.equal(fingerprint.failure, FingerprintFailure.PRIVILEGE_DROP_FAILED);
  assert.match(fingerprint.detail, /unprivileged account/);

  assert.equal(calls.length, 0, 'not one launch escaped');
});

test('a failed drop stays failed rather than being re-probed until it succeeds', async () => {
  const instance = dropper({ passwd: '' });
  await assert.rejects(instance.plan());
  await assert.rejects(instance.plan());
  await assert.rejects(instance.invocation(CLI, ['auth', 'status']));
  assert.equal(instance._lookups.length, 1, 'the refusal is decided once and held');
});

test('a lookup that failed decided nothing, and is asked again', async () => {
  // The account is not refused here — the directory did not answer. Holding that for the life of
  // the process takes the coding backend down over one unanswered query, on exactly the
  // LDAP-joined host this module uses getent to support. Asking again cannot produce a root
  // launch: the outcomes are still refuse, or drop to the account that has been validated.
  let attempts = 0;
  const flaky = new PrivilegeDropper({
    deployMode: 'host',
    user: 'admin',
    exec: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('timed out'), { killed: true });
      return { stdout: PASSWD, stderr: '' };
    },
    stat: fakeStat(REAL_HELPERS),
    currentUid: () => 0,
  });

  await assert.rejects(flaky.plan(), (err) => err.failure === PrivilegeFailure.USER_LOOKUP_FAILED && err.transient === true);
  const plan = await flaky.plan();
  assert.equal(plan.mode, 'sudo', 'the second attempt got an answer');
  assert.equal(attempts, 2);

  // A refusal, by contrast, is decided once — asking again is how a flapping probe eventually
  // lets something through.
  const refused = dropper({ passwd: 'admin:x:0:0:root:/root:/bin/sh\n' });
  await assert.rejects(refused.plan(), (err) => err.transient === false);
  await assert.rejects(refused.plan());
  assert.equal(refused._lookups.length, 1);
});

test("the helper's own refusal is a configuration fault, not a failed phase", async () => {
  // `sudo: a password is required` is sudo declining to run anything — no phase happened. Reported
  // as a phase failure it reads as "the phase did not complete", which sends an operator to look
  // at the project instead of at the sudoers policy.
  for (const message of [
    'sudo: a password is required',
    'sudo: unknown user admin',
    'sudo: unable to execute /usr/local/bin/claude: No such file or directory',
    // The likeliest misconfiguration of all: a wrong PW_ORCHESTRATOR_CLAUDE_BIN. sudo reports it,
    // so the ENOENT that used to reach `unavailable` never arrives on this path.
    'sudo: /usr/local/bin/clade: command not found',
    'sudo: sorry, you are not allowed to preserve the environment',
  ]) {
    const { backend } = backendWith({
      script: () => Object.assign(new Error('Command failed'), { code: 1, stderr: `${message}\n`, stdout: '' }),
    });

    const phase = await backend.runPhase(PHASE);
    assert.equal(phase.failure_kind, 'privilege_drop_failed', message);

    const health = await backend.probeAuth();
    assert.equal(health.state, HealthState.DOWN);
    assert.match(health.detail, /unprivileged account/);
  }

  // And the CLI's own stderr is not mistaken for the helper's. The middle case is the one that
  // matters: real sudo prints that warning on every invocation on a host whose /etc/hosts does not
  // name it, so a looser match turned every failed phase into a configuration fault and sent the
  // operator to read the sudoers policy. The last is the agent choosing its own failure label.
  for (const stderr of [
    'Error: something went wrong in the session\n',
    'sudo: unable to resolve host build-01: Name or service not known\nError: the tests failed\n',
    'the agent ran a command and printed:\nsudo: a password is required\n',
  ]) {
    const { backend: normal } = backendWith({
      script: () => Object.assign(new Error('Command failed'), { code: 1, stderr }),
    });
    assert.equal(
      (await normal.runPhase(PHASE)).failure_kind, 'phase_failed',
      `misread as a privilege fault: ${JSON.stringify(stderr.slice(0, 40))}`,
    );
  }

  // A refusal exit code is required too: sudo refuses with 1, 126 or 127, never 0.
  const { backend: oddCode } = backendWith({
    script: () => Object.assign(new Error('Command failed'), { code: 3, stderr: 'sudo: a password is required\n' }),
  });
  assert.equal((await oddCode.runPhase(PHASE)).failure_kind, 'phase_failed');
});

test('the environment crosses by name, never as arguments', async () => {
  // The regression this exists for: composing the child's environment as `env -i -- NAME=value …`
  // put the service's entire environment — service tokens included — into /proc/<pid>/cmdline,
  // which is world-readable, for the whole length of a phase. sudo carries the values in its own
  // environment instead, which is owner-only; only the names appear in argv.
  process.env.PW_ORCHESTRATOR_FAKE_TOKEN = 'svc-tok-MUST-NOT-APPEAR';
  process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
  try {
    const { backend, calls } = backendWith();
    await backend.runPhase(PHASE);
    const call = calls.at(-1);

    assert.equal(
      call.args.some((arg) => arg.includes('svc-tok-MUST-NOT-APPEAR')), false,
      'a service token reached the command line',
    );
    assert.equal(
      call.args.some((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)), false,
      'no environment value is passed as an argument',
    );
    const launch = launched(call);
    assert.ok(launch.preserved.includes('HTTPS_PROXY'), 'the names a deployment needs do cross');
    assert.equal(launch.preserved.includes('PW_ORCHESTRATOR_FAKE_TOKEN'), false);
    assert.equal(launch.env.HTTPS_PROXY, 'http://proxy.internal:3128', 'and their values travel in the environment');
  } finally {
    delete process.env.PW_ORCHESTRATOR_FAKE_TOKEN;
    delete process.env.HTTPS_PROXY;
  }
});

test('being the account means both ids, not just the uid', async () => {
  // A process running as the account but in another primary group creates files the account's own
  // terminal may not be able to write — half of what this module exists to prevent.
  const wrongGroup = dropper({ currentUid: 1000, currentGid: 27 });
  const plan = await wrongGroup.plan();
  assert.equal(plan.mode, 'sudo', 'the helper decides the identity when the group differs');

  const exact = dropper({ currentUid: 1000, currentGid: 1000, stats: {} });
  assert.equal((await exact.plan()).mode, 'no_drop');
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
  assert.equal(plan.mode, 'no_drop');
  assert.equal(plan.reason, 'already_target_user');

  const asRoot = dropper({ currentUid: 0, stats: {} });
  await assert.rejects(asRoot.plan(), (err) => err.failure === PrivilegeFailure.SUDO_UNRESOLVABLE);
});

test('being the target account does not exempt a launch from any other host-mode control', async () => {
  // The case that made this necessary: `sudo -u admin node server.js`, with no -H, is uid 1000 with
  // `HOME=/root`. Returning the caller's launch untouched here meant the CLI read root's home and
  // resolved a bare `claude` through PATH — the very bug this module exists to fix, reported as a
  // success because the uid happened to match.
  const instance = dropper({ currentUid: 1000, stats: {} });

  const invocation = await instance.invocation('/usr/local/bin/claude', ['auth', 'status'], {
    env: { HOME: '/root', USER: 'root', ANTHROPIC_API_KEY: 'sk-survives-nothing' },
  });
  assert.equal(invocation.file, '/usr/local/bin/claude', 'no helper is needed');
  assert.equal(invocation.options.env.HOME, '/home/admin', 'the environment is still corrected');
  assert.equal(invocation.options.env.USER, 'admin');
  assert.equal('ANTHROPIC_API_KEY' in invocation.options.env, false, 'billing variables are still stripped');

  await assert.rejects(
    instance.invocation('claude', ['auth', 'status'], {}),
    (err) => err.failure === PrivilegeFailure.EXECUTABLE_NOT_ABSOLUTE,
    'a PATH-resolved CLI is still refused',
  );
});

test('the dropper defaults to the mode that requires a drop, and refuses one it does not know', async () => {
  // A safety-critical default must fail towards the control. Constructed with nothing at all, the
  // dropper is host-mode — so it refuses for want of an account rather than launching as root.
  await assert.rejects(new PrivilegeDropper({}).plan(), (err) => err.failure === PrivilegeFailure.USER_MISSING);
  // A configuration object with no mode is not read as "container, nothing to do".
  assert.equal(privilegeDropperFor({ tmuxUser: 'admin' }).deployMode, 'host');
  assert.equal(privilegeDropperFor({}).deployMode, 'host');
  for (const mode of ['Host', 'HOST', 'hosts', 'docker', '', null]) {
    await assert.rejects(
      dropper({ deployMode: mode }).plan(),
      (err) => err.failure === PrivilegeFailure.UNKNOWN_DEPLOY_MODE,
      `expected ${JSON.stringify(mode)} to be refused rather than guessed at`,
    );
  }
});

test('no loader variable reaches the child, because it would run inside the attested binary', async () => {
  // The regression this exists for was introduced by the fix above it. While the launch relied on
  // sudo's `env_reset`, `LD_PRELOAD` was stripped for free; naming the environment explicitly —
  // which is what made the scrub real — turned it into a variable this service would deliberately
  // re-apply. A preloaded constructor runs inside the process whose SHA-256 was just checked, so
  // the pin, the ELF check and the wrapper check all become statements about a file rather than
  // about the behaviour that ran. Verified against real processes: with the environment named,
  // `LD_PRELOAD=…/pre.so` did execute in the child.
  const loaders = {
    LD_PRELOAD: '/tmp/evil.so',
    LD_LIBRARY_PATH: '/tmp/evil',
    LD_AUDIT: '/tmp/audit.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    NODE_OPTIONS: '--require /tmp/evil.js',
    BUN_INSPECT: '1',
  };
  for (const [key, value] of Object.entries(loaders)) process.env[key] = value;
  try {
    const { backend, calls } = backendWith();
    await backend.runPhase(PHASE);
    const env = launched(calls.at(-1)).env;
    for (const key of Object.keys(loaders)) {
      assert.equal(key in env, false, `${key} would execute inside the attested binary`);
    }
    // The argv itself, not only the decoded environment: this is what the loader would read.
    assert.equal(calls.at(-1).args.some((arg) => /^(LD_|DYLD_)/.test(arg)), false);
  } finally {
    for (const key of Object.keys(loaders)) delete process.env[key];
  }
});

test('the environment scrub covers the families the CLI actually reads, not a fixed list', async () => {
  const { backend, calls } = backendWith();
  const smuggled = {
    // Substitutes the billing identity while still passing the claude.ai/firstParty check.
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-nope',
    // Repoints the whole credential and settings directory; a settings file carries its own env.
    CLAUDE_CONFIG_DIR: '/tmp/attacker',
    // Overrides the two settings the attestation is about — effort has no read-back at all.
    CLAUDE_EFFORT: 'low',
    MAX_THINKING_TOKENS: '1',
    ANTHROPIC_MODEL: 'claude-3-haiku',
    ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-haiku',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-3-haiku',
    // A name this build has never heard of. The prefix rule is the point: the list is a race.
    ANTHROPIC_SOMETHING_INVENTED_LATER: 'x',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  };
  for (const [key, value] of Object.entries(smuggled)) process.env[key] = value;
  process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
  try {
    await backend.runPhase(PHASE);
    const env = launched(calls.at(-1)).env;
    for (const key of Object.keys(smuggled)) {
      assert.equal(key in env, false, `${key} must not reach the child`);
    }
    // Connectivity, not billing. Removing it would break a legitimate proxied install and stop
    // nothing an operator who can set it could not do more directly.
    assert.equal(env.HTTPS_PROXY, 'http://proxy.internal:3128');
  } finally {
    for (const key of Object.keys(smuggled)) delete process.env[key];
    delete process.env.HTTPS_PROXY;
  }
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
  assert.equal(args.indexOf('--'), 5, 'sudo option parsing ends before the program name');
  assert.ok(args.indexOf(prompt) > args.indexOf('--'), 'the prompt cannot be read as a sudo option');
  assert.deepEqual(launched(calls.at(-1)).argv.filter((a) => a === prompt), [prompt]);
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
