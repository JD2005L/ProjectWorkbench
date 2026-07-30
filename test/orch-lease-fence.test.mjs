// The durable project write-lease fence.
//
// A lease is designed to expire — that is what lets a crashed worker's project be picked up again
// without an operator's help. That design is exactly wrong for a cancellation whose termination
// could not be confirmed: a descendant may still be alive and writing to the workspace, and "wait for
// the TTL and let someone else in" is precisely how a second job would come to write the same tree a
// live agent has not finished with. A fence is a separate, non-expiring hold on the resource: once
// set it survives lease expiry and lease release attempts alike, and only an explicit `clearFence`
// call — an evidenced operator action, never a timer — takes it down.
//
// `state.get` inside a transaction reads only what is already committed — a transaction stages writes
// and applies them atomically at the end, so it cannot see its own pending `tx.put` calls. Acquiring
// and then fencing therefore take two separate `store.transact` calls throughout, exactly as the
// engine's own `_acquireLease`/`_fenceLease` do it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { MIGRATIONS } from '../app/orchestrator/index.js';
import { ApiError } from '../app/orchestrator/errors.js';

const execFileAsync = promisify(execFile);
const CLEAR_FENCE_SCRIPT = fileURLToPath(new URL('../scripts/pw-orch-clear-fence.mjs', import.meta.url));

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-fence-'));
  return {
    dir,
    journalPath: path.join(dir, 'orchestrator.journal'),
    snapshotPath: path.join(dir, 'orchestrator.snapshot.json'),
    lockPath: path.join(dir, 'orchestrator.lock'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withRepo(fn) {
  const p = tempPaths();
  const store = await JournalStore.open({
    journalPath: p.journalPath, snapshotPath: p.snapshotPath, lockPath: p.lockPath,
    compactEveryRecords: 1_000,
  });
  const repo = new OrchestratorRepository(store);
  try {
    await fn({ repo, store });
  } finally {
    await store.close();
    p.cleanup();
  }
}

const RESOURCE = 'project-write:wb-1:Demo';

/** Acquire, then fence, as two committed steps — returns the fencing token. */
async function acquireAndFence(repo, store, { resource = RESOURCE, owner = 'job-1', ttlMs, reason = 'test' } = {}) {
  const acquired = await store.transact((tx, state) => repo.acquireLease(tx, state, { resource, owner, ttlMs }));
  await store.transact((tx, state) => repo.fenceLease(tx, state, {
    resource, owner, fencingToken: acquired.fencing_token, reason,
  }));
  return acquired.fencing_token;
}

test('fence: a fenced lease refuses acquisition even after its TTL has lapsed', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store, { ttlMs: 5, reason: 'unconfirmed termination' });

    // Let the TTL lapse. A plain lease would now be free for anyone; a fence must not be.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await assert.rejects(
      store.transact((tx, state) => {
        repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-2', ttlMs: 5_000 });
      }),
      (err) => err instanceof ApiError && err.code === 'lease_lost',
      'an expired TTL must not reopen a fenced resource',
    );
  });
});

test('fence: acquireLease rejects while fenced, even for the job that set the fence', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store);

    await assert.rejects(
      store.transact((tx, state) => {
        repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-2' });
      }),
      (err) => err instanceof ApiError && err.code === 'lease_lost',
      'a fenced resource must refuse a new acquisition, even by a different owner',
    );

    // Not even the ORIGINAL owner may quietly re-acquire past a fence — that would be exactly the
    // auto-clear-without-evidence this mechanism exists to prevent.
    await assert.rejects(
      store.transact((tx, state) => {
        repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-1' });
      }),
      (err) => err instanceof ApiError && err.code === 'lease_lost',
    );
  });
});

test('fence: releaseLease is refused while fenced — a late-settling worker cannot undo it', async () => {
  await withRepo(async ({ repo, store }) => {
    const fencingToken = await acquireAndFence(repo, store);

    await assert.rejects(
      store.transact((tx, state) => {
        repo.releaseLease(tx, state, { resource: RESOURCE, owner: 'job-1', fencingToken });
      }),
      (err) => err instanceof ApiError && err.code === 'lease_lost',
    );

    assert.equal(repo.getLease(RESOURCE).fenced, true, 'the fence must still be up');
  });
});

test('fence: fenceLease is a no-op when the caller does not hold the current lease', async () => {
  await withRepo(async ({ repo, store }) => {
    await store.transact((tx, state) => {
      repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-1' });
    });

    // job-2 never held this resource; its late cancellation must not fence a lease it does not own —
    // that would let one job's confusion block an entirely different, legitimate holder.
    await store.transact((tx, state) => {
      repo.fenceLease(tx, state, { resource: RESOURCE, owner: 'job-2', fencingToken: 999_999, reason: 'stale' });
    });

    assert.equal(repo.getLease(RESOURCE).fenced, undefined, 'an unrelated job must not be able to fence this resource');
  });
});

test('fence: clearFence requires an explicit reason and releases the lease outright', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store, { reason: 'unconfirmed' });
    assert.equal(repo.getLease(RESOURCE).fenced, true);

    await store.transact((tx, state) => {
      repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:james', reason: 'verified no surviving descendant, manual ps -ef review' });
    });

    assert.equal(repo.getLease(RESOURCE).fenced, false);

    // And the resource is genuinely free again — a fresh acquisition succeeds.
    await store.transact((tx, state) => {
      repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-3' });
    });
    assert.equal(repo.getLease(RESOURCE).owner, 'job-3');
  });
});

test('fence: clearFence refuses when nothing is fenced — never a silent no-op', async () => {
  await withRepo(async ({ repo, store }) => {
    await store.transact((tx, state) => {
      repo.acquireLease(tx, state, { resource: RESOURCE, owner: 'job-1' });
    });

    await assert.rejects(
      store.transact((tx, state) => {
        repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:james', reason: 'just checking' });
      }),
      (err) => err instanceof ApiError,
      'clearing a fence that is not there must fail loudly, not succeed quietly',
    );
  });
});

// ---------------------------------------------------------------------------
// durable, append-only audit trail for fence-set and fence-clear
//
// `clearFence` writes cleared_at/cleared_by/clear_reason onto the SAME mutable lease row that
// `fenceLease` wrote fenced_at/fenced_by/fenced_reason onto — and the very next `acquireLease` for
// that resource overwrites that row entirely. Nothing durable is left saying a fence ever happened,
// once the resource has moved on. These records are separate, immutable, and keyed so a later
// acquire/fence/clear on the same resource can never touch an earlier entry.
// ---------------------------------------------------------------------------

test('audit: fenceLease appends an immutable record distinct from the mutable lease row', async () => {
  await withRepo(async ({ repo, store }) => {
    const fencingToken = await acquireAndFence(repo, store, { owner: 'job-1', reason: 'unconfirmed termination' });

    const trail = repo.listFenceAudit(RESOURCE);
    assert.equal(trail.length, 1);
    const [entry] = trail;
    assert.equal(entry.resource, RESOURCE);
    assert.equal(entry.action, 'fenced');
    assert.equal(entry.fencing_token, fencingToken);
    assert.equal(entry.owner, 'job-1');
    assert.match(entry.reason, /unconfirmed termination/);
    assert.ok(entry.recorded_at, 'the audit record must carry its own timestamp');
  });
});

test('audit: clearFence appends its own immutable record, naming the operator', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store, { owner: 'job-1', reason: 'unconfirmed termination' });
    await store.transact((tx, state) => {
      repo.clearFence(tx, state, {
        resource: RESOURCE, clearedBy: 'operator:james', reason: 'verified no surviving descendant',
      });
    });

    const trail = repo.listFenceAudit(RESOURCE);
    assert.equal(trail.length, 2, 'both the fence and the clear must be recorded');
    const [fenced, cleared] = trail;
    assert.equal(fenced.action, 'fenced');
    assert.equal(cleared.action, 'cleared');
    assert.equal(cleared.operator, 'operator:james');
    assert.match(cleared.reason, /verified no surviving descendant/);
    // Both entries name the same lease token — the clear is auditably about the fence that preceded it.
    assert.equal(cleared.fencing_token, fenced.fencing_token);
  });
});

test('audit: the trail accumulates across clear -> reacquire -> re-fence, never overwritten', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store, { owner: 'job-1', reason: 'first incident' });
    await store.transact((tx, state) => {
      repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:james', reason: 'cleared after review 1' });
    });

    // The resource is free again — a later job acquires and is itself later fenced.
    await acquireAndFence(repo, store, { owner: 'job-2', reason: 'second incident' });
    await store.transact((tx, state) => {
      repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:maria', reason: 'cleared after review 2' });
    });

    const trail = repo.listFenceAudit(RESOURCE);
    assert.equal(trail.length, 4, 'every fence and every clear across both incidents must still be present');
    assert.deepEqual(trail.map((e) => e.action), ['fenced', 'cleared', 'fenced', 'cleared']);
    assert.deepEqual(trail.map((e) => e.owner), ['job-1', 'job-1', 'job-2', 'job-2']);
    assert.match(trail[0].reason, /first incident/);
    assert.match(trail[2].reason, /second incident/);
    assert.equal(trail[1].operator, 'operator:james');
    assert.equal(trail[3].operator, 'operator:maria');
    // Sequence numbers strictly increase — this is what makes "append-only" a checkable property
    // rather than an assertion about intent.
    for (let i = 1; i < trail.length; i++) assert.ok(trail[i].sequence > trail[i - 1].sequence);

    // And the mutable lease row itself — exactly as before — only reflects the LATEST cycle.
    const lease = repo.getLease(RESOURCE);
    assert.equal(lease.fenced, false);
    assert.equal(lease.cleared_by, 'operator:maria');
  });
});

test('audit: the trail survives its own lease TTL expiring', async () => {
  await withRepo(async ({ repo, store }) => {
    await acquireAndFence(repo, store, { ttlMs: 5, reason: 'unconfirmed termination' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(repo.listFenceAudit(RESOURCE).length, 1, 'a lapsed TTL must not affect the audit trail at all');
  });
});

test('audit: the trail survives a close and reopen of the store', async () => {
  const p = tempPaths();
  try {
    let store = await JournalStore.open({
      journalPath: p.journalPath, snapshotPath: p.snapshotPath, lockPath: p.lockPath, compactEveryRecords: 1_000,
    });
    let repo = new OrchestratorRepository(store);
    await acquireAndFence(repo, store, { owner: 'job-1', reason: 'unconfirmed termination' });
    await store.transact((tx, state) => {
      repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:james', reason: 'reviewed' });
    });
    await store.close();

    store = await JournalStore.open({
      journalPath: p.journalPath, snapshotPath: p.snapshotPath, lockPath: p.lockPath, compactEveryRecords: 1_000,
    });
    repo = new OrchestratorRepository(store);
    const trail = repo.listFenceAudit(RESOURCE);
    assert.equal(trail.length, 2);
    assert.deepEqual(trail.map((e) => e.action), ['fenced', 'cleared']);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('audit: the trail survives compaction — every entry, not just the latest', async () => {
  const p = tempPaths();
  try {
    let store = await JournalStore.open({
      journalPath: p.journalPath, snapshotPath: p.snapshotPath, lockPath: p.lockPath, compactEveryRecords: 3,
    });
    let repo = new OrchestratorRepository(store);

    // Enough fence/clear cycles, at a low compaction threshold, that at least one compaction must
    // have happened mid-sequence — not merely once at the very end.
    for (let i = 1; i <= 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await acquireAndFence(repo, store, { owner: `job-${i}`, reason: `incident ${i}` });
      // eslint-disable-next-line no-await-in-loop
      await store.transact((tx, state) => {
        repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: `operator:${i}`, reason: `reviewed ${i}` });
      });
    }
    assert.ok(fs.existsSync(p.snapshotPath), 'compaction must have run at this threshold');
    await store.close();

    store = await JournalStore.open({
      journalPath: p.journalPath, snapshotPath: p.snapshotPath, lockPath: p.lockPath, compactEveryRecords: 3,
    });
    repo = new OrchestratorRepository(store);
    const trail = repo.listFenceAudit(RESOURCE);
    assert.equal(trail.length, 10, 'all 5 fences and all 5 clears must survive compaction, not just the last cycle');
    assert.deepEqual(trail.map((e) => e.owner), ['job-1', 'job-1', 'job-2', 'job-2', 'job-3', 'job-3', 'job-4', 'job-4', 'job-5', 'job-5']);
    await store.close();
  } finally {
    p.cleanup();
  }
});

test('audit: a secret pasted into the fence or clear reason is redacted in the durable record', async () => {
  await withRepo(async ({ repo, store }) => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    await acquireAndFence(repo, store, { owner: 'job-1', reason: `unconfirmed termination, token was ${secret}` });
    await store.transact((tx, state) => {
      repo.clearFence(tx, state, { resource: RESOURCE, clearedBy: 'operator:james', reason: `checked, saw ${secret} in the log too` });
    });

    const trail = repo.listFenceAudit(RESOURCE);
    for (const entry of trail) {
      assert.ok(!entry.reason.includes(secret), 'a raw secret must never reach the durable audit record');
    }
  });
});

// ---------------------------------------------------------------------------
// the operator recovery path: scripts/pw-orch-clear-fence.mjs
// ---------------------------------------------------------------------------
//
// Run as a real subprocess against a real durable store, exactly as an operator would use it: the
// service is not running (the store is closed before the script opens it), and the script's own
// argument handling is what has to refuse a careless invocation.

test('clear-fence script: importing index.js for MIGRATIONS has no side effects of its own', () => {
  // The script pulls `MIGRATIONS` from `app/orchestrator/index.js`, which also exports
  // `createOrchestratorSubsystem`/`mountOrchestrator` — functions the script never calls, and never
  // functions the *import* itself runs. index.js's own doc comment states this is deliberate:
  // "Constructed here rather than at import time so that a disabled instance never opens the store,
  // never takes the lock, and never creates a directory." Checked directly against the source: every
  // line at module scope (column 0 — not indented inside a function body) is only an `import`,
  // `export`, or the `MIGRATIONS` constant's own declaration, never a call to any of this module's
  // own bootstrap functions.
  const source = fs.readFileSync(new URL('../app/orchestrator/index.js', import.meta.url), 'utf8');
  const risky = /^(createOrchestratorSubsystem|buildSubsystem|mountOrchestrator|JournalStore\.open)\s*\(/;
  const offendingLine = source.split('\n').find((line) => risky.test(line));
  assert.equal(offendingLine, undefined,
    `index.js must not call its own bootstrap functions at module scope, found: ${offendingLine}`);
});

/**
 * Every store here is opened with the SAME `MIGRATIONS` the live service applies (via
 * `createOrchestratorSubsystem`) — not an empty list. A store already migrated to schema v1 opened
 * without that argument reads its own schema as "written by a newer build than this understands" and
 * refuses to open at all; that must be caught here, against a store that has genuinely been through
 * migration, not against a bare journal that happens to still be at v0.
 */
async function openMigrated(config) {
  return JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath, lockPath: config.lockPath,
    migrations: MIGRATIONS,
  });
}

async function fenceViaJs(dir) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_DATA_DIR: dir,
  };
  const config = loadOrchestratorConfig(env);
  const store = await openMigrated(config);
  const repo = new OrchestratorRepository(store);
  const resource = 'project-write:wb-1:Demo';
  const acquired = await store.transact((tx, state) => repo.acquireLease(tx, state, { resource, owner: 'job-1' }));
  await store.transact((tx, state) => repo.fenceLease(tx, state, {
    resource, owner: 'job-1', fencingToken: acquired.fencing_token, reason: 'unconfirmed termination',
  }));
  // Closed so the script (a second process) can open the store — the lock is the whole point.
  await store.close();
  return { env, resource };
}

async function readLease(env, resource) {
  const config = loadOrchestratorConfig(env);
  const store = await openMigrated(config);
  const lease = new OrchestratorRepository(store).getLease(resource);
  await store.close();
  return lease;
}

test('clear-fence script: without --confirm it only reports status and changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);

    const { stdout } = await execFileAsync(process.execPath, [CLEAR_FENCE_SCRIPT, '--project', 'Demo'], { env, timeout: 15_000 });
    assert.match(stdout, /FENCED/);
    assert.match(stdout, /no change made/);

    assert.equal((await readLease(env, resource)).fenced, true, 'status alone must not clear anything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: --confirm without --reason or --by is refused before it opens the store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);

    const err = await execFileAsync(process.execPath, [CLEAR_FENCE_SCRIPT, '--project', 'Demo', '--confirm'], { env, timeout: 15_000 })
      .then(() => null, (e) => e);
    assert.ok(err, 'must be refused');
    assert.equal(err.code, 2);

    assert.equal((await readLease(env, resource)).fenced, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: --confirm with reason and operator name clears it, durably', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);

    const { stdout } = await execFileAsync(process.execPath, [
      CLEAR_FENCE_SCRIPT, '--project', 'Demo',
      '--reason', 'verified no surviving descendant via ps -ef', '--by', 'james', '--confirm',
    ], { env, timeout: 15_000 });
    assert.match(stdout, /cleared by james/);

    const lease = await readLease(env, resource);
    assert.equal(lease.fenced, false);
    assert.equal(lease.cleared_by, 'james');
    assert.match(lease.clear_reason, /ps -ef/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: refuses to open the store while the service is still running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      PW_ORCHESTRATOR_ENABLED: 'true',
      PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
      PW_ORCHESTRATOR_DATA_DIR: dir,
    };
    const config = loadOrchestratorConfig(env);
    // Left open deliberately — standing in for the live service still holding the store.
    const store = await openMigrated(config);
    try {
      const err = await execFileAsync(process.execPath, [CLEAR_FENCE_SCRIPT, '--project', 'Demo'], { env, timeout: 15_000 })
        .then(() => null, (e) => e);
      assert.ok(err, 'must refuse while the store is locked by another process');
      assert.equal(err.code, 3);
      assert.match(err.stderr, /still running|locked/i);
    } finally {
      await store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: a secret pasted into --reason is redacted, in its own output and in the durable record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);
    const secret = 'sk-liveTESTSECRETVALUEMUSTNOTAPPEAR1234567890';

    const { stdout } = await execFileAsync(process.execPath, [
      CLEAR_FENCE_SCRIPT, '--project', 'Demo',
      '--reason', `verified clean, ref token=${secret}`, '--by', 'james', '--confirm',
    ], { env, timeout: 15_000 });

    assert.equal(stdout.includes(secret), false, 'the script\'s own stdout must not echo a raw secret back');
    assert.match(stdout, /REDACTED/);

    const lease = await readLease(env, resource);
    assert.equal(JSON.stringify(lease).includes(secret), false, 'the durable record must not carry the raw secret either');
    assert.match(lease.clear_reason, /REDACTED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: clearing leaves a full auditable record — who fenced it, who cleared it, and why, all still readable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);

    await execFileAsync(process.execPath, [
      CLEAR_FENCE_SCRIPT, '--project', 'Demo',
      '--reason', 'verified no surviving descendant via ps -ef', '--by', 'james', '--confirm',
    ], { env, timeout: 15_000 });

    const lease = await readLease(env, resource);
    // The clearing action is recorded...
    assert.equal(lease.fenced, false);
    assert.equal(lease.cleared_by, 'james');
    assert.match(lease.clear_reason, /ps -ef/);
    assert.ok(lease.cleared_at, 'the clearing must be timestamped');
    // ...but so is the ORIGINAL fencing this cleared: an operator reading this record later must be
    // able to see the whole story, not just its ending.
    assert.equal(lease.fenced_by, 'job-1');
    assert.match(lease.fenced_reason, /unconfirmed termination/);
    assert.ok(lease.fenced_at, 'the original fencing must still be timestamped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear-fence script: prints the durable audit history, not just the current lease row', async () => {
  // The mutable lease row `fenced_by`/`fenced_reason`/`cleared_by`/`clear_reason` only ever shows the
  // MOST RECENT cycle — an operator investigating a resource fenced and cleared more than once has no
  // way to see the earlier incidents from the lease row alone. The script must surface the append-only
  // trail, not just today's fields.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-clearfence-'));
  try {
    const { env, resource } = await fenceViaJs(dir);

    const before = await execFileAsync(process.execPath, [CLEAR_FENCE_SCRIPT, '--project', 'Demo'], { env, timeout: 15_000 });
    assert.match(before.stdout, /history/i);
    assert.match(before.stdout, /fenced/);
    assert.match(before.stdout, /job-1/);

    await execFileAsync(process.execPath, [
      CLEAR_FENCE_SCRIPT, '--project', 'Demo',
      '--reason', 'verified no surviving descendant via ps -ef', '--by', 'james', '--confirm',
    ], { env, timeout: 15_000 });

    // Fence again, on a fresh acquisition, so there are now two full incidents in the trail.
    const config = loadOrchestratorConfig(env);
    const store = await openMigrated(config);
    const repo = new OrchestratorRepository(store);
    const acquired = await store.transact((tx, state) => repo.acquireLease(tx, state, { resource, owner: 'job-2' }));
    await store.transact((tx, state) => repo.fenceLease(tx, state, {
      resource, owner: 'job-2', fencingToken: acquired.fencing_token, reason: 'second incident',
    }));
    await store.close();

    const after = await execFileAsync(process.execPath, [CLEAR_FENCE_SCRIPT, '--project', 'Demo'], { env, timeout: 15_000 });
    // Both incidents' owners appear — the first fence/clear cycle is not lost once a second begins.
    assert.match(after.stdout, /job-1/);
    assert.match(after.stdout, /job-2/);
    assert.match(after.stdout, /second incident/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
