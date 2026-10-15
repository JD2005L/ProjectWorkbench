// The dashboard half of "the agent asks, an admin approves" promotes, on real isolated instances.
//
// The property under test is that the agent cannot approve. The agent can reach the app on
// 127.0.0.1:3000 directly and send any headers it likes, so approve (and reject) must refuse:
//   * any on-box (trusted-local) caller, cookie or not;
//   * the soft-mode implicit admin;
//   * an identity from PW_AUTH_HEADER with no server-issued session;
//   * a signed-in user who is not an administrator;
//   * a signed-in administrator who does not re-enter the right password — the defence against
//     script running in a page on this origin with the admin's cookie;
// and must accept a signed-in administrator, through nginx, with their password, for the exact
// digest of an awaiting dry run that is under a day old. Asking and reading stay open to the
// on-box caller. A request "through nginx" here carries X-Forwarded-For and a same-host
// Origin, exactly what nginx and a browser send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const scryptAsync = promisify(crypto.scrypt);
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

const PASS = 'Sup3rSecret!23';
// The OS picks the port: test files run in parallel, and fixed ranges collide.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
async function withInstance(extraEnv, fn, { spool = true } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-promote-approval-'));
  fs.mkdirSync(path.join(dir, 'workspaces'));
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  const spoolDir = path.join(dir, 'promote');
  if (spool) for (const d of ['', 'requests', 'queue']) fs.mkdirSync(path.join(spoolDir, d), { recursive: true, mode: 0o700 });
  const hash = await hashPassword(PASS);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { id: 'u-boss', username: 'boss', role: 'admin', projects: '*', passwordHash: hash },
    { id: 'u-dev', username: 'dev', role: 'developer', projects: '*', passwordHash: hash },
  ] }));
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
  const audit = path.join(dir, 'audit.log');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PORT: String(port), PW_ISOLATED: '1',
    PW_AUTH_ENFORCE: 'true', PW_REGISTRY_PATH: path.join(dir, 'projects.json'), PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'), PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'), PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'),
    PW_AUDIT_LOG: audit, PW_PROMOTE_SPOOL: spoolDir, PW_API_TOKENS_PATH: path.join(dir, 'api-tokens.json'),
    ...extraEnv,
  };
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: path.dirname(serverJs), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up\n${logs.join('')}`);
    await fn({ base, spool: spoolDir, audit, logs });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// On-box: straight to the app, as the agent's CLI does. Via nginx: forwarded and same-origin.
const viaNginx = (base) => ({ 'X-Forwarded-For': '10.1.2.3', Origin: base });
async function call(base, method, p, { body, cookie, nginx = false, headers = {} } = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(nginx ? viaNginx(base) : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function login(base, username) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
}
// Stand in for the host runner finishing a dry run.
function dryRunDone(spool, id, { digest = 'd'.repeat(64), ageMs = 0 } = {}) {
  fs.writeFileSync(path.join(spool, 'requests', id, 'status.json'), JSON.stringify({
    id, state: 'dry-run-ok', digest, files: 3, bytes: 10, head: { ref: 'refs/heads/main', commit: 'a'.repeat(40) },
    finishedAt: new Date(Date.now() - ageMs).toISOString(),
  }));
  return digest;
}
const approvePath = (id) => `/api/promote/requests/${id}/approve`;

test('the agent can ask and read, but nothing short of a signed-in administrator with their password can approve', { timeout: 60000 }, async () => {
  await withInstance({}, async ({ base, spool, audit }) => {
    // Asking, on-box, without signing in: allowed, and queues a dry run.
    const asked = await call(base, 'POST', '/api/promote/requests', { body: { note: 'ship the rail work' } });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const id = asked.body.request.id;
    assert.equal(asked.body.request.requestedBy, 'on-box agent');
    assert.equal(asked.body.request.state, 'queued');
    assert.ok(fs.existsSync(path.join(spool, 'queue', `${id}.dryrun`)), 'a dry run is queued for the host runner');
    const listed = await call(base, 'GET', '/api/promote/requests');
    assert.equal(listed.body.installed, true);
    assert.equal(listed.body.requests[0].id, id, 'and the on-box caller can read it');

    const digest = dryRunDone(spool, id);
    assert.equal((await call(base, 'GET', `/api/promote/requests/${id}`)).body.request.state, 'awaiting-approval');
    const admin = await login(base, 'boss');
    const dev = await login(base, 'dev');

    const refusals = [
      ['on-box, no session', { body: { password: PASS, digest } }, 403, 'promote_approval_local'],
      ['on-box WITH an admin session', { cookie: admin, body: { password: PASS, digest } }, 403, 'promote_approval_local'],
      ['via nginx, no session', { nginx: true, body: { password: PASS, digest } }, 403, 'promote_approval_requires_admin'],
      ['a signed-in non-admin', { nginx: true, cookie: dev, body: { password: PASS, digest } }, 403, 'promote_approval_requires_admin'],
      ['an admin session without the password', { nginx: true, cookie: admin, body: { digest } }, 403, 'promote_password'],
      ['an admin session with a wrong password', { nginx: true, cookie: admin, body: { password: 'nope', digest } }, 403, 'promote_password'],
      ['the right password but a different digest', { nginx: true, cookie: admin, body: { password: PASS, digest: 'e'.repeat(64) } }, 409, 'promote_digest_mismatch'],
    ];
    for (const [label, opts, status, code] of refusals) {
      const r = await call(base, 'POST', approvePath(id), opts);
      assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, label);
      assert.equal(fs.existsSync(path.join(spool, 'requests', id, 'approval.json')), false, `${label}: nothing was approved`);
      assert.equal(fs.existsSync(path.join(spool, 'queue', `${id}.promote`)), false, `${label}: nothing was queued`);
    }

    const ok = await call(base, 'POST', approvePath(id), { nginx: true, cookie: admin, body: { password: PASS, digest } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.request.state, 'approved');
    const approval = JSON.parse(fs.readFileSync(path.join(spool, 'requests', id, 'approval.json'), 'utf8'));
    assert.equal(approval.approvedBy, 'boss');
    assert.equal(approval.digest, digest, 'the approval names the digest that was reviewed');
    const ttl = Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt);
    assert.equal(ttl, 24 * 3600 * 1000, 'and expires in a day');
    assert.ok(fs.existsSync(path.join(spool, 'queue', `${id}.promote`)), 'the promote is queued for the runner');

    const again = await call(base, 'POST', '/api/promote/requests', { body: {} });
    assert.equal(again.status, 409, 'no new request while one is approved or promoting');
    assert.equal(again.body.code, 'promote_busy');

    const lines = fs.readFileSync(audit, 'utf8');
    assert.match(lines, /"event":"promote_request"/);
    assert.match(lines, /"event":"promote_approve_refused".*"reason":"password"/);
    assert.match(lines, /"event":"promote_approve".*"user":"boss"/);
  });
});

test('a new request supersedes an unapproved one; a stale dry run cannot be approved; reject needs the same signed-in admin', { timeout: 60000 }, async () => {
  await withInstance({}, async ({ base, spool, audit }) => {
    const a = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    dryRunDone(spool, a);
    const b = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    assert.notEqual(a, b);
    assert.equal((await call(base, 'GET', `/api/promote/requests/${a}`)).body.request.state, 'superseded');
    const admin = await login(base, 'boss');
    const late = await call(base, 'POST', approvePath(a), { nginx: true, cookie: admin, body: { password: PASS, digest: 'd'.repeat(64) } });
    assert.equal(late.status, 409, 'a superseded request cannot be approved');

    const digest = dryRunDone(spool, b, { ageMs: 25 * 3600 * 1000 });
    assert.equal((await call(base, 'GET', `/api/promote/requests/${b}`)).body.request.state, 'stale');
    const stale = await call(base, 'POST', approvePath(b), { nginx: true, cookie: admin, body: { password: PASS, digest } });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /more than a day old/);

    const c = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    dryRunDone(spool, c);
    const onBox = await call(base, 'POST', `/api/promote/requests/${c}/reject`, { body: { reason: 'agent says no' } });
    assert.equal(onBox.status, 403, 'the agent cannot reject either');
    const rej = await call(base, 'POST', `/api/promote/requests/${c}/reject`, { nginx: true, cookie: admin, body: { reason: 'not today' } });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(rej.body.request.state, 'rejected');
    const after = await call(base, 'POST', approvePath(c), { nginx: true, cookie: admin, body: { password: PASS, digest: 'd'.repeat(64) } });
    assert.equal(after.status, 409, 'a rejected request cannot be approved');
    assert.match(fs.readFileSync(audit, 'utf8'), /"event":"promote_reject".*"reason":"not today"/);
  });
});

test('repeated wrong passwords lock approval for that session', { timeout: 60000 }, async () => {
  await withInstance({}, async ({ base, spool }) => {
    const id = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    const digest = dryRunDone(spool, id);
    const admin = await login(base, 'boss');
    for (let i = 0; i < 5; i++) assert.equal((await call(base, 'POST', approvePath(id), { nginx: true, cookie: admin, body: { password: 'x', digest } })).status, 403);
    const locked = await call(base, 'POST', approvePath(id), { nginx: true, cookie: admin, body: { password: PASS, digest } });
    assert.equal(locked.status, 429, 'even the right password is refused once locked');
    assert.equal(fs.existsSync(path.join(spool, 'requests', id, 'approval.json')), false);
  });
});

test('a PW_AUTH_HEADER identity has no session and cannot approve, even claiming an admin', { timeout: 60000 }, async () => {
  await withInstance({ PW_AUTH_HEADER: 'x-remote-user' }, async ({ base, spool }) => {
    const id = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    const digest = dryRunDone(spool, id);
    const who = await call(base, 'GET', '/api/auth/me', { nginx: true, headers: { 'x-remote-user': 'boss' } });
    assert.equal(who.body.user?.username, 'boss', 'sanity: the header does authenticate as the admin');
    const r = await call(base, 'POST', approvePath(id), { nginx: true, headers: { 'x-remote-user': 'boss' }, body: { password: PASS, digest } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'promote_approval_requires_admin');
  });
});

test('the soft-mode implicit admin cannot approve', { timeout: 60000 }, async () => {
  await withInstance({ PW_AUTH_ENFORCE: 'false' }, async ({ base, spool }) => {
    const id = (await call(base, 'POST', '/api/promote/requests', { body: {} })).body.request.id;
    const digest = dryRunDone(spool, id);
    const r = await call(base, 'POST', approvePath(id), { nginx: true, body: { password: PASS, digest } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'promote_approval_requires_admin');
  });
});

test('without the host install, asking says so instead of pretending', { timeout: 60000 }, async () => {
  await withInstance({}, async ({ base }) => {
    const r = await call(base, 'POST', '/api/promote/requests', { body: {} });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'promote_not_installed');
    assert.equal((await call(base, 'GET', '/api/promote/requests')).body.installed, false);
  }, { spool: false });
});
