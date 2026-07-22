// Legacy GOA user records used `isAdmin: boolean` (no role/projects/id).
// Normalization must map them to canonical shape, leave canonical records
// untouched, and DROP the obsolete isAdmin flag so the next save persists
// canonical records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function getNormalize() {
  try {
    const m = await import('../app/users-compat.js');
    if (m.normalizeUserRecord) return m.normalizeUserRecord;
  } catch {}
  // Fallback (pre-fix layout): extract the inline function from server.js so
  // this test runs — and demonstrates the isAdmin-retention defect — on the
  // unfixed tree too.
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  const m = src.match(/function normalizeUserRecord\(u\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'normalizeUserRecord not found');
  return new Function('return ' + m[0])();
}

test('legacy isAdmin:true -> admin, projects *, id from username, isAdmin dropped', async () => {
  const normalize = await getNormalize();
  const n = normalize({ username: 'goa.admin', passwordHash: 'x', isAdmin: true });
  assert.equal(n.role, 'admin');
  assert.equal(n.projects, '*');
  assert.equal(n.id, 'goa.admin');
  assert.equal(n.username, 'goa.admin');
  assert.equal(n.passwordHash, 'x');
  assert.ok(!('isAdmin' in n), 'obsolete isAdmin must be dropped so the next persist writes canonical records');
});

test('legacy isAdmin:false -> developer, isAdmin dropped', async () => {
  const normalize = await getNormalize();
  const n = normalize({ username: 'goa.dev', isAdmin: false });
  assert.equal(n.role, 'developer');
  assert.equal(n.projects, '*');
  assert.equal(n.id, 'goa.dev');
  assert.ok(!('isAdmin' in n));
});

test('legacy record with an explicit projects list keeps it', async () => {
  const normalize = await getNormalize();
  const n = normalize({ username: 'goa.scoped', isAdmin: false, projects: ['siteA'] });
  assert.deepEqual(n.projects, ['siteA']);
  assert.equal(n.role, 'developer');
});

test('canonical-native record is left completely unchanged', async () => {
  const normalize = await getNormalize();
  const u = { id: 'u-1', username: 'dev1', role: 'developer', projects: ['a', 'b'], passwordHash: 'h', ghToken: 't' };
  const before = structuredClone(u);
  assert.deepEqual(normalize(u), before);
});

test('record with both role and stale isAdmin keeps role, drops isAdmin', async () => {
  const normalize = await getNormalize();
  const n = normalize({ id: 'u-2', username: 'dev2', role: 'content_editor', projects: ['a'], isAdmin: true });
  assert.equal(n.role, 'content_editor');
  assert.deepEqual(n.projects, ['a']);
  assert.ok(!('isAdmin' in n));
});

test('missing id is derived from username; existing id preserved', async () => {
  const normalize = await getNormalize();
  assert.equal(normalize({ username: 'x', isAdmin: true }).id, 'x');
  assert.equal(normalize({ id: 'keep-me', username: 'x', role: 'admin' }).id, 'keep-me');
});

test('persistence round-trip: a normalized user list serializes without isAdmin', async () => {
  const normalize = await getNormalize();
  const users = [
    { username: 'a', passwordHash: 'p1', isAdmin: true },
    { username: 'b', passwordHash: 'p2', isAdmin: false },
    { id: 'c', username: 'c', role: 'developer', projects: '*' },
  ].map(normalize);
  const json = JSON.stringify({ users }, null, 2);
  assert.ok(!json.includes('isAdmin'), 'persisted users.json must not carry the obsolete isAdmin field');
  const back = JSON.parse(json).users;
  assert.equal(back[0].role, 'admin');
  assert.equal(back[1].role, 'developer');
  assert.equal(back[2].role, 'developer');
});

test('non-object input passes through untouched', async () => {
  const normalize = await getNormalize();
  assert.equal(normalize(null), null);
  assert.equal(normalize(undefined), undefined);
  assert.equal(normalize('str'), 'str');
});
