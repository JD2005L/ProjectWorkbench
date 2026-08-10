// GOA-5, at the boundary that matters: the dashboard process itself.
//
// app/deploy-mode.js decides what "ambiguous" means; this file proves the dashboard acts on it.
// A container instance that omitted PW_DEPLOY_MODE used to boot happily with full host semantics —
// terminalOwnerPlan returning {kind:'named', user:'admin'}, panes launched via `sudo -u admin tmux`
// under per-project systemd units the image does not have — and the operator learned about it hours
// later as terminals that never came up. Refusing at startup with EX_CONFIG is loud, immediate, and
// names the variable to set.
//
// Kept separate from test/deploy-mode.test.mjs on purpose: booting the real server needs `express`,
// and that file must stay in the dependency-free offline subset (see scripts/pw-test-offline.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

/** Boot the real server with throwaway paths and report how it exited. Never touches a live instance. */
function bootServer(extraEnv, { waitForListen = false, port = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deploymode-'));
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
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverJs], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const done = (code, signal) => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
      resolve({ code, signal, out });
    };
    child.on('exit', (code, signal) => done(code, signal));
    if (waitForListen) {
      // A boot that survives long enough to listen is the positive control; kill it and report that.
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }, 4000);
      child.on('exit', () => clearTimeout(timer));
    }
  });
}

test('REGRESSION: the dashboard refuses to start when the deploy mode is ambiguous', async () => {
  const { code, out } = await bootServer({ PW_DEPLOY_MODE: 'containr' });
  assert.equal(code, 78, `EX_CONFIG expected; server said:\n${out}`);
  assert.match(out, /deploy-mode/);
  assert.match(out, /PW_DEPLOY_MODE/);
  assert.match(out, /host\|container/);
});

test('REGRESSION: an unset mode inside a containerised runtime refuses rather than assuming host', async () => {
  const { code, out } = await bootServer({ container: 'podman' });
  assert.equal(code, 78, `EX_CONFIG expected; server said:\n${out}`);
  assert.match(out, /containerised/);
  assert.match(out, /PW_DEPLOY_MODE=host\|container/);
});

test('an explicit mode still boots, even with container evidence present', async () => {
  // The positive control. Without it, "refuses to start" could be satisfied by a server that never
  // starts at all, and every existing deployment would be broken by this change.
  const { code, signal, out } = await bootServer(
    { PW_DEPLOY_MODE: 'host', container: 'podman', PORT: '0' },
    { waitForListen: true },
  );
  assert.ok(code !== 78, `an explicitly stated mode must never be treated as ambiguous:\n${out}`);
  assert.ok(signal === 'SIGKILL' || code === 0 || code === null,
    `expected a running server we then killed, got code=${code} signal=${signal}:\n${out}`);
});

test('a plain host install — no variable, no evidence — boots exactly as before', async () => {
  const { code, signal, out } = await bootServer({ PORT: '0' }, { waitForListen: true });
  assert.ok(code !== 78, `an ordinary install.sh deployment must not be treated as ambiguous:\n${out}`);
  assert.ok(signal === 'SIGKILL' || code === 0 || code === null,
    `expected a running server we then killed, got code=${code} signal=${signal}:\n${out}`);
});
