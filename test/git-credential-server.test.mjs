// The dashboard end of the credential boundary.
//
// Boots real isolated instances of app/server.js (the smoke.test.mjs /
// user-lifecycle.test.mjs pattern) and asserts the REAL on-disk credential
// state a real HTTP request produces — plus the two structural properties that
// make the boundary meaningful:
//
//   * the dashboard process performs no filesystem or git operation on a
//     project repository at all (A31-4);
//   * credential work really enters the serialization domain, proved by a
//     second OS process holding the lock (A31-3).
//
// Synthetic token sentinels only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

const SENTINEL = 'ghp_SYNTHETIC_SERVER_SENTINEL_A1';
const SENTINEL_2 = 'ghp_SYNTHETIC_SERVER_SENTINEL_B2';
const ME = process.getuid();

function makeFakeTtydDir(dir) {
  const binDir = fs.mkdtempSync(path.join(dir, 'bin-shim-'));
  fs.writeFileSync(path.join(binDir, 'ttyd'), '#!/usr/bin/env bash\nexec sleep infinity\n', { mode: 0o755 });
  return binDir;
}

function makeInstance(port, extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-credsrv-')));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  const secretKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyPath, `${secretKey}\n`);
  const env = {
    PATH: `${makeFakeTtydDir(dir)}:${process.env.PATH}`,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'registry', 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users', 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: secretKeyPath,
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
    PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_HOST_TERMINAL_USER: os.userInfo().username,
    PW_CREDENTIAL_LOCK_PATH: path.join(dir, 'registry', '.pw-credential.lock'),
    PW_WORKSPACE_LOCK_PATH: path.join(dir, 'registry', '.pw-workspace.lock'),
    PW_PROJECTS_LOCK_PATH: path.join(dir, 'registry', '.pw-projects.lock'),
    PW_LIFECYCLE_LOCK_PATH: path.join(dir, 'users', '.pw-lifecycle.lock'),
    ...extraEnv,
  };
  return { dir, env, secretKey, workspaces: env.PW_WORKSPACES };
}

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

function writeUsers(inst, users) {
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users }, null, 2));
}
function writeProjects(inst, projects) {
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(projects, null, 2));
}

function seedRepo(inst, name) {
  const projectPath = path.join(inst.workspaces, name);
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  return projectPath;
}

function credState(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  const file = path.join(gitDir, '.pw-credentials');
  let helpers = [];
  try {
    helpers = execFileSync('git', ['config', '--file', path.join(gitDir, 'config'), '--get-all', 'credential.helper'], { encoding: 'utf8' })
      .split('\n').slice(0, -1);
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  const present = fs.existsSync(file);
  return {
    present,
    token: present ? (fs.readFileSync(file, 'utf8').match(/https:\/\/([^:]+):x-oauth-basic@github\.com/) || [])[1] ?? null : null,
    mode: present ? fs.lstatSync(file).mode & 0o777 : null,
    uid: present ? fs.lstatSync(file).uid : null,
    helpers,
  };
}

async function withServer(inst, port, fn) {
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: appDir, env: inst.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const exited = new Promise((r) => child.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n${logs.join('')}`);
    return await fn(base, logs);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

function form(base, url, body) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: new URL(base).host, accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
}

function patchUser(base, username, body) {
  return fetch(`${base}/api/users/${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Origin: new URL(base).host },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

// ---------------------------------------------------------------------------
// Structural: the dashboard must not touch a repository itself
// ---------------------------------------------------------------------------

test('app/server.js performs no filesystem or git write against a project repository', () => {
  const src = fs.readFileSync(serverJs, 'utf8');
  // The credential artifact name may only appear in a comment: every real use
  // now lives behind the privilege-dropped helper.
  for (const line of src.split('\n')) {
    const code = line.replace(/^\s+/, '');
    if (code.startsWith('//')) continue;
    assert.equal(code.includes('.pw-credentials'), false, `server.js still names the credential artifact in code: ${code.trim().slice(0, 120)}`);
    assert.equal(
      /execFileAsync\('git',\s*\[[^\]]*'config'/.test(code), false,
      `server.js still runs git config directly: ${code.trim().slice(0, 120)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// End-to-end credential state
// ---------------------------------------------------------------------------

test('assigning a project owner writes an owner-owned 0600 credential and the helper pair', { timeout: 40000 }, async () => {
  const port = 3960;
  const inst = makeInstance(port);
  const proj = seedRepo(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7901, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*' }]);

  await withServer(inst, port, async (base) => {
    const res = await patchUser(base, 'alice', { ghToken: SENTINEL });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = credState(proj);
    assert.equal(state.token, SENTINEL);
    assert.equal(state.mode, 0o600);
    assert.equal(state.uid, ME);
    assert.deepEqual(state.helpers, ['', `store --file=${path.join(proj, '.git', '.pw-credentials')}`]);
  });
});

test('rotating the owner token replaces the credential and keeps the helper pair', { timeout: 40000 }, async () => {
  const port = 3961;
  const inst = makeInstance(port);
  const proj = seedRepo(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7902, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, SENTINEL) }]);

  await withServer(inst, port, async (base) => {
    assert.equal((await patchUser(base, 'alice', { ghToken: SENTINEL_2 })).status, 200);
    const state = credState(proj);
    assert.equal(state.token, SENTINEL_2);
    assert.equal(state.mode, 0o600);
    assert.deepEqual(state.helpers, ['', `store --file=${path.join(proj, '.git', '.pw-credentials')}`]);
  });
});

test('removing the owner token revokes the credential AND the helper, confirmed', { timeout: 40000 }, async () => {
  const port = 3962;
  const inst = makeInstance(port);
  const proj = seedRepo(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7903, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, SENTINEL) }]);

  await withServer(inst, port, async (base) => {
    assert.equal((await patchUser(base, 'alice', { ghToken: SENTINEL })).status, 200);
    assert.equal(credState(proj).token, SENTINEL);

    assert.equal((await patchUser(base, 'alice', { ghToken: '' })).status, 200);
    const state = credState(proj);
    assert.equal(state.present, false, 'the credential must actually be gone');
    assert.deepEqual(state.helpers, [], 'the helper must actually be unset');
  });
});

test('a project with no repository yet is reported as skipped rather than failing the request', { timeout: 40000 }, async () => {
  const port = 3963;
  const inst = makeInstance(port);
  const proj = path.join(inst.workspaces, 'norepo');
  fs.mkdirSync(proj, { recursive: true });
  writeProjects(inst, [{ name: 'norepo', path: proj, port: 7904, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*' }]);

  await withServer(inst, port, async (base) => {
    const res = await patchUser(base, 'alice', { ghToken: SENTINEL });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fs.existsSync(path.join(proj, '.git')), false, 'nothing may be created where there is no repository');
  });
});

// ---------------------------------------------------------------------------
// A31-3 — the dashboard really enters the serialization domain
// ---------------------------------------------------------------------------

test('BARRIER: a credential request waits while another process holds the credential lock', { timeout: 40000 }, async () => {
  const port = 3964;
  const inst = makeInstance(port);
  const proj = seedRepo(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7905, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, SENTINEL) }]);

  await withServer(inst, port, async (base) => {
    // Seed a real credential first: the barrier is about whether the ROTATION
    // can start, so there has to be a prior state for it to fail to change.
    assert.equal((await patchUser(base, 'alice', { ghToken: SENTINEL })).status, 200);
    assert.equal(credState(proj).token, SENTINEL);

    const holdFile = path.join(inst.dir, 'held');
    const releaseFile = path.join(inst.dir, 'release');
    const holderJs = path.join(inst.dir, 'holder.mjs');
    fs.writeFileSync(holderJs, `
import fs from 'node:fs';
import { makeCredentialLockDomain } from '${appDir}/credential-domain-lock.js';
const domain = makeCredentialLockDomain({ lockPaths: ${JSON.stringify({
      lifecycle: inst.env.PW_LIFECYCLE_LOCK_PATH,
      workspace: inst.env.PW_WORKSPACE_LOCK_PATH,
      projects: inst.env.PW_PROJECTS_LOCK_PATH,
      credential: inst.env.PW_CREDENTIAL_LOCK_PATH,
    })}, timeoutMs: 20000 });
await domain.withLocks(['lifecycle'], async () => {
  fs.writeFileSync(${JSON.stringify(holdFile)}, 'held');
  while (!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise((r) => setTimeout(r, 10));
});
`);
    const holder = spawn(process.execPath, [holderJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    const holderErr = [];
    holder.stderr.on('data', (d) => holderErr.push(String(d)));
    const holderExited = new Promise((r) => holder.on('exit', r));

    const deadline = Date.now() + 8000;
    while (!fs.existsSync(holdFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(holdFile), `holder never took the lock: ${holderErr.join('')}`);

    let settled = false;
    // The catch keeps a rejection from becoming an unhandled one if an assertion
    // below tears the server down while this request is still in flight.
    const rotation = patchUser(base, 'alice', { ghToken: SENTINEL_2 })
      .then((r) => { settled = true; return r; }, (e) => { settled = true; return { status: 0, error: String(e) }; });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(settled, false, 'the dashboard did not enter the credential serialization domain');
    assert.equal(credState(proj).token, SENTINEL, 'no credential work may happen outside the domain');

    fs.writeFileSync(releaseFile, 'go');
    assert.equal((await rotation).status, 200);
    assert.equal(credState(proj).token, SENTINEL_2);
    await holderExited;
  });
});

// ---------------------------------------------------------------------------
// A31-5-adjacent — the clone-time credential file is no longer plantable
// ---------------------------------------------------------------------------

test('a symlink pre-planted at the clone credential path is never written through', { timeout: 40000 }, async () => {
  const port = 3965;
  const inst = makeInstance(port);
  writeProjects(inst, []);
  writeUsers(inst, [{ id: 'u-a', username: 'admin1', role: 'admin', projects: '*', ghToken: encryptToken(inst.secretKey, SENTINEL) }]);

  // The workspace root is owned by the pane account, so anything the dashboard
  // creates there by pathname can be pre-empted. `.pw-clone-<slug>` was exactly
  // such a file, and it held the decrypted token.
  const bait = path.join(inst.dir, 'bait');
  fs.writeFileSync(bait, 'untouched\n');
  fs.symlinkSync(bait, path.join(inst.workspaces, '.pw-clone-victim'));

  await withServer(inst, port, async (base) => {
    // A repository that cannot be cloned: the request fails, but what matters is
    // where the credential file went while it was trying.
    await form(base, '/manage/add', { name: 'victim', port: '7906', repo: `${inst.dir}/no-such-repo.git`, primaryUser: 'admin1' });
    assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched\n', 'the decrypted token was written through a planted symlink');
  });
});

// ---------------------------------------------------------------------------
// A31-1/A31-5 — no secret ever surfaces
// ---------------------------------------------------------------------------

test('no synthetic credential value appears in dashboard logs or API responses', { timeout: 40000 }, async () => {
  const port = 3966;
  const inst = makeInstance(port);
  const proj = seedRepo(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7907, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-a', username: 'alice', role: 'developer', projects: '*' }]);

  await withServer(inst, port, async (base, logs) => {
    assert.equal((await patchUser(base, 'alice', { ghToken: SENTINEL })).status, 200);
    const users = await (await fetch(`${base}/api/users`)).text();
    const projects = await (await fetch(`${base}/api/projects/config`)).text();
    // Break the repository so the next transition FAILS, and check the error path too.
    fs.chmodSync(path.join(proj, '.git'), 0o555);
    const failed = await patchUser(base, 'alice', { ghToken: SENTINEL_2 });
    fs.chmodSync(path.join(proj, '.git'), 0o755);

    const haystack = [users, projects, JSON.stringify(failed), logs.join('')].join('\n');
    assert.equal(haystack.includes(SENTINEL), false, 'a credential value reached a response or a log');
    assert.equal(haystack.includes(SENTINEL_2), false, 'a credential value reached a response or a log');
  });
});
