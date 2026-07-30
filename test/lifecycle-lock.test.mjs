// Cross-process serialization for the user lifecycle (rename/delete/
// reconcile) and, since rounds 4-5, sessions.json and projects.json too.
//
// Round 6 REGRESSION: an adversarial review found the round-4 design (owner
// token + rename()-based "claim, then decide" stale-reclaim) was still
// fundamentally unsound — claiming (renaming away) a lock ALWAYS vacates the
// path, even when the lock turns out to be perfectly live, and during that
// vacancy window a third party's fresh acquisition can slip into the empty
// path and run concurrently with the still-active original holder. Confirmed
// directly: calling the old module's internal reclaim function against a
// genuinely active holder produced a real, reproducible critical-section
// overlap (see /tmp/pr20_lock_quarantine_race.mjs from that review).
//
// app/lifecycle-lock.js v3 abandons path-based quarantine entirely for a real
// kernel flock(2) lock (via the external flock(1) binary, given an inherited,
// pre-validated O_NOFOLLOW regular-file fd — never a path). flock has no
// "vacancy window" by construction: it is a property of an open file
// description, enforced by the kernel, not a userspace judgment about a path.
// There is no more PID/start-time/staleness machinery to test, because there
// is no more userspace staleness judgment to get wrong — a crashed holder's
// lock releases automatically the instant the kernel reclaims its file
// descriptors, which is exactly what the SIGKILL test below exercises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLifecycleLock } from '../app/lifecycle-lock.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const LOCK_MODULE = path.join(APP_DIR, 'lifecycle-lock.js');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-lock-'));
}

// Flags stray lock-bookkeeping artifacts only (the v1/v2 designs' .tmp-*/
// .claim-* files) — not unrelated files a test itself creates in the same
// scratch directory (e.g. a counter file for a race test).
function strayLockDebris(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.claim-'));
}

test('runs the function and releases the lock afterward', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const result = await withLifecycleLock(lockPath, async () => 42);
  assert.equal(result, 42);
  // Unlike v1/v2, the lock file itself is expected to PERSIST (a plain,
  // now-unlocked inode) — flock's identity is the kernel lock state, not the
  // file's existence. Only stray bookkeeping files would be a problem.
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('releases the lock even when the function throws', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  await assert.rejects(withLifecycleLock(lockPath, async () => { throw new Error('boom'); }), /boom/);
  // A second acquisition must succeed promptly — proof the failed critical
  // section didn't leave the lock held.
  const start = Date.now();
  await withLifecycleLock(lockPath, async () => {}, { timeoutMs: 4000 });
  assert.ok(Date.now() - start < 2000, 'the lock must have been released despite the throw');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a second acquisition waits for the first to release, never runs concurrently (in-process)', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const order = [];
  const slow = withLifecycleLock(lockPath, async () => {
    order.push('slow-start');
    await new Promise((r) => setTimeout(r, 60));
    order.push('slow-end');
  });
  await new Promise((r) => setTimeout(r, 5)); // let `slow` actually acquire first
  const fast = withLifecycleLock(lockPath, async () => { order.push('fast'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: waiting for a lock that never releases times out with an actionable error, not a hang', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  let releaseHolder;
  const held = new Promise((r) => { releaseHolder = r; });
  const holder = withLifecycleLock(lockPath, async () => { await held; });
  await new Promise((r) => setTimeout(r, 50)); // let the holder actually acquire
  const start = Date.now();
  await assert.rejects(
    withLifecycleLock(lockPath, async () => {}, { timeoutMs: 1000 }),
    /timed out|failed/i,
  );
  assert.ok(Date.now() - start < 3000, 'the timeout must actually bound the wait');
  releaseHolder();
  await holder;
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a lock path that is a symlink is refused, never followed', async () => {
  const dir = await tmpDir();
  const realTarget = path.join(dir, 'real-target');
  fs.writeFileSync(realTarget, '');
  const lockPath = path.join(dir, '.lock');
  fs.symlinkSync(realTarget, lockPath);
  await assert.rejects(withLifecycleLock(lockPath, async () => {}), /symlink|ELOOP|non-regular/i);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a lock path that is a directory (non-regular) is refused, never treated as a lock', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);
  await assert.rejects(withLifecycleLock(lockPath, async () => {}), /non-regular|EISDIR|illegal operation/i);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a lock file with garbage/malformed content is still a valid flock target — content is never trusted or parsed', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, 'this is not json, not a pid, just garbage\x00\xff');
  let ran = false;
  await withLifecycleLock(lockPath, async () => { ran = true; }, { timeoutMs: 4000 });
  assert.ok(ran, 'a pre-existing regular file with arbitrary content must still work as a plain flock target');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: no stray bookkeeping files are ever created — just the one lock file', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  for (let i = 0; i < 20; i++) {
    await withLifecycleLock(lockPath, async () => {});
  }
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The reviewer's exact overlap probe (/tmp/pr20_lock_quarantine_race.mjs),
// adapted: the old design's specific attack surface (a directly-callable
// internal reclaim function that vacates an active lock's path) no longer
// exists in v3 — there is no quarantine step to attack. What survives as a
// permanent regression test is the PROPERTY the reviewer's probe was
// checking: an active holder B is never joined by a concurrent second
// entrant, under real adversarial concurrency, for many iterations.
// ---------------------------------------------------------------------------
test('REGRESSION (reviewer overlap probe): an active holder is never joined by a concurrent second entrant, across many iterations', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const ITERATIONS = 200;
  let overlapObserved = false;
  for (let i = 0; i < ITERATIONS && !overlapObserved; i++) {
    let bActive = false;
    let releaseB;
    const held = new Promise((r) => { releaseB = r; });
    const b = withLifecycleLock(lockPath, async () => {
      bActive = true;
      await held;
      bActive = false;
    }, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 5)); // let b actually acquire
    const d = withLifecycleLock(lockPath, async () => {
      if (bActive) overlapObserved = true;
    }, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 8));
    releaseB();
    await Promise.all([b, d]);
  }
  assert.equal(overlapObserved, false, 'a waiter must never observe the prior holder still active — zero tolerance, any single occurrence is a bug');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

function spawnRacingWorker(lockPath, counterFile, iterations) {
  const workerScript = `
    import { withLifecycleLock } from ${JSON.stringify(LOCK_MODULE)};
    import fs from 'node:fs';
    const lockPath = ${JSON.stringify(lockPath)};
    const counterFile = ${JSON.stringify(counterFile)};
    for (let i = 0; i < ${iterations}; i++) {
      await withLifecycleLock(lockPath, async () => {
        const n = Number(fs.readFileSync(counterFile, 'utf8'));
        await new Promise((r) => setTimeout(r, 2));
        fs.writeFileSync(counterFile, String(n + 1));
      }, { timeoutMs: 20000 });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
  });
}

test('REGRESSION: 16 REAL processes racing the same lock, high iteration — never interleave, no lost increments', { timeout: 60000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const counterFile = path.join(dir, 'counter.json');
  const PROCS = 16;
  const ITER = 20;
  fs.writeFileSync(counterFile, '0');

  await Promise.all(Array.from({ length: PROCS }, () => spawnRacingWorker(lockPath, counterFile, ITER)));

  assert.equal(Number(fs.readFileSync(counterFile, 'utf8')), PROCS * ITER, 'every increment across all 16 real processes must be preserved');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: SIGKILLing the lock holder releases it immediately — crash recovery needs no PID/stale heuristics', { timeout: 15000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const markerFile = path.join(dir, 'acquired.marker');

  const holderScript = `
    import { withLifecycleLock } from ${JSON.stringify(LOCK_MODULE)};
    import fs from 'node:fs';
    await withLifecycleLock(${JSON.stringify(lockPath)}, async () => {
      fs.writeFileSync(${JSON.stringify(markerFile)}, 'acquired');
      await new Promise(() => {}); // hang forever holding the lock, until SIGKILLed
    });
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript]);
  try {
    for (let i = 0; i < 100 && !fs.existsSync(markerFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(markerFile), 'the holder must have actually acquired the lock before being killed');

    holder.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300)); // let the kernel actually reclaim its fds

    const start = Date.now();
    let ran = false;
    await withLifecycleLock(lockPath, async () => { ran = true; }, { timeoutMs: 4000 });
    assert.ok(ran, 'a fresh acquisition must succeed despite the killed holder');
    assert.ok(Date.now() - start < 2000, 'crash recovery must be immediate (kernel-enforced), not a slow stale-timeout guess');
  } finally {
    try { holder.kill('SIGKILL'); } catch { /* already gone */ }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
