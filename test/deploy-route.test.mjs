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
import { addIdentity, manifestDocument, writeJson } from './deploy-manifest-fixtures.mjs';

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
    const loginBody = await login.json();
    assert.equal(loginBody.ok, true, `sanity: login must succeed (HTTP ${login.status}: ${loginBody.error || ''})`);
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


// The badge used to be emitted only when true, so after a successful deploy the
// client rewrote the version text and left the badge behind — a card claiming the
// working copy was newer than a build that had just superseded it. It is now
// always rendered and hidden when it does not apply, so the client can correct it
// in place, and the deploy response carries the recomputed answer.
//
// withServer() removes the instance directory on teardown, so each case gets its
// own instance rather than reusing one across two server lifetimes.
// Both target cards render a badge, so an assertion has to be scoped to one of
// them: an unscoped regex matches prod's legitimately-hidden badge and reads as
// dev's being wrong.
function targetSection(html, target) {
  const seg = html.split('data-target="').find((part) => part.startsWith(`${target}"`));
  assert.ok(seg, `no ${target} target card in the rendered modal`);
  return seg;
}

async function withDeployCard(port, versionCmd, fn) {
  const inst = makeInstance(port);
  const proj = path.join(inst.dir, 'workspaces', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.txt'), 'x');   // gives getLocalVersion a today-stamp to read
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name: 'demo', path: proj, port: 7821 }], null, 2));
  fs.writeFileSync(inst.env.PW_DEPLOY_CONFIG, JSON.stringify({
    demo: { dev: { script: 'echo deployed-ok', versionCmd } },
  }));
  const password = 'Sup3rSecret!23';
  const passwordHash = await hashPassword(password);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u-boss', username: 'boss', role: 'admin', projects: '*', passwordHash },
  ] }, null, 2));
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password }),
    });
    const loginBody = await r.json();
    assert.equal(loginBody.ok, true, `sanity: login must succeed (HTTP ${r.status}: ${loginBody.error || ''})`);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const card = await (await fetch(`${base}/api/deploy/demo/card`, { headers: { Cookie: cookie } })).json();
    assert.equal(card.ok, true, `card must render: ${JSON.stringify(card).slice(0, 200)}`);
    await fn({ base, cookie, card });
  });
}

test('REGRESSION: the source-newer badge is always rendered so a deploy can clear it', { timeout: 30000 }, async () => {
  // Deployed build FAR in the future: the target is newer, so the badge must be
  // present-but-hidden rather than absent — the state the card got wrong before.
  await withDeployCard(3906, 'echo V1.99.0101.0000', async ({ base, cookie, card }) => {
    const dev = targetSection(card.html, 'dev');
    assert.match(dev, /class="src-newer-badge"/, 'badge must be in the DOM even when it does not apply');
    assert.match(dev, /class="src-newer-badge"[^>]*\shidden/, 'and must be hidden when the target is newer');

    // The deploy response has to carry the recomputed comparison, because that is
    // what the client toggles on.
    const dep = await (await fetch(`${base}/api/deploy/demo/dev`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
    })).json();
    assert.equal(dep.ok, true, `deploy must succeed: ${JSON.stringify(dep).slice(0, 200)}`);
    assert.equal(typeof dep.sourceNewer, 'boolean', 'response must state whether source is still newer');
    assert.equal(dep.sourceNewer, false, 'a future-dated build is not older than the working copy');
  });

  // The converse: an ancient deployed build IS older, so the badge shows.
  await withDeployCard(3907, 'echo V1.00.0101.0000', async ({ card }) => {
    const dev = targetSection(card.html, 'dev');
    assert.match(dev, /class="src-newer-badge"/, 'badge present');
    assert.doesNotMatch(dev, /class="src-newer-badge"[^>]*\shidden/, 'and visible when the source really is newer');
  });
});

test('managed deployment HTTP: data-only panels and fresh validated choices never use stale saved scripts', { timeout: 30000 }, async () => {
  // No login/session mutation is needed for the existing trusted-local test
  // operator. In particular, this scenario can run without Linux flock(1).
  const port = 3904;
  const inst = makeInstance(port);
  const proj = path.join(inst.dir, 'workspaces', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const document = manifestDocument();
  document.slots.prod = { label: 'Deploy MCP server', script: 'bash deploy/deploy-mcp.sh' };
  writeJson(proj, ['.pw', 'deploy.json'], document);
  addIdentity(proj, 'alpha', { published: '2.3.4' });
  addIdentity(proj, 'bravo');
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name: 'demo', path: proj, port: 7822 }]));
  fs.writeFileSync(inst.env.PW_DEPLOY_CONFIG, JSON.stringify({ demo: { dev: { script: 'echo obsolete-default', versionCmd: 'echo obsolete-version' } } }));
  const registryBefore = fs.readFileSync(inst.env.PW_REGISTRY_PATH, 'utf8');
  const configBefore = fs.readFileSync(inst.env.PW_DEPLOY_CONFIG, 'utf8');
  await withServer(inst, port, async base => {
    const page = await (await fetch(`${base}/deploy`)).text();
    const card = await (await fetch(`${base}/api/deploy/demo/card`)).json();
    assert.equal(card.ok, true, card.error);
    for (const html of [page, card.html]) {
      const dev = targetSection(html, 'dev');
      assert.match(dev, /name="identity" required><option value="">/);
      assert.match(dev, /name="bump" required><option value="">/);
      assert.match(dev, /Repository-managed/);
      assert.doesNotMatch(dev, /obsolete-default|obsolete-version|save-config|src-newer/);
      const prod = targetSection(html, 'prod');
      assert.match(prod, /Deploy MCP server/);
      assert.match(prod, /No input selections required/);
      assert.doesNotMatch(prod, /<select\b|<button[^>]*class="[^"]*deploy-btn"[^>]*\bdisabled/);
    }
    const version = await (await fetch(`${base}/api/deploy/demo/dev/version`)).json();
    assert.equal(version.managed, true);
    assert.equal(version.manifest.inputs[0].choices[0].version, '2.3.4');
    const status = await (await fetch(`${base}/api/deploy/status`)).json();
    assert.equal(status.projects[0].dev.managed, true);
    assert.equal(status.projects[0].prod.managed, true);
    assert.equal(status.projects[0].prod.configured, true);
    assert.deepEqual(status.projects[0].prod.manifest.inputs, []);
    assert.equal(status.projects[0].prod.manifest.version, null);
    assert.equal(fs.readFileSync(inst.env.PW_REGISTRY_PATH, 'utf8'), registryBefore);
    assert.equal(fs.readFileSync(inst.env.PW_DEPLOY_CONFIG, 'utf8'), configBefore, 'GET must not migrate or rewrite saved config');
    const good = { inputs: { identity: 'alpha', bump: 'patch' }, manifestRevision: version.manifest.revision };
    for (const body of [
      {}, { option: 'patch' }, { ...good, inputs: { bump: 'patch' } },
      { ...good, inputs: { identity: 'missing', bump: 'patch' } },
      { ...good, inputs: { identity: 'alpha', bump: 'draft' } },
      { ...good, inputs: { identity: 'alpha', bump: 'patch', extra: 'x' } },
      { ...good, script: 'override' },
    ]) {
      const result = await fetch(`${base}/api/deploy/demo/dev`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.ok([400, 409].includes(result.status));
      assert.equal((await result.json()).ok, false);
    }
    const save = await fetch(`${base}/api/deploy/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'demo', target: 'dev', script: 'overwritten' }),
    });
    assert.equal(save.status, 409);
    const prodInvalid = await fetch(`${base}/api/deploy/demo/prod`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { identity: 'alpha' }, manifestRevision: status.projects[0].prod.manifest.revision }),
    });
    assert.equal(prodInvalid.status, 400, 'script-only managed slots still reject undeclared input values');
    addIdentity(proj, 'future-style');
    const reopened = await (await fetch(`${base}/api/deploy/demo/card`)).json();
    assert.match(reopened.html, /<option value="future-style">/);
    const stale = await fetch(`${base}/api/deploy/demo/dev`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).staleManifest, true);
    fs.unlinkSync(path.join(proj, '.pw', 'deploy.json'));
    const removed = await fetch(`${base}/api/deploy/demo/dev`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good),
    });
    assert.equal(removed.status, 409, 'missing manifest must not run the old default-identity script');
    assert.equal(fs.existsSync(inst.env.PW_DEPLOY_LOG), false, 'no rejected request reaches execution/history');
    assert.equal(fs.readFileSync(inst.env.PW_DEPLOY_CONFIG, 'utf8'), configBefore);
  });
});
