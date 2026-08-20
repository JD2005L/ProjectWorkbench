// The workspace inbox writer, at the seam where its decisions are deterministic.
//
// THE DEFECT. `adoptIntoWorkspace()` ran `chown <owner> <project>/_inbox <file>`
// from the ROOT dashboard, and GNU chown follows a command-line symlink by
// default. A pane account that owns its own workspace could therefore replace
// `_inbox` with a symlink and have root hand it any directory on the host:
//
//   $ sudo chown 1000:1000 ws/_inbox      # ws/_inbox -> /tmp/victim
//   drwx------ 2 1000 1000  victim        # the TARGET converted
//   lrwxrwxrwx 1 1000 1000  _inbox        # the link itself untouched
//
// The same symlink also made the root `fs.mkdir` + `fs.writeFile` that preceded
// it write root-owned content into a directory the attacker chose.
//
// THE REPAIR, and what is tested here. The dashboard no longer writes or chowns
// a workspace path at all: it hands the bytes to app/workspace-writer.mjs
// running AS the resolved terminal owner, through the same fixed-argv,
// no-shell, job-on-stdin drop the credential helper uses. Two things then have
// to hold, and neither is provable from a running server alone:
//
//   1. the argv really is a fixed vector with no shell in it (inboxWriteArgv)
//   2. the worker itself refuses to follow a symlink, and cannot be raced into
//      following one, EVEN THOUGH it is unprivileged (applyInboxWrite)
//
// (2) is deliberately not an lstat guard alone — a check-then-use lstat is
// still TOCTOU. The create is O_CREAT|O_EXCL|O_NOFOLLOW onto a private temp
// name and the publish is rename(2), neither of which follows a final symlink.
//
// Nothing here needs root, so it is real evidence on any runner. The
// root-controller/non-root-worker half lives in test/upload-privilege-real.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  INBOX_DIR, applyInboxWrite, inboxWriteArgv, isSafeInboxName, readJobHeader,
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

test('inboxWriteArgv is a fixed argv with no shell, for both drop mechanisms and for no drop at all', () => {
  const container = inboxWriteArgv({
    plan: { drop: true, owner: { uid: 1000, gid: 1000, user: 'admin', source: 'PW_TERMINAL_UID' } },
    execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs',
  });
  assert.deepEqual(container, [
    '/usr/bin/setpriv', '--reuid', '1000', '--regid', '1000', '--init-groups',
    '/usr/bin/node', '/app/workspace-writer.mjs',
  ]);

  const host = inboxWriteArgv({
    plan: { drop: true, owner: { uid: 1000, gid: 1000, user: 'admin', source: 'passwd' } },
    execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs',
  });
  assert.deepEqual(host, ['/usr/bin/sudo', '-n', '-u', 'admin', '/usr/bin/node', '/app/workspace-writer.mjs']);

  // Dashboard and panes already share an account (container without
  // PW_TERMINAL_UID, or a dev box running PW as the pane user): the work still
  // goes through the helper, so there is exactly ONE implementation of the write.
  assert.deepEqual(
    inboxWriteArgv({ plan: { drop: false }, execPath: '/usr/bin/node', helperPath: '/app/workspace-writer.mjs' }),
    ['/usr/bin/node', '/app/workspace-writer.mjs'],
  );

  for (const argv of [container, host]) {
    assert.ok(!argv.some((a) => /^(sh|bash|-c)$/.test(a)), `no shell may appear in ${JSON.stringify(argv)}`);
  }
});

test('inboxWriteArgv refuses a drop it cannot express, rather than falling back to running as root', () => {
  assert.throws(() => inboxWriteArgv({ plan: { drop: true, owner: null }, execPath: 'n', helperPath: 'h' }), /owner required/);
  assert.throws(
    () => inboxWriteArgv({ plan: { drop: true, owner: { uid: 1000, gid: 1000, source: 'passwd' } }, execPath: 'n', helperPath: 'h' }),
    /account name/,
  );
});

// --- the name that reaches the worker -----------------------------------------

test('isSafeInboxName accepts a stamped upload name and rejects anything that could leave _inbox', () => {
  assert.equal(isSafeInboxName('2026-08-20T20-00-00-000Z-notes.txt'), true);
  assert.equal(isSafeInboxName('a.bin'), true);
  for (const bad of ['', '.', '..', 'a/b', '/abs', '../escape', 'x/../../etc/passwd', '.hidden', 'a\0b', 'a\nb', 'x'.repeat(400)]) {
    assert.equal(isSafeInboxName(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

// --- the worker ----------------------------------------------------------------

test('applyInboxWrite lands the payload in _inbox, creating the directory when it is absent', async () => {
  const t = tree();
  try {
    const out = await applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('hello inbox') });
    assert.equal(out.path, path.join(t.inbox, 'a.txt'));
    assert.equal(out.bytes, 11);
    assert.equal(fs.readFileSync(out.path, 'utf8'), 'hello inbox');
    assert.equal(fs.lstatSync(out.path).isFile(), true, 'the published entry must be a real file, never a link');
    assert.equal(fs.lstatSync(out.path).mode & 0o777, 0o644, 'the pane account has to be able to read it back');
    assert.equal(fs.lstatSync(t.inbox).isDirectory(), true);
    assert.deepEqual(entries(t.inbox), ['a.txt'], 'no temp file may survive a successful write');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyInboxWrite reuses an existing _inbox and overwrites a same-named entry', async () => {
  const t = tree();
  try {
    fs.mkdirSync(t.inbox);
    fs.writeFileSync(path.join(t.inbox, 'a.txt'), 'STALE');
    const out = await applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('fresh') });
    assert.equal(fs.readFileSync(out.path, 'utf8'), 'fresh');
    assert.deepEqual(entries(t.inbox), ['a.txt']);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('ADVERSARIAL: an _inbox replaced by a symlink is refused, and the target it pointed at is untouched', async () => {
  const t = tree();
  try {
    fs.symlinkSync(t.victim, t.inbox);
    await assert.rejects(
      applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') }),
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
      applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') }),
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

    const out = await applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: bytes('payload') });

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
        applyInboxWrite({ fsp, projectPath: t.projectPath, name: bad, source: bytes('payload') }),
        /unsafe upload name/i,
        `must refuse ${JSON.stringify(bad)}`,
      );
    }
    assert.deepEqual(entries(t.projectPath), [], 'a refused name must not even create _inbox');
    assert.deepEqual(entries(t.root).filter((e) => e !== 'demo' && e !== 'victim'), []);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyInboxWrite rejects an empty payload and leaves nothing behind', async () => {
  const t = tree();
  try {
    await assert.rejects(
      applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: Readable.from([]) }),
      (e) => e.code === 'empty-payload' && /0 bytes/.test(e.message),
      'the caller has to be able to tell this apart from a server fault, because it is the streaming route\'s 400',
    );
    assert.deepEqual(entries(t.inbox), [], 'neither the empty file nor its temp may survive');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('PRESERVED: allowEmpty lets the JSON route keep accepting a genuinely empty file', async () => {
  const t = tree();
  try {
    const out = await applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source: Readable.from([]), allowEmpty: true });
    assert.equal(out.bytes, 0);
    assert.equal(fs.statSync(out.path).size, 0);
    assert.deepEqual(entries(t.inbox), ['a.txt'], 'and still no temp left behind');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyInboxWrite cleans up its temp file when the payload stream fails mid-write', async () => {
  const t = tree();
  try {
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('connection reset'));
      },
    });
    await assert.rejects(applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'a.txt', source }), /connection reset/);
    assert.deepEqual(entries(t.inbox), [], 'an aborted upload leaves neither a partial file nor a temp');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('applyInboxWrite streams a payload larger than one chunk without truncating it', async () => {
  const t = tree();
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const source = Readable.from([chunk, chunk, chunk]);
    const out = await applyInboxWrite({ fsp, projectPath: t.projectPath, name: 'big.bin', source });
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
