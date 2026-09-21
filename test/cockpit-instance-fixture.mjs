// A real dashboard process on a private, owner-marked tmux socket, for tests that need the page the
// server actually sends. Same shape as test/autoupdater-env.test.mjs's instance: container mode so
// the dashboard creates panes itself, PW_ISOLATED so no login is needed, every path in a temp dir.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedTmuxFixture } from './tmux-owner-fixture.mjs';
import { startCleanTmuxServer } from './pane-env-fixture.mjs';

const execFileAsync = promisify(execFile);
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

export async function tmux(sock, args) {
  const env = { ...process.env };
  delete env.TMUX;
  return (await execFileAsync('tmux', ['-L', sock, ...args], { env })).stdout;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Whether a CLI is INSTALLED is a property of the machine, not of the thing these tests examine.
// The dashboard decides it by running `<bin> --version` (app/server.js getCliVersion), so a test
// that asserts how a person's credential is CLASSIFIED for a CLI only passes where that CLI
// happens to be present — which is why the Copilot sign-in cases passed locally for their author
// and failed on CI and on any instance without the GitHub Copilot CLI. Unlike the tmux owner
// helper above, the CLI here is not the thing under test; it is an external dependency the test
// must not require. So: a stub that answers the one question the probe asks.
export function installCliStubs(dir, names) {
  const bin = path.join(dir, 'cli-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) {
    if (!name || name.includes('/')) throw new Error(`installCliStubs: expected a bare CLI name, got ${JSON.stringify(name)}`);
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${name} 0.0.0-fixture"; exit 0; }\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  return bin;
}

/** Boot an isolated dashboard with one project, run fn({ base, name, sock }), always tear down. */
export async function withCockpit(fn, { prefix = 'pw-cockpit-', env: extraEnv = {}, clis = [] } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  const sock = `pwcockpit-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  startCleanTmuxServer(sock);
  const owned = ownedTmuxFixture({ socket: sock, dir, env: { PW_DEPLOY_MODE: 'container' } });
  const cliBin = clis.length ? installCliStubs(dir, clis) : '';
  const env = {
    ...owned,
    // after ...owned, so the stubs win the lookup that decides `installed`
    ...(cliBin ? { PATH: `${cliBin}:${owned.PATH}` } : {}),
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_DEPLOY_MODE: 'container',
    PW_TMUX_SOCKET: sock,
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    // Isolate the workbench settings file for the same reason every other state path
    // here is isolated (see the note on workbenchSettingsPath in app/server.js): left
    // unset, a fixture instance reads the REAL /etc/project-workbench/workbench.json,
    // so these tests depend on production settings — and fail outright wherever that
    // file is root-only, which is how it ships.
    PW_WORKBENCH_SETTINGS: path.join(dir, 'workbench.json'),
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
    PW_API_TOKENS_PATH: path.join(dir, 'api-tokens.json'),
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
    ...extraEnv,
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
    const name = 'cockpit' + crypto.randomBytes(3).toString('hex');
    const created = await fetch(`${base}/manage/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ name, port: String(20000 + crypto.randomInt(0, 9000)) }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, `project creation must succeed: ${JSON.stringify(created)}`);
    await fn({ base, name, sock, logs, dir });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
    try { await tmux(sock, ['kill-server']); } catch { /* already gone */ }
    try { fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, sock), { force: true }); } catch { /* fine */ }
    // Retry the removal: a pane the test opened can still be dying inside the tmux
    // server while this runs, writing into the instance's credential tree — and rmSync
    // then fails ENOTEMPTY on a directory that repopulated itself mid-walk. Observed
    // once the sign-in tests started launching real CLI logins in a pane. The failure
    // is in teardown, so it fails a test that already passed.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Every inline, JavaScript-typed <script> body in an HTML document, in order. */
export function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
    .filter(([, attrs]) => {
      const t = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
      return !t || /^(text\/javascript|application\/javascript)$/i.test(t[1]);
    })
    .map(([, , body]) => body);
}

/** The source of `async function <name>(...){...}` in src, by brace matching outside strings. */
export function functionSource(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  let i = src.indexOf('{', start + header.length - 1);
  let depth = 0;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`unbalanced braces after ${header}`);
}
