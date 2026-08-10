// Candidate A — the credential artifact itself: created, replaced, removed, repaired.
//
// GOA-6. `syncProjectCredentials` wrote `<workspace>/.git/.pw-credentials` and ran `git config
// --local` mutations from the dashboard process — root in both deploy modes — into a tree the
// unprivileged pane account owns. GOA found the consequence live: one root-owned `0600` helper
// inside a pane-owned `.git`. Two defects at once. A decrypted credential written by root into a
// directory a lesser-privileged account controls, and a file that account cannot read, so git
// authentication silently fails for the very user the credential belongs to.
//
// Chown-after-write is not the repair. It does nothing about the window between `open` and `chown`,
// and nothing at all about WHERE the write landed — if the account replaced the target with a
// symlink first, root already followed it. So the write happens as the workspace owner, the kernel
// refuses to follow anything, and publication is atomic so no crash can leave a partial credential
// or a wrong mode behind.
//
// Pinned here, in the order an attacker would try them:
//
//   symlink            target, or `.git` itself, is a link — refuse; never write through it
//   non-regular        target is a fifo/dir/device — refuse (and never block on opening a fifo)
//   hard link          target has another name — refuse; someone else holds it
//   path substitution  target is swapped after validation — the rename wins, not the stale check
//   ownership          `.git` is not owned by the expected account — refuse
//   atomicity          an interrupted write publishes nothing and keeps the working credential
//   secret reflection  no message, stack, code, or return value ever contains the token
//
// Dependency-free: no express, no dashboard boot, so any lane can run it against the same SHA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  writeCredentialStore, removeCredentialStore, inspectCredentialStore,
  CREDENTIAL_FILENAME, CredentialBoundaryError, credentialStorePath,
} from '../app/git-credential-store.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Distinctive, so "did the secret leak" is a substring search rather than a judgement call.
const TOKEN = 'ghp_CANARY_0123456789_do_not_reflect';
const ME = os.userInfo().uid;

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-cred-'));
  await execFileAsync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return dir;
}
const storePath = (ws) => path.join(ws, '.git', CREDENTIAL_FILENAME);
const strays = async (ws) => (await fsp.readdir(path.join(ws, '.git')))
  .filter((f) => f.startsWith(CREDENTIAL_FILENAME) && f !== CREDENTIAL_FILENAME);

/** Every observable surface of a failure. None of it may contain the token. */
function surfaces(err) {
  let json = '';
  try { json = JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})); } catch { /* circular */ }
  return [err?.message, err?.stack, err?.code, err?.reason, err?.path, json, String(err)].join('\n');
}

async function expectRefusal(fn, pattern) {
  let caught;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected a refusal, got success');
  assert.ok(caught instanceof CredentialBoundaryError,
    `refusals must be distinguishable from crashes; got ${caught?.constructor?.name}: ${caught?.message}`);
  if (pattern) assert.match(caught.reason || caught.message, pattern);
  assert.ok(!surfaces(caught).includes(TOKEN), 'a refusal must never reflect the token');
  return caught;
}

// --- the happy path, and what it guarantees --------------------------------------------------

test('a fresh store is created 0600, owned by the running account, with exactly the expected content', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));

  const res = await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  assert.equal(res.action, 'written');
  assert.equal(credentialStorePath(ws), storePath(ws));

  const st = await fsp.lstat(storePath(ws));
  assert.equal(st.isFile(), true);
  assert.equal(st.mode & 0o777, 0o600, 'a token store must never be group- or world-readable');
  assert.equal(st.uid, ME, 'it must belong to the account whose git has to read it');
  assert.equal(st.nlink, 1);
  assert.equal(await fsp.readFile(storePath(ws), 'utf8'), `https://${TOKEN}:x-oauth-basic@github.com\n`);
});

test('replacing an existing store is a rename, not an in-place rewrite, and leaves no temp behind', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));

  await writeCredentialStore({ projectPath: ws, token: 'ghp_first', expectUid: ME });
  const firstIno = (await fsp.lstat(storePath(ws))).ino;
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });

  const st = await fsp.lstat(storePath(ws));
  assert.notEqual(st.ino, firstIno,
    'in-place truncate+write leaves a window where the file is empty or half-written and still readable');
  assert.equal(st.mode & 0o777, 0o600);
  assert.match(await fsp.readFile(storePath(ws), 'utf8'), /CANARY/);
  assert.deepEqual(await strays(ws), []);
});

test('removal deletes the store and is idempotent', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  assert.equal((await removeCredentialStore({ projectPath: ws, expectUid: ME })).action, 'removed');
  assert.equal(fs.existsSync(storePath(ws)), false);
  assert.equal((await removeCredentialStore({ projectPath: ws, expectUid: ME })).action, 'absent');
});

// --- symlinks ---------------------------------------------------------------------------------

test('REGRESSION: a symlink planted at the target is refused, and its target is never written', async (t) => {
  const ws = await workspace();
  const victim = path.join(ws, 'victim.txt');
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.writeFile(victim, 'ORIGINAL\n');
  await fsp.symlink(victim, storePath(ws));

  await expectRefusal(() => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME }), /symlink/i);
  assert.equal(await fsp.readFile(victim, 'utf8'), 'ORIGINAL\n',
    'THE ATTACK: root following a planted link writes a decrypted credential into an arbitrary file');
  assert.equal((await fsp.lstat(storePath(ws))).isSymbolicLink(), true,
    'and a refusal must not quietly clean up the evidence either');
});

test('REGRESSION: a symlinked .git is refused before anything inside it is opened', async (t) => {
  const ws = await workspace();
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-elsewhere-'));
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  t.after(() => fsp.rm(elsewhere, { recursive: true, force: true }));
  await fsp.rm(path.join(ws, '.git'), { recursive: true, force: true });
  await fsp.symlink(elsewhere, path.join(ws, '.git'));

  await expectRefusal(() => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME }), /symlink|not a directory/i);
  assert.deepEqual(await fsp.readdir(elsewhere), [], 'nothing may be created through a linked .git');
});

test('removal unlinks a planted symlink as a link, and reports it distinctly', async (t) => {
  const ws = await workspace();
  const victim = path.join(ws, 'keepme.txt');
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.writeFile(victim, 'KEEP\n');
  await fsp.symlink(victim, storePath(ws));

  const res = await removeCredentialStore({ projectPath: ws, expectUid: ME });
  assert.equal(res.action, 'removed-unsafe');
  assert.equal(fs.existsSync(victim), true, 'unlinking a link must never delete what it points at');
  assert.equal(fs.existsSync(storePath(ws)), false);
});

// --- non-regular files and hard links ----------------------------------------------------------

test('REGRESSION: a non-regular target (fifo) is refused rather than opened', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  try {
    await execFileAsync('mkfifo', [storePath(ws)]);
  } catch {
    t.skip('mkfifo is unavailable here, so the non-regular case cannot be constructed');
    return;
  }
  // Opening a fifo for writing blocks until a reader appears — refusing on type is also what stops
  // this call hanging the dashboard forever.
  await expectRefusal(() => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME }), /regular file/i);
});

test('REGRESSION: a hard-linked target is refused — someone else holds the other name', async (t) => {
  const ws = await workspace();
  const other = path.join(ws, 'other-name');
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.writeFile(storePath(ws), 'placeholder\n', { mode: 0o600 });
  await fsp.link(storePath(ws), other);

  await expectRefusal(() => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME }), /hard link|link count/i);
  assert.ok(!(await fsp.readFile(other, 'utf8')).includes(TOKEN),
    'writing through a hard link publishes the credential under a name the writer does not control');
});

// --- ownership ---------------------------------------------------------------------------------

test('REGRESSION: a .git owned by another account is refused', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await expectRefusal(
    () => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME + 4242 }),
    /owner/i,
  );
  assert.equal(fs.existsSync(storePath(ws)), false);
});

test('an existing store owned by another account is displaced, never written through', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  // The live GOA shape: a foreign-owned 0600 file inside a correctly-owned .git. Replacement is
  // safe only because it is a rename over the NAME, never an open-and-write of that inode.
  await fsp.writeFile(storePath(ws), 'foreign stand-in\n', { mode: 0o600 });
  const res = await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME, foreignUid: ME + 4242 });
  assert.equal(res.action, 'written');
  assert.equal(res.displacedForeign, true, 'the caller has to be told an unexpected artifact was displaced');
  const st = await fsp.lstat(storePath(ws));
  assert.equal(st.uid, ME);
  assert.equal(st.mode & 0o777, 0o600);
});

// --- path substitution ---------------------------------------------------------------------------

test('REGRESSION: swapping the target after validation cannot redirect the credential', async (t) => {
  const ws = await workspace();
  const victim = path.join(ws, 'swap-victim.txt');
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.writeFile(victim, 'ORIGINAL\n');

  // The classic TOCTOU: a regular file passes validation, then becomes a symlink before the write.
  // The pre-check is defence in depth; the guarantee is that content goes to a NEW file opened
  // O_EXCL|O_NOFOLLOW and is published by rename, which resolves the name once and never follows a
  // link. Passing a stale inspection proves the guarantee holds with the check switched off.
  await fsp.writeFile(storePath(ws), 'looks fine\n', { mode: 0o600 });
  const stale = await inspectCredentialStore({ projectPath: ws });
  assert.equal(stale.kind, 'regular');

  await fsp.rm(storePath(ws));
  await fsp.symlink(victim, storePath(ws));               // the swap, after inspection
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME, alreadyInspected: stale });

  assert.equal(await fsp.readFile(victim, 'utf8'), 'ORIGINAL\n',
    'a stale inspection must not authorise writing through whatever the name points at now');
  const st = await fsp.lstat(storePath(ws));
  assert.equal(st.isSymbolicLink(), false, 'the rename must have replaced the planted link with a real file');
  assert.equal(st.uid, ME);
  assert.equal(st.mode & 0o777, 0o600);
});

// --- atomicity -------------------------------------------------------------------------------------

test('REGRESSION: a write that fails mid-flight publishes nothing and keeps the working credential', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: 'ghp_previous_good', expectUid: ME });
  const before = await fsp.readFile(storePath(ws), 'utf8');

  await expectRefusal(
    // Injected at the last possible moment: content written and fsynced, not yet published.
    () => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME, failBeforePublish: true }),
    /interrupted|publish/i,
  );

  assert.equal(await fsp.readFile(storePath(ws), 'utf8'), before,
    'a failed rotation must leave the working credential in place, not a truncated one');
  assert.deepEqual(await strays(ws), [], 'and must not leave a temp file holding the new token');
});

// --- concurrency -------------------------------------------------------------------------------------

test('concurrent rotations converge on one intact store, never a blend of two tokens', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));

  const tokens = Array.from({ length: 12 }, (_, i) => `ghp_concurrent_${i}`);
  await Promise.all(tokens.map((tok) => writeCredentialStore({ projectPath: ws, token: tok, expectUid: ME })));

  // Parse the token out rather than substring-matching the body: `ghp_concurrent_1` is a prefix of
  // `ghp_concurrent_10`, so a naive `includes` reports two survivors for a perfectly intact file.
  // The property under test is that the content is exactly one writer's line, start to end.
  const body = await fsp.readFile(storePath(ws), 'utf8');
  const parsed = /^https:\/\/(.+):x-oauth-basic@github\.com\n$/.exec(body);
  assert.ok(parsed, `the store must hold exactly one complete credential line, got: ${JSON.stringify(body)}`);
  assert.ok(tokens.includes(parsed[1]),
    `the surviving token must be exactly one writer's, not a blend: ${JSON.stringify(parsed[1])}`);
  assert.equal((await fsp.lstat(storePath(ws))).mode & 0o777, 0o600);
  assert.deepEqual(await strays(ws), [], 'every concurrent writer must clean up its own temp file');
});

test('a removal racing rotations ends in a definite state, never a partial file', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await Promise.all([
    writeCredentialStore({ projectPath: ws, token: 'ghp_race_a', expectUid: ME }),
    removeCredentialStore({ projectPath: ws, expectUid: ME }),
    writeCredentialStore({ projectPath: ws, token: 'ghp_race_b', expectUid: ME }),
    removeCredentialStore({ projectPath: ws, expectUid: ME }),
  ]);
  if (fs.existsSync(storePath(ws))) {
    const body = await fsp.readFile(storePath(ws), 'utf8');
    assert.match(body, /^https:\/\/ghp_race_[ab]:x-oauth-basic@github\.com\n$/, `partial content survived: ${body}`);
    assert.equal((await fsp.lstat(storePath(ws))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await strays(ws), []);
});

// --- secret non-reflection ------------------------------------------------------------------------------

test('REGRESSION: no failure path reflects the token in any observable surface', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));

  const cases = [
    ['no .git at all', async () => {
      const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-bare-'));
      try { return await writeCredentialStore({ projectPath: bare, token: TOKEN, expectUid: ME }); }
      finally { await fsp.rm(bare, { recursive: true, force: true }); }
    }],
    ['wrong ownership', () => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME + 4242 })],
    ['relative path', () => writeCredentialStore({ projectPath: 'relative/path', token: TOKEN, expectUid: ME })],
    ['interrupted publish', () => writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME, failBeforePublish: true })],
  ];
  for (const [name, fn] of cases) {
    let caught;
    try { await fn(); } catch (e) { caught = e; }
    assert.ok(caught, `${name}: expected a refusal`);
    assert.ok(!surfaces(caught).includes(TOKEN), `${name}: the token leaked into an error surface`);
    assert.ok(!surfaces(caught).includes('CANARY'), `${name}: a fragment of the token leaked`);
  }

  // The success path must not return it either — callers log results.
  const res = await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  assert.ok(!JSON.stringify(res).includes('CANARY'), 'the result object is logged by callers');
});

test('inspection reports what is there without reading or echoing the contents', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));

  assert.equal((await inspectCredentialStore({ projectPath: ws })).kind, 'absent');
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  const reg = await inspectCredentialStore({ projectPath: ws });
  assert.equal(reg.kind, 'regular');
  assert.equal(reg.uid, ME);
  assert.equal(reg.mode, 0o600);
  assert.ok(!JSON.stringify(reg).includes('CANARY'), 'inspection must never surface content');

  await fsp.rm(storePath(ws));
  await fsp.symlink(path.join(ws, 'anything'), storePath(ws));
  assert.equal((await inspectCredentialStore({ projectPath: ws })).kind, 'symlink');
});

test('a relative or empty project path is refused outright', async () => {
  await expectRefusal(() => writeCredentialStore({ projectPath: 'not/absolute', token: TOKEN, expectUid: ME }), /absolute/i);
  await expectRefusal(() => removeCredentialStore({ projectPath: '', expectUid: ME }), /absolute|required/i);
});

test('this module spawns nothing at all — there is no shell to quote into', () => {
  const src = fs.readFileSync(path.join(REPO, 'app', 'git-credential-store.mjs'), 'utf8');
  assert.ok(!/child_process/.test(src), 'the store touches the filesystem directly');
  assert.ok(!/shell\s*:\s*true/.test(src));
});
