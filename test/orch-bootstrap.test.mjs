// Capability-fingerprint bootstrap.
//
// The orchestrator refuses every claim — of any provenance — when it holds no `known_fingerprint`
// for the instance, and refuses again when the one it holds does not match. That is correct and
// deliberately fail-closed, and it leaves exactly one question unanswered: where does the
// administrator get the value in the first place?
//
// Nowhere, before this. The digest was computed inside `buildAttestationEnvelope` and never
// published, so a correctly registered instance was unreachable: PW could only produce the value by
// attesting, and the attestation was refused for want of the value. This file pins the way out.
//
// Two properties matter, and neither is provable by inspection:
//
//   1. the published value is *byte-identical* to the one attestation uses. A bootstrap report that
//      computes "the same thing" a second way is a second implementation, and the failure mode is
//      an operator pinning a value that never matches;
//   2. the report carries no secret. It is copied between hosts, pasted into tickets and stored in
//      the orchestrator's registry, so anything sensitive in it leaks by design rather than by
//      accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildFingerprintReport, FINGERPRINT_REPORT_FIELDS } from '../app/orchestrator/bootstrap.js';
import { buildAttestation, DEFAULT_MODEL_ALIASES, capabilityFingerprint } from '../app/orchestrator/attestation.js';
import { AuthMode } from '../app/orchestrator/contract.js';

const execFileAsync = promisify(execFile);

const INSTANCE = 'pvi2-ct2115';

const FINGERPRINT = Object.freeze({
  ok: true,
  realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
  version: '2.1.220 (Claude Code)',
  capabilities: {
    '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    '--model': { declared: true, values: null },
  },
  identity: { dev: 47, inode: 1253244, size: 275012592, mtimeMs: 1785144521000 },
  probed_at: '2026-07-27T12:00:00.000Z',
});

const BINDING = Object.freeze({
  session_key: `orch:${INSTANCE}:Demo:pvi2-orchestrator`,
  run_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  config_generation: 3,
  at: '2026-07-27T12:00:00.000Z',
  auth_mode: AuthMode.SUBSCRIPTION,
});

const INIT = Object.freeze({
  model: 'claude-sonnet-5', apiKeySource: 'none', claude_code_version: '2.1.220',
  session_id: BINDING.run_id,
});

/** The attestation a real verification would emit for the same binary. */
const attestationFor = (fingerprint = FINGERPRINT) => buildAttestation({
  requested: { model_alias: 'sonnet', effort: 'high' },
  aliases: DEFAULT_MODEL_ALIASES,
  init: INIT,
  fingerprint,
  argvOwnedByServer: true,
  binding: BINDING,
  instanceId: INSTANCE,
  argv: ['-p', 'x', '--model', 'sonnet', '--effort', 'high'],
}).settings_attestation;

// ---------------------------------------------------------------------------
// the property the whole bootstrap rests on
// ---------------------------------------------------------------------------

test('bootstrap: the published fingerprint is the exact value attestation uses', () => {
  const report = buildFingerprintReport({ instanceId: INSTANCE, fingerprint: FINGERPRINT });
  const attested = attestationFor().envelope.capability_fingerprint;

  assert.equal(report.capability_fingerprint, attested,
    'a value that merely resembles the attested one strands the operator who pins it');
  // Same function, not a parallel implementation: a second way of computing "the same thing" is a
  // second thing, and it drifts silently the first time either side changes.
  assert.equal(report.capability_fingerprint, capabilityFingerprint(FINGERPRINT));
  assert.match(report.capability_fingerprint, /^[a-f0-9]{64}$/);
});

test('bootstrap: every input to the digest is published alongside it', () => {
  // An operator pinning an opaque hash cannot tell whether it describes the binary they think it
  // does. Each component is reported so the value can be checked by hand — `sha256sum` on the
  // realpath, `--version`, and the option surface from `--help`.
  const report = buildFingerprintReport({ instanceId: INSTANCE, fingerprint: FINGERPRINT });
  assert.equal(report.instance_id, INSTANCE);
  assert.equal(report.binary.realpath, FINGERPRINT.realpath);
  assert.equal(report.binary.version, FINGERPRINT.version);
  assert.equal(report.binary.sha256, FINGERPRINT.sha256);
  assert.deepEqual(report.binary.advertised_options.sort(), ['--effort', '--model']);
  assert.deepEqual(report.binary.advertised_values['--effort'], ['low', 'medium', 'high', 'xhigh', 'max']);
  // `--model` declares no readable value list; null says "declared, values unknown" and must not be
  // flattened to an empty list, which would read as "no value is valid".
  assert.equal(report.binary.advertised_values['--model'], null);
});

// ---------------------------------------------------------------------------
// it is copied between hosts, so it must carry nothing that should not travel
// ---------------------------------------------------------------------------

test('bootstrap: the report carries no secret, by allowlist rather than by inspection', () => {
  // A denylist of things to strip is a list someone forgets to extend. The report is built from a
  // fixed set of fields instead, and this asserts the set — so a future field is a deliberate
  // decision made here, not an accident that ships.
  const report = buildFingerprintReport({
    instanceId: INSTANCE,
    fingerprint: {
      ...FINGERPRINT,
      // Everything a fingerprint object might carry that has no business travelling.
      _cachedAt: Date.now(),
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret', PW_ORCHESTRATOR_TOKEN: 'tok_secret' },
      oauth: { access_token: 'oauth-secret', refresh_token: 'refresh-secret' },
      stderr: 'Bearer sk-ant-api03-leaked',
    },
  });

  assert.deepEqual(Object.keys(report).sort(), [...FINGERPRINT_REPORT_FIELDS].sort());

  const serialised = JSON.stringify(report);
  for (const secret of ['sk-ant', 'oauth', 'access_token', 'refresh_token', 'Bearer', 'tok_secret', 'PW_ORCHESTRATOR_TOKEN']) {
    assert.ok(!serialised.includes(secret), `the report leaked ${secret}`);
  }
});

test('bootstrap: a failed probe reports the failure and no fingerprint to pin', () => {
  // Half a report is worse than none: an operator who pins a value taken from a failed probe has
  // pinned something that can never match.
  const report = buildFingerprintReport({
    instanceId: INSTANCE,
    fingerprint: { ok: false, failure: 'wrapper', detail: 'the configured coding CLI is an interpreted script' },
  });
  assert.equal(report.capability_fingerprint, null);
  assert.equal(report.attestable, false);
  assert.equal(report.binary.failure, 'wrapper');
  assert.match(report.detail, /interpreted script/);
});

// ---------------------------------------------------------------------------
// rotation and mismatch
// ---------------------------------------------------------------------------

test('bootstrap: a deliberate CLI upgrade moves the value, which is what forces a re-pin', () => {
  const before = buildFingerprintReport({ instanceId: INSTANCE, fingerprint: FINGERPRINT });
  const after = buildFingerprintReport({
    instanceId: INSTANCE,
    fingerprint: { ...FINGERPRINT, version: '2.2.0 (Claude Code)', sha256: 'a'.repeat(64) },
  });
  assert.notEqual(before.capability_fingerprint, after.capability_fingerprint);

  // And the upgraded instance attests with the new value, so the orchestrator's old pin refuses it
  // until an administrator deliberately re-pins. That refusal IS the control: an upgrade nobody
  // authorised looks exactly like a substituted binary, because from the far side it is one.
  const attested = attestationFor({ ...FINGERPRINT, version: '2.2.0 (Claude Code)', sha256: 'a'.repeat(64) });
  assert.equal(attested.envelope.capability_fingerprint, after.capability_fingerprint);
  assert.notEqual(attested.envelope.capability_fingerprint, before.capability_fingerprint);
});

test('bootstrap: the advertised surface is part of the value, not just the file', () => {
  // A rebuilt binary that keeps its content hash but stops declaring `--effort` would otherwise
  // still match a pin taken before the change, and enforcement would be claimed against an option
  // the program no longer has.
  const narrowed = {
    ...FINGERPRINT,
    capabilities: { '--model': { declared: true, values: null } },
  };
  assert.notEqual(
    buildFingerprintReport({ instanceId: INSTANCE, fingerprint: FINGERPRINT }).capability_fingerprint,
    buildFingerprintReport({ instanceId: INSTANCE, fingerprint: narrowed }).capability_fingerprint,
  );
});

// ---------------------------------------------------------------------------
// the operator command
// ---------------------------------------------------------------------------

test('bootstrap: the operator command emits the same report, and needs no credential', async () => {
  // Run as a real subprocess with an EMPTY environment but for the CLI path: if it needed a token,
  // a project grant or an OAuth session, it would fail here. That is the point of it existing —
  // registering an instance happens before it has any credential the orchestrator would accept.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-boot-'));
  try {
    // A fake "binary": an ELF-ish file with no shebang, which answers --version and --help.
    const fake = path.join(dir, 'claude.exe');
    fs.writeFileSync(fake, [
      '\x7fELF fake binary for the bootstrap test',
      'echo unused',
    ].join('\n'));
    fs.chmodSync(fake, 0o755);

    const script = fileURLToPath(new URL('../scripts/pw-orch-fingerprint.mjs', import.meta.url));
    const run = () => execFileAsync(process.execPath, [script, '--json'], {
      env: {
        PATH: '/usr/bin:/bin',
        PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
        PW_ORCHESTRATOR_CLI: fake,
      },
      timeout: 60_000,
    });
    // A report nobody can pin exits non-zero, deliberately, so an install script can gate on it —
    // the JSON is still on stdout.
    const { stdout, code } = await run().catch((err) => ({ stdout: err.stdout, code: err.code }));
    assert.equal(code ?? 0, 1, 'an unpinnable report must fail the command');

    const report = JSON.parse(stdout);
    assert.deepEqual(Object.keys(report).sort(), [...FINGERPRINT_REPORT_FIELDS].sort());
    assert.equal(report.instance_id, INSTANCE);
    // The fake answers nothing, so the probe fails honestly rather than inventing a value.
    assert.equal(report.capability_fingerprint, null);
    assert.equal(report.attestable, false);
    assert.ok(report.binary.failure, 'a probe that could not complete must say so');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
