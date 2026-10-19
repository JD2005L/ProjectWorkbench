import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportCommittedSource, gitRunner, gitEnvironment, snapshotArgv, checkUpstream, describeUpstream, upstreamCheckEnabled, UPSTREAM_REFUSES } from '../app/deployment/source.js';
import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES, snapshotDigest } from '../app/deployment/protocol.js';

const execute = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const revision = 'a'.repeat(40), oid = 'b'.repeat(40);

async function repository(t) {
  const root = await fs.mkdtemp(path.join(testDirectory, '.deploy-source-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execute('git', ['-C', root, ...args], { env: gitEnvironment() });
  await git('init', '--quiet');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored-secret.env\n');
  await fs.writeFile(path.join(root, 'source.txt'), 'committed source\n');
  await fs.writeFile(path.join(root, 'deploy.sh'), 'printf ready\\n\n');
  await fs.chmod(path.join(root, 'deploy.sh'), 0o755);
  await git('add', '--', '.gitignore', 'source.txt', 'deploy.sh');
  await git('update-index', '--chmod=+x', 'deploy.sh');
  await git('-c', 'user.name=DeploymentFixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic fixture');
  return { root, git };
}

function memoryGit(entries, { dirty = false, afterDirty = false, changedRevision = false } = {}) {
  const calls = [];
  let statusCount = 0, headCount = 0;
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'status') return Buffer.from((dirty || (++statusCount > 1 && afterDirty)) ? ' M source.txt\0' : '');
    if (args[0] === 'rev-parse') return Buffer.from(`${changedRevision && ++headCount > 1 ? 'c'.repeat(40) : revision}\n`);
    if (args[0] === 'ls-tree') return Buffer.from(entries.map(entry => `${entry.mode || '100644'} ${entry.type || 'blob'} ${entry.oid || oid} ${entry.size ?? entry.content?.length ?? 0}\t${entry.path}\0`).join(''));
    if (args[0] === 'cat-file') return Buffer.concat(entries.flatMap(entry => {
      const content = entry.content || Buffer.alloc(0);
      return [Buffer.from(`${entry.oid || oid} blob ${entry.size ?? content.length}\n`), content, Buffer.from('\n')];
    }));
    throw new Error(`Unexpected Git command ${args[0]}`);
  };
  return { run, calls };
}

test('source: exact committed files, executable bit, canonical digest, and unchanged worktree', async t => {
  const { root, git } = await repository(t);
  await fs.writeFile(path.join(root, 'ignored-secret.env'), 'synthetic ignored private data');
  const before = await git('status', '--porcelain=v1');
  assert.equal(before.stdout, '');
  const result = await exportCommittedSource(gitRunner(root));
  assert.equal(result.revision, (await git('rev-parse', 'HEAD')).stdout.trim());
  assert.equal(result.source.sha256, snapshotDigest(result.source.files));
  assert.deepEqual(result.source.files.map(file => file.path).sort(), ['.gitignore', 'deploy.sh', 'source.txt']);
  assert.equal(result.source.files.find(file => file.path === 'deploy.sh').executable, true);
  assert.equal(Buffer.from(result.source.files.find(file => file.path === 'source.txt').data, 'base64').toString(), 'committed source\n');
  assert.equal((await git('status', '--porcelain=v1')).stdout, before.stdout);
  assert.deepEqual((await fs.readdir(root)).sort(), ['.git', '.gitignore', 'deploy.sh', 'ignored-secret.env', 'source.txt']);
});

test('source: refuses tracked, staged, and untracked changes without committing or stashing them', async t => {
  const { root, git } = await repository(t);
  await fs.writeFile(path.join(root, 'source.txt'), 'dirty data');
  const originalHead = (await git('rev-parse', 'HEAD')).stdout;
  await assert.rejects(exportCommittedSource(gitRunner(root)), error => error.code === 'deployment_workspace_dirty');
  await git('add', '--', 'source.txt');
  await assert.rejects(exportCommittedSource(gitRunner(root)), error => error.code === 'deployment_workspace_dirty');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked data');
  await assert.rejects(exportCommittedSource(gitRunner(root)), /clean committed workspace/);
  assert.equal((await git('rev-parse', 'HEAD')).stdout, originalHead);
  assert.match((await git('status', '--porcelain=v1')).stdout, /source\.txt|untracked\.txt/);
});

test('source: exactly 32 MiB is accepted; one byte over is refused before cat-file', async () => {
  const exact = memoryGit([{ path: 'payload.bin', content: Buffer.alloc(MAX_SOURCE_BYTES, 42) }]);
  const result = await exportCommittedSource(exact.run);
  assert.equal(Buffer.from(result.source.files[0].data, 'base64').length, MAX_SOURCE_BYTES);
  const over = memoryGit([{ path: 'payload.bin', size: MAX_SOURCE_BYTES + 1 }]);
  await assert.rejects(exportCommittedSource(over.run), error => error.statusCode === 413);
  assert.ok(!over.calls.some(call => call.args[0] === 'cat-file'));
});

test('source: file-count limit and aggregate file sizes are checked before reading blobs', async () => {
  const many = memoryGit(Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => ({ path: `source-${index}.txt` })));
  await assert.rejects(exportCommittedSource(many.run), error => error.statusCode === 413);
  assert.ok(!many.calls.some(call => call.args[0] === 'cat-file'));
  const aggregate = memoryGit([{ path: 'one.bin', size: MAX_SOURCE_BYTES }, { path: 'two.bin', size: 1 }]);
  await assert.rejects(exportCommittedSource(aggregate.run), error => error.statusCode === 413);
});

test('source: symlinks, submodules, databases and private configuration never become transferred files', async () => {
  const unsafe = [
    { path: 'link', mode: '120000' }, { path: 'module', mode: '160000', type: 'commit' },
    ...['../outside', '.git/config', 'node_modules/dependency.js', '.env', '.env.production', 'data/runtime.sqlite',
      'data/runtime.db', 'data/runtime.sqlite3-wal', 'credentials.key', '.git-credentials', 'workbench.json', '.pw/secrets.json',
      '_inbox/private.txt', 'C:/outside', 'folder\\outside'].map(name => ({ path: name })),
  ];
  for (const entry of unsafe) {
    const fixture = memoryGit([entry]);
    await assert.rejects(exportCommittedSource(fixture.run), undefined, entry.path);
    assert.ok(!fixture.calls.some(call => call.args[0] === 'cat-file'));
  }
});

test('source: workspace or HEAD changing during export aborts rather than uploading a stale selection', async () => {
  for (const options of [{ afterDirty: true }, { changedRevision: true }]) {
    const fixture = memoryGit([{ path: 'source.txt', content: Buffer.from('committed') }], options);
    await assert.rejects(exportCommittedSource(fixture.run), error => error.statusCode === 409);
  }
});

test('source: malformed blob framing and unsafe filenames are rejected', async () => {
  const fixture = memoryGit([{ path: 'source.txt', size: 20, content: Buffer.from('short') }]);
  await assert.rejects(exportCommittedSource(fixture.run), /incomplete blob/);
  const invalid = memoryGit([{ path: 'source.txt' }]);
  await assert.rejects(exportCommittedSource((args, opts) => args[0] === 'ls-tree'
    ? Buffer.from([0xff, 0]) : invalid.run(args, opts)), /UTF-8/);
});

test('source: pane-account helper reuses vetted privilege drops and refuses root fallback', () => {
  assert.throws(() => snapshotArgv({ owner: null, currentUid: 0 }), /non-root/);
  assert.throws(() => snapshotArgv({ owner: { uid: 0, gid: 2001 }, currentUid: 0 }), /non-root/);
  const numeric = { uid: 2001, gid: 2001, user: 'fixture-pane', source: 'PW_TERMINAL_UID' };
  assert.deepEqual(snapshotArgv({ owner: numeric, currentUid: 0 }).slice(0, 6),
    ['/usr/bin/setpriv', '--reuid', '2001', '--regid', '2001', '--init-groups']);
  const named = { ...numeric, source: 'passwd' };
  assert.deepEqual(snapshotArgv({ owner: named, currentUid: 0 }).slice(0, 4), ['/usr/bin/sudo', '-n', '-u', 'fixture-pane']);
  assert.equal(snapshotArgv({ owner: numeric, currentUid: 2001 })[0], process.execPath);
});

test('source: Git child environment excludes service/deployment secrets and Git command overrides', () => {
  const env = gitEnvironment({ PATH: 'fixture-path', HOME: 'fixture-home', DEPLOY_PASSWORD: 'synthetic-secret',
    PW_SERVICE_TOKEN: 'synthetic-token', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'bad-command', GIT_DIR: 'other-repo', NODE_OPTIONS: '--require=bad-module' });
  for (const key of ['DEPLOY_PASSWORD', 'PW_SERVICE_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
});

// ── upstream comparison before a deploy (checkUpstream) ─────────────────────
// Real Git throughout: a bare repository stands in for the remote, and a second
// clone stands in for a colleague who pushes.
async function upstreamFixture(t) {
  const base = await fs.mkdtemp(path.join(testDirectory, '.deploy-upstream-fixture-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const env = gitEnvironment();
  const at = dir => (...args) => execute('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgSign=false', '-c', 'init.defaultBranch=main', ...args], { env });
  const remote = path.join(base, 'remote.git'), work = path.join(base, 'work'), other = path.join(base, 'other');
  await execute('git', ['init', '--quiet', '--bare', '-b', 'main', remote], { env });
  await execute('git', ['clone', '--quiet', remote, work], { env });
  const commit = async (dir, name) => {
    await fs.writeFile(path.join(dir, name), `${name}\n`);
    await at(dir)('add', '--', name);
    await at(dir)('commit', '--quiet', '-m', name);
  };
  await at(work)('checkout', '--quiet', '-b', 'main');
  await commit(work, 'first.txt');
  await at(work)('push', '--quiet', '-u', 'origin', 'main');
  await execute('git', ['clone', '--quiet', remote, other], { env });
  return { base, remote, work, other, commit, git: at };
}

test('upstream: a workspace at the remote tip is in sync and says nothing', async t => {
  const { work } = await upstreamFixture(t);
  const check = await checkUpstream(gitRunner(work));
  assert.equal(check.state, 'in_sync');
  assert.equal(check.upstream, 'origin/main');
  assert.equal(check.head, check.remoteTip);
  assert.equal(describeUpstream(check), '');
});

test('upstream: a push the workspace has not fetched refuses as behind, without fetching', async t => {
  const { work, other, commit, git } = await upstreamFixture(t);
  await commit(other, 'colleague.txt');
  await git(other)('push', '--quiet');
  const refsBefore = (await git(work)('for-each-ref')).stdout;
  const check = await checkUpstream(gitRunner(work));
  assert.equal(check.state, 'behind');
  assert.equal(check.unfetched, true);
  assert.ok(UPSTREAM_REFUSES.includes(check.state));
  assert.match(describeUpstream(check, work), /refused.*behind origin\/main.*git pull --ff-only.*Nothing was deployed/s);
  assert.equal((await git(work)('for-each-ref')).stdout, refsBefore, 'the check must not fetch or move any ref');
});

test('upstream: a fetched-but-not-pulled push refuses as behind, with the count', async t => {
  const { work, other, commit, git } = await upstreamFixture(t);
  await commit(other, 'a.txt'); await commit(other, 'b.txt');
  await git(other)('push', '--quiet');
  await git(work)('fetch', '--quiet');
  const check = await checkUpstream(gitRunner(work));
  assert.deepEqual([check.state, check.behind, check.ahead], ['behind', 2, 0]);
  assert.match(describeUpstream(check), /2 commits behind/);
});

test('upstream: unpushed local commits deploy with a warning, not a refusal', async t => {
  const { work, commit } = await upstreamFixture(t);
  await commit(work, 'local.txt');
  const check = await checkUpstream(gitRunner(work));
  assert.deepEqual([check.state, check.ahead, check.behind], ['ahead', 1, 0]);
  assert.equal(UPSTREAM_REFUSES.includes(check.state), false);
  assert.match(describeUpstream(check), /^Warning: 1 local commit is not pushed to origin\/main/);
});

test('upstream: local and remote commits on both sides refuse as diverged', async t => {
  const { work, other, commit, git } = await upstreamFixture(t);
  await commit(other, 'remote.txt'); await git(other)('push', '--quiet');
  await commit(work, 'local.txt'); await git(work)('fetch', '--quiet');
  const check = await checkUpstream(gitRunner(work));
  assert.deepEqual([check.state, check.ahead, check.behind], ['diverged', 1, 1]);
  assert.match(describeUpstream(check), /refused.*diverged/);
});

test('upstream: what cannot be judged only warns — detached, no upstream, unreachable, not Git', async t => {
  const { base, work, remote, git } = await upstreamFixture(t);
  await git(work)('checkout', '--quiet', '--detach');
  assert.equal((await checkUpstream(gitRunner(work))).state, 'detached');
  await git(work)('checkout', '--quiet', '-b', 'local-only');
  assert.equal((await checkUpstream(gitRunner(work))).state, 'no_upstream');
  await git(work)('checkout', '--quiet', 'main');
  await fs.rename(remote, `${remote}.gone`);
  const gone = await checkUpstream(gitRunner(work));
  assert.equal(gone.state, 'unreachable');
  assert.match(describeUpstream(gone), /^Warning: origin\/main could not be reached/);
  // Outside this checkout, or Git would find the repository above the fixture.
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-upstream-plain-'));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  assert.equal((await checkUpstream(gitRunner(plain))).state, 'not_git');
  for (const state of ['detached', 'no_upstream', 'unreachable', 'not_git', 'unknown']) assert.equal(UPSTREAM_REFUSES.includes(state), false, state);
});

test('upstream: PW_DEPLOY_UPSTREAM_CHECK=off (or false/0/no) is the only way to turn the check off', () => {
  assert.equal(upstreamCheckEnabled({}), true);
  assert.equal(upstreamCheckEnabled({ PW_DEPLOY_UPSTREAM_CHECK: 'on' }), true);
  assert.equal(upstreamCheckEnabled({ PW_DEPLOY_UPSTREAM_CHECK: 'typo' }), true);
  for (const off of ['off', 'OFF', ' false ', '0', 'no']) assert.equal(upstreamCheckEnabled({ PW_DEPLOY_UPSTREAM_CHECK: off }), false, off);
});

test('upstream: the helper answers --upstream over stdin as a separate process', async t => {
  const { work } = await upstreamFixture(t);
  const helper = path.join(testDirectory, '..', 'app', 'deployment', 'source.js');
  const result = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [helper, '--upstream'], { env: gitEnvironment() }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ workspace: work }));
  });
  assert.equal(JSON.parse(result).state, process.getuid?.() === 0 ? 'unknown' : 'in_sync');
});

test('upstream with paths: lists what would ship uncommitted — untracked and ignored too, node_modules and other paths not', async t => {
  const { work, git } = await upstreamFixture(t);
  await fs.mkdir(path.join(work, 'app', 'node_modules', 'dep'), { recursive: true });
  await fs.mkdir(path.join(work, 'docs'));
  await fs.writeFile(path.join(work, '.gitignore'), '*.log\nnode_modules/\n');
  await fs.writeFile(path.join(work, 'app', 'kept.js'), 'kept\n');
  await git(work)('add', '--', '.gitignore', 'app/kept.js'); await git(work)('commit', '--quiet', '-m', 'app'); await git(work)('push', '--quiet');
  const clean = await checkUpstream(gitRunner(work), { paths: ['app', 'scripts'] });
  assert.deepEqual([clean.state, clean.dirtyCount], ['in_sync', 0]);
  await fs.writeFile(path.join(work, 'app', 'node_modules', 'dep', 'index.js'), 'x\n');
  await fs.writeFile(path.join(work, 'docs', 'notes.md'), 'not shipped\n');
  await fs.writeFile(path.join(work, 'app', 'debug.log'), 'ignored but would ship\n');
  await fs.writeFile(path.join(work, 'app', 'new.js'), 'untracked\n');
  await git(work)('mv', 'app/kept.js', 'app/renamed.js');
  const dirty = await checkUpstream(gitRunner(work), { paths: ['app', 'scripts', '../escape'] });
  assert.deepEqual(dirty.dirty.sort(), ['app/debug.log', 'app/new.js', 'app/renamed.js']);
  assert.equal(dirty.dirtyCount, 3);
  assert.equal(dirty.state, 'in_sync', 'the upstream comparison still runs alongside');
});
