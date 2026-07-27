// The subscription-backed Claude Code runner.
//
// Contract §6 is the reason this file is careful. The rule is that ProjectWorkbench must report what
// is *actually* active and must be able to say "I do not know" — there is deliberately no way to say
// "probably correct". Two things follow from measuring the real CLI (Claude Code 2.1.220) rather
// than assuming:
//
//   * **Model is positively verifiable.** `--output-format stream-json` emits a `system/init` event
//     carrying `model` and `permissionMode`. That is structured output from the running session, not
//     an echoed keystroke, and an unknown `--model` fails the run outright.
//
//   * **Effort is not.** The init event carries no effort, and an unknown `--effort` value is
//     *silently ignored* — the CLI prints a warning to stderr, exits 0, and runs at its default.
//     There is no read-back path at all. So the honest answer is `effective: null`, and that is the
//     default here even though it blocks jobs, because the alternative is reporting a guess and the
//     whole control exists to prevent exactly that. An operator who accepts argv attestation can
//     opt in explicitly, and every such response is labelled `argv-attested` in `detail` so the
//     orchestrator can see what kind of evidence it is holding.
//
// This gap is documented in docs/orchestrator-api.md for coordination with the orchestrator side;
// it was not among the gaps Milestone 1 identified.

import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  SCHEMA_VERSION, PATTERNS, Effort, PhaseClass, CodingBackend, HealthState, AuthMethod,
  AuthMode,
} from '../contract.js';
import { redactText } from '../redact.js';
import { buildAttestation } from '../attestation.js';
import { FingerprintCache } from './fingerprint.js';

const execFileAsync = promisify(execFile);

const VALID_EFFORTS = new Set(Object.values(Effort));

/**
 * Phase class → permission mode. An allowlist, not a parameter.
 *
 * Exploration, planning and review run in `plan`, which cannot write: an "independent review" that
 * could edit the code it is reviewing is not a review. `bypassPermissions` and `dontAsk` appear
 * nowhere and are unreachable by construction.
 */
const PERMISSION_MODE_BY_PHASE = Object.freeze({
  [PhaseClass.DISCOVERY]: 'plan',
  [PhaseClass.PLANNING]: 'plan',
  [PhaseClass.HIGH_RISK_DESIGN]: 'plan',
  [PhaseClass.ROUTINE_REVIEW]: 'plan',
  [PhaseClass.HIGH_RISK_REVIEW]: 'plan',
  [PhaseClass.IMPLEMENTATION]: 'acceptEdits',
  [PhaseClass.MECHANICAL_CORRECTION]: 'acceptEdits',
});

/** Environment variables that would move inference off the subscription and onto API billing. */
const FORBIDDEN_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK',
];

/**
 * Classify a process failure into a distinct kind, so each can reach its own safe state.
 *
 * Lumping these together is how "the job failed" comes to mean nothing: an expired subscription, a
 * usage limit and a crashed process need three different operator responses, and only one of them
 * is worth retrying automatically.
 */
export function classifyBackendFailure(err) {
  if (err?.code === 'ENOENT') return 'unavailable';
  // An abort is a deliberate cancellation, and must be checked BEFORE the kill/SIGTERM cases —
  // aborting execFile terminates the child with SIGTERM, which would otherwise read as a timeout
  // and send the job to a blocked state instead of a cancelled one.
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.kind === 'cancelled') return 'cancelled';
  if (err?.killed || err?.signal === 'SIGTERM') return 'timeout';
  if (err?.signal) return 'process_died';

  const text = `${err?.stderr ?? ''}\n${err?.stdout ?? ''}\n${err?.message ?? ''}`.toLowerCase();
  if (/usage limit|rate limit|429|too many requests|quota/.test(text)) return 'rate_limited';
  if (/invalid api key|please run \/login|oauth|not (logged|signed) in|authentication/.test(text)) return 'auth_expired';
  return 'phase_failed';
}

export class ClaudeCodeBackend {
  constructor({ config, exec = execFileAsync, clock = () => new Date(), fingerprints = null } = {}) {
    this.config = config;
    this.exec = exec;
    this.clock = clock;
    this.name = CodingBackend.CLAUDE_CODE;
    // Cached per binary identity, so the ~1s hash of a 275 MB binary happens once and any change
    // to the file misses the cache rather than being trusted.
    this.fingerprints = fingerprints ?? new FingerprintCache({ exec });
  }

  /** Fingerprint the configured CLI, for enforcement claims and for health reporting. */
  async fingerprint() {
    return this.fingerprints.get({
      executable: this.config.backendExecutable,
      options: ['--effort', '--model'],
      expectedSha256: this.config.backendFingerprintSha256 || null,
    });
  }

  // -------------------------------------------------------------------------
  // argv construction — pure, and the main unit under test
  // -------------------------------------------------------------------------

  buildPhaseArgv({ prompt, model, effort, maxTurns, phaseClass, resumeSessionId = null, sessionId = null }) {
    // The alias pattern alone permits a leading '-', and `--dangerously-skip-permissions` is a
    // perfectly valid "alias" by that rule. execFile uses no shell, so this is not shell injection —
    // it is argv injection, and the CLI's own parser would read it as an option.
    if (typeof model !== 'string' || !PATTERNS.modelAlias.test(model) || model.startsWith('-')) {
      throw new Error(`invalid model alias: ${JSON.stringify(model)}`);
    }
    if (typeof effort !== 'string' || !VALID_EFFORTS.has(effort)) {
      // The contract's Effort enum is the authority, and it now includes `xhigh` — the CLI
      // advertises it, and a policy that cannot name a level the binary supports would silently
      // round down. Anything outside the enum is still refused before it reaches the CLI.
      throw new Error(`invalid effort: ${JSON.stringify(effort)}`);
    }
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 60) {
      throw new Error(`invalid max turns: ${JSON.stringify(maxTurns)}`);
    }
    const permissionMode = PERMISSION_MODE_BY_PHASE[phaseClass];
    if (!permissionMode) throw new Error(`unknown phase class: ${JSON.stringify(phaseClass)}`);

    const argv = [
      '-p', String(prompt),
      '--model', model,
      '--effort', effort,
      '--output-format', 'stream-json',
      // stream-json requires --verbose when used with --print.
      '--verbose',
      '--max-turns', String(maxTurns),
      '--permission-mode', permissionMode,
    ];
    // Model and effort are reapplied above on *every* invocation, resume included. A resumed session
    // must never be assumed to have retained the values it was launched with.
    if (resumeSessionId) argv.push('--resume', resumeSessionId);
    else if (sessionId) argv.push('--session-id', sessionId);
    return argv;
  }

  /** A child environment with every API-billing escape hatch removed. */
  phaseEnv() {
    const env = { ...process.env };
    for (const key of FORBIDDEN_ENV) delete env[key];
    return env;
  }

  // -------------------------------------------------------------------------
  // authentication health
  // -------------------------------------------------------------------------

  /**
   * Probe sign-in status without spending subscription quota.
   *
   * `claude auth status` reports `loggedIn`, `authMethod`, `apiProvider` and `subscriptionType` —
   * and also an email and an org id, which are deliberately *not* propagated: the contract's
   * `account_label` is a label, never an address.
   */
  async probeAuth() {
    const checkedAt = this.clock().toISOString();
    const base = { schema_version: SCHEMA_VERSION, backend: this.name, checked_at: checkedAt };

    let stdout;
    try {
      ({ stdout } = await this.exec(this.config.backendExecutable, ['auth', 'status'], {
        timeout: 15_000, env: this.phaseEnv(),
      }));
    } catch (err) {
      const kind = classifyBackendFailure(err);
      return {
        ...base,
        state: HealthState.DOWN,
        method: AuthMethod.UNKNOWN,
        detail: kind === 'unavailable'
          ? 'the coding CLI is not installed on this instance'
          : 'the coding CLI could not report its authentication status',
        // Inconclusive: not a positive finding of API billing, so it must not override the session's
        // own report either way.
        auth_mode: null,
      };
    }

    let status;
    try {
      status = JSON.parse(stdout);
    } catch {
      return { ...base, state: HealthState.DOWN, method: AuthMethod.UNKNOWN, detail: 'the coding CLI produced unreadable authentication status', auth_mode: null };
    }

    if (!status?.loggedIn) {
      return { ...base, state: HealthState.DOWN, method: AuthMethod.SUBSCRIPTION_OAUTH, detail: 'the coding CLI is signed out', auth_mode: null };
    }

    // Only subscription OAuth against the first-party provider is permitted. An API key or a
    // Bedrock/Vertex provider would move inference onto API billing, which the product forbids —
    // and the contract's AuthMethod enum has no member that could even express it.
    const subscriptionBacked = status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty';
    if (!subscriptionBacked) {
      return {
        ...base,
        state: HealthState.DOWN,
        method: AuthMethod.UNKNOWN,
        detail: 'only subscription-backed sign-in is permitted; this backend is not subscription authenticated',
        // A positive finding: this backend IS API-billed, whatever the session later prints.
        auth_mode: AuthMode.API_KEY,
      };
    }

    const tier = String(status.subscriptionType ?? '').trim();
    return {
      ...base,
      state: HealthState.OK,
      method: AuthMethod.SUBSCRIPTION_OAUTH,
      account_label: tier ? `Claude ${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Claude subscription',
      cli_version: status.version ? String(status.version).slice(0, 200) : null,
      auth_mode: AuthMode.SUBSCRIPTION,
    };
  }

  // -------------------------------------------------------------------------
  // stream-json parsing
  // -------------------------------------------------------------------------

  /**
   * Parse the CLI's newline-delimited JSON.
   *
   * Unparseable output is reported as such rather than treated as an empty success — a run that
   * produced nothing readable has not been observed to do anything, and "no output" is not evidence
   * that the work is done.
   */
  parseStream(stdout) {
    const events = [];
    let sawJson = false;
    for (const line of String(stdout).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
        sawJson = true;
      } catch {
        // A single unparseable line among good ones is CLI chatter, not a protocol failure.
      }
    }
    return {
      sawJson,
      init: events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null,
      result: events.find((e) => e.type === 'result') ?? null,
      rateLimit: events.filter((e) => e.type === 'rate_limit_event').pop() ?? null,
    };
  }

  /** Seconds until a reported rate-limit reset, floored at 1 so a caller never busy-loops. */
  retryAfterFrom(rateLimit) {
    const resetsAt = Number(rateLimit?.rate_limit_info?.resetsAt);
    if (!Number.isFinite(resetsAt)) return 60;
    return Math.max(1, Math.ceil((resetsAt * 1_000 - this.clock().getTime()) / 1_000));
  }

  // -------------------------------------------------------------------------
  // configuration verification
  // -------------------------------------------------------------------------

  /**
   * Report the effective configuration of the lane.
   *
   * Deliberately runs a real, bounded, read-only phase rather than inspecting a config file: what
   * matters is what the *running session* reports, and a file cannot answer that.
   */
  async verifyConfiguration({
    requested, phaseClass = PhaseClass.DISCOVERY, cwd, cliSessionId = null,
    runId = 'unbound', sessionKey = null,
    configGeneration = null, verificationNonce = null,
  }) {
    const argv = this.buildPhaseArgv({
      prompt: 'Reply with exactly: ready',
      model: requested.model_alias,
      effort: requested.effort,
      maxTurns: 1,
      // Verification must never be able to write, whatever phase it is verifying for.
      phaseClass: PhaseClass.DISCOVERY,
      resumeSessionId: cliSessionId,
    });

    // Fingerprint BEFORE launching. Taking it afterwards left a window in which the binary that ran
    // and the binary that was attested need not be the same file.
    const fingerprint = await this.fingerprint();
    const probedAuth = await this.probeAuth().catch(() => null);

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.exec(this.config.backendExecutable, argv, {
        cwd, timeout: Math.min(this.config.backendTimeoutMs, 300_000), env: this.phaseEnv(),
        maxBuffer: 8 * 1024 * 1024,
      }));
    } catch (err) {
      const error = new Error('the coding backend could not be queried');
      error.kind = classifyBackendFailure(err);
      if (error.kind === 'rate_limited') error.retryAfterSeconds = 60;
      throw error;
    }

    const { init } = this.parseStream(stdout);

    // Everything the caller learns comes from `buildAttestation`, which never copies a requested
    // value into its answer. Where the CLI reports a setting the provenance is `runtime_reported`;
    // where ProjectWorkbench could only enforce it at launch the provenance says so, and a peer
    // that cannot express the distinction is told the setting is not effective.
    const attestation = buildAttestation({
      requested, aliases: this.config.modelAliases, init: init ?? {}, stderr,
      fingerprint,
      // Explicit, because this is what decides which runtime claims are permitted at all: the
      // orchestrator's record of what this backend can report is consulted by name.
      backend: this.name,
      instanceId: this.config.instanceId,
      argv,
      // True by construction: buildPhaseArgv is the only argv source and takes no caller argv.
      argvOwnedByServer: true,
      // Only a POSITIVE finding overrides the session's own report. An inconclusive probe leaves
      // the decision to the init event rather than blocking on the probe's inability to answer.
      probedAuthMode: probedAuth?.auth_mode ?? null,
      binding: {
        // Never the backend's own session id: letting the program being attested choose the
        // anti-replay key would let it pick one, and it is unbounded and unvalidated.
        session_key: sessionKey,
        run_id: runId,
        // The caller's generation when it sent one, else this instance's own. Either way the claim
        // is stamped with a generation, so it cannot outlive a configuration change.
        config_generation: Number.isInteger(configGeneration) ? configGeneration : this.config.configGeneration,
        verification_nonce: verificationNonce,
        at: this.clock().toISOString(),
      },
    });

    return {
      effective: attestation.effective,
      observed_model: attestation.observed_model,
      provenance: attestation.provenance,
      settings_attestation: attestation.settings_attestation,
      attestation,
      backend: this.name,
      checked_at: this.clock().toISOString(),
      detail: attestation.detail,
      requirement: attestation.requirement,
      cli_session_id: init?.session_id ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // running a phase
  // -------------------------------------------------------------------------

  /**
   * Run one bounded phase.
   *
   * Returns structured facts. The agent's own summary is carried as `summary` and is explicitly not
   * evidence of anything: whether the work was actually done is decided by the deterministic checks
   * and by git, never by what the model said about itself.
   */
  async runPhase({ prompt, model, effort, maxTurns, phaseClass, cwd, resumeSessionId = null, sessionId = null, timeoutMs = null, signal = null }) {
    const argv = this.buildPhaseArgv({ prompt, model, effort, maxTurns, phaseClass, resumeSessionId, sessionId });
    const permissionMode = PERMISSION_MODE_BY_PHASE[phaseClass];

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.exec(this.config.backendExecutable, argv, {
        cwd,
        timeout: timeoutMs ?? this.config.backendTimeoutMs,
        env: this.phaseEnv(),
        maxBuffer: 32 * 1024 * 1024,
        // Cancellation has to reach the child process. Without this the agent kept editing while
        // the caller waited out the phase budget — up to half an hour by default.
        ...(signal ? { signal } : {}),
      }));
    } catch (err) {
      const kind = classifyBackendFailure(err);
      if (kind === 'cancelled') {
        // Let the caller record the cancellation; this is not a backend failure to be blocked on.
        throw Object.assign(new Error('the phase was cancelled'), { kind: 'cancelled' });
      }
      return {
        ok: false,
        failure_kind: kind,
        retry_after_seconds: kind === 'rate_limited' ? 60 : null,
        session_id: null,
        model: null,
        permission_mode: permissionMode,
        // Bounded hard: an execFile failure message is `Command failed: <full argv>` followed by
        // stderr, and redaction is pattern-based — a secret in an unusual shape would survive.
        summary: redactText(String(err?.message ?? 'the phase failed').split('\n')[0].slice(0, 200), { maxLength: 200 }),
        turns_used: 0,
        max_turns_reached: false,
      };
    }

    const { sawJson, init, result, rateLimit } = this.parseStream(stdout);
    if (!sawJson || !result) {
      return {
        ok: false,
        failure_kind: 'malformed_output',
        retry_after_seconds: null,
        session_id: init?.session_id ?? null,
        model: init?.model ?? null,
        permission_mode: permissionMode,
        summary: 'the coding CLI produced no readable result',
        turns_used: 0,
        max_turns_reached: false,
      };
    }

    const maxTurnsReached = result.subtype === 'error_max_turns';
    const limited = rateLimit && rateLimit.rate_limit_info?.status !== 'allowed';
    const failed = result.is_error === true || maxTurnsReached || limited;

    let failureKind = null;
    if (maxTurnsReached) failureKind = 'max_turns';
    else if (limited) failureKind = 'rate_limited';
    else if (result.is_error === true) failureKind = classifyBackendFailure({ stderr, stdout: result.result ?? '' });

    return {
      ok: !failed,
      failure_kind: failureKind,
      retry_after_seconds: limited ? this.retryAfterFrom(rateLimit) : null,
      session_id: result.session_id ?? init?.session_id ?? null,
      model: init?.model ?? null,
      permission_mode: init?.permissionMode ?? permissionMode,
      // Redacted here, at the point the raw material is first held. The orchestrator redacts again,
      // but by then a leak has already crossed a service boundary.
      summary: redactText(String(result.result ?? ''), { maxLength: 2_000 }),
      turns_used: Number.isInteger(result.num_turns) ? result.num_turns : 0,
      max_turns_reached: maxTurnsReached,
      duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
    };
  }
}
