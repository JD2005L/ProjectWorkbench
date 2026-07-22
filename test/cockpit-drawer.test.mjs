// The in-cockpit Files drawer must offer an accessible Inbox/Outbox tab split
// (role=tablist/tab/tabpanel, arrow-key navigation, per-tab counts), with the
// Outbox wired to the existing authenticated /api/outbox routes — download,
// delete, clear-all, and never upload. Boots real isolated instances like
// smoke.test.mjs (ports 3879-3882 to stay clear of its 3877/3878).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-drawer-'));
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

function seedProject(inst, name = 'demo') {
  const proj = path.join(inst.dir, 'workspaces', name);
  fs.mkdirSync(path.join(proj, '_outbox'), { recursive: true });
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name, path: proj, port: 7801 }], null, 2));
  return proj;
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

test('drawer: accessible Inbox/Outbox tab split with preserved inbox behavior (root)', { timeout: 30000 }, async () => {
  const port = 3879;
  const inst = makeInstance(port);
  seedProject(inst);
  await withServer(inst, port, async (base) => {
    const r = await fetch(`${base}/term/demo/`);
    assert.equal(r.status, 200);
    const html = await r.text();

    // Real tab semantics, default Inbox.
    assert.match(html, /role="tablist"/, 'drawer must expose a tablist');
    assert.equal((html.match(/role="tab"(?!list|panel)/g) || []).length, 2, 'exactly two drawer tabs');
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 2, 'exactly two drawer tabpanels');
    assert.match(html, /id="trayTabInbox"[^>]*aria-selected="true"/, 'Inbox selected by default');
    assert.match(html, /id="trayTabOutbox"[^>]*aria-selected="false"/, 'Outbox unselected by default');
    assert.match(html, /id="trayTabOutbox"[^>]*tabindex="-1"/, 'roving tabindex on inactive tab');
    assert.ok(html.includes('aria-controls="trayInboxPanel"') && html.includes('aria-controls="trayOutboxPanel"'), 'tabs reference their panels');
    assert.match(html, /id="trayOutboxPanel"[^>]*\bhidden\b/, 'Outbox panel hidden on load');

    // Keyboard support wired on the tablist.
    assert.ok(html.includes('selectTrayTab'), 'tab selection helper present');
    for (const k of ["'ArrowLeft'", "'ArrowRight'", "'Home'", "'End'"]) {
      assert.ok(html.includes(k), `tablist keyboard handling missing ${k}`);
    }

    // Per-tab counts.
    assert.ok(html.includes('id="trayInboxCount"') && html.includes('id="trayOutboxCount"'), 'per-tab count badges');

    // Outbox wiring: list/refresh, download, per-file delete, clear-all with confirm.
    assert.ok(html.includes("fetch('/api/outbox/'"), 'outbox fetch at root base');
    assert.ok(html.includes('refreshOutbox'), 'outbox refresh function');
    assert.ok(html.includes('>Download<'), 'Download control in outbox rows');
    assert.ok(html.includes("outbox?')"), 'clear-all / delete confirmation mentioning outbox');

    // Never any upload path to the outbox.
    for (let i = html.indexOf('api/outbox'); i !== -1; i = html.indexOf('api/outbox', i + 1)) {
      const window_ = html.slice(i, i + 160);
      assert.ok(!/POST/.test(window_), `outbox endpoint used with POST: …${window_.slice(0, 80)}…`);
    }

    // Inbox behavior preserved (paste/drop/picker, streaming, preview, insertion, delete, clear-all).
    for (const marker of [
      'id="drop"', 'id="file"', "fetch('/api/inbox/'", "'/api/upload/'", '/api/upload-stream/',
      'uploadStream(', 'showPreview(', 'insertPath(', '__pwSendToTerminal', 'refreshInbox',
      'Clear all', 'hoverPanel', 'xterm-helper-textarea',
    ]) {
      assert.ok(html.includes(marker), `inbox marker lost: ${marker}`);
    }
    // No duplicate window-level upload handlers (one paste, one drop).
    assert.equal((html.match(/window\.addEventListener\('paste'/g) || []).length, 1, 'exactly one window paste handler');
    assert.equal((html.match(/window\.addEventListener\('drop'/g) || []).length, 1, 'exactly one window drop handler');

    // Lightweight /files page unchanged: still shows both boxes with its own wiring.
    const fhtml = await (await fetch(`${base}/files/demo/`)).text();
    assert.ok(fhtml.includes('Outbox') && fhtml.includes('Inbox'), '/files page keeps Inbox+Outbox cards');
    assert.ok(fhtml.includes('api/outbox/'), '/files page outbox wiring intact');

    // Drawer styling stays cockpit-scoped: the login page must not carry it.
    const lhtml = await (await fetch(`${base}/login`)).text();
    assert.ok(!lhtml.includes('trayTab'), 'tray tab styles/markup must not leak beyond the cockpit');
  });
});

test('drawer + outbox URLs honor PW_BASE_PATH=/workbench', { timeout: 30000 }, async () => {
  const port = 3880;
  const inst = makeInstance(port, { PW_BASE_PATH: '/workbench' });
  const proj = seedProject(inst);
  fs.writeFileSync(path.join(proj, '_outbox', 'a.txt'), 'aa');
  await withServer(inst, port, async (base) => {
    const html = await (await fetch(`${base}/workbench/term/demo/`)).text();
    assert.ok(html.includes("fetch('/workbench/api/outbox/'"), 'outbox fetch under base path');
    assert.ok(html.includes("fetch('/workbench/api/inbox/'"), 'inbox fetch under base path');
    assert.ok(html.includes('/workbench/api/upload-stream/'), 'streaming upload under base path');
    const list = await (await fetch(`${base}/workbench/api/outbox/demo`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.files[0].url.startsWith('/workbench/api/outbox/demo/file/'), true, 'download URLs carry the base path');
    const dl = await fetch(`${base}${list.files[0].url}`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'aa');
  });
});

test('outbox API: list/download/delete/clear CRUD, no POST route (root, soft mode)', { timeout: 30000 }, async () => {
  const port = 3881;
  const inst = makeInstance(port);
  const proj = seedProject(inst);
  fs.writeFileSync(path.join(proj, '_outbox', 'report.txt'), 'agent report contents');
  fs.writeFileSync(path.join(proj, '_outbox', 'result.zip'), 'PK-zip-bytes');
  await withServer(inst, port, async (base) => {
    const list1 = await (await fetch(`${base}/api/outbox/demo`)).json();
    assert.equal(list1.ok, true);
    assert.deepEqual(list1.files.map((f) => f.name).sort(), ['report.txt', 'result.zip']);
    const rep = list1.files.find((f) => f.name === 'report.txt');
    assert.ok(rep.size > 0 && rep.mtime, 'size and timestamp listed');
    assert.equal(rep.url, '/api/outbox/demo/file/report.txt');

    const dl = await fetch(`${base}${rep.url}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') || '', /attachment/);
    assert.equal(await dl.text(), 'agent report contents');

    assert.equal((await fetch(`${base}/api/outbox/demo`, { method: 'POST' })).status, 404, 'no upload route may exist');

    const del = await (await fetch(`${base}/api/outbox/demo/file/report.txt`, { method: 'DELETE' })).json();
    assert.equal(del.ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/outbox/demo`)).json()).files.map((f) => f.name), ['result.zip']);

    const clr = await (await fetch(`${base}/api/outbox/demo`, { method: 'DELETE' })).json();
    assert.equal(clr.ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/outbox/demo`)).json()).files, []);
    assert.deepEqual(fs.readdirSync(path.join(proj, '_outbox')), []);
  });
});

test('outbox API: unauthenticated requests rejected when auth is enforced', { timeout: 30000 }, async () => {
  const port = 3882;
  const inst = makeInstance(port, { PW_AUTH_ENFORCE: 'true' });
  seedProject(inst);
  await withServer(inst, port, async (base) => {
    assert.equal((await fetch(`${base}/api/outbox/demo`)).status, 401);
    assert.equal((await fetch(`${base}/api/outbox/demo/file/x.txt`)).status, 401);
    assert.equal((await fetch(`${base}/api/outbox/demo/file/x.txt`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/api/outbox/demo`, { method: 'DELETE' })).status, 401);
  });
});
