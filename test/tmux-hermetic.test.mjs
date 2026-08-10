// GOA-7 — the harness must be hermetic, proven by running the same file both ways.
//
// The finding: `test/pw-tmux-server.test.mjs` built its tmux client environment from `process.env`,
// so with an ambient `TMUX_TMPDIR` set it produced 6 pass / 3 fail, and with it cleared 9 pass / 0
// fail — same commit, same tmux, same code. Container-mode deployments export `TMUX_TMPDIR` BY
// DESIGN (it is the whole sidecar socket mechanism), so a container-oriented developer saw three
// failures in exactly the test that locks down the fix, with nothing wrong in the product.
//
// A test whose result depends on an unrelated ambient variable is a weak gate in BOTH directions:
// it false-fails there, and it would keep passing here if the script's host-mode `unset` were later
// removed. So this file runs a small tmux-backed probe twice — once under an adversarial ambient
// environment, once with it cleared — and requires the two runs to agree exactly.
//
// It also covers the variable class GOA-7 did not name, found while building this harness: a
// developer shell inside a Project Workbench pane inherits `PW_TMUX_HOST_MODE=1` from the owner
// unit, which does not move where the test LOOKS, it moves what the script DOES. Every
// "container mode" assertion silently ran the host branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AMBIENT_TMUX_VARS, AMBIENT_PW_VARS, sanitizedTmuxEnv, sockDir, sockName, shortSockRoot,
  assertSocketPathFits, killTestSock, TEST_SOCK_PREFIX,
} from './tmux-env.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'fixtures', 'tmux-socket-probe.mjs');

/** Run the probe under a given environment and return its TAP totals. */
async function runProbe(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  // node:test refuses to run recursively, and it detects that through an inherited variable. This
  // IS a nested run by design — the whole point is to execute the same file twice under different
  // ambient environments — so the marker has to go, or both runs silently execute nothing and the
  // parity assertion passes on two empty results.
  delete env.NODE_TEST_CONTEXT;
  const res = await execFileAsync(process.execPath, ['--test', PROBE], {
    env, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  }).catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? String(e), failed: true }));
  const out = `${res.stdout}\n${res.stderr}`;
  const num = (key) => Number(/^# (?:tests|pass|fail) .*/m.test(out) ? (new RegExp(`^# ${key} (\\d+)`, 'm').exec(out)?.[1] ?? -1) : -1);
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), out };
}

test('REGRESSION (GOA-7): ambient TMUX/TMUX_PANE/TMUX_TMPDIR must not change the result', { timeout: 300000 }, async (t) => {
  const decoy = await shortSockRoot('h');
  t.after(() => fsp.rm(decoy, { recursive: true, force: true }));

  // The adversarial case: exactly what a container-mode developer's shell (and a PW pane) carries.
  const dirty = await runProbe({
    TMUX_TMPDIR: decoy,
    TMUX: '/tmp/tmux-1000/default,1234,0',
    TMUX_PANE: '%7',
    PW_TMUX_HOST_MODE: '1',
  });
  const clean = await runProbe({
    TMUX_TMPDIR: undefined, TMUX: undefined, TMUX_PANE: undefined, PW_TMUX_HOST_MODE: undefined,
  });

  assert.ok(clean.tests > 0, `the probe did not run at all:\n${clean.out}`);
  assert.equal(clean.fail, 0, `the probe must pass with a clean environment:\n${clean.out}`);
  assert.equal(dirty.fail, 0,
    'THE REGRESSION: the same file failed only because of ambient state the product does not read:\n'
    + dirty.out);
  assert.deepEqual(
    { tests: dirty.tests, pass: dirty.pass, fail: dirty.fail },
    { tests: clean.tests, pass: clean.pass, fail: clean.fail },
    'both runs must return identical totals — that is what "hermetic" means here',
  );
});

test('the sanitizer removes every variable that redirects tmux or switches the script’s branch', () => {
  const polluted = {
    TMUX: 'x', TMUX_PANE: '%1', TMUX_TMPDIR: '/somewhere',
    PW_TMUX_HOST_MODE: '1', PW_DEPLOY_MODE: 'container', NOTIFY_SOCKET: '/run/systemd/notify',
    PW_TMUX_SOCKET: 'leaked', PW_ENV_FILE: '/etc/project-workbench/pw.env',
  };
  const saved = {};
  for (const [k, v] of Object.entries(polluted)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const env = sanitizedTmuxEnv();
    for (const key of [...AMBIENT_TMUX_VARS, ...AMBIENT_PW_VARS]) {
      assert.equal(env[key], undefined, `${key} must not survive sanitization`);
    }
    // ...and an explicit value still gets through, because tests opt IN to a mode deliberately.
    assert.equal(sanitizedTmuxEnv({ TMUX_TMPDIR: '/opted/in' }).TMUX_TMPDIR, '/opted/in');
    assert.equal(sanitizedTmuxEnv({ PW_TMUX_HOST_MODE: '1' }).PW_TMUX_HOST_MODE, '1');
    assert.ok(env.PATH, 'and the rest of the environment must be preserved');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('socket roots are short enough for sun_path, and a deep one is reported as itself', async (t) => {
  // GOA lost a run to this: from a deep path, tmux fails with "error connecting to … (File name too
  // long)", which reads like a socket-resolution bug and is easy to misdiagnose as GOA-7 itself.
  const root = await shortSockRoot('s');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(path.join(sockDir(root), sockName('x'))) <= 100);

  const deep = path.join('/tmp', 'a'.repeat(60), 'b'.repeat(40));
  assert.throws(() => assertSocketPathFits(deep, sockName('y')), /sun_path/,
    'the harness must name the real problem instead of letting tmux report a connection error');
});

test('cleanup only ever touches this harness’s own isolated sockets', async (t) => {
  // A typo in a socket name must not be able to reap a real Project Workbench server.
  await assert.rejects(() => killTestSock(execFileAsync, 'default'), /refusing to clean up/);
  await assert.rejects(() => killTestSock(execFileAsync, ''), /refusing to clean up/);

  // And a real cleanup removes the socket from every root it was told about, and no others.
  const sock = sockName('cleanup');
  assert.ok(sock.startsWith(TEST_SOCK_PREFIX));
  const root = await shortSockRoot('q');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await execFileAsync('tmux', ['-L', sock, 'new-session', '-d', 'sleep 60'], {
    env: sanitizedTmuxEnv({ TMUX_TMPDIR: root }),
  });
  assert.ok(fs.existsSync(path.join(sockDir(root), sock)));
  await killTestSock(execFileAsync, sock, [root]);
  assert.equal(fs.existsSync(path.join(sockDir(root), sock)), false, 'the isolated socket must be gone');
});
