// GitHub OAuth device flow, so a person can authorise their own GitHub access from the
// dashboard instead of hand-making a personal access token.
//
// WHY THIS EXISTS
//
// One stored token per person has to do two unrelated jobs on this workbench: it is the
// push credential pinned into every repository that person owns, and it is what
// authenticates Copilot in their terminals. Those need different things — pushing needs
// write access to the repository, Copilot needs a token type it accepts — and a
// hand-made PAT routinely satisfies one and fails the other. That has now happened in
// both directions here: a classic PAT that pushed perfectly and Copilot refused, then a
// fine-grained PAT that Copilot accepted and could not push.
//
// An OAuth token avoids the whole class: the user authorises an app, and the token
// carries whatever that authorisation grants rather than whatever someone remembered to
// tick. (Which app matters — see CLIENT ID below.)
//
// WHY THE DEVICE FLOW AND NOT THE WEB FLOW
//
// The web flow needs a registered redirect URL that GitHub can reach, and this
// workbench is a LAN host behind a private CA. The device flow needs no inbound
// anything: the dashboard asks GitHub for a code, the person types that code into
// github.com in their own browser, and the dashboard polls for the result. It is also
// what `gh auth login` and `copilot login` do here for the same reason.
//
// NOTHING IN THIS MODULE TOUCHES DISK OR STATE. It is the protocol only, with fetch
// injected, so the state machine can be tested without a network and the caller keeps
// the decisions about who may authorise whom and where the token is stored.

export const DEVICE_CODE_PATH = '/login/device/code';
export const ACCESS_TOKEN_PATH = '/login/oauth/access_token';

/**
 * CLIENT ID. Deliberately unset by default, which leaves the feature OFF.
 *
 * Two ways to fill it, and they are not equivalent:
 *
 *   * an OAuth app this organisation registers (GitHub > Developer settings > OAuth
 *     Apps, "Enable Device Flow" ticked). Correct and accountable — the grant is to a
 *     named app the org controls. Tokens from it push fine. Whether Copilot accepts
 *     them is NOT guaranteed: GitHub gates Copilot API access, and a self-registered
 *     app is not on that list.
 *
 *   * the GitHub CLI's own public client id. Copilot CLI documents that it accepts
 *     "OAuth tokens from the GitHub CLI (gh) app", so such a token does both jobs —
 *     which is exactly why the one working token on this box is of that kind. It is
 *     also, strictly, authorising as another vendor's app, which is an operator's
 *     decision to make deliberately rather than something this code should assume.
 *
 * So: no default. An unset client id produces an actionable message instead of a
 * silent fallback.
 */
export function githubOauthConfig(env = {}) {
  const clientId = String(env.PW_GITHUB_OAUTH_CLIENT_ID || '').trim();
  const rawScopes = String(env.PW_GITHUB_OAUTH_SCOPES ?? 'repo,read:org,workflow').trim();
  return {
    enabled: !!clientId,
    clientId,
    // GitHub wants a space-separated list; a comma-separated env var is friendlier.
    scopes: rawScopes ? rawScopes.split(/[,\s]+/).filter(Boolean).join(' ') : '',
    base: String(env.PW_GITHUB_OAUTH_BASE || 'https://github.com').replace(/\/+$/, ''),
    apiBase: String(env.PW_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* GitHub answering with something else */ }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`GitHub returned an unreadable response (HTTP ${res.status})`);
  }
  return parsed;
}

/**
 * Ask GitHub for a device code. Returns what the PERSON needs (a code to type and a URL
 * to type it into) plus what the POLLER needs (the device code and the interval).
 *
 * The device code is a bearer-ish secret for the pending authorisation: whoever holds it
 * collects the resulting token. It is returned to the caller so it can be kept
 * server-side, and must never be handed to a browser.
 */
export async function startDeviceFlow({ fetchImpl, config }) {
  const out = await postJson(fetchImpl, `${config.base}${DEVICE_CODE_PATH}`, {
    client_id: config.clientId,
    scope: config.scopes,
  });
  if (out.error) throw new Error(githubErrorMessage(out));
  if (!out.device_code || !out.user_code || !out.verification_uri) {
    throw new Error('GitHub did not return a device code — check the client id has Device Flow enabled.');
  }
  return {
    deviceCode: String(out.device_code),
    userCode: String(out.user_code),
    verificationUri: String(out.verification_uri),
    // Defaults straight from the device-flow spec, for a server that omits them.
    intervalMs: Math.max(1, Number(out.interval) || 5) * 1000,
    expiresInMs: Math.max(60, Number(out.expires_in) || 900) * 1000,
  };
}

/**
 * One poll. Returns a STATUS rather than throwing for the expected outcomes, because
 * "not yet" is the normal case and "the person declined" is a legitimate answer:
 *
 *   pending    keep waiting at the current interval
 *   slow-down  keep waiting, but GitHub says the interval was too fast
 *   ok         { token }
 *   denied     the person refused the authorisation
 *   expired    the code timed out; start again
 */
export async function pollDeviceFlow({ fetchImpl, config, deviceCode }) {
  const out = await postJson(fetchImpl, `${config.base}${ACCESS_TOKEN_PATH}`, {
    client_id: config.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (out.access_token) return { status: 'ok', token: String(out.access_token) };
  switch (out.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow-down', intervalMs: Math.max(1, Number(out.interval) || 10) * 1000 };
    case 'access_denied': return { status: 'denied' };
    case 'expired_token': return { status: 'expired' };
    default: throw new Error(githubErrorMessage(out));
  }
}

/**
 * Whose account did that token actually authorise, and what does it grant?
 *
 * Asked because the flow can be STARTED by an administrator on somebody else's row —
 * the authorisation itself happens in whichever GitHub session the person at the browser
 * is signed into, which is not necessarily the person the row names. Recording and
 * showing the GitHub login makes a mis-binding visible instead of silent.
 *
 * Scopes come from the response header, which is the only place they appear.
 */
export async function verifyToken({ fetchImpl, config, token }) {
  const res = await fetchImpl(`${config.apiBase}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub rejected the new token when verifying it (HTTP ${res.status})`);
  let body = null;
  try { body = await res.json(); } catch { /* fall through to the shape check */ }
  const login = body && typeof body.login === 'string' ? body.login : '';
  if (!login) throw new Error('GitHub did not say which account this token belongs to.');
  const scopeHeader = (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-oauth-scopes')) || '';
  return { login, scopes: String(scopeHeader).split(',').map((s) => s.trim()).filter(Boolean) };
}

/** GitHub's own message, when it gives one, rather than a generic failure. */
function githubErrorMessage(out) {
  const code = out.error ? String(out.error) : 'unknown_error';
  const desc = out.error_description ? String(out.error_description) : '';
  if (code === 'unauthorized_client' || code === 'invalid_client') {
    return `GitHub refused the configured OAuth client (${code}). Check PW_GITHUB_OAUTH_CLIENT_ID, and that the app has Device Flow enabled.${desc ? ` GitHub said: ${desc}` : ''}`;
  }
  return desc ? `GitHub refused the request (${code}): ${desc}` : `GitHub refused the request (${code}).`;
}

/**
 * Does this token look able to do the two jobs a stored token has here?
 *
 * Advisory, and honest about it: scopes are what the token CARRIES, not what the
 * repository grants — a token with `repo` still cannot push where its account has no
 * write access, which is the failure that started all this. Copilot is not a scope at
 * all; acceptance depends on the app the token came from, so it can only be reported as
 * unknown rather than guessed at.
 */
export function describeTokenCapability(scopes = []) {
  const set = new Set(scopes);
  const canPush = set.has('repo') || set.has('public_repo') || set.has('write:packages');
  return {
    canPush,
    pushNote: canPush
      ? 'Carries the repo scope, so it can push wherever this GitHub account already has write access.'
      : 'Does NOT carry the repo scope, so it cannot push. Re-authorise including repo access.',
  };
}
