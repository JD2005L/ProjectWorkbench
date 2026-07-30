// Resolves the per-user credential context for an orchestrator-managed
// project's tmux session — the same fail-closed contract app/server.js's
// credentialContext() and app/project-terminal-credentials.mjs already
// enforce for the human dashboard/terminal paths, applied here as a THIRD
// entrypoint (see app/project-owner.js's own doc comment, which anticipated
// exactly this: "used by TWO independent entrypoints that must agree
// byte-for-byte").
//
// The orchestrator has its OWN project config (workspace_subdir,
// capabilities, verification_commands, ... in orchestrator-projects.json)
// with no notion of primaryUser at all — a project there is identified only
// by project_id. So this cross-references the MAIN dashboard's projects.json
// (PW_REGISTRY_PATH) by name === project_id to find primaryUser, exactly like
// the tmux SESSION NAME the lane shares with human windows already does:
// laneNaming() computes the identical pw_<sanitized-name> the main registry
// uses, by design ("the project's tmux session is shared with human
// windows").
//
// Runs IN-PROCESS (the orchestrator is mounted directly into app/server.js,
// unlike the host-mode systemd terminal launcher, which is a separate spawned
// process) — so this calls the same underlying functions server.js's own
// credentialContext() uses directly, rather than shelling out to
// project-terminal-credentials.mjs the way scripts/project-terminal-start
// must.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadUsersFile } from '../users-file.js';
import { makeSecretCrypto } from '../secret-crypto.js';
import { resolveProjectCredentialOwner } from '../project-owner.js';
import { resolveTerminalOwner, makePasswdLookup } from '../terminal-owner.js';
import {
  ensureUserCredentials, credentialDropArgv, spawnCredentialJob, CREDENTIALS_OFF,
} from '../user-credentials.js';

const execFileAsync = promisify(execFile);
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRegistryProject(registryPath, projectId) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the project registry (${registryPath}) to resolve credentials for "${projectId}": ${e?.message || e}`);
  }
  return (Array.isArray(registry) ? registry : []).find((p) => p?.name === projectId) || null;
}

/**
 * Resolves `{ key, tokens }` for the given orchestrator project id — `key` is
 * the fingerprint to stamp on the shared tmux session (or CREDENTIALS_OFF),
 * `tokens` are `KEY=VALUE` environment entries to prefix new-session/
 * new-window commands with. THROWS (fail-closed) on any resolution or
 * materialization failure — never falls back to shared credentials silently.
 */
export async function resolveLaneCredentials({
  registryPath, projectId, perUserEnabled,
  usersPath, secretKeyPath, credBase, sharedClaudeJson,
}) {
  if (!perUserEnabled) return { key: CREDENTIALS_OFF, tokens: [] };

  const project = readRegistryProject(registryPath, projectId);
  if (!project) {
    // Distinct from "found the project, it legitimately has no primaryUser"
    // (the normal shared/off case, handled below via resolveProjectCredentialOwner):
    // the orchestrator's project id not mapping to ANY dashboard project at all
    // means nothing here can be verified, so this must not be treated as if it
    // were the legitimate off case.
    throw new Error(`no current project in the registry (${registryPath}) maps to orchestrator project id "${projectId}"; cannot resolve its credential owner. Refusing to fall back to the shared Claude/GitHub login.`);
  }
  const primaryUser = project.primaryUser || '';

  // Stricter than app/project-owner.js's own resolveProjectCredentialOwner()
  // (which treats "feature on, project intentionally has no primaryUser" as
  // a second legitimate shared/off case, for the human dashboard/terminal
  // paths). For the orchestrator lane — an unattended, automated surface
  // with no human in the loop to notice a wrong attribution — "off" is
  // legitimate ONLY when PW_PER_USER_CLAUDE is disabled outright. A project
  // enabled for per-user credentials but missing a primaryUser assignment is
  // an incomplete configuration, not an intentional choice, and must fail
  // closed rather than silently run under the shared login.
  if (!primaryUser) {
    throw new Error(`project "${projectId}" has per-user credentials enabled but no primaryUser configured; refusing to run the orchestrator lane under the shared Claude/GitHub login.`);
  }

  const users = await loadUsersFile(usersPath);
  const { decrypt } = makeSecretCrypto({ secretKeyPath });
  let owner;
  try {
    owner = resolveProjectCredentialOwner({ perUserEnabled, project: { name: projectId, primaryUser }, users, decrypt });
  } catch (e) {
    throw new Error(`project "${projectId}" cannot resolve its credential owner (primaryUser "${primaryUser}"): ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
  }
  if (!owner) {
    // Cannot actually happen once primaryUser is non-empty and perUserEnabled
    // is true (resolveProjectCredentialOwner only returns null for the two
    // legitimate-off cases, both already excluded above) — but never treat an
    // unexpected null as a silent green light either way.
    throw new Error(`project "${projectId}": could not resolve a credential owner despite a configured primaryUser "${primaryUser}". Refusing to fall back to the shared Claude/GitHub login.`);
  }

  try {
    const passwdLookup = makePasswdLookup({ execFile: execFileAsync, readFile: fs.promises.readFile });
    const terminalOwner = await resolveTerminalOwner(process.env, passwdLookup);
    const helperPath = path.join(APP_DIR, 'credential-writer.mjs');
    const runJob = (job, plan) => spawnCredentialJob({
      spawn, argv: credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath }), job,
    });
    const cred = await ensureUserCredentials({
      fsp: fs.promises, base: credBase, username: owner.username, ghToken: owner.ghToken, sharedClaudeJson,
      owner: terminalOwner, currentUid: process.getuid?.() ?? null, runJob,
    });
    const tokens = ['CLAUDE_CONFIG_DIR=' + cred.configDir];
    return { key: cred.fingerprint, tokens };
  } catch (e) {
    throw new Error(`project "${projectId}" (owner "${owner.username}") credential materialization failed: ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
  }
}

/**
 * The cheap, safe default used when nothing explicitly injects a resolver
 * (e.g. a test that does not care about per-user credentials at all): reads
 * PW_PER_USER_CLAUDE straight from the environment and, when it is not
 * enabled, resolves to the "off" sentinel without touching the filesystem —
 * byte-identical to how every other per-user-credential entrypoint treats the
 * disabled case. Production wiring (app/orchestrator/index.js) always
 * injects the real resolveLaneCredentials above instead, driven by the
 * dashboard's own resolved config rather than re-reading process.env here.
 */
export async function defaultLaneCredentialResolver(projectId) {
  const perUserEnabled = String(process.env.PW_PER_USER_CLAUDE || '').toLowerCase() === 'true';
  if (!perUserEnabled) return { key: CREDENTIALS_OFF, tokens: [] };
  return resolveLaneCredentials({
    registryPath: process.env.PW_REGISTRY_PATH || '/opt/project-workbench/projects.json',
    projectId,
    perUserEnabled,
    usersPath: process.env.PW_USERS_PATH || '/etc/project-workbench/users.json',
    secretKeyPath: process.env.PW_SECRET_KEY_PATH || '/etc/project-workbench/.secret-key',
    credBase: process.env.PW_USER_CRED_BASE || '/home/admin/pw-users',
    sharedClaudeJson: path.join(process.env.HOME || '/home/admin', '.claude.json'),
  });
}
