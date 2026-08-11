// Round 5 audit finding: withProjectsLock (app/server.js) was an IN-PROCESS-
// ONLY promise chain guarding projects.json's read-modify-write — the exact
// same architectural defect item 4 fixed for sessions.json (and round 3
// fixed for users.json via app/lifecycle-lock.js). Two real dashboard
// processes each doing loadProjects() -> mutate -> saveProjects() with only
// in-process serialization can silently lose one process's write, since
// there is no coordination across the process boundary at all.
//
// Fixed by routing withProjectsLock through the SAME cross-process
// withLifecycleLock, under its own lock file — the call signature is
// unchanged (every call site already does its own load/mutate/save inside
// the callback), so only the underlying serialization mechanism changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedTmuxFixture } from './tmux-owner-fixture.mjs';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

function makeSharedInstance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-projlock-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  fs.writeFileSync(secretKeyPath, crypto.randomBytes(32).toString('hex') + '\n');
  const registryPath = path.join(dir, 'registry', 'projects.json');
  fs.writeFileSync(registryPath, '[]');
  // Private, owner-marked tmux socket — see the note in test/tmux-owner-fixture.mjs.
  const tmuxSocket = `pwpl-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const owned = ownedTmuxFixture({ socket: tmuxSocket, dir, env: { PW_DEPLOY_MODE: 'container' } });
  return {
    dir,
    registryPath,
    env: {
      ...owned,
      PW_TMUX_SOCKET: tmuxSocket,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      PW_ISOLATED: '1',
      PW_DEPLOY_MODE: 'container',
      PW_REGISTRY_PATH: registryPath,
      PW_USERS_PATH: path.join(dir, 'users', 'users.json'),
      PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
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
  // PW_ISOLATED auto-derives a tmux socket ('pwprev-' + each server's own
  // pid) the instant a route touches tmux (e.g. /manage/add's startProject);
  // nothing else ever cleaned those servers up, so they leaked indefinitely
  // across every run — a real contributor to "fork failed: No space left on
  // device" under load. Harmless no-op for a run that never touched tmux.
  await Promise.all(pids.map((pid) => new Promise((resolve) => {
    const tk = spawn('tmux', ['-L', `pwprev-${pid}`, 'kill-server']);
    tk.on('exit', resolve);
    tk.on('error', resolve);
  })));
}

test('REGRESSION: two REAL dashboard processes creating DIFFERENT projects concurrently never lose one to a cross-process last-write-wins race', { timeout: 60000 }, async () => {
  const inst = makeSharedInstance();
  const s1 = spawnServerOn(inst, 3960);
  const s2 = spawnServerOn(inst, 3961);
  try {
    await Promise.all([waitUp(s1), waitUp(s2)]);

    const addProject = (base, name, port) => fetch(`${base}/manage/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ name, port: String(port) }),
    }).then((r) => r.json());

    const COUNT = 12;
    const names = Array.from({ length: COUNT }, (_, i) => `proj${i}`);
    const results = await Promise.all(names.map((name, i) => addProject(i % 2 === 0 ? s1.base : s2.base, name, 8000 + i)));
    assert.ok(results.every((r) => r.ok === true), `every project creation must succeed: ${JSON.stringify(results)}`);

    const onDisk = JSON.parse(fs.readFileSync(inst.registryPath, 'utf8'));
    const onDiskNames = new Set(onDisk.map((p) => p.name));
    assert.equal(onDisk.length, COUNT, `every concurrently created project must survive across both processes — got ${onDisk.length} of ${COUNT}`);
    for (const name of names) assert.ok(onDiskNames.has(name), `project "${name}" must be present in projects.json`);
  } finally {
    await killAll([s1.child, s2.child]);
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
});
