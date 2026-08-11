// Who owns the live tmux server?
//
// ============================================================================
// WHY THIS EXISTS
//
// Every project's shells, running agents and scrollback live in ONE tmux server.
// Whichever process creates that server decides which cgroup it lands in, and
// therefore what can reap it. If a ttyd terminal wins the race and creates it,
// the server lives in that terminal's unit — so restarting or stopping one
// project's terminal takes down every project's sessions. A dedicated owner unit
// only fixes that if the server is genuinely ITS server.
//
// The superseded candidate (PR #24, reference-only) asked a weaker question:
// "does a `_keepalive` session exist on this socket". Independent review
// demonstrated the gap — with a client-created server already present, the owner
// unit reported ready and released the `After=` barrier for every terminal while
// supervising a foreign server in a ttyd's cgroup.
//
// So ownership here is TWO independent facts, and both must hold:
//
//   1. MARKER  — the server carries our owner marker. It is a tmux *server
//      option*, not an environment variable, so it belongs to the server itself
//      and cannot be inherited by a client that merely happens to be launched by
//      us. (An env-var marker would also make the cold-start race test vacuous:
//      the racing client would inherit it and look like the owner.)
//
//   2. CGROUP  — the server process actually lives in the expected owner's
//      cgroup. This is the fact that unit text and session names cannot fake.
//
// Neither alone is sufficient. The marker without the cgroup is the exact
// adopt-don't-move case above. The cgroup without the marker is a server some
// other process created inside our unit.
//
// TESTING NOTE, recorded because it invalidated the previous attempt: in a test
// where every process shares the runner's cgroup, the cgroup half cannot
// discriminate — only the marker can. The cgroup branch is therefore exercised
// against a controlled `/proc` (see `procRoot`), and a same-cgroup comparison is
// never described as proof.
//
// PORTABILITY: nothing here names a deployment. The expected owner is resolved
// from configuration with mode-appropriate defaults, so one frozen SHA serves a
// host install and a container install alike.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

// A tmux user option on the SERVER (`tmux set-option -s @pw_owner …`), readable
// with `tmux show-options -sv @pw_owner`. Server-scoped is the whole point.
export const OWNER_MARKER_OPTION = '@pw_owner';

// The value we stamp. Constant, non-secret, and not environment-specific.
export const OWNER_MARKER_VALUE = 'pw-owner';

// Default owner unit per deployment mode. `PW_TMUX_OWNER_CGROUP` overrides both,
// so a topology we have not anticipated is configuration rather than a fork.
export const HOST_OWNER_UNIT = 'pw-tmux-server.service';
export const CONTAINER_OWNER_UNIT = 'pw-tmux.service';

export function expectedOwnerCgroup(env = {}) {
  if (env.PW_TMUX_OWNER_CGROUP) return env.PW_TMUX_OWNER_CGROUP;
  return String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container'
    ? CONTAINER_OWNER_UNIT
    : HOST_OWNER_UNIT;
}

// Operator recovery follows the active topology. Ownership checks may be shared,
// but telling a container operator to restart the host-only unit is not useful.
export function ownerRemediation(env = {}) {
  const container = String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container';
  const unit = container ? CONTAINER_OWNER_UNIT : HOST_OWNER_UNIT;
  return `pw-tmux-save && tmux kill-server && systemctl restart ${unit}`;
}

// The cgroup of a process, from `/proc/<pid>/cgroup`. `procRoot` is injectable so
// the discriminating case can be exercised against controlled contents instead of
// against a runner where every process shares one cgroup.
//
// Prefers the cgroup v2 unified line (`0::/…`); falls back to the last v1 line so
// a hybrid host still answers. A pid that is gone returns null — "I could not
// tell" is never allowed to read as "it matched".
export function readProcessCgroup({ pid, procRoot = '/proc' }) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(procRoot, String(pid), 'cgroup'), 'utf8');
  } catch {
    return null;
  }
  const lines = String(text).split('\n').filter(Boolean);
  const unified = lines.find((l) => l.startsWith('0::'));
  if (unified) return unified.slice(3);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const parts = last.split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : null;
}

// Does this cgroup path belong to the expected owner unit?
//
// Compared as a whole PATH SEGMENT, so `not-pw-tmux-server.service.d` and
// `pw-tmux-server.service.evil` do not pass on a substring match.
export function cgroupMatchesOwner(cgroup, expectedOwner) {
  if (!cgroup || !expectedOwner) return false;
  return String(cgroup).split('/').filter(Boolean).includes(String(expectedOwner));
}

// The whole verdict: metadata only, and a reason a human can act on.
export function assessOwnership({ pid, procRoot = '/proc', expectedOwner, expectedMarker = OWNER_MARKER_VALUE, marker = '' }) {
  if (!pid) {
    return { owned: false, markerOk: false, cgroupOk: false, pid: null, cgroup: null, reason: 'no running tmux server on the target socket' };
  }
  const cgroup = readProcessCgroup({ pid, procRoot });
  const markerOk = String(marker || '') === String(expectedMarker);
  const cgroupOk = cgroupMatchesOwner(cgroup, expectedOwner);

  let reason = 'the live tmux server is owned by this unit';
  if (!markerOk && !cgroupOk) {
    reason = `foreign tmux server (pid ${pid}): owner marker absent and cgroup ${cgroup || 'unknown'} is not ${expectedOwner}`;
  } else if (!markerOk) {
    reason = `tmux server (pid ${pid}) is in the expected cgroup but carries no owner marker — it was created by something other than the owner`;
  } else if (!cgroupOk) {
    reason = `tmux server (pid ${pid}) carries the owner marker but its cgroup ${cgroup || 'unknown'} is not ${expectedOwner} — it is being supervised, not owned`;
  }
  return { owned: markerOk && cgroupOk, markerOk, cgroupOk, pid: Number(pid), cgroup, reason };
}
