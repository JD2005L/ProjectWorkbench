import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployManifestError, resolveDeployManifest, validateDeployInputs } from '../app/deploy-manifest.js';
import { resourceName, snapshotDigest, validateRecipe } from '../app/deployment/protocol.js';
import { createDeploymentService, buildDeploymentJob } from '../app/deployment/pw.js';
import { createDeploymentServer } from '../app/deployment/service.js';
import { DeploymentEngine } from '../app/deployment/engine.js';
import { deploymentConfig, MemoryJobStore, until } from './deploy-service-fixtures.mjs';
import { deployRouteHarness } from './deploy-manifest-harness.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const token = 'synthetic-manifest-service-credential-0123456789';
const simpleSlot = () => ({ label: 'Fixture deployment', script: 'printf deployed' });
const podmanRecipe = () => ({ adapter: 'podman', image: 'fixture-image', service: 'fixture-dev',
  dockerfile: 'Containerfile', versionFile: 'build/version.json', versionFormat: 'json', versionField: 'version' });

async function workspace(t, slot = simpleSlot()) {
  const root = await fs.mkdtemp(path.join(testDirectory, '.deploy-pw-manifest-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.pw'));
  const document = { schemaVersion: 1, slots: { dev: slot } };
  const file = path.join(root, '.pw', 'deploy.json');
  const save = () => fs.writeFile(file, JSON.stringify(document));
  await save();
  return { root, document, file, save };
}

async function snapshotFor(fixture) {
  const files = [
    { path: '.pw/deploy.json', data: (await fs.readFile(fixture.file)).toString('base64'), executable: false },
    { path: 'Containerfile', data: Buffer.from('FROM scratch\n').toString('base64'), executable: false },
  ];
  return { revision: 'a'.repeat(40), source: { files, sha256: snapshotDigest(files) } };
}

test('manifest execution: omission preserves the legacy resolved shape and revision exactly', async t => {
  const fixture = await workspace(t);
  const actual = await resolveDeployManifest(fixture.root, 'dev');
  const resolved = { schemaVersion: 1, target: 'dev', label: 'Fixture deployment',
    script: 'printf deployed', inputs: [], version: null };
  const fingerprints = [['.pw/deploy.json', crypto.createHash('sha256').update(await fs.readFile(fixture.file)).digest('hex')]];
  const revision = crypto.createHash('sha256').update(JSON.stringify({ resolved, fingerprints })).digest('hex');
  assert.deepEqual(actual, { ...resolved, revision });
  assert.equal(Object.hasOwn(actual, 'execution'), false);
});

test('manifest execution: script, IIS and Podman recipes use the shared validator including version-file options', async t => {
  const fixture = await workspace(t);
  for (const execution of [{}, { adapter: 'script' }, { adapter: 'iis' }, podmanRecipe(),
    { adapter: 'podman', versionFile: 'VERSION' },
    { adapter: 'podman', healthUrl: 'http://127.0.0.1:8787/health', versionField: 'version' }]) {
    fixture.document.slots.dev.execution = execution;
    await fixture.save();
    const actual = await resolveDeployManifest(fixture.root, 'dev');
    assert.deepEqual(actual.execution, validateRecipe(execution));
    assert.equal(actual.script, 'printf deployed');
  }
});

test('manifest execution: only explicit Podman recipes can omit a script; invalid script values remain invalid', async t => {
  const fixture = await workspace(t, { label: 'Container deployment', execution: podmanRecipe() });
  assert.equal((await resolveDeployManifest(fixture.root, 'dev')).script, '');
  fixture.document.slots.dev.script = '';
  await fixture.save();
  assert.equal((await resolveDeployManifest(fixture.root, 'dev')).script, '');
  for (const execution of [undefined, { adapter: 'script' }, { adapter: 'iis' }]) {
    fixture.document.slots.dev = { label: 'Requires script', execution };
    await fixture.save();
    await assert.rejects(resolveDeployManifest(fixture.root, 'dev'), DeployManifestError);
  }
  for (const script of [null, 0, {}, 'bad\0script', 'x'.repeat(65537)]) {
    fixture.document.slots.dev = { label: 'Container deployment', execution: podmanRecipe(), script };
    await fixture.save();
    await assert.rejects(resolveDeployManifest(fixture.root, 'dev'), DeployManifestError);
  }
});

test('manifest execution: credentials, privilege grants, enrollment flags and unsafe recipe paths are rejected visibly', async t => {
  const fixture = await workspace(t);
  const invalid = [null, [], { adapter: 'unknown' },
    { adapter: 'script', runAsRoot: true }, { adapter: 'script', token }, { adapter: 'script', endpoint: 'https://deploy.example.test' },
    { adapter: 'podman', user: 'fixture-root' }, { adapter: 'podman', enabled: true },
    { adapter: 'podman', dockerfile: '../outside' }, { adapter: 'podman', versionFile: '../outside' },
    { adapter: 'podman', versionFile: '.env' }, { adapter: 'podman', versionFormat: 'json' },
    { adapter: 'podman', versionFile: 'VERSION', versionFormat: 'executable' },
    { adapter: 'podman', healthUrl: 'https://fixture:secret@example.test/health' }];
  for (const execution of invalid) {
    fixture.document.slots.dev.execution = execution;
    await fixture.save();
    await assert.rejects(resolveDeployManifest(fixture.root, 'dev'), error => {
      assert.ok(error instanceof DeployManifestError);
      assert.equal(error.statusCode, 400);
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes('cannot read repository deployment data'));
      return true;
    });
    assert.equal(await resolveDeployManifest(fixture.root, 'prod'), null);
  }
});

test('manifest execution: recipe changes invalidate a displayed selection and committed-source recipe mismatch refuses submission', async t => {
  const fixture = await workspace(t, { ...simpleSlot(), execution: { adapter: 'script' } });
  const before = await resolveDeployManifest(fixture.root, 'dev');
  const snapshot = await snapshotFor(fixture);
  fixture.document.slots.dev.execution = { adapter: 'iis' };
  await fixture.save();
  const after = await resolveDeployManifest(fixture.root, 'dev');
  assert.notEqual(before.revision, after.revision);
  assert.throws(() => validateDeployInputs(after, {}, before.revision), error => error.statusCode === 409);
  assert.throws(() => buildDeploymentJob({ project: 'RecipeApp', target: 'dev', snapshot,
    config: { script: after.script }, manifest: after, selection: { env: {} } }), error => error.code === 'deployment_manifest_changed');
});

test('manifest execution: private DEPLOY_* names cannot become public repository input selectors', async t => {
  const fixture = await workspace(t);
  for (const env of ['DEPLOY_USER', 'DEPLOY_PASSWORD', 'DEPLOY_TOKEN', 'DEPLOY_API_KEY',
    'DEPLOY_OPERATOR', 'DEPLOY_IDENTITY_SOURCE']) {
    fixture.document.slots.dev.inputs = [{ name: 'credential', type: 'select', label: 'Credential',
      required: true, env, choices: [{ value: 'synthetic-value', label: 'Not a public input' }] }];
    await fixture.save();
    await assert.rejects(resolveDeployManifest(fixture.root, 'dev'), DeployManifestError);
  }
});

test('manifest execution: repository input data cannot overwrite trusted deployment attribution', async t => {
  const fixture = await workspace(t, {
    ...simpleSlot(),
    inputs: [{ name: 'release', type: 'select', label: 'Release', required: true,
      env: 'DEPLOY_RELEASE', choices: [{ value: '1.2.3', label: 'Version 1.2.3' }] }],
  });
  const manifest = await resolveDeployManifest(fixture.root, 'dev');
  const request = buildDeploymentJob({
    project: 'RecipeApp', target: 'dev', snapshot: await snapshotFor(fixture),
    config: { script: manifest.script }, manifest,
    selection: { env: {
      DEPLOY_RELEASE: '1.2.3', DEPLOY_OPERATOR: 'forged.operator', DEPLOY_IDENTITY_SOURCE: 'forged-source',
    } },
    deployOperator: 'real.operator', identitySource: 'instance',
  });
  assert.equal(request.environment.DEPLOY_RELEASE, '1.2.3');
  assert.equal(request.environment.DEPLOY_OPERATOR, 'real.operator');
  assert.equal(request.environment.DEPLOY_IDENTITY_SOURCE, 'instance');
});

test('manifest execution: unsupported local adapters never run only their preparation script or the saved legacy script', async t => {
  const fixture = await workspace(t);
  for (const adapter of ['iis', 'podman']) {
    fixture.document.slots.dev.execution = { adapter };
    await fixture.save();
    const manifest = await resolveDeployManifest(fixture.root, 'dev');
    const harness = deployRouteHarness(fixture.root, { config: { demo: { dev: { script: 'saved legacy script', runAsRoot: true } } } });
    const card = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
    assert.match(card.body.html, /requires the external backend/);
    assert.match(card.body.html, /Repository execution recipe \(read-only\)/);
    const result = await harness.call('POST', '/api/deploy/:project/:target', {
      params: { project: 'demo', target: 'dev' }, body: { inputs: {}, manifestRevision: manifest.revision },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'deployment_external_recipe_required');
    assert.equal(harness.executions.length, 0);
    assert.equal(harness.reclaims.length, 0);
    assert.equal(harness.history.length, 0);
  }
});

test('manifest execution: malformed metadata blocks POST and saved-script fallback before credentials or execution', async t => {
  const fixture = await workspace(t, { ...simpleSlot(), execution: { adapter: 'script', credential: token } });
  const harness = deployRouteHarness(fixture.root, { config: { demo: { dev: { script: 'saved legacy script', runAsRoot: true } } } });
  const result = await harness.call('POST', '/api/deploy/:project/:target', { params: { project: 'demo', target: 'dev' } });
  assert.equal(result.statusCode, 400);
  assert.match(result.body.error, /Unknown recipe field/);
  assert.ok(!JSON.stringify(result.body).includes(token));
  assert.equal(harness.credentialReads, 0);
  assert.equal(harness.executions.length, 0);
});

test('manifest execution: managed backend selection is admin-only metadata that preserves host config and rejects recipe edits', async t => {
  const fixture = await workspace(t);
  const original = { script: 'legacy saved script', versionCmd: 'legacy version command', runAsRoot: true, reauth: true, opaqueHostSetting: 'retain' };
  const harness = deployRouteHarness(fixture.root, { config: { demo: { dev: structuredClone(original) } } });
  const manifest = await resolveDeployManifest(fixture.root, 'dev');
  const adminCard = await harness.call('GET', '/api/deploy/:project/card', { params: { project: 'demo' } });
  assert.match(adminCard.body.html, /save-backend/);
  assert.match(adminCard.body.html, /Execution backend is an operator setting/);
  assert.match(adminCard.body.html, /Repository-managed deploy script \(bash, read-only\)/);
  const developerCard = await harness.call('GET', '/api/deploy/:project/card', {
    params: { project: 'demo' }, caller: { username: 'developer', role: 'developer', projects: ['demo'] },
  });
  assert.doesNotMatch(developerCard.body.html, /save-backend/);

  const selected = await harness.call('POST', '/api/deploy/config', {
    body: { project: 'demo', target: 'dev', backend: 'external' },
  });
  assert.equal(selected.statusCode, 200);
  assert.deepEqual(harness.config.demo.dev, { ...original, backend: 'external' });
  assert.equal((await resolveDeployManifest(fixture.root, 'dev')).revision, manifest.revision);

  for (const body of [
    { project: 'demo', target: 'dev', backend: 'local', script: 'attempted override' },
    { project: 'demo', target: 'dev', backend: 'local', versionCmd: 'attempted override' },
    { project: 'demo', target: 'dev', backend: 'local', execution: { adapter: 'script' } },
    { project: 'demo', target: 'dev', backend: 'local', unexpected: true },
  ]) {
    const rejected = await harness.call('POST', '/api/deploy/config', { body });
    assert.equal(rejected.statusCode, 400, JSON.stringify(rejected.body));
    assert.deepEqual(harness.config.demo.dev, { ...original, backend: 'external' });
  }
  const legacySave = await harness.call('POST', '/api/deploy/config', {
    body: { project: 'demo', target: 'dev', script: 'attempted override' },
  });
  assert.equal(legacySave.statusCode, 409);
  const unauthorized = await harness.call('POST', '/api/deploy/config', {
    caller: { username: 'developer', role: 'developer', projects: ['demo'] },
    body: { project: 'demo', target: 'dev', backend: 'local' },
  });
  assert.equal(unauthorized.statusCode, 403);
  assert.deepEqual(harness.config.demo.dev, { ...original, backend: 'external' });
});

test('manifest execution: an admin-selected external managed Podman slot reaches the real service API while the global backend remains local', async t => {
  const resource = resourceName('RecipeApp', 'dev');
  const execution = { ...podmanRecipe(), image: resource, service: resource };
  const fixture = await workspace(t, {
    label: 'Container deployment', execution,
    inputs: [{ name: 'release', type: 'select', label: 'Release', required: true, env: 'DEPLOY_RELEASE',
      choices: [{ value: '1.2.3', label: 'Version 1.2.3' }] }],
  });
  const executed = [];
  const engine = new DeploymentEngine({ config: deploymentConfig(), store: new MemoryJobStore(), executor: {
    deploy: async request => { executed.push(request); return { version: '1.2.3' }; },
  } });
  await engine.init();
  const server = createDeploymentServer({ engine, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const service = createDeploymentService({
    settingsStore: {
      load: async () => ({ deployment: { backend: 'local' } }),
      connection: async draft => draft === undefined ? null : ({ endpoint: `http://127.0.0.1:${server.address().port}`, token }),
    },
    snapshot: async root => { assert.equal(root, fixture.root); return snapshotFor(fixture); },
  });
  const harness = deployRouteHarness(fixture.root, { project: { name: 'RecipeApp' }, config: {}, deploymentService: service });
  const manifest = await resolveDeployManifest(fixture.root, 'dev');
  const saved = await harness.call('POST', '/api/deploy/config', {
    body: { project: 'RecipeApp', target: 'dev', backend: 'external' },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(harness.config.RecipeApp.dev, { backend: 'external' });
  const result = await harness.call('POST', '/api/deploy/:project/:target', {
    params: { project: 'RecipeApp', target: 'dev' }, body: { inputs: { release: '1.2.3' }, manifestRevision: manifest.revision },
  });
  assert.equal(result.statusCode, 202, JSON.stringify(result.body));
  await until(() => engine.get(result.body.job.id).state === 'succeeded');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].script, '');
  assert.deepEqual(executed[0].recipe, validateRecipe(execution));
  assert.equal(executed[0].environment.DEPLOY_RELEASE, '1.2.3');
  assert.equal(executed[0].environment.DEPLOY_OPTION, undefined);
  assert.equal(executed[0].revision, 'a'.repeat(40));
  assert.ok(!JSON.stringify(executed[0]).includes(token));
  assert.equal(harness.executions.length, 0);
  assert.equal((await (await service.requiredClient({ forceExternal:true })).version('RecipeApp', 'dev')).version, '1.2.3');
});
