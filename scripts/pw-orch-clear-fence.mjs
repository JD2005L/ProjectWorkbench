#!/usr/bin/env node
// Clear a project's durable write-lease fence — the one recovery path for a cancellation whose
// termination could not be confirmed.
//
// A fence is set when `cancelJob` cannot confirm that every descendant process of a launch is
// actually dead by the time its grace period elapses: rather than release the project's write lease
// (which would let a later job start writing to a workspace a live agent might still be editing), the
// lease is fenced — held past its own expiry, refusing every acquisition, including by the job that
// set it — until an operator says otherwise.
//
// There is deliberately no automatic path that clears one. That is what a fence *is*: the one
// guarantee the contract makes here is that nothing writes to this project again until a human has
// looked and said so, and a background process quietly clearing it on a timer would be exactly the
// auto-clear-without-evidence the mechanism exists to prevent. This command is how that human does it
// — and only that: it opens the durable store directly, so it must be run with the orchestrator
// service stopped (the store's own cross-process lock refuses a second writer, and this command does
// not try to work around that).
//
//   node scripts/pw-orch-clear-fence.mjs --project Demo                     # status only, no change
//   node scripts/pw-orch-clear-fence.mjs --project Demo --reason "..." --confirm --by james
//
// Configuration is read from the environment, exactly as the service reads it (PW_ORCHESTRATOR_*,
// see config.js). Exit status:
//   0  the requested status was reported, or the fence was cleared
//   1  the resource was not fenced (status) or nothing to clear (--confirm)
//   2  the invocation itself was wrong (missing/invalid arguments)
//   3  the durable store could not be opened (most likely: the service is still running)

import process from 'process';

import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { MIGRATIONS } from '../app/orchestrator/index.js';
import { JournalStore, StoreLockedError } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';

function usage(stream) {
  stream.write([
    'usage: pw-orch-clear-fence.mjs --project <id> [--reason "<text>" --confirm --by <name>]',
    '',
    '  --project <id>   the project whose write-lease resource to inspect or clear',
    '  --reason "<t>"   required with --confirm: why this is safe to clear (goes in the durable record)',
    '  --by <name>      required with --confirm: who is clearing it',
    '  --confirm        actually clear the fence; omit to only report its current status',
    '',
    'Without --confirm, this only reports whether the project is fenced and why — it changes nothing.',
    'The orchestrator service must be stopped first: this opens the durable store directly, and the',
    "store's own lock refuses a second writer.\n",
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { project: null, reason: null, by: null, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') args.project = argv[++i];
    else if (arg === '--reason') args.reason = argv[++i];
    else if (arg === '--by') args.by = argv[++i];
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else { args.invalid = arg; break; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(process.stdout); process.exit(0); }
if (args.invalid) { process.stderr.write(`unrecognised argument: ${args.invalid}\n`); usage(process.stderr); process.exit(2); }
if (!args.project) { process.stderr.write('--project is required\n'); usage(process.stderr); process.exit(2); }
if (args.confirm && !args.reason?.trim()) {
  process.stderr.write('--confirm requires --reason: a fence is not cleared without a stated reason\n');
  process.exit(2);
}
if (args.confirm && !args.by?.trim()) {
  process.stderr.write('--confirm requires --by: a fence is not cleared without recording who cleared it\n');
  process.exit(2);
}

const config = loadOrchestratorConfig(process.env);
if (!config.enabled || !config.instanceId) {
  process.stderr.write('PW_ORCHESTRATOR_ENABLED and PW_ORCHESTRATOR_INSTANCE_ID must be set, exactly as the service reads them\n');
  process.exit(2);
}

let store;
try {
  store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath, lockPath: config.lockPath,
    // The same migrations the service itself applies: opened without them, a store the live
    // service has already migrated reads as "written by a newer schema than this understands" and
    // refuses to open at all.
    migrations: MIGRATIONS,
  });
} catch (err) {
  if (err instanceof StoreLockedError) {
    process.stderr.write(
      'the durable store is locked — the orchestrator service is still running. Stop it first: this '
      + 'command opens the store directly and a second writer is exactly what the lock exists to refuse.\n',
    );
  } else {
    process.stderr.write(`the durable store could not be opened: ${err.message}\n`);
  }
  process.exit(3);
}

// A single exit point, reached only after `store.close()` below has actually run: `process.exit()`
// bypasses a pending `finally`, so calling it from inside this try block would have made the close
// dead code, relying entirely on the store's own on-exit lock release instead of running it.
let exitCode;
try {
  const repo = new OrchestratorRepository(store);
  const resource = `project-write:${config.instanceId}:${args.project}`;
  const lease = repo.getLease(resource);

  if (!lease?.fenced) {
    process.stdout.write(`${resource}\nnot fenced${lease ? ` (owner: ${lease.owner}, expires_at: ${lease.expires_at})` : ' (no lease record at all)'}\n`);
    exitCode = 1;
  } else {
    process.stdout.write([
      resource,
      'FENCED',
      `  fenced_at:     ${lease.fenced_at}`,
      `  fenced_by:     ${lease.fenced_by}`,
      `  fenced_reason: ${lease.fenced_reason}`,
      '',
    ].join('\n'));

    if (!args.confirm) {
      process.stdout.write(
        'no change made — pass --confirm --reason "..." --by <name> once you have verified no '
        + 'descendant process from that job is still writing to this project\'s workspace\n',
      );
      exitCode = 0;
    } else {
      await store.transact((tx, state) => {
        repo.clearFence(tx, state, { resource, clearedBy: args.by, reason: args.reason });
      });
      process.stdout.write(`cleared by ${args.by}: ${args.reason}\n`);
      exitCode = 0;
    }
  }
} finally {
  await store.close();
}
process.exit(exitCode);
