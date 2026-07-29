// Per-user CLI credentials (opt-in via PW_PER_USER_CLAUDE).
//
// A project is "owned" by its primaryUser. When the feature is on, that project's
// terminal runs Claude against the owner's OWN config directory, so the owner's
// login/seat is used instead of the shared box login, and Copilot rides on the
// owner's GitHub token.
//
// Two properties this module exists to guarantee:
//
//  1. Ownership. The dashboard runs as root; the pane does not (see
//     terminal-owner.js). Every path created here is handed to the pane's account
//     or the operation FAILS — a root-owned 0700 config dir the pane cannot read
//     is worse than no per-user credentials at all, because the agent then breaks
//     instead of falling back.
//
//  2. Token placement. The GitHub token must never travel as an argv token.
//     tmux keeps a pane's start command for the life of the pane
//     (`tmux list-panes -F '#{pane_start_command}'`) and every pane on a workbench
//     runs as the same OS account, so `env GH_TOKEN=<secret> bash` publishes one
//     user's token to every other project's terminal. It is written to a 0600
//     file that the pane's shell sources instead — the same shape the existing
//     syncProjectCredentials() uses for git.
//
// NOTE: all sessions still run as one OS user. This buys per-user accountability
// and correct seat attribution, NOT hard OS isolation between users on the box.

import path from 'node:path';
import crypto from 'node:crypto';

export function safeUserName(u) {
  const cleaned = String(u || '').replace(/[^A-Za-z0-9._-]/g, '_');
  // '.' and '..' pass the character filter untouched but would escape the
  // credential base through path.join ('/srv/pw-users' + '..' -> '/srv'), so any
  // all-dots name collapses to a harmless placeholder.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '_';
  return cleaned;
}
export function userCredRoot(base, username) {
  return path.join(base, safeUserName(username));
}
export function userClaudeConfigDir(base, username) {
  return path.join(userCredRoot(base, username), 'claude');
}
export function userSessionEnvFile(base, username) {
  return path.join(userCredRoot(base, username), 'session-env.sh');
}

// A stable, NON-SECRET identifier for "which credentials is this session on".
// Stamped onto the tmux session so a later change (feature toggled, primaryUser
// reassigned, token rotated) is detectable on an already-running session. The
// token is hashed, never stored: the stamp is readable by anyone who can run
// `tmux show-options`.
export function credentialFingerprint({ username = '', configDir = '', ghToken = '' } = {}) {
  return crypto.createHash('sha256').update(`${username}\0${configDir}\0${ghToken}`).digest('hex').slice(0, 16);
}

// POSIX single-quoting: close the quote, escape the literal quote, reopen.
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Sentinel fingerprint for "this session uses the shared box login".
export const CREDENTIALS_OFF = 'off';

// Is a live session running on credentials other than the ones it would be given
// today? Panes inherit their environment at creation, so toggling
// PW_PER_USER_CLAUDE, reassigning a project's primaryUser, or rotating a token
// cannot re-key a session that is already running — the drift has to be reported
// and reconciled deliberately, because recreating a session destroys whatever is
// running in it.
export function sessionCredentialState({ perUserEnabled = false, desiredKey = CREDENTIALS_OFF, stampedKey = '' } = {}) {
  if (!perUserEnabled) return { stale: false, reason: 'disabled' };
  if (stampedKey && stampedKey === desiredKey) return { stale: false, reason: 'current' };
  if (!stampedKey) {
    // No stamp: the session predates stamping or was made by an older build.
    // With per-user credentials in play we cannot claim it is current, but with
    // nothing to be stale about there is no point alarming anyone.
    return desiredKey === CREDENTIALS_OFF ? { stale: false, reason: 'current' } : { stale: true, reason: 'unstamped' };
  }
  return { stale: true, reason: 'changed' };
}

export function renderSessionEnvFile(vars = {}) {
  const lines = [
    '# Project Workbench per-user session environment — generated, do not edit.',
    '# Sourced as the pane shell rcfile so the value never appears in argv',
    "# (tmux retains a pane's start command for the life of the pane).",
  ];
  for (const [key, value] of Object.entries(vars)) {
    if (value) lines.push(`export ${key}=${shSingleQuote(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

// Create/refresh a user's credential material and hand every path we own to the
// pane's account. Resolves to { configDir, envFile, fingerprint }; REJECTS when
// ownership cannot be established, so the caller can fall back to the shared
// login rather than pointing an agent at an unreadable directory.
//
// `owner` is null when the dashboard and the pane already share an account, in
// which case no chown is attempted and behaviour is byte-identical to before.
export async function ensureUserCredentials({
  fsp,
  base,
  username,
  ghToken = '',
  sharedClaudeJson = '',
  owner = null,
}) {
  const configDir = userClaudeConfigDir(base, username);
  const credRoot = userCredRoot(base, username);
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });

  const claim = async (target) => {
    if (!owner) return;
    const st = await fsp.stat(target);
    if (st.uid === owner.uid && st.gid === owner.gid) return;
    // Deliberately unguarded: a failure here must reject the whole operation.
    await fsp.chown(target, owner.uid, owner.gid);
  };

  // `mkdir -p` may have created the base and the per-user root too, and the pane
  // has to traverse both to reach its config dir — hand over every level.
  for (const level of [base, credRoot, configDir]) await claim(level);

  // Seed the managed MCP servers from the shared config so a per-user Claude
  // still gets team MCP (teamkb / pulse / skillhub). Only on first creation:
  // never clobber a config the user has since edited.
  const cfgFile = path.join(configDir, '.claude.json');
  let seeded = false;
  try {
    await fsp.access(cfgFile);
  } catch {
    let mcpServers = {};
    if (sharedClaudeJson) {
      try {
        const shared = JSON.parse(await fsp.readFile(sharedClaudeJson, 'utf8'));
        if (shared && typeof shared.mcpServers === 'object' && shared.mcpServers) mcpServers = shared.mcpServers;
      } catch { /* no shared config, or unparseable: seed an empty one */ }
    }
    await fsp.writeFile(cfgFile, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
    seeded = true;
  }
  await claim(cfgFile);

  const envFile = userSessionEnvFile(base, username);
  if (ghToken) {
    await fsp.writeFile(envFile, renderSessionEnvFile({ GH_TOKEN: ghToken }), { mode: 0o600 });
    await fsp.chmod(envFile, 0o600);
    await claim(envFile);
  } else {
    // The owner's token was removed: drop a stale file rather than leaving a
    // revoked secret on disk and in every future session.
    await fsp.rm(envFile, { force: true }).catch(() => {});
  }

  return {
    configDir,
    envFile: ghToken ? envFile : '',
    seeded,
    fingerprint: credentialFingerprint({ username, configDir, ghToken }),
  };
}
