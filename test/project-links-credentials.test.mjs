// The project links menu must never render URL credentials.
//
// THE DEFECT. `safeHttpUrl()` vetted the SCHEME and nothing else — it returned
// `new URL(v).href`, which preserves `username:password@` userinfo verbatim. A
// repo/dev/prod URL configured as `https://alice:s3cr3t@github.com/acme/app.git`
// therefore reached `projectLinksMenu()`, which renders the URL twice: once in
// the `href` and once as VISIBLE TEXT in the menu row. Anyone who could open the
// cockpit — or shoulder-surf it, or receive a screenshot of it — read the
// password, and it went out in the href of every click.
//
// THE INVARIANT. A configured URL carrying ANY userinfo is omitted entirely
// rather than repaired: a link that silently drops half of what an operator
// configured is its own kind of wrong, and there is no way to render the
// credential safely. Credential-free http(s) links keep working unchanged, and
// non-http(s) stays rejected as before.
//
// This drives the REAL rendered cockpit route on a real isolated instance, not a
// re-implementation of the helper — the defect was in what reaches the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

const SECRET = 's3cr3tPASSWORD';
const USERINFO_USER = 'alice-the-user';

const PROJECTS = [
  {
    name: 'creds',
    // repo is stored as a raw clone URL (never passed through safeHttpUrl on the
    // way in), so this is exactly what a `git clone` URL with a token looks like.
    repo: `https://${USERINFO_USER}:${SECRET}@github.com/acme/app.git`,
    devUrl: `https://${USERINFO_USER}@dev.example.com/`,
    prodUrl: 'https://prod.example.com/',
  },
  {
    name: 'clean',
    repo: 'https://github.com/acme/app.git',
    devUrl: 'https://dev.example.com/',
    // An `@` in the PATH is not userinfo: dropping this would be a false positive
    // that quietly deletes a legitimate link.
    prodUrl: 'https://registry.example.com/@acme/app',
  },
  {
    name: 'hostile',
    // Password-only userinfo (empty username) is still userinfo.
    repo: `https://:${SECRET}@github.com/acme/app.git`,
    devUrl: 'javascript:alert(1)',
    prodUrl: 'data:text/html,<script>alert(1)</script>',
  },
];

function makeInstance(port) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-links-')));
  const workspaces = path.join(dir, 'workspaces');
  fs.mkdirSync(workspaces, { recursive: true });
  const registry = PROJECTS.map((p, i) => ({ ...p, path: path.join(workspaces, p.name), port: 7810 + i }));
  for (const p of registry) fs.mkdirSync(p.path, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(registry, null, 2));
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      PORT: String(port),
      PW_ISOLATED: '1',
      PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
      PW_USERS_PATH: path.join(dir, 'users.json'),
      PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
      PW_WORKSPACES: workspaces,
      PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
      PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
      PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
      PW_AUDIT_LOG: path.join(dir, 'audit.log'),
    },
  };
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
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve);
      tk.on('error', resolve);
    });
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

/** The rendered links menu only — the element the defect was reported against. */
function linksMenu(html) {
  const m = /<div class="tabMenu projLinks" id="projLinksMenu"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(m, 'the cockpit must still render a project links menu');
  return m[1];
}

const labels = (menu) => [...menu.matchAll(/<span class="ti-name">([^<]*)<\/span>/g)].map((m) => m[1]);
const hrefs = (menu) => [...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test('links menu: a URL carrying userinfo is omitted entirely, and the credential never reaches the page', { timeout: 30000 }, async () => {
  const port = 3989;
  const inst = makeInstance(port);
  await withServer(inst, port, async (base) => {
    const html = await (await fetch(`${base}/term/creds/`)).text();

    // The credential itself, in any of the forms the page could carry it.
    for (const leak of [SECRET, encodeURIComponent(SECRET), `${USERINFO_USER}:`, `${USERINFO_USER}@`, `${USERINFO_USER}%40`]) {
      assert.equal(html.includes(leak), false, `the rendered cockpit must not contain ${JSON.stringify(leak)}`);
    }

    const menu = linksMenu(html);
    assert.deepEqual(labels(menu), ['Prod site'], 'only the credential-free link may survive');
    assert.deepEqual(hrefs(menu), ['https://prod.example.com/'], 'and it must render unchanged');
    assert.equal(menu.includes('github.com'), false, 'a repo URL with userinfo is dropped, not stripped and rendered');
    assert.equal(menu.includes('dev.example.com'), false, 'a dev URL with userinfo is dropped too');
  });
});

test('links menu: credential-free http(s) links still render, including an @ in the path', { timeout: 30000 }, async () => {
  const port = 3990;
  const inst = makeInstance(port);
  await withServer(inst, port, async (base) => {
    const menu = linksMenu(await (await fetch(`${base}/term/clean/`)).text());
    assert.deepEqual(labels(menu), ['GitHub repo', 'Dev site', 'Prod site'], 'every safe link must survive');
    assert.deepEqual(hrefs(menu), [
      'https://github.com/acme/app', // the .git suffix is still dropped for browsing
      'https://dev.example.com/',
      'https://registry.example.com/@acme/app', // an @ in the path is not userinfo
    ]);
    assert.ok(menu.includes('target="_blank"') && menu.includes('rel="noopener noreferrer"'), 'link hardening is preserved');
  });
});

test('links menu: non-http(s) stays rejected, and a project left with no links shows the empty state', { timeout: 30000 }, async () => {
  const port = 3991;
  const inst = makeInstance(port);
  await withServer(inst, port, async (base) => {
    const html = await (await fetch(`${base}/term/hostile/`)).text();
    assert.equal(html.includes(SECRET), false, 'password-only userinfo is userinfo, and must not be rendered');
    assert.equal(html.includes('javascript:alert'), false, 'a javascript: URL must still be rejected');
    assert.equal(html.includes('data:text/html'), false, 'a data: URL must still be rejected');

    const menu = linksMenu(html);
    assert.deepEqual(labels(menu), [], 'no link may survive this project');
    assert.match(menu, /No links configured/, 'the existing empty state must be shown rather than an empty menu');
  });
});
