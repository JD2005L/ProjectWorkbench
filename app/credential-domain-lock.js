// One serialization domain for everything that can invalidate a project's git
// credential state.
//
// ============================================================================
// THE DEFECT THIS REPLACES
//
// Credential work used to be reached through two DIFFERENT cross-process locks:
// project routes held the projects lock, user-lifecycle routes held the
// lifecycle lock. Neither excluded the other, so a project rename/delete could
// run concurrently with a token rotation on the same repository — the rotation
// then failing ENOENT against a workspace that had just been moved out from
// under it. A `serialized: true` flag travelling in the job proved nothing: it
// is a literal, true whether or not any lock was ever taken.
//
// THE PROTOCOL
//
// There is ONE canonical total order:
//
//     lifecycle  >  workspace  >  projects  >  credential
//
// Every operation names the locks it needs and acquires them in that order.
// Because every acquisition is a PREFIX-CONSISTENT walk of a single total order,
// no cycle can form, so the protocol is deadlock-free by construction rather
// than by convention.
//
// Two properties make that claim checkable instead of aspirational:
//
//   - Re-entrancy is real. `AsyncLocalStorage` scopes the set of currently-held
//     locks to the ASYNC CALL CHAIN, not the process, so an inner
//     `withLocks(['credential'])` inside an outer `withLocks(['lifecycle',
//     'projects'])` skips what it already holds — while a genuinely concurrent
//     request, which has its own async context, sees an empty set and blocks on
//     flock as it should. A process-global "held" set would have let the second
//     request walk straight through.
//
//   - Out-of-order acquisition THROWS. Asking for a lock that ranks below one
//     already held is the only way this design could deadlock, so it is refused
//     loudly at the call site instead of hanging in production. That refusal is
//     directly tested.
//
// The underlying exclusion is `app/lifecycle-lock.js`'s real flock(2) — kernel
// enforced, released automatically when a holder dies, and effective between
// separate open file descriptions, so it serializes two concurrent operations
// inside ONE process just as it does across two processes.
// ============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';

import { withLifecycleLock } from './lifecycle-lock.js';

// Lowest rank is acquired first. Adding a lock means placing it in this list,
// which is the whole specification of the ordering.
// `workspace` is the one that may legitimately be held for a long time: cloning,
// chown, rm -rf, routing and systemd all happen under it, and nothing latency
// sensitive waits on it. `projects` sits BELOW it so a registry transaction stays
// short — that is the lock a credential rotation waits on, and it must never be
// held across a network clone.
export const LOCK_ORDER = ['lifecycle', 'workspace', 'projects', 'credential'];

const RANK = new Map(LOCK_ORDER.map((name, i) => [name, i]));

// Scoped to the async call chain — see the note on re-entrancy above.
const heldStore = new AsyncLocalStorage();

export function makeCredentialLockDomain({ lockPaths, acquire = withLifecycleLock, timeoutMs = 15000 }) {
  for (const name of LOCK_ORDER) {
    if (!lockPaths?.[name]) throw new Error(`credential lock domain: no path configured for the "${name}" lock`);
  }

  // The locks held by the current async call chain, in canonical order.
  function heldLockNames() {
    const held = heldStore.getStore();
    return held ? LOCK_ORDER.filter((n) => held.has(n)) : [];
  }

  async function withLocks(names, fn) {
    const requested = Array.isArray(names) ? names : [names];
    for (const name of requested) {
      if (!RANK.has(name)) {
        throw new Error(`credential lock domain: unknown lock "${name}" — the domain is ${LOCK_ORDER.join(' > ')}`);
      }
    }

    const held = heldStore.getStore() ?? new Map();
    const wanted = [...new Set(requested)].sort((a, b) => RANK.get(a) - RANK.get(b));
    const toAcquire = wanted.filter((name) => !held.has(name));

    if (toAcquire.length) {
      const highestHeld = Math.max(-1, ...[...held.keys()].map((n) => RANK.get(n)));
      const lowestNew = Math.min(...toAcquire.map((n) => RANK.get(n)));
      if (lowestNew < highestHeld) {
        const blocker = LOCK_ORDER[highestHeld];
        const offender = LOCK_ORDER[lowestNew];
        throw new Error(
          `credential lock domain: refusing an out-of-order acquisition of "${offender}" while holding "${blocker}" — the canonical order is ${LOCK_ORDER.join(' > ')}. Acquire the outer locks before entering.`,
        );
      }
    }

    const nextHeld = new Map(held);
    for (const name of wanted) nextHeld.set(name, lockPaths[name]);

    const chain = async (index) => {
      if (index >= toAcquire.length) return heldStore.run(nextHeld, fn);
      return acquire(lockPaths[toAcquire[index]], () => chain(index + 1), { timeoutMs });
    };
    return chain(0);
  }

  return { withLocks, heldLockNames, lockPaths };
}
