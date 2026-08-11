// Shared fixture support: make a test's PRIVATE tmux server look like what a
// real deployment has — an owned server.
//
// Candidate C makes every server-creation seam refuse a tmux server it does not
// own. Harnesses that stand up their own private server were, before this,
// creating exactly the state the gate exists to catch: an unmarked server nobody
// claims. They were not wrong to fail; they were describing an environment that
// cannot occur in production, where the owner unit stamps the server before any
// terminal is allowed to touch it.
//
// So these helpers install the REAL assertion helper and reproduce the REAL
// expectations. Deliberately NOT provided, because each would be a fail-open the
// contract forbids:
//
//   * no bypass/enforcement flag,
//   * no reuse of PW_TMUX_OWNER_BOOTSTRAP as a test exemption,
//   * no private-socket exemption (production isolates with the same variable,
//     so exempting private sockets would exempt production too).
//
// The cgroup half is handled the way Round 8 prescribed: a test where every
// process shares the runner's cgroup cannot discriminate on cgroup, so the branch
// is exercised against a CONTROLLED /proc whose contents say what a real host
// would say. `PW_TMUX_REQUIRE_CGROUP=1` — the same value the shipped units set —
// stays ON, so the fixture proves the production expectation rather than dodging it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OWNER_MARKER_OPTION, OWNER_MARKER_VALUE, expectedOwnerCgroup } from '../app/tmux-owner.js';

const REAL_HELPER = fileURLToPath(new URL('../scripts/pw-tmux-assert-owner', import.meta.url));

// Put the REAL helper on PATH — not a stub. A fixture that stubbed it would stop
// testing the thing the seams actually call.
export function installOwnerHelper(dir) {
  const bin = path.join(dir, 'owner-bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'pw-tmux-assert-owner');
  try {
    fs.symlinkSync(REAL_HELPER, link);
  } catch {
    fs.copyFileSync(REAL_HELPER, link);
    fs.chmodSync(link, 0o755);
  }
  return bin;
}

function tmuxOn(socket, args) {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
}

// Bring the private server up (if it is not already), stamp the owner marker the
// way the owner unit does, and write a controlled /proc entry placing that exact
// server pid in the expected owner cgroup.
export function markOwnedServer({ socket, dir, env = {} }) {
  // A server only exists once a session does — `tmux start-server` exits
  // immediately with no sessions (verified against tmux 3.4).
  try {
    tmuxOn(socket, ['has-session', '-t', '_keepalive']);
  } catch {
    try { tmuxOn(socket, ['new-session', '-d', '-s', '_keepalive', 'sleep 86400']); } catch { /* raced */ }
  }
  try { tmuxOn(socket, ['set-option', '-s', OWNER_MARKER_OPTION, OWNER_MARKER_VALUE]); } catch { /* no server */ }

  const procRoot = path.join(dir, 'proc');
  let pid = null;
  try { pid = tmuxOn(socket, ['display-message', '-p', '#{pid}']); } catch { /* no server */ }
  if (pid && /^\d+$/.test(pid)) {
    fs.mkdirSync(path.join(procRoot, pid), { recursive: true });
    // Resolved by PRODUCTION's own function, so the fixture cannot drift from the
    // unit the deployment actually expects (host vs container owner).
    fs.writeFileSync(path.join(procRoot, pid, 'cgroup'), `0::/system.slice/${expectedOwnerCgroup(env)}\n`);
  }
  return { procRoot, pid };
}

// The environment a shipped unit provides. `PW_TMUX_REQUIRE_CGROUP=1` matches
// systemd/pw-tmux-server.service and the client units.
export function ownerEnv({ procRoot }) {
  return { PW_TMUX_PROC_ROOT: procRoot, PW_TMUX_REQUIRE_CGROUP: '1' };
}

// One call for the common case: helper on PATH, server marked, env produced.
export function ownedTmuxFixture({ socket, dir, basePath = process.env.PATH, env = {} }) {
  const bin = installOwnerHelper(dir);
  // A fixture with no explicit mode models the backward-compatible host owner.
  // Return that decision to the spawned helper as well as using it to build fake
  // /proc; otherwise a container-mode parent makes the two halves disagree.
  const fixtureEnv = { PW_DEPLOY_MODE: 'host', ...env };
  const { procRoot } = markOwnedServer({ socket, dir, env: fixtureEnv });
  return { PATH: `${bin}:${basePath}`, ...fixtureEnv, ...ownerEnv({ procRoot }) };
}
