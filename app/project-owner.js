// Who owns a project's per-user credentials, and what is their token?
//
// This is the single piece of logic AC1 of the PR #20 remediation depends on
// for its fail-closed guarantee, and it is used by TWO independent
// entrypoints that must agree byte-for-byte on the answer:
//
//   - app/server.js (the dashboard's ensureTmuxSession/newTmuxWindow path)
//   - app/project-terminal-credentials.mjs (the host-mode systemd terminal
//     startup path, invoked by scripts/project-terminal-start)
//
// Returns `null` for the two cases where shared credentials are the INTENDED
// behaviour: the feature is off, or the project intentionally has no
// primaryUser. Every other failure THROWS — a primaryUser that doesn't
// resolve to a user record, or a token that fails to decrypt — because the
// only caller-visible difference between "no owner" and "owner resolution
// failed" is whether the session launches under the shared identity, and
// that must never happen silently.
export function resolveProjectCredentialOwner({ perUserEnabled, project, users, decrypt }) {
  if (!perUserEnabled || !project?.primaryUser) return null;
  const u = (users || []).find((x) => x.username === project.primaryUser);
  if (!u) throw new Error(`primaryUser "${project.primaryUser}" does not exist in users.json`);
  const ghToken = u.ghToken ? (decrypt(u.ghToken) || '') : '';
  return { username: u.username, ghToken };
}
