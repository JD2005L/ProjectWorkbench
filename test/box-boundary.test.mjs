// Every route that touches `_inbox` or `_outbox`, against a real server, with a
// real symlink in the way.
//
// THE DEFECT. The upload chown was the reported vector, but the substituted-box
// primitive it depended on was reachable from eight more route handlers, each of
// which did its filesystem work in the ROOT dashboard process:
//
//   GET    /api/inbox/:project              fs.readdir + fs.stat
//   GET    /file/:project/:file             res.sendFile
//   DELETE /api/inbox/:project/:file        fs.rm
//   DELETE /api/inbox/:project              fs.readdir + fs.rm -r
//   GET    /api/outbox/:project             fs.readdir + fs.stat
//   GET    /api/outbox/:project/file/:name  res.download
//   DELETE /api/outbox/:project/file/:name  fs.rm
//   DELETE /api/outbox/:project             fs.readdir + fs.rm -r
//
// Both boxes belong to the pane account, so replacing either with a symlink is
// within that account's authority. That turned the list routes into metadata
// disclosure for any directory on the host, the download routes into arbitrary
// root file read, the single deletes into arbitrary root delete by basename, and
// the clear-alls into emptying an arbitrary root directory recursively.
//
// These are the route-level regressions: every normal flow still works and keeps
// its response shape, and a substituted box produces a refusal that discloses
// nothing and deletes nothing. They run at whatever uid the runner has, so they
// are deterministic in CI; the cross-uid evidence that needs a genuinely
// privileged controller and root-only victim artifacts is in
// test/box-privilege-real.test.mjs.
//
// Instances are private and isolated (own registry/users/sessions/workspaces/
// audit log, own tmux socket, ports 3992-3997), in the shape smoke.test.mjs and
// cockpit-drawer.test.mjs already use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);
const MY_NAME = os.userInfo().username;

const SECRET = 'VICTIM-ONLY-CONTENT-8f21\n';
const SECRET_NAME = 'victim-secret.txt';

function makeInstance(port, extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-box-')));
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
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
    PW_HOST_TERMINAL_USER: MY_NAME,
    ...extraEnv,
  };
  return { dir, env };
}

/** A registered project, plus the directory an attacker would aim a box at. */
function seedProject(inst, name = 'demo') {
  const proj = path.join(inst.dir, 'workspaces', name);
  fs.mkdirSync(proj, { recursive: true });
  const victim = path.join(inst.dir, 'victim');
  fs.mkdirSync(path.join(victim, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(victim, SECRET_NAME), SECRET);
  fs.writeFileSync(path.join(victim, 'deep', 'inner.txt'), 'INNER\n');
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name, path: proj, port: 7801 }], null, 2));
  return { proj, victim, box: (b) => path.join(proj, b) };
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

const entries = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

/**
 * The four routes each box exposes, so both can be driven by exactly the same
 * assertions. A boundary that only holds for the box that was reported is not a
 * boundary.
 */
const ROUTES = {
  _inbox: {
    list: (base) => `${base}/api/inbox/demo`,
    read: (base, name) => `${base}/file/demo/${encodeURIComponent(name)}`,
    del: (base, name) => `${base}/api/inbox/demo/${encodeURIComponent(name)}`,
    clear: (base) => `${base}/api/inbox/demo`,
    attachment: false,
    // `/file/` is not under `/api/`, so wantsJson() is false and requireAuth
    // sends the browser to the login page instead of answering 401.
    unauthRead: 302,
  },
  _outbox: {
    list: (base) => `${base}/api/outbox/demo`,
    read: (base, name) => `${base}/api/outbox/demo/file/${encodeURIComponent(name)}`,
    del: (base, name) => `${base}/api/outbox/demo/file/${encodeURIComponent(name)}`,
    clear: (base) => `${base}/api/outbox/demo`,
    attachment: true,
    unauthRead: 401,
  },
};

let nextPort = 3992;

for (const [BOX, R] of Object.entries(ROUTES)) {
  test(`PRESERVED ${BOX}: list, download and delete keep their shapes and behaviour`, { timeout: 30000 }, async () => {
    const port = nextPort++;
    const inst = makeInstance(port);
    const t = seedProject(inst);
    fs.mkdirSync(t.box(BOX), { recursive: true });
    fs.writeFileSync(path.join(t.box(BOX), 'report.txt'), 'agent report contents');
    fs.writeFileSync(path.join(t.box(BOX), 'shot.png'), Buffer.from('\x89PNG\r\n\x1a\n', 'binary'));

    await withServer(inst, port, async (base) => {
      const list = await (await fetch(R.list(base))).json();
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.deepEqual(list.files.map((f) => f.name).sort(), ['report.txt', 'shot.png']);
      const rep = list.files.find((f) => f.name === 'report.txt');
      assert.equal(rep.size, 21);
      assert.match(rep.mtime, /^\d{4}-\d{2}-\d{2}T/, 'the drawer sorts on this');
      assert.equal(rep.path, path.join(t.box(BOX), 'report.txt'), 'the absolute path the terminal gets pasted');
      assert.equal(rep.url, R.read('', 'report.txt'), 'the download URL shape is unchanged');

      const dl = await fetch(`${base}${rep.url}`);
      assert.equal(dl.status, 200);
      assert.equal(await dl.text(), 'agent report contents');
      assert.match(dl.headers.get('content-type') || '', /text\/plain/, 'content type still comes from the extension');
      if (R.attachment) {
        assert.match(dl.headers.get('content-disposition') || '', /attachment/, 'outbox downloads stay attachments');
        assert.match(dl.headers.get('content-disposition') || '', /report\.txt/, 'and keep their filename');
      }

      const png = await fetch(R.read(base, 'shot.png'));
      assert.equal(png.status, 200);
      assert.match(png.headers.get('content-type') || '', /image\/png/, 'inline previews depend on this');

      // CHANGED, deliberately: the inbox route used to hand express's default
      // error handler an ENOENT and answer 500 for a missing file, while its
      // outbox twin already answered 404 from its sendFile callback. Both now
      // answer 404. Nothing requests a missing entry on a normal path.
      assert.equal((await fetch(R.read(base, 'missing.txt'))).status, 404, 'a missing entry is a 404 on both boxes');

      const del = await (await fetch(R.del(base, 'report.txt'), { method: 'DELETE' })).json();
      assert.equal(del.ok, true);
      assert.deepEqual(entries(t.box(BOX)), ['shot.png']);

      const clr = await (await fetch(R.clear(base), { method: 'DELETE' })).json();
      assert.equal(clr.ok, true);
      assert.deepEqual(entries(t.box(BOX)), []);
      assert.deepEqual((await (await fetch(R.list(base))).json()).files, []);
    });
  });

  test(`PRESERVED ${BOX}: an absent box lists as empty rather than as an error`, { timeout: 30000 }, async () => {
    const port = nextPort++;
    const inst = makeInstance(port);
    seedProject(inst);
    await withServer(inst, port, async (base) => {
      assert.deepEqual(await (await fetch(R.list(base))).json(), { ok: true, files: [] });
      assert.equal((await (await fetch(R.clear(base), { method: 'DELETE' })).json()).ok, true, 'clearing nothing is not an error');
    });
  });

  test(`ADVERSARIAL ${BOX}: a substituted box discloses nothing and deletes nothing`, { timeout: 40000 }, async () => {
    const port = nextPort++;
    const inst = makeInstance(port);
    const t = seedProject(inst);
    fs.symlinkSync(t.victim, t.box(BOX));

    await withServer(inst, port, async (base) => {
      // LIST — must not report the names, sizes or mtimes of what the link chose.
      const listRes = await fetch(R.list(base));
      const listBody = await listRes.text();
      assert.equal(listBody.includes(SECRET_NAME), false, `list disclosed the victim's contents: ${listBody.slice(0, 300)}`);
      assert.equal(listBody.includes('inner.txt'), false);
      const list = JSON.parse(listBody);
      assert.equal(list.ok, false, 'a substituted box must be reported, not quietly rendered as an empty inbox');

      // READ — must not serve the bytes of what the link chose.
      const readRes = await fetch(R.read(base, SECRET_NAME));
      const readBody = await readRes.text();
      assert.equal(readBody.includes(SECRET.trim()), false, `download served the victim's bytes: ${readBody.slice(0, 300)}`);
      assert.ok(readRes.status >= 400, `a substituted box must refuse the download, got HTTP ${readRes.status}`);

      // DELETE ONE — the classic delete-by-basename primitive.
      const delRes = await fetch(R.del(base, SECRET_NAME), { method: 'DELETE' });
      assert.ok(delRes.status >= 400, `a substituted box must refuse the delete, got HTTP ${delRes.status}`);
      assert.equal(fs.existsSync(path.join(t.victim, SECRET_NAME)), true, 'the file the link chose must survive');
      assert.equal(fs.readFileSync(path.join(t.victim, SECRET_NAME), 'utf8'), SECRET);

      // CLEAR ALL — the recursive one.
      const clrRes = await fetch(R.clear(base), { method: 'DELETE' });
      assert.ok(clrRes.status >= 400, `a substituted box must refuse the clear, got HTTP ${clrRes.status}`);
      assert.deepEqual(entries(t.victim), ['deep', SECRET_NAME].sort(), 'a recursive clear must not empty what the link chose');
      assert.equal(fs.readFileSync(path.join(t.victim, 'deep', 'inner.txt'), 'utf8'), 'INNER\n');

      // The link itself is left exactly as found, and the refusal is not
      // permanent damage: repair it and the same routes work again.
      assert.equal(fs.lstatSync(t.box(BOX)).isSymbolicLink(), true);
      fs.unlinkSync(t.box(BOX));
      fs.mkdirSync(t.box(BOX));
      fs.writeFileSync(path.join(t.box(BOX), 'fine.txt'), 'fine');
      const back = await (await fetch(R.list(base))).json();
      assert.deepEqual(back.files.map((f) => f.name), ['fine.txt'], 'this is a boundary, not an outage');
    });
  });
}

test('PRESERVED: authentication and project scoping still gate every box route', { timeout: 30000 }, async () => {
  const port = nextPort++;
  const inst = makeInstance(port, { PW_AUTH_ENFORCE: 'true' });
  seedProject(inst);
  await withServer(inst, port, async (base) => {
    for (const [BOX, R] of Object.entries(ROUTES)) {
      assert.equal((await fetch(R.list(base))).status, 401, `${BOX} list`);
      assert.equal((await fetch(R.del(base, 'x.txt'), { method: 'DELETE' })).status, 401, `${BOX} delete`);
      assert.equal((await fetch(R.clear(base), { method: 'DELETE' })).status, 401, `${BOX} clear`);

      // `redirect: 'manual'`, because the inbox download lives outside /api/ and
      // is answered with a login redirect rather than a 401 — following it would
      // read as a 200 and hide the check entirely.
      const read = await fetch(R.read(base, 'x.txt'), { redirect: 'manual' });
      assert.equal(read.status, R.unauthRead, `${BOX} read`);
      if (R.unauthRead === 302) assert.match(read.headers.get('location') || '', /\/login\?next=/, 'and it goes to the login page');
      assert.equal((await read.text()).includes('VICTIM'), false, 'no bytes may be served to an unauthenticated caller');
    }
    // Auth is checked before the project is even resolved.
    assert.equal((await fetch(`${base}/api/inbox/nope`)).status, 401, 'auth is checked before the project exists');
  });
});
