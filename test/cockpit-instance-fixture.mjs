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

/** Boot an isolated dashboard with one project, run fn({ base, name, sock }), always tear down. */
export async function withCockpit(fn, { prefix = 'pw-cockpit-' } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  const sock = `pwcockpit-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  startCleanTmuxServer(sock);
  const owned = ownedTmuxFixture({ socket: sock, dir, env: { PW_DEPLOY_MODE: 'container' } });
  const env = {
    ...owned,
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
    PW_USER_CRED_BASE: path.join(dir, 'pw-users'),
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
    await fn({ base, name, sock, logs });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
    try { await tmux(sock, ['kill-server']); } catch { /* already gone */ }
    try { fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, sock), { force: true }); } catch { /* fine */ }
    fs.rmSync(dir, { recursive: true, force: true });
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
