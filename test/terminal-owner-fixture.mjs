// Give a private test instance a terminal owner it can actually resolve.
//
// THE DEFECT THIS EXISTS TO FIX. Workspace boxes (`_inbox`, `_outbox`) are
// operated on by a worker running AS the resolved terminal owner, and a
// dashboard that cannot resolve that owner REFUSES rather than doing the work as
// root (see app/workspace-file.js). Host mode resolves the owner by name, and
// that name defaults to the literal `admin` — which exists on PVI2/CT2115 and
// does not exist on a GitHub runner, where the suite runs as `runner`. So a
// fixture that boots a server without naming an owner passes on a developer's
// box and fails in CI with `{"ok":false,"error":"Refused: the terminal owner
// could not be resolved …"}`, which is the production behaviour working exactly
// as intended against a fixture that never configured itself.
//
// The repair belongs in the FIXTURE, not in production: no fallback is weakened
// and no root filesystem access is restored. A hermetic instance simply declares
// that its terminal owner is the account already running the suite, so
// credentialExecutionPlan reports `already-owner`, nothing is dropped, and the
// test needs no privilege at all.
//
// The genuinely privileged evidence — a root controller handing work to a
// DIFFERENT, unprivileged account — deliberately stays in
// test/upload-privilege-real.test.mjs and test/box-privilege-real.test.mjs,
// where the two uids differ and the assertions therefore cannot be vacuous.
// Nothing here is a substitute for those.
import os from 'node:os';

/**
 * Environment naming the current account as a private instance's terminal owner,
 * portable across both deploy modes.
 *
 * BOTH key sets are supplied on purpose. Host mode resolves the owner by NAME
 * through passwd (`PW_HOST_TERMINAL_USER`); container mode resolves it by
 * NUMERIC uid/gid (`PW_TERMINAL_UID`/`PW_TERMINAL_GID`). A fixture must not have
 * to care which mode the instance ends up in, and each key is inert in the other
 * mode, so one block covers the whole `PW_DEPLOY_MODE` matrix.
 */
export function selfOwnedTerminalEnv(user = os.userInfo()) {
  // A root runner has no distinct unprivileged owner to name, by design: uid 0
  // is refused by parsePasswdEntry AND by terminalOwnerPlan, precisely so a
  // user's private files are never handed to root. Container mode without
  // PW_TERMINAL_UID is the honest description of "dashboard and panes share an
  // account", which is what a root runner actually is.
  if (Number(user.uid) === 0) return { PW_DEPLOY_MODE: 'container' };
  return {
    PW_HOST_TERMINAL_USER: user.username,
    PW_TERMINAL_USER: user.username,
    PW_TERMINAL_UID: String(user.uid),
    PW_TERMINAL_GID: String(user.gid),
  };
}
