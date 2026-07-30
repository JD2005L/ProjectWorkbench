// The deploy re-authentication decision.
//
// Deployment slots may require the operator to re-enter their domain password
// (`reauth`). A password saved from an earlier deploy is kept encrypted on the
// user record, so the common case must be "try the saved one and say nothing" —
// prompting first makes storing the password pointless, which is exactly what
// both deploy surfaces used to do.
//
// The decision lives here rather than in the route so it can be tested without
// booting a server, and so the cockpit modal and the standalone Deployment
// Centre are provably driven by ONE contract: the client always requests first
// and reacts to `needPassword`.

export const REAUTH_PROMPT = 'Enter your domain password for deployment:';
export const REAUTH_STALE = 'Your saved deployment password no longer verifies (it may have changed). Please enter your current domain password.';
export const REAUTH_REJECTED = 'Re-authentication failed: your password did not verify.';

// Resolve to either:
//   { ok:true,  password, save }                    -> run the deploy
//   { ok:false, needPassword:true, staleStored, error } -> ask the client (401)
//
// `verify` is injected (the route passes authenticate.bind(null, username)); any
// throw from it is treated as "did not verify", never as success.
export async function resolveDeployReauth({
  reauth = false,
  submitted = '',
  stored = '',
  savePassword = false,
  verify = null,
} = {}) {
  // No re-auth on this slot: a saved password is still forwarded to the script,
  // which is the pre-existing behaviour and unrelated to verification.
  if (!reauth) return { ok: true, password: submitted || stored, save: false };

  // A freshly-entered password wins over the saved one, so a user whose domain
  // password changed can correct it without an admin clearing the stored value.
  const candidate = submitted || stored;
  let verified = false;
  try {
    verified = !!(candidate && (await verify(candidate)));
  } catch {
    verified = false;
  }

  if (verified) {
    return {
      ok: true,
      password: candidate,
      // Only ever persist something the user just typed AND opted to save.
      save: Boolean(submitted && savePassword),
    };
  }

  const staleStored = !submitted && Boolean(stored);
  const noCredentials = !submitted && !stored;
  return {
    ok: false,
    needPassword: true,
    staleStored,
    error: staleStored ? REAUTH_STALE : noCredentials ? REAUTH_PROMPT : REAUTH_REJECTED,
  };
}
