// deploy/promote-app.sh's "exactly origin/main" preflight, executed for real against disposable
// Git trees. A manual promote copies the WORKING TREE, so it must refuse uncommitted (untracked
// and ignored included) files under app/ and scripts/, and any HEAD that is not exactly
// origin/main; it must never pull, and the approved-snapshot path (PW_PROMOTE_SRC) skips it.
//
// Only the preflight block runs: it is cut from the script between its own markers, so the rest
// of pw-promote-app (root, podman, the live tree) is never reached. setpriv is removed because the
// suite already runs as the workspace's owner, which is what setpriv would drop to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMOTE_APP = fileURLToPath(new URL('../deploy/promote-app.sh', import.meta.url));
const SETPRIV = 'setpriv --reuid="$OWNER_UID" --regid="$OWNER_GID" --clear-groups --no-new-privs -- ';

function gateScript() {
  const src = fs.readFileSync(PROMOTE_APP, 'utf8');
  const from = src.indexOf('REPO=$(dirname "$SRC")');
  const to = src.indexOf('# ------------------------------------------------------------- manifest ------');
  assert.ok(from > 0 && to > from, 'the preflight block and the manifest marker that ends it are both present');
  const block = src.slice(from, to);
  assert.ok(block.includes(SETPRIV), 'git runs through setpriv as the owner, with no_new_privs');
  return ['set -uo pipefail',
    'die(){ printf "ABORT: %s\\n" "$*"; exit 1; }; say(){ printf "[promote] %s\\n" "$*"; }; hr(){ printf -- "-- %s\\n" "$*"; }',
    'WITH_SCRIPTS=1; GIT_CHECK=${GIT_CHECK:-1}; SRC="$1/app"',
    block.replace(SETPRIV, '').replace('command -v setpriv', 'command -v true'),
    'echo PASSED'].join('\n');
}

function world(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pw-promote-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' });
  const remote = path.join(root, 'remote.git'), ws = path.join(root, 'ws'), other = path.join(root, 'other');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote], { env });
  fs.mkdirSync(path.join(ws, 'app', 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'scripts'));
  fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n*.log\n');
  fs.writeFileSync(path.join(ws, 'app', 'server.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(ws, 'scripts', 'run.sh'), 'echo hi\n');
  git(ws, 'init', '--quiet', '-b', 'main'); git(ws, 'add', '-A'); git(ws, 'commit', '--quiet', '-m', 'one');
  git(ws, 'remote', 'add', 'origin', remote); git(ws, 'push', '--quiet', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(ws, 'app', 'node_modules', 'dep', 'index.js'), 'ignored and never copied\n');
  const script = path.join(root, 'gate.sh');
  fs.writeFileSync(script, gateScript());
  const run = (extra = {}) => spawnSync('bash', [script, ws], { env: { ...env, ...extra }, encoding: 'utf8' });
  const commit = (dir, name) => { fs.writeFileSync(path.join(dir, name), `${name}\n`); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', name); };
  return { root, remote, ws, other, git, run, commit, env };
}

test('promote-app git check: an in-sync, committed checkout passes (node_modules is not "uncommitted")', t => {
  const w = world(t);
  const r = w.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /is exactly origin\/main\nPASSED/);
});

test('promote-app git check: modified, untracked and ignored files under app/ refuse — they would ship', t => {
  for (const [label, act] of [
    ['modified', w => fs.appendFileSync(path.join(w.ws, 'app', 'server.js'), '// edit\n')],
    ['untracked', w => fs.writeFileSync(path.join(w.ws, 'scripts', 'new.sh'), 'x\n')],
    ['ignored', w => fs.writeFileSync(path.join(w.ws, 'app', 'debug.log'), 'x\n')],
  ]) {
    const w = world(t); act(w);
    const r = w.run();
    assert.equal(r.status, 1, label);
    assert.match(r.stdout, /ABORT: the checkout has changes that are not committed/, label);
  }
});

test('promote-app git check: ahead, behind (unfetched and fetched) refuse with what to run; nothing is pulled', t => {
  const ahead = world(t); ahead.commit(ahead.ws, 'app/local.js');
  let r = ahead.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not exactly origin\/main[\s\S]*behind 0, ahead 1[\s\S]*push the local commits first/);

  const behind = world(t);
  execFileSync('git', ['clone', '--quiet', behind.remote, behind.other], { env: behind.env });
  behind.commit(behind.other, 'app/colleague.js'); behind.git(behind.other, 'push', '--quiet');
  const headBefore = behind.git(behind.ws, 'rev-parse', 'HEAD');
  r = behind.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /behind \?, ahead \?[\s\S]*git pull --ff-only/);
  assert.equal(behind.git(behind.ws, 'rev-parse', 'HEAD'), headBefore, 'the check never pulls');
  behind.git(behind.ws, 'fetch', '--quiet');
  assert.match(behind.run().stdout, /behind 1, ahead 0/);
});

test('promote-app git check: an unreachable remote falls back to the last-fetched origin/main, with a warning', t => {
  const w = world(t);
  fs.renameSync(w.remote, `${w.remote}.gone`);
  const r = w.run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARNING origin unreachable; comparing with the last-fetched origin\/main/);
});

test('promote-app git check: an approved snapshot (PW_PROMOTE_SRC) and --skip-git-check do not run it', t => {
  const w = world(t);
  fs.appendFileSync(path.join(w.ws, 'app', 'server.js'), '// dirty, but not what ships\n');
  assert.match(w.run({ PW_PROMOTE_SRC: '/snapshot' }).stdout, /git check done at request time[\s\S]*PASSED/);
  const skipped = w.run({ GIT_CHECK: '0' });
  assert.match(skipped.stdout, /git check SKIPPED[\s\S]*PASSED/);
  const src = fs.readFileSync(PROMOTE_APP, 'utf8');
  assert.match(src, /--skip-git-check\) GIT_CHECK=0 ;;/, 'the flag is what sets GIT_CHECK=0');
});
