// Repairing what the old root-write path already left on disk, and proving the dashboard no longer
// creates more of it.
//
// Fixing the write path stops new bad artifacts; the ones already there stay broken. GOA has at
// least one live: a root-owned `0600` `.pw-credentials` inside a pane-owned `.git`. That file is
// unreadable by the account whose credential it is, so git authentication silently fails there.
//
// The repair is REPLACE-AS-THE-OWNER, never chown. Root chowning a file inside a directory the pane
// account controls repeats the original mistake — the path can be swapped underneath — and needs
// root at the moment we are trying to stop using it. A recursive chown of the workspace is worse
// still: it rewrites files the product never created. Unlinking and rewriting as the owner needs no
// privilege at all, because the account owns the containing directory whoever owns the file.
//
// Dependency-free. The genuinely-differing-account evidence lives in
// test/credential-boundary-real.test.mjs, which the PVI2 lane owns.
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
  inventoryCredentialArtifacts, remediateCredentialArtifact, classifyWorkspace, CREDENTIAL_FILENAME,
} from '../app/credential-remediation.mjs';
import { writeCredentialStore } from '../app/git-credential-store.mjs';

/**
 * Source with comments removed. These modules deliberately EXPLAIN why they do not chown and do not
 * glob, and a check that cannot tell an explanation from an implementation would force the next
 * person to delete the explanation to make the test pass.
 */
function code(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('#')).join('\n');
}

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ghp_CANARY_remediation_0123456789';
const ME = os.userInfo().uid;
const store = (ws) => path.join(ws, '.git', CREDENTIAL_FILENAME);

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-remed-'));
  await execFileAsync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  return dir;
}

// --- inventory ---------------------------------------------------------------------------------

test('inventory classifies what needs repair, and reports nothing about contents', async (t) => {
  const clean = await workspace();
  const wrongMode = await workspace();
  const linked = await workspace();
  const absent = await workspace();
  const noGit = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-remed-nogit-'));
  t.after(() => Promise.all([clean, wrongMode, linked, absent, noGit].map((d) => fsp.rm(d, { recursive: true, force: true }))));

  await writeCredentialStore({ projectPath: clean, token: TOKEN, expectUid: ME });
  await writeCredentialStore({ projectPath: wrongMode, token: TOKEN, expectUid: ME });
  await fsp.chmod(store(wrongMode), 0o644);
  await fsp.symlink(path.join(linked, 'somewhere'), store(linked));

  const { scanned, findings } = await inventoryCredentialArtifacts({
    projectPaths: [clean, wrongMode, linked, absent, noGit], expectUid: ME,
  });
  assert.equal(scanned, 5);
  const by = Object.fromEntries(findings.map((f) => [f.projectPath, f]));

  assert.equal(by[clean].status, 'ok');
  assert.equal(by[wrongMode].status, 'needs-remediation');
  assert.match(by[wrongMode].reasons.join(), /mode is 644/);
  assert.equal(by[linked].status, 'unsafe-artifact');
  assert.equal(by[linked].kind, 'symlink');
  assert.equal(by[absent], undefined, 'a workspace with no artifact is not a finding');
  assert.equal(by[noGit], undefined, 'a project that is not cloned yet is not a finding');

  assert.ok(!JSON.stringify(findings).includes('CANARY'), 'an inventory report must never carry credential material');
});

test('a workspace whose .git is owned by another account is reported, never forced', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });

  const { findings } = await inventoryCredentialArtifacts({ projectPaths: [ws], expectUid: ME + 4242 });
  assert.equal(findings[0].status, 'unsafe-workspace');
  assert.match(findings[0].reason, /owned by uid/);

  const res = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME + 4242, token: TOKEN });
  assert.equal(res.action, 'skipped');
  assert.equal(fs.existsSync(store(ws)), true, 'a workspace we do not understand must be left exactly as found');
});

test('classifyWorkspace refuses a symlinked workspace or .git without following either', async (t) => {
  const real = await workspace();
  const linkedWs = path.join(os.tmpdir(), `pw-remed-link-${Date.now()}`);
  t.after(() => fsp.rm(real, { recursive: true, force: true }));
  t.after(() => fsp.rm(linkedWs, { force: true }).catch(() => {}));
  await fsp.symlink(real, linkedWs);
  assert.match((await classifyWorkspace({ projectPath: linkedWs, expectUid: ME })).reason, /symlink/);

  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.rm(path.join(ws, '.git'), { recursive: true, force: true });
  await fsp.symlink(real, path.join(ws, '.git'));
  assert.match((await classifyWorkspace({ projectPath: ws, expectUid: ME })).reason, /\.git is a symlink/);

  assert.match((await classifyWorkspace({ projectPath: 'relative', expectUid: ME })).reason, /absolute/);
});

// --- migration ----------------------------------------------------------------------------------

test('REGRESSION: a wrong-mode artifact is replaced, not chmod-ed in place', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  await fsp.chmod(store(ws), 0o644);
  const before = (await fsp.lstat(store(ws))).ino;

  const res = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: TOKEN });
  assert.equal(res.action, 'replaced');
  const st = await fsp.lstat(store(ws));
  assert.equal(st.mode & 0o777, 0o600);
  assert.notEqual(st.ino, before, 'replacement, so the repaired file cannot inherit anything from the bad one');
});

test('an unsafe artifact (symlink) is unlinked as a link, and its target is untouched', async (t) => {
  const ws = await workspace();
  const victim = path.join(ws, 'victim.txt');
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await fsp.writeFile(victim, 'ORIGINAL\n');
  await fsp.symlink(victim, store(ws));

  const res = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: '' });
  assert.equal(res.action, 'removed');
  assert.equal(res.previousKind, 'symlink');
  assert.equal(await fsp.readFile(victim, 'utf8'), 'ORIGINAL\n', 'remediation must never resolve a planted link');
  assert.equal(fs.existsSync(store(ws)), false);
});

test('with no token available the artifact is removed rather than left unreadable', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  await fsp.chmod(store(ws), 0o666);

  const res = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: '' });
  assert.equal(res.action, 'removed');
  assert.equal(fs.existsSync(store(ws)), false,
    'a credential nobody can safely use is worth less than none; the dashboard rewrites a correct one on next sync');
});

test('a correct artifact is left completely alone, and dry-run changes nothing', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  const before = await fsp.lstat(store(ws));

  assert.equal((await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: TOKEN })).action, 'already-correct');
  assert.equal((await fsp.lstat(store(ws))).ino, before.ino, 'an already-correct artifact must not be churned');

  await fsp.chmod(store(ws), 0o644);
  const dry = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: TOKEN, dryRun: true });
  assert.equal(dry.action, 'would-remediate');
  assert.equal((await fsp.lstat(store(ws))).mode & 0o777, 0o644, 'dry-run must change nothing at all');
});

test('remediation never reflects the token and never recurses into the workspace', async (t) => {
  const ws = await workspace();
  t.after(() => fsp.rm(ws, { recursive: true, force: true }));
  const bystander = path.join(ws, 'bystander.txt');
  await fsp.writeFile(bystander, 'untouched\n');
  const bystanderBefore = await fsp.lstat(bystander);
  await writeCredentialStore({ projectPath: ws, token: TOKEN, expectUid: ME });
  await fsp.chmod(store(ws), 0o640);

  const res = await remediateCredentialArtifact({ projectPath: ws, expectUid: ME, token: TOKEN });
  assert.ok(!JSON.stringify(res).includes('CANARY'), 'a remediation report must never carry credential material');

  const after = await fsp.lstat(bystander);
  assert.equal(after.uid, bystanderBefore.uid, 'nothing else in the workspace may be touched');
  assert.equal(after.mode, bystanderBefore.mode);
});

// --- the product path, and what it must not contain -----------------------------------------------

test('REGRESSION: the dashboard writes no workspace credential artifact in-process', () => {
  const src = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  const start = src.indexOf('async function syncProjectCredentials');
  assert.ok(start > -1);
  const body = src.slice(start, src.indexOf('\n}\n', start));

  assert.ok(!/execFileAsync\('git',\s*\[\s*'-C'[^\]]*'config'/.test(body),
    'THE REGRESSION: `git config --local` from the dashboard leaves a root-owned .git/config inside a pane-owned workspace');
  assert.ok(!/fs\.writeFile\([^)]*credFile/.test(body),
    'and writing the store from the dashboard leaves a root-owned file git cannot read');
  assert.match(body, /runCredentialJob\(\s*\n?\s*\{ action: 'git-credentials'/,
    'the work must go through the established privilege-dropped helper');
  assert.match(body, /refusing to write git credentials as root/,
    'an unresolvable workspace owner must fail closed, not fall back to a root write');
  assert.match(body, /ran as uid/,
    'the helper reports the uid it ran as, so the drop is proven rather than assumed');
  assert.match(body, /serializeCredentialWork/,
    'rotation and removal for one workspace must not interleave');
  assert.ok(!/chown/.test(body), 'repair is by replacement as the owner, never by chowning');
});

test('no recursive chown was added anywhere in the product', () => {
  const src = fs.readFileSync(path.join(REPO, 'app', 'server.js'), 'utf8');
  // The three pre-existing ones belong to the clone/init path, where the product just created the
  // directory itself. Pinning the count means a fourth has to be argued for rather than slipped in.
  assert.equal([...src.matchAll(/chown['"],\s*\['-R'/g)].length, 3);
  for (const file of ['git-credential-store.mjs', 'credential-remediation.mjs', 'project-git-credentials.mjs']) {
    assert.ok(!/chown/.test(code(path.join('app', file))), `${file} must not chown anything`);
  }
});

test('nothing in the credential path uses a shell', () => {
  for (const file of ['app/git-credential-store.mjs', 'app/credential-remediation.mjs', 'app/project-git-credentials.mjs', 'app/credential-writer.mjs']) {
    const src = code(file);
    assert.ok(!/shell\s*:\s*true/.test(src), `${file}: no shell`);
    assert.ok(!/\bexec\(/.test(src), `${file}: exec() takes a shell string; argv only`);
  }
});

test('the operator remediation tool is shipped and never chowns or globs', () => {
  const cli = code(path.join('scripts', 'pw-credential-remediate'));
  // Look for an INVOCATION, not the word: the tool legitimately prints "nothing is chowned" to the
  // operator, which is the reassurance a check shouldn't force anyone to delete.
  assert.ok(!/['"]chown['"]|execFile[^\n]*chown|spawn[^\n]*chown/.test(cli), 'repair is replacement as the owner');
  assert.ok(!/readdir|glob/.test(cli), 'only registry-listed projects are examined; nothing is discovered off disk');
  assert.match(cli, /credentialDropArgv/, 'it must use the same privilege-drop boundary the dashboard uses');
  assert.match(cli, /--apply/, 'and default to reporting rather than changing anything');
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.match(sh, /pw-credential-remediate/, 'the installer must ship it or an operator cannot run it');
});
