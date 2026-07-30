// Cross-process serialization for the user lifecycle (rename/delete/
// reconcile). The in-process tail chain in app/user-store.js only ever
// serialized concurrent requests handled by ONE Node process; two dashboard
// processes (a rolling restart, a second instance, a CLI tool) racing the
// same users.json/projects.json/credential-tree read-modify-write had no
// coordination at all. withLifecycleLock() is a plain lockfile (no native
// deps, matching the rest of this codebase).
//
// Round 4 regression: the original design (atomic O_EXCL create + a bare
// "pid\ntimestamp\n" record + blind path-based unlink on release/reclaim) had
// an ABA/TOCTOU hole — the staleness *decision* and the unlink *action* were
// separate steps with a gap between them, so a waiter's delayed unlink could
// land on a brand-new, legitimate successor lock instead of the stale one it
// judged. Confirmed empirically: two real node processes racing lost up to 7
// of 80 increments. The fixed design (atomic tmp-file+link publish, an
// unguessable owner token + pid/start-time identity per acquisition, and
// rename()-based exclusive claim-then-verify before any removal) is what
// every test below exercises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLifecycleLock, _internal } from '../app/lifecycle-lock.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const LOCK_MODULE = path.join(APP_DIR, 'lifecycle-lock.js');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-lock-'));
}

// Directory entries a fully-settled lock directory should have: none of our
// own bookkeeping (.tmp-*/.claim-*) may ever survive past the operations that
// created them.
function strayLockDebris(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.claim-'));
}

test('runs the function and releases the lock afterward', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const result = await withLifecycleLock(lockPath, async () => 42);
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lockPath), false, 'the lock file must be removed once released');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('releases the lock even when the function throws', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  await assert.rejects(withLifecycleLock(lockPath, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a second acquisition waits for the first to release, never runs concurrently', async () => {
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

test('REGRESSION: a lock held by a dead PID is broken immediately, not after the stale timeout', { timeout: 5000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  // A PID essentially guaranteed not to exist.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTicks: null, token: 'dead-owner-token', acquiredAt: new Date().toISOString() }));
  const start = Date.now();
  await withLifecycleLock(lockPath, async () => {}, { staleMs: 60000, timeoutMs: 4000 });
  assert.ok(Date.now() - start < 2000, 'a dead-PID lock must be reclaimed fast, not wait out a long staleMs');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock held by a live process is NOT broken just because it is old — waits, then times out', { timeout: 5000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  // Our OWN pid is definitely alive; backdate the timestamp far past a
  // short staleMs to prove liveness wins over age.
  const ownStartTicks = await _internal.getStartTicks(process.pid);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startTicks: ownStartTicks,
    token: 'live-owner-token',
    acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
  }));
  await assert.rejects(
    withLifecycleLock(lockPath, async () => {}, { staleMs: 500, timeoutMs: 300 }),
    /lock/i,
  );
  assert.ok(fs.existsSync(lockPath), 'a live holder\'s lock must not have been removed');
  const survivor = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(survivor.token, 'live-owner-token', 'the exact live instance must survive untouched');
  fs.rmSync(lockPath, { force: true });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: a lock claiming a live pid but a MISMATCHED start time (pid reuse) is treated as stale', { timeout: 5000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  // process.pid is genuinely alive, but the start-time we record is nonsense
  // — simulating "this pid used to belong to a different, now-dead process,
  // and has since been recycled by an unrelated live one." Liveness alone
  // would wrongly treat this as held; identity (pid + start time) must not.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startTicks: 1, // guaranteed not to match our real start time
    token: 'recycled-pid-token',
    acquiredAt: new Date().toISOString(),
  }));
  const start = Date.now();
  await withLifecycleLock(lockPath, async () => {}, { staleMs: 60000, timeoutMs: 4000 });
  assert.ok(Date.now() - start < 2000, 'a start-time mismatch must be reclaimed fast, like a dead pid');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: crash recovery — a process that acquires and is killed before releasing does not wedge the lock', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const markerFile = path.join(dir, 'acquired.marker');

  const crashScript = `
    import { withLifecycleLock } from ${JSON.stringify(LOCK_MODULE)};
    import fs from 'node:fs';
    await withLifecycleLock(${JSON.stringify(lockPath)}, async () => {
      fs.writeFileSync(${JSON.stringify(markerFile)}, 'acquired');
      // Simulate a hard crash mid-critical-section: exit immediately, never
      // reaching the release in withLifecycleLock's finally block.
      process.exit(1);
    });
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', crashScript]);
    child.on('exit', () => resolve());
    child.on('error', reject);
  });

  assert.ok(fs.existsSync(markerFile), 'the child must have actually acquired the lock before crashing');
  assert.ok(fs.existsSync(lockPath), 'the crashed lock file must still be sitting there, abandoned');

  const start = Date.now();
  let ran = false;
  await withLifecycleLock(lockPath, async () => { ran = true; }, { timeoutMs: 4000 });
  assert.ok(ran, 'a fresh acquisition must succeed despite the abandoned lock');
  assert.ok(Date.now() - start < 2000, 'crash recovery must be fast, not wait out a long stale timeout');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: reclaiming a stale lock never destroys a fresh successor published at the same path', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');

  // A stale (dead-pid) lock sits at lockPath.
  await _internal.publish(lockPath, { pid: 999999, startTicks: null, token: 'stale-old-token', acquiredAt: new Date().toISOString() });

  // A waiter exclusively claims it — this is the atomic step that decouples
  // whatever was at the path from anything published there next.
  const claimPath = await _internal.claimExclusive(lockPath);
  assert.ok(claimPath, 'the stale lock must be claimable');
  assert.equal(fs.existsSync(lockPath), false, 'the path is free the instant it is claimed');

  // Exactly here — while the waiter holds the OLD lock exclusively but has
  // not yet decided its fate — a legitimate successor acquires afresh.
  const ownStartTicks = await _internal.getStartTicks(process.pid);
  await _internal.publish(lockPath, { pid: process.pid, startTicks: ownStartTicks, token: 'fresh-successor-token', acquiredAt: new Date().toISOString() });

  // The waiter now inspects what it claimed (the OLD, dead lock) and — since
  // it really is dead — discards it.
  const claimedInfo = await _internal.readLockInfo(claimPath);
  assert.equal(claimedInfo.token, 'stale-old-token');
  assert.equal(await _internal.isOwnerAlive(claimedInfo.pid, claimedInfo.startTicks), false);
  await fsp.rm(claimPath, { force: true });

  // The successor must be completely untouched.
  const survivor = await _internal.readLockInfo(lockPath);
  assert.ok(survivor, 'the successor lock must still exist');
  assert.equal(survivor.token, 'fresh-successor-token');
  assert.equal(survivor.pid, process.pid);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: tryReclaim() re-verifies the exact instance it claimed and restores a live successor untouched', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');

  // Seed a stale lock, then IMMEDIATELY replace it with a live successor —
  // by the time any code calls the public reclaim path, only the successor
  // is visible. tryReclaim must never be fooled into deleting it.
  await _internal.publish(lockPath, { pid: 999999, startTicks: null, token: 'old', acquiredAt: new Date().toISOString() });
  const claimPath = await _internal.claimExclusive(lockPath);
  const ownStartTicks = await _internal.getStartTicks(process.pid);
  await _internal.publish(lockPath, { pid: process.pid, startTicks: ownStartTicks, token: 'live-successor', acquiredAt: new Date().toISOString() });
  await fsp.rm(claimPath, { force: true }); // waiter discards the genuinely-dead old instance

  // Now call tryReclaim() directly against the live successor as if a SECOND
  // waiter mistakenly thought it might be stale too.
  await _internal.tryReclaim(lockPath);
  const survivor = await _internal.readLockInfo(lockPath);
  assert.ok(survivor, 'a live lock must survive an errant reclaim attempt');
  assert.equal(survivor.token, 'live-successor');
  assert.deepEqual(strayLockDebris(dir), []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: releaseOwned() only ever removes the exact instance it owns, never a lock that replaced it', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const ownStartTicks = await _internal.getStartTicks(process.pid);

  await _internal.publish(lockPath, { pid: process.pid, startTicks: ownStartTicks, token: 'original-holder', acquiredAt: new Date().toISOString() });

  // Something else's lock now occupies the path instead (this should never
  // happen under a correct protocol — this test proves the defensive branch
  // holds even so).
  await fsp.rm(lockPath, { force: true });
  await _internal.publish(lockPath, { pid: process.pid, startTicks: ownStartTicks, token: 'someone-elses-lock', acquiredAt: new Date().toISOString() });

  // Release using the ORIGINAL (no longer present) token must not touch it.
  await _internal.releaseOwned(lockPath, 'original-holder');

  const survivor = await _internal.readLockInfo(lockPath);
  assert.ok(survivor, 'a lock that is not the exact instance being released must survive');
  assert.equal(survivor.token, 'someone-elses-lock');
  assert.deepEqual(strayLockDebris(dir), []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: concurrent stale-breakers racing the same dead lock never double-run, and leave a clean final state', { timeout: 15000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTicks: null, token: 'dead', acquiredAt: new Date().toISOString() }));

  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;
  const CONTENDERS = 8;
  await Promise.all(Array.from({ length: CONTENDERS }, () => withLifecycleLock(lockPath, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    runs += 1;
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
  }, { timeoutMs: 10000 })));

  assert.equal(runs, CONTENDERS, 'every contender must eventually run');
  assert.equal(maxConcurrent, 1, 'no two contenders may ever hold the lock at the same time');
  assert.equal(fs.existsSync(lockPath), false, 'the lock must be fully released after the last contender');
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
        // A deliberate window between read and write: if two holders were
        // EVER in the critical section at once, this is exactly where an
        // increment would be lost.
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

test('REGRESSION: two REAL node processes racing the same lock, high iteration — never interleave, no lost increments', { timeout: 60000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const counterFile = path.join(dir, 'counter.json');
  const ITER = 150;
  fs.writeFileSync(counterFile, '0');

  await Promise.all([
    spawnRacingWorker(lockPath, counterFile, ITER),
    spawnRacingWorker(lockPath, counterFile, ITER),
  ]);

  assert.equal(Number(fs.readFileSync(counterFile, 'utf8')), ITER * 2, 'every increment across both real processes must be preserved');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: three REAL node processes racing the same lock, high iteration — never interleave, no lost increments', { timeout: 60000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const counterFile = path.join(dir, 'counter.json');
  const ITER = 100;
  fs.writeFileSync(counterFile, '0');

  await Promise.all([
    spawnRacingWorker(lockPath, counterFile, ITER),
    spawnRacingWorker(lockPath, counterFile, ITER),
    spawnRacingWorker(lockPath, counterFile, ITER),
  ]);

  assert.equal(Number(fs.readFileSync(counterFile, 'utf8')), ITER * 3, 'every increment across all three real processes must be preserved');
  assert.deepEqual(strayLockDebris(dir), []);
  await fsp.rm(dir, { recursive: true, force: true });
});
