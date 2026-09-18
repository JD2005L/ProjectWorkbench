import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { DeploymentError } from '../app/deployment/protocol.js';
import { buildTarArchive, pipeBounded, runProcess } from '../app/deployment/container-process.js';
import { runtimeRequest, runtimeSshArgv } from '../app/deployment/runtime-client.js';

function child() {
  const value = new EventEmitter();
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.exitCode = null;
  value.kill = signal => {
    value.signals.push(signal);
    if (signal === 'SIGKILL') {
      value.exitCode = null;
      value.emit('close', null, 'SIGKILL');
    }
    return true;
  };
  value.signals = [];
  return value;
}

const runtime = {
  host: 'runtime.example.test',
  port: 22,
  user: 'deploy',
  keyFile: '/etc/pw-deploy/key',
  knownHostsFile: '/etc/pw-deploy/known-hosts',
};

test('fixed SSH invocation disables user config, forwarding, PTY, local commands and agent use', () => {
  const argv = runtimeSshArgv(runtime);
  assert.deepEqual(argv.slice(0, 3), ['/usr/bin/ssh', '-F', '/dev/null']);
  for (const option of [
    'ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no',
    'RequestTTY=no', 'ControlMaster=no', 'ProxyCommand=none',
    'ConnectTimeout=15', 'ServerAliveInterval=10', 'ServerAliveCountMax=3',
  ]) {
    assert.ok(argv.includes(option), `missing SSH safety option ${option}`);
  }
  assert.equal(argv.at(-1), 'pw-deploy-runtime');
});

test('runtime request observes an early connector close while OCI input remains open', async () => {
  const connector = child();
  const oci = new PassThrough();
  const pending = runtimeRequest(runtime, { action: 'image_import' }, {
    ociStream: oci,
    spawnProcess: () => connector,
  });
  queueMicrotask(() => {
    connector.exitCode = 255;
    connector.emit('close', 255, null);
  });
  await assert.rejects(pending, error => error instanceof DeploymentError && error.code === 'runtime_protocol_error');
  oci.destroy();
});

test('runProcess escalates an ignored SIGTERM to SIGKILL and reports cancellation', async () => {
  const ignored = child();
  const controller = new AbortController();
  const pending = runProcess('/bin/helper', [], {
    signal: controller.signal,
    spawnProcess: () => ignored,
    terminationOptions: { graceMs: 1, reapMs: 50 },
  });
  controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled'));
  await assert.rejects(pending, error => error instanceof DeploymentError && error.code === 'cancelled');
  assert.deepEqual(ignored.signals, ['SIGTERM', 'SIGKILL']);
});

test('runProcess terminates a helper whose captured output exceeds its bound', async () => {
  const noisy = child();
  const pending = runProcess('/bin/helper', [], {
    captureStdout: true,
    maxStdoutBytes: 4,
    spawnProcess: () => noisy,
    terminationOptions: { graceMs: 1, reapMs: 50 },
  });
  noisy.stdout.write('too much output');
  await assert.rejects(pending, error => error instanceof DeploymentError && error.code === 'process_output_too_large');
  assert.deepEqual(noisy.signals, ['SIGTERM', 'SIGKILL']);
});

test('pipeBounded fails closed when its destination pipe fails', async () => {
  const source = new PassThrough();
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('synthetic pipe failure'));
    },
  });
  const pending = pipeBounded(source, destination, 1024);
  source.end('payload');
  await assert.rejects(pending, /synthetic pipe failure/);
});

function readOctal(header, offset, length) {
  return Number.parseInt(header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim(), 8);
}

test('buildTarArchive applies validated optional ownership and keeps default ownership root', () => {
  const files = [{ path: 'source/app.js', data: Buffer.from('ok').toString('base64'), executable: false }];
  const owned = buildTarArchive(files, { uid: 1001, gid: 1001 });
  assert.equal(readOctal(owned, 108, 8), 1001);
  assert.equal(readOctal(owned, 116, 8), 1001);
  const defaultOwned = buildTarArchive(files);
  assert.equal(readOctal(defaultOwned, 108, 8), 0);
  assert.equal(readOctal(defaultOwned, 116, 8), 0);
  for (const options of [{ uid: -1 }, { gid: 1.5 }, { uid: 0o10000000 }, null]) {
    assert.throws(() => buildTarArchive(files, options), error =>
      error instanceof DeploymentError && error.code === 'artifact_transfer_failed');
  }
});
