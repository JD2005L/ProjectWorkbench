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

import {
  auditThisRepo, execProgramsIn, installedUnits, read,
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
