import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { HostExecutor } from '../app/deployment/executor.js';
import { JobStore } from '../app/deployment/store.js';
import { deploymentConfig, deploymentRequest, until } from './deploy-service-fixtures.mjs';

const enabled = process.platform === 'linux' && process.getuid() === 0
  && process.env.PW_DEPLOY_NATIVE_FIXTURE === '1';
const exec = promisify(execFile);
const parent = path.dirname(fileURLToPath(import.meta.url));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(parent, '.deploy-native-'));
  await fs.chmod(root, 0o711);
  const unitName = `pw-deploy-fixture-${crypto.randomUUID()}.service`;
  const config = deploymentConfig({
    stateDir: path.join(root, 'state'), buildUser: 'nobody', runtimeUser: 'nobody',
    unitName, adapters: ['script', 'iis'], defaultTimeoutSeconds: 60,
  });
  const executor = new HostExecutor(config);
  await executor.init();
  const store = new JobStore(config.stateDir);
  await store.init();
  const fatal = [];
  const engine = new DeploymentEngine({ config, store, executor, onFatal: error => fatal.push(error) });
  await exec('/usr/bin/systemd-run', [
    '--quiet', '--collect', '--service-type=exec', `--unit=${unitName}`, '--uid=nobody',
    '--property=NoNewPrivileges=yes', '--property=RuntimeMaxSec=120s', '/usr/bin/sleep', '120',
  ], { timeout: 10000 });
  t.after(async () => {
    await engine.close();
    await executor.stopUnit(unitName);
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(fatal, []);
  });
  await engine.init();
  return { root, config, executor, store, engine, unitName };
}

test('native script and IIS recipes run non-root with no-new-privileges and remove staging', { skip: !enabled }, async t => {
  const { engine, store, executor } = await fixture(t);
  for (const adapter of ['script', 'iis']) {
    const job = await engine.submit(deploymentRequest({
      requestId: crypto.randomUUID(), recipe: { adapter },
      script: 'printf "UID=%s\\n" "$(/usr/bin/id -u)"\n/usr/bin/awk \'/^NoNewPrivs:/ {print "NNP=" $2}\' /proc/self/status\n',
      versionCommand: 'printf "1.2.3\\n"',
    }));
    await until(() => engine.get(job.id).finishedAt, 20000);
    assert.equal(engine.get(job.id).state, 'succeeded');
    const text = engine.logs(job.id).live.map(line => line.text).join('\n');
    assert.match(text, new RegExp(`UID=${executor.builder.uid}`));
    assert.match(text, /NNP=1/);
    assert.equal(engine.get(job.id).version, '1.2.3');
    assert.deepEqual(await fs.readdir(store.jobDirectory(job.id)), ['job.json']);
  }
});

test('native cancellation kills the owned child tree but not unrelated processes', { skip: !enabled }, async t => {
  const { engine } = await fixture(t);
  const unrelated = spawn('/usr/bin/sleep', ['90'], { stdio: 'ignore' });
  t.after(() => unrelated.kill('SIGTERM'));
  const job = await engine.submit(deploymentRequest({
    script: '/usr/bin/sleep 90 &\nprintf "CHILD=%s\\n" "$!"\nwait\n',
  }));
  let child;
  await until(() => {
    child = engine.logs(job.id).live.map(line => /^CHILD=(\d+)$/.exec(line.text)).find(Boolean);
    return child;
  }, 10000);
  await engine.cancel(job.id);
  await until(() => engine.get(job.id).finishedAt, 20000);
  assert.equal(engine.get(job.id).state, 'cancelled');
  await until(() => !alive(Number(child[1])), 5000);
  assert.equal(alive(unrelated.pid), true);
});

test('a native step also has a systemd deadline independent of the JavaScript job timer', { skip: !enabled }, async t => {
  const { executor } = await fixture(t);
  const began = Date.now();
  await assert.rejects(executor.run(executor.builder, {
    jobId: crypto.randomUUID(), policy: { timeoutSeconds: 1 }, signal: new AbortController().signal,
    onOutput: () => {},
  }, 'fixture-deadline', '/', ['/usr/bin/sleep', '90']), error => error.code === 'step_failed');
  assert.ok(Date.now() - began < 10000);
});

test('stopping the fixture broker stops bound units; recovery records interruption without replay', { skip: !enabled }, async t => {
  const { engine, store, executor, unitName } = await fixture(t);
  const id = crypto.randomUUID(), at = new Date().toISOString();
  const job = {
    id, requestId: crypto.randomUUID(), project: 'FixtureApp', target: 'dev', revision: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64), fingerprint: 'c'.repeat(64), adapter: 'script',
    state: 'running', phase: 'starting', createdAt: at, startedAt: at, version: null,
    events: [{ seq: 1, at, phase: 'starting', state: 'running' }], lastSeq: 1,
  };
  await store.saveJob(job);
  const lines = [];
  const running = executor.run(executor.builder, {
    jobId: id, policy: { timeoutSeconds: 60 }, signal: new AbortController().signal,
    onOutput: text => lines.push(text),
  }, 'fixture-child', '/', ['/usr/bin/bash', '-s'], {
    input: '/usr/bin/sleep 90 &\nprintf "CHILD=%s\\n" "$!"\nwait\n',
  });
  const stopped = assert.rejects(running, error => error.code === 'interrupted');
  stopped.catch(() => {});
  let child;
  await until(() => { child = /CHILD=(\d+)/.exec(lines.join('')); return child; }, 10000);
  await executor.stopUnit(unitName);
  await stopped;
  await until(() => !alive(Number(child[1])), 5000);
  await engine.init();
  assert.equal(engine.get(id).state, 'interrupted');
  assert.equal(engine.get(id).errorCode, 'worker_restarted');
  assert.equal((await store.loadJobs()).find(item => item.id === id).state, 'interrupted');
  assert.equal(engine.active.size, 0);
});

test('restart reclaims deferred source after a terminal unsafe-stop outcome without replay', { skip: !enabled }, async t => {
  const { engine, store, executor } = await fixture(t);
  const id = crypto.randomUUID(), at = new Date().toISOString();
  await store.saveJob({
    id, requestId: crypto.randomUUID(), project: 'FixtureApp', target: 'dev', revision: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64), fingerprint: 'c'.repeat(64), adapter: 'script',
    state: 'failed', phase: 'failed', errorCode: 'cancellation_failed',
    createdAt: at, startedAt: at, finishedAt: at, version: null,
    events: [{ seq: 1, at, phase: 'cleanup_deferred', state: 'running' },
      { seq: 2, at, phase: 'failed', state: 'failed', code: 'cancellation_failed' }], lastSeq: 2,
  });
  for (const name of ['stage', 'home', 'artifacts']) {
    const directory = path.join(store.jobDirectory(id), name);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'synthetic-fixture.txt'), 'fixture-only\n');
  }
  let recoveries = 0;
  const recover = executor.recover.bind(executor);
  executor.recover = async (...args) => { recoveries++; return recover(...args); };
  await engine.init();
  assert.equal(engine.get(id).state, 'failed');
  assert.equal(engine.get(id).phase, 'recovery_complete');
  assert.deepEqual(await fs.readdir(store.jobDirectory(id)), ['job.json']);
  await engine.init();
  assert.equal(recoveries, 1);
  assert.equal(engine.active.size, 0);
});
