// Capability-fingerprint bootstrap.
//
// The orchestrator refuses every attestation — of any provenance — when it holds no
// `known_fingerprint` for the instance, and refuses again when the one it holds does not match.
// Both refusals are correct and deliberately fail-closed. Together they leave one question, and it
// is a chicken-and-egg one: the administrator has to obtain the value *before* the instance can
// make a claim, because every claim it makes before then is refused for want of it.
//
// So the digest is published here, by the same function that computes it for the envelope. Not a
// second implementation of "the same thing": a second implementation is a second thing, and it
// drifts the first time either side changes — with the failure mode being an operator who pins a
// value that never matches and no obvious reason why.
//
// The report travels. It is copied between hosts, pasted into tickets, and stored in the
// orchestrator's registry, so it is assembled from a fixed allowlist of fields rather than by
// stripping what looks sensitive. A denylist is a list someone forgets to extend.

import { SCHEMA_VERSION, ATTESTATION_CONTRACT_VERSION } from './contract.js';
import { capabilityFingerprint } from './attestation.js';

/**
 * Exactly the fields a report carries.
 *
 * Asserted by the tests, so adding one is a deliberate decision made here rather than a field that
 * arrives by accident inside a spread and ships to another host.
 */
export const FINGERPRINT_REPORT_FIELDS = Object.freeze([
  'schema_version',
  'contract_version',
  'instance_id',
  'attestable',
  'capability_fingerprint',
  'binary',
  'detail',
  'probed_at',
]);

/** The option surface a report describes. Fixed, so an operator sees the same shape every time. */
const REPORTED_OPTIONS = Object.freeze(['--model', '--effort']);

/**
 * Describe this instance's coding CLI, and the value an administrator must pin for it.
 *
 * `fingerprint` is whatever `probeBinaryFingerprint` returned — including a failure, which is
 * reported as a failure. Half a report is worse than none: a value taken from a probe that did not
 * complete is a value that can never match.
 */
export function buildFingerprintReport({ instanceId, fingerprint }) {
  if (!fingerprint?.ok) {
    return {
      schema_version: SCHEMA_VERSION,
      contract_version: ATTESTATION_CONTRACT_VERSION,
      instance_id: instanceId ?? null,
      attestable: false,
      capability_fingerprint: null,
      binary: {
        failure: fingerprint?.failure ?? 'unknown',
        realpath: null,
        version: null,
        sha256: null,
        advertised_options: [],
        advertised_values: {},
      },
      detail: fingerprint?.detail ?? 'the configured coding CLI could not be fingerprinted',
      probed_at: new Date().toISOString(),
    };
  }

  const advertisedOptions = REPORTED_OPTIONS.filter(
    (option) => fingerprint.capabilities?.[option]?.declared,
  );
  const advertisedValues = {};
  for (const option of advertisedOptions) {
    const values = fingerprint.capabilities[option]?.values;
    // `null` means "declared, values unreadable" and must not be flattened to an empty list, which
    // would read as "no value is valid" — the opposite claim.
    advertisedValues[option] = Array.isArray(values) ? [...values] : null;
  }

  // Effort is enforceable only when the binary declares the option *and* lists the value, because
  // Claude Code accepts an unrecognised `--effort` with a stderr warning and runs at its default.
  const enforceable = Array.isArray(fingerprint.capabilities?.['--effort']?.values);

  return {
    schema_version: SCHEMA_VERSION,
    contract_version: ATTESTATION_CONTRACT_VERSION,
    instance_id: instanceId ?? null,
    attestable: enforceable,
    // The same function the envelope uses. Byte-identical by construction, not by agreement.
    capability_fingerprint: capabilityFingerprint(fingerprint),
    binary: {
      // Every input to the digest, so the value can be checked by hand rather than trusted: run
      // `sha256sum` on the realpath, `--version`, and read the option surface out of `--help`.
      realpath: fingerprint.realpath,
      version: fingerprint.version,
      sha256: fingerprint.sha256,
      advertised_options: advertisedOptions,
      advertised_values: advertisedValues,
    },
    detail: enforceable
      ? null
      : 'the configured coding CLI does not declare a value list for --effort, so effort cannot be enforced at launch',
    probed_at: fingerprint.probed_at ?? new Date().toISOString(),
  };
}
