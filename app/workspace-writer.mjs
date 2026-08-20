// Workspace file writer — runs AS the terminal account, never as root.
//
// The root dashboard must not write into a project workspace: that tree is owned
// by the unprivileged pane account, so a root mkdir/write/chown there is one
// symlink away from being a local privilege escalation — and the superseded
// upload path proved it, since GNU chown follows a command-line symlink and
// `chown <owner> <project>/_inbox` on a planted link converted whatever
// directory the pane chose. Instead the dashboard drops privileges (setpriv in
// container mode, `sudo -u` in host mode — see credentialDropArgv) and runs this
// helper, which performs the filesystem work with exactly the authority the pane
// account already has. See app/workspace-file.js for the full note.
//
// Protocol: one JSON job line on stdin, then the raw payload bytes; one JSON
// result object on stdout.
//
//   in : {"action":"inbox-write","projectPath":…,"name":…,"allowEmpty":false}\n<bytes…>
//   out: {"ok":true,"result":{"path":…,"bytes":…}} | {"ok":false,"error":…,"code":…}
//
// The payload travels on stdin specifically so it never appears in this
// process's command line, and so an upload of any size is streamed rather than
// buffered — the streaming route exists because whole-file buffering was the
// failure mode.
//
// This file is installed root-owned and is not writable by the pane account.

import fsp from 'node:fs/promises';
import { unlinkSync } from 'node:fs';

import { applyInboxWrite, readJobHeader } from './workspace-file.js';

// The controller stands this process down with SIGTERM when its payload stream
// dies (a cancelled upload, a reset connection). Drop the half-written temp
// synchronously on the way out, so an abort leaves the inbox exactly as it was.
let tempPath = null;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (tempPath) { try { unlinkSync(tempPath); } catch { /* already gone */ } }
    process.exit(1);
  });
}

function fail(message, code) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) }));
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
  const action = job.action || 'inbox-write';
  if (action !== 'inbox-write') {
    fail(`workspace writer: unknown action ${JSON.stringify(String(action))}`);
    return;
  }

  try {
    const result = await applyInboxWrite({
      fsp,
      projectPath: job.projectPath,
      name: job.name,
      source,
      allowEmpty: !!job.allowEmpty,
      onTemp: (p) => { tempPath = p; },
    });
    tempPath = null;
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (e) {
    // The message may name a path; it never carries payload bytes.
    fail(e?.message || String(e), e?.code);
  }
}

await main();
