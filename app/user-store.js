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

export function createUserStore({ load, save }) {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new Error('createUserStore requires load and save functions');
  }

  // Tail of the serialization chain. Each update waits for the previous one to
  // settle; a rejection is absorbed here so one failure cannot wedge the queue.
  let tail = Promise.resolve();

  function update(mutate) {
    const run = tail.then(async () => {
      const users = await load();
      const outcome = await mutate(users);
      // A mutator returns false to say "nothing to persist" (record vanished,
      // or the value was already correct) so we do not rewrite the file.
      if (outcome === false) return { changed: false, result: outcome };
      await save(users);
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
