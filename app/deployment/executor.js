import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DeploymentError } from './protocol.js';

const exec = promisify(execFile);
const STEP_FILE = fileURLToPath(new URL('./step.js', import.meta.url));
const PODMAN = '/usr/bin/podman';
const SYSTEMCTL = '/usr/bin/systemctl';

export async function accountIdentity(name) {
  let stdout;
  try {
    ({ stdout } = await exec('/usr/bin/getent', ['passwd', name], { timeout: 10000, maxBuffer: 16384 }));
  } catch {
    throw new DeploymentError('Configured deployment account cannot be resolved', 503, 'invalid_execution_account');
  }
  const entries = stdout.trim().split('\n');
  const fields = entries[0]?.split(':');
  const uid = Number(fields?.[2]), gid = Number(fields?.[3]);
  if (entries.length !== 1 || fields?.[0] !== name || !Number.isSafeInteger(uid) || uid <= 0
      || !Number.isSafeInteger(gid) || gid <= 0 || !path.posix.isAbsolute(fields?.[5] || '')) {
    throw new DeploymentError('Configured deployment account is unavailable or unsafe', 503, 'invalid_execution_account');
  }
  return { name, uid, gid, home: fields[5] };
}

export function stepInvocation(config, identity, control, phase, cwd, { privilegedHelpers = false } = {}) {
  if (!Number.isSafeInteger(identity.uid) || identity.uid <= 0 || !Number.isSafeInteger(identity.gid) || identity.gid <= 0) {
    throw new DeploymentError('A deployment step cannot run as root', 403, 'invalid_execution_account');
  }
  if (!/^[a-f0-9-]{36}$/.test(control.jobId) || !/^[a-z][a-z0-9-]{0,31}$/.test(phase)) {
    throw new DeploymentError('Invalid step identity');
  }
  const unit = `pw-deploy-step-${control.jobId}-${phase}.service`;
  return {
    unit,
    command: '/usr/bin/systemd-run',
    args: [
      // Unlike Type=exec, a oneshot unit does not treat SIGTERM as a clean
      // command exit. A stopped deployment must not become a success.
      '--quiet', '--wait', '--pipe', '--collect', '--service-type=oneshot', `--unit=${unit}`,
      // Resolve the account's native primary group. An AD account can have a
      // valid passwd GID without a separate NSS group record for Group=<gid>.
      `--uid=${identity.name}`, `--working-directory=${cwd}`,
      '--property=Delegate=yes', '--property=KillMode=control-group',
      '--property=TimeoutStopSec=15s', `--property=TimeoutStartSec=${control.policy.timeoutSeconds}s`,
      `--property=BindsTo=${config.unitName}`, `--property=After=${config.unitName}`,
      `--property=NoNewPrivileges=${privilegedHelpers ? 'no' : 'yes'}`,
      '/usr/bin/node', STEP_FILE,
    ],
  };
}

function baseEnvironment(identity, home) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home || identity.home,
    USER: identity.name, LOGNAME: identity.name, LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: `/run/user/${identity.uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${identity.uid}/bus`,
    NODE_OPTIONS: '--dns-result-order=ipv4first --no-network-family-autoselection',
  };
}

export class HostExecutor {
  constructor(config) { this.config = config; }

  async assertSupervisor() {
    const { stdout } = await exec(SYSTEMCTL, ['show', this.config.unitName, '--property=MainPID', '--value'],
      { timeout: 10000, maxBuffer: 16384 });
    if (Number(stdout.trim()) !== process.pid) {
      throw new DeploymentError('Broker must run in its configured system service', 503, 'supervisor_mismatch');
    }
  }

  async supervisorAvailable() {
    let stdout;
    try {
      ({ stdout } = await exec(SYSTEMCTL,
        ['show', this.config.unitName, '--all', '--property=ActiveState,Job'], { timeout: 10000, maxBuffer: 16384 }));
    } catch (error) {
      if (!error.stdout?.includes('ActiveState=inactive')) {
        throw new DeploymentError('Host supervisor is unavailable', 503, 'supervisor_unavailable');
      }
      stdout = error.stdout;
    }
    const values = new Map(stdout.trim().split('\n').map(line => line.split('=')));
    return values.get('ActiveState') === 'active' && ['', '0'].includes(values.get('Job'));
  }

  async init() {
    if (!process.getuid || process.getuid() !== 0) {
      throw new DeploymentError('The host broker requires its protected system service', 503, 'host_service_required');
    }
    [this.builder, this.runtime] = await Promise.all([
      accountIdentity(this.config.buildUser), accountIdentity(this.config.runtimeUser),
    ]);
    for (const file of ['/usr/bin/node', '/usr/bin/bash', '/usr/bin/systemd-run', SYSTEMCTL]) {
      await fs.access(file, fs.constants.X_OK);
    }
    if (this.config.adapters.includes('podman')) {
      for (const file of [PODMAN, '/usr/bin/npm']) await fs.access(file, fs.constants.X_OK);
    }
    for (const file of ['/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/certs/ca-certificates.crt']) {
      try { await fs.access(file); this.caBundle = file; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async prepare(request, control) {
    const stage = path.join(control.jobDirectory, 'stage');
    const home = path.join(control.jobDirectory, 'home');
    for (const directory of [stage, home]) {
      await fs.mkdir(directory, { mode: 0o700 });
    }
    const directories = new Set([stage]);
    const files = [...request.source.files];
    if (request.recipe.adapter === 'podman' && request.recipe.versionFile) {
      const stamp = {
        path: request.recipe.versionFile, executable: false,
        data: Buffer.from(request.recipe.versionFormat === 'json'
          ? `${JSON.stringify({ version: request.revision.slice(0, 12), builtAt: new Date().toISOString() })}\n`
          : `${request.revision.slice(0, 12)}\n`).toString('base64'),
      };
      const index = files.findIndex(file => file.path === stamp.path);
      if (index === -1) files.push(stamp);
      else files[index] = stamp;
    }
    for (const file of files) {
      control.signal.throwIfAborted();
      const destination = path.join(stage, ...file.path.split('/'));
      const parent = path.dirname(destination);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (current !== stage) { directories.add(current); current = path.dirname(current); }
      const handle = await fs.open(destination, 'wx', file.executable ? 0o700 : 0o600);
      try { await handle.writeFile(Buffer.from(file.data, 'base64')); }
      finally { await handle.close(); }
      await fs.chown(destination, this.builder.uid, this.builder.gid);
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      await fs.chown(directory, this.builder.uid, this.builder.gid);
    }
    await fs.chown(home, this.builder.uid, this.builder.gid);
    return { stage, home };
  }

  async stopUnit(unit, launcher) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await exec(SYSTEMCTL, ['stop', unit], { timeout: 20000, maxBuffer: 16384 });
        return;
      } catch {
        let state;
        try {
          ({ stdout: state } = await exec(SYSTEMCTL, ['show', unit, '--property=LoadState', '--value'],
            { timeout: 10000, maxBuffer: 16384 }));
        } catch (error) { state = error.stdout; }
        if (state?.trim() === 'not-found') {
          // A cancellation can arrive before StartTransientUnit has registered
          // the unit. Do not mistake an in-flight launch for a stopped job.
          if (!launcher || launcher.exitCode !== null || launcher.signalCode !== null) return;
          await sleep(50);
          continue;
        }
        try {
          await exec(SYSTEMCTL, ['kill', '--signal=KILL', unit], { timeout: 10000, maxBuffer: 16384 });
          await exec(SYSTEMCTL, ['stop', unit], { timeout: 10000, maxBuffer: 16384 });
          return;
        } catch {
          throw new DeploymentError('Could not stop the deployment step', 503, 'cancellation_failed');
        }
      }
    }
    throw new DeploymentError('Could not establish that the deployment step stopped', 503, 'cancellation_failed');
  }

  async recover(job, directory) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(job.id)) {
      throw new DeploymentError('Invalid recovery identity', 503, 'invalid_state');
    }
    const prefix = `pw-deploy-step-${job.id}-`;
    const { stdout } = await exec(SYSTEMCTL,
      ['list-units', '--all', '--plain', '--no-legend', '--no-pager', `${prefix}*.service`],
      { timeout: 10000, maxBuffer: 65536 });
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const unit = line.trim().split(/\s+/)[0];
      if (!unit.startsWith(prefix) || !/^[a-z0-9-]+\.service$/.test(unit)) {
        throw new DeploymentError('Unexpected recovery unit', 503, 'cancellation_failed');
      }
      const { stdout: bindings } = await exec(SYSTEMCTL, ['show', unit, '--property=BindsTo', '--value'],
        { timeout: 10000, maxBuffer: 16384 });
      if (!bindings.trim().split(/\s+/).includes(this.config.unitName)) {
        throw new DeploymentError('Recovery unit belongs to another supervisor', 503, 'cancellation_failed');
      }
      await this.stopUnit(unit);
    }
    await this.cleanup(directory);
  }

  async cleanup(directory) {
    for (const name of ['stage', 'home', 'artifacts']) {
      await fs.rm(path.join(directory, name), { recursive: true, force: true });
    }
  }

  async run(identity, control, phase, cwd, argv, {
    env = baseEnvironment(identity), input = '', privilegedHelpers = false,
    capture = false, outputFile, allowedExitCodes = [0],
  } = {}) {
    control.signal.throwIfAborted();
    if (!await this.supervisorAvailable()) {
      throw new DeploymentError('Host supervisor is changing state', 503, 'interrupted');
    }
    control.signal.throwIfAborted();
    const invocation = stepInvocation(this.config, identity, control, phase, cwd, { privilegedHelpers });
    const child = spawn(invocation.command, invocation.args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', failure, stopping, rejectSupervision;
    const supervisionFailed = new Promise((resolve, reject) => { rejectSupervision = reject; });
    const stop = () => {
      if (!stopping) stopping = this.stopUnit(invocation.unit, child).catch(error => {
        failure = error;
        child.kill('SIGTERM');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        rejectSupervision(error);
      });
    };
    const abort = () => stop();
    control.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') { failure = new DeploymentError('Step input failed', 502, 'step_input_failed'); stop(); }
    });
    child.stdin.end(JSON.stringify({ argv, env, input }));
    let outputDone = Promise.resolve();
    if (outputFile) {
      const destination = createWriteStream(outputFile, { flags: 'wx', mode: 0o600 });
      outputDone = pipeline(child.stdout, destination).catch(() => {
        failure = new DeploymentError('Image transfer failed', 502, 'artifact_transfer_failed');
        stop();
      });
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', text => {
        control.onOutput(text);
        if (capture) {
          if (Buffer.byteLength(output) + Buffer.byteLength(text) > 65536) {
            failure = new DeploymentError('Step response exceeded its limit', 502, 'step_output_too_large');
            stop();
          } else output += text;
        }
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => control.onOutput(text));
    try {
      const finished = new Promise((resolve, reject) => {
        child.on('error', () => reject(new DeploymentError('Host supervisor could not start', 503, 'supervisor_unavailable')));
        child.on('close', code => resolve(code));
      });
      const exitCode = await Promise.race([finished, supervisionFailed]);
      await outputDone;
      if (stopping) await stopping;
      if (failure) throw failure;
      control.signal.throwIfAborted();
      if (!allowedExitCodes.includes(exitCode)) {
        if (!await this.supervisorAvailable()) {
          throw new DeploymentError('Host supervisor stopped the deployment', 503, 'interrupted');
        }
        throw new DeploymentError('Deployment step failed', 502, 'step_failed');
      }
      return { output: output.trim(), exitCode };
    } finally {
      control.signal.removeEventListener('abort', abort);
    }
  }

  async script(request, control, paths) {
    const env = {
      ...baseEnvironment(this.builder, paths.home), ...request.environment, ...request.secrets,
      PW_SOURCE_REVISION: request.revision, PW_WORKSPACE_DIR: paths.stage, PW_PROJECT_DIR: paths.stage,
      DEPLOY_PROJECT: request.project, DEPLOY_TARGET: request.target,
      DOTNET_CLI_HOME: paths.home,
    };
    if (this.caBundle) env.NODE_EXTRA_CA_CERTS = this.caBundle;
    await control.onEvent('deploying');
    await this.run(this.builder, control, 'script', paths.stage,
      ['/usr/bin/bash', '--noprofile', '--norc', '-s', '--', 'pw-deploy', request.environment.DEPLOY_OPTION || ''],
      { env, input: `${request.script}\n` });
    let version = null;
    if (request.versionCommand.trim()) {
      await control.onEvent('reading_version');
      version = (await this.run(this.builder, control, 'version', paths.stage,
        ['/usr/bin/bash', '--noprofile', '--norc', '-s'], { env, input: `${request.versionCommand}\n`, capture: true })).output;
    }
    return { version };
  }

  async health(url, signal) {
    return new Promise((resolve, reject) => {
      const transport = new URL(url).protocol === 'https:' ? https : http;
      const request = transport.get(url, { signal, timeout: 5000 }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new DeploymentError('Health endpoint did not return OK', 502, 'health_failed'));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', text => {
          body += text;
          if (Buffer.byteLength(body) > 65536) request.destroy(new Error('Health response too large'));
        });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            if (!health || typeof health !== 'object' || Array.isArray(health)
                || (health.ok !== true && health.status !== 'ok')
                || health.ok === false || (health.status !== undefined && health.status !== 'ok')) throw new Error('Not healthy');
            resolve(health);
          } catch { reject(new DeploymentError('Invalid health response', 502, 'health_failed')); }
        });
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('Health timeout')));
      request.on('error', reject);
    });
  }

  async podman(request, control, paths) {
    const { image, service } = control.policy;
    const candidate = `localhost/${image}:candidate-${control.jobId}`;
    const latest = `localhost/${image}:latest`;
    const command = async (identity, phase, args, options = {}) => this.run(identity, control, phase, paths.stage,
      [PODMAN, '--cgroup-manager=cgroupfs', ...args], { privilegedHelpers: true, ...options });
    const runtimeCommand = (phase, args, options = {}) => this.run(this.runtime, control, phase, '/',
      [PODMAN, '--cgroup-manager=cgroupfs', ...args], { privilegedHelpers: true, ...options });
    const runtimeService = (phase, args, options = {}) => this.run(this.runtime, control, phase, '/',
      [SYSTEMCTL, '--user', ...args], options);
    const loaded = await runtimeService('service-preflight', ['show', `${service}.service`, '--property=LoadState', '--value'], { capture: true });
    if (loaded.output !== 'loaded') throw new DeploymentError('Target service unit is not provisioned', 409, 'service_not_provisioned');
    if (request.source.files.some(file => file.path === 'package-lock.json')) {
      await control.onEvent('installing_dependencies');
      const buildEnv = baseEnvironment(this.builder, paths.home);
      if (this.caBundle) buildEnv.NODE_EXTRA_CA_CERTS = this.caBundle;
      await this.run(this.builder, control, 'dependencies', paths.stage,
        ['/usr/bin/npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'],
        { env: buildEnv });
    }
    await control.onEvent('building_image');
    await command(this.builder, 'build', ['build', '--pull=missing', '-f',
      `./${request.recipe.dockerfile || 'Dockerfile'}`, '--label',
      `org.opencontainers.image.revision=${request.revision}`, '-t', candidate, '.']);
    await control.onEvent('checking_image');
    await command(this.builder, 'image-smoke', ['run', '--rm', '--pull=never', '--network=none',
      '--read-only', '--entrypoint=/bin/true', candidate]);
    const artifactDirectory = path.join(control.jobDirectory, 'artifacts');
    await fs.mkdir(artifactDirectory, { mode: 0o711 });
    await fs.chmod(artifactDirectory, 0o711);
    const artifact = path.join(artifactDirectory, 'candidate.oci');
    await control.onEvent('transferring_image');
    await command(this.builder, 'export', ['save', '--format=oci-archive', candidate], { outputFile: artifact });
    await fs.chown(artifact, 0, this.runtime.gid);
    await fs.chmod(artifact, 0o440);
    await runtimeCommand('import', ['load', '--input', artifact]);
    const imageId = (await runtimeCommand('candidate-id', ['image', 'inspect', '--format', '{{.Id}}', candidate], { capture: true })).output;
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(imageId)) throw new DeploymentError('Invalid candidate image identity', 502, 'invalid_image');
    let previousImage;
    const present = await runtimeCommand('running-exists', ['container', 'exists', service], { allowedExitCodes: [0, 1] });
    if (present.exitCode === 0) {
      previousImage = (await runtimeCommand('running-id', ['inspect', '--format', '{{.Image}}', service], { capture: true })).output;
      if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(previousImage)) throw new DeploymentError('Invalid running image identity', 502, 'invalid_image');
      await runtimeCommand('rollback-tag', ['tag', previousImage, `localhost/${image}:rollback`]);
      await control.onEvent('rollback_saved');
    }
    await control.onEvent('activating_image');
    control.signal.throwIfAborted();
    try {
      await runtimeCommand('promote', ['tag', candidate, latest]);
      await runtimeService('restart', ['restart', `${service}.service`]);
      await control.onEvent('waiting_for_health');
      await this.waitForContainer(request, control, imageId);
    } catch (error) {
      if (previousImage && !['cancellation_failed', 'interrupted'].includes(error?.code)
          && control.signal.reason?.code !== 'interrupted') {
        const recovery = { ...control, signal: AbortSignal.timeout(60000),
          policy: { ...control.policy, timeoutSeconds: 60 } };
        await control.onEvent('restoring_previous_image');
        try {
          await this.run(this.runtime, recovery, 'rollback-promote', '/',
            [PODMAN, '--cgroup-manager=cgroupfs', 'tag', previousImage, latest], { privilegedHelpers: true });
          await this.run(this.runtime, recovery, 'rollback-restart', '/',
            [SYSTEMCTL, '--user', 'restart', `${service}.service`]);
          await this.waitForContainer(request, recovery, previousImage, { prefix: 'rollback', probeHealth: false });
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

  async waitForContainer(request, control, imageId, { prefix = 'verify', probeHealth = true } = {}) {
    const service = `${control.policy.service}.service`;
    const podman = (phase, args, options = {}) => this.run(this.runtime, control, `${prefix}-${phase}`, '/',
      [PODMAN, '--cgroup-manager=cgroupfs', ...args], { privilegedHelpers: true, ...options });
    let failureCode = 'health_failed';
    for (let attempt = 0; attempt < 20; attempt++) {
      control.signal.throwIfAborted();
      let healthy = true;
      if (probeHealth && request.recipe.healthUrl) {
        try {
          const health = await this.health(request.recipe.healthUrl, control.signal);
          if (request.recipe.versionField && health[request.recipe.versionField] !== request.revision.slice(0, 12)) {
            throw new DeploymentError('Running version does not match source', 502, 'version_mismatch');
          }
        } catch (error) {
          control.signal.throwIfAborted();
          healthy = false;
          failureCode = error?.code === 'version_mismatch' ? 'version_mismatch' : 'health_failed';
        }
      }
      const active = await this.run(this.runtime, control, `${prefix}-active-${attempt}`, '/',
        [SYSTEMCTL, '--user', 'is-active', service], { capture: true, allowedExitCodes: [0, 3] });
      if (healthy && active.exitCode === 0 && active.output === 'active') {
        const exists = await podman(`exists-${attempt}`, ['container', 'exists', control.policy.service], { allowedExitCodes: [0, 1] });
        if (exists.exitCode === 0) {
          const running = (await podman(`image-${attempt}`,
            ['inspect', '--format', '{{.State.Running}} {{.Image}}', control.policy.service], { capture: true })).output;
          if (running.startsWith('true ')
              && running.slice(5).replace(/^sha256:/, '') === imageId.replace(/^sha256:/, '')) return;
          failureCode = 'version_mismatch';
        }
      }
      await sleep(1000, undefined, { signal: control.signal });
    }
    throw new DeploymentError('Container did not become ready with the expected image', 502, failureCode);
  }

  async cleanupImages(control) {
    const cleanup = { ...control, signal: AbortSignal.timeout(30000),
      policy: { ...control.policy, timeoutSeconds: 30 } };
    const candidate = `localhost/${control.policy.image}:candidate-${control.jobId}`;
    const seen = new Set();
    for (const [role, identity] of [['build', this.builder], ['runtime', this.runtime]]) {
      if (seen.has(identity.uid)) continue;
      seen.add(identity.uid);
      const exists = await this.run(identity, cleanup, `cleanup-${role}-exists`, '/',
        [PODMAN, '--cgroup-manager=cgroupfs', 'image', 'exists', candidate],
        { privilegedHelpers: true, allowedExitCodes: [0, 1] });
      if (exists.exitCode === 0) {
        await this.run(identity, cleanup, `cleanup-${role}-image`, '/',
          [PODMAN, '--cgroup-manager=cgroupfs', 'image', 'rm', '--no-prune', candidate], { privilegedHelpers: true });
      }
    }
  }

  async deploy(request, control) {
    control.signal.throwIfAborted();
    await control.onEvent('preparing_source');
    let originalError;
    try {
      const paths = await this.prepare(request, control);
      if (request.recipe.adapter === 'podman') return await this.podman(request, control, paths);
      return await this.script(request, control, paths);
    } catch (error) {
      originalError = error;
      throw error;
    } finally {
      if (originalError?.code === 'cancellation_failed') {
        await control.onEvent('cleanup_deferred');
      } else {
        let cleanupError;
        try {
          if (request.recipe.adapter === 'podman' && originalError?.code !== 'interrupted'
              && control.signal.reason?.code !== 'interrupted') await this.cleanupImages(control);
        } catch (error) { cleanupError = error; }
        if (cleanupError?.code === 'cancellation_failed') {
          await control.onEvent('cleanup_deferred');
          throw cleanupError;
        }
        try { await this.cleanup(control.jobDirectory); }
        catch (error) { cleanupError ||= error; }
        if (cleanupError) {
          await control.onEvent('cleanup_failed');
          if (!originalError) throw new DeploymentError('Deployment staging cleanup failed', 500, 'cleanup_failed');
        }
      }
    }
  }
}
