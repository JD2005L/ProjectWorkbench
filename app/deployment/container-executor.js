// Container-mode executor for the deployment service.
//
// Every untrusted project command (npm ci, the deployment script, the
// version command) runs inside a disposable, per-job worker container built
// from the same immutable, pinned image this controller itself ships in -
// never in this process and never on the host. This controller only talks
// to its own dedicated rootless Podman builder socket (in --remote mode)
// and, to promote a build onto the existing target unit, to the fixed
// runtime-relay connector over a pinned SSH invocation (see
// runtime-client.js and deploy/container/runtime-relay.py). It never
// touches the runtime host's filesystem, IIS, SQL or directory services
// directly, and it never falls back to a local/native code path.
//
// This file mirrors executor.js phase-by-phase (prepare -> install ->
// build -> verify -> transfer -> activate -> confirm -> rollback ->
// cleanup) so operators see the same event vocabulary regardless of
// adapter. Deliberate differences from executor.js are called out inline.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeploymentError } from './protocol.js';
import {
  spawnChild, runProcess, pipeProcesses, buildTarArchive, confirmStopped,
  observeProcess, processDeadline, terminateAndReap,
} from './container-process.js';
import { runtimeRequest, nextRuntimeRequestId } from './runtime-client.js';
import { RuntimeCandidateJournal, validateRuntimeCandidate } from './container-journal.js';

const PODMAN = '/usr/bin/podman';
const WORKER_ENTRYPOINT = '/opt/pw-deploy/app/deployment/container-worker.js';
// The builder CLI call itself must never see project secrets or host
// environment noise: only the minimum PATH needed to exec podman.
const MINIMAL_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin' };
const MAX_BUILD_CONTEXT_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 65536;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function stripDigest(value) {
  return typeof value === 'string' ? value.replace(/^sha256:/, '') : value;
}

// Base environment for every worker container: fixed, deterministic, and
// free of request-supplied values. Matches the paths the Containerfile
// already prepares (/workspace/source, /workspace/home owned by 1001:1001).
function workerBaseEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/workspace/home',
    USER: 'deploy-job',
    LOGNAME: 'deploy-job',
    LANG: 'C.UTF-8',
    NODE_OPTIONS: '--dns-result-order=ipv4first --no-network-family-autoselection',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
  };
}

// Script/version phases additionally receive the request's approved
// environment/secrets and the same PW_*/DEPLOY_* variables native exposes,
// rebased onto the fixed in-container workspace paths.
function scriptEnv(request) {
  return {
    ...workerBaseEnv(),
    ...request.environment,
    ...request.secrets,
    PW_SOURCE_REVISION: request.revision,
    PW_WORKSPACE_DIR: '/workspace/source',
    PW_PROJECT_DIR: '/workspace/source',
    DEPLOY_PROJECT: request.project,
    DEPLOY_TARGET: request.target,
    DOTNET_CLI_HOME: '/workspace/home',
  };
}

// Inserts or replaces the recipe's configured version-stamp file, mirroring
// native's own insert-or-replace behaviour. Podman-adapter only.
function withVersionStamp(request) {
  const files = request.source.files.map(file => ({ ...file }));
  if (request.recipe.adapter === 'podman' && request.recipe.versionFile) {
    const stampText = request.recipe.versionFormat === 'json'
      ? `${JSON.stringify({ version: request.revision.slice(0, 12), builtAt: new Date().toISOString() })}\n`
      : `${request.revision.slice(0, 12)}\n`;
    const stamp = { path: request.recipe.versionFile, executable: false, data: Buffer.from(stampText).toString('base64') };
    const index = files.findIndex(file => file.path === stamp.path);
    if (index === -1) files.push(stamp);
    else files[index] = stamp;
  }
  return files;
}

export class ContainerExecutor {
  constructor(config, { spawnProcess, now = () => Date.now(), candidateJournal = new RuntimeCandidateJournal() } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.candidateJournal = candidateJournal;
  }

  podmanRemoteArgs(args) {
    return ['--remote', '--url', `unix://${this.config.container.builderSocket}`, ...args];
  }

  volumeName(jobId) {
    return `pw-deploy-job-${jobId}-workspace`;
  }

  containerName(jobId, phase) {
    return `pw-deploy-job-${jobId}-${phase}`;
  }

  candidateTag(image, jobId) {
    return `localhost/${image}:candidate-${jobId}`;
  }

  labelArgs(jobId, phase) {
    const values = [`io.pw-deploy.instance=${this.config.container.instanceId}`, `io.pw-deploy.job=${jobId}`];
    if (phase) values.push(`io.pw-deploy.phase=${phase}`);
    return values.flatMap(value => ['--label', value]);
  }

  // Probes the builder socket at startup. Fails closed rather than ever
  // falling back to local storage or a rootful daemon, and confirms the
  // exact pinned worker image this instance requires is already present on
  // the builder - never pulled, substituted or silently assumed - so a
  // missing/misconfigured packaged image is caught here, not deep into a
  // job's first real deploy.
  async init() {
    const initControl = { signal: AbortSignal.timeout(15000), onOutput: () => {} };
    let probe;
    try {
      probe = await runProcess(PODMAN, this.podmanRemoteArgs(['info', '--format', 'json']), {
        env: MINIMAL_ENV, signal: initControl.signal, spawnProcess: this.spawnProcess,
        captureStdout: true, maxStdoutBytes: 1024 * 1024,
      });
    } catch {
      throw new DeploymentError('Could not reach the rootless deployment builder', 503, 'builder_unavailable');
    }
    let info;
    try {
      info = JSON.parse(probe.output);
    } catch {
      throw new DeploymentError('Deployment builder returned an invalid response', 503, 'builder_unavailable');
    }
    if (info?.host?.security?.rootless !== true) {
      throw new DeploymentError('The deployment builder must be a rootless Podman daemon', 503, 'rootful_daemon_refused');
    }
    let imagePresent;
    try {
      imagePresent = await this.exists(initControl, ['image', 'exists', this.config.container.workerImage]);
    } catch {
      throw new DeploymentError('Could not verify the packaged worker image on the deployment builder', 503, 'builder_unavailable');
    }
    if (!imagePresent) {
      throw new DeploymentError(
        'The pinned packaged worker image is not present on the deployment builder; it must be loaded exactly as configured, never pulled or substituted',
        503, 'worker_image_unavailable',
      );
    }
    const inspected = await this.builderRaw(initControl, [
      'image', 'inspect', '--format', '{{json .Config.Labels}}', this.config.container.workerImage,
    ], { captureStdout: true });
    let labels;
    try { labels = JSON.parse(inspected.output); }
    catch {
      throw new DeploymentError('Invalid packaged worker image metadata', 503, 'worker_image_unavailable');
    }
    if (labels?.['io.pw-deploy.worker'] !== 'true' || labels?.['io.pw-deploy.api-version'] !== '1') {
      throw new DeploymentError('The pinned image is not a compatible deployment worker', 503, 'worker_image_unavailable');
    }
  }

  // -- low-level builder helpers ---------------------------------------------

  async builderRaw(control, args, options = {}) {
    control.signal.throwIfAborted();
    return runProcess(PODMAN, this.podmanRemoteArgs(args), {
      env: MINIMAL_ENV,
      signal: control.signal,
      spawnProcess: this.spawnProcess,
      onStdout: text => control.onOutput(text),
      onStderr: text => control.onOutput(text),
      ...options,
    });
  }

  async exists(control, args) {
    const result = await this.builderRaw(control, args, { allowedExitCodes: [0, 1] });
    return result.exitCode === 0;
  }

  async createVolume(control, name) {
    if (await this.exists(control, ['volume', 'exists', name])) {
      throw new DeploymentError('Deployment workspace already exists', 409, 'resource_conflict');
    }
    await this.builderRaw(control, ['volume', 'create', ...this.labelArgs(control.jobId), name]);
    await this.assertOwnedResource(control, 'volume', name);
  }

  async removeVolume(control, name) {
    if (await this.exists(control, ['volume', 'exists', name])) {
      await this.assertOwnedResource(control, 'volume', name);
      await this.builderRaw(control, ['volume', 'rm', name]);
    }
  }

  async assertOwnedResource(control, kind, name) {
    const format = kind === 'volume' ? '{{json .Labels}}' : '{{json .Config.Labels}}';
    const inspected = await this.builderRaw(control, [
      kind, 'inspect', '--format', format, name,
    ], { captureStdout: true, maxStdoutBytes: 8192, onStdout: () => {} });
    let labels;
    try { labels = JSON.parse(inspected.output); }
    catch { throw new DeploymentError('Invalid deployment resource ownership', 503, 'resource_conflict'); }
    if (labels?.['io.pw-deploy.instance'] !== this.config.container.instanceId
        || labels?.['io.pw-deploy.job'] !== control.jobId) {
      throw new DeploymentError('Refusing a resource not owned by this deployment job', 409, 'resource_conflict');
    }
  }

  async stopContainer(control, name) {
    // This most commonly runs as a direct reaction to control.signal having
    // just been aborted (see startWorker's onAbort handler below), so it
    // must not perform its own podman calls against that same signal: every
    // builderRaw call would immediately refuse to even start via
    // throwIfAborted(), and the real container could then never actually be
    // confirmed stopped. An independent, generously bounded deadline lets
    // the stop-and-confirm sequence run to completion regardless of why the
    // caller's own signal is no longer usable.
    const stopControl = { ...control, signal: AbortSignal.timeout(15000) };
    try {
      if (await this.exists(stopControl, ['container', 'exists', name])) {
        await this.assertOwnedResource(stopControl, 'container', name);
        await this.builderRaw(stopControl, ['stop', '--time=10', name], { allowedExitCodes: [0, 125] });
      }
      await confirmStopped(async () => {
        if (!(await this.exists(stopControl, ['container', 'exists', name]))) return true;
        const status = await this.builderRaw(stopControl, ['container', 'inspect', '--format', '{{.State.Status}}', name], {
          captureStdout: true,
        });
        return ['created', 'exited', 'stopped'].includes(status.output.trim());
      });
    } catch {
      throw new DeploymentError('Could not confirm the owned deployment resource stopped', 503, 'cancellation_failed');
    }
  }

  async removeContainer(control, name) {
    // Same reasoning as stopContainer: this frequently tears down a phase
    // container from runPhase's own finally block immediately after a
    // cancellation, so its own direct calls need an independent deadline too.
    const cleanupControl = { ...control, signal: AbortSignal.timeout(30000) };
    if (!(await this.exists(cleanupControl, ['container', 'exists', name]))) return;
    await this.stopContainer(cleanupControl, name);
    await this.builderRaw(cleanupControl, ['rm', '--volumes', name]);
  }

  async copyInto(control, containerName, tarBuffer) {
    await this.builderRaw(control, ['cp', '--archive=false', '-', `${containerName}:/workspace/source`], { input: tarBuffer });
  }

  // Creates (but does not start) a disposable worker container from the
  // pinned image. UID0 only for the container-worker.js guardian, which
  // drops to 1001:1001 via setpriv before running any project command;
  // capabilities are limited to what that drop requires.
  async createWorkerContainer(control, phase, volumeName) {
    const name = this.containerName(control.jobId, phase);
    await this.builderRaw(control, ['create', '--name', name, ...this.labelArgs(control.jobId, phase),
      '--interactive', '--read-only', '--user=0:0',
      '--cap-drop=all', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=KILL', '--cap-add=SETPCAP',
      '--security-opt=no-new-privileges',
      '--pull=never',
      `--memory=${this.config.container.maxMemoryMiB}m`, `--memory-swap=${this.config.container.maxMemoryMiB}m`,
      `--pids-limit=${this.config.container.maxPids}`,
      `--timeout=${Math.ceil(this.remainingDeadlineMs(control) / 1000) + 3}`,
      '--log-driver=none',
      // The packaged image may declare its own HEALTHCHECK; that only makes
      // sense for the long-running promoted app, never for a disposable
      // per-phase job container, so it is explicitly disabled here rather
      // than silently inherited.
      '--no-healthcheck',
      '--tmpfs=/tmp',
      '--volume', `${volumeName}:/workspace`,
      '--entrypoint=/usr/bin/node',
      this.config.container.workerImage, WORKER_ENTRYPOINT]);
    return name;
  }

  // Starts a created worker container attached, feeding the bounded stdin
  // envelope (credentials/script bodies never touch argv, env or labels)
  // and relaying stdout/stderr live to control.onOutput. Cancellation stops
  // and confirms the container rather than merely killing our local CLI.
  async startWorker(control, name, envelope, { capture = false } = {}) {
    control.signal.throwIfAborted();
    try {
      const result = await this.builderRaw(control, ['start', '--attach', '--interactive', name], {
        input: JSON.stringify(envelope),
        captureStdout: capture,
        maxStdoutBytes: MAX_CAPTURE_BYTES,
        timeoutMs: this.remainingDeadlineMs(control) + 3000,
        onAbort: () => this.stopContainer(control, name),
        failure: () => new DeploymentError('Deployment step failed', 502, 'step_failed'),
      });
      return { ...result, output: result.output.trim() };
    } catch (error) {
      if (error.code === 'process_output_too_large') {
        throw new DeploymentError('Step response exceeded its limit', 502, 'step_output_too_large');
      }
      if (error.code === 'process_unavailable') {
        throw new DeploymentError('Worker container could not start', 503, 'builder_unavailable');
      }
      throw error;
    }
  }

  // Runs one phase end-to-end: create -> (optional copy-in) -> start ->
  // remove. Always removes the container afterwards, even on failure.
  async runPhase(control, phase, volumeName, envelope, { copyIn, capture = false, after } = {}) {
    const name = await this.createWorkerContainer(control, phase, volumeName);
    try {
      if (copyIn) await this.copyInto(control, name, copyIn);
      const result = await this.startWorker(control, name, envelope, { capture });
      if (after) await after(name);
      return result;
    } finally {
      await this.removeContainer(control, name);
    }
  }

  // Remaining time budget for the next worker envelope's independent hard
  // deadline, decreasing across phases rather than resetting per phase.
  remainingDeadlineMs(control) {
    const remaining = control.deadlineAt === undefined
      ? control.policy.timeoutSeconds * 1000 : control.deadlineAt - this.now();
    if (!Number.isFinite(remaining)) throw new DeploymentError('Invalid execution deadline', 500, 'invalid_state');
    return Math.max(1000, Math.min(3600000, remaining));
  }

  async candidateIdentity(control, candidate, revision) {
    const inspected = await this.builderRaw(control, [
      'image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}', candidate,
    ], { captureStdout: true, maxStdoutBytes: 512 });
    const [raw, sourceRevision, extra] = inspected.output.trim().split(/\s+/);
    const id = raw?.startsWith('sha256:') ? raw : `sha256:${raw}`;
    if (!IMAGE_ID.test(id) || sourceRevision !== revision || extra !== undefined) {
      throw new DeploymentError('Built image identity does not match the requested source', 502, 'invalid_image');
    }
    return id;
  }

  // -- build / transfer -------------------------------------------------------

  async buildFromTar(control, tarBuffer, buildArgs) {
    control.signal.throwIfAborted();
    await this.builderRaw(control, ['build', ...buildArgs, '-'], {
      input: tarBuffer, timeoutMs: this.remainingDeadlineMs(control),
    });
  }

  // Streams the dependency-installed workspace straight from the builder's
  // `podman cp` output into `podman build`'s stdin, never buffering the
  // (potentially large, npm-ci-inflated) archive in this process and never
  // extracting it to local disk. The trailing "/." on the cp source copies
  // directory *contents* with no wrapping prefix, matching a Dockerfile
  // context rooted at ".".
  async buildFromContainer(control, sourceContainerName, buildArgs) {
    control.signal.throwIfAborted();
    const copy = spawnChild(PODMAN, this.podmanRemoteArgs(['cp', `${sourceContainerName}:/workspace/source/.`, '-']), {
      env: MINIMAL_ENV, spawnProcess: this.spawnProcess,
    });
    copy.stdin.end();
    const build = spawnChild(PODMAN, this.podmanRemoteArgs(['build', ...buildArgs, '-']), {
      env: MINIMAL_ENV, spawnProcess: this.spawnProcess,
    });
    await pipeProcesses(copy, build, {
      signal: control.signal,
      timeoutMs: this.remainingDeadlineMs(control),
      maxBytes: MAX_BUILD_CONTEXT_BYTES,
      onProducerStderr: text => control.onOutput(text),
      onConsumerStderr: text => control.onOutput(text),
      onConsumerStdout: text => control.onOutput(text),
      producerFailure: () => new DeploymentError('Could not read the isolated workspace', 502, 'artifact_transfer_failed'),
      consumerFailure: () => new DeploymentError('Deployment step failed', 502, 'step_failed'),
    });
  }

  // Streams `podman save --format=oci-archive` straight into the runtime
  // relay's image_import request as a single pipeline; the OCI bytes never
  // touch local disk or any text log. Returns the definitive imported image
  // ID as reported by the relay (derived from `podman image inspect` on the
  // runtime side, not scraped from load's free-text stdout).
  async transferImage(control, candidateTag, request, image, expectedImageId) {
    control.signal.throwIfAborted();
    if (!IMAGE_ID.test(expectedImageId || '')) throw new DeploymentError('Invalid candidate identity', 502, 'invalid_image');
    const checkpoint = {
      jobId: control.jobId, instanceId: this.config.container.instanceId,
      project: request.project, target: request.target, revision: request.revision, image, imageId: expectedImageId,
    };
    validateRuntimeCandidate(checkpoint, { ...request, id: control.jobId }, this.config);
    await this.candidateJournal.write(control.jobDirectory, checkpoint);
    control.signal.throwIfAborted();
    const timeoutMs = this.remainingDeadlineMs(control);
    const scope = processDeadline(control.signal, timeoutMs,
      new DeploymentError('Runtime mutation outcome is uncertain', 503, 'runtime_mutation_uncertain'));
    let save, exchange;
    const output = text => {
      try { control.onOutput(text); } catch (error) { scope.abort(error); }
    };
    try {
      save = spawnChild(PODMAN, this.podmanRemoteArgs(['save', '--format=oci-archive', candidateTag]), {
        env: MINIMAL_ENV, spawnProcess: this.spawnProcess,
      });
      const observed = observeProcess(save);
      save.stdin.end();
      save.stderr.setEncoding('utf8');
      save.stderr.on('data', output);
      exchange = runtimeRequest(this.config.container.runtime, {
        requestId: nextRuntimeRequestId(control.jobId),
        action: 'image_import',
        project: request.project,
        target: request.target,
        image,
        jobId: control.jobId,
        expectedImageId,
        revision: request.revision,
      }, { signal: scope.signal, ociStream: save.stdout, maxOciBytes: MAX_IMAGE_BYTES,
        spawnProcess: this.spawnProcess, timeoutMs });
      const result = await scope.wait(exchange);
      const saved = await scope.wait(observed.promise);
      scope.signal.throwIfAborted();
      if (observed.error || saved.code !== 0) {
        throw new DeploymentError('Could not export the deployment image', 502, 'artifact_transfer_failed');
      }
      if (!result || result.imageId !== expectedImageId) {
        throw new DeploymentError('Runtime relay returned an invalid image identity', 502, 'invalid_image');
      }
      return result.imageId;
    } catch (error) {
      scope.abort(error);
      save?.stdout.destroy();
      const [reaped, requested] = await Promise.allSettled([terminateAndReap([save]), exchange]);
      if (reaped.status === 'rejected') throw reaped.reason;
      if (requested.status === 'rejected' && requested.reason?.code === 'cancellation_failed') throw requested.reason;
      throw error;
    } finally {
      scope.dispose();
      save?.stderr.removeListener('data', output);
    }
  }

  // Polls the runtime relay for unit-active + running-image-identity +
  // (optionally) health/version agreement, mirroring executor.js's own
  // waitForContainer polling loop (20 attempts, 1s apart).
  async waitForRuntime(request, control, service, imageId, { probeHealth = true } = {}) {
    let failureCode = 'health_failed';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      control.signal.throwIfAborted();
      let healthy = true;
      if (probeHealth && request.recipe.healthUrl) {
        try {
          const health = await runtimeRequest(this.config.container.runtime, {
            requestId: nextRuntimeRequestId(control.jobId),
            action: 'health_check',
            project: request.project,
            target: request.target,
            service,
            expectedImageId: imageId,
            healthUrl: request.recipe.healthUrl,
            versionField: request.recipe.versionField,
          }, { signal: control.signal, spawnProcess: this.spawnProcess });
          if (request.recipe.versionField && health.version !== request.revision.slice(0, 12)) {
            healthy = false;
            failureCode = 'version_mismatch';
          }
        } catch {
          control.signal.throwIfAborted();
          healthy = false;
          failureCode = failureCode === 'version_mismatch' ? failureCode : 'health_failed';
        }
      }
      if (healthy) {
        const active = await runtimeRequest(this.config.container.runtime, {
          requestId: nextRuntimeRequestId(control.jobId),
          action: 'service_is_active',
          project: request.project,
          target: request.target,
          service,
        }, { signal: control.signal, spawnProcess: this.spawnProcess });
        if (active.state === 'active') {
          const status = await runtimeRequest(this.config.container.runtime, {
            requestId: nextRuntimeRequestId(control.jobId),
            action: 'container_status',
            project: request.project,
            target: request.target,
            service,
          }, { signal: control.signal, spawnProcess: this.spawnProcess });
          if (status.exists && status.running && stripDigest(status.image) === stripDigest(imageId)) return;
          failureCode = 'version_mismatch';
        } else {
          failureCode = 'service_not_provisioned';
        }
      }
      await sleep(1000, undefined, { signal: control.signal });
    }
    throw new DeploymentError('Container did not become ready with the expected image', 502, failureCode);
  }

  // -- adapters ---------------------------------------------------------------

  // Podman flow: generated version stamp -> npm ci in an isolated worker
  // when a lockfile is present -> build the candidate image with a full
  // revision label -> network-isolated read-only smoke test -> stream the
  // OCI candidate to the runtime -> snapshot the previous running image as
  // a rollback tag -> promote + restart the EXISTING unit -> confirm
  // active/running-image/health -> bounded rollback on failure.
  async podman(request, control) {
    const { service, image } = control.policy;
    const candidate = this.candidateTag(image, control.jobId);
    const dockerfilePath = request.recipe.dockerfile || 'Dockerfile';
    const files = withVersionStamp(request);
    const hasLockfile = files.some(file => file.path === 'package-lock.json');
    if (await this.exists(control, ['image', 'exists', candidate])) {
      throw new DeploymentError('Deployment candidate image already exists', 409, 'resource_conflict');
    }
    const buildArgs = ['--pull=missing', '--force-rm',
      `--memory=${this.config.container.maxMemoryMiB}m`, `--memory-swap=${this.config.container.maxMemoryMiB}m`,
      '-f', dockerfilePath, ...this.labelArgs(control.jobId),
      '--label', `org.opencontainers.image.revision=${request.revision}`, '-t', candidate];

    const preflight = await runtimeRequest(this.config.container.runtime, {
      requestId: nextRuntimeRequestId(control.jobId),
      action: 'service_preflight',
      project: request.project,
      target: request.target,
      service,
    }, { signal: control.signal, spawnProcess: this.spawnProcess });
    if (preflight.loadState !== 'loaded') {
      throw new DeploymentError('Target service unit is not provisioned', 409, 'service_not_provisioned');
    }

    if (hasLockfile) {
      await control.onEvent('installing_dependencies');
      const volumeName = this.volumeName(control.jobId);
      await this.createVolume(control, volumeName);
      await this.runPhase(control, 'dependencies', volumeName, {
        argv: ['/usr/bin/npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'],
        env: workerBaseEnv(),
        input: '',
        deadlineMs: this.remainingDeadlineMs(control),
      }, {
        copyIn: buildTarArchive(files, { uid: 1001, gid: 1001 }),
        after: async name => {
          await control.onEvent('building_image');
          await this.buildFromContainer(control, name, buildArgs);
        },
      });
    } else {
      await control.onEvent('building_image');
      await this.buildFromTar(control, buildTarArchive(files), buildArgs);
    }

    await control.onEvent('checking_image');
    const expectedImageId = await this.candidateIdentity(control, candidate, request.revision);
    // The candidate is an untrusted project-built image that may declare its
    // own HEALTHCHECK; disabled here too so this disposable smoke check never
    // inherits or runs it.
    const smokeName = this.containerName(control.jobId, 'smoke');
    try {
      await this.builderRaw(control, [
        'run', '--rm', '--name', smokeName, ...this.labelArgs(control.jobId, 'smoke'),
        '--pull=never', '--network=none', '--read-only', '--user=1001:1001',
        '--cap-drop=all', '--security-opt=no-new-privileges', '--log-driver=none',
        `--memory=${this.config.container.maxMemoryMiB}m`, `--memory-swap=${this.config.container.maxMemoryMiB}m`,
        `--pids-limit=${this.config.container.maxPids}`,
        `--timeout=${Math.ceil(this.remainingDeadlineMs(control) / 1000) + 3}`,
        '--no-healthcheck', '--entrypoint=/bin/true', candidate,
      ], { onAbort: () => this.stopContainer(control, smokeName) });
    } finally { await this.removeContainer(control, smokeName); }

    await control.onEvent('transferring_image');
    const imageId = await this.transferImage(control, candidate, request, image, expectedImageId);

    let previousImage;
    const status = await runtimeRequest(this.config.container.runtime, {
      requestId: nextRuntimeRequestId(control.jobId),
      action: 'container_status',
      project: request.project,
      target: request.target,
      service,
    }, { signal: control.signal, spawnProcess: this.spawnProcess });
    if (status.exists) {
      previousImage = status.image;
      if (!IMAGE_ID.test(previousImage || '')) {
        throw new DeploymentError('Invalid running image identity', 502, 'invalid_image');
      }
      await runtimeRequest(this.config.container.runtime, {
        requestId: nextRuntimeRequestId(control.jobId),
        action: 'image_tag',
        project: request.project,
        target: request.target,
        image,
        sourceImage: previousImage,
        tagSuffix: 'rollback',
      }, { signal: control.signal, spawnProcess: this.spawnProcess });
      await control.onEvent('rollback_saved');
    }

    await control.onEvent('activating_image');
    control.signal.throwIfAborted();
    try {
      await runtimeRequest(this.config.container.runtime, {
        requestId: nextRuntimeRequestId(control.jobId),
        action: 'image_tag',
        project: request.project,
        target: request.target,
        image,
        sourceImage: imageId,
        tagSuffix: 'latest',
      }, { signal: control.signal, spawnProcess: this.spawnProcess });
      await runtimeRequest(this.config.container.runtime, {
        requestId: nextRuntimeRequestId(control.jobId),
        action: 'service_restart',
        project: request.project,
        target: request.target,
        service,
      }, { signal: control.signal, spawnProcess: this.spawnProcess });
      await control.onEvent('waiting_for_health');
      await this.waitForRuntime(request, control, service, imageId);
    } catch (error) {
      const interrupted = control.signal.reason?.code === 'interrupted' || error?.code === 'interrupted';
      if (previousImage && error?.code !== 'cancellation_failed' && !interrupted) {
        await control.onEvent('restoring_previous_image');
        const recoverySignal = AbortSignal.timeout(60000);
        try {
          await runtimeRequest(this.config.container.runtime, {
            requestId: nextRuntimeRequestId(control.jobId),
            action: 'image_tag',
            project: request.project,
            target: request.target,
            image,
            sourceImage: previousImage,
            tagSuffix: 'latest',
          }, { signal: recoverySignal, spawnProcess: this.spawnProcess });
          await runtimeRequest(this.config.container.runtime, {
            requestId: nextRuntimeRequestId(control.jobId),
            action: 'service_restart',
            project: request.project,
            target: request.target,
            service,
          }, { signal: recoverySignal, spawnProcess: this.spawnProcess });
          await this.waitForRuntime(request, { ...control, signal: recoverySignal }, service, previousImage, { probeHealth: false });
          await control.onEvent('rollback_restored');
        } catch {
          await control.onEvent('rollback_failed');
          throw new DeploymentError('Could not restore the previous running image', 503, 'cancellation_failed');
        }
      }
      throw error;
    }
    return { version: request.revision.slice(0, 12) };
  }

  // Script/IIS flow: one disposable worker runs the deployment script, and
  // (if configured) a SEPARATE disposable worker runs the version command
  // against the same named volume - same files, no inherited shell state.
  async script(request, control) {
    const volumeName = this.volumeName(control.jobId);
    await this.createVolume(control, volumeName);
    const files = withVersionStamp(request);
    const env = scriptEnv(request);
    await control.onEvent('deploying');
    await this.runPhase(control, 'script', volumeName, {
      argv: ['/usr/bin/bash', '--noprofile', '--norc', '-s'],
      env,
      input: `${request.script}\n`,
      deadlineMs: this.remainingDeadlineMs(control),
    }, { copyIn: buildTarArchive(files, { uid: 1001, gid: 1001 }) });
    let version = null;
    if (request.versionCommand && request.versionCommand.trim()) {
      await control.onEvent('reading_version');
      const result = await this.runPhase(control, 'version', volumeName, {
        argv: ['/usr/bin/bash', '--noprofile', '--norc', '-s'],
        env,
        input: `${request.versionCommand}\n`,
        deadlineMs: this.remainingDeadlineMs(control),
      }, { capture: true });
      version = result.output;
    }
    return { version };
  }

  // Removes every resource this job could have created: worker containers
  // for all three phases (each a safe no-op if never created), the shared
  // workspace volume, the local candidate image tag, and (podman adapter
  // only) the runtime-side candidate tag. No broad prune: only exact,
  // job-labelled/named resources are ever touched.
  async cleanupJobResources(request, control) {
    const volumeName = this.volumeName(control.jobId);
    for (const phase of ['dependencies', 'script', 'version', 'smoke']) {
      await this.removeContainer(control, this.containerName(control.jobId, phase));
    }
    await this.removeVolume(control, volumeName);
    if (control.policy.image) {
      const candidate = this.candidateTag(control.policy.image, control.jobId);
      if (await this.exists(control, ['image', 'exists', candidate])) {
        await this.assertOwnedResource(control, 'image', candidate);
        await this.builderRaw(control, ['image', 'rm', '--no-prune', candidate]);
      }
      await this.cleanupRuntimeCandidate({ ...request, id: control.jobId }, control.jobDirectory, control.signal);
    }
  }

  async cleanupRuntimeCandidate(job, directory, signal) {
    const value = await this.candidateJournal.read(directory);
    if (!value) return;
    const checkpoint = validateRuntimeCandidate(value, job, this.config);
    await runtimeRequest(this.config.container.runtime, {
      requestId: nextRuntimeRequestId(job.id), action: 'image_remove_candidate',
      project: job.project, target: job.target, image: checkpoint.image,
      jobId: job.id, expectedImageId: checkpoint.imageId,
    }, { signal, spawnProcess: this.spawnProcess });
    await this.candidateJournal.remove(directory);
  }

  async deploy(request, control) {
    control.signal.throwIfAborted();
    await control.onEvent('preparing_source');
    const jobControl = { ...control, deadlineAt: this.now() + control.policy.timeoutSeconds * 1000 };
    let originalError;
    try {
      if (request.recipe.adapter === 'podman') return await this.podman(request, jobControl);
      return await this.script(request, jobControl);
    } catch (error) {
      originalError = error;
      throw error;
    } finally {
      const interrupted = originalError?.code === 'interrupted' || control.signal.reason?.code === 'interrupted';
      if (originalError?.code === 'cancellation_failed' || interrupted) {
        await control.onEvent('cleanup_deferred');
      } else {
        let cleanupError;
        try {
          await this.cleanupJobResources(request, {
            ...jobControl,
            signal: AbortSignal.timeout(30000),
            policy: { ...jobControl.policy, timeoutSeconds: 30 },
          });
        } catch (error) { cleanupError = error; }
        if (cleanupError?.code === 'cancellation_failed') {
          await control.onEvent('cleanup_deferred');
          throw cleanupError;
        }
        try {
          await this.cleanup(control.jobDirectory);
        } catch (error) { cleanupError = cleanupError || error; }
        if (cleanupError) {
          await control.onEvent('cleanup_failed');
          if (!originalError) throw new DeploymentError('Deployment cleanup failed', 500, 'cleanup_failed');
        }
      }
    }
  }

  // Startup recovery: discover and remove ONLY this instance's exact
  // job-labelled builder-side resources. Never a broad prune, never a
  // reconstructed name guess. A protected pre-import checkpoint also permits
  // deleting that exact runtime candidate, never replaying or reactivating it.
  async recover(job, directory) {
    if (!JOB_ID.test(job.id)) throw new DeploymentError('Invalid recovery identity', 503, 'invalid_state');
    const control = { jobId: job.id, signal: AbortSignal.timeout(60000), onOutput: () => {} };
    const filters = [`label=io.pw-deploy.instance=${this.config.container.instanceId}`, `label=io.pw-deploy.job=${job.id}`]
      .flatMap(value => ['--filter', value]);
    const names = new Set(['dependencies', 'script', 'version', 'smoke'].map(phase => this.containerName(job.id, phase)));

    const containers = await this.builderRaw(control, ['ps', '-a', ...filters, '--format', '{{.ID}} {{.Names}}'], {
      captureStdout: true, maxStdoutBytes: 1024 * 1024,
    });
    for (const line of containers.output.split('\n').map(text => text.trim()).filter(Boolean)) {
      const [id, name] = line.split(/\s+/);
      if (!/^[0-9a-f]{12,64}$/.test(id || '') || !names.has(name)) {
        throw new DeploymentError('Unexpected recovery container', 503, 'cancellation_failed');
      }
      await this.removeContainer(control, id);
    }

    const volumes = await this.builderRaw(control, ['volume', 'ls', ...filters, '--format', '{{.Name}}'], {
      captureStdout: true, maxStdoutBytes: 1024 * 1024,
    });
    for (const name of volumes.output.split('\n').map(text => text.trim()).filter(Boolean)) {
      if (name !== this.volumeName(job.id)) throw new DeploymentError('Unexpected recovery volume', 503, 'cancellation_failed');
      await this.removeVolume(control, name);
    }

    const images = await this.builderRaw(control, ['images', ...filters, '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'], {
      captureStdout: true, maxStdoutBytes: 1024 * 1024,
    });
    for (const line of images.output.split('\n').map(text => text.trim()).filter(Boolean)) {
      const [id, tag] = line.split(/\s+/);
      if (!/^[0-9a-f]{12,64}$/.test(id || '') || !tag
          || !new RegExp(`^localhost/[a-z0-9][a-z0-9._-]{0,100}:candidate-${job.id}$`).test(tag)) {
        throw new DeploymentError('Unexpected recovery image', 503, 'cancellation_failed');
      }
      await this.assertOwnedResource(control, 'image', tag);
      await this.builderRaw(control, ['image', 'rm', '--no-prune', tag]);
    }

    if (job.adapter === 'podman') await this.cleanupRuntimeCandidate(job, directory, control.signal);
    await this.cleanup(directory);
  }

  // The container flow keeps no local staging directory - source is
  // streamed directly into and out of worker containers - but the hook is
  // preserved for parity with the native executor and any future use.
  async cleanup(directory) {
    if (!directory) return;
    await fs.rm(path.join(directory, 'work'), { recursive: true, force: true });
  }
}
