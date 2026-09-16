import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, SERVICE_NAME, MAX_REQUEST_BYTES, DeploymentError, publicJob, fields } from './protocol.js';
import { readHostConfig, readProtectedFile } from './policy.js';
import { JobStore } from './store.js';
import { DeploymentEngine } from './engine.js';
import { HostExecutor } from './executor.js';

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function jsonBody(request, maxBytes = 65536) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new DeploymentError('JSON request content is required', 415, 'invalid_content_type');
  }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new DeploymentError('Request is too large', 413, 'request_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new DeploymentError('Request is too large', 413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DeploymentError('Request is not valid JSON'); }
}

export function createDeploymentServer({ engine, token }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) throw new Error('Invalid service credential');
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  let uploads = 0;
  const server = http.createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const method = request.method;
      if ((method === 'GET' || method === 'HEAD') && url.pathname === '/health') {
        reply(response, engine.stopping ? 503 : 200, { ok: !engine.stopping, service: SERVICE_NAME, apiVersion: API_VERSION });
        return;
      }
      const authorization = String(request.headers.authorization || '');
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!supplied || supplied.length > 512
          || !crypto.timingSafeEqual(tokenHash, crypto.createHash('sha256').update(supplied).digest())) {
        request.resume();
        reply(response, 401, { ok: false, error: 'Deployment service authentication required', code: 'unauthorized' });
        return;
      }
      let parts;
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new DeploymentError('Invalid API path'); }
      if (parts[0] !== 'v1') throw new DeploymentError('Deployment endpoint not found', 404, 'not_found');
      if (parts.length === 2 && parts[1] === 'health' && method === 'GET') {
        reply(response, 200, { ok: true, service: SERVICE_NAME, apiVersion: API_VERSION,
          ready: !engine.stopping, running: engine.active.size, queued: engine.queue.length });
      } else if (parts.length === 2 && parts[1] === 'jobs' && method === 'POST') {
        if (uploads >= 2) throw new DeploymentError('Source transfer capacity is busy', 429, 'queue_full');
        uploads++;
        try {
          const job = await engine.submit(await jsonBody(request, MAX_REQUEST_BYTES));
          reply(response, 202, { ok: true, job });
        } finally { uploads--; }
      } else if (parts.length === 2 && parts[1] === 'jobs' && method === 'GET') {
        const jobs = engine.list({
          project: url.searchParams.get('project') || undefined,
          target: url.searchParams.get('target') || undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
        });
        reply(response, 200, { ok: true, jobs });
      } else if (parts.length === 3 && parts[1] === 'jobs' && method === 'GET') {
        reply(response, 200, { ok: true, job: publicJob(engine.get(parts[2])) });
      } else if (parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'log' && method === 'GET') {
        reply(response, 200, { ok: true, ...engine.logs(parts[2], Number(url.searchParams.get('after') || 0)) });
      } else if (parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'cancel' && method === 'POST') {
        fields(await jsonBody(request), [], 'cancellation');
        reply(response, 200, { ok: true, job: await engine.cancel(parts[2]) });
      } else if (parts.length === 4 && parts[1] === 'version' && method === 'GET') {
        reply(response, 200, { ok: true, ...engine.version(parts[2], parts[3]) });
      } else if (parts.length === 2 && parts[1] === 'targets' && method === 'GET') {
        reply(response, 200, { ok: true, targets: engine.targetList() });
      } else if (parts.length === 4 && parts[1] === 'targets' && method === 'PUT') {
        const target = await engine.updateTarget(parts[2], parts[3], await jsonBody(request));
        reply(response, 200, { ok: true, target });
      } else if (parts.length === 2 && parts[1] === 'settings' && method === 'GET') {
        reply(response, 200, { ok: true, ...engine.settings });
      } else if (parts.length === 2 && parts[1] === 'settings' && method === 'PUT') {
        reply(response, 200, { ok: true, ...await engine.updateSettings(await jsonBody(request)) });
      } else throw new DeploymentError('Deployment endpoint not found', 404, 'not_found');
    } catch (error) {
      request.resume();
      if (!response.headersSent && !response.destroyed) {
        const known = error instanceof DeploymentError;
        reply(response, known ? error.statusCode : 500, {
          ok: false, error: known ? error.message : 'Deployment service operation failed',
          code: known ? error.code : 'service_error',
        });
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new Error('Usage: node service.js --config /absolute/config.json');
  }
  process.umask(0o077);
  const config = await readHostConfig(path.resolve(process.argv[3]));
  const token = (await readProtectedFile(config.tokenFile, { secret: true })).trim();
  const executor = new HostExecutor(config);
  await executor.init();
  await executor.assertSupervisor();
  let server, pruning, retentionTimer, stopping = false;
  const engine = new DeploymentEngine({
    config, store: new JobStore(config.stateDir), executor,
    onFatal: () => {
      process.stderr.write('Deployment service stopped after a supervision or state failure\n');
      void shutdown(1);
    },
  });
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(retentionTimer);
    try {
      const closed = new Promise(resolve => {
        if (!server?.listening) resolve();
        else server.close(resolve);
      });
      server?.closeIdleConnections();
      await engine.close();
      await pruning;
      await closed;
      process.exitCode = code;
    } catch {
      process.stderr.write('Deployment service shutdown failed; bound units will be stopped by systemd\n');
      process.exit(1);
    }
  }
  await engine.init();
  server = createDeploymentServer({ engine, token });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  try {
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      if (config.listen.socketPath) server.listen(config.listen.socketPath, onListening);
      else server.listen(config.listen.port, config.listen.host, onListening);
    });
    server.on('error', error => engine.failClosed(error));
    if (config.listen.socketPath) await fs.chmod(config.listen.socketPath, 0o600);
  } catch (error) {
    await shutdown(78);
    throw error;
  }
  retentionTimer = setInterval(() => {
    if (!pruning && !stopping) {
      pruning = engine.prune().catch(error => engine.failClosed(error)).finally(() => { pruning = null; });
    }
  }, 3600000);
  retentionTimer.unref();
  process.stdout.write('PW deployment service ready\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const reason = error instanceof DeploymentError ? `${error.code}: ${error.message}`
      : typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'invalid_configuration';
    process.stderr.write(`Deployment service startup failed (${reason}); inspect configuration and prerequisites\n`);
    process.exitCode = 78;
  });
}
