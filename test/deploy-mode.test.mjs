// GOA-5: `PW_DEPLOY_MODE` unset silently meant "host".
//
// Project Workbench has two mutually exclusive terminal models. Host mode launches panes through
// `sudo -u admin tmux` under per-project systemd units; container mode spawns ttyd from the node
// process and drops privileges with setpriv. Picking the wrong one does not degrade — it produces a
// deployment that is wrong in a way nothing reports. Before this module both `app/terminal-owner.js`
// and `app/orchestrator/config.js` resolved the mode with their own copy of
//   String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host'
// which has two silent failures: a typo (`containr`, `Container `, `docker`) becomes host, and an
// omitted variable becomes host even inside an obviously containerised runtime.
//
// The contract here: an explicit, recognised value is always honoured (so every existing deployment
// keeps the mode it already has); anything the product cannot read as a deliberate choice is
// AMBIGUOUS and must fail safely at the boundary rather than resolve to a default. A plain host
// install — no variable, no container evidence — is not ambiguous, because that is what every
// pre-existing `install.sh` deployment looks like and breaking it would be a worse regression than
// the one being fixed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDeployMode, containerEvidence, requireDeployMode } from '../app/deploy-mode.js';

const noProbe = () => false;

test('an explicit recognised mode is honoured exactly, in either direction', () => {
  for (const [raw, mode] of [['host', 'host'], ['container', 'container'], ['HOST', 'host'], ['Container', 'container'], ['  container  ', 'container']]) {
    const got = resolveDeployMode({ PW_DEPLOY_MODE: raw }, { probe: noProbe });
    assert.equal(got.mode, mode, `PW_DEPLOY_MODE=${JSON.stringify(raw)}`);
    assert.equal(got.ambiguous, false);
    assert.equal(got.source, 'explicit');
  }
});

test('an explicit mode wins over container evidence — an operator statement is never overridden', () => {
  const got = resolveDeployMode(
    { PW_DEPLOY_MODE: 'host', container: 'podman', PW_TERMINAL_UID: '1001' },
    { probe: () => true },
  );
  assert.equal(got.mode, 'host');
  assert.equal(got.ambiguous, false);
});

test('REGRESSION: an unrecognised value is ambiguous, not silently host', () => {
  for (const raw of ['containr', 'docker', 'k8s', 'true', 'hosts', 'container-mode']) {
    const got = resolveDeployMode({ PW_DEPLOY_MODE: raw }, { probe: noProbe });
    assert.equal(got.mode, null, `PW_DEPLOY_MODE=${raw} must not resolve to a mode`);
    assert.equal(got.ambiguous, true);
    assert.match(got.reason, /PW_DEPLOY_MODE/);
    assert.match(got.reason, /host\|container/);
  }
});

test('an existing plain host install — unset, no evidence — keeps working and is not ambiguous', () => {
  for (const env of [{}, { PW_DEPLOY_MODE: '' }, { PW_DEPLOY_MODE: '   ' }, { TMUX_TMPDIR: '/opt/project-workbench/run/tmux' }]) {
    const got = resolveDeployMode(env, { probe: noProbe });
    assert.equal(got.mode, 'host', `env ${JSON.stringify(env)} is what every pre-existing install.sh deployment looks like`);
    assert.equal(got.ambiguous, false);
    assert.equal(got.source, 'default');
  }
});

test('TMUX_TMPDIR is deliberately NOT container evidence', () => {
  // Container mode exports it by design, but a host operator or a test harness may equally have it
  // set; treating it as evidence would refuse to boot a working host box over an ambient variable.
  assert.deepEqual(containerEvidence({ TMUX_TMPDIR: '/tmp/whatever' }, { probe: noProbe }), []);
});

test('REGRESSION: unset + container evidence is ambiguous rather than silently host', () => {
  const cases = [
    [{ container: 'podman' }, /container=podman/],
    [{ container: 'docker' }, /container=docker/],
    [{ PW_TERMINAL_UID: '1001' }, /PW_TERMINAL_UID/],
  ];
  for (const [env, pattern] of cases) {
    const got = resolveDeployMode(env, { probe: noProbe });
    assert.equal(got.mode, null, `${JSON.stringify(env)} must not silently resolve to host semantics`);
    assert.equal(got.ambiguous, true);
    assert.match(got.reason, pattern);
    assert.match(got.reason, /PW_DEPLOY_MODE/, 'the message must name the variable the operator has to set');
  }
});

test('a container marker file is evidence too, and the probe is injectable', () => {
  const seen = [];
  const probe = (p) => { seen.push(p); return p === '/run/.containerenv'; };
  const got = resolveDeployMode({}, { probe });
  assert.equal(got.ambiguous, true);
  assert.match(got.reason, /\/run\/\.containerenv/);
  assert.ok(seen.includes('/run/.containerenv'), 'the podman marker must actually be probed');
  assert.ok(seen.includes('/.dockerenv'), 'the docker marker must actually be probed');
});

test('requireDeployMode returns the mode, or throws an actionable error on ambiguity', () => {
  assert.equal(requireDeployMode({ PW_DEPLOY_MODE: 'container' }, { probe: noProbe }), 'container');
  assert.equal(requireDeployMode({}, { probe: noProbe }), 'host');
  assert.throws(
    () => requireDeployMode({ PW_DEPLOY_MODE: 'containr' }, { probe: noProbe }),
    (e) => /PW_DEPLOY_MODE/.test(e.message) && /host\|container/.test(e.message),
    'a typo must stop the caller, not resolve to a default',
  );
  assert.throws(
    () => requireDeployMode({ container: 'podman' }, { probe: noProbe }),
    /PW_DEPLOY_MODE/,
  );
});

test('the resolver is pure: it never mutates the environment it is handed', () => {
  const env = { PW_DEPLOY_MODE: 'container' };
  const before = JSON.stringify(env);
  resolveDeployMode(env, { probe: noProbe });
  assert.equal(JSON.stringify(env), before);
});

// --- the four call sites that used to carry their own copy ---------------------------------

import { terminalOwnerPlan } from '../app/terminal-owner.js';
import { resolveTerminalPriv } from '../app/terminal-priv.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

test('REGRESSION: terminalOwnerPlan refuses an ambiguous mode instead of returning host semantics', () => {
  // Before: {kind:'named', user:'admin'} — i.e. "launch every pane via `sudo -u admin tmux`" —
  // for a typo and for an unset variable inside a container. `invalid` is the file's existing
  // fail-closed kind, and resolveTerminalOwner already throws on it.
  for (const env of [{ PW_DEPLOY_MODE: 'containr' }, { container: 'podman' }]) {
    const plan = terminalOwnerPlan(env);
    assert.equal(plan.kind, 'invalid', `${JSON.stringify(env)} must not resolve to a usable owner plan`);
    assert.match(plan.reason, /PW_DEPLOY_MODE/);
  }
});

test('terminalOwnerPlan is unchanged for every mode an operator actually stated', () => {
  assert.deepEqual(terminalOwnerPlan({ PW_DEPLOY_MODE: 'host' }), { kind: 'named', user: 'admin' });
  assert.deepEqual(terminalOwnerPlan({}), { kind: 'named', user: 'admin' });
  assert.deepEqual(
    terminalOwnerPlan({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001' }),
    { kind: 'numeric', uid: 1001, gid: 1001, user: 'admin' },
  );
  assert.equal(terminalOwnerPlan({ PW_DEPLOY_MODE: 'container' }).kind, 'none');
});

test('the setpriv drop stays off under an ambiguous mode rather than claiming to have dropped', () => {
  assert.equal(resolveTerminalPriv({ PW_DEPLOY_MODE: 'containr', PW_TERMINAL_UID: '1001' }).enabled, false);
  assert.equal(resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001' }).enabled, true);
  assert.equal(resolveTerminalPriv({ PW_DEPLOY_MODE: 'host', PW_TERMINAL_UID: '1001' }).enabled, false);
});

test('REGRESSION: the orchestrator config refuses to load under an ambiguous mode', () => {
  assert.throws(
    () => loadOrchestratorConfig({ PW_DEPLOY_MODE: 'containr' }),
    /PW_DEPLOY_MODE/,
    'a typo used to select the host branch, which then validated a privilege-drop account container mode has no use for',
  );
  // Explicit modes still load exactly as before.
  assert.equal(loadOrchestratorConfig({ PW_DEPLOY_MODE: 'container' }).deployMode, 'container');
  assert.equal(loadOrchestratorConfig({}).deployMode, 'host');
});
