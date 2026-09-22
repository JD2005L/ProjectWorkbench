// A user's saved deployment password, as a STATE rather than a string.
//
// Same rule app/cli-auth-status.js applies to GitHub tokens: "saved but will not
// decrypt" is not "none saved". The remedies differ — re-enter it versus save one
// — and collapsing them is what produced a deploy running with DEPLOY_PASSWORD=''
// while the Users screen still showed the credential as set, so the project's own
// slot script aborted reporting a missing password for a credential the operator
// could plainly see listed. A record becomes unreadable for ordinary reasons: a
// rotated .secret-key, or a users.json carried between instances.
//
// `decrypt` is injected so this is the one implementation of the decision, shared
// by server.js and by the route harness the tests evaluate — two copies of "read
// the credential and judge it" is exactly the duplication that drifts in silence.
export function readStoredDeployPassword(user, decrypt) {
  if (!user?.deployPassword) return { state: 'none', password: '' };
  let password = '';
  try {
    password = decrypt(user.deployPassword);
  } catch {
    return { state: 'unreadable', password: '' };
  }
  // A ciphertext that decrypts to nothing is equally unusable, and saying
  // "unreadable" sends the operator to the same, correct remedy.
  return password ? { state: 'stored', password } : { state: 'unreadable', password: '' };
}

import { canonicalDeployAccount } from './deployment/settings.js';

// Which identity a deploy runs as: the first CONFIGURED level wins.
//
// Candidates arrive most-specific-first (project override, instance default for
// the target, then the operator's own saved credential) and each carries the
// state readStoredDeployPassword() produced plus a `source` name for messages and
// for the audit line.
//
// The asymmetry is the whole point: **absent falls through, unreadable does not.**
// A level that was never configured is not an opinion, so the next level answers.
// A level that WAS configured but cannot be decrypted is a misconfiguration, and
// quietly using the next identity would mean a production deploy running as
// somebody other than the account an administrator chose — or, if it fell all the
// way through, as an empty password, which is the collapse that had a slot script
// reporting "no password supplied" for a credential the Users screen showed as set.
export function resolveDeployIdentity(candidates) {
  for (const candidate of candidates) {
    if (!candidate || candidate.state === 'none') continue;
    return candidate;              // 'stored' runs; 'unreadable' is the caller's to refuse
  }
  return { state: 'none', source: 'none', user: '', password: '' };
}

// The identity seam, with its two dependencies injected: how to decrypt, and how
// to read the workbench's default for a target. One object so the route source
// has a single name to call and the route harness has a single thing to stub —
// the precedence rule itself lives here, in one place, and is unit-tested
// directly rather than re-implemented in a fixture.
export function makeDeployIdentity({ decrypt, instanceCredential }) {
  // A slot's own override (admin-edited in deploy-config.json, deliberately not
  // a UI field yet — the same treatment `runAsRoot` gets, because it is a
  // privilege grant), then the workbench default for the target, then the
  // operator's own saved credential.
  async function resolve(slotConfig, target, operatorRecord) {
    const candidates = [];
    const override = slotConfig?.deployCredential;
    if (override && (override.user || override.password)) {
      // An override is hand-edited in deploy-config.json, so it gets neither the
      // settings validator's completeness check nor its domain canonicalisation.
      // Half a pair is refused here rather than falling through to the instance
      // default, which would publish as an account nobody chose for this slot
      // (PR #74); the account name is still canonicalised so one level cannot
      // hand a script `goa\` while the other hands it `GOA\`.
      const read = override.user && override.password
        ? readStoredDeployPassword({ deployPassword: override.password }, decrypt)
        : { state: 'unreadable', password: '' };
      candidates.push({ state: read.state, source: 'project',
        user: canonicalDeployAccount(override.user || ''), password: read.password });
    }
    if (instanceCredential) candidates.push(await instanceCredential(target));
    if (operatorRecord) {
      const own = readStoredDeployPassword(operatorRecord, decrypt);
      candidates.push({ state: own.state, source: 'operator',
        user: operatorRecord.deployUser || operatorRecord.username || '', password: own.password });
    }
    return resolveDeployIdentity(candidates);
  }

  // DEPLOY_USER/DEPLOY_PASSWORD keep their meaning — the account the deploy
  // authenticates as — so no slot script has to change to benefit.
  // DEPLOY_OPERATOR carries the human who pressed the button, which is the only
  // place that name survives once a shared account is in use.
  function env(identity, operator) {
    if (identity?.state !== 'stored') return null;
    return { DEPLOY_USER: identity.user, DEPLOY_PASSWORD: identity.password,
      DEPLOY_IDENTITY_SOURCE: identity.source, ...(operator ? { DEPLOY_OPERATOR: operator } : {}) };
  }

  // Read-only version probes: an unreadable or unreadable-settings credential
  // yields no probe rather than an error page. The deploy route refuses loudly
  // instead, because publishing under the wrong identity is the harm.
  async function probeEnv(slotConfig, target, operatorRecord, operator) {
    try { return env(await resolve(slotConfig, target, operatorRecord), operator); }
    catch { return null; }
  }

  return { resolve, env, probeEnv };
}
