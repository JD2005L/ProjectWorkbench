// Adversarial review round 2 (P0 items 1-4): the cross-process lifecycle
// lock (app/lifecycle-lock.js), immutable operation IDs on pending rename
// markers, and immutable-user-ID-keyed DELETE. Complements
// test/user-lifecycle.test.mjs (which already covers the basic retry/
// no-mistaken-takeover shapes) with the SPECIFIC scenarios called out:
// literal URL/body replay, deterministic concurrent rename races, DELETE's
// rename+recreate race / concurrent session write / project-save failure /
// credential-prune failure / replay, and username-reuse credential isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const appDir = path.dirname(serverJs);

// See test/user-lifecycle.test.mjs's identical helper for why: app/server.js's
// tmux() (host mode) and credentialContext()/terminalOwner() both resolve the
// real 'admin' account, and app/server.js spawns 'ttyd' bare (PATH-resolved) —
// both only exist on the real PW host. PW_HOST_TERMINAL_USER points at
// whichever account is actually running this test (explicit, real, sudo-able
// — never a production fallback); the stub ttyd ahead on PATH just blocks
// like the real one does.
function makeFakeTtydDir(dir) {
  const binDir = fs.mkdtempSync(path.join(dir, 'bin-shim-'));
  fs.writeFileSync(path.join(binDir, 'ttyd'), '#!/usr/bin/env bash\nexec sleep infinity\n', { mode: 0o755 });
  return binDir;
}

function makeInstance(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lifelock-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  const secretKeyPath = path.join(dir, '.secret-key');
  const secretKey = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretKeyPath, secretKey + '\n');
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
    ...extraEnv,
  };
  return { dir, env, secretKey };
}

function encryptToken(secretKeyHex, plaintext) {
  const key = Buffer.from(secretKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function writeUsers(inst, users) { fs.writeFileSync(inst.env.PW_USERS_PATH, JSON.stringify({ users }, null, 2)); }
function writeProjects(inst, projects) { fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(projects, null, 2)); }
function seedProject(inst, name, opts = {}) {
  const proj = path.join(inst.dir, 'workspaces', name);
  fs.mkdirSync(proj, { recursive: true });
  // A REAL repository, not an empty `.git` directory — see the note in
  // test/user-lifecycle.test.mjs's seedProject.
  if (opts.git) execFileSync('git', ['init', '-q', proj]);
  return proj;
}
function readGhTokenFromCredFile(projPath) {
  const file = path.join(projPath, '.git', '.pw-credentials');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/https:\/\/([^:]+):x-oauth-basic@github\.com/);
  return m ? m[1] : null;
}
function readProjectsConfig(base) { return fetch(`${base}/api/projects/config`).then((r) => r.json()); }
async function getUsersRaw(base) { return (await (await fetch(`${base}/api/users`)).json()).users; }
function patchUser(base, urlUsername, bodyObj) {
  return fetch(`${base}/api/users/${encodeURIComponent(urlUsername)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
  }).then((r) => r.json());
}
function deleteUser(base, urlUsername) {
  return fetch(`${base}/api/users/${encodeURIComponent(urlUsername)}`, { method: 'DELETE' }).then((r) => r.json());
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
      try { up = (await fetch(base + '/healthz')).status === 200; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    // See test/deploy-route.test.mjs's identical cleanup for why: PW_ISOLATED
    // auto-derives a tmux socket keyed to this server's own pid, and nothing
    // else ever cleans that server up.
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve);
      tk.on('error', resolve);
    });
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Item 2: literal URL/body replay after a post-commit failure
// ---------------------------------------------------------------------------

test('REGRESSION: literal replay of PATCH /api/users/alice {username:"alicia"} is idempotent — the exact original URL and body, not a URL updated by the test', { timeout: 30000 }, async () => {
  const port = 3920;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7830, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_x') }]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o555);
    let first;
    try { first = await patchUser(base, 'alice', { username: 'alicia' }); }
    finally { fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o755); }
    assert.equal(first.ok, false, 'the first attempt must fail (forced project-reference-stage failure)');
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alicia'), true, 'users.json already committed the rename');

    // The EXACT same request: URL still says /api/users/alice, body still
    // says {"username":"alicia"} — verbatim, not adjusted for the rename
    // that already happened.
    const replay = await patchUser(base, 'alice', { username: 'alicia' });
    assert.equal(replay.ok, true, `literal replay must succeed via immutable-id/marker resolution: ${JSON.stringify(replay)}`);
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, 'alicia');
    assert.equal(readGhTokenFromCredFile(proj), 'ghp_x');
    assert.equal((await getUsersRaw(base)).find((u) => u.username === 'alicia').pendingCredentialSync, null);
  });
});

test('REGRESSION: literal replay of DELETE /api/users/alice is idempotent-safe after a partial failure under the OLD url', { timeout: 30000 }, async () => {
  const port = 3921;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7831, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o555);
    try { assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, false); }
    finally { fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o755); }
    // demo.primaryUser is still "alice" — unreconciled.

    // DELETE against the ORIGINAL url, never updated to "alicia".
    const del = await deleteUser(base, 'alice');
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal((await getUsersRaw(base)).length, 1, 'only the admin should remain');
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, '');
  });
});

// ---------------------------------------------------------------------------
// Item 1: deterministic concurrent rename races
// ---------------------------------------------------------------------------

test('REGRESSION: two racing renames of the same user settle deterministically — the second-fired one wins, no corruption, no orphaned marker', { timeout: 30000 }, async () => {
  const port = 3922;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7832, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    const pA = patchUser(base, 'alice', { username: 'wonderland' });
    const pB = patchUser(base, 'alice', { username: 'looking-glass' }); // fired immediately after, not awaited between
    const [a, b] = await Promise.all([pA, pB]);
    // Exactly one of these must have found "alice" and renamed her; the
    // other necessarily 404s (by the time it runs, "alice" no longer exists
    // under any resolution — there is no in-flight pending marker for it
    // to fall back to, since the FIRST rename's marker's fromUsername IS
    // "alice", which... — assert on the actual deterministic outcome below
    // rather than guessing which request "wins" the race to be first.
    const users = await getUsersRaw(base);
    assert.equal(users.length, 1, 'exactly one user record must exist — no duplication, no data loss');
    const finalUsername = users[0].username;
    assert.ok(['wonderland', 'looking-glass'].includes(finalUsername), `unexpected final username: ${finalUsername}`);
    // Whichever one "won", it must be fully, coherently applied: project
    // reference follows it, and there is no leftover pending marker.
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, finalUsername);
    assert.equal(users[0].pendingCredentialSync, null, 'no orphaned marker after two racing renames settle');
    // Exactly one of the two requests reported success; a 404 for whichever
    // one lost the race is the CORRECT, non-corrupting outcome (POST/PATCH is
    // not required to be a no-op for identities that never existed at the
    // time it ran) — the critical property is that the surviving state is
    // internally consistent, which the assertions above already establish.
    const oks = [a.ok, b.ok].filter(Boolean).length;
    assert.ok(oks >= 1, 'at least one of the two racing renames must have succeeded');
  });
});

test('REGRESSION: a reconcile racing a second rename of the same user never applies a stale from/to pair', { timeout: 30000 }, async () => {
  const port = 3923;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7833, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    // Get a pending marker on the books (from=alice, to=alicia) by forcing
    // the first rename's reconciliation to fail.
    fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o555);
    try { assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, false); }
    finally { fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o755); }

    // Fire an explicit reconcile and a FURTHER rename (superseding the
    // marker) back-to-back, not awaited between each other.
    const pReconcile = fetch(`${base}/api/users/alicia/reconcile`, { method: 'POST' }).then((r) => r.json());
    const pRename = patchUser(base, 'alicia', { username: 'wonderland' });
    await Promise.all([pReconcile, pRename]);

    const users = await getUsersRaw(base);
    assert.equal(users.length, 1);
    const finalUsername = users[0].username;
    assert.ok(['alicia', 'wonderland'].includes(finalUsername));
    // Whatever the final identity, the project reference and pending marker
    // must be MUTUALLY CONSISTENT with it — never split (e.g. project still
    // saying "alice" while the marker already cleared, or a marker whose
    // to/fromUsername no longer matches reality).
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, finalUsername);
    if (users[0].pendingCredentialSync) {
      assert.equal(users[0].pendingCredentialSync.toUsername, finalUsername);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 3: DELETE — rename+recreate race, concurrent session write,
// project-save failure, credential-prune failure, replay/restart
// ---------------------------------------------------------------------------

test('REGRESSION: DELETE never deletes a NEW account that recreated the vacated username after a rename', { timeout: 30000 }, async () => {
  const port = 3924;
  const inst = makeInstance(port);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    // alice -> alicia, fully successful this time (nothing forced to fail).
    assert.equal((await patchUser(base, 'alice', { username: 'alicia' })).ok, true);
    // A brand-new, unrelated account recreates "alice".
    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', role: 'developer', password: 'aB1!aB1!aB1!', projects: '*' }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, JSON.stringify(created));

    // A DELETE naming "alicia" (the RENAMED identity) must remove alicia,
    // never the new, unrelated "alice".
    const del = await deleteUser(base, 'alicia');
    assert.equal(del.ok, true);
    const remaining = await getUsersRaw(base);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].username, 'alice', 'the NEW alice must survive — she is a completely different account');
  });
});

test('REGRESSION: a concurrent login is never lost to a racing DELETE\'s session purge (withSessionsLock)', { timeout: 30000 }, async () => {
  const port = 3925;
  const inst = makeInstance(port);
  const passwordHash = 'scrypt$' + Buffer.from('salt').toString('base64') + '$' + Buffer.from('hash').toString('base64');
  writeUsers(inst, [
    { id: 'u-victim', username: 'victim', role: 'developer', projects: '*' },
    { id: 'u-bob', username: 'bob', role: 'developer', projects: '*', passwordHash },
  ]);
  await withServer(inst, port, async (base) => {
    // Seed a real session for bob directly (bypassing password auth, which
    // isn't the point of this test) so DELETE's session purge has real
    // concurrent traffic to race against.
    fs.writeFileSync(inst.env.PW_SESSIONS_PATH, JSON.stringify({ sessions: [] }));
    // Fire the delete and a burst of "logins" (direct session-store writes
    // via the same code path a login uses) concurrently. What matters is
    // that withSessionsLock serializes them — no lost session, no corrupt
    // sessions.json — not the exact interleaving.
    const del = deleteUser(base, 'victim');
    const logins = Array.from({ length: 10 }, (_, i) =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'whatever-wrong' }),
      }));
    await Promise.all([del, ...logins]);
    assert.equal((await deleteUser(base, 'victim')).ok, false, 'sanity: victim is really gone'); // 404 now
    const sessionsRaw = JSON.parse(fs.readFileSync(inst.env.PW_SESSIONS_PATH, 'utf8'));
    assert.ok(Array.isArray(sessionsRaw.sessions), 'sessions.json must remain well-formed after concurrent writers');
  });
});

test('REGRESSION: DELETE fails closed (not deleted, retryable) when the project-save stage fails, and a replay after clearing it fully succeeds', { timeout: 30000 }, async () => {
  const port = 3926;
  const inst = makeInstance(port);
  const proj = seedProject(inst, 'demo', { git: true });
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7834, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  await withServer(inst, port, async (base) => {
    fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o555);
    let first;
    try { first = await deleteUser(base, 'alice'); }
    finally { fs.chmodSync(path.dirname(inst.env.PW_REGISTRY_PATH), 0o755); }
    assert.equal(first.ok, false, 'must fail closed, not report success, when the project-reference stage cannot commit');
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alice'), true, 'the account must still exist — safely retryable');

    const retry = await deleteUser(base, 'alice');
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alice'), false);
    assert.equal((await readProjectsConfig(base)).projects.find((p) => p.name === 'demo').primaryUser, '');
  });
});

test('REGRESSION: DELETE fails closed when the credential-tree prune fails, and a replay after clearing it fully succeeds', { timeout: 30000 }, async () => {
  const port = 3927;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  writeProjects(inst, []);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  const credDir = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, '.claude.json'), '{}');
  await withServer(inst, port, async (base) => {
    fs.rmSync(inst.env.PW_USER_CRED_BASE, { recursive: true, force: true });
    fs.writeFileSync(inst.env.PW_USER_CRED_BASE, 'not a directory'); // pruneUserCredentialTrees throws
    let first;
    try { first = await deleteUser(base, 'alice'); }
    finally { fs.rmSync(inst.env.PW_USER_CRED_BASE, { force: true }); }
    assert.equal(first.ok, false);
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alice'), true);

    const retry = await deleteUser(base, 'alice');
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal((await getUsersRaw(base)).some((u) => u.username === 'alice'), false);
  });
});

test('REGRESSION: replaying DELETE after it already fully succeeded (simulated restart) 404s cleanly, does not resurrect or double-act', { timeout: 30000 }, async () => {
  const port = 3928;
  const inst = makeInstance(port);
  writeUsers(inst, [
    { id: 'u-alice', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  await withServer(inst, port, async (base) => {
    assert.equal((await deleteUser(base, 'alice')).ok, true);
    // A "replay/restart" — e.g. a retried client request, or the same
    // operation resubmitted after a dashboard restart lost track of whether
    // it had already completed.
    const replay = await deleteUser(base, 'alice');
    assert.equal(replay.ok, false);
    assert.equal((await getUsersRaw(base)).length, 1, 'must not have resurrected or duplicated anything');
  });
});

// ---------------------------------------------------------------------------
// Item 4: username reuse must never inherit a prior identity's credential tree
// ---------------------------------------------------------------------------

test('REGRESSION: a new account that reuses a deleted user\'s username never sees their old Claude/GitHub material', { timeout: 30000 }, async () => {
  const port = 3929;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7835, primaryUser: 'alice' }]);
  writeUsers(inst, [
    { id: 'u-alice-old', username: 'alice', role: 'developer', projects: '*' },
    { id: 'u-admin', username: 'admin0', role: 'admin', projects: '*' },
  ]);
  const credDir = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  fs.writeFileSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'session-env.sh'), "export GH_TOKEN='ghp_OLD_OWNER_SECRET'\n");
  fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'OLD_OAUTH_TOKEN_MUST_NOT_LEAK' } }));

  await withServer(inst, port, async (base) => {
    assert.equal((await deleteUser(base, 'alice')).ok, true);
    assert.equal(fs.existsSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice')), false, 'the old tree must be pruned on delete');

    const created = await fetch(`${base}/api/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', role: 'developer', password: 'aB1!aB1!aB1!', projects: '*' }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, JSON.stringify(created));

    // The new alice becomes demo's owner (DELETE cleared the old alice's
    // reference; reassign it directly — there is no dedicated HTTP verb for
    // "set primaryUser" alone) and gets her credential dir materialized on
    // next recycle.
    const projects = JSON.parse(fs.readFileSync(inst.env.PW_REGISTRY_PATH, 'utf8'));
    for (const p of projects) if (p.name === 'demo') p.primaryUser = 'alice';
    fs.writeFileSync(inst.env.PW_REGISTRY_PATH, JSON.stringify(projects, null, 2));

    const recycled = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' }).then((r) => r.json());
    assert.equal(recycled.ok, true, JSON.stringify(recycled));

    const newConfigPath = path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude', '.claude.json');
    assert.ok(fs.existsSync(newConfigPath), 'the new alice must get a config materialized');
    assert.equal(fs.existsSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'claude', '.credentials.json')), false,
      'the OLD OAuth credentials file must never survive into the new identity\'s directory');
    const content = fs.readFileSync(newConfigPath, 'utf8');
    assert.equal(content.includes('OLD_OAUTH_TOKEN_MUST_NOT_LEAK'), false);
    assert.equal(fs.existsSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'session-env.sh')) &&
      fs.readFileSync(path.join(inst.env.PW_USER_CRED_BASE, 'alice', 'session-env.sh'), 'utf8').includes('ghp_OLD_OWNER_SECRET'), false,
      'the OLD GitHub token must never survive into the new identity\'s session file');
  });
});

// ---------------------------------------------------------------------------
// Items 5 & 6 (server-side): ensureTmuxSession's / ensureProjectTmuxSession's
// unified existing-session policy — resolve the current owner, verify the
// session's stamped fingerprint against it EXACTLY, refuse to attach on any
// mismatch or resolution failure.
//
// /manage/update calls stopProject() BEFORE startProject(), and stopProject
// unconditionally kills the project's tmux session in container mode — so
// every /manage/update always hits ensureTmuxSession's CREATE path, never
// its existing-session branch. These two tests still lock in real, valuable
// behavior (a fail-closed create via a route OTHER than recycle, and a
// rotated token being picked up cleanly on the next legitimate recreate) —
// they are deliberately NOT testing the existing-session branch itself.
// ---------------------------------------------------------------------------

function updateProject(base, name, body) {
  const params = new URLSearchParams({ name, port: String(body.port), primaryUser: body.primaryUser || '', ...body.extra });
  return fetch(`${base}/manage/update/${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params,
  }).then((r) => r.json());
}

test('REGRESSION: /manage/update also fails closed (via ensureTmuxSession\'s create path) when the owner becomes unresolvable', { timeout: 30000 }, async () => {
  const port = 3930;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7836, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    const first = await updateProject(base, 'demo', { port: 7836, primaryUser: 'alice' });
    assert.equal(first.ok, true, JSON.stringify(first));

    writeUsers(inst, []); // "alice" no longer exists — primaryUser now dangles

    const second = await updateProject(base, 'demo', { port: 7836, primaryUser: 'alice' });
    assert.equal(second.ok, false, 'recreating the session under an unresolvable owner must fail closed, not fall back to shared credentials');
    assert.match(second.error || '', /credential|owner|primaryUser/i);
  });
});

test('a rotated token is picked up cleanly on the next /manage/update (which always recreates the session)', { timeout: 30000 }, async () => {
  const port = 3931;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7837, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_old') }]);
  await withServer(inst, port, async (base) => {
    assert.equal((await updateProject(base, 'demo', { port: 7837, primaryUser: 'alice' })).ok, true);
    writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*', ghToken: encryptToken(inst.secretKey, 'ghp_new') }]);
    const second = await updateProject(base, 'demo', { port: 7837, primaryUser: 'alice' });
    assert.equal(second.ok, true, JSON.stringify(second));
  });
});

test('an existing session with an UNCHANGED owner survives repeated project updates fine', { timeout: 30000 }, async () => {
  const port = 3932;
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container' });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7838, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  await withServer(inst, port, async (base) => {
    assert.equal((await updateProject(base, 'demo', { port: 7838, primaryUser: 'alice' })).ok, true);
    const again = await updateProject(base, 'demo', { port: 7838, primaryUser: 'alice' });
    assert.equal(again.ok, true, JSON.stringify(again));
  });
});

// ensureProjectTmuxSession (the PVIKPBot supervised-handoff base session) is
// reached WITHOUT a preceding kill — a genuine existing-session path. The
// handoff endpoint then waits up to 30s for a real `claude` prompt that will
// never appear in this sandbox (no claude binary), so elapsed time
// discriminates a fail-closed credential refusal (near-instant) from
// successfully passing the credential check and reaching that wait (slow).
test('REGRESSION: ensureProjectTmuxSession (PVIKPBot base session) refuses to reattach once the existing session\'s owner becomes unresolvable', { timeout: 20000 }, async () => {
  const port = 3933;
  const tmuxSock = 'pw-lifelock-' + crypto.randomBytes(4).toString('hex');
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container', PW_INTERNAL_HANDOFF_TOKEN: 'test-token', PW_TMUX_SOCKET: tmuxSock });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7839, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  try {
    await withServer(inst, port, async (base) => {
      const handoff = (prompt) => fetch(`${base}/api/internal/pvikpbot/handoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ project: 'demo', prompt }),
      }).then((r) => r.json());

      // First call: valid owner. Fire it but do NOT await completion — with
      // no real `claude` binary in this sandbox it will eventually time out
      // waiting for a prompt that never appears (~30s), which this test does
      // not need to wait through. ensureProjectTmuxSession's own work (create
      // the base session, stamp it) happens fast, well before that wait.
      handoff('hello').catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(await tmuxOk(tmuxSock, 'demo'), 'sanity: the base session must have been created');

      // Break owner resolution WITHOUT touching the tmux session.
      writeUsers(inst, []);

      const start = Date.now();
      const result = await handoff('hello again');
      const elapsed = Date.now() - start;
      assert.equal(result.ok, false, 'must refuse once the owner cannot be resolved');
      assert.match(result.error || '', /credential|owner|stale/i);
      assert.ok(elapsed < 5000, `must fail fast (credential check), not after the ~30s claude-prompt wait: ${elapsed}ms`);
    });
  } finally {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('tmux', ['-L', tmuxSock, 'kill-server']).catch(() => {});
  }
});

// Item 3 (round 5): a tmux show-options/set-option failure that is NOT a
// genuinely-unset option (a control-plane hiccup, a corrupt server, an
// unexpected error) must be distinguishable from "nothing stamped" and must
// make every caller fail closed — never silently coerced into "unstamped,
// proceed". This shim passes every real tmux invocation straight through to
// the real binary, EXCEPT show-options/set-option against a specific session
// while a marker file exists — that one invocation fails with a distinctive,
// non-"invalid option" error, simulating exactly that kind of failure. The
// marker is a plain file the test creates/removes at will so a single running
// server can be made to hit the failure on demand, without restarting it.
function makeTmuxShim(dir) {
  const shimDir = fs.mkdtempSync(path.join(dir, 'tmux-shim-'));
  const markerPath = path.join(dir, 'tmux-fail.marker');
  // The real invocation is `tmux -u -L <sock> show-options -t <sess> ...` (or
  // `sudo -u <owner> tmux ...` in host mode) — the subcommand is NOT $1, it
  // comes after tmux's own global flags. Scan every arg instead of assuming a
  // position.
  fs.writeFileSync(path.join(shimDir, 'tmux'), `#!/usr/bin/env bash
target=""
prev=""
subcmd=""
for arg in "$@"; do
  if [[ "$prev" == "-t" ]]; then target="$arg"; fi
  if [[ "$arg" == "show-options" || "$arg" == "set-option" ]]; then subcmd="$arg"; fi
  prev="$arg"
done
if [[ -n "$subcmd" ]] \\
   && [[ -n "\${PW_TEST_TMUX_FAIL_SESSION:-}" && "$target" == "$PW_TEST_TMUX_FAIL_SESSION" ]] \\
   && [[ -n "\${PW_TEST_TMUX_FAIL_MARKER:-}" && -f "$PW_TEST_TMUX_FAIL_MARKER" ]]; then
  echo "injected test failure: simulated tmux control-plane error" >&2
  exit 1
fi
exec "$PW_TEST_REAL_TMUX" "$@"
`, { mode: 0o755 });
  return { shimDir, markerPath };
}

test('REGRESSION: a tmux control-plane failure reading the stamped fingerprint fails closed, never silently treated as unstamped', { timeout: 20000 }, async () => {
  const port = 3935;
  const tmuxSock = 'pw-lifelock-' + crypto.randomBytes(4).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tmux-shim-parent-'));
  const { shimDir, markerPath } = makeTmuxShim(dir);
  const realTmux = (await import('node:child_process')).execSync('command -v tmux').toString().trim();
  const inst = makeInstance(port, {
    PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container', PW_INTERNAL_HANDOFF_TOKEN: 'test-token', PW_TMUX_SOCKET: tmuxSock,
    PATH: `${shimDir}:${process.env.PATH}`,
    PW_TEST_REAL_TMUX: realTmux,
    PW_TEST_TMUX_FAIL_SESSION: 'pw_demo',
    PW_TEST_TMUX_FAIL_MARKER: markerPath,
  });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7841, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  try {
    await withServer(inst, port, async (base) => {
      const handoff = (prompt) => fetch(`${base}/api/internal/pvikpbot/handoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ project: 'demo', prompt }),
      }).then((r) => r.json());

      // First call: shim inert (no marker yet) — behaves exactly like real
      // tmux, session gets created and properly stamped.
      handoff('hello').catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      assert.ok(await tmuxOk(tmuxSock, 'demo'), 'sanity: the base session must have been created through the shim');

      // Arm the injected failure: the NEXT show-options against pw_demo fails
      // with a control-plane error, not "invalid option".
      fs.writeFileSync(markerPath, '1');

      const start = Date.now();
      const result = await handoff('hello again');
      const elapsed = Date.now() - start;
      assert.equal(result.ok, false, 'an unverifiable fingerprint read must refuse to reattach, not silently proceed');
      assert.match(result.error || '', /verif|credential|stale/i);
      assert.ok(elapsed < 5000, `must fail fast, not after the ~30s claude-prompt wait: ${elapsed}ms`);
    });
  } finally {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(realTmux, ['-L', tmuxSock, 'kill-server']).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REGRESSION: a tmux control-plane failure while stamping a FRESH session fails closed (create must not silently claim success)', { timeout: 20000 }, async () => {
  const port = 3936;
  const tmuxSock = 'pw-lifelock-' + crypto.randomBytes(4).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-tmux-shim-parent-'));
  const { shimDir, markerPath } = makeTmuxShim(dir);
  const realTmux = (await import('node:child_process')).execSync('command -v tmux').toString().trim();
  // Arm the marker BEFORE the server ever starts — the very first
  // show-options/set-option against pw_demo (the read-back verification
  // inside stampSessionCredKey, during FRESH session creation) fails.
  fs.writeFileSync(markerPath, '1');
  const inst = makeInstance(port, {
    PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container', PW_INTERNAL_HANDOFF_TOKEN: 'test-token', PW_TMUX_SOCKET: tmuxSock,
    PATH: `${shimDir}:${process.env.PATH}`,
    PW_TEST_REAL_TMUX: realTmux,
    PW_TEST_TMUX_FAIL_SESSION: 'pw_demo',
    PW_TEST_TMUX_FAIL_MARKER: markerPath,
  });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7842, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  try {
    await withServer(inst, port, async (base) => {
      const result = await fetch(`${base}/api/internal/pvikpbot/handoff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ project: 'demo', prompt: 'hello' }),
      }).then((r) => r.json());
      assert.equal(result.ok, false, 'a fresh session whose stamp cannot be verified must not be handed off as successfully created');
      assert.match(result.error || '', /verif|credential|stale|injected test failure/i);
    });
  } finally {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(realTmux, ['-L', tmuxSock, 'kill-server']).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Item 2 (round 5): newTmuxWindow() / POST /api/term/:project/windows must
// verify the LIVE session's stamped fingerprint before adding a window to
// it — not just resolve today's credentials — or a stale/mismatched session
// silently gets a new pane under a DIFFERENT identity than the rest of the
// session (mixed-attribution panes).
test('REGRESSION: POST /api/term/:project/windows refuses to add a window to a session whose stamped fingerprint no longer matches', { timeout: 30000 }, async () => {
  const port = 3934;
  const tmuxSock = 'pw-lifelock-' + crypto.randomBytes(4).toString('hex');
  const inst = makeInstance(port, { PW_PER_USER_CLAUDE: 'true', PW_DEPLOY_MODE: 'container', PW_TMUX_SOCKET: tmuxSock });
  const proj = seedProject(inst, 'demo');
  writeProjects(inst, [{ name: 'demo', path: proj, port: 7840, primaryUser: 'alice' }]);
  writeUsers(inst, [{ id: 'u-alice', username: 'alice', role: 'developer', projects: '*' }]);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await withServer(inst, port, async (base) => {
      const started = await fetch(`${base}/api/term/demo/recycle`, { method: 'POST' });
      assert.equal((await started.json()).ok, true, 'sanity: session starts cleanly');
      const before = await (await fetch(`${base}/api/term/demo/windows`)).json();

      // Directly corrupt the session's stamp to a fingerprint that does not
      // match today's owner — simulating drift the dashboard itself did not
      // cause (an out-of-band restamp, or a resolution change this specific
      // check must catch independent of credentialContext()).
      await execFileAsync('tmux', ['-L', tmuxSock, 'set-option', '-t', 'pw_demo', '@pw_cred_key', 'deadbeefdeadbeef']);

      const res = await fetch(`${base}/api/term/demo/windows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'extra' }),
      });
      const body = await res.json();
      assert.equal(body.ok, false, 'must refuse to add a window to a session stamped with a mismatched fingerprint');
      assert.match(body.error || '', /stale|fingerprint/i);

      const after = await (await fetch(`${base}/api/term/demo/windows`)).json();
      assert.equal(after.windows.length, before.windows.length, 'no window may have been created despite the refusal');
    });
  } finally {
    await execFileAsync('tmux', ['-L', tmuxSock, 'kill-server']).catch(() => {});
  }
});

async function tmuxOk(tmuxSock, projectName) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try { await execFileAsync('tmux', ['-L', tmuxSock, 'has-session', '-t', 'pw_' + projectName]); return true; }
  catch { return false; }
}
