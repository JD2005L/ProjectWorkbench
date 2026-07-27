// Model and effort attestation (contract §6).
//
// The contract's rule is that ProjectWorkbench reports what is *actually* active and can say "I do
// not know", with no way to say "probably correct". An earlier implementation failed that rule in
// the worst possible way — it looked like a check and was not one:
//
//   * the engine compared only effort, never the model; and
//   * in the one mode where a job could run, the "effective" effort was copied from the request,
//     making the comparison `requested === requested`.
//
// This module exists so the comparison cannot be written that way again. Nothing here ever returns
// a value taken from the request. Every field of `effective` comes from an observation, and if an
// observation is missing the answer is `null` — which blocks the job.
//
// The design is grounded in what the installed CLI actually does. Probing Claude Code 2.1.220:
//
//   --model sonnet  ->  init.model = "claude-sonnet-5"
//   --model haiku   ->  init.model = "claude-haiku-4-5-20251001"
//   --model opus    ->  init.model = "claude-opus-5"
//
// so an alias never equals what comes back, and comparison must go through an explicit mapping.
// Meanwhile the init event carries no effort field of any kind, and an unrecognised `--effort` is
// silently ignored (warning on stderr, exit 0, running at the default). Effort is therefore not
// attestable, and this module says so rather than inventing a value.

import { SCHEMA_VERSION, Effort } from './contract.js';

/**
 * What a coding CLI must provide before ProjectWorkbench can attest effective effort.
 *
 * Surfaced to operators verbatim, because "the job is blocked" is only actionable alongside "and
 * here is what would unblock it".
 */
export const EFFORT_ATTESTATION_REQUIREMENT =
  'Effective effort can only be attested by a coding CLI that reports the effort actually in force '
  + 'for the running session — as an `effort`, `effortLevel`, or `reasoning_effort` field on the '
  + 'stream-json `system/init` event, or via an equivalent status command. Claude Code 2.1.220 '
  + 'reports the active model and permission mode but no effort, and silently ignores an '
  + 'unrecognised --effort value, so effort cannot be attested against it and jobs will block at '
  + 'blocked_configuration. Passing the flag is not attestation: it is the assumption the contract '
  + 'exists to forbid.';

/**
 * Shortest usable model-id prefix. Anything shorter is a wildcard in disguise: `"*"` or `"c*"` would
 * verify every id a vendor could ever return.
 */
const MIN_PATTERN_PREFIX = 6;

/** Init-event fields a CLI might use to report effective effort. Checked in order. */
const EFFORT_FIELDS = ['effort', 'effortLevel', 'reasoning_effort', 'effort_level'];

const VALID_EFFORTS = new Set(Object.values(Effort));

/**
 * Alias → the concrete model ids that alias may legitimately resolve to.
 *
 * A trailing `*` matches a longer id with that exact prefix, which is how a dated release
 * (`claude-haiku-4-5-20251001`) is covered without the mapping becoming a wildcard. Recorded from
 * the installed CLI rather than guessed.
 */
export const DEFAULT_MODEL_ALIASES = Object.freeze(new Map([
  ['sonnet', Object.freeze(['claude-sonnet-5*'])],
  ['opus', Object.freeze(['claude-opus-5*'])],
  ['haiku', Object.freeze(['claude-haiku-4-5*'])],
  ['fable', Object.freeze(['claude-fable-5*'])],
]));

/**
 * Parse an operator-supplied alias mapping.
 *
 * Anything malformed yields an *empty* map, never a partial or permissive one: a configuration
 * mistake must make attestation fail, not succeed by accident.
 */
export function parseModelAliases(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_MODEL_ALIASES;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();

  const out = new Map();
  for (const [alias, targets] of Object.entries(parsed)) {
    if (!alias || typeof alias !== 'string') continue;
    if (!Array.isArray(targets) || targets.length === 0) continue;
    // A pattern whose prefix is empty or near-empty is a wildcard, and a wildcard verifies
    // anything — including a silent downgrade to a cheaper model. The module's whole thesis is that
    // a configuration mistake must make attestation fail, not succeed by accident, so such a
    // pattern is dropped rather than honoured.
    const cleaned = targets.filter((t) => {
      if (typeof t !== 'string') return false;
      const prefix = t.endsWith('*') ? t.slice(0, -1) : t;
      return prefix.length >= MIN_PATTERN_PREFIX;
    });
    if (cleaned.length) out.set(alias, Object.freeze(cleaned));
  }
  return out;
}

function matchesPattern(observed, pattern) {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    // A prefix must be a *strict* prefix of something longer, or an exact match — never a
    // substring, and never satisfied by a shorter value.
    return observed === prefix || observed.startsWith(prefix);
  }
  return observed === pattern;
}

/**
 * Attest that the session is running the model that was requested.
 *
 * Note what is absent: there is no branch in which `requestedAlias` is compared to itself. An alias
 * echoed back is not evidence that it resolved to anything, and an alias with no configured mapping
 * is `unverifiable` rather than assumed good.
 */
export function attestModel({ requestedAlias, observedModel, aliases }) {
  if (typeof observedModel !== 'string' || observedModel.length === 0) {
    return { verified: false, outcome: 'unverifiable', observed: null, reason: 'the session reported no model' };
  }

  const map = aliases instanceof Map ? aliases : new Map();
  const patterns = map.get(requestedAlias);

  if (!patterns) {
    // No self-attestation branch. An earlier version let a "concrete id" verify against itself,
    // which is the alias-compared-to-itself hole in another shape: an echoed string is not an
    // observation. If an operator wants to request a concrete id, they map it explicitly.
    return {
      verified: false,
      outcome: 'unverifiable',
      observed: observedModel,
      reason: `no configured mapping for model alias '${requestedAlias}'`,
    };
  }

  if (patterns.some((pattern) => matchesPattern(observedModel, pattern))) {
    return { verified: true, outcome: 'verified', observed: observedModel, reason: null };
  }
  return {
    verified: false,
    outcome: 'mismatch',
    observed: observedModel,
    reason: `the session is running '${observedModel}', which the mapping for '${requestedAlias}' does not cover`,
  };
}

/**
 * Attest the effort actually in force.
 *
 * With a CLI that does not report it, the outcome is `unavailable` — a capability statement, not a
 * transient failure. The distinction matters to an operator: `unavailable` means no amount of
 * retrying will help and the requirement above must be met instead.
 */
export function attestEffort({ requestedEffort, init, stderr = '' }) {
  // A warning that the flag was ignored is positive evidence *against* attestation, and outranks
  // any value the session might also report.
  if (/unknown --effort value/i.test(String(stderr))) {
    return {
      verified: false, outcome: 'ignored', observed: null,
      reason: 'the coding CLI reported that it ignored the requested effort',
    };
  }

  const field = EFFORT_FIELDS.find((name) => typeof init?.[name] === 'string' && init[name].length);
  if (!field) {
    return {
      verified: false, outcome: 'unavailable', observed: null,
      reason: 'the coding CLI does not report the effort in force for the session',
    };
  }

  const observed = init[field];
  if (!VALID_EFFORTS.has(observed)) {
    return {
      verified: false, outcome: 'unverifiable', observed,
      reason: `the session reported an effort outside the contract vocabulary: '${observed}'`,
    };
  }
  if (observed !== requestedEffort) {
    return {
      verified: false, outcome: 'mismatch', observed,
      reason: `the session is running at '${observed}' effort, not '${requestedEffort}'`,
    };
  }
  return { verified: true, outcome: 'verified', observed, reason: null };
}

/**
 * Build the combined verdict for a session.
 *
 * `effective` is non-null only when the model is attested, the effort is attested, and the session
 * is subscription-backed. Anything else yields `null` and `blocking: true`, which the engine turns
 * into `blocked_configuration` before a single file is read.
 */
export function buildAttestation({ requested, aliases, init, stderr = '' }) {
  const model = attestModel({
    requestedAlias: requested.model_alias, observedModel: init?.model, aliases,
  });
  const effort = attestEffort({ requestedEffort: requested.effort, init, stderr });

  // `apiKeySource` is reported in the init event; "none" is the subscription case. Anything else
  // means inference is billed to an API account, which the product forbids — and the contract's
  // AuthMethod enum has no member that could even express it.
  const apiKeySource = typeof init?.apiKeySource === 'string' ? init.apiKeySource : null;
  // Absence is NOT assent. A build that stopped emitting the field would otherwise let an
  // API-billed session attest, which is fail-open inside the one module whose thesis is fail-closed
  // on absence.
  const subscriptionBacked = apiKeySource === 'none';

  const reasons = [];
  if (!subscriptionBacked) {
    reasons.push(apiKeySource === null
      ? 'the session did not report its authentication source'
      : 'the session is not subscription authenticated');
  }
  if (!model.verified) reasons.push(model.reason);
  if (!effort.verified) reasons.push(effort.reason);

  const attested = subscriptionBacked && model.verified && effort.verified;

  return {
    // The contract vocabulary, not the vendor id: the orchestrator asked for an alias and compares
    // against the alias it asked for.
    effective: attested
      ? { schema_version: SCHEMA_VERSION, model_alias: requested.model_alias, effort: effort.observed }
      : null,
    blocking: !attested,
    model,
    effort,
    observed_model: model.observed,
    api_key_source: apiKeySource,
    cli_version: typeof init?.claude_code_version === 'string' ? init.claude_code_version : null,
    detail: attested ? null : reasons.filter(Boolean).join('; ').slice(0, 200),
    // Surfaced separately so an operator sees the actionable requirement rather than only a refusal.
    requirement: effort.outcome === 'unavailable' ? EFFORT_ATTESTATION_REQUIREMENT : null,
  };
}
