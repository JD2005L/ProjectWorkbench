// P1 — the owner and the dashboard executor must reach the SAME tmux server.
//
// A gate, a readiness signal and a cgroup proof are all worthless if the owner is
// supervising a server nothing else can see. At the reviewed head that is exactly
// what a fresh host would have got:
//
//   owner unit  : no User=/Group=, so ExecStart runs as ROOT, and the keepalive
//                 unconditionally defaulted TMUX_TMPDIR=<prefix>/run/tmux
//                 -> server at /opt/project-workbench/run/tmux/default, uid 0, mode 0700
//   dashboard   : `sudo -u <hostTerminalUser> tmux` with no TMUX_TMPDIR
//                 -> /tmp/tmux-<uid of that account>/default
//
// Different directory AND different uid. The unit would report active and ready,
// having honestly proven ownership of a server that no terminal, no seam and no
// probe will ever look at — while every new-session / new-window / recycle fails
// against an empty socket. The installer comment promising "the per-user DEFAULT
// tmux socket" was false.
//
// Confirmed against the live host before repair: the working server really is at
// /tmp/tmux-1000/default, /opt/project-workbench/run/tmux does not exist on a host
// at all (it is the container's bind mount), and /tmp/tmux-0 — root's socket — is
// empty. The superseded release's unit carried User=admin/Group=admin precisely
// for this reason; Candidate C dropped it.
//
// WHY THIS FILE DOES NOT USE PW_TMUX_SOCKET_PATH. That override hands both sides
// the same `-S` path, so they agree by construction and the defect is invisible —
// it is the fixture shape that would have hidden this. Here each side's socket is
// RESOLVED: the owner's from the staged unit plus the effective TMUX_TMPDIR that
// the real keepalive hands to a real `tmux` invocation, the executor's from
// tmuxProbeArgv() plus the account it names. Then they are compared.
//
// Nothing here starts a tmux server. The owner's effective environment is observed
// through a recording `tmux` shim, so the live shared server is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { tmuxProbeArgv } from '../app/tmux-owner-gate.js';
import { hostTerminalUser } from '../app/terminal-owner.js';
import {
  installDefaults, installedUnits, read, resolveUid, stageInstall,
  tmuxDefaultSocket, unitAccount,
} from './installer-manifest-lib.mjs';

const OWNER_UNIT = 'systemd/pw-tmux-server.service';

const HAVE_TMUX = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function stage(installSh = read('install.sh'), vars = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-parity-')));
  const staged = stageInstall(root, installSh, vars);
  return { root, staged, installSh };
}

function stagedOwnerUnit(host) {
  const unit = installedUnits(host.installSh).find((u) => u.source === OWNER_UNIT);
  assert.ok(unit, 'install.sh no longer installs the owner unit');
  return fs.readFileSync(path.join(host.root, unit.dest), 'utf8');
}

/**
 * The TMUX_TMPDIR the real keepalive actually hands to tmux, observed by running
 * the staged script with a recording `tmux` shim first on PATH.
 *
 * The shim records and exits non-zero, so the keepalive gets "no server" at its
 * very first probe and dies without ever creating one. That is the point: this
 * resolves the owner's socket identity WITHOUT touching any tmux server, which is
 * what makes it safe to run on a host with live sessions.
 */
function ownerEffectiveTmuxEnv(host, extraEnv = {}) {
  const unitText = stagedOwnerUnit(host);
  const unitEnv = {};
  for (const m of unitText.matchAll(/^\s*Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    unitEnv[m[1]] = m[2].trim();
  }
  const execStart = /^ExecStart=(\S+)/m.exec(unitText);
  assert.ok(execStart, 'the owner unit has no ExecStart');
  const script = path.join(host.root, execStart[1]);
  assert.equal(fs.existsSync(script), true, `staged install has no ${execStart[1]}`);

  const bin = path.join(host.root, 'shim');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(host.root, `tmux-env-${Object.keys(extraEnv).join('_') || 'base'}.log`);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
printf 'TMUX_TMPDIR=%s\\n' "${'${TMUX_TMPDIR-<unset>}'}" >> ${JSON.stringify(log)}
printf 'ARGV=%s\\n' "$*" >> ${JSON.stringify(log)}
exit 1
`, { mode: 0o755 });

  spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: host.root,
      LANG: 'C.UTF-8',
      ...unitEnv,          // the unit's OWN environment — no socket override added
      ...extraEnv,
    },
  });

  assert.equal(fs.existsSync(log), true, 'the keepalive never invoked tmux at all');
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const first = lines.find((l) => l.startsWith('TMUX_TMPDIR='));
  const value = first.slice('TMUX_TMPDIR='.length);
  const argv = lines.find((l) => l.startsWith('ARGV=')).slice('ARGV='.length);
  const socketName = /-L\s+(\S+)/.exec(argv);
  return {
    tmuxTmpdir: value === '<unset>' ? null : value,
    socketName: socketName ? socketName[1] : 'default',
    sawExplicitSocketPath: /-S\s/.test(argv),
  };
}

/** The owner's socket identity: which account, on which socket path. */
function ownerSocketIdentity(host, extraEnv = {}) {
  const account = unitAccount(stagedOwnerUnit(host));
  const user = account.user ?? 'root';           // no User= means root, which is the defect
  const effective = ownerEffectiveTmuxEnv(host, extraEnv);
  return {
    user,
    socket: tmuxDefaultSocket({ tmuxTmpdir: effective.tmuxTmpdir, uid: resolveUid(user), name: effective.socketName }),
    effective,
  };
}

/**
 * The dashboard executor's socket identity, from the real probe builder.
 *
 * `sudo` runs with env_reset, so TMUX_TMPDIR is NOT carried across the hop — the
 * pane account's tmux therefore uses its own per-user default. That is asserted
 * below rather than assumed.
 */
function executorSocketIdentity(env = {}) {
  const [command, argv] = tmuxProbeArgv(env, ['display-message', '-p', '#{pid}']);
  assert.equal(command, 'sudo', 'host-mode executor must hop to the pane account');
  const user = argv[1];
  assert.equal(user, hostTerminalUser(env), 'the probe must resolve the account through terminal-owner');
  const name = env.PW_TMUX_SOCKET || 'default';
  return { user, socket: tmuxDefaultSocket({ tmuxTmpdir: null, uid: resolveUid(user), name }) };
}

// ---------------------------------------------------------------------------
// The rule this file relies on, verified against the real tmux
// ---------------------------------------------------------------------------

test('tmux really does place its default socket at $TMUX_TMPDIR/tmux-<uid>/<name>', { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, () => {
  // Verified inside a PRIVATE TMUX_TMPDIR, so the shared server is untouched and
  // the assertion is about tmux's behaviour rather than about this host's state.
  //
  // The environment is BUILT, never inherited. `$TMUX` names the socket of the
  // server the current pane belongs to and takes precedence over TMUX_TMPDIR, so
  // spreading process.env here sends every command to the LIVE shared server
  // instead of the private one — which is exactly what happened while writing
  // this test, and it created a stray session on the real host.
  const dir = fs.mkdtempSync('/tmp/pwsock-');
  try {
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: dir, LANG: 'C.UTF-8', TMUX_TMPDIR: dir };
    execFileSync('tmux', ['-u', 'new-session', '-d', '-s', 'probe', 'sleep 60'], { env, timeout: 20000 });
    const socket = execFileSync('tmux', ['-u', 'display-message', '-p', '#{socket_path}'], { env, encoding: 'utf8', timeout: 20000 }).trim();
    assert.equal(socket, tmuxDefaultSocket({ tmuxTmpdir: dir, uid: os.userInfo().uid }),
      'tmuxDefaultSocket() no longer matches what tmux actually does');
    execFileSync('tmux', ['-u', 'kill-server'], { env, timeout: 20000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The parity invariant
// ---------------------------------------------------------------------------

test('P1: the owner and the dashboard executor resolve the SAME socket and the SAME account', () => {
  const host = stage();
  try {
    const owner = ownerSocketIdentity(host);
    const executor = executorSocketIdentity({});

    assert.equal(owner.effective.sawExplicitSocketPath, false,
      'this regression must not be resolved through an explicit -S socket override');

    assert.equal(owner.user, executor.user,
      `the owner runs as ${owner.user} but the dashboard drives tmux as ${executor.user} — different per-user sockets`);
    assert.equal(owner.socket, executor.socket,
      `owner supervises ${owner.socket} while the dashboard probes and drives ${executor.socket}`);
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('the owner unit names the account the installer actually creates', () => {
  const host = stage();
  try {
    const account = unitAccount(stagedOwnerUnit(host));
    const { user } = installDefaults(host.installSh);
    assert.equal(account.user, user, `owner unit User= is ${account.user}, installer creates ${user}`);
    assert.equal(account.group, user, `owner unit Group= is ${account.group}, installer creates ${user}`);
    assert.equal(account.user, hostTerminalUser({}),
      'the owner unit and terminal-owner.js must name one account, or they drift');
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('host mode uses the per-user default socket — no custom TMUX_TMPDIR', () => {
  const host = stage();
  try {
    const effective = ownerEffectiveTmuxEnv(host);
    assert.equal(effective.tmuxTmpdir, null,
      `the host owner handed tmux TMUX_TMPDIR=${effective.tmuxTmpdir}, so its server lands on a socket the seams never look at`);
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('host mode CLEARS an inherited TMUX_TMPDIR rather than honouring it', () => {
  // A stray TMUX_TMPDIR in the unit's environment (an EnvironmentFile, an operator's
  // export) must not be able to move the owner off the socket the seams use.
  const host = stage();
  try {
    const effective = ownerEffectiveTmuxEnv(host, { TMUX_TMPDIR: '/tmp/pw-decoy-tmpdir' });
    assert.equal(effective.tmuxTmpdir, null,
      'an inherited TMUX_TMPDIR moved the host owner off the per-user default socket');
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('CONTAINER: the sidecar keeps its explicit bind-mounted socket dir', () => {
  // The sidecar passes -e TMUX_TMPDIR=<mount> and its server must stay there. The
  // host-mode clear must not reach into container mode.
  const host = stage();
  try {
    const effective = ownerEffectiveTmuxEnv(host, {
      PW_TMUX_HOST_MODE: '0',
      PW_DEPLOY_MODE: 'container',
      TMUX_TMPDIR: '/opt/project-workbench/run/tmux',
    });
    assert.equal(effective.tmuxTmpdir, '/opt/project-workbench/run/tmux',
      'container supervision lost its bind-mounted socket dir');
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Mutations — root, custom TMUX_TMPDIR, account mismatch
// ---------------------------------------------------------------------------

test('MUTATION: an owner unit with no User= (i.e. root) breaks parity', () => {
  const host = stage();
  try {
    const stripped = stagedOwnerUnit(host).replace(/^(User|Group)=.*$/gm, '# removed by mutation');
    const account = unitAccount(stripped);
    assert.equal(account.user, null, 'the mutation did not apply');
    const rootIdentity = tmuxDefaultSocket({ tmuxTmpdir: null, uid: resolveUid('root') });
    assert.notEqual(rootIdentity, executorSocketIdentity({}).socket,
      'running the owner as root would have to differ from the pane account, or this proves nothing');
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('MUTATION: restoring the unconditional TMUX_TMPDIR default breaks parity', () => {
  const host = stage();
  try {
    const execStart = /^ExecStart=(\S+)/m.exec(stagedOwnerUnit(host))[1];
    const script = path.join(host.root, execStart);
    const original = fs.readFileSync(script, 'utf8');

    // The reviewed head's behaviour, restored verbatim.
    const broken = original.replace(
      /if \[\[ "\$HOST_MODE" == 1 \]\]; then[\s\S]*?\nfi\n/,
      ': "${TMUX_TMPDIR:=/opt/project-workbench/run/tmux}"\nexport TMUX_TMPDIR\nmkdir -p "$TMUX_TMPDIR" 2>/dev/null || true\n',
    );
    assert.notEqual(broken, original, 'the mutation did not apply — the host-mode branch has changed shape');
    fs.writeFileSync(script, broken);

    const effective = ownerEffectiveTmuxEnv(host);
    assert.equal(effective.tmuxTmpdir, '/opt/project-workbench/run/tmux',
      'the mutation did not reproduce the reviewed head');
    const owner = tmuxDefaultSocket({ tmuxTmpdir: effective.tmuxTmpdir, uid: resolveUid(installDefaults(host.installSh).user) });
    assert.notEqual(owner, executorSocketIdentity({}).socket,
      'the reviewed head must produce a DIFFERENT socket from the executor, or this regression is vacuous');
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('MUTATION: an owner unit naming a different account breaks parity', () => {
  const host = stage();
  try {
    const mismatched = unitAccount(stagedOwnerUnit(host).replace(/^User=.*$/m, 'User=nobody')).user;
    assert.equal(mismatched, 'nobody', 'the mutation did not apply');
    const executor = executorSocketIdentity({});
    assert.notEqual(mismatched, executor.user, 'the mutation must name a different account');
    assert.notEqual(
      tmuxDefaultSocket({ tmuxTmpdir: null, uid: resolveUid(mismatched) }), executor.socket,
      'a different account must resolve a different socket, or the parity check cannot fail',
    );
  } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});
