// Pure decision logic for the user lifecycle (rename / delete / reconcile).
// Extracted so it is directly unit-testable without booting a server or
// faking HTTP-level concurrency. The actual mutual-exclusion guarantee comes
// from app/lifecycle-lock.js (a cross-process lock) wrapping every call into
// this module's callers in app/server.js — these are the DECISIONS made once
// inside that lock, including the ABA guard a lock alone doesn't provide by
// itself (a bug in the caller could still apply a stale decision even while
// correctly serialized).

// Resolve whatever a client's URL happens to name to a CURRENT user record.
// The exact current username wins first — unambiguous, and correct even for
// a user who has nothing to do with any pending rename. Only when there is
// no exact match do we fall back to a user whose UNFINISHED rename's
// ORIGINAL name was `target`: this is what makes retrying a rename via its
// literal original url/body idempotent even after users.json has already
// committed the new username (PATCH /api/users/alice {username:"alicia"}
// replayed verbatim after a post-commit failure). An ambiguous match (more
// than one record claims the same origin name — should be prevented by
// reservedUsernameConflict, but never trust that alone) resolves to null
// rather than guessing which one the caller meant.
export function resolveLifecycleTarget(users, target) {
  const exact = users.find((u) => u.username === target);
  if (exact) return exact;
  const viaPending = users.filter((u) => u.pendingCredentialSync?.fromUsername === target);
  return viaPending.length === 1 ? viaPending[0] : null;
}

// A username currently named as the FROM side of a DIFFERENT account's
// unfinished rename is "reserved": that account's credential tree may not
// have been pruned yet, so handing the name to a new or renamed-into account
// risks it inheriting the departing identity's Claude/GitHub OAuth material.
// `excludeUserId` lets an account's own retry of its own pending rename pass
// (its marker's fromUsername is never the same as the NEW name it's asking
// for, but excluding self keeps this check meaningful under composition).
export function reservedUsernameConflict(users, candidateUsername, excludeUserId = null) {
  const holder = users.find((u) => u.pendingCredentialSync?.fromUsername === candidateUsername && u.id !== excludeUserId);
  return holder
    ? `username "${candidateUsername}" is reserved: a pending credential reconciliation for a different account still references it`
    : null;
}

// After a reconciliation's effects have run (project reassignment, git
// resync, credential-tree prune), is it still safe to clear the marker on
// `currentRecord`? False if a DIFFERENT operation (e.g. a newer rename that
// superseded this one between when this operation started and when its
// effects finished) is now the current marker — clearing it would erase
// someone else's still-pending record of unfinished work. The cross-process
// lock already makes the scenario this guards against structurally
// impossible in practice (nothing else can run between this operation's
// steps), but the check costs nothing and remains correct even if that
// invariant is ever loosened by a future change.
export function reconciliationStillCurrent(currentRecord, expectedOpId) {
  return !!(currentRecord && currentRecord.pendingCredentialSync?.opId === expectedOpId);
}
