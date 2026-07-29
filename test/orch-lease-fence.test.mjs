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
// the operator recovery path: scripts/pw-orch-clear-fence.mjs
// ---------------------------------------------------------------------------
//
// Run as a real subprocess against a real durable store, exactly as an operator would use it: the
// service is not running (the store is closed before the script opens it), and the script's own
// argument handling is what has to refuse a careless invocation.

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
