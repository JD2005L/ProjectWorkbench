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
import { hostTerminalUser } from './terminal-owner.js';

const execFileAsync = promisify(execFile);

// The probe must reach the SAME tmux server the seam it guards will drive.
//
// A gate is only meaningful if it inspects the server the executor talks to. In
// host mode the dashboard process runs as root while the panes — and therefore
// the shared server — live on the pane account's per-user socket, which is why
// server.js's tmux() hops through `sudo -u <account>`. This capture used to exec
// a bare `tmux`, so as root it inspected root's OWN (empty) default socket and
// reported "no running tmux server on the target socket" about a perfectly
// healthy host: the gate refused every new-session/new-window/recycle, and the
// refusal text sent the operator to a save/kill/restart migration that could not
// fix it because the new server would land on the pane account's socket too.
//
// The shell seams never had this bug — project-terminal@.service already runs as
// the pane account, so `pw-tmux-assert-owner` was on the right socket by virtue
// of its unit. The orchestrator adapter injects its own executor. Only this
// default capture, used by the root-running dashboard, could drift — so it now
// resolves the account through hostTerminalUser(), exactly as tmux() does, and
// the two cannot name different accounts.
export function tmuxProbeArgv(env, args) {
  const socket = env.PW_TMUX_SOCKET ? ['-L', env.PW_TMUX_SOCKET] : [];
  const argv = [...socket, ...args];
  return String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container'
    ? ['tmux', argv]
    : ['sudo', ['-u', hostTerminalUser(env), 'tmux', ...argv]];
}

async function tmuxCapture(env, args) {
  const [command, argv] = tmuxProbeArgv(env, args);
  try {
    const { stdout } = await execFileAsync(command, argv, { timeout: 10000, env });
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

  // THE FULL VERDICT, UNCONDITIONALLY. Ownership is one contract and it does not
  // get to be weaker on the side that runs as root.
  //
  // This previously accepted a marker-only/foreign-cgroup server unless
  // PW_TMUX_REQUIRE_CGROUP=1 — a flag only the owner unit set. So the dashboard
  // and every other JS seam ran fail-open against precisely the adopt-don't-move
  // state the shell gate refuses outright: markerOk true, cgroupOk false,
  // owned false, shell refuses, JS accepted. There is no flag to reach that
  // branch with any more, because there is no branch.
  //
  // Round 8's warning still holds and is honoured elsewhere: a same-cgroup
  // comparison proves nothing, so the cgroup branch is exercised against a
  // CONTROLLED /proc (test/tmux-owner.test.mjs, test/tmux-owner-shipping.test.mjs)
  // and fixtures supply a /proc saying what a real host would say — they do not
  // switch the check off.
  if (verdict.owned) return verdict;

  throw new TmuxOwnershipError(
    `refusing to create a tmux session: ${verdict.reason}. `
    + `Expected owner cgroup ${expectedOwner}. `
    + 'If this host ran terminals before the owner unit existed, migrate deliberately: '
    + 'pw-tmux-save && tmux kill-server && systemctl restart pw-tmux-server.service',
  );
}
