// Session, cookie and rate-limit primitives for the standalone deployment
// console. Deliberately framework-free and HTTP-transport-agnostic so the
// authentication policy (bounded, memory-only, short-lived) can be unit
// tested without a real socket. See standalone-web.js for HTTP wiring.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ds_session';
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/; // RFC 6265 cookie-name token

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Both sides are hashed first so equal-length buffers are always compared,
// which keeps this constant-time even when an attacker supplies a token of
// a different length than the real one (mismatched-length buffers would
// otherwise make crypto.timingSafeEqual throw instead of just failing).
export function constantTimeEqual(expected, supplied) {
  if (typeof expected !== 'string' || !expected || typeof supplied !== 'string' || !supplied || supplied.length > 4096) {
    return false;
  }
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string' || !header || header.length > 8192) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!COOKIE_NAME.test(name)) continue;
    const value = part.slice(index + 1).trim();
    if (value.length > 4096) continue;
    cookies[name] = value;
  }
  return cookies;
}

// maxAgeSeconds <= 0 clears the cookie (used for logout / expiry).
export function serializeSessionCookie({ basePath, value = '', maxAgeSeconds = 0 }) {
  const bounded = Math.max(0, Math.floor(maxAgeSeconds) || 0);
  const parts = [`${SESSION_COOKIE}=${value}`, `Path=${basePath}`, 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${bounded}`];
  if (bounded <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
}

// An in-memory, capacity-bounded session table. No persistence, no clustering:
// a restart signs everyone out, which is acceptable for a short-lived admin
// session and keeps the console's footprint to a single process.
export function createSessionStore({ sessionMinutes = 30, maxSessions = 200, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const ttlMs = Math.round(sessionMinutes * 60000);

  function sweep() {
    const current = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(id);
    }
  }

  return {
    get size() { return sessions.size; },
    sweep,
    create() {
      sweep();
      if (sessions.size >= maxSessions) return null;
      const id = randomToken();
      const csrfToken = randomToken();
      const expiresAt = now() + ttlMs;
      sessions.set(id, { csrfToken, expiresAt });
      return { id, csrfToken, expiresAt, maxAgeSeconds: Math.round(ttlMs / 1000) };
    },
    get(id) {
      if (typeof id !== 'string' || !id || id.length > 200) return null;
      const session = sessions.get(id);
      if (!session) return null;
      if (session.expiresAt <= now()) { sessions.delete(id); return null; }
      return { id, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
    },
    destroy(id) { sessions.delete(id); },
    clear() { sessions.clear(); },
  };
}

// A small fixed-window limiter keyed by remote address. Bounded in both
// attempts-per-window and total tracked keys so it cannot itself become an
// unbounded-memory vector under a distributed flood.
export function createLoginLimiter({ windowMs = 5 * 60000, maxAttempts = 10, maxEntries = 1000, now = () => Date.now() } = {}) {
  const attempts = new Map();

  function prune() {
    const current = now();
    for (const [key, entry] of attempts) {
      if (current - entry.windowStart > windowMs) attempts.delete(key);
    }
    if (attempts.size > maxEntries) {
      const overflow = attempts.size - maxEntries;
      const oldest = [...attempts.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart).slice(0, overflow);
      for (const [key] of oldest) attempts.delete(key);
    }
  }

  return {
    get size() { return attempts.size; },
    // Records one attempt for key and returns true if that key is over budget.
    hit(key) {
      prune();
      const current = now();
      const entry = attempts.get(key);
      if (!entry || current - entry.windowStart > windowMs) {
        attempts.set(key, { count: 1, windowStart: current });
        return false;
      }
      entry.count += 1;
      return entry.count > maxAttempts;
    },
    clear() { attempts.clear(); },
  };
}
