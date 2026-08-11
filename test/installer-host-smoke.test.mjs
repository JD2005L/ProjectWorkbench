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
  execProgramsIn, installedUnits, read, REPO, stageInstall, unitEnvironment,
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
function stageHost(installSh = read('install.sh'), vars = null) {
  const stageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-stage-')));
  const sockRoot = fs.mkdtempSync('/tmp/pwh-');
  fs.chmodSync(sockRoot, 0o700);

  const bin = path.join(stageRoot, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const systemctlLog = path.join(stageRoot, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(systemctlLog)}\nexit 0\n`, { mode: 0o755 });
  const readyFlag = path.join(stageRoot, 'ready');
  fs.writeFileSync(path.join(bin, 'systemd-notify'), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "--ready" ] && printf '%s\\n' "$*" > ${JSON.stringify(readyFlag)}; done\nexit 0\n`, { mode: 0o755 });

  const staged = stageInstall(stageRoot, installSh, vars);
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
 * PW_TMUX_REQUIRE_CGROUP normally comes from the unit. Two bootstrap-only calls
 * below override it just long enough to learn the private test server PID; the
 * strict positive and negative controlled-/proc proofs then use the unit value.
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
function procRootFor(host, pid, cgroup, { v1 = false } = {}) {
  const root = path.join(host.stageRoot, `proc-${pid}-${v1 ? 'v1' : 'v2'}`);
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  const body = v1
    ? `12:pids:/system.slice/${cgroup}\n11:memory:/system.slice/${cgroup}\n`
    : `0::/system.slice/${cgroup}\n`;
  fs.writeFileSync(path.join(root, String(pid), 'cgroup'), body);
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
    // This smoke proves the staged executable/readiness path. The separate test
    // below supplies controlled /proc and proves the unit's strict cgroup gate.
    // A first start cannot know the tmux PID needed to construct that fixture.
    const { r, execFailure, unitDest } = runStagedExecStart(host, {
      extraEnv: { PW_TMUX_REQUIRE_CGROUP: '0' },
    });
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
    // Bootstrap only far enough to learn the private server PID. The next run
    // restores the shipped strict setting and validates it against controlled
    // /proc; the negative control then proves the gate can reject.
    assert.equal(runStagedExecStart(host, {
      extraEnv: { PW_TMUX_REQUIRE_CGROUP: '0' },
    }).r.status, 0, 'first start failed');
    const pid = serverPid(host);
    assert.match(pid, /^\d+$/, 'no live tmux server to interrogate');

    const expected = unitEnvironment(read(OWNER_UNIT)).PW_TMUX_REQUIRE_CGROUP;
    assert.equal(expected, '1', 'the owner unit no longer requires a cgroup match — this test is checking nothing');

    const ok = runStagedExecStart(host, { procRoot: procRootFor(host, pid, 'pw-tmux-server.service') });
    assert.equal(ok.r.status, 0, `the owner refused its own cgroup:\n${ok.r.stdout}${ok.r.stderr}`);

    const v1 = runStagedExecStart(host, {
      procRoot: procRootFor(host, pid, 'pw-tmux-server.service', { v1: true }),
    });
    assert.equal(v1.r.status, 0, `the owner refused its own cgroup-v1 path:\n${v1.r.stdout}${v1.r.stderr}`);

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

// ---------------------------------------------------------------------------
// The ownership gate must RUN from where install.sh puts it
// ---------------------------------------------------------------------------
//
// Shipping a helper and shipping a WORKING helper are different claims, and only
// the first one was ever checked. pw-tmux-assert-owner is an ES module importing
// `../app/tmux-owner.js` relative to itself; installed flat into /usr/local/bin
// that resolved to /usr/local/app/, so it exited nonzero with ERR_MODULE_NOT_FOUND
// on every invocation while the manifest audit — which asks only "was a file
// installed at this path, executable?" — stayed green.
//
// The seams treat "cannot execute the helper" as fatal, so that is a total
// host-mode outage: no project or setup terminal starts, and pw-tmux-restore
// refuses, so sessions are never restored at boot.

/** Where a seam finds the gate: the /usr/local/bin entry, however it was created. */
function stagedGateOnPath(host) {
  const onPath = path.join(host.stageRoot, '/usr/local/bin/pw-tmux-assert-owner');
  assert.ok(fs.existsSync(onPath), 'the staged install has no /usr/local/bin/pw-tmux-assert-owner');
  return onPath;
}

/**
 * A PATH carrying node and NOTHING else.
 *
 * The helper's shebang is `#!/usr/bin/env node`, so node has to be resolvable or
 * the test measures the shebang rather than the import. tmux is deliberately still
 * absent, which pins the verdict to "no server on the target socket" — a refusal
 * the GATE produces. Pointing PATH at node's real directory would drag /usr/bin —
 * and tmux — in with it, so it gets a directory of its own.
 */
function nodeOnlyBin(host) {
  const dir = path.join(host.stageRoot, 'node-only-bin');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  }
  return dir;
}

/**
 * Run it as a seam would — executing the file, shebang and all. The failure that
 * matters is the module loader's, not the gate's: a gate refusal is the CORRECT
 * outcome here and is what the assertions look for.
 */
function runStagedGate(host, gatePath) {
  return spawnSync(gatePath, [], {
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: nodeOnlyBin(host), PW_DEPLOY_MODE: 'host', HOME: host.stageRoot },
  });
}

test('the staged ownership gate resolves its import and reaches a real verdict', () => {
  const host = stageHost();
  try {
    const r = runStagedGate(host, stagedGateOnPath(host));
    assert.doesNotMatch(
      String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'the staged gate could not load app/tmux-owner.js from where install.sh put it',
    );
    assert.match(
      String(r.stderr), /pw-tmux-assert-owner: refusing to use this tmux server/,
      'the gate must fail AS THE GATE, with an actionable verdict',
    );
    assert.notEqual(r.status, 0, 'no server means refuse');
  } finally { cleanup(host); }
});

test('NEGATIVE CONTROL: the flat /usr/local/bin copy still cannot resolve', () => {
  // Reproduces the shipped defect against the same staged app/ tree, so the test
  // above cannot pass vacuously — if this ever stops failing, the layout is no
  // longer what is protecting us and the assertion above proves nothing.
  const host = stageHost();
  try {
    const flat = path.join(host.stageRoot, '/usr/local/bin/pw-tmux-assert-owner-flatcopy');
    fs.rmSync(flat, { force: true });
    // From the REPOSITORY, not the staged tree, so the control is independent of
    // whatever layout install.sh currently uses and keeps meaning under mutation.
    fs.copyFileSync(path.join(REPO, 'scripts/pw-tmux-assert-owner'), flat);
    fs.chmodSync(flat, 0o755);

    const r = runStagedGate(host, flat);
    assert.match(
      String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'a flat /usr/local/bin copy resolved — the layout fix is no longer what protects this',
    );
    assert.doesNotMatch(String(r.stderr), /refusing to use this tmux server/);
  } finally { cleanup(host); }
});

test('the gate on $PATH points at the copy that sits beside app/', () => {
  const host = stageHost();
  try {
    const onPath = stagedGateOnPath(host);
    const beside = path.join(host.stageRoot, host.staged.vars.prefix, 'scripts/pw-tmux-assert-owner');
    assert.equal(fs.realpathSync(onPath), fs.realpathSync(beside),
      'the PATH entry must resolve to the copy one level below app/');
    // …and app/ really is one level up from it, which is what makes `../app/` work.
    assert.equal(
      fs.existsSync(path.join(path.dirname(beside), '../app/tmux-owner.js')), true,
      'app/tmux-owner.js is not one level up from the installed gate',
    );
  } finally { cleanup(host); }
});

/** node AND tmux, and nothing else — the gate needs both to reach a real verdict. */
function gateBin(host) {
  const dir = path.join(host.stageRoot, 'gate-bin');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    fs.symlinkSync(execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim(), path.join(dir, 'tmux'));
  }
  return dir;
}

/** A private tmux server, on a private socket name under the private socket root. */
function privateServer(host, socketName) {
  const env = { PATH: gateBin(host), HOME: host.stageRoot, TMUX_TMPDIR: host.sockRoot, LANG: 'C.UTF-8' };
  spawnSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', 'probe'], { env, timeout: 15000 });
  const pid = spawnSync('tmux', ['-L', socketName, 'display-message', '-p', '#{pid}'],
    { env, encoding: 'utf8', timeout: 10000 }).stdout.trim();
  return { env, pid };
}

/** Run the INSTALLED /usr/local/bin entrypoint against a private server + controlled /proc. */
function runGateAgainst(host, { socketName, procRoot, env }) {
  return spawnSync(path.join(host.stageRoot, '/usr/local/bin/pw-tmux-assert-owner'), [], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...env, PW_DEPLOY_MODE: 'host', PW_TMUX_SOCKET: socketName, PW_TMUX_PROC_ROOT: procRoot },
  });
}

needTmux('the installed entrypoint reaches the REAL metadata verdict, not a loader error', () => {
  const host = stageHost();
  const socketName = 'pwgate1';
  try {
    const { env, pid } = privateServer(host, socketName);
    assert.match(pid, /^\d+$/, 'the private tmux server did not start');
    // Controlled /proc, per the Round 8 rule that a same-cgroup comparison on a
    // shared runner proves nothing. The live server is never consulted.
    const procRoot = procRootFor(host, pid, 'pw-tmux-server.service');

    // Marker absent: the verdict must be the metadata one, naming the pid.
    let r = runGateAgainst(host, { socketName, procRoot, env });
    assert.doesNotMatch(String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(String(r.stderr), new RegExp(`tmux server \\(pid ${pid}\\) is in the expected cgroup but carries no owner marker`),
      `expected the marker verdict about pid ${pid}, got: ${r.stderr}`);
    assert.notEqual(r.status, 0);

    // Marker present AND cgroup right: the installed entrypoint must accept.
    spawnSync('tmux', ['-L', socketName, 'set-option', '-s', '@pw_owner', 'pw-owner'], { env, timeout: 10000 });
    r = runGateAgainst(host, { socketName, procRoot, env });
    assert.equal(r.status, 0, `the installed gate refused a genuinely owned server: ${r.stderr}`);
    assert.match(String(r.stdout), new RegExp(`tmux owner ok: pid ${pid} in pw-tmux-server.service`));

    // Foreign cgroup, marker present: still fail-closed, through the same entrypoint.
    r = runGateAgainst(host, { socketName, procRoot: procRootFor(host, pid, 'project-terminal@demo.service'), env });
    assert.notEqual(r.status, 0, 'the installed gate accepted a foreign cgroup');
    assert.match(String(r.stderr), /cgroup/i);
  } finally {
    spawnSync('tmux', ['-L', socketName, 'kill-server'],
      { env: { PATH: gateBin(host), HOME: host.stageRoot, TMUX_TMPDIR: host.sockRoot }, timeout: 10000 });
    cleanup(host);
  }
});

test('MUTATION: a direct copy into /usr/local/bin is caught by the staged smoke', () => {
  // The audit next door is a source-level check and cannot see this: a flat copy
  // IS installed, and IS executable. Only executing the staged entrypoint tells
  // the two layouts apart, so the guard is pinned here.
  const mutated = read('install.sh')
    .replace(/install -d -m 0755 "\$PW_INSTALL_DIR\/scripts"\n/, '')
    .replace(/install -m 0755 "\$SRC_DIR\/scripts\/pw-tmux-assert-owner"\s+"\$PW_INSTALL_DIR\/scripts\/pw-tmux-assert-owner"/,
      'install -m 0755 "$SRC_DIR/scripts/pw-tmux-assert-owner"   /usr/local/bin/pw-tmux-assert-owner')
    .replace(/ln -sfn "\$PW_INSTALL_DIR\/scripts\/pw-tmux-assert-owner"\s+\/usr\/local\/bin\/pw-tmux-assert-owner\n/, '');
  assert.notEqual(mutated, read('install.sh'), 'the mutation did not apply');

  const host = stageHost(mutated);
  try {
    const r = runStagedGate(host, stagedGateOnPath(host));
    assert.match(String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'a direct /usr/local/bin copy went undetected — this smoke no longer protects the layout');
  } finally { cleanup(host); }
});

test('PORTABLE: a non-default PW_INSTALL_DIR still yields a resolvable gate', () => {
  // The advertised override must produce a working install, not one whose gate
  // points into a tree nothing populated.
  const vars = { prefix: '/srv/pw-alt', user: 'admin', home: '/home/admin' };
  const host = stageHost(read('install.sh'), vars);
  try {
    const onPath = stagedGateOnPath(host);
    const beside = path.join(host.stageRoot, vars.prefix, 'scripts/pw-tmux-assert-owner');
    assert.equal(fs.existsSync(beside), true, 'the gate was not installed under the overridden prefix');
    assert.equal(fs.realpathSync(onPath), fs.realpathSync(beside),
      'the PATH entry does not follow the overridden prefix');

    const r = runStagedGate(host, onPath);
    assert.doesNotMatch(String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'the gate cannot resolve its import under a non-default PW_INSTALL_DIR');
    assert.match(String(r.stderr), /pw-tmux-assert-owner: refusing to use this tmux server/);
  } finally { cleanup(host); }
});

test('the gate on $PATH resolves into the root-controlled install tree', () => {
  const host = stageHost();
  try {
    const target = fs.realpathSync(stagedGateOnPath(host));
    const prefixRoot = fs.realpathSync(path.join(host.stageRoot, host.staged.vars.prefix));
    assert.ok(target.startsWith(`${prefixRoot}/`),
      `the PATH entry resolves outside the install tree: ${target}`);
    // Module closure: what it imports is present in that same tree.
    assert.equal(fs.existsSync(path.join(path.dirname(target), '../app/tmux-owner.js')), true,
      'the installed gate has no app/tmux-owner.js one level up — its import closure is incomplete');
  } finally { cleanup(host); }
});

// ---------------------------------------------------------------------------
// What actually makes the symlink layout work: realpath resolution of the main
// ---------------------------------------------------------------------------
//
// The /usr/local/bin entry is a symlink into $PW_INSTALL_DIR/scripts. That only
// resolves `../app/tmux-owner.js` because node resolves an ES main module against
// its REALPATH. That behavior is load-bearing and is not universal — node exposes
// `--preserve-symlinks-main`, which resolves against the LINK path instead and puts
// the import back at /usr/local/app.
//
// So it is pinned from both sides: the default must work, and the flag that turns
// the behavior off must break it. If the mutation ever stops failing, the guarantee
// has moved and this layout needs re-examining rather than quiet trust.

needTmux('the symlinked entrypoint resolves through realpath, and that is what carries it', () => {
  const host = stageHost();
  const socketName = 'pwgate2';
  try {
    const { env, pid } = privateServer(host, socketName);
    const procRoot = procRootFor(host, pid, 'pw-tmux-server.service');
    spawnSync('tmux', ['-L', socketName, 'set-option', '-s', '@pw_owner', 'pw-owner'], { env, timeout: 10000 });

    // Default resolution: reaches the real verdict through the link.
    const ok = runGateAgainst(host, { socketName, procRoot, env });
    assert.equal(ok.status, 0, `default resolution failed through the symlink: ${ok.stderr}`);

    // MUTATION: resolve the main against the LINK path instead of its realpath.
    const broken = runGateAgainst(host, {
      socketName, procRoot, env: { ...env, NODE_OPTIONS: '--preserve-symlinks-main' },
    });
    assert.match(
      String(broken.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'link-path resolution no longer breaks the import — realpath is not what is protecting this layout any more',
    );
  } finally {
    spawnSync('tmux', ['-L', socketName, 'kill-server'],
      { env: { PATH: gateBin(host), HOME: host.stageRoot, TMUX_TMPDIR: host.sockRoot }, timeout: 10000 });
    cleanup(host);
  }
});
