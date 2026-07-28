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

/** Whether this host can actually be asked, resolved once for the whole file. */
const capability = await (async () => {
  if (process.platform !== 'linux') return { ok: false, why: 'not a POSIX host with sudo semantics' };
  if (!fs.existsSync('/usr/bin/sudo')) return { ok: false, why: 'no /usr/bin/sudo' };
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
    await execFileAsync('/usr/bin/sudo', ['-n', '-H', '-u', target.name, '--', '/usr/bin/id', '-u'], { timeout: 15_000 });
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
function realDropper() {
  return new PrivilegeDropper({
    deployMode: 'host',
    user: capability.target.name,
    forbiddenEnv: FORBIDDEN_ENV,
    currentUid: () => 0,
  });
}

function skipUnlessCapable(t) {
  if (!capability.ok) {
    t.skip(`real-process privilege drop not exercisable here: ${capability.why}`);
    return false;
  }
  return true;
}

test('the child process really runs as the configured account', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const { stdout: uid } = await exec('/usr/bin/id', ['-u'], { timeout: 15_000 });
  const { stdout: gid } = await exec('/usr/bin/id', ['-g'], { timeout: 15_000 });

  assert.equal(Number(uid.trim()), capability.target.uid, 'effective uid is the unprivileged account');
  assert.equal(Number(gid.trim()), capability.target.gid);
  assert.notEqual(Number(uid.trim()), 0, 'and it is emphatically not root');
});

test('the child sees the account home, so the subscription sign-in is where it expects', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const read = async (name) => (await exec('/usr/bin/printenv', [name], { timeout: 15_000 })).stdout.trim();

  assert.equal(await read('HOME'), capability.target.home);
  assert.equal(await read('USER'), capability.target.name);
  assert.equal(await read('LOGNAME'), capability.target.name);
});

test('no API-billing variable survives into the real child', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const exec = realDropper().wrap(execFileAsync);

  const { stdout } = await exec('/usr/bin/env', [], {
    timeout: 15_000,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-must-not-survive', CLAUDE_CODE_USE_BEDROCK: '1' },
  });

  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) {
    assert.equal(new RegExp(`^${key}=`, 'm').test(stdout), false, `${key} reached the child`);
  }
  assert.match(stdout, new RegExp(`^HOME=${capability.target.home}$`, 'm'));
});

test('a bounded phase writing into a workspace leaves no root-owned artifact', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const exec = realDropper().wrap(execFileAsync);
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-privdrop-ws-'));
  t.after(() => fsp.rm(workspace, { recursive: true, force: true }));
  // The workspace belongs to the unprivileged account, exactly as a project checkout does.
  if (capability.callerUid === 0) await fsp.chown(workspace, capability.target.uid, capability.target.gid);

  // A stand-in for the phase: a real child, with the workspace as its cwd, creating a real file.
  await exec('/usr/bin/touch', ['artifact.txt'], { cwd: workspace, timeout: 15_000 });

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
  const invocation = await realDropper().invocation('/usr/bin/sleep', [marker], {});
  const controller = new AbortController();

  const running = execFileAsync(invocation.file, invocation.argv, {
    ...invocation.options, signal: controller.signal, timeout: 60_000,
  });

  // Wait for the real child to exist before cancelling; aborting before the spawn completes would
  // prove nothing about signal relay.
  await waitFor(async () => await pgrepCount(marker) > 0, 10_000, 'the sleep never started');

  controller.abort();
  const err = await running.then(() => null, (e) => e);
  assert.ok(err, 'the cancelled launch rejected');
  assert.equal(classifyBackendFailure(err), 'cancelled');

  await waitFor(async () => await pgrepCount(marker) === 0, 10_000, 'the process behind sudo outlived its cancellation');
});

test('a deadline behind sudo terminates the real process and reads as a timeout', async (t) => {
  if (!skipUnlessCapable(t)) return;
  const marker = `918.${process.pid}`;
  const invocation = await realDropper().invocation('/usr/bin/sleep', [marker], {});

  const err = await execFileAsync(invocation.file, invocation.argv, { ...invocation.options, timeout: 1_000 })
    .then(() => null, (e) => e);

  assert.ok(err, 'the launch did not outlive its deadline');
  assert.equal(classifyBackendFailure(err), 'timeout');
  await waitFor(async () => await pgrepCount(marker) === 0, 10_000, 'the process behind sudo outlived its deadline');
});

/** How many processes carry this marker in their argv. `pgrep` exits 1 when there are none. */
async function pgrepCount(marker) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-f', `sleep ${marker}`], { timeout: 10_000 });
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
