import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportCommittedSource, gitRunner, gitEnvironment, snapshotArgv } from '../app/deployment/source.js';
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
