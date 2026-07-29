// The rail has to answer "which project am I in?" at a glance.
//
// It could not. Three states compete for attention there — pins lean out and take a hue-filled
// monogram, a finished project glows amber, a busy one pulses green — and the active project said so
// only in *colour*: a blue-ish border, a blue-ish background, a 3px cyan edge. Among several
// emphasised keys that reads as one more emphasised key, and at the collapsed 64px width, where the
// name and the border are both invisible, all that survived was a 3px edge among other coloured 3px
// edges. A project that was active *and* finished showed amber and nothing else at all.
//
// So the active key is marked by geometry instead: it squares off and runs into the workspace, the
// way a tab joins its panel. Nothing else in the rail uses the right-hand edge, geometry survives at
// 64px, and it composes with amber rather than competing with it.
//
// Boots a real isolated instance, like the other cockpit suites (ports 3883-3884 to stay clear of
// smoke.test.mjs on 3877/3878 and cockpit-drawer.test.mjs on 3879-3882).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

function makeInstance(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-rail-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
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
      PW_WORKSPACES: path.join(dir, 'workspaces'),
      PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    },
  };
}

/** Two projects, so "the active one" is a distinction the markup has to actually make. */
function seedProjects(inst, names = ['demo', 'other']) {
  const registry = names.map((name, i) => {
    const proj = path.join(inst.dir, 'workspaces', name);
    fs.mkdirSync(proj, { recursive: true });
    return { name, path: proj, port: 7801 + i };
  });
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(registry, null, 2));
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
        const r = await fetch(`${base}/healthz`);
        up = r.status === 200;
      } catch { /* not listening yet */ }
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

/** The key for one project, as served. */
function keyFor(html, project) {
  const at = html.indexOf(`data-project="${project}"`);
  assert.notEqual(at, -1, `no rail key for ${project}`);
  const from = html.lastIndexOf('<a ', at);
  return html.slice(from, html.indexOf('</a>', at) + 4);
}

test('rail: exactly one key is marked active, and it is the project being viewed', { timeout: 30000 }, async () => {
  const port = 3883;
  const inst = makeInstance(port);
  seedProjects(inst);
  await withServer(inst, port, async (base) => {
    const html = await (await fetch(`${base}/term/demo/`)).text();

    assert.equal((html.match(/class="pkey[^"]*\bcurrent\b/g) || []).length, 1, 'exactly one active key');
    assert.match(keyFor(html, 'demo'), /class="pkey current"/);
    assert.doesNotMatch(keyFor(html, 'other'), /\bcurrent\b/);
    // Not only visual: assistive technology is told the same thing.
    assert.match(keyFor(html, 'demo'), /aria-current="page"/);
    assert.doesNotMatch(keyFor(html, 'other'), /aria-current/);

    // And it moves with the viewer.
    const otherHtml = await (await fetch(`${base}/term/other/`)).text();
    assert.match(keyFor(otherHtml, 'other'), /class="pkey current"/);
    assert.doesNotMatch(keyFor(otherHtml, 'demo'), /\bcurrent\b/);
  });
});

test('rail: the active key is marked by geometry, so it survives 64px and composes with amber', { timeout: 30000 }, async () => {
  const port = 3884;
  const inst = makeInstance(port);
  seedProjects(inst);
  await withServer(inst, port, async (base) => {
    const css = await (await fetch(`${base}/term/demo/`)).text();

    // The connector: the key loses its right-hand rounding and bridges into the workspace.
    assert.match(css, /\.pkey\.current\{[^}]*border-radius:0/, 'active key must square off');
    assert.match(css, /\.pkey\.current\{[^}]*border-right-color:transparent/, 'active key must open its right edge');
    assert.match(css, /\.pkey\.current::after\{[^}]*left:100%/, 'active key must bridge into the content area');

    // The part that has to keep working at the collapsed width, where no name and no border show.
    assert.match(css, /\.pkey\.current \.pk-edge\{[^}]*width:5px/, 'the spine must thicken');

    // Amber is not overridden — a project that is active AND finished must show both. The bridge
    // takes the amber fill rather than the active key losing its amber.
    assert.match(css, /\.pkey\.current\.lit::after\{[^}]*border-color:#a16207/, 'the bridge follows amber');

    // Order matters and is easy to break by accident: `.pkey.lit` and `.pkey.pinned` both set
    // border-color, so the rules that open the right-hand edge have to come after them or an active
    // project that is also pinned or finished grows its border back and stops connecting.
    const current = css.indexOf('.pkey.current{border-radius:0');
    assert.ok(current > css.indexOf('.pkey.lit{'), 'active geometry must be declared after .lit');
    assert.ok(current > css.indexOf('.pkey.pinned{'), 'active geometry must be declared after .pinned');

    // The states this had to stop competing with are untouched.
    assert.match(css, /\.pkey\.lit\{[^}]*border-color:#a16207/, 'amber attention preserved');
    assert.match(css, /\.pkey\.pinned\{[^}]*transform:translateX\(10px\)/, 'the pin lean-out preserved');
    assert.match(css, /\.pkey\.working \.pk-live\{[^}]*animation:pwLivePulse/, 'the working pulse preserved');
  });
});
