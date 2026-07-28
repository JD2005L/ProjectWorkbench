// Attestation provenance (orchestrator contracts/policy.py).
//
// The distinction this pins down: `runtime_reported` is an observation — the backend emitted the
// value and it was normalised through a recorded mapping. `launch_enforced` is control over an
// *input* — ProjectWorkbench owned the argv, the exact fingerprinted binary advertises the option
// and the value, and no ignored-option warning appeared. The second is genuinely weaker, and the
// product must never print one while meaning the other.
//
// Live evidence from the installed CLI (2.1.220), which is what makes each case concrete:
//   --help declares `--effort <level>` with `(low, medium, high, xhigh, max)`
//   the runtime init event reports the resolved model and says nothing about effort
//   /usr/local/bin/claude is a WRAPPER that appends --permission-mode and --mcp-config to argv
//   /bin/claude -> .../claude-code/bin/claude.exe is the real ELF binary
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAttestation, attestLaunchEnforced, buildLaunchAttestation, buildAttestationEnvelope,
  extractIgnoredOptionWarning, authModeOf, DEFAULT_MODEL_ALIASES, UNBOUND_NONCE,
} from '../app/orchestrator/attestation.js';
import {
  parseOptionCapability, probeBinaryFingerprint, FingerprintCache, FingerprintFailure,
} from '../app/orchestrator/runner/fingerprint.js';
import { Provenance, weakerProvenance, AuthMode, Effort } from '../app/orchestrator/contract.js';

const INSTANCE = 'wb-test-01';

/** The real `--help` block for --effort, verbatim from the installed CLI. */
const REAL_HELP = [
  '  --dangerously-skip-permissions        Bypass all permission checks.',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --exclude-dynamic-system-prompt-sections',
  '  --model <model>                       Model for the current session',
].join('\n');

/**
 * A minimal *loadable* ELF header, followed by whatever body a test wants.
 *
 * The magic alone is not enough any more, and that is the point: a file carrying `\x7fELF` and
 * nothing else valid is exactly what `execve` refuses with ENOEXEC, which makes `execvp` hand it to
 * /bin/sh. These fixtures stand in for a real binary, so they carry a header a kernel would accept:
 * 64-bit, little-endian, version 1, ET_EXEC.
 */
const elfBinary = (body) => {
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'latin1');
  header[4] = 2;  // EI_CLASS  = ELFCLASS64
  header[5] = 1;  // EI_DATA   = little-endian
  header[6] = 1;  // EI_VERSION
  header.writeUInt16LE(2, 16);  // e_type = ET_EXEC
  header.writeUInt16LE(0x3e, 18); // e_machine = x86-64
  return Buffer.concat([header, Buffer.from(body, 'latin1')]);
};

/** A fingerprint of the real binary, as the prober would return it. */
const GOOD_FINGERPRINT = Object.freeze({
  ok: true,
  realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
  version: '2.1.220 (Claude Code)',
  capabilities: {
    '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    '--model': { declared: true, values: null },
  },
  identity: { dev: 47, inode: 1253244, size: 275012592, mtimeMs: 1785144521000 },
});

const BINDING = Object.freeze({
  session_key: 'orch:wb-test-01:Demo:pvi2-orchestrator',
  run_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  // Fresh for every verification. A nonce derived from the job and phase alone would repeat on every
  // retry, so an attestation captured on the first attempt would stay valid on the fifth — including
  // after the lane had been relaunched with different flags.
  verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  config_generation: 3,
  at: '2026-07-27T12:00:00.000Z',
  auth_mode: AuthMode.SUBSCRIPTION,
});

/** The real init event: resolved model, no effort, subscription auth. */
const INIT = Object.freeze({
  type: 'system', subtype: 'init', model: 'claude-sonnet-5', apiKeySource: 'none',
  claude_code_version: '2.1.220', session_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  permissionMode: 'plan',
});

const ARGV = ['-p', 'x', '--model', 'sonnet', '--effort', 'high', '--output-format', 'stream-json'];

const build = (overrides = {}) => buildAttestation({
  requested: { model_alias: 'sonnet', effort: 'high' },
  aliases: DEFAULT_MODEL_ALIASES,
  init: INIT,
  stderr: '',
  fingerprint: GOOD_FINGERPRINT,
  argvOwnedByServer: true,
  binding: BINDING,
  instanceId: INSTANCE,
  argv: ARGV,
  ...overrides,
});

// ---------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------

test('provenance: a record is described by its weakest field, never its strongest', () => {
  // Describing it by the strongest would let one observed value launder an unobserved one.
  assert.equal(weakerProvenance(Provenance.RUNTIME_REPORTED, Provenance.LAUNCH_ENFORCED), Provenance.LAUNCH_ENFORCED);
  assert.equal(weakerProvenance(Provenance.LAUNCH_ENFORCED, Provenance.UNAVAILABLE), Provenance.UNAVAILABLE);
  assert.equal(weakerProvenance(Provenance.RUNTIME_REPORTED, Provenance.RUNTIME_REPORTED), Provenance.RUNTIME_REPORTED);
});

test('provenance: xhigh is a contract effort, because the binary advertises it', () => {
  // A policy that cannot name a level the binary supports would silently round down to `high`.
  assert.ok(Object.values(Effort).includes('xhigh'));
});

// ---------------------------------------------------------------------------
// capability parsing, against the real help text
// ---------------------------------------------------------------------------

test('fingerprint: the declared values are read from the real --help output', () => {
  const capability = parseOptionCapability(REAL_HELP, '--effort');
  assert.equal(capability.declared, true);
  assert.deepEqual(capability.values, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('fingerprint: an option with no readable value list yields null, never an empty list', () => {
  // An empty list would read as "no value is valid"; null says "declared, values unknown".
  const capability = parseOptionCapability(REAL_HELP, '--model');
  assert.equal(capability.declared, true);
  assert.equal(capability.values, null);
  assert.deepEqual(parseOptionCapability(REAL_HELP, '--nonexistent'), { declared: false, values: null });
});

// ---------------------------------------------------------------------------
// the happy path this whole change exists to enable
// ---------------------------------------------------------------------------

test('provenance: the current CLI yields model runtime_reported and effort launch_enforced', () => {
  const result = build();
  assert.equal(result.provenance.model, Provenance.RUNTIME_REPORTED);
  assert.equal(result.provenance.effort, Provenance.LAUNCH_ENFORCED);
  assert.equal(result.provenance.weakest, Provenance.LAUNCH_ENFORCED);
  assert.equal(result.blocking, false, 'a job must be able to run on this combination');
  assert.deepEqual(
    { model_alias: result.effective.model_alias, effort: result.effective.effort },
    { model_alias: 'sonnet', effort: 'high' },
  );

  // The launch attestation must be present, and must not claim observation.
  const attestation = result.settings_attestation;
  assert.equal(attestation.model_provenance, Provenance.RUNTIME_REPORTED);
  assert.equal(attestation.effort_provenance, Provenance.LAUNCH_ENFORCED);
  assert.ok(attestation.launch, 'a launch_enforced field requires a launch attestation');
  assert.equal(attestation.launch.caller_controlled_argv, false);
  // Identity, authentication and binding live in the envelope now, and apply to EVERY claim — with
  // them inside the launch record, declaring both fields runtime_reported skipped all of them and
  // got the stronger provenance for free.
  assert.equal(attestation.envelope.auth_mode, AuthMode.SUBSCRIPTION);
  assert.equal(attestation.envelope.attested_by, INSTANCE);
  assert.equal(attestation.envelope.verification_nonce, BINDING.verification_nonce);
  assert.equal(attestation.envelope.binary_version, '2.1.220 (Claude Code)');
  assert.equal(attestation.envelope.binary_path, GOOD_FINGERPRINT.realpath);
  assert.match(attestation.envelope.capability_fingerprint, /^[a-f0-9]{64}$/);
  // …and nowhere else. The launch record carrying them is what let a peer skip the binary-identity
  // check, and the administrator's may_attest_launch decision with it, by claiming to have observed
  // both fields — which is *more*, not less, so the bypass was to claim more.
  for (const moved of ['binary_path', 'binary_version', 'capability_fingerprint']) {
    assert.ok(!(moved in attestation.launch), `${moved} belongs to the envelope, not the launch record`);
  }
  assert.match(attestation.launch.argv_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(attestation.launch.advertised_values['--effort'], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(attestation.envelope.config_generation, 3);

  // And the runtime-reported half must carry the structured normalization that produced it: free
  // text was not evidence, because the validator could only ask whether the list was non-empty.
  assert.deepEqual(attestation.normalization.map((n) => n.field), ['model_alias']);
  assert.equal(attestation.normalization[0].source_key, 'init.model');
  assert.equal(attestation.normalization[0].raw_value, 'claude-sonnet-5');
  assert.equal(attestation.normalization[0].value, 'sonnet');
});

test('provenance: a CLI printing an effort field does NOT make effort observed', () => {
  // The claim that a field was observed is only checkable if the *orchestrator* already knows the
  // backend emits it. Its RUNTIME_REPORTABLE table holds exactly one entry for claude-code —
  // model_alias from init.model — and nothing for effort, because 2.1.220 does not report it.
  //
  // So a payload claiming to have observed effort asserts something the CLI cannot do, and is
  // refused. Upgrading is a two-step sequence and the order is the point: the orchestrator records
  // the new capability first, and only then may this side claim it. Otherwise a peer decides
  // unilaterally that its own word is now stronger, which is the whole bypass.
  const result = build({ init: { ...INIT, effort: 'high' } });
  assert.equal(result.provenance.effort, Provenance.LAUNCH_ENFORCED);
  assert.equal(result.provenance.weakest, Provenance.LAUNCH_ENFORCED);
  assert.ok(result.settings_attestation.launch, 'effort still rests on the launch record');
  assert.deepEqual(
    result.settings_attestation.normalization.map((n) => n.field), ['model_alias'],
    'no normalization entry may be offered for a field the backend cannot report',
  );
  assert.equal(result.blocking, false, 'and the job still runs');
});

test('provenance: an observed effort that contradicts the launched value blocks', () => {
  // The observation cannot *raise* the claim, but it can still refute it. A CLI reporting `low`
  // while PW passed `--effort high` is direct evidence the enforcement did not take, and quietly
  // reporting launch_enforced high would be attesting to the opposite of what was seen.
  const result = build({ init: { ...INIT, effort: 'low' } });
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.equal(result.blocking, true);
  assert.equal(result.settings_attestation, null);
  assert.match(result.detail, /running at 'low' effort, not 'high'/);
});

test('provenance: a runtime-only claim still names the binary it is about', () => {
  // "The backend emitted sonnet" says nothing if there is no record of which backend that is. The
  // envelope carries the identity for every claim, so there is no shape of payload — whatever its
  // provenance — that skips the fingerprint comparison.
  const envelope = buildAttestationEnvelope({
    instanceId: INSTANCE, binding: BINDING, authMode: AuthMode.SUBSCRIPTION,
    fingerprint: GOOD_FINGERPRINT,
  });
  assert.equal(envelope.binary_path, GOOD_FINGERPRINT.realpath);
  assert.equal(envelope.binary_version, '2.1.220 (Claude Code)');
  assert.match(envelope.capability_fingerprint, /^[a-f0-9]{64}$/);
});

test('provenance: the normalization names a source key the orchestrator accepts', () => {
  // `init.model` is the only source claude-code is recorded as emitting model_alias from. A key the
  // orchestrator does not know is refused there, so inventing one here would strand the job.
  const attestation = build().settings_attestation;
  assert.deepEqual(
    attestation.normalization.map((n) => [n.field, n.source_key]),
    [['model_alias', 'init.model']],
  );
});

test('provenance: advertised_values cannot carry a key the contract will not hold', () => {
  // The keys are typed `Slug` on the other side — no slashes, no spaces, 100 characters — and the
  // map is bounded. These come from a configured option list, so a mistake there must drop the
  // entry rather than produce a payload the contract rejects outright and strand every job.
  const hostile = {
    ...GOOD_FINGERPRINT,
    capabilities: {
      ...GOOD_FINGERPRINT.capabilities,
      '--effort/../etc': { declared: true, values: ['high'] },
      [`--${'x'.repeat(200)}`]: { declared: true, values: ['high'] },
      '--has space': { declared: true, values: ['high'] },
    },
  };
  const launch = buildLaunchAttestation({
    instanceId: INSTANCE, fingerprint: hostile, argv: ARGV, binding: BINDING,
    authMode: AuthMode.SUBSCRIPTION,
  });
  const SLUG = /^[A-Za-z0-9._-]{1,100}$/;
  for (const key of Object.keys(launch.advertised_values)) {
    assert.match(key, SLUG, `advertised_values key ${key} is not a contract slug`);
  }
  for (const option of launch.advertised_options) {
    assert.match(option, SLUG, `advertised_options entry ${option} is not a contract slug`);
  }
  assert.ok(launch.advertised_values['--effort'], 'the legitimate option survives the filter');
  assert.ok(Object.keys(launch.advertised_values).length <= 50);
});

// ---------------------------------------------------------------------------
// adversarial: every way the claim could be false
// ---------------------------------------------------------------------------

test('provenance: a caller-supplied argv can never be launch_enforced', () => {
  // If a caller can put anything on the command line, the digest attests to the caller's intent
  // rather than to policy.
  const result = build({ argvOwnedByServer: false });
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.equal(result.blocking, true);
});

test('provenance: a value the binary does not advertise is never enforced', () => {
  // The CLI accepts an unknown --effort silently and runs at its default, so "the option exists" is
  // not enough — the VALUE has to be one it declares.
  const narrow = {
    ...GOOD_FINGERPRINT,
    capabilities: { '--effort': { declared: true, values: ['low', 'medium'] } },
  };
  const result = build({ fingerprint: narrow });
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.match(result.detail, /does not declare 'high'/);
});

test('provenance: an option the binary does not declare at all is never enforced', () => {
  const result = build({
    fingerprint: { ...GOOD_FINGERPRINT, capabilities: { '--model': { declared: true, values: null } } },
  });
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.match(result.detail, /does not declare --effort/);
});

test('provenance: a warning that the option was ignored defeats the claim', () => {
  for (const stderr of [
    "Warning: Unknown --effort value 'high' — ignoring it and using the default effort.",
    'warning: unsupported option --effort',
  ]) {
    const result = build({ stderr });
    assert.equal(result.provenance.effort, Provenance.UNAVAILABLE, `stderr: ${stderr}`);
  }
  assert.equal(extractIgnoredOptionWarning('all quiet', '--effort'), null);
});

test('provenance: a missing or failed fingerprint is never enforced', () => {
  for (const fingerprint of [
    null,
    { ok: false, failure: FingerprintFailure.WRAPPER },
    { ok: false, failure: FingerprintFailure.PINNED_MISMATCH },
    { ok: false, failure: FingerprintFailure.NOT_ABSOLUTE },
  ]) {
    const result = build({ fingerprint });
    assert.equal(result.provenance.effort, Provenance.UNAVAILABLE, `fingerprint ${fingerprint?.failure ?? 'null'}`);
    assert.equal(result.blocking, true);
  }
});

test('provenance: evidence must be bound to a session, run and configuration generation', () => {
  for (const binding of [
    { ...BINDING, session_key: null },
    { ...BINDING, run_id: null },
    { ...BINDING, config_generation: undefined },
    { ...BINDING, config_generation: -1 },
  ]) {
    const result = build({ binding });
    assert.equal(result.provenance.effort, Provenance.UNAVAILABLE, JSON.stringify(binding));
  }
});

test('provenance: an API-billed session is never enforced and never effective', () => {
  const result = build({ init: { ...INIT, apiKeySource: 'ANTHROPIC_API_KEY' } });
  assert.equal(result.blocking, true);
  assert.equal(result.settings_attestation, null);
  assert.equal(authModeOf({ apiKeySource: 'ANTHROPIC_API_KEY' }), AuthMode.API_KEY);
  assert.equal(authModeOf({ apiKeySource: 'none' }), AuthMode.SUBSCRIPTION);
});

test('provenance: a stale capability fingerprint changes the attested digest', () => {
  // If what the binary advertises moves, the binary that advertised the option is not the binary
  // that ran, and prior attestations mean nothing.
  const first = build().settings_attestation.envelope.capability_fingerprint;
  const drifted = build({
    fingerprint: { ...GOOD_FINGERPRINT, version: '2.2.0 (Claude Code)' },
  }).settings_attestation.envelope.capability_fingerprint;
  assert.notEqual(first, drifted, 'a version change must move the capability fingerprint');

  const rehashed = build({
    fingerprint: { ...GOOD_FINGERPRINT, sha256: 'f'.repeat(64) },
  }).settings_attestation.envelope.capability_fingerprint;
  assert.notEqual(first, rehashed, 'a content change must move the capability fingerprint');
});

test('provenance: the argv digest binds the exact command line', () => {
  const first = build().settings_attestation.launch.argv_digest;
  const other = build({ argv: [...ARGV, '--extra'] }).settings_attestation.launch.argv_digest;
  assert.notEqual(first, other);
});

test('provenance: forged provenance cannot be smuggled in through the init event', () => {
  // A backend emitting these fields must not be able to assert its own provenance.
  const result = build({
    init: {
      ...INIT,
      provenance: 'runtime_reported',
      effort_provenance: 'runtime_reported',
      settings_attestation: { effective: { model_alias: 'sonnet', effort: 'max' } },
    },
  });
  assert.equal(result.provenance.effort, Provenance.LAUNCH_ENFORCED, 'provenance is decided here, not by the backend');
  assert.equal(result.effective.effort, 'high', 'the effective value must not come from the backend’s claim');
});

test('provenance: an attestation is never emitted with an unavailable field', () => {
  // The contract's own validator refuses a partial record — "omit the attestation entirely so the
  // caller fails closed rather than reading a partial one as partial trust".
  const result = build({ fingerprint: null });
  assert.equal(result.settings_attestation, null);
});

// ---------------------------------------------------------------------------
// old peers
// ---------------------------------------------------------------------------

test('provenance: a peer that does not bind its request gets no launch attestation', () => {
  // `unbound` is the contract's default run_id — an old peer that never learned to say which run it
  // is asking about. An attestation stamped with it is bound to nothing, so it is not made, and the
  // job blocks rather than running on evidence that could be replayed onto any other run.
  const result = build({ binding: { ...BINDING, run_id: 'unbound' } });
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.equal(result.blocking, true);
  assert.equal(result.settings_attestation, null);
  assert.match(result.detail, /bind/i);
});

test('provenance: a nonce outside the contract alphabet is treated as unbound', () => {
  // The envelope constrains the nonce to `^[A-Za-z0-9_-]+$`, not merely to a length — because
  // `hmac.compare_digest` raises TypeError on a non-ASCII `str`, and that exception escaped every
  // handler and stranded the job mid-verification. PW echoes the nonce the caller supplied, so a
  // value it cannot legally echo must be refused here rather than sent onward: producing a payload
  // the far side cannot even compare is how this side becomes the source of that failure.
  for (const nonce of [
    'nonce-with-é-accent-0123456789',       // non-ASCII: the TypeError case
    'nonce with spaces 0123456789ab',       // whitespace
    'nonce:with:colons:0123456789ab',       // an identifier, but not a nonce
    'nonce/with/slashes/0123456789',
    'nonce with-a-nul-0123456789',
  ]) {
    const result = build({ binding: { ...BINDING, verification_nonce: nonce } });
    assert.equal(result.settings_attestation, null, `a ${JSON.stringify(nonce)} nonce must not be attested`);
    assert.equal(result.blocking, true);
  }

  // And the legitimate one — hex, as PW itself generates — still works.
  assert.ok(build().settings_attestation);
});

test('provenance: codex-cli claims nothing at runtime until someone measures it', () => {
  // The row was a copy-paste asserting the same `init.model` source as Claude Code, with no
  // fixture, no documentation and no measurement behind it — in the one table that makes
  // `runtime_reported` checkable rather than self-certifying. The orchestrator removed it, and a
  // backend with no row cannot have observed anything, which is the correct answer until someone
  // measures it. PW mirrors the table, so PW must mirror the removal or it claims something the
  // far side now refuses.
  const result = build({ backend: 'codex-cli' });
  assert.equal(result.provenance.model, Provenance.UNAVAILABLE);
  assert.equal(result.settings_attestation, null);
  assert.equal(result.blocking, true);
  assert.match(result.detail, /not recorded as reporting the resolved model/);
});

test('provenance: a caller that reuses the default nonce is treated as unbound', () => {
  // The sentinel default means "no fresh nonce supplied". Accepting it would let an attestation
  // captured on one verification be replayed onto a later one for the same job.
  for (const nonce of [UNBOUND_NONCE, undefined, null, 'tooshort', 'x'.repeat(200)]) {
    const result = build({ binding: { ...BINDING, verification_nonce: nonce } });
    assert.equal(result.settings_attestation, null, `nonce ${String(nonce).slice(0, 12)} must not attest`);
    assert.equal(result.blocking, true);
  }
});

test('provenance: an unbound caller cannot get the STRONGER label either', () => {
  // The envelope's checks apply to every claim. Previously binding gated only launch enforcement,
  // so a backend printing `effort` could skip it entirely and be believed.
  const result = build({
    binding: { ...BINDING, run_id: 'unbound' },
    init: { ...INIT, effort: 'high' },
  });
  assert.equal(result.provenance.model, Provenance.UNAVAILABLE);
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.equal(result.settings_attestation, null);
});

test('provenance: a peer that binds gets an attestation stamped with exactly its binding', () => {
  const result = build({ binding: { ...BINDING, run_id: 'run-42', config_generation: 7 } });
  assert.equal(result.settings_attestation.envelope.run_id, 'run-42');
  assert.equal(result.settings_attestation.envelope.config_generation, 7);
  // The version of the attestation contract this build implements travels with the evidence, so a
  // peer below it cannot read the payload as though these checks had been made.
  assert.equal(result.settings_attestation.envelope.contract_version, '1.1');
});

// ---------------------------------------------------------------------------
// the real binary, and the wrapper that must be refused
// ---------------------------------------------------------------------------

test('fingerprint: a shell wrapper is refused — it can rewrite argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-'));
  try {
    // Exactly the shape of ProjectWorkbench's own /usr/local/bin/claude, which appends
    // --permission-mode and --mcp-config before exec'ing the real binary.
    const wrapper = path.join(dir, 'claude');
    fs.writeFileSync(wrapper, '#!/usr/bin/env bash\nexec /real/claude --permission-mode skip "$@"\n', { mode: 0o755 });
    const result = await probeBinaryFingerprint({ executable: wrapper, options: ['--effort'] });
    assert.equal(result.ok, false);
    assert.equal(result.failure, FingerprintFailure.WRAPPER);
    assert.match(result.detail, /rewrite argv/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint: EVERY interpreted script is refused, not just shell ones', async () => {
  // The vendor ships cli-wrapper.cjs with `#!/usr/bin/env node` and calls it a fallback launcher.
  // Enumerating interpreters is a losing game; any shebang can rewrite argv.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-'));
  try {
    for (const shebang of [
      '#!/usr/bin/env node', '#!/usr/bin/node', '#!/usr/bin/env bun', '#!/usr/bin/env deno',
      '#!/bin/ash', '#!/usr/bin/env -S bash -e', '#!   /bin/sh',
    ]) {
      const shim = path.join(dir, 'shim');
      fs.writeFileSync(shim, `${shebang}\nexec /real/claude --permission-mode bypassPermissions "$@"\n`, { mode: 0o755 });
      // eslint-disable-next-line no-await-in-loop
      const result = await probeBinaryFingerprint({ executable: shim, options: ['--effort'] });
      assert.equal(result.ok, false, `${shebang} must be refused`);
      assert.equal(result.failure, FingerprintFailure.WRAPPER, shebang);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint: a file with no shebang that a shell will still run is refused', async () => {
  // Found while writing the bootstrap test, and it is the same hole the shebang check closes,
  // reached from the other side. `execvp` falls back to running a file through /bin/sh when the
  // kernel refuses it with ENOEXEC — so a text file with NO shebang is still interpreted, still
  // sees the full argv, and can still rewrite it. Verified against the real syscall:
  //
  //   printf '\x7fELF not a real elf\necho "REWROTE-ARGV $*"\n' > fake.exe
  //   execFile('fake.exe', ['--version'])  ->  stdout "REWROTE-ARGV --version"
  //
  // …while stderr reads `ELF: not found` from the shell that ran it. It even carries the ELF magic,
  // so a header check alone is not the answer either: what matters is that the kernel would load
  // it, and the only honest way to require that is to refuse anything we cannot recognise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-enoexec-'));
  try {
    const impostor = path.join(dir, 'claude.exe');
    fs.writeFileSync(impostor, '\x7fELF not a real elf\necho "REWROTE-ARGV $*"\n');
    fs.chmodSync(impostor, 0o755);

    const result = await probeBinaryFingerprint({ executable: impostor, options: ['--effort'] });
    assert.equal(result.ok, false, 'a file a shell would run must never be fingerprinted as trusted');
    assert.equal(result.failure, FingerprintFailure.NOT_A_BINARY);
    assert.match(result.detail, /loadable/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint: an option prefix does not borrow another option’s declared values', () => {
  // `\b` sits between `t` and `-`, so a search for --effort matched --effort-cap and adopted its
  // value list — enough to "enforce" a value the binary never accepts.
  const help = [
    '  --effort-cap <level>                  Cap for effort',
    '                                        (low, medium, high, xhigh, max)',
    '  --other <x>                           Something else',
  ].join('\n');
  assert.deepEqual(parseOptionCapability(help, '--effort'), { declared: false, values: null });
  assert.deepEqual(parseOptionCapability(help, '--effort-cap').values, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('provenance: a backend cannot reach the STRONGER label by printing a field', () => {
  // The asymmetry: seven checks fenced launch_enforced while runtime_reported cost one JSON field.
  // A backend nobody could fingerprint is not attributable, whatever it prints.
  const result = build({
    fingerprint: { ok: false, failure: FingerprintFailure.WRAPPER },
    argvOwnedByServer: false,
    init: { ...INIT, effort: 'high' },
  });
  assert.equal(result.provenance.model, Provenance.UNAVAILABLE);
  assert.equal(result.provenance.effort, Provenance.UNAVAILABLE);
  assert.equal(result.settings_attestation, null);
  assert.equal(result.blocking, true);
});

test('provenance: a nonsense reported effort falls through to enforcement, not to a block', () => {
  // `unverifiable` used to suppress the fallback, so a backend printing garbage could deny service.
  const result = build({ init: { ...INIT, effort: 'turbo' } });
  assert.equal(result.provenance.effort, Provenance.LAUNCH_ENFORCED);
  assert.equal(result.blocking, false);
});

test('provenance: an independent auth probe overrides the backend’s own claim', () => {
  const result = build({ probedAuthMode: AuthMode.API_KEY });
  assert.equal(result.blocking, true);
  assert.equal(result.settings_attestation, null);
  assert.match(result.detail, /subscription/i);
});

test('fingerprint: a relative executable is refused — PATH is not ours to trust', async () => {
  const result = await probeBinaryFingerprint({ executable: 'claude', options: ['--effort'] });
  assert.equal(result.ok, false);
  assert.equal(result.failure, FingerprintFailure.NOT_ABSOLUTE);
});

test('fingerprint: a pinned hash that does not match is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-'));
  try {
    // Not a script: every shebang is now refused, because any interpreter can rewrite argv.
    const binary = path.join(dir, 'fake-cli');
    fs.writeFileSync(binary, elfBinary('fake binary contents'), { mode: 0o755 });
    const result = await probeBinaryFingerprint({
      executable: binary, options: ['--effort'], expectedSha256: 'a'.repeat(64),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, FingerprintFailure.PINNED_MISMATCH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint: the cache is keyed on binary identity and invalidated by any change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-'));
  try {
    const binary = path.join(dir, 'cli');
    const write = (body) => fs.writeFileSync(binary, elfBinary(body), { mode: 0o755 });
    write('v1');

    let probes = 0;
    const exec = async (file, args) => {
      probes += 1;
      if (args[0] === '--version') return { stdout: '1.0.0', stderr: '' };
      return { stdout: '  --effort <level>   Effort\n                     (low, high)\n', stderr: '' };
    };
    const cache = new FingerprintCache({ exec });

    const first = await cache.get({ executable: binary, options: ['--effort'] });
    assert.equal(first.ok, true);
    const probesAfterFirst = probes;

    // Same identity: served from cache, no re-probe and no re-hash.
    await cache.get({ executable: binary, options: ['--effort'] });
    assert.equal(probes, probesAfterFirst, 'an unchanged binary must not be re-probed');
    assert.equal(cache.size, 1);

    // Change the file: a different program, however it is named. The cache must miss.
    await new Promise((r) => setTimeout(r, 10));
    write('v2-different-length');
    const second = await cache.get({ executable: binary, options: ['--effort'] });
    assert.ok(probes > probesAfterFirst, 'a changed binary must be re-probed');
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(cache.size, 2, 'the old identity is not reused for the new file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fingerprint: a failed probe is not cached, so a transient fault does not stick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-fp-'));
  try {
    const missing = path.join(dir, 'not-there');
    const cache = new FingerprintCache({ exec: async () => ({ stdout: '', stderr: '' }) });
    const first = await cache.get({ executable: missing, options: ['--effort'] });
    assert.equal(first.ok, false);
    assert.equal(cache.size, 0, 'a failure must not be cached — it may be a partially written upgrade');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session: the attestation survives the REAL session manager and reaches the response', async () => {
  // Regression. `_verificationResponse` takes `outcome` as a fourth parameter and the success path
  // passed three, nulling the attestation, provenance, observed model and operator requirement. The
  // contract derives `effective` from the attestation, so every job blocked while the audit line
  // still recorded the verification as successful. Nothing caught it because every engine harness
  // stubs the session manager and calls the backend directly — so this test uses the real one.
  const { OrchestratorSessionManager } = await import('../app/orchestrator/session.js');
  const { ClaudeCodeBackend } = await import('../app/orchestrator/runner/claude.js');
  const { loadOrchestratorConfig } = await import('../app/orchestrator/config.js');

  const help = '  --effort <level>   Effort\n                     (low, medium, high, xhigh, max)\n';
  const init = JSON.stringify({
    type: 'system', subtype: 'init', model: 'claude-sonnet-5', apiKeySource: 'none',
    session_id: 'sess-1', claude_code_version: '2.1.220', permissionMode: 'plan',
  });
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'sess-1', result: 'ok' });
  const exec = async (file, args) => {
    if (args[0] === '--version') return { stdout: '2.1.220 (Claude Code)', stderr: '' };
    if (args[0] === '--help') return { stdout: help, stderr: '' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
    return { stdout: `${init}\n${result}\n`, stderr: '' };
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sess-'));
  try {
    const config = loadOrchestratorConfig({
      PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
      PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'd'), PW_WORKSPACES: path.join(dir, 'ws'),
      // Container mode, stated rather than inherited. This test is about attestation reaching the
      // response; host mode would additionally require this machine to have the configured
      // unprivileged account and a usable sudo, which would make the assertion below a statement
      // about the host the suite runs on.
      PW_DEPLOY_MODE: 'container',
    });
    const backend = new ClaudeCodeBackend({ config, exec });
    backend.fingerprint = async () => GOOD_FINGERPRINT;

    const record = {
      session_key: 'orch:wb-test-01:Demo:pvi2-orchestrator', orchestrator_instance_id: 'orch',
      project_id: 'Demo', cli_backend: 'claude-code', workspace_path: path.join(dir, 'ws', 'Demo'),
      cli_session_id: null,
    };
    const store = { get: () => record, transact: async (fn) => fn({ put() {} }, { get: () => record }) };
    const manager = new OrchestratorSessionManager({ config, store, repo: { putSession() {} }, tmux: null, backend });

    const out = await manager.verifySession({
      token: { orchestrator_instance_id: 'orch' }, project: { project_id: 'Demo' },
      request: {
        session_key: record.session_key, phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
        run_id: 'run-7', config_generation: 2,
        verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      },
    });

    assert.ok(out.settings_attestation, 'the attestation must reach the response');
    assert.equal(out.settings_attestation.model_provenance, Provenance.RUNTIME_REPORTED);
    assert.equal(out.settings_attestation.effort_provenance, Provenance.LAUNCH_ENFORCED);
    // Stamped with the CALLER's binding, not one invented on this side.
    assert.equal(out.settings_attestation.envelope.run_id, 'run-7');
    assert.equal(out.settings_attestation.envelope.config_generation, 2);
    assert.equal(out.settings_attestation.envelope.contract_version, '1.1');
    assert.equal(out.settings_attestation.envelope.verification_nonce, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    assert.equal(out.provenance.weakest, Provenance.LAUNCH_ENFORCED);
    assert.equal(out.observed_model, 'claude-sonnet-5');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launch attestation: the hostile defaults on the contract side are answered explicitly', () => {
  // `caller_controlled_argv` defaults to TRUE and `auth_mode` to `api_key` on the orchestrator side,
  // so a payload that omits them fails closed. Both must be set explicitly here.
  const launch = buildLaunchAttestation({
    instanceId: INSTANCE, fingerprint: GOOD_FINGERPRINT, argv: ARGV,
    binding: BINDING, stderr: '', authMode: AuthMode.SUBSCRIPTION,
  });
  assert.equal(launch.caller_controlled_argv, false);
  assert.equal(launch.ignored_option_warning, null);
  // The id is allowlisted on the other side, not chosen here: a locally invented one is
  // schema-valid and refused by the policy validator, so every enforced claim would have been
  // rejected in production while every shape-level check passed.
  assert.equal(launch.argv_builder_id, 'pw-fixed-argv-v1');
  assert.deepEqual(launch.advertised_options.sort(), ['--effort', '--model']);
  // `auth_mode` defaults to api_key on the contract side, so a payload that omits it fails closed.
  const envelope = buildAttestationEnvelope({
    instanceId: INSTANCE, binding: BINDING, authMode: AuthMode.SUBSCRIPTION,
    fingerprint: GOOD_FINGERPRINT,
  });
  assert.equal(envelope.auth_mode, AuthMode.SUBSCRIPTION);
  assert.equal(envelope.attested_by, INSTANCE);

  // And there is no envelope at all without an identified binary — refused by name, rather than
  // crashing on a property access somewhere inside.
  assert.throws(
    () => buildAttestationEnvelope({ instanceId: INSTANCE, binding: BINDING, authMode: AuthMode.SUBSCRIPTION }),
    /requires a successful binary fingerprint/,
  );
});

test('launch attestation: an enforcement claim is refused outright when a precondition fails', () => {
  const refused = attestLaunchEnforced({
    option: '--effort', value: 'high', fingerprint: GOOD_FINGERPRINT, stderr: '',
    argvOwnedByServer: true, binding: { ...BINDING, auth_mode: AuthMode.API_KEY },
  });
  assert.equal(refused.verified, false);
  assert.equal(refused.provenance, Provenance.UNAVAILABLE);
});
