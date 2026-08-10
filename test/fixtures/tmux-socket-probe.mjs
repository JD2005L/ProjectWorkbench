// A deliberately tiny tmux-backed test, run TWICE by test/tmux-hermetic.test.mjs — once with an
// adversarial ambient TMUX_TMPDIR/TMUX_PANE/PW_TMUX_HOST_MODE set, once with all of them cleared —
// which must produce identical results.
//
// It lives under test/fixtures/ so the `*.test.mjs` glob does not pick it up on its own: the parity
// check runs it, and running the full pw-tmux-server file twice for the same evidence would cost
// minutes for no extra signal.
//
// What it proves is exactly GOA-7's mechanism: the production script's host-mode branch unsets
// TMUX_TMPDIR so the server lands on the per-user default socket the terminals attach to, while a
// client that RETAINS an ambient TMUX_TMPDIR looks for the same socket name under a different
// directory and times out against a perfectly live server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizedTmuxEnv, sockName, shortSockRoot, killTestSock, sockExists, waitFor } from '../tmux-env.mjs';

const execFileAsync = promisify(execFile);
const KEEPALIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'pw-tmux-keepalive.sh');

function runKeepalive(env) {
  const proc = spawn('bash', [KEEPALIVE], { env: sanitizedTmuxEnv(env), detached: true, stdio: 'ignore' });
  proc.unref();
  return proc;
}
function stop(proc) {
  try { process.kill(-proc.pid); } catch { /* gone */ }
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
}
async function reachable(sock, env = {}) {
  try { await execFileAsync('tmux', ['-L', sock, 'has-session', '-t', '_keepalive'], { env: sanitizedTmuxEnv(env) }); return true; }
  catch { return false; }
}

test('probe: host mode resolves tmux’s default socket root, whatever the ambient environment says', { timeout: 30000 }, async (t) => {
  const sock = sockName('p1');
  const decoy = await shortSockRoot('d');
  t.after(() => killTestSock(execFileAsync, sock, [decoy]));
  t.after(() => fsp.rm(decoy, { recursive: true, force: true }));

  const proc = runKeepalive({ PW_TMUX_HOST_MODE: '1', PW_TMUX_SOCKET: sock });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => sockExists(sock, null), 15000), 'host mode must use the per-user default socket dir');
  assert.equal(sockExists(sock, decoy), false, 'and never a redirected one');
  assert.ok(await reachable(sock), 'a sanitized client must reach it');
});

test('probe: container mode resolves the explicitly supplied socket root', { timeout: 30000 }, async (t) => {
  const sock = sockName('p2');
  const root = await shortSockRoot('r');
  t.after(() => killTestSock(execFileAsync, sock, [root]));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const proc = runKeepalive({ PW_TMUX_SOCKET: sock, TMUX_TMPDIR: root });
  t.after(() => stop(proc));

  assert.ok(await waitFor(() => sockExists(sock, root), 15000), 'container mode must use the sidecar bind mount');
  assert.equal(sockExists(sock, null), false, 'and never fall back to the host default');
  assert.ok(await reachable(sock, { TMUX_TMPDIR: root }), 'a client pointed at the same root must reach it');
});
