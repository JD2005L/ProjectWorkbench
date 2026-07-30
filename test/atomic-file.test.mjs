// Crash-safe file writes for users.json / projects.json / sessions.json.
// A plain fs.writeFile() truncates the file in place before writing the new
// bytes — a crash (or a `kill -9`, indistinguishable at the filesystem level
// from a power loss for THIS process) between truncate and the new content
// landing leaves a corrupt or empty file behind, and a normal directory-entry
// rename is not durable on its own without an fsync of the directory too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../app/atomic-file.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-atomic-'));
}

test('writes the content and sets the requested mode', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'data.json');
  await writeFileAtomic(file, JSON.stringify({ a: 1 }) + '\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('overwrites existing content completely (no partial-append artifacts)', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'data.json');
  await writeFileAtomic(file, 'x'.repeat(500), { mode: 0o600 });
  await writeFileAtomic(file, 'short', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'short');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('never leaves a stray temp file behind on success', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'data.json');
  await writeFileAtomic(file, 'hello', { mode: 0o600 });
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ['data.json']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an unwritable target directory rejects rather than silently doing nothing', async () => {
  await assert.rejects(writeFileAtomic('/tmp/pw-does-not-exist-dir-xyz/data.json', 'x', { mode: 0o600 }));
});

test('REGRESSION: a process killed mid-write never corrupts or truncates the previous good file', { timeout: 15000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, 'ORIGINAL-GOOD-CONTENT');

  // A child process that writes a large payload via writeFileAtomic, given
  // just enough time to open+start writing the TEMP file before being
  // SIGKILLed — i.e. killed before it could ever reach the atomic rename.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileAtomic } from ${JSON.stringify(path.join(APP_DIR, 'atomic-file.js'))};
    await writeFileAtomic(${JSON.stringify(file)}, 'X'.repeat(50_000_000), { mode: 0o600 });
  `]);
  await new Promise((r) => setTimeout(r, 40));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));

  assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL-GOOD-CONTENT', 'the original file must survive a mid-write crash untouched');
  // No half-written temp file should be mistaken for the real file by any reader.
  const entries = fs.readdirSync(dir);
  assert.ok(entries.includes('data.json'));
  for (const e of entries) if (e !== 'data.json') assert.match(e, /\.tmp-/, `unexpected leftover: ${e}`);
  await fsp.rm(dir, { recursive: true, force: true });
});
