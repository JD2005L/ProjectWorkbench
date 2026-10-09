// Inbox pins: a pinned file is kept past the inbox expiry for as long as it stays
// pinned; unpinned, it is ordinary again and an already-expired one goes at the next
// sweep (James, 2026-10-07). The pins live in a root-owned file outside every
// workspace (app/inbox-pins.js); the sweep's rule is selectExpiredBoxFiles' `keep`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInboxPins, inboxExpiresAt } from '../app/inbox-pins.js';
import { selectExpiredBoxFiles } from '../app/workspace-file.js';
import { writeFileAtomic } from '../app/atomic-file.js';
import { selfOwnedTerminalEnv } from './terminal-owner-fixture.mjs';

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pins-'));

// ---------------------------------------------------------------- the rule

test('the sweep keeps pinned files however old, and expires the same file once unpinned', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const files = [
    { name: 'old-pinned.pdf', size: 1, mtime: new Date(now - 90 * DAY).toISOString() },
    { name: 'old.pdf', size: 1, mtime: new Date(now - 40 * DAY).toISOString() },
    { name: 'new.pdf', size: 1, mtime: new Date(now - 2 * DAY).toISOString() },
  ];
  assert.deepEqual(selectExpiredBoxFiles(files, { now, maxAgeDays: 30, keep: new Set(['old-pinned.pdf']) }), ['old.pdf']);
  assert.deepEqual(selectExpiredBoxFiles(files, { now, maxAgeDays: 30, keep: new Set() }).sort(), ['old-pinned.pdf', 'old.pdf']);
  assert.deepEqual(selectExpiredBoxFiles(files, { now, maxAgeDays: 30 }).sort(), ['old-pinned.pdf', 'old.pdf'], 'no keep = the old behaviour');
});

test('a file\'s expiry date: age + the setting, none when pinned or when expiry is off', () => {
  const mtime = '2026-10-01T00:00:00.000Z';
  assert.equal(inboxExpiresAt({ mtime, pinned: false, maxAgeDays: 30 }), '2026-10-31T00:00:00.000Z');
  assert.equal(inboxExpiresAt({ mtime, pinned: true, maxAgeDays: 30 }), null);
  assert.equal(inboxExpiresAt({ mtime, pinned: false, maxAgeDays: 0 }), null);
  assert.equal(inboxExpiresAt({ mtime: 'nonsense', pinned: false, maxAgeDays: 30 }), null);
});

// ---------------------------------------------------------------- the store

test('pins persist, toggle idempotently, and are written owner-only', async () => {
  const file = path.join(tmp(), 'state', 'inbox-pins.json');
  const pins = createInboxPins({ fsp, file, writeFileAtomic });
  await pins.setPinned('P', 'a.pdf', true);
  await pins.setPinned('P', 'a.pdf', true);
  await pins.setPinned('P', 'b.pdf', true);
  await pins.setPinned('Q', 'c.pdf', true);
  await pins.setPinned('P', 'b.pdf', false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { P: ['a.pdf'], Q: ['c.pdf'] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createInboxPins({ fsp, file, writeFileAtomic });
  assert.deepEqual([...await again.pinned('P')], ['a.pdf']);
  assert.deepEqual([...await again.pinned('none')], []);
});

test('quick successive toggles never lose one another', async () => {
  const file = path.join(tmp(), 'inbox-pins.json');
  const pins = createInboxPins({ fsp, file, writeFileAtomic });
  await Promise.all(Array.from({ length: 20 }, (_, i) => pins.setPinned('P', `f${i}`, true)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).P.length, 20);
});

test('pins for files that are gone are forgotten, so a later upload of that name is not pinned', async () => {
  const file = path.join(tmp(), 'inbox-pins.json');
  const pins = createInboxPins({ fsp, file, writeFileAtomic });
  await pins.setPinned('P', 'kept.pdf', true);
  await pins.setPinned('P', 'gone.pdf', true);
  await pins.pruneMissing('P', ['kept.pdf', 'other.pdf']);
  assert.deepEqual([...await pins.pinned('P')], ['kept.pdf']);
  await pins.pruneMissing('P', []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('an unreadable pins file reads as nothing pinned, and malformed entries are ignored', async () => {
  const dir = tmp();
  const file = path.join(dir, 'inbox-pins.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual([...await createInboxPins({ fsp, file, writeFileAtomic }).pinned('P')], []);
  fs.writeFileSync(file, JSON.stringify({ P: 'not-a-list', Q: ['x'] }));
  const pins = createInboxPins({ fsp, file, writeFileAtomic });
  assert.deepEqual([...await pins.pinned('P')], []);
  assert.deepEqual([...await pins.pinned('Q')], ['x']);
});

// ---------------------------------------------------------------- through the dashboard

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test('API: listing shows pin state and expiry; pin, unpin, refusals; clear-all keeps pinned files', { timeout: 40000 }, async () => {
  const dir = tmp();
  const port = await freePort();
  const proj = path.join(dir, 'workspaces', 'demo');
  const inbox = path.join(proj, '_inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([{ name: 'demo', path: proj, port: 7801 }]));
  for (const n of ['keep.pdf', 'old.pdf', 'new.pdf']) fs.writeFileSync(path.join(inbox, n), n);
  const forty = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(path.join(inbox, 'old.pdf'), forty, forty);
  const pinsFile = path.join(dir, 'inbox-pins.json');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8', PORT: String(port), PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'), PW_USERS_PATH: path.join(dir, 'users.json'), PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'), PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'), PW_AUDIT_LOG: path.join(dir, 'audit.log'),
    PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'), PW_INBOX_PINS_PATH: pinsFile,
    ...selfOwnedTerminalEnv(),
  };
  fs.writeFileSync(env.PW_SECRET_KEY_PATH, 'a'.repeat(64) + '\n');
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: path.dirname(serverJs), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const json = async (url, init) => { const r = await fetch(base + url, init); return { status: r.status, body: await r.json() }; };
  const pin = (name, pinned) => json(`/api/inbox/demo/${encodeURIComponent(name)}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up\n${logs.join('')}`);

    let list = (await json('/api/inbox/demo')).body;
    const byName = (l) => Object.fromEntries(l.files.map((f) => [f.name, f]));
    assert.equal(byName(list)['keep.pdf'].pinned, false);
    assert.ok(byName(list)['keep.pdf'].expiresAt, 'an unpinned file reports when it will expire');
    assert.ok(Date.parse(byName(list)['old.pdf'].expiresAt) < Date.now(), 'an old file is already due');

    const pinned = await pin('keep.pdf', true);
    assert.equal(pinned.status, 200);
    assert.deepEqual({ ok: pinned.body.ok, pinned: pinned.body.pinned, expiresAt: pinned.body.expiresAt }, { ok: true, pinned: true, expiresAt: null });
    await pin('old.pdf', true);
    list = (await json('/api/inbox/demo')).body;
    assert.equal(byName(list)['keep.pdf'].pinned, true);
    assert.equal(byName(list)['keep.pdf'].expiresAt, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(pinsFile, 'utf8')), { demo: ['keep.pdf', 'old.pdf'] });

    const unpinned = await pin('old.pdf', false);
    assert.equal(unpinned.body.pinned, false);
    assert.ok(Date.parse(unpinned.body.expiresAt) < Date.now(), 'unpinned and already past its age: due at the next sweep');

    assert.equal((await pin('nope.pdf', true)).status, 404);
    assert.equal((await json('/api/inbox/demo/keep.pdf/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: 'yes' }) })).status, 400);
    assert.equal((await pin('sub/nope.pdf', true)).status, 404, 'a path is reduced to its base name, which must name a listed file');

    // Clear all keeps what is pinned.
    const cleared = await json('/api/inbox/demo', { method: 'DELETE' });
    assert.deepEqual(cleared.body, { ok: true, kept: 1 });
    assert.deepEqual(fs.readdirSync(inbox), ['keep.pdf']);

    // Deleting a pinned file on purpose works, and takes its pin with it.
    assert.equal((await json('/api/inbox/demo/keep.pdf', { method: 'DELETE' })).body.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(pinsFile, 'utf8')), {});
    assert.ok(fs.readFileSync(env.PW_AUDIT_LOG, 'utf8').includes('inbox_pin'), 'pinning is audited');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
