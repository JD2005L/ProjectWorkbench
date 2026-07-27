#!/usr/bin/env node
// Publish this instance's capability fingerprint, so an administrator can pin it.
//
// The orchestrator refuses every attestation from an instance it has no `known_fingerprint` for,
// and refuses again when the value it holds does not match. Both refusals are right. Together they
// mean a new instance cannot bootstrap itself: every claim it makes before registration is refused
// for want of the value registration needs.
//
// This command breaks that circle from the outside. It takes no credential, contacts nothing, and
// writes only to stdout — so it can be run on a host that has not been registered yet, which is
// precisely when it is needed.
//
//   node scripts/pw-orch-fingerprint.mjs           # human-readable
//   node scripts/pw-orch-fingerprint.mjs --json    # the report, for transfer
//
// Configuration is read from the environment, exactly as the service reads it:
//
//   PW_ORCHESTRATOR_INSTANCE_ID   this instance's id, as the orchestrator knows it
//   PW_ORCHESTRATOR_CLI           absolute path to the real coding CLI (never the wrapper)
//   PW_ORCHESTRATOR_CLI_SHA256    optional pinned content hash; a mismatch refuses
//
// Exit status is load-bearing, so this can gate an install script:
//   0  a fingerprint was produced
//   1  the CLI could not be fingerprinted, or declares no enforceable --effort
//   2  the invocation itself was wrong

import process from 'process';

import { buildFingerprintReport } from '../app/orchestrator/bootstrap.js';
import { probeBinaryFingerprint } from '../app/orchestrator/runner/fingerprint.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');

if (args.some((a) => !['--json', '--help', '-h'].includes(a))) {
  process.stderr.write('usage: pw-orch-fingerprint.mjs [--json]\n');
  process.exit(2);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('usage: pw-orch-fingerprint.mjs [--json]\n\nPrints the capability fingerprint an administrator must pin for this instance.\n');
  process.exit(0);
}

const instanceId = process.env.PW_ORCHESTRATOR_INSTANCE_ID || null;
const executable = process.env.PW_ORCHESTRATOR_CLI || '/bin/claude';
const expectedSha256 = process.env.PW_ORCHESTRATOR_CLI_SHA256 || null;

const fingerprint = await probeBinaryFingerprint({
  executable,
  // The two options attestation can rest on. Fixed here rather than configurable: a report
  // describing a different surface than the service uses would produce a different digest.
  options: ['--effort', '--model'],
  expectedSha256,
});

const report = buildFingerprintReport({ instanceId, fingerprint });

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `instance_id            ${report.instance_id ?? '(unset — set PW_ORCHESTRATOR_INSTANCE_ID)'}`,
    `attestation contract   ${report.contract_version}`,
    `binary                 ${report.binary.realpath ?? executable}`,
    `version                ${report.binary.version ?? '(unavailable)'}`,
    `sha256                 ${report.binary.sha256 ?? '(unavailable)'}`,
    `advertised options     ${report.binary.advertised_options.join(' ') || '(none)'}`,
    `--effort values        ${(report.binary.advertised_values['--effort'] ?? []).join(', ') || '(none declared)'}`,
    '',
    `capability_fingerprint ${report.capability_fingerprint ?? '(none — nothing to pin)'}`,
  ];
  if (report.detail) lines.push('', `note: ${report.detail}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// A report an administrator cannot pin is a failure, whatever it printed.
process.exit(report.capability_fingerprint && report.attestable ? 0 : 1);
