// Pure-decision tests for the inbox-expiry selector. The FS removal itself goes
// through the owner-dropped, symlink-safe box worker (box-delete) that the
// dashboard UI and its own tests already exercise; here we pin only the rule for
// *what* expires, the way scheduled-tasks tests pin due-evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectExpiredBoxFiles } from '../app/workspace-file.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('selects only files older than maxAgeDays, keeps newer', () => {
  const files = [
    { name: '2026-08-01-old.png', size: 1, mtime: ago(35 * DAY) },     // expired
    { name: '2026-09-07-new.png', size: 1, mtime: ago(2 * DAY) },      // kept
  ];
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: 30 }), ['2026-08-01-old.png']);
});

test('the cutoff is strict — a file exactly maxAgeDays old is kept', () => {
  const files = [{ name: 'edge.png', size: 1, mtime: ago(30 * DAY) }]; // t === cutoff
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: 30 }), []);
  // ...one millisecond older is expired.
  const older = [{ name: 'edge.png', size: 1, mtime: ago(30 * DAY + 1) }];
  assert.deepEqual(selectExpiredBoxFiles(older, { now: NOW, maxAgeDays: 30 }), ['edge.png']);
});

test('skips names box-delete would refuse (dotfiles / in-progress upload temps)', () => {
  const files = [
    { name: '.pw-inbox-123-abc.part', size: 1, mtime: ago(100 * DAY) }, // dotfile: not deletable
    { name: '.hidden', size: 1, mtime: ago(100 * DAY) },
    { name: 'keep-me.png', size: 1, mtime: ago(100 * DAY) },            // expired + safe
  ];
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: 30 }), ['keep-me.png']);
});

test('skips entries with a missing or unparseable mtime', () => {
  const files = [
    { name: 'a.png', size: 1, mtime: 'not-a-date' },
    { name: 'b.png', size: 1 },
    { name: 'c.png', size: 1, mtime: ago(40 * DAY) }, // the only valid, expired one
  ];
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: 30 }), ['c.png']);
});

test('maxAgeDays <= 0, or a non-numeric value, disables expiry', () => {
  const files = [{ name: 'old.png', size: 1, mtime: ago(365 * DAY) }];
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: 0 }), []);
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: -5 }), []);
  assert.deepEqual(selectExpiredBoxFiles(files, { now: NOW, maxAgeDays: NaN }), []);
});

test('tolerates a missing / non-array listing', () => {
  assert.deepEqual(selectExpiredBoxFiles(undefined, { maxAgeDays: 30 }), []);
  assert.deepEqual(selectExpiredBoxFiles(null, { maxAgeDays: 30 }), []);
  assert.deepEqual(selectExpiredBoxFiles('nope', { maxAgeDays: 30 }), []);
  assert.deepEqual(selectExpiredBoxFiles([{ notaname: 1 }], { maxAgeDays: 30 }), []);
});
