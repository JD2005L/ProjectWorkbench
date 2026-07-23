// Boots real isolated instances of app/server.js on non-production ports with
// throwaway registry/users/session/workspace paths. Never touches the live
// /opt/project-workbench/app or host nginx/tmux (PW_ISOLATED + temp paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

function makeInstance(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
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
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
    PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
    ...extraEnv,
  };
  return { dir, env };
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
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

test('smoke: isolated instance — health 200, enforced root 302 -> login, login 200', { timeout: 30000 }, async () => {
  const port = 3877;
  const inst = makeInstance(port, { PW_AUTH_ENFORCE: 'true' });
  await withServer(inst, port, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.match(root.headers.get('location') || '', /^\/login\?next=/);

    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Sign in/i);
  });
});

test('smoke: /workbench base path — cockpit renders iframe URL, clipboard allow, refit code, scoped deploy CSS', { timeout: 30000 }, async () => {
  const port = 3878;
  const inst = makeInstance(port, {
    PW_BASE_PATH: '/workbench',
    PW_DEPLOY_CENTRE: 'true', // deploy-configured project: worst case for CSS leakage
  });
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([
    { name: 'demo', path: path.join(inst.dir, 'workspaces', 'demo'), port: 7801 },
  ], null, 2));
  fs.mkdirSync(path.join(inst.dir, 'workspaces', 'demo'), { recursive: true });
  fs.writeFileSync(inst.env.PW_DEPLOY_CONFIG, JSON.stringify({ demo: { dev: { script: 'true' } } }));

  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/workbench/term/demo/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('src="/workbench/pty/demo/"'), 'terminal iframe must carry the base-path pty URL');
    assert.match(html, /<iframe id="term" allow="clipboard-write; clipboard-read"/, 'clipboard allow attribute missing');
    assert.ok(html.includes('pwRefitTerm'), 'terminal refit code missing');
    // Deploy CSS must be present (project is deploy-configured) but fully scoped.
    assert.ok(html.includes('#deployBackdrop'), 'deploy modal styling missing');
    for (const leak of ['\n.button{', '\n.badge{', '\n.version{', '\n.muted{', '\na{color']) {
      assert.ok(!html.includes(leak), `unscoped deployment selector leaked into cockpit: ${leak.trim()}`);
    }
  });
});
