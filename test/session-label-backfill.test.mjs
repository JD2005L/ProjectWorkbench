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
//   * a window where nothing establishes whose account it spends: the pane carries no
//     credential directory AND the session's stamp does not match its owner. (A stamp
//     that merely drifted — a rotated token — is NOT that case: the pane still names
//     the person, which is the stronger evidence and the one that is used.);
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

test('a rotated or cleared token no longer blocks the label: the PANE names the person', { timeout: 120000 }, async () => {
  // Observed for real: clearing Kevin's GitHub token changed his credential fingerprint,
  // so every session stamped with the old one stopped matching and the backfill skipped
  // his projects as stale — even though those panes plainly run on HIS config directory.
  // The pane's start command carries CLAUDE_CONFIG_DIR=<base>/<encoded user>/claude,
  // which names the person directly and survives anything that changes the hash.
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const sess = `pw_${name}`;
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);
    await stripLabels(sock, sess);

    // Rotate the owner's token behind the session's back — exactly what "Clear" does.
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
    for (const u of users.users) if (u.username === OWNER) delete u.ghToken;
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));

    const out = await backfill(base, cookie);
    const mine = out.results.find((r) => r.project === name);
    assert.equal(mine.status, 'labelled', `the pane still names its owner: ${JSON.stringify(mine)}`);
    const got = await labels(sock, sess);
    assert.ok(got.every((l) => l.endsWith(`=${OWNER}`)), `every window labelled from the pane: ${got.join(' ')}`);
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('a window that names NOBODY, in a session whose stamp does not vouch, is skipped', { timeout: 120000 }, async () => {
  // The skip case is narrower than it was, and this is what is left of it: the pane
  // carries no credential directory (the shared box login, or a pane created without
  // one) AND the session's stamp does not match its owner. Nothing establishes whose
  // account that pane spends, and "cannot tell" must never become a label — a recycle
  // is the deliberate remedy.
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seed(dir, name);
    const cookie = await login(base, OWNER);
    const sess = `pw_${name}`;
    assert.equal((await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, { method: 'POST', headers: { cookie } })).json()).ok, true);

    // A plain window: no CLAUDE_CONFIG_DIR in its start command, so the pane names
    // nobody. Then corrupt the session stamp so the owner cannot vouch for it either.
    await tmux(sock, ['kill-session', '-t', sess]);
    await tmux(sock, ['new-session', '-d', '-s', sess, 'sleep 300']);
    await tmux(sock, ['set-option', '-t', sess, '@pw_cred_key', 'deadbeefdeadbeef']);
    await stripLabels(sock, sess);

    const out = await backfill(base, cookie);
    const mine = out.results.find((r) => r.project === name);
    assert.equal(mine.status, 'stale', JSON.stringify(mine));
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
