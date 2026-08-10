// GOA-7 — hermetic tmux test environments.
//
// The bug: `test/pw-tmux-server.test.mjs` built its tmux client environment from `process.env`, so
// it inherited an ambient `TMUX_TMPDIR`. In host mode the production script deliberately UNSETS
// that variable (so the server lands on the per-user default socket the terminals attach to), which
// meant the server was created under `/tmp/tmux-<uid>/<sock>` while the test's own client looked
// under `$TMUX_TMPDIR/tmux-<uid>/<sock>`. Three tests then timed out against a perfectly live
// server. Container-mode deployments export `TMUX_TMPDIR` BY DESIGN — it is the entire sidecar
// socket mechanism — so a container-oriented developer saw three failures in exactly the test that
// locks down the fix, with nothing wrong in the code.
//
// A test whose result depends on an unrelated ambient variable is a weak gate in both directions:
// it false-fails here, and it would keep passing if the script's host-mode `unset` were later
// removed. So:
//
//   1. Every tmux environment is built from a SANITIZED base — ambient TMUX, TMUX_PANE and
//      TMUX_TMPDIR are removed unless a test explicitly supplies them.
//   2. Host-mode helpers resolve the per-user default socket root, deliberately, and container-mode
//      helpers resolve an explicitly supplied one. The two never guess.
//   3. Socket roots are SHORT. `sun_path` is capped at 108 bytes and CI temp paths are routinely
//      deep enough to blow it; the failure ("File name too long") is easy to misdiagnose as GOA-7
//      itself, and cost GOA an invalidated run.
//   4. Cleanup only ever touches sockets this harness created, in the roots it was told about, and
//      only ones whose names carry the test prefix — never a real Project Workbench server.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

/** Variables that make tmux talk to somebody else's server. */
export const AMBIENT_TMUX_VARS = Object.freeze(['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR']);

/**
 * ...and the Project Workbench knobs that decide WHICH BEHAVIOUR the scripts under test run.
 *
 * Found while building this harness, and it is the same bug class GOA-7 reported rather than a
 * separate one: a developer shell inside a PW pane inherits `PW_TMUX_HOST_MODE=1` from the owner
 * unit's environment. Every "container mode" test then ran the HOST branch — the script unset
 * TMUX_TMPDIR, the socket landed in the per-user default dir, and the assertion that container mode
 * honours the sidecar bind mount failed against a completely healthy script. Ambient TMUX_TMPDIR
 * moves where the test looks; ambient PW_TMUX_HOST_MODE moves what the script DOES, which is worse:
 * a container-mode regression would sail through on such a host, and the whole point of these tests
 * is that both modes are exercised deliberately.
 *
 * NOTIFY_SOCKET is here for the same reason — inherited from a systemd unit it would make the
 * keepalive signal readiness to a socket the test knows nothing about.
 */
export const AMBIENT_PW_VARS = Object.freeze([
  'PW_TMUX_HOST_MODE', 'PW_TMUX_SOCKET', 'PW_TMUX_STATE_DIR', 'PW_TMUX_OWNER', 'PW_TMUX_OWNER_REQUIRED',
  'PW_TMUX_OWNER_CGROUP', 'PW_TMUX_OWNER_EXPECT', 'PW_TMUX_PROC_ROOT', 'PW_TMUX_WATCH_INTERVAL',
  'PW_TMUX_RESTORE_ON_START', 'PW_TMUX_RESTORE_BIN', 'PW_TMUX_NOTIFY_CMD', 'PW_TMUX_LOG',
  'PW_DEPLOY_MODE', 'PW_ENV_FILE', 'PW_ENV_LIB', 'NOTIFY_SOCKET',
]);

/** Only sockets whose name starts with this may be cleaned up. */
export const TEST_SOCK_PREFIX = 'pwt-';

/**
 * A process environment with every ambient tmux variable removed, plus whatever the caller asks for.
 * Pass `TMUX_TMPDIR` explicitly to opt INTO a socket root — never by accident.
 */
export function sanitizedTmuxEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [...AMBIENT_TMUX_VARS, ...AMBIENT_PW_VARS]) delete env[key];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/** tmux nests a per-uid `tmux-<uid>` directory under its socket root; that is why the default is /tmp. */
export function sockDir(root = null) {
  return path.join(root ?? '/tmp', `tmux-${process.getuid()}`);
}

/** Where host mode puts its socket: tmux's own default, i.e. TMUX_TMPDIR unset. */
export const HOST_SOCK_DIR = sockDir(null);

/** A short, unique socket name. Short because the whole path has to fit in sun_path. */
export function sockName(tag = '') {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${TEST_SOCK_PREFIX}${tag ? `${tag}-` : ''}${suffix}`;
}

/**
 * A deliberately SHORT socket root for container-shaped tests, created under /tmp rather than under
 * whatever deep scratch directory the runner happens to use.
 */
export async function shortSockRoot(tag = 'c') {
  const root = await fsp.mkdtemp(`/tmp/pwt${tag}`);
  assertSocketPathFits(root, 'x'.repeat(24));
  return root;
}

/**
 * Throw if a socket under `root` could exceed the 108-byte `sun_path` limit. Called by the helpers
 * so the harness reports the real problem instead of tmux's "File name too long", which reads like
 * a socket-resolution bug and is exactly what GOA misdiagnosed once already.
 */
export function assertSocketPathFits(root, name) {
  const full = path.join(sockDir(root), name);
  if (Buffer.byteLength(full) > 100) {
    throw new Error(
      `tmux socket path is too long for sun_path (${Buffer.byteLength(full)} bytes): ${full}\n`
      + 'Use test/tmux-env.mjs\'s shortSockRoot() — a deep temp dir silently breaks every tmux-backed test.',
    );
  }
  return full;
}

/**
 * Kill an isolated test server and remove its socket, looking ONLY in the roots given (plus the host
 * default, which host-mode tests use by design). Refuses any socket name without the test prefix, so
 * a typo can never reap a real Project Workbench server.
 */
export async function killTestSock(execFileAsync, sock, roots = []) {
  if (!String(sock).startsWith(TEST_SOCK_PREFIX)) {
    throw new Error(`refusing to clean up '${sock}': not a ${TEST_SOCK_PREFIX}* test socket`);
  }
  const rootList = [...new Set([...roots.filter(Boolean), null])];
  for (const root of rootList) {
    try {
      await execFileAsync('tmux', ['-L', sock, 'kill-server'], {
        env: sanitizedTmuxEnv(root ? { TMUX_TMPDIR: root } : {}),
      });
    } catch { /* already gone */ }
  }
  for (const root of rootList) {
    const file = path.join(sockDir(root), sock);
    try { await fsp.rm(file, { force: true }); } catch { /* fine */ }
  }
}

/** Does the socket exist in this root? Host mode passes null for tmux's default root. */
export function sockExists(sock, root = null) {
  return fs.existsSync(path.join(sockDir(root), sock));
}

/** Poll until `fn` is truthy. Returns false on timeout rather than throwing, so callers can assert. */
export async function waitFor(fn, ms = 8000, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
