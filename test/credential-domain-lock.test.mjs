// A31-3 — ONE credential serialization domain, expressed as a rigorously
// ordered composed-lock protocol.
//
// The defect this replaces was a caller-supplied `serialized: true` boolean: a
// literal that is true whether or not any lock was ever taken. Nothing here
// trusts a flag. Every exclusion claim is proved by a real overlapping barrier —
// a second OS process that genuinely holds the lock — and every ordering claim
// is proved by the protocol refusing an out-of-order acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LOCK_ORDER, makeCredentialLockDomain } from '../app/credential-domain-lock.js';

const appDir = fileURLToPath(new URL('../app/', import.meta.url));

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-domain-')));
}

function lockPathsIn(dir) {
  return {
    lifecycle: path.join(dir, '.lifecycle.lock'),
    projects: path.join(dir, '.projects.lock'),
    credential: path.join(dir, '.credential.lock'),
  };
}

function domainIn(dir) {
  return makeCredentialLockDomain({ lockPaths: lockPathsIn(dir), timeoutMs: 8000 });
}

async function until(predicate, { timeoutMs = 8000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// A REAL second process that takes the named locks in canonical order, signals
// that it holds them, and only lets go when told to. This is the barrier: no
// sleeps, no assumptions about scheduling.
function startHolder(dir, names, { holdFile, releaseFile }) {
  const script = `
import { makeCredentialLockDomain } from '${appDir}credential-domain-lock.js';
import fs from 'node:fs';
const domain = makeCredentialLockDomain({ lockPaths: ${JSON.stringify(lockPathsIn(dir))}, timeoutMs: 8000 });
await domain.withLocks(${JSON.stringify(names)}, async () => {
  fs.writeFileSync(${JSON.stringify(holdFile)}, 'held\\n');
  while (!fs.existsSync(${JSON.stringify(releaseFile)})) {
    await new Promise((r) => setTimeout(r, 10));
  }
});
`;
  const file = path.join(dir, `holder-${names.join('-')}.mjs`);
  fs.writeFileSync(file, script);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  // Registered NOW, not at await time: a child that has already exited never
  // fires a listener attached afterwards, and the wait would hang forever.
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, logs, exited };
}

test('the canonical order is lifecycle > projects > credential', () => {
  assert.deepEqual(LOCK_ORDER, ['lifecycle', 'projects', 'credential']);
});

test('acquiring in canonical order runs the body once, holding every named lock', async () => {
  const domain = domainIn(tmpDir());
  const seen = [];
  const out = await domain.withLocks(['lifecycle', 'projects', 'credential'], async () => {
    seen.push(...domain.heldLockNames());
    return 'done';
  });
  assert.equal(out, 'done');
  assert.deepEqual(seen, ['lifecycle', 'projects', 'credential']);
  assert.deepEqual(domain.heldLockNames(), [], 'every lock must be released when the body returns');
});

test('a nested acquisition of an already-held lock is re-entrant and does not deadlock', async () => {
  const domain = domainIn(tmpDir());
  const out = await domain.withLocks(['lifecycle', 'projects'], async () =>
    domain.withLocks(['lifecycle', 'projects', 'credential'], async () =>
      domain.withLocks(['credential'], async () => 'inner')));
  assert.equal(out, 'inner');
});

test('an out-of-order acquisition is REFUSED rather than deadlocking', async () => {
  const domain = domainIn(tmpDir());
  await assert.rejects(
    domain.withLocks(['credential'], async () => domain.withLocks(['projects'], async () => 'never')),
    /out-of-order|canonical order/i,
  );
  await assert.rejects(
    domain.withLocks(['projects'], async () => domain.withLocks(['lifecycle'], async () => 'never')),
    /out-of-order|canonical order/i,
  );
  assert.deepEqual(domain.heldLockNames(), []);
});

test('an unknown lock name is refused', async () => {
  const domain = domainIn(tmpDir());
  await assert.rejects(domain.withLocks(['sessions'], async () => 'never'), /unknown lock/i);
});

test('locks are released when the body throws', async () => {
  const dir = tmpDir();
  const domain = domainIn(dir);
  await assert.rejects(domain.withLocks(['lifecycle', 'credential'], async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(domain.heldLockNames(), []);
  // Provably released: a second real process can now take them immediately.
  const holdFile = path.join(dir, 'held');
  const releaseFile = path.join(dir, 'release');
  const { exited } = startHolder(dir, ['lifecycle', 'credential'], { holdFile, releaseFile });
  assert.equal(await until(() => fs.existsSync(holdFile)), true, 'the locks were not released');
  fs.writeFileSync(releaseFile, 'go\n');
  await exited;
});

test('BARRIER: a credential operation cannot enter while another PROCESS holds the credential lock', async () => {
  const dir = tmpDir();
  const domain = domainIn(dir);
  const holdFile = path.join(dir, 'held');
  const releaseFile = path.join(dir, 'release');
  const { logs, exited } = startHolder(dir, ['credential'], { holdFile, releaseFile });
  assert.equal(await until(() => fs.existsSync(holdFile)), true, `holder never took the lock: ${logs.join('')}`);

  let entered = false;
  const attempt = domain.withLocks(['credential'], async () => { entered = true; return 'in'; });

  // The holder is genuinely holding it: give the attempt real time to succeed
  // incorrectly, then assert it did not.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(entered, false, 'the credential domain admitted a second holder');

  fs.writeFileSync(releaseFile, 'go\n');
  assert.equal(await attempt, 'in', 'the attempt must proceed once the lock is released');
  assert.equal(entered, true);
  await exited;
});

test('BARRIER: a credential operation cannot enter while another PROCESS holds only the PROJECTS lock', async () => {
  const dir = tmpDir();
  const domain = domainIn(dir);
  const holdFile = path.join(dir, 'held');
  const releaseFile = path.join(dir, 'release');
  // This is the reviewer's scenario: a project mutation (rename/delete) running
  // under the project lock while a user-lifecycle credential rotation starts.
  // They must not overlap, even though they entered through different doors.
  const { logs, exited } = startHolder(dir, ['lifecycle', 'projects'], { holdFile, releaseFile });
  assert.equal(await until(() => fs.existsSync(holdFile)), true, `holder never took the locks: ${logs.join('')}`);

  let entered = false;
  const rotation = domain.withLocks(['lifecycle', 'projects', 'credential'], async () => { entered = true; return 'rotated'; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(entered, false, 'a rotation overlapped a project mutation');

  fs.writeFileSync(releaseFile, 'go\n');
  assert.equal(await rotation, 'rotated');
  await exited;
});

test('OVERLAP: two concurrent credential operations in one process never run at the same time', async () => {
  const domain = domainIn(tmpDir());
  let inside = 0;
  let maxInside = 0;
  const one = async () => domain.withLocks(['lifecycle', 'projects', 'credential'], async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 60));
    inside -= 1;
  });
  await Promise.all([one(), one(), one()]);
  assert.equal(maxInside, 1, 'the credential domain let two operations overlap');
});

test('OVERLAP: two real processes serialize, proven by non-overlapping enter/exit records', async () => {
  const dir = tmpDir();
  const journal = path.join(dir, 'journal.log');
  const script = `
import { makeCredentialLockDomain } from '${appDir}credential-domain-lock.js';
import fs from 'node:fs';
const tag = process.argv[2];
const domain = makeCredentialLockDomain({ lockPaths: ${JSON.stringify(lockPathsIn(dir))}, timeoutMs: 8000 });
await domain.withLocks(['lifecycle', 'projects', 'credential'], async () => {
  fs.appendFileSync(${JSON.stringify(journal)}, 'enter ' + tag + '\\n');
  await new Promise((r) => setTimeout(r, 120));
  fs.appendFileSync(${JSON.stringify(journal)}, 'exit ' + tag + '\\n');
});
`;
  const file = path.join(dir, 'racer.mjs');
  fs.writeFileSync(file, script);
  const run = (tag) => new Promise((resolve) => {
    const c = spawn(process.execPath, [file, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([run('A'), run('B'), run('C')]);
  for (const r of results) assert.equal(r.code, 0, `racer failed: ${r.err}`);

  const lines = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  // Strict alternation enter/exit proves no critical section ever overlapped.
  for (let i = 0; i < lines.length; i += 2) {
    const [enterWord, enterTag] = lines[i].split(' ');
    const [exitWord, exitTag] = lines[i + 1].split(' ');
    assert.equal(enterWord, 'enter', `expected an enter at line ${i + 1}: ${lines.join(' | ')}`);
    assert.equal(exitWord, 'exit', `expected an exit at line ${i + 2}: ${lines.join(' | ')}`);
    assert.equal(enterTag, exitTag, `process ${enterTag} was interrupted by ${exitTag}`);
  }
});
