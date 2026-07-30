// Reading users.json — shared by app/server.js and app/project-terminal-credentials.mjs
// so both entrypoints see the exact same records (including the legacy
// isAdmin -> role/projects/id normalization), not two independently
// maintained readers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUsersFile } from '../app/users-file.js';

test('reads and normalizes users from a real file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-users-file-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, JSON.stringify({ users: [{ username: 'alice', isAdmin: true }] }));
  const users = await loadUsersFile(file);
  assert.equal(users.length, 1);
  assert.equal(users[0].role, 'admin');
  assert.equal('isAdmin' in users[0], false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing file resolves to an empty list, not a throw', async () => {
  assert.deepEqual(await loadUsersFile('/tmp/pw-does-not-exist-users.json'), []);
});

test('REGRESSION: malformed JSON throws rather than silently resolving to an empty list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-users-file-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, '{ not valid json');
  await assert.rejects(loadUsersFile(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
