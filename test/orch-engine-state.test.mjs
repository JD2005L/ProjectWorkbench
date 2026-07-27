// Increment 3 — state machine, durable event log, and leases with fencing tokens.
//
// These three are tested together because they are the safety core: an unnoticed transition edge
// lets work start on an unverified model, a re-issued event sequence corrupts every consumer's
// resume cursor, and a missing fencing check lets a revived orchestrator process write after its
// lease was taken over.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import {
  ALLOWED_TRANSITIONS,
  UNIVERSAL_TERMINAL_TARGETS,
  canTransition,
  assertTransition,
} from '../app/orchestrator/statemachine.js';
import { JobStatus, EventType, TERMINAL_STATES, ActorKind, ErrorCode } from '../app/orchestrator/contract.js';
import { ApiError } from '../app/orchestrator/errors.js';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-eng-'));
  return {
    dir,
    journalPath: path.join(dir, 'j'),
    snapshotPath: path.join(dir, 's.json'),
    lockPath: path.join(dir, 'l'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withRepo(fn, { now } = {}) {
  const p = tempPaths();
  let clock = now ?? (() => new Date('2026-07-27T12:00:00.000Z'));
  const store = await JournalStore.open({ ...p, compactEveryRecords: 500 });
  const repo = new OrchestratorRepository(store, { clock: () => clock() });
  try {
    await fn({ repo, store, setClock: (fn2) => { clock = fn2; }, paths: p });
  } finally {
    await store.close();
    p.cleanup();
  }
}

const WORKBENCH_ACTOR = { kind: ActorKind.WORKBENCH, identifier: 'wb-test' };

// ---------------------------------------------------------------------------
// transition table
// ---------------------------------------------------------------------------

test('states: every job status has a transition entry and terminals have no outgoing edges', () => {
  for (const status of Object.values(JobStatus)) {
    assert.ok(ALLOWED_TRANSITIONS.has(status), `no transition entry for ${status}`);
  }
  for (const status of TERMINAL_STATES) {
    assert.equal(ALLOWED_TRANSITIONS.get(status).size, 0, `${status} must be a sink`);
  }
});

test('states: every non-terminal status can always fail, cancel, expire, or be superseded', () => {
  assert.deepEqual([...UNIVERSAL_TERMINAL_TARGETS].sort(), ['cancelled', 'expired', 'failed', 'superseded']);
  for (const [status, targets] of ALLOWED_TRANSITIONS) {
    if (TERMINAL_STATES.has(status)) continue;
    for (const terminal of UNIVERSAL_TERMINAL_TARGETS) {
      assert.ok(targets.has(terminal), `${status} must be able to reach ${terminal}`);
    }
  }
});

test('states: a configuration block can never reach a coding phase without re-verifying', () => {
  // This is the edge that stops work starting on an unverified model.
  for (const forbidden of [
    JobStatus.IMPLEMENTING, JobStatus.DISCOVERING, JobStatus.PLANNING,
    JobStatus.VERIFYING_TARGETED, JobStatus.VERIFYING_FULL, JobStatus.REVIEWING,
    JobStatus.PUBLISHING, JobStatus.COMPLETED,
  ]) {
    assert.equal(
      canTransition(JobStatus.BLOCKED_CONFIGURATION, forbidden), false,
      `blocked_configuration must not reach ${forbidden}`,
    );
  }
  // It may only resume through session setup and backend verification.
  assert.ok(canTransition(JobStatus.BLOCKED_CONFIGURATION, JobStatus.QUEUED));
  assert.ok(canTransition(JobStatus.BLOCKED_CONFIGURATION, JobStatus.ENSURING_PROJECT_SESSION));
  assert.ok(canTransition(JobStatus.BLOCKED_CONFIGURATION, JobStatus.VERIFYING_BACKEND));
});

test('states: the only forward edge out of backend verification is discovery', () => {
  const targets = ALLOWED_TRANSITIONS.get(JobStatus.VERIFYING_BACKEND);
  const forward = [...targets].filter((t) => !TERMINAL_STATES.has(t) && !String(t).startsWith('blocked_') && !String(t).startsWith('waiting_'));
  assert.deepEqual(forward, [JobStatus.DISCOVERING]);
});

test('states: publication is only reachable through review or an approval wait', () => {
  const inbound = [...ALLOWED_TRANSITIONS.entries()]
    .filter(([, targets]) => targets.has(JobStatus.PUBLISHING))
    .map(([from]) => from)
    .sort();
  assert.deepEqual(inbound, [
    'reviewing', 'waiting_for_approval', 'waiting_for_input', 'waiting_for_publication_approval',
  ]);
  // In particular, implementation can never publish directly.
  assert.equal(canTransition(JobStatus.IMPLEMENTING, JobStatus.PUBLISHING), false);
});

test('states: an illegal transition raises the contract invalid_transition error', () => {
  assert.doesNotThrow(() => assertTransition(JobStatus.RECEIVED, JobStatus.VALIDATING));
  let err;
  try { assertTransition(JobStatus.COMPLETED, JobStatus.IMPLEMENTING); } catch (e) { err = e; }
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, ErrorCode.INVALID_TRANSITION);
  assert.equal(err.status, 409);
  // The message names both states so an operator can see what was attempted, but nothing else.
  assert.match(err.message, /completed/);
  assert.match(err.message, /implementing/);
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

test('events: sequences are per-job, start at 1, and are gapless', async () => {
  await withRepo(async ({ repo, store }) => {
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: 'still working',
      }));
    }
    await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_b', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
      actor: WORKBENCH_ACTOR, message: 'other job',
    }));

    assert.deepEqual(repo.listEvents('pwjob_a').map((e) => e.sequence), [1, 2, 3]);
    assert.deepEqual(repo.listEvents('pwjob_b').map((e) => e.sequence), [1]);
    assert.equal(repo.latestSequence('pwjob_a'), 3);
    assert.equal(repo.latestSequence('pwjob_unknown'), 0);
  });
});

test('events: the cursor pages forward and is bounded', async () => {
  await withRepo(async ({ repo, store }) => {
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.PHASE_STARTED, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: `phase ${i}`,
      }));
    }
    assert.deepEqual(repo.listEvents('pwjob_a', { afterSequence: 7 }).map((e) => e.sequence), [8, 9, 10]);
    assert.deepEqual(repo.listEvents('pwjob_a', { limit: 2 }).map((e) => e.sequence), [1, 2]);
    assert.deepEqual(repo.listEvents('pwjob_a', { afterSequence: 10 }), []);
    // Events come back in sequence order regardless of insertion order in the underlying map.
    const all = repo.listEvents('pwjob_a', { limit: 200 });
    assert.deepEqual(all.map((e) => e.sequence), all.map((e) => e.sequence).slice().sort((a, b) => a - b));
  });
});

test('events: a progress claim without evidence is refused at record time', async () => {
  await withRepo(async ({ repo, store }) => {
    for (const eventType of ['check_completed', 'diff_observed', 'review_completed', 'publication_recorded', 'deployment_recorded']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        store.transact((tx, state) => repo.appendEvent(tx, state, {
          job_id: 'pwjob_a', event_type: eventType, status: JobStatus.VERIFYING_TARGETED,
          actor: WORKBENCH_ACTOR, message: 'the tests passed, trust me',
        })),
        /requires evidence/,
        `${eventType} must require evidence`,
      );
    }
    assert.equal(repo.listEvents('pwjob_a').length, 0, 'a refused event must not consume a sequence');

    // The same event with real evidence is accepted.
    await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.CHECK_COMPLETED, status: JobStatus.VERIFYING_TARGETED,
      actor: WORKBENCH_ACTOR, message: 'targeted tests passed',
      evidence: { command: 'npm test', exit_code: 0, passed: 8, failed: 0 },
    }));
    assert.equal(repo.listEvents('pwjob_a')[0].sequence, 1, 'sequences must not skip over refused events');
  });
});

test('events: an artifact reference counts as corroboration, an empty evidence object does not', async () => {
  await withRepo(async ({ repo, store }) => {
    await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.DIFF_OBSERVED, status: JobStatus.IMPLEMENTING,
      actor: WORKBENCH_ACTOR, message: 'diff observed', artifact_ids: ['pwart_1'],
    }));
    await assert.rejects(
      store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.DIFF_OBSERVED, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: 'diff observed', evidence: {},
      })),
      /requires evidence/,
    );
  });
});

test('events: a heartbeat may not carry evidence and never counts as progress', async () => {
  await withRepo(async ({ repo, store }) => {
    await assert.rejects(
      store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: 'alive', evidence: { exit_code: 0 },
      })),
      /heartbeat must not carry evidence/,
    );
    const beat = await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
      actor: WORKBENCH_ACTOR, message: 'alive',
    }));
    assert.equal(beat.counts_as_progress, false);
  });
});

test('events: a state change must record where it came from', async () => {
  await withRepo(async ({ repo, store }) => {
    await assert.rejects(
      store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.STATE_CHANGED, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: 'moved',
      })),
      /previous status/,
    );
    const changed = await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.STATE_CHANGED, status: JobStatus.IMPLEMENTING,
      previous_status: JobStatus.DISCOVERING, actor: WORKBENCH_ACTOR, message: 'moved',
    }));
    assert.equal(changed.counts_as_progress, true);
  });
});

test('events: free text and evidence are redacted before they are ever stored', async () => {
  await withRepo(async ({ repo, store }) => {
    const stored = await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.CHECK_COMPLETED, status: JobStatus.VERIFYING_TARGETED,
      actor: WORKBENCH_ACTOR,
      message: 'pushed to https://user:supersecrettoken@github.com/o/r.git',
      evidence: { command: 'git push https://user:supersecrettoken@github.com/o/r.git', exit_code: 0 },
    }));
    const blob = JSON.stringify(stored);
    assert.ok(!blob.includes('supersecrettoken'), 'ProjectWorkbench is the first line of redaction');
    assert.ok(blob.includes('[REDACTED]'));
  });
});

test('events: the durable sequence survives a restart and never repeats', async () => {
  const p = tempPaths();
  try {
    let store = await JournalStore.open({ ...p, compactEveryRecords: 500 });
    let repo = new OrchestratorRepository(store, { clock: () => new Date('2026-07-27T12:00:00Z') });
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await store.transact((tx, state) => repo.appendEvent(tx, state, {
        job_id: 'pwjob_a', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
        actor: WORKBENCH_ACTOR, message: 'x',
      }));
    }
    await store.close();

    store = await JournalStore.open({ ...p, compactEveryRecords: 500 });
    repo = new OrchestratorRepository(store, { clock: () => new Date('2026-07-27T12:00:00Z') });
    const next = await store.transact((tx, state) => repo.appendEvent(tx, state, {
      job_id: 'pwjob_a', event_type: EventType.HEARTBEAT, status: JobStatus.IMPLEMENTING,
      actor: WORKBENCH_ACTOR, message: 'after restart',
    }));
    assert.equal(next.sequence, 4, 'a restart must not rewind the SSE resume cursor');
    assert.deepEqual(repo.listEvents('pwjob_a').map((e) => e.sequence), [1, 2, 3, 4]);
    await store.close();
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------
// leases and fencing
// ---------------------------------------------------------------------------

test('leases: acquisition issues a strictly increasing fencing token, never reused after release', async () => {
  await withRepo(async ({ repo, store }) => {
    const a = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-1' }));
    assert.equal(a.fencing_token, 1);
    await store.transact((tx, s) => repo.releaseLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-1', fencingToken: a.fencing_token }));
    const b = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' }));
    assert.equal(b.fencing_token, 2, 'a released token must never be reissued');
  });
});

test('leases: a live lease is not stolen, and the same owner re-entering keeps its token', async () => {
  await withRepo(async ({ repo, store }) => {
    const held = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-1' }));
    await assert.rejects(
      store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' })),
      /held by another owner/,
    );
    const again = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-1' }));
    assert.equal(again.fencing_token, held.fencing_token, 'a re-entrant acquire must not burn a token');
  });
});

test('leases: an expired lease may be taken over, and the takeover raises the token', async () => {
  let now = new Date('2026-07-27T12:00:00.000Z');
  await withRepo(async ({ repo, store }) => {
    const first = await store.transact((tx, s) => repo.acquireLease(tx, s, {
      resource: 'project-write:Demo', owner: 'orch-1', ttlMs: 60_000,
    }));
    now = new Date('2026-07-27T12:00:59.000Z');
    await assert.rejects(
      store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' })),
      /held by another owner/,
      'a lease that has not yet expired must not be stolen',
    );
    now = new Date('2026-07-27T12:01:01.000Z');
    const takeover = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' }));
    assert.ok(takeover.fencing_token > first.fencing_token);

    // The stale holder wakes up believing it still holds the lease. Its token is now old, so every
    // write it attempts must fail — expiry alone cannot prevent this, the token is what does.
    let err;
    try { repo.assertFencing(store, 'project-write:Demo', first.fencing_token); } catch (e) { err = e; }
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, ErrorCode.LEASE_LOST);
    assert.doesNotThrow(() => repo.assertFencing(store, 'project-write:Demo', takeover.fencing_token));
  }, { now: () => now });
});

test('leases: heartbeat renewal extends the holder and rejects a stale renewer', async () => {
  let now = new Date('2026-07-27T12:00:00.000Z');
  await withRepo(async ({ repo, store }) => {
    const held = await store.transact((tx, s) => repo.acquireLease(tx, s, {
      resource: 'project-write:Demo', owner: 'orch-1', ttlMs: 60_000,
    }));
    now = new Date('2026-07-27T12:00:50.000Z');
    const renewed = await store.transact((tx, s) => repo.renewLease(tx, s, {
      resource: 'project-write:Demo', owner: 'orch-1', fencingToken: held.fencing_token, ttlMs: 60_000,
    }));
    assert.equal(renewed.fencing_token, held.fencing_token, 'renewal keeps the token');
    assert.equal(new Date(renewed.expires_at).toISOString(), '2026-07-27T12:01:50.000Z');

    // Past the *original* expiry, the renewed lease is still live and cannot be taken over.
    now = new Date('2026-07-27T12:01:10.000Z');
    await assert.rejects(
      store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' })),
      /held by another owner/,
    );

    await assert.rejects(
      store.transact((tx, s) => repo.renewLease(tx, s, {
        resource: 'project-write:Demo', owner: 'orch-2', fencingToken: held.fencing_token, ttlMs: 60_000,
      })),
      /not the lease holder/,
    );
  }, { now: () => now });
});

test('leases: fencing state survives a restart, so a revived writer is still fenced out', async () => {
  const p = tempPaths();
  const clock = () => new Date('2026-07-27T12:00:00Z');
  try {
    let store = await JournalStore.open({ ...p, compactEveryRecords: 500 });
    let repo = new OrchestratorRepository(store, { clock });
    // ttl 0 against a frozen clock: the lease is already expired, so orch-2 legitimately takes over.
    const first = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-1', ttlMs: 0 }));
    const second = await store.transact((tx, s) => repo.acquireLease(tx, s, { resource: 'project-write:Demo', owner: 'orch-2' }));
    await store.close();

    store = await JournalStore.open({ ...p, compactEveryRecords: 500 });
    repo = new OrchestratorRepository(store, { clock });
    assert.throws(() => repo.assertFencing(store, 'project-write:Demo', first.fencing_token), ApiError);
    assert.doesNotThrow(() => repo.assertFencing(store, 'project-write:Demo', second.fencing_token));
    await store.close();
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the orchestrator's submitted fencing token (contract §7)
// ---------------------------------------------------------------------------

test('fencing: a submission carrying a token lower than one already accepted is refused', async () => {
  await withRepo(async ({ repo, store }) => {
    await store.transact((tx, s) => repo.acceptOrchestratorFencing(tx, s, { projectId: 'Demo', token: 7 }));
    // The same token repeats legitimately: a retry of the same submission.
    await store.transact((tx, s) => repo.acceptOrchestratorFencing(tx, s, { projectId: 'Demo', token: 7 }));
    // A higher token is a legitimate takeover.
    await store.transact((tx, s) => repo.acceptOrchestratorFencing(tx, s, { projectId: 'Demo', token: 8 }));

    let err;
    try {
      await store.transact((tx, s) => repo.acceptOrchestratorFencing(tx, s, { projectId: 'Demo', token: 7 }));
    } catch (e) { err = e; }
    assert.ok(err instanceof ApiError, 'a stale fencing token must be an ApiError');
    assert.equal(err.code, ErrorCode.LEASE_LOST);
    assert.equal(err.status, 409);

    // Fencing is scoped per project: another project's counter is untouched.
    await store.transact((tx, s) => repo.acceptOrchestratorFencing(tx, s, { projectId: 'Other', token: 1 }));
    assert.equal(repo.acceptedFencingToken('Demo'), 8);
    assert.equal(repo.acceptedFencingToken('Other'), 1);
  });
});
