// A deterministic coding backend for tests.
//
// Deterministic in the strict sense: no randomness, no wall clock, no network, no OAuth. That is a
// hard requirement rather than a convenience — the test suite must never touch the operator's live
// Claude subscription, and an assertion on an event stream is only meaningful if the same sequence
// of calls always produces the same output.
//
// The fake does not simulate an agent. It exposes explicit controls so a test states the backend
// behaviour it wants (auth expired, rate limited, malformed output, process death, a question
// raised) instead of depending on a hidden heuristic.

import { CodingBackend, HealthState, AuthMethod, SCHEMA_VERSION } from '../contract.js';

export class FakeCodingBackend {
  constructor({ effective = { model_alias: 'sonnet', effort: 'high' }, clock = () => new Date('2026-07-27T12:00:00.000Z') } = {}) {
    this.name = CodingBackend.CLAUDE_CODE;
    this.clock = clock;

    /** Reported effective settings. `null` means "cannot determine", which must block a job. */
    this.effective = effective;
    /** When true, verification mirrors whatever was requested (the correctly configured case). */
    this.mirrorRequested = false;

    // -- failure controls; a test sets these directly --
    this.authExpired = false;
    this.rateLimited = false;
    this.retryAfterSeconds = null;
    this.malformedOutput = false;
    this.processDied = false;
    this.timedOut = false;
    this.unavailable = false;

    /** Scripted phase outcomes, consumed in order. */
    this.phaseResults = [];
    /** Counter behind the synthetic session ids. Deterministic: no randomness, no clock. */
    this._sessionCounter = 0;
    /** Every invocation, in order, so a test can assert what was *not* run and with which flags. */
    this.invocations = [];
  }

  /** Backend authentication health. There is no API-key path to report. */
  async probeAuth() {
    const checkedAt = this.clock().toISOString();
    if (this.unavailable) {
      return {
        schema_version: SCHEMA_VERSION, backend: this.name, state: HealthState.DOWN,
        method: AuthMethod.UNKNOWN, checked_at: checkedAt, detail: 'the coding CLI is not installed',
      };
    }
    if (this.authExpired) {
      return {
        schema_version: SCHEMA_VERSION, backend: this.name, state: HealthState.DOWN,
        method: AuthMethod.SUBSCRIPTION_OAUTH, checked_at: checkedAt,
        detail: 'the subscription session is signed out',
      };
    }
    if (this.rateLimited) {
      return {
        schema_version: SCHEMA_VERSION, backend: this.name, state: HealthState.DEGRADED,
        method: AuthMethod.SUBSCRIPTION_OAUTH, retry_after_seconds: this.retryAfterSeconds ?? 60,
        checked_at: checkedAt, detail: 'a subscription rate limit is in effect',
      };
    }
    return {
      schema_version: SCHEMA_VERSION, backend: this.name, state: HealthState.OK,
      method: AuthMethod.SUBSCRIPTION_OAUTH, account_label: 'Fake Subscription',
      cli_version: '0.0.0-fake', checked_at: checkedAt,
    };
  }

  /**
   * Report what is *actually* active.
   *
   * `effective: null` is a first-class answer, not an error: the contract deliberately offers no way
   * to say "probably correct", and a job whose configuration cannot be confirmed must block.
   */
  async verifyConfiguration({ requested, phaseClass, sessionKey }) {
    this.invocations.push({ kind: 'verify', requested, phaseClass, sessionKey });
    if (this.unavailable) throw Object.assign(new Error('backend unavailable'), { kind: 'unavailable' });
    if (this.authExpired) throw Object.assign(new Error('signed out'), { kind: 'auth_expired' });
    if (this.rateLimited) {
      throw Object.assign(new Error('rate limited'), { kind: 'rate_limited', retryAfterSeconds: this.retryAfterSeconds ?? 60 });
    }
    const effective = this.mirrorRequested ? { ...requested } : this.effective;
    return {
      effective: effective ? { schema_version: SCHEMA_VERSION, ...effective } : null,
      backend: this.name,
      checked_at: this.clock().toISOString(),
      detail: effective ? null : 'the CLI did not report its effective configuration',
    };
  }

  /** Run one bounded phase. Returns a structured result; it never returns prose as evidence. */
  async runPhase(request) {
    this.invocations.push({ kind: 'phase', ...request });
    if (this.unavailable) throw Object.assign(new Error('backend unavailable'), { kind: 'unavailable' });
    if (this.authExpired) throw Object.assign(new Error('signed out'), { kind: 'auth_expired' });
    if (this.rateLimited) {
      throw Object.assign(new Error('rate limited'), { kind: 'rate_limited', retryAfterSeconds: this.retryAfterSeconds ?? 60 });
    }
    if (this.processDied) throw Object.assign(new Error('the coding process exited unexpectedly'), { kind: 'process_died' });
    if (this.timedOut) throw Object.assign(new Error('the phase exceeded its time budget'), { kind: 'timeout' });
    if (this.malformedOutput) throw Object.assign(new Error('the CLI produced unparseable output'), { kind: 'malformed_output' });

    const scripted = this.phaseResults.shift();
    if (scripted) return scripted;

    // A resumed run keeps its session; a fresh one gets a new id. That is what the real CLI does,
    // and modelling it matters: the engine's review-isolation check compares session ids, so a fake
    // that returned one constant id would make an independent review look non-independent.
    this._sessionCounter += 1;
    const sessionId = request.resumeSessionId ?? `fake-session-${String(this._sessionCounter).padStart(4, '0')}`;
    return {
      ok: true,
      session_id: sessionId,
      effective: this.effective ? { schema_version: SCHEMA_VERSION, ...this.effective } : null,
      summary: 'fake phase completed',
      questions: [],
      turns_used: 1,
      max_turns_reached: false,
    };
  }
}
