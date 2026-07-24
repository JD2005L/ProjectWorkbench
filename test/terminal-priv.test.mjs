// The non-root terminal drop (PW_TERMINAL_UID) must be OFF by default and, in
// particular, must NOT engage in host mode: PW spawns panes there via
// `sudo -u admin`, so a setpriv --init-groups on top fails with "initgroups
// failed: Operation not permitted". It engages only in container mode, where
// tmux() runs as root. Unset UID => passthrough, byte-identical to upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalPriv, wrapAgentEnv, agentLoginDrop } from '../app/terminal-priv.js';

const CANON_ADMIN = ['env', 'HOME=/home/admin', 'LANG=C.UTF-8', 'TERM=screen-256color', 'PATH=/usr/local/bin:/usr/bin'];
const CANON_ROOT = ['env', 'HOME=/root', 'LANG=C.UTF-8', 'TERM=xterm-256color', 'IS_SANDBOX=1', 'COPILOT_AUTO_UPDATE=false', 'PATH=/usr/local/bin:/usr/bin'];

test('unset PW_TERMINAL_UID => disabled, passthrough', () => {
  const p = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container' });
  assert.equal(p.enabled, false);
  assert.deepEqual(wrapAgentEnv(p, CANON_ADMIN), CANON_ADMIN);
  assert.deepEqual(agentLoginDrop(p), []);
});

test('host mode + UID set => disabled (regression: no setpriv from sudo -u admin)', () => {
  for (const env of [{ PW_TERMINAL_UID: '1001' }, { PW_TERMINAL_UID: '1001', PW_DEPLOY_MODE: 'host' }]) {
    const p = resolveTerminalPriv(env);
    assert.equal(p.enabled, false, JSON.stringify(env));
    assert.deepEqual(wrapAgentEnv(p, CANON_ADMIN), CANON_ADMIN);
    assert.deepEqual(agentLoginDrop(p), []);
  }
});

test('container + UID => setpriv wrap with reuid/regid/init-groups', () => {
  const p = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001' });
  assert.equal(p.enabled, true);
  const w = wrapAgentEnv(p, CANON_ADMIN);
  assert.deepEqual(w.slice(0, 7), ['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--init-groups', '/usr/bin/env']);
  assert.ok(w.includes('HOME=/home/admin'));
  assert.ok(w.includes('USER=admin'));
  assert.ok(w.includes('LOGNAME=admin'));
  assert.ok(w.includes('IS_SANDBOX=1'));
});

test('container + UID rewrites HOME and appends extra PATH without duplicating flags', () => {
  const p = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_EXTRA_PATH: '/opt/npm-global/bin' });
  const w = wrapAgentEnv(p, CANON_ROOT);
  assert.ok(w.includes('HOME=/home/admin'));
  assert.ok(!w.includes('HOME=/root'));
  assert.ok(w.includes('PATH=/usr/local/bin:/usr/bin:/opt/npm-global/bin'));
  assert.equal(w.filter((t) => t === 'IS_SANDBOX=1').length, 1);
});

test('does not double-inject USER when canonical already has it', () => {
  const p = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001' });
  const canon = ['env', 'HOME=/home/admin', 'USER=admin', 'LOGNAME=admin', 'PATH=/usr/bin'];
  const w = wrapAgentEnv(p, canon);
  assert.equal(w.filter((t) => t === 'USER=admin').length, 1);
});

test('agentLoginDrop: setpriv argv in container, [] in host', () => {
  const on = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001' });
  assert.deepEqual(agentLoginDrop(on), ['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--init-groups', '/usr/bin/env', 'HOME=/home/admin', 'USER=admin', 'LOGNAME=admin']);
  assert.deepEqual(agentLoginDrop(resolveTerminalPriv({ PW_TERMINAL_UID: '1001' })), []);
});

test('custom gid/user/home honoured', () => {
  const p = resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1500', PW_TERMINAL_GID: '1600', PW_TERMINAL_USER: 'svc', PW_TERMINAL_HOME: '/home/svc' });
  assert.equal(p.gid, '1600');
  const d = agentLoginDrop(p);
  assert.deepEqual(d, ['/usr/bin/setpriv', '--reuid', '1500', '--regid', '1600', '--init-groups', '/usr/bin/env', 'HOME=/home/svc', 'USER=svc', 'LOGNAME=svc']);
});