// Keeping `_inbox/` and `_outbox/` out of git in every workspace, through the clone's
// `.git/info/exclude` and never through a commit to the project's repo.
//
// Prompted 2026-10-14: a screenshot pasted into an STPDataHub-Tool-ClassFinalization
// terminal landed in `_inbox/` as an untracked file, so that repo's own publish
// script — which runs `git status --porcelain` itself — refused with "the tool
// workspace has uncommitted changes" although everything was committed and pushed.
//
// The work runs in the privilege-dropped workspace worker (see app/workspace-file.js),
// so these drive applyBoxesIgnore directly for the cases, the real worker executable
// for the protocol, and real git for the outcome that matters: `git status` is clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  BOX_EXCLUDE_LINES, BOX_EXCLUDE_MARKER, INBOX_DIR, OUTBOX_DIR,
  applyBoxClear, applyBoxList, applyBoxWrite, applyBoxesIgnore,
} from '../app/workspace-file.js';

const WRITER = fileURLToPath(new URL('../app/workspace-writer.mjs', import.meta.url));

function workspace(t, { git = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-boxes-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  if (git) {
    execFileSync('git', ['init', '-q', '-b', 'main', projectPath]);
    execFileSync('git', ['-C', projectPath, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '--allow-empty', '-m', 'init']);
  }
  return { root, projectPath, exclude: path.join(projectPath, '.git', 'info', 'exclude') };
}

const porcelain = (projectPath) => execFileSync('git', ['-C', projectPath, 'status', '--porcelain'], { encoding: 'utf8' });
const lines = (text) => text.split('\n').filter(Boolean);

test('REGRESSION: a file dropped into either box no longer makes `git status --porcelain` dirty', async (t) => {
  const { projectPath } = workspace(t);
  fs.mkdirSync(path.join(projectPath, INBOX_DIR));
  fs.writeFileSync(path.join(projectPath, INBOX_DIR, 'shot.png'), 'png');
  // An agent made this one itself — PW never created it — and it is covered all the same.
  fs.mkdirSync(path.join(projectPath, OUTBOX_DIR));
  fs.writeFileSync(path.join(projectPath, OUTBOX_DIR, 'report.md'), '# r');
  assert.match(porcelain(projectPath), /_inbox\/[\s\S]*_outbox\//, 'sanity: dirty before');

  const r = await applyBoxesIgnore({ fsp, projectPath });
  assert.equal(r.status, 'updated');
  assert.deepEqual(r.added, [...BOX_EXCLUDE_LINES]);
  assert.equal(porcelain(projectPath), '', 'clean after, with no commit to the repo');
  assert.equal(execFileSync('git', ['-C', projectPath, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length, 1,
    'nothing was committed');

  // Only the box itself is ignored: a same-named file elsewhere is still visible.
  fs.mkdirSync(path.join(projectPath, 'src', '_inbox'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'src', '_inbox', 'real.js'), '1');
  assert.match(porcelain(projectPath), /src\//, 'the patterns are anchored to the workspace root');
});

test('idempotent: a second run changes nothing and never duplicates a line', async (t) => {
  const { projectPath, exclude } = workspace(t);
  await applyBoxesIgnore({ fsp, projectPath });
  const once = fs.readFileSync(exclude, 'utf8');
  const again = await applyBoxesIgnore({ fsp, projectPath });
  assert.equal(again.status, 'unchanged');
  assert.equal(fs.readFileSync(exclude, 'utf8'), once);
  for (const line of [...BOX_EXCLUDE_LINES, BOX_EXCLUDE_MARKER]) {
    assert.equal(lines(once).filter((l) => l === line).length, 1, `exactly one ${line}`);
  }
});

test('append-only: existing content, its trailing-newline state and the file mode are preserved', async (t) => {
  const { projectPath, exclude } = workspace(t);
  const original = '# git ls-files --others --exclude-from=.git/info/exclude\n*.local\nsecrets/';   // no trailing newline
  fs.writeFileSync(exclude, original);
  fs.chmodSync(exclude, 0o600);
  await applyBoxesIgnore({ fsp, projectPath });
  const after = fs.readFileSync(exclude, 'utf8');
  assert.ok(after.startsWith(`${original}\n`), 'everything already there is kept verbatim, then a newline');
  assert.deepEqual(lines(after.slice(original.length)), [BOX_EXCLUDE_MARKER, ...BOX_EXCLUDE_LINES]);
  assert.equal(fs.statSync(exclude).mode & 0o777, 0o600, 'the operator\'s mode is kept');
  assert.deepEqual(fs.readdirSync(path.dirname(exclude)).filter((n) => n.startsWith('.pw-exclude-')), [], 'no temp file left behind');
});

test('only the missing line is added when one is already there, and the marker is not repeated', async (t) => {
  const { projectPath, exclude } = workspace(t);
  fs.writeFileSync(exclude, `${BOX_EXCLUDE_MARKER}\n/_inbox/\n`);
  const r = await applyBoxesIgnore({ fsp, projectPath });
  assert.deepEqual(r.added, ['/_outbox/']);
  assert.equal(fs.readFileSync(exclude, 'utf8'), `${BOX_EXCLUDE_MARKER}\n/_inbox/\n/_outbox/\n`);
});

test('a clone without .git/info gets one; a workspace that is not a repo is left alone', async (t) => {
  const { projectPath, exclude } = workspace(t);
  fs.rmSync(path.dirname(exclude), { recursive: true, force: true });
  assert.equal((await applyBoxesIgnore({ fsp, projectPath })).status, 'updated');
  assert.ok(fs.existsSync(exclude));

  const bare = workspace(t, { git: false });
  assert.deepEqual(await applyBoxesIgnore({ fsp, projectPath: bare.projectPath }), { status: 'not-a-repo' });
  assert.deepEqual(fs.readdirSync(bare.projectPath), [], 'nothing created in a non-repo');
});

test('a linked worktree or submodule (.git is a file) is reported as skipped, not followed', async (t) => {
  const { projectPath } = workspace(t, { git: false });
  fs.writeFileSync(path.join(projectPath, '.git'), 'gitdir: /somewhere/else/.git/worktrees/demo\n');
  assert.deepEqual(await applyBoxesIgnore({ fsp, projectPath }), { status: 'skipped', reason: 'gitfile' });
});

test('ADVERSARIAL: a symlinked .git, .git/info or exclude is refused and its target is untouched', async (t) => {
  for (const which of ['.git', 'info', 'exclude']) {
    const { root, projectPath } = workspace(t, { git: which !== '.git' });
    const victim = path.join(root, 'victim');
    fs.mkdirSync(path.join(victim, 'info'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'info', 'exclude'), 'VICTIM\n');
    fs.writeFileSync(path.join(victim, 'exclude'), 'VICTIM\n');
    const gitDir = path.join(projectPath, '.git');
    if (which === '.git') fs.symlinkSync(victim, gitDir);
    if (which === 'info') { fs.rmSync(path.join(gitDir, 'info'), { recursive: true, force: true }); fs.symlinkSync(victim, path.join(gitDir, 'info')); }
    if (which === 'exclude') { fs.rmSync(path.join(gitDir, 'info', 'exclude'), { force: true }); fs.symlinkSync(path.join(victim, 'exclude'), path.join(gitDir, 'info', 'exclude')); }
    await assert.rejects(applyBoxesIgnore({ fsp, projectPath }), /symlink; refusing/, `${which} as a symlink is refused`);
    assert.equal(fs.readFileSync(path.join(victim, 'info', 'exclude'), 'utf8'), 'VICTIM\n');
    assert.equal(fs.readFileSync(path.join(victim, 'exclude'), 'utf8'), 'VICTIM\n');
  }
});

test('box listing, clear and expiry are unaffected: the exclude lives outside the boxes', async (t) => {
  const { projectPath } = workspace(t);
  await applyBoxWrite({ fsp, projectPath, box: INBOX_DIR, name: 'a.txt', source: Readable.from([Buffer.from('a')]) });
  await applyBoxesIgnore({ fsp, projectPath });
  assert.deepEqual((await applyBoxList({ fsp, projectPath, box: INBOX_DIR })).files.map((f) => f.name), ['a.txt'],
    'no marker file appears in the Files tray');
  await applyBoxClear({ fsp, projectPath, box: INBOX_DIR });
  fs.writeFileSync(path.join(projectPath, INBOX_DIR, 'later.png'), 'x');
  assert.equal(porcelain(projectPath), '', 'a cleared box is still ignored');
});

function runWorker(job, payload = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, reply: JSON.parse(out.split('\n')[0]) }));
    child.stdin.end(`${JSON.stringify(job)}\n${payload}`);
  });
}

test('the worker runs the job as `boxes-ignore`, and every box-write keeps the exclude too', async (t) => {
  const direct = workspace(t);
  const r = await runWorker({ action: 'boxes-ignore', projectPath: direct.projectPath });
  assert.equal(r.code, 0);
  assert.equal(r.reply.ok, true);
  assert.equal(r.reply.result.status, 'updated');

  // The reported vector: a paste is a box-write. It must leave the clone clean on its own.
  const viaPaste = workspace(t);
  const w = await runWorker({ action: 'box-write', projectPath: viaPaste.projectPath, box: INBOX_DIR, name: 'clip.png' }, 'PNGBYTES');
  assert.equal(w.reply.ok, true);
  assert.ok(fs.existsSync(path.join(viaPaste.projectPath, INBOX_DIR, 'clip.png')));
  assert.equal(porcelain(viaPaste.projectPath), '', 'the dropped file is invisible to git status');
});
