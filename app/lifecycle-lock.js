// Cross-process serialization for the user lifecycle (rename / delete /
// reconcile), and now also for sessions.json and projects.json (rounds 4-5).
//
// This has gone through three designs:
//
//   v1 (round 3): a bare "pid\ntimestamp\n" lockfile, released/reclaimed by
//   blindly unlinking whatever was at the lock path. ABA/TOCTOU: the
//   staleness DECISION and the unlink ACTION were separate steps with a gap
//   between them, so a waiter could delete a brand-new successor lock.
//
//   v2 (round 4): closed that specific gap with an owner token + pid/start-
//   time identity, atomic tmp-file+link publication, and rename()-based
//   "claim, then decide" reclaim. That closed the ORIGINAL empty-file
//   misjudgment bug, but round 6's adversarial review found the design was
//   still fundamentally unsound: `tryReclaim()`'s rename() ALWAYS vacates the
//   lock path the instant it runs, even against a lock that turns out to be
//   perfectly live — and during that vacancy, a third party's fresh
//   acquisition can slip into the now-empty path and run concurrently with
//   the still-active original holder. Confirmed directly: calling
//   `tryReclaim()` against a genuinely active holder produces a real,
//   reproducible critical-section overlap. Any "quarantine by rename, decide
//   after" design has this hole structurally — the moment the path is
//   vacated, ANYTHING can fill it, and "restore if the path is still free"
//   only prevents clobbering the interloper, not the interloper existing
//   concurrently with the original holder in the first place.
//
//   v3 (this file): abandons path-based staleness/quarantine entirely in
//   favor of a real kernel flock(2) lock, which has no "vacancy window" by
//   construction — flock is a property of an open file description, not of
//   the path, and the kernel enforces mutual exclusion directly. No PID
//   liveness heuristic, no start-time/PID-reuse guard, no stale-timeout
//   guess: none of that machinery is needed, because there is no userspace
//   staleness JUDGMENT to get wrong. A crashed holder's lock releases
//   automatically the instant the kernel reclaims its file descriptors —
//   including on SIGKILL — with zero code on our side.
//
// Node has no flock(2) binding without a native addon (disallowed here — no
// native deps, matching the rest of this codebase). The trick: open the lock
// file ourselves (O_NOFOLLOW, refusing a symlink; reject anything that isn't
// a plain regular file), then spawn the external `flock(1)` binary
// (util-linux, present on every target host) with that already-open file
// descriptor INHERITED — not a path. flock(1) given a bare fd number (no
// command to run) calls flock(2) on it and exits; the lock is then held by
// whichever open file description that fd refers to — which is OUR fd, not
// the short-lived child's — for as long as we keep it open. Closing it (or
// the whole process dying, for ANY reason, including SIGKILL) is what
// releases the lock; the kernel guarantees this, we do not implement it.
// flock(1) never touches the lock PATH itself in this design (it only ever
// sees a bare fd number), so it cannot be tricked by a symlink either — that
// risk is fully handled by our own O_NOFOLLOW open before flock ever runs.
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const FLOCK_CANDIDATES = ['/usr/bin/flock', '/bin/flock'];
let resolvedFlockBinaryPromise;

// Validate the flock(1) binary itself: a real, non-symlinked, regular,
// executable file at one of a fixed set of absolute paths. Refusing a
// symlink here closes off substituting the helper binary itself.
function resolveFlockBinary() {
  if (!resolvedFlockBinaryPromise) {
    resolvedFlockBinaryPromise = (async () => {
      for (const candidate of FLOCK_CANDIDATES) {
        let st;
        try {
          st = await fsp.lstat(candidate);
        } catch {
          continue;
        }
        if (!st.isFile()) continue; // false for a symlink (lstat, not stat) and for any non-regular type
        if (!(st.mode & 0o111)) continue;
        return candidate;
      }
      throw new Error(`lifecycle lock: no usable flock(1) binary found (checked ${FLOCK_CANDIDATES.join(', ')})`);
    })();
  }
  return resolvedFlockBinaryPromise;
}

// Opens (creating if needed) the lock file, refusing to follow a symlink at
// the final path component (O_NOFOLLOW) and refusing anything that is not a
// plain regular file once opened. The file's CONTENT is never read or
// written by this module — it exists purely as a flock(2) target; the
// lock's identity is the kernel's open-file-description, not anything
// stored in the file, so a "persistent unlocked inode" between acquisitions
// is expected and harmless.
async function openValidatedLockFile(lockPath) {
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
  const fh = await fsp.open(lockPath, flags, 0o600);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`lifecycle lock: refusing a non-regular-file lock target: ${lockPath}`);
    return fh;
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

// Runs flock(1) against an inherited fd (never a path — see module notes)
// and resolves once the CHILD exits: exit 0 means the flock(2) call
// succeeded, meaning `fd`'s open file description is now locked and stays
// locked for as long as the caller keeps `fd` open, regardless of this
// short-lived child having already exited.
function acquireViaChild(flockBin, fd, timeoutSec) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(flockBin, ['-x', '-w', String(timeoutSec), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    } catch (e) {
      reject(e);
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

export async function withLifecycleLock(lockPath, fn, { timeoutMs = 15000 } = {}) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const flockBin = await resolveFlockBinary();
  const fh = await openValidatedLockFile(lockPath);
  try {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const { code, signal, stderr } = await acquireViaChild(flockBin, fh.fd, timeoutSec);
    if (code !== 0) {
      throw new Error(
        `lifecycle lock timed out or failed waiting for ${lockPath} ` +
        `(flock exit ${code}${signal ? `, signal ${signal}` : ''}${stderr.trim() ? `: ${stderr.trim()}` : ''})`,
      );
    }
    return await fn();
  } finally {
    // Releasing is just closing our fd: flock(2) is scoped to the open file
    // description, so this is the ENTIRE release step — no unlink, no
    // rename, no separate "am I still the owner" check, because there was
    // never a userspace ownership record to get out of sync with reality.
    await fh.close().catch(() => {});
  }
}
