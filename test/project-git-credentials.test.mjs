// GOA-6 — the dashboard must not create root-owned artifacts inside an account-owned workspace.
//
// The confirmed product instance: `syncProjectCredentials` in app/server.js ran, in the dashboard
// process, `git -C <workspace> config --local …` three times and wrote
// `<workspace>/.git/.pw-credentials` with mode 0600. The dashboard is root in BOTH deploy modes
// (host: root node -> `sudo -u admin tmux`; container: root node -> setpriv), and the workspace and
// its `.git` belong to the unprivileged pane account — so each run left a root-owned `.git/config`
// and a root-owned credential file inside a tree the pane owns. The pane's own `git fetch` then
// failed with "cannot lock ref … Permission denied" and "fatal: failed to write object", and git
// could not read the credential file written for it. The clone path already chowns what it creates;
// this path did not.
//
// It is a privilege boundary as well as an ownership bug: Git config can name programs to execute
// (core.pager, credential.helper, core.fsmonitor), so a root write into a directory an unprivileged
// account controls is a symlink away from being a local escalation — the same reasoning that put the
// per-user credential tree behind app/credential-writer.mjs in the first place.
//
// What is NOT done, and is asserted here: no recursive chown of existing worktrees. Repairing
// ownership wholesale would rewrite files the product never created.
//
// Dependency-free: no express, no dashboard boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyProjectGitCredentials, credentialFilePath } from '../app/project-git-credentials.mjs';
import { credentialDropArgv } from '../app/user-credentials.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(REPO, 'app', 'credential-writer.mjs');
const TOKEN = 'ghp_testtoken0123456789';

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-gitcred-'));
  await execFileAsync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return dir;
}

// --- the module itself --------------------------------------------------------------------

test('configuring a workspace writes the store 0600 and uses only the project-local helper', async (t) => {
  const dir = await workspace();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const calls = [];
  const spyExec = async (bin, args) => { calls.push([bin, ...args]); return execFileAsync(bin, args); };
  const res = await applyProjectGitCredentials({ fsp, execFile: spyExec, projectPath: dir, token: TOKEN });

  assert.equal(res.action, 'configured');
  const credFile = credentialFilePath(dir);
  assert.equal(fs.existsSync(credFile), true);
  assert.equal((await fsp.stat(credFile)).mode & 0o777, 0o600, 'a token store must not be world- or group-readable');
  assert.match(await fsp.readFile(credFile, 'utf8'), /^https:\/\/.*:x-oauth-basic@github\.com$/m);

  // The reset entry is what stops the token being dispatched to — and duplicated into — an
  // inherited global store; `--add` twice rather than `--replace-all`, which would drop it.
  const helpers = (await execFileAsync('git', ['-C', dir, 'config', '--local', '--get-all', 'credential.helper'])).stdout;
  // The leading empty entry is deliberate and load-bearing, so only the trailing newline is dropped.
  assert.deepEqual(helpers.replace(/\n$/, '').split('\n'), ['', `store --file=${credFile}`]);

  assert.ok(calls.every((argv) => !argv.some((a) => a.includes(TOKEN))),
    'the token must never appear in a command line, where ps would publish it to every other user on the account');
});

test('clearing removes the store and the helper, and is idempotent', async (t) => {
  const dir = await workspace();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await applyProjectGitCredentials({ fsp, execFile: execFileAsync, projectPath: dir, token: TOKEN });
  const res = await applyProjectGitCredentials({ fsp, execFile: execFileAsync, projectPath: dir, token: '' });
  assert.equal(res.action, 'cleared');
  assert.equal(fs.existsSync(credentialFilePath(dir)), false);
  const after = await execFileAsync('git', ['-C', dir, 'config', '--local', '--get-all', 'credential.helper'])
    .catch((e) => ({ stdout: e.stdout ?? '' }));
  assert.equal(after.stdout.trim(), '');

  await applyProjectGitCredentials({ fsp, execFile: execFileAsync, projectPath: dir, token: '' });   // again
});

test('a project without a .git directory is a no-op, not an error', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-gitcred-bare-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const res = await applyProjectGitCredentials({ fsp, execFile: execFileAsync, projectPath: dir, token: TOKEN });
  assert.equal(res.skipped, 'no .git directory');
  assert.equal(fs.existsSync(credentialFilePath(dir)), false);
});

// --- the privilege-dropped path, with real processes --------------------------------------

/** Can we actually drop non-interactively on this host? Skipped by name rather than faked if not. */
async function canDrop(user) {
  try { await execFileAsync('sudo', ['-n', '-u', user, 'true'], { timeout: 5000 }); return true; }
  catch { return false; }
}

function runHelper(argv, job) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.stdin.end(JSON.stringify(job));
  });
}

test('REGRESSION: the git-credentials job runs through the drop and its artifacts are owned by the pane account', { timeout: 30000 }, async (t) => {
  const user = os.userInfo().username;
  if (!(await canDrop(user))) {
    t.skip(`real-process privilege drop not exercisable here: sudo will not run non-interactively as '${user}' on this host`);
    return;
  }
  const dir = await workspace();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const expected = os.userInfo().uid;

  // Exactly the argv app/server.js builds: the same helper, the same drop, for a named (host-mode)
  // owner. `sudo -n -u <account>` in host mode; `setpriv --reuid` when the owner came from
  // PW_TERMINAL_UID.
  const argv = credentialDropArgv({
    owner: { user, source: 'passwd' }, execPath: process.execPath, helperPath: HELPER,
  });
  assert.deepEqual(argv.slice(0, 4), ['/usr/bin/sudo', '-n', '-u', user],
    'the work must be handed to the account that owns the workspace, not done as the dashboard user');

  const res = await runHelper(argv, { action: 'git-credentials', projectPath: dir, ghToken: TOKEN });
  assert.equal(res.code, 0, `helper failed: ${res.err || res.out}`);
  const parsed = JSON.parse(res.out);
  assert.equal(parsed.ok, true, res.out);
  assert.equal(parsed.result.action, 'configured');

  // THE ASSERTION THIS EXISTS FOR: what the run created belongs to the pane account.
  for (const file of [credentialFilePath(dir), path.join(dir, '.git', 'config')]) {
    const st = await fsp.stat(file);
    assert.equal(st.uid, expected,
      `${path.basename(file)} must be owned by the account whose pane has to read and lock it, not by the dashboard`);
  }
  assert.equal((await fsp.stat(credentialFilePath(dir))).mode & 0o777, 0o600);

  // And the token still never reached a command line.
  assert.ok(!argv.some((a) => a.includes(TOKEN)));
});

test('the helper refuses a git-credentials job with no project path', { timeout: 20000 }, async () => {
  const res = await runHelper([process.execPath, HELPER], { action: 'git-credentials' });
  assert.notEqual(res.code, 0);
  assert.match(res.out || res.err, /no projectPath/);
});

// --- and the dashboard no longer does it itself --------------------------------------------

test('REGRESSION: app/server.js does not write workspace git config or the credential store directly', () => {
  const src = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  const start = src.indexOf('async function syncProjectCredentials');
  assert.ok(start > -1, 'syncProjectCredentials should still exist');
  const body = src.slice(start, src.indexOf('\n}', start));

  assert.ok(!/execFileAsync\('git',\s*\[\s*'-C'[^\]]*'config'/.test(body),
    'THE REGRESSION: running `git config --local` from the dashboard leaves a root-owned .git/config '
    + 'inside a workspace the pane account owns');
  assert.ok(!/fs\.writeFile\(\s*credFile/.test(body),
    'and writing the credential store from the dashboard leaves a root-owned 0600 file git cannot read');
  assert.match(body, /runCredentialJob\(\{ action: 'git-credentials'/,
    'the work must go through the established privilege-dropped helper');
  assert.match(body, /refusing to write git credentials as root/,
    'an unresolvable pane account must fail closed rather than fall back to a root write');
});

test('no recursive chown of existing worktrees was introduced as product behaviour', () => {
  const src = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  const start = src.indexOf('async function syncProjectCredentials');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(!/chown/.test(body),
    'repairing ownership wholesale would rewrite files the product never created; the fix is to stop '
    + 'creating root-owned ones');

  // The clone path's existing chown is of a directory the product just created, and is unchanged.
  // The three pre-existing recursive chowns all belong to the clone/init path, where the product has
  // just created the directory itself; they are unchanged by this repair. Pinning the count means a
  // new one has to be argued for rather than added quietly.
  const chowns = [...src.matchAll(/chown['"],\s*\['-R'/g)];
  assert.equal(chowns.length, 3, 'a fourth recursive chown would be repairing somebody else\'s worktree');
});
