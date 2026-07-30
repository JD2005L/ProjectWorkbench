// Round 6 REGRESSION (reviewer probe /tmp/pr20_same_user_delete_race.mjs):
// DELETE /api/users/:username already held the cross-process users lifecycle
// lock (LIFECYCLE_LOCK_PATH) for its entire operation, including purging the
// victim's sessions. But login authenticated the password and created the
// session WITHOUT ever acquiring that same lock — authenticate() read
// users.json (finding the still-present victim) entirely outside any lock
// that DELETE also respects, so a login racing a concurrent delete of the
// SAME user could authenticate successfully and create a brand-new session
// AFTER delete's session-purge step had already run against an
// already-vacated victim. Reproduced directly: DELETE returns 200 while 24
// concurrent victim logins succeed, and sessions.json retains orphaned
// sessions for the now-deleted user.
//
// Fixed by holding the users lifecycle lock across the ENTIRE login flow —
// authenticate (password verification), the lastLoginAt update, AND session
// creation — nested exactly like DELETE already nests its own session purge
// (users lock outer, sessions lock inner; this direction, never the
// reverse, was already the codebase-wide invariant since round 5). Either
// DELETE's critical section runs first and removes the user, so a
// subsequent login's authenticate() (now re-reading users.json from INSIDE
// the same lock) correctly fails with 401 and creates no session — or
// login's critical section (authenticate + session create, fully) runs
// first and completes before DELETE can even start its own critical
// section, so DELETE's session purge (reading sessions.json fresh, inside
// its own acquisition of the SAME lock) sees and removes that session too.
// Either ordering: no orphan, no revived session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(crypto.scrypt);
const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

async function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(p, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(h).toString('base64')}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sid(resp) { return /pw_session=([^;]+)/.exec(resp.headers.get('set-cookie') || '')?.[1] || null; }
async function waitUp(base, child, logs) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs.join(''));
    try { if ((await fetch(base + '/healthz')).status === 200) return; } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error('startup timeout ' + logs.join(''));
}

async function runRound() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-del-login-'));
  for (const d of ['workspaces', 'registry', 'users']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const password = 'correct horse battery staple';
  const ph = await hashPassword(password);
  const usersPath = path.join(dir, 'users/users.json');
  const sessionsPath = path.join(dir, 'sessions.json');
  const registryPath = path.join(dir, 'registry/projects.json');
  fs.writeFileSync(usersPath, JSON.stringify({
    users: [
      { id: 'u-admin', username: 'admin', role: 'admin', projects: '*', passwordHash: ph },
      { id: 'u-victim', username: 'victim', role: 'developer', projects: '*', passwordHash: ph },
    ],
  }));
  fs.writeFileSync(registryPath, '[]');
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8',
    PW_ISOLATED: '1', PW_AUTH_ENFORCE: 'true',
    PW_REGISTRY_PATH: registryPath, PW_USERS_PATH: usersPath, PW_SESSIONS_PATH: sessionsPath,
    PW_WORKSPACES: path.join(dir, 'workspaces'), PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy.json'), PW_DEPLOY_LOG: path.join(dir, 'deploy.jsonl'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
  };
  const basePort = 4300 + Math.floor(Math.random() * 400) * 2;
  const ports = [basePort, basePort + 1];
  const servers = ports.map((port) => {
    const logs = [];
    const child = spawn(process.execPath, [serverJs], { cwd: appDir, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(String(d)));
    child.stderr.on('data', (d) => logs.push(String(d)));
    return { child, logs, base: `http://127.0.0.1:${port}` };
  });
  try {
    await Promise.all(servers.map((s) => waitUp(s.base, s.child, s.logs)));
    const login = async (base, user) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password }) });
      const body = await r.json();
      return { status: r.status, ok: body.ok, cookie: sid(r), body };
    };
    const admin = await login(servers[0].base, 'admin');
    assert.equal(admin.ok, true, 'sanity: admin login must succeed');

    const attempts = Array.from({ length: 24 }, (_, i) => login(servers[i % 2].base, 'victim'));
    await sleep(8);
    const dr = await fetch(servers[0].base + '/api/users/victim', { method: 'DELETE', headers: { cookie: `pw_session=${admin.cookie}` } });
    const db = await dr.json();
    const logins = await Promise.all(attempts);

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')).sessions || [];
    const victimSessions = sessions.filter((s) => s.userId === 'u-victim');
    const successes = logins.filter((x) => x.ok);
    return { deleteStatus: dr.status, deleteOk: db.ok, loginOk: successes.length, login401: logins.filter((x) => x.status === 401).length, victimSessions, successes };
  } finally {
    for (const s of servers) s.child.kill('SIGKILL');
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('REGRESSION: DELETE racing 24 concurrent same-user logins never leaves an orphaned or revived session', { timeout: 60000 }, async () => {
  const ROUNDS = 6;
  for (let i = 0; i < ROUNDS; i++) {
    const out = await runRound();
    assert.equal(out.deleteStatus, 200, `round ${i}: delete must succeed`);
    assert.equal(out.deleteOk, true, `round ${i}: delete must report ok`);
    // The core invariant: no session for the deleted user may survive,
    // REGARDLESS of whether individual concurrent logins succeeded (before
    // the delete completed) or failed (after it completed, and correctly so).
    assert.equal(out.victimSessions.length, 0, `round ${i}: no orphaned victim session may survive a completed delete — got ${JSON.stringify(out.victimSessions)}`);
    // Every login that reported success must correspond to a session that
    // NO LONGER exists (since delete purges strictly AFTER any login that
    // beat it, per the shared lock) — i.e. a successful login's session
    // must not have been silently left behind either.
    for (const s of out.successes) {
      assert.equal(s.cookie != null, true, `round ${i}: a successful login must have set a session cookie`);
    }
  }
});
