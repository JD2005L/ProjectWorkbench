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
import os from 'node:os';

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

// ---------------------------------------------------------------------------
// SECURITY: runPhase() must refuse an API-billed session exactly like
// verifyConfiguration() already does — a real phase, not just the one-time
// verification probe, is what actually spends money and does the work.
//
// CLAUDE_CONFIG_DIR (see phaseEnv()'s allowlist above) points at the SAME
// per-user config directory a human's own interactive terminal uses (per
// app/orchestrator/lane-credentials.js's own docs: "used by TWO independent
// entrypoints"). A settings.json placed there with its own `env.
// ANTHROPIC_API_KEY` is honored by the real CLI regardless of what
// phaseEnv() stripped from the process environment — verified empirically
// against the real installed claude binary. verifyConfiguration() already
// refuses this via attestation.js's claimsSubscription check (init.
// apiKeySource !== 'none'); nothing made runPhase() apply the identical
// rule, so a phase could silently bill to that key with ok:true.
// ---------------------------------------------------------------------------

test('runner: SECURITY — a phase reporting non-subscription apiKeySource is refused, never ok:true', async () => {
  const billed = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5',
    apiKeySource: 'ANTHROPIC_API_KEY', session_id: 's1', permissionMode: 'acceptEdits',
  });
  const { backend } = backendWith({ stdout: `${billed}\n${RESULT_LINE}\n` });
  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, false, 'a phase that actually ran under API-key billing must never report ok:true, whatever the CLI itself reported about the task');
  assert.equal(result.failure_kind, 'api_billed');
});

test('runner: SECURITY — a phase whose init event omits apiKeySource entirely is refused too — absence is not consent', async () => {
  // Mirrors attestation.js's own claimsSubscription logic exactly: apiKeySource missing/non-string
  // resolves to null, and null !== 'none', so it is refused — the real CLI has always reported this
  // field (see the file-level comment on INIT_LINE), so its absence is itself suspicious.
  const noField = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 's1', permissionMode: 'acceptEdits',
  });
  const { backend } = backendWith({ stdout: `${noField}\n${RESULT_LINE}\n` });
  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_kind, 'api_billed');
});

test('runner: a phase reporting the subscription (apiKeySource: "none") is unaffected by the new check', async () => {
  const { backend } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.failure_kind, 'api_billed');
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

// ---------------------------------------------------------------------------
// per-user credential environment
//
// A resolved per-user credential (see app/orchestrator/lane-credentials.js)
// decides WHICH Claude identity a job runs under. The orchestrator's tmux
// lane applies it to the pane's launch command (session.js), but runPhase()/
// verifyConfiguration()/probeAuth() spawn the coding CLI directly — a
// SEPARATE process that must receive the SAME resolved tokens or the actual
// automated work runs under the shared/default login regardless of what the
// pane (or a human attaching to it) would see.
// ---------------------------------------------------------------------------

test('runner: runPhase applies the resolved credential tokens to the spawned CLI\'s real environment', async () => {
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
    credentialTokens: ['CLAUDE_CONFIG_DIR=/srv/pw-users/alice/.claude'],
  });
  const phase = calls.find((c) => c.args.includes('-p'));
  assert.equal(phase.options.env.CLAUDE_CONFIG_DIR, '/srv/pw-users/alice/.claude',
    'the spawned process\'s own environment must carry the resolved per-user config dir');
});

test('runner: verifyConfiguration applies the resolved credential tokens to BOTH the auth probe and the verification phase', async () => {
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  await backend.verifyConfiguration({
    requested: { model_alias: 'sonnet', effort: 'high' },
    phaseClass: PhaseClass.DISCOVERY,
    sessionKey: 'o:w:Demo:pvi2-orchestrator',
    cwd: '/srv/workspaces/Demo',
    runId: 'run-1', configGeneration: 1,
    verificationNonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    credentialTokens: ['CLAUDE_CONFIG_DIR=/srv/pw-users/alice/.claude'],
  });
  const authProbe = calls.find((c) => c.args[0] === 'auth');
  const phase = calls.find((c) => c.args.includes('-p'));
  assert.equal(authProbe.options.env.CLAUDE_CONFIG_DIR, '/srv/pw-users/alice/.claude',
    'the auth-status probe must check the SAME identity the phase itself will run under, not the shared one');
  assert.equal(phase.options.env.CLAUDE_CONFIG_DIR, '/srv/pw-users/alice/.claude');
});

test('runner: no credentialTokens means the spawned process env is byte-unchanged (disabled mode)', async () => {
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
    // credentialTokens omitted entirely — the disabled-mode / no-primaryUser shape.
  });
  const phase = calls.find((c) => c.args.includes('-p'));
  assert.equal('CLAUDE_CONFIG_DIR' in phase.options.env, false);
  // The base environment (process.env, minus the forbidden API-billing keys) must be otherwise
  // untouched — the same object shape phaseEnv() always produced.
  assert.equal(phase.options.env.PATH, process.env.PATH);
});

// ---------------------------------------------------------------------------
// SECURITY: credentialTokens must never be able to reintroduce a forbidden
// (API-billing) environment key.
//
// phaseEnv() strips FORBIDDEN_ENV from process.env FIRST, then applies
// credentialTokens — a caller-supplied array of KEY=VALUE strings threaded
// all the way from app/orchestrator/lane-credentials.js's resolver through
// engine.js and session.js. Applying tokens AFTER the strip with no check on
// what they name means any token naming a forbidden key (a bug in a future
// resolver, or a malicious project registry entry) silently reintroduces it
// — undoing this exact function's own stated contract ("every API-billing
// escape hatch removed").
// ---------------------------------------------------------------------------

test('runner: SECURITY — credentialTokens can never reintroduce a forbidden API-billing key', () => {
  const { backend } = backendWith({});
  for (const forbidden of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_BEARER_TOKEN_BEDROCK',
  ]) {
    const env = backend.phaseEnv([`${forbidden}=reintroduced`, 'CLAUDE_CONFIG_DIR=/safe']);
    assert.equal(forbidden in env, false, `${forbidden} must never be reintroducible via credentialTokens`);
    // The legitimate token alongside it must still apply — this is not a blanket rejection of the
    // whole token list, only of the specific forbidden key.
    assert.equal(env.CLAUDE_CONFIG_DIR, '/safe');
  }
});

test('runner: SECURITY — only the resolver-owned CLAUDE_CONFIG_DIR key may be set via credentialTokens, not an arbitrary key', () => {
  const { backend } = backendWith({});
  const env = backend.phaseEnv(['SOME_UNEXPECTED_KEY=value', 'CLAUDE_CONFIG_DIR=/safe', 'PATH=/hijacked']);
  assert.equal('SOME_UNEXPECTED_KEY' in env, false, 'a key resolveLaneCredentials() never produces must be dropped, not trusted');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/safe');
  assert.notEqual(env.PATH, '/hijacked', 'PATH is not a resolver-owned key and must not be overridable via credentialTokens');
});

test('runner: an empty or malformed credential token is dropped, never applied as an empty override', () => {
  const { backend } = backendWith({});
  // No '=' at all: already skipped by the pre-existing eq === -1 guard.
  // An empty value ("KEY="): must not silently null out a real config dir.
  // An empty key ("=value"): nonsensical, must not reach the allowlist.
  const env = backend.phaseEnv(['CLAUDE_CONFIG_DIR=', '=orphan-value', 'not-a-token-at-all']);
  assert.equal('CLAUDE_CONFIG_DIR' in env, false, 'an empty value must not be applied as an empty CLAUDE_CONFIG_DIR override');
  assert.equal('' in env, false);
});

test('runner: SECURITY REGRESSION — a forbidden key smuggled via credentialTokens never reaches a REAL spawned process, while the legitimate key still does', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: '/usr/local/bin/claude',
    // The default backend privilege-drops via a REAL PrivilegeDropper (see below — this test spawns
    // a live child process), which resolves PW_ORCHESTRATOR_TMUX_USER through the real passwd
    // database. The config default ('admin') only exists on CT2115; portable across hosts (including
    // GitHub's runners, which have no 'admin' account) means naming the account this process is
    // actually running as, exactly like the INTEGRATION test below does.
    PW_ORCHESTRATOR_TMUX_USER: os.userInfo().username,
  });
  const exec = async (file, args, options) => {
    if (args[0] === '--version') return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    if (args[0] === '--help') return { stdout: REAL_HELP, stderr: '' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' };
    // A REAL child process — proves a forbidden key smuggled through credentialTokens really is
    // absent from a live process's environment, not just from a JS object this test constructed.
    const real = await execFileAsync('env', [], { env: options.env });
    const lines = real.stdout.split('\n');
    const apiKey = lines.find((l) => l.startsWith('ANTHROPIC_API_KEY=')) ?? '(absent)';
    const configDir = lines.find((l) => l.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length) ?? '';
    return { stdout: `${INIT_LINE}\n${JSON.stringify({ ...JSON.parse(RESULT_LINE), result: `${apiKey}|${configDir}` })}\n`, stderr: '' };
  };
  const backend = new ClaudeCodeBackend({ config, exec, clock: () => new Date('2026-07-27T12:00:00.000Z') });
  backend.fingerprint = async () => FINGERPRINT;

  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
    credentialTokens: ['ANTHROPIC_API_KEY=reintroduced', 'CLAUDE_CONFIG_DIR=/srv/pw-users/alice/.claude'],
  });
  assert.equal(result.summary, '(absent)|/srv/pw-users/alice/.claude',
    'a REAL spawned process must never see the smuggled ANTHROPIC_API_KEY, while the legitimate CLAUDE_CONFIG_DIR must still reach it');
});

test('runner: INTEGRATION — CLAUDE_CONFIG_DIR survives the REAL PrivilegeDropper.dropEnv() pass, not just phaseEnv()\'s own stripping', async () => {
  // Merge-integration regression, PR19 (host-mode privilege drop) x PR20 (per-user credential
  // attribution). PR19 independently added CLAUDE_CONFIG_DIR to the SAME FORBIDDEN_ENV list this
  // file's constructor hands to privilegeDropperFor() — for every OTHER launch, correctly: a
  // settings.json anywhere the CLI would look carries its own env block and apiKeyHelper. But
  // ClaudeCodeBackend.exec is `this.privilege.wrap(exec)` (the constructor, unmodified by this
  // file's own changes), and PrivilegeDropper.dropEnv() (privilege.js) strips its OWN copy of
  // `forbiddenEnv` a SECOND time, independently, on whatever env phaseEnv() already produced —
  // AFTER phaseEnv() has already applied and defended CLAUDE_CONFIG_DIR via
  // ALLOWED_CREDENTIAL_TOKEN_KEYS. Fixing only phaseEnv()'s own re-strip (this file's local
  // FORBIDDEN_ENV) would still lose CLAUDE_CONFIG_DIR at THIS second, independent layer — the actual
  // bypass this test exists to catch is PRIVILEGE_DROP_FORBIDDEN_ENV being reverted to the raw
  // FORBIDDEN_ENV constant (or dropped) at the constructor call site.
  //
  // This constructs a REAL PrivilegeDropper (not a fake `privilege` object) against `deployMode:
  // 'host'` — the default — so `dropEnv()` genuinely runs: even when this process already IS the
  // configured account (`plan.mode === 'no_drop'`, the common case for a test sandbox), dropEnv() is
  // still called; only `deployMode: 'container'` (`passthrough`) would skip it.
  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: '/usr/local/bin/claude',
    PW_ORCHESTRATOR_TMUX_USER: os.userInfo().username,
  });
  const backend = new ClaudeCodeBackend({ config });
  // Confirm the plan this test actually exercises isn't the container passthrough that would make
  // the rest of this test vacuous.
  const plan = await backend.privilege.plan();
  assert.notEqual(plan.mode, 'passthrough', 'sanity: this test must exercise a real dropEnv() call');

  const wrappedEnv = await backend.privilege.invocation(
    config.backendExecutable, [], { env: backend.phaseEnv(['CLAUDE_CONFIG_DIR=/srv/pw-users/alice/.claude']) },
  ).then((invocation) => invocation.options.env);
  assert.equal(wrappedEnv.CLAUDE_CONFIG_DIR, '/srv/pw-users/alice/.claude',
    'CLAUDE_CONFIG_DIR must survive PrivilegeDropper.dropEnv() — the independent, second stripping pass PR19 added — not just phaseEnv()\'s own');
});

test('runner: REGRESSION — the resolved credential env reaches a REAL spawned process, not just a JS options object', async () => {
  // Unlike the spy above (which only proves this code CONSTRUCTS the right options.env), this
  // drives a genuine child process through Node's own execFile and reads back what that process's
  // real environment actually contained — the same class of proof test/project-terminal-start.test.mjs
  // and test/orch-session-credentials.test.mjs use via /proc/<pid>/environ for the tmux pane side of
  // this same feature.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_CLAUDE_BIN: '/usr/local/bin/claude',
    // See the SECURITY REGRESSION test above: this spawns a live child process through the real
    // PrivilegeDropper, so the drop target must be an account that actually exists on whatever host
    // runs this test — the account this process is running as, not the production default.
    PW_ORCHESTRATOR_TMUX_USER: os.userInfo().username,
  });
  const exec = async (file, args, options) => {
    if (args[0] === '--version') return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    if (args[0] === '--help') return { stdout: REAL_HELP, stderr: '' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' };
    // The REAL child process: `env` genuinely reads its own live environment, unrelated to
    // anything this test file constructed as a JS object.
    const real = await execFileAsync('env', [], { env: options.env });
    const dir = real.stdout.split('\n').find((l) => l.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length) ?? '';
    return { stdout: `${INIT_LINE}\n${JSON.stringify({ ...JSON.parse(RESULT_LINE), result: dir })}\n`, stderr: '' };
  };
  const backend = new ClaudeCodeBackend({ config, exec, clock: () => new Date('2026-07-27T12:00:00.000Z') });
  backend.fingerprint = async () => FINGERPRINT;

  const result = await backend.runPhase({
    prompt: 'implement it', model: 'sonnet', effort: 'high', maxTurns: 10,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo',
    credentialTokens: ['CLAUDE_CONFIG_DIR=/srv/pw-users/alice/.claude'],
  });
  assert.equal(result.summary, '/srv/pw-users/alice/.claude',
    'a REAL spawned process must have actually seen CLAUDE_CONFIG_DIR in its own environment');
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
  //
  // Not the caller's own `AbortSignal` by reference: the privilege drop's `_execTracked` hands
  // `exec()` an internal controller instead, aborted only once a guaranteed descendant-tree rescan
  // has run — so a real kill is never raced against discovering what else the launch started (see
  // privilege.js). What has to reach execFile is a live, real `AbortSignal`, not that specific object.
  const { backend, calls } = backendWith({ stdout: `${INIT_LINE}\n${RESULT_LINE}\n` });
  const controller = new AbortController();
  await backend.runPhase({
    prompt: 'x', model: 'sonnet', effort: 'high', maxTurns: 5,
    phaseClass: PhaseClass.IMPLEMENTATION, cwd: '/srv/workspaces/Demo', signal: controller.signal,
  });
  assert.equal(typeof calls[0].options.signal?.addEventListener, 'function');
  assert.equal(calls[0].options.signal.aborted, false);
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
