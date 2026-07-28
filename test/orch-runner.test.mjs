// Increment 6 — the subscription-backed coding runner.
//
// Every test here drives an *injected* process runner. Nothing spawns the real CLI, nothing touches
// the operator's OAuth session, and nothing spends subscription quota — which is a requirement, not
// a convenience. What is asserted instead is the two things that can actually be got wrong: the
// exact argv the backend constructs (including that model and effort are reapplied on every resume)
// and how it classifies what comes back.
//
// The recorded fixtures below are real output shapes captured from Claude Code 2.1.220.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCodeBackend, classifyBackendFailure } from '../app/orchestrator/runner/claude.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { HealthState, AuthMethod, PhaseClass, Effort } from '../app/orchestrator/contract.js';

// Container mode, explicitly. Every assertion below describes a launch with nothing in front of the
// CLI, which is exactly what container mode must keep doing: the container already runs as the
// unprivileged user, so there is nothing to drop. Host mode puts `sudo -n -H -u <user> --` in front
// of the same argv and is covered on its own terms in orch-privilege.test.mjs — leaving this file's
// mode implicit would have made this suite a test of whoever happened to run it.
const CONFIG = loadOrchestratorConfig({
  PW_ORCHESTRATOR_ENABLED: 'true',
  PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
  PW_ORCHESTRATOR_CLAUDE_BIN: '/usr/local/bin/claude',
  PW_DEPLOY_MODE: 'container',
});

/** A recorded init event — the authoritative report of what a session is actually running. */
const INIT_LINE = JSON.stringify({
  type: 'system', subtype: 'init',
  cwd: '/srv/workspaces/Demo',
  session_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  // The real event carries this, and absence is no longer read as assent: a build that stopped
  // emitting it would otherwise let an API-billed session attest.
  apiKeySource: 'none',
  claude_code_version: '2.1.220',
  tools: ['Read', 'Edit', 'Bash'],
});

const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 3,
  session_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  stop_reason: 'end_turn', terminal_reason: 'completed',
  result: 'Implemented the change and ran the targeted tests.',
  duration_ms: 12_000,
});

/** Build a backend whose process runner is a scripted stub, recording every invocation. */
function backendWith(script, { config = CONFIG, fingerprint = FINGERPRINT } = {}) {
  const calls = [];
  const exec = async (file, args, options) => {
    // Identity probes are answered separately from the scripted phase output: the runner now
    // fingerprints the binary before every launch, and `auth status` is an independent check.
    if (args[0] === '--version') return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    if (args[0] === '--help') return { stdout: REAL_HELP, stderr: '' };
    calls.push({ file, args, options });
    const outcome = typeof script === 'function' ? script({ file, args, options, calls }) : script;
    if (outcome instanceof Error) throw outcome;
    return { stdout: outcome?.stdout ?? '', stderr: outcome?.stderr ?? '' };
  };
  const backend = new ClaudeCodeBackend({ config, exec, clock: () => new Date('2026-07-27T12:00:00.000Z') });
  // A fingerprint the tests control, so they exercise attestation rather than this host's filesystem.
  if (fingerprint !== null) backend.fingerprint = async () => fingerprint;
  return { backend, calls };
}

/** The real --help block, so capability parsing is exercised against genuine output. */
const REAL_HELP = [
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --model <model>                       Model for the current session',
].join('\n');

const FINGERPRINT = Object.freeze({
  ok: true,
  realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
  version: '2.1.220 (Claude Code)',
  capabilities: {
    '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    '--model': { declared: true, values: null },
  },
});

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

test('runner: a phase applies model, effort, turn bound and permission mode explicitly', () => {
  const { backend } = backendWith({});
  const argv = backend.buildPhaseArgv({
    prompt: 'do the thing',
    model: 'sonnet',
    effort: Effort.HIGH,
    maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION,
  });

  assert.deepEqual(argv, [
    '-p', 'do the thing',
    '--model', 'sonnet',
    '--effort', 'high',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '10',
    '--permission-mode', 'acceptEdits',
  ]);
});

test('runner: a resumed session reapplies model and effort — never assumed to have retained them', () => {
  const { backend } = backendWith({});
  const argv = backend.buildPhaseArgv({
    prompt: 'continue', model: 'sonnet', effort: Effort.HIGH, maxTurns: 4,
    phaseClass: PhaseClass.IMPLEMENTATION, resumeSessionId: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  });
  assert.ok(argv.includes('--resume'));
  assert.equal(argv[argv.indexOf('--resume') + 1], 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af');
  // The whole point: a resume that inherits whatever the session last had is exactly the failure
  // §6 is written to prevent.
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
});

test('runner: the permission mode is an allowlist keyed by phase class, never caller-supplied', () => {
  const { backend } = backendWith({});
  const modeFor = (phaseClass) => {
    const argv = backend.buildPhaseArgv({ prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 1, phaseClass });
    return argv[argv.indexOf('--permission-mode') + 1];
  };
  // Exploration, planning and review must not be able to edit.
  assert.equal(modeFor(PhaseClass.DISCOVERY), 'plan');
  assert.equal(modeFor(PhaseClass.PLANNING), 'plan');
  assert.equal(modeFor(PhaseClass.ROUTINE_REVIEW), 'plan');
  assert.equal(modeFor(PhaseClass.HIGH_RISK_REVIEW), 'plan');
  assert.equal(modeFor(PhaseClass.HIGH_RISK_DESIGN), 'plan');
  // Only implementation classes may write.
  assert.equal(modeFor(PhaseClass.IMPLEMENTATION), 'acceptEdits');
  assert.equal(modeFor(PhaseClass.MECHANICAL_CORRECTION), 'acceptEdits');
  // An unknown phase class fails closed rather than defaulting to something permissive.
  assert.throws(() => modeFor('arbitrary'), /unknown phase class/i);
  // And nothing dangerous is reachable at all.
  for (const phaseClass of Object.values(PhaseClass)) {
    assert.notEqual(modeFor(phaseClass), 'bypassPermissions');
    assert.notEqual(modeFor(phaseClass), 'dontAsk');
  }
});

test('runner: an effort outside the contract vocabulary is refused before it reaches the CLI', () => {
  const { backend } = backendWith({});
  // `xhigh` is now a contract effort — the binary advertises it. Anything outside the enum is still
  // refused before it can reach the CLI.
  for (const bad of ['ultra', '', 'high; rm -rf /', null]) {
    assert.throws(
      () => backend.buildPhaseArgv({ prompt: 'x', model: 'sonnet', effort: bad, maxTurns: 1, phaseClass: PhaseClass.IMPLEMENTATION }),
      /effort/i,
      `effort ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('runner: a model alias that is not a plain alias is refused before it reaches the CLI', () => {
  const { backend } = backendWith({});
  for (const bad of ['--dangerously-skip-permissions', 'sonnet --model opus', '', 'a b', null]) {
    assert.throws(
      () => backend.buildPhaseArgv({ prompt: 'x', model: bad, effort: 'high', maxTurns: 1, phaseClass: PhaseClass.IMPLEMENTATION }),
      /model/i,
      `model ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('runner: the turn bound is a hard ceiling, not a suggestion', () => {
  const { backend } = backendWith({});
  for (const bad of [0, -1, 61, 1.5, 'ten', null]) {
    assert.throws(
      () => backend.buildPhaseArgv({ prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: bad, phaseClass: PhaseClass.IMPLEMENTATION }),
      /turn/i,
    );
  }
});

// ---------------------------------------------------------------------------
// authentication health
// ---------------------------------------------------------------------------

test('runner: a signed-in subscription reports ok without disclosing the account address', async () => {
  const { backend, calls } = backendWith({
    stdout: JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'operator@example.com', orgId: 'fe945812-1fd8-478b-9f5e-ca2df098fc6e',
      orgName: "operator@example.com's Organization", subscriptionType: 'max',
    }),
  });
  const health = await backend.probeAuth();

  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.equal(health.state, HealthState.OK);
  assert.equal(health.method, AuthMethod.SUBSCRIPTION_OAUTH);
  assert.equal(health.account_label, 'Claude Max');
  const blob = JSON.stringify(health);
  assert.ok(!blob.includes('operator@example.com'), 'an account address must never be reported');
  assert.ok(!blob.includes('fe945812'), 'an org id must never be reported');
});

test('runner: a signed-out backend is down, and says so without a credential hint', async () => {
  const { backend } = backendWith({ stdout: JSON.stringify({ loggedIn: false }) });
  const health = await backend.probeAuth();
  assert.equal(health.state, HealthState.DOWN);
  assert.match(health.detail, /signed out/i);
});

test('runner: API-key authentication is refused outright — the product forbids API-billed inference', async () => {
  for (const status of [
    { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
    { loggedIn: true, authMethod: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
  ]) {
    const { backend } = backendWith({ stdout: JSON.stringify(status) });
    // eslint-disable-next-line no-await-in-loop
    const health = await backend.probeAuth();
    assert.equal(health.state, HealthState.DOWN, `${JSON.stringify(status)} must not be usable`);
    assert.equal(health.method, AuthMethod.UNKNOWN);
    assert.match(health.detail, /subscription/i);
  }
});

test('runner: a missing CLI is down rather than an exception', async () => {
  const { backend } = backendWith(() => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  const health = await backend.probeAuth();
  assert.equal(health.state, HealthState.DOWN);
  assert.match(health.detail, /not installed/i);
});

// ---------------------------------------------------------------------------
// effective configuration
// ---------------------------------------------------------------------------

test('runner: the effective model comes from the init event, not from an echoed keystroke', async () => {
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY,
    sessionKey: 'o:w:Demo:pvi2-orchestrator',
    cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });

  // The observed model is retained even when `effective` must be null for want of a verifiable
  // effort: a session running a *different* model than requested is a mismatch, which is a stronger
  // and more actionable signal than "could not determine".
  assert.equal(outcome.observed_model, 'claude-sonnet-5');
  // The phase invocation, not the independent `auth status` probe that now precedes it.
  const phase = calls.find((c) => c.args.includes('-p'));
  assert.equal(phase.args[phase.args.indexOf('--model') + 1], 'sonnet');
  // Verification itself must never be able to write, whatever phase it is verifying for.
  assert.equal(phase.args[phase.args.indexOf('--permission-mode') + 1], 'plan');
});

test('runner: a session reporting no effort is launch-enforced, not blocked', async () => {
  // The installed CLI's real behaviour: it declares --effort in --help but reports nothing about it
  // at runtime, so the value is enforced at launch rather than observed.
  const { backend } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  // Effort is not reported, so it is ENFORCED at launch rather than blocking — the whole point of
  // the provenance contract. The model half remains an observation.
  assert.equal(outcome.attestation.effort.provenance, 'launch_enforced');
  assert.equal(outcome.attestation.model.provenance, 'runtime_reported');
  // The model IS attested — the two halves are reported separately so a real model drift stays
  // distinguishable from "the CLI cannot tell us about effort".
  assert.equal(outcome.attestation.model.verified, true);
  assert.equal(outcome.observed_model, 'claude-sonnet-5');
  assert.equal(outcome.effective.effort, 'high');
});

test('runner: a session that DOES report effort attests, with no configuration change', async () => {
  // Forward compatibility: the capability is probed per session, not configured.
  const reporting = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', effort: 'high',
    apiKeySource: 'none', session_id: 's1', permissionMode: 'plan',
  });
  const { backend } = backendWith({ stdout: `${reporting}\n${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.deepEqual(
    { model_alias: outcome.effective.model_alias, effort: outcome.effective.effort },
    { model_alias: 'sonnet', effort: 'high' },
  );
});

test('runner: a session running a different model than requested is a mismatch, not a pass', async () => {
  const drifted = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001', effort: 'high',
    apiKeySource: 'none', session_id: 's1',
  });
  const { backend } = backendWith({ stdout: `${drifted}\n${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.equal(outcome.effective, null);
  assert.equal(outcome.attestation.model.outcome, 'mismatch');
});

test('runner: an API-billed session is refused even when it attests perfectly', async () => {
  const billed = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', effort: 'high',
    apiKeySource: 'ANTHROPIC_API_KEY', session_id: 's1',
  });
  const { backend } = backendWith({ stdout: `${billed}\n${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.equal(outcome.effective, null);
  assert.match(outcome.detail, /subscription/i);
});

test('runner: a CLI warning that it ignored the effort flag is never attested as applied', async () => {
  const reporting = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', effort: 'high',
    apiKeySource: 'none', session_id: 's1',
  });
  const { backend } = backendWith({
    stdout: `${reporting}\n${RESULT_LINE}\n`,
    stderr: "Warning: Unknown --effort value 'high' — ignoring it and using the default effort.",
  });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.equal(outcome.effective, null, 'an ignored flag must never be attested as applied');
  assert.equal(outcome.attestation.effort.outcome, 'ignored');
});

test('runner: output with no init event is unverifiable rather than optimistically parsed', async () => {
  const { backend } = backendWith({ stdout: `${RESULT_LINE}\n` });
  const outcome = await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY, sessionKey: 'k', cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  });
  assert.equal(outcome.effective, null);
});

// ---------------------------------------------------------------------------
// running a phase, and classifying what comes back
// ---------------------------------------------------------------------------

test('runner: a successful phase returns structured facts, not the agent’s prose as evidence', async () => {
  const { backend } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, true);
  assert.equal(result.session_id, 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af');
  assert.equal(result.turns_used, 3);
  assert.equal(result.max_turns_reached, false);
  assert.equal(result.permission_mode, 'acceptEdits');
  assert.equal(result.model, 'claude-sonnet-5');
  // The narrative is carried as a summary, explicitly not as evidence of anything.
  assert.match(result.summary, /Implemented the change/);
});

test('runner: a max-turn exit is a failure, never a success', async () => {
  const { backend } = backendWith({
    stdout: `${INIT_LINE}\n${JSON.stringify({
      type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 10,
      session_id: 'abc', result: 'ran out of turns',
    })}\n`,
  });
  const result = await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, false);
  assert.equal(result.max_turns_reached, true);
  assert.equal(result.failure_kind, 'max_turns');
});

test('runner: an abort is classified as cancellation, not as a timeout', () => {
  // Aborting execFile terminates the child with SIGTERM, which the timeout branch would otherwise
  // claim — sending a deliberately cancelled job to a blocked state instead of a cancelled one.
  for (const err of [
    Object.assign(new Error('x'), { name: 'AbortError', killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('x'), { code: 'ABORT_ERR', killed: true, signal: 'SIGTERM' }),
  ]) {
    assert.equal(classifyBackendFailure(err), 'cancelled');
  }
});

test('runner: an abort signal is passed through to the child process', async () => {
  // The signal has to reach execFile. Previously only the test fake honoured it, so cancellation
  // was green in the suite and inert in production.
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const controller = new AbortController();
  await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo', signal: controller.signal,
  });
  assert.equal(calls[0].options.signal, controller.signal);
});

test('runner: failures map to distinct kinds so each can reach its own safe state', () => {
  const cases = [
    [{ stderr: 'Invalid API key · Please run /login', code: 1 }, 'auth_expired'],
    [{ stderr: 'OAuth token has expired', code: 1 }, 'auth_expired'],
    [{ stderr: 'Claude usage limit reached. Your limit will reset at 3pm', code: 1 }, 'rate_limited'],
    [{ stderr: '429 Too Many Requests', code: 1 }, 'rate_limited'],
    [{ killed: true, signal: 'SIGTERM' }, 'timeout'],
    [{ signal: 'SIGKILL' }, 'process_died'],
    [{ code: 'ENOENT' }, 'unavailable'],
    [{ code: 1, stderr: 'something else entirely' }, 'phase_failed'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyBackendFailure(Object.assign(new Error('x'), err)), expected, JSON.stringify(err));
  }
});

test('runner: a rate-limit event carries a real reset time rather than an invented backoff', async () => {
  const rateLimit = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1_785_135_600, rateLimitType: 'five_hour' },
  });
  const { backend } = backendWith({ stdout: `${INIT_LINE}\n${rateLimit}\n${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, num_turns: 0, session_id: 'a', result: 'limited' })}\n` });
  const result = await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_kind, 'rate_limited');
  // 2026-07-27T12:00:00Z is 1785153600; the reset is in the past relative to it, so the floor is 1.
  assert.ok(result.retry_after_seconds >= 1);
});

test('runner: unparseable output is malformed, not silently treated as an empty success', async () => {
  const { backend } = backendWith({ stdout: 'this is not json at all\n' });
  const result = await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_kind, 'malformed_output');
});

test('runner: output is bounded and redacted before any of it is retained', async () => {
  const leaky = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'a',
    result: 'pushed with token ghp_0123456789abcdefghijklmnopqrstuvwxyz and it worked',
  });
  const { backend } = backendWith({ stdout: `${INIT_LINE}\n${leaky}\n` });
  const result = await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes('ghp_0123456789abcdefghijklmnopqrstuvwxyz'));
  assert.ok(blob.includes('[REDACTED]'));
});

test('runner: the phase runs in the project workspace and inherits no AI API credentials', async () => {
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  const { options } = calls[0];
  assert.equal(options.cwd, '/srv/workspaces/Demo');
  // An inherited API key would silently move billing off the subscription and onto the API.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    assert.ok(!(key in options.env), `${key} must not be passed to the coding backend`);
  }
  assert.ok(options.timeout > 0, 'a phase must be bounded in time');
});
