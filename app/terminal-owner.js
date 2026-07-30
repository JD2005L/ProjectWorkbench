// Which OS account do agent panes actually run as?
//
// This is NOT the same question as terminal-priv.js's setpriv drop, and
// conflating the two is a real defect. The drop exists only in CONTAINER mode;
// `resolveTerminalPriv()` deliberately reports `enabled: false` in host mode
// because PW there already spawns panes unprivileged via `sudo -u admin tmux`.
//
// But "no setpriv drop" does not mean "the pane runs as root". In BOTH modes the
// dashboard process runs as root while the pane runs as a NON-root account:
//
//   container + PW_TERMINAL_UID : root tmux() -> setpriv --reuid <uid>
//   host                        : root node  -> sudo -u admin tmux
//   container, no PW_TERMINAL_UID: tmux runs as root, pane is root  (no handover)
//
// So anything root creates on a pane's behalf — a per-user credential directory,
// for instance — must be handed to that account or the pane cannot read it.
// Gating that handover on terminal-priv's `enabled` flag silently skips host
// mode, leaving a root-owned 0700 directory the pane can neither traverse nor
// write, and the feature dead on arrival.
//
// Everything here fails CLOSED: an account that cannot be resolved to a plain,
// non-root passwd entry produces an error, never a guess.

import { resolveTerminalPriv } from './terminal-priv.js';

// The account host-mode PW runs panes as. Exported so server.js's tmux() and the
// ownership resolution below cannot drift apart — they must name the same user.
export const HOST_TERMINAL_USER = 'admin';

// PW_HOST_TERMINAL_USER is an explicit, opt-in override of HOST_TERMINAL_USER —
// NOT a fallback. Unset (every real deployment), this returns the literal
// 'admin' constant unconditionally, byte-identical to before this existed. It
// exists so a test (or a deployment that genuinely runs panes as a different
// account) can point host-mode resolution at a DIFFERENT but still real,
// sudo-able account explicitly — it never activates itself when 'admin' fails
// to resolve. server.js's tmux() must call this too (never re-read
// HOST_TERMINAL_USER directly) so the two can never name different accounts.
export function hostTerminalUser(env = {}) {
  return env.PW_HOST_TERMINAL_USER || HOST_TERMINAL_USER;
}

function deployMode(env = {}) {
  return String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host';
}

// Conservative POSIX account-name check. The name reaches `getent passwd <name>`
// as an argv element (no shell), so this is defence in depth rather than the
// only thing standing between us and injection — but it also rejects the
// leading-dash names that would be parsed as options.
export function isValidAccountName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 32 && /^[A-Za-z_][A-Za-z0-9._-]*\$?$/.test(name);
}

// Parse one passwd line into a validated entry, or null when it is unusable.
// Rejects: wrong field count, non-numeric ids, uid/gid 0 (never hand a user's
// private credentials to root), and a missing or relative home directory.
export function parsePasswdEntry(line, expectName = '') {
  const fields = String(line ?? '').split(':');
  if (fields.length !== 7) return null;
  const name = fields[0];
  const uidStr = fields[2];
  const gidStr = fields[3];
  const home = fields[5];
  if (!name) return null;
  if (expectName && name !== expectName) return null;
  if (!/^\d+$/.test(uidStr) || !/^\d+$/.test(gidStr)) return null;
  const uid = Number(uidStr);
  const gid = Number(gidStr);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) return null;
  if (uid === 0 || gid === 0) return null;
  if (!home || !home.startsWith('/')) return null;
  return { name, uid, gid, home };
}

// What kind of ownership handover does this deployment need?
//   { kind: 'none' }                      dashboard and pane share an account
//   { kind: 'numeric', uid, gid, user }   container drop; the uid is authoritative
//   { kind: 'named', user }               host mode; the uid must come from passwd
//   { kind: 'invalid', reason }           configured but unusable -> refuse
export function terminalOwnerPlan(env = {}) {
  if (deployMode(env) === 'container') {
    const priv = resolveTerminalPriv(env);
    if (!priv.enabled) return { kind: 'none', reason: 'container-root' };
    const uid = Number(priv.uid);
    const gid = Number(priv.gid);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
      return { kind: 'invalid', reason: `unusable PW_TERMINAL_UID/GID (${priv.uid}/${priv.gid})` };
    }
    return { kind: 'numeric', uid, gid, user: priv.user || String(uid) };
  }
  // Host mode always runs panes through `sudo -u <HOST_TERMINAL_USER> tmux`.
  return { kind: 'named', user: hostTerminalUser(env) };
}

// Build a passwd lookup. getent is tried first because it answers through NSS and
// therefore covers directory-backed accounts (PW_AUTH_MODE=ldap); /etc/passwd is
// the fallback for minimal images that ship no getent. Two entries for one name
// means an ambiguous directory: refuse rather than pick one.
export function makePasswdLookup({ execFile = null, readFile = null, passwdPath = '/etc/passwd' } = {}) {
  return async function lookup(name) {
    if (!isValidAccountName(name)) return null;
    if (execFile) {
      try {
        const { stdout } = await execFile('getent', ['passwd', name], { timeout: 5000 });
        const lines = String(stdout || '').split('\n').filter(Boolean);
        if (lines.length > 1) return null;
        if (lines.length === 1) {
          const entry = parsePasswdEntry(lines[0], name);
          if (entry) return entry;
        }
      } catch { /* getent missing or the name is unknown; fall through */ }
    }
    if (readFile) {
      try {
        const text = String(await readFile(passwdPath, 'utf8'));
        const lines = text.split('\n').filter((l) => l.startsWith(`${name}:`));
        if (lines.length === 1) return parsePasswdEntry(lines[0], name);
      } catch { /* unreadable; fall through to the refusal below */ }
    }
    return null;
  };
}

// Resolve the account that owns pane-visible files, or null when no handover is
// needed. Throws when a handover IS needed but the account cannot be resolved —
// callers must treat that as "do not hand this path to a pane".
export async function resolveTerminalOwner(env = {}, lookup = null) {
  const plan = terminalOwnerPlan(env);
  if (plan.kind === 'none') return null;
  if (plan.kind === 'invalid') throw new Error(`terminal owner: ${plan.reason}`);
  if (plan.kind === 'numeric') {
    return { uid: plan.uid, gid: plan.gid, user: plan.user, source: 'PW_TERMINAL_UID' };
  }
  if (typeof lookup !== 'function') throw new Error('terminal owner: no passwd lookup provided');
  const entry = await lookup(plan.user);
  if (!entry) throw new Error(`terminal owner: account "${plan.user}" did not resolve to a usable passwd entry`);
  return { uid: entry.uid, gid: entry.gid, user: entry.name, home: entry.home, source: 'passwd' };
}
