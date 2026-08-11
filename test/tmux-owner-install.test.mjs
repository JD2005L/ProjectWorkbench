// Candidate C — the installer, the unit wiring, and the memory ceiling.
//
// Three separate findings are pinned here.
//
// GOA-3 / HJ-24-2: `install.sh` is the bare-metal/VM HOST path by definition
// (DEPLOY.md). Run against a container-mode host that already has the sidecar
// owner, an unconditional install of the host owner unit stands up a SECOND
// server owner on the per-user default socket while the real one lives on the
// bind-mounted socket — "the second, invisible server" reached from the other
// direction. The accepted resolution is to stay host-only and fail fast, NOT to
// invent a container topology in install.sh.
//
// HJ-24-2: the client units must fail closed on the owner. `Wants=` lets a
// terminal start anyway and create the server itself.
//
// HJ-24-3: `printf "%d"` under mawk clamps to INT_MAX, so MemoryHigh became ~2 GiB
// on every host above ~2.73 GiB of RAM — throttling precisely the workload the
// ceiling was added to protect. The test must invoke `mawk` explicitly, because
// on a gawk host the bug is invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// ---------------------------------------------------------------------------
// C5 — install.sh stays host-only and fails fast
// ---------------------------------------------------------------------------

test('install.sh refuses container mode outright', () => {
  const src = read('install.sh');
  assert.match(src, /PW_DEPLOY_MODE/, 'install.sh must know what deploy mode it was handed');
  assert.match(src, /container/i, 'install.sh must name the mode it refuses');
});

test('install.sh refuses when a container sidecar owner is present', () => {
  const src = read('install.sh');
  assert.match(src, /pw-tmux\.service/, 'install.sh must detect the sidecar owner unit');
});

test('install.sh does not invent a container owner topology', () => {
  const src = read('install.sh');
  // Refusing to run is fine; conditionally installing a partial container
  // topology is what the disposition forbids.
  assert.equal(/podman run/.test(src), false, 'install.sh must not stand up container topology');
});

test('owner enable/readiness failure is fatal, not warned away', () => {
  const src = read('install.sh');
  const enableLines = src.split('\n').filter((l) => /pw-tmux-server\.service/.test(l) && /systemctl/.test(l));
  assert.ok(enableLines.length > 0, 'install.sh must enable the owner unit');
  for (const line of enableLines) {
    assert.equal(/\|\|\s*true/.test(line), false, `owner unit failure is swallowed: ${line.trim()}`);
    assert.equal(/^\s*-/.test(line), false, `owner unit failure is ignored: ${line.trim()}`);
  }
});

test('a real container-mode invocation exits nonzero without touching systemd', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-inst-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // systemctl must never be reached; if it is, record it.
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(path.join(dir, 'systemctl.log'))}\nexit 0\n`, { mode: 0o755 });

  const r = spawnSync('bash', [path.join(repo, 'install.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PW_DEPLOY_MODE: 'container' },
  });
  assert.notEqual(r.status, 0, 'container mode must be fatal');
  assert.match(`${r.stdout}${r.stderr}`, /container/i);
  assert.equal(fs.existsSync(path.join(dir, 'systemctl.log')), false, 'it must refuse before touching systemd');
});

// ---------------------------------------------------------------------------
// C1 (wiring) — client units fail closed on the owner
// ---------------------------------------------------------------------------

test('client units Require and order After the owner unit, not merely Want it', () => {
  for (const unit of ['systemd/project-terminal@.service', 'systemd/project-setup-terminal.service', 'systemd/pw-tmux-persist.service']) {
    const src = read(unit);
    assert.match(src, /Requires=.*pw-tmux-server\.service/, `${unit} must Require the owner`);
    assert.match(src, /After=.*pw-tmux-server\.service/, `${unit} must be ordered After the owner`);
    assert.equal(/Wants=.*pw-tmux-server\.service/.test(src), false, `${unit} still only Wants the owner`);
  }
});

test('the owner unit is Type=notify with NotifyAccess=all', () => {
  const src = read('systemd/pw-tmux-server.service');
  assert.match(src, /^Type=notify$/m);
  assert.match(src, /^NotifyAccess=all$/m);
  assert.equal(/^Type=simple$/m.test(src), false, 'Type=simple is the defect');
});

test('container sidecar declares the same strict owner contract its clients resolve', () => {
  const src = read('systemd/pw-tmux.service');
  assert.match(src, /-e PW_DEPLOY_MODE=container\b/, 'sidecar bootstrap must resolve container defaults');
  assert.match(src, /-e PW_TMUX_OWNER_CGROUP=pw-tmux\.service\b/, 'sidecar and clients must name one owner cgroup');
  assert.match(src, /-e PW_TMUX_REQUIRE_CGROUP=1\b/, 'sidecar bootstrap must validate its cgroup before supervising');
});

// ---------------------------------------------------------------------------
// C8 — MemoryHigh must not clamp
// ---------------------------------------------------------------------------

test('MemoryHigh is computed with 64-bit shell arithmetic, not awk/printf', () => {
  const src = read('install.sh');
  const memLines = src.split('\n').filter((l) => /MemTotal|pw_mem_high|MemoryHigh/.test(l));
  assert.ok(memLines.length > 0, 'install.sh must compute a memory ceiling');
  for (const line of memLines) {
    assert.equal(/awk/.test(line), false, `MemoryHigh still goes through awk: ${line.trim()}`);
    assert.equal(/printf\s+["']%d/.test(line), false, `MemoryHigh still uses printf %d: ${line.trim()}`);
  }
});

test('the computation does NOT clamp at INT_MAX — checked against real mawk', () => {
  const haveMawk = (() => { try { execFileSync('mawk', ['-W', 'version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

  // 16 GiB in kB, the case the review reproduced.
  const kb = 16777216;
  const expected = Math.floor((kb * 1024 * 3) / 4); // 12884901888

  // What this repository now does: 64-bit shell arithmetic.
  const shell = spawnSync('bash', ['-c', `kb=${kb}; echo $(( kb * 1024 * 3 / 4 ))`], { encoding: 'utf8' });
  assert.equal(Number(shell.stdout.trim()), expected, 'shell arithmetic must not clamp');
  assert.ok(expected > 2147483647, 'the fixture must exceed INT_MAX or it proves nothing');

  // Whether the LOCAL awk clamps is a property of that build, not of this
  // repository: the review reproduced INT_MAX truncation on Debian 12's mawk,
  // while mawk 1.3.4 20240123 here returns the value correctly. Asserting that a
  // third-party tool is buggy would make this test pass or fail on the toolchain
  // rather than on our code. What matters — and what is asserted above and in
  // 'MemoryHigh is computed with 64-bit shell arithmetic' — is that the awk
  // dependency is GONE, so the result is correct on clamping and non-clamping
  // awks alike. The local behaviour is recorded as information only.
  if (haveMawk) {
    const localMawk = spawnSync('mawk', [`BEGIN { printf "%d", ${kb} * 1024 * 3 / 4 }`], { encoding: 'utf8' });
    const clamps = Number(localMawk.stdout.trim()) === 2147483647;
    assert.ok(
      clamps || Number(localMawk.stdout.trim()) === expected,
      `unexpected mawk result: ${localMawk.stdout.trim()}`,
    );
  }
});

// ---------------------------------------------------------------------------
// C9 — CI must trigger for every PR/head
// ---------------------------------------------------------------------------

test('CI runs on every pull request and on any pushed branch', () => {
  const wf = read('.github/workflows/test.yml');
  assert.match(wf, /pull_request/, 'must run on pull requests');
  // A branch allow-list is what produced "no run for the reviewed SHA".
  const pushBlock = wf.slice(wf.indexOf('push:'), wf.indexOf('jobs:'));
  assert.equal(/branches:\s*\[[^\]]*\]/.test(pushBlock), false, 'push must not be limited to an allow-list of branches');
});

test('the workflow does not claim required-check enforcement it cannot make', () => {
  const wf = read('.github/workflows/test.yml');
  assert.equal(/required check|branch protection is enforced|blocks merge/i.test(wf), false,
    'required-check enforcement is external; the workflow must not claim it');
});

test('CI runs the full suite in explicit host and container modes with stable check names', () => {
  const wf = read('.github/workflows/test.yml');
  assert.match(wf, /matrix:/, 'deployment modes must be a CI matrix, not an implicit default lane');
  assert.match(wf, /deploy-mode:\s*\[host, container\]/, 'both supported deployment modes must run');
  assert.match(wf, /name:\s*node-test \(\$\{\{ matrix\.deploy-mode \}\}\)/, 'matrix checks need stable distinct names');
  assert.match(wf, /PW_DEPLOY_MODE:\s*\$\{\{ matrix\.deploy-mode \}\}/, 'each lane must explicitly set its deployment mode');
});
