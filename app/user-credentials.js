// Per-user CLI credentials (opt-in via PW_PER_USER_CLAUDE).
//
// A project is "owned" by its primaryUser. When the feature is on, that project's
// terminal runs Claude against the owner's OWN config directory, so the owner's
// login/seat is used instead of the shared box login, and Copilot rides on the
// owner's GitHub token.
//
// ============================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
//   The root dashboard must never perform a filesystem operation on a path that
//   the unprivileged terminal account controls.
//
// The credential tree lives under PW_USER_CRED_BASE (default /home/admin/pw-users)
// and is, by design, owned by the account the panes run as. That account is
// shared by every terminal on the box. So if root were to mkdir/write/chown/rm
// inside that tree, any user with a terminal could plant a symlink and have root
// follow it:
//
//   ln -s /etc/sudoers.d/pwn /home/admin/pw-users/<user>/session-env.sh
//
// and root's writeFile would create a root-owned file with attacker-chosen
// content, and the follow-up chown would hand it to the attacker. That is a
// straight local privilege escalation from "has a project terminal" to root.
//
// The fix is structural rather than defensive: the credential tree is written by
// a helper process running AS the terminal account (see credential-writer.mjs),
// with the job delivered on stdin. Root does not touch those paths, so there is
// no confused deputy to exploit — the helper has exactly the authority the
// attacker already had. No chown is needed either, because the files are created
// by their eventual owner.
//
// applyCredentialJob() is additionally hardened with O_NOFOLLOW and lstat checks.
// That is defence in depth, not the primary control: it also protects the
// in-process path used when the dashboard and the panes already share an account.
// ============================================================================
//
// Token placement. The GitHub token must never travel as an argv token. tmux
// keeps a pane's start command for the life of the pane
// (`tmux list-panes -F '#{pane_start_command}'`) and every pane on a workbench
// runs as the same OS account, so `env GH_TOKEN=<secret> bash` publishes one
// user's token to every other project's terminal. It is written to a 0600 file
// that the pane's shell sources instead — the same shape syncProjectCredentials()
// already uses for git. The same reasoning applies to the helper: the job travels
// on stdin, never on its command line.
//
// SCOPE: all panes still run as ONE OS account. This buys per-user accountability
// and correct seat attribution. It is NOT cross-user secret isolation — see
// docs/per-user-claude-credentials.md.

import path from 'node:path';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';

// ---------------------------------------------------------------------------
// Username -> path segment
// ---------------------------------------------------------------------------

// Percent-encode anything outside [A-Za-z0-9_-]. This is INJECTIVE: '%' is not
// in the safe set, so every '%' in the output starts an escape and the mapping
// can be reversed unambiguously (see decodeUserName).
//
// Injectivity is a security property, not cosmetics. The previous
// "replace unsafe characters with _" scheme mapped the distinct usernames
// '.', '..' and '_' all onto the single directory '_', which would have made
// three different people share one Claude login and one GitHub token.
//
// It also removes path traversal by construction: '.' and '/' are escaped, so an
// encoded segment can never be '.', '..', or contain a separator.
export function encodeUserName(u) {
  const name = String(u ?? '');
  if (!name) throw new Error('credential username must not be empty');
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  // Refuse rather than hash-truncate: a lossy fallback would reintroduce exactly
  // the collision class this function exists to remove.
  if (Buffer.byteLength(out) > 255) throw new Error('credential username too long to encode');
  return out;
}

export function decodeUserName(segment) {
  const s = String(segment ?? '');
  if (!/^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})*$/.test(s)) return null;
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '%') { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function isEncodedUserName(segment) {
  const s = String(segment ?? '');
  if (!s || s.length > 255) return false;
  if (!/^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})*$/.test(s)) return false;
  // Round-trip: only a canonical encoding is ours. Rejects '%2e' (lowercase) and
  // gratuitous escaping of safe characters.
  const decoded = decodeUserName(s);
  return decoded !== null && encodeUserName(decoded) === s;
}

export function userCredRoot(base, username) {
  return path.join(base, encodeUserName(username));
}
/**
 * Keys in settings.json that are PW INSTANCE configuration rather than personal preference, and
 * so must exist in every per-user config dir. The feature's contract is that enabling per-user
 * credentials changes WHOSE identity a project runs as, not how the workbench behaves -- so
 * anything that alters behaviour has to come across, or turning the flag on silently changes it.
 *
 *   hooks                             hooks.Stop runs pw-stop-hook.sh, which writes the marker
 *                                     under /var/lib/project-workbench/pending that the rail
 *                                     renders as a project's amber "turn done" flag.
 *   preferredNotifChannel             'terminal_bell' makes Claude ring the BEL that tmux records
 *                                     as window_bell_flag -- the live half of that same flag.
 *   permissions                       the instance's tool-permission posture. Pre-migration EVERY
 *                                     project terminal ran on the shared config, so this was
 *                                     already in force for every owner; seeding it restores that
 *                                     rather than widening anything. Carries both defaultMode and
 *                                     an MCP allow-list, so review it when onboarding an owner.
 *   skipDangerousModePermissionPrompt pairs with the above; without it a posture the operator has
 *                                     already chosen re-prompts on every new session.
 *   effortLevel                       the instance's reasoning-effort default.
 *
 * Deliberately NOT seeded: `model`, which the wrapper leaves unset ON PURPOSE so each user picks
 * their own, plus `theme` and `enabledPlugins` -- personal, and Claude Code writes them itself.
 *
 * Merge is fill-only: a key the user has already set is never overwritten, so seeding a posture
 * still leaves them free to choose a different one.
 */
export const SEEDED_SETTINGS_KEYS = Object.freeze([
  'hooks',
  'preferredNotifChannel',
  'permissions',
  'skipDangerousModePermissionPrompt',
  'effortLevel',
]);

/**
 * Files copied from the shared $HOME/.copilot into a per-user COPILOT_HOME on first
 * creation. Same contract as SEEDED_SETTINGS_KEYS: enabling per-user credentials changes
 * WHOSE seat a tab spends, not what the agent is told or which tools it can reach.
 *
 *   copilot-instructions.md  Copilot's equivalent of CLAUDE.md, and one of the two live
 *                            copies of the standing workspace-boundary guardrail.
 *   mcp-config.json          the team MCP servers, so a per-user Copilot still has them.
 *
 * NOT seeded: config.json / *-state.json / session-store.db -- per-person state and any
 * stored login, which is the whole point of splitting the directory.
 */
export const SEEDED_COPILOT_FILES = Object.freeze(['copilot-instructions.md', 'mcp-config.json']);

export function userClaudeConfigDir(base, username) {
  return path.join(userCredRoot(base, username), 'claude');
}
export function userSessionEnvFile(base, username) {
  return path.join(userCredRoot(base, username), 'session-env.sh');
}

// Copilot CLI's config/state dir. COPILOT_HOME is its documented override
// (`copilot help environment`) and the exact analogue of CLAUDE_CONFIG_DIR:
// without it every user's Copilot sessions, history, skills and any stored
// login stay pooled in the ONE shared $HOME/.copilot, so per-user tokens would
// still leave a single shared Copilot identity on disk for anyone to /login
// over.
export function userCopilotConfigDir(base, username) {
  return path.join(userCredRoot(base, username), 'copilot');
}

// ---------------------------------------------------------------------------
// Session fingerprint
// ---------------------------------------------------------------------------

// A stable, NON-SECRET identifier for "which credentials is this session on".
// Stamped onto the tmux session so a later change (feature toggled, primaryUser
// reassigned, token rotated) is detectable on an already-running session. The
// token is hashed, never stored: the stamp is readable by anyone who can run
// `tmux show-options`.
export function credentialFingerprint({ username = '', configDir = '', ghToken = '' } = {}) {
  return crypto.createHash('sha256').update(`${username}\0${configDir}\0${ghToken}`).digest('hex').slice(0, 16);
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
  // While disabled, the desired state is unconditionally the shared/off
  // login — enforced here, not merely assumed of callers, so a caller that
  // passes a stale/wrong desiredKey while disabled still gets the right
  // answer. A session stamped with a REAL per-user fingerprint left over
  // from when the feature was on is exactly as stale as any other mismatch;
  // it must not be reported "fine" just because the feature is off now.
  const effectiveDesired = perUserEnabled ? desiredKey : CREDENTIALS_OFF;
  if (stampedKey && stampedKey === effectiveDesired) return { stale: false, reason: 'current' };
  if (!stampedKey) {
    // No stamp: the session predates stamping or was made by an older build.
    // With per-user credentials in play we cannot claim it is current, but with
    // nothing to be stale about there is no point alarming anyone.
    return effectiveDesired === CREDENTIALS_OFF ? { stale: false, reason: 'current' } : { stale: true, reason: 'unstamped' };
  }
  return { stale: true, reason: 'changed' };
}

// POSIX single-quoting: close the quote, escape the literal quote, reopen.
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

// ---------------------------------------------------------------------------
// No-follow filesystem primitives
// ---------------------------------------------------------------------------

// mkdir that refuses to accept a symlink in place of the directory. Plain
// mkdir(2) does not follow a symlink for the final component (it fails EEXIST),
// but that EEXIST is indistinguishable from "already a real directory", so the
// lstat is what actually closes the hole.
async function mkdirChecked(fsp, dir, { recursive = false, enforceMode = false } = {}) {
  try {
    await fsp.mkdir(dir, { recursive, mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const st = await fsp.lstat(dir);
  if (st.isSymbolicLink()) throw new Error(`refusing to use a symlinked credential path: ${dir}`);
  if (!st.isDirectory()) throw new Error(`credential path is not a directory: ${dir}`);
  // A directory that already existed keeps whatever mode it was made with, which
  // for a plain `mkdir -p` is 0755. Tighten the levels we own through an
  // O_NOFOLLOW descriptor, so the check above cannot be raced by a swap. The
  // configured base is left alone: it may legitimately be an operator-managed
  // shared directory.
  if (enforceMode && (st.mode & 0o777) !== 0o700) {
    const fh = await fsp.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { await fh.chmod(0o700); } finally { await fh.close(); }
  }
}

// Open for writing, refusing to follow a symlink at the final component, then
// set the mode through the descriptor so a swap after open cannot redirect it.
async function writeChecked(fsp, file, data, mode = 0o600) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const fh = await fsp.open(file, flags, mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

// Is there a usable regular file here? A symlink or any other non-regular type
// found in our own tree is hostile or corrupt; remove it so the caller recreates
// a real file. unlink(2) removes the link itself and never follows it.
async function regularFileExists(fsp, file) {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isFile()) return true;
  await fsp.rm(file, { recursive: true, force: true });
  return false;
}

// Copy a shared file into the per-user tree, but only when the user does not
// have their own. Fill-only, exactly like the settings.json merge: a file the
// user has since edited is never clobbered, and a shared file that does not
// exist is simply not seeded.
async function seedFileIfAbsent(fsp, target, sourcePath) {
  if (!sourcePath) return false;
  if (await regularFileExists(fsp, target)) return false;
  let body;
  try { body = await fsp.readFile(sourcePath, 'utf8'); }
  catch { return false; }   // no shared file, or unreadable: nothing to seed
  await writeChecked(fsp, target, body);
  return true;
}

// ---------------------------------------------------------------------------
// The filesystem job
// ---------------------------------------------------------------------------

// Everything that touches the credential tree. Runs EITHER in-process (when the
// dashboard already is the terminal account) OR inside credential-writer.mjs
// after the privilege drop. It never chowns: whoever runs it is the owner.
export async function applyCredentialJob({ fsp, base, username, ghToken = '', sharedClaudeJson = '', sharedSettings = '', sharedClaudeMd = '', sharedCopilotHome = '' }) {
  const credRoot = userCredRoot(base, username);
  const configDir = userClaudeConfigDir(base, username);
  const copilotHome = userCopilotConfigDir(base, username);

  // The base itself may legitimately need creating; below it we build one level
  // at a time so a planted symlink cannot smuggle us out of the tree.
  await mkdirChecked(fsp, base, { recursive: true });
  await mkdirChecked(fsp, credRoot, { enforceMode: true });
  await mkdirChecked(fsp, configDir, { enforceMode: true });
  await mkdirChecked(fsp, copilotHome, { enforceMode: true });

  // Seed the managed MCP servers from the shared config so a per-user Claude
  // still gets team MCP (teamkb / pulse / skillhub). Only on first creation:
  // never clobber a config the user has since edited.
  const cfgFile = path.join(configDir, '.claude.json');
  let seeded = false;
  if (!(await regularFileExists(fsp, cfgFile))) {
    let mcpServers = {};
    if (sharedClaudeJson) {
      try {
        const shared = JSON.parse(await fsp.readFile(sharedClaudeJson, 'utf8'));
        if (shared && typeof shared.mcpServers === 'object' && shared.mcpServers) mcpServers = shared.mcpServers;
      } catch { /* no shared config, or unparseable: seed an empty one */ }
    }
    await writeChecked(fsp, cfgFile, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    seeded = true;
  }

  // settings.json needs MERGE semantics, not the "only on first creation" guard .claude.json
  // uses above. Claude Code writes this file ITSELF the moment a user changes theme or model, so
  // an absent-file guard loses the race and the hooks never land -- which is exactly how enabling
  // per-user credentials silently killed the turn-done flag for every project on 2026-09-14
  // (the per-user settings.json existed, holding only {model, theme, enabledPlugins}).
  // Only absent keys are filled, so a user's own preferences are never touched.
  const settingsFile = path.join(configDir, 'settings.json');
  if (sharedSettings) {
    try {
      const shared = JSON.parse(await fsp.readFile(sharedSettings, 'utf8')) || {};
      let current = {};
      if (await regularFileExists(fsp, settingsFile)) {
        try { current = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) || {}; }
        catch { current = {}; }   // unparseable: treat as empty rather than refusing to seed
      }
      let changed = false;
      for (const key of SEEDED_SETTINGS_KEYS) {
        if (shared[key] !== undefined && current[key] === undefined) { current[key] = shared[key]; changed = true; }
      }
      if (changed) await writeChecked(fsp, settingsFile, `${JSON.stringify(current, null, 2)}\n`);
    } catch { /* no shared settings, or unreadable: leave the per-user file alone */ }
  }

  const envFile = userSessionEnvFile(base, username);
  if (ghToken) {
    await regularFileExists(fsp, envFile); // clears a planted symlink first
    await writeChecked(fsp, envFile, renderSessionEnvFile({ GH_TOKEN: ghToken }));
  } else {
    // The owner's token was removed: drop a stale file rather than leaving a
    // revoked secret on disk and in every future session.
    await fsp.rm(envFile, { force: true }).catch(() => {});
  }

  // CLAUDE.md is INSTRUCTIONS, not preference, and the shared one carries the
  // standing workspace-boundary / no-attack-tooling guardrail every PW agent is
  // supposed to start with. Pointing CLAUDE_CONFIG_DIR at an unseeded per-user
  // dir silently removed it ("Instructions no longer present") and had to be
  // repaired by hand for each owner on 2026-09-14. Per-launcher mode materializes
  // a dir for every PERSON rather than every project owner, which multiplies that
  // gap, so it is seeded here instead.
  await seedFileIfAbsent(fsp, path.join(configDir, 'CLAUDE.md'), sharedClaudeMd);

  // The same two classes of file for Copilot: its instructions (the other live
  // copy of that guardrail) and its MCP servers. Fill-only, like .claude.json.
  if (sharedCopilotHome) {
    for (const name of SEEDED_COPILOT_FILES) {
      await seedFileIfAbsent(fsp, path.join(copilotHome, name), path.join(sharedCopilotHome, name));
    }
  }

  return { configDir, copilotHome, envFile: ghToken ? envFile : '', seeded };
}

// Remove credential trees that no longer belong to a current user, so a deleted
// user's Claude login and GitHub token do not linger on disk.
export async function pruneUserCredentials({ fsp, base, keep = [] }) {
  const keepSet = new Set();
  for (const name of keep) {
    try { keepSet.add(encodeUserName(name)); } catch { /* unencodable name keeps nothing */ }
  }

  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { removed: [] };
    throw e;
  }

  const removed = [];
  for (const ent of entries) {
    if (keepSet.has(ent.name)) continue;
    // Only ever delete something that both looks like our encoding AND has our
    // layout inside it. PW_USER_CRED_BASE is operator-configurable and could be
    // pointed at a directory holding unrelated data; a prune must not become an
    // arbitrary delete because of a misconfiguration.
    if (!ent.isDirectory() || !isEncodedUserName(ent.name)) continue;
    const dir = path.join(base, ent.name);
    let ours = false;
    for (const marker of ['claude', 'session-env.sh']) {
      try { await fsp.lstat(path.join(dir, marker)); ours = true; break; } catch { /* not this one */ }
    }
    if (!ours) continue;
    await fsp.rm(dir, { recursive: true, force: true });
    removed.push(ent.name);
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Privilege drop
// ---------------------------------------------------------------------------

// Does this job need to run as somebody else? `owner` is null when the dashboard
// and the panes already share an account, and the uid comparison catches the
// same case in host mode, where the owner is resolved from passwd regardless of
// who we happen to be running as (a dev box running PW as `admin` itself).
export function credentialExecutionPlan({ owner = null, currentUid = null } = {}) {
  if (!owner) return { drop: false, reason: 'shared-account' };
  if (currentUid !== null && currentUid !== undefined && Number(currentUid) === Number(owner.uid)) {
    return { drop: false, reason: 'already-owner' };
  }
  return { drop: true, reason: 'privilege-drop', owner };
}

// argv for running `helperPath` as the credential owner. Mirrors the two drop
// mechanisms the rest of PW already uses: setpriv in container mode (see
// terminal-priv.js) and `sudo -u` in host mode (see server.js tmux()).
//
// Nothing secret is ever placed here — the job travels on the helper's stdin.
export function credentialDropArgv({ owner, execPath, helperPath }) {
  if (!owner) throw new Error('credentialDropArgv: owner required');
  if (!execPath || !helperPath) throw new Error('credentialDropArgv: execPath and helperPath required');
  if (owner.source === 'PW_TERMINAL_UID') {
    return ['/usr/bin/setpriv', '--reuid', String(owner.uid), '--regid', String(owner.gid), '--init-groups', execPath, helperPath];
  }
  if (!owner.user) throw new Error('credentialDropArgv: named owner has no account name');
  return ['/usr/bin/sudo', '-n', '-u', owner.user, execPath, helperPath];
}

// Run a credential job in a dropped child. The job — including the token — is
// written to stdin and never appears in the child's command line.
export function spawnCredentialJob({ spawn, argv, job, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error('credential helper timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* helper died before writing */ }
      if (code === 0 && parsed && parsed.ok) return finish(resolve, parsed.result);
      finish(reject, new Error(parsed?.error || err.trim().split('\n').pop() || `credential helper exited ${code}`));
    });
    child.stdin.on('error', (e) => finish(reject, e));
    child.stdin.end(JSON.stringify(job));
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Create/refresh a user's credential material. Resolves to
// { configDir, envFile, seeded, fingerprint }; REJECTS when the material
// cannot be placed. The caller (server.js's credentialContext) treats that as
// a hard failure and refuses to launch, rather than pointing an agent at a
// directory it cannot read — or silently falling back to the shared login,
// which would be the same silent identity swap this module exists to avoid.
export async function ensureUserCredentials({
  fsp,
  base,
  username,
  ghToken = '',
  sharedClaudeJson = '',
  sharedSettings = '',
  sharedClaudeMd = '',
  sharedCopilotHome = '',
  owner = null,
  currentUid = null,
  runJob = null,
}) {
  const job = { action: 'ensure', base, username, ghToken, sharedClaudeJson, sharedSettings, sharedClaudeMd, sharedCopilotHome };
  const plan = credentialExecutionPlan({ owner, currentUid });
  const result = plan.drop
    ? await runJob(job, plan)
    : await applyCredentialJob({ fsp, ...job });
  return {
    configDir: result.configDir,
    // Absent when an older credential-writer.mjs answered the job (a rolling
    // deploy): callers must treat '' as "no COPILOT_HOME to set" rather than
    // passing `undefined` into a tmux env token.
    copilotHome: result.copilotHome || '',
    envFile: result.envFile,
    seeded: !!result.seeded,
    fingerprint: credentialFingerprint({ username, configDir: result.configDir, ghToken }),
  };
}

export async function pruneCredentials({ fsp, base, keep = [], owner = null, currentUid = null, runJob = null }) {
  const job = { action: 'prune', base, keep };
  const plan = credentialExecutionPlan({ owner, currentUid });
  return plan.drop ? runJob(job, plan) : pruneUserCredentials({ fsp, base, keep });
}

// Has this user completed their own Claude login? Used ONLY to render a
// status column (GET /api/users' claudeSignedIn) — never a security
// decision — but it still must not let whoever's asking (possibly the root
// dashboard) follow a symlink planted at this path into an arbitrary target.
// lstat() (never stat()) is what makes that true: a symlink here is neither
// followed nor ever considered "signed in".
export async function userSignedIn({ fsp, base, username }) {
  try {
    const st = await fsp.lstat(path.join(userClaudeConfigDir(base, username), '.credentials.json'));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// Has this user completed their own `copilot login`?
//
// Copilot writes the credential into <COPILOT_HOME>/config.json when there is no OS
// credential store to use — which is the case on this workbench (no keyring in the
// container). Two signals are accepted because only one of them survives a box that
// DOES have a credential store: `copilotTokens` holds the material itself, while
// `loggedInUsers` / `lastLoggedInUser` record the account and remain even when the
// token went to a keyring instead.
//
// The file is Copilot's own, so it is read defensively: lstat first (never follow a
// symlink planted in a pane-controlled tree), a bounded read, and `//` comment lines
// stripped before parsing because Copilot writes a JSONC-style header into it. Only a
// BOOLEAN ever leaves this function — never an account name, never the token.
const COPILOT_CONFIG_MAX_BYTES = 1024 * 1024;

export async function userCopilotSignedIn({ fsp, base, username }) {
  const file = path.join(userCopilotConfigDir(base, username), 'config.json');
  let body;
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.size === 0 || st.size > COPILOT_CONFIG_MAX_BYTES) return false;
    const fh = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { body = await fh.readFile('utf8'); } finally { await fh.close(); }
  } catch {
    return false;   // absent, a symlink, unreadable: not signed in, never an error
  }
  let parsed;
  try {
    parsed = JSON.parse(body.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n'));
  } catch {
    return false;   // Copilot changed the format, or the file is half-written
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const tokens = parsed.copilotTokens;
  if (tokens && typeof tokens === 'object' && Object.values(tokens).some((v) => typeof v === 'string' && v.trim())) return true;
  if (Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.some((u) => u && typeof u.login === 'string' && u.login.trim())) return true;
  return typeof parsed.lastLoggedInUser?.login === 'string' && !!parsed.lastLoggedInUser.login.trim();
}

// Same in-process-or-dropped-helper shape as ensureUserCredentials/
// pruneCredentials: when the dashboard is NOT the credential-tree's owning
// account, this check runs inside the SAME privilege-dropped helper
// (credential-writer.mjs) as every other read of that tree, rather than the
// dashboard (often root) touching a pane-controlled path itself.
//
// Returns BOTH CLIs' sign-in state from one job, because the Users table needs both
// and each extra job is another privilege-dropped process spawn per user per request.
// `copilotSignedIn` is absent from an older helper's reply (a rolling deploy); it is
// coerced to false rather than optimistically true, so a stale helper can never make
// someone look signed in when nobody has checked.
export async function checkUserCliSignIn({ fsp, base, username, owner = null, currentUid = null, runJob = null }) {
  const job = { action: 'status', base, username };
  const plan = credentialExecutionPlan({ owner, currentUid });
  const result = plan.drop ? await runJob(job, plan) : {
    signedIn: await userSignedIn({ fsp, base, username }),
    copilotSignedIn: await userCopilotSignedIn({ fsp, base, username }),
  };
  return { claude: !!result.signedIn, copilot: !!result.copilotSignedIn };
}

// Kept as the single-answer form for callers that only care about Claude.
export async function checkUserSignedIn(args) {
  return (await checkUserCliSignIn(args)).claude;
}
