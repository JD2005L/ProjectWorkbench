// Both upload routes, against a real server, with a real symlink in the way.
//
// THE DEFECT. `/api/upload/:project` and `/api/upload-stream/:project` both
// mkdir'd and wrote `<project>/_inbox/<name>` from the dashboard process and
// then called `adoptIntoWorkspace()`, which shells `chown <owner> <_inbox>
// <file>`. On a live instance that process is ROOT, and every one of those three
// operations follows a symlink at the final component. A pane account owns its
// own workspace, so replacing `_inbox` with a link is entirely within its
// authority — and that turned an ordinary file drop into root-owned content in a
// directory of the attacker's choosing, plus a root chown of that directory.
//
// These are the route-level regressions: normal uploads still work on both
// paths and in both deploy modes, and a symlinked `_inbox` produces a refusal
// with NOTHING written through it. They run at whatever uid the runner has, so
// they are deterministic in CI; the cross-uid ownership evidence that needs a
// genuinely privileged controller is in test/upload-privilege-real.test.mjs.
//
// Instances are private and isolated (own registry/users/sessions/workspaces/
// audit log, own tmux socket, ports 3985-3988), in the shape smoke.test.mjs and
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
const ME = os.userInfo().uid;
const MY_NAME = os.userInfo().username;

function makeInstance(port, extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upload-')));
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
    // The pane account this deployment hands workspace files to, resolved from
    // passwd exactly as a live instance resolves it — named explicitly so the
    // test does not depend on an `admin` account existing on the runner.
    PW_HOST_TERMINAL_USER: MY_NAME,
    ...extraEnv,
  };
  return { dir, env };
}

/** A registered project, plus the victim directory an attacker would aim `_inbox` at. */
function seedProject(inst, name = 'demo') {
  const proj = path.join(inst.dir, 'workspaces', name);
  fs.mkdirSync(proj, { recursive: true });
  const victim = path.join(inst.dir, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'ORIGINAL\n');
  fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify([{ name, path: proj, port: 7801 }], null, 2));
  return { proj, inbox: path.join(proj, '_inbox'), victim };
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
    // PW_ISOLATED derives a tmux socket keyed to the server's own pid and
    // nothing else ever cleans it up (see cockpit-drawer.test.mjs).
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve);
      tk.on('error', resolve);
    });
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

const uploadJson = (base, project, body) => fetch(`${base}/api/upload/${project}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const uploadStream = (base, project, filename, payload) => fetch(
  `${base}/api/upload-stream/${project}?filename=${encodeURIComponent(filename)}`,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: payload },
);

/** Everything under a directory, so "nothing was written through the link" is measured. */
const entries = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

test('uploads land in _inbox owned by the terminal owner, on both the JSON and the streaming route', { timeout: 30000 }, async () => {
  const port = 3985;
  const inst = makeInstance(port);
  const t = seedProject(inst);
  await withServer(inst, port, async (base) => {
    const j = await (await uploadJson(base, 'demo', {
      filename: 'notes.txt', mime: 'text/plain', data: Buffer.from('json payload').toString('base64'),
    })).json();
    assert.equal(j.ok, true, JSON.stringify(j));
    assert.equal(path.dirname(j.path), t.inbox, 'the JSON upload must land under _inbox');
    assert.match(path.basename(j.path), /^[\d-]+T[\d-]+Z-notes\.txt$/, 'the stamped name contract is preserved');
    assert.equal(j.url, `/file/demo/${encodeURIComponent(path.basename(j.path))}`, 'the download URL shape is preserved');
    assert.equal(fs.readFileSync(j.path, 'utf8'), 'json payload');

    const s = await (await uploadStream(base, 'demo', 'big.bin', Buffer.alloc(70000, 0x42))).json();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(path.dirname(s.path), t.inbox, 'the streaming upload must land under _inbox');
    assert.equal(s.bytes, 70000, 'the streaming route still reports the byte count');
    assert.equal(s.url, `/file/demo/${encodeURIComponent(path.basename(s.path))}`);
    assert.equal(fs.statSync(s.path).size, 70000);

    // Owned by, and writable by, the account panes run as — the reason the
    // handover exists at all. (Same uid as this runner here; the root-controller
    // case is proved in test/upload-privilege-real.test.mjs.)
    for (const p of [j.path, s.path, t.inbox]) {
      const st = fs.lstatSync(p);
      assert.equal(st.isSymbolicLink(), false, `${p} must be a real entry`);
      assert.equal(st.uid, ME, `${p} must be owned by the resolved terminal owner`);
    }
    fs.appendFileSync(j.path, ''); // writable by that account, not a read-only root artifact
    assert.equal(fs.lstatSync(j.path).mode & 0o200, 0o200, 'the terminal owner must be able to rewrite its own inbox file');

    // And the route the drawer reads it back through still serves it.
    const back = await fetch(`${base}${j.url}`);
    assert.equal(back.status, 200);
    assert.equal(await back.text(), 'json payload');

    const listed = await (await fetch(`${base}/api/inbox/demo`)).json();
    assert.deepEqual(listed.files.map((f) => f.path).sort(), [j.path, s.path].sort(), 'both uploads are listed');
  });
});

test('ADVERSARIAL: a symlinked _inbox is refused on the JSON route, and the target it chose is untouched', { timeout: 30000 }, async () => {
  const port = 3986;
  const inst = makeInstance(port);
  const t = seedProject(inst);
  fs.symlinkSync(t.victim, t.inbox);
  await withServer(inst, port, async (base) => {
    const res = await uploadJson(base, 'demo', {
      filename: 'evil.txt', mime: 'text/plain', data: Buffer.from('root payload').toString('base64'),
    });
    const body = await res.json().catch(() => null);

    assert.ok(res.status >= 400, `a symlinked _inbox must be refused, got HTTP ${res.status} ${JSON.stringify(body)}`);
    assert.equal(body?.ok, false, 'the refusal must be a clean JSON error, not a hang or a silent success');

    assert.deepEqual(entries(t.victim), ['keep.txt'], 'nothing may be written into the directory the link chose');
    assert.equal(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8'), 'ORIGINAL\n');
    assert.equal(fs.lstatSync(t.inbox).isSymbolicLink(), true, 'the link itself is left exactly as it was found');
    assert.equal(fs.lstatSync(t.victim).uid, ME, 'and no ownership outside the terminal owner changed');
  });
});

test('ADVERSARIAL: a symlinked _inbox is refused on the streaming route too', { timeout: 30000 }, async () => {
  const port = 3987;
  const inst = makeInstance(port);
  const t = seedProject(inst);
  fs.symlinkSync(t.victim, t.inbox);
  await withServer(inst, port, async (base) => {
    const res = await uploadStream(base, 'demo', 'evil.bin', Buffer.alloc(4096, 0x43));
    const body = await res.json().catch(() => null);

    assert.ok(res.status >= 400, `a symlinked _inbox must be refused, got HTTP ${res.status} ${JSON.stringify(body)}`);
    assert.equal(body?.ok, false);

    assert.deepEqual(entries(t.victim), ['keep.txt'], 'the streaming path must not write through the link either');
    assert.equal(fs.readFileSync(path.join(t.victim, 'keep.txt'), 'utf8'), 'ORIGINAL\n');
    assert.equal(fs.lstatSync(t.inbox).isSymbolicLink(), true);

    // The refusal must not be permanent damage: repair the link and the same
    // route works again, so this is a boundary, not an outage.
    fs.unlinkSync(t.inbox);
    const ok = await (await uploadStream(base, 'demo', 'fine.bin', Buffer.from('ok'))).json();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(path.dirname(ok.path), t.inbox);
  });
});

test('an empty streaming upload is still rejected with 400 and leaves no file behind', { timeout: 30000 }, async () => {
  const port = 3988;
  const inst = makeInstance(port, { PW_DEPLOY_MODE: 'container' });
  const t = seedProject(inst);
  await withServer(inst, port, async (base) => {
    // Container mode without PW_TERMINAL_UID: dashboard and panes share an
    // account, so no drop is needed — the same helper still does the write, and
    // the same contracts hold. This is the portability half of the fix.
    const ok = await (await uploadStream(base, 'demo', 'fine.bin', Buffer.from('container ok'))).json();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(fs.readFileSync(ok.path, 'utf8'), 'container ok');

    const res = await uploadStream(base, 'demo', 'empty.bin', Buffer.alloc(0));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /0 bytes/);
    assert.deepEqual(entries(t.inbox), [path.basename(ok.path)], 'the empty upload may not leave a file or a temp behind');

    // PRESERVED: the JSON route has always accepted a genuinely empty file, and
    // the two routes differ here on purpose — an empty streaming body means the
    // browser's read failed, which is the failure that route exists to catch.
    const empty = await (await uploadJson(base, 'demo', { filename: 'empty.txt', mime: 'text/plain', data: '' })).json();
    assert.equal(empty.ok, true, JSON.stringify(empty));
    assert.equal(fs.statSync(empty.path).size, 0);
  });
});
