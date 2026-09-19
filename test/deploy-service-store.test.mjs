import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../app/deployment/store.js';
import { publicJob } from '../app/deployment/protocol.js';
import { builderStartupDiagnostic } from './deploy-service-fixtures.mjs';

const POSIX = process.platform !== 'win32';
const parent = path.dirname(fileURLToPath(import.meta.url));

function job() {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(), requestId: crypto.randomUUID(), project: 'FixtureApp', target: 'dev',
    revision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), fingerprint: 'c'.repeat(64),
    adapter: 'script', state: 'queued', phase: 'queued', createdAt: at, version: null,
    events: [{ seq: 1, at, phase: 'queued', state: 'queued' }], lastSeq: 1,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(parent, '.deploy-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JobStore(path.join(root, 'state'));
  await store.init();
  return { root, store };
}

test('POSIX journal survives reopening, preserves exact modes and excludes execution contents', { skip: !POSIX }, async t => {
  const { store } = await fixture(t);
  const entry = { ...job(), script: 'private-script', secrets: { DEPLOY_PASSWORD: 'private-value' },
    source: { files: [{ data: 'private-source' }] } };
  await store.saveJob(entry);
  await store.writeSetting('settings', { paused: true });
  const reopened = new JobStore(store.directory);
  await reopened.init();
  assert.deepEqual((await reopened.loadJobs()).map(item => item.id), [entry.id]);
  assert.deepEqual(await reopened.readSetting('settings', {}), { paused: true });
  for (const directory of [store.directory, store.jobsDirectory, store.jobDirectory(entry.id)]) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o711);
  }
  const metadata = path.join(store.jobDirectory(entry.id), 'job.json');
  assert.equal((await fs.stat(metadata)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(metadata, 'utf8')).includes('private-'), false);
});

test('concurrent journal updates retain the last submitted state, not the slowest write', { skip: !POSIX }, async t => {
  const { store } = await fixture(t);
  const entry = job();
  const writes = [store.saveJob(entry)];
  for (let seq = 2; seq <= 12; seq++) {
    entry.lastSeq = seq;
    entry.phase = `phase_${seq}`;
    entry.events.push({ seq, at: new Date().toISOString(), phase: entry.phase, state: 'queued' });
    writes.push(store.saveJob(entry));
  }
  await Promise.all(writes);
  assert.equal((await store.loadJobs())[0].lastSeq, 12);
  assert.equal((await fs.readdir(store.jobDirectory(entry.id))).length, 1);
});

test('state symlinks, writable job directories and private metadata permissions fail closed', { skip: !POSIX }, async t => {
  const { root, store } = await fixture(t);
  const link = path.join(root, 'state-link');
  await fs.symlink(store.directory, link);
  await assert.rejects(new JobStore(link).init(), error => error.code === 'unsafe_state');
  const entry = job();
  await store.saveJob(entry);
  const metadata = path.join(store.jobDirectory(entry.id), 'job.json');
  await fs.chmod(metadata, 0o644);
  await assert.rejects(store.loadJobs(), error => error.code === 'unsafe_state');
  await fs.chmod(metadata, 0o600);
  await fs.chmod(store.jobDirectory(entry.id), 0o777);
  await assert.rejects(store.loadJobs(), error => error.code === 'unsafe_state');
});

test('corruption and retention path traversal cannot be mistaken for an empty journal', { skip: !POSIX }, async t => {
  const { store } = await fixture(t);
  const entry = job();
  await store.saveJob(entry);
  await fs.writeFile(path.join(store.jobDirectory(entry.id), 'job.json'), '{"broken":');
  await assert.rejects(store.loadJobs());
  assert.throws(() => store.jobDirectory('../outside'));
  await assert.rejects(store.removeJob('../outside'));
  await store.removeJob(entry.id);
  assert.deepEqual(await store.loadJobs(), []);
});

test('portable job serialization preserves bounded startup diagnostics privately and accepts old records', async t => {
  const store = new JobStore(path.join(parent, 'unused-diagnostic-model'));
  const old = job(), current = job();
  current.builderStartupFailure = builderStartupDiagnostic(current.id);
  current.rawError = 'PRIVATE_EXCEPTION';
  current.secrets = { VALUE: 'PRIVATE_SECRET' };
  const written = new Map();
  store.writeJob = async (directory, content) => {
    written.set(path.join(directory, 'job.json'), content);
  };
  await store.saveJob(old);
  await store.saveJob(current);
  const retained = JSON.parse(written.get(path.join(store.jobDirectory(current.id), 'job.json')));
  assert.deepEqual(retained.builderStartupFailure, current.builderStartupFailure);
  assert.equal(Object.hasOwn(publicJob(retained), 'builderStartupFailure'), false);
  assert.equal(JSON.stringify([...written.values()]).includes('PRIVATE_'), false);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1001 });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    else delete process.getuid;
  });
  const directory = { isDirectory: () => true, isSymbolicLink: () => false, uid: 1001, mode: 0o711 };
  t.mock.method(fs, 'readdir', async () => [old, current].map(item => ({
    ...directory, name: item.id,
  })));
  t.mock.method(fs, 'lstat', async file => written.has(file)
    ? { isFile: () => true, isSymbolicLink: () => false, uid: 1001, mode: 0o600, size: written.get(file).length }
    : directory);
  t.mock.method(fs, 'readFile', async file => written.get(file));
  const loaded = await store.loadJobs();
  assert.equal(Object.hasOwn(loaded[0], 'builderStartupFailure'), false);
  assert.deepEqual(loaded[1].builderStartupFailure, current.builderStartupFailure);
  let removed;
  t.mock.method(fs, 'rm', async (file, options) => { removed = { file, options }; });
  await store.removeJob(current.id);
  assert.deepEqual(removed, { file: store.jobDirectory(current.id), options: { recursive: true } });
});

test('invalid startup diagnostic fields cannot reach a serialized job or become recovery authority', async () => {
  const store = new JobStore(path.join(parent, 'unused-diagnostic-model'));
  const current = job();
  let writes = 0;
  store.writeJob = async () => { writes++; };
  const good = builderStartupDiagnostic(current.id);
  for (const builderStartupFailure of [
    { ...good, stack: 'PRIVATE_STACK' },
    { ...good, jobId: good.instanceId },
    { ...good, primary: { ...good.primary, code: 'PRIVATE_CODE' } },
    { ...good, primary: { ...good.primary, rule: 'PRIVATE_RULE' } },
    { ...good, cleanup: [...good.cleanup, ...good.cleanup, ...good.cleanup] },
  ]) {
    assert.throws(() => store.saveJob({ ...current, builderStartupFailure }),
      error => error.code === 'builder_protocol_error');
  }
  assert.equal(writes, 0);
});
