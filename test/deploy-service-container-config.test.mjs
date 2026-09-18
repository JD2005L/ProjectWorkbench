import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContainerConfig, validateContainerUidMap, validateUiLocation, validateContainerCredentials,
  validateContainerBuildCapabilities, assertContainerBuildSupport,
} from '../app/deployment/container-config.js';
import { resolveJobPolicy, validateHostConfig } from '../app/deployment/policy.js';
import { deploymentRequest } from './deploy-service-fixtures.mjs';

const policy = () => ({
  mode: 'container', tokenFile: '/run/secrets/deploy-api-token', stateDir: '/var/lib/pw-deploy',
  listen: { host: '0.0.0.0', port: 3800 }, adapters: ['script', 'iis'],
  ui: { publicOrigin: 'https://deploy.example.test', tokenFile: '/run/secrets/deploy-ui-token' },
  container: { instanceId: '11111111-1111-4111-8111-111111111111',
    builderSocket: '/run/pw-deploy/podman.sock', workerImage: `sha256:${'a'.repeat(64)}` },
});

test('container policy needs no host Node/SDK identity and pins its isolated worker image', () => {
  const config = validateContainerConfig(policy());
  assert.equal(config.container.maxMemoryMiB, 2048);
  assert.equal(config.container.maxPids, 512);
  assert.equal(config.ui.basePath, '/deploy-service');
  assert.equal(config.defaults.maxConcurrent, 1);
  assert.equal(config.buildUser, undefined);
  assert.equal(config.runtimeUser, undefined);
  assert.equal(resolveJobPolicy(config, config.defaults, {}, deploymentRequest({ recipe: { adapter: 'script' } })).timeoutSeconds, 600);
});

test('container policy rejects mutable images, privilege fields and unbound Podman activation', () => {
  for (const patch of [
    { mode: 'native' }, { buildUser: 'root' }, { runAsRoot: true }, { adapters: ['podman'] },
    { listen: { host: '192.0.2.1', port: 3800 } },
    { ui: { ...policy().ui, tokenFile: policy().tokenFile } },
    { container: { ...policy().container, workerImage: 'localhost/deploy:latest' } },
    { container: { ...policy().container, instanceId: 'shared' } },
    { container: { ...policy().container, privileged: true } },
    { container: { ...policy().container, maxMemoryMiB: 1 } },
    { container: { ...policy().container, builderSocket: '/run/../tmp/socket' } },
  ]) assert.throws(() => validateContainerConfig({ ...policy(), ...patch }));
});

test('runtime connection is explicit, non-root, host-key-pinned and not job editable', () => {
  const runtime = { host: 'runtime.example.test', user: 'app-runtime',
    keyFile: '/run/secrets/runtime-key', knownHostsFile: '/etc/pw-deploy/known_hosts' };
  const input = { ...policy(), adapters: ['podman'], container: { ...policy().container, runtime } };
  assert.equal(validateContainerConfig(input).container.runtime.port, 22);
  for (const patch of [{ user: 'root' }, { host: '-oProxyCommand=bad' }, { host: 'host\nbad' },
    { keyFile: 'relative' }, { knownHostsFile: '/tmp/../known_hosts' }, { strictHostKeyChecking: false }]) {
    assert.throws(() => validateContainerConfig({ ...input,
      container: { ...input.container, runtime: { ...runtime, ...patch } } }));
  }
});

test('console location requires an independent HTTPS origin and a literal path', () => {
  assert.deepEqual(validateUiLocation({ publicOrigin: 'https://console.example.test/' }),
    { publicOrigin: 'https://console.example.test', basePath: '/deploy-service' });
  for (const publicOrigin of ['http://localhost', 'https://user:pass@host', 'https://host/path',
    'https://host/?token=fixture', 'https://host/#fragment', 'not-a-url']) {
    assert.throws(() => validateUiLocation({ publicOrigin }));
  }
  for (const basePath of ['//host', '/a/../b', '/a%2fb', '/ui?query', 'relative', '/v1', '/v1/console', '/health']) {
    assert.throws(() => validateUiLocation({ publicOrigin: 'https://host', basePath }));
  }
});

test('container root must map to a non-host-root identity; malformed/identity maps fail closed', () => {
  validateContainerUidMap('0 2000 1\n1 100000 65536\n');
  validateContainerUidMap('0 100000 65536\n');
  for (const value of ['', '0 0 4294967295', '0 2000 0', '0 2000 nope', '1 2000 65536',
    '0 2000 1\n1001 0 1', '0 -1 65536']) assert.throws(() => validateContainerUidMap(value));
});

test('Podman controller builds require chroot capability in both effective and bounding sets', () => {
  validateContainerBuildCapabilities('CapEff:\t0000000000040000\nCapBnd:\t0000000000040000\n');
  for (const status of [
    '', null, 'CapEff: invalid\nCapBnd: 0000000000040000\n',
    'CapEff: 0000000000000000\nCapBnd: 0000000000040000\n',
    'CapEff: 0000000000040000\nCapBnd: 0000000000000000\n',
  ]) {
    assert.throws(() => validateContainerBuildCapabilities(status),
      error => error.code === 'container_build_capability_missing');
  }
});

test('script-only controllers do not require build-only capabilities or a Linux status probe', async () => {
  await assertContainerBuildSupport({ adapters: ['script', 'iis'] });
});

test('shared destination safeguards do not relax the legacy native listener policy', () => {
  assert.throws(() => validateHostConfig({ tokenFile: '/etc/deploy/token', stateDir: '/var/lib/deploy',
    buildUser: 'builder', runtimeUser: 'runtime', listen: { host: '0.0.0.0', port: 3800 } }), /loopback/);
});

test('API and console credentials must be distinct strong values without public error disclosure', () => {
  const token = 'synthetic-machine-credential-value-0123456789';
  const uiToken = 'synthetic-console-credential-value-0123456789';
  assert.deepEqual(validateContainerCredentials({ token, uiToken }), { token, uiToken });
  for (const value of [{ token, uiToken: token }, { token, uiToken: 'short' },
    { token: `${token}\n`, uiToken }, { token: null, uiToken }]) {
    assert.throws(() => validateContainerCredentials(value), error => {
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(uiToken), false);
      return error.code === 'invalid_configuration';
    });
  }
});

test('host root cannot be mapped through a higher container UID either', () => {
  assert.throws(() => validateContainerUidMap('0 1000 1\n1 100000 1999\n2000 0 1\n'),
    error => error.code === 'unsafe_container');
});
