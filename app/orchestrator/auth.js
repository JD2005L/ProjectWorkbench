// Scoped service-token authentication for the orchestration API.
//
// This is a machine surface, so the credential model is deliberately unlike the dashboard's. A
// dedicated token per orchestrator instance, stored as a SHA-256 digest rather than a reusable
// secret, carrying an explicit project grant and an explicit scope list. Three consequences follow,
// and each is tested:
//
//   * A dashboard session cookie can never authorise an orchestration call, and a service token can
//     never reach a dashboard route. The two surfaces share no credential material.
//   * Rotation needs no outage: several live tokens are accepted at once, and retiring one is a
//     `disabled` flag rather than a deletion, so the audit trail survives the rotation.
//   * The token's registered `orchestrator_instance_id` must match the one in the payload. A caller
//     cannot present a valid credential and then act as a different orchestrator.

import fs from 'fs';
import crypto from 'crypto';

import { ApiError, unauthenticated, forbiddenScope, projectNotAuthorized } from './errors.js';
import { ErrorCode, PATTERNS } from './contract.js';

/** Operation scopes. A token carries an explicit list; absence is refusal. */
export const SCOPES = Object.freeze({
  JOBS_READ: 'jobs:read',
  JOBS_WRITE: 'jobs:write',
  SESSION_MANAGE: 'session:manage',
  PUBLISH: 'publish',
  // Recording a human decision is its own authority, deliberately separate from jobs:write.
  // ProjectWorkbench cannot verify that a human was involved — it sits at the far end of a
  // machine-to-machine interface. What it can do is refuse to let one credential request work,
  // approve it, and act on that approval. Granting `approve` alongside the others is then a
  // deliberate, visible act rather than a default.
  APPROVE: 'approve',
});

const KNOWN_SCOPES = new Set(Object.values(SCOPES));

/**
 * Load and cache the token file, re-reading it when it changes on disk.
 *
 * Caching on (mtime, size) means an operator can rotate tokens by editing the file — no restart, no
 * redeploy, and no window in which the service is serving with a credential set nobody can see.
 */
export class ServiceTokenStore {
  constructor(tokensPath) {
    this.tokensPath = tokensPath;
    this._cache = { key: null, tokens: [] };
  }

  load() {
    let stat;
    try {
      stat = fs.statSync(this.tokensPath);
    } catch {
      // No token file means no orchestrator may authenticate. Failing closed is the point.
      this._cache = { key: null, tokens: [] };
      return this._cache.tokens;
    }

    const key = `${stat.mtimeMs}:${stat.size}`;
    if (this._cache.key === key) return this._cache.tokens;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
    } catch {
      this._cache = { key, tokens: [] };
      return this._cache.tokens;
    }

    const tokens = (Array.isArray(parsed?.tokens) ? parsed.tokens : [])
      .filter((entry) => entry
        && entry.disabled !== true
        && typeof entry.secret_sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(entry.secret_sha256)
        && typeof entry.orchestrator_instance_id === 'string'
        && PATTERNS.identifier.test(entry.orchestrator_instance_id))
      .map((entry) => Object.freeze({
        token_id: String(entry.token_id ?? 'unnamed'),
        orchestrator_instance_id: entry.orchestrator_instance_id,
        secret_sha256: entry.secret_sha256.toLowerCase(),
        projects: Object.freeze((Array.isArray(entry.projects) ? entry.projects : []).map(String)),
        scopes: Object.freeze((Array.isArray(entry.scopes) ? entry.scopes : []).filter((s) => KNOWN_SCOPES.has(s))),
      }));

    this._cache = { key, tokens: Object.freeze(tokens) };
    return this._cache.tokens;
  }
}

function digest(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/** Compare digests in constant time so a wrong token cannot be discovered byte by byte. */
function digestsMatch(presentedDigest, expectedHex) {
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== presentedDigest.length) return false;
  return crypto.timingSafeEqual(presentedDigest, expected);
}

/** Extract the bearer credential. Any other scheme, or none, is not a credential. */
function bearerFrom(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer[ ]+(\S+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Authenticate a request, returning the matched token record.
 *
 * Every failure produces the identical `unauthenticated` response: an unknown token, a wrong token,
 * a retired token, and a malformed header are indistinguishable to the caller. Distinguishing them
 * would turn the endpoint into an oracle for probing the credential set.
 */
export function authenticateRequest(req, tokenStore) {
  const presented = bearerFrom(req);
  if (!presented) throw unauthenticated();

  const presentedDigest = digest(presented);
  // Every candidate is compared, rather than short-circuiting on the first match, so the work done
  // does not depend on where in the list the matching token sits.
  let matched = null;
  for (const candidate of tokenStore.load()) {
    if (digestsMatch(presentedDigest, candidate.secret_sha256)) matched = candidate;
  }
  if (!matched) throw unauthenticated();
  return matched;
}

/** Require an operation scope. */
export function requireScope(token, scope) {
  if (!token.scopes.includes(scope)) {
    throw forbiddenScope(`this credential does not carry the '${scope}' scope`);
  }
}

/**
 * Require that the payload's claimed orchestrator instance is the one this token is registered to.
 *
 * Without this, a compromised or misconfigured orchestrator could present its own valid credential
 * while acting under another instance's identity — and the fencing tokens, lane ownership, and
 * audit trail would all be attributed to the wrong party.
 */
export function assertInstanceMatches(token, claimedInstanceId) {
  if (claimedInstanceId && claimedInstanceId !== token.orchestrator_instance_id) {
    throw forbiddenScope('the payload claims a different orchestrator instance than this credential');
  }
}

/** Require that this token was granted the project. A grant of `"*"` is not honoured. */
export function assertProjectGranted(token, projectId) {
  if (!token.projects.includes(projectId)) {
    throw projectNotAuthorized();
  }
}

/**
 * Fixed-window rate limiter, keyed per credential.
 *
 * Refusing is correct here rather than queueing: a queued request holds a connection while the
 * caller's own timeout expires, and the orchestrator retries — which is how a slow service turns
 * into an overloaded one.
 */
export class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this._windows = new Map();
  }

  check(key, now = Date.now()) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const entry = this._windows.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this._windows.set(key, { windowStart, count: 1 });
      if (this._windows.size > 10_000) this._prune(windowStart);
      return;
    }
    entry.count += 1;
    if (entry.count > this.perMinute) {
      const retryAfter = Math.ceil((windowStart + 60_000 - now) / 1_000);
      throw new ApiError(ErrorCode.RATE_LIMITED, 'too many requests for this credential', {
        retryAfterSeconds: Math.max(1, retryAfter),
      });
    }
  }

  _prune(currentWindow) {
    for (const [key, entry] of this._windows) {
      if (entry.windowStart !== currentWindow) this._windows.delete(key);
    }
  }
}
