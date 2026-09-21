// Upgrading terminals that already exist.
//
// Per-window identity stamps arrived after these sessions did, so their tabs render
// uncoloured even though the panes are running on perfectly good per-user credentials.
// The obvious fix — recycle — kills everything running in the session, which is an
// absurd price for a label.
//
// It is also unnecessary: a stamp is a tmux window OPTION, so it can be written to a
// LIVE session without the pane's process noticing. The whole risk is therefore not
// technical but epistemic — writing a name that is not true — so this file is mostly
// about what the backfill REFUSES to label:
//
//   * a session whose stamped fingerprint no longer matches what its owner resolves to
//     (its panes are on older credentials; the current owner's name would be wrong);
//   * a window that already carries a label (with per-launcher credentials a session
//     legitimately holds several identities, and the project owner is not all of them);
//   * anything it cannot read or resolve at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { tmux, withCockpit } from './cockpit-instance-fixture.mjs';

const scryptAsync = promisify(crypto.scrypt);
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}
const PASSWORD = 'Upgr4de!Me';
const OWNER = 'james.levac';
const OTHER = 'kevin.charlebois';

async function seed(dir, name) {
  const passwordHash = await hashPassword(PASSWORD);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { id: 'u-owner', username: OWNER, role: 'admin', projects: '*', passwordHash, ghToken: 'gho_OWNER_TOKEN' },
    { id: 'u-other', username: OTHER, role: 'developer', projects: '*', passwordHash, ghToken: 'gho_OTHER_TOKEN' },
  ] }, null, 2));
  const file = path.join(dir, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const p of projects) if (p.name === name) p.primaryUser = OWNER;
  fs.writeFileSync(file, JSON.stringify(projects, null, 2));
}
const login = async (base, username) => {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal((await r.json()).ok, true, `sanity: ${username} must sign in`);
  return r.headers.get('set-cookie').split(';')[0];
};
const backfill = (base, cookie) => fetch(`${base}/api/setup/heal/session-labels`, {
  method: 'POST', headers: { cookie },
}).then((r) => r.json().then((j) => ({ status: r.status, ...j })));

const windowIds = async (sock, sess) =>
  (await tmux(sock, ['list-windows', '-t', sess, '-F', '#{window_id}'])).split('\n').filter(Boolean);
const labels = async (sock, sess) =>
  (await tmux(sock, ['list-windows', '-t', sess, '-F', '#{window_id}=#{@pw_cred_user}'])).split('\n').filter(Boolean);
/** Put a live session back into its pre-upgrade shape: stamped session, unlabelled windows. */
async function stripLabels(sock, sess) {
  for (const id of await windowIds(sock, sess)) {
    await tmux(sock, ['set-option', '-w', '-u', '-t', id, '@pw_cred_user']);
    await tmux(sock, ['set-option', '-w', '-u', '-t', id, '@pw_cred_key']);
  }
}

test('an existing session is labelled in place, without touching what is running', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const sess = `pw_${name}`;

    // Recreate the session under the owner (as the real migration already did), then
    // strip the window labels to reproduce a terminal that predates them.
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);
    await stripLabels(sock, sess);
    const before = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, { headers: { cookie } })).json();
    assert.ok(before.windows.every((w) => !w.credUser), 'sanity: the tabs start unlabelled');
    // Something long-running, so "nothing was disturbed" is a real assertion.
    const pane = (await tmux(sock, ['list-panes', '-t', sess, '-F', '#{pane_pid}'])).split('\n')[0].trim();

    const out = await backfill(base, cookie);
    assert.equal(out.ok, true, `the backfill must run: ${JSON.stringify(out)}`);
    const mine = out.results.find((r) => r.project === name);
    assert.equal(mine.status, 'labelled');
    assert.equal(mine.owner, OWNER);
    assert.ok(mine.labelled >= 1, 'at least the base window is labelled');

    const after = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, { headers: { cookie } })).json();
    assert.ok(after.windows.every((w) => w.credUser === OWNER), 'every tab now names whose credentials it runs on');
    assert.ok(after.windows.every((w) => w.credColor), 'and so gets a colour');
    assert.equal(after.windows.length, before.windows.length, 'no window was created or destroyed');
    assert.equal((await tmux(sock, ['list-panes', '-t', sess, '-F', '#{pane_pid}'])).split('\n')[0].trim(), pane,
      'the pane process is the same one — a label is metadata, not a restart');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('a label that is already there is never overwritten', { timeout: 120000 }, async () => {
  // Per-launcher credentials mean one session can hold several identities. Relabelling
  // someone else's tab as the project owner would replace a true label with a false one.
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const sess = `pw_${name}`;
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);

    // Two windows: one belonging to somebody else, one unlabelled.
    await tmux(sock, ['new-window', '-t', sess, '-n', 'theirs']);
    const ids = await windowIds(sock, sess);
    await stripLabels(sock, sess);
    await tmux(sock, ['set-option', '-w', '-t', ids[ids.length - 1], '@pw_cred_user', OTHER]);

    const out = await backfill(base, cookie);
    const mine = out.results.find((r) => r.project === name);
    assert.equal(mine.kept, 1, 'the already-labelled window is counted as left alone');
    const got = await labels(sock, sess);
    assert.ok(got.some((l) => l.endsWith(`=${OTHER}`)), `${OTHER}'s tab keeps its own label: ${got.join(' ')}`);
    assert.ok(got.some((l) => l.endsWith(`=${OWNER}`)), 'and the blank one is filled with the owner');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('a session on older credentials is SKIPPED and named, not mislabelled', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const sess = `pw_${name}`;
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);
    await stripLabels(sock, sess);
    // Its panes are on credentials that no longer match the owner's fingerprint — the
    // exact state a pre-flag session is in. The owner's name would be a guess.
    await tmux(sock, ['set-option', '-t', sess, '@pw_cred_key', 'deadbeefdeadbeef']);

    const out = await backfill(base, cookie);
    const mine = out.results.find((r) => r.project === name);
    assert.equal(mine.status, 'stale');
    assert.match(out.message, /recycle to migrate/, 'the operator is told what the remedy is');
    assert.ok((await labels(sock, sess)).every((l) => l.endsWith('=')), 'and nothing was labelled');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('the backfill is idempotent', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);
    await stripLabels(sock, `pw_${name}`);

    const first = (await backfill(base, cookie)).results.find((r) => r.project === name);
    const second = (await backfill(base, cookie)).results.find((r) => r.project === name);
    assert.ok(first.labelled >= 1);
    assert.equal(second.labelled, 0, 'a second run has nothing left to do');
    assert.equal(second.kept, first.labelled, 'and reports the existing labels as left alone');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('with per-user credentials off, there is nothing to label and it says so', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const out = await backfill(base, cookie);
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(out.error, /no per-person identity/);
  });
});

test('only an admin can run it', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OTHER);   // developer
    const out = await backfill(base, cookie);
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});
