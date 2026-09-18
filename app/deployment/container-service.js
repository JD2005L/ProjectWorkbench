import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withLifecycleLock } from '../lifecycle-lock.js';
import { writeFileAtomic } from '../atomic-file.js';
import { DeploymentError } from './protocol.js';
import { DeploymentEngine } from './engine.js';
import { JobStore } from './store.js';
import { createDeploymentServer } from './service.js';
import {
  assertContainerIsolation, assertContainerBuildSupport, readContainerConfig, readContainerCredentials, validateContainerCredentials,
} from './container-config.js';
import { ContainerExecutor } from './container-executor.js';
import { createStandaloneWeb } from './standalone-web.js';

export async function startContainerService({
  config, token, uiToken, executor = new ContainerExecutor(config),
  store = new JobStore(config.stateDir), installSignals = false,
}) {
  validateContainerCredentials({ token, uiToken });
  let server, web, retentionTimer, pruning, closing, complete, fatalError;
  const finished = new Promise(resolve => { complete = resolve; });
  const engine = new DeploymentEngine({
    config, store, executor,
    onFatal: error => {
      fatalError ??= error;
      process.stderr.write('Deployment controller stopped after an execution or state failure\n');
      void close().catch(() => { if (installSignals) process.exitCode = 1; });
    },
  });

  function close() {
    if (closing) return closing;
    closing = (async () => {
      engine.stopping = true;
      clearInterval(retentionTimer);
      if (installSignals) {
        process.removeListener('SIGTERM', signal);
        process.removeListener('SIGINT', signal);
      }
      const stoppedListening = new Promise((resolve, reject) => {
        if (!server?.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      const outcomes = await Promise.allSettled([
        engine.close(), pruning, stoppedListening,
        Promise.resolve().then(() => web?.close?.()),
      ]);
      const errors = [...new Set([
        ...outcomes.filter(result => result.status === 'rejected').map(result => result.reason),
        ...(fatalError ? [fatalError] : []),
      ])];
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Deployment controller shutdown failed');
    })();
    closing.then(() => complete({ ok: true }), error => complete({ ok: false, error }));
    return closing;
  }

  function signal() {
    void close().catch(() => {
      process.stderr.write('Deployment shutdown could not confirm cleanup; owned-job recovery is required\n');
      process.exitCode = 1;
      server?.closeAllConnections();
    });
  }

  try {
    await executor.init();
    await engine.init();
    web = createStandaloneWeb({
      engine, token: uiToken, basePath: config.ui.basePath,
      publicOrigin: config.ui.publicOrigin, sessionMinutes: config.ui.sessionMinutes,
    });
    server = createDeploymentServer({
      engine, token, web, publicHealthPath: `${config.ui.basePath}/health`,
    });
    await new Promise((resolve, reject) => {
      const failed = error => reject(error);
      server.once('error', failed);
      server.listen(config.listen.port, config.listen.host, () => {
        server.removeListener('error', failed);
        resolve();
      });
    });
    server.on('error', error => engine.failClosed(error));
    if (installSignals) {
      process.on('SIGTERM', signal);
      process.on('SIGINT', signal);
    }
    retentionTimer = setInterval(() => {
      if (!pruning && !closing) {
        pruning = engine.prune().catch(error => engine.failClosed(error)).finally(() => { pruning = null; });
      }
    }, 3600000);
    retentionTimer.unref();
    return { engine, server, close, finished };
  } catch (error) {
    const [cleanup] = await Promise.allSettled([close()]);
    if (cleanup.status === 'rejected' && cleanup.reason !== error) {
      throw new AggregateError([error, cleanup.reason], 'Deployment startup and cleanup failed');
    }
    throw error;
  }
}

export async function bindExecutionIdentity(config) {
  const file = path.join(config.stateDir, 'execution-identity.json');
  const runtime = config.container.runtime;
  const builder = config.container.builderControl;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    instanceId: config.container.instanceId, builderSocket: config.container.builderSocket,
    runtime: runtime ? { host: runtime.host, port: runtime.port, user: runtime.user } : null,
    ...(builder ? {
      builder: { host: builder.host, port: builder.port, user: builder.user },
      builderJobSockets: config.container.builderJobSockets,
    } : {}),
  })).digest('hex');
  let previous;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) || stat.size > 1024) {
      throw new DeploymentError('Unsafe execution identity record', 503, 'unsafe_state');
    }
    previous = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== undefined) {
    if (previous?.fingerprint !== fingerprint || Object.keys(previous).length !== 1) {
      throw new DeploymentError('Execution identity changed; reconcile owned work before migrating state', 503, 'execution_identity_changed');
    }
  } else {
    await writeFileAtomic(file, `${JSON.stringify({ fingerprint })}\n`, { mode: 0o600 });
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new Error('Usage: node container-service.js --config /absolute/config.json');
  }
  process.umask(0o077);
  await assertContainerIsolation();
  const config = await readContainerConfig(path.resolve(process.argv[3]));
  await assertContainerBuildSupport(config);
  const credentials = await readContainerCredentials(config);
  const store = new JobStore(config.stateDir);
  await store.init();
  await withLifecycleLock(path.join(config.stateDir, 'controller.lock'), async () => {
    await bindExecutionIdentity(config);
    const application = await startContainerService({ config, ...credentials, store, installSignals: true });
    process.stdout.write('Contained deployment engine and console ready\n');
    const outcome = await application.finished;
    if (!outcome.ok) throw outcome.error;
  }, { timeoutMs: 1000 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const reason = error instanceof DeploymentError ? error.code : 'service_failure';
    process.stderr.write(`Contained deployment service failed (${reason})\n`);
    process.exitCode = 78;
  });
}
