import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseEnvelope, setprivArgv, runGuardian } from '../app/deployment/container-worker.js';

const validEnvelope = () => ({
  argv: ['/usr/bin/bash', '--noprofile', '--norc', '-s'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', DEPLOY_PROJECT: 'ExampleApp' },
  input: 'echo hi\n',
  deadlineMs: 30000,
});

// -- parseEnvelope: the only channel a script body, its environment or any
// secret ever crosses on. Every bound below must fail closed.

test('parseEnvelope accepts a well-formed bounded envelope and preserves its fields exactly', () => {
  const envelope = validEnvelope();
  assert.deepEqual(parseEnvelope(JSON.stringify(envelope)), envelope);
});

test('parseEnvelope allows omitting input (treated as empty at run time, not required)', () => {
  const { input, ...rest } = validEnvelope();
  const parsed = parseEnvelope(JSON.stringify(rest));
  assert.equal(parsed.input, undefined);
});

test('parseEnvelope rejects malformed JSON outright', () => {
  assert.throws(() => parseEnvelope('{not json'));
});

test('parseEnvelope rejects every malformed argv shape', () => {
  const base = validEnvelope();
  for (const argv of [
    undefined, [], 'not-an-array', [123], ['relative-not-absolute'],
    ['/usr/bin/bash', 'has\0nul'], [''],
  ]) {
    assert.throws(() => parseEnvelope(JSON.stringify({ ...base, argv })),
      undefined, `argv ${JSON.stringify(argv)} must be rejected`);
  }
});

test('parseEnvelope rejects every malformed env shape', () => {
  const base = validEnvelope();
  for (const env of [
    undefined, null, [], 'not-an-object',
    { path: '/bin' },        // lowercase key
    { '1PATH': '/bin' },     // leading digit
    { 'PATH-X': '/bin' },    // disallowed character
    { PATH: 123 },           // non-string value
    { PATH: 'has\0nul' },    // embedded NUL
  ]) {
    assert.throws(() => parseEnvelope(JSON.stringify({ ...base, env })),
      undefined, `env ${JSON.stringify(env)} must be rejected`);
  }
});

test('parseEnvelope rejects a non-string input field', () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ ...validEnvelope(), input: 42 })));
  assert.throws(() => parseEnvelope(JSON.stringify({ ...validEnvelope(), input: null })));
});

test('parseEnvelope rejects deadlines outside the bounded 1s-1h window and non-integers', () => {
  const base = validEnvelope();
  for (const deadlineMs of [undefined, 0, 999, 3600001, -1, 1.5, '30000', NaN, Infinity]) {
    assert.throws(() => parseEnvelope(JSON.stringify({ ...base, deadlineMs })),
      undefined, `deadlineMs ${deadlineMs} must be rejected`);
  }
  assert.equal(parseEnvelope(JSON.stringify({ ...base, deadlineMs: 1000 })).deadlineMs, 1000);
  assert.equal(parseEnvelope(JSON.stringify({ ...base, deadlineMs: 3600000 })).deadlineMs, 3600000);
});

// -- setprivArgv: the exact, fixed privilege-drop invocation. No project
// input ever influences anything but the trailing argv it is handed.

test('setprivArgv drops to the fixed worker UID/GID with every capability removed and no new privileges', () => {
  const argv = setprivArgv(validEnvelope());
  assert.deepEqual(argv.slice(0, 6), [
    '--reuid=1001', '--regid=1001', '--clear-groups',
    '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs',
  ]);
  assert.equal(argv[6], '--');
  assert.deepEqual(argv.slice(7, 10), ['/usr/bin/env', '--chdir=/workspace/source', '--']);
  assert.deepEqual(argv.slice(10), validEnvelope().argv);
});

test('setprivArgv never inserts a shell around the envelope argv', () => {
  const argv = setprivArgv(validEnvelope());
  assert.equal(argv.includes('bash'), false);
  assert.equal(argv.some(value => value === '-c' || value === 'sh'), false);
});

// -- runGuardian: the PID1 guardian process-lifecycle logic, driven through
// a synthetic child and synthetic timers so the independent hard deadline,
// escalation and signal handling can be verified deterministically without
// a real setpriv binary, real root or real wall-clock waiting.

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.ended = undefined;
  child.stdin.end = data => { child.stdin.ended = data; };
  child.killedWith = [];
  child.kill = signal => child.killedWith.push(signal);
  return child;
}

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(fn, ms) {
      const id = nextId += 1;
      const handle = { id, unref() { return handle; } };
      pending.set(id, { fn, ms });
      return handle;
    },
    clearTimeoutFn(handle) { if (handle) pending.delete(handle.id); },
    fire(ms) {
      const match = [...pending.entries()].find(([, entry]) => entry.ms === ms);
      if (!match) throw new Error(`No pending timer for ${ms}ms`);
      const [id, entry] = match;
      pending.delete(id);
      entry.fn();
    },
    count() { return pending.size; },
  };
}

// Every scenario below must end by letting the fake child "exit" so
// runGuardian's finish() removes its process-level SIGTERM/SIGINT
// listeners; otherwise a real signal listener would leak across tests.
async function withGuardian(envelope, run) {
  const child = fakeChild();
  const timers = fakeTimers();
  const spawnCalls = [];
  const spawnProcess = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  };
  const guardian = runGuardian(envelope, {
    spawnProcess, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  await run({ child, timers, spawnCalls, guardian });
  return guardian;
}

test('runGuardian spawns setpriv with the envelope environment/cwd and delivers input only through stdin', async () => {
  const envelope = validEnvelope();
  const code = await withGuardian(envelope, async ({ child, spawnCalls }) => {
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, '/usr/bin/setpriv');
    assert.deepEqual(spawnCalls[0].args, setprivArgv(envelope));
    assert.deepEqual(spawnCalls[0].options.env, envelope.env);
    assert.equal(spawnCalls[0].options.cwd, '/');
    assert.deepEqual(spawnCalls[0].options.stdio, ['pipe', 'inherit', 'inherit']);
    assert.equal(child.stdin.ended, envelope.input);
    child.emit('exit', 0, null);
  });
  assert.equal(code, 0);
});

test('runGuardian propagates the child exit code exactly, including non-zero', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => { child.emit('exit', 17, null); });
  assert.equal(code, 17);
});

test('runGuardian maps a signal-only exit (no exit code) to a distinct non-zero code', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => { child.emit('exit', null, 'SIGSEGV'); });
  assert.equal(code, 128);
});

test('runGuardian maps an exit with neither code nor signal to a generic failure', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => { child.emit('exit', null, null); });
  assert.equal(code, 1);
});

test('runGuardian treats a stdin EPIPE as tolerable and keeps waiting for the real exit', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => {
    child.stdin.emit('error', Object.assign(new Error('epipe'), { code: 'EPIPE' }));
    // No premature settlement: still nothing resolved until the child exits.
    child.emit('exit', 0, null);
  });
  assert.equal(code, 0);
});

test('runGuardian stops and waits for the child after a non-EPIPE stdin delivery failure', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => {
    child.stdin.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }));
    assert.deepEqual(child.killedWith, ['SIGTERM']);
    child.emit('exit', 0, null);
  });
  assert.equal(code, 74);
});

test('runGuardian reports 127 when the privilege-drop helper itself cannot start', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child }) => {
    child.emit('error', new Error('ENOENT'));
    child.emit('exit', null, null); // real Node also emits exit(null) after a spawn error
  });
  assert.equal(code, 127);
});

test('runGuardian enforces its own independent hard deadline: the script cannot delay or cancel it', async () => {
  const envelope = validEnvelope();
  await withGuardian(envelope, async ({ child, timers }) => {
    assert.equal(timers.count(), 1, 'only the deadline timer is armed until termination begins');
    timers.fire(envelope.deadlineMs);
    assert.deepEqual(child.killedWith, ['SIGTERM'], 'deadline expiry sends SIGTERM first, not SIGKILL immediately');
    assert.equal(timers.count(), 1, 'a grace-period escalation timer is now armed');
    // The dropped-privilege child has no way to reach this guardian, so
    // simulate it ignoring SIGTERM entirely: the escalation timer alone
    // must still finish the job.
    timers.fire(3000);
    assert.deepEqual(child.killedWith, ['SIGTERM', 'SIGKILL'], 'an unresponsive child is escalated to SIGKILL');
    child.emit('exit', null, 'SIGKILL');
  });
});

test('runGuardian clears the deadline once the child exits on its own, never firing afterward', async () => {
  const envelope = validEnvelope();
  await withGuardian(envelope, async ({ child, timers }) => {
    child.emit('exit', 0, null);
    assert.equal(timers.count(), 0, 'both the deadline and any escalation timer are cleared on settlement');
  });
});

test('a child that handles the deadline signal by exiting zero cannot report worker success', async () => {
  const envelope = validEnvelope();
  const code = await withGuardian(envelope, async ({ child, timers }) => {
    timers.fire(envelope.deadlineMs);
    child.emit('exit', 0, null);
  });
  assert.equal(code, 124);
});

test('repeated shutdown signals cannot postpone the guardian escalation timer', async () => {
  const code = await withGuardian(validEnvelope(), async ({ child, timers }) => {
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    assert.deepEqual(child.killedWith, ['SIGTERM']);
    timers.fire(3000);
    assert.deepEqual(child.killedWith, ['SIGTERM', 'SIGKILL']);
    child.emit('exit', null, 'SIGKILL');
  });
  assert.equal(code, 143);
});

test('runGuardian forwards host SIGTERM/SIGINT into the same termination path as the deadline', async () => {
  const envelope = validEnvelope();
  await withGuardian(envelope, async ({ child }) => {
    process.emit('SIGTERM');
    assert.deepEqual(child.killedWith, ['SIGTERM']);
    child.emit('exit', 0, 'SIGTERM');
  });
});

test('runGuardian removes its process-level signal listeners once settled (no leak across runs)', async () => {
  const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  await withGuardian(validEnvelope(), async ({ child }) => { child.emit('exit', 0, null); });
  assert.equal(process.listenerCount('SIGTERM'), before.term);
  assert.equal(process.listenerCount('SIGINT'), before.int);
});

// -- module-level structural guarantees that cannot be exercised without a
// real container UID 0 / real setpriv binary, verified statically instead.

test('the worker module only auto-runs as a direct entrypoint, never merely on import', () => {
  const source = fs.readFileSync(new URL('../app/deployment/container-worker.js', import.meta.url), 'utf8');
  assert.match(source, /if \(process\.argv\[1\][^\n]*fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(source, /await assertContainerIsolation\(\)/);
  assert.match(source, /process\.pid !== 1/);
});

test('the worker never writes the envelope, script body or environment to a log', () => {
  const source = fs.readFileSync(new URL('../app/deployment/container-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.log/);
  assert.doesNotMatch(source, /writeFile/);
  assert.doesNotMatch(source, /stdout\.write\(.*envelope/);
});

test('running the worker file directly still requires UID 0 and fails closed under a normal user', { skip: process.getuid?.() === 0 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL('../app/deployment/container-worker.js', import.meta.url));
  await assert.rejects(exec(process.execPath, [script], { timeout: 5000 }),
    error => error.code === 78);
});
