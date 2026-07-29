// Resolves and materializes a project's per-user Claude/GitHub credentials
// for the HOST-MODE systemd-launched terminal (scripts/project-terminal-start),
// enforcing the EXACT SAME fail-closed contract as app/server.js's
// credentialContext(): when PW_PER_USER_CLAUDE is on and the project has a
// primaryUser, that owner's credentials are mandatory — any failure (an
// unreadable users store, a primaryUser that doesn't resolve to a record, an
// undecryptable GitHub token, a failing credential helper) exits nonzero with
// an actionable error instead of silently falling back to the shared login.
// Shared credentials remain the answer only for the two INTENDED cases: the
// feature is off, or the project has no primaryUser.
//
// This closes the gap the fix in app/server.js (this PR's AC1) left open:
// server.js only governs sessions it creates directly (ensureTmuxSession /
// newTmuxWindow / recycle). The systemd-launched INITIAL host-mode terminal
// never went through that code at all — it always used the shared login,
// silently, regardless of PW_PER_USER_CLAUDE. There is nothing to "fall back"
// to here that the caller (the bash script) doesn't already have: this
// process runs AS the terminal account (systemd's project-terminal@.service
// runs `User=admin`), so — like server.js — it drops privileges only when it
// is NOT already the credential owner (see credentialExecutionPlan in
// app/user-credentials.js), and never performs a filesystem operation on the
// credential tree itself; that work happens in credential-writer.mjs, the
// SAME helper server.js uses.
//
// Protocol (mirrors credential-writer.mjs): one JSON object on stdout, ALWAYS
// — {"ok":true,"shared":true} | {"ok":true,"shared":false,"configDir":...,
// "envFile":...,"fingerprint":...} | {"ok":false,"error":"..."} — and the
// process exit code signals success/failure. No secret (a GitHub token) is
// ever written to stdout, stderr, or an error message.
//
// Usage: node project-terminal-credentials.mjs <projectName> <primaryUser>
//   <primaryUser> is empty ('') when the project has none configured.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { loadUsersFile } from './users-file.js';
import { makeSecretCrypto } from './secret-crypto.js';
import { resolveProjectCredentialOwner } from './project-owner.js';
import { resolveTerminalOwner, makePasswdLookup } from './terminal-owner.js';
import { ensureUserCredentials, credentialDropArgv, spawnCredentialJob } from './user-credentials.js';

const execFileAsync = promisify(execFile);

function ok(result) {
  process.stdout.write(JSON.stringify({ ok: true, ...result }));
}
function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}

async function main() {
  const [, , projectName, primaryUserArg] = process.argv;
  const primaryUser = primaryUserArg || '';
  const perUserEnabled = String(process.env.PW_PER_USER_CLAUDE || '').toLowerCase() === 'true';

  const usersPath = process.env.PW_USERS_PATH || '/etc/project-workbench/users.json';
  const secretKeyPath = process.env.PW_SECRET_KEY_PATH || '/etc/project-workbench/.secret-key';
  const credBase = process.env.PW_USER_CRED_BASE || '/home/admin/pw-users';
  const sharedClaudeJson = path.join(process.env.HOME || '/home/admin', '.claude.json');

  let owner;
  try {
    const users = perUserEnabled && primaryUser ? await loadUsersFile(usersPath) : [];
    const { decrypt } = makeSecretCrypto({ secretKeyPath });
    owner = resolveProjectCredentialOwner({
      perUserEnabled,
      project: { name: projectName, primaryUser },
      users,
      decrypt,
    });
  } catch (e) {
    fail(`project "${projectName}" cannot resolve its credential owner (primaryUser "${primaryUser}"): ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
    return;
  }

  if (!owner) {
    ok({ shared: true });
    return;
  }

  try {
    const passwdLookup = makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile });
    const terminalOwner = await resolveTerminalOwner(process.env, passwdLookup);
    const helperPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'credential-writer.mjs');
    const runJob = (job, plan) => spawnCredentialJob({
      spawn,
      argv: credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath }),
      job,
    });
    const cred = await ensureUserCredentials({
      fsp: fs,
      base: credBase,
      username: owner.username,
      ghToken: owner.ghToken,
      sharedClaudeJson,
      owner: terminalOwner,
      currentUid: process.getuid?.() ?? null,
      runJob,
    });
    ok({ shared: false, configDir: cred.configDir, envFile: cred.envFile, fingerprint: cred.fingerprint });
  } catch (e) {
    fail(`project "${projectName}" (owner "${owner.username}") credential materialization failed: ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
  }
}

await main();
