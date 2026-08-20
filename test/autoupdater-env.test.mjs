// DISABLE_AUTOUPDATER=1 has to reach EVERY pane a project session is made of.
//
// Claude Code nags — and can self-update underneath a running agent — unless the pane's environment
// says not to. A pane's environment is captured once, at `tmux new-session` / `tmux new-window`
// time, from the `env KEY=VAL ... bash` command the seam hands tmux; nothing set later reaches an
// already-running pane. So "the dashboard sets it" is only true of the exact seam that spells it
// out, and the token was spelled out in exactly one of them.
//
// The result on a live instance: the first window of a container-mode session was quiet, and every
// window opened after it (the ones an operator actually works in), every host-mode systemd terminal,
// and every session recreated after a reboot still nagged. deploy/patch-autoupdater.sh patched the
// ONE live literal it knew about, which is why this kept looking fixed.
//
// Two kinds of proof here, because neither is sufficient alone:
//
//   * REAL PROCESS — boot a real isolated dashboard, create a real project, open a real second
//     window, and read the environment of the real pane process out of /proc. This is the only
//     thing that proves the variable actually arrives; an argv assertion cannot.
//   * SOURCE CONTRACT — enumerate every pane-creating seam and require the token in each. This is
//     what stops a NEW seam (or a rename of an old one) from shipping without it, and it covers
//     ensureProjectTmuxSession, whose only production caller launches a real `claude` process.
//
// The sibling real-process proofs for the two shell seams live with their own harnesses:
// test/project-terminal-start.test.mjs (host-mode systemd terminal) and
// test/pw-tmux-restore.test.mjs (post-reboot restore).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedTmuxFixture } from './tmux-owner-fixture.mjs';
import { assertNoAmbientPaneEnv, paneEnviron, startCleanTmuxServer } from './pane-env-fixture.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = path.join(REPO, 'app', 'server.js');
const appDir = path.dirname(serverJs);
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const TOKEN = 'DISABLE_AUTOUPDATER=1';

// --- source contract: every seam that can create a project pane ---------------

/**
 * One top-level function's source text. The file indents every body line, so a `\n` immediately
 * followed by a top-level keyword is the end of the function — deliberately structural, so this
 * fails loudly if a seam is renamed or moved rather than quietly matching nothing.
 */
function functionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `app/server.js no longer defines ${name}() — this contract needs updating, not deleting`);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:async function |function |const |let |app\.|module\.)/);
  const body = end === -1 ? rest : rest.slice(0, end);
  assert.match(body, /agentEnvTokens\(/, `${name}() no longer builds its pane environment through agentEnvTokens()`);
  return body;
}

test('every dashboard pane-creation seam spells out the autoupdater token', () => {
  const src = read('app/server.js');
  // Named individually rather than swept, so that losing one is a failure here and not a silently
  // smaller sweep. These are the three seams that hand tmux a pane command.
  for (const name of ['ensureTmuxSession', 'ensureProjectTmuxSession', 'newTmuxWindow']) {
    assert.ok(
      functionSource(src, name).includes(TOKEN),
      `app/server.js ${name}() creates panes without ${TOKEN}`,
    );
  }
});

test('NO DRIFT: no agentEnvTokens() pane environment anywhere omits the token', () => {
  const src = read('app/server.js');
  // The sweep on top of the named list: a seam added later gets caught even though nobody thought
  // to name it here.
  const lists = [...src.matchAll(/agentEnvTokens\(\[([\s\S]*?)\]\)/g)].map((m) => m[1]);
  assert.ok(lists.length >= 3, `expected the dashboard to build pane environments via agentEnvTokens(): found ${lists.length}`);
  for (const list of lists) {
    assert.ok(list.includes(TOKEN), `an agentEnvTokens() pane environment omits ${TOKEN}: ${list.slice(0, 160)}`);
  }
});

test('the shell pane-creation seams spell out the autoupdater token in every env prefix', () => {
  // Both scripts build `env KEY=VAL ... bash` command strings. Every one of them is a pane
  // environment, including the per-user credential variants — a project with an owner must not be
  // the one that keeps nagging.
  for (const seam of ['scripts/project-terminal-start', 'scripts/pw-tmux-restore']) {
    const prefixes = read(seam).split('\n').filter((l) => /(^|["'=])env HOME=/.test(l));
    assert.ok(prefixes.length >= 1, `${seam} no longer builds an 'env HOME=...' pane command`);
    for (const line of prefixes) {
      assert.ok(line.includes(TOKEN), `${seam} builds a pane environment without ${TOKEN}: ${line.trim().slice(0, 160)}`);
    }
  }
});

test('the setpriv drop preserves the token rather than dropping or duplicating it', async () => {
  // Container mode with PW_TERMINAL_UID rewrites the canonical token list (HOME, PATH, USER); the
  // autoupdater token has to survive that rewrite untouched, exactly once.
  const { resolveTerminalPriv, wrapAgentEnv } = await import('../app/terminal-priv.js');
  const priv = resolveTerminalPriv({ PW_TERMINAL_UID: '1000', PW_DEPLOY_MODE: 'container' });
  const wrapped = wrapAgentEnv(priv, ['env', 'HOME=/root', TOKEN, 'PATH=/usr/bin']);
  assert.equal(wrapped.filter((t) => t === TOKEN).length, 1, `the drop must carry ${TOKEN} through exactly once: ${JSON.stringify(wrapped)}`);
});

// --- real process: the dashboard's own two seams -------------------------------

function makeInstance(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-autoupd-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.secret-key'), crypto.randomBytes(32).toString('hex') + '\n');
  // Private, owner-marked tmux socket — see test/tmux-owner-fixture.mjs. Container mode because
  // that is the mode whose dashboard creates panes itself; in host mode the same dashboard delegates
  // to project-terminal@.service, which test/project-terminal-start.test.mjs covers as a real
  // process. Set explicitly so this test means the same thing in both CI matrix legs.
  const sock = `pwaue-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  // Panes inherit the tmux SERVER's environment, and this suite is routinely run from a PW terminal
  // that already exports DISABLE_AUTOUPDATER=1 — so the server has to come up scrubbed, before the
  // owner fixture would create one, or every assertion below passes on an unpatched tree.
  startCleanTmuxServer(sock);
  const owned = ownedTmuxFixture({ socket: sock, dir, env: { PW_DEPLOY_MODE: 'container' } });
  return {
    dir,
    sock,
    env: {
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
    },
  };
}

async function tmux(sock, args) {
  return execFileAsync('tmux', ['-L', sock, ...args]);
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
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
    try { await tmux(inst.sock, ['kill-server']); } catch { /* already gone */ }
    try { await fsp.rm(`/tmp/tmux-${process.getuid()}/${inst.sock}`, { force: true }); } catch { /* fine */ }
    fs.rmSync(inst.dir, { recursive: true, force: true });
  }
}

test('REAL PROCESS: a project session AND every window opened in it carry DISABLE_AUTOUPDATER=1', { timeout: 60000 }, async () => {
  const port = 3980;
  const inst = makeInstance(port);
  const name = 'autoupd';
  await withServer(inst, port, async (base) => {
    // The claim this test makes is only meaningful if a pane can come back WITHOUT the token.
    await assertNoAmbientPaneEnv(inst.sock);

    const created = await fetch(`${base}/manage/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ name, port: '8412' }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, `project creation must succeed: ${JSON.stringify(created)}`);

    const session = `pw_${name}`;
    // 1. ensureTmuxSession — the session's first window.
    const first = await paneEnviron(inst.sock, `${session}:0`);
    assert.equal(first.DISABLE_AUTOUPDATER, '1', 'the session\'s first pane must carry the autoupdater token');

    // 2. newTmuxWindow — every window an operator opens afterwards. This is the pane people
    //    actually work in, and it was the one that kept nagging.
    const opened = await fetch(`${base}/api/term/${name}/windows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second' }),
    }).then((r) => r.json());
    assert.equal(opened.ok, true, `opening a window must succeed: ${JSON.stringify(opened)}`);

    const second = await paneEnviron(inst.sock, `${session}:second`);
    assert.equal(second.DISABLE_AUTOUPDATER, '1', 'a window opened in an existing session must carry the autoupdater token too');
    // Credential isolation is unchanged by carrying one more non-secret token: nothing per-user
    // leaks into a shared-login pane.
    assert.equal('CLAUDE_CONFIG_DIR' in second, false, 'a shared-login pane must still carry no per-user config dir');
  });
});
