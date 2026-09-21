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

// Who owns the credentials for a terminal a PERSON just launched, and what is
// their token?
//
// Per-launcher mode (PW_PER_LAUNCHER_CLAUDE) answers a different question from
// resolveProjectCredentialOwner above: not "whose project is this" but "whose
// seat is about to be spent". A project is shared by everyone granted access to
// it, so keying a tab's Claude login / GitHub token to the project's primaryUser
// bills every teammate's work to the owner's seat. Keying it to the person who
// clicked "+" bills it to them.
//
// Returns `null` — meaning "no launcher identity, use the project owner" — for
// the cases where there is legitimately no person to attribute to:
//   * per-launcher mode is off;
//   * no username was supplied (a scheduled task, the boot reattach, a bot);
//   * the username does not resolve to a user record. That is the IMPLICIT_ADMIN
//     of an unauthenticated instance, not a failure: falling back to the project
//     owner keeps today's behaviour, which is NOT the silent shared-login swap
//     resolveProjectCredentialOwner exists to prevent.
//
// A token that fails to decrypt still THROWS (via decrypt), because a corrupt
// stored secret is a real fault and must not quietly become "no token".
//
// A launcher with no stored ghToken is NOT an error: they get their own config
// dir with no GH_TOKEN, so Claude/Copilot ask them to sign in rather than
// inheriting someone else's seat.
export function resolveLauncherCredentialOwner({ perLauncherEnabled, username, users, decrypt }) {
  if (!perLauncherEnabled) return null;
  const name = String(username || '').trim();
  if (!name) return null;
  const u = (users || []).find((x) => x.username === name);
  if (!u) return null;
  const ghToken = u.ghToken ? (decrypt(u.ghToken) || '') : '';
  return { username: u.username, ghToken };
}
