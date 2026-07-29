// Route/domain tests for the PR #20 remediation: fail-closed per-user credential
// resolution (AC1), coherent user rename (AC2), serialized mutation + credential
// side-effect lifecycle (AC3), and bounded/fail-safe user deletion (AC4).
//
// Boots real isolated instances of app/server.js exactly like smoke.test.mjs —
// throwaway registry/users/session/workspace/secret-key paths, never the live
// host. Ports 3890-3899 to stay clear of every other suite's fixed ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

function makeInstance(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lifecycle-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  const secretKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyPath, secretKey + '\n');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: secretKeyPath,
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
    PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    ...extraEnv,
  };
  return { dir, env, secretKey };
}

// Mirrors app/server.js's encrypt() exactly (AES-256-GCM, 'enc:' + base64(iv+tag+ct))
// so a test can seed users.json with an already-encrypted ghToken without going
// through the HTTP API.
function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function writeUsers(inst, users) {
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users }, null, 2));
}

function writeProjects(inst, projects) {
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(projects, null, 2));
}

function seedProject(inst, name, opts = {}) {
  const proj = path.join(inst.dir, 'workspaces', name);
  fs.mkdirSync(proj, { recursive: true });
  if (opts.git) {
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  }
  return proj;
}

// syncProjectCredentials writes the DECRYPTED token straight into the git
// credential-store line, so a test can read it back without needing the
// instance's encryption key.
function readGhTokenFromCredFile(projPath) {
  const file = path.join(projPath, '.git', '.pw-credentials');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/https:\/\/([^:]+):x-oauth-basic@github\.com/);
  return m ? m[1] : null;
}

function readProjectsConfig(base) {
  return fetch(`${base}/api/projects/config`).then((r) => r.json());
}

async function withServer(inst, port, fn) {
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: appDir, env: inst.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(base + (inst.env.PW_BASE_PATH || '') + '/healthz');
        up = r.status === 200;
      } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn(base, logs);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC1: fail-closed per-user credential resolution
// ---------------------------------------------------------------------------

test('REGRESSION: an unreadable users.json must fail closed, not silently launch under the shared login', { timeout: 30000 }, async () => {
  const port = 3890;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7801, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    // Corrupt users.json AFTER boot so the failure is isolated to the credential path.
    fs.writeFileSync(inst.env.PW_USERS_PATH, '{ not valid json');
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.notEqual(r.status, 200, 'must not report success when the users store cannot be read');
    assert.equal(body.ok, false);
    assert.match(body.error || '', /per-user-claude|credential/i, 'error must be actionable, not generic');
  });
});

test('REGRESSION: a primaryUser with a corrupt (non-decryptable) GitHub token must fail closed', { timeout: 30000 }, async () => {
  const port = 3891;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7802, primaryUser: 'alice' }]);
  // A ciphertext that will fail AES-GCM auth-tag verification (wrong key/tampered).
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: 'enc:' + Buffer.alloc(40, 1).toString('base64') }]);
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.notEqual(r.status, 200, 'must not report success when the owner\'s token cannot be decrypted');
    assert.equal(body.ok, false);
  });
});

test('REGRESSION: a primaryUser that does not resolve to any user record must fail closed', { timeout: 30000 }, async () => {
  const port = 3892;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  // primaryUser is set (not the "intentionally no owner" case) but no such user exists.
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7803, primaryUser: 'ghost' }]);
  writeUsers(inst, []);
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.notEqual(r.status, 200, 'a dangling primaryUser must not silently fall back to the shared login');
    assert.equal(body.ok, false);
  });
});

test('REGRESSION: a credential-materialization failure (base path unusable) must fail closed', { timeout: 30000 }, async () => {
  const port = 3893;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7804, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  // Make PW_USER_CRED_BASE an existing plain FILE so mkdir() inside the credential
  // job fails with ENOTDIR — a stand-in for "the helper/materialization failed".
  fs.writeFileSync(inst.env.PW_USER_CRED_BASE, 'not a directory');
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.notEqual(r.status, 200, 'a credential materialization failure must not silently launch under the shared login');
    assert.equal(body.ok, false);
  });
});

test('allowed shared fallback: feature disabled still launches fine', { timeout: 30000 }, async () => {
  const port = 3894;
  const inst = makeInstance(port); // PW_PER_USER_CLAUDE unset (off)
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7805, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: 'enc:' + Buffer.alloc(40, 1).toString('base64') }]);
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.equal(body.ok, true, 'feature-off must still use the shared login, unaffected by a bad token on an unrelated feature');
  });
});

test('REGRESSION: a dangling primaryUser on a LIVE session must not 500 the whole /api/projects/status poll — it must report that ONE project stale', { timeout: 30000 }, async () => {
  const port = 3896;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj1 = seedProject(inst, 'broken');
  const proj2 = seedProject(inst, 'fine');
  writeProjects(inst, [
    { name: 'broken', path: proj1, port: 7807, primaryUser: 'alice' },
    { name: 'fine', path: proj2, port: 7808 },
  ]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    // Establish a real live session while alice still resolves.
    const started = await fetch(`${base}/api/term/broken/recycle`, { method: 'POST' });
    assert.equal((await started.json()).ok, true, 'sanity: the session must start cleanly while the owner is valid');

    // Now alice disappears from users.json without the project's reference being
    // cleaned up (the exact shape of a dangling primaryUser).
    writeUsers(inst, []);

    const r = await fetch(`${base}/api/projects/status`);
    assert.equal(r.status, 200, 'one broken project must not take down status reporting for every project');
    const body = await r.json();
    assert.equal(body.ok, true);
    const broken = body.projects.find((p) => p.name === 'broken');
    const fine = body.projects.find((p) => p.name === 'fine');
    assert.ok(broken, 'the broken project must still be listed');
    assert.equal(broken.credentialsStale, true, 'an unresolvable owner must be reported stale, never silently "fine"');
    assert.ok(fine, 'an unrelated healthy project must still be listed');
  });
});

test('allowed shared fallback: a project with no primaryUser launches fine even with the feature on', { timeout: 30000 }, async () => {
  const port = 3895;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7806 }]); // no primaryUser at all
  writeUsers(inst, []);
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    assert.equal(body.ok, true, 'a project that intentionally has no owner must still get the shared login');
  });
});

// ---------------------------------------------------------------------------
// AC2: coherent user rename lifecycle
// ---------------------------------------------------------------------------

test('REGRESSION: renaming a user updates every project.primaryUser reference that named them', { timeout: 30000 }, async () => {
  const port = 3897;
  const inst = makeInstance(port);
  const proj1 = seedProject(inst, 'one');
  const proj2 = seedProject(inst, 'two');
  const proj3 = seedProject(inst, 'unrelated');
  writeProjects(inst, [
    { name: 'one', path: proj1, port: 7810, primaryUser: 'alice' },
    { name: 'two', path: proj2, port: 7811, primaryUser: 'alice' },
    { name: 'unrelated', path: proj3, port: 7812, primaryUser: 'bob' },
  ]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-bob', username: 'bob', role: 'developer', projects: '*' },
  ]);
  await withServer(inst, port, async (base) => {
    const patch = await fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alicia' }),
    });
    const patchBody = await patch.json();
    assert.equal(patchBody.ok, true, JSON.stringify(patchBody));
    assert.equal(patchBody.user.username, 'alicia');

    const cfg = await readProjectsConfig(base);
    const byName = Object.fromEntries(cfg.projects.map((p) => [p.name, p.primaryUser]));
    assert.equal(byName.one, 'alicia', 'project "one" must follow the rename');
    assert.equal(byName.two, 'alicia', 'project "two" must follow the rename');
    assert.equal(byName.unrelated, 'bob', 'an unrelated owner must be untouched');
  });
});

test('REGRESSION: a rename + token change together must resync EVERY owned project\'s git credentials to the new token', { timeout: 30000 }, async () => {
  const port = 3898;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7813, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_OLD') }]);
  await withServer(inst, port, async (base) => {
    const patch = await fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alicia', ghToken: 'ghp_NEW' }),
    });
    assert.equal((await patch.json()).ok, true);
    assert.equal(readGhTokenFromCredFile(proj), 'ghp_NEW', 'the project must be resynced under its NEW owner name, with the NEW token');
  });
});

// Inverse of encryptToken() above — lets a test independently confirm what a
// user's ghToken in users.json actually decrypts to, using nothing but the
// on-disk ciphertext and the instance's own secret key. This is READ-ONLY:
// unlike a "verification write" (re-issuing a mutating PATCH to see if it
// still succeeds), decrypting a value can't itself change or paper over the
// state being checked.
function decryptToken(secretKeyHex, ciphertext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const buf = Buffer.from(ciphertext.slice(4), 'base64'); // strip 'enc:'
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
}

test('REGRESSION: two racing token updates deterministically leave the NEWER one (B) in both users.json and the derived credential file', { timeout: 30000 }, async () => {
  // update()'s effect runs inside the SAME serialized tail as the commit
  // (app/user-store.js), so whichever request's handler calls
  // userStore.update() SECOND cannot even start its own commit until the
  // FIRST request's entire commit+effect has finished — there is no window
  // for the two to interleave. Firing A then B back-to-back (same tick, no
  // await between) without awaiting A first reliably reproduces "A is still
  // the one in flight when B arrives", i.e. exactly the scenario a
  // stale-snapshot bug would get wrong; empirically 30/30 locally. This is
  // the ordering claim itself; the exact "delayed A must not clobber B"
  // mechanism is proven with a fully controlled clock in
  // test/user-store.test.mjs.
  const port = 3907;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7818, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    const patch = (ghToken) => fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ghToken }),
    }).then((r) => r.json());

    const pA = patch('ghp_A');
    const pB = patch('ghp_B'); // fired immediately after, NOT awaited between
    const [a, b] = await Promise.all([pA, pB]);
    assert.ok(a.ok && b.ok, JSON.stringify({ a, b }));

    // Independent verification #1: decrypt users.json's OWN ciphertext directly
    // off disk — no HTTP round-trip, no route logic involved in the check.
    const onDisk = JSON.parse(fs.readFileSync(inst.env.PW_USERS_PATH, 'utf8'));
    const aliceRecord = onDisk.users.find((u) => u.username === 'alice');
    const usersJsonToken = decryptToken(inst.secretKey, aliceRecord.ghToken);
    assert.equal(usersJsonToken, 'ghp_B', 'users.json must hold the NEWER commit');

    // Independent verification #2: read the derived git credential file
    // directly — no mutating "check" (a resync PATCH) that could itself
    // paper over a divergence between the two.
    const fileToken = readGhTokenFromCredFile(proj);
    assert.equal(fileToken, 'ghp_B', 'the derived credential file must match — not whichever effect happened to run last in real time');
  });
});

test('REGRESSION: renaming a user actively removes their old per-user credential namespace', { timeout: 30000 }, async () => {
  const port = 3899;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  writeProjects(inst, []);
  // Simulate alice's pre-existing credential tree (as if she had already
  // signed in to Claude under her old name).
  const oldDir = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, '.claude.json'), '{}');
  await withServer(inst, port, async (base) => {
    const patch = await fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alicia' }),
    });
    assert.equal((await patch.json()).ok, true);
    assert.equal(fs.existsSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice')), false, 'the OLD credential tree must not survive the rename indefinitely');
  });
});

test('REGRESSION: a rename stales the tmux credential fingerprint of a project the owner already had a live session on', { timeout: 30000 }, async () => {
  const port = 3900;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7814, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    const started = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
    assert.equal((await started.json()).ok, true, 'sanity: the session must start cleanly before the rename');

    const patch = await fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alicia' }),
    });
    assert.equal((await patch.json()).ok, true);

    const status = await (await fetch(`${base}/api/projects/status`)).json();
    const demo = status.projects.find((p) => p.name === 'demo');
    assert.equal(demo.credentialsStale, true, 'the live session was created under the old owner name/config dir and must now read as stale');
  });
});

test('drift/restart: recycling a stale session after a rename reconciles it to the new fingerprint', { timeout: 30000 }, async () => {
  const port = 3906;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7817, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    assert.equal((await (await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' })).json()).ok, true);
    assert.equal((await (await fetch(`${base}/api/users/alice`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alicia' }),
    })).json()).ok, true);

    const beforeRecycle = await (await fetch(`${base}/api/projects/status`)).json();
    assert.equal(beforeRecycle.projects.find((p) => p.name === 'demo').credentialsStale, true, 'sanity: must be stale before reconciling');

    const recycled = await (await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' })).json();
    assert.equal(recycled.ok, true);
    assert.equal(recycled.credentialsStale, false, 'the recycle route\'s own response must already reflect the reconciled state');

    const afterRecycle = await (await fetch(`${base}/api/projects/status`)).json();
    assert.equal(afterRecycle.projects.find((p) => p.name === 'demo').credentialsStale, false, 'a freshly recreated session must no longer read as stale');
  });
});

// ---------------------------------------------------------------------------
// AC4: bounded, fail-safe user deletion
// ---------------------------------------------------------------------------

async function getUsers(base) {
  const body = await (await fetch(`${base}/api/users`)).json();
  return body.users;
}

test('user deletion: happy path revokes project references, git credentials, credential tree, and sessions', { timeout: 30000 }, async () => {
  const port = 3901;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7815, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_alice') },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  const credDir = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, '.claude.json'), '{}');
  fs.writeFileSync(inst.env.PW_SESSIONS_PATH, JSON.stringify({ sessions: [{ id: 's1', userId: 'u-alice', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() }] }, null, 2));

  await withServer(inst, port, async (base) => {
    const del = await fetch(`${base}/api/users/alice`, { method: 'DELETE' });
    assert.equal((await del.json()).ok, true);

    const cfg = await readProjectsConfig(base);
    assert.equal(cfg.projects.find((p) => p.name === 'demo').primaryUser, '', 'the project reference must be revoked');
    assert.equal(readGhTokenFromCredFile(proj), null, 'the git credential file must be cleared');
    assert.equal(fs.existsSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice')), false, 'the credential tree must be removed');
    const sessions = JSON.parse(fs.readFileSync(inst.env.PW_SESSIONS_PATH, 'utf8')).sessions;
    assert.equal(sessions.some((s) => s.userId === 'u-alice'), false, 'the deleted user\'s sessions must be revoked');
  });
});

test('user deletion refuses to remove the last admin', { timeout: 30000 }, async () => {
  const port = 3902;
  const inst = makeInstance(port);
  writeUsers(inst, [{ id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    const del = await fetch(`${base}/api/users/admin0`, { method: 'DELETE' });
    assert.equal(del.status, 409);
    const body = await del.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /last admin/i);
  });
});

test('REGRESSION: a cleanup failure must fail BEFORE the irreversible identity deletion, leaving a safely retryable state', { timeout: 30000 }, async () => {
  const port = 3903;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7816, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_alice') },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  // Force the credential-tree prune to fail: PW_USER_CRED_BASE is a plain file,
  // not a directory, so pruneUserCredentialTrees() cannot even list it.
  fs.writeFileSync(inst.env.PW_USER_CRED_BASE, 'not a directory');

  await withServer(inst, port, async (base) => {
    const del = await fetch(`${base}/api/users/alice`, { method: 'DELETE' });
    const body = await del.json().catch(() => ({}));
    assert.notEqual(del.status, 200, 'a required cleanup failure must not be reported as an unqualified success');
    assert.equal(body.ok, false);

    const usersAfterFailure = await getUsers(base);
    assert.ok(usersAfterFailure.some((u) => u.username === 'alice'),
      'the identity must still exist — deleting it before cleanup succeeded would make the failure irreversible');
    const cfgAfterFailure = await readProjectsConfig(base);
    assert.equal(cfgAfterFailure.projects.find((p) => p.name === 'demo').primaryUser, 'alice',
      'project references must be untouched until cleanup can actually complete');

    // Clear the obstruction and retry the identical request.
    fs.rmSync(inst.env.PW_USER_CRED_BASE, { force: true });
    const retry = await fetch(`${base}/api/users/alice`, { method: 'DELETE' });
    assert.equal((await retry.json()).ok, true, 'once the obstruction is cleared, a retry must fully succeed');
    assert.equal((await getUsers(base)).some((u) => u.username === 'alice'), false);
    const cfgAfterRetry = await readProjectsConfig(base);
    assert.equal(cfgAfterRetry.projects.find((p) => p.name === 'demo').primaryUser, '', 'the retry must complete the reference cleanup too');
  });
});

// ---------------------------------------------------------------------------
// AC5: source guards tying the AC1 fail-closed rewrite to the pre-existing
// root-out-of-pane-paths security properties. The actual properties (no
// chown, O_NOFOLLOW, injective username encoding, stdin-only token, default
// off) are exercised in depth by test/user-credentials.test.mjs; this only
// asserts the NEW code introduced here didn't quietly reopen the exact hole
// AC1 closed.
// ---------------------------------------------------------------------------

function extractFunctionSource(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', start);
  const braceStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

test('SECURITY: the fail-closed credential path never catches a failure back into the shared/off credentials', () => {
  const src = fs.readFileSync(path.join(appDir, 'server.js'), 'utf8');
  const credentialContext = extractFunctionSource(src, 'async function credentialContext(project){');
  const owner = extractFunctionSource(src, 'async function projectCredentialOwner(project){');
  assert.ok(credentialContext, 'credentialContext must still exist under this name');
  assert.ok(owner, 'projectCredentialOwner must still exist under this name');
  assert.equal(/catch[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*return off/.test(credentialContext), false,
    'credentialContext must not catch a failure and return the shared/off credentials');
  assert.match(credentialContext, /throw new Error/, 'failures must propagate as thrown, actionable errors');
  assert.equal(/catch[^{]*\{[^}]*return null/.test(owner), false,
    'projectCredentialOwner must not swallow a failure into a null (= shared-fallback) return');
});

test('SECURITY: PER_USER_CLAUDE remains default-off', () => {
  const src = fs.readFileSync(path.join(appDir, 'server.js'), 'utf8');
  assert.match(src, /PW_PER_USER_CLAUDE \|\| ''/, 'an unset env var must resolve to falsy, not an opt-out default');
});

// ---------------------------------------------------------------------------
// Blocker #2 (independent acceptance review): rename reconciliation must be
// retryable. A partial failure after users.json commits the new username
// must leave a durable, idempotent trail so the SAME request (or an explicit
// recovery request) can finish project.primaryUser updates, credential
// resync, and old-tree pruning — without an admin editing files by hand.
// ---------------------------------------------------------------------------

function patchUser(base, username, bodyObj) {
  return fetch(`${base}/api/users/${encodeURIComponent(username)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
  }).then((r) => r.json());
}
function reconcileUser(base, username) {
  return fetch(`${base}/api/users/${encodeURIComponent(username)}/reconcile`, { method: 'POST' }).then((r) => r.json());
}
async function getUsersRaw(base) {
  const body = await (await fetch(`${base}/api/users`)).json();
  return body.users;
}

test('pendingCredentialSync is surfaced via GET /api/users so an admin can see it needs attention', { timeout: 30000 }, async () => {
  const port = 3908;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7819, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    let users = await getUsersRaw(base);
    assert.equal(users[0].pendingCredentialSync, false);

    fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o444);
    try {
      const patch = await patchUser(base, 'alice', { username: 'alicia' });
      assert.equal(patch.ok, false);
    } finally { fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o644); }

    users = await getUsersRaw(base);
    assert.equal(users.find((u) => u.username === 'alicia').pendingCredentialSync, true, 'a stuck reconciliation must be visible, not a hidden file-only state');
  });
});

test('REGRESSION: retrying the IDENTICAL rename PATCH finishes reconciliation after the project-reference stage failed', { timeout: 30000 }, async () => {
  const port = 3909;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7820, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_x') }]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o444); // saveProjects() will fail: EACCES
    try {
      const first = await patchUser(base, 'alice', { username: 'alicia' });
      assert.equal(first.ok, false, 'a project-reference-reassignment failure must not be reported as success');
    } finally { fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o644); }

    // users.json already committed the rename (the identity change is not
    // rolled back); the project reference must NOT have moved yet.
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alicia'), true);
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, 'alice');

    // Retry with the identical body — a no-op rename this time (already
    // renamed), but the persisted pendingCredentialSync marker must still
    // drive the reconciliation through to completion.
    const retry = await patchUser(base, 'alicia', { username: 'alicia' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, 'alicia');
    assert.equal(readGhTokenFromCredFile(proj), 'ghp_x');
    assert.equal((await getUsersRaw(base)).find((u) => u.username === 'alicia').pendingCredentialSync, false);
  });
});

test('REGRESSION: retrying finishes reconciliation after the git-credential-resync stage failed', { timeout: 30000 }, async () => {
  const port = 3910;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7821, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_x') }]);
  const gitDir = path.join(proj, '.git');
  await withServer(inst, port, async (base) => {
    fs.chmodSync(gitDir, 0o555); // creating .pw-credentials inside will fail: EACCES
    try {
      const first = await patchUser(base, 'alice', { username: 'alicia' });
      assert.equal(first.ok, false);
    } finally { fs.chmodSync(gitDir, 0o755); }

    assert.equal(readGhTokenFromCredFile(proj), null, 'the resync must not have happened yet');

    const retry = await patchUser(base, 'alicia', { username: 'alicia' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, 'alicia');
    assert.equal(readGhTokenFromCredFile(proj), 'ghp_x');
  });
});

test('REGRESSION: retrying finishes reconciliation after the credential-tree-prune stage failed', { timeout: 30000 }, async () => {
  const port = 3911;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  writeProjects(inst, []);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  const credDir = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, '.claude.json'), '{}');
  await withServer(inst, port, async (base) => {
    fs.rmSync(inst.env.PW_USER_CRED_BASE, { recursive: true, force: true });
    fs.writeFileSync(inst.env.PW_USER_CRED_BASE, 'not a directory'); // pruneUserCredentialTrees will throw
    try {
      const first = await patchUser(base, 'alice', { username: 'alicia' });
      assert.equal(first.ok, false);
    } finally { fs.rmSync(inst.env.PW_USER_CRED_BASE, { force: true }); }

    const retry = await patchUser(base, 'alicia', { username: 'alicia' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal((await getUsersRaw(base)).find((u) => u.username === 'alicia').pendingCredentialSync, false);
  });
});

test('REGRESSION: the explicit recovery endpoint finishes a stuck reconciliation without resending the rename', { timeout: 30000 }, async () => {
  const port = 3912;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7822, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_x') }]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o444);
    try { assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, false); }
    finally { fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o644); }

    const recovered = await reconcileUser(base, 'alicia');
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, 'alicia');

    // Idempotent: nothing pending now, so calling it again is a harmless no-op.
    const again = await reconcileUser(base, 'alicia');
    assert.equal(again.ok, true);
    assert.equal(again.pending, false);
  });
});

test('REGRESSION: no mistaken takeover — reconciliation refuses when the old username has been reclaimed by a different account', { timeout: 30000 }, async () => {
  const port = 3913;
  const inst = makeInstance(port);
  const projAlicia = seedProject(inst, 'aliciaProj', { git: true });
  const projNewAlice = seedProject(inst, 'newAliceProj', { git: true });
  writeProjects(inst, [
    { name: 'aliciaProj', path: projAlicia, port: 7823, primaryUser: 'alice' },
    { name: 'newAliceProj', path: projNewAlice, port: 7824 },
  ]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o444);
    try { assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, false); }
    finally { fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o644); }
    // aliciaProj still points at "alice" (unreconciled) at this point.

    // A brand new, DIFFERENT person takes the now-vacant username "alice" and
    // is deliberately given ownership of a different project.
    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', role: 'developer', password: 'aB1!aB1!aB1!', projects: '*' }),
    }).then((r) => r.json());
    assert.equal(created.ok, true);
    await withProjectsLockTestHelper(inst, 'newAliceProj', 'alice');

    // Retrying alicia's reconciliation must refuse — reassigning
    // aliciaProj's project reference (or pruning "alice"'s credential
    // namespace) now would hijack the NEW alice's identity/projects.
    const attempt = await patchUser(base, 'alicia', { username: 'alicia' });
    assert.equal(attempt.ok, false, 'must not silently claim success while an unresolved naming conflict exists');
    assert.match(attempt.error, /alice/i);

    const cfg = await readProjectsConfig(base);
    assert.equal(cfg.projects.find((p) => p.name === 'aliciaProj').primaryUser, 'alice', 'must not have been reassigned to alicia — that would take over nothing (still says "alice")');
    assert.equal(cfg.projects.find((p) => p.name === 'newAliceProj').primaryUser, 'alice', 'the NEW alice\'s own project must be completely untouched');
  });
});

// Writes projects.json directly (bypassing HTTP) to assign a primaryUser,
// used only to set up the "both names exist" fixture above without needing
// a dedicated route round-trip.
async function withProjectsLockTestHelper(inst, projectName, primaryUser) {
  const projects = JSON.parse(fs.readFileSync(inst.env.PW_REGISTRY_PATH, 'utf8'));
  for (const p of projects) if (p.name === projectName) p.primaryUser = primaryUser;
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(projects, null, 2));
}

test('REGRESSION: deleting a user with an unfinished rename also revokes the lingering OLD-name project reference', { timeout: 30000 }, async () => {
  const port = 3914;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7825, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_x') },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o444);
    try { assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, false); }
    finally { fs.chmodSync(inst.env.PW_REGISTRY_PATH, 0o644); }
    // demo.primaryUser is still "alice" (the rename never finished reconciling).

    const del = await fetch(`${base}/api/users/alicia`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, '',
      'the reference under the OLD name must be revoked too, not just one under the current name');
  });
});
