// The ownership gate, for the in-process (JS) server-creation seams.
//
// `scripts/pw-tmux-assert-owner` is the same gate for the shell entrypoints.
// Both sit on `app/tmux-owner.js`, so the dashboard, the orchestrator adapter and
// the shell scripts cannot drift apart about what "owned" means — six copies of a
// security check is how the previous attempt ended up with a gate that was true
// of one entrypoint only.
//
// FAIL CLOSED, ALWAYS. Round 8 recorded two fail-open paths in the superseded
// candidate: a missing helper made terminal creation skip the gate and create the
// server anyway, and the dashboard bypassed the gate entirely. So:
//
//   * a refusal throws;
//   * an unavailable/unusable tmux, /proc or helper throws;
//   * there is deliberately no "gate unavailable, proceed" branch to reach.
//
// The one intentional exemption is the OWNER itself: `pw-tmux-keepalive.sh`
// creates the server by design and proves ownership afterwards rather than
// gating itself into a deadlock. `PW_TMUX_OWNER_BOOTSTRAP=1` marks that path, and
// nothing else sets it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OWNER_MARKER_OPTION, OWNER_MARKER_VALUE, assessOwnership, expectedOwnerCgroup } from './tmux-owner.js';

const execFileAsync = promisify(execFile);

async function tmuxCapture(env, args) {
  const socket = env.PW_TMUX_SOCKET ? ['-L', env.PW_TMUX_SOCKET] : [];
  try {
    const { stdout } = await execFileAsync('tmux', [...socket, ...args], { timeout: 10000, env });
    return String(stdout || '').trim();
  } catch {
    return null;
  }
}

export class TmuxOwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TmuxOwnershipError';
    this.code = 'PW_TMUX_FOREIGN_SERVER';
  }
}

// Throws unless the live server on the target socket is genuinely ours.
export async function assertTmuxOwner({ env = process.env, capture = tmuxCapture } = {}) {
  // The owner unit bootstrapping its own server is the one caller that must not
  // be gated — it is the thing that makes ownership true in the first place.
  if (String(env.PW_TMUX_OWNER_BOOTSTRAP || '') === '1') return { owned: true, reason: 'owner bootstrap' };

  const expectedOwner = expectedOwnerCgroup(env);
  const procRoot = env.PW_TMUX_PROC_ROOT || '/proc';

  const pidText = await capture(env, ['display-message', '-p', '#{pid}']);
  const pid = pidText && /^\d+$/.test(pidText) ? Number(pidText) : null;
  const marker = pid ? ((await capture(env, ['show-options', '-sv', OWNER_MARKER_OPTION])) || '') : '';

  const verdict = assessOwnership({ pid, procRoot, expectedOwner, expectedMarker: OWNER_MARKER_VALUE, marker });

  // The MARKER is always required: it is a server option only the owner sets, so
  // a client-created server can never carry it. The CGROUP half is defence in
  // depth against something that can set options on the server, and is enforced
  // where a cgroup comparison is meaningful — the owner unit and the client units
  // set PW_TMUX_REQUIRE_CGROUP=1. Round 8 recorded that a same-cgroup comparison
  // proves nothing, so the cgroup branch is exercised against a controlled /proc
  // (test/tmux-owner.test.mjs) and is never presented as proof on its own.
  const requireCgroup = String(env.PW_TMUX_REQUIRE_CGROUP || '') === '1';
  if (verdict.markerOk && (verdict.cgroupOk || !requireCgroup)) return verdict;

  throw new TmuxOwnershipError(
    `refusing to create a tmux session: ${verdict.reason}. `
    + `Expected owner cgroup ${expectedOwner}. `
    + 'If this host ran terminals before the owner unit existed, migrate deliberately: '
    + 'pw-tmux-save && tmux kill-server && systemctl restart pw-tmux-server.service',
  );
}
