// The apt step must not abort a clean reinstall on an already-provisioned host.
//
// install.sh used to name `nodejs npm` unconditionally. On any NodeSource host that
// aborts the WHOLE apt transaction:
//
//   Depends: node-npm-bundled but it is not going to be installed
//   … Depends: nodejs:any
//   E: Unable to correct problems, you have held broken packages.   (exit 100)
//
// NodeSource's `nodejs` package OWNS /usr/bin/npm, so Debian's separate `npm` is
// redundant there and cannot be co-installed — it depends on a chain of `node-*`
// packages plus `nodejs:any`. Because apt resolves a request as a whole, that single
// unsatisfiable token also stopped nginx, ttyd, tmux and everything else from being
// installed: a clean reinstall could not complete at all. The installer's own error
// message recommends NodeSource, so it was contradicting itself.
//
// These tests run the REAL install.sh against a curated PATH, so node/npm presence is
// controlled rather than inherited from whatever machine runs the suite.
//
// NOTHING IS INSTALLED AND NOTHING ON THE HOST IS TOUCHED. The `apt-get` stub records
// the requested package list and then exits nonzero, so `set -e` aborts install.sh at
// that exact line — before it creates users, directories or clones anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// Real tools install.sh reaches before the apt step. Curated rather than inheriting
// /usr/bin, because "npm is absent" cannot be expressed on a PATH that has the real one.
// `bash` is included deliberately: the stubs' `#!/usr/bin/env bash` shebang resolves
// bash through this same PATH, so omitting it makes every stub fail to launch.
const REAL_TOOLS = ['bash', 'sed', 'grep', 'cat', 'dirname', 'basename'];

function which(name) {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

/**
 * A sandbox host shape.
 *   node   — version string to report, or null for "no node on this host"
 *   npm    — true if the npm COMMAND exists (on NodeSource it ships with nodejs)
 *   source — 'nodesource' | 'debian' | null, what dpkg-query reports for nodejs
 */
function sandbox({ node = null, npm = false, source = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-apt-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const w = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

  for (const t of REAL_TOOLS) {
    const p = which(t);
    if (p) fs.symlinkSync(p, path.join(bin, t));
  }

  // Root, without being root.
  w('id', 'if [ "$1" = "-u" ]; then echo 0; else echo "uid=0(root)"; fi');

  if (node) w('node', `[ "$1" = "--version" ] && echo "v${node}" || exit 0`);
  if (npm) w('npm', 'echo 10.9.8');
  w('dpkg-query', source === 'nodesource'
    ? 'echo "22.23.2-1nodesource1"'
    : (source === 'debian' ? 'echo "18.19.0+dfsg-6~deb12u1"' : 'exit 1'));

  const aptLog = path.join(dir, 'apt.args');
  // Record the install request, then abort install.sh before it can touch anything.
  w('apt-get', `if [ "$1" = "update" ]; then exit 0; fi\nprintf '%s\\n' "$*" > ${JSON.stringify(aptLog)}\nexit 42`);

  return { dir, bin, aptLog };
}

function runInstaller(sb) {
  const r = spawnSync(which('bash'), [path.join(repo, 'install.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: sb.bin, HOME: sb.dir, PW_INSTALL_DIR: path.join(sb.dir, 'opt') },
  });
  const requested = fs.existsSync(sb.aptLog) ? fs.readFileSync(sb.aptLog, 'utf8').trim().split(/\s+/) : null;
  return { r, requested, out: `${r.stdout}${r.stderr}` };
}

const BASE = ['nginx', 'apache2-utils', 'ttyd', 'git', 'curl', 'ca-certificates', 'jq', 'tmux', 'sudo', 'openssl'];

test('REGRESSION: a provisioned NodeSource host no longer asks apt for npm', () => {
  // Exactly PVI2: NodeSource node 22, npm supplied by that same package.
  const sb = sandbox({ node: '22.23.2', npm: true, source: 'nodesource' });
  try {
    const { requested } = runInstaller(sb);
    assert.ok(requested, 'the apt step was never reached');
    assert.equal(requested.includes('npm'), false,
      `npm was requested from apt on a NodeSource host — this is the exit-100 abort: ${requested.join(' ')}`);
    assert.equal(requested.includes('nodejs'), false,
      `nodejs was requested although a usable one is installed: ${requested.join(' ')}`);
    // …and the packages that actually matter are still all requested.
    for (const p of BASE) assert.ok(requested.includes(p), `${p} is no longer installed by the apt step`);
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('a bare host still gets nodejs AND npm from apt', () => {
  // The behavior that must not regress: with nothing installed, apt is still the
  // thing that provides the runtime.
  const sb = sandbox({ node: null, npm: false, source: null });
  try {
    const { requested } = runInstaller(sb);
    assert.ok(requested, 'the apt step was never reached');
    assert.ok(requested.includes('nodejs'), `a bare host must install nodejs: ${requested.join(' ')}`);
    assert.ok(requested.includes('npm'), `a bare host must install npm: ${requested.join(' ')}`);
    for (const p of BASE) assert.ok(requested.includes(p), `${p} missing from a bare-host install`);
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('a Debian host with node but no npm asks only for npm', () => {
  const sb = sandbox({ node: '20.11.0', npm: false, source: 'debian' });
  try {
    const { requested } = runInstaller(sb);
    assert.ok(requested, 'the apt step was never reached');
    assert.ok(requested.includes('npm'), `npm is missing and must be requested: ${requested.join(' ')}`);
    assert.equal(requested.includes('nodejs'), false,
      `node is already usable, so nodejs must not be requested: ${requested.join(' ')}`);
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('an OLD NodeSource runtime fails with an actionable message, not an apt solver wall', () => {
  // apt genuinely cannot repair this: Debian's nodejs/npm conflict with the
  // NodeSource package. Saying so beats exit 100 and a page of Depends: lines.
  const sb = sandbox({ node: '16.20.2', npm: true, source: 'nodesource' });
  try {
    const { r, requested, out } = runInstaller(sb);
    assert.notEqual(r.status, 0, 'an unusable runtime must be fatal');
    assert.match(out, /NodeSource/, 'the diagnosis must name NodeSource as the reason apt cannot fix it');
    assert.match(out, /Node\.js 18\+ is required/);
    assert.equal(requested, null, 'it must refuse BEFORE running apt, not after a failed transaction');
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('an old DEBIAN runtime still goes through apt, which can upgrade it', () => {
  // The mirror image: no NodeSource involved, so apt is allowed to try.
  const sb = sandbox({ node: '16.20.2', npm: true, source: 'debian' });
  try {
    const { requested } = runInstaller(sb);
    assert.ok(requested, 'apt must still be attempted for a Debian-provided runtime');
    assert.ok(requested.includes('nodejs'), `an old Debian node must be upgraded via apt: ${requested.join(' ')}`);
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});

test('the apt request is a single transaction containing no empty arguments', () => {
  // An unquoted array expansion that produced an empty token would make apt fail in
  // a way that looks exactly like the bug being fixed.
  const sb = sandbox({ node: '22.23.2', npm: true, source: 'nodesource' });
  try {
    const { requested } = runInstaller(sb);
    assert.ok(requested.every((a) => a.length > 0), `empty argument in the apt request: ${JSON.stringify(requested)}`);
    assert.ok(requested.includes('-y') && requested.includes('--no-install-recommends'),
      `the apt flags were lost: ${requested.join(' ')}`);
  } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
});
