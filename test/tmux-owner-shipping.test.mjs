// Candidate C — the two things a real host proved were missing.
//
// BLOCKER 1. Every seam now refuses unless `pw-tmux-assert-owner` is on PATH,
// and install.sh never shipped it. On a real host `command -v` finds nothing and
// every project/setup terminal and the persist/restore path refuse. The test
// fixtures supplied a temporary helper, which is exactly what hid this — so the
// manifest check below is derived FROM THE SEAMS rather than hand-listed, so a
// helper that a seam starts depending on cannot be forgotten again.
//
// BLOCKER 2. The JS gate accepted a marker-only/foreign-cgroup server unless
// PW_TMUX_REQUIRE_CGROUP=1 — which only the owner unit sets. The dashboard and
// every other JS seam therefore ran fail-open relative to the shell gate, which
// refuses that state unconditionally. Ownership is one contract; it does not get
// to be weaker on the side that runs as root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTmuxOwner } from '../app/tmux-owner-gate.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// ---------------------------------------------------------------------------
// BLOCKER 1 — everything a seam invokes must actually be shipped
// ---------------------------------------------------------------------------

// The files a seam can exec by bare name at runtime.
const SEAM_FILES = [
  'scripts/project-terminal-start',
  'scripts/setup-terminal-start',
  'scripts/pw-tmux-restore',
  'scripts/pw-tmux-keepalive.sh',
];

function helpersReferencedBySeams() {
  const found = new Set();
  for (const seam of SEAM_FILES) {
    for (const m of read(seam).matchAll(/\bpw-tmux-assert-owner\b/g)) found.add('pw-tmux-assert-owner');
    // Any other bare `pw-*` helper a seam shells out to.
    for (const m of read(seam).matchAll(/command -v (pw-[a-z-]+)/g)) found.add(m[1]);
  }
  return [...found];
}

test('every helper a seam invokes by name lands on $PATH', () => {
  const install = read('install.sh');
  const referenced = helpersReferencedBySeams();
  assert.ok(referenced.length > 0, 'expected the seams to reference at least one helper');
  for (const helper of referenced) {
    // What a seam needs is /usr/local/bin/<helper> to EXIST. Whether install.sh
    // gets it there with `install` or with a symlink is not the seam's concern —
    // and demanding a direct copy here is what forced the ownership gate into
    // /usr/local/bin, where its relative import cannot resolve.
    const direct = new RegExp(`install -m 0755 [^\\n]*scripts/${helper}[^\\n]*/usr/local/bin/${helper}`).test(install);
    const linked = new RegExp(`ln -sfn [^\\n]*${helper}[^\\n]*/usr/local/bin/${helper}`).test(install);
    assert.ok(direct || linked,
      `install.sh never puts ${helper} on $PATH, so every seam that calls it refuses on a real host`);
  }
});

test('the ownership helper is installed where its relative import resolves', () => {
  const install = read('install.sh');
  // THE DEFECT THIS PINS. The helper imports `../app/tmux-owner.js` relative to
  // itself, so a flat copy into /usr/local/bin resolves to /usr/local/app/ — a
  // path no deployment has. It then exits nonzero with ERR_MODULE_NOT_FOUND on
  // every invocation, and because a missing helper is a refusal rather than a
  // skip, every seam refuses: no terminal starts and restore never runs.
  assert.match(
    install,
    /install -m 0755 "\$SRC_DIR\/scripts\/pw-tmux-assert-owner"\s+"\$PW_INSTALL_DIR\/scripts\/pw-tmux-assert-owner"/,
    'the gate must be installed beside app/, not flat into /usr/local/bin',
  );
  assert.match(
    install,
    /ln -sfn "\$PW_INSTALL_DIR\/scripts\/pw-tmux-assert-owner"\s+\/usr\/local\/bin\/pw-tmux-assert-owner/,
    'the gate must still be reachable on $PATH',
  );
  // The import that layout exists to satisfy.
  assert.match(read('scripts/pw-tmux-assert-owner'), /from '\.\.\/app\/tmux-owner\.js'/);

  // And it must be executable in the repository too, or the install copies a
  // non-executable file into place.
  const mode = fs.statSync(path.join(repo, 'scripts/pw-tmux-assert-owner')).mode & 0o777;
  assert.equal(mode & 0o111, 0o111, `scripts/pw-tmux-assert-owner is not executable (mode ${mode.toString(8)})`);
});

test('every script install.sh ships actually exists in the repository', () => {
  const install = read('install.sh');
  for (const m of install.matchAll(/install -m 0755 "\$SRC_DIR\/(scripts\/[A-Za-z0-9._-]+)"/g)) {
    assert.equal(fs.existsSync(path.join(repo, m[1])), true, `install.sh ships ${m[1]}, which does not exist`);
  }
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — the JS gate must require the FULL verdict, in shipped config
// ---------------------------------------------------------------------------

// A controlled /proc placing the server in a FOREIGN cgroup — the adopt-don't-move
// state: our marker is present, the cgroup is a terminal's.
function foreignCgroupProc(dir, pid) {
  const root = path.join(dir, 'proc');
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'cgroup'), '0::/system.slice/project-terminal@demo.service\n');
  return root;
}

function captureFor({ pid, marker }) {
  return async (_env, argv) => {
    if (argv.includes('#{pid}')) return String(pid);
    if (argv.includes('@pw_owner')) return marker;
    return null;
  };
}

test('SHIPPED CONFIG: the JS gate refuses a marker-only, foreign-cgroup server', async () => {
  const dir = fs.mkdtempSync('/tmp/pwship-');
  const procRoot = foreignCgroupProc(dir, 4242);
  // Deliberately NO PW_TMUX_REQUIRE_CGROUP: this is the environment the dashboard
  // and every non-owner JS seam actually run with.
  const env = { PW_TMUX_PROC_ROOT: procRoot };
  await assert.rejects(
    assertTmuxOwner({ env, capture: captureFor({ pid: 4242, marker: 'pw-owner' }) }),
    /cgroup/i,
    'the JS gate accepted a foreign-cgroup server in shipped configuration',
  );
});

test('SHIPPED CONFIG: no environment flag can make the JS gate accept a foreign cgroup', async () => {
  const dir = fs.mkdtempSync('/tmp/pwship-');
  const procRoot = foreignCgroupProc(dir, 4243);
  for (const extra of [{}, { PW_TMUX_REQUIRE_CGROUP: '0' }, { PW_TMUX_REQUIRE_CGROUP: '' }]) {
    await assert.rejects(
      assertTmuxOwner({ env: { PW_TMUX_PROC_ROOT: procRoot, ...extra }, capture: captureFor({ pid: 4243, marker: 'pw-owner' }) }),
      /cgroup/i,
      `a foreign cgroup was accepted with ${JSON.stringify(extra)}`,
    );
  }
});

test('SHIPPED CONFIG: the JS gate still accepts a genuinely owned server', async () => {
  const dir = fs.mkdtempSync('/tmp/pwship-');
  const root = path.join(dir, 'proc');
  fs.mkdirSync(path.join(root, '4244'), { recursive: true });
  fs.writeFileSync(path.join(root, '4244', 'cgroup'), '0::/system.slice/pw-tmux-server.service\n');
  const verdict = await assertTmuxOwner({
    env: { PW_TMUX_PROC_ROOT: root },
    capture: captureFor({ pid: 4244, marker: 'pw-owner' }),
  });
  assert.equal(verdict.owned, true);
});

test('the JS gate has no fail-open conditional left in it', () => {
  const src = read('app/tmux-owner-gate.js');
  const code = src.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); }).join('\n');
  assert.equal(/!requireCgroup|requireCgroup\s*\?/.test(code), false,
    'the gate still has a conditional that can accept an unowned server');
  assert.match(code, /verdict\.owned/, 'the gate must require the full owned verdict');
});

test('the JS gate and the shell gate agree on the same verdict function', () => {
  // One contract: both sides must reach it through assessOwnership rather than
  // re-deciding locally.
  assert.match(read('app/tmux-owner-gate.js'), /assessOwnership/);
  assert.match(read('scripts/pw-tmux-assert-owner'), /assessOwnership/);
});
