import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deploymentRequest, until } from './deploy-service-fixtures.mjs';
import { HostExecutor } from '../app/deployment/executor.js';

const enabled = process.platform === 'linux' && process.getuid() === 0
  && process.env.PW_DEPLOY_NATIVE_FIXTURE === '1';
const exec = promisify(execFile);
const serviceFile = fileURLToPath(new URL('../app/deployment/service.js', import.meta.url));

test('the actual broker starts in its supervisor, serves protected jobs, and restores metadata after restart',
  { skip: !enabled, timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.deploy-startup-'));
    await fs.chmod(root, 0o711);
    const unitName = `pw-deploy-fixture-${crypto.randomUUID()}.service`;
    const socketPath = path.join(root, 'control.sock');
    const configPath = path.join(root, 'config.json');
    const tokenFile = path.join(root, 'fixture.token');
    const token = 'fixture-only-broker-credential-not-used-in-production';
    const stateDir = path.join(root, 'state');
    const config = {
      unitName, listen: { socketPath }, tokenFile, stateDir,
      buildUser: 'nobody', runtimeUser: 'nobody', adapters: ['script', 'iis'],
      defaultTimeoutSeconds: 60,
    };
    const executor = new HostExecutor(config);
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    t.after(async () => {
      await executor.stopUnit(unitName);
      await fs.rm(root, { recursive: true, force: true });
    });
    async function start() {
      await exec('/usr/bin/systemd-run', [
        '--quiet', '--collect', '--service-type=exec', `--unit=${unitName}`, '--property=RuntimeMaxSec=90s',
        '/usr/bin/node', serviceFile, '--config', configPath,
      ], { timeout: 10000 });
      await until(() => existsSync(socketPath), 10000);
    }
    function api(route, body, credential = token) {
      return new Promise((resolve, reject) => {
        const request = http.request({
          socketPath, path: route, method: body === undefined ? 'GET' : 'POST', agent: false,
          headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        }, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { text += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
            catch (error) { reject(error); }
          });
        });
        request.setTimeout(3000, () => request.destroy(new Error('Fixture API timeout')));
        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    async function waitFor(id, expected) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const response = await api(`/v1/jobs/${id}`);
        assert.equal(response.status, 200);
        if (expected(response.body.job)) return response.body.job;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('Broker job did not reach the expected state');
    }
    await start();
    assert.equal((await api('/health', undefined, '')).status, 200);
    assert.equal((await api('/v1/jobs', undefined, '')).status, 401);
    assert.equal((await api('/v1/health')).body.ready, true);
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    const first = await api('/v1/jobs', deploymentRequest({ project: 'BootstrapFixture', target: 'dev',
      versionCommand: 'printf "1.2.3\\n"' }));
    assert.equal(first.status, 202);
    const completed = await waitFor(first.body.job.id, job => job.state === 'succeeded');
    assert.equal(completed.version, '1.2.3');
    const second = await api('/v1/jobs', deploymentRequest({
      requestId: crypto.randomUUID(), project: 'BootstrapFixture', target: 'dev',
      script: 'printf "fixture-started\\n"\n/usr/bin/sleep 60\n',
    }));
    await waitFor(second.body.job.id, job => job.phase === 'deploying');
    await executor.stopUnit(unitName);
    await until(() => !existsSync(socketPath), 10000);
    await start();
    const interrupted = await waitFor(second.body.job.id, job => job.state === 'interrupted');
    assert.ok(['interrupted', 'worker_restarted'].includes(interrupted.errorCode));
    const version = await api('/v1/version/BootstrapFixture/dev');
    assert.equal(version.body.version, '1.2.3');
    assert.deepEqual(await fs.readdir(path.join(stateDir, 'jobs', interrupted.id)), ['job.json']);
  });
