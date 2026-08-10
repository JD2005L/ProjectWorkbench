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
//         {"action":"git-credentials","projectPath":…,"ghToken":…}
//   out: {"ok":true,"result":{…}} | {"ok":false,"error":"…"}
//
// `git-credentials` is here for the same reason as the rest (GOA-6): the workspace and its `.git`
// belong to the pane account, so the root dashboard writing `.git/config` and `.git/.pw-credentials`
// left root-owned artifacts the pane could then neither lock nor read — and `.git/config` can name
// programs to execute, which makes a root write there a privilege boundary, not just an ownership
// annoyance. Note it does not take `base`, so the malformed-job guard below allows it explicitly.
//
// The job travels on stdin specifically so the GitHub token never appears in
// this process's command line, where `ps` would publish it to every other user
// sharing the account.
//
// This file is installed root-owned and is not writable by the pane account.

import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyCredentialJob, pruneUserCredentials, userSignedIn } from './user-credentials.js';
import { applyProjectGitCredentials } from './project-git-credentials.mjs';

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
  if (!job || typeof job !== 'object' || (!job.base && job.action !== 'git-credentials')) {
    fail('credential helper: malformed job');
    return;
  }

  try {
    if (job.action === 'git-credentials') {
      if (!job.projectPath) {
        fail('credential helper: git-credentials job has no projectPath');
        return;
      }
      const result = await applyProjectGitCredentials({
        fsp, execFile: execFileAsync, projectPath: job.projectPath, token: job.ghToken || '',
      });
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return;
    }
    const result = job.action === 'prune'
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
