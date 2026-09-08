// Shared fixture support: make a test's PRIVATE tmux server look like what a
// real deployment has — an owned server.
//
// Candidate C makes every server-creation seam refuse a tmux server it does not
// own. Harnesses that stand up their own private server were, before this,
// creating exactly the state the gate exists to catch: an unmarked server nobody
// claims. They were not wrong to fail; they were describing an environment that
// cannot occur in production, where the owner unit stamps the server before any
// terminal is allowed to touch it.
//
// So these helpers install the REAL assertion helper and reproduce the REAL
// expectations. Deliberately NOT provided, because each would be a fail-open the
// contract forbids:
//
//   * no bypass/enforcement flag,
//   * no reuse of PW_TMUX_OWNER_BOOTSTRAP as a test exemption,
//   * no private-socket exemption (production isolates with the same variable,
//     so exempting private sockets would exempt production too).
//
// The cgroup half is handled the way Round 8 prescribed: a test where every
// process shares the runner's cgroup cannot discriminate on cgroup, so the branch
// is exercised against a CONTROLLED /proc whose contents say what a real host
// would say. `PW_TMUX_REQUIRE_CGROUP=1` — the same value the shipped units set —
// stays ON, so the fixture proves the production expectation rather than dodging it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OWNER_MARKER_OPTION, OWNER_MARKER_VALUE, expectedOwnerCgroup } from '../app/tmux-owner.js';

const REAL_HELPER = fileURLToPath(new URL('../scripts/pw-tmux-assert-owner', import.meta.url));

// A FIXTURE THAT STANDS A REAL SERVER UP OWNS TAKING IT DOWN.
//
// markOwnedServer() below brings up a detached tmux server running `sleep 86400`.
// The obligation to stop it used to sit with each caller, and several suites
// simply never did — so every focused or full run left live servers behind, each
// holding a socket and a sleeping child for 24 hours. That is a verification
// defect rather than untidiness: they accumulate across runs until tmux can no
// longer fork ("fork failed: No space left on device"), which takes the suite
// that proves the product works out of service entirely.
//
// Registering at the point of CREATION and releasing on process exit keeps the
// obligation with the code that incurs it, so a caller added later cannot forget
// it. `process.on('exit')` admits only synchronous work, hence execFileSync.
const FIXTURE_SERVERS = new Map();

/** The session and payload every fixture server is stood up with. */
export const FIXTURE_SESSION = '_keepalive';
const FIXTURE_KEEPALIVE = 'sleep 86400';
const TMUX_TIMEOUT_MS = 20000;

// A FIXTURE MUST NEVER BE ABLE TO TAKE DOWN A SERVER IT DID NOT CREATE.
//
// The pair below — `kill-server` plus an unlink of the socket file — is genuinely
// destructive, so the set of sockets it may be pointed at is a boundary rather
// than housekeeping. It used to be two literals, `default` and $PW_TMUX_SOCKET,
// and neither of them describes the server the test process is actually INSIDE.
//
// A ProjectWorkbench terminal runs this suite from within tmux, which exports
// `TMUX=<socket-path>,<server-pid>,<session-id>`; that first field names the LIVE
// server. Where the live socket is not called `default` and PW_TMUX_SOCKET is not
// in the runner's environment — a terminal on a named socket, a wrapper that
// scrubs PW_TMUX_*, a container hop — the inherited name passed straight through
// and cleanup would have killed the running workbench. `-L NAME` beats an
// inherited $TMUX and resolves to $TMUX_TMPDIR/tmux-<uid>/NAME (verified against
// tmux 3.4 in test/tmux-fixture-cleanup-authority.test.mjs), so the kill lands.
//
// So the inherited server is DERIVED from $TMUX rather than guessed at by name.

/**
 * $TMUX as tmux writes it: the socket path, then the server pid, then the session
 * id. The path is matched greedily so the two trailing fields are taken off the
 * RIGHT — a socket path may itself contain commas, and reading up to the first one
 * truncates it (see inheritedTmuxIdentity).
 */
const TMUX_ENV_SHAPE = /^(.+),(\d+),(\d*)$/;

/**
 * The tmux server this process is running inside, as named by $TMUX.
 *
 * Reported as `{ present, ambiguous, names, paths }`.
 *
 * THE PATH IS PARSED FROM THE RIGHT. tmux appends `,<server-pid>,<session-id>` to
 * the socket path, and `-L` rejects only `/` — a comma is a perfectly legal socket
 * name. `tmux -L 'pwcomma-a,sentinel'` on tmux 3.4 really does produce
 * `TMUX=/tmp/.../pwcomma-a,sentinel,2324856,0`, so taking everything before the
 * FIRST comma derives `pwcomma-a` for a server actually called `pwcomma-a,sentinel`
 * and leaves the live server unprotected under the name it really has. Only the two
 * trailing numeric fields are fixed-shape, so only they can be split off.
 *
 * `ambiguous` is the case that matters: $TMUX is set — so this process IS inside
 * some server — but the value is not that documented shape, or yields no usable
 * socket name. That must never be read as "nothing to protect", because the one
 * thing it does establish is that a live server is in scope and cannot be
 * identified. Whatever CAN be gleaned is still protected alongside it: refusing too
 * much costs a leaked private server, and refusing too little costs the workbench.
 */
export function inheritedTmuxIdentity(env = process.env) {
  const raw = env.TMUX;
  if (typeof raw !== 'string' || raw === '') return { present: false, ambiguous: false, names: [], paths: [] };
  const names = new Set();
  const paths = new Set();
  // Stored verbatim: the socket path tmux uses is the one it was given, so trimming
  // would protect a name the live server does not answer to.
  const consider = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return false;
    paths.add(candidate);
    const base = path.basename(candidate);
    if (!base || base === '.' || base === '..') return false;
    names.add(base);
    return true;
  };

  const documented = TMUX_ENV_SHAPE.exec(raw);
  if (documented) return { present: true, ambiguous: !consider(documented[1]), names: [...names], paths: [...paths] };

  // Not the documented shape, so the socket cannot be identified: ambiguous, and
  // glean only from a value that could still BE a socket path on its own.
  if (!raw.includes(',')) consider(raw);
  return { present: true, ambiguous: true, names: [...names], paths: [...paths] };
}

const INHERITED = inheritedTmuxIdentity();

/** Socket NAMES that name a server no fixture created: shared, configured, inherited. */
const NOT_A_FIXTURE_SOCKET = new Set(
  ['default', process.env.PW_TMUX_SOCKET, ...INHERITED.names].filter(Boolean),
);

/** Socket PATHS of the same, so the unlink half is checked on its own terms too. */
const NOT_A_FIXTURE_SOCKET_PATH = new Set(INHERITED.paths);

/**
 * Why this socket may not serve as a PRIVATE FIXTURE SERVER, or null if it may.
 *
 * The one decision, asked by every path that creates, marks or reaps one, and
 * always BEFORE that path's first tmux invocation. Creating and marking are not
 * the harmless half: markOwnedServer() stamps the production owner marker with
 * `set-option -s`, which mutates whatever server the name resolves to. So the
 * ambiguous case withholds the right to TOUCH a server, not merely to kill one —
 * while $TMUX cannot be read, any name might be the live server, and a refusal
 * that had already run `has-session` would have addressed it regardless.
 */
export function fixtureSocketRefusal(socket) {
  if (typeof socket !== 'string' || socket.trim() === '') {
    return 'a fixture socket must be a non-empty tmux -L socket name';
  }
  if (socket.includes('/')) {
    return 'a fixture socket is an -L NAME, never a socket path (tmux rejects a name containing "/")';
  }
  if (NOT_A_FIXTURE_SOCKET.has(socket)) {
    return 'it names the shared default server, $PW_TMUX_SOCKET, or the server $TMUX says this process '
      + 'is running inside — none of which this fixture created';
  }
  if (INHERITED.present && INHERITED.ambiguous) {
    return `$TMUX is ${JSON.stringify(process.env.TMUX)}, which names no socket that can be read out of it: `
      + 'this process is inside a server it cannot identify, so no name can be proven private and no '
      + 'fixture may address one rather than guessing';
  }
  return null;
}

/**
 * Refuse, loudly, to point a fixture at a server it did not create.
 *
 * Throwing is right here even for the ambiguous case, which cannot occur under a
 * real tmux: a suite that stops is recoverable, and a suite that quietly stamps
 * the production owner marker onto the live workbench is not.
 */
export function assertPrivateFixtureSocket(socket) {
  const refusal = fixtureSocketRefusal(socket);
  if (refusal) throw new Error(`fixture refused tmux socket ${JSON.stringify(socket)}: ${refusal}`);
  return socket;
}

/** Where tmux keeps its sockets, so a killed server leaves no socket file either. */
function tmuxSocketDir() {
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
}

/**
 * Grant cleanup authority over one private server and return the teardown handle.
 *
 * Refusing returns null and warns rather than throwing: the cost of refusing is a
 * leaked private server, and the cost of guessing wrong is killing the workbench
 * this suite is running inside. Only one of those is recoverable.
 */
function grantFixtureCleanup(socket) {
  const refusal = fixtureSocketRefusal(socket);
  if (refusal) {
    process.emitWarning(
      `refusing cleanup authority over tmux socket ${JSON.stringify(socket)}: ${refusal}`,
      'PwFixtureCleanup',
    );
    return null;
  }
  const existing = FIXTURE_SERVERS.get(socket);
  if (existing) return existing;
  const handle = {
    socket,
    // Resolved when authority is granted — the directory in force when the server
    // was created — so the unlink cannot follow a later TMUX_TMPDIR somewhere else.
    socketPath: path.join(tmuxSocketDir(), socket),
    release() { releaseFixtureTmuxServer(handle); },
  };
  FIXTURE_SERVERS.set(socket, handle);
  return handle;
}

/**
 * Stand a PRIVATE fixture tmux server up and take on its teardown in one step, so
 * cleanup authority follows creation instead of being handed a bare string.
 *
 * Returns the teardown handle (`release()` reaps just this one), or null if the
 * server came up but authority was refused.
 */
export function createFixtureTmuxServer({ socket, session = FIXTURE_SESSION, command = FIXTURE_KEEPALIVE, env } = {}) {
  assertPrivateFixtureSocket(socket);
  const options = { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS };
  if (env) options.env = env;
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', session, command], options);
  return grantFixtureCleanup(socket);
}

/**
 * Record a private server THIS process brought up, to be killed when it exits.
 * Kept for callers that create the server themselves; prefer
 * createFixtureTmuxServer(), which cannot be handed a socket it did not create.
 */
export function registerFixtureTmuxServer(socket) {
  grantFixtureCleanup(socket);
  return socket;
}

function releaseFixtureTmuxServer(handle) {
  FIXTURE_SERVERS.delete(handle.socket);
  // Asked again at the moment of the kill, not only when authority was granted:
  // the refusal is the whole safety of this pair, so it guards the destruction
  // itself rather than a decision taken earlier.
  if (fixtureSocketRefusal(handle.socket) || NOT_A_FIXTURE_SOCKET_PATH.has(handle.socketPath)) return;
  try {
    execFileSync('tmux', ['-L', handle.socket, 'kill-server'], { stdio: 'ignore', timeout: TMUX_TIMEOUT_MS });
  } catch { /* already gone */ }
  // kill-server does not remove its own socket file on this system, so without
  // this a run still leaks an (empty, but accumulating) socket special file.
  try { fs.rmSync(handle.socketPath, { force: true }); } catch { /* fine */ }
}

/** Kill every server this process registered. Idempotent; safe to call early. */
export function killFixtureTmuxServers() {
  for (const handle of [...FIXTURE_SERVERS.values()]) releaseFixtureTmuxServer(handle);
  FIXTURE_SERVERS.clear();
}

process.on('exit', killFixtureTmuxServers);

// Put the REAL helper on PATH — not a stub. A fixture that stubbed it would stop
// testing the thing the seams actually call.
export function installOwnerHelper(dir) {
  const bin = path.join(dir, 'owner-bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'pw-tmux-assert-owner');
  try {
    fs.symlinkSync(REAL_HELPER, link);
  } catch {
    fs.copyFileSync(REAL_HELPER, link);
    fs.chmodSync(link, 0o755);
  }
  return bin;
}

function tmuxOn(socket, args) {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
}

// Bring the private server up (if it is not already), stamp the owner marker the
// way the owner unit does, and write a controlled /proc entry placing that exact
// server pid in the expected owner cgroup.
export function markOwnedServer({ socket, dir, env = {} }) {
  // Asserted OUTSIDE the try below, and before any tmux runs. Stamping the owner
  // marker on the shared server, or standing a keepalive session up on it, would
  // be mutating the live workbench — and the catch that absorbs a lost creation
  // race would swallow the evidence that it had happened.
  assertPrivateFixtureSocket(socket);
  // A server only exists once a session does — `tmux start-server` exits
  // immediately with no sessions (verified against tmux 3.4).
  try {
    tmuxOn(socket, ['has-session', '-t', FIXTURE_SESSION]);
  } catch {
    // Creation and teardown in one step, so authority follows the act that
    // incurred it rather than being granted from a bare socket string.
    try { createFixtureTmuxServer({ socket }); } catch { /* raced */ }
  }
  try { tmuxOn(socket, ['set-option', '-s', OWNER_MARKER_OPTION, OWNER_MARKER_VALUE]); } catch { /* no server */ }

  const procRoot = path.join(dir, 'proc');
  let pid = null;
  try { pid = tmuxOn(socket, ['display-message', '-p', '#{pid}']); } catch { /* no server */ }
  if (pid && /^\d+$/.test(pid)) {
    fs.mkdirSync(path.join(procRoot, pid), { recursive: true });
    // Resolved by PRODUCTION's own function, so the fixture cannot drift from the
    // unit the deployment actually expects (host vs container owner).
    fs.writeFileSync(path.join(procRoot, pid, 'cgroup'), `0::/system.slice/${expectedOwnerCgroup(env)}\n`);
  }
  return { procRoot, pid };
}

// The environment a shipped unit provides. `PW_TMUX_REQUIRE_CGROUP=1` matches
// systemd/pw-tmux-server.service and the client units.
export function ownerEnv({ procRoot }) {
  return { PW_TMUX_PROC_ROOT: procRoot, PW_TMUX_REQUIRE_CGROUP: '1' };
}

// One call for the common case: helper on PATH, server marked, env produced.
export function ownedTmuxFixture({ socket, dir, basePath = process.env.PATH, env = {} }) {
  const bin = installOwnerHelper(dir);
  // A fixture with no explicit mode models the backward-compatible host owner.
  // Return that decision to the spawned helper as well as using it to build fake
  // /proc; otherwise a container-mode parent makes the two halves disagree.
  const fixtureEnv = { PW_DEPLOY_MODE: 'host', ...env };
  const { procRoot } = markOwnedServer({ socket, dir, env: fixtureEnv });
  return { PATH: `${bin}:${basePath}`, ...fixtureEnv, ...ownerEnv({ procRoot }) };
}
