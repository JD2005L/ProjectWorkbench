// Cross-process serialization for the user lifecycle (rename / delete /
// reconcile). app/user-store.js's `tail` promise chain only ever serialized
// requests handled by ONE Node process; two dashboard processes (a rolling
// restart overlapping the old and new instance, a second instance, a CLI
// tool) racing the same users.json + projects.json + credential-tree
// read-modify-write had no coordination at all across that boundary.
//
// This is a plain lockfile — no native deps, matching the rest of this
// codebase (no better-sqlite3, no flock binding): atomic creation via
// O_EXCL, a recorded PID, and a stale-lock break that prefers PID liveness
// over elapsed time. That preference matters: a crashed holder's PID is
// gone, so its lock is reclaimable immediately (fast, correct crash
// recovery) — but a merely SLOW, still-alive holder must never have its
// lock broken out from under it just because it took a while, or two
// operations could run concurrently, which is exactly the bug class this
// module exists to close.
import fsp from 'node:fs/promises';
import path from 'node:path';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process. EPERM: it exists but we can't signal it —
    // still alive. Anything else, assume alive rather than guess wrong.
    return e.code !== 'ESRCH';
  }
}

async function readLockInfo(lockPath) {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8');
    const [pidStr, ts] = raw.split('\n');
    const pid = Number(pidStr);
    const acquiredAt = new Date(ts).getTime();
    if (!Number.isFinite(pid) || !Number.isFinite(acquiredAt)) return null;
    return { pid, acquiredAt };
  } catch {
    return null;
  }
}

async function lockFileAgeMs(lockPath) {
  try {
    const st = await fsp.stat(lockPath);
    return Date.now() - st.mtimeMs;
  } catch {
    return Infinity; // gone entirely between our failed open() and this stat — safe to just retry
  }
}

export async function withLifecycleLock(lockPath, fn, { staleMs = 60000, retryMs = 20, timeoutMs = 15000 } = {}) {
  const start = Date.now();
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fh = await fsp.open(lockPath, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Liveness is authoritative and unconditional whenever we can read a
      // PID: a live holder's lock is NEVER broken just because it has been
      // held a while — a merely slow (not dead) operation must be allowed to
      // finish, or two lifecycle operations could run concurrently, which is
      // the exact bug class this module exists to prevent. `staleMs` only
      // matters when the lock file itself is unreadable or malformed — an
      // ambiguous state (a concurrent writer mid-create? corrupt garbage?)
      // where age is the only signal available: a very fresh unparsable file
      // might just be another process mid-write; an old one is abandoned.
      const info = await readLockInfo(lockPath);
      const stale = info ? !isProcessAlive(info.pid) : (await lockFileAgeMs(lockPath)) > staleMs;
      if (stale) {
        await fsp.rm(lockPath, { force: true }).catch(() => {});
        continue; // immediately retry acquisition, no artificial delay
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lifecycle lock timed out waiting for ${lockPath} (held by pid ${info?.pid ?? '?'})`);
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}
