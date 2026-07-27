// Model and effort attestation (contract §6), rebuilt fail-closed.
//
// An independent review found the previous implementation was a tautology: the engine compared only
// effort, and in the one mode where a job could actually run the "effective" effort was copied from
// the request, so the check was `requested === requested`. The model was never compared at all —
// and could not have been, because the CLI reports a *resolved* id while the request carries an
// alias.
//
// Probing Claude Code 2.1.220 directly settled the design:
//
//   --model sonnet  ->  init.model = "claude-sonnet-5"
//   --model haiku   ->  init.model = "claude-haiku-4-5-20251001"     (a dated id, different shape)
//   init keys       ->  agents, analytics_disabled, apiKeySource, capabilities, claude_code_version,
//                       cwd, fast_mode_disabled_reason, fast_mode_state, mcp_servers, memory_paths,
//                       model, output_style, permissionMode, plugins, product_feedback_disabled,
//                       session_id, skills, slash_commands, subtype, tools, type, uuid
//
// There is no effort field, and an unrecognised `--effort` is silently ignored. So effort is not
// attestable by this CLI, and the honest answer is to report the capability unavailable and block —
// never to let unverified work proceed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_ALIASES,
  parseModelAliases,
  attestModel,
  attestEffort,
  buildAttestation,
  EFFORT_ATTESTATION_REQUIREMENT,
} from '../app/orchestrator/attestation.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

// ---------------------------------------------------------------------------
// model attestation — through an explicit mapping, never string equality
// ---------------------------------------------------------------------------

test('attestation: a configured alias is attested only against its explicit mapping', () => {
  const aliases = parseModelAliases(JSON.stringify({
    sonnet: ['claude-sonnet-5'],
    haiku: ['claude-haiku-4-5*'],
  }));

  // Exactly what the real CLI returned for each alias.
  assert.equal(attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-sonnet-5', aliases }).verified, true);
  assert.equal(attestModel({ requestedAlias: 'haiku', observedModel: 'claude-haiku-4-5-20251001', aliases }).verified, true);

  // The session is running something else entirely. This is the case the check exists for.
  const drifted = attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-haiku-4-5-20251001', aliases });
  assert.equal(drifted.verified, false);
  assert.equal(drifted.outcome, 'mismatch');
});

test('attestation: an alias with no configured mapping is unverifiable, never assumed', () => {
  const aliases = parseModelAliases(JSON.stringify({ sonnet: ['claude-sonnet-5'] }));
  const result = attestModel({ requestedAlias: 'opus', observedModel: 'claude-opus-5', aliases });
  assert.equal(result.verified, false);
  assert.equal(result.outcome, 'unverifiable');
  assert.match(result.reason, /no configured mapping/i);
});

test('attestation: the alias is never compared to itself', () => {
  // The precise defect being pinned. `requested === requested` must not be reachable: if the CLI
  // echoed the alias back verbatim, that is not evidence the alias resolved to anything.
  const aliases = parseModelAliases(JSON.stringify({ sonnet: ['claude-sonnet-5'] }));
  const echoed = attestModel({ requestedAlias: 'sonnet', observedModel: 'sonnet', aliases });
  assert.equal(echoed.verified, false, 'an echoed alias is not an attestation');

  // And an unmapped alias echoed back is likewise not self-verifying.
  const empty = parseModelAliases('{}');
  assert.equal(attestModel({ requestedAlias: 'sonnet', observedModel: 'sonnet', aliases: empty }).verified, false);
});

test('attestation: a missing or malformed observation is unverifiable', () => {
  const aliases = parseModelAliases(JSON.stringify({ sonnet: ['claude-sonnet-5'] }));
  for (const observed of [null, undefined, '', 123, {}]) {
    const result = attestModel({ requestedAlias: 'sonnet', observedModel: observed, aliases });
    assert.equal(result.verified, false, `observed ${JSON.stringify(observed)} must not verify`);
    assert.equal(result.outcome, 'unverifiable');
  }
});

test('attestation: the shipped default mapping covers the aliases the CLI actually resolves', () => {
  // Recorded from the installed CLI rather than guessed. A prefix entry is used where the vendor
  // returns a dated id, so a point release does not spuriously read as a mismatch.
  assert.equal(attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-sonnet-5', aliases: DEFAULT_MODEL_ALIASES }).verified, true);
  assert.equal(attestModel({ requestedAlias: 'haiku', observedModel: 'claude-haiku-4-5-20251001', aliases: DEFAULT_MODEL_ALIASES }).verified, true);
  assert.equal(attestModel({ requestedAlias: 'opus', observedModel: 'claude-opus-5', aliases: DEFAULT_MODEL_ALIASES }).verified, true);
  // A concrete id may also be requested directly, and attests against itself only when it matches.
  assert.equal(attestModel({ requestedAlias: 'claude-sonnet-5', observedModel: 'claude-sonnet-5', aliases: DEFAULT_MODEL_ALIASES }).verified, true);
  assert.equal(attestModel({ requestedAlias: 'claude-sonnet-5', observedModel: 'claude-opus-5', aliases: DEFAULT_MODEL_ALIASES }).verified, false);
});

test('attestation: a prefix mapping cannot be widened into a wildcard by a crafted alias', () => {
  const aliases = parseModelAliases(JSON.stringify({ haiku: ['claude-haiku-4-5*'] }));
  for (const observed of ['claude-haiku-4', 'claude-haiku', 'claude-sonnet-5', 'x-claude-haiku-4-5']) {
    assert.equal(
      attestModel({ requestedAlias: 'haiku', observedModel: observed, aliases }).verified, false,
      `${observed} must not satisfy the claude-haiku-4-5* mapping`,
    );
  }
});

test('attestation: a malformed alias configuration yields no mappings rather than a permissive one', () => {
  for (const raw of ['not json', '[]', 'null', '{"sonnet": "claude-sonnet-5"}', '{"sonnet": []}', '{"": ["x"]}']) {
    const aliases = parseModelAliases(raw);
    assert.equal(
      attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-sonnet-5', aliases }).verified, false,
      `configuration ${raw} must not produce a working mapping`,
    );
  }
});

// ---------------------------------------------------------------------------
// effort attestation — the capability this CLI does not have
// ---------------------------------------------------------------------------

test('attestation: effort is unavailable when the session reports no effort', () => {
  // The real init event, verbatim keys. No effort anywhere in it.
  const init = {
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', permissionMode: 'plan',
    apiKeySource: 'none', claude_code_version: '2.1.220', session_id: 'abc',
    capabilities: ['interrupt_receipt_v1'], tools: [], slash_commands: ['effort'],
  };
  const result = attestEffort({ requestedEffort: 'high', init, stderr: '' });
  assert.equal(result.verified, false);
  assert.equal(result.outcome, 'unavailable');
  // `slash_commands` contains the string "effort"; that is a command name, not a reported setting.
  assert.match(result.reason, /does not report/i);
  assert.ok(EFFORT_ATTESTATION_REQUIREMENT.length > 40, 'the requirement must be stated for operators');
});

test('attestation: effort is attested when — and only when — the session actually reports it', () => {
  // Forward compatibility: a CLI that reports effort is picked up with no configuration change.
  for (const field of ['effort', 'effortLevel', 'reasoning_effort']) {
    const init = { type: 'system', subtype: 'init', model: 'claude-sonnet-5', [field]: 'high' };
    const result = attestEffort({ requestedEffort: 'high', init, stderr: '' });
    assert.equal(result.verified, true, `a session reporting ${field} must attest`);
    assert.equal(result.observed, 'high');
  }
  // And a reported effort that differs is a mismatch, not a pass.
  const drifted = attestEffort({ requestedEffort: 'high', init: { effort: 'low' }, stderr: '' });
  assert.equal(drifted.verified, false);
  assert.equal(drifted.outcome, 'mismatch');
});

test('attestation: a CLI warning that it ignored the flag is never attested as applied', () => {
  const init = { model: 'claude-sonnet-5', effort: 'high' };
  const result = attestEffort({
    requestedEffort: 'high', init,
    stderr: "Warning: Unknown --effort value 'high' — ignoring it and using the default effort.",
  });
  assert.equal(result.verified, false);
  assert.equal(result.outcome, 'ignored');
});

// ---------------------------------------------------------------------------
// the combined verdict
// ---------------------------------------------------------------------------

test('attestation: effective is null unless BOTH model and effort are attested', () => {
  const aliases = DEFAULT_MODEL_ALIASES;
  const requested = { model_alias: 'sonnet', effort: 'high' };

  // The installed CLI: model attested, effort unavailable -> effective null, and the job must block.
  const real = buildAttestation({
    requested, aliases,
    init: { model: 'claude-sonnet-5', apiKeySource: 'none', claude_code_version: '2.1.220' },
    stderr: '',
  });
  assert.equal(real.effective, null, 'an unattestable effort must block, not be assumed');
  assert.equal(real.model.verified, true);
  assert.equal(real.effort.outcome, 'unavailable');
  assert.equal(real.blocking, true);
  assert.match(real.detail, /effort/i);

  // A hypothetical CLI reporting both.
  const complete = buildAttestation({
    requested, aliases,
    init: { model: 'claude-sonnet-5', effort: 'high', apiKeySource: 'none' },
    stderr: '',
  });
  assert.deepEqual(
    { model_alias: complete.effective.model_alias, effort: complete.effective.effort },
    { model_alias: 'sonnet', effort: 'high' },
    'the attested effective settings speak the contract vocabulary, not the vendor id',
  );
  assert.equal(complete.blocking, false);

  // Model drift blocks even when effort is reported.
  const drifted = buildAttestation({
    requested, aliases,
    init: { model: 'claude-haiku-4-5-20251001', effort: 'high', apiKeySource: 'none' },
    stderr: '',
  });
  assert.equal(drifted.effective, null);
  assert.equal(drifted.blocking, true);
  assert.equal(drifted.model.outcome, 'mismatch');
});

test('attestation: an API-billed session is refused however well it attests', () => {
  // apiKeySource is reported in the init event; "none" is the subscription case. Anything else
  // means inference is being billed to an API account, which the product forbids outright.
  for (const source of ['ANTHROPIC_API_KEY', 'apiKeyHelper', 'bedrock', 'vertex']) {
    const result = buildAttestation({
      requested: { model_alias: 'sonnet', effort: 'high' },
      aliases: DEFAULT_MODEL_ALIASES,
      init: { model: 'claude-sonnet-5', effort: 'high', apiKeySource: source },
      stderr: '',
    });
    assert.equal(result.effective, null, `${source} must not produce effective settings`);
    assert.equal(result.blocking, true);
    assert.match(result.detail, /subscription/i);
  }
});

test('attestation: the requested effort is never copied into the result', () => {
  // The exact regression. Whatever the CLI does or does not report, the returned effort must come
  // from an observation — so with a non-reporting CLI there is no effective value at all.
  for (const effort of ['low', 'medium', 'high', 'max']) {
    const result = buildAttestation({
      requested: { model_alias: 'sonnet', effort },
      aliases: DEFAULT_MODEL_ALIASES,
      init: { model: 'claude-sonnet-5', apiKeySource: 'none' },
      stderr: '',
    });
    assert.equal(result.effective, null, `effort ${effort} must not be self-attested`);
  }
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('config: the vacuous argv attestation mode is gone', () => {
  const cfg = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    // Previously this made every job's verification a tautology. It must now do nothing at all.
    PW_ORCHESTRATOR_EFFORT_ATTESTATION: 'argv',
  });
  assert.equal(cfg.effortAttestation, undefined, 'the setting must no longer exist');
});

test('config: model aliases are configuration-driven with the measured defaults', () => {
  const stock = loadOrchestratorConfig({ PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1' });
  assert.equal(attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-sonnet-5', aliases: stock.modelAliases }).verified, true);

  const custom = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_MODEL_ALIASES: JSON.stringify({ house: ['vendor-model-7'] }),
  });
  assert.equal(attestModel({ requestedAlias: 'house', observedModel: 'vendor-model-7', aliases: custom.modelAliases }).verified, true);
  // An explicit configuration replaces the defaults rather than extending them: an operator who
  // pins their fleet's models should not silently inherit vendor aliases they did not name.
  assert.equal(attestModel({ requestedAlias: 'sonnet', observedModel: 'claude-sonnet-5', aliases: custom.modelAliases }).verified, false);
});
