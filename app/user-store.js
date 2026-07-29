// Serialized read-modify-write for the users store.
//
// Every user mutation used to follow the same shape:
//
//   const users = await loadUsers();     // whole-file snapshot
//   ...await something slow...           // LDAP bind, scrypt hash
//   user.field = value;
//   await saveUsers(users);              // writes the WHOLE stale snapshot back
//
// Anything another request changed during the slow await is silently reverted on
// save — a role change, a rotated GitHub token, a new deploy password, or an
// entire user deletion can be resurrected. The deploy re-auth path made this
// easy to hit because it awaits a directory bind between the load and the save.
//
// createUserStore() closes that by (a) re-reading the file AFTER the slow work
// has finished, so the mutation is applied to current data, and (b) chaining
// updates so two of them can never interleave their read-modify-write.
//
// The mutator therefore runs against a FRESH list and must locate its own record
// by identity rather than closing over one loaded earlier.
//
// The same class of bug exists one layer up: a caller that commits a user
// mutation and THEN fires off a detached credential side effect (resync a
// project's git credential helper, prune a renamed user's old credential
// directory) has serialized the write but not the effect. Two concurrent
// mutations can commit in order A-then-B and still run those effects in
// either order, so update() accepts an optional `effect` that runs inside the
// SAME tail, after a successful save — see the update() doc comment below.

export function createUserStore({ load, save }) {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new Error('createUserStore requires load and save functions');
  }

  // Tail of the serialization chain. Each update waits for the previous one to
  // settle; a rejection is absorbed here so one failure cannot wedge the queue.
  let tail = Promise.resolve();

  // `effect`, when given, runs AFTER a successful save but BEFORE the next
  // queued update's `load()` — i.e. inside the very same serialized tail as
  // the users.json write. That is what makes it safe for a caller to put a
  // credential-side-effect (git config resync, a stale credential-tree prune)
  // in there: two concurrent mutations can no longer commit users.json in one
  // order and run their derived-state effects in the other, because the next
  // mutation literally cannot start until this one's effect has finished.
  function update(mutate, effect) {
    const run = tail.then(async () => {
      const users = await load();
      const outcome = await mutate(users);
      // A mutator returns false to say "nothing to persist" (record vanished,
      // or the value was already correct) so we do not rewrite the file.
      if (outcome === false) return { changed: false, result: outcome };
      await save(users);
      // `resave` lets the effect persist a follow-up mutation to the SAME
      // in-memory `users` (e.g. "clear the marker I set once reconciliation
      // actually succeeded") without calling update()/updateUser() again.
      // Re-entering update() from inside an effect would chain onto `tail`,
      // which by then already points at THIS call's own `run` — a
      // self-deadlock, since the inner call could never settle before the
      // outer one does. resave() writes directly, bypassing the queue,
      // which is safe here: we already hold the only slot in it.
      if (effect) await effect(users, outcome, () => save(users));
      return { changed: true, result: outcome };
    });
    tail = run.then(() => {}, () => {});
    return run;
  }

  // Convenience for the common "change one field on one user" case.
  function updateUser(match, mutate) {
    const find = typeof match === 'function' ? match : (u) => u && u.username === match;
    return update(async (users) => {
      const rec = users.find(find);
      if (!rec) return false;
      const outcome = await mutate(rec, users);
      return outcome === false ? false : rec;
    });
  }

  return { update, updateUser };
}
