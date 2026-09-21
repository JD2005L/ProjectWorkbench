// Letting `gh` do the GitHub authorisation, and reading back what it stored.
//
// This is the route to prefer when gh is installed: gh IS an app GitHub trusts, so it
// needs no OAuth client id from us, and the token it produces is the one kind that has
// always done both jobs on this workbench — pushing and Copilot. PW implements none of
// the OAuth; it opens a terminal running the login AS THAT PERSON and then reads back
// what gh wrote into their own GH_CONFIG_DIR.
//
// The correctness of the read-back is the whole thing, and it rests on two behaviours of
// gh 2.101.0 that were measured rather than assumed:
//
//   1. `gh auth token` ECHOES AN AMBIENT GH_TOKEN. Per-user credentials already export
//      one into every pane, so an unsanitised read returns the token PW already had and
//      reports a brand-new login that never happened — a silent no-op that looks like
//      success. The environment has to be stripped.
//   2. With nothing stored, gh writes to stderr and leaves stdout EMPTY. So the answer is
//      decided by the shape of stdout; the exit code cannot carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import {
  GH_TOKEN_ENV_VARS, GH_DEFAULT_SCOPES,
  ghLoginCommand, looksLikeGithubToken, ghReadEnv, readStoredGhToken,
} from '../app/gh-cli.js';
import { applyCredentialJob, userGhConfigDir } from '../app/user-credentials.js';

const execFileAsync = promisify(execFileCb);
const SERVER = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// The command a person runs
// ---------------------------------------------------------------------------

test('the login command suits a box with no browser of its own', () => {
  const cmd = ghLoginCommand();
  // --web is gh's device flow: it prints a one-time code and a URL, which is the only
  // shape that works here.
  assert.match(cmd, /--web/);
  assert.match(cmd, /--hostname github\.com/);
  assert.match(cmd, /--git-protocol https/);
  // repo is what makes the result usable as a push credential, which is half the point.
  assert.match(cmd, new RegExp(`--scopes ${GH_DEFAULT_SCOPES.replace(/,/g, ',')}`));
  assert.match(GH_DEFAULT_SCOPES, /\brepo\b/);
  // --insecure-storage is deliberate: gh uses an OS credential store when it finds one
  // and plain text otherwise, and this container has no keyring — so being explicit
  // makes the result land somewhere `gh auth token` can always read it back, instead of
  // depending on the continued absence of a keyring.
  assert.match(cmd, /--insecure-storage/);
});

// ---------------------------------------------------------------------------
// Reading back what gh stored
// ---------------------------------------------------------------------------

test('the read environment strips every variable gh would prefer over stored state', () => {
  // This is the false-positive guard. Without it, a pane's own GH_TOKEN is echoed back
  // and adopted as a fresh login.
  const env = ghReadEnv({ GH_TOKEN: 'gho_AMBIENT', GITHUB_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'y', PATH: '/usr/bin' }, '/cred/gh');
  for (const key of GH_TOKEN_ENV_VARS) assert.equal(key in env, false, `${key} must be stripped`);
  assert.equal(env.GH_CONFIG_DIR, '/cred/gh', 'and the per-person config dir must be set');
  assert.equal(env.PATH, '/usr/bin', 'while the rest of the environment survives');
  assert.equal(env.GH_PROMPT_DISABLED, '1', 'gh must not try to be interactive from a request');
});

test('only something shaped like a token is accepted', () => {
  for (const good of ['gho_abc123', 'ghu_abc', 'ghp_abc', 'ghs_abc', 'github_pat_11ABC_def']) {
    assert.equal(looksLikeGithubToken(good), true, good);
  }
  // gh's own "nothing stored" message, an empty read, and anything with whitespace must
  // never be stored as somebody's credential.
  for (const bad of ['', '   ', 'no oauth token found for github.com', 'gho_ abc', 'hunter2', null, undefined]) {
    assert.equal(looksLikeGithubToken(bad), false, JSON.stringify(bad));
  }
});

/** A stub gh: prints whatever the script says for the env it was given. */
function stubGh({ stored = '', failExit = false } = {}) {
  return async (bin, args, opts) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args.slice(0, 2), ['auth', 'token']);
    // The stub deliberately honours the same precedence the real gh does, so a caller
    // that forgets to strip the environment fails this test the way it fails in life.
    const ambient = opts.env.GH_TOKEN || opts.env.GITHUB_TOKEN || '';
    if (ambient) return { stdout: ambient + '\n' };
    if (!stored) {
      if (failExit) { const e = new Error('exit 1'); e.stdout = ''; throw e; }
      return { stdout: '' };
    }
    return { stdout: stored + '\n' };
  };
}

test('a stored token is returned; nothing stored is "" rather than an error', async () => {
  assert.equal(await readStoredGhToken({ execFile: stubGh({ stored: 'gho_FRESH' }), ghConfigDir: '/c/gh' }), 'gho_FRESH');
  assert.equal(await readStoredGhToken({ execFile: stubGh({}), ghConfigDir: '/c/gh' }), '');
  // The common case arrives as a non-zero exit with empty stdout — that is "not yet",
  // not a failure, because it is what polling sees while somebody is still in their
  // browser.
  assert.equal(await readStoredGhToken({ execFile: stubGh({ failExit: true }), ghConfigDir: '/c/gh' }), '');
});

test('REGRESSION: an ambient GH_TOKEN must not be mistaken for a fresh login', async () => {
  // The bug this prevents: every pane already has GH_TOKEN exported by per-user
  // credentials, so reading without stripping returns the token PW already stored and
  // "captures" it again, reporting success while nothing happened.
  const got = await readStoredGhToken({
    execFile: stubGh({}), ghConfigDir: '/c/gh',
    env: { GH_TOKEN: 'gho_ALREADY_STORED', GITHUB_TOKEN: 'gho_ALSO' },
  });
  assert.equal(got, '', 'the ambient token must not be reported as stored');
});

test('no config dir means no answer, without shelling out at all', async () => {
  let called = false;
  const spy = async () => { called = true; return { stdout: 'gho_X' }; };
  assert.equal(await readStoredGhToken({ execFile: spy, ghConfigDir: '' }), '');
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Against the real gh, when it is installed
// ---------------------------------------------------------------------------

const ghInstalled = await execFileAsync('gh', ['--version']).then(() => true).catch(() => false);

test('REAL GH: an empty config dir reads as nothing stored', { skip: ghInstalled ? false : 'gh is not installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gh-'));
  try {
    assert.equal(await readStoredGhToken({ execFile: execFileAsync, ghConfigDir: dir, env: process.env }), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REAL GH: a token in hosts.yml is read back, and an ambient one is not', { skip: ghInstalled ? false : 'gh is not installed here' }, async () => {
  // Round-trips through the real binary, so a change in how gh stores or reports its
  // token breaks this rather than silently breaking capture.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gh-'));
  try {
    fs.writeFileSync(path.join(dir, 'hosts.yml'),
      'github.com:\n    oauth_token: gho_STORED_EXAMPLE\n    user: someone\n    git_protocol: https\n');
    assert.equal(await readStoredGhToken({ execFile: execFileAsync, ghConfigDir: dir, env: process.env }), 'gho_STORED_EXAMPLE');
    // And with an ambient token in the environment, the STORED one still wins, because
    // the environment is stripped before gh is asked.
    assert.equal(
      await readStoredGhToken({ execFile: execFileAsync, ghConfigDir: dir, env: { ...process.env, GH_TOKEN: 'gho_AMBIENT_WINS_IF_UNSTRIPPED' } }),
      'gho_STORED_EXAMPLE',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The per-person config directory
// ---------------------------------------------------------------------------

test('each person gets their own gh config dir, created with the rest of their tree', async () => {
  // Without this every gh login would overwrite one shared hosts.yml, and PW could not
  // tell whose token it was reading back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ghdir-'));
  try {
    const base = path.join(dir, 'pw-users');
    const out = await applyCredentialJob({ fsp, base, username: 'kevin.charlebois' });
    assert.equal(out.ghConfigDir, userGhConfigDir(base, 'kevin.charlebois'));
    const st = await fsp.stat(out.ghConfigDir);
    assert.equal(st.isDirectory(), true);
    assert.equal(st.mode & 0o777, 0o700, 'it holds a credential, so it is not group- or world-readable');
    assert.notEqual(userGhConfigDir(base, 'kevin.charlebois'), userGhConfigDir(base, 'james.levac'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the pane gets GH_CONFIG_DIR, so gh in a terminal is that person\'s gh', () => {
  assert.match(SERVER, /'GH_CONFIG_DIR=' \+ cred\.ghConfigDir/);
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

test('the terminal is opened AS THE TARGET, not as whoever pressed the button', () => {
  // gh writes into the config dir of the account the pane runs as, so a tab created on
  // the presser's credentials would authorise the wrong person into the wrong directory.
  const start = SERVER.indexOf("app.post(BASE + '/api/github-cli/connect'");
  assert.notEqual(start, -1);
  const body = SERVER.slice(start, SERVER.indexOf("app.post(BASE + '/api/github-cli/capture'", start));
  assert.match(body, /newTmuxWindow\(project, 'GitHub login', command, target\)/);
  // And when tabs cannot be keyed to a person, doing it for somebody else is refused
  // rather than silently writing into the wrong tree.
  assert.match(body, /PER_LAUNCHER_CLAUDE/);
  assert.match(body, /needs per-launcher credentials/);
  // The project is chosen from what the TARGET can reach, not the caller.
  assert.match(body, /filterProjectsForUser\(await loadProjects\(\), targetUser\)/);
});

test('capture verifies the token before adopting it, and never echoes it', () => {
  const start = SERVER.indexOf("app.post(BASE + '/api/github-cli/capture'");
  assert.notEqual(start, -1);
  const body = SERVER.slice(start, start + 2200);
  assert.match(body, /status:'pending'/, 'nothing stored yet is a normal answer while they finish');
  assert.match(body, /verifyToken\(/, 'which GitHub account it is must be established, not assumed');
  assert.match(body, /setUserGithubToken\(target, token, who\.login\)/);
  assert.doesNotMatch(body, /token,\s*scopes/, 'the token itself must not be returned');
  assert.match(body, /login: who\.login, scopes: who\.scopes/, 'only the account and scopes are reported');
});

test('the gh route needs no OAuth app of our own — that is the point of it', () => {
  const start = SERVER.indexOf("app.post(BASE + '/api/github-cli/connect'");
  const body = SERVER.slice(start, SERVER.indexOf("app.post(BASE + '/api/github-cli/capture'", start));
  assert.doesNotMatch(body, /GITHUB_OAUTH\.enabled/, 'a missing client id must not block the gh route');
  // It does require the tool, and says where to get it.
  assert.match(body, /deploy\/install-gh\.sh/);
});
