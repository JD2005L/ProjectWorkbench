import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { ContainerExecutor } from '../app/deployment/container-executor.js';
import { validateContainerConfig } from '../app/deployment/container-config.js';
import {
  DeploymentError, resourceName, snapshotDigest, validateJob,
} from '../app/deployment/protocol.js';
import { resolveJobPolicy } from '../app/deployment/policy.js';
import { deploymentRequest } from './deploy-service-fixtures.mjs';

const PODMAN = '/usr/bin/podman';
const SSH = '/usr/bin/ssh';
const HEADER_BYTES = 10;
const MAX_FRAME_BYTES = 65_536;
const IMAGE_ID = /^(?:sha256:)?([a-f0-9]{64})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EXTERNAL_ID = /^[a-f0-9]{12,64}$/;
const LIBPOD_CGROUP = /(?:^|\/)libpod-([a-f0-9]{64})\.scope(?:\/|$)/;
const MUTATING_RUNTIME_ACTIONS = new Set([
  'image_import', 'image_remove_candidate', 'image_tag', 'service_restart',
]);

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeImageId(value, description) {
  const match = IMAGE_ID.exec(String(value).trim());
  if (!match) throw new Error(`${description} was not a bare or sha256: 64-hex image ID`);
  return `sha256:${match[1]}`;
}

function fixtureFile(filePath, contents, executable = false) {
  return { path: filePath, data: Buffer.from(contents).toString('base64'), executable };
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ensure(body.length <= MAX_FRAME_BYTES, 'Fixture runtime frame exceeded its limit');
  return Buffer.concat([Buffer.from(String(body.length).padStart(HEADER_BYTES, '0'), 'ascii'), body]);
}

function decodeRequest(buffer) {
  ensure(buffer.length >= HEADER_BYTES, 'Fixture runtime request was truncated');
  const header = buffer.subarray(0, HEADER_BYTES).toString('ascii');
  ensure(/^\d{10}$/.test(header), 'Fixture runtime request header was invalid');
  const length = Number(header);
  ensure(length <= MAX_FRAME_BYTES, 'Fixture runtime request exceeded its limit');
  ensure(buffer.length >= HEADER_BYTES + length, 'Fixture runtime request body was truncated');
  return JSON.parse(buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8'));
}

function fixtureRuntimeResponse(request) {
  if (request?.action === 'service_preflight') {
    return { ok: true, result: { loadState: 'loaded' } };
  }
  if (MUTATING_RUNTIME_ACTIONS.has(request?.action)) {
    return {
      ok: false,
      code: 'action_not_allowed',
      error: 'Fixture runtime refuses every mutating action',
    };
  }
  return {
    ok: false,
    code: 'action_not_allowed',
    error: 'Fixture runtime permits only the read-only service preflight',
  };
}

export function createFixtureRuntimePeer(onRequest = () => {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  let closed = false;
  let received = Buffer.alloc(0);
  let decodedRequest;
  let inputFinished = false;

  const close = (code, signal = null) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  const respond = value => {
    child.stdout.write(encodeFrame(value));
    close(0);
  };
  const fail = error => {
    child.stderr.write('Fixture runtime peer rejected an invalid frame\n');
    child.emit('error', error);
    close(1);
  };
  const parse = () => {
    if (closed || decodedRequest || received.length < HEADER_BYTES) return;
    const header = received.subarray(0, HEADER_BYTES).toString('ascii');
    if (!/^\d{10}$/.test(header)) {
      fail(new Error('Fixture runtime request header was invalid'));
      return;
    }
    const length = Number(header);
    if (length > MAX_FRAME_BYTES) {
      fail(new Error('Fixture runtime request exceeded its limit'));
      return;
    }
    if (received.length < HEADER_BYTES + length) return;
    try {
      decodedRequest = decodeRequest(received);
      onRequest(structuredClone(decodedRequest));
      if (decodedRequest.action !== 'image_import' || inputFinished) {
        respond(fixtureRuntimeResponse(decodedRequest));
      }
    } catch (error) {
      fail(error);
    }
  };

  child.stdin.on('data', chunk => {
    if (closed) return;
    if (decodedRequest?.action === 'image_import') return;
    const remaining = HEADER_BYTES + MAX_FRAME_BYTES - received.length;
    if (remaining <= 0) {
      fail(new Error('Fixture runtime request exceeded its limit'));
      return;
    }
    received = Buffer.concat([received, Buffer.from(chunk).subarray(0, remaining)]);
    parse();
  });
  child.stdin.on('finish', () => {
    inputFinished = true;
    parse();
    if (!closed && decodedRequest?.action === 'image_import') {
      respond(fixtureRuntimeResponse(decodedRequest));
    }
  });
  child.kill = signal => {
    close(null, signal || 'SIGTERM');
    child.stdin.destroy();
    return true;
  };
  return child;
}

export function createContainerBuildFixturePayload({
  instanceId = '11111111-1111-4111-8111-111111111111',
  baseAlias = `localhost/pw-contained-fixture-${instanceId}:build-base`,
  generatedMarker = `dependency-output-${instanceId}`,
  cancellationMarker = `PW_BUILD_CANCEL_READY_${instanceId.replaceAll('-', '')}`,
} = {}) {
  ensure(UUID.test(instanceId), 'Build fixture requires a version-4 instance UUID');
  ensure(new RegExp(`^localhost/pw-contained-fixture-${instanceId}:build-base$`).test(baseAlias),
    'Build fixture base alias must be the exact instance-owned private alias');
  ensure(/^[A-Za-z0-9_-]{16,100}$/.test(generatedMarker),
    'Build fixture generated marker is invalid');
  ensure(/^[A-Za-z0-9_-]{16,100}$/.test(cancellationMarker),
    'Build fixture cancellation marker is invalid');
  const project = `ContainedBuild${instanceId.replaceAll('-', '').slice(0, 12)}`;
  const image = resourceName(project, 'dev');
  const packageJson = {
    name: 'pw-contained-build-fixture',
    version: '1.0.0',
    private: true,
    scripts: { install: 'node scripts/install.mjs' },
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageJson.name,
        version: packageJson.version,
        hasInstallScript: true,
      },
    },
  };
  const files = [
    fixtureFile('package.json', `${JSON.stringify(packageJson)}\n`),
    fixtureFile('package-lock.json', `${JSON.stringify(packageLock)}\n`),
    fixtureFile('.npmrc', 'offline=true\naudit=false\nfund=false\n'),
    fixtureFile('scripts/install.mjs', [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('generated/nested', { recursive: true });",
      `await fs.writeFile('generated/nested/dependency-proof.txt', ${JSON.stringify(`${generatedMarker}\n`)}, { mode: 0o600 });`,
      '',
    ].join('\n')),
    fixtureFile('nested/source-proof.txt', 'source-present\n'),
    fixtureFile('cancel-marker.txt', `${cancellationMarker}\n`),
    fixtureFile('Dockerfile', [
      `FROM ${baseAlias}`,
      'COPY . /fixture',
      `RUN test "$(cat /fixture/generated/nested/dependency-proof.txt)" = ${JSON.stringify(generatedMarker)} \\`,
      '    && test "$(cat /fixture/nested/source-proof.txt)" = source-present \\',
      '    && test ! -e /fixture/source/package.json',
      'ENTRYPOINT ["/bin/true"]',
      '',
    ].join('\n')),
    fixtureFile('Dockerfile.cancel', [
      `FROM ${baseAlias}`,
      'COPY . /fixture',
      'RUN cgroup="$(sed -n \'s/^0:://p\' /proc/self/cgroup)" \\',
      `    && printf '${cancellationMarker} %s\\n' "$cgroup" \\`,
      '    && exec /usr/bin/timeout --signal=TERM --kill-after=2s 90s \\',
      '      /bin/sh -c \'trap "" TERM INT; while :; do /usr/bin/sleep 1; done\'',
      'ENTRYPOINT ["/bin/true"]',
      '',
    ].join('\n')),
  ];
  return validateJob(deploymentRequest({
    requestId: `fixture-build-${instanceId}`,
    project,
    target: 'dev',
    revision: 'b'.repeat(40),
    source: { files, sha256: snapshotDigest(files) },
    script: '',
    versionCommand: '',
    environment: {},
    secrets: {},
    recipe: { adapter: 'podman', image, service: image, dockerfile: 'Dockerfile' },
  }));
}

function fixtureConfig({ instanceId, socketPath, imageId }) {
  return validateContainerConfig({
    mode: 'container',
    listen: { host: '127.0.0.1', port: 3800 },
    tokenFile: '/run/secrets/pw-contained-fixture-api',
    stateDir: '/var/lib/pw-contained-fixture',
    adapters: ['podman'],
    defaultTimeoutSeconds: 120,
    resourceNames: {},
    ui: {
      basePath: '/deploy-service',
      publicOrigin: 'https://fixture.example.test',
      tokenFile: '/run/secrets/pw-contained-fixture-ui',
    },
    container: {
      instanceId,
      builderSocket: socketPath,
      workerImage: imageId,
      maxMemoryMiB: 512,
      maxPids: 128,
      runtime: {
        host: 'fixture.invalid',
        port: 22,
        user: 'fixture-runtime',
        keyFile: '/run/pw-contained-fixture/runtime.key',
        knownHostsFile: '/run/pw-contained-fixture/known-hosts',
      },
    },
  });
}

function createSpawnProcess(socketPath, podmanCalls, runtimeRequests, clientEnvironment) {
  const expectedPrefix = ['--remote', '--url', `unix://${socketPath}`];
  return (command, args, options) => {
    if (command === PODMAN) {
      ensure(args.length >= 3 && expectedPrefix.every((value, index) => value === args[index]),
        'ContainerExecutor attempted Podman outside the private fixture socket');
      podmanCalls.push([...args.slice(3)]);
      return spawn(command, args, { ...options, env: { ...options.env, ...clientEnvironment } });
    }
    if (command === SSH) {
      ensure(args.includes('fixture.invalid') && args.at(-1) === 'pw-deploy-runtime',
        'ContainerExecutor attempted an unapproved SSH destination');
      return createFixtureRuntimePeer(request => runtimeRequests.push(request));
    }
    throw new Error(`Container build fixture refused executable ${command}`);
  };
}

function boundedOutput(maximum = 1024 * 1024) {
  let text = '';
  let overflow = false;
  return {
    write(chunk) {
      if (overflow) return false;
      const next = text + String(chunk);
      if (Buffer.byteLength(next) > maximum) {
        overflow = true;
        return false;
      }
      text = next;
      return true;
    },
    text: () => text,
    overflow: () => overflow,
  };
}

async function waitFor(description, timeoutMs, signal, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    await sleep(100, undefined, signal ? { signal } : undefined);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function exists(executor, control, kind, name) {
  return (await executor.builderRaw(control, [kind, 'exists', name], {
    allowedExitCodes: [0, 1],
  })).exitCode === 0;
}

async function inspectImageId(executor, control, reference) {
  const result = await executor.builderRaw(control, [
    'image', 'inspect', '--format', '{{.Id}}', reference,
  ], { captureStdout: true, maxStdoutBytes: 256 });
  return normalizeImageId(result.output, `Image ${reference}`);
}

async function externalContainers(executor, control) {
  const result = await executor.builderRaw(control, [
    'ps', '-a', '--external', '--no-trunc', '--format', 'json',
  ], { captureStdout: true, maxStdoutBytes: 1024 * 1024 });
  let rows;
  try {
    rows = JSON.parse(result.output.trim() || '[]');
  } catch (error) {
    throw new Error('Private Podman returned invalid external-container JSON', { cause: error });
  }
  ensure(Array.isArray(rows), 'Private Podman external-container response was not an array');
  return rows.map(row => {
    const id = row.Id ?? row.ID ?? row.id;
    ensure(EXTERNAL_ID.test(id || ''), 'Private Podman returned an invalid external-container ID');
    return { id };
  });
}

function cancellationPath(output, marker) {
  return new RegExp(`(?:^|\\n)${marker} (\\/[^\\r\\n]*)\\r?\\n`).exec(output)?.[1] ?? null;
}

export function parseBuildCancellationIdentity(output, marker) {
  const cgroupPath = cancellationPath(output, marker);
  if (!cgroupPath || !/^\/[A-Za-z0-9_.:@/-]*$/.test(cgroupPath)
      || cgroupPath.includes('..') || path.posix.normalize(cgroupPath) !== cgroupPath) {
    throw new DeploymentError(
      'Build cancellation oracle unavailable: controlled RUN did not expose a safe cgroup-v2 identity',
      503, 'fixture_oracle_unavailable',
    );
  }
  const id = LIBPOD_CGROUP.exec(cgroupPath)?.[1];
  if (!id) {
    throw new DeploymentError(
      `Build cancellation oracle unavailable: controlled cgroup did not contain a libpod container identity (${cgroupPath})`,
      503, 'fixture_oracle_unavailable',
    );
  }
  const directory = path.posix.resolve('/sys/fs/cgroup', `.${cgroupPath}`);
  if (!directory.startsWith('/sys/fs/cgroup/')) {
    throw new DeploymentError('Build cancellation oracle escaped cgroupfs', 503, 'fixture_oracle_unavailable');
  }
  return { id, cgroupPath, directory };
}

async function cgroupPopulated(identity) {
  let text;
  try {
    text = await fs.readFile(path.join(identity.directory, 'cgroup.events'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    const limitation = new DeploymentError(
      `Build cancellation oracle could not read ${identity.directory}/cgroup.events`,
      503, 'fixture_oracle_unavailable',
    );
    limitation.cause = error;
    throw limitation;
  }
  const match = /^populated ([01])$/m.exec(text);
  if (!match) {
    throw new DeploymentError(
      `Build cancellation oracle returned invalid cgroup.events for ${identity.cgroupPath}`,
      503, 'fixture_oracle_unavailable',
    );
  }
  return match[1] === '1';
}

async function removeOwnedImage(executor, control, reference, instanceId, jobId) {
  if (!(await exists(executor, control, 'image', reference))) return;
  const labels = JSON.parse((await executor.builderRaw(control, [
    'image', 'inspect', '--format', '{{json .Config.Labels}}', reference,
  ], { captureStdout: true, maxStdoutBytes: 8192 })).output);
  ensure(labels?.['io.pw-deploy.instance'] === instanceId
    && labels?.['io.pw-deploy.job'] === jobId,
  `Refusing to remove image ${reference} without exact fixture ownership`);
  await executor.builderRaw(control, ['image', 'rm', '--no-prune', reference]);
  ensure(!(await exists(executor, control, 'image', reference)),
    `Fixture image ${reference} still exists after removal`);
}

function commandIndex(calls, predicate) {
  return calls.findIndex(predicate);
}

export async function exerciseContainerBuildFixture({
  socketPath, instanceId, imageId, storageBase, signal,
} = {}) {
  ensure(process.platform === 'linux', 'Container build fixture requires Linux');
  ensure(typeof socketPath === 'string' && path.isAbsolute(socketPath),
    'Container build fixture requires the private absolute Podman socket path');
  ensure(UUID.test(instanceId || ''), 'Container build fixture requires the private instance UUID');
  imageId = normalizeImageId(imageId, 'Container build fixture worker image');
  ensure(typeof storageBase === 'string' && path.isAbsolute(storageBase),
    'Container build fixture requires its private storage base');
  signal?.throwIfAborted();
  const storageStat = await fs.lstat(storageBase);
  ensure(storageStat.isDirectory() && !storageStat.isSymbolicLink()
    && storageStat.uid === process.getuid() && (storageStat.mode & 0o777) === 0o700,
  'Container build fixture requires an owned 0700 private storage base');
  const socketStat = await fs.lstat(socketPath);
  ensure(socketStat.isSocket() && socketStat.uid === process.getuid(),
    'Container build fixture requires the owned private Podman Unix socket');

  const baseAlias = `localhost/pw-contained-fixture-${instanceId}:build-base`;
  const generatedMarker = `dependency-output-${crypto.randomUUID()}`;
  const cancellationMarker = `PW_BUILD_CANCEL_READY_${crypto.randomUUID().replaceAll('-', '')}`;
  const request = createContainerBuildFixturePayload({
    instanceId, baseAlias, generatedMarker, cancellationMarker,
  });
  const config = fixtureConfig({ instanceId, socketPath, imageId });
  const podmanCalls = [];
  const runtimeRequests = [];
  const fixtureDirectory = path.join(storageBase, `pw-contained-fixture-build-${crypto.randomUUID()}`);
  const clientEnvironment = {
    HOME: path.join(fixtureDirectory, 'client-home'),
    XDG_RUNTIME_DIR: path.join(fixtureDirectory, 'client-runtime'),
    TMPDIR: path.join(fixtureDirectory, 'client-tmp'),
  };
  const executor = new ContainerExecutor(config, {
    spawnProcess: createSpawnProcess(socketPath, podmanCalls, runtimeRequests, clientEnvironment),
  });
  const positiveJobId = crypto.randomUUID();
  const cancellationJobId = crypto.randomUUID();
  const positiveDirectory = path.join(fixtureDirectory, positiveJobId);
  const positiveVolume = executor.volumeName(positiveJobId);
  const dependencyContainer = executor.containerName(positiveJobId, 'dependencies');
  const positivePolicy = resolveJobPolicy(config, config.defaults, {}, request);
  const positiveCandidate = executor.candidateTag(positivePolicy.image, positiveJobId);
  const cancellationCandidate = executor.candidateTag(positivePolicy.image, cancellationJobId);
  const cancellationSeed = executor.containerName(cancellationJobId, 'dependencies');
  const events = [];
  const output = boundedOutput();
  const cleanupErrors = [];
  let primaryError;
  let result;
  let aliasCreationAttempted = false;
  let cancellationAbort;
  let cancellationBuildSettled;
  let cancellationIdentityValue;
  let serverBuildStopped = false;

  const positiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const positiveControl = {
    jobId: positiveJobId,
    jobDirectory: positiveDirectory,
    policy: positivePolicy,
    signal: positiveSignal,
    onOutput: text => output.write(text),
    onEvent: async phase => { events.push(phase); },
  };
  const cleanupControl = {
    jobId: positiveJobId,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(240_000)])
      : AbortSignal.timeout(240_000),
    policy: { ...positivePolicy, timeoutSeconds: 120 },
    onOutput: () => {},
  };

  try {
    await fs.mkdir(fixtureDirectory, { mode: 0o700 });
    // Do not consult the host root account's home or registry-auth locations.
    for (const directory of Object.values(clientEnvironment)) await fs.mkdir(directory, { mode: 0o700 });
    await fs.mkdir(positiveDirectory, { mode: 0o700 });
    await executor.init();
    const builderInfo = JSON.parse((await executor.builderRaw({ ...positiveControl, onOutput: () => {} }, ['info', '--format', 'json'], {
      captureStdout: true, maxStdoutBytes: 1024 * 1024,
    })).output);
    ensure(builderInfo?.host?.security?.rootless === true
      && builderInfo?.store?.graphRoot === path.join(storageBase, 'graph')
      && builderInfo?.store?.runRoot === path.join(path.dirname(socketPath), 'r')
      && builderInfo?.store?.volumePath === path.join(storageBase, 'graph', 'volumes')
      && builderInfo?.store?.imageCopyTmpDir === path.join(storageBase, 'transfer'),
    'Container build fixture refuses a socket outside its verified private store');
    ensure(!(await exists(executor, positiveControl, 'image', baseAlias)),
      `Fixture base alias collision: ${baseAlias}`);
    aliasCreationAttempted = true;
    await executor.builderRaw(positiveControl, ['tag', imageId, baseAlias]);
    ensure(await inspectImageId(executor, positiveControl, baseAlias) === imageId,
      'Fixture base alias did not preserve the pinned worker image identity');

    let runtimeRefusal;
    try {
      await executor.podman(request, positiveControl);
    } catch (error) {
      runtimeRefusal = error;
    }
    ensure(runtimeRefusal, 'Fixture runtime refusal was not reached');
    ensure(runtimeRefusal.code === 'action_not_allowed',
      `Fixture runtime returned ${runtimeRefusal.code || runtimeRefusal.name} instead of its framed mutation refusal: ${output.text().slice(-4096)}`);
    ensure(!output.overflow(), 'Real dependency build output exceeded the fixture limit');
    ensure(runtimeRequests.some(item => item.action === 'service_preflight'),
      'Real build did not complete the read-only runtime preflight');
    ensure(runtimeRequests.some(item => item.action === 'image_import'),
      'Real dependency build did not reach the deliberately refused runtime import');
    ensure(!runtimeRequests.some(item => ['image_tag', 'service_restart'].includes(item.action)),
      'Fixture runtime must stop before promotion or service restart');
    for (const phase of ['installing_dependencies', 'building_image', 'checking_image', 'transferring_image']) {
      ensure(events.includes(phase), `Real dependency build did not reach ${phase}`);
    }
    ensure(await exists(executor, cleanupControl, 'image', positiveCandidate),
      'Real dependency build did not create its candidate image');
    await executor.assertOwnedResource(cleanupControl, 'image', positiveCandidate);
    const candidateRevision = (await executor.builderRaw(cleanupControl, [
      'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      positiveCandidate,
    ], { captureStdout: true, maxStdoutBytes: 256 })).output.trim();
    ensure(candidateRevision === request.revision, 'Candidate image lost its exact source revision');
    ensure(!(await exists(executor, cleanupControl, 'container', dependencyContainer)),
      'Dependency container remained after its workspace was consumed');
    ensure(await exists(executor, cleanupControl, 'volume', positiveVolume),
      'Dependency workspace volume disappeared before cancellation fixture reuse');
    const cpIndex = commandIndex(podmanCalls, args => args[0] === 'cp'
      && args[1] === `${dependencyContainer}:/workspace/source/.` && args[2] === '-');
    const buildIndex = commandIndex(podmanCalls, args => args[0] === 'build' && args.at(-1) === '-');
    const removeIndex = commandIndex(podmanCalls, args => args[0] === 'rm'
      && args.at(-1) === dependencyContainer);
    ensure(cpIndex >= 0 && buildIndex > cpIndex && removeIndex > buildIndex,
      'Dependency workspace was not copied into the real build before its container was removed');

    cancellationAbort = new AbortController();
    const cancellationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000), cancellationAbort.signal])
      : AbortSignal.any([AbortSignal.timeout(120_000), cancellationAbort.signal]);
    let markerResolve;
    const markerSeen = new Promise(resolve => { markerResolve = resolve; });
    const cancellationOutput = boundedOutput();
    const cancellationControl = {
      jobId: cancellationJobId,
      jobDirectory: positiveDirectory,
      policy: { ...positivePolicy, timeoutSeconds: 120 },
      signal: cancellationSignal,
      onOutput: text => {
        if (!cancellationOutput.write(text)) {
          cancellationAbort.abort(new DeploymentError(
            'Remote build output exceeded the fixture limit', 502, 'step_output_too_large',
          ));
          return;
        }
        if (cancellationPath(cancellationOutput.text(), cancellationMarker) !== null) markerResolve();
      },
      onEvent: async () => {},
    };
    await executor.createWorkerContainer(cancellationControl, 'dependencies', positiveVolume);
    const cancellationBuildArgs = [
      '--pull=never', '--force-rm', '--network=none',
      `--memory=${config.container.maxMemoryMiB}m`,
      `--memory-swap=${config.container.maxMemoryMiB}m`,
      '-f', 'Dockerfile.cancel',
      ...executor.labelArgs(cancellationJobId),
      '--label', `org.opencontainers.image.revision=${request.revision}`,
      '-t', cancellationCandidate,
    ];
    const buildPromise = executor.buildFromContainer(
      cancellationControl, cancellationSeed, cancellationBuildArgs,
    );
    cancellationBuildSettled = buildPromise.then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error }),
    );
    await within(Promise.race([
      markerSeen,
      cancellationBuildSettled.then(outcome => {
        if (!outcome.ok) throw outcome.error;
        throw new Error('Remote build completed without emitting its controlled RUN marker');
      }),
    ]), 30_000, 'Timed out waiting for the controlled remote-build marker');
    cancellationIdentityValue = parseBuildCancellationIdentity(cancellationOutput.text(), cancellationMarker);
    ensure(await cgroupPopulated(cancellationIdentityValue),
      `Controlled build cgroup ${cancellationIdentityValue.cgroupPath} was not populated before cancellation`);
    const externalBeforeAbort = await externalContainers(executor, cleanupControl);
    ensure(externalBeforeAbort.some(item => item.id === cancellationIdentityValue.id),
      `Controlled build identity ${cancellationIdentityValue.id} was not visible in the private Podman store`);
    cancellationAbort.abort(new DeploymentError(
      'Synthetic fixture build cancellation', 409, 'cancelled',
    ));
    const cancellationOutcome = await within(cancellationBuildSettled, 20_000,
      'Remote build client did not settle after cancellation');
    ensure(!cancellationOutcome.ok, 'Cancelled remote build unexpectedly succeeded');
    await waitFor(
      'the controlled build cgroup to stop', 20_000,
      AbortSignal.timeout(25_000), async () => {
        return !(await cgroupPopulated(cancellationIdentityValue));
      },
    ).catch(error => {
      throw new Error(
        `Remote-build termination could not be proven: cgroup ${cancellationIdentityValue.cgroupPath} remained populated`,
        { cause: error },
      );
    });
    await waitFor(
      'the exact controlled Buildah container to leave private storage', 20_000,
      AbortSignal.timeout(25_000), async () => {
        const rows = await externalContainers(executor, cleanupControl);
        return !rows.some(item => item.id === cancellationIdentityValue.id);
      },
    ).catch(error => {
      throw new Error(
        `Remote build stopped, but unlabeled Buildah storage ${cancellationIdentityValue.id} remained; refusing automatic deletion`,
        { cause: error },
      );
    });
    ensure(!(await exists(executor, cleanupControl, 'image', cancellationCandidate)),
      'Cancelled remote build unexpectedly committed its candidate image');
    serverBuildStopped = true;

    result = {
      dependencyBuild: {
        jobId: positiveJobId,
        generatedMarker,
        candidateRevision,
        copiedWorkspaceBeforeRemoval: true,
        runtimeStoppedAt: 'image_import',
      },
      remoteBuildCancellation: {
        jobId: cancellationJobId,
        marker: cancellationMarker,
        externalContainerId: cancellationIdentityValue.id,
        cgroupPath: cancellationIdentityValue.cgroupPath,
        serverWorkStopped: true,
      },
      unproven: [
        'runtime image import',
        'runtime candidate tagging',
        'service restart',
        'health confirmation',
        'rollback',
      ],
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupAttempt = async operation => {
    try { await operation(); } catch (error) { cleanupErrors.push(error); }
  };
  if (cancellationAbort && !cancellationAbort.signal.aborted) {
    cancellationAbort.abort(new DeploymentError(
      'Container build fixture is stopping', 503, 'interrupted',
    ));
  }
  let buildClientSettled = true;
  if (cancellationBuildSettled) {
    try {
      const outcome = await within(cancellationBuildSettled, 20_000,
        'Remote build client remained active during fixture cleanup');
      ensure(outcome, 'Remote build client remained active during fixture cleanup');
    } catch (error) {
      buildClientSettled = false;
      cleanupErrors.push(error);
    }
  }
  const finalCleanupControl = {
    ...cleanupControl,
    signal: AbortSignal.timeout(30_000),
    policy: { ...positivePolicy, timeoutSeconds: 30 },
  };
  const positiveBuildUncertain = events.includes('building_image') && !events.includes('checking_image');
  const cleanupSafe = buildClientSettled && !positiveBuildUncertain
    && (!cancellationBuildSettled || serverBuildStopped);
  if (cleanupSafe) {
    await cleanupAttempt(() => executor.removeContainer(
      { ...finalCleanupControl, jobId: cancellationJobId }, cancellationSeed,
    ));
    await cleanupAttempt(() => executor.removeContainer(finalCleanupControl, dependencyContainer));
    await cleanupAttempt(async () => {
      if (!cancellationIdentityValue) return;
      const rows = await externalContainers(executor, finalCleanupControl);
      ensure(!rows.some(item => item.id === cancellationIdentityValue.id),
        `Unlabeled Buildah storage ${cancellationIdentityValue.id} remains; fixture preserved it for parent review`);
    });
    await cleanupAttempt(() => removeOwnedImage(
      executor, { ...finalCleanupControl, jobId: cancellationJobId },
      cancellationCandidate, instanceId, cancellationJobId,
    ));
    await cleanupAttempt(() => removeOwnedImage(
      executor, finalCleanupControl, positiveCandidate, instanceId, positiveJobId,
    ));
    await cleanupAttempt(() => executor.removeVolume(finalCleanupControl, positiveVolume));
    await cleanupAttempt(async () => {
      if (!aliasCreationAttempted || !(await exists(executor, finalCleanupControl, 'image', baseAlias))) return;
      ensure(await inspectImageId(executor, finalCleanupControl, baseAlias) === imageId,
        `Refusing to remove base alias ${baseAlias} after its identity changed`);
      await executor.builderRaw(finalCleanupControl, ['image', 'untag', imageId, baseAlias]);
      ensure(!(await exists(executor, finalCleanupControl, 'image', baseAlias)),
        `Fixture base alias ${baseAlias} still exists after removal`);
    });
  } else {
    cleanupErrors.push(new Error(
      `Private build resources retained because server-side termination was not established: ${cancellationSeed}, ${cancellationCandidate}, ${positiveCandidate}, ${positiveVolume}, ${baseAlias}`,
    ));
  }
  if (cleanupSafe) {
    await cleanupAttempt(async () => {
      let stat;
      try {
        stat = await fs.lstat(fixtureDirectory);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      ensure(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(),
        `Refusing to remove unsafe fixture directory ${fixtureDirectory}`);
      ensure(path.dirname(fixtureDirectory) === storageBase
        && path.basename(fixtureDirectory).startsWith('pw-contained-fixture-build-'),
      `Refusing to remove unexpected fixture directory ${fixtureDirectory}`);
      await fs.rm(fixtureDirectory, { recursive: true });
    });
  }

  if (primaryError && cleanupErrors.length) {
    throw new AggregateError([primaryError, ...cleanupErrors],
      `Container build fixture failed and cleanup was incomplete: ${[primaryError, ...cleanupErrors]
        .map(error => `${error.code || error.name}: ${error.message}`).join(' | ').slice(0, 8192)}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors,
      `Container build fixture cleanup was incomplete: ${cleanupErrors.map(error => error.message).join(' | ').slice(0, 8192)}`);
  }
  return result;
}
