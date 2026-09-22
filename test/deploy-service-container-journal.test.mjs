import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeCandidateJournal, validateRuntimeCandidate } from '../app/deployment/container-journal.js';
import { deploymentConfig } from './deploy-service-fixtures.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const job = {
  id: '524637ea-d8d4-41b4-a2b1-b9d615961b2f', project: 'ExampleApp', target: 'prod', revision: 'a'.repeat(40),
};
const config = { ...deploymentConfig(), container: { instanceId: '624637ea-d8d4-41b4-a2b1-b9d615961b2f' } };
const checkpoint = () => ({
  jobId: job.id, instanceId: config.container.instanceId, project: job.project, target: job.target,
  revision: job.revision, image: 'exampleapp', imageId: `sha256:${'b'.repeat(64)}`,
});

test('runtime checkpoint is bound to exact job, source, instance and approved resource', () => {
  assert.deepEqual(validateRuntimeCandidate(checkpoint(), job, config), checkpoint());
  for (const change of [
    { jobId: config.container.instanceId }, { instanceId: job.id }, { project: 'OtherApp' }, { target: 'dev' },
    { revision: 'c'.repeat(40) }, { image: 'otherapp' }, { image: '' }, { image: undefined },
    { imageId: 'not-an-image' }, { secret: 'not-permitted' },
  ]) assert.throws(() => validateRuntimeCandidate({ ...checkpoint(), ...change }, job, config));
});

test('checkpoint resource validation honours current immutable legacy reservations', () => {
  const reserved = { ...config, resourceNames: { 'AnotherProject/prod': 'exampleapp' } };
  assert.throws(() => validateRuntimeCandidate(checkpoint(), job, reserved),
    error => error.code === 'resource_not_allowed');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(directory, '.container-journal-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'runtime-candidate.json'), journal: new RuntimeCandidateJournal() };
}

test('runtime candidate checkpoint is durable, private and removed only explicitly', {
  skip: process.platform !== 'linux',
}, async t => {
  const { root, file, journal } = await fixture(t);
  assert.equal(await journal.read(root), null);
  await journal.write(root, checkpoint());
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await new RuntimeCandidateJournal().read(root), checkpoint());
  await journal.remove(root);
  assert.equal(await journal.read(root), null);
});

test('runtime checkpoint refuses permissive files and hardlinks', {
  skip: process.platform !== 'linux',
}, async t => {
  const { root, file, journal } = await fixture(t);
  await journal.write(root, checkpoint());
  await fs.chmod(file, 0o644);
  await assert.rejects(journal.read(root), error => error.code === 'invalid_state');
  await fs.chmod(file, 0o600);
  await fs.link(file, path.join(root, 'another-link'));
  await assert.rejects(journal.read(root), error => error.code === 'invalid_state');
});

test('runtime checkpoint rejects symlinks and unsafe job directories', {
  skip: process.platform !== 'linux',
}, async t => {
  const { root, file, journal } = await fixture(t);
  const target = path.join(root, 'target.json');
  await fs.writeFile(target, JSON.stringify(checkpoint()), { mode: 0o600 });
  await fs.symlink(target, file);
  await assert.rejects(journal.read(root), error => error.code === 'invalid_state');
  await fs.unlink(file);
  await fs.chmod(root, 0o777);
  await assert.rejects(journal.write(root, checkpoint()), error => error.code === 'invalid_state');
});
