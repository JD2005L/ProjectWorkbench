// Per-user CLI credentials: directory ownership and token placement.
//
// Two regressions are pinned here:
//
//  1. OWNERSHIP. The dashboard runs as root and the pane does not. Every path
//     created for a pane must be handed to the pane's account, in host mode as
//     well as container mode, and the operation must FAIL (so the caller falls
//     back to the shared login) rather than leave an agent pointed at a
//     directory it cannot read.
//
//  2. TOKEN PLACEMENT. The GitHub token must never become an argv token. tmux
//     retains a pane's start command for the life of the pane
//     (`tmux list-panes -F '#{pane_start_command}'`) and every pane on a
//     workbench runs as the same OS account, so `env GH_TOKEN=<secret> bash`
//     publishes one user's token to every other project's terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import realFsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CREDENTIALS_OFF,
  credentialFingerprint,
  ensureUserCredentials,
  sessionCredentialState,
  renderSessionEnvFile,
  safeUserName,
  shSingleQuote,
  userClaudeConfigDir,
  userCredRoot,
  userSessionEnvFile,
} from '../app/user-credentials.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'ghp_pretendTOKENvalue0123456789';

function tmpBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-usercred-'));
  return path.join(dir, 'pw-users');
}

// A real filesystem with a simulated ownership layer, so the chown contract can
// be asserted without the suite needing root or a second uid.
function ownedFsp({ rootUid = 0, rootGid = 0, chownFailsOn = null } = {}) {
  const owners = new Map();
  const chowns = [];
  return {
    chowns,
    mkdir: (...a) => realFsp.mkdir(...a),
    readFile: (...a) => realFsp.readFile(...a),
    writeFile: (...a) => realFsp.writeFile(...a),
    access: (...a) => realFsp.access(...a),
    chmod: (...a) => realFsp.chmod(...a),
    rm: (...a) => realFsp.rm(...a),
    async stat(p) {
      const st = await realFsp.stat(p);
      const o = owners.get(p) || { uid: rootUid, gid: rootGid };
      return { uid: o.uid, gid: o.gid, mode: st.mode, isFile: () => st.isFile() };
    },
    async chown(p, uid, gid) {
      chowns.push({ path: p, uid, gid });
      if (chownFailsOn && p === chownFailsOn) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      owners.set(p, { uid, gid });
    },
    preown(p, uid, gid) { owners.set(p, { uid, gid }); },
  };
}

test('REGRESSION: every level is handed to the pane account (host mode, uid 1000)', async () => {
  const base = tmpBase();
  const fsp = ownedFsp();
  const owner = { uid: 1000, gid: 1000, user: 'admin' };
  const res = await ensureUserCredentials({ fsp, base, username: 'james.levac', ghToken: TOKEN, owner });

  const expected = [
    base,
    userCredRoot(base, 'james.levac'),
    userClaudeConfigDir(base, 'james.levac'),
    path.join(userClaudeConfigDir(base, 'james.levac'), '.claude.json'),
    userSessionEnvFile(base, 'james.levac'),
  ];
  assert.deepEqual(fsp.chowns.map((c) => c.path).sort(), expected.slice().sort());
  for (const c of fsp.chowns) assert.deepEqual({ uid: c.uid, gid: c.gid }, { uid: 1000, gid: 1000 });
  assert.equal(res.configDir, userClaudeConfigDir(base, 'james.levac'));
});

test('container mode (uid 1001) hands over the same set', async () => {
  const base = tmpBase();
  const fsp = ownedFsp();
  await ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: { uid: 1001, gid: 1001 } });
  assert.equal(fsp.chowns.length, 5);
  for (const c of fsp.chowns) assert.deepEqual({ uid: c.uid, gid: c.gid }, { uid: 1001, gid: 1001 });
});

test('owner=null (dashboard and pane share an account) performs no chown at all', async () => {
  const base = tmpBase();
  const fsp = ownedFsp();
  const res = await ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: null });
  assert.deepEqual(fsp.chowns, [], 'shared-account deployments must stay byte-identical');
  assert.ok(fs.existsSync(res.configDir));
});

test('already-correct ownership is not re-chowned', async () => {
  const base = tmpBase();
  const fsp = ownedFsp({ rootUid: 1000, rootGid: 1000 });
  await ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: { uid: 1000, gid: 1000 } });
  assert.deepEqual(fsp.chowns, []);
});

test('FAIL CLOSED: a chown that cannot be performed rejects the whole operation', async () => {
  const base = tmpBase();
  const configDir = userClaudeConfigDir(base, 'u');
  const fsp = ownedFsp({ chownFailsOn: configDir });
  await assert.rejects(
    () => ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: { uid: 1000, gid: 1000 } }),
    /EPERM/,
    'an unreadable credential dir must never be handed to a pane',
  );
});

test('the token goes to a 0600 file, never into the returned env tokens', async () => {
  const base = tmpBase();
  const fsp = ownedFsp();
  const res = await ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: null });

  assert.equal(res.envFile, userSessionEnvFile(base, 'u'));
  assert.equal(fs.statSync(res.envFile).mode & 0o777, 0o600, 'session env file must be 0600');
  assert.ok(fs.readFileSync(res.envFile, 'utf8').includes(`export GH_TOKEN='${TOKEN}'`));

  // Nothing the caller puts on a command line may carry the secret.
  assert.ok(!res.configDir.includes(TOKEN));
  assert.ok(!res.envFile.includes(TOKEN));
  assert.ok(!res.fingerprint.includes(TOKEN));
  assert.ok(!JSON.stringify({ configDir: res.configDir, envFile: res.envFile, fingerprint: res.fingerprint }).includes(TOKEN));
});

test('the seeded config dir never contains the token either', async () => {
  const base = tmpBase();
  const res = await ensureUserCredentials({ fsp: ownedFsp(), base, username: 'u', ghToken: TOKEN, owner: null });
  const cfg = fs.readFileSync(path.join(res.configDir, '.claude.json'), 'utf8');
  assert.ok(!cfg.includes(TOKEN), 'the Claude config must not carry the GitHub token');
});

test('a removed token deletes the stale env file rather than leaving a revoked secret', async () => {
  const base = tmpBase();
  const fsp = ownedFsp();
  const first = await ensureUserCredentials({ fsp, base, username: 'u', ghToken: TOKEN, owner: null });
  assert.ok(fs.existsSync(first.envFile));

  const second = await ensureUserCredentials({ fsp, base, username: 'u', ghToken: '', owner: null });
  assert.equal(second.envFile, '');
  assert.equal(fs.existsSync(userSessionEnvFile(base, 'u')), false);
});

test('the generated env file survives a real bash source, including hostile tokens', async () => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-inject-'));
  const marker = path.join(markerDir, 'INJECTED');
  const nasty = `gh'p_"; touch ${marker}; #`;
  const base = tmpBase();
  const res = await ensureUserCredentials({ fsp: ownedFsp(), base, username: 'u', ghToken: nasty, owner: null });
  const { stdout, stderr } = await execFileAsync('bash', ['-c', `set -u; . ${JSON.stringify(res.envFile)}; printf '%s' "$GH_TOKEN"`]);
  assert.equal(stdout, nasty, 'quoting must round-trip exactly');
  assert.equal(stderr, '');
  assert.equal(fs.existsSync(marker), false, 'the token must never be executed as shell');
});

test('shSingleQuote closes and reopens around embedded quotes', () => {
  assert.equal(shSingleQuote('plain'), "'plain'");
  assert.equal(shSingleQuote("a'b"), `'a'\\''b'`);
  assert.equal(renderSessionEnvFile({ EMPTY: '', SET: 'x' }).includes('EMPTY'), false, 'empty values are omitted');
});

test('MCP servers are seeded once from the shared config and never clobbered', async () => {
  const base = tmpBase();
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-shared-'));
  const sharedClaudeJson = path.join(sharedDir, '.claude.json');
  fs.writeFileSync(sharedClaudeJson, JSON.stringify({ mcpServers: { teamkb: { url: 'https://x/teamkb/mcp' } }, other: 1 }));

  const first = await ensureUserCredentials({ fsp: ownedFsp(), base, username: 'u', sharedClaudeJson, owner: null });
  assert.equal(first.seeded, true);
  const cfgPath = path.join(first.configDir, '.claude.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), { mcpServers: { teamkb: { url: 'https://x/teamkb/mcp' } } });
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);

  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: {}, userEdited: true }));
  const second = await ensureUserCredentials({ fsp: ownedFsp(), base, username: 'u', sharedClaudeJson, owner: null });
  assert.equal(second.seeded, false);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).userEdited, true, 'a user-edited config must survive');
});

test('a missing or unparseable shared config still yields a usable seed', async () => {
  for (const shared of ['', '/nonexistent/.claude.json']) {
    const base = tmpBase();
    const res = await ensureUserCredentials({ fsp: ownedFsp(), base, username: 'u', sharedClaudeJson: shared, owner: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(res.configDir, '.claude.json'), 'utf8')), { mcpServers: {} });
  }
});

test('usernames cannot escape the credential base', () => {
  assert.equal(safeUserName('../../root'), '.._.._root');
  assert.equal(safeUserName('a/b'), 'a_b');
  assert.equal(safeUserName('GOA\\user'), 'GOA_user');
  for (const hostile of ['../../root', 'a/b', '..', 'x\0y']) {
    const dir = userClaudeConfigDir('/srv/pw-users', hostile);
    assert.ok(dir.startsWith('/srv/pw-users/'), `${hostile} -> ${dir}`);
    assert.ok(!dir.includes('..' + path.sep), `${hostile} -> ${dir}`);
  }
});

test('the fingerprint identifies the credentials without revealing them', () => {
  const a = credentialFingerprint({ username: 'u', configDir: '/d', ghToken: TOKEN });
  assert.equal(a, credentialFingerprint({ username: 'u', configDir: '/d', ghToken: TOKEN }), 'stable');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes(TOKEN));
  // Any input change must be observable, or a stale session would look current.
  assert.notEqual(a, credentialFingerprint({ username: 'u', configDir: '/d', ghToken: 'rotated' }));
  assert.notEqual(a, credentialFingerprint({ username: 'other', configDir: '/d', ghToken: TOKEN }));
  assert.notEqual(a, credentialFingerprint({ username: 'u', configDir: '/other', ghToken: TOKEN }));
  assert.notEqual(a, credentialFingerprint({ username: 'u', configDir: '/d', ghToken: '' }));
  // Field boundaries are not ambiguous (no 'u'+'/d' vs 'u/'+'d' collision).
  assert.notEqual(
    credentialFingerprint({ username: 'ab', configDir: 'c' }),
    credentialFingerprint({ username: 'a', configDir: 'bc' }),
  );
});

// ── Session credential drift ────────────────────────────────────────────────
// Regression: ensureTmuxSession() returned early for an existing session, so a
// project whose credentials changed (feature enabled, primaryUser reassigned,
// token rotated) kept running on the old ones indefinitely and nothing said so.

test('a session matching the current credentials is not stale', () => {
  assert.deepEqual(
    sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc123', stampedKey: 'abc123' }),
    { stale: false, reason: 'current' },
  );
});

test('REGRESSION: a session stamped with different credentials is reported stale', () => {
  assert.deepEqual(
    sessionCredentialState({ perUserEnabled: true, desiredKey: 'new-key', stampedKey: 'old-key' }),
    { stale: true, reason: 'changed' },
  );
});

test('REGRESSION: enabling per-user credentials makes an unstamped session stale', () => {
  // The session predates the change, so it is still on the shared login.
  assert.deepEqual(
    sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc123', stampedKey: '' }),
    { stale: true, reason: 'unstamped' },
  );
});

test('a project that has no owner and no stamp is current, not noisy', () => {
  assert.deepEqual(
    sessionCredentialState({ perUserEnabled: true, desiredKey: CREDENTIALS_OFF, stampedKey: '' }),
    { stale: false, reason: 'current' },
  );
});

test('a session holding private credentials after the owner was removed is stale', () => {
  assert.deepEqual(
    sessionCredentialState({ perUserEnabled: true, desiredKey: CREDENTIALS_OFF, stampedKey: 'abc123' }),
    { stale: true, reason: 'changed' },
  );
});

test('with the feature off nothing is ever stale, whatever the stamp says', () => {
  for (const stampedKey of ['', 'abc123', CREDENTIALS_OFF]) {
    assert.deepEqual(
      sessionCredentialState({ perUserEnabled: false, desiredKey: 'abc123', stampedKey }),
      { stale: false, reason: 'disabled' },
    );
  }
  assert.deepEqual(sessionCredentialState(), { stale: false, reason: 'disabled' });
});

// ── The token must not come back as an argv token ───────────────────────────

test('REGRESSION: server.js never builds the GitHub token into a tmux command', () => {
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  // The old shape was: extra.push('GH_TOKEN=' + t) folded into the `env …` tokens
  // handed to `tmux new-session`, which tmux then keeps as pane_start_command.
  assert.ok(!/['"`]GH_TOKEN=/.test(src), 'GH_TOKEN must never be concatenated into an env token list');
  assert.ok(!/GH_TOKEN=.*\+/.test(src), 'GH_TOKEN must never be built into a string with the value');
  // The supported delivery path is the 0600 rcfile.
  assert.match(src, /'--rcfile'/, 'the pane shell must source the credential env file');
});

test('the tmux credential stamp is a fingerprint, never the token', () => {
  const src = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  const stampLine = src.split('\n').find((l) => l.includes('set-option') && l.includes('CRED_KEY_OPTION'));
  assert.ok(stampLine, 'the session stamp should be set with tmux set-option');
  assert.ok(stampLine.includes('key'), 'only the fingerprint is stamped');
  // The option name must not collide with the markers pw-tmux-save filters on.
  assert.match(src, /@pw_cred_key/);
  assert.ok(!src.includes("'@pw_session_key'"), 'must not reuse the orchestrator lane marker');
});
