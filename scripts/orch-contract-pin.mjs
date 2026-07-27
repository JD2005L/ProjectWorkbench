#!/usr/bin/env node
// Pin the orchestrator contract revision the cross-contract tests were validated against.
//
// Why this exists. The cross-contract tests import the orchestrator's *live working tree* through
// its venv. That tree is a sibling repository which changes independently, so a run that was green
// yesterday can fail today with nothing in this repository having moved — and the failure looks like
// flakiness rather than what it is. That is exactly what happened: an independent verifier reported
// an "intermittent" full-suite failure, and the cause was commit 703d765 landing on the other side
// mid-verification, restructuring SettingsAttestation. Two runs of the same commit genuinely
// disagreed, because the thing being compared against had changed underneath both.
//
// Pinning converts that into a deterministic, self-explaining failure: the guard hashes the contract
// sources, compares them to what is recorded here, and says the contract has moved and which files.
// The pin is updated deliberately, as part of conforming to the change — never automatically.
//
//   node scripts/orch-contract-pin.mjs           # report current vs pinned
//   node scripts/orch-contract-pin.mjs --write   # re-pin after conforming

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIN_PATH = path.join(HERE, '..', 'contract', 'orchestrator-revision.json');

/** Where the orchestrator lives. Overridable so a CI checkout can point elsewhere. */
export const ORCHESTRATOR_ROOT = process.env.PW_ORCHESTRATOR_CONTRACT_ROOT
  || '/opt/project-workbench/workspaces/PVICodingOrchestrator';

/** The contract sources this repository is conformed to. */
export const PINNED_FILES = Object.freeze([
  'src/pvi_orchestrator/contracts/policy.py',
  'src/pvi_orchestrator/contracts/common.py',
  'src/pvi_orchestrator/contracts/states.py',
  'src/pvi_orchestrator/contracts/events.py',
  'src/pvi_orchestrator/contracts/evidence.py',
  'src/pvi_orchestrator/contracts/interaction.py',
  'src/pvi_orchestrator/contracts/jobs.py',
  'src/pvi_orchestrator/contracts/publication.py',
  'src/pvi_orchestrator/contracts/workbench.py',
  'src/pvi_orchestrator/contracts/health.py',
  'src/pvi_orchestrator/workbench/protocol.py',
]);

/** Whether the orchestrator source tree is present at all. */
export function orchestratorAvailable() {
  return fs.existsSync(path.join(ORCHESTRATOR_ROOT, PINNED_FILES[0]));
}

/** Hash each pinned contract file. Missing files hash to null rather than throwing. */
export function currentContractDigests() {
  const digests = {};
  for (const relative of PINNED_FILES) {
    const absolute = path.join(ORCHESTRATOR_ROOT, relative);
    try {
      digests[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    } catch {
      digests[relative] = null;
    }
  }
  return digests;
}

/** The orchestrator's HEAD, recorded for the human reading a drift report. */
export function currentRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ORCHESTRATOR_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function readPin() {
  try {
    return JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compare the live contract against the pin.
 *
 * Returns `{ drifted, changed, missing, pinnedRevision, currentRevision }`. `changed` names the
 * files whose content differs, which is what makes the failure actionable rather than mysterious.
 */
export function compareToPin() {
  const pin = readPin();
  const current = currentContractDigests();
  if (!pin) {
    return { drifted: true, changed: PINNED_FILES.slice(), missing: [], pinnedRevision: null, currentRevision: currentRevision(), reason: 'no pin recorded' };
  }
  const changed = [];
  const missing = [];
  for (const relative of PINNED_FILES) {
    if (current[relative] === null) missing.push(relative);
    else if (pin.files?.[relative] !== current[relative]) changed.push(relative);
  }
  return {
    drifted: changed.length > 0 || missing.length > 0,
    changed,
    missing,
    pinnedRevision: pin.revision ?? null,
    currentRevision: currentRevision(),
  };
}

export function buildPin() {
  return {
    _comment: [
      'The orchestrator contract revision this repository is conformed to.',
      'The cross-contract tests validate against that repository\'s live working tree, which changes',
      'independently — so without this pin a contract change there surfaces here as an intermittent',
      'test failure with nothing in this repository having moved.',
      'Update deliberately, as part of conforming to the change: node scripts/orch-contract-pin.mjs --write',
    ],
    revision: currentRevision(),
    pinned_at: new Date().toISOString(),
    root: ORCHESTRATOR_ROOT,
    files: currentContractDigests(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!orchestratorAvailable()) {
    process.stdout.write(`orchestrator contract not present at ${ORCHESTRATOR_ROOT}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--write')) {
    const pin = buildPin();
    fs.mkdirSync(path.dirname(PIN_PATH), { recursive: true });
    fs.writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
    process.stdout.write(`pinned orchestrator contract at ${pin.revision ?? 'unknown revision'}\n`);
  } else {
    const result = compareToPin();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.drifted ? 1 : 0);
  }
}
