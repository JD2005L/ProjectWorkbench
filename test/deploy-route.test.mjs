// Route-level regression lock-in for AC6: this remediation does not touch
// app/deploy-reauth.js or the deploy route, but it does touch server.js
// broadly (user-store wiring, CSRF-adjacent code paths), so these two
// properties are pinned down end-to-end rather than only at the unit level
// (test/deploy-reauth.test.mjs already covers resolveDeployReauth() in
// isolation):
//
//   1. CSRF: a mutating request that is NOT trusted-local and carries no
//      matching Origin/Referer is rejected before it reaches any route.
//   2. A saved, still-valid deploy password is reused without prompting —
//      the actual behavioural contract of app/deploy-reauth.js, exercised
//      through the real HTTP route and a real login session.
//
// Boots a real isolated instance like smoke.test.mjs. Port 3904, clear of
// every other suite's fixed ports (see test/user-lifecycle.test.mjs's header
// for the rest of the range in use).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);
const scryptAsync = promisify(crypto.scrypt);

function makeInstance(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deploy-route-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  fs.writeFileSync(secretKeyPath, crypto.randomBytes(32).toString('hex') + '\n');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_DEPLOY_CENTRE: 'true',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: secretKeyPath,
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
    PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
    ...extraEnv,
  };
  return { dir, env };
}

// Mirrors app/server.js's hashPassword()/encrypt() exactly so a test can seed
// an already-hashed password / already-encrypted deploy password without
// going through the HTTP API.
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}
function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
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
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    // PW_ISOLATED auto-derives a tmux socket ('pwprev-' + this server's own
    // pid) the instant a test exercises a tmux-touching route; nothing else
    // ever cleaned that server up, so it leaked indefinitely across every
    // run (hundreds of accumulated tmux servers found across prior rounds —
    // a real contributor to "fork failed: No space left on device" under
    // load). Harmless no-op for a test that never touches tmux at all.
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve);
      tk.on('error', resolve);
    });
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

test('REGRESSION: CSRF still blocks a mutating request with no matching Origin/Referer from a non-local caller', { timeout: 30000 }, async () => {
  const port = 3904;
  const inst = makeInstance(port);
  await withServer(inst, port, async (base) => {
    // X-Forwarded-For simulates arriving through nginx (as every real browser/LAN
    // request does), which is exactly what makes isTrustedLocal() false.
    const blocked = await fetch(`${base}/api/deploy/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.5' },
      body: JSON.stringify({ project: 'demo', target: 'dev', script: 'true' }),
    });
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /CSRF check failed/);

    const allowed = await fetch(`${base}/api/deploy/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.5', Origin: base },
      body: JSON.stringify({ project: 'demo', target: 'dev', script: 'true' }),
    });
    assert.notEqual(allowed.status, 403, 'a matching Origin must still be accepted');
  });
});

test('REGRESSION: a saved deploy password is reused without prompting, and never re-prompts on the happy path', { timeout: 30000 }, async () => {
  const port = 3905;
  const inst = makeInstance(port);
  const proj = path.join(inst.dir, 'workspaces', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name: 'demo', path: proj, port: 7820 }], null, 2));
  fs.writeFileSync(inst.env.PW_DEPLOY_CONFIG, JSON.stringify({ demo: { dev: { script: 'echo deployed-ok', reauth: true } } }));

  const password = 'Sup3rSecret!23';
  const passwordHash = await hashPassword(password);
  const secretKey = fs.readFileSync(inst.env.PW_SECRET_KEY_PATH, 'utf8').trim();
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u-boss', username: 'boss', role: 'admin', projects: '*', passwordHash, deployPassword: encryptToken(secretKey, password) },
  ] }, null, 2));

  await withServer(inst, port, async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password }),
    });
    assert.equal((await login.json()).ok, true, 'sanity: login must succeed');
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const deploy = await fetch(`${base}/api/deploy/demo/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}), // no password submitted — must fall back to the saved one
    });
    const body = await deploy.json();
    assert.notEqual(deploy.status, 401, `must not prompt when a valid saved password exists: ${JSON.stringify(body)}`);
    assert.equal(body.needPassword, undefined);
    assert.equal(body.ok, true);
    assert.match(body.output, /deployed-ok/);
  });
});
