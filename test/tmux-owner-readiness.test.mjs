// Candidate C — readiness must prove ownership of the LIVE server, and the
// cold-start race test must be able to fail.
//
// Round 8, item 1: the superseded candidate's readiness asked only "does a
// `_keepalive` session exist on this socket". With a client-created server
// already present it reported ready — releasing the `After=` barrier for every
// terminal — while supervising a foreign server in a ttyd's cgroup.
//
// Round 8, item 2: its cold-start race test was vacuous. Moving the readiness
// signal to before server creation (i.e. reinstating the `Type=simple` behaviour
// the repair targets) left the test PASSING, because the client acted only after
// an async round-trip, by which time the server always existed. The corrected
// form drives the client from INSIDE the readiness notification, at the instant
// the barrier releases, and asserts the surviving server's owner marker. It must
// be shown to fail against the unrepaired behaviour.
//
// Both traps are honoured below. The race client is run with the owner marker
// CLEARED from its environment, because a client that inherits the marker makes
// the test vacuous a second way.
//
// Hermetic: a short private socket root (tmux socket paths are bounded by
// sockaddr_un, ~104 bytes), every inherited tmux/PW variable scrubbed, and no
// network or dependency use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const KEEPALIVE = path.join(repo, 'scripts/pw-tmux-keepalive.sh');

const HAVE_TMUX = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const needTmux = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'not run: tmux is not installed here' }, fn);

// Short root: a socket path under a long mkdtemp would exceed sockaddr_un and the
// failure would look like a logic bug.
function shortSocketRoot() {
  const root = fs.mkdtempSync('/tmp/pwt-');
  fs.chmodSync(root, 0o700);
  return root;
}

// A scrubbed environment: nothing a developer's shell or CI runner exports may
// decide the outcome.
function cleanEnv(extra = {}) {
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: os.homedir(), LANG: 'C.UTF-8' };
  for (const k of ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'NOTIFY_SOCKET', 'PW_ENV_FILE', 'PW_DEPLOY_MODE']) {
    delete env[k];
  }
  return { ...env, ...extra };
}

function tmuxIn(root, socket, args, env = {}) {
  return spawnSync('tmux', ['-S', path.join(root, socket), ...args], {
    encoding: 'utf8', timeout: 20000, env: cleanEnv(env),
  });
}

function killServer(root, socket) {
  tmuxIn(root, socket, ['kill-server']);
}

// Run the keepalive as the owner would, with a stub `systemd-notify` on PATH that
// records readiness and can run a hook AT THE INSTANT readiness fires.
function runOwner(root, socket, { readyHook = '', extraEnv = {}, timeoutMs = 25000 } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const readyFlag = path.join(root, 'ready');
  fs.writeFileSync(path.join(bin, 'systemd-notify'), `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "--ready" ]; then
    date +%s%N > ${JSON.stringify(readyFlag)}
    ${readyHook}
  fi
done
exit 0
`, { mode: 0o755 });

  const r = spawnSync('bash', [KEEPALIVE], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: cleanEnv({
      PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`,
      PW_TMUX_SOCKET_PATH: path.join(root, socket),
      PW_TMUX_HOST_MODE: '1',
      PW_TMUX_OWNER_BOOTSTRAP: '1',
      PW_TMUX_EXIT_AFTER_READY: '1',   // test-only: supervise-and-return
      ...extraEnv,
    }),
  });
  return { ...r, readyFlag, ready: fs.existsSync(readyFlag) };
}

// ---------------------------------------------------------------------------
// C1 — readiness proves ownership of the LIVE server
// ---------------------------------------------------------------------------

needTmux('the owner stamps its marker and signals ready only with the server live', () => {
  const root = shortSocketRoot();
  try {
    const r = runOwner(root, 'sock');
    assert.equal(r.status, 0, `owner failed: ${r.stderr}`);
    assert.equal(r.ready, true, 'readiness was never signalled');

    const marker = tmuxIn(root, 'sock', ['show-options', '-sv', '@pw_owner']);
    assert.equal(marker.stdout.trim(), 'pw-owner', 'the live server carries no owner marker');
    const ka = tmuxIn(root, 'sock', ['has-session', '-t', '_keepalive']);
    assert.equal(ka.status, 0, 'the keepalive session must exist');
  } finally { killServer(root, 'sock'); }
});

needTmux('the owner REFUSES a pre-existing foreign server rather than adopting it', () => {
  const root = shortSocketRoot();
  try {
    // A server created by something else, with no owner marker — the
    // adopt-don't-move case.
    const pre = tmuxIn(root, 'sock', ['new-session', '-d', '-s', 'squatter', 'sleep 300']);
    assert.equal(pre.status, 0, `could not stage a foreign server: ${pre.stderr}`);

    const r = runOwner(root, 'sock');
    assert.notEqual(r.status, 0, 'the owner adopted a foreign server instead of refusing');
    assert.equal(r.ready, false, 'readiness must NOT be signalled for a foreign server');
    assert.match(r.stderr, /foreign|owner marker|migrat/i, 'the refusal must be actionable');
    // And it must document the migration rather than leaving an operator stuck.
    assert.match(r.stderr, /pw-tmux-save|kill-server/i, 'the refusal must document the migration');
  } finally { killServer(root, 'sock'); }
});

needTmux('readiness is not signalled when the server dies before the proof completes', () => {
  const root = shortSocketRoot();
  try {
    // Kill the server from inside the readiness hook's own moment is not
    // possible; instead prove the ordering directly: readiness must come AFTER
    // the marker exists, so a run whose server never starts must not signal.
    const r = runOwner(root, 'sock', { extraEnv: { PW_TMUX_FORCE_SERVER_FAILURE: '1' } });
    assert.notEqual(r.status, 0);
    assert.equal(r.ready, false, 'readiness fired without a live proven server');
  } finally { killServer(root, 'sock'); }
});

needTmux('required cgroup validation refuses an unreadable process cgroup', () => {
  const root = shortSocketRoot();
  try {
    const r = runOwner(root, 'sock', {
      extraEnv: { PW_TMUX_REQUIRE_CGROUP: '1', PW_TMUX_PROC_ROOT: path.join(root, 'missing-proc') },
    });
    assert.notEqual(r.status, 0, 'strict owner bootstrap accepted a server whose cgroup it could not read');
    assert.equal(r.ready, false, 'readiness must not be signalled without cgroup proof');
    assert.match(r.stderr, /cgroup.*read|read.*cgroup/i);
  } finally { killServer(root, 'sock'); }
});

// ---------------------------------------------------------------------------
// C3 — the cold-start race, in the form that can actually fail
// ---------------------------------------------------------------------------

needTmux('COLD START RACE: a client racing at the instant readiness releases cannot become the server creator', () => {
  const root = shortSocketRoot();
  const sock = path.join(root, 'sock');
  const clientLog = path.join(root, 'client.log');
  try {
    // The client runs FROM INSIDE the readiness notification — the instant the
    // After= barrier would release — and with the owner marker cleared from its
    // environment so it cannot look like the owner by inheritance.
    const readyHook = `env -u PW_TMUX_OWNER_BOOTSTRAP -u PW_TMUX_HOST_MODE `
      + `tmux -S ${JSON.stringify(sock)} new-session -d -s racer 'sleep 300' >> ${JSON.stringify(clientLog)} 2>&1 || true`;

    const r = runOwner(root, 'sock', { readyHook });
    assert.equal(r.status, 0, `owner failed: ${r.stderr}`);
    assert.equal(r.ready, true);

    // THE ASSERTION: whatever server is now live must be the OWNER's. If the
    // client won the race it created a markerless server in its own cgroup.
    const marker = tmuxIn(root, 'sock', ['show-options', '-sv', '@pw_owner']);
    assert.equal(
      marker.stdout.trim(), 'pw-owner',
      'the surviving server was created by the racing client, not the owner — readiness released too early',
    );
  } finally { killServer(root, 'sock'); }
});
