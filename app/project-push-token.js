// Which credential authenticates a project's git remote.
//
// WHY A PROJECT NEEDS ITS OWN, separate from the person's:
//
// PW stores one GitHub token per person and used it for both jobs — the push
// credential pinned into the projects they own, AND what authenticates Copilot in
// their terminals. That works only while one GitHub account can do both, and an
// Enterprise Managed User cannot. An EMU account (`someone_enterprise`) exists only
// inside its enterprise: it is invisible to the public API, it cannot be added as a
// collaborator on a repository outside the enterprise, and no setting changes that —
// it is the data-isolation guarantee EMU is sold on. So a project whose remote lives
// outside the enterprise can never be pushed to by the account that holds the Copilot
// seat.
//
// Both roles were the same field, which had a sharp edge: authorising a person through
// `gh auth login` replaced their token with an enterprise OAuth token and silently
// re-pinned it into every project they own, breaking pushes to any remote that account
// cannot reach. The failure surfaced as a 403 naming an account nobody had chosen.
//
// So the two roles are now separate. A person's token stays their AI identity and the
// default push credential. A project may carry its OWN push credential, which wins for
// git and is never used for anything else — not Copilot, not a pane environment.
//
// THE OVERRIDE WINS EVEN WHEN IT IS BROKEN. An unreadable override is reported as a
// fault, never quietly replaced by the owner's token: the override exists precisely
// because the owner's account authenticates as the wrong identity for this remote, so
// falling back would push as exactly the account the operator ruled out.
//
// Pure and injectable so both the dashboard and the credential audit resolve one
// answer, and so no test needs a keyring. A token is never placed in `detail`.

export const PUSH_TOKEN_SOURCES = Object.freeze({
  override: 'project-override', // the project's own pushToken
  owner: 'owner',               // the primaryUser's stored GitHub token
  none: 'none',                 // neither is configured
});

/**
 * Resolve the token to pin as a project's git credential.
 *
 * @returns {{token:string, source:string, readable:boolean, detail:string}}
 *   `token` is '' whenever there is nothing usable — which callers treat as REVOKE, so
 *   `readable` and `detail` are what distinguish "deliberately none" from "a stored
 *   secret we could not read". `detail` is safe to log or show to an operator.
 */
export function resolveProjectGitToken({ project, users, decrypt }) {
  const mk = (token, source, readable, detail) => ({ token, source, readable, detail });

  if (project?.pushToken) {
    let token = '';
    try {
      token = decrypt(project.pushToken) || '';
    } catch (e) {
      return mk('', PUSH_TOKEN_SOURCES.override, false,
        `this project's own push credential could not be decrypted (${e?.message || e})`);
    }
    if (!token) {
      return mk('', PUSH_TOKEN_SOURCES.override, false,
        "this project's own push credential decrypted to nothing");
    }
    return mk(token, PUSH_TOKEN_SOURCES.override, true, "this project's own push credential");
  }

  const name = String(project?.primaryUser || '').trim();
  if (!name) {
    return mk('', PUSH_TOKEN_SOURCES.none, false,
      'no push credential on the project and no git identity chosen');
  }
  const u = (users || []).find((x) => x?.username === name);
  if (!u) {
    return mk('', PUSH_TOKEN_SOURCES.owner, false,
      `git identity "${name}" does not resolve to a user record`);
  }
  let token = '';
  try {
    token = u.ghToken ? (decrypt(u.ghToken) || '') : '';
  } catch (e) {
    return mk('', PUSH_TOKEN_SOURCES.owner, false,
      `the stored token for "${name}" could not be decrypted (${e?.message || e})`);
  }
  if (!token) {
    return mk('', PUSH_TOKEN_SOURCES.owner, false, `"${name}" has no stored GitHub token`);
  }
  return mk(token, PUSH_TOKEN_SOURCES.owner, true, `the GitHub token of "${name}"`);
}
