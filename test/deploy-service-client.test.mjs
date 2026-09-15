import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { DeploymentClient } from '../app/deployment/client.js';
import { API_VERSION, SERVICE_NAME, DeploymentError } from '../app/deployment/protocol.js';
import { createDeploymentServer } from '../app/deployment/service.js';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { deploymentRequest, deploymentConfig, MemoryJobStore, until } from './deploy-service-fixtures.mjs';

const TOKEN = 'synthetic-service-credential-0123456789';
const health = { ok: true, service: SERVICE_NAME, apiVersion: API_VERSION, ready: true, running: 0, queued: 0 };
const job = changes => ({ id: crypto.randomUUID(), requestId: 'fixture-request-1', project: 'ExampleApp', target: 'prod',
  revision: 'a'.repeat(40), adapter: 'script', state: 'queued', phase: 'queued', createdAt: '2026-09-15T12:00:00.000Z', version: null, ...changes });
const reply = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

async function fixture(t, handler, options = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { path: req.url, method: req.method, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
    requests.push(request);
    if (req.url === '/v1/health' && options.health !== false) reply(res, options.health || health);
    else handler(request, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { requests, endpoint, client: new DeploymentClient({ endpoint, token: TOKEN, ...options.client }) };
}

test('client: rejects insecure, credential-bearing and malformed endpoints before connecting', () => {
  for (const endpoint of ['http://remote.example.test', 'ftp://localhost', 'file:///private',
    'https://user:password@example.test', 'https://example.test?token=x', 'https://example.test#fragment', 'unix:relative',
    'unix:/socket\nheader', 'javascript:alert(1)']) {
    assert.throws(() => new DeploymentClient({ endpoint, token: TOKEN }), DeploymentError, endpoint);
  }
  for (const token of ['', undefined, 'secret\r\nX-Header: injected', 'contains a space']) {
    assert.throws(() => new DeploymentClient({ endpoint: 'http://localhost:1', token }), DeploymentError);
  }
});

test('client: checks authenticated protocol before submitting the exact validated job, with no credentials in public output', async t => {
  const f = await fixture(t, (req, res) => reply(res, { ok: true, job: job({
    requestId: req.body.requestId, source: req.body.source, secrets: req.body.secrets, script: req.body.script,
  }) }, 202));
  const request = deploymentRequest({ requestId: crypto.randomUUID(), secrets: { DEPLOY_PASSWORD: 'synthetic-deploy-password' } });
  const result = await f.client.submit(request);
  assert.deepEqual(f.requests.map(req => req.path), ['/v1/health', '/v1/jobs']);
  assert.ok(f.requests.every(req => req.authorization === `Bearer ${TOKEN}`));
  assert.equal(f.requests[1].body.source.sha256, request.source.sha256);
  assert.equal(f.requests[1].body.secrets.DEPLOY_PASSWORD, request.secrets.DEPLOY_PASSWORD);
  assert.equal(result.revision, request.revision);
  assert.equal(result.script, undefined);
  assert.equal(result.source, undefined);
  assert.equal(result.secrets, undefined);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('client: wrong service, unknown protocol, false readiness, or a login page never enqueue', async t => {
  for (const response of [{ ...health, apiVersion: 99 }, { ...health, service: 'login' }, { ...health, ready: false }, { ok: true }]) {
    const f = await fixture(t, (_req, res) => reply(res, { ok: true }), { health: response });
    await assert.rejects(f.client.submit(deploymentRequest()), /compatible|not ready/);
    assert.deepEqual(f.requests.map(req => req.path), ['/v1/health']);
  }
  const login = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<form>Sign in</form>'); }, { health: false });
  await assert.rejects(login.client.health(), /compatible/);
});

test('client: redirects are refused without sending a credential to the redirect destination', async t => {
  const destination = await fixture(t, (_req, res) => reply(res, health), { health: false });
  const origin = await fixture(t, (_req, res) => { res.writeHead(302, { Location: destination.endpoint }); res.end(); }, { health: false });
  await assert.rejects(origin.client.health(), error => error.code === 'deployment_redirect');
  assert.equal(destination.requests.length, 0);
  assert.equal(origin.requests.length, 1);
});

test('client: upstream error bodies cannot echo credentials, URLs, or raw exception text', async t => {
  const f = await fixture(t, (_req, res) => reply(res, { ok: false, code: 'unauthorized', error: `Bearer ${TOKEN} private/path` }, 401), { health: false });
  await assert.rejects(f.client.health(), error => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /credential/);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes('private/path'));
    return true;
  });
});

test('client: timeouts and bounded responses fail explicitly without retry', async t => {
  const stalled = await fixture(t, () => {}, { health: false, client: { timeoutMs: 30 } });
  await assert.rejects(stalled.client.health(), error => error.code === 'deployment_timeout');
  assert.equal(stalled.requests.length, 1);
  const oversized = await fixture(t, (_req, res) => reply(res, { ...health, excess: 'x'.repeat(5000) }), {
    health: false, client: { maxResponseBytes: 1024 },
  });
  await assert.rejects(oversized.client.health(), error => error.code === 'deployment_response_too_large');
});

test('client: malformed or cross-project jobs are not accepted as valid history', async t => {
  const f = await fixture(t, (_req, res) => reply(res, { ok: true, jobs: [job({ project: 'OtherApp' })] }));
  await assert.rejects(f.client.jobs({ project: 'ExampleApp' }), /compatible/);
  const g = await fixture(t, (_req, res) => reply(res, { ok: true, job: job({ revision: 'main' }) }));
  await assert.rejects(g.client.job('fixture-id-123'), /compatible/);
  assert.throws(() => new DeploymentClient({ endpoint: f.endpoint, token: TOKEN, timeoutMs: 0 }), DeploymentError);
});

test('client: logs retain text, bound cursor data, and redact service credentials', async t => {
  const id = crypto.randomUUID();
  const f = await fixture(t, (_req, res) => reply(res, { ok: true, events: [
    { seq: 1, at: '2026-09-15T12:00:00Z', phase: 'starting', private: TOKEN },
  ], live: [{ seq: 2, at: '2026-09-15T12:00:01Z', text: `<img onerror=alert(1)> ${TOKEN} Bearer other-secret\n`, account: 'private-account' }], nextSeq: 2 }));
  const result = await f.client.log(id);
  assert.match(result.live[0].text, /<img/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes('other-secret'));
  assert.equal(result.events[0].private, undefined);
  assert.equal(result.live[0].account, undefined);
  await assert.rejects(f.client.log(id, -1), /numeric/);
});

test('client: base endpoint paths are preserved and resource path traversal is rejected', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.path, '/broker/v1/health');
    reply(res, health);
  }, { health: false });
  const client = new DeploymentClient({ endpoint: `${f.endpoint}/broker/`, token: TOKEN });
  assert.equal((await client.health()).apiVersion, 1);
  await assert.rejects(client.job('../other'), /job ID/);
  await assert.rejects(client.version('ExampleApp', '../settings'), /Target/);
});

test('client: interoperates with the host HTTP API, including history, versions and admin controls', async t => {
  let hold = false;
  const engine = new DeploymentEngine({ config: deploymentConfig(), store: new MemoryJobStore(), executor: {
    deploy: async (_request, hooks) => {
      await hooks.onEvent('publishing');
      hooks.onOutput('synthetic build output\n');
      if (hold) await new Promise((_resolve, reject) => {
        if (hooks.signal.aborted) reject(hooks.signal.reason);
        else hooks.signal.addEventListener('abort', () => reject(hooks.signal.reason), { once: true });
      });
      return { version: '1.2.3' };
    },
  } });
  await engine.init();
  const server = createDeploymentServer({ engine, token: TOKEN });
  const statuses = [];
  server.on('request', (request, response) => response.once('finish', () => {
    statuses.push({ method: request.method, path: request.url, status: response.statusCode });
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const client = new DeploymentClient({ endpoint, token: TOKEN });
  const publicHealth = await fetch(`${endpoint}/health`);
  assert.equal(publicHealth.status, 200);
  assert.deepEqual(await publicHealth.json(), { ok: true, service: SERVICE_NAME, apiVersion: API_VERSION });
  assert.equal((await fetch(`${endpoint}/v1/health`)).status, 401);
  assert.deepEqual(await client.targets(), []);
  const submitted = await client.submit(deploymentRequest({ requestId: crypto.randomUUID() }));
  assert.ok(statuses.some(response => response.method === 'POST' && response.path === '/v1/jobs' && response.status === 202));
  await until(() => engine.get(submitted.id).state === 'succeeded');
  assert.equal((await client.job(submitted.id)).state, 'succeeded');
  assert.equal((await client.jobs({ project: 'ExampleApp', target: 'prod' })).length, 1);
  assert.equal((await client.version('ExampleApp', 'prod')).version, '1.2.3');
  assert.ok((await client.log(submitted.id)).events.some(event => event.phase === 'succeeded'));
  assert.equal((await client.targets())[0].project, 'ExampleApp');
  await assert.rejects(client.job('missing-job-001'), error => error.statusCode === 404 && error.code === 'job_not_found');
  await assert.rejects(client.submit(deploymentRequest({ requestId: crypto.randomUUID(), recipe: { adapter: 'podman', image: 'unrelated-image' } })),
    error => error.statusCode === 403 && error.code === 'resource_not_allowed');
  hold = true;
  const active = await client.submit(deploymentRequest({ requestId: crypto.randomUUID(), target: 'dev' }));
  await until(() => engine.get(active.id).state === 'running');
  assert.equal((await client.cancel(active.id)).id, active.id);
  await until(() => engine.get(active.id).state === 'cancelled');
  assert.ok(statuses.some(response => response.method === 'POST' && response.path === `/v1/jobs/${active.id}/cancel` && response.status === 200),
    'the real service accepts only JSON {} for cancellation');
  assert.equal((await client.updateTarget('ExampleApp', 'prod', { paused: true, timeoutSeconds: 90 })).timeoutSeconds, 90);
  assert.equal((await client.updateSettings({ paused: true, maxConcurrent: 2, retentionDays: 8 })).paused, true);
  assert.equal((await client.settings()).maxConcurrent, 2);
  const settings = await (await fetch(`${endpoint}/v1/settings`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(settings.paused, true);
  assert.equal(settings.maxConcurrent, 2);
  assert.equal(settings.settings, undefined, 'core settings stay flat on the wire');
  await assert.rejects(client.submit(deploymentRequest({ requestId: crypto.randomUUID() })), error => error.code === 'target_paused');
});
