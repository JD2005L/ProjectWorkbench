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
