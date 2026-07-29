// Per-user credential material: encoding, privilege drop, and the filesystem job.
//
// The security property under test is:
//
//   the root dashboard never performs a filesystem operation on a path the
//   shared unprivileged terminal account controls.
//
// Several tests below first DEMONSTRATE the vulnerability with the old code
// shape, then assert the current code does not have it. That is deliberate: a
// regression test for a symlink attack is only meaningful if it can be shown to
// catch the attack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  encodeUserName,
  decodeUserName,
  isEncodedUserName,
  userCredRoot,
  userClaudeConfigDir,
  userSessionEnvFile,
  credentialFingerprint,
  sessionCredentialState,
  renderSessionEnvFile,
  shSingleQuote,
  applyCredentialJob,
  pruneUserCredentials,
  credentialExecutionPlan,
  credentialDropArgv,
  spawnCredentialJob,
  ensureUserCredentials,
  CREDENTIALS_OFF,
} from '../app/user-credentials.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

async function tmpBase() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pw-cred-'));
}

// ---------------------------------------------------------------------------
// Injective username encoding
// ---------------------------------------------------------------------------

test('REGRESSION: ".", ".." and "_" are three different users, not one directory', () => {
  // The old safeUserName() replaced unsafe characters with '_' and collapsed
  // all-dot names to '_', so these three usernames shared one credential tree —
  // one Claude login and one GitHub token between three people.
  const segments = ['.', '..', '_'].map(encodeUserName);
  assert.deepEqual(segments, ['%2E', '%2E%2E', '_']);
  assert.equal(new Set(segments).size, 3);
});

test('encoding is injective across a hostile corpus', () => {
  const names = [
    '.', '..', '...', '_', '__', '%', '%2E', '%2e', 'a', 'A', 'a.b', 'a_b', 'a-b',
    'a/b', 'a\\b', 'a b', 'a\tb', 'a\nb', "a'b", 'a"b', 'a$b', 'a;b', 'a|b',
    'james-levac_goa', 'JAMES-LEVAC_GOA', 'user@example.com', 'DOMAIN\\user',
    'ünïcodé', '日本語', '../../etc/passwd', './x', 'x/../y', '',
  ];
  const seen = new Map();
  for (const name of names) {
    let encoded;
    try { encoded = encodeUserName(name); } catch { continue; } // '' is rejected
    assert.equal(seen.has(encoded), false, `collision: ${JSON.stringify(name)} and ${JSON.stringify(seen.get(encoded))} both -> ${encoded}`);
    seen.set(encoded, name);
    assert.equal(decodeUserName(encoded), name, `round-trip failed for ${JSON.stringify(name)}`);
  }
});

test('an encoded segment can never traverse out of the base', () => {
  for (const hostile of ['..', '.', '../..', '/etc/passwd', 'a/../../b', '....//']) {
    const seg = encodeUserName(hostile);
    assert.ok(!seg.includes('/'), `${seg} contains a separator`);
    assert.ok(!seg.includes(path.sep), `${seg} contains a separator`);
    assert.notEqual(seg, '.');
    assert.notEqual(seg, '..');
    const joined = path.join('/srv/pw-users', seg);
    assert.ok(joined.startsWith('/srv/pw-users/'), `${joined} escaped the base`);
  }
});

test('empty and over-long usernames are refused rather than silently folded', () => {
  assert.throws(() => encodeUserName(''), /must not be empty/);
  assert.throws(() => encodeUserName(null), /must not be empty/);
  assert.throws(() => encodeUserName('\u00e9'.repeat(200)), /too long/);
});

test('isEncodedUserName accepts only canonical encodings', () => {
  assert.equal(isEncodedUserName('%2E'), true);
  assert.equal(isEncodedUserName('james-levac_goa'), true);
  assert.equal(isEncodedUserName('%2e'), false);      // lowercase hex is not ours
  assert.equal(isEncodedUserName('%41'), false);      // 'A' escaped needlessly
  assert.equal(isEncodedUserName('a b'), false);
  assert.equal(isEncodedUserName(''), false);
  assert.equal(isEncodedUserName('..'), false);
});

test('path helpers compose off the encoded segment', () => {
  const base = '/srv/pw-users';
  assert.equal(userCredRoot(base, 'a.b'), '/srv/pw-users/a%2Eb');
  assert.equal(userClaudeConfigDir(base, 'a.b'), '/srv/pw-users/a%2Eb/claude');
  assert.equal(userSessionEnvFile(base, 'a.b'), '/srv/pw-users/a%2Eb/session-env.sh');
});

// ---------------------------------------------------------------------------
// Symlink / TOCTOU: root must not be usable as a confused deputy
// ---------------------------------------------------------------------------

test('REGRESSION: a planted session-env.sh symlink does not clobber its target', async () => {
  const base = await tmpBase();
  const victim = path.join(base, 'victim-root-owned');
  await fsp.writeFile(victim, 'ORIGINAL');

  const credRoot = userCredRoot(base, 'mallory');
  await fsp.mkdir(credRoot, { recursive: true });
  const envFile = userSessionEnvFile(base, 'mallory');
  await fsp.symlink(victim, envFile);

  // First, prove the attack is real against the old code shape (a plain write).
  await fsp.writeFile(envFile, 'PWNED-BY-OLD-CODE');
  assert.equal(await fsp.readFile(victim, 'utf8'), 'PWNED-BY-OLD-CODE',
    'sanity check: a naive writeFile does follow the symlink');

  // Reset and run the real code path.
  await fsp.writeFile(victim, 'ORIGINAL');
  await applyCredentialJob({ fsp, base, username: 'mallory', ghToken: 'ghp_secret' });

  assert.equal(await fsp.readFile(victim, 'utf8'), 'ORIGINAL', 'the symlink target was modified');
  const st = await fsp.lstat(envFile);
  assert.equal(st.isSymbolicLink(), false, 'the planted symlink survived');
  assert.equal(st.isFile(), true);
  assert.ok((await fsp.readFile(envFile, 'utf8')).includes('ghp_secret'));
  await fsp.rm(base, { recursive: true, force: true });
});

test('REGRESSION: a planted .claude.json symlink does not clobber its target', async () => {
  const base = await tmpBase();
  const victim = path.join(base, 'victim');
  await fsp.writeFile(victim, 'ORIGINAL');

  const configDir = userClaudeConfigDir(base, 'mallory');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.symlink(victim, path.join(configDir, '.claude.json'));

  await applyCredentialJob({ fsp, base, username: 'mallory' });

  assert.equal(await fsp.readFile(victim, 'utf8'), 'ORIGINAL');
  assert.equal((await fsp.lstat(path.join(configDir, '.claude.json'))).isSymbolicLink(), false);
  await fsp.rm(base, { recursive: true, force: true });
});

test('REGRESSION: a symlinked credential directory is refused, not followed', async () => {
  const base = await tmpBase();
  const outside = await tmpBase();
  await fsp.writeFile(path.join(outside, 'sentinel'), 'UNTOUCHED');

  // Mallory points her own credential root at somewhere she should not reach.
  await fsp.mkdir(base, { recursive: true });
  await fsp.symlink(outside, userCredRoot(base, 'mallory'));

  await assert.rejects(
    applyCredentialJob({ fsp, base, username: 'mallory', ghToken: 'ghp_secret' }),
    /symlinked credential path/,
  );
  assert.equal(await fsp.readFile(path.join(outside, 'sentinel'), 'utf8'), 'UNTOUCHED');
  assert.deepEqual(await fsp.readdir(outside), ['sentinel'], 'wrote into the symlink target');

  await fsp.rm(base, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

test('the credential job never chowns — the writer already owns what it makes', async () => {
  const src = await fsp.readFile(path.join(APP_DIR, 'user-credentials.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function applyCredentialJob'));
  assert.equal(/\bchown\b/.test(body), false,
    'applyCredentialJob must not chown: a root chown on an attacker-controlled path is the escalation primitive we removed');
});

test('modes are 0700 on directories and 0600 on files', async () => {
  const base = await tmpBase();
  const r = await applyCredentialJob({ fsp, base, username: 'a.user', ghToken: 'ghp_x' });
  const mode = async (p) => (await fsp.stat(p)).mode & 0o777;
  assert.equal(await mode(userCredRoot(base, 'a.user')), 0o700);
  assert.equal(await mode(r.configDir), 0o700);
  assert.equal(await mode(path.join(r.configDir, '.claude.json')), 0o600);
  assert.equal(await mode(r.envFile), 0o600);
  await fsp.rm(base, { recursive: true, force: true });
});

test('a pre-existing world-readable credential dir is tightened to 0700', async () => {
  const base = await tmpBase();
  // What `mkdir -p` under a default umask leaves behind, e.g. from an earlier
  // build or an operator creating the tree by hand.
  await fsp.mkdir(userClaudeConfigDir(base, 'loose'), { recursive: true, mode: 0o755 });
  await fsp.chmod(userCredRoot(base, 'loose'), 0o755);
  await fsp.chmod(userClaudeConfigDir(base, 'loose'), 0o755);

  await applyCredentialJob({ fsp, base, username: 'loose', ghToken: 'ghp_x' });

  const mode = async (p) => (await fsp.stat(p)).mode & 0o777;
  assert.equal(await mode(userCredRoot(base, 'loose')), 0o700);
  assert.equal(await mode(userClaudeConfigDir(base, 'loose')), 0o700);
  await fsp.rm(base, { recursive: true, force: true });
});

test('an existing config is never clobbered, and a removed token drops the env file', async () => {
  const base = await tmpBase();
  const first = await applyCredentialJob({ fsp, base, username: 'u', ghToken: 'ghp_x' });
  assert.equal(first.seeded, true);
  await fsp.writeFile(path.join(first.configDir, '.claude.json'), '{"mine":true}');

  const second = await applyCredentialJob({ fsp, base, username: 'u', ghToken: '' });
  assert.equal(second.seeded, false);
  assert.equal(JSON.parse(await fsp.readFile(path.join(first.configDir, '.claude.json'), 'utf8')).mine, true);
  assert.equal(second.envFile, '');
  await assert.rejects(fsp.stat(first.envFile), /ENOENT/, 'a revoked token must not stay on disk');
  await fsp.rm(base, { recursive: true, force: true });
});

test('MCP servers are seeded from the shared config', async () => {
  const base = await tmpBase();
  const shared = path.join(base, 'shared.json');
  await fsp.writeFile(shared, JSON.stringify({ mcpServers: { teamkb: { command: 'x' } }, other: 1 }));
  const r = await applyCredentialJob({ fsp, base, username: 'u', sharedClaudeJson: shared });
  const cfg = JSON.parse(await fsp.readFile(path.join(r.configDir, '.claude.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['teamkb']);
  assert.equal('other' in cfg, false, 'only mcpServers should be carried over');
  await fsp.rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Privilege drop
// ---------------------------------------------------------------------------

test('execution plan drops only when the owner is somebody else', () => {
  assert.equal(credentialExecutionPlan({ owner: null }).drop, false);
  assert.equal(credentialExecutionPlan({ owner: null }).reason, 'shared-account');
  assert.equal(credentialExecutionPlan({ owner: { uid: 1001 }, currentUid: 1001 }).drop, false);
  assert.equal(credentialExecutionPlan({ owner: { uid: 1001 }, currentUid: 1001 }).reason, 'already-owner');
  assert.equal(credentialExecutionPlan({ owner: { uid: 1001 }, currentUid: 0 }).drop, true);
  // A missing currentUid must not be mistaken for uid 0.
  assert.equal(credentialExecutionPlan({ owner: { uid: 1001 }, currentUid: null }).drop, true);
});

test('drop argv matches the mechanism PW already uses in each mode', () => {
  const container = credentialDropArgv({
    owner: { uid: 1001, gid: 1001, user: 'admin', source: 'PW_TERMINAL_UID' },
    execPath: '/usr/bin/node', helperPath: '/opt/pw/app/credential-writer.mjs',
  });
  assert.deepEqual(container, ['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--init-groups', '/usr/bin/node', '/opt/pw/app/credential-writer.mjs']);

  const host = credentialDropArgv({
    owner: { uid: 1001, gid: 1001, user: 'admin', source: 'passwd' },
    execPath: '/usr/bin/node', helperPath: '/opt/pw/app/credential-writer.mjs',
  });
  assert.deepEqual(host, ['/usr/bin/sudo', '-n', '-u', 'admin', '/usr/bin/node', '/opt/pw/app/credential-writer.mjs']);

  assert.throws(() => credentialDropArgv({ owner: { uid: 1, source: 'passwd' }, execPath: 'n', helperPath: 'h' }), /account name/);
  assert.throws(() => credentialDropArgv({ owner: null, execPath: 'n', helperPath: 'h' }), /owner required/);
});

test('SECURITY: no secret ever reaches the helper argv', () => {
  const argv = credentialDropArgv({
    owner: { uid: 1001, gid: 1001, user: 'admin', source: 'passwd' },
    execPath: '/usr/bin/node', helperPath: '/opt/pw/app/credential-writer.mjs',
  });
  // The argv is a pure function of owner + paths; it cannot carry a token
  // because it is not given one.
  assert.equal(credentialDropArgv.length, 1);
  for (const arg of argv) assert.equal(/gh[pousr]_/.test(arg), false);
});

test('the helper does the job, taking the token on stdin and not on its command line', async () => {
  const base = await tmpBase();
  const helper = path.join(APP_DIR, 'credential-writer.mjs');
  const token = 'ghp_STDIN_ONLY_TOKEN_123';

  const result = await spawnCredentialJob({
    spawn,
    argv: [process.execPath, helper],
    job: { action: 'ensure', base, username: 'over.stdin', ghToken: token },
  });

  assert.equal(result.configDir, userClaudeConfigDir(base, 'over.stdin'));
  assert.ok((await fsp.readFile(result.envFile, 'utf8')).includes(token));
  await fsp.rm(base, { recursive: true, force: true });
});

test('the helper reports failure rather than exiting silently', async () => {
  const helper = path.join(APP_DIR, 'credential-writer.mjs');
  await assert.rejects(
    spawnCredentialJob({ spawn, argv: [process.execPath, helper], job: { nope: true } }),
    /malformed job/,
  );
});

test('ensureUserCredentials delegates to the helper exactly when a drop is required', async () => {
  const base = await tmpBase();
  const calls = [];
  const runJob = async (job, plan) => { calls.push({ job, plan }); return { configDir: '/x', envFile: '/y', seeded: true }; };

  // Same account: runs in-process, helper untouched.
  const inProc = await ensureUserCredentials({
    fsp, base, username: 'u', ghToken: 'ghp_a', owner: { uid: 1001 }, currentUid: 1001, runJob,
  });
  assert.equal(calls.length, 0);
  assert.equal(inProc.configDir, userClaudeConfigDir(base, 'u'));

  // Different account: delegated, and the token travels inside the job payload.
  const dropped = await ensureUserCredentials({
    fsp, base, username: 'u', ghToken: 'ghp_b', owner: { uid: 1001, source: 'passwd', user: 'admin' }, currentUid: 0, runJob,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].job.ghToken, 'ghp_b');
  assert.equal(calls[0].plan.drop, true);
  assert.equal(dropped.configDir, '/x');
  await fsp.rm(base, { recursive: true, force: true });
});

test('a failing helper rejects so the caller can fall back to the shared login', async () => {
  await assert.rejects(ensureUserCredentials({
    fsp, base: '/tmp/nope', username: 'u', owner: { uid: 1 }, currentUid: 0,
    runJob: async () => { throw new Error('setpriv: Operation not permitted'); },
  }), /Operation not permitted/);
});

// ---------------------------------------------------------------------------
// Pruning stale credential trees
// ---------------------------------------------------------------------------

test('prune removes trees for departed users and keeps current ones', async () => {
  const base = await tmpBase();
  for (const u of ['stays', 'goes', 'a.dotted']) await applyCredentialJob({ fsp, base, username: u, ghToken: 'ghp_x' });

  const { removed } = await pruneUserCredentials({ fsp, base, keep: ['stays', 'a.dotted'] });
  assert.deepEqual(removed, ['goes']);
  assert.ok(fs.existsSync(userCredRoot(base, 'stays')));
  assert.ok(fs.existsSync(userCredRoot(base, 'a.dotted')));
  assert.equal(fs.existsSync(userCredRoot(base, 'goes')), false);
  await fsp.rm(base, { recursive: true, force: true });
});

test('SAFETY: prune never deletes anything that is not one of our trees', async () => {
  const base = await tmpBase();
  await applyCredentialJob({ fsp, base, username: 'real', ghToken: 'ghp_x' });
  // Things that must survive a prune even though no user claims them.
  await fsp.mkdir(path.join(base, 'Documents'));                 // encodable name, but not our layout
  await fsp.writeFile(path.join(base, 'Documents', 'a.txt'), 'x');
  await fsp.mkdir(path.join(base, '.ssh'));                      // not an encoded name at all
  await fsp.writeFile(path.join(base, 'loose-file'), 'x');

  const { removed } = await pruneUserCredentials({ fsp, base, keep: [] });
  assert.deepEqual(removed, ['real']);
  assert.ok(fs.existsSync(path.join(base, 'Documents', 'a.txt')));
  assert.ok(fs.existsSync(path.join(base, '.ssh')));
  assert.ok(fs.existsSync(path.join(base, 'loose-file')));
  await fsp.rm(base, { recursive: true, force: true });
});

test('prune on a base that does not exist is a no-op', async () => {
  assert.deepEqual((await pruneUserCredentials({ fsp, base: '/tmp/pw-does-not-exist-xyz', keep: [] })).removed, []);
});

// ---------------------------------------------------------------------------
// Session env file and fingerprints
// ---------------------------------------------------------------------------

test('the session env file exports the token and quotes it safely', () => {
  const out = renderSessionEnvFile({ GH_TOKEN: "gh'p_weird" });
  assert.match(out, /export GH_TOKEN='gh'\\''p_weird'/);
  assert.equal(renderSessionEnvFile({ GH_TOKEN: '' }).includes('export'), false);
});

test('shSingleQuote survives a quote-injection attempt', () => {
  assert.equal(shSingleQuote("a'; rm -rf /; '"), `'a'\\''; rm -rf /; '\\'''`);
});

test('the fingerprint is a hash, not the token', () => {
  const fp = credentialFingerprint({ username: 'u', configDir: '/d', ghToken: 'ghp_supersecret' });
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp.includes('supersecret'), false);
  assert.notEqual(fp, credentialFingerprint({ username: 'u', configDir: '/d', ghToken: 'ghp_other' }));
  assert.equal(fp, credentialFingerprint({ username: 'u', configDir: '/d', ghToken: 'ghp_supersecret' }));
});

test('session drift is reported only when it is actionable', () => {
  const off = CREDENTIALS_OFF;
  assert.equal(sessionCredentialState({ perUserEnabled: false, desiredKey: 'abc', stampedKey: '' }).stale, false);
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc', stampedKey: 'abc' }).stale, false);
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc', stampedKey: 'old' }).stale, true);
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc', stampedKey: 'old' }).reason, 'changed');
  // An unstamped session with nothing to be stale about should not raise a flag.
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: off, stampedKey: '' }).stale, false);
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc', stampedKey: '' }).stale, true);
  assert.equal(sessionCredentialState({ perUserEnabled: true, desiredKey: 'abc', stampedKey: '' }).reason, 'unstamped');
});

// ---------------------------------------------------------------------------
// Source guards — these encode decisions that are easy to undo by accident
// ---------------------------------------------------------------------------

test('SECURITY: the token is never folded into the tmux env argv', async () => {
  const src = await fsp.readFile(path.join(APP_DIR, 'server.js'), 'utf8');
  assert.equal(/GH_TOKEN=['"`]?\s*\+/.test(src), false,
    'GH_TOKEN must not be concatenated into an argv token: tmux keeps pane_start_command for the life of the pane');
  assert.match(src, /--rcfile/, 'the token is delivered by sourcing a 0600 rcfile instead');
});

test('SECURITY: the dashboard hands credential work to the dropped helper', async () => {
  const src = await fsp.readFile(path.join(APP_DIR, 'server.js'), 'utf8');
  assert.match(src, /runJob:\s*runCredentialJob/, 'ensureUserCredentials must be given the privilege-dropping runner');
  assert.match(src, /credentialDropArgv/);
  assert.match(src, /currentUid:\s*process\.getuid/, 'the drop decision needs the real uid');
});
