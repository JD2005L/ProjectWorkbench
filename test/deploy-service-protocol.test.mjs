import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotDigest, validateSnapshot, validateEndpoint, validateJob,
  validateEnvironment, resourceName, publicJob,
} from '../app/deployment/protocol.js';

function request() {
  const files = [{ path: 'deploy/prod.sh', data: Buffer.from('exit 0\n').toString('base64'), executable: true }];
  return {
    apiVersion: 1, requestId: 'fixture-request-1', project: 'ExampleApp', target: 'prod',
    revision: 'a'.repeat(40), source: { files, sha256: snapshotDigest(files) },
    script: 'bash deploy/prod.sh', environment: { DEPLOY_OPTION: '' }, secrets: {},
  };
}

test('new projects need a valid recipe, not service enrollment', () => {
  const job = validateJob(request());
  assert.equal(job.project, 'ExampleApp');
  assert.equal(job.recipe.adapter, 'script');
  assert.equal(resourceName(job.project, job.target), 'example-app');
  assert.equal(resourceName(job.project, 'dev'), 'example-app-dev');
});

test('exact committed source is required and content is digest-bound', () => {
  assert.throws(() => validateJob({ ...request(), revision: 'main' }), /exact Git commit/);
  const job = request();
  job.source.files[0].data = Buffer.from('changed\n').toString('base64');
  assert.throws(() => validateJob(job), /digest does not match/);
});

test('source rejects path traversal, private runtime material and file/directory collisions', () => {
  for (const name of ['../outside', '/etc/passwd', 'C:/outside', 'a\\outside', '.git/config',
    'node_modules/a.js', '.env', '.env.production', 'data/roster.sqlite', 'private.key']) {
    const files = [{ path: name, data: '', executable: false }];
    assert.throws(() => validateSnapshot({ files, sha256: snapshotDigest(files) }), undefined, name);
  }
  const files = [{ path: 'a', data: '' }, { path: 'a/b', data: '' }];
  assert.throws(() => validateSnapshot({ files, sha256: snapshotDigest(files) }), /conflicts/);
});

test('snapshot order does not alter identity; duplicate paths and malformed base64 are refused', () => {
  const files = [{ path: 'a', data: 'YQ==' }, { path: 'b', data: 'Yg==' }];
  assert.equal(snapshotDigest(files), snapshotDigest([...files].reverse()));
  assert.throws(() => validateSnapshot({ files: [files[0], files[0]], sha256: snapshotDigest(files) }), /Duplicate/);
  assert.throws(() => validateSnapshot({ files: [{ path: 'a', data: '!bad' }], sha256: 'a'.repeat(64) }), /encoding/);
});

test('a large regular asset is validated without recursive regular-expression limits', () => {
  const files = [{ path: 'assets/fixture.bin', data: Buffer.alloc(2 * 1024 * 1024, 42).toString('base64') }];
  assert.equal(validateSnapshot({ files, sha256: snapshotDigest(files) }).files.length, 1);
});

test('endpoint supports portable HTTPS, loopback and Unix sockets, but no insecure remote or inline credentials', () => {
  assert.equal(validateEndpoint('https://deploy.example.invalid/api/').endpoint, 'https://deploy.example.invalid/api');
  assert.equal(validateEndpoint('http://127.0.0.1:3800').url.hostname, '127.0.0.1');
  assert.equal(validateEndpoint('unix:/run/pw-deploy/control.sock').socketPath, '/run/pw-deploy/control.sock');
  for (const endpoint of ['http://remote.example.invalid', 'https://user:password@example.invalid',
    'https://example.invalid/?token=secret', 'unix:relative', 'file:///etc/passwd']) {
    assert.throws(() => validateEndpoint(endpoint));
  }
});

test('script environment cannot override host execution or smuggle credentials into retained metadata', () => {
  for (const environment of [{ PATH: '/tmp' }, { BASH_ENV: '/tmp/start' }, { HOME: '/root' },
    { DEPLOY_PASSWORD: 'fixture-secret' }, { DEPLOY_OPTION: '\0' }]) {
    assert.throws(() => validateEnvironment(environment));
  }
  assert.deepEqual(validateEnvironment({ DEPLOY_PASSWORD: 'fixture-secret' }, { secrets: true }),
    { DEPLOY_PASSWORD: 'fixture-secret' });
  assert.throws(() => validateEnvironment({ DEPLOY_OPTION: 'x' }, { secrets: true }));
});

test('version stamping is explicit and cannot conflict with the source tree', () => {
  assert.equal(validateJob({ ...request(), recipe: { adapter: 'podman' } }).recipe.versionFile, undefined);
  const recipe = { adapter: 'podman', versionFile: 'VERSION', versionFormat: 'json' };
  assert.deepEqual(validateJob({ ...request(), recipe }).recipe, recipe);
  assert.throws(() => validateJob({ ...request(), recipe: { ...recipe, versionFile: '../VERSION' } }));
  assert.throws(() => validateJob({ ...request(), recipe: { ...recipe, versionFormat: 'executable' } }), /format/);
  assert.throws(() => validateJob({ ...request(), recipe: { adapter: 'podman', versionFormat: 'json' } }), /requires/);
  assert.throws(() => validateJob({ ...request(), recipe: { ...recipe, versionFile: 'deploy' } }), /conflicts/);
});

test('job contract refuses UID, command and target privilege grants', () => {
  for (const extra of [{ uid: 0 }, { runAsRoot: true }, { command: 'sudo something' }]) {
    assert.throws(() => validateJob({ ...request(), ...extra }), /Unknown job field/);
  }
  assert.throws(() => validateJob({ ...request(), recipe: { adapter: 'podman', service: '--system' } }), /Invalid service/);
  assert.throws(() => validateJob({ ...request(), recipe: { adapter: 'root' } }), /Unsupported/);
});

test('journal projection excludes scripts, secrets, environment, source and raw logs', () => {
  const job = publicJob({ ...request(), id: 'job-1', state: 'queued',
    sourceDigest: 'a'.repeat(64), logs: 'fixture-secret', secrets: { DEPLOY_PASSWORD: 'fixture-secret' } });
  assert.equal(job.state, 'queued');
  for (const key of ['script', 'versionCommand', 'secrets', 'environment', 'source', 'logs']) {
    assert.equal(Object.hasOwn(job, key), false);
  }
  assert.equal(JSON.stringify(job).includes('fixture-secret'), false);
});
