// Workspace box worker — runs AS the terminal account, never as root.
//
// The root dashboard must not touch a project's `_inbox` or `_outbox`: both are
// owned by the unprivileged pane account, so a root operation there is one
// symlink away from being a local privilege escalation — and the superseded
// upload path proved it, since GNU chown follows a command-line symlink and
// `chown <owner> <project>/_inbox` on a planted link converted whatever
// directory the pane chose. The same substitution turned the list, download and
// delete routes into arbitrary root read and arbitrary root delete.
//
// So the dashboard drops privileges (setpriv in container mode, `sudo -u` in
// host mode — see credentialDropArgv) and runs this helper, which performs the
// filesystem work with exactly the authority the pane account already has. See
// app/workspace-file.js for the full note.
//
// Protocol: one JSON job line on stdin, optionally followed by raw payload
// bytes; one JSON result line on stdout, optionally followed by raw payload
// bytes.
//
//   write : {"action":"box-write","projectPath":…,"box":…,"name":…}\n<bytes…>
//        -> {"ok":true,"result":{"path":…,"bytes":…}}\n
//   list  : {"action":"box-list","projectPath":…,"box":…}\n
//        -> {"ok":true,"result":{"files":[{"name":…,"size":…,"mtime":…}]}}\n
//   read  : {"action":"box-read","projectPath":…,"box":…,"name":…}\n
//        -> {"ok":true,"result":{"bytes":N,"mtime":…}}\n<N bytes…>
//   delete: {"action":"box-delete","projectPath":…,"box":…,"name":…}\n
//   clear : {"action":"box-clear","projectPath":…,"box":…}\n
//        -> {"ok":true,"result":{…}}\n
//   any   -> {"ok":false,"error":…,"code":…}\n
//
// Payloads travel on stdin/stdout specifically so they never appear in this
// process's command line, and so a transfer of any size is streamed rather than
// buffered — whole-file buffering was the failure mode the streaming upload
// route exists to avoid.
//
// This file is installed root-owned and is not writable by the pane account.

import fsp from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import {
  applyBoxClear, applyBoxDelete, applyBoxList, applyBoxRead, applyBoxWrite, readJobHeader,
} from './workspace-file.js';

// The controller stands this process down with SIGTERM when its payload stream
// dies (a cancelled upload, a reset connection) or when a job overruns. Drop the
// half-written temp synchronously on the way out, so an abort leaves the box
// exactly as it was.
let tempPath = null;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (tempPath) { try { unlinkSync(tempPath); } catch { /* already gone */ } }
    process.exit(1);
  });
}

function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(message, code) {
  reply({ ok: false, error: message, ...(code ? { code } : {}) });
  process.exitCode = 1;
}

async function main() {
  let read;
  try {
    read = await readJobHeader(process.stdin);
  } catch (e) {
    fail(e?.message || String(e));
    return;
  }

  const { job, source } = read;
  const common = { fsp, projectPath: job.projectPath, box: job.box, name: job.name };

  try {
    switch (job.action) {
      case 'box-write':
        reply({
          ok: true,
          result: await applyBoxWrite({
            ...common, source, allowEmpty: !!job.allowEmpty, onTemp: (p) => { tempPath = p; },
          }),
        });
        tempPath = null;
        return;

      case 'box-list':
        reply({ ok: true, result: await applyBoxList(common) });
        return;

      case 'box-delete':
        reply({ ok: true, result: await applyBoxDelete(common) });
        return;

      case 'box-clear':
        reply({ ok: true, result: await applyBoxClear(common) });
        return;

      case 'box-read': {
        const out = await applyBoxRead(common);
        reply({ ok: true, result: { bytes: out.bytes, mtime: out.mtime } });
        // The controller may abandon the download (the client went away), which
        // closes this pipe. That is an ordinary end to a transfer, not a fault
        // to report — and there is nowhere left to report it to anyway.
        try { await pipeline(out.stream, process.stdout); } catch { process.exitCode = 1; }
        return;
      }

      default:
        fail(`workspace worker: unknown action ${JSON.stringify(String(job.action))}`);
    }
  } catch (e) {
    // The message may name a path; it never carries payload bytes.
    fail(e?.message || String(e), e?.code);
  }
}

await main();
