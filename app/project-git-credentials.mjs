// Per-workspace Git credentials — written AS the terminal account, never as root.
//
// GOA-6. `syncProjectCredentials` in app/server.js ran, from the dashboard process:
//
//     git -C <workspace> config --local --unset-all credential.helper
//     git -C <workspace> config --local --add       credential.helper ''
//     git -C <workspace> config --local --add       credential.helper 'store --file=<workspace>/.git/.pw-credentials'
//     fs.writeFile(<workspace>/.git/.pw-credentials, …, { mode: 0o600 })
//
// The dashboard is root in BOTH deploy modes (host: root node -> `sudo -u admin tmux`; container:
// root node -> setpriv). The workspace and its `.git` belong to the unprivileged pane account. So
// every one of those calls left a root-owned `.git/config` and a root-owned, 0600 credential file
// inside a tree the pane is supposed to own — after which the pane's own `git fetch` fails with
// "cannot lock ref … Permission denied" and "failed to write object", and `git` cannot read the
// credential file that was written for it. Contrast the clone path, which already chowns what it
// creates.
//
// It is also the same privilege-boundary principle as app/credential-writer.mjs: a root write into
// a directory an unprivileged account controls is a symlink away from being a local escalation.
// `.git/config` is a particularly bad thing to write as root, because Git config can name programs
// to execute (`core.pager`, `credential.helper`, `core.fsmonitor`).
//
// So this module does the filesystem and `git config` work with exactly the authority the pane
// account already has, and app/server.js reaches it through the SAME privilege-dropped helper the
// per-user credential tree already uses (app/credential-writer.mjs, dropped via credentialDropArgv).
//
// NOT DONE HERE, deliberately: no recursive chown of the workspace. Repairing ownership of an
// existing worktree wholesale is a destructive, surprising thing for a credential sync to do — it
// would rewrite files the product never created. This fixes the code that creates root-owned
// artifacts; it does not go looking for other people's.
//
// The token travels in the job on stdin and never reaches a command line, so `ps` cannot publish it
// to other users sharing the account. The remote URL never carries it either.

import path from 'node:path';

export const CREDENTIALS_FILENAME = '.pw-credentials';

/** Where the per-project credential store lives, for a given workspace path. */
export function credentialFilePath(projectPath) {
  return path.join(projectPath, '.git', CREDENTIALS_FILENAME);
}

/**
 * Apply (or clear) a workspace's Git credential configuration.
 *
 * @param {object}   io
 * @param {object}   io.fsp          node:fs/promises (injected for testing)
 * @param {Function} io.execFile     promisified execFile (injected for testing)
 * @param {string}   io.projectPath  the workspace root
 * @param {string}   [io.token]      the owner's GitHub token; empty/absent clears the configuration
 * @returns {Promise<{action: 'configured'|'cleared', credFile: string}>}
 */
export async function applyProjectGitCredentials({ fsp, execFile, projectPath, token = '' }) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('project-git-credentials: projectPath required');
  const gitDir = path.join(projectPath, '.git');
  // No .git yet: nothing to configure, and nothing to clear. Not an error — a project can be added
  // before it is cloned.
  try { await fsp.access(gitDir); } catch { return { action: 'cleared', credFile: '', skipped: 'no .git directory' }; }

  const credFile = credentialFilePath(projectPath);
  const git = (...args) => execFile('git', ['-C', projectPath, 'config', '--local', ...args]).catch(() => {});

  if (token) {
    await fsp.writeFile(credFile, `https://${token}:x-oauth-basic@github.com\n`, { mode: 0o600 });
    // Use ONLY our project-local store: clear any prior local entries, then add an empty reset
    // (drops inherited global/system helpers for this repo so the token is never dispatched to — and
    // duplicated into — a global store) followed by our per-project store. Two --add, not
    // --replace-all, which would drop the reset.
    await git('--unset-all', 'credential.helper');
    await git('--add', 'credential.helper', '');
    await git('--add', 'credential.helper', `store --file=${credFile}`);
    return { action: 'configured', credFile };
  }

  await fsp.rm(credFile, { force: true }).catch(() => {});
  await git('--unset-all', 'credential.helper');
  return { action: 'cleared', credFile };
}
