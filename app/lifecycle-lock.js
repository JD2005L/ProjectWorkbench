// Cross-process serialization for the user lifecycle (rename / delete /
// reconcile). app/user-store.js's `tail` promise chain only ever serialized
// requests handled by ONE Node process; two dashboard processes (a rolling
// restart overlapping the old and new instance, a second instance, a CLI
// tool) racing the same users.json + projects.json + credential-tree
// read-modify-write had no coordination at all across that boundary.
//
// This is a plain lockfile — no native deps, matching the rest of this
// codebase (no better-sqlite3, no flock binding). It went through two
// designs:
//
//   v1 (round 3) recorded a bare "pid\ntimestamp\n" and released/reclaimed by
//   blindly unlinking whatever was at the lock path. That is an ABA/TOCTOU
//   bug: the staleness *decision* (read the path, judge dead-or-old) and the
//   *action* (unlink the path) are two separate steps with an unbounded gap
//   between them. Empirically (see .goal-loops/pvibot-pr20-remediation.md,
//   round 4), a waiter could observe an ambiguous/absent lock file during the
//   narrow window where a holder had just released and was already
//   reacquiring for its next iteration, judge it "stale", and then its
//   *delayed* unlink executed only once that holder's brand-new, fully valid
//   successor lock was in place — deleting a live lock out from under its
//   legitimate owner and producing a real lost update (confirmed: two real
//   node processes racing lost up to 7 of 80 increments).
//
//   v2 (this file) closes that gap with three changes:
//     1. Publication is atomic: the full {pid, startTicks, token,
//        acquiredAt} record is written to a private temp file first, then
//        published with link() (an atomic, exclusive-create op). A lock file
//        is therefore NEVER visible half-written — any reader sees either
//        nothing or a complete, parseable record.
//     2. Every acquisition carries an unguessable owner token (random bytes)
//        plus the owning process's PID *and* start time (from
//        /proc/<pid>/stat, ticks since boot) so a liveness check can't be
//        fooled by PID reuse (dead pid recycled by an unrelated live one).
//     3. Removal — both a holder's own release and a waiter's stale-lock
//        reclaim — never unlinks by path. It first rename()s the lock path
//        to a private, uniquely-named claim file. rename() is atomic: of any
//        number of concurrent renamers of the same source path, exactly one
//        succeeds and the rest get ENOENT — so exactly one actor ever ends up
//        exclusively holding the file that WAS there, decoupled from
//        whatever gets published at that path next. Only after that exclusive
//        claim does the code inspect the content and decide to delete it
//        (this exact instance, verified) or restore it (link() it back,
//        itself exclusive/atomic, so it can never clobber a fresh successor
//        that legitimately republished at the path in the meantime).
import crypto from 'node:crypto';
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

// Ticks since boot the given pid started at, from /proc — the same
// signal-free liveness-identity source used by scripts/pw-tmux-save. Field 22
// of /proc/<pid>/stat (starttime); parsing skips past the "(comm)" field,
// which can itself contain spaces/parens, exactly like that script does.
// Returns null (never throws) if unavailable — non-Linux, pid gone, or
// malformed content — callers must treat null as "can't verify further"
// rather than as a mismatch.
async function getStartTicks(pid) {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(') ') + 2);
    const fields = rest.trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

let ownStartTicksPromise;
function getOwnStartTicks() {
  if (!ownStartTicksPromise) ownStartTicksPromise = getStartTicks(process.pid);
  return ownStartTicksPromise;
}

// Is the recorded owner still THE SAME live process — not merely a live
// process that happens to reuse a recycled pid? startTicks may be null (older
// record, or /proc was unavailable when it was written); in that case we
// fall back to pid liveness alone, same as before.
async function isOwnerAlive(pid, startTicks) {
  if (!isProcessAlive(pid)) return false;
  if (startTicks == null) return true;
  const current = await getStartTicks(pid);
  if (current == null) return true; // can't verify further; trust liveness
  return current === startTicks;
}

async function readLockInfo(lockPath) {
  let raw;
  try {
    raw = await fsp.readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const info = JSON.parse(raw);
    if (!info || !Number.isFinite(info.pid) || typeof info.token !== 'string' || !info.token) return null;
    return info;
  } catch {
    return null;
  }
}

// Publish `info` at `lockPath`, failing EEXIST if something is already there.
// Content is written to a private temp file FIRST and made visible with a
// single atomic link() — lockPath never exists half-written.
async function publish(lockPath, info) {
  const tmpPath = `${lockPath}.tmp-${info.token}`;
  await fsp.writeFile(tmpPath, JSON.stringify(info), { mode: 0o600 });
  try {
    await fsp.link(tmpPath, lockPath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Atomically claim exclusive ownership of whatever is currently at
// `lockPath`, moving it to a private path only this call knows about.
// Returns the claim path, or null if lockPath was already gone (someone else
// got there first — nothing for the caller to act on).
async function claimExclusive(lockPath) {
  const claimPath = `${lockPath}.claim-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fsp.rename(lockPath, claimPath);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return claimPath;
}

// Put a claimed file back at lockPath, but only if lockPath is still free —
// link() is exclusive/atomic, so this can never clobber a fresh lock that a
// legitimate new holder published while we held the claim.
async function restoreIfFree(claimPath, lockPath) {
  try {
    await fsp.link(claimPath, lockPath);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fsp.rm(claimPath, { force: true }).catch(() => {});
  }
}

// A holder releasing its OWN lock: claim whatever is at lockPath, and delete
// it ONLY if it is verified to be the exact instance (matching token) this
// call acquired. Anything else — however that could happen — is restored,
// never destroyed.
async function releaseOwned(lockPath, token) {
  const claimPath = await claimExclusive(lockPath);
  if (!claimPath) return; // already gone; nothing of ours to release
  const info = await readLockInfo(claimPath);
  if (info && info.token === token) {
    await fsp.rm(claimPath, { force: true }).catch(() => {});
  } else {
    await restoreIfFree(claimPath, lockPath);
  }
}

// A waiter attempting to reclaim what LOOKS like a stale lock: claim
// exclusively first, then make the stale/not-stale decision fresh on the
// exact instance now held — never on an earlier, separately-read snapshot.
// If it turns out to still be live (or a fresh successor already replaced
// it), restore it untouched.
async function tryReclaim(lockPath) {
  const claimPath = await claimExclusive(lockPath);
  if (!claimPath) return;
  const info = await readLockInfo(claimPath);
  const stale = info ? !(await isOwnerAlive(info.pid, info.startTicks)) : true;
  if (stale) {
    await fsp.rm(claimPath, { force: true }).catch(() => {});
  } else {
    await restoreIfFree(claimPath, lockPath);
  }
}

export async function withLifecycleLock(lockPath, fn, { staleMs = 60000, retryMs = 20, timeoutMs = 15000 } = {}) {
  const start = Date.now();
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const startTicks = await getOwnStartTicks();

  for (;;) {
    try {
      await publish(lockPath, { pid: process.pid, startTicks, token, acquiredAt: new Date().toISOString() });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Cheap, non-destructive read to decide whether reclaiming is even
      // worth attempting. Because publish() is atomic, a visible lock file is
      // NEVER half-written, so this read is reliable — but a live holder's
      // lock is still never touched based on it alone: only the exclusive
      // claim-and-reverify in tryReclaim() is allowed to actually remove
      // anything.
      const info = await readLockInfo(lockPath);
      let candidateStale;
      if (info) {
        candidateStale = !(await isOwnerAlive(info.pid, info.startTicks));
      } else {
        const st = await fsp.stat(lockPath).catch(() => null);
        if (!st) continue; // vanished since our failed publish(); just retry
        // Genuinely unparseable AND present is corruption, not a writer
        // mid-flight (publish() can't leave that state) — age-gate it
        // conservatively rather than assume it's ours to break.
        candidateStale = Date.now() - st.mtimeMs > staleMs;
      }

      if (candidateStale) {
        await tryReclaim(lockPath);
        continue; // reclaimed, restored, or already gone — retry publish()
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
    await releaseOwned(lockPath, token);
  }
}

// Test-only internals. NOT part of this module's public contract — exported
// solely so test/lifecycle-lock.test.mjs can construct exact, deterministic
// races (e.g. a successor publishing at a path the instant a stale instance
// is claimed away from it) instead of relying purely on real-world timing.
export const _internal = {
  isProcessAlive,
  getStartTicks,
  isOwnerAlive,
  readLockInfo,
  publish,
  claimExclusive,
  restoreIfFree,
  releaseOwned,
  tryReclaim,
};
