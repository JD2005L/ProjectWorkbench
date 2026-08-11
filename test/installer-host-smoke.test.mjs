// STAGED HOST-INSTALL SMOKE — does the installed result actually execute?
//
// The manifest audit next door proves install.sh *claims* to ship everything the
// units reference. That is a source-level claim. What failed on the real host was
// one level down: systemd tried to exec the owner unit's ExecStart and got
// 203/EXEC. So this file stages the installer's own manifest into a temporary
// root and then RUNS the owner unit's exact ExecStart out of that staging root.
//
// WHAT MAKES THIS DIFFERENT FROM THE READINESS SUITE. tmux-owner-readiness.test.mjs
// runs scripts/pw-tmux-keepalive.sh from the REPOSITORY — which is exactly the
// shape of fixture that hid this defect, because the repository copy always exists
// no matter what install.sh does. Here the subject under test is the STAGED file at
// the unit's own ExecStart path, so if install.sh does not put a file there, this
// fails the way the host failed.
//
// NO LIVE SERVICE CHANGES. Nothing here touches the real /etc, /usr/local or the
// shared tmux socket:
//   * every install destination is rerooted under a private temp directory;
//   * `systemctl` is a recording stub on PATH and is asserted never to be called;
//   * the tmux server runs on a private socket path under a short /tmp root and is
//     killed in the test's own cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  execProgramsIn, installedUnits, read, stageInstall, unitEnvironment,
} from './installer-manifest-lib.mjs';

const OWNER_UNIT = 'systemd/pw-tmux-server.service';

const HAVE_TMUX = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const needTmux = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, fn);

/**
 * Stage the installer's manifest, plus a recording `systemctl` stub. The socket
 * root is separate and short: tmux socket paths are bounded by sockaddr_un
 * (~104 bytes), and a path under a long mkdtemp fails in a way that looks like a
 * logic bug.
 */
function stageHost(installSh = read('install.sh')) {
  const stageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-stage-')));
  const sockRoot = fs.mkdtempSync('/tmp/pwh-');
  fs.chmodSync(sockRoot, 0o700);

  const bin = path.join(stageRoot, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const systemctlLog = path.join(stageRoot, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(systemctlLog)}\nexit 0\n`, { mode: 0o755 });
  const readyFlag = path.join(stageRoot, 'ready');
  fs.writeFileSync(path.join(bin, 'systemd-notify'), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "--ready" ] && printf '%s\\n' "$*" > ${JSON.stringify(readyFlag)}; done\nexit 0\n`, { mode: 0o755 });

  const staged = stageInstall(stageRoot, installSh);
  return { stageRoot, sockRoot, bin, systemctlLog, readyFlag, staged, installSh };
}

function cleanup(host) {
  try {
    spawnSync('tmux', ['-S', path.join(host.sockRoot, 'sock'), 'kill-server'], { timeout: 10000, stdio: 'ignore' });
  } catch { /* the server may already be gone */ }
  fs.rmSync(host.stageRoot, { recursive: true, force: true });
  fs.rmSync(host.sockRoot, { recursive: true, force: true });
}

/** The owner unit's ExecStart, read from the STAGED unit file rather than restated. */
function stagedOwnerExecStart(host) {
  const unit = installedUnits(host.installSh).find((u) => u.source === OWNER_UNIT);
  assert.ok(unit, 'install.sh no longer installs the owner unit');
  const stagedUnit = path.join(host.stageRoot, unit.dest);
  assert.equal(fs.existsSync(stagedUnit), true, `the staged install has no ${unit.dest}`);
  const text = fs.readFileSync(stagedUnit, 'utf8');
  const start = execProgramsIn(text).filter((p) => p.directive === 'ExecStart');
  assert.equal(start.length, 1, `expected exactly one ExecStart in ${unit.dest}, got ${start.length}`);
  return { argv: start[0].argv, env: unitEnvironment(text), unitDest: unit.dest };
}

/**
 * Run the staged ExecStart the way the unit would.
 *
 * The unit's own Environment= lines are applied verbatim. Only three test-only
 * variables are added, and each is stated rather than hidden:
 *   PW_TMUX_SOCKET_PATH  — a private socket, so the live server is never touched;
 *   PW_TMUX_PROC_ROOT    — a controlled /proc, per the Round 8 rule that a
 *                          same-cgroup comparison on a CI runner proves nothing;
 *   PW_TMUX_EXIT_AFTER_READY — return after readiness instead of supervising
 *                          forever, which is the script's documented test hook.
 * PW_TMUX_REQUIRE_CGROUP is NOT overridden: it comes from the unit.
 */
function runStagedExecStart(host, { procRoot, extraEnv = {} } = {}) {
  const { argv, env: unitEnv, unitDest } = stagedOwnerExecStart(host);
  const staged = path.join(host.stageRoot, argv[0]);

  // The 203/EXEC precondition, checked before we try: systemd reports 203/EXEC
  // when the ExecStart path is missing or is not executable.
  if (!fs.existsSync(staged)) {
    return { execFailure: `203/EXEC: ${unitDest} ExecStart=${argv[0]} — the staged install has no such file`, staged };
  }
  if (!(fs.statSync(staged).mode & 0o111)) {
    return { execFailure: `203/EXEC: ${unitDest} ExecStart=${argv[0]} — staged but not executable`, staged };
  }

  const r = spawnSync(staged, argv.slice(1), {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: `${host.bin}:/usr/bin:/bin`,
      HOME: host.stageRoot,
      LANG: 'C.UTF-8',
      TMUX_TMPDIR: host.sockRoot,
      ...unitEnv,
      PW_TMUX_SOCKET_PATH: path.join(host.sockRoot, 'sock'),
      PW_TMUX_PROC_ROOT: procRoot ?? path.join(host.stageRoot, 'empty-proc'),
      PW_TMUX_EXIT_AFTER_READY: '1',
      ...extraEnv,
    },
  });
  return { r, staged, unitDest };
}

function serverPid(host) {
  const r = spawnSync('tmux', ['-S', path.join(host.sockRoot, 'sock'), 'display-message', '-p', '#{pid}'], {
    encoding: 'utf8', timeout: 10000,
  });
  return r.stdout.trim();
}

/** A controlled /proc placing the given pid in the cgroup the owner unit expects. */
function procRootFor(host, pid, cgroup) {
  const root = path.join(host.stageRoot, `proc-${pid}`);
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'cgroup'), `0::/system.slice/${cgroup}\n`);
  return root;
}

// ---------------------------------------------------------------------------
// The smoke
// ---------------------------------------------------------------------------

test('the staged install puts an executable file at the owner unit\'s ExecStart path', () => {
  const host = stageHost();
  try {
    const { argv, unitDest } = stagedOwnerExecStart(host);
    const staged = path.join(host.stageRoot, argv[0]);
    assert.equal(fs.existsSync(staged), true,
      `${unitDest} ExecStart=${argv[0]} but the staged install writes no such file — this is 203/EXEC`);
    assert.ok(fs.statSync(staged).mode & 0o111,
      `${argv[0]} is staged non-executable (mode ${(fs.statSync(staged).mode & 0o777).toString(8)}) — this is 203/EXEC`);
  } finally { cleanup(host); }
});

needTmux('the staged ExecStart runs to readiness — no 203/EXEC, no missing-helper path', () => {
  const host = stageHost();
  try {
    const { r, execFailure, unitDest } = runStagedExecStart(host);
    assert.equal(execFailure, undefined, execFailure);

    const output = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.error, undefined, `${unitDest} ExecStart could not be spawned: ${r.error && r.error.message}`);
    assert.equal(r.status, 0, `the owner's ExecStart exited ${r.status}\n${output}`);
    assert.equal(fs.existsSync(host.readyFlag), true, `readiness was never signalled\n${output}`);

    // The failure shapes a missing helper produces, named explicitly so a
    // regression reports the cause rather than a bare non-zero exit.
    for (const shape of [/No such file or directory/i, /command not found/i, /not found/i]) {
      assert.equal(shape.test(output), false, `a missing-helper path was reached:\n${output}`);
    }
  } finally { cleanup(host); }
});

needTmux('the staged ExecStart satisfies the unit\'s OWN cgroup requirement', () => {
  // The unit ships PW_TMUX_REQUIRE_CGROUP=1. The first run above leaves the server
  // up, so its real pid can now be placed in a controlled /proc that says what a
  // real host would say — Round 8's rule, because every process on a CI runner
  // shares one cgroup and a live comparison would prove nothing. The keepalive is
  // idempotent, so re-running it against the live server is the real second start.
  const host = stageHost();
  try {
    assert.equal(runStagedExecStart(host).r.status, 0, 'first start failed');
    const pid = serverPid(host);
    assert.match(pid, /^\d+$/, 'no live tmux server to interrogate');

    const expected = unitEnvironment(read(OWNER_UNIT)).PW_TMUX_REQUIRE_CGROUP;
    assert.equal(expected, '1', 'the owner unit no longer requires a cgroup match — this test is checking nothing');

    const ok = runStagedExecStart(host, { procRoot: procRootFor(host, pid, 'pw-tmux-server.service') });
    assert.equal(ok.r.status, 0, `the owner refused its own cgroup:\n${ok.r.stdout}${ok.r.stderr}`);

    // Negative control: the same run against a terminal's cgroup must refuse, or
    // the check above is passing for the wrong reason.
    fs.rmSync(host.readyFlag, { force: true });
    const bad = runStagedExecStart(host, { procRoot: procRootFor(host, pid, 'project-terminal@demo.service') });
    assert.notEqual(bad.r.status, 0, 'a foreign cgroup was accepted');
    assert.match(`${bad.r.stdout}${bad.r.stderr}`, /cgroup/i);
    assert.equal(fs.existsSync(host.readyFlag), false, 'readiness was signalled for a foreign cgroup');
  } finally { cleanup(host); }
});

needTmux('MUTATION: with the keepalive install line removed, this smoke fails as 203/EXEC', () => {
  // The proof that this smoke would have caught the deployment blocker. Staging an
  // installer that does not ship the helper must reproduce the host's failure.
  const withoutHelper = read('install.sh')
    .split('\n')
    .filter((l) => !(/install\s+-m\s+0755/.test(l) && /pw-tmux-keepalive/.test(l)))
    .join('\n');
  assert.notEqual(withoutHelper, read('install.sh'), 'the mutation did not apply');

  const host = stageHost(withoutHelper);
  try {
    const { execFailure } = runStagedExecStart(host);
    assert.match(execFailure ?? '', /203\/EXEC/, 'an installer that ships no keepalive was accepted by this smoke');
  } finally { cleanup(host); }
});

test('the smoke changes nothing outside its staging root', () => {
  const host = stageHost();
  try {
    if (HAVE_TMUX) runStagedExecStart(host);
    assert.equal(fs.existsSync(host.systemctlLog), false,
      `the smoke invoked systemctl: ${fs.existsSync(host.systemctlLog) ? fs.readFileSync(host.systemctlLog, 'utf8') : ''}`);

    // Every destination the staged manifest wrote is inside the staging root.
    for (const item of [...host.staged.helpers, ...host.staged.units]) {
      assert.ok(item.target.startsWith(`${host.stageRoot}/`), `staged outside the temp root: ${item.target}`);
      assert.equal(fs.existsSync(item.target), true, `staging did not produce ${item.dest}`);
    }
    assert.ok(host.staged.units.length >= 8, `expected the unit set to be staged; staged ${host.staged.units.length}`);
    assert.ok(host.staged.helpers.length >= 6, `expected the helper set to be staged; staged ${host.staged.helpers.length}`);
  } finally { cleanup(host); }
});
