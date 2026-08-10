// Applying a workspace's Git credential configuration — the store file plus the `git config
// --local` entries that point at it — as the workspace owner, with no shell.
//
// Split from app/git-credential-store.mjs so that module can assert it spawns nothing at all: the
// filesystem safety (no-follow, atomic publish, ownership validation) lives there, and the process
// execution lives here. Both halves run inside app/credential-writer.mjs, which callers reach only
// through the vetted privilege-drop boundary (credentialDropArgv → `sudo -n -u <owner>` in host
// mode, `setpriv --reuid` in container mode).
//
// NO SHELL, EVER. Every git invocation is argv through execFile. A shell would be a second injection
// surface on top of the one this whole candidate exists to close, and the credential file path is
// attacker-influenced in exactly the way that matters (`--file=<path>`).
//
// THE TOKEN NEVER REACHES A COMMAND LINE. It is written to the store by the module above; the git
// config entry names the *path* to the store, not its contents. `ps` on a shared account therefore
// shows a filename, not a credential.

import { writeCredentialStore, removeCredentialStore, credentialStorePath } from './git-credential-store.mjs';

/**
 * Configure or clear a workspace's per-project credential helper.
 *
 * @param {object}   o
 * @param {Function} o.execFile     promisified execFile, injected so this is testable and shell-free
 * @param {string}   o.projectPath  absolute workspace path
 * @param {string}   [o.token]      the owner's GitHub token; empty/absent clears the configuration
 * @param {number}   [o.expectUid]  the account that must own `.git` and that this process must be
 * @returns {Promise<{action:'configured'|'cleared', displacedForeign?:boolean, credFile:string}>}
 */
export async function applyProjectGitCredentials({ execFile, projectPath, token = '', expectUid }) {
  if (typeof execFile !== 'function') throw new Error('project-git-credentials: execFile is required');
  const credFile = credentialStorePath(projectPath);
  // Failures are swallowed per-call exactly as before: `--unset-all` exits non-zero when there is
  // nothing to unset, which is the normal first-run case, not an error.
  const git = (...args) => execFile('git', ['-C', projectPath, 'config', '--local', ...args]).catch(() => {});

  if (token) {
    const written = await writeCredentialStore({ projectPath, token, expectUid });
    // Use ONLY our project-local store: clear prior local entries, then add an empty reset — which
    // drops inherited global/system helpers for this repo, so the token is never dispatched to, and
    // duplicated into, a global store — followed by ours. Two `--add`, not `--replace-all`, which
    // would drop the reset.
    await git('--unset-all', 'credential.helper');
    await git('--add', 'credential.helper', '');
    await git('--add', 'credential.helper', `store --file=${credFile}`);
    return { action: 'configured', displacedForeign: written.displacedForeign, credFile };
  }

  const removed = await removeCredentialStore({ projectPath, expectUid });
  await git('--unset-all', 'credential.helper');
  return { action: 'cleared', removed: removed.action, credFile };
}
