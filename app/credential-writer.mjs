// Credential writer — runs AS the terminal account, never as root.
//
// The root dashboard must not touch the per-user credential tree: that tree is
// owned by the shared unprivileged pane account, so any user with a terminal can
// plant a symlink there and turn a root write into a local privilege escalation.
// Instead the dashboard drops privileges (setpriv in container mode, `sudo -u` in
// host mode — see credentialDropArgv) and runs this helper, which performs the
// filesystem work with exactly the authority the pane account already has.
//
// Protocol: one JSON job object on stdin, one JSON result object on stdout.
//
//   in : {"action":"ensure","base":…,"username":…,"ghToken":…,"sharedClaudeJson":…}
//         {"action":"prune","base":…,"keep":[…]}
//         {"action":"status","base":…,"username":…}
//         {"action":"git-credential","projectPath":…,"credential":…}
//         {"action":"git-credential-inventory","workspaceRoot":…,"names":[…]}
//   out: {"ok":true,"result":{…}} | {"ok":false,"error":"…"}
//
// The job travels on stdin specifically so the GitHub token never appears in
// this process's command line, where `ps` would publish it to every other user
// sharing the account. That applies identically to the per-workspace git
// credential: `git-credential` carries the helper line on stdin and the token is
// never an argument to any git invocation.
//
// This file is installed root-owned and is not writable by the pane account.

import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyCredentialJob, pruneUserCredentials, userSignedIn } from './user-credentials.js';
import { applyWorkspaceGitCredentialJob, inventoryWorkspaceGitCredentials } from './workspace-git-credentials.js';

const execFileAsync = promisify(execFile);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}

async function main() {
  let job;
  try {
    job = JSON.parse(await readStdin());
  } catch {
    fail('credential helper: unreadable job');
    return;
  }
  if (!job || typeof job !== 'object') {
    fail('credential helper: malformed job');
    return;
  }
  // Each action declares the one field it cannot work without, so adding the
  // workspace actions does not weaken the guard on the user-tree actions: those
  // still require `base`, and a job that names no known action still requires it
  // rather than falling through unvalidated.
  const required = {
    'git-credential': 'projectPath',
    'git-credential-inventory': 'workspaceRoot',
  }[job.action] || 'base';
  if (!job[required]) {
    fail(`credential helper: malformed job (missing ${required})`);
    return;
  }

  try {
    const result = job.action === 'git-credential'
      ? await applyWorkspaceGitCredentialJob({
        fsp,
        execFile: execFileAsync,
        projectPath: job.projectPath,
        credential: job.credential || '',
      })
      : job.action === 'git-credential-inventory'
      ? await inventoryWorkspaceGitCredentials({
        fsp,
        workspaceRoot: job.workspaceRoot,
        names: Array.isArray(job.names) ? job.names : [],
      })
      : job.action === 'prune'
      ? await pruneUserCredentials({ fsp, base: job.base, keep: Array.isArray(job.keep) ? job.keep : [] })
      : job.action === 'status'
      ? { signedIn: await userSignedIn({ fsp, base: job.base, username: job.username }) }
      : await applyCredentialJob({
        fsp,
        base: job.base,
        username: job.username,
        ghToken: job.ghToken || '',
        sharedClaudeJson: job.sharedClaudeJson || '',
      });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (e) {
    // The message may name a path but never carries the token.
    fail(e && e.message ? e.message : String(e));
  }
}

await main();
