// DEPLOYMENT BLOCKER — the installer manifest, derived rather than curated.
//
// A controlled host deployment of the exact merged main 6a9e8cd failed at the last
// line of install.sh: `systemctl enable --now pw-tmux-server.service` exited
// 203/EXEC. 203/EXEC is systemd's verdict for "I could not execute the ExecStart
// program" — the file was not there.
//
// The unit's ExecStart named /opt/project-workbench/scripts/pw-tmux-keepalive.sh.
// That path is the CONTAINER layout: the Containerfile COPYs scripts/ to
// /opt/project-workbench/scripts/, and the sidecar unit pw-tmux.service runs from
// there legitimately. On a HOST, install.sh clones the repository to
// $PW_INSTALL_DIR/source and installs helpers into /usr/local/bin — it never
// creates /opt/project-workbench/scripts/, and it never installed the keepalive at
// all. The host owner unit had borrowed a path that exists only in the other
// deployment.
//
// WHY THE EXISTING GUARD DID NOT CATCH IT. tmux-owner-shipping.test.mjs already
// derives a helper manifest — but only from what the seam SCRIPTS invoke by bare
// name (`command -v pw-…`). No check ever read the systemd units, so a helper
// referenced solely by a unit's ExecStart sat outside every derivation. Round 12
// fixed this same class of defect for pw-tmux-assert-owner and deliberately chose a
// derived check over a hand-list so it could not recur; the derivation was simply
// not wide enough to include the unit files.
//
// So the audit is derived from BOTH sources and curates neither:
//   * the units install.sh actually installs, read out of install.sh;
//   * every Exec* directive in those units, parsed from the unit files;
//   * every helper the seams invoke, read out of the seam sources.
// Anything repository-owned that those references reach must be installed by
// install.sh, at that exact destination, with an executable mode.
//
// The mutation tests at the bottom exist because this repository has been burned
// repeatedly by a check that could not fail. They re-run the SAME audit against a
// deliberately broken installer and a deliberately broken unit — including the
// exact 6a9e8cd defect — and require it to report the violation.
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  REPO, auditThisRepo, execProgramsIn, installDefaults, installedUnits, read,
  renderUnit, repoOwnedScripts, seamFiles, seamReferences, stageInstall, unrenderedPlaceholders,
} from './installer-manifest-lib.mjs';

test('DEPLOYMENT BLOCKER: every executable an installed unit or seam references is installed by install.sh', () => {
  const { violations } = auditThisRepo();
  assert.deepEqual(violations, [], `installer manifest is incomplete:\n  - ${violations.join('\n  - ')}`);
});

test('the derivation is not vacuous — it reads real units, real Exec lines and real seams', () => {
  const units = installedUnits(read('install.sh'));

  assert.ok(units.length >= 8, `expected install.sh to install the unit set; found ${units.length}`);
  assert.ok(
    units.some((u) => u.source === 'systemd/pw-tmux-server.service'),
    'the owner unit — the one that failed 203/EXEC — is not in the derived scope',
  );
  // The container sidecar must stay OUT of scope: install.sh refuses to run beside it.
  assert.equal(
    units.some((u) => u.source === 'systemd/pw-tmux.service'), false,
    'the container sidecar unit is not installed by the host installer and must not be scoped to it',
  );

  const execCount = units.reduce((n, u) => n + execProgramsIn(read(u.source)).length, 0);
  assert.ok(execCount >= 6, `expected to parse several Exec* directives; parsed ${execCount}`);

  const { checked } = auditThisRepo();
  assert.ok(checked.length >= 4, `expected the audit to actually check several paths; checked ${checked.length}`);
  assert.ok(
    checked.includes('/usr/local/bin/pw-tmux-keepalive.sh'),
    'the helper whose absence broke the deployment is not among the paths this audit checks',
  );
});

test('the Exec parser survives continuations and systemd prefix characters', () => {
  const programs = execProgramsIn([
    'ExecStartPre=-/usr/bin/podman rm -f pw-tmux',
    'ExecStart=/usr/bin/podman run --name pw-tmux \\',
    '  --rm docker.io/library/alpine',
    'ExecStart=',
    'ExecStop=@!/usr/local/bin/pw-tmux-save',
  ].join('\n'));
  assert.deepEqual(programs.map((p) => p.program), [
    '/usr/bin/podman', '/usr/bin/podman', '/usr/local/bin/pw-tmux-save',
  ]);
});

// ---------------------------------------------------------------------------
// Mutation proofs — the audit must be able to FAIL
// ---------------------------------------------------------------------------

test('MUTATION: dropping the keepalive install line is caught', () => {
  const broken = read('install.sh')
    .split('\n')
    .filter((l) => !(/install\s+-m\s+0755/.test(l) && /pw-tmux-keepalive\.sh/.test(l)))
    .join('\n');
  assert.notEqual(broken, read('install.sh'), 'the mutation did not apply — no keepalive install line to remove');
  const { violations } = auditThisRepo({ installSh: broken });
  assert.ok(
    violations.some((v) => /pw-tmux-keepalive\.sh/.test(v) && /never installs/.test(v)),
    `removing the install line produced no violation naming the helper: ${JSON.stringify(violations)}`,
  );
});

test('MUTATION: the exact 6a9e8cd defect — the host unit pointing at the container path — is caught', () => {
  const { violations } = auditThisRepo({
    unitFor: (rel) => (rel === 'systemd/pw-tmux-server.service'
      ? read(rel).replace(/^ExecStart=.*$/m, 'ExecStart=/opt/project-workbench/scripts/pw-tmux-keepalive.sh')
      : read(rel)),
  });
  assert.ok(
    violations.some((v) => /\/opt\/project-workbench\/scripts\/pw-tmux-keepalive\.sh/.test(v) && /203\/EXEC/.test(v)),
    `the deployment's actual defect was not reported: ${JSON.stringify(violations)}`,
  );
});

test('MUTATION: installing a helper without an executable mode is caught', () => {
  const broken = read('install.sh').replace(
    /install\s+-m\s+0755(\s+"\$SRC_DIR\/scripts\/pw-tmux-keepalive\.sh")/,
    'install -m 0644$1',
  );
  assert.notEqual(broken, read('install.sh'), 'the mutation did not apply — the install line has changed shape');
  const { violations } = auditThisRepo({ installSh: broken });
  assert.ok(
    violations.some((v) => /pw-tmux-keepalive\.sh/.test(v) && /not executable/.test(v)),
    `a non-executable install mode was accepted: ${JSON.stringify(violations)}`,
  );
});

// ---------------------------------------------------------------------------
// Installed units must be RENDERED, so the advertised overrides are truthful
// ---------------------------------------------------------------------------

function stageWith(vars) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-render-')));
  return { root, staged: stageInstall(root, read('install.sh'), vars) };
}

test('no installed unit reaches systemd with an unrendered placeholder', () => {
  const host = stageWith(installDefaults(read('install.sh')));
  try {
    for (const unit of host.staged.units) {
      const left = unrenderedPlaceholders(fs.readFileSync(unit.target, 'utf8'));
      assert.deepEqual(left, [], `${unit.dest} still contains ${left.join(', ')} — systemd would take it literally`);
    }
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('PW_INSTALL_DIR and the account overrides are real, not advertised fiction', () => {
  // A NON-DEFAULT staging. Every unit must follow the override; none may retain a
  // literal from the default install, which is what made the documented
  // PW_INSTALL_DIR knob produce units pointing at a tree nothing populated.
  const vars = { prefix: '/srv/pw-alt', user: 'pwsvc', home: '/var/lib/pwsvc' };
  const host = stageWith(vars);
  try {
    let sawPrefix = 0;
    let sawUser = 0;
    for (const unit of host.staged.units) {
      const text = fs.readFileSync(unit.target, 'utf8');
      // DIRECTIVES only. A comment may legitimately cite the container's
      // /opt/project-workbench layout — recording why the host unit must not use
      // it is exactly the provenance a reviewer needs. What must never survive an
      // override is a value systemd actually acts on.
      const directives = text.split('\n').filter((l) => !l.trim().startsWith('#'));
      for (const line of directives) {
        assert.equal(/\/opt\/project-workbench/.test(line), false,
          `${unit.dest} kept the default prefix despite PW_INSTALL_DIR=${vars.prefix}: ${line.trim()}`);
      }
      for (const line of directives) {
        if (/^\s*(User|Group)=admin\s*$/.test(line)) assert.fail(`${unit.dest} kept the default account: ${line}`);
        if (/^\s*Environment=HOME=\/home\/admin\s*$/.test(line)) assert.fail(`${unit.dest} kept the default home: ${line}`);
      }
      if (text.includes(vars.prefix)) sawPrefix++;
      if (new RegExp(`^\\s*User=${vars.user}\\s*$`, 'm').test(text)) sawUser++;
    }
    assert.ok(sawPrefix >= 1, 'no staged unit picked up the overridden prefix — the render is not reaching them');
    assert.ok(sawUser >= 2, `only ${sawUser} unit(s) picked up the overridden account`);
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('the owner unit is rendered, not copied verbatim', () => {
  const src = read('install.sh');
  const line = src.split('\n').find((l) => /pw-tmux-server\.service/.test(l) && /\/etc\/systemd\/system/.test(l));
  assert.ok(line, 'install.sh no longer installs the owner unit');
  assert.match(line, /^render_unit /, `the owner unit is still copied verbatim, so its account is never substituted: ${line.trim()}`);
  assert.match(src, /grep -qE '@PW_\[A-Z_\]\+@'/, 'install.sh must refuse to install a unit with a surviving placeholder');
});

test("the staging render matches install.sh's OWN render_unit, byte for byte", () => {
  // renderUnit() in the test lib is a reimplementation of install.sh's sed. If the
  // two drift, every render assertion above is checking a fixture instead of the
  // installer — the precise failure mode that hid two blockers already. So run the
  // installer's real function and diff the results.
  const src = read('install.sh');
  const fn = /^render_unit\(\) \{[\s\S]*?^\}/m.exec(src);
  assert.ok(fn, 'install.sh no longer defines render_unit()');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-renderfn-')));
  try {
    const vars = { prefix: '/srv/pw-alt', user: 'pwsvc', home: '/var/lib/pwsvc' };
    const units = installedUnits(src);
    // Every unit in ONE bash, not one bash per unit: this suite runs alongside
    // process-timing assertions elsewhere, and spawn pressure is not free.
    const script = ['set -eu', 'die() { echo "$*" >&2; exit 1; }', fn[0]]
      .concat(units.map((u) => `render_unit ${JSON.stringify(path.join(REPO, u.source))} ${JSON.stringify(path.join(dir, path.basename(u.dest)))}`))
      .join('\n');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        PATH: '/usr/bin:/bin', PW_INSTALL_DIR: vars.prefix,
        PW_USER: vars.user, PW_GROUP: vars.user, PW_HOME: vars.home,
      },
    });
    assert.equal(r.status, 0, `install.sh's render_unit failed: ${r.stderr}`);
    for (const unit of units) {
      assert.equal(
        fs.readFileSync(path.join(dir, path.basename(unit.dest)), 'utf8'),
        renderUnit(read(unit.source), vars),
        `the test lib's renderUnit() has drifted from install.sh's render_unit() on ${unit.source}`,
      );
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh's render_unit refuses a unit with a surviving placeholder", () => {
  const src = read('install.sh');
  const fn = /^render_unit\(\) \{[\s\S]*?^\}/m.exec(src)[0];
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-renderbad-')));
  try {
    const bad = path.join(dir, 'bad.service');
    fs.writeFileSync(bad, '[Service]\nExecStart=@PW_UNKNOWN@/bin/thing\n');
    const r = spawnSync('bash', ['-c', [
      'set -eu', 'die() { echo "$*" >&2; exit 1; }', fn,
      `render_unit ${JSON.stringify(bad)} ${JSON.stringify(path.join(dir, 'out.service'))}`,
    ].join('\n')], {
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: '/usr/bin:/bin', PW_INSTALL_DIR: '/opt/x', PW_USER: 'u', PW_GROUP: 'u', PW_HOME: '/home/u' },
    });
    assert.notEqual(r.status, 0, 'an unrendered placeholder was installed rather than refused');
    assert.match(r.stderr, /placeholder/i);
    assert.equal(fs.existsSync(path.join(dir, 'out.service')), false, 'the bad unit was written anyway');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The seam scan must reach the whole tree
// ---------------------------------------------------------------------------

test('the seam scan is recursive and covers .mjs, not just top-level app/*.js', () => {
  const files = seamFiles();
  assert.ok(files.some((f) => f.startsWith('app/orchestrator/')),
    'the seam scan never descends into app/orchestrator — helpers referenced only there are invisible');
  assert.ok(files.some((f) => f.endsWith('.mjs')), 'the seam scan ignores .mjs seams');
  assert.equal(files.some((f) => f.includes('node_modules')), false, 'the seam scan wandered into node_modules');

  // Non-vacuity: the widened scan must actually observe a reference the old flat
  // scan could not see. app/orchestrator/config.js names /usr/local/bin/claude.
  const refs = seamReferences();
  assert.ok(refs.has('claude'), 'the widened scan found no /usr/local reference in a subdirectory');
  assert.ok([...refs.get('claude')].some((f) => f.startsWith('app/orchestrator/')),
    'the claude reference was not attributed to the orchestrator subtree');
});

test('every repo-owned executable the widened scan reaches is covered by the audit', () => {
  // The widened scan must not merely run — it must be shown to leave nothing
  // repository-owned unchecked.
  const owned = repoOwnedScripts();
  const referenced = [...seamReferences().keys()].filter((n) => owned.has(n));
  assert.ok(referenced.length > 0, 'the scan found no repository-owned helper at all');

  const { checked, violations } = auditThisRepo();
  assert.deepEqual(violations, [], `widened scan surfaced uncovered references:\n  - ${violations.join('\n  - ')}`);
  for (const name of referenced) {
    assert.ok(checked.some((p) => p.endsWith(`/${name}`)),
      `${name} is referenced by a seam but never checked by the audit`);
  }
});

test('MUTATION: a seam-invoked helper that install.sh drops is still caught', () => {
  const broken = read('install.sh')
    .split('\n')
    .filter((l) => !(/install\s+-m\s+0755/.test(l) && /pw-tmux-assert-owner/.test(l)))
    .join('\n');
  assert.notEqual(broken, read('install.sh'), 'the mutation did not apply');
  const { violations } = auditThisRepo({ installSh: broken });
  assert.ok(
    violations.some((v) => /pw-tmux-assert-owner/.test(v)),
    `the Round 12 blocker would no longer be caught: ${JSON.stringify(violations)}`,
  );
});
