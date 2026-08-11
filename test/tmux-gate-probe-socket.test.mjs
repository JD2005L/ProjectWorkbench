// The ownership gate must PROBE the same tmux server the seam it guards DRIVES.
//
// Every other gate test injects `capture`, so they all verify the verdict logic
// against a supplied answer and none of them ever exercised the default probe.
// That is exactly how this escaped a green CI: on a real host-mode deployment the
// dashboard runs as root while the shared server lives on the pane account's
// per-user socket, so a bare `tmux` probe inspected root's own EMPTY socket and
// returned "no running tmux server on the target socket" about a healthy host —
// refusing every new-session / new-window / terminal recycle, permanently, with a
// migration hint that could not have fixed it.
//
// These tests pin the invariant that makes the gate meaningful: probe and
// executor resolve the SAME account, through the same helper, in both modes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmuxProbeArgv } from '../app/tmux-owner-gate.js';
import { HOST_TERMINAL_USER, hostTerminalUser } from '../app/terminal-owner.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('host mode: the probe hops to the pane account, exactly as tmux() does', () => {
  const [command, argv] = tmuxProbeArgv({ PW_DEPLOY_MODE: 'host' }, ['display-message', '-p', '#{pid}']);
  assert.equal(command, 'sudo');
  assert.deepEqual(argv, ['-u', HOST_TERMINAL_USER, 'tmux', 'display-message', '-p', '#{pid}']);
});

test('host mode is the DEFAULT: an unset PW_DEPLOY_MODE still hops', () => {
  // The live unit sets PW_DEPLOY_MODE=host, but nothing may depend on that: an
  // unset mode is host per expectedOwnerCgroup(), so it must hop too.
  const [command] = tmuxProbeArgv({}, ['display-message', '-p', '#{pid}']);
  assert.equal(command, 'sudo', 'an unset deploy mode must not fall back to a bare, root-socket tmux');
});

test('REGRESSION: the host-mode probe never execs a bare tmux', () => {
  // The defect in one line. As root a bare `tmux` reads /tmp/tmux-0/default,
  // which on a real deployment is empty, so the gate reported "no server".
  for (const env of [{}, { PW_DEPLOY_MODE: 'host' }, { PW_DEPLOY_MODE: 'HOST' }]) {
    const [command] = tmuxProbeArgv(env, ['show-options', '-sv', '@pw_owner']);
    assert.notEqual(command, 'tmux', `host-mode probe must not exec tmux directly (env ${JSON.stringify(env)})`);
  }
});

test('container mode: the probe execs tmux directly, as tmux() does there', () => {
  // In container mode the dashboard drives tmux in its own namespace with no
  // sudo hop, so the probe must not invent one.
  const [command, argv] = tmuxProbeArgv({ PW_DEPLOY_MODE: 'container' }, ['display-message', '-p', '#{pid}']);
  assert.equal(command, 'tmux');
  assert.deepEqual(argv, ['display-message', '-p', '#{pid}']);
});

test('the socket override is carried in both modes', () => {
  const [, hostArgv] = tmuxProbeArgv({ PW_DEPLOY_MODE: 'host', PW_TMUX_SOCKET: 'pw' }, ['kill-server']);
  assert.deepEqual(hostArgv, ['-u', HOST_TERMINAL_USER, 'tmux', '-L', 'pw', 'kill-server']);

  const [, containerArgv] = tmuxProbeArgv({ PW_DEPLOY_MODE: 'container', PW_TMUX_SOCKET: 'pw' }, ['kill-server']);
  assert.deepEqual(containerArgv, ['-L', 'pw', 'kill-server']);
});

test('probe and executor cannot name different accounts', () => {
  // terminal-owner.js exists so tmux() and ownership resolution can never drift
  // apart about the account. The probe must resolve it the same way — including
  // an explicit PW_HOST_TERMINAL_USER override.
  const env = { PW_DEPLOY_MODE: 'host', PW_HOST_TERMINAL_USER: 'paneuser' };
  const [, argv] = tmuxProbeArgv(env, ['display-message', '-p', '#{pid}']);
  assert.deepEqual(argv.slice(0, 2), ['-u', hostTerminalUser(env)]);
  assert.equal(argv[1], 'paneuser');
});

test('the gate resolves the account through terminal-owner, not a literal', () => {
  // A hardcoded 'admin' here would re-open the drift terminal-owner.js was
  // written to close.
  const src = read('app/tmux-owner-gate.js');
  assert.match(src, /import \{ hostTerminalUser \} from '\.\/terminal-owner\.js'/);
  assert.match(src, /hostTerminalUser\(env\)/);
});
