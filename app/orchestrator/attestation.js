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

import crypto from 'crypto';

import {
  SCHEMA_VERSION, PROVENANCE_SCHEMA_VERSION, Provenance, weakerProvenance, AuthMode,
  ATTESTATION_CONTRACT_VERSION, ARGV_BUILDER_ID, Effort, CodingBackend, PATTERNS,
  VERIFICATION_NONCE_LENGTH,
} from './contract.js';

/** The one source key claude-code is recorded as reporting the resolved model from. */
const MODEL_SOURCE_KEY = 'init.model';

/**
 * What a coding CLI must provide before ProjectWorkbench can attest effective effort.
 *
 * Surfaced to operators verbatim, because "the job is blocked" is only actionable alongside "and
 * here is what would unblock it".
 */
export const EFFORT_ATTESTATION_REQUIREMENT =
  'Runtime-reported effort requires a coding CLI that reports the effort in force for the running '
  + 'session — an `effort`, `effortLevel` or `reasoning_effort` field on the stream-json '
  + '`system/init` event, or an equivalent status command. Claude Code 2.1.220 reports the active '
  + 'model and permission mode but no effort. Where the CLI instead *declares* the option and its '
  + 'permitted values in --help, ProjectWorkbench can enforce the value at launch and report '
  + 'provenance launch_enforced (schema 1.1) — which states what was passed to a fingerprinted '
  + 'binary that accepted it, not what the model then did. A 1.0 peer cannot express that '
  + 'distinction and is told the setting is not effective.';

/** Preconditions for claiming a setting was enforced at launch. All must hold; each is reported. */
export const LaunchEnforcementFailure = Object.freeze({
  NO_FINGERPRINT: 'no_fingerprint',
  OPTION_NOT_DECLARED: 'option_not_declared',
  VALUE_NOT_DECLARED: 'value_not_declared',
  OPTION_IGNORED: 'option_ignored',
  ARGV_NOT_OWNED: 'argv_not_owned',
  NOT_BOUND: 'not_bound',
});

/**
 * Shortest usable model-id prefix. Anything shorter is a wildcard in disguise: `"*"` or `"c*"` would
 * verify every id a vendor could ever return.
 */
const MIN_PATTERN_PREFIX = 6;

/** Init-event fields a CLI might use to report effective effort. Checked in order. */
const EFFORT_FIELDS = ['effort', 'effortLevel', 'reasoning_effort', 'effort_level'];

/**
 * What each backend is *recorded* as able to report at runtime, and from which source key.
 *
 * This mirrors the orchestrator's own `RUNTIME_REPORTABLE`, and the mirroring is the point: a
 * `runtime_reported` label is only worth anything if the party being told already knows the backend
 * can report the field. Otherwise the strong claim costs one self-consistent JSON object whose only
 * checked value is supplied by the same peer in the same payload — strictly cheaper than
 * `launch_enforced` and strictly stronger, which inverts the whole contract.
 *
 * For `claude-code` there is exactly one entry. Claude Code 2.1.220 reports the resolved model in
 * its init event and says nothing whatsoever about effort, so effort rests on the launch record and
 * a payload claiming otherwise is refused on the other side.
 *
 * **If a CLI later reports effort, this table is not where it starts.** The orchestrator records the
 * new capability first; only then may this side claim it. That order is deliberate — a peer that can
 * extend its own table has decided unilaterally that its own word is now stronger, which is the
 * bypass the two words exist to prevent. Adding an entry here before the orchestrator has one simply
 * strands every job.
 */
export const RUNTIME_REPORTABLE = Object.freeze({
  'claude-code': Object.freeze({ model_alias: Object.freeze([MODEL_SOURCE_KEY]) }),
  // `codex-cli` is deliberately absent. It was here asserting the same `init.model` source as
  // Claude Code, with no fixture, no documentation and no measurement behind it — a copy-paste in
  // the one table that makes `runtime_reported` checkable rather than self-certifying. A backend
  // with no row cannot have observed anything, which is the correct answer until someone measures
  // it. Adding a row is how that changes, and it is a deliberate act on both sides.
});

/** Whether `backend` is recorded as reporting `field`, from `sourceKey`. Unknown backend → no. */
export function runtimeReportable(backend, field, sourceKey) {
  const sources = RUNTIME_REPORTABLE[backend]?.[field];
  return Array.isArray(sources) && sources.includes(sourceKey);
}

/**
 * Keys the orchestrator's `Slug` will hold: no slashes, no spaces, 100 characters, and a bounded
 * map. An operator's configured option list is not validated by the contract until it is already on
 * the wire, so a mistake there must drop the entry rather than produce a payload that is refused
 * outright and strands every job on that instance.
 */
const CONTRACT_SLUG = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_LIST_ITEMS = 50;

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
      verified: false, outcome: 'unverifiable', observed, field,
      reason: `the session reported an effort outside the contract vocabulary: '${observed}'`,
    };
  }
  if (observed !== requestedEffort) {
    return {
      verified: false, outcome: 'mismatch', observed, field,
      reason: `the session is running at '${observed}' effort, not '${requestedEffort}'`,
    };
  }
  // `field` travels with the result because a runtime claim has to name the source it came from,
  // and that name is checked against what the backend is recorded as emitting.
  return { verified: true, outcome: 'verified', observed, field, reason: null, provenance: Provenance.RUNTIME_REPORTED };
}

/**
 * Attest a setting ProjectWorkbench enforced at launch.
 *
 * This is deliberately hard to satisfy, because the claim is weaker than an observation and must not
 * be mistaken for one. Every condition below is a way the claim could be false:
 *
 *   * the binary must be the exact configured one, fingerprinted — otherwise "we launched it with
 *     this flag" names no particular program;
 *   * that binary's own `--help` must declare the option *and* list the value — a flag a program
 *     does not know about is not enforcement, and Claude Code accepts an unknown --effort value
 *     silently;
 *   * the run must not have warned that it ignored the option;
 *   * the argv must have come from the fixed server-side builder, never from a caller;
 *   * and the evidence must be bound to this session, this run and this configuration generation,
 *     so it cannot be replayed from an earlier, differently configured launch.
 */
export function attestLaunchEnforced({
  option, value, fingerprint, stderr = '', argvOwnedByServer, binding,
}) {
  const fail = (failure, reason) => ({
    verified: false, outcome: failure, observed: null, reason, provenance: Provenance.UNAVAILABLE,
  });

  if (!argvOwnedByServer) {
    return fail(LaunchEnforcementFailure.ARGV_NOT_OWNED,
      'the launch arguments were not built solely by ProjectWorkbench');
  }
  if (!fingerprint?.ok) {
    return fail(LaunchEnforcementFailure.NO_FINGERPRINT,
      `the coding CLI could not be fingerprinted (${fingerprint?.failure ?? 'unknown'})`);
  }
  const capability = fingerprint.capabilities?.[option];
  if (!capability?.declared) {
    return fail(LaunchEnforcementFailure.OPTION_NOT_DECLARED,
      `the coding CLI does not declare ${option}`);
  }
  if (!Array.isArray(capability.values) || !capability.values.includes(value)) {
    // Claude Code accepts an unrecognised --effort value with only a stderr warning and runs at its
    // default, so "the option exists" is not enough — the *value* has to be one it declares.
    return fail(LaunchEnforcementFailure.VALUE_NOT_DECLARED,
      `the coding CLI does not declare '${value}' as a permitted value for ${option}`);
  }
  const warning = extractIgnoredOptionWarning(stderr, option);
  if (warning) {
    return fail(LaunchEnforcementFailure.OPTION_IGNORED, warning);
  }
  if (!bindingIsUsable(binding)) {
    return fail(LaunchEnforcementFailure.NOT_BOUND,
      'the caller did not bind its request to a run with a fresh verification nonce');
  }
  if (binding.auth_mode !== AuthMode.SUBSCRIPTION) {
    return fail(LaunchEnforcementFailure.NOT_BOUND,
      'launch enforcement requires a subscription-authenticated backend');
  }

  return { verified: true, outcome: 'enforced', observed: value, reason: null, provenance: Provenance.LAUNCH_ENFORCED };
}

/** A backend that says it ignored the flag has already told us the enforcement did not happen. */
export function extractIgnoredOptionWarning(stderr, option) {
  const text = String(stderr ?? '');
  const patterns = [
    new RegExp(`unknown ${option.replace(/^-+/, '--')} value[^\\n]*`, 'i'),
    new RegExp(`ignoring[^\\n]*${option.replace(/^-+/, '')}[^\\n]*`, 'i'),
    new RegExp(`${option}[^\\n]*\\bignor(?:ed|ing)\\b[^\\n]*`, 'i'),
    /unsupported option[^\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0].trim().slice(0, 200);
  }
  return null;
}

/** Subscription or API key — named so it can be refused rather than silently accepted. */
export function authModeOf(init) {
  return init?.apiKeySource === 'none' ? AuthMode.SUBSCRIPTION : AuthMode.API_KEY;
}

/** Stable digest of a structure, used for the capability and argv fingerprints. */
function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The digest an administrator records for this instance's binary, and which every claim is compared
 * against. Covers the advertised surface as well as the content: a rebuilt binary that advertises a
 * different option set is not the binary the record was made about.
 */
export function capabilityFingerprint(fingerprint) {
  return digest({
    realpath: fingerprint.realpath,
    version: fingerprint.version,
    sha256: fingerprint.sha256,
    capabilities: fingerprint.capabilities,
  });
}

/**
 * The `LaunchAttestation` the orchestrator's contract defines.
 *
 * Every field is something the orchestrator cannot check for itself — it does not run the binary.
 * The value of the record is that a named party puts its name to each claim, and the contract's own
 * validator refuses the lot if any is missing. Note the two hostile defaults on that side:
 * `caller_controlled_argv` defaults to true and `auth_mode` to `api_key`, so a payload that omits
 * them fails closed rather than reading as safe.
 */
export function buildLaunchAttestation({
  instanceId, fingerprint, argv, binding, stderr = '', authMode,
}) {
  const advertisedOptions = Object.keys(fingerprint.capabilities ?? {})
    .filter((option) => fingerprint.capabilities[option]?.declared)
    // Bounded and slug-safe: these keys are typed on the other side, and a payload the contract
    // refuses outright would strand every job rather than dropping one misconfigured option.
    .filter((option) => CONTRACT_SLUG.test(option))
    .slice(0, MAX_LIST_ITEMS);
  const advertisedValues = {};
  for (const option of advertisedOptions) {
    const values = fingerprint.capabilities[option]?.values;
    if (Array.isArray(values)) advertisedValues[option] = values.slice(0, MAX_LIST_ITEMS);
  }

  return {
    schema_version: SCHEMA_VERSION,
    // The binary identity is NOT here. It moved to the envelope, because every claim is a claim
    // about a specific program: with it under this branch, a peer skipped the entire
    // binary-identity check — and the administrator's may_attest_launch decision with it — by
    // declaring both fields observed, which is *more*, not less.
    advertised_options: advertisedOptions,
    advertised_values: advertisedValues,
    argv_builder_id: ARGV_BUILDER_ID,
    argv_digest: digest(argv),
    // False, and it has to be: if a caller could put anything on the command line, the digest would
    // attest to the caller's intent rather than to policy.
    caller_controlled_argv: false,
    ignored_option_warning: extractIgnoredOptionWarning(stderr, '--effort'),
  };
}

/**
 * Who is speaking, under what authentication, about which run.
 *
 * Required for *every* claim, not just an enforced one. That is the correction the envelope exists
 * to make: with identity, auth and binding living inside the launch record, a peer that declared
 * both fields `runtime_reported` skipped all of them and got the *stronger* provenance for free —
 * the checks were opt-in by the party being checked.
 */
export function buildAttestationEnvelope({ instanceId, binding, authMode, fingerprint }) {
  // Refused, not crashed. There is no envelope — and therefore no claim of any provenance — about a
  // binary that could not be identified, and a caller that omits it should be told which rule it
  // broke rather than reading a TypeError off a property access.
  if (!fingerprint?.ok) {
    throw new Error('an attestation envelope requires a successful binary fingerprint: every claim is a claim about a specific program');
  }
  return {
    schema_version: SCHEMA_VERSION,
    attested_by: instanceId,
    // Which program is speaking. "The backend emitted sonnet" says nothing if the party being told
    // has no record of which backend that is, or if its fingerprint has moved since the record was
    // made — so this is required of every claim, whatever provenance it carries.
    binary_path: fingerprint.realpath.slice(0, 200),
    binary_version: fingerprint.version.slice(0, 200),
    // A digest of the advertised capability *surface*, not merely of the file: if what the binary
    // advertises moves, the binary that advertised the option is not the binary that ran.
    capability_fingerprint: capabilityFingerprint(fingerprint),
    session_key: binding.session_key,
    run_id: binding.run_id,
    // The nonce the orchestrator asked with, so a good answer cannot be replayed onto a later
    // verification of the same job — including after the lane was relaunched with different flags.
    verification_nonce: binding.verification_nonce,
    config_generation: binding.config_generation,
    auth_mode: authMode,
    attested_at: binding.at,
    contract_version: ATTESTATION_CONTRACT_VERSION,
  };
}

/** The default nonce means "the caller did not supply a fresh one". */
export const UNBOUND_NONCE = '0'.repeat(32);

/**
 * Whether a binding is complete enough to attest anything at all.
 *
 * Applies to both provenance labels now: an unbound answer is replayable, and a replayable answer
 * about a session that has since been relaunched is not evidence about the run being asked about.
 */
export function bindingIsUsable(binding) {
  if (!binding?.session_key || !binding?.run_id) return false;
  if (binding.run_id === 'unbound') return false;
  if (!Number.isInteger(binding.config_generation) || binding.config_generation < 0) return false;
  const nonce = binding.verification_nonce;
  if (typeof nonce !== 'string') return false;
  if (nonce.length < VERIFICATION_NONCE_LENGTH.min || nonce.length > VERIFICATION_NONCE_LENGTH.max) return false;
  // The alphabet, not merely the length. The envelope constrains it because a non-ASCII value
  // reaching `hmac.compare_digest` raises TypeError on the far side — an exception that escaped
  // every handler and stranded the job mid-verification. This side echoes the caller's nonce, so
  // refusing what it cannot legally echo is what stops it becoming the source of that failure.
  if (!PATTERNS.verificationNonce.test(nonce)) return false;
  if (nonce === UNBOUND_NONCE) return false;
  return true;
}

export function buildAttestation({
  requested, aliases, init, stderr = '',
  fingerprint = null, argvOwnedByServer = false, binding = null,
  instanceId = null, argv = [], probedAuthMode = null,
  backend = CodingBackend.CLAUDE_CODE,
}) {
  // A trustworthy fingerprint is a precondition for BOTH labels, not just the weaker one. Without
  // this the apparatus was one-sided: seven checks fenced `launch_enforced`, while `runtime_reported`
  // — the STRONGER label — cost a hostile or substituted backend one extra JSON field. "The backend
  // said so" is only worth anything once we know which backend.
  const identified = Boolean(fingerprint?.ok);
  // The envelope's checks apply to every claim. An unbound answer cannot be attributed to the run
  // being asked about, whichever way its values were learned.
  const bound = bindingIsUsable(binding);

  const model = attestModel({
    requestedAlias: requested.model_alias, observedModel: init?.model, aliases,
  });
  if (!identified || !bound) {
    model.verified = false;
    model.reason = model.reason ?? (identified
      ? 'the caller did not bind its request to a run with a fresh verification nonce'
      : `the coding CLI could not be fingerprinted (${fingerprint?.failure ?? 'unknown'}), so nothing it reports can be attributed`);
  }
  // …and the observation is only *labelled* one if the orchestrator knows this backend emits the
  // field from this source. A backend it has no record of gets no runtime claim, however plausible
  // the value looks: the point of the label is that the party being told can check it.
  if (model.verified && !runtimeReportable(backend, 'model_alias', MODEL_SOURCE_KEY)) {
    model.verified = false;
    model.reason = `${backend} is not recorded as reporting the resolved model, so its word cannot be checked`;
  }
  model.provenance = model.verified ? Provenance.RUNTIME_REPORTED : Provenance.UNAVAILABLE;

  let effort = attestEffort({ requestedEffort: requested.effort, init, stderr });
  // An observation this backend is not recorded as being able to make cannot carry the claim — but
  // it is still evidence, and a *contradicting* one still refutes. So only a clean, matching
  // observation is converted; `mismatch` and `ignored` keep their outcome and go on to block.
  if (effort.verified && !runtimeReportable(backend, 'effort', `init.${effort.field}`)) {
    effort = {
      ...effort,
      verified: false,
      outcome: 'unavailable',
      provenance: Provenance.UNAVAILABLE,
      reason: `${backend} is not recorded as reporting the effort in force, so a value it prints cannot be attested as observed`,
    };
  }
  if (!identified || !bound) {
    effort = {
      ...effort,
      verified: false,
      provenance: Provenance.UNAVAILABLE,
      reason: identified
        ? 'the caller did not bind its request to a run with a fresh verification nonce'
        : 'the coding CLI could not be fingerprinted, so nothing it reports can be attributed',
    };
  }
  // `unverifiable` also falls through to enforcement: a backend printing a nonsense effort would
  // otherwise suppress the fallback and block the job — a denial of service by malformed output.
  if (!effort.verified && ['unavailable', 'unverifiable'].includes(effort.outcome)) {
    const enforced = attestLaunchEnforced({
      option: '--effort', value: requested.effort, fingerprint, stderr, argvOwnedByServer,
      binding: { ...binding, auth_mode: authModeOf(init) },
    });
    if (enforced.verified) {
      effort = enforced;
    } else {
      // Keep the runtime explanation — the CLI genuinely does not report effort — but say why the
      // fallback did not apply either. Without both halves an operator sees "not reported" and has
      // no idea that enforcement was attempted and refused, or on what grounds.
      effort = {
        ...effort,
        reason: `${effort.reason}; and it could not be enforced at launch: ${enforced.reason}`,
        enforcement_failure: enforced.outcome,
      };
    }
  }

  // `apiKeySource` is reported in the init event; "none" is the subscription case. Anything else
  // means inference is billed to an API account, which the product forbids — and the contract's
  // AuthMethod enum has no member that could even express it.
  const apiKeySource = typeof init?.apiKeySource === 'string' ? init.apiKeySource : null;
  // Absence is NOT assent. A build that stopped emitting the field would otherwise let an
  // API-billed session attest, which is fail-open inside the one module whose thesis is fail-closed
  // on absence.
  // The init event's own word, cross-checked against an INDEPENDENT probe when one was taken. A
  // backend that prints `apiKeySource: none` while running on an API key would otherwise authenticate
  // itself by assertion.
  const claimsSubscription = apiKeySource === 'none';
  const subscriptionBacked = claimsSubscription
    && (probedAuthMode === null || probedAuthMode === AuthMode.SUBSCRIPTION);

  const reasons = [];
  if (!subscriptionBacked) {
    reasons.push(apiKeySource === null
      ? 'the session did not report its authentication source'
      : 'the session is not subscription authenticated');
  }
  if (!model.verified) reasons.push(model.reason);
  if (!effort.verified) reasons.push(effort.reason);

  const attested = subscriptionBacked && model.verified && effort.verified;

  // No separate disclosure gate: the contract itself carries provenance, so there is no shape in
  // which an enforcement can be mistaken for an observation. A peer that fails to bind its request
  // simply gets no launch attestation, and therefore no effective settings.
  const disclosable = attested;

  return {
    // The contract vocabulary, not the vendor id: the orchestrator asked for an alias and compares
    // against the alias it asked for.
    effective: disclosable
      ? { schema_version: SCHEMA_VERSION, model_alias: requested.model_alias, effort: effort.observed }
      : null,
    blocking: !disclosable,
    // The provenance of each half, published rather than flattened away. `attested` records that
    // ProjectWorkbench itself is satisfied even when the answer is withheld from an old peer, so an
    // operator can tell "not attested" from "not disclosable to this caller".
    attested,
    provenance: {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      model: model.provenance,
      effort: effort.provenance ?? Provenance.UNAVAILABLE,
      // A record is described by its weakest field. Describing it by the strongest would let the
      // observed model launder an effort nobody observed.
      weakest: weakerProvenance(model.provenance, effort.provenance ?? Provenance.UNAVAILABLE),
    },
    // The `SettingsAttestation` the orchestrator's contract defines, or null. Its validator refuses
    // a record carrying an UNAVAILABLE field outright — "omit the attestation entirely so the caller
    // fails closed rather than reading a partial one as partial trust" — so it is only built when
    // both halves are established.
    settings_attestation: attested && instanceId
      ? {
        schema_version: SCHEMA_VERSION,
        effective: { schema_version: SCHEMA_VERSION, model_alias: requested.model_alias, effort: effort.observed },
        model_provenance: model.provenance,
        effort_provenance: effort.provenance,
        envelope: buildAttestationEnvelope({
          instanceId, binding, authMode: authModeOf(init), fingerprint,
        }),
        launch: effort.provenance === Provenance.LAUNCH_ENFORCED || model.provenance === Provenance.LAUNCH_ENFORCED
          ? buildLaunchAttestation({ instanceId, fingerprint, argv, stderr, binding, authMode: authModeOf(init) })
          : null,
        // One structured entry per runtime_reported field, naming the source it came from and the
        // value that source produced. Free text was not evidence: the validator could only ask
        // whether the list was non-empty, which made the STRONGER claim the cheaper one.
        // Per field, and only for a source the backend is recorded as emitting from — an entry
        // naming a key the orchestrator does not know is refused there. The per-field shape matters
        // too: one entry used to satisfy the check for both, so a peer could claim to have observed
        // effort while only ever showing its working for the model.
        normalization: [
          ...(model.provenance === Provenance.RUNTIME_REPORTED ? [{
            schema_version: SCHEMA_VERSION,
            field: 'model_alias',
            source_key: MODEL_SOURCE_KEY,
            raw_value: model.observed,
            value: requested.model_alias,
          }] : []),
          ...(effort.provenance === Provenance.RUNTIME_REPORTED ? [{
            schema_version: SCHEMA_VERSION,
            field: 'effort',
            source_key: `init.${effort.field}`,
            raw_value: effort.observed,
            value: effort.observed,
          }] : []),
        ],
      }
      : null,
    model,
    effort,
    observed_model: model.observed,
    api_key_source: apiKeySource,
    cli_version: typeof init?.claude_code_version === 'string' ? init.claude_code_version : null,
    detail: disclosable ? null : reasons.filter(Boolean).join('; ').slice(0, 200),
    // Surfaced separately so an operator sees the actionable requirement rather than only a refusal.
    requirement: effort.outcome === 'unavailable' ? EFFORT_ATTESTATION_REQUIREMENT : null,
  };
}
