// Per-launcher credentials END TO END, against a real instance with a real tmux
// server: a signed-in person opens a tab, and that tab's pane really is created with
// THEIR config dirs, really is labelled with their name, and really comes back from
// the window API in the colour the operator assigned them.
//
// The unit-level contract lives in test/per-launcher-credentials.test.mjs. This file
// exists because the interesting failures are all in the wiring between layers — the
// route not passing the launcher, the stamp landing on the wrong window, the colour
// mapping never being read — and none of those are visible to a unit test or a source
// assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { tmux, withCockpit } from './cockpit-instance-fixture.mjs';

const scryptAsync = promisify(crypto.scrypt);
// Mirrors app/server.js's hashPassword(), like test/scheduled-tasks-api.test.mjs.
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

const PASSWORD = 'L4uncher!Pass';
const OWNER = 'james.levac';
const LAUNCHER = 'kevin.charlebois';
const LAUNCHER_DIR = 'kevin%2Echarlebois';

// decrypt() returns its input unchanged unless it is 'enc:'-prefixed, so a plaintext
// token can be seeded without reimplementing the AES-GCM wrapper here.
async function seedUsers(dir) {
  const passwordHash = await hashPassword(PASSWORD);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { id: 'u-owner', username: OWNER, role: 'admin', projects: '*', passwordHash, ghToken: 'gho_OWNER_TOKEN' },
    { id: 'u-launcher', username: LAUNCHER, role: 'developer', projects: '*', passwordHash, ghToken: 'gho_LAUNCHER_TOKEN' },
  ] }, null, 2));
}

function setPrimaryUser(dir, name, owner) {
  const file = path.join(dir, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const p of projects) if (p.name === name) p.primaryUser = owner;
  fs.writeFileSync(file, JSON.stringify(projects, null, 2));
}

function setTabColors(dir, colors) {
  const file = path.join(dir, 'workbench.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fixture starts with none */ }
  fs.writeFileSync(file, JSON.stringify({ ...current, userTabColors: colors }, null, 2));
}

async function login(base, username) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal((await r.json()).ok, true, `sanity: ${username} must be able to sign in`);
  return r.headers.get('set-cookie').split(';')[0];
}

const paneStartCommands = async (sock, session) =>
  (await tmux(sock, ['list-panes', '-s', '-t', session, '-F', '#{window_index}\t#{pane_start_command}']))
    .split('\n').filter(Boolean);

test('a tab opened by a person runs on THEIR credentials, labelled and coloured', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, OWNER);
    setTabColors(dir, { [OWNER]: 'orange', [LAUNCHER]: 'yellow' });

    const cookie = await login(base, LAUNCHER);
    const made = await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'kev-tab', cmd: '' }),
    });
    const body = await made.json();
    assert.equal(body.ok, true, `the tab must be created: ${JSON.stringify(body)}`);

    const win = body.windows.find((w) => w.name === 'kev-tab');
    assert.ok(win, 'the new tab must be in the returned window list');
    assert.equal(win.credUser, LAUNCHER, 'the tab must be attributed to whoever opened it');
    assert.equal(win.credColor, '#fbbf24', 'and carry the colour the operator assigned that person (yellow)');

    // The label is not cosmetic: it must match the identity the PANE was actually
    // given. Reading the pane's start command is the only way to see that, and it is
    // also what proves COPILOT_HOME made it into the environment rather than just
    // into the credential context.
    const panes = await paneStartCommands(sock, `pw_${name}`);
    const kevPane = panes.find((line) => line.startsWith(`${win.index}\t`));
    assert.ok(kevPane, `the new window must have a pane: ${panes.join(' | ')}`);
    // The path segment is the PERCENT-ENCODED username (encodeUserName: '.' -> '%2E'),
    // which is what makes two distinct usernames impossible to collide onto one dir.
    assert.match(kevPane, new RegExp(`CLAUDE_CONFIG_DIR=\\S*${LAUNCHER_DIR}/claude`), 'Claude must use the launcher\'s config dir');
    assert.match(kevPane, new RegExp(`COPILOT_HOME=\\S*${LAUNCHER_DIR}/copilot`), 'Copilot must use the launcher\'s own home, not the shared one');
    assert.doesNotMatch(kevPane, /gho_/, 'the token must never appear in a pane start command');

    // The launcher's credential tree really exists, with the instruction files seeded.
    const credRoot = path.join(dir, 'pw-users', LAUNCHER_DIR);
    assert.equal(fs.existsSync(path.join(credRoot, 'copilot')), true, 'the launcher gets their own COPILOT_HOME');
    assert.equal(fs.readFileSync(path.join(credRoot, 'session-env.sh'), 'utf8').includes('gho_LAUNCHER_TOKEN'), true,
      'the launcher\'s own GH_TOKEN is what Copilot will authenticate with');
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('the same project\'s base tab stays on the OWNER, so the strip shows both identities', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, sock, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, OWNER);
    setTabColors(dir, { [OWNER]: 'orange', [LAUNCHER]: 'yellow' });

    // Recycle so the session is (re)created after primaryUser was set — the base
    // window is created with no person behind it and must take the project owner.
    const owner = await login(base, OWNER);
    const recycled = await fetch(`${base}/api/term/${encodeURIComponent(name)}/recycle`, {
      method: 'POST', headers: { cookie: owner },
    });
    assert.equal((await recycled.json()).ok, true, 'sanity: the session must recycle');

    const cookie = await login(base, LAUNCHER);
    await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'kev-tab', cmd: '' }),
    });

    const list = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, { headers: { cookie } })).json();
    const byName = Object.fromEntries(list.windows.map((w) => [w.name, w]));
    assert.equal(byName['kev-tab'].credUser, LAUNCHER);
    assert.equal(byName['kev-tab'].credColor, '#fbbf24');
    const baseTab = list.windows.find((w) => w.name !== 'kev-tab');
    assert.equal(baseTab.credUser, OWNER, 'a pane with no person behind it belongs to the project owner');
    assert.equal(baseTab.credColor, '#f97316', 'and shows the owner\'s colour (orange), so the mix is visible');

    // One session, two identities, each recorded on its own window — the invariant
    // that replaced "refuse to add a mismatched window".
    const stamps = await tmux(sock, ['list-windows', '-t', `pw_${name}`, '-F', '#{window_name}=#{@pw_cred_user}']);
    assert.match(stamps, new RegExp(`kev-tab=${LAUNCHER}`));
    assert.match(stamps, new RegExp(`=${OWNER}`));
  }, { env: { PW_PER_USER_CLAUDE: 'true' } });
});

test('with per-launcher pinned OFF, a tab keeps running on the project owner', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, OWNER);

    const cookie = await login(base, LAUNCHER);
    const body = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'kev-tab', cmd: '' }),
    })).json();
    assert.equal(body.ok, true, `the tab must still open: ${JSON.stringify(body)}`);
    const win = body.windows.find((w) => w.name === 'kev-tab');
    assert.equal(win.credUser, OWNER, 'PW_PER_LAUNCHER_CLAUDE=false must restore owner keying without a revert');
  }, { env: { PW_PER_USER_CLAUDE: 'true', PW_PER_LAUNCHER_CLAUDE: 'false' } });
});

test('with the feature off entirely, tabs are unlabelled and uncoloured', { timeout: 120000 }, async () => {
  await withCockpit(async ({ base, name, dir }) => {
    await seedUsers(dir);
    setPrimaryUser(dir, name, OWNER);

    const cookie = await login(base, LAUNCHER);
    const body = await (await fetch(`${base}/api/term/${encodeURIComponent(name)}/windows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'kev-tab', cmd: '' }),
    })).json();
    assert.equal(body.ok, true);
    const win = body.windows.find((w) => w.name === 'kev-tab');
    // No identity to show: an uncoloured tab is how the shared box login reads, and
    // it must not be confused with "someone we could not identify".
    assert.equal(win.credUser, '', 'the shared login has no per-person identity to stamp');
    assert.equal(win.credColor, undefined);
  });
});
