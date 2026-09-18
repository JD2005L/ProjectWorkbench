import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { DeploymentError } from '../app/deployment/protocol.js';
import { buildTarArchive, pipeBounded, pipeProcesses, runProcess } from '../app/deployment/container-process.js';
import { runtimeRequest, runtimeSshArgv } from '../app/deployment/runtime-client.js';

function child() {
  const value = new EventEmitter();
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.exitCode = null;
  const lifetime = setTimeout(() => {}, 5000);
  value.once('close', () => clearTimeout(lifetime));
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

async function within(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation exceeded its test deadline')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
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
  assert.equal(oci.destroyed, true);
  assert.equal(oci.listenerCount('data'), 0);
});

test('runtime request deadline covers idle OCI upload and reaps the connector', async () => {
  const connector = child();
  const oci = new PassThrough();
  const controller = new AbortController();
  const pending = runtimeRequest(runtime, { action: 'image_import' }, {
    signal: controller.signal, ociStream: oci, timeoutMs: 20,
    terminationOptions: { graceMs: 5, reapMs: 50 },
    spawnProcess: () => connector,
  });
  try {
    await assert.rejects(within(pending), error => error.code === 'runtime_mutation_uncertain');
    assert.deepEqual(connector.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(oci.destroyed, true);
    assert.equal(oci.listenerCount('data'), 0);
  } finally {
    controller.abort();
    oci.destroy();
    connector.kill('SIGKILL');
    await pending.catch(() => {});
  }
});

test('runtime request releases OCI input on an already-aborted request without spawning', async () => {
  const oci = new PassThrough();
  const controller = new AbortController();
  controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled'));
  await assert.rejects(runtimeRequest(runtime, { action: 'image_import' }, {
    signal: controller.signal, ociStream: oci,
    spawnProcess: () => { throw new Error('must not spawn'); },
  }), error => error.code === 'cancelled');
  assert.equal(oci.destroyed, true);
});

test('runtime response allows the full bounded JSON body plus its framing header', async () => {
  const connector = child();
  const base = JSON.stringify({ ok: true, result: { value: '' } });
  const value = 'x'.repeat(262144 - Buffer.byteLength(base));
  const body = Buffer.from(JSON.stringify({ ok: true, result: { value } }));
  const frame = Buffer.concat([Buffer.from(String(body.length).padStart(10, '0')), body]);
  const pending = runtimeRequest(runtime, { action: 'container_status' }, { spawnProcess: () => connector });
  queueMicrotask(() => {
    connector.stdout.end(frame);
    connector.exitCode = 0;
    connector.emit('close', 0, null);
  });
  assert.equal((await pending).value, value);
});

test('runtime refusal codes preserve health policy, cancellation and process-stop errors', async () => {
  for (const [code, expected] of [
    ['health_target_not_allowed', 'health_target_not_allowed'],
    ['process_failed', 'process_failed'],
    ['cancelled', 'cancelled'],
    ['unknown_runtime_error', 'runtime_protocol_error'],
  ]) {
    const connector = child();
    const body = Buffer.from(JSON.stringify({ ok: false, code, error: 'Fixture refusal' }));
    const frame = Buffer.concat([Buffer.from(String(body.length).padStart(10, '0')), body]);
    const pending = runtimeRequest(runtime, { action: 'health_check' }, { spawnProcess: () => connector });
    queueMicrotask(() => {
      connector.stdout.end(frame);
      connector.exitCode = 0;
      connector.emit('close', 0, null);
    });
    await assert.rejects(pending, error => error instanceof DeploymentError && error.code === expected);
  }
});

test('pipeline deadline includes process exit after all bytes are transferred', async () => {
  const producer = child(), consumer = child();
  const controller = new AbortController();
  consumer.stdin.resume();
  producer.stdout.end('fixture archive');
  const pending = pipeProcesses(producer, consumer, {
    signal: controller.signal, timeoutMs: 20,
    terminationOptions: { graceMs: 5, reapMs: 50 },
  });
  try {
    await assert.rejects(within(pending), error => error.code === 'artifact_transfer_failed');
    assert.equal(consumer.stdin.writableFinished, true);
    assert.deepEqual(producer.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(consumer.signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    controller.abort();
    producer.kill('SIGKILL');
    consumer.kill('SIGKILL');
    producer.stdout.destroy();
    consumer.stdin.destroy();
    await pending.catch(() => {});
  }
});

test('a pre-aborted pipeline still reaps its already-created processes', async () => {
  const producer = child(), consumer = child();
  const controller = new AbortController();
  controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled'));
  try {
    await assert.rejects(pipeProcesses(producer, consumer, {
      signal: controller.signal,
      terminationOptions: { graceMs: 5, reapMs: 50 },
    }), error => error.code === 'cancelled');
    assert.deepEqual(producer.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(consumer.signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    producer.kill('SIGKILL');
    consumer.kill('SIGKILL');
    producer.stdout.destroy();
    consumer.stdin.destroy();
  }
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

test('a failed managed-resource stop callback does not prevent local process reaping', async () => {
  const ignored = child();
  const controller = new AbortController();
  const pending = runProcess('/bin/helper', [], {
    signal: controller.signal, spawnProcess: () => ignored,
    onAbort: async () => { throw new Error('synthetic daemon stop failed'); },
    terminationOptions: { graceMs: 5, reapMs: 50 },
  });
  controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled'));
  await assert.rejects(pending, error => error.code === 'cancellation_failed');
  assert.deepEqual(ignored.signals, ['SIGTERM', 'SIGKILL']);
});

test('output overflow observes the close of an actual local helper before rejecting', { timeout: 5000 }, async () => {
  let closed = false;
  const pending = runProcess(process.execPath, ['-e',
    'setInterval(() => process.stdout.write("fixture-output"), 10)'], {
    captureStdout: true, maxStdoutBytes: 4, timeoutMs: 2000,
    terminationOptions: { graceMs: 100, reapMs: 500 },
    spawnProcess(command, args, options) {
      const helper = spawn(command, args, options);
      helper.once('close', () => { closed = true; });
      return helper;
    },
  });
  await assert.rejects(pending, error => error.code === 'process_output_too_large');
  assert.equal(closed, true);
});

test('a real POSIX helper ignoring SIGTERM is killed and reaped', {
  skip: process.platform === 'win32', timeout: 5000,
}, async () => {
  const controller = new AbortController();
  const signals = [];
  let closed = false;
  const pending = runProcess(process.execPath, ['-e',
    'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    signal: controller.signal, timeoutMs: 2000,
    terminationOptions: { graceMs: 100, reapMs: 500 },
    onStdout() { controller.abort(new DeploymentError('Deployment cancelled', 409, 'cancelled')); },
    spawnProcess(command, args, options) {
      const helper = spawn(command, args, options);
      const kill = helper.kill.bind(helper);
      helper.kill = signal => { signals.push(signal); return kill(signal); };
      helper.once('close', () => { closed = true; });
      return helper;
    },
  });
  await assert.rejects(pending, error => error.code === 'cancelled');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(closed, true);
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

test('tar seeding includes deduplicated owner-writable parent directories before every nested file', () => {
  const files = ['nested/one.txt', 'nested/deeper/two.txt', 'nested/deeper/three.txt']
    .map(path => ({ path, data: Buffer.from('fixture').toString('base64'), executable: false }));
  for (const owner of [0, 1001]) {
    const archive = buildTarArchive(files, { uid: owner, gid: owner });
    const entries = [];
    for (let offset = 0; archive[offset] !== 0; ) {
      const header = archive.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      entries.push({
        name: `${prefix ? `${prefix}/` : ''}${name}`.replace(/\/$/, ''),
        type: header.toString('ascii', 156, 157),
        mode: readOctal(header, 100, 8),
        uid: readOctal(header, 108, 8),
        gid: readOctal(header, 116, 8),
      });
      offset += 512 + Math.ceil(readOctal(header, 124, 12) / 512) * 512;
    }
    assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [
      ['nested', '5'], ['nested/one.txt', '0'], ['nested/deeper', '5'],
      ['nested/deeper/two.txt', '0'], ['nested/deeper/three.txt', '0'],
    ]);
    for (const entry of entries) {
      assert.equal(entry.uid, owner);
      assert.equal(entry.gid, owner);
      if (entry.type === '5') assert.equal(entry.mode & 0o700, 0o700);
    }
  }
});
