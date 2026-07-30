// Serialized read-modify-write for the users store.
//
// The bug this closes: a request loads the WHOLE users file, awaits something
// slow (an LDAP bind, a scrypt hash), then writes its stale snapshot back —
// silently reverting anything another request changed in the meantime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserStore } from '../app/user-store.js';

// A fake users file. load() deep-copies, exactly like reading and parsing JSON,
// so a caller holding a list cannot see later writes.
function fakeDisk(initial = []) {
  const state = { users: initial, loads: 0, saves: 0 };
  return {
    state,
    load: async () => { state.loads += 1; return JSON.parse(JSON.stringify(state.users)); },
    save: async (users) => { state.saves += 1; state.users = JSON.parse(JSON.stringify(users)); },
  };
}

const usernames = (disk) => disk.state.users.map((u) => u.username);

test('REGRESSION: a slow update cannot resurrect a user deleted while it was in flight', async () => {
  const disk = fakeDisk([{ username: 'alice' }, { username: 'bob' }]);
  const store = createUserStore(disk);

  // The old shape: the deploy route snapshots the users file BEFORE awaiting the
  // directory bind.
  const staleSnapshot = await disk.load();

  // Meanwhile an admin deletes bob.
  await store.update((users) => { users.splice(users.findIndex((u) => u.username === 'bob'), 1); });
  assert.deepEqual(usernames(disk), ['alice']);

  // Demonstrate the bug: writing the stale snapshot back brings bob home.
  staleSnapshot.find((u) => u.username === 'alice').deployPassword = 'enc';
  await disk.save(staleSnapshot);
  assert.deepEqual(usernames(disk), ['alice', 'bob'], 'sanity check: the old shape does resurrect');

  // Now the fixed path: re-read inside the store, mutate the fresh record.
  await store.update((users) => { users.splice(users.findIndex((u) => u.username === 'bob'), 1); });
  await store.updateUser('alice', (rec) => { rec.deployPassword = 'enc2'; });

  assert.deepEqual(usernames(disk), ['alice'], 'bob was resurrected by a stale write');
  assert.equal(disk.state.users[0].deployPassword, 'enc2');
});

test('REGRESSION: a concurrent role change survives a slow password save', async () => {
  const disk = fakeDisk([{ username: 'alice', role: 'viewer' }]);
  const store = createUserStore(disk);

  // Request A: slow (models the deploy re-auth bind) — it must read AFTER the
  // slow work, not before.
  const slow = store.update(async (users) => {
    users.find((u) => u.username === 'alice').deployPassword = 'enc';
  });
  // Request B: a quick role promotion issued while A is still in flight.
  const quick = store.updateUser('alice', (rec) => { rec.role = 'admin'; });

  await Promise.all([slow, quick]);

  const alice = disk.state.users[0];
  assert.equal(alice.role, 'admin', 'the role change was lost');
  assert.equal(alice.deployPassword, 'enc', 'the password save was lost');
});

test('updates are serialized, never interleaved', async () => {
  const disk = fakeDisk([{ username: 'a', n: 0 }]);
  const store = createUserStore(disk);
  const order = [];

  await Promise.all([1, 2, 3, 4, 5].map((i) => store.update(async (users) => {
    order.push(`start${i}`);
    await new Promise((r) => setTimeout(r, 5 - i)); // later calls resolve faster
    users[0].n += 1;
    order.push(`end${i}`);
  })));

  assert.equal(disk.state.users[0].n, 5, 'a lost update: increments were dropped');
  for (let i = 0; i < order.length; i += 2) {
    assert.equal(order[i].replace('start', ''), order[i + 1].replace('end', ''),
      `interleaved: ${order.join(',')}`);
  }
});

test('a mutator returning false does not rewrite the file', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  const before = disk.state.saves;
  const out = await store.update(() => false);
  assert.equal(disk.state.saves, before);
  assert.equal(out.changed, false);
});

test('updateUser reports a missing record instead of creating one', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  const out = await store.updateUser('nobody', (rec) => { rec.role = 'admin'; });
  assert.equal(out.result, false);
  assert.equal(disk.state.users.length, 1);
});

test('updateUser accepts a predicate so callers can match on id', async () => {
  const disk = fakeDisk([{ id: 'u-1', username: 'a' }, { id: 'u-2', username: 'b' }]);
  const store = createUserStore(disk);
  await store.updateUser((u) => u.id === 'u-2', (rec) => { rec.lastLoginAt = 'now'; });
  assert.equal(disk.state.users[1].lastLoginAt, 'now');
  assert.equal(disk.state.users[0].lastLoginAt, undefined);
});

test('a failing update does not wedge the queue', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  await assert.rejects(store.update(() => { throw new Error('boom'); }), /boom/);
  await store.updateUser('a', (rec) => { rec.role = 'admin'; });
  assert.equal(disk.state.users[0].role, 'admin', 'the queue stalled after a failure');
});

test('a failing save does not wedge the queue either', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  let failNext = true;
  const store = createUserStore({
    load: disk.load,
    save: async (u) => { if (failNext) { failNext = false; throw new Error('EIO'); } return disk.save(u); },
  });
  await assert.rejects(store.update((users) => { users[0].role = 'x'; }), /EIO/);
  await store.updateUser('a', (rec) => { rec.role = 'admin'; });
  assert.equal(disk.state.users[0].role, 'admin');
});

test('the store re-reads on every update rather than caching', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  await store.updateUser('a', (rec) => { rec.x = 1; });
  // Somebody edits users.json out of band.
  disk.state.users.push({ username: 'out-of-band' });
  await store.updateUser('a', (rec) => { rec.x = 2; });
  assert.deepEqual(usernames(disk), ['a', 'out-of-band'], 'the out-of-band user was clobbered');
});

test('createUserStore refuses to be built without load and save', () => {
  assert.throws(() => createUserStore({}), /requires load and save/);
  assert.throws(() => createUserStore({ load: () => {} }), /requires load and save/);
});

// ---------------------------------------------------------------------------
// AC3: the credential side-effect lifecycle must be serialized WITH the
// users.json commit, not detached from it. A caller (e.g. the user-rename
// route) needs to run a git-credential resync / prune after a successful
// mutation, and that side effect must be ordered exactly like the commits
// are — otherwise a slow effect for an earlier commit can overwrite a later
// commit's derived state (the credential file, a stamped fingerprint, ...).
// ---------------------------------------------------------------------------

test('update() runs an effect after a successful save, inside the same serialized tail', async () => {
  const disk = fakeDisk([{ username: 'a', n: 0 }]);
  const store = createUserStore(disk);
  const order = [];
  await store.update((users) => { users[0].n = 1; order.push('mutate'); }, async () => { order.push('effect'); });
  assert.deepEqual(order, ['mutate', 'effect']);
});

test('the effect is skipped when the mutator reports nothing to persist', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  let ran = false;
  await store.update(() => false, async () => { ran = true; });
  assert.equal(ran, false, 'an effect must not run for a no-op mutation');
});

test('effect() receives the freshly-saved users and the mutator outcome', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  let seenUsers, seenOutcome;
  await store.update(
    (users) => { const rec = users[0]; rec.role = 'admin'; return rec; },
    async (users, outcome) => { seenUsers = users; seenOutcome = outcome; },
  );
  assert.equal(seenUsers[0].role, 'admin');
  assert.equal(seenOutcome.role, 'admin');
});

test('REGRESSION: a slow effect for a delayed-but-earlier commit A must not clobber a later commit B\'s effect', async () => {
  const disk = fakeDisk([{ username: 'owner', token: '' }]);
  const store = createUserStore(disk);
  // Models a derived store outside users.json (e.g. a project's git credential
  // file) that both commits' side effects write into.
  const derived = { token: '' };

  const A = store.update(
    (users) => { users[0].token = 'TOKEN_A'; return users[0]; },
    async (users) => {
      // The slow step: A's own commit was fast, but resyncing its derived
      // state (a git config write, a credential-helper round trip) is not.
      await new Promise((r) => setTimeout(r, 30));
      derived.token = users.find((u) => u.username === 'owner').token;
    },
  );
  // B is queued right behind A — this is the "newer update" arriving while A
  // is still in flight, exactly like two admin requests racing.
  const B = store.update(
    (users) => { users[0].token = 'TOKEN_B'; return users[0]; },
    async (users) => { derived.token = users.find((u) => u.username === 'owner').token; },
  );

  await Promise.all([A, B]);
  assert.equal(disk.state.users[0].token, 'TOKEN_B', 'users.json must hold the newer commit');
  assert.equal(derived.token, 'TOKEN_B', 'the derived state must reflect the newer commit, not whichever effect happened to finish last');
});

test('an effect that throws surfaces to the caller but does not wedge the queue', async () => {
  const disk = fakeDisk([{ username: 'a' }]);
  const store = createUserStore(disk);
  await assert.rejects(store.update((users) => users[0], async () => { throw new Error('resync failed'); }), /resync failed/);
  // users.json was already committed before the effect ran — the caller can
  // decide how to surface that partial state; the queue itself must survive.
  await store.updateUser('a', (rec) => { rec.role = 'admin'; });
  assert.equal(disk.state.users[0].role, 'admin');
});

// REGRESSION: a real caller needs to clear a marker it set earlier in the
// SAME mutation (e.g. "reconciliation succeeded, stop tracking it as
// pending") once its effect finishes. The naive way to do that is to call
// store.update()/updateUser() again from inside the effect — but that
// re-enters `update()`, which chains onto the SAME `tail` the currently-
// running effect is part of, so the inner call can never settle until the
// outer one does: a self-deadlock. update() must give the effect a way to
// persist a follow-up change WITHOUT re-entering the tail queue.
test('REGRESSION: an effect can persist a follow-up change to the same record without deadlocking on its own tail', async () => {
  const disk = fakeDisk([{ username: 'a', pending: true }]);
  const store = createUserStore(disk);

  const DEADLOCK_TIMEOUT = 2000;
  const run = store.update(
    (users) => users[0],
    async (users, outcome, resave) => {
      delete outcome.pending;
      await resave();
    },
  );
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('DEADLOCK: update() with an effect that resaves never settled')), DEADLOCK_TIMEOUT));
  await Promise.race([run, timeout]);

  assert.equal(disk.state.users[0].pending, undefined, 'the follow-up resave must actually have persisted');
  assert.equal(disk.state.saves, 2, 'one save for the mutation, one for the effect\'s resave');

  // The queue itself must still be alive afterward.
  await store.updateUser('a', (rec) => { rec.role = 'admin'; });
  assert.equal(disk.state.users[0].role, 'admin');
});
