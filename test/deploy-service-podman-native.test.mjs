import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { HostExecutor } from '../app/deployment/executor.js';
import { JobStore } from '../app/deployment/store.js';
import { snapshotDigest, resourceName } from '../app/deployment/protocol.js';
import { redactOutput } from '../app/deployment/output.js';
import { deploymentConfig, deploymentRequest, until } from './deploy-service-fixtures.mjs';

const runtime = process.env.PW_DEPLOY_FIXTURE_RUNTIME;
const enabled = process.platform === 'linux' && process.getuid() === 0
  && process.env.PW_DEPLOY_NATIVE_FIXTURE === '1' && !!runtime;
const exec = promisify(execFile);

test('native Podman builds, imports, activates, backs out failed health and removes only fixture artifacts',
  { skip: !enabled, timeout: 120000 }, async t => {
    const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.deploy-podman-'));
    await fs.chmod(root, 0o711);
    const project = `deployfixture-${crypto.randomBytes(6).toString('hex')}`;
    const service = resourceName(project, 'dev');
    const latest = `localhost/${service}:latest`;
    const unitName = `pw-deploy-fixture-${crypto.randomUUID()}.service`;
    const config = deploymentConfig({
      stateDir: path.join(root, 'state'), buildUser: runtime, runtimeUser: runtime,
      unitName, defaultTimeoutSeconds: 90, adapters: ['podman'],
    });
    const executor = new HostExecutor(config);
    await executor.init();
    const store = new JobStore(config.stateDir);
    const fatal = [];
    const engine = new DeploymentEngine({ config, store, executor, onFatal: error => fatal.push(error) });
    const control = () => ({
      jobId: crypto.randomUUID(), policy: { timeoutSeconds: 30 }, signal: AbortSignal.timeout(30000),
      onOutput: () => {},
    });
    const run = (phase, argv, options = {}) => executor.run(executor.runtime, control(), phase, '/', argv, options);
    const podman = (phase, argv, options = {}) => run(phase,
      ['/usr/bin/podman', '--cgroup-manager=cgroupfs', ...argv], { privilegedHelpers: true, ...options });
    const systemctl = (phase, argv, options = {}) => run(phase, ['/usr/bin/systemctl', '--user', ...argv], options);
    const health = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: '0.0.0' }));
    });
    const submitted = [];
    async function finished(job) {
      try { await until(() => engine.get(job.id).finishedAt, 60000); }
      catch (error) {
        t.diagnostic(redactOutput(JSON.stringify({ job: engine.get(job.id), log: engine.logs(job.id) }),
          [runtime, String(executor.runtime.uid)]));
        throw error;
      }
    }
    let anchor = false, target = false;
    t.after(async () => {
      await engine.close();
      health.closeAllConnections();
      await new Promise(resolve => health.close(resolve));
      if (target) {
        await systemctl('fixture-stop', ['stop', `${service}.service`]);
        const exists = await podman('fixture-container-exists', ['container', 'exists', service], { allowedExitCodes: [0, 1] });
        if (exists.exitCode === 0) await podman('fixture-remove', ['rm', '--force', service]);
      }
      if (anchor) {
        for (const tag of [latest, `localhost/${service}:rollback`,
          ...submitted.map(job => `localhost/${service}:candidate-${job.id}`)]) {
          const exists = await podman('fixture-image-exists', ['image', 'exists', tag], { allowedExitCodes: [0, 1] });
          if (exists.exitCode === 0) await podman('fixture-image-remove', ['image', 'rm', '--no-prune', tag]);
        }
        await executor.stopUnit(unitName);
      }
      await fs.rm(root, { recursive: true, force: true });
      assert.deepEqual(fatal, []);
    });
    await exec('/usr/bin/systemd-run', [
      '--quiet', '--collect', '--service-type=exec', `--unit=${unitName}`, '--uid=nobody',
      '--property=NoNewPrivileges=yes', '--property=RuntimeMaxSec=180s', '/usr/bin/sleep', '180',
    ], { timeout: 10000 });
    anchor = true;
    await engine.init();
    await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
    // Public cached base only: no application image, data mount or production service.
    await podman('fixture-base-tag', ['tag', 'docker.io/library/debian:12', latest]);
    await run('fixture-unit', [
      '/usr/bin/systemd-run', '--user', '--quiet', '--collect', `--unit=${service}.service`, '--service-type=notify',
      '--property=Delegate=yes', '--property=KillMode=control-group', '--property=RuntimeMaxSec=180s',
      '--property=NotifyAccess=all', '--property=TimeoutStopSec=20s',
      `--property=ExecStop=/usr/bin/podman --cgroup-manager=cgroupfs stop --ignore -t 10 ${service}`,
      `--property=ExecStopPost=/usr/bin/podman --cgroup-manager=cgroupfs rm --force --ignore ${service}`,
      '/usr/bin/podman', '--cgroup-manager=cgroupfs', 'run', '--sdnotify=conmon', '--replace', '--rm', '--pull=never',
      '--network=none', '--read-only', '--name', service, '--entrypoint=/bin/sleep', latest, '180',
    ]);
    target = true;
    const sourceFiles = [{
      path: 'Dockerfile', executable: false,
      data: Buffer.from('FROM docker.io/library/debian:12\nCOPY VERSION /fixture-version.json\n').toString('base64'),
    }];
    const request = deploymentRequest({
      requestId: crypto.randomUUID(), project, target: 'dev', script: '',
      source: { files: sourceFiles, sha256: snapshotDigest(sourceFiles) },
      recipe: { adapter: 'podman', versionFile: 'VERSION', versionFormat: 'json' },
    });
    const first = await engine.submit(request);
    submitted.push(first);
    await finished(first);
    assert.equal(engine.get(first.id).state, 'succeeded',
      JSON.stringify({ job: engine.get(first.id), log: engine.logs(first.id) }));
    assert.deepEqual(await fs.readdir(store.jobDirectory(first.id)), ['job.json']);
    const oldImage = (await podman('fixture-read-image',
      ['inspect', '--format', '{{.Image}}', service], { capture: true })).output;
    const second = await engine.submit({
      ...request, requestId: crypto.randomUUID(), revision: 'b'.repeat(40),
      recipe: { ...request.recipe, healthUrl: `http://127.0.0.1:${health.address().port}/health`, versionField: 'version' },
    });
    submitted.push(second);
    await finished(second);
    assert.equal(engine.get(second.id).state, 'failed');
    assert.equal(engine.get(second.id).errorCode, 'version_mismatch');
    assert.ok(engine.logs(second.id).events.some(event => event.phase === 'rollback_restored'));
    const restored = (await podman('fixture-read-restored',
      ['inspect', '--format', '{{.State.Running}} {{.Image}}', service], { capture: true })).output;
    assert.equal(restored, `true ${oldImage}`);
    assert.deepEqual(await fs.readdir(store.jobDirectory(second.id)), ['job.json']);
    for (const job of submitted) {
      const exists = await podman('fixture-candidate-check',
        ['image', 'exists', `localhost/${service}:candidate-${job.id}`], { allowedExitCodes: [0, 1] });
      assert.equal(exists.exitCode, 1);
    }
  });
