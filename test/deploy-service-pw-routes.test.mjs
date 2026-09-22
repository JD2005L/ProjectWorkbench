import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mountDeploymentRoutes } from '../app/deployment/routes.js';
import { createDeploymentService, buildDeploymentJob } from '../app/deployment/pw.js';
import { DeploymentError, snapshotDigest } from '../app/deployment/protocol.js';
import { resolveDeployManifest } from '../app/deploy-manifest.js';
import { deployRouteHarness, functionSource, serverSource } from './deploy-manifest-harness.mjs';

const express = createRequire(new URL('../app/package.json', import.meta.url))('express');
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'synthetic-service-credential-0123456789';
const health = { ok: true, service: 'pw-deploy', apiVersion: 1, ready: true, running: 1, queued: 0 };
const makeJob = (id, project, target = 'dev', state = 'running') => ({ id, project, target, state, phase: state,
  revision: 'a'.repeat(40), createdAt: '2026-09-15T12:00:00Z', adapter: 'script', version: null });

async function apiFixture(t, options = {}) {
  const projects = [{ name: 'OwnApp' }, { name: 'OtherApp' }, { name: 'AdminApp', adminOnly: true }];
  const users = {
    admin: { username: 'fixture-admin', role: 'admin', projects: '*' },
    developer: { username: 'fixture-developer', role: 'developer', projects: ['OwnApp'] },
    wildcard: { username: 'fixture-wildcard', role: 'developer', projects: '*' },
  };
  const jobs = [makeJob('job-own-001', 'OwnApp'), makeJob('job-other-001', 'OtherApp'),
    makeJob('job-admin-001', 'AdminApp'), makeJob('job-removed-001', 'RemovedApp'),
    makeJob('job-production-001', 'OwnApp', 'prod'), makeJob('job-finished-001', 'OwnApp', 'dev', 'succeeded')];
  const calls = [], audit = [];
  const client = {
    health: async () => health,
    job: async id => {
      calls.push(['job', id]);
      const result = jobs.find(job => job.id === id);
      if (!result) throw new DeploymentError('No job', 404, 'not_found');
      return structuredClone(result);
    },
    jobs: async ({ project, target }) => {
      calls.push(['jobs', project, target]);
      return jobs.filter(job => (!project || project === job.project) && (!target || target === job.target)).map(job => structuredClone(job));
    },
    log: async id => { calls.push(['log', id]); return { events: [], live: [{ seq: 1, at: '2026-09-15T12:00:00Z', text: 'own operational text' }], nextSeq: 1 }; },
    cancel: async id => { calls.push(['cancel', id]); const job = jobs.find(job => job.id === id); job.state = 'cancelled'; return structuredClone(job); },
    targets: async () => { calls.push(['targets']); return []; },
    settings: async () => ({ paused: false, maxConcurrent: 1, defaultTimeoutSeconds: 600, retentionDays: 7 }),
    updateSettings: async value => { calls.push(['settings', value]); return value; },
    updateTarget: async (project, target, value) => ({ project, target, ...value }),
    version: async () => ({ version: '1.2.3', revision: 'a'.repeat(40), deployedAt: '2026-09-15T12:00:00Z' }),
  };
  const middleware = vm.runInNewContext([
    ...['esc', 'wantsJson', 'requireAuth', 'requireAdmin', 'userHasProjectAccess', 'filterProjectsForUser', 'requireProjectAccess'].map(functionSource),
    '({ requireAuth, requireAdmin, requireProjectAccess, filterProjectsForUser })',
  ].join('\n'), { BASE: '/pw', loadProjects: async () => projects });
  const service = {
    client: async () => { if (options.connectionError) throw options.connectionError; return options.local ? null : client; },
    requiredClient: async (selection) => {
      calls.push(['required-client', selection?.forceExternal]);
      if (options.connectionError) throw options.connectionError;
      return client;
    },
    settingsStore: {
      load: async () => ({ deployment: { backend: options.local ? 'local' : 'external', endpoint: 'https://deploy.example.test', credential: 'enc:YWJjZA==',
        ...(options.consoleUrl ? { consoleUrl: options.consoleUrl } : {}) } }),
      updateDeployment: async body => { calls.push(['backend', body]); return { backend: body.backend, endpoint: 'https://deploy.example.test', hasCredential: true }; },
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-fixture-user')] || null; next(); });
  mountDeploymentRoutes(app, { base: '/pw', service, ...middleware, loadProjects: async () => projects,
    audit: async (event, detail) => audit.push({ event, ...detail }) });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { user = 'developer', method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${origin}/pw${route}`, { method, redirect: 'manual',
      headers: { 'x-fixture-user': user, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  return { request, calls, audit, client, jobs };
}

test('PW API: status, logs and cancellation use actual project access gates before returning or mutating another project', async t => {
  const f = await apiFixture(t);
  for (const user of ['developer', 'wildcard']) {
    for (const id of user === 'developer' ? ['job-other-001', 'job-admin-001', 'job-removed-001'] : ['job-admin-001', 'job-removed-001']) {
      for (const [suffix, method] of [['', 'GET'], ['/log', 'GET'], ['/cancel', 'POST']]) {
        const result = await f.request(`/api/deploy-service/jobs/${id}${suffix}`, { user, method, ...(method === 'POST' ? { body: {} } : {}) });
        assert.equal(result.status, 403, `${user} ${id} ${suffix}`);
        assert.ok(!JSON.stringify(result.body).includes('own operational'));
      }
    }
  }
  assert.ok(!f.calls.some(call => call[0] === 'log' || call[0] === 'cancel'));
  assert.equal((await f.request('/api/deploy-service/jobs/job-own-001/log')).status, 200);
  assert.equal((await f.request('/api/deploy-service/jobs/job-other-001/log', { user: 'admin' })).status, 200);
  assert.equal((await f.request('/api/deploy-service/jobs/job-removed-001', { user: 'admin' })).status, 200);
});

test('PW API: job list queries only authorized projects, applies target/state filters and lets admin see all', async t => {
  const f = await apiFixture(t);
  const own = await f.request('/api/deploy-service/jobs?target=prod&state=running');
  assert.deepEqual(own.body.jobs.map(job => job.id), ['job-production-001']);
  assert.deepEqual(f.calls.filter(call => call[0] === 'jobs').map(call => call[1]), ['OwnApp']);
  const forbidden = await f.request('/api/deploy-service/jobs?project=OtherApp');
  assert.equal(forbidden.status, 403);
  const all = await f.request('/api/deploy-service/jobs', { user: 'admin' });
  assert.equal(all.body.jobs.length, 6);
  assert.equal((await f.request('/api/deploy-service/jobs?limit=201')).status, 400);
  assert.equal((await f.request('/api/deploy-service/jobs?state=unknown')).status, 400);
});

test('PW API: backend, diagnostics, target and service settings require ADMIN, never trusted-loopback privilege', async t => {
  const f = await apiFixture(t);
  const routes = [['/backend', 'GET'], ['/backend', 'PUT'], ['/diagnostics', 'GET'], ['/connection/test', 'POST'],
    ['/targets', 'GET'], ['/targets/OwnApp/dev', 'PUT'], ['/settings', 'GET'], ['/settings', 'PUT']];
  for (const [route, method] of routes) {
    assert.equal((await f.request(`/api/deploy-service${route}`, { method, body: method === 'GET' ? undefined : {} })).status, 403);
    assert.equal((await f.request(`/api/deploy-service${route}`, { user: '', method, body: method === 'GET' ? undefined : {} })).status, 401);
  }
  assert.ok(!f.calls.some(call => ['backend', 'targets', 'settings'].includes(call[0])));
  const backend = await f.request('/api/deploy-service/backend', { user: 'admin' });
  assert.equal(backend.body.deployment.hasCredential, true);
  assert.ok(!JSON.stringify(backend.body).includes('enc:'));
});

test('PW API: cancelling is a visible filterable active state, not an unknown protocol state', async t => {
  const f = await apiFixture(t);
  f.jobs[0].state = 'cancelling';
  f.jobs[0].phase = 'cancelling';
  const result = await f.request('/api/deploy-service/jobs?state=cancelling');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.jobs.map(job => job.id), ['job-own-001']);
});

test('PW API: mutating service routes enforce same-origin even on loopback, with no machine-token bypass', async t => {
  const f = await apiFixture(t);
  for (const headers of [{ Origin: '' }, { Origin: 'https://attacker.example.test' },
    { Origin: '', Authorization: 'Bearer pw_untrusted_synthetic' }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await f.request('/api/deploy-service/backend', { user: 'admin', method: 'PUT', body: { backend: 'external' }, headers });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'deployment_csrf');
  }
  assert.ok(!f.calls.some(call => call[0] === 'backend'));
  assert.equal((await f.request('/api/deploy-service/backend', { user: 'admin', method: 'PUT', body: { backend: 'local' } })).status, 200);
});

test('PW API: production cancellation requires explicit confirmation and terminal jobs cannot be cancelled', async t => {
  const f = await apiFixture(t);
  assert.equal((await f.request('/api/deploy-service/jobs/job-production-001/cancel', { method: 'POST', body: {} })).status, 400);
  assert.equal((await f.request('/api/deploy-service/jobs/job-finished-001/cancel', { method: 'POST', body: {} })).status, 409);
  assert.ok(!f.calls.some(call => call[0] === 'cancel'));
  const result = await f.request('/api/deploy-service/jobs/job-production-001/cancel', { method: 'POST', body: { confirmProduction: true } });
  assert.equal(result.body.job.state, 'cancelled');
  assert.deepEqual(f.calls.filter(call => call[0] === 'cancel'), [['cancel', 'job-production-001']]);
  assert.ok(!JSON.stringify(f.audit).includes(TOKEN));
});

test('PW API: job reads, logs, cancellation and version keep using the service client when the global default is local', async t => {
  const f = await apiFixture(t, { local: true });
  assert.equal((await f.request('/api/deploy-service/jobs/job-own-001')).status, 200);
  assert.equal((await f.request('/api/deploy-service/jobs/job-own-001/log')).status, 200);
  assert.equal((await f.request('/api/deploy-service/jobs/job-own-001/cancel', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/deploy-service/version/OwnApp/dev')).status, 200);
  assert.ok(f.calls.filter(call => call[0] === 'required-client').every(call => call[1] === true));
});

test('PW API: public landing health is generic JSON, not a login redirect or administrative diagnostics', async t => {
  const ready = await apiFixture(t);
  const result = await ready.request('/api/deploy-service/health', { user: '' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, backend: 'external', ready: true });
  assert.ok(!JSON.stringify(result.body).match(/token|endpoint|target|account|running|queued/i));
  const broken = await apiFixture(t, { connectionError: new DeploymentError(`private ${TOKEN}`, 502, 'deployment_protocol_error') });
  const unavailable = await broken.request('/api/deploy-service/health', { user: '' });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { ok: false, ready: false });
  const page = await ready.request('/deploy-service', { user: '' });
  assert.equal(page.status, 302);
  assert.equal((await ready.request('/api/deploy-service/jobs', { user: '' })).status, 401);
});

test('PW console: configured standalone administration destination preserves only bounded job selectors', async t => {
  const f = await apiFixture(t, { local: true, consoleUrl: 'https://console.example.test/deploy-service' });
  const result = await f.request('/deploy-service?job=job-own-001&project=OwnApp&target=dev&token=not-forwarded', { user: 'admin' });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), 'https://console.example.test/deploy-service?job=job-own-001&project=OwnApp&target=dev');
  assert.equal((await f.request('/deploy-service', { user: '' })).status, 302);
  const own = await f.request('/deploy-service');
  assert.equal(own.status, 200);
  assert.match(own.body, /OwnApp/);
  assert.doesNotMatch(own.body, /OtherApp/);
  assert.equal((await f.request('/api/deploy-service/health', { user: '' })).body.backend, 'local');
});

test('PW console: no destination keeps legacy rendering; malformed selectors cannot become redirect content', async t => {
  const legacy = await apiFixture(t);
  assert.equal((await legacy.request('/deploy-service', { user: 'admin' })).status, 200);
  const f = await apiFixture(t, { consoleUrl: 'https://console.example.test/deploy-service' });
  for (const query of ['job=%2Fsecret', 'job=a&job=b', 'project=../OtherApp', 'target=unknown']) {
    const result = await f.request(`/deploy-service?${query}`, { user: 'admin' });
    assert.equal(result.status, 400);
    assert.equal(result.headers.get('location'), null);
  }
});

test('PW connection settings remain administrator-only and accessible after the standalone console is configured', async t => {
  const f = await apiFixture(t, { local: true, consoleUrl: 'https://console.example.test/deploy-service' });
  const result = await f.request('/deploy-service/connection', { user: 'admin' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('location'), null);
  assert.match(result.body, /Deployment connection/i);
  assert.equal((await f.request('/deploy-service/connection')).status, 403);
  assert.notEqual((await f.request('/deploy-service/connection', { user: '' })).status, 200);
  assert.equal((await f.request('/api/deploy-service/health', { user: '' })).body.backend, 'local');
});

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(testDirectory, '.deploy-pw-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const sourceSnapshot = files => ({ revision: 'a'.repeat(40), source: { files, sha256: snapshotDigest(files) } });

test('PW dispatch: a brand-new manifest project inherits external execution without enrollment or local commands', async t => {
  const root = await workspace(t);
  const document = { schemaVersion: 1, slots: { dev: { label: 'Development', script: 'printf deployed' } } };
  await fs.mkdir(path.join(root, '.pw'));
  await fs.writeFile(path.join(root, '.pw', 'deploy.json'), JSON.stringify(document));
  const files = [{ path: '.pw/deploy.json', data: Buffer.from(JSON.stringify(document)).toString('base64'), executable: false }];
  const submitted = [], calls = [];
  class Client {
    constructor(connection) { assert.equal(connection.token, TOKEN); }
    async health() { calls.push('health'); return health; }
    async submit(request) { submitted.push(request); return { ...makeJob('job-new-001', request.project), requestId: request.requestId, revision: request.revision }; }
    async version() { return { version: '1.0.0', revision: 'a'.repeat(40), deployedAt: null }; }
    async jobs() { return []; }
  }
  const service = createDeploymentService({ settingsStore: { connection: async () => ({ endpoint: 'https://deploy.example.test', token: TOKEN }) },
    snapshot: async input => { assert.equal(input, root); calls.push('snapshot'); return sourceSnapshot(files); }, Client });
  const harness = deployRouteHarness(root, { project: { name: 'BrandNewApp' }, config: {}, deploymentService: service });
  const manifest = await resolveDeployManifest(root, 'dev');
  const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'BrandNewApp', target: 'dev' },
    body: { inputs: {}, manifestRevision: manifest.revision } });
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.backend, 'external');
  assert.equal(result.body.job.project, 'BrandNewApp');
  assert.match(result.body.jobUrl, /^\/pw\/deploy-service\?job=/);
  assert.deepEqual(calls, ['health', 'snapshot']);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].recipe.adapter, 'script');
  assert.equal(submitted[0].revision, 'a'.repeat(40));
  assert.equal(submitted[0].environment.DEPLOY_PROJECT, 'BrandNewApp');
  assert.equal(submitted[0].environment.PATH, undefined);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.reclaims.length, 0);
  assert.equal(harness.history.length, 0);
  assert.ok(!JSON.stringify(harness.audit).includes(TOKEN));
});

test('PW dispatch: invalid configuration, missing credentials, unreachable service, and wrong protocol never fall back locally', async t => {
  const root = await workspace(t);
  for (const code of ['deployment_settings_invalid', 'deployment_credential_required', 'deployment_unreachable', 'deployment_protocol_error']) {
    const harness = deployRouteHarness(root, { deploymentService: { client: async () => { throw new DeploymentError('External deployment refused.', 503, code); } } });
    const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, code);
    assert.equal(harness.executions.length, 0);
    assert.equal(harness.history.length, 0);
  }
});

test('PW dispatch: external version/card/history surfaces never execute a saved local probe', async t => {
  const root = await workspace(t);
  const calls = [];
  const client = {
    version: async () => { calls.push('version'); return { version: '2.0.0', revision: 'a'.repeat(40), deployedAt: '2026-09-15T12:00:00Z' }; },
    jobs: async () => [makeJob('job-own-001', 'demo', 'dev', 'succeeded')],
  };
  const harness = deployRouteHarness(root, { deploymentService: { client: async () => client } });
  const version = await harness.call('GET', '/api/deploy/:project/:target/version', { params: { project: 'demo', target: 'dev' } });
  assert.equal(version.body.version, '2.0.0');
  assert.equal(version.body.metadata, true);
  const card = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
  assert.match(card.body.html, /Last successful version|not fresh runtime probes/);
  const history = await harness.call('GET', '/api/deploy/:project/log', { params: { project: 'demo' } });
  assert.equal(history.body.log[0].jobId, 'job-own-001');
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.credentialReads, 0);
  assert.ok(calls.length > 0);
});

test('PW slot backend: one explicit external slot uses the shared service while its inherited local sibling keeps local execution, history and version', async t => {
  const root = await workspace(t);
  const submitted = [];
  class Client {
    async health() { return health; }
    async submit(request) {
      submitted.push(request);
      return { ...makeJob('job-slot-external-001', request.project, request.target, 'queued'), revision: request.revision };
    }
    async version(project, target) {
      assert.equal(project, 'demo');
      assert.equal(target, 'dev');
      return { version: '2.0.0', revision: 'a'.repeat(40), deployedAt: '2026-09-15T12:00:00Z' };
    }
    async jobs() { return [makeJob('job-slot-external-001', 'demo', 'dev', 'succeeded')]; }
  }
  const service = createDeploymentService({
    settingsStore: {
      load: async () => ({ deployment: { backend: 'local' } }),
      connection: async draft => draft === undefined ? null : { endpoint: 'https://deploy.example.test', token: TOKEN },
    },
    snapshot: async () => sourceSnapshot([{ path: 'deploy.sh', data: Buffer.from('printf deployed').toString('base64'), executable: true }]),
    Client,
  });
  const harness = deployRouteHarness(root, {
    config: { demo: {
      dev: { script: 'external script', backend: 'external' },
      prod: { script: 'local script', versionCmd: 'echo local-version' },
    } },
    deploymentService: service,
    onExec: execution => ({ stdout: execution.args.includes('echo local-version') ? '1.0.0' : 'local deployed' }),
  });

  const dev = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(dev.statusCode, 202);
  assert.equal(dev.body.backend, 'external');
  assert.equal(submitted.length, 1);
  assert.equal(harness.executions.length, 0);

  const prod = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'prod' } });
  assert.equal(prod.statusCode, 200);
  assert.equal(prod.body.ok, true);
  assert.equal(harness.executions.length, 2, 'the inherited local slot runs its script and local version command');
  assert.equal(harness.history[0].backend, 'local');

  const externalVersion = await harness.call('GET', '/api/deploy/:project/:target/version', { params: { project: 'demo', target: 'dev' } });
  assert.deepEqual(externalVersion.body, { ok: true, version: '2.0.0', revision: 'a'.repeat(40), deployedAt: '2026-09-15T12:00:00Z', backend: 'external', configured: true, metadata: true });
  const localVersion = await harness.call('GET', '/api/deploy/:project/:target/version', { params: { project: 'demo', target: 'prod' } });
  assert.deepEqual(localVersion.body, { ok: true, backend: 'local', version: '1.0.0', configured: true });

  const history = await harness.call('GET', '/api/deploy/:project/log', { params: { project: 'demo' } });
  assert.deepEqual(new Set(history.body.log.map(entry => entry.backend)), new Set(['local', 'external']));
  assert.equal(history.body.log.find(entry => entry.jobId)?.target, 'dev');
  assert.equal(history.body.log.find(entry => !entry.jobId)?.target, 'prod');
});

test('PW slot backend: inherit follows global external, editor serialization is admin-only, and unknown backend values are refused', async t => {
  const root = await workspace(t);
  const submitted = [];
  class Client {
    async health() { return health; }
    async submit(request) { submitted.push(request); return { ...makeJob('job-inherit-001', request.project), revision: request.revision }; }
    async version() { return { version: null, revision: null, deployedAt: null }; }
    async jobs() { return []; }
  }
  const service = createDeploymentService({
    settingsStore: {
      load: async () => ({ deployment: { backend: 'external' } }),
      connection: async () => ({ endpoint: 'https://deploy.example.test', token: TOKEN }),
    },
    snapshot: async () => sourceSnapshot([{ path: 'deploy.sh', data: Buffer.from('printf deployed').toString('base64'), executable: true }]),
    Client,
  });
  const harness = deployRouteHarness(root, { deploymentService: service });
  const card = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
  assert.match(card.body.html, /Execution backend/);
  assert.match(card.body.html, /value="inherit" selected/);

  const inherited = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(inherited.statusCode, 202);
  assert.equal(submitted.length, 1);

  const saved = await harness.call('POST', '/api/deploy/config', { body: {
    project: 'demo', target: 'dev', script: 'true', versionCmd: '', backend: 'local',
  } });
  assert.equal(saved.statusCode, 200);
  assert.equal(harness.config.demo.dev.backend, 'local');
  const explicitLocal = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(explicitLocal.statusCode, 200);
  assert.equal(harness.executions.length, 1);
  assert.equal(submitted.length, 1, 'the explicit local override must not inherit global external execution');
  const invalid = await harness.call('POST', '/api/deploy/config', { body: {
    project: 'demo', target: 'dev', script: 'true', versionCmd: '', backend: 'other',
  } });
  assert.equal(invalid.statusCode, 400, JSON.stringify(invalid.body));
  assert.equal(harness.config.demo.dev.backend, 'local');
  const developer = await harness.call('POST', '/api/deploy/config', {
    caller: { username: 'developer', role: 'developer', projects: ['demo'] },
    body: { project: 'demo', target: 'dev', script: 'true', versionCmd: '', backend: 'external' },
  });
  assert.equal(developer.statusCode, 403);
  assert.equal(harness.config.demo.dev.backend, 'local');
});

test('PW slot backend: an explicit external transport failure never runs the local script', async t => {
  const root = await workspace(t);
  const harness = deployRouteHarness(root, {
    config: { demo: { dev: { script: 'must not run', backend: 'external' } } },
    deploymentService: {
      backend: async () => 'local',
      client: async (_draft, { forceExternal } = {}) => {
        assert.equal(forceExternal, true);
        throw new DeploymentError('External deployment refused.', 503, 'deployment_unreachable');
      },
    },
  });
  const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'deployment_unreachable');
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.history.length, 0);
});

test('PW dispatch: local script semantics and explicit root ownership repair remain intact on success and failure', async t => {
  const root = await workspace(t);
  for (const failed of [false, true]) {
    const harness = deployRouteHarness(root, { config: { demo: { dev: { script: 'legacy script', runAsRoot: true } } },
      onExec: () => { if (failed) throw Object.assign(new Error('synthetic deploy failure'), { stderr: 'failed output' }); return { stdout: 'legacy deployed' }; } });
    const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
    assert.equal(result.body.ok, !failed);
    assert.equal(harness.executions[0].file, 'bash');
    assert.equal(harness.reclaims.length, 1);
    assert.deepEqual(harness.reclaims[0].args, ['--apply', 'demo']);
    assert.equal(harness.history.length, 1);
  }
});

test('PW modal history: active or cancelled service jobs are not mislabeled as failed local deployments', async t => {
  const root = await workspace(t);
  let state = 'queued';
  const client = {
    version: async () => ({ version: null, revision: null, deployedAt: null }),
    jobs: async () => [makeJob('job-history-001', 'demo', 'dev', state)],
  };
  const harness = deployRouteHarness(root, { deploymentService: { client: async () => client } });
  for (state of ['queued', 'running', 'cancelling', 'cancelled', 'interrupted']) {
    const result = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
    const history = result.body.html.split('id="history-panel"')[1];
    assert.ok(history.includes(`>${state}</td>`));
    assert.ok(!history.includes('Failed'));
    if (['queued', 'running', 'cancelling'].includes(state)) assert.ok(history.includes(`<td class="muted">${state}</td>`));
  }
});

test('PW dispatch: explicit Podman metadata needs no placeholder script and is never run locally', async t => {
  const root = await workspace(t);
  const files = [{ path: 'Containerfile', data: Buffer.from('FROM scratch\n').toString('base64'), executable: false }];
  const execution = { adapter: 'podman', image: 'example-image', service: 'example-dev', dockerfile: 'Containerfile' };
  const submitted = [];
  class Client {
    async health() { return health; }
    async submit(request) { submitted.push(request); return { ...makeJob('job-podman-001', 'demo'), revision: request.revision }; }
    async version() { return { version: null, revision: null, deployedAt: null }; }
    async jobs() { return []; }
  }
  const service = createDeploymentService({ settingsStore: { connection: async () => ({ endpoint: 'https://deploy.example.test', token: TOKEN }) },
    snapshot: async () => sourceSnapshot(files), Client });
  const config = { demo: { dev: { script: '', execution } } };
  const harness = deployRouteHarness(root, { config, deploymentService: service });
  const card = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
  const dev = card.body.html.split('data-target="dev"')[1].split('data-target="prod"')[0];
  assert.match(dev, /deploy-btn/);
  const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(submitted[0].recipe, execution);
  assert.equal(submitted[0].script, '');
  assert.equal(harness.executions.length, 0);
  const local = deployRouteHarness(root, { config });
  const blocked = await local.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(blocked.statusCode, 400);
  assert.equal(local.executions.length, 0);
});

test('PW legacy surfaces cannot expose remote projects absent from this workbench to a nonadmin grant', async t => {
  const root = await workspace(t);
  const calls = [];
  const client = { jobs: async () => { calls.push('jobs'); return []; }, version: async () => { calls.push('version'); return {}; } };
  const harness = deployRouteHarness(root, { deploymentService: { client: async () => client } });
  const caller = { username: 'fixture-developer', role: 'developer', projects: ['RemovedApp'] };
  for (const route of ['/api/deploy/:project/log', '/api/deploy/:project/:target/version']) {
    const result = await harness.call('GET', route, { params: { project: 'RemovedApp', target: 'dev' }, caller });
    assert.equal(result.statusCode, 403);
  }
  assert.deepEqual(calls, []);
});

test('PW slot execution metadata uses shared recipe validation and cannot store service credentials', async t => {
  const root = await workspace(t);
  const harness = deployRouteHarness(root);
  const saved = await harness.call('POST', '/api/deploy/config', { body: {
    project: 'demo', target: 'dev', script: 'bash deploy.sh', execution: { adapter: 'iis' },
  } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(harness.config.demo.dev.execution, { adapter: 'iis' });
  const rejected = await harness.call('POST', '/api/deploy/config', { body: {
    project: 'demo', target: 'dev', script: 'true', execution: { adapter: 'script', credential: TOKEN },
  } });
  assert.equal(rejected.statusCode, 400);
  assert.ok(!JSON.stringify(rejected.body).includes(TOKEN));
  assert.ok(!JSON.stringify(harness.config).includes(TOKEN));
});

test('PW job builder: explicit adapters, literal legacy option and ephemeral secrets, never root flags or process credentials', () => {
  const files = [{ path: 'deploy.sh', data: Buffer.from('printf done').toString('base64'), executable: true }];
  const request = buildDeploymentJob({ project: 'ExampleApp', target: 'prod', snapshot: sourceSnapshot(files),
    config: { script: 'bash deploy.sh "$1"', runAsRoot: true, execution: { adapter: 'iis' } },
    option: 'minor; touch forbidden', deployUser: 'fixture-deployer', deployPassword: 'synthetic-password',
    deployOperator: 'kevin.charlebois', identitySource: 'instance' });
  assert.equal(request.recipe.adapter, 'iis');
  assert.equal(request.environment.DEPLOY_OPTION, 'minor; touch forbidden');
  assert.match(request.script, /^set -- "\$DEPLOY_OPTION"/);
  assert.ok(!request.script.includes('touch forbidden'));
  assert.equal(request.secrets.DEPLOY_PASSWORD, 'synthetic-password');
  assert.equal(request.runAsRoot, undefined);
  assert.equal(request.environment.DEPLOY_PASSWORD, undefined);
  assert.equal(request.environment.DEPLOY_OPERATOR, 'kevin.charlebois');
  assert.equal(request.environment.DEPLOY_IDENTITY_SOURCE, 'instance');
  assert.throws(() => buildDeploymentJob({ project: 'ExampleApp', target: 'dev', snapshot: sourceSnapshot(files),
    config: { script: 'true', execution: { adapter: 'script', credential: TOKEN } } }), /Unknown recipe/);
});

test('PW settings readback surfaces all use redacted deployment settings', () => {
  for (const route of ['/api/setup/state', '/api/system/status']) {
    const offset = serverSource.indexOf(`app.get(BASE + '${route}'`);
    const body = serverSource.slice(offset, serverSource.indexOf('\n});', offset) + 4);
    assert.match(body, /publicWorkbenchSettings\(settings\)/);
  }
  assert.match(serverSource, /settings:publicWorkbenchSettings\(s\)/);
  assert.ok(serverSource.indexOf("app.get(BASE + '/api/deploy-service/health'") < serverSource.indexOf('app.use(attachUser)'),
    'public deployment readiness must not touch authentication/account stores');
});
