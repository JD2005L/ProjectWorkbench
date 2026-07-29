// The privilege drop, exercised against real processes.
//
// orch-privilege.test.mjs asserts the argv and the environment with everything injected, which is
// what makes it deterministic — and also what makes it unable to answer the only question that
// actually mattered on the live host: does the child really run as somebody else? That needs real
// `sudo`, a real passwd database and a real process, so it is asked here.
//
// The suite skips itself when the host cannot answer — no sudo, no resolvable account, or a sudoers
// policy that would prompt for a password — because a test that silently passes on a machine where
// it could not run is worse than one that says it did not run. It never touches the live tmux
// namespace, the live orchestrator or anything outside a fresh temporary directory.
//
// Set PW_TEST_DROP_USER to name the account to drop to; it defaults to the account running the
// suite, which still exercises the whole real path end to end. Running the suite as root — which is
// the live service's situation — makes it a genuine root-to-unprivileged drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { PrivilegeDropper, resolveDropUser } from '../app/orchestrator/runner/privilege.js';
import { classifyBackendFailure } from '../app/orchestrator/runner/claude.js';

const execFileAsync = promisify(execFile);

const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'];

/**
 * The tools the scenarios below drive. Named absolutely — this file asserts things about launching
 * programs at fixed paths, so resolving them through PATH would be testing something else — and
 * checked up front, so a host missing one skips with a reason instead of failing on an ENOENT that
 * says nothing about the privilege drop.
 */
const TOOLS = Object.freeze({
  sudo: '/usr/bin/sudo',
  id: '/usr/bin/id',
  printenv: '/usr/bin/printenv',
  env: '/usr/bin/env',
  touch: '/usr/bin/touch',
  sleep: '/usr/bin/sleep',
  pgrep: '/usr/bin/pgrep',
  setsid: '/usr/bin/setsid',
  sh: '/bin/sh',
});

/** Whether this host can actually be asked, resolved once for the whole file. */
const capability = await (async () => {
  if (process.platform !== 'linux') return { ok: false, why: 'not a POSIX host with sudo semantics' };
  const missing = Object.values(TOOLS).filter((tool) => !fs.existsSync(tool));
  if (missing.length) return { ok: false, why: `this host has no ${missing.join(', ')}` };
  const me = os.userInfo();
  const name = process.env.PW_TEST_DROP_USER || (me.uid === 0 ? 'admin' : me.username);

  let target;
  try {
    target = await resolveDropUser(name);
  } catch (err) {
    return { ok: false, why: `the account '${name}' is not usable as a drop target (${err.failure ?? err.message})` };
  }
  try {
    // -n, so a policy that would prompt fails here rather than hanging the suite.
    await execFileAsync(TOOLS.sudo, ['-n', '-H', '-u', target.name, '--', TOOLS.id, '-u'], { timeout: 15_000 });
  } catch {
    return { ok: false, why: `sudo will not run non-interactively as '${target.name}' on this host` };
  }
  return { ok: true, target, callerUid: me.uid };
})();

/**
 * A dropper on the real host: real getent, real stat of the real sudo.
 *
 * `currentUid` is forced to 0 so the sudo path is taken even when the suite is already running as
 * the target account. Without it a developer box would quietly test the direct path and report a
 * pass for something it never ran.
 */
function realDropper({ terminationGraceMs } = {}) {
  return new PrivilegeDropper({
    deployMode: 'host',
    user: capability.target.name,
    forbiddenEnv: FORBIDDEN_ENV,
    currentUid: () => 0,
    ...(terminationGraceMs !== undefined ? { terminationGraceMs } : {}),
  });
}

function skipUnlessCapable(t) {
  if (!capability.ok) {
    t.skip(`real-process privilege drop not exercisable here: ${capability.why}`);
    return false;
  }
  return true;
}

/**
 * Some of these scenarios can only *discriminate* when the drop actually changes the identity.
 *
 * Run by the target account itself, "the child runs as the target account" is true even with the
 * drop removed entirely — verified by removing it: three of the four process assertions still
 * passed, including the one about root-owned artifacts, whose `chown` is itself skipped off-root.
 * A test that cannot fail is not evidence, so those skip with the reason rather than reporting a
 * pass. The environment scrub is exempt: it discriminates whoever runs the suite.
 */
function skipUnlessDropChangesIdentity(t) {
  if (!skipUnlessCapable(t)) return false;
  if (capability.callerUid === capability.target.uid) {
    t.skip(
      `this assertion cannot fail when the suite already runs as '${capability.target.name}' `
      + '— run it as root, or set PW_TEST_DROP_USER to a different account',
    );
    return false;
  }
  return true;
}

test('the child process really runs as the configured account', async (t) => {
  if (!skipUnlessDropChangesIdentity(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const { stdout: uid } = await exec(TOOLS.id, ['-u'], { timeout: 15_000 });
  const { stdout: gid } = await exec(TOOLS.id, ['-g'], { timeout: 15_000 });

  assert.equal(Number(uid.trim()), capability.target.uid, 'effective uid is the unprivileged account');
  assert.equal(Number(gid.trim()), capability.target.gid);
  assert.notEqual(Number(uid.trim()), 0, 'and it is emphatically not root');
});

test('the child sees the account home, so the subscription sign-in is where it expects', async (t) => {
  if (!skipUnlessDropChangesIdentity(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const read = async (name) => (await exec(TOOLS.printenv, [name], { timeout: 15_000 })).stdout.trim();

  assert.equal(await read('HOME'), capability.target.home);
  assert.equal(await read('USER'), capability.target.name);
  assert.equal(await read('LOGNAME'), capability.target.name);
});

test('no API-billing variable survives into the real child', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const { stdout } = await exec(TOOLS.env, [], {
    timeout: 15_000,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-must-not-survive', CLAUDE_CODE_USE_BEDROCK: '1' },
  });

  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) {
    assert.equal(new RegExp(`^${key}=`, 'm').test(stdout), false, `${key} reached the child`);
  }
  assert.match(stdout, new RegExp(`^HOME=${capability.target.home}$`, 'm'));
});

test('a bounded phase writing into a workspace leaves no root-owned artifact', async (t) => {
  if (!skipUnlessDropChangesIdentity(t)) return;
  const exec = realDropper().wrap(execFileAsync);
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-privdrop-ws-'));
  t.after(() => fsp.rm(workspace, { recursive: true, force: true }));
  // The workspace belongs to the unprivileged account, exactly as a project checkout does.
  if (capability.callerUid === 0) await fsp.chown(workspace, capability.target.uid, capability.target.gid);

  // A stand-in for the phase: a real child, with the workspace as its cwd, creating a real file.
  await exec(TOOLS.touch, ['artifact.txt'], { cwd: workspace, timeout: 15_000 });

  const created = await fsp.stat(path.join(workspace, 'artifact.txt'));
  assert.equal(created.uid, capability.target.uid, 'the artifact belongs to the unprivileged account');
  assert.notEqual(created.uid, 0, 'nothing root-owned was left in the workspace');

  const entries = await fsp.readdir(workspace, { withFileTypes: true });
  for (const entry of entries) {
    const info = await fsp.stat(path.join(workspace, entry.name));
    assert.notEqual(info.uid, 0, `${entry.name} is root-owned`);
  }
});

test('cancelling a real phase kills the process behind sudo', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const marker = `917.${process.pid}`;
  // Through `wrap`, which is the path the backend takes — the invocation alone would leave out the
  // part that makes the promise settle only once the thing it launched is actually gone.
  const exec = realDropper().wrap(execFileAsync);
  const controller = new AbortController();

  const running = exec(TOOLS.sleep, [marker], { signal: controller.signal, timeout: 60_000 });

  // Wait for the real child to exist before cancelling; aborting before the spawn completes would
  // prove nothing about signal relay. The matcher is anchored, so this cannot be satisfied by sudo.
  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the sleep never started');

  controller.abort();
  const err = await running.then(() => null, (e) => e);
  assert.ok(err, 'the cancelled launch rejected');
  assert.equal(classifyBackendFailure(err), 'cancelled');

  // No grace period here, deliberately: by the time the caller is told the phase stopped, it has.
  assert.equal(await pgrepCount(marker), 0, 'the process was still running when the caller was told it had stopped');
});

test('a cancellation racing the launch does not leave the CLI running', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // The window that made this necessary. `execFile` rejects the moment it *calls* kill, and with
  // sudo in front an abort landing in the first few milliseconds left both sudo and the command
  // alive — the job recorded cancelled while the agent kept editing. Reproduced at 5 ms as a normal
  // user and at 12 ms as root, so the delays are swept rather than guessed at.
  const exec = realDropper().wrap(execFileAsync);

  for (const delay of [0, 1, 3, 5, 8, 12, 20, 40]) {
    // One decimal point: `sleep` must actually accept the interval, or the process under test
    // exits immediately and the assertion below passes for the wrong reason.
    const marker = `${900 + delay}.${process.pid % 100000}`;
    const controller = new AbortController();
    const running = exec(TOOLS.sleep, [marker], { signal: controller.signal, timeout: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, delay));
    controller.abort();

    const err = await running.then(() => null, (e) => e);
    assert.ok(err, `the launch aborted at ${delay}ms rejected`);
    assert.equal(classifyBackendFailure(err), 'cancelled', `aborting at ${delay}ms reads as a cancellation`);
    assert.equal(await pgrepCount(marker), 0, `a launch aborted at ${delay}ms was left running`);
  }
});

test('the service environment does not reach the world-readable command line', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // `/proc/<pid>/cmdline` is mode 0444 — every local user can read it — while
  // `/proc/<pid>/environ`, where sudo carries the preserved values, is 0400. An earlier version of
  // this module composed the child's environment as `env -i -- NAME=value …` arguments, which
  // published the whole service environment (service tokens, directory credentials) to anyone on
  // the box for the length of every phase.
  const secret = `svc-tok-MUST-NOT-APPEAR-${process.pid}`;
  const marker = `931.${process.pid % 100000}`;
  const dropper = realDropper();
  const invocation = await dropper.invocation(TOOLS.sleep, [marker], {
    env: { ...process.env, PW_TEST_FAKE_TOKEN: secret },
  });
  const running = execFileAsync(invocation.file, invocation.argv, { ...invocation.options, timeout: 30_000 });
  running.catch(() => {});
  t.after(() => dropper.ensureTerminated(running.child, { graceMs: 2_000 }));

  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the sleep never started');

  const cmdline = (await fsp.readFile(`/proc/${running.child.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  assert.equal(cmdline.includes(secret), false, 'a service-environment value reached /proc/<pid>/cmdline');
  assert.match(cmdline, /--preserve-env=/, 'the names, and only the names, are on the command line');
});

test('a command that ignores SIGTERM is killed, not orphaned and called dead', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // The helper relays SIGTERM; a CLI that ignores it survives the grace. Killing only the helper
  // then reparents that process to init — unattributable, still writing to the workspace — while
  // the caller is told the phase stopped. What has to be confirmed dead is what was launched.
  const marker = `932.${process.pid % 100000}`;
  const dropper = realDropper();
  const invocation = await dropper.invocation('/bin/sh', ['-c', `trap '' TERM; exec ${TOOLS.sleep} ${marker}`], {});
  const running = execFileAsync(invocation.file, invocation.argv, { ...invocation.options, timeout: 60_000 });
  running.catch(() => {});

  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the stubborn command never started');

  const confirmed = await dropper.ensureTerminated(running.child, { graceMs: 1_500 });

  assert.equal(await pgrepCount(marker), 0, 'the command that ignored SIGTERM was left running');
  assert.equal(confirmed, true, 'and termination was reported as confirmed only because it was');
});

test('a tool subprocess that outlives the CLI is killed too, not left writing to the workspace', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // The shape a `Bash` tool leaves behind: the CLI exits on SIGTERM and something it started —
  // a build, a test run — does not, and is reparented to init. Enumerating the tree once was not
  // enough, because by the time a single /proc scan finished the parent had already gone and the
  // grandchild was no longer reachable from it; the launch was then reported terminated with the
  // grandchild still running and still writing. The tree is re-read on every round instead.
  const marker = `933.${process.pid % 100000}`;
  const dropper = realDropper();
  const invocation = await dropper.invocation(
    '/bin/sh',
    ['-c', `/bin/sh -c "trap '' TERM; exec ${TOOLS.sleep} ${marker}" & exec ${TOOLS.sleep} 934.5`],
    {},
  );
  const running = execFileAsync(invocation.file, invocation.argv, { ...invocation.options, timeout: 60_000 });
  running.catch(() => {});

  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the tool subprocess never started');

  const confirmed = await dropper.ensureTerminated(running.child, { graceMs: 1_500 });

  assert.equal(await pgrepCount(marker), 0, 'a tool subprocess was orphaned and left running');
  assert.equal(confirmed, true);
});

test('wrapCommand kills a setsid-detached, SIGTERM-ignoring descendant a repository check left behind', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // The shape a repository check can leave behind, distinct from the coding CLI's own tool
  // subprocess: the check command itself hangs and is SIGTERM'd on timeout, but something it
  // started with `setsid` has moved to its own session entirely and ignores the signal outright.
  // git.js and checks.js run through wrapCommand, not wrap — before this fix, only wrap confirmed
  // the descendant tree was actually dead.
  const marker = `937.${process.pid % 100000}`;
  const dropper = realDropper({ terminationGraceMs: 1_500 });
  const wrapped = dropper.wrapCommand(execFileAsync);

  const running = wrapped(
    TOOLS.sh,
    ['-c', `${TOOLS.setsid} ${TOOLS.sh} -c 'trap "" TERM; exec ${TOOLS.sleep} ${marker}' </dev/null >/dev/null 2>&1 & exec ${TOOLS.sleep} 60`],
    { timeout: 1_000 },
  );
  running.catch(() => {});

  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the setsid-detached descendant never started');

  const err = await running.then(() => null, (e) => e);
  assert.ok(err, 'the repository-check-shaped command must have timed out');
  assert.equal(err.terminationConfirmed, true, 'termination must be confirmed, not merely reported');
  assert.equal(await pgrepCount(marker), 0, 'a setsid-detached descendant survived wrapCommand\'s timeout');
});

test('wrap kills a setsid-detached, SIGTERM-ignoring descendant when the launch is aborted, not just on timeout', async (t) => {
  if (!skipUnlessCapable(t)) return;
  // The same blind spot, reached from the other trigger `execFile` can kill a direct child through
  // without this module ever seeing it: an AbortSignal, not a timeout. The coding CLI's own phase
  // deadline and cancellation both go through `signal`, not `timeout` — this is the path a real
  // cancellation of a running phase actually takes.
  const marker = `938.${process.pid % 100000}`;
  const dropper = realDropper({ terminationGraceMs: 1_500 });
  const wrapped = dropper.wrap(execFileAsync);
  const controller = new AbortController();

  const running = wrapped(
    TOOLS.sh,
    ['-c', `${TOOLS.setsid} ${TOOLS.sh} -c 'trap "" TERM; exec ${TOOLS.sleep} ${marker}' </dev/null >/dev/null 2>&1 & exec ${TOOLS.sleep} 60`],
    { signal: controller.signal, timeout: 60_000 },
  );
  running.catch(() => {});

  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the setsid-detached descendant never started');
  controller.abort();

  const err = await running.then(() => null, (e) => e);
  assert.ok(err, 'the aborted launch must reject');
  assert.equal(err.terminationConfirmed, true, 'termination must be confirmed, not merely reported');
  assert.equal(await pgrepCount(marker), 0, 'a setsid-detached descendant survived the abort');
});

test('a deadline behind sudo terminates the real process and reads as a timeout', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const marker = `918.${process.pid}`;
  const exec = realDropper().wrap(execFileAsync);

  const err = await exec(TOOLS.sleep, [marker], { timeout: 1_000 }).then(() => null, (e) => e);

  assert.ok(err, 'the launch did not outlive its deadline');
  assert.equal(classifyBackendFailure(err), 'timeout');
  assert.equal(await pgrepCount(marker), 0, 'the process behind sudo outlived its deadline');
});

/**
 * How many *actual* sleeps carry this marker — not how many command lines mention it.
 *
 * `-x` anchors the match to the whole command line. Without it, `pgrep -f "sleep <marker>"` also
 * matches `sudo -n -H -u #1000 -- /usr/bin/env -i -- … /usr/bin/sleep <marker>`, so both the
 * precondition ("it started") and the postcondition ("it died") could be satisfied by sudo alone,
 * with the process under test never existing. Verified: loose matched 4 processes here, anchored
 * matched 1.
 */
async function pgrepCount(marker) {
  try {
    const { stdout } = await execFileAsync(TOOLS.pgrep, ['-x', '-f', `${TOOLS.sleep} ${marker}`], { timeout: 10_000 });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate, budgetMs, message) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}
