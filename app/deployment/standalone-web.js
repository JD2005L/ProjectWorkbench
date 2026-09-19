// A minimal, self-contained administration console for the contained
// deployment engine. This module owns its own authentication: Project
// Workbench is never involved in serving or signing in to this surface, and
// it never calls back into PW. It is mounted as the optional `web` handler
// accepted by createDeploymentServer (see service.js), which tries it before
// the machine /v1/* bearer-token check, so a cookie here can never authorize
// the machine API and a machine bearer token here is never treated as a UI
// session.
import crypto from 'node:crypto';
import { reply, jsonBody } from './service.js';
import {
  API_VERSION, SERVICE_NAME, TERMINAL_STATES, DeploymentError, fields, publicJob, projectName, targetName, consoleSelectorQuery,
} from './protocol.js';
import { JOB_STATES } from './client.js';
import { renderDeploymentPage, renderStandaloneLogin, renderStandaloneNotice } from './ui.js';
import {
  SESSION_COOKIE, createSessionStore, createLoginLimiter, constantTimeEqual, parseCookies, serializeSessionCookie,
} from './standalone-auth.js';

const API_PREFIX = '/api/deploy-service';
const MAX_LOGIN_BODY = 4096;
const MAX_API_BODY = 65536;
const BASE_PATH_PATTERN = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
// Mirrors container-config.js's validateUiLocation: a base path of exactly
// /v1 or /health (or anything nested under them) collides with the native
// machine API and public health routes handled by service.js. Enforced here
// too, independently of that bootstrap-time check, so a direct
// createStandaloneWeb call can never mount the cookie-authenticated console
// where it would shadow the bearer-token API. Only the exact segment is
// reserved -- /v1beta or /healthcheck are ordinary, unrelated base paths.
const RESERVED_BASE_PATH = /^\/(?:v1|health)(?:\/|$)/;

function invalid(message) {
  throw new Error(message);
}

function requireHttpsOrigin(value, label) {
  let url;
  try { url = new URL(value); }
  catch { return invalid(`${label} must be a valid HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname) {
    invalid(`${label} must be a valid HTTPS origin with no path, credentials or query`);
  }
  return url.origin;
}

// Bounded application/x-www-form-urlencoded body reader for the plain HTML
// login and logout forms (kept separate from service.js's jsonBody, which
// requires a JSON content type).
async function formBody(request, maxBytes) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded')) {
    throw new DeploymentError('A form submission is required', 415, 'invalid_content_type');
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
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function nonce() {
  return crypto.randomBytes(16).toString('base64');
}

function csp(value) {
  return `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; `
    + `connect-src 'self'; img-src 'self'; script-src 'nonce-${value}'; style-src 'nonce-${value}'`;
}

function sendHtml(response, status, html, cspNonce) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', csp(cspNonce));
  response.end(html);
}

function sendRedirect(response, status, location, cookie) {
  response.statusCode = status;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (cookie) response.setHeader('Set-Cookie', cookie);
  response.end();
}

export function createStandaloneWeb({
  engine, token, basePath = '/deploy-service', publicOrigin, sessionMinutes = 30,
  now = () => Date.now(), maxSessions = 200, maxLoginAttempts = 10, loginWindowMs = 5 * 60000,
  maxConcurrentLogins = 4,
} = {}) {
  if (!engine || typeof engine.list !== 'function' || typeof engine.targetList !== 'function') {
    invalid('A deployment engine is required');
  }
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    invalid('A strong console administrator credential is required');
  }
  if (typeof basePath !== 'string' || basePath.length > 160 || !BASE_PATH_PATTERN.test(basePath)
      || RESERVED_BASE_PATH.test(basePath)) {
    invalid('Invalid console base path');
  }
  const origin = requireHttpsOrigin(publicOrigin, 'The console public origin');
  if (!Number.isSafeInteger(sessionMinutes) || sessionMinutes < 5 || sessionMinutes > 120) {
    invalid('Invalid console session lifetime');
  }
  // Bounded, not just "whatever the caller passes": these gate memory-only
  // session/rate-limiter state, so a stray negative/NaN/absurd value from
  // config must fail fast at construction rather than silently misbehave
  // (e.g. a NaN window never expiring, or a negative capacity locking every
  // session out).
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10000) {
    invalid('Invalid console session capacity');
  }
  if (!Number.isSafeInteger(maxLoginAttempts) || maxLoginAttempts < 1 || maxLoginAttempts > 1000) {
    invalid('Invalid console login attempt bound');
  }
  if (!Number.isSafeInteger(loginWindowMs) || loginWindowMs < 1000 || loginWindowMs > 24 * 60 * 60000) {
    invalid('Invalid console login throttle window');
  }
  // maxConcurrentLogins may be 0 (deliberately refuse all sign-ins), so its
  // floor is 0, not 1.
  if (!Number.isSafeInteger(maxConcurrentLogins) || maxConcurrentLogins < 0 || maxConcurrentLogins > 1000) {
    invalid('Invalid console login concurrency bound');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const sessions = createSessionStore({ sessionMinutes, maxSessions, now });
  const limiter = createLoginLimiter({ windowMs: loginWindowMs, maxAttempts: maxLoginAttempts, now });
  let activeLogins = 0;

  function session(request) {
    return sessions.get(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  }
  function clientKey(request) {
    return request.socket?.remoteAddress || 'unknown';
  }
  function requireMutationAllowed(request, activeSession) {
    if (request.headers.origin !== origin) {
      throw new DeploymentError('This action requires a direct, same-origin request.', 403, 'origin_rejected');
    }
    if (!constantTimeEqual(activeSession.csrfToken, request.headers['x-csrf-token'])) {
      throw new DeploymentError('This action requires a valid session CSRF token.', 403, 'csrf_rejected');
    }
  }

  function renderConsole(activeSession) {
    const value = nonce();
    // Projects are derived from observed target activity only; there is no
    // separate enrollment/registry, so a never-deployed project never appears.
    const projects = [...new Set(engine.targetList().map(target => target.project))]
      .sort().map(name => ({ name }));
    const html = renderDeploymentPage({
      base: basePath, admin: true, projects,
      standalone: { nonce: value, csrfToken: activeSession.csrfToken, logoutPath: `${basePath}/logout` },
    });
    return { html, nonce: value };
  }

  function renderLogin(status, error, query = '') {
    const value = nonce();
    return { status, nonce: value, html: renderStandaloneLogin({ basePath, error, nonce: value, query }) };
  }

  function renderNotice(status, title, message) {
    const value = nonce();
    return { status, nonce: value, html: renderStandaloneNotice({ basePath, title, message, nonce: value }) };
  }

  async function apiDispatch(apiPath, request, response, url, activeSession) {
    let parts;
    try { parts = apiPath.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new DeploymentError('Invalid deployment console path'); }
    const method = request.method;
    if (parts.length === 1 && parts[0] === 'jobs' && method === 'GET') {
      // Mirrors the PW route's GET /jobs semantics exactly (routes.js): same
      // validators/error text for limit/project/target/state, and the same
      // "fetch a wide pool, then filter by state, re-sort and slice to the
      // requested limit" shape. engine.list() itself has no state parameter
      // (state filtering is a route-level concern there too), so a state
      // selected in the shared UI only narrows results if this route applies
      // it explicitly.
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DeploymentError('Job limit must be 1-200.');
      const project = url.searchParams.has('project') ? projectName(url.searchParams.get('project')) : undefined;
      const target = url.searchParams.has('target') ? targetName(url.searchParams.get('target')) : undefined;
      const state = url.searchParams.has('state') ? url.searchParams.get('state') : undefined;
      if (state !== undefined && !JOB_STATES.has(state)) throw new DeploymentError('Invalid deployment job state.');
      const jobs = engine.list({ project, target, limit: 200 })
        .filter(item => state === undefined || item.state === state)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, limit);
      return reply(response, 200, { ok: true, jobs });
    }
    if (parts.length === 2 && parts[0] === 'jobs' && method === 'GET') {
      return reply(response, 200, { ok: true, job: publicJob(engine.get(parts[1])) });
    }
    if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'log' && method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      return reply(response, 200, { ok: true, ...engine.logs(parts[1], after) });
    }
    if (parts.length === 3 && parts[0] === 'jobs' && parts[2] === 'cancel' && method === 'POST') {
      requireMutationAllowed(request, activeSession);
      const body = await jsonBody(request, MAX_API_BODY);
      fields(body, ['confirmProduction'], 'cancellation');
      if (body.confirmProduction !== undefined && typeof body.confirmProduction !== 'boolean') {
        throw new DeploymentError('confirmProduction must be boolean.');
      }
      const job = engine.get(parts[1]);
      // Check terminal state before requiring production confirmation: an
      // already-finished job is refused for that reason regardless of target
      // or confirmation, so callers never need a second round trip just to
      // learn a completed job cannot be cancelled.
      if (TERMINAL_STATES.has(job.state)) throw new DeploymentError('This deployment has already finished.', 409, 'job_finished');
      if (job.target === 'prod' && body.confirmProduction !== true) {
        throw new DeploymentError('Explicit production cancellation confirmation is required.');
      }
      return reply(response, 200, { ok: true, job: await engine.cancel(parts[1]) });
    }
    if (parts.length === 1 && parts[0] === 'targets' && method === 'GET') {
      return reply(response, 200, { ok: true, targets: engine.targetList() });
    }
    if (parts.length === 3 && parts[0] === 'targets' && method === 'PUT') {
      requireMutationAllowed(request, activeSession);
      // Only pause/timeout policy is mutable here; execution identities, adapters
      // and resource-name bindings are enforced immutable by policy.js/engine.js,
      // which reject any other field before this ever reaches storage.
      const target = await engine.updateTarget(parts[1], parts[2], await jsonBody(request, MAX_API_BODY));
      return reply(response, 200, { ok: true, target });
    }
    if (parts.length === 1 && parts[0] === 'settings' && method === 'GET') {
      return reply(response, 200, { ok: true, settings: engine.settings });
    }
    if (parts.length === 1 && parts[0] === 'settings' && method === 'PUT') {
      requireMutationAllowed(request, activeSession);
      const settings = await engine.updateSettings(await jsonBody(request, MAX_API_BODY));
      return reply(response, 200, { ok: true, settings });
    }
    if (parts.length === 1 && parts[0] === 'diagnostics' && method === 'GET') {
      return reply(response, 200, { ok: true, health: {
        ok: !engine.stopping, service: SERVICE_NAME, apiVersion: API_VERSION,
        ready: !engine.stopping, running: engine.active.size, queued: engine.queue.length,
      } });
    }
    throw new DeploymentError('Deployment console endpoint not found', 404, 'not_found');
  }

  async function apiRoute(apiPath, request, response, url) {
    const activeSession = session(request);
    if (!activeSession) {
      request.resume();
      reply(response, 401, { ok: false, error: 'Sign in to the deployment console to continue.', code: 'unauthorized' });
      return;
    }
    await apiDispatch(apiPath, request, response, url, activeSession);
  }

  async function loginRoute(request, response, url) {
    const query = consoleSelectorQuery(url.searchParams);
    const destination = `${basePath}/${query ? `?${query}` : ''}`;
    if (session(request)) return sendRedirect(response, 303, destination);
    const method = request.method;
    if (method === 'GET' || method === 'HEAD') {
      const page = renderLogin(200, '', query);
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    if (method !== 'POST') {
      request.resume();
      return reply(response, 405, { ok: false, error: 'Method not allowed', code: 'method_not_allowed' });
    }
    if (request.headers.origin !== origin) {
      request.resume();
      const page = renderLogin(403, 'This console requires a direct, same-origin sign-in request.', query);
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    if (limiter.hit(clientKey(request))) {
      request.resume();
      const page = renderLogin(429, 'Too many sign-in attempts. Wait a few minutes and try again.', query);
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    if (activeLogins >= maxConcurrentLogins) {
      request.resume();
      const page = renderLogin(429, 'The console is busy. Try signing in again shortly.', query);
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    activeLogins += 1;
    try {
      const form = await formBody(request, MAX_LOGIN_BODY);
      const supplied = form.get('token') || '';
      const valid = typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 512
        && crypto.timingSafeEqual(tokenHash, crypto.createHash('sha256').update(supplied).digest());
      if (!valid) {
        const page = renderLogin(401, 'Invalid administrator token.', query);
        return sendHtml(response, page.status, page.html, page.nonce);
      }
      const created = sessions.create();
      if (!created) {
        const page = renderLogin(503, 'Too many active console sessions. Try again shortly.', query);
        return sendHtml(response, page.status, page.html, page.nonce);
      }
      const cookie = serializeSessionCookie({ basePath, value: created.id, maxAgeSeconds: created.maxAgeSeconds });
      return sendRedirect(response, 303, destination, cookie);
    } finally {
      activeLogins -= 1;
    }
  }

  async function logoutRoute(request, response) {
    const activeSession = session(request);
    if (!activeSession) {
      request.resume();
      // Logout is idempotent: a missing/expired session still lands on the
      // sign-in page rather than surfacing a bare JSON error to a plain
      // <form> navigation (this is a real, non-attack path: e.g. a second
      // click, or a tab left open past session expiry).
      return sendRedirect(response, 303, `${basePath}/login`);
    }
    if (request.headers.origin !== origin) {
      request.resume();
      // Reject without destroying the still-valid session. This must not be
      // a redirect that reads as a successful sign-out: a mismatched Origin
      // only occurs from a forged cross-site submission, so the visitor (who
      // is still signed in) is shown an explicit notice that nothing was
      // completed, never a token/session id, with a safe link back.
      const page = renderNotice(403, 'Sign-out not completed',
        'Sign-out was not completed because this request did not come from the console itself. You are still signed in.');
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    const form = await formBody(request, MAX_LOGIN_BODY);
    if (!constantTimeEqual(activeSession.csrfToken, form.get('csrf'))) {
      // Same reasoning as the Origin check above: a bad/missing CSRF token
      // never destroys the session and never looks like a successful logout.
      const page = renderNotice(403, 'Sign-out not completed',
        'Sign-out was not completed because its confirmation token was missing or invalid. You are still signed in.');
      return sendHtml(response, page.status, page.html, page.nonce);
    }
    sessions.destroy(activeSession.id);
    const cookie = serializeSessionCookie({ basePath, value: '', maxAgeSeconds: 0 });
    return sendRedirect(response, 303, `${basePath}/login`, cookie);
  }

  async function consoleRoute(request, response, url) {
    const query = consoleSelectorQuery(url.searchParams);
    const activeSession = session(request);
    if (!activeSession) return sendRedirect(response, 303, `${basePath}/login${query ? `?${query}` : ''}`);
    const page = renderConsole(activeSession);
    return sendHtml(response, 200, page.html, page.nonce);
  }

  async function web(request, response) {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { return false; }
    const pathname = url.pathname;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;
    const sub = pathname === basePath ? '/' : pathname.slice(basePath.length) || '/';
    try {
      if (sub === API_PREFIX || sub.startsWith(`${API_PREFIX}/`)) {
        await apiRoute(sub.slice(API_PREFIX.length) || '/', request, response, url);
      } else if (sub === '/login') {
        await loginRoute(request, response, url);
      } else if (sub === '/logout' && request.method === 'POST') {
        await logoutRoute(request, response);
      } else if (sub === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        await consoleRoute(request, response, url);
      } else {
        request.resume();
        reply(response, 404, { ok: false, error: 'Deployment console endpoint not found', code: 'not_found' });
      }
    } catch (error) {
      request.resume();
      if (!response.headersSent && !response.destroyed) {
        const known = error instanceof DeploymentError;
        reply(response, known ? error.statusCode : 500, {
          ok: false, error: known ? error.message : 'Deployment console operation failed.',
          code: known ? error.code : 'console_error',
        });
      }
    }
    return true;
  }

  web.close = () => { sessions.clear(); };
  return web;
}
