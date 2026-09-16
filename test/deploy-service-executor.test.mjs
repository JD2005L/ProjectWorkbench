import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HostExecutor, stepInvocation } from '../app/deployment/executor.js';
import { DeploymentError, validateJob } from '../app/deployment/protocol.js';
import { deploymentConfig, deploymentRequest } from './deploy-service-fixtures.mjs';

const identity = { name: 'fixture-builder', uid: 1002, gid: 1002, home: '/home/fixture-builder' };
const control = { jobId: '11111111-1111-4111-8111-111111111111', policy: { timeoutSeconds: 600 } };

test('every script step has non-root identity, no-new-privileges and a host supervisor binding', () => {
  const command = stepInvocation(deploymentConfig(), identity, control, 'script', '/fixture/stage');
  assert.equal(command.command, '/usr/bin/systemd-run');
  assert.ok(command.args.includes('--service-type=oneshot'));
  assert.ok(command.args.includes('--uid=fixture-builder'));
  assert.ok(command.args.includes('--property=NoNewPrivileges=yes'));
  assert.ok(command.args.includes('--property=Delegate=yes'));
  assert.ok(command.args.includes('--property=BindsTo=pw-deploy.service'));
  assert.ok(command.args.includes('--property=KillMode=control-group'));
  assert.ok(command.args.includes('--property=TimeoutStartSec=600s'));
  assert.equal(command.args.some(arg => arg.startsWith('--gid=')), false,
    'the native passwd primary group must work even without a separate NSS group record');
  assert.equal(command.args.some(arg => arg.includes('DEPLOY_PASSWORD')), false);
  assert.equal(command.args.some(arg => arg === 'bash' || arg === '-c'), false);
});

test('only the trusted Podman helper path can request rootless mapping helpers, not a root UID', () => {
  const command = stepInvocation(deploymentConfig(), identity, control, 'build', '/fixture/stage',
    { privilegedHelpers: true });
  assert.ok(command.args.includes('--property=NoNewPrivileges=no'));
  assert.ok(command.args.includes('--uid=fixture-builder'));
  assert.throws(() => stepInvocation(deploymentConfig(), { ...identity, uid: 0 }, control, 'build', '/fixture'));
  assert.throws(() => stepInvocation(deploymentConfig(), identity, { ...control, jobId: '../../other' }, 'build', '/fixture'));
});

test('supervised command line contains no job script or credentials; the non-root wrapper reads stdin', () => {
  const source = fs.readFileSync(new URL('../app/deployment/step.js', import.meta.url), 'utf8');
  assert.match(source, /process\.getuid\(\) === 0/);
  assert.match(source, /for await \(const chunk of process\.stdin\)/);
  assert.match(source, /env: envelope\.env/);
  assert.doesNotMatch(source, /console\.log\(envelope|writeFile/);
});

test('a failed stop defers filesystem cleanup until recovery, instead of racing the live process', async () => {
  const executor = new HostExecutor(deploymentConfig());
  let cleaned = false;
  const events = [];
  executor.prepare = async () => ({ stage: '/fixture/stage', home: '/fixture/home' });
  executor.script = async () => { throw new DeploymentError('Synthetic unsafe stop', 503, 'cancellation_failed'); };
  executor.cleanup = async () => { cleaned = true; };
  await assert.rejects(executor.deploy(validateJob(deploymentRequest()), {
    signal: new AbortController().signal, jobDirectory: '/fixture', onEvent: async phase => events.push(phase),
  }), error => error.code === 'cancellation_failed');
  assert.equal(cleaned, false);
  assert.deepEqual(events, ['preparing_source', 'cleanup_deferred']);
});
