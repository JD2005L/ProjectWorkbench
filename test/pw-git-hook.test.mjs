// scripts/pw-git-hook: signs commits made by PW Claude sessions with a PW-Session
// trailer (docs/ci-results.md), and runs the repository's own hooks exactly as before.
// Real git, real commits; tmux is a stub that answers for the pane the commit runs in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../scripts/pw-git-hook', import.meta.url));
const NAMES = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-merge', 'post-rewrite', 'pre-push', 'post-checkout'];

function setup({ session = 'pw_Demo', window = '@12', panePid = '4242' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-git-hook-'));
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  fs.copyFileSync(HOOK, path.join(hooks, 'pw-git-hook'));
  fs.chmodSync(path.join(hooks, 'pw-git-hook'), 0o755);
  for (const n of NAMES) fs.symlinkSync('pw-git-hook', path.join(hooks, n));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$*" in
  *session_name*) echo "${session} ${window} ${panePid}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (args, env = {}) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  const pwEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    TMUX_PANE: '%5', PW_CI_INSTANCE: 'pvi2', HOME: home,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig-global'),
  };
  fs.writeFileSync(pwEnv.GIT_CONFIG_GLOBAL, '');
  let n = 0;
  const commit = (env = pwEnv, extra = []) => {
    fs.writeFileSync(path.join(repo, `f${n++}.txt`), String(n));
    git(['add', '-A']);
    return spawnSync('git', ['commit', '-q', '-m', 'change', ...extra], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8' });
  };
  const lastMessage = () => git(['log', '-1', '--format=%B']);
  const ledgerFile = path.join(home, '.local', 'state', 'project-workbench', 'ci-commits.log');
  const ledger = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 4).join(' ')) : []);
  const head = () => git(['rev-parse', 'HEAD']).trim();
  return { root, repo, hooks, git, pwEnv, commit, lastMessage, ledger, ledgerFile, head };
}

test('a commit made in a PW pane is signed with instance/session/window', () => {
  const t = setup();
  assert.equal(t.commit().status, 0);
  assert.match(t.lastMessage(), /^PW-Session: pvi2\/pw_Demo\/@12$/m);
});

test('every commit, amend and rebase result is recorded in the ledger with its window and pane', () => {
  const t = setup();
  t.commit();
  const first = t.head();
  assert.deepEqual(t.ledger(), [`${first} pw_Demo @12 4242`]);
  assert.equal(fs.statSync(t.ledgerFile).mode & 0o777, 0o600);
  const amend = spawnSync('git', ['commit', '-q', '--amend', '-m', 'changed'], { cwd: t.repo, env: { ...process.env, ...t.pwEnv }, encoding: 'utf8' });
  assert.equal(amend.status, 0, amend.stderr);
  assert.ok(t.ledger().includes(`${t.head()} pw_Demo @12 4242`), 'the amended commit');
  // a rebase rewrites commits: the new SHAs are recorded, and the repo's own post-rewrite
  // still receives the old -> new list on stdin
  const seen = path.join(t.root, 'rewrite-seen');
  fs.writeFileSync(path.join(t.repo, '.git', 'hooks', 'post-rewrite'), `#!/bin/sh\ncat > "${seen}"\n`, { mode: 0o755 });
  t.commit(); t.commit();
  const r = spawnSync('git', ['rebase', '-q', '--exec', 'true', 'HEAD~2'], { cwd: t.repo, env: { ...process.env, ...t.pwEnv, GIT_SEQUENCE_EDITOR: 'true' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.ledger().includes(`${t.head()} pw_Demo @12 4242`), 'the rebased head');
  assert.ok(fs.existsSync(seen), 'the repo\'s own post-rewrite ran');
});

test('REVIEW: a pull that fast-forwards to somebody else\'s commit is not recorded; a merge made here is', () => {
  const t = setup();
  t.commit();
  const plain = { ...process.env, GIT_CONFIG_GLOBAL: t.pwEnv.GIT_CONFIG_GLOBAL, HOME: t.pwEnv.HOME, TMUX_PANE: '' };
  // someone else's commits arrive on another clone
  const other = path.join(t.root, 'other');
  execFileSync('git', ['clone', '-q', t.repo, other], { env: plain });
  const ogit = (args) => execFileSync('git', ['-c', 'user.email=o@x', '-c', 'user.name=O', ...args], { cwd: other, env: plain, encoding: 'utf8' });
  fs.writeFileSync(path.join(other, 'theirs.txt'), '1'); ogit(['add', '-A']); ogit(['commit', '-q', '-m', 'theirs']);
  const theirs = ogit(['rev-parse', 'HEAD']).trim();
  const pull = (args) => spawnSync('git', ['-c', 'pull.rebase=false', 'pull', '-q', ...args, other, 'main'], { cwd: t.repo, env: { ...process.env, ...t.pwEnv }, encoding: 'utf8' });
  assert.equal(pull(['--ff-only']).status, 0);
  assert.equal(t.head(), theirs);
  assert.ok(!t.ledger().some((l) => l.startsWith(theirs)), 'a fast-forward to their commit is not ours');
  // diverge, then a real merge commit is made in this window
  fs.writeFileSync(path.join(other, 'theirs2.txt'), '2'); ogit(['add', '-A']); ogit(['commit', '-q', '-m', 'theirs 2']);
  t.commit();
  const merged = pull(['--no-ff', '--no-edit']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.ok(t.ledger().includes(`${t.head()} pw_Demo @12 4242`), 'the merge commit made here is recorded');
});

test('amending keeps exactly one signature', () => {
  const t = setup();
  t.commit();
  const r = spawnSync('git', ['commit', '-q', '--amend', '-m', 'change\n\nPW-Session: other/pw_X/@1'], { cwd: t.repo, env: { ...process.env, ...t.pwEnv }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = t.lastMessage().split('\n').filter((l) => l.startsWith('PW-Session:'));
  assert.deepEqual(lines, ['PW-Session: pvi2/pw_Demo/@12']);
});

test('outside a PW pane, or in a non-PW tmux session, nothing is added', () => {
  const t = setup();
  // Explicitly empty: the test runner may itself be inside tmux.
  assert.equal(t.commit({ ...t.pwEnv, TMUX_PANE: '' }).status, 0);
  assert.doesNotMatch(t.lastMessage(), /PW-Session/);
  assert.deepEqual(t.ledger(), [], 'and nothing is recorded');
  const other = setup({ session: 'scratch' });
  assert.equal(other.commit().status, 0);
  assert.doesNotMatch(other.lastMessage(), /PW-Session/);
  const badWindow = setup({ window: 'nope; rm -rf' });
  assert.equal(badWindow.commit().status, 0);
  assert.doesNotMatch(badWindow.lastMessage(), /PW-Session/);
});

test('the repository\'s own .git/hooks still run, with their exit status', () => {
  const t = setup();
  const marker = path.join(t.root, 'ran');
  fs.writeFileSync(path.join(t.repo, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho post >> "${marker}"\n`, { mode: 0o755 });
  assert.equal(t.commit().status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'post\n');
  // a repo hook that rejects the commit still rejects it
  fs.writeFileSync(path.join(t.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "blocked by repo hook" >&2\nexit 7\n', { mode: 0o755 });
  const r = t.commit();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /blocked by repo hook/);
  // and the repo's own prepare-commit-msg sees the message after it was signed
  fs.rmSync(path.join(t.repo, '.git', 'hooks', 'pre-commit'));
  fs.writeFileSync(path.join(t.repo, '.git', 'hooks', 'prepare-commit-msg'), '#!/bin/sh\necho "Repo-Hook: yes" >> "$1"\n', { mode: 0o755 });
  assert.equal(t.commit().status, 0);
  assert.match(t.lastMessage(), /PW-Session: pvi2\/pw_Demo\/@12/);
  assert.match(t.lastMessage(), /Repo-Hook: yes/);
});

test('a repo with its own core.hooksPath (husky-style) keeps using it', () => {
  const t = setup();
  const own = path.join(t.repo, '.husky');
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'commit-msg'), '#!/bin/sh\ngrep -q "change" "$1" || exit 1\necho husky >> "$(dirname "$0")/../husky-ran"\n', { mode: 0o755 });
  t.git(['config', 'core.hooksPath', '.husky']);
  assert.equal(t.commit().status, 0);
  assert.equal(fs.readFileSync(path.join(t.repo, 'husky-ran'), 'utf8'), 'husky\n');
  assert.match(t.lastMessage(), /PW-Session: pvi2\/pw_Demo\/@12/);
});

test('REVIEW P2: a hooks path set globally (not in the repo) is still honoured, ~ expanded', () => {
  const t = setup();
  const glob = path.join(t.pwEnv.HOME, 'global-hooks');
  fs.mkdirSync(glob);
  fs.writeFileSync(path.join(glob, 'post-commit'), `#!/bin/sh\necho global >> "${path.join(t.root, 'global-ran')}"\n`, { mode: 0o755 });
  fs.writeFileSync(t.pwEnv.GIT_CONFIG_GLOBAL, '[core]\n\thooksPath = ~/global-hooks\n');
  assert.equal(t.commit().status, 0);
  assert.equal(fs.readFileSync(path.join(t.root, 'global-ran'), 'utf8'), 'global\n');
  assert.equal(t.ledger().length, 1, 'still recorded');
});

test('without the wrapper\'s opt-in environment the hook directory is never consulted', () => {
  const t = setup();
  const r = t.commit({ PATH: t.pwEnv.PATH, TMUX_PANE: '%5', PW_CI_INSTANCE: 'pvi2' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(t.lastMessage(), /PW-Session/);
});
