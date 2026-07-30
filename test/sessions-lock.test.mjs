// Round 5, item 4: sessions.json's read-modify-write (create/touch/logout/
// purge) was serialized only by an IN-PROCESS promise chain (sessionsLock)
// guarding an IN-PROCESS cache (sessionsCache) — app/server.js's own
// withUsersLock pattern, reused everywhere else in this file for
// users.json, was never applied here. Two real dashboard processes (a
// rolling restart overlap, two instances, a CLI tool) racing sessions.json
// had no cross-process coordination at all: each process's OWN cache read
// the file once, mutated its own in-memory copy, and wrote the WHOLE file
// back — so whichever process's write landed last silently discarded every
// other process's concurrent session create/revoke.
//
// Fixed by routing sessions.json through the SAME cross-process
// withLifecycleLock (app/lifecycle-lock.js, itself hardened in round 4) that
// already serializes users.json, with a reload-from-disk-under-lock
// read-modify-write and NO process-local cache — exactly users.json's own
// shape (loadUsers/saveUsers/withUsersLock).
//
// These tests spawn REAL, SEPARATE dashboard processes (not just async tasks
// in one process) sharing one sessions.json/users.json, for genuine
// cross-process concurrency — the same technique app/lifecycle-lock.js's own
// test suite uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(crypto.scrypt);
const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

function makeSharedInstance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sessions-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  fs.writeFileSync(secretKeyPath, crypto.randomBytes(32).toString('hex') + '\n');
  const sessionsPath = path.join(dir, 'sessions.json');
  return {
    dir,
    sessionsPath,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      PW_ISOLATED: '1',
      PW_REGISTRY_PATH: path.join(dir, 'registry', 'projects.json'),
      PW_USERS_PATH: path.join(dir, 'users', 'users.json'),
      PW_SESSIONS_PATH: sessionsPath,
      PW_WORKSPACES: path.join(dir, 'workspaces'),
      PW_SECRET_KEY_PATH: secretKeyPath,
      PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
      PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
      PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    },
  };
}

function spawnServerOn(inst, port) {
  const env = { ...inst.env, PORT: String(port) };
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return { child, base: `http://127.0.0.1:${port}`, logs };
}

async function waitUp(inst) {
  for (let i = 0; i < 80; i++) {
    if (inst.child.exitCode !== null) break;
    try { if ((await fetch(inst.base + '/healthz')).status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 125));
  }
  assert.fail(`server did not come up on ${inst.base}\n--- logs ---\n${inst.logs.join('')}`);
}

async function killAll(procs) {
  const pids = procs.map((p) => p.pid);
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
  await new Promise((r) => setTimeout(r, 200));
  for (const p of procs) { if (p.exitCode === null) { try { p.kill('SIGKILL'); } catch { /* fine */ } } }
  // See test/projects-lock.test.mjs's identical cleanup for why: PW_ISOLATED
  // auto-derives a tmux socket keyed to each server's own pid, and nothing
  // else ever cleans those servers up.
  await Promise.all(pids.map((pid) => new Promise((resolve) => {
    const tk = spawn('tmux', ['-L', `pwprev-${pid}`, 'kill-server']);
    tk.on('exit', resolve);
    tk.on('error', resolve);
  })));
}

function readSessionsRaw(sessionsPath) {
  try { return JSON.parse(fs.readFileSync(sessionsPath, 'utf8')).sessions || []; }
  catch { return []; }
}

test('REGRESSION: two REAL dashboard processes racing concurrent logins never lose a session', { timeout: 60000 }, async () => {
  const inst = makeSharedInstance();
  const password = 'correct horse battery staple';
  const passwordHash = await hashPassword(password);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u1', username: 'alice', role: 'admin', projects: '*', passwordHash },
  ] }));
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([]));

  const s1 = spawnServerOn(inst, 3950);
  const s2 = spawnServerOn(inst, 3951);
  try {
    await Promise.all([waitUp(s1), waitUp(s2)]);

    const login = (base) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password }),
    }).then((r) => r.json());

    const COUNT = 16;
    const results = await Promise.all(Array.from({ length: COUNT }, (_, i) => login(i % 2 === 0 ? s1.base : s2.base)));
    assert.ok(results.every((r) => r.ok === true), `every login must succeed: ${JSON.stringify(results)}`);

    const sessions = readSessionsRaw(inst.sessionsPath);
    assert.equal(sessions.length, COUNT, `every successful login must persist its own session across both processes — got ${sessions.length} of ${COUNT}`);
    assert.equal(new Set(sessions.map((s) => s.id)).size, COUNT, 'every session id must be unique — no overwritten/duplicated entries');
  } finally {
    await killAll([s1.child, s2.child]);
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
});

function sessionIdFromSetCookie(setCookieHeader) {
  const m = /pw_session=([^;]+)/.exec(setCookieHeader || '');
  return m ? m[1] : null;
}

test('REGRESSION: concurrent logout across two REAL dashboard processes revokes exactly the intended sessions — no resurrection, no collateral loss', { timeout: 60000 }, async () => {
  const inst = makeSharedInstance();
  const password = 'correct horse battery staple';
  const passwordHash = await hashPassword(password);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u1', username: 'alice', role: 'admin', projects: '*', passwordHash },
  ] }));
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([]));

  const s1 = spawnServerOn(inst, 3952);
  const s2 = spawnServerOn(inst, 3953);
  try {
    await Promise.all([waitUp(s1), waitUp(s2)]);
    const login = (base) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password }),
    }).then(async (r) => ({ ok: (await r.json()).ok, cookie: sessionIdFromSetCookie(r.headers.get('set-cookie')) }));

    // 8 pre-existing sessions, half on each server.
    const PRE = 8;
    const pre = await Promise.all(Array.from({ length: PRE }, (_, i) => login(i % 2 === 0 ? s1.base : s2.base)));
    assert.ok(pre.every((r) => r.ok && r.cookie));
    const toRevoke = pre.slice(0, PRE / 2).map((r) => r.cookie); // revoke half
    const toKeep = pre.slice(PRE / 2).map((r) => r.cookie); // the other half must survive untouched

    const logout = (base, cookie) => fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { Cookie: `pw_session=${cookie}` },
    }).then((r) => r.json());

    // Revoke the first half concurrently, alternating servers, WHILE also
    // creating brand-new sessions concurrently on both — a realistic mixed
    // create+revoke race, not just one or the other in isolation.
    const NEW = 6;
    const [logoutResults, newLogins] = await Promise.all([
      Promise.all(toRevoke.map((c, i) => logout(i % 2 === 0 ? s1.base : s2.base, c))),
      Promise.all(Array.from({ length: NEW }, (_, i) => login(i % 2 === 0 ? s2.base : s1.base))),
    ]);
    assert.ok(logoutResults.every((r) => r.ok === true), JSON.stringify(logoutResults));
    assert.ok(newLogins.every((r) => r.ok === true), JSON.stringify(newLogins));

    const finalIds = new Set(readSessionsRaw(inst.sessionsPath).map((s) => s.id));
    assert.equal(finalIds.size, toKeep.length + NEW, `expected exactly the kept + new sessions, got ${finalIds.size}`);
    for (const c of toRevoke) assert.equal(finalIds.has(c), false, `revoked session ${c} must not be resurrected`);
    for (const c of toKeep) assert.equal(finalIds.has(c), true, `untouched session ${c} must survive the concurrent revoke/create race`);
    for (const r of newLogins) assert.equal(finalIds.has(r.cookie), true, `newly created session ${r.cookie} must survive`);
  } finally {
    await killAll([s1.child, s2.child]);
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
});

test('REGRESSION: a naturally expired session is reaped without disturbing sessions concurrently created on another REAL process', { timeout: 60000 }, async () => {
  const inst = makeSharedInstance();
  // 1ms TTL — any session is "expired" the instant a subsequent request looks it up.
  inst.env.PW_SESSION_HOURS = String(1 / 3600000);
  const password = 'correct horse battery staple';
  const passwordHash = await hashPassword(password);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u1', username: 'alice', role: 'admin', projects: '*', passwordHash },
  ] }));
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([]));

  const s1 = spawnServerOn(inst, 3954);
  const s2 = spawnServerOn(inst, 3955);
  try {
    await Promise.all([waitUp(s1), waitUp(s2)]);
    const login = (base) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password }),
    }).then(async (r) => ({ ok: (await r.json()).ok, cookie: sessionIdFromSetCookie(r.headers.get('set-cookie')) }));

    const stale = await login(s1.base);
    assert.ok(stale.ok && stale.cookie);
    await new Promise((r) => setTimeout(r, 50)); // let the 1ms TTL lapse for real

    // s2 triggers the expiry-driven revoke (any authenticated request does,
    // via attachUser -> lookupSession) WHILE s1 concurrently creates fresh
    // sessions — the expiring revoke and the fresh creates must not collide.
    const NEW = 6;
    const [meResult, newLogins] = await Promise.all([
      fetch(`${s2.base}/api/auth/me`, { headers: { Cookie: `pw_session=${stale.cookie}` } }).then((r) => r.json()),
      Promise.all(Array.from({ length: NEW }, () => login(s1.base))),
    ]);
    assert.equal(meResult.authenticated, false, 'the expired session must no longer authenticate');
    assert.ok(newLogins.every((r) => r.ok === true), JSON.stringify(newLogins));

    const finalIds = new Set(readSessionsRaw(inst.sessionsPath).map((s) => s.id));
    assert.equal(finalIds.has(stale.cookie), false, 'the expired session must have been reaped');
    assert.equal(finalIds.size, NEW, `expired session gone, all ${NEW} fresh ones survive — got ${finalIds.size}`);
  } finally {
    await killAll([s1.child, s2.child]);
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
});

test('REGRESSION: DELETE /api/users purging a deleted user\'s sessions does not race a concurrent login for a DIFFERENT user', { timeout: 60000 }, async () => {
  const inst = makeSharedInstance();
  const password = 'correct horse battery staple';
  const passwordHash = await hashPassword(password);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u-admin', username: 'admin', role: 'admin', projects: '*', passwordHash },
    { id: 'u-victim', username: 'victim', role: 'developer', projects: '*', passwordHash },
  ] }));
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([]));

  const s1 = spawnServerOn(inst, 3956);
  const s2 = spawnServerOn(inst, 3957);
  try {
    await Promise.all([waitUp(s1), waitUp(s2)]);
    const login = (base, username) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(async (r) => ({ ok: (await r.json()).ok, cookie: sessionIdFromSetCookie(r.headers.get('set-cookie')) }));

    const adminLogin = await login(s1.base, 'admin');
    const victimLogin = await login(s1.base, 'victim');
    assert.ok(adminLogin.ok && victimLogin.ok);

    const deleteVictim = () => fetch(`${s1.base}/api/users/victim`, {
      method: 'DELETE', headers: { Cookie: `pw_session=${adminLogin.cookie}` },
    }).then((r) => r.json());

    const NEW = 16;
    const [delResult, newLogins] = await Promise.all([
      deleteVictim(),
      Promise.all(Array.from({ length: NEW }, (_, i) => login(i % 2 === 0 ? s2.base : s1.base, 'admin'))),
    ]);
    assert.equal(delResult.ok, true, JSON.stringify(delResult));
    assert.ok(newLogins.every((r) => r.ok === true), JSON.stringify(newLogins));

    const finalIds = new Set(readSessionsRaw(inst.sessionsPath).map((s) => s.id));
    assert.equal(finalIds.has(victimLogin.cookie), false, 'the deleted user\'s session must be purged');
    assert.equal(finalIds.has(adminLogin.cookie), true, 'the admin\'s OWN pre-existing session (used to authorize the delete) must survive');
    for (const r of newLogins) assert.equal(finalIds.has(r.cookie), true, `new admin session ${r.cookie} concurrent with the delete must survive`);
    assert.equal(finalIds.size, 1 + NEW, `expected admin's original session + ${NEW} new ones, got ${finalIds.size}`);
  } finally {
    await killAll([s1.child, s2.child]);
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
});
