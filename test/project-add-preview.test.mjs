// Registering a project WITH a preview, refusals half: every bad preview is refused with a 400
// before anything is cloned or written, on both mounts of the shared add handler -- the admin form
// (/manage/add) and the machine API (POST /api/projects, projects:register token).
//
// Booted without tmux, like test/api-tokens-surface.test.mjs: a refusal never reaches the
// terminal, so these stay runnable where the code is written. The success half (a preview stored,
// routed by nginx, reported back) needs a real terminal and lives in
// test/api-tokens-register.test.mjs. The rules themselves are pinned in test/preview-config.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// One project already registered: terminal SEED_PORT, preview SEED_PREVIEW.
const SEED_PORT = 7681;
const SEED_PREVIEW = 7790;

async function withDashboard(fn) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-add-preview-'));
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_API_TOKENS_PATH: path.join(dir, 'api-tokens.json'),
    PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'),
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
  };
  const logs = [];
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    // Seeded after boot, so nothing tries to start a terminal for it; the registry is re-read per request.
    fs.writeFileSync(env.PW_REGISTRY_PATH, JSON.stringify([
      { name: 'seed', path: path.join(dir, 'workspaces', 'seed'), port: SEED_PORT, preview: { cmd: 'npm run dev', port: SEED_PREVIEW } },
    ], null, 2) + '\n');
    await fn({ base, dir, logs });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const REFUSALS = [
  // [label, extra fields, expected error]
  ['collides with another project\'s preview port', { previewCmd: 'npm run dev', previewPort: String(SEED_PREVIEW) },
    `Preview port ${SEED_PREVIEW} is already in use by another project`],
  ['collides with another project\'s terminal port', { previewCmd: 'npm run dev', previewPort: String(SEED_PORT) },
    `Preview port ${SEED_PORT} is already in use by another project`],
  ['equals the new project\'s own terminal port', { previewCmd: 'npm run dev', previewPort: '__TERMINAL__' },
    'Preview port cannot match this project\'s terminal port'],
  ['is out of range', { previewCmd: 'npm run dev', previewPort: '80' },
    'Preview port must be between 1024 and 65535'],
  ['sets a reserved env key', { previewCmd: 'npm run dev', previewEnv: 'NODE_ENV=development\nPORT=3000' },
    'PORT is reserved and cannot be set via preview env'],
  ['sets an invalid env name', { previewCmd: 'npm run dev', previewEnv: 'BAD-NAME=1' },
    'Invalid env var name: BAD-NAME'],
];

async function assertRefusals({ base, dir }, post) {
  for (const [label, extra, error] of REFUSALS) {
    const name = 'pv' + crypto.randomBytes(3).toString('hex');
    const port = String(24000 + crypto.randomInt(0, 6000));
    const fields = { name, port, ...extra };
    if (fields.previewPort === '__TERMINAL__') fields.previewPort = port;
    const res = await post(fields);
    const text = await res.text();
    assert.equal(res.status, 400, `${label}: must be refused: ${text}`);
    assert.deepEqual(JSON.parse(text), { ok: false, error }, `${label}: the error must say why`);
    // Refused BEFORE the clone: nothing on disk, nothing in the registry.
    assert.ok(!fs.existsSync(path.join(dir, 'workspaces', name)), `${label}: no workspace may be created`);
    const registry = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'));
    assert.deepEqual(registry.map((p) => p.name), ['seed'], `${label}: the registry must be untouched`);
  }
}

test('the admin form refuses a bad preview before cloning anything', { timeout: 60000 }, async () => {
  await withDashboard(async (ctx) => {
    await assertRefusals(ctx, (fields) => fetch(`${ctx.base}/manage/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields),
    }));
  });
});

test('the machine API refuses a bad preview before cloning anything', { timeout: 60000 }, async () => {
  await withDashboard(async (ctx) => {
    const created = await fetch(`${ctx.base}/api/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'preview-refusals', scopes: ['projects:register'] }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, `token creation must succeed: ${JSON.stringify(created)}`);
    await assertRefusals(ctx, (fields) => fetch(`${ctx.base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${created.token}` },
      // A JSON client may well send the port as a number.
      body: JSON.stringify({ ...fields, previewPort: fields.previewPort ? Number(fields.previewPort) : undefined }),
    }));
  });
});
