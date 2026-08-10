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
//   out: {"ok":true,"result":{…}} | {"ok":false,"error":"…"}
//
// The job travels on stdin specifically so the GitHub token never appears in
// this process's command line, where `ps` would publish it to every other user
// sharing the account.
//
// This file is installed root-owned and is not writable by the pane account.

import fsp from 'node:fs/promises';
import { applyCredentialJob, pruneUserCredentials, userSignedIn } from './user-credentials.js';
import { runGitCredentialJob, remediateGitCredentials, nodeJobDeps, nodeRunGit } from './git-credentials.js';

// Jobs that operate on the per-user credential TREE are addressed by `base`.
// The git-credential job addresses a project REPOSITORY instead, so it carries
// a workspace root and a project path and has no `base` at all.
const TREE_ACTIONS = new Set(['ensure', 'prune', 'status']);

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
  const action = job.action || 'ensure';
  if (TREE_ACTIONS.has(action) && !job.base) {
    fail('credential helper: malformed job');
    return;
  }

  try {
    const result = action === 'git-credential-audit'
      // Always the remediation planner: with `apply` false it is a dry run that
      // still reports the ACTION each row would get, which is what an operator
      // has to see before authorising a change.
      ? await remediateGitCredentials({
        deps: nodeJobDeps(),
        runGit: nodeRunGit(),
        workspaceRoot: job.workspaceRoot,
        projects: Array.isArray(job.projects) ? job.projects : [],
        expectedUid: job.expectedUid,
        apply: !!job.apply,
      })
      : action === 'git-credential'
      ? await runGitCredentialJob({
        deps: nodeJobDeps(),
        runGit: nodeRunGit(),
        workspaceRoot: job.workspaceRoot,
        projectPath: job.projectPath,
        registeredPaths: Array.isArray(job.registeredPaths) ? job.registeredPaths : [],
        token: job.token || '',
        expectedUid: job.expectedUid,
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
