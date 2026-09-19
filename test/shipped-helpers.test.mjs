// Locating a script this repository ships, in either install layout.
//
// Both callers got this wrong, in opposite directions, and each failure was invisible on the
// instance it was written on:
//
//   * the wake helper named /usr/local/bin — which install.sh creates and a container image never
//     does, because install.sh refuses to run in container mode at all. On a container deployment
//     the wake route spawned a path that did not exist.
//   * the ownership helper named <app>/../scripts — which the container image populates and
//     install.sh does not: it installs that tool to /usr/local/sbin and puts only a couple of files
//     in <install>/scripts. On a clean host the reclaim ran nothing, silently, because its failure
//     is deliberately non-fatal. Where an older deploy path had populated that directory it was
//     worse than absent: a stale copy that would run instead of the installed one.
//
// So the resolver is what these pin: installed location first (on a host that is the copy
// install.sh maintains, and the same binary the tmux wake hooks invoke, so the dashboard and the
// hooks can never run two different versions), image layout as the fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveShippedHelper, SHIPPED_HELPER_DIRS } from '../app/shipped-helpers.js';

const APP = '/opt/project-workbench/app';
const SIBLING = '/opt/project-workbench/scripts/pw-claude-wake';
const only = (...present) => (p) => present.includes(p);

test('a host install runs the copy install.sh maintains, not a sibling left behind by an older one', () => {
  // Both exist. The PATH copy has to win: on this layout the sibling is whatever some earlier
  // deploy path dropped there, and the tmux hooks are already running /usr/local/bin.
  const resolved = resolveShippedHelper('pw-claude-wake', {
    appDir: APP, isFile: only('/usr/local/bin/pw-claude-wake', SIBLING),
  });
  assert.equal(resolved, '/usr/local/bin/pw-claude-wake');
});

test('a container install runs the image copy, because nothing is on PATH there', () => {
  const resolved = resolveShippedHelper('pw-claude-wake', { appDir: APP, isFile: only(SIBLING) });
  assert.equal(resolved, SIBLING, 'the image COPYs scripts/ to <install>/scripts and installs nothing on PATH');
});

test('sbin is searched too, which is where install.sh puts the privileged tools', () => {
  const resolved = resolveShippedHelper('pw-fix-workspace-ownership', {
    appDir: APP, isFile: only('/usr/local/sbin/pw-fix-workspace-ownership'),
  });
  assert.equal(resolved, '/usr/local/sbin/pw-fix-workspace-ownership');
  assert.deepEqual([...SHIPPED_HELPER_DIRS], ['/usr/local/bin', '/usr/local/sbin'], 'bin before sbin, both searched');
});

test('with the helper nowhere, it still names a real location rather than an empty string', () => {
  const resolved = resolveShippedHelper('pw-claude-wake', { appDir: APP, isFile: () => false });
  assert.equal(resolved, SIBLING,
    'a caller that cannot find the helper must fail naming a path an operator can go and look at');
});

test('the caller passes a bare script name, never a path', () => {
  // A path here would quietly defeat the whole resolution and reintroduce the layout assumption.
  assert.throws(() => resolveShippedHelper('/usr/local/bin/pw-claude-wake', { appDir: APP }), /bare script name/);
  assert.throws(() => resolveShippedHelper('../scripts/pw-claude-wake', { appDir: APP }), /bare script name/);
});

test('both server helpers go through the resolver, and neither names an install location itself', () => {
  const server = readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  for (const name of ['pw-claude-wake', 'pw-fix-workspace-ownership']) {
    assert.match(server, new RegExp(`resolveShippedHelper\\('${name}', \\{ appDir: APP_DIR \\}\\)`),
      `${name} must be resolved, not hardcoded`);
  }
  assert.doesNotMatch(server, /['"]\/usr\/local\/s?bin\/pw-/,
    'no install location may be spelled out in the dashboard again');
});
