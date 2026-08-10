// A31-3 must buy credential-race serialization WITHOUT buying an outage.
//
// The regression this exists to prevent: widening the project lock to also take
// the lifecycle lock put every long, external, network-bound operation — a
// `git clone` that may run for 300s — directly in front of login and all user
// management, which wait on the lifecycle lock with a 15s timeout and then 500.
//
// So the rule is scope, not just order: the ordered domain may only ever be held
// across the SHORT state transitions that can actually race. Cloning, chown,
// systemd and routing work happen outside it.
//
// Everything here is a real HTTP probe against a real server with a genuinely
// stalled clone. Synthetic sentinels only.
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
const SENTINEL = 'ghp_SYNTHETIC_AVAILABILITY_SENTINEL';

// A `git` that STALLS on clone and passes everything else through, so the server
// is doing exactly the long external work it does in production.
function makeStallingGitDir(dir, gateFile) {
  const binDir = path.join(dir, 'stall-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'git'), `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "clone" ]; then
    while [ ! -e ${JSON.stringify(gateFile)} ]; do sleep 0.05; done
    exit 1
  fi
done
exec ${realGit} "$@"
`, { mode: 0o755 });
  return binDir;
}

function makeInstance(port, dir) {
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  const secretKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyPath, `${secretKey}\n`);
  const ttyd = path.join(dir, 'ttyd-bin');
  fs.mkdirSync(ttyd, { recursive: true });
  fs.writeFileSync(path.join(ttyd, 'ttyd'), '#!/usr/bin/env bash\nexec sleep infinity\n', { mode: 0o755 });
  const gateFile = path.join(dir, 'release-clone');
  const env = {
    PATH: `${makeStallingGitDir(dir, gateFile)}:${ttyd}:${process.env.PATH}`,
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
    PW_PROJECTS_LOCK_PATH: path.join(dir, 'registry', '.pw-projects.lock'),
    PW_LIFECYCLE_LOCK_PATH: path.join(dir, 'users', '.pw-lifecycle.lock'),
  };
  return { dir, env, secretKey, gateFile, workspaces: env.PW_WORKSPACES };
}

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
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

async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

function form(base, url, body) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: new URL(base).host, accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
}

test('a stalled clone must not take down login or user management', { timeout: 120000 }, async () => {
  const port = 3971;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-avail-')));
  const inst = makeInstance(port, dir);
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([]));
  fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({
    users: [{ id: 'u-a', username: 'alice', role: 'admin', projects: '*', ghToken: encryptToken(inst.secretKey, SENTINEL) }],
  }));

  await withServer(inst, port, async (base) => {
    // Baseline, with nothing in flight.
    const baseline = await timed(() => fetch(`${base}/api/auth/check`));
    assert.equal(baseline.value.status, 200);
    const baseUsers = await timed(() => fetch(`${base}/api/users`));
    assert.equal(baseUsers.value.status, 200);

    // Start a project add whose clone will hang until we release it.
    const adding = form(base, '/manage/add', {
      name: 'slowclone', port: '7950', repo: 'https://example.invalid/repo.git', primaryUser: 'alice',
    }).catch((e) => ({ status: 0, error: String(e) }));

    // Wait until the clone is genuinely stalled inside the request.
    const deadline = Date.now() + 20000;
    let stalled = false;
    while (Date.now() < deadline && !stalled) {
      try { stalled = execFileSync('bash', ['-lc', `pgrep -af 'sleep 0.05' | grep -c . || true`], { encoding: 'utf8' }).trim() !== '0'; } catch { /* retry */ }
      if (!stalled) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(stalled, 'the clone never stalled, so this test would prove nothing');

    // THE ASSERTION: availability is unaffected while that long work is in flight.
    const during = await timed(() => fetch(`${base}/api/auth/check`));
    assert.equal(during.value.status, 200, 'login/auth must stay available during a slow clone');
    assert.ok(during.ms < 5000, `auth took ${during.ms}ms during a slow clone — it is waiting on a lock it must not wait on`);

    const users = await timed(() => fetch(`${base}/api/users`));
    assert.equal(users.value.status, 200, 'user management must stay available during a slow clone');
    assert.ok(users.ms < 5000, `GET /api/users took ${users.ms}ms during a slow clone`);

    // The reviewer's exact probe: a login attempt, which must answer promptly
    // rather than waiting on a lock and then failing.
    const login = await timed(() => fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: new URL(base).host },
      body: JSON.stringify({ username: 'alice', password: 'not-the-password' }),
    }));
    assert.ok(login.value.status < 500, `login returned ${login.value.status} during a slow clone — it waited on a lock and gave up`);
    assert.ok(login.ms < 5000, `login took ${login.ms}ms during a slow clone`);

    const rotate = await timed(() => fetch(`${base}/api/users/alice`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Origin: new URL(base).host },
      body: JSON.stringify({ role: 'admin' }),
    }));
    assert.equal(rotate.value.status, 200, 'a user update must stay available during a slow clone');
    assert.ok(rotate.ms < 5000, `PATCH /api/users took ${rotate.ms}ms during a slow clone`);

    fs.writeFileSync(inst.gateFile, 'go');
    await adding;
  });
});
