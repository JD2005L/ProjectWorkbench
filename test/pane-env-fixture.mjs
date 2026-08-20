// Shared fixture support: make "this variable reached the pane" a claim a test can actually fail.
//
// A tmux pane inherits the environment of the tmux SERVER process (verified against tmux 3.4: the
// client's environment does not reach a new session's panes, only `update-environment` names do).
// Every harness in this suite stands its private server up from the test runner's own environment —
// and a ProjectWorkbench terminal is one of the places these tests get run from, where
// DISABLE_AUTOUPDATER=1 is already set. So a pane inherited the token whether or not the seam under
// test set it, and the first version of the autoupdater regression passed on a completely unpatched
// tree.
//
// Two helpers, used together:
//
//   * startCleanTmuxServer() brings the private server up from a SCRUBBED environment, before
//     ownedTmuxFixture() would create one, so nothing ambient can reach a pane.
//   * assertNoAmbientPaneEnv() proves that actually worked, by reading the baseline pane. If the
//     scrub ever stops applying — a renamed fixture session, a new server-creation order — the
//     harness fails loudly instead of going quietly green.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The pane-environment names these regressions are ABOUT. Scrubbed from the server so that a pane
// carrying one proves the seam put it there.
export const PANE_ENV_NAMES = Object.freeze(['DISABLE_AUTOUPDATER', 'IS_SANDBOX', 'COPILOT_AUTO_UPDATE']);

// The session name test/tmux-owner-fixture.mjs uses for the server it stands up. Matching it is
// deliberate: creating this session first means markOwnedServer() adopts our scrubbed server rather
// than creating a second one from the ambient environment.
const BASELINE_SESSION = '_keepalive';

export function scrubbedEnv(base = process.env) {
  const env = { ...base };
  for (const name of PANE_ENV_NAMES) delete env[name];
  return env;
}

/** Bring the private tmux server up from a scrubbed environment. Call BEFORE ownedTmuxFixture(). */
export function startCleanTmuxServer(socket) {
  try {
    execFileSync('tmux', ['-L', socket, 'has-session', '-t', BASELINE_SESSION], { stdio: 'ignore', timeout: 20000 });
  } catch {
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', BASELINE_SESSION, 'sleep 86400'], {
      env: scrubbedEnv(), timeout: 20000,
    });
  }
}

/** The REAL environment of the REAL pane process, out of /proc. */
export async function paneEnviron(socket, target) {
  const { stdout } = await execFileAsync('tmux', ['-L', socket, 'list-panes', '-t', target, '-F', '#{pane_pid}']);
  const pid = stdout.trim().split('\n').filter(Boolean)[0];
  const raw = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

/**
 * The baseline: a pane on this server that no seam under test created must carry none of these
 * names. Without this, "the pane has DISABLE_AUTOUPDATER=1" is not evidence of anything.
 */
export async function assertNoAmbientPaneEnv(socket) {
  const env = await paneEnviron(socket, BASELINE_SESSION);
  for (const name of PANE_ENV_NAMES) {
    assert.equal(
      name in env, false,
      `this harness cannot prove anything: the tmux server already carries ${name}, so every pane `
      + 'inherits it whether or not the seam under test sets it (see test/pane-env-fixture.mjs)',
    );
  }
}
