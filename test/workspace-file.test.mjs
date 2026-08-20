// The workspace box worker, at the seam where its decisions are deterministic.
//
// THE INVARIANT. No root filesystem operation below terminal-controlled
// `<workspace>/_inbox` or `<workspace>/_outbox`. Both are owned by the pane
// account, so substituting either for a symlink is within that account's
// authority — and the dashboard runs as root.
//
// THE DEFECT, reproduced. `adoptIntoWorkspace()` ran
// `chown <owner> <project>/_inbox <file>` from the root dashboard, and GNU chown
// follows a command-line symlink by default:
//
//   $ sudo chown 1000:1000 ws/_inbox      # ws/_inbox -> /tmp/victim
//   drwx------ 2 1000 1000  victim        # the TARGET converted
//   lrwxrwxrwx 1 1000 1000  _inbox        # the link itself untouched
//
// The same symlink made the root `fs.mkdir` + `fs.writeFile` that preceded it
// write root-owned content into a directory the attacker chose — and the same
// substitution turned every OTHER route on both boxes into a root primitive:
// readdir/stat into metadata disclosure, sendFile/download into arbitrary root
// file read, `rm <box>/<name>` into arbitrary root delete by basename, and the
// recursive clear-all into emptying an arbitrary root directory.
//
// THE REPAIR, and what is tested here. The dashboard performs no filesystem
// operation under either box. Every one of write/list/read/delete/clear goes to
// app/workspace-writer.mjs running AS the resolved terminal owner, through the
// same fixed-argv, no-shell, job-on-stdin drop the credential helper uses. Two
// things then have to hold, and neither is provable from a running server alone:
//
//   1. the argv really is a fixed vector with no shell in it (workspaceJobArgv)
//   2. the worker itself refuses to follow a symlink, and cannot be raced into
//      following one, EVEN THOUGH it is unprivileged (applyBox*)
//
// (2) is deliberately not an lstat guard alone — a check-then-use lstat is
// still TOCTOU, and it is NOT the boundary. The boundary is that root never runs
// these operations at all; the lstat refusals exist so an operator gets a
// comprehensible error. Where a single operation can be made race-proof it is:
// the write creates O_CREAT|O_EXCL|O_NOFOLLOW onto a private temp name and
// publishes with rename(2), and the read opens O_NOFOLLOW.
//
// Nothing here needs root, so it is real evidence on any runner. The
// root-controller/non-root-worker halves live in test/upload-privilege-real.test.mjs
// and test/box-privilege-real.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import {
  HARD_KILL_GRACE_MS, INBOX_DIR, WORKSPACE_BOXES,
  applyBoxClear, applyBoxDelete, applyBoxList, applyBoxRead, applyBoxWrite,
  isSafeBoxName, readJobHeader, runWorkspaceWrite, workspaceJobArgv,
} from '../app/workspace-file.js';

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-inbox-')));
  const projectPath = path.join(root, 'demo');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'ORIGINAL\n');
  return { root, projectPath, victim, inbox: path.join(projectPath, INBOX_DIR) };
}

const bytes = (s) => Readable.from([Buffer.from(s)]);

/** Every entry under a directory, so "nothing was left behind" is measured rather than assumed. */
function entries(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

// --- the drop vector ----------------------------------------------------------

test('workspaceJobArgv is a fixed argv with no shell, for both drop mechanisms and for no drop at all', () => {
  const container = workspaceJobArgv({
    plan: { drop: true, owner: { uid: 1000, gid: 1000, user: 'admin', source: 'PW_TERMINAL_UID' } },
    execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs',
  });
  assert.deepEqual(container, [
    '/usr/bin/setpriv', '--reuid', '1000', '--regid', '1000', '--init-groups',
    '/usr/bin/node', '/app/workspace-writer.mjs',
  ]);

  const host = workspaceJobArgv({
    plan: { drop: true, owner: { uid: 1000, gid: 1000, user: 'admin', source: 'passwd' } },
    execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs',
  });
  assert.deepEqual(host, ['/usr/bin/sudo', '-n', '-u', 'admin', '/usr/bin/node', '/app/workspace-writer.mjs']);

  // Dashboard and panes already share an account (container without
  // PW_TERMINAL_UID, or a dev box running PW as the pane user): the work still
  // goes through the helper, so there is exactly ONE implementation of the write.
  assert.deepEqual(
    workspaceJobArgv({ plan: { drop: false }, execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs' }),
    ['/usr/bin/node', '/app/workspace-writer.mjs'],
  );

  for (const argv of [container, host]) {
    assert.ok(!argv.some((a) => /^(sh|bash|-c)$/.test(a)), `no shell may appear in ${JSON.stringify(argv)}`);
  }
});

test('workspaceJobArgv refuses a drop it cannot express, rather than falling back to running as root', () => {
  assert.throws(() => workspaceJobArgv({ plan: { drop: true, owner: null }, execPath: 'n', helperPath: 'h' }), /owner required/);
  assert.throws(
    () => workspaceJobArgv({ plan: { drop: true, owner: { uid: 1000, gid: 1000, source: 'passwd' } }, execPath: 'n', helperPath: 'h' }),
    /account name/,
  );
});

// --- the name that reaches the worker -----------------------------------------

test('isSafeBoxName accepts a stamped upload name and rejects anything that could leave _inbox', () => {
  assert.equal(isSafeBoxName('2026-08-20T20-00-00-000Z-notes.txt'), true);
  assert.equal(isSafeBoxName('a.bin'), true);
  for (const bad of ['', '.', '..', 'a/b', '/abs', '../escape', 'x/../../etc/passwd', '.hidden', 'a\0b', 'a\nb', 'x'.repeat(400)]) {
    assert.equal(isSafeBoxName(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

// --- the worker ----------------------------------------------------------------

test('applyBoxWrite lands the payload in _inbox, creating the directory when it is absent', async () => {
  const t = tree();
  try {
    const out = await applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('hello inbox') });
    assert.equal(out.path, path.join(t.inbox, 'a.txt'));
    assert.equal(out.bytes, 11);
    assert.equal(fs.readFileSync(out.path, 'utf8'), 'hello inbox');
    assert.equal(fs.lstatSync(out.path).isFile(), true, 'the published entry must be a real file, never a link');
    assert.equal(fs.lstatSync(out.path).mode & 0o777, 0o644, 'the pane account has to be able to read it back');
    assert.equal(fs.lstatSync(t.inbox).isDirectory(), true);
    assert.deepEqual(entries(t.inbox), ['a.txt'], 'no temp file may survive a successful write');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyBoxWrite reuses an existing _inbox and overwrites a same-named entry', async () => {
  const t = tree();
  try {
    fs.mkdirSync(t.inbox);
    fs.writeFileSync(path.join(t.inbox, 'a.txt'), 'STALE');
    const out = await applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('fresh') });
    assert.equal(fs.readFileSync(out.path, 'utf8'), 'fresh');
    assert.deepEqual(entries(t.inbox), ['a.txt']);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('ADVERSARIAL: an _inbox replaced by a symlink is refused, and the target it pointed at is untouched', async () => {
  const t = tree();
  try {
    fs.symlinkSync(t.victim, t.inbox);
    await assert.rejects(
      applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') }),
      /symlink/i,
      'a symlinked _inbox must be refused by name, not written through',
    );
    assert.deepEqual(entries(t.victim), ['keep.txt'], 'nothing may be created in the directory the link chose');
    assert.equal(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8'), 'ORIGINAL\n');
    assert.equal(fs.lstatSync(t.inbox).isSymbolicLink(), true, 'and the link itself is left exactly as found');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('ADVERSARIAL: an _inbox replaced by a regular file is refused rather than treated as a directory', async () => {
  const t = tree();
  try {
    fs.writeFileSync(t.inbox, 'not a directory');
    await assert.rejects(
      applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') }),
      /not a directory/i,
    );
    assert.equal(fs.readFileSync(t.inbox, 'utf8'), 'not a directory');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('ADVERSARIAL: a symlink planted at the upload NAME is replaced, never followed', async () => {
  const t = tree();
  try {
    fs.mkdirSync(t.inbox);
    const target = path.join(t.victim, 'keep.txt');
    fs.symlinkSync(target, path.join(t.inbox, 'a.txt'));

    const out = await applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') });

    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL\n', 'the file the link chose must not be written');
    assert.equal(fs.lstatSync(out.path).isSymbolicLink(), false, 'the planted link must be gone');
    assert.equal(fs.readFileSync(out.path, 'utf8'), 'payload', 'and the upload lands as a real file in _inbox');
    assert.deepEqual(entries(t.inbox), ['a.txt']);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('ADVERSARIAL: a name that tries to leave _inbox is refused before any filesystem work', async () => {
  const t = tree();
  try {
    for (const bad of ['../escape.txt', 'sub/escape.txt', '..', '/etc/cron.d/pw']) {
      await assert.rejects(
        applyBoxWrite({ fsp, projectPath: t.projectPath, name: bad, source: bytes('payload') }),
        /unsafe entry name/i,
        `must refuse ${JSON.stringify(bad)}`,
      );
    }
    assert.deepEqual(entries(t.projectPath), [], 'a refused name must not even create _inbox');
    assert.deepEqual(entries(t.root).filter((e) => e !== 'demo' && e !== 'victim'), []);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyBoxWrite rejects an empty payload and leaves nothing behind', async () => {
  const t = tree();
  try {
    await assert.rejects(
      applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: Readable.from([]) }),
      (e) => e.code === 'empty-payload' && /0 bytes/.test(e.message),
      'the caller has to be able to tell this apart from a server fault, because it is the streaming route\'s 400',
    );
    assert.deepEqual(entries(t.inbox), [], 'neither the empty file nor its temp may survive');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('PRESERVED: allowEmpty lets the JSON route keep accepting a genuinely empty file', async () => {
  const t = tree();
  try {
    const out = await applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: Readable.from([]), allowEmpty: true });
    assert.equal(out.bytes, 0);
    assert.equal(fs.statSync(out.path).size, 0);
    assert.deepEqual(entries(t.inbox), ['a.txt'], 'and still no temp left behind');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyBoxWrite cleans up its temp file when the payload stream fails mid-write', async () => {
  const t = tree();
  try {
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection reset'));
      },
    });
    await assert.rejects(applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source }), /connection reset/);
    assert.deepEqual(entries(t.inbox), [], 'an aborted upload leaves neither a partial file nor a temp');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyBoxWrite streams a payload larger than one chunk without truncating it', async () => {
  const t = tree();
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const source = Readable.from([chunk, chunk, chunk]);
    const out = await applyBoxWrite({ fsp, projectPath: t.projectPath, name: 'big.bin', source });
    assert.equal(out.bytes, chunk.length * 3);
    assert.equal(fs.statSync(out.path).size, chunk.length * 3);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

// --- the wire between controller and worker ------------------------------------

test('readJobHeader takes one JSON line and hands the rest of the stream on as the payload', async () => {
  const job = { action: 'inbox-write', projectPath: '/w/demo', name: 'a.txt' };
  const wire = Readable.from([Buffer.from(`${JSON.stringify(job)}\n`), Buffer.from('pay'), Buffer.from('load')]);
  const read = await readJobHeader(wire);
  assert.deepEqual(read.job, job);
  const chunks = [];
  for await (const c of read.source) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'payload');
});

test('readJobHeader keeps payload bytes that arrived in the SAME chunk as the header', async () => {
  const job = { action: 'inbox-write', projectPath: '/w/demo', name: 'a.txt' };
  const wire = Readable.from([Buffer.from(`${JSON.stringify(job)}\nfirst`), Buffer.from('-rest')]);
  const read = await readJobHeader(wire);
  const chunks = [];
  for await (const c of read.source) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'first-rest', 'a payload split across the header boundary must not be lost');
});

test('readJobHeader refuses a job it cannot parse instead of guessing', async () => {
  await assert.rejects(readJobHeader(Readable.from([Buffer.from('not json\npayload')])), /unreadable job/);
  await assert.rejects(readJobHeader(Readable.from([Buffer.from('{"a":1}')])), /unreadable job/, 'a header with no newline is not a job');
});

// --- reading, listing and deleting: the rest of the same boundary ---------------
//
// The write was only one of the privileged operations the dashboard performed
// under directories the pane account controls. `_inbox` AND `_outbox` are both
// terminal-owned workspace state, and with either replaced by a symlink the rest
// of the route surface was just as reachable from root:
//
//   readdir + stat        -> the names, sizes and mtimes of a root-only directory
//   sendFile / download   -> the BYTES of a root-only file
//   rm <box>/<name>       -> an arbitrary root file, deleted by basename
//   rm -r <box>/*         -> an arbitrary root directory, emptied
//
// So list/read/delete/clear run in the same dropped worker as the write, for
// both boxes, and refuse a substituted box directory with the same non-lstat
// guarantees. Everything below is exercised against BOTH boxes on purpose: a
// boundary that only holds for the one that was reported is not a boundary.

const boxPath = (t, box) => path.join(t.projectPath, box);

async function seedBox(t, box, files) {
  fs.mkdirSync(boxPath(t, box), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(boxPath(t, box), name), body);
}

const drain = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

test('the box directory is a fixed allowlist, so it can never become caller-chosen traversal', async () => {
  const t = tree();
  try {
    assert.deepEqual([...WORKSPACE_BOXES].sort(), ['_inbox', '_outbox'], 'exactly the two terminal-owned boxes');
    for (const bad of ['..', '../victim', '/etc', 'notabox', '', '_inbox/../..']) {
      await assert.rejects(
        applyBoxList({ fsp, projectPath: t.projectPath, box: bad }),
        /unknown workspace box/i,
        `must refuse box ${JSON.stringify(bad)}`,
      );
    }
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

for (const BOX of ['_inbox', '_outbox']) {
  test(`${BOX}: applyBoxList reports the regular entries and nothing else`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, { 'a.txt': 'aa', 'b.bin': 'bbbb' });
      fs.mkdirSync(path.join(boxPath(t, BOX), 'sub'));
      fs.symlinkSync(path.join(t.victim, 'keep.txt'), path.join(boxPath(t, BOX), 'link.txt'));

      const out = await applyBoxList({ fsp, projectPath: t.projectPath, box: BOX });
      assert.deepEqual(out.files.map((f) => f.name).sort(), ['a.txt', 'b.bin'], 'directories and links are not files');
      const a = out.files.find((f) => f.name === 'a.txt');
      assert.equal(a.size, 2);
      assert.match(a.mtime, /^\d{4}-\d{2}-\d{2}T/, 'an ISO timestamp, the shape the drawer sorts on');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxList reports an absent box as empty rather than as a failure`, async () => {
    const t = tree();
    try {
      assert.deepEqual((await applyBoxList({ fsp, projectPath: t.projectPath, box: BOX })).files, []);
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`ADVERSARIAL ${BOX}: applyBoxList refuses a symlinked box instead of disclosing what it points at`, async () => {
    const t = tree();
    try {
      fs.symlinkSync(t.victim, boxPath(t, BOX));
      await assert.rejects(applyBoxList({ fsp, projectPath: t.projectPath, box: BOX }), /symlink/i);
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxRead hands back the size and a stream of the bytes`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, { 'a.txt': 'hello read' });
      const out = await applyBoxRead({ fsp, projectPath: t.projectPath, box: BOX, name: 'a.txt' });
      assert.equal(out.bytes, 10);
      assert.equal((await drain(out.stream)).toString(), 'hello read');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxRead reports a missing entry as not-found, so the route can still answer 404`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, {});
      await assert.rejects(
        applyBoxRead({ fsp, projectPath: t.projectPath, box: BOX, name: 'nope.txt' }),
        (e) => e.code === 'not-found',
      );
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`ADVERSARIAL ${BOX}: applyBoxRead refuses a symlinked box, and a link planted at the NAME`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, {});
      fs.symlinkSync(path.join(t.victim, 'keep.txt'), path.join(boxPath(t, BOX), 'link.txt'));
      await assert.rejects(
        applyBoxRead({ fsp, projectPath: t.projectPath, box: BOX, name: 'link.txt' }),
        (e) => e.code === 'not-found' || /symlink|ELOOP/i.test(e.message),
        'a link at the entry name must not be followed to its target',
      );

      fs.rmSync(boxPath(t, BOX), { recursive: true, force: true });
      fs.symlinkSync(t.victim, boxPath(t, BOX));
      await assert.rejects(applyBoxRead({ fsp, projectPath: t.projectPath, box: BOX, name: 'keep.txt' }), /symlink/i);
      assert.equal(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8'), 'ORIGINAL\n');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxDelete removes one entry and is quiet about one that is already gone`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, { 'a.txt': 'aa', 'b.txt': 'bb' });
      await applyBoxDelete({ fsp, projectPath: t.projectPath, box: BOX, name: 'a.txt' });
      assert.deepEqual(entries(boxPath(t, BOX)), ['b.txt']);
      await applyBoxDelete({ fsp, projectPath: t.projectPath, box: BOX, name: 'a.txt' });
      assert.deepEqual(entries(boxPath(t, BOX)), ['b.txt'], 'deleting what is already gone is not an error');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`ADVERSARIAL ${BOX}: applyBoxDelete refuses a symlinked box — the file it points at survives`, async () => {
    const t = tree();
    try {
      fs.symlinkSync(t.victim, boxPath(t, BOX));
      await assert.rejects(applyBoxDelete({ fsp, projectPath: t.projectPath, box: BOX, name: 'keep.txt' }), /symlink/i);
      assert.equal(fs.existsSync(path.join(t.victim, 'keep.txt')), true, 'delete-by-basename must not reach through the link');
      assert.equal(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8'), 'ORIGINAL\n');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`ADVERSARIAL ${BOX}: applyBoxDelete refuses a name that tries to leave the box`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, { 'a.txt': 'aa' });
      for (const bad of ['../../victim/keep.txt', 'sub/x', '..', '/etc/passwd']) {
        await assert.rejects(
          applyBoxDelete({ fsp, projectPath: t.projectPath, box: BOX, name: bad }),
          /unsafe entry name/i,
          `must refuse ${JSON.stringify(bad)}`,
        );
      }
      assert.equal(fs.existsSync(path.join(t.victim, 'keep.txt')), true);
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxClear empties the box, subdirectories included, and reports what it removed`, async () => {
    const t = tree();
    try {
      await seedBox(t, BOX, { 'a.txt': 'aa', 'b.txt': 'bb' });
      fs.mkdirSync(path.join(boxPath(t, BOX), 'sub'));
      fs.writeFileSync(path.join(boxPath(t, BOX), 'sub', 'c.txt'), 'cc');

      const out = await applyBoxClear({ fsp, projectPath: t.projectPath, box: BOX });
      assert.deepEqual(out.removed.sort(), ['a.txt', 'b.txt', 'sub'], 'clear-all has always removed directories too');
      assert.deepEqual(entries(boxPath(t, BOX)), []);
      assert.equal(fs.lstatSync(boxPath(t, BOX)).isDirectory(), true, 'the box itself survives being emptied');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`${BOX}: applyBoxClear treats an absent box as already empty`, async () => {
    const t = tree();
    try {
      assert.deepEqual((await applyBoxClear({ fsp, projectPath: t.projectPath, box: BOX })).removed, []);
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });

  test(`ADVERSARIAL ${BOX}: applyBoxClear refuses a symlinked box rather than emptying what it points at`, async () => {
    const t = tree();
    try {
      fs.mkdirSync(path.join(t.victim, 'deep'), { recursive: true });
      fs.writeFileSync(path.join(t.victim, 'deep', 'inner.txt'), 'INNER\n');
      fs.symlinkSync(t.victim, boxPath(t, BOX));

      await assert.rejects(applyBoxClear({ fsp, projectPath: t.projectPath, box: BOX }), /symlink/i);
      assert.deepEqual(entries(t.victim), ['deep', 'keep.txt'], 'a recursive clear must not reach through the link');
      assert.equal(fs.readFileSync(path.join(t.victim, 'deep', 'inner.txt'), 'utf8'), 'INNER\n');
    } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
  });
}

// --- standing a worker down ----------------------------------------------------

test('REGRESSION: a worker that ignores SIGTERM is still SIGKILLed after the grace period', async (t) => {
  // The escalation timer has to OUTLIVE the promise settling. The first revision
  // of this file scheduled the SIGKILL and then cleared it one line later from
  // inside finish(), so the fallback its comment promised could never fire. A
  // fake child is the only way to observe that: a real worker exits on SIGTERM
  // and the defect is invisible.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kills = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = (sig) => { kills.push(sig); return true; };

  const settled = assert.rejects(runWorkspaceWrite({
    spawn: () => child, argv: ['/usr/bin/node', 'helper.mjs'],
    job: { action: 'box-write' }, source: new PassThrough(), timeoutMs: 1000,
  }), /timed out/);

  t.mock.timers.tick(1000);
  await settled;
  assert.deepEqual(kills, ['SIGTERM'], 'the polite request comes first');

  t.mock.timers.tick(HARD_KILL_GRACE_MS);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'], 'and a worker that ignores it is killed anyway');
});

test('a worker that DOES stand down on SIGTERM is never SIGKILLed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kills = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = (sig) => { kills.push(sig); if (sig === 'SIGTERM') child.emit('close', 1); return true; };

  const settled = assert.rejects(runWorkspaceWrite({
    spawn: () => child, argv: ['/usr/bin/node', 'helper.mjs'],
    job: { action: 'box-write' }, source: new PassThrough(), timeoutMs: 1000,
  }), /timed out|exited/);

  t.mock.timers.tick(1000);
  await settled;
  t.mock.timers.tick(HARD_KILL_GRACE_MS * 2);
  assert.deepEqual(kills, ['SIGTERM'], 'no SIGKILL for a worker that already went');
});
