// Handing a legacy `_inbox` / `_outbox` back to the account that now operates it.
//
// WHY THIS FILE EXISTS. app/workspace-file.js moved every box operation out of
// the root dashboard and into app/workspace-writer.mjs running AS the terminal
// owner. That closed the boundary for good, but it said nothing about the boxes
// the SUPERSEDED root path had already created. Those directories are
// `root:root 0755`, and the worker is no longer root:
//
//   Paste failed: EACCES: permission denied, open
//   '<project>/_inbox/.pw-inbox-<pid>-<rand>.part'
//
// The worker cannot create its O_EXCL temp file in a directory it does not own,
// so on an instance that predates the boundary EVERY upload into an
// already-used box fails, and nothing in the running system repairs it. The
// structural fix therefore needs a one-time ownership handover to go with it —
// the same shape as the credential tree's "write as the owner, and repair the
// ones already written".
//
// ONLY ROOT CAN chown, SO THIS ONE OPERATION CANNOT BE DELEGATED to the worker.
// That puts it in direct tension with the rule app/workspace-file.js exists to
// enforce, and a naive repair is the very vulnerability that module removed:
// `chown <owner> <project>/_inbox` follows a command-line symlink, so a planted
// `_inbox -> /some/root/dir` converts the TARGET. An lstat first would not help;
// check-then-use is still TOCTOU.
//
// SO THE HANDOVER IS RACE-PROOF BY CONSTRUCTION, not by checking:
//
//   open(box, O_RDONLY|O_NOFOLLOW|O_DIRECTORY)   one syscall, no path re-resolution
//   fstat(fd)                                     what we are about to convert
//   fchown(fd, uid, gid)                          that inode, not that name
//
// O_NOFOLLOW refuses a symlink at the final component (ELOOP) and O_DIRECTORY
// refuses anything that is not a directory (ENOTDIR), both in the kernel and
// both before we hold anything. Every later syscall addresses the OPEN FILE, so
// no substitution between the open and the chown can redirect it — the name is
// resolved exactly once, and never again.
//
// WHY GIVING A DIRECTORY AWAY IS NOT A NEW PRIMITIVE. The fd provably names a
// directory, and the pane account cannot present an arbitrary root-owned one at
// `<project>/_inbox`: Linux forbids hard links to directories outright, and
// renaming a directory into the workspace needs write permission on the
// directory's ORIGINAL parent, which for a root-owned tree it does not have. The
// only root-owned directory it can have at that name is one the old root
// dashboard put there — the case this repair is for. Handing that back restores
// the invariant; it does not widen the account's authority by a single inode.
//
// WHY THE ENTRIES INSIDE ARE DELIBERATELY LEFT ALONE. Recursing WOULD create a
// new primitive, and a worse one than the bug: a hard link inside the box is the
// inode, so O_NOFOLLOW does not see it, and chowning entries would hand the
// account any file it could link in. It is also unnecessary. Delete and replace
// are governed by write permission on the DIRECTORY, which this repair restores,
// and rename(2) publishes an upload over a root-owned predecessor without ever
// opening it. Legacy files stay root-owned at 0644, which lists, downloads,
// deletes and overwrites exactly as before.

import { constants as fsConstants } from 'node:fs';

/** The `<project>` children this repair will ever name. Anything else is a bug. */
export const REPAIRABLE_BOXES = ['_inbox', '_outbox'];

/**
 * The uid we are willing to take a box away from.
 *
 * ONLY root. A box owned by some third account is not a leftover of the
 * superseded path, and quietly reassigning it would be this module inventing a
 * policy rather than repairing a known regression — so it is reported and left
 * exactly as it is.
 */
const LEGACY_UID = 0;

/** open(2) flags that make the handle provably a real directory at that name. */
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;

/**
 * A name for what is sitting where a box belongs — for the OPERATOR, not for the
 * decision.
 *
 * Linux reports a symlinked final component as ENOTDIR rather than ELOOP once
 * O_DIRECTORY is in the flags, so errno alone cannot tell "someone linked the
 * box away" from "someone left a file here" — and those want very different
 * responses. This lstat runs only AFTER the kernel has already refused, so it is
 * not a check-then-use: the outcome is settled, no handle exists, and no chown
 * can follow from anything it says. It fails soft, because a worse message is
 * still better than a repair sweep that throws.
 */
async function describeRefusal(fsp, dir) {
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink()) return 'box is a symlink';
  } catch { /* whatever it was is gone or unreadable; the generic answer stands */ }
  return 'box is not a directory';
}

/**
 * Hand ONE box back to `owner`, if and only if root still holds it.
 *
 * Resolves to a record of what happened, never rejects for an ordinary outcome:
 * a box that does not exist yet, or already belongs to the owner, is the normal
 * case on a healthy instance and must not look like a failure at boot.
 *
 *   { box, state: 'ok' }        already the owner's — nothing to do
 *   { box, state: 'absent' }    no such box yet; the worker will create its own
 *   { box, state: 'repaired' }  root's, now the owner's
 *   { box, state: 'refused', reason }  a symlink, a non-directory, a third owner
 */
export async function repairBox({ fsp, projectPath, box, owner }) {
  if (!REPAIRABLE_BOXES.includes(box)) throw new Error(`repairBox: not a workspace box ${JSON.stringify(String(box))}`);
  if (!Number.isInteger(owner?.uid) || !Number.isInteger(owner?.gid)) {
    throw new Error('repairBox: owner uid and gid required');
  }
  const dir = `${projectPath}/${box}`;

  let handle;
  try {
    handle = await fsp.open(dir, DIR_FLAGS);
  } catch (e) {
    if (e?.code === 'ENOENT') return { box, dir, state: 'absent' };
    // ELOOP and ENOTDIR are both the planted-box case: something that is not a
    // directory is sitting where a box belongs. They are reported rather than
    // worked around — an operator needs to see it, and this module will not be
    // the one to remove it.
    if (e?.code === 'ELOOP' || e?.code === 'ENOTDIR') {
      return { box, dir, state: 'refused', reason: await describeRefusal(fsp, dir) };
    }
    return { box, dir, state: 'refused', reason: e?.message || String(e) };
  }

  try {
    const st = await handle.stat();
    if (st.uid === owner.uid && st.gid === owner.gid) return { box, dir, state: 'ok' };
    if (st.uid !== LEGACY_UID) {
      return { box, dir, state: 'refused', reason: `owned by uid ${st.uid}, not root` };
    }
    // fchown on the handle: this inode, whatever the name resolves to now.
    await handle.chown(owner.uid, owner.gid);
    return { box, dir, state: 'repaired', from: { uid: st.uid, gid: st.gid } };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Hand every project's boxes back, and say what changed.
 *
 * One project's refusal never stops the sweep: a single planted box would
 * otherwise leave every LATER project still broken, which is the opposite of
 * what a repair is for.
 */
export async function repairWorkspaceBoxes({ fsp, projects, owner, boxes = REPAIRABLE_BOXES }) {
  const repaired = [];
  const refused = [];
  for (const project of projects || []) {
    if (!project?.path) continue;
    for (const box of boxes) {
      let r;
      try { r = await repairBox({ fsp, projectPath: project.path, box, owner }); }
      catch (e) { r = { box, dir: `${project.path}/${box}`, state: 'refused', reason: e?.message || String(e) }; }
      if (r.state === 'repaired') repaired.push({ project: project.name, ...r });
      else if (r.state === 'refused') refused.push({ project: project.name, ...r });
    }
  }
  return { repaired, refused };
}
