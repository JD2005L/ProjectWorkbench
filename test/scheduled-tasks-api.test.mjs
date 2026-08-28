// The scheduled-task routes, against a real instance.
//
// Runs isolated on purpose: PW_ISOLATED disarms the ticker, so the API can be
// exercised without any risk of a task firing into a real project mid-test. The
// scheduling arithmetic itself is covered by test/scheduled-tasks.test.mjs, which
// needs no server at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
// Mirrors app/server.js's hashPassword(), same as test/deploy-route.test.mjs does,
// so an admin can be seeded without going through the HTTP API first.
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);
const PASSWORD = 'Sup3rSecret!23';

function makeInstance(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tasks-'));
  fs.mkdirSync(path.join(dir, 'workspaces', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspaces', 'beta'), { recursive: true });
  // Seeded, as test/deploy-route.test.mjs does: session signing needs it, and
  // without it the login handler answers with an HTML error page rather than JSON.
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  // enabledClis is empty on purpose: the agent picker must then be empty whatever
  // is installed on this machine, which makes the assertion about the gate rather
  // than about the test host.
  fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({ enabledClis: [], updateClis: [] }, null, 2));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port), PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_SCHEDULED_TASKS: path.join(dir, 'scheduled-tasks.json'),
    PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'),
    PW_TIMEZONE: 'America/Edmonton',
  };
  fs.writeFileSync(env.PW_REGISTRY_PATH, JSON.stringify([
    { name: 'alpha', path: path.join(dir, 'workspaces', 'alpha'), port: 7841 },
    { name: 'beta', path: path.join(dir, 'workspaces', 'beta'), port: 7842 },
  ], null, 2));
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
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not start on :${port}\n${logs.join('')}`);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: PASSWORD }),
    });
    assert.equal((await login.json()).ok, true, 'sanity: login must succeed');
    await fn(base, login.headers.get('set-cookie').split(';')[0], logs);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve); tk.on('error', resolve);
    });
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

async function seedAdmin(inst) {
  const passwordHash = await hashPassword(PASSWORD);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u-boss', username: 'boss', role: 'admin', projects: '*', passwordHash },
  ] }, null, 2));
}

const validTask = {
  id: 'eod-commit', name: 'End of day', window: 'eod',
  schedule: { kind: 'daily', at: '17:00', weekdaysOnly: true },
  command: 'echo hello', target: 'all',
};

test('tasks round-trip through the API and are listed with a display time', { timeout: 30000 }, async () => {
  const port = 3931;
  const inst = makeInstance(port);
  await seedAdmin(inst);
  await withServer(inst, port, async (base, cookie) => {
    const post = async (body) => (await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    }));
    const list = async () => (await (await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie } })).json());

    let j = await (await list());
    assert.equal(j.ok, true);
    assert.deepEqual(j.tasks, [], 'starts empty');
    assert.deepEqual(j.projects, ['alpha', 'beta'], 'offers the live registry to pick from');
    assert.match(j.gitTemplate, /@\{upstream\}/, 'ships the guarded git template for the UI to offer');

    // The picker is served from the same module that validates, so the two cannot
    // disagree about which zones exist, and every entry must actually resolve.
    assert.ok(Array.isArray(j.timeZones) && j.timeZones.length > 5, 'ships a timezone list for the picker');
    assert.ok(j.timeZones.some((z) => z.id === 'America/Edmonton'), 'includes Mountain');
    for (const z of j.timeZones) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-CA', { timeZone: z.id }), `unresolvable zone offered: ${z.id}`);
      assert.ok(z.label && z.label !== z.id, `zone ${z.id} needs a human label`);
    }
    assert.equal(j.timeZone, 'America/Edmonton', 'and the dashboard zone, which the form preselects');

    // Only agents that could actually run are offered. This instance enables none
    // in its settings file, so the picker must be empty rather than listing three
    // CLIs that would fail at 17:00 unattended.
    assert.ok(Array.isArray(j.agents), 'ships the agent list');
    assert.deepEqual(j.agents, [], 'nothing enabled in settings means nothing offered, however much is installed');

    assert.equal((await (await post(validTask)).json()).ok, true);
    j = await list();
    assert.equal(j.tasks.length, 1);
    assert.equal(j.tasks[0].id, 'eod-commit');
    assert.equal(j.tasks[0].schedule.weekdaysOnly, true);
    assert.equal(j.tasks[0].timeZone, 'America/Edmonton', 'inherits the dashboard timezone when none is given');
    assert.equal(j.tasks[0].lastRunDisplay, 'never', 'a task that has not run says so');

    // A definition naming a currently-unusable agent stays loadable — dropping it
    // would remove a scheduled job the operator believes exists — but is flagged.
    assert.equal((await (await post({ ...validTask, id: 'agent-task', prompt: 'do it', agent: 'claude' })).json()).ok, true);
    const withAgent = (await list()).tasks.find((t) => t.id === 'agent-task');
    assert.equal(withAgent.agent, 'claude', 'the definition is preserved');
    assert.equal(withAgent.agentUnavailable, true, 'and flagged as not runnable right now');
    assert.match(withAgent.effectiveCommand, /claude -p 'do it'/, 'the composed command is still shown');
    await fetch(`${base}/api/tasks/agent-task`, { method: 'DELETE', headers: { Cookie: cookie } });

    // Editing by the same id replaces rather than duplicating.
    assert.equal((await (await post({ ...validTask, name: 'Renamed' })).json()).ok, true);
    j = await list();
    assert.equal(j.tasks.length, 1, 'same id must edit, not append');
    assert.equal(j.tasks[0].name, 'Renamed');

    // It is on disk, in the file the operator can also edit by hand.
    const onDisk = JSON.parse(fs.readFileSync(inst.env.PW_SCHEDULED_TASKS, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].name, 'Renamed');

    const del = await fetch(`${base}/api/tasks/eod-commit`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal((await del.json()).ok, true);
    assert.deepEqual((await list()).tasks, []);
    assert.equal((await fetch(`${base}/api/tasks/eod-commit`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 404);
  });
});

test('a bad definition is refused with a reason, and run bookkeeping cannot be submitted', { timeout: 30000 }, async () => {
  const port = 3932;
  const inst = makeInstance(port);
  await seedAdmin(inst);
  await withServer(inst, port, async (base, cookie) => {
    const post = async (body) => (await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    }));

    const bad = await post({ ...validTask, schedule: { kind: 'daily', at: '25:00' } });
    assert.equal(bad.status, 400, 'an impossible time is rejected at the boundary');
    assert.match((await bad.json()).error, /HH:MM/, 'and says what was wrong');

    // A submitted lastRun would let a caller suppress the next run, or fake a
    // missed one into firing immediately.
    assert.equal((await (await post({ ...validTask, lastRun: '2099-01-01T00:00:00Z', lastStatus: 'ok' })).json()).ok, true);
    const j = await (await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie } })).json();
    assert.equal(j.tasks[0].lastRun, null, 'a submitted lastRun must be discarded');
    assert.equal(j.tasks[0].lastStatus, null);
  });
});

test('the task routes require admin, and the Settings page exposes the tab', { timeout: 30000 }, async () => {
  const port = 3933;
  const inst = makeInstance(port);
  const passwordHash = await hashPassword(PASSWORD);
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users: [
    { id: 'u-boss', username: 'boss', role: 'admin', projects: '*', passwordHash },
    { id: 'u-dev', username: 'dev', role: 'developer', projects: '*', passwordHash },
  ] }, null, 2));
  await withServer(inst, port, async (base, adminCookie) => {
    const devLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dev', password: PASSWORD }),
    });
    const devCookie = devLogin.headers.get('set-cookie').split(';')[0];

    // A developer can use terminals; scheduling work into every project is not
    // the same authority.
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { Cookie: devCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: devCookie }, body: JSON.stringify(validTask),
    })).status, 403);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { Cookie: adminCookie } })).status, 200);

    const settings = await (await fetch(`${base}/settings`, { headers: { Cookie: adminCookie } })).text();
    assert.match(settings, /data-tab="tasks"/, 'the tab is reachable from Settings');
    assert.match(settings, /id="tab-tasks"/, 'and its section is rendered');
  });
});
