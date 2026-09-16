import http from 'node:http';
import https from 'node:https';
import {
  API_VERSION, SERVICE_NAME, MAX_REQUEST_BYTES, TERMINAL_STATES, ADAPTERS,
  DeploymentError, fields, record, projectName, targetName, publicJob, validateEndpoint, validateJob,
} from './protocol.js';
import { validateServiceToken } from './settings.js';

export const JOB_STATES = new Set(['queued', 'running', 'cancelling', ...TERMINAL_STATES]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SERVICE_ERRORS = {
  unauthorized: 'Deployment service rejected its credential.',
  target_paused: 'The deployment service or target is paused.',
  queue_full: 'The deployment service is busy. No automatic retry was made.',
  job_finished: 'This deployment has already finished.',
  job_not_found: 'The deployment job was not found.',
  not_found: 'The deployment service resource was not found.',
  timeout: 'The deployment deadline was exceeded.',
  source_too_large: 'The deployment source exceeds the service limit.',
  resource_not_allowed: 'Container image and service must belong to the selected project and target.',
  health_host_not_allowed: 'The deployment health endpoint host is not approved by service policy.',
  adapter_disabled: 'The deployment adapter is disabled by service policy.',
  invalid_request: 'The deployment service rejected the request.',
};

function protocolError() {
  return new DeploymentError('The endpoint did not return a compatible deployment service response.', 502, 'deployment_protocol_error');
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw new DeploymentError('Invalid deployment job ID.');
  return value;
}

function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DeploymentError('Invalid deployment numeric parameter.');
  return value;
}

function text(value, max = 1000) {
  if (typeof value !== 'string' || value.length > max) throw protocolError();
  return value;
}

function date(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw protocolError();
  return value;
}

function responseJob(value) {
  if (!record(value)) throw protocolError();
  try {
    identifier(value.id);
    projectName(value.project);
    targetName(value.target);
  } catch { throw protocolError(); }
  if (!JOB_STATES.has(value.state) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision || '')) throw protocolError();
  if (typeof value.createdAt !== 'string' || typeof value.phase !== 'string' || !value.phase) throw protocolError();
  if (value.adapter !== undefined && !ADAPTERS.includes(value.adapter)) throw protocolError();
  for (const key of ['createdAt', 'startedAt', 'finishedAt']) date(value[key]);
  for (const key of ['phase', 'requestId', 'sourceDigest', 'errorCode']) if (value[key] !== undefined) text(value[key], 200);
  if (value.version !== undefined && value.version !== null) text(value.version, 500);
  return publicJob(value);
}

function serviceSettings(value) {
  if (typeof value.paused !== 'boolean') throw protocolError();
  try {
    return { paused: value.paused, maxConcurrent: integer(value.maxConcurrent, 1, 4),
      defaultTimeoutSeconds: integer(value.defaultTimeoutSeconds, 30, 3600), retentionDays: integer(value.retentionDays, 1, 90) };
  } catch { throw protocolError(); }
}

function targetSettings(value) {
  try {
    if (!record(value) || typeof value.paused !== 'boolean') throw protocolError();
    const target = { project: projectName(value.project), target: targetName(value.target),
      paused: value.paused, timeoutSeconds: integer(value.timeoutSeconds, 30, 3600) };
    if (value.adapter !== undefined) {
      if (!ADAPTERS.includes(value.adapter)) throw protocolError();
      target.adapter = value.adapter;
    }
    return target;
  } catch { throw protocolError(); }
}

export class DeploymentClient {
  #endpoint;
  #token;
  #timeoutMs;
  #maxResponseBytes;

  constructor({ endpoint, token, timeoutMs = 10000, maxResponseBytes = MAX_RESPONSE_BYTES }) {
    this.#endpoint = validateEndpoint(endpoint);
    this.#token = validateServiceToken(token);
    this.#timeoutMs = integer(timeoutMs, 1, 120000);
    this.#maxResponseBytes = integer(maxResponseBytes, 1, MAX_RESPONSE_BYTES);
  }

  #redact(value) {
    return value.replaceAll(this.#token, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  }

  #job(value) {
    const job = responseJob(value);
    if (JSON.stringify(job).includes(this.#token)) throw protocolError();
    return job;
  }

  #request(method, apiPath, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      throw new DeploymentError('Deployment request is too large.', 413, 'request_too_large');
    }
    const endpoint = this.#endpoint;
    const secure = endpoint.url?.protocol === 'https:';
    const options = {
      method, agent: false,
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.#token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
      ...(endpoint.socketPath ? { socketPath: endpoint.socketPath, path: apiPath } : {
        protocol: endpoint.url.protocol,
        hostname: endpoint.url.hostname === 'localhost' && !secure ? '127.0.0.1' : endpoint.url.hostname.replace(/^\[|\]$/g, ''),
        port: endpoint.url.port || undefined,
        path: `${endpoint.url.pathname.replace(/\/$/, '')}${apiPath}`,
      }),
      ...(secure ? { rejectUnauthorized: true } : {}),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const request = (secure ? https : http).request(options, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          finish(new DeploymentError('Deployment endpoint returned a redirect. Redirects are not followed.', 502, 'deployment_redirect'));
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
          response.destroy(); finish(protocolError()); return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > this.#maxResponseBytes) {
            finish(new DeploymentError('Deployment service response exceeded its limit.', 502, 'deployment_response_too_large'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(new DeploymentError('Deployment service response was interrupted.', 502, 'deployment_unreachable')));
        response.on('end', () => {
          if (settled) return;
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(protocolError()); return; }
          if (!record(value)) { finish(protocolError()); return; }
          if (response.statusCode < 200 || response.statusCode >= 300 || value.ok !== true) {
            const code = Object.hasOwn(SERVICE_ERRORS, value.code) ? value.code : 'deployment_service_rejected';
            const message = SERVICE_ERRORS[code] || 'Deployment service rejected the operation. No automatic retry was made.';
            const status = [400, 403, 404, 409, 413, 423, 429].includes(response.statusCode) ? response.statusCode : 502;
            finish(new DeploymentError(message, status, code));
            return;
          }
          finish(null, value);
        });
      });
      timer = setTimeout(() => {
        finish(new DeploymentError('Deployment service timed out. A submitted job may still be running; inspect job history before retrying.', 504, 'deployment_timeout'));
        request.destroy();
      }, this.#timeoutMs);
      request.on('error', () => finish(new DeploymentError('Deployment service is unreachable or its TLS certificate is invalid. No local deployment was attempted.', 503, 'deployment_unreachable')));
      request.end(payload);
    });
  }

  async health() {
    const value = await this.#request('GET', '/v1/health');
    if (value.service !== SERVICE_NAME || value.apiVersion !== API_VERSION || typeof value.ready !== 'boolean'
        || !Number.isSafeInteger(value.running) || value.running < 0 || !Number.isSafeInteger(value.queued) || value.queued < 0) throw protocolError();
    return { ok: true, service: SERVICE_NAME, apiVersion: API_VERSION, ready: value.ready, running: value.running, queued: value.queued };
  }

  async #readyRequest(method, apiPath, body) {
    if (!(await this.health()).ready) throw new DeploymentError('The deployment service is not ready.', 503, 'deployment_not_ready');
    return this.#request(method, apiPath, body);
  }

  async submit(job) {
    const submitted = validateJob(job);
    const response = this.#job((await this.#readyRequest('POST', '/v1/jobs', submitted)).job);
    if (response.project !== submitted.project || response.target !== submitted.target || response.revision !== submitted.revision
        || response.requestId !== submitted.requestId) throw protocolError();
    return response;
  }

  async jobs({ project, target, limit = 50 } = {}) {
    const query = new URLSearchParams({ limit: String(integer(limit, 1, 200)) });
    if (project !== undefined) query.set('project', projectName(project));
    if (target !== undefined) query.set('target', targetName(target));
    const value = await this.#readyRequest('GET', `/v1/jobs?${query}`);
    if (!Array.isArray(value.jobs) || value.jobs.length > limit) throw protocolError();
    const jobs = value.jobs.map(job => this.#job(job));
    if (jobs.some(job => (project !== undefined && job.project !== project) || (target !== undefined && job.target !== target))) throw protocolError();
    return jobs;
  }

  async job(id) {
    const job = this.#job((await this.#readyRequest('GET', `/v1/jobs/${identifier(id)}`)).job);
    if (job.id !== id) throw protocolError();
    return job;
  }

  async cancel(id) {
    const job = this.#job((await this.#readyRequest('POST', `/v1/jobs/${identifier(id)}/cancel`, {})).job);
    if (job.id !== id) throw protocolError();
    return job;
  }

  async log(id, after = 0) {
    const value = await this.#readyRequest('GET', `/v1/jobs/${identifier(id)}/log?after=${integer(after, 0, Number.MAX_SAFE_INTEGER)}`);
    if (!Array.isArray(value.events) || value.events.length > 2048 || !Array.isArray(value.live) || value.live.length > 256
        || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < after) throw protocolError();
    const sequence = entry => {
      if (!record(entry) || !Number.isSafeInteger(entry.seq) || entry.seq <= after || entry.seq > value.nextSeq || typeof entry.at !== 'string') throw protocolError();
      return { seq: entry.seq, at: date(entry.at) };
    };
    const events = value.events.map(entry => {
      const event = { ...sequence(entry), phase: this.#redact(text(entry.phase, 200)) };
      for (const key of ['state', 'code', 'message']) if (entry[key] !== undefined) event[key] = this.#redact(text(entry[key], 1000));
      return event;
    });
    const live = value.live.map(entry => ({ ...sequence(entry), text: this.#redact(text(entry.text, 16384)) }));
    if (new Set([...events, ...live].map(entry => entry.seq)).size !== events.length + live.length) throw protocolError();
    return { events, live, nextSeq: value.nextSeq };
  }

  async version(project, target) {
    const value = await this.#readyRequest('GET', `/v1/version/${encodeURIComponent(projectName(project))}/${targetName(target)}`);
    if (value.version !== null) text(value.version, 500);
    if (value.revision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision || '')) throw protocolError();
    if (value.deployedAt === undefined) throw protocolError();
    return { version: value.version === null ? null : this.#redact(value.version), revision: value.revision, deployedAt: date(value.deployedAt) };
  }

  async targets() {
    const value = await this.#readyRequest('GET', '/v1/targets');
    if (!Array.isArray(value.targets) || value.targets.length > 10000) throw protocolError();
    return value.targets.map(targetSettings);
  }

  async updateTarget(project, target, update) {
    fields(update, ['paused', 'timeoutSeconds'], 'target settings');
    if (typeof update.paused !== 'boolean') throw new DeploymentError('paused must be boolean.');
    if (update.timeoutSeconds !== undefined) integer(update.timeoutSeconds, 30, 3600);
    const value = await this.#readyRequest('PUT', `/v1/targets/${encodeURIComponent(projectName(project))}/${targetName(target)}`, update);
    const result = targetSettings(value.target);
    if (result.project !== project || result.target !== target) throw protocolError();
    return result;
  }

  async settings() {
    return serviceSettings(await this.#readyRequest('GET', '/v1/settings'));
  }

  async updateSettings(update) {
    fields(update, ['paused', 'maxConcurrent', 'defaultTimeoutSeconds', 'retentionDays'], 'service settings');
    if (update.paused !== undefined && typeof update.paused !== 'boolean') throw new DeploymentError('paused must be boolean.');
    if (update.maxConcurrent !== undefined) integer(update.maxConcurrent, 1, 4);
    if (update.defaultTimeoutSeconds !== undefined) integer(update.defaultTimeoutSeconds, 30, 3600);
    if (update.retentionDays !== undefined) integer(update.retentionDays, 1, 90);
    return serviceSettings(await this.#readyRequest('PUT', '/v1/settings', update));
  }
}
