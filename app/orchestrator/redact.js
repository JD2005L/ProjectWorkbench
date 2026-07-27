// Secret redaction.
//
// ProjectWorkbench holds the raw material — command output, diffs, git remotes, CLI logs — so it is
// the *first* line of redaction, not the last. The orchestrator redacts again on the way in and on
// the way out, but by then a leaked credential has already crossed a service boundary.
//
// The rules below are deliberately conservative in the direction of over-redaction: a mangled log
// excerpt is a cosmetic problem, a leaked token is not. Ordinary evidence text (commands, test
// counts, file names) must survive untouched, which the test suite asserts.

export const REDACTED = '[REDACTED]';

/** Object keys whose *value* is a credential regardless of its shape. */
const SECRET_KEY_RE = /^(.*_)?(secret|token|password|passwd|pwd|api_?key|access_?key|private_?key|credential|authorization|auth|cookie|session_?id|bearer)(_.*)?$/i;

/**
 * Value patterns. Ordering matters: the more specific vendor prefixes run before the generic
 * assignment rule so the replacement text stays informative.
 */
const VALUE_RULES = [
  // PEM private key blocks, including the body. The body is length-bounded so an unterminated
  // BEGIN marker cannot make this quadratic in the number of markers.
  [/-----BEGIN (?:[A-Z ]{0,32} )?PRIVATE KEY-----[\s\S]{0,65536}?-----END (?:[A-Z ]{0,32} )?PRIVATE KEY-----/g, REDACTED],
  // Vendor-prefixed keys and tokens.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // Credentials embedded in a URL: https://user:secret@host/…
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`],
  // Authorization headers of any scheme. Written with bounded, non-adjacent quantifiers: an
  // earlier version had two `\s*` runs separated by an optional group, which backtracks
  // quadratically — 200k spaces took 63 seconds, and this runs on the main event loop.
  [/\b(authorization[ \t]{0,32}[:=][ \t]{0,32})(?:bearer[ \t]+|basic[ \t]+|token[ \t]+)?[^\s]{1,4096}/gi,
    (_m, prefix) => `${prefix}${REDACTED}`],
  // Generic `name = value` assignments where the name says "credential". The name run is bounded
  // on both sides of the keyword so a long string of `token` repeats cannot make matching
  // super-linear.
  [/\b([A-Za-z0-9_.-]{0,64}(?:secret|token|password|passwd|pwd|api_?key|access_?key|private_?key|credential)[A-Za-z0-9_.-]{0,64})([ \t]{0,32}[:=][ \t]{0,32})(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s]{1,4096}))/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`],
];

/**
 * Redact and bound a free-text string.
 *
 * `maxLength` is not cosmetic: an unbounded excerpt is how a whole log file ends up inside an event
 * payload, an error body, or the orchestrator's reasoning context.
 */
export function redactText(text, { maxLength = 4_000 } = {}) {
  if (typeof text !== 'string') return '';

  // Truncate FIRST. Running the rules over the full input and truncating afterwards means the
  // regex cost is driven by the raw size — and `ArtifactStore.write` passes 32 MB of subprocess
  // output. Since this subsystem shares a process with the dashboard, a slow match here stalls
  // every terminal, preview and inbox on the instance.
  const bounded = text.length > maxLength ? text.slice(0, maxLength) : text;

  let out = bounded;
  for (const [pattern, replacement] of VALUE_RULES) {
    out = out.replace(pattern, replacement);
  }
  return text.length > maxLength ? `${out}…[truncated]` : out;
}

/**
 * Walk a structure, redacting string values and blanking any value whose *key* names a credential.
 * Depth- and breadth-bounded so a hostile or runaway structure cannot become a stack overflow.
 */
export function redactDeep(value, { maxLength = 4_000, depth = 0 } = {}) {
  if (depth > 12) return null;
  if (typeof value === 'string') return redactText(value, { maxLength });
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => redactDeep(item, { maxLength, depth: depth + 1 }));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor') continue;
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactDeep(item, { maxLength, depth: depth + 1 });
    }
    return out;
  }
  return null;
}

/**
 * Scan added lines for credential shapes. Used as a publication gate check, where the question is
 * "did this change introduce a secret", not "does this file mention one".
 */
export function scanForSecrets(addedLines) {
  const findings = [];
  // Per-line bound: a minified bundle or a base64 blob on one line would otherwise hand an
  // unbounded string to the matcher once per added line.
  const LINE_LIMIT = 4_000;
  for (const { file, line, text } of addedLines.slice(0, 50_000)) {
    const bounded = String(text ?? '').slice(0, LINE_LIMIT);
    if (redactText(bounded, { maxLength: LINE_LIMIT }) !== bounded) {
      findings.push({ file, line, rule: 'credential-shape' });
    }
  }
  return findings;
}
