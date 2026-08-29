// The one-time handover that lets a pre-boundary box be written again.
//
// THE DEFECT, reproduced. app/workspace-file.js moved every box operation to a
// worker running as the terminal owner, but the boxes the superseded ROOT path
// had already created stayed `root:root 0755`. The worker cannot create its
// O_EXCL temp file in a directory it does not own, so on an upgraded instance
// every upload into an already-used box failed with
// `EACCES ... open '<project>/_inbox/.pw-inbox-<pid>-<rand>.part'`.
//
// WHAT HAS TO HOLD, and why a running server cannot show it. Only root can
// chown, so this is the one box operation that is NOT delegated — which makes it
// the one place the old `chown <owner> <project>/_inbox` vulnerability could
// come back. The repair must therefore be provable, not merely observed:
//
//   1. it converts the INODE it opened, never the name (fchown, not chown)
//   2. O_NOFOLLOW + O_DIRECTORY refuse a planted link or file IN THE KERNEL,
//      so there is no check-then-use window to race
//   3. it takes a box from root and from nobody else
//   4. it never descends — a hard link inside a box is the inode, so chowning
//      entries would hand the account any file it could link in
//   5. one planted box does not strand every later project
//
// The open() calls here are REAL, so the kernel's own O_NOFOLLOW/O_DIRECTORY
// refusals are what the refusal cases assert. Only stat/chown are instrumented,
// because a test process is not root and cannot own a root-owned directory to
// begin with.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repairBox, repairWorkspaceBoxes, REPAIRABLE_BOXES } from '../app/workspace-box-owner.js';

const OWNER = { uid: 1000, gid: 1000 };
const ROOT_OWNED = { uid: 0, gid: 0 };

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-box-owner-'));
  test.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Real open(2), doctored ownership.
 *
 * `as` is what fstat should claim the opened inode belongs to; every chown is
 * recorded instead of performed. The open itself is untouched, so a symlink or a
 * non-directory is refused by the kernel exactly as it would be in production.
 */
function spyFs(as) {
  const opened = [];
  const chowns = [];
  return {
    opened,
    chowns,
    fsp: {
      // Only used to LABEL a refusal the kernel has already made; it can never
      // put a handle in this module's hands, so it is the real thing.
      lstat: (p) => fs.lstat(p),
      async open(p, flags) {
        opened.push(p);
        const handle = await fs.open(p, flags);
        return {
          stat: async () => ({ ...(await handle.stat()), ...as }),
          chown: async (uid, gid) => { chowns.push({ path: p, uid, gid }); },
          close: () => handle.close(),
        };
      },
    },
  };
}

test('a root-owned box is handed to the owner by fchown on the opened directory', async () => {
  const ws = await workspace();
  await fs.mkdir(path.join(ws, '_inbox'));
  const spy = spyFs(ROOT_OWNED);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'repaired');
  assert.deepEqual(r.from, ROOT_OWNED);
  // Exactly one chown, and it is on the handle this module opened itself — the
  // name was resolved once, by open(), and never again.
  assert.deepEqual(spy.chowns, [{ path: path.join(ws, '_inbox'), uid: 1000, gid: 1000 }]);
});

test('a box that already belongs to the owner is not touched', async () => {
  const ws = await workspace();
  await fs.mkdir(path.join(ws, '_inbox'));
  const spy = spyFs(OWNER);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'ok');
  assert.deepEqual(spy.chowns, [], 'the healthy case must issue no chown at all');
});

test('the repair is idempotent: a second pass over a repaired box is a no-op', async () => {
  const ws = await workspace();
  await fs.mkdir(path.join(ws, '_inbox'));
  const first = spyFs(ROOT_OWNED);
  await repairBox({ fsp: first.fsp, projectPath: ws, box: '_inbox', owner: OWNER });
  // Second boot: the box now belongs to the owner, which is the 'ok' case above.
  const second = spyFs(OWNER);

  const r = await repairBox({ fsp: second.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'ok');
  assert.deepEqual(second.chowns, []);
});

test('a box replaced by a symlink is refused by the kernel, and nothing is chowned', async () => {
  const ws = await workspace();
  const victim = path.join(ws, 'victim');
  await fs.mkdir(victim);
  // The exact substitution the superseded `chown <owner> <project>/_inbox`
  // followed: the link is what the name resolves to, the target is root's.
  await fs.symlink(victim, path.join(ws, '_inbox'));
  const spy = spyFs(ROOT_OWNED);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'refused');
  assert.match(r.reason, /symlink/);
  assert.deepEqual(spy.chowns, [], 'the TARGET must not be converted');
  // And the link itself is still exactly what it was: this module reports a
  // planted box, it does not remove one.
  assert.equal(await fs.readlink(path.join(ws, '_inbox')), victim);
});

test('a plain file sitting where a box belongs is refused, not opened as one', async () => {
  const ws = await workspace();
  await fs.writeFile(path.join(ws, '_inbox'), 'not a box');
  const spy = spyFs(ROOT_OWNED);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'refused');
  assert.match(r.reason, /not a directory/);
  assert.deepEqual(spy.chowns, []);
});

test('a box owned by some third account is reported, never reassigned', async () => {
  const ws = await workspace();
  await fs.mkdir(path.join(ws, '_outbox'));
  const spy = spyFs({ uid: 4242, gid: 4242 });

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_outbox', owner: OWNER });

  assert.equal(r.state, 'refused');
  assert.match(r.reason, /uid 4242/);
  assert.deepEqual(spy.chowns, [], 'only root is a legacy owner; anything else is somebody else policy');
});

test('a box that does not exist yet is absent, not a failure', async () => {
  const ws = await workspace();
  const spy = spyFs(ROOT_OWNED);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'absent');
  assert.deepEqual(spy.chowns, []);
});

test('the repair never descends into a box, so a hard link inside cannot be claimed', async () => {
  const ws = await workspace();
  const box = path.join(ws, '_inbox');
  await fs.mkdir(box);
  // Stand in for the escalation a recursive repair would hand over: an entry
  // whose inode is somebody else's file. O_NOFOLLOW cannot see a hard link,
  // because the link IS the inode — the only defence is not to touch entries.
  const outside = path.join(ws, 'outside');
  await fs.writeFile(outside, 'someone else\n');
  await fs.link(outside, path.join(box, 'planted'));
  const spy = spyFs(ROOT_OWNED);

  const r = await repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner: OWNER });

  assert.equal(r.state, 'repaired');
  assert.deepEqual(spy.opened, [box], 'the box directory is the ONLY path this repair opens');
  assert.equal(spy.chowns.length, 1, 'entries inside the box are never chowned');
});

test('a name outside the two boxes is a programming error, not a traversal', async () => {
  const ws = await workspace();
  const spy = spyFs(ROOT_OWNED);
  for (const box of ['../..', '.git', '_inbox/../..', 'src']) {
    await assert.rejects(
      () => repairBox({ fsp: spy.fsp, projectPath: ws, box, owner: OWNER }),
      /not a workspace box/,
    );
  }
  assert.deepEqual(spy.opened, [], 'a rejected box name never reaches open()');
});

test('an owner without a numeric uid/gid is refused before anything is opened', async () => {
  const ws = await workspace();
  await fs.mkdir(path.join(ws, '_inbox'));
  const spy = spyFs(ROOT_OWNED);
  for (const owner of [null, {}, { uid: 1000 }, { uid: 'admin', gid: 'admin' }]) {
    await assert.rejects(
      () => repairBox({ fsp: spy.fsp, projectPath: ws, box: '_inbox', owner }),
      /owner uid and gid required/,
    );
  }
  assert.deepEqual(spy.opened, []);
});

test('one planted box does not strand the projects after it', async () => {
  const ws = await workspace();
  const projects = [];
  for (const name of ['first', 'planted', 'last']) {
    const p = path.join(ws, name);
    await fs.mkdir(p);
    projects.push({ name, path: p });
  }
  await fs.mkdir(path.join(ws, 'first', '_inbox'));
  await fs.mkdir(path.join(ws, 'victim'));
  await fs.symlink(path.join(ws, 'victim'), path.join(ws, 'planted', '_inbox'));
  await fs.mkdir(path.join(ws, 'last', '_inbox'));
  const spy = spyFs(ROOT_OWNED);

  const { repaired, refused } = await repairWorkspaceBoxes({ fsp: spy.fsp, projects, owner: OWNER });

  assert.deepEqual(repaired.map(r => r.project), ['first', 'last']);
  assert.deepEqual(refused.map(r => r.project), ['planted']);
  assert.deepEqual(spy.chowns.map(c => c.path), [
    path.join(ws, 'first', '_inbox'),
    path.join(ws, 'last', '_inbox'),
  ]);
});

test('both boxes are swept, and only those two', async () => {
  assert.deepEqual(REPAIRABLE_BOXES, ['_inbox', '_outbox']);
  const ws = await workspace();
  const p = path.join(ws, 'proj');
  await fs.mkdir(path.join(p, '_inbox'), { recursive: true });
  await fs.mkdir(path.join(p, '_outbox'));
  await fs.mkdir(path.join(p, 'src'));
  const spy = spyFs(ROOT_OWNED);

  await repairWorkspaceBoxes({ fsp: spy.fsp, projects: [{ name: 'proj', path: p }], owner: OWNER });

  assert.deepEqual(spy.chowns.map(c => path.basename(c.path)), ['_inbox', '_outbox']);
});
