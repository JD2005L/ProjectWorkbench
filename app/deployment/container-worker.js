// Fixed entrypoint for disposable deployment worker containers (PID 1 inside
// the job container's own user namespace, never host root). The controller
// grants this process only the capabilities it needs to drop privileges and
// terminate its child (setuid/setgid/setpcap/chown/kill); everything else in the
// container is unprivileged. Script bodies, environment values and
// credentials arrive on the attached stdin envelope for exactly one run,
// never through argv, `podman create` environment/labels, or a mounted file,
// and are never written to a log. The guardian keeps its own hard deadline
// so a misbehaving or hostile script cannot outlive the job's time budget:
// the dropped-privilege child has no permission to signal this process, so
// it cannot delay, pause or cancel that timer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainerIsolation } from './container-config.js';

const WORKER_UID = 1001;
const WORKER_GID = 1001;
const SETPRIV = '/usr/bin/setpriv';
const WORKSPACE_DIRS = ['/workspace/source', '/workspace/home'];
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const GRACE_MS = 3000;

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  const timeout = setTimeout(() => process.stdin.destroy(new Error('Execution envelope timed out')), 10000);
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_ENVELOPE_BYTES) throw new Error('Execution envelope is too large');
    }
    return input;
  } finally { clearTimeout(timeout); }
}

// Pure validation of the bounded stdin envelope - the only channel a script
// body, its environment or any secret ever crosses on. Exported so its exact
// bounds can be exercised directly, without a real stdin stream.
export function parseEnvelope(text) {
  const envelope = JSON.parse(text);
  if (!Array.isArray(envelope.argv) || !envelope.argv.length
      || envelope.argv.some(value => typeof value !== 'string' || value.includes('\0'))
      || !envelope.argv[0].startsWith('/') || !envelope.env || typeof envelope.env !== 'object'
      || Array.isArray(envelope.env)) throw new Error('Invalid execution envelope');
  for (const [key, value] of Object.entries(envelope.env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid worker environment');
  }
  if (envelope.input !== undefined && typeof envelope.input !== 'string') throw new Error('Invalid worker input');
  if (!Number.isSafeInteger(envelope.deadlineMs) || envelope.deadlineMs < 1000 || envelope.deadlineMs > 3600000) {
    throw new Error('Invalid worker deadline');
  }
  return envelope;
}

// Exact privilege-drop invocation: fixed capabilities/flags only, with the
// envelope's own argv appended last and never reinterpreted by a shell.
export function setprivArgv(envelope) {
  return [
    `--reuid=${WORKER_UID}`, `--regid=${WORKER_GID}`, '--clear-groups',
    '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--',
    '/usr/bin/env', '--chdir=/workspace/source', '--',
    ...envelope.argv,
  ];
}

function prepareWorkspace() {
  for (const directory of WORKSPACE_DIRS) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe worker workspace');
    fs.chownSync(directory, WORKER_UID, WORKER_GID);
  }
}

// The guardian itself: an independent hard deadline the dropped-privilege
// child can never delay, pause or cancel (it has no capability left to
// signal PID 1), and whose own exit - deadline-triggered or the child's
// natural exit - always tears down every remaining namespace process since
// this guardian is PID 1 in the job's own namespace. `spawnProcess` is
// injectable so this can be exercised with a synthetic child in tests,
// without a real setpriv binary or real root.
export function runGuardian(envelope, { spawnProcess = spawn, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let killTimer, forcedExitCode, terminating = false;
    const child = spawnProcess(SETPRIV, setprivArgv(envelope), {
      env: envelope.env, cwd: '/', stdio: ['pipe', 'inherit', 'inherit'],
    });
    const terminate = code => {
      forcedExitCode ??= code;
      if (terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      killTimer = setTimeoutFn(() => child.kill('SIGKILL'), GRACE_MS);
      killTimer?.unref?.();
    };
    const onTerm = () => terminate(143);
    const onInt = () => terminate(130);
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(deadline);
      clearTimeoutFn(killTimer);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve(code);
    };

    // This guardian deadline is independent of the child: only this timer or
    // the child's own exit clears it, never a signal from the dropped
    // privilege script (it lacks the UID/capability to send this process one).
    const deadline = setTimeoutFn(() => terminate(124), envelope.deadlineMs);
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);

    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        process.stderr.write('Deployment worker input delivery failed\n');
        terminate(74);
      }
    });
    child.stdin.end(envelope.input ?? '');
    child.on('error', () => {
      process.stderr.write('Deployment worker executable could not start\n');
      finish(127);
    });
    child.on('exit', (code, signal) => finish(forcedExitCode ?? code ?? (signal ? 128 : 1)));
  });
}

async function main() {
  await assertContainerIsolation();
  if (process.pid !== 1) throw new Error('The worker guardian must own the container PID namespace');
  const envelope = parseEnvelope(await readStdin());
  prepareWorkspace();
  process.exitCode = await runGuardian(envelope);
}

// Only auto-runs when executed directly as the container entrypoint (`node
// container-worker.js`, PID 1 inside the job container); importing this
// module - as the test suite does, to reach the pure helpers above - never
// spawns a privilege-dropped child or touches the real filesystem.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Invalid deployment worker execution envelope\n');
    process.exitCode = 78;
  });
}
