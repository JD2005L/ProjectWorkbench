import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeploymentServer } from '../app/deployment/service.js';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { deploymentConfig, deploymentRequest, MemoryJobStore, until } from './deploy-service-fixtures.mjs';

const TOKEN = 'fixture-only-service-token-not-a-real-credential';

async function fixture(t) {
  let executions = 0;
  const engine = new DeploymentEngine({
    config: deploymentConfig(), store: new MemoryJobStore(),
    executor: { async deploy() { executions++; return { version: '1.0.0' }; } },
  });
  await engine.init();
  const server = createDeploymentServer({ engine, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    engine, executions: () => executions,
    send(route, { body, method = body === undefined ? 'GET' : 'POST', token = TOKEN } = {}) {
      return fetch(base + route, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
  };
}

test('only minimal health is public; all worker data and controls require the service token', async t => {
  const app = await fixture(t);
  const health = await (await app.send('/health', { token: '' })).json();
  assert.deepEqual(Object.keys(health).sort(), ['apiVersion', 'ok', 'service']);
  for (const route of ['/v1/health', '/v1/jobs', '/v1/settings', '/v1/targets']) {
    assert.equal((await app.send(route, { token: '' })).status, 401);
    assert.equal((await app.send(route, { token: 'incorrect' })).status, 401);
  }
  assert.equal((await app.send('/v1/jobs', { token: '', body: deploymentRequest() })).status, 401);
  assert.equal(app.executions(), 0);
});

test('HTTP submission supports a previously unseen project and exposes only safe job data', async t => {
  const app = await fixture(t);
  const response = await app.send('/v1/jobs', { body: deploymentRequest({ project: 'PreviouslyUnseen',
    secrets: { DEPLOY_PASSWORD: 'fixture-private-value' } }) });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  await until(() => app.engine.get(job.id).state === 'succeeded');
  for (const route of [`/v1/jobs/${job.id}`, '/v1/jobs', `/v1/jobs/${job.id}/log`, '/v1/targets']) {
    const text = await (await app.send(route)).text();
    assert.equal(text.includes('fixture-private-value'), false);
    assert.equal(text.includes('bash deploy/prod.sh'), false);
  }
  const version = await (await app.send('/v1/version/PreviouslyUnseen/prod')).json();
  assert.equal(version.version, '1.0.0');
  assert.equal(version.revision, 'a'.repeat(40));
});

test('malformed requests, root execution fields and arbitrary host paths fail before execution', async t => {
  const app = await fixture(t);
  for (const body of [{ ...deploymentRequest(), uid: 0 },
    { ...deploymentRequest(), sourcePath: '/etc/passwd' },
    { ...deploymentRequest(), apiVersion: 99 }]) {
    assert.equal((await app.send('/v1/jobs', { body })).status, 400);
  }
  assert.equal(app.executions(), 0);
  assert.equal((await app.send('/v1/jobs?limit=invalid')).status, 400);
  assert.equal((await app.send('/v1/jobs/absent')).status, 404);
  assert.equal((await app.send('/v1/settings', { method: 'PUT', body: { runAsRoot: true } })).status, 400);
});

test('operational administration is bounded and no target registry entry is required by default', async t => {
  const app = await fixture(t);
  assert.equal((await app.send('/v1/settings', { method: 'PUT', body: { maxConcurrent: 2 } })).status, 200);
  assert.equal((await app.send('/v1/settings', { method: 'PUT', body: { maxConcurrent: 20 } })).status, 400);
  assert.equal((await app.send('/v1/targets/ExampleApp/prod', { method: 'PUT', body: { paused: true } })).status, 200);
  assert.equal((await app.send('/v1/jobs', { body: deploymentRequest() })).status, 423);
  assert.equal((await app.send('/v1/jobs', { body: deploymentRequest({ project: 'OtherProject' }) })).status, 202);
});
