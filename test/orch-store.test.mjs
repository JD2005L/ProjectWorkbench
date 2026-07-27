// Increment 2 — the durable store.
//
// The orchestration contract's whole value rests on evidence surviving a crash: a job that was
// implementing when the process died must not come back as "probably fine". These tests therefore
// go after durability directly — torn writes, mid-file corruption, concurrent openers, kill -9
// during a write loop — rather than only exercising the happy path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { JournalStore, JournalCorruptError, StoreLockedError } from '../app/orchestrator/store/journal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-store-'));
  return {
    dir,
    journalPath: path.join(dir, 'orchestrator.journal'),
    snapshotPath: path.join(dir, 'orchestrator.snapshot.json'),
    lockPath: path.join(dir, 'orchestrator.lock'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function openStore(paths, overrides = {}) {
  return JournalStore.open({
    journalPath: paths.journalPath,
    snapshotPath: paths.snapshotPath,
    lockPath: paths.lockPath,
    compactEveryRecords: 1_000,
    ...overrides,
  });
}

test('store: writes are readable, and survive a clean reopen', async () => {
  const p = tempPaths();
  try {
    let store = await openStore(p);
    await store.transact((tx) => {
      tx.put('jobs', 'pwjob_1', { workbench_job_id: 'pwjob_1', status: 'received' });
      tx.put('jobs', 'pwjob_2', { workbench_job_id: 'pwjob_2', status: 'queued' });
    });
    assert.equal(store.get('jobs', 'pwjob_1').status, 'received');
    assert.equal(store.list('jobs').length, 2);
    await store.close();

    store = await openStore(p);
    assert.equal(store.get('jobs', 'pwjob_2').status, 'queued');
    assert.equal(store.list('jobs').length, 2);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: a transaction is all-or-nothing — a rejected batch leaves memory and disk untouched', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    await store.transact((tx) => tx.put('jobs', 'pwjob_1', { status: 'received' }));

    await assert.rejects(
      store.transact((tx) => {
        tx.put('jobs', 'pwjob_1', { status: 'implementing' });
        tx.put('jobs', 'pwjob_9', { status: 'received' });
        throw new Error('business rule rejected this batch');
      }),
      /business rule rejected/,
    );

    assert.equal(store.get('jobs', 'pwjob_1').status, 'received', 'the first put must not have applied');
    assert.equal(store.get('jobs', 'pwjob_9'), undefined);
    await store.close();

    const reopened = await openStore(p);
    assert.equal(reopened.get('jobs', 'pwjob_1').status, 'received');
    assert.equal(reopened.get('jobs', 'pwjob_9'), undefined);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});

test('store: a torn trailing record is discarded and every complete record survives', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    for (let i = 1; i <= 5; i++) {
      await store.transact((tx) => tx.put('jobs', `pwjob_${i}`, { n: i }));
    }
    await store.close();

    // Simulate a crash during the sixth append: a partial line with no terminating newline.
    fs.appendFileSync(p.journalPath, '9f8e7d6c {"ops":[{"op":"put","kind":"jobs","id":"pwjob_6"');

    const reopened = await openStore(p);
    assert.equal(reopened.list('jobs').length, 5, 'the five complete records must survive');
    assert.equal(reopened.get('jobs', 'pwjob_6'), undefined, 'the torn record must not be applied');

    // The store must be able to keep writing after recovery, and the recovered file must be clean.
    await reopened.transact((tx) => tx.put('jobs', 'pwjob_7', { n: 7 }));
    await reopened.close();

    const again = await openStore(p);
    assert.equal(again.list('jobs').length, 6);
    assert.equal(again.get('jobs', 'pwjob_7').n, 7);
    await again.close();
  } finally {
    p.cleanup();
  }
});

test('store: mid-file corruption fails closed rather than silently losing durable state', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    for (let i = 1; i <= 4; i++) {
      await store.transact((tx) => tx.put('jobs', `pwjob_${i}`, { n: i }));
    }
    await store.close();

    // Flip a byte inside the payload of the second record — a checksum mismatch that is *not* the
    // final line, so it cannot be explained by a crash mid-append.
    const lines = fs.readFileSync(p.journalPath, 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes('pwjob_2'));
    assert.ok(idx > -1);
    lines[idx] = lines[idx].replace('"n":2', '"n":9');
    fs.writeFileSync(p.journalPath, lines.join('\n'));

    await assert.rejects(openStore(p), JournalCorruptError);
  } finally {
    p.cleanup();
  }
});

test('store: durable sequence counters are gapless and monotonic across a restart', async () => {
  const p = tempPaths();
  try {
    let store = await openStore(p);
    const first = [];
    for (let i = 0; i < 3; i++) {
      first.push(await store.transact((tx) => tx.nextSequence('events:pwjob_1')));
    }
    assert.deepEqual(first, [1, 2, 3]);
    await store.close();

    store = await openStore(p);
    // The counter must resume from the durable value, never from an in-memory zero: the sequence is
    // the SSE resume cursor, so a repeat would silently rewrite a consumer's history.
    const next = await store.transact((tx) => tx.nextSequence('events:pwjob_1'));
    assert.equal(next, 4);
    assert.equal(store.counter('events:pwjob_1'), 4);
    assert.equal(store.counter('events:pwjob_unknown'), 0);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: compaction snapshots state, shrinks the journal, and loses nothing', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p, { compactEveryRecords: 10 });
    for (let i = 1; i <= 40; i++) {
      await store.transact((tx) => {
        tx.put('jobs', `pwjob_${i}`, { n: i });
        tx.nextSequence('global');
      });
    }
    assert.ok(fs.existsSync(p.snapshotPath), 'a snapshot must have been written');
    const journalLines = fs.readFileSync(p.journalPath, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(journalLines < 40, `journal should have been compacted, saw ${journalLines} records`);
    await store.close();

    const reopened = await openStore(p, { compactEveryRecords: 10 });
    assert.equal(reopened.list('jobs').length, 40);
    assert.equal(reopened.get('jobs', 'pwjob_37').n, 37);
    assert.equal(reopened.counter('global'), 40);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});

test('store: deletes are durable and do not resurrect after compaction', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p, { compactEveryRecords: 5 });
    for (let i = 1; i <= 12; i++) {
      await store.transact((tx) => tx.put('jobs', `pwjob_${i}`, { n: i }));
    }
    await store.transact((tx) => tx.delete('jobs', 'pwjob_3'));
    for (let i = 13; i <= 20; i++) {
      await store.transact((tx) => tx.put('jobs', `pwjob_${i}`, { n: i }));
    }
    await store.close();

    const reopened = await openStore(p, { compactEveryRecords: 5 });
    assert.equal(reopened.get('jobs', 'pwjob_3'), undefined, 'a deleted record must stay deleted');
    assert.equal(reopened.list('jobs').length, 19);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});

test('store: a second opener is refused while the first holds the lock', async () => {
  const p = tempPaths();
  try {
    const first = await openStore(p);
    await assert.rejects(openStore(p), StoreLockedError);
    await first.close();
    // Once released, the lock is available again.
    const second = await openStore(p);
    await second.close();
  } finally {
    p.cleanup();
  }
});

test('store: a lock left by a dead process is reclaimed rather than deadlocking the service', async () => {
  const p = tempPaths();
  try {
    // A pid that cannot be running: write a stale lock by hand.
    fs.writeFileSync(p.lockPath, JSON.stringify({ pid: 2 ** 30, acquiredAt: new Date().toISOString(), host: os.hostname() }));
    const store = await openStore(p);
    await store.transact((tx) => tx.put('jobs', 'pwjob_1', { n: 1 }));
    assert.equal(store.get('jobs', 'pwjob_1').n, 1);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: kill -9 mid-write leaves a consistent prefix with no partially applied batch', async (t) => {
  const p = tempPaths();
  const writer = path.join(HERE, 'fixtures', 'orch-store-writer.mjs');
  try {
    const child = spawn(process.execPath, [writer, p.journalPath, p.snapshotPath, p.lockPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let wrote = 0;
    child.stdout.on('data', (d) => { wrote += String(d).split('\n').filter(Boolean).length; });

    // Let it get well into the write loop, then kill it without warning.
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(wrote > 5, `writer should have committed several batches, saw ${wrote}`);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    const store = await openStore(p);
    const jobs = store.list('jobs');
    assert.ok(jobs.length > 0, 'committed work must survive the kill');
    // Every batch wrote a job and its paired event together. A half-applied batch would show up as
    // a job with no event, which is exactly the "state no record explains" the contract forbids.
    for (const job of jobs) {
      assert.ok(store.get('events', `ev_${job.n}`), `batch ${job.n} applied its job but not its event`);
    }
    assert.equal(store.counter('global'), jobs.length, 'the durable counter must match the applied batches');
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: migrations run once, in order, and are recorded durably', async () => {
  const p = tempPaths();
  const applied = [];
  const migrations = [
    { version: 1, name: 'seed-meta', up: (tx) => { applied.push(1); tx.put('meta', 'k', { v: 'a' }); } },
    { version: 2, name: 'rename-value', up: (tx, state) => { applied.push(2); tx.put('meta', 'k', { v: `${state.get('meta', 'k').v}-b` }); } },
  ];
  try {
    let store = await openStore(p, { migrations });
    assert.deepEqual(applied, [1, 2]);
    assert.equal(store.get('meta', 'k').v, 'a-b');
    assert.equal(store.schemaVersion, 2);
    await store.close();

    // A restart must not re-run them.
    store = await openStore(p, { migrations });
    assert.deepEqual(applied, [1, 2], 'migrations must not run twice');
    assert.equal(store.get('meta', 'k').v, 'a-b');
    await store.close();

    // A later build adds one more migration; only the new one runs.
    const withThird = [...migrations, { version: 3, name: 'add-flag', up: (tx) => { applied.push(3); tx.put('meta', 'flag', { on: true }); } }];
    store = await openStore(p, { migrations: withThird });
    assert.deepEqual(applied, [1, 2, 3]);
    assert.equal(store.schemaVersion, 3);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: opening against a newer schema than this build understands fails closed', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p, {
      migrations: [{ version: 1, name: 'a', up: () => {} }, { version: 2, name: 'b', up: () => {} }],
    });
    await store.close();
    // An older binary must refuse rather than write records the newer schema will misread.
    await assert.rejects(
      openStore(p, { migrations: [{ version: 1, name: 'a', up: () => {} }] }),
      /newer schema/i,
    );
  } finally {
    p.cleanup();
  }
});

test('store: stored records are deep-frozen snapshots, so a caller cannot mutate durable state', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    const original = { status: 'received', nested: { turns: 1 } };
    await store.transact((tx) => tx.put('jobs', 'pwjob_1', original));

    // Mutating the object we handed in must not change what the store holds.
    original.status = 'completed';
    original.nested.turns = 99;
    assert.equal(store.get('jobs', 'pwjob_1').status, 'received');
    assert.equal(store.get('jobs', 'pwjob_1').nested.turns, 1);

    // And the returned record must not be mutable either.
    const held = store.get('jobs', 'pwjob_1');
    assert.throws(() => { held.status = 'completed'; }, TypeError);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: a failed durable append leaves memory untouched — durability precedes visibility', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    await store.transact((tx) => tx.put('jobs', 'pwjob_1', { status: 'received' }));

    // Take the journal's file descriptor away to simulate an I/O failure at commit time. The
    // ordering rule under test is that state becomes *visible* only after it is durable: if the
    // append fails, nothing may have been applied to memory.
    fs.closeSync(store._fd);

    await assert.rejects(store.transact((tx) => tx.put('jobs', 'pwjob_2', { status: 'implementing' })));
    assert.equal(store.get('jobs', 'pwjob_2'), undefined, 'an undurable write must never be visible');
    assert.equal(store.get('jobs', 'pwjob_1').status, 'received');

    store._fd = fs.openSync(p.journalPath, 'a');
    await store.close();

    const reopened = await openStore(p);
    assert.equal(reopened.get('jobs', 'pwjob_2'), undefined);
    assert.equal(reopened.list('jobs').length, 1);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});

test('store: an async transaction callback is refused, which is what keeps a batch atomic', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    // An `await` inside a transaction would let another transaction observe a half-built batch.
    // The guard is the invariant; without it, serialisation guarantees nothing.
    await assert.rejects(
      store.transact(async (tx) => tx.put('jobs', 'pwjob_1', {})),
      /must be synchronous/,
    );
    assert.equal(store.list('jobs').length, 0);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('store: a closed store refuses further writes rather than losing them silently', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    await store.transact((tx) => tx.put('jobs', 'pwjob_1', { n: 1 }));
    await store.close();
    await assert.rejects(store.transact((tx) => tx.put('jobs', 'pwjob_2', { n: 2 })), /closed/);
    await store.close(); // idempotent

    const reopened = await openStore(p);
    assert.equal(reopened.list('jobs').length, 1);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});

test('store: writes are serialised, so concurrent transactions cannot interleave', async () => {
  const p = tempPaths();
  try {
    const store = await openStore(p);
    // Fire 50 read-modify-write transactions at once. With a single writer each must observe the
    // previous one's result, so the counter lands exactly on 50 with no lost update.
    await Promise.all(Array.from({ length: 50 }, () => store.transact((tx, state) => {
      const current = state.get('meta', 'counter')?.n ?? 0;
      tx.put('meta', 'counter', { n: current + 1 });
    })));
    assert.equal(store.get('meta', 'counter').n, 50);
    await store.close();

    const reopened = await openStore(p);
    assert.equal(reopened.get('meta', 'counter').n, 50);
    await reopened.close();
  } finally {
    p.cleanup();
  }
});
