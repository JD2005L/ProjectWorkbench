// Cross-process serialization for the user lifecycle (rename/delete/
// reconcile). The in-process tail chain in app/user-store.js only ever
// serialized concurrent requests handled by ONE Node process; two dashboard
// processes (a rolling restart, a second instance, a CLI tool) racing the
// same users.json/projects.json/credential-tree read-modify-write had no
// coordination at all. withLifecycleLock() is a plain lockfile (no native
// deps, matching the rest of this codebase): atomic create (O_EXCL), a
// recorded PID, and a stale-lock break that prefers PID liveness (fast,
// correct crash recovery) over a time-based guess (which would risk breaking
// a live holder's lock out from under it).
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

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-lock-'));
}

test('runs the function and releases the lock afterward', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const result = await withLifecycleLock(lockPath, async () => 42);
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lockPath), false, 'the lock file must be removed once released');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('releases the lock even when the function throws', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  await assert.rejects(withLifecycleLock(lockPath, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockPath), false);
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
  fs.writeFileSync(lockPath, '999999\n' + new Date().toISOString() + '\n');
  const start = Date.now();
  await withLifecycleLock(lockPath, async () => {}, { staleMs: 60000, timeoutMs: 4000 });
  assert.ok(Date.now() - start < 2000, 'a dead-PID lock must be reclaimed fast, not wait out a long staleMs');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a lock held by a live process is NOT broken just because it is old — waits, then times out', { timeout: 5000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  // Our OWN pid is definitely alive; backdate the timestamp far past a
  // short staleMs to prove liveness wins over age.
  fs.writeFileSync(lockPath, `${process.pid}\n${new Date(Date.now() - 3600_000).toISOString()}\n`);
  await assert.rejects(
    withLifecycleLock(lockPath, async () => {}, { staleMs: 500, timeoutMs: 300 }),
    /lock/i,
  );
  assert.ok(fs.existsSync(lockPath), 'a live holder\'s lock must not have been removed');
  fs.rmSync(lockPath, { force: true });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('REGRESSION: two REAL node processes racing the same lock never interleave — no lost increments', { timeout: 20000 }, async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, '.lock');
  const counterFile = path.join(dir, 'counter.json');
  fs.writeFileSync(counterFile, '0');

  const workerScript = `
    import { withLifecycleLock } from ${JSON.stringify(path.join(APP_DIR, 'lifecycle-lock.js'))};
    import fs from 'node:fs';
    const lockPath = ${JSON.stringify(lockPath)};
    const counterFile = ${JSON.stringify(counterFile)};
    for (let i = 0; i < 40; i++) {
      await withLifecycleLock(lockPath, async () => {
        const n = Number(fs.readFileSync(counterFile, 'utf8'));
        // A deliberate window between read and write: if two holders were
        // EVER in the critical section at once, this is exactly where an
        // increment would be lost.
        await new Promise((r) => setTimeout(r, 2));
        fs.writeFileSync(counterFile, String(n + 1));
      }, { timeoutMs: 15000 });
    }
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
  });

  await Promise.all([run(), run()]);
  assert.equal(Number(fs.readFileSync(counterFile, 'utf8')), 80, 'every increment across both real processes must be preserved');
  await fsp.rm(dir, { recursive: true, force: true });
});
