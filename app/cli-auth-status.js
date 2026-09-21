// What a PERSON's CLI sign-in state actually is — the box's is a different question.
//
// Installing a CLI is a property of the machine. Being signed in to one is a property
// of a person, and since per-launcher credentials landed those two answers can differ
// for every user on the box. The Setup Wizard answers the machine question. This
// module answers the person question, for the Users table.
//
// Nothing here ever returns, logs or embeds credential MATERIAL. A token is inspected
// only far enough to classify its TYPE, because the type is the difference between
// "this person's Copilot works" and "this person's Copilot silently fails", and that
// difference has to be visible in the UI without publishing the secret to it.

// GitHub token families, by prefix. Only the prefix is read.
//
// Why the type matters at all: `copilot login --help` states which token types Copilot
// CLI accepts, and CLASSIC personal access tokens (`ghp_`) are explicitly not among
// them. A classic PAT authenticates git perfectly well, so it looks correct
// everywhere else on the workbench and then fails only for inference — which presents
// as a broken tab, not as a credential problem. Naming it in the UI is the whole point
// of this classification.
export const GITHUB_TOKEN_KINDS = Object.freeze({
  oauth: 'oauth',                 // gho_ / ghu_  — GitHub CLI or Copilot CLI OAuth token
  fineGrained: 'fine-grained',    // github_pat_  — needs the "Copilot Requests" permission
  classic: 'classic',             // ghp_         — NOT accepted by Copilot CLI
  server: 'server',               // ghs_         — app/installation token
  refresh: 'refresh',             // ghr_         — refresh token, not an access token
  unknown: 'unknown',             // non-empty and unrecognised
  none: 'none',
});

export function classifyGithubToken(token) {
  const t = String(token || '').trim();
  if (!t) return GITHUB_TOKEN_KINDS.none;
  if (t.startsWith('github_pat_')) return GITHUB_TOKEN_KINDS.fineGrained;
  if (t.startsWith('gho_') || t.startsWith('ghu_')) return GITHUB_TOKEN_KINDS.oauth;
  if (t.startsWith('ghp_')) return GITHUB_TOKEN_KINDS.classic;
  if (t.startsWith('ghs_')) return GITHUB_TOKEN_KINDS.server;
  if (t.startsWith('ghr_')) return GITHUB_TOKEN_KINDS.refresh;
  return GITHUB_TOKEN_KINDS.unknown;
}

/** Token types Copilot CLI will accept. Fine-grained PATs additionally need the
 *  "Copilot Requests" permission, which cannot be determined from the token itself —
 *  so this is "the right KIND of token", never a promise that it will work. */
const COPILOT_USABLE_KINDS = new Set([GITHUB_TOKEN_KINDS.oauth, GITHUB_TOKEN_KINDS.fineGrained]);

export const COPILOT_AUTH_STATES = Object.freeze({
  viaToken: 'via-token',           // a stored token of an accepted kind — nothing else to do
  tokenRejected: 'token-rejected', // a stored token Copilot will refuse (classic PAT et al.)
  tokenUnknown: 'token-unknown',   // a stored token of an unrecognised shape
  signedIn: 'signed-in',           // no stored token, but this person completed `copilot login`
  none: 'none',                    // neither
  unreadable: 'unreadable',        // the stored token could not be decrypted — a real fault
});

/**
 * How Copilot will authenticate for ONE person, and why.
 *
 * The ordering is not a preference, it is Copilot's documented behaviour: the
 * `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` environment variables take
 * PRECEDENCE over previously stored credentials. Per-user credentials export the
 * person's stored token as `GH_TOKEN`, so whenever they have one it is what Copilot
 * uses — and a `copilot login` they perform is ignored while it is present. That is
 * why a stored-but-rejected token is reported as the state even when a login exists:
 * reporting the login would describe a credential that is not in play.
 *
 * `hasLogin` is the "did this person complete their own copilot login" boolean, read
 * from their own COPILOT_HOME (see userCopilotSignedIn in user-credentials.js).
 */
export function resolveCopilotAuthState({ tokenKind = GITHUB_TOKEN_KINDS.none, hasLogin = false, tokenUnreadable = false } = {}) {
  if (tokenUnreadable) return { state: COPILOT_AUTH_STATES.unreadable, overridesLogin: false };
  if (tokenKind !== GITHUB_TOKEN_KINDS.none) {
    const state = COPILOT_USABLE_KINDS.has(tokenKind)
      ? COPILOT_AUTH_STATES.viaToken
      : (tokenKind === GITHUB_TOKEN_KINDS.unknown ? COPILOT_AUTH_STATES.tokenUnknown : COPILOT_AUTH_STATES.tokenRejected);
    // A login that exists but cannot take effect is worth saying out loud: it is the
    // difference between "sign in" (useful advice) and "your sign-in is being ignored"
    // (the actual problem).
    return { state, overridesLogin: hasLogin };
  }
  return { state: hasLogin ? COPILOT_AUTH_STATES.signedIn : COPILOT_AUTH_STATES.none, overridesLogin: false };
}

/**
 * Can this person usefully run `copilot login` right now?
 *
 * No, whenever they have a stored token — it would be overridden, so offering the
 * button would send them round a loop that cannot succeed. The reason is returned so
 * the caller can say which of the two situations it is instead of just refusing.
 */
export function copilotLoginWouldTakeEffect(state) {
  switch (state) {
    case COPILOT_AUTH_STATES.none:
    case COPILOT_AUTH_STATES.signedIn:
      return { ok: true, reason: '' };
    case COPILOT_AUTH_STATES.viaToken:
      return { ok: false, reason: 'Your stored GitHub token already authenticates Copilot, and it takes precedence over a login. Nothing to do.' };
    case COPILOT_AUTH_STATES.tokenRejected:
      return { ok: false, reason: 'Your stored GitHub token takes precedence over a login, and Copilot CLI does not accept its type (classic personal access tokens are not supported). Replace it with a fine-grained token carrying the "Copilot Requests" permission, or clear it and then sign in.' };
    case COPILOT_AUTH_STATES.tokenUnknown:
      return { ok: false, reason: 'Your stored GitHub token takes precedence over a login and its type is not recognised. Replace or clear it, then sign in.' };
    default:
      return { ok: false, reason: 'Your stored GitHub token could not be read, so it is unclear what Copilot would authenticate with. An administrator needs to replace it.' };
  }
}
