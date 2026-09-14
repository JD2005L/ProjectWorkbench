// Scoped service-token authentication for the machine API.
//
// This is a machine surface, so the credential model is deliberately unlike the dashboard's —
// it follows app/orchestrator/auth.js rather than the session-cookie model:
//
//   * Tokens are stored as a SHA-256 digest, never as a reusable secret. The plaintext exists
//     once, in the response that creates it. A dashboard admin reading this file later cannot
//     recover a usable credential, so the file is not an exfiltration target the way a
//     plaintext store would be.
//   * A token carries an EXPLICIT scope list; absence is refusal. There is deliberately no
//     "admin" scope — the dashboard's requireAdmin unlocks 29 routes including permission-mode
//     changes and password resets, and a credential that lives on a laptop must not reach them.
//   * Revocation is a `disabled` flag, not a deletion, so the audit trail outlives the token.
//   * A dashboard session can never authorise a machine call and a machine token can never
//     reach a dashboard route: the two surfaces share no credential material.

import fs from 'fs/promises';
import crypto from 'crypto';
import { writeFileAtomic } from './atomic-file.js';

/** Operation scopes. A token carries an explicit list; absence is refusal. */
export const SCOPES = Object.freeze({
  PROJECTS_REGISTER: 'projects:register',
});

const KNOWN_SCOPES = new Set(Object.values(SCOPES));

// Identifiable prefix so a leaked token is greppable in logs and recognisable in a config file.
const TOKEN_PREFIX = 'pwat_';

/**
 * Does this value even have the shape of one of our tokens?
 *
 * Used by the CSRF gate to decide whether a request is a machine call at all, BEFORE any store
 * read. Shape only - it says nothing about validity, and callers must still authorise.
 */
export function looksLikeApiToken(value) {
  return String(value || '').startsWith(TOKEN_PREFIX);
}

export function isKnownScope(scope) {
  return KNOWN_SCOPES.has(String(scope || ''));
}

export function digestToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

/**
 * Mint a new token. Returns { plaintext, record } — the caller must surface `plaintext` exactly
 * once and persist only `record`.
 */
export function mintToken({ label = '', scopes = [], createdBy = '' } = {}) {
  const bad = scopes.filter((s) => !isKnownScope(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.join(', ')}`);
  if (!scopes.length) throw new Error('a token with no scopes can do nothing; refusing to mint one');

  const plaintext = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return {
    plaintext,
    record: {
      id: crypto.randomUUID(),
      label: String(label || '').trim().slice(0, 80),
      digest: digestToken(plaintext),
      scopes: [...new Set(scopes)],
      createdAt: new Date().toISOString(),
      createdBy: String(createdBy || ''),
      lastUsedAt: null,
      disabled: false,
    },
  };
}

export async function loadTokens(tokensPath) {
  try {
    const raw = await fs.readFile(tokensPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

export async function saveTokens(tokensPath, tokens) {
  // 0600: the digests are not directly usable, but the label/scope set still describes the
  // machine surface's authority and does not belong to non-root readers.
  await writeFileAtomic(tokensPath, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
}

/** Metadata safe to render in the dashboard. Never includes the digest. */
export function safeTokenShape(t) {
  return {
    id: t.id,
    label: t.label,
    scopes: t.scopes || [],
    createdAt: t.createdAt || null,
    createdBy: t.createdBy || '',
    lastUsedAt: t.lastUsedAt || null,
    disabled: !!t.disabled,
  };
}

/**
 * Resolve a presented bearer token to its record, or null.
 *
 * Compares DIGESTS with timingSafeEqual. Hashing first also fixes the length-leak that comparing
 * raw secrets of differing length would otherwise have, since every digest is the same width.
 */
export function resolveToken(tokens, presented) {
  const raw = String(presented || '');
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const want = Buffer.from(digestToken(raw), 'hex');
  for (const t of tokens || []) {
    if (t?.disabled || typeof t?.digest !== 'string' || t.digest.length !== want.length * 2) continue;
    const have = Buffer.from(t.digest, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) return t;
  }
  return null;
}

/** Extract a bearer token from a request's Authorization header. */
export function presentedToken(req) {
  const auth = String(req.get?.('authorization') || '');
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

export function tokenHasScope(token, scope) {
  return Array.isArray(token?.scopes) && token.scopes.includes(scope);
}
