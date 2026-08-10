// The installer aborts partway through when it references an undefined variable.
//
// Regression: install.sh runs under `set -euo pipefail`, and the block that
// copies bin/ (the stdio MCP adapter documented in docs/orchestrator-api.md)
// used $INSTALL_DIR — a name that is never assigned anywhere. Under `set -u`
// that is a fatal error, so any install whose source tree contains bin/ died
// after copying the app but before configuring anything. Only PW_INSTALL_DIR
// exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const installShPath = fileURLToPath(new URL('../install.sh', import.meta.url));
const src = fs.readFileSync(installShPath, 'utf8');

test('install.sh is syntactically valid', async () => {
  await execFileAsync('bash', ['-n', installShPath]);
});

test('install.sh still runs under set -u, which is what makes this fatal', () => {
  assert.match(src, /^set -euo pipefail$/m);
});

test('REGRESSION: no undefined *INSTALL_DIR variable is referenced', () => {
  const referenced = [...src.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]);
  const offenders = [...new Set(referenced.filter((n) => n.endsWith('INSTALL_DIR') && n !== 'PW_INSTALL_DIR'))];
  assert.deepEqual(offenders, [], `install.sh references undefined variable(s): ${offenders.join(', ')}`);
});

test('every variable the installer expands is assigned or is a documented input', () => {
  const assigned = new Set([...src.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]));
  // Shell builtins / positional-ish names that are always defined.
  const builtin = new Set(['0', '1', '2', '@', '*', '#', '?', '$', 'HOME', 'PATH', 'USER', 'PWD', 'SHELL', 'UID', 'EUID', 'RANDOM', 'LINENO', 'BASH_SOURCE', 'FUNCNAME', 'IFS', 'PS1', 'LANG', 'LC_ALL', 'TERM', 'SUDO_USER']);
  const referenced = [...new Set([...src.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]))];
  const unresolved = referenced.filter((n) => !assigned.has(n) && !builtin.has(n) && n.startsWith('PW_') === false && n.endsWith('_DIR'));
  assert.deepEqual(unresolved, [], `unassigned *_DIR variables: ${unresolved.join(', ')}`);
});

test('the bin/ copy targets PW_INSTALL_DIR', () => {
  const block = src.match(/if \[ -d "\$SRC_DIR\/bin" \];[\s\S]*?\nfi/);
  assert.ok(block, 'the bin/ copy block should still exist');
  assert.ok(block[0].includes('"$PW_INSTALL_DIR/bin"'));
  assert.ok(!/\$\{?INSTALL_DIR/.test(block[0]));
});

// --- GOA-3 / HJ-24-2: the installer is deploy-mode gated and does not fail open ---------------
//
// install.sh is host-mode-only by construction — it installs the per-project systemd terminal units
// and has never installed systemd/pw-tmux.service, the container-mode owner. PR #24 added an
// unconditional `install` + `systemctl enable --now pw-tmux-server.service`, which on a
// container-mode host stands up a SECOND server owner on the per-user default socket while the real
// one lives on the sidecar's bind-mounted TMUX_TMPDIR: the "second, invisible server" the keepalive's
// own comment warns about, reached from the other direction.
//
// Asserted on the source rather than by running it, because the script installs system units and
// enables services; the behaviour it gates is covered by real processes in test/pw-tmux-server.test.mjs.

/** The installer with comment-only lines removed, so an explanation is never mistaken for code. */
const installCode = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('REGRESSION (GOA-3): the host-mode tmux owner is installed and enabled only in host mode', () => {
  assert.match(installCode, /PW_DEPLOY_MODE/, 'the installer must have a deploy-mode concept at all');

  for (const needle of [
    'systemd/pw-tmux-server.service',            // installing the unit
    'enable --now pw-tmux-server.service',       // starting it
    'pw-tmux-server.service.d',                  // the MemoryHigh drop-in
  ]) {
    const idx = installCode.indexOf(needle);
    assert.ok(idx > -1, `${needle} should still be in the installer`);
    const guard = installCode.lastIndexOf('if [ "$PW_DEPLOY_MODE" = "host" ]; then', idx);
    const closed = installCode.lastIndexOf('\nfi\n', idx);
    assert.ok(guard > -1 && guard > closed,
      `${needle} must sit inside a host-mode guard — running it against a container-mode host stands up a competing tmux owner`);
  }
});

test('REGRESSION (GOA-3): an ambiguous deploy mode stops the install rather than assuming host', () => {
  assert.match(installCode, /looks containerised/, 'container evidence with no explicit mode must be refused');
  assert.match(installCode, /is not one of host\|container/, 'an unrecognised mode must be refused');
  // And a plain host box — no variable, no evidence — must still install exactly as before.
  assert.match(installCode, /PW_DEPLOY_MODE=host\n/, 'the no-evidence default stays host');
});

test('REGRESSION (HJ-24-2): a failed owner start ends the install instead of warning and continuing', () => {
  const enable = installCode.indexOf('enable --now pw-tmux-server.service');
  assert.ok(enable > -1);
  const after = installCode.slice(enable, enable + 900);
  assert.match(after, /\bdie\b/,
    'THE REGRESSION: this used to `warn` and continue, so an install reported success while leaving '
    + 'terminals free to create the server themselves — and a later owner start can only ADOPT that server, '
    + 'never move it and its panes into the owner cgroup');
  assert.ok(!/enable --now pw-tmux-server\.service[^\n]*\|\| warn/.test(installCode),
    'the owner enable must not be a warning-only step');
  assert.match(after, /PW_TMUX_OWNER_REQUIRED=false/, 'the refusal must name the documented opt-out');
});

test('an existing host whose server predates the owner unit is told how to migrate, not silently "fixed"', () => {
  // `systemctl enable --now` on a box that already has a running server merely adopts it: the
  // sessions stay in whatever cgroup created them. Claiming the fix is in effect would be false.
  assert.match(installCode, /pw-tmux-assert-owner --quiet/);
  assert.match(src, /pw-tmux-save/);
  assert.match(src, /tmux kill-server/);
  assert.match(src, /systemctl restart pw-tmux-server\.service/);
});

test('the installer ships every helper the units and scripts reference', () => {
  for (const [source, target] of [
    ['scripts/pw-tmux-keepalive.sh', '/usr/local/bin/pw-tmux-keepalive'],   // the owner unit's ExecStart
    ['scripts/pw-tmux-assert-owner', '/usr/local/bin/pw-tmux-assert-owner'], // the ownership gate
    ['scripts/pw-mem-high', '/usr/local/bin/pw-mem-high'],                   // the MemoryHigh calculation
    ['scripts/pw-env.sh', '/usr/local/lib/pw-env.sh'],                       // the environment contract
  ]) {
    const pattern = new RegExp(`${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s+${target.replace(/\//g, '\\/')}`);
    assert.match(src, pattern, `${source} must be installed to ${target} or the thing that calls it is dead on arrival`);
  }
});
