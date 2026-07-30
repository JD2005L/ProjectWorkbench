// Pure decision logic for the user lifecycle (rename/delete/reconcile),
// extracted out of the route handlers so it's directly unit-testable without
// booting a server or faking HTTP-level concurrency. The actual mutual-
// exclusion guarantee comes from app/lifecycle-lock.js (a cross-process
// lock) wrapping calls into these functions in app/server.js — these are the
// DECISIONS made once inside it, including the ABA guard that a lock alone
// doesn't document or prove by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLifecycleTarget, reservedUsernameConflict, reconciliationStillCurrent } from '../app/user-lifecycle.js';

test('resolveLifecycleTarget: an exact current username always wins, even if someone else has a pending marker naming it', () => {
  const users = [
    { id: 'u1', username: 'alice' },
    { id: 'u2', username: 'alicia', pendingCredentialSync: { opId: 'x', fromUsername: 'alice', toUsername: 'alicia' } },
  ];
  // "alice" is BOTH a real current user AND the "from" of u2's pending
  // rename. The real, current, unambiguous alice must win.
  assert.equal(resolveLifecycleTarget(users, 'alice'), users[0]);
});

test('resolveLifecycleTarget: falls back to the unfinished rename\'s original name when there is no current exact match', () => {
  const users = [{ id: 'u2', username: 'alicia', pendingCredentialSync: { opId: 'x', fromUsername: 'alice', toUsername: 'alicia' } }];
  assert.equal(resolveLifecycleTarget(users, 'alice'), users[0]);
});

test('resolveLifecycleTarget: no match at all resolves to null', () => {
  assert.equal(resolveLifecycleTarget([{ id: 'u1', username: 'bob' }], 'ghost'), null);
});

test('REGRESSION: resolveLifecycleTarget refuses to guess when two records ambiguously claim the same origin name', () => {
  const users = [
    { id: 'u1', username: 'x1', pendingCredentialSync: { opId: 'a', fromUsername: 'alice', toUsername: 'x1' } },
    { id: 'u2', username: 'x2', pendingCredentialSync: { opId: 'b', fromUsername: 'alice', toUsername: 'x2' } },
  ];
  assert.equal(resolveLifecycleTarget(users, 'alice'), null, 'an ambiguous match must never resolve to a guess');
});

test('reservedUsernameConflict: flags a name that is the origin of someone ELSE\'s pending rename', () => {
  const users = [{ id: 'u2', username: 'alicia', pendingCredentialSync: { opId: 'x', fromUsername: 'alice', toUsername: 'alicia' } }];
  assert.match(reservedUsernameConflict(users, 'alice', null), /reserved/i);
});

test('reservedUsernameConflict: does not flag the SAME account retrying its own pending rename', () => {
  const users = [{ id: 'u2', username: 'alicia', pendingCredentialSync: { opId: 'x', fromUsername: 'alice', toUsername: 'alicia' } }];
  assert.equal(reservedUsernameConflict(users, 'alice', 'u2'), null);
});

test('reservedUsernameConflict: a name with no pending marker anywhere is unreserved', () => {
  assert.equal(reservedUsernameConflict([{ id: 'u1', username: 'bob' }], 'carol', null), null);
});

test('REGRESSION: reconciliationStillCurrent is false when a NEWER operation has superseded the marker (the ABA guard)', () => {
  // Models: reconcile A captured opId 'A-old'; while its (slow) effects ran,
  // a completely different rename operation replaced the marker with a new
  // opId. Finalizing (clearing) under the STALE opId here would erase that
  // newer operation's still-pending record of unfinished work.
  const supersededRecord = { id: 'u1', username: 'wonderland', pendingCredentialSync: { opId: 'B-new', fromUsername: 'alice', toUsername: 'wonderland' } };
  assert.equal(reconciliationStillCurrent(supersededRecord, 'A-old'), false);
});

test('reconciliationStillCurrent is true when nothing else has touched the marker since', () => {
  const record = { id: 'u1', username: 'alicia', pendingCredentialSync: { opId: 'X', fromUsername: 'alice', toUsername: 'alicia' } };
  assert.equal(reconciliationStillCurrent(record, 'X'), true);
});

test('reconciliationStillCurrent is false once the marker has already been cleared (record gone or unmarked)', () => {
  assert.equal(reconciliationStillCurrent({ id: 'u1', username: 'alicia' }, 'X'), false);
  assert.equal(reconciliationStillCurrent(null, 'X'), false);
});
