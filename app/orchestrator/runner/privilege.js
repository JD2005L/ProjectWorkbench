// Dropping privilege before the coding CLI is launched.
//
// Host-mode ProjectWorkbench runs the dashboard as root — it binds a privileged port, reads
// /etc/project-workbench, and manages other users' terminals — while every project terminal runs as
// `admin`. `TmuxAdapter` already takes that into account and execs `sudo -u admin tmux …`. The
// coding backend did not, and the consequences were not cosmetic:
//
//   * **Authentication.** A subscription sign-in lives in the *operator's* home directory. A root
//     process cannot see it, so `claude auth status` reported signed-out and the live instance
//     published `backend: down, auth method: unknown` while the subscription was perfectly healthy.
//
//   * **Ownership.** A phase that did run would edit an admin-owned workspace as root, leaving
//     root-owned files behind — in the working tree, in `.git`, and in whatever the agent created.
//     The human terminal for that same project runs as admin and cannot then write them.
//
// The rule this module enforces is therefore: in host mode, a Claude subprocess runs as the
// configured non-root user or it does not run at all. There is deliberately no path that falls back
// to root — a silent fallback is how the failure above stayed invisible in the first place.
//
// What it does NOT do is weaken the identity of the thing being launched. The drop is a prefix in
// front of a fixed argv:
//
//     /usr/bin/sudo -n -H -u '#1000' --preserve-env=HTTPS_PROXY,… -- /abs/claude.exe --model …
//
// `sudo` is looked up at an absolute path and checked to be a root-owned setuid binary that is not
// group- or world-writable — never resolved through PATH. The CLI is required to be an absolute
// path so neither PATH nor sudo's `secure_path` chooses the program, and the argv is built by the
// backend, not by a caller. Fingerprinting continues to hash, stat and ELF-check *the CLI*, never
// the helper.
//
// The child's environment comes from sudo's `env_reset` — built from the target's passwd entry,
// with PATH from sudoers' vetted `secure_path` — plus the short list of names in `PRESERVED_ENV`.
// Names, not values: an earlier version composed the environment as `env -i -- NAME=value …`
// arguments, which put the service's entire environment into `/proc/<pid>/cmdline`, world-readable
// for the length of every phase. `/proc/<pid>/environ`, where sudo carries the preserved values, is
// owner-only.

import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * A POSIX-portable account name.
 *
 * Deliberately narrower than what `useradd` will accept. The name becomes an argv element in front
 * of a command run as root, so the value of a permissive pattern is negative: `-u`, `--`, a name
 * with a space, or anything that could be read as an option is refused here rather than reasoned
 * about at the sudo command line. A trailing `$` (a Samba machine account) is refused for the same
 * reason — nothing on this path should be one.
 */
export const DROP_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,30}$/;

/** Account names that are never a privilege *drop*, whatever the passwd database says. */
const ROOT_NAMES = Object.freeze(new Set(['root', 'toor']));

/** How a privilege drop refused to happen. Each is a distinct operator fault with its own fix. */
export const PrivilegeFailure = Object.freeze({
  UNKNOWN_DEPLOY_MODE: 'unknown_deploy_mode',
  USER_LOOKUP_FAILED: 'user_lookup_failed',
  HELPER_REFUSED: 'helper_refused',
  USER_MISSING: 'user_missing',
  USER_MALFORMED: 'user_malformed',
  USER_IS_ROOT: 'user_is_root',
  USER_UNRESOLVABLE: 'user_unresolvable',
  USER_RESOLVES_TO_ROOT: 'user_resolves_to_root',
  USER_HOME_INVALID: 'user_home_invalid',
  SUDO_UNRESOLVABLE: 'sudo_unresolvable',
  SUDO_NOT_ABSOLUTE: 'sudo_not_absolute',
  SUDO_NOT_PRIVILEGED: 'sudo_not_privileged',
  SUDO_WRITABLE: 'sudo_writable',
  EXECUTABLE_NOT_ABSOLUTE: 'executable_not_absolute',
});

/**
 * A refusal to launch, carrying `kind: 'privilege_drop_failed'`.
 *
 * The backend's failure classifier keys on `kind`, so a drop that cannot be made reaches the
 * orchestrator as a configuration fault with its own message rather than being folded into
 * "the phase failed" — which is what an operator would have to debug from otherwise.
 */
export class PrivilegeDropError extends Error {
  constructor(failure, detail, { transient = false } = {}) {
    super(detail);
    this.name = 'PrivilegeDropError';
    this.failure = failure;
    this.kind = 'privilege_drop_failed';
    // Whether asking again could reasonably give a different answer. A misconfigured account never
    // becomes usable by being asked twice; a directory that timed out might. It matters because the
    // decision is memoised, and caching a network blip for the life of the process would take the
    // coding backend down until somebody restarted the service.
    this.transient = transient;
  }
}

/** Validate the configured account name. Returns the name, or throws. */
export function validateDropUser(user) {
  if (user === undefined || user === null || String(user).trim() === '') {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_MISSING,
      'host mode requires PW_ORCHESTRATOR_TMUX_USER to name the unprivileged account the coding CLI runs as',
    );
  }
  const name = String(user).trim();
  if (!DROP_USER_PATTERN.test(name)) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_MALFORMED,
      'PW_ORCHESTRATOR_TMUX_USER is not a plain POSIX account name',
    );
  }
  if (ROOT_NAMES.has(name)) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_IS_ROOT,
      'PW_ORCHESTRATOR_TMUX_USER names the superuser, which is not a privilege drop',
    );
  }
  return name;
}

/**
 * Resolve the account through the passwd database.
 *
 * `getent passwd` rather than a parse of /etc/passwd: the answer has to be the one the system will
 * actually give `sudo`, which on an LDAP-joined host — and this product ships LDAP staging — is not
 * in the local file at all. Fixed argv, no shell, and the *name* is validated before it gets here.
 */
export async function resolveDropUser(user, { exec = execFileAsync, getentExecutable = '/usr/bin/getent', timeoutMs = 10_000 } = {}) {
  const name = validateDropUser(user);

  let lines = [];
  try {
    const { stdout } = await exec(getentExecutable, ['passwd', name], { timeout: timeoutMs });
    lines = String(stdout).split('\n').filter((l) => l.startsWith(`${name}:`));
  } catch (err) {
    // `getent` exits 2 when there is simply no such key — an answer, and a permanent one. Anything
    // else (a timeout, EACCES, a directory that did not respond) is the lookup failing rather than
    // the account being absent, and the two must not collapse into the same verdict: the first is
    // an operator's mistake, the second is a blip that would otherwise be cached forever.
    if (err?.code !== 2) {
      throw new PrivilegeDropError(
        PrivilegeFailure.USER_LOOKUP_FAILED,
        `the passwd database could not be queried for '${name}'`,
        { transient: true },
      );
    }
    lines = [];
  }
  if (lines.length === 0) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_UNRESOLVABLE,
      `the configured unprivileged account '${name}' does not exist on this host`,
    );
  }
  if (lines.length > 1) {
    // Two sources answered — a local entry and a directory one, say — and they need not agree on
    // the uid. Picking the first would be picking one at random.
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_UNRESOLVABLE,
      `the account '${name}' resolves to more than one passwd entry on this host`,
    );
  }

  // name:passwd:uid:gid:gecos:home:shell. The fields are read positionally, so anything other than
  // exactly seven means a field carried a colon — a GECOS is quite capable of it through a
  // directory — and every index after it would describe the wrong thing. `fields[5]` would then
  // hold part of the comment, which is accepted as a home directory if it happens to start with a
  // slash. Refused rather than parsed harder.
  const fields = lines[0].split(':');
  if (fields.length !== 7) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_UNRESOLVABLE,
      `the passwd entry for '${name}' is not in the expected seven-field form`,
    );
  }
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5] ?? '';
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_UNRESOLVABLE,
      `the passwd entry for '${name}' could not be read`,
    );
  }
  if (uid === 0 || gid === 0) {
    // A non-root *name* mapped to uid 0 is the classic backdoor account, and running as it would be
    // no drop at all while looking like one in every log line.
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_RESOLVES_TO_ROOT,
      `the configured account '${name}' resolves to a superuser id, which is not a privilege drop`,
    );
  }
  if (!home || !path.isAbsolute(home)) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_HOME_INVALID,
      `the configured account '${name}' has no absolute home directory, so the subscription sign-in could not be read`,
    );
  }
  return { name, uid, gid, home };
}

/** Candidate locations for sudo when the operator has not configured one. */
const SUDO_CANDIDATES = Object.freeze(['/usr/bin/sudo', '/bin/sudo']);

/**
 * How often a live launch's descendant tree is re-enumerated.
 *
 * Cheap relative to what it buys: a `/proc` scan is not free, but a launch normally runs for many
 * multiples of this interval, so there are many chances to see a descendant before it could ever be
 * orphaned by a kill this module did not send itself. Short enough that a process a check backgrounds
 * and that lives for even a second is seen well before `execFile`'s own `timeout`/`signal` handling
 * could kill the direct child out from under it.
 */
const DESCENDANT_POLL_MS = 200;

/**
 * A plain environment name.
 *
 * Used to keep the composed environment expressible: a name containing `=` or beginning with `-`
 * does not occur in a real environment and cannot be handled unambiguously anywhere downstream.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables carried across the drop, by name.
 *
 * sudo's `env_reset` builds the child's environment from the target's passwd entry — which is the
 * right default, and is why `PATH` comes from sudoers' vetted `secure_path` rather than from
 * whatever the service inherited. But it also means the launch would lose the handful of variables a
 * deployment genuinely needs, so those are named here and preserved by name.
 *
 * Names, never values: `--preserve-env=<list>` carries the *values* through sudo's own environment,
 * where they stay in `/proc/<pid>/environ` (mode 0400). An earlier version of this module composed
 * the environment as `env -i -- NAME=value …` arguments instead, which put the entire service
 * environment — service tokens, directory credentials, everything — into `/proc/<pid>/cmdline`,
 * which is mode 0444 and readable by every local user for the whole length of a phase. That is a
 * strictly worse place to keep a secret than the one it replaced.
 *
 * The list is deliberately short and contains nothing secret: connectivity, trust anchors and
 * locale. Anything not here does not cross.
 */
const PRESERVED_ENV = Object.freeze([
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);

/**
 * sudo declining to run anything, as distinct from sudo mentioning itself.
 *
 * Deliberately narrow, and deliberately excluding `unable to resolve host`, which is a warning sudo
 * prints on every invocation on a host whose `/etc/hosts` does not name it — a benign line that a
 * looser match turned into "this instance cannot drop privilege".
 */
const SUDO_REFUSAL = new RegExp([
  '^sudo: a (password|terminal) is required',
  '^sudo: no tty present',
  '^sudo: unknown user',
  '^sudo: (sorry, )?(you |user )',
  '^sudo: unable to (execute|change to runas|set runas|stat|open|initialize|resolve uid)',
  '^sudo: (parse error|syntax error)',
  // A misconfigured `PW_ORCHESTRATOR_CLAUDE_BIN` is the likeliest fault of all, and sudo reports it
  // rather than the kernel — so the ENOENT that used to reach `unavailable` never arrives, and
  // without this the operator is sent to look at the project instead of at the path they set.
  '^sudo: .*(command not found|is not allowed to|not permitted|no such file or directory)',
].join('|'), 'i');

/**
 * Resolve and vet the privilege-drop helper.
 *
 * Never through PATH: PATH is the operator's environment, and a `sudo` chosen from it is a program
 * of somebody else's choosing standing between this service and the CLI. The checks below are the
 * ones that distinguish the real thing from a stand-in — root-owned, setuid, and not writable by
 * anyone else.
 */
export async function resolveSudo(configured, { stat = fsp.stat } = {}) {
  const candidates = configured ? [String(configured)] : SUDO_CANDIDATES;
  if (configured && !path.isAbsolute(String(configured))) {
    throw new PrivilegeDropError(
      PrivilegeFailure.SUDO_NOT_ABSOLUTE,
      'PW_ORCHESTRATOR_SUDO_BIN must be an absolute path',
    );
  }

  for (const candidate of candidates) {
    let info;
    try {
      // Follows symlinks deliberately: the checks must describe the file that will actually be
      // executed, not the name pointing at it.
      info = await stat(candidate);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.uid !== 0 || (info.mode & 0o4000) === 0) {
      throw new PrivilegeDropError(
        PrivilegeFailure.SUDO_NOT_PRIVILEGED,
        `${candidate} is not a root-owned setuid binary, so it cannot drop privilege`,
      );
    }
    if ((info.mode & 0o022) !== 0) {
      // A group- or world-writable setuid root binary is not a control, it is the vulnerability.
      throw new PrivilegeDropError(
        PrivilegeFailure.SUDO_WRITABLE,
        `${candidate} is writable by users other than its owner and must not be trusted to drop privilege`,
      );
    }
    return candidate;
  }

  throw new PrivilegeDropError(
    PrivilegeFailure.SUDO_UNRESOLVABLE,
    'no usable sudo binary was found, so the coding CLI cannot be run as the unprivileged account',
  );
}

/**
 * Decides, once, how a Claude subprocess is launched — and then builds every invocation.
 *
 * The plan is resolved lazily and memoised, including its failure: a host whose configuration
 * cannot produce a drop must fail the same way on the tenth call as on the first, rather than
 * re-probing until a transient success lets a root launch through.
 */
export class PrivilegeDropper {
  constructor({
    // Defaults to the mode that *requires* a drop. A safety-critical default must fail towards the
    // control, not away from it: a caller that forgets to pass a mode gets the strict path and a
    // loud failure, rather than a silent root launch.
    deployMode = 'host',
    user = '',
    sudoExecutable = '',
    forbiddenEnv = [],
    forbiddenEnvPrefixes = [],
    exec = execFileAsync,
    stat = fsp.stat,
    // Injected so the decision is deterministic under test and does not depend on who happens to
    // be running the suite.
    currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
    currentGid = () => (typeof process.getgid === 'function' ? process.getgid() : null),
    resolveUser = resolveDropUser,
    resolveHelper = resolveSudo,
    // How long a cancelled or timed-out launch is given to actually die before it is killed
    // outright. Bounded, and awaited: a caller that has been told the phase stopped must not still
    // have an agent writing to the workspace behind it.
    terminationGraceMs = 5_000,
  } = {}) {
    this.deployMode = deployMode;
    this.user = user;
    this.sudoExecutable = sudoExecutable;
    this.forbiddenEnv = Object.freeze([...forbiddenEnv]);
    this.forbiddenEnvPrefixes = Object.freeze([...forbiddenEnvPrefixes]);
    this.exec = exec;
    this.stat = stat;
    this.currentUid = currentUid;
    this.currentGid = currentGid;
    this.resolveUser = resolveUser;
    this.resolveHelper = resolveHelper;
    this.terminationGraceMs = terminationGraceMs;
    this._plan = null;
  }

  /**
   * How this instance will launch the CLI.
   *
   * Three outcomes, and only one of them skips the whole apparatus. Container mode is `passthrough`:
   * the container already runs as the unprivileged user, there is no root to drop from, and the
   * launch is exactly what it was before this module existed. Host mode is `sudo`, except in the one
   * case that is already correct — this process *is* the configured account — which is `no_drop`.
   *
   * `no_drop` is not container mode wearing a different hat. Every other host-mode control still
   * applies to it: the account is still validated and resolved, the CLI must still be an absolute
   * path, and the environment is still corrected. An earlier version returned a bare passthrough
   * here, which meant a service started as `sudo -u admin node server.js` (uid 1000, `HOME=/root`)
   * launched the CLI with root's HOME and a PATH-resolved executable — reproducing the exact bug
   * this module exists to fix, and calling it a success.
   */
  async plan() {
    if (!this._plan) {
      const attempt = this._resolvePlan();
      this._plan = attempt;
      // A refusal is held — deciding it once is what stops a flapping probe from eventually letting
      // a launch through. But a *lookup* that failed decided nothing, and holding that would take
      // the backend down for the life of the process over one unanswered directory query. Retrying
      // it cannot produce a root launch: the outcomes are still refuse, or drop to the account that
      // has been validated and resolved.
      attempt.catch((err) => {
        if (err?.transient && this._plan === attempt) this._plan = null;
      });
    }
    return this._plan;
  }

  async _resolvePlan() {
    if (this.deployMode === 'container') return Object.freeze({ mode: 'passthrough', reason: 'container' });
    if (this.deployMode !== 'host') {
      // Not a mode this module knows how to be safe in. `loadOrchestratorConfig` normalises to one
      // of the two, so reaching this means a caller constructed the dropper by hand — and guessing
      // on its behalf is how a typo becomes a root launch.
      throw new PrivilegeDropError(
        PrivilegeFailure.UNKNOWN_DEPLOY_MODE,
        `unknown deployment mode ${JSON.stringify(this.deployMode)}: the coding CLI will not be launched`,
      );
    }

    // Validated before anything is resolved or executed, so a malformed name never reaches getent.
    const target = await this.resolveUser(this.user, { exec: this.exec });

    const uid = this.currentUid();
    const gid = this.currentGid();
    // Both ids, not just the uid: a process running as the account but in another primary group
    // creates files the account's own terminal may not be able to write, which is half of what this
    // module exists to prevent. If either differs, the helper decides the identity.
    if (uid !== null && uid === target.uid && (gid === null || gid === target.gid)) {
      return Object.freeze({ mode: 'no_drop', reason: 'already_target_user', target });
    }

    const sudo = await this.resolveHelper(this.sudoExecutable, { stat: this.stat });
    return Object.freeze({ mode: 'sudo', sudo, target });
  }

  /** The environment the CLI is launched with, corrected for the account it now runs as. */
  dropEnv(env, target) {
    // `env ?? process.env`, because that is what the child would have inherited had nothing been
    // passed — `execFile` defaults to the process environment. With `env -i` in the launch, taking
    // `{}` here would have handed the CLI a three-variable environment with no PATH, which is not
    // "the same launch as before, as somebody else"; it is a different launch.
    const next = { ...(env ?? process.env) };
    for (const key of this.forbiddenEnv) delete next[key];
    // A prefix rule as well as a list, because the list is a losing race: the CLI reads
    // `ANTHROPIC_*` names this build has never heard of, and a variable that arrives with the next
    // release must not be trusted merely because nobody has enumerated it yet.
    for (const key of Object.keys(next)) {
      if (this.forbiddenEnvPrefixes.some((prefix) => key.startsWith(prefix))) delete next[key];
      // A name that cannot be expressed as `NAME=value` is dropped here rather than only in the
      // sudo branch, so the dropped and the already-the-account launches compose the same
      // environment instead of nearly the same one.
      else if (!ENV_NAME.test(key)) delete next[key];
    }
    // sudo's own `env_reset` sets these from the target's passwd entry, and `-H` forces HOME. They
    // are set here as well so the launch is correct on a host whose sudoers has env_reset disabled —
    // where the child would otherwise inherit root's HOME and read root's (absent) sign-in.
    next.HOME = target.home;
    next.USER = target.name;
    next.LOGNAME = target.name;
    // Stale sudo bookkeeping from an outer invocation would describe a different launch than this
    // one; sudo sets its own for the child.
    for (const key of Object.keys(next)) {
      if (key.startsWith('SUDO_')) delete next[key];
    }
    return next;
  }

  /**
   * Translate a system-utility launch into the argv actually executed.
   *
   * Unlike `invocation`, this does NOT require an absolute path. System utilities (git, gh) are
   * resolved through sudo's vetted `secure_path`, which is acceptable because they are not
   * fingerprinted — their identity is not part of an attestation claim. The only requirement is
   * that they run as the unprivileged account so they cannot create root-owned artifacts.
   */
  async commandInvocation(file, argv, options = {}, resolved = null) {
    const plan = resolved ?? await this.plan();
    if (plan.mode === 'passthrough') return { file, argv: [...argv], options: { ...options } };

    const childEnv = this.dropEnv(options.env, plan.target);
    if (plan.mode === 'no_drop') {
      return { file: String(file), argv: [...argv], options: { ...options, env: childEnv } };
    }

    return {
      file: plan.sudo,
      argv: [
        '-n', '-H', '-u', `#${plan.target.uid}`,
        `--preserve-env=${PRESERVED_ENV.join(',')}`,
        '--', String(file), ...argv,
      ],
      options: { ...options, env: childEnv },
    };
  }

  /**
   * Wrap an exec-shaped function for system utilities (git, gh, check commands).
   *
   * Like `wrap` but without the absolute-path enforcement — system utilities are not fingerprinted,
   * so PATH/`secure_path` choosing the program is not the same hazard it is for the CLI. Termination
   * tracking is NOT simpler here: a check command is exactly as capable of backgrounding or
   * `setsid`-ing something of its own as the coding CLI is of starting a tool subprocess, and a
   * timeout or an abort must confirm that whole tree is gone before telling the caller the command
   * stopped. Shares `_execTracked` with `wrap` for exactly that reason.
   */
  wrapCommand(exec) {
    return async (file, argv, options = {}) => {
      const plan = await this.plan();
      const invocation = await this.commandInvocation(file, argv, options, plan);
      return this._execTracked(exec, invocation, plan, options);
    };
  }

  /**
   * Run one invocation, making a best-effort attempt to kill the whole descendant tree before a
   * timeout or an abort reaches the caller. Shared by `wrap` and `wrapCommand`, which differ only in
   * how the invocation itself was built.
   */
  async _execTracked(exec, invocation, plan, options) {
    const running = exec(invocation.file, invocation.argv, invocation.options);
    // `promisify(execFile)` exposes the child on the promise. Absent — an injected runner in a
    // test, say — there is nothing to reap and nothing to wait for.
    const child = running?.child ?? null;

    // Enumerated continuously from the moment the child exists, not only once the launch has
    // already failed — `execFile`'s own `timeout`/`signal` handling kills the direct child through a
    // path this module cannot see and does not control, and once that kill lands the kernel
    // reparents whatever the child had started to init, unreachable from `pid` at all. Polling while
    // the launch is still alive is what lets `ensureTerminated`'s best-effort kill reach as much of
    // the tree as possible — but it does NOT make "confirmed" a provable claim; see there for why.
    const tracked = child ? new Map() : null; // pid -> /proc start-time, for identity before signalling
    // Tracks the currently-running tick's promise, if any, so a caller entering the catch block can
    // await it rather than starting `ensureTerminated`'s own mutation of `tracked` while a tick is
    // still in the middle of reading `/proc` and writing to the very same map.
    let pollInFlight = null;
    const poller = tracked ? setInterval(() => {
      pollInFlight = rescanTracked(tracked, [child.pid, ...tracked.keys()])
        .catch(() => {})
        .finally(() => { pollInFlight = null; });
    }, DESCENDANT_POLL_MS) : null;
    if (typeof poller?.unref === 'function') poller.unref();

    try {
      return await running;
    } catch (err) {
      if (poller) clearInterval(poller);
      // Never let `ensureTerminated` start reading and mutating `tracked` while a poll tick already
      // in flight is doing the same thing — the interval is stopped above, but a tick that started
      // just before is still awaiting its own `/proc` reads and would otherwise race the rescan
      // `ensureTerminated` is about to perform on the identical map.
      if (pollInFlight) await pollInFlight;
      // Only a launch that was actually KILLED — by this module's own timeout/abort, or by anything
      // else that reaches the child as a signal — needs a termination verdict at all. A command that
      // simply ran to completion and exited non-zero (a failing check, `git rev-parse` outside a
      // repository) rejects through this exact same catch, and must not be confused with one: every
      // check a caller runs is *expected* to fail sometimes, and treating an ordinary failing exit
      // code as "termination unconfirmed" would fence a project on a red test rather than on anything
      // resembling a live, unaccounted-for process. `err.signal`/`err.killed` are null for a normal
      // exit and set only when a signal ended the process — the same discriminator
      // `classifyBackendFailure` already uses to tell a timeout or a crash from a plain failure.
      const wasKilled = Boolean(err?.signal) || Boolean(err?.killed) || Boolean(options.signal?.aborted);
      // Await the death of what was launched before telling the caller it stopped. The verdict is
      // carried on the error rather than dropped: a cancellation that could not be carried out must
      // not be indistinguishable from one that was.
      if (child && wasKilled) err.terminationConfirmed = await this.ensureTerminated(child, { tracked });

      const refusal = this.helperFailure(err, plan);
      if (refusal) throw refusal;

      // A kill that raced the launch can surface as EPERM or ESRCH rather than as an abort, and a
      // cancellation reported as a process failure blocks work that was deliberately stopped. If the
      // caller cancelled, the cancellation is what happened.
      if (options.signal?.aborted && err?.name !== 'AbortError') {
        throw Object.assign(new Error('the launch was cancelled'), {
          name: 'AbortError', kind: 'cancelled', terminationConfirmed: err?.terminationConfirmed,
        });
      }
      throw err;
    } finally {
      if (poller) clearInterval(poller);
    }
  }

  /**
   * Translate one launch into the argv actually executed.
   *
   * Exposed separately from `wrap` so a test can assert the exact argv and environment without
   * spawning anything.
   */
  async invocation(file, argv, options = {}, resolved = null) {
    const plan = resolved ?? await this.plan();
    if (plan.mode === 'passthrough') return { file, argv: [...argv], options: { ...options } };

    if (!file || !path.isAbsolute(String(file))) {
      // Otherwise the name is resolved through PATH — or, under sudo, through its `secure_path`,
      // which is the same lookup by another name. Either way the file that ran and the file that
      // was fingerprinted need not be the same, and on this product PATH holds a wrapper that
      // appends argv of its own.
      throw new PrivilegeDropError(
        PrivilegeFailure.EXECUTABLE_NOT_ABSOLUTE,
        'PW_ORCHESTRATOR_CLAUDE_BIN must be an absolute path to the real coding CLI before it can be '
        + 'run as the unprivileged account: a bare name would be resolved through PATH',
      );
    }

    const childEnv = this.dropEnv(options.env, plan.target);
    // Already the account: the environment still has to be right, but there is nothing to drop.
    if (plan.mode === 'no_drop') {
      return { file: String(file), argv: [...argv], options: { ...options, env: childEnv } };
    }

    return {
      file: plan.sudo,
      argv: [
        // -n so a sudoers rule needing a password fails immediately instead of hanging until the
        // phase deadline; -H so HOME is the target's even where env_reset is off; -- so no later
        // element can be read as an option to sudo.
        '-n', '-H', '-u',
        // The runas target is the *uid* that was validated, not the name that resolved to it. sudo
        // re-resolves a name through NSS at exec time, and the plan is held for the lifetime of the
        // process: a directory change that repointed the name at uid 0 in between would have been
        // obeyed, and every log line would still have said the launch was unprivileged.
        `#${plan.target.uid}`,
        // Names only. The values travel in sudo's own environment, which is owner-readable; naming
        // them as `NAME=value` arguments instead would publish the service's whole environment to
        // every local user through /proc/<pid>/cmdline, which is world-readable.
        `--preserve-env=${PRESERVED_ENV.join(',')}`,
        '--',
        String(file), ...argv,
      ],
      // sudo's own environment, and the channel the preserved names travel in. Scrubbed, so the
      // helper is handed nothing the CLI is not allowed to see either.
      //
      // Deliberately NOT `detached`. Putting the launch in its own session looked like the way to
      // let a cancel reach the whole tree, and measurably made cancellation worse: aborting 8ms
      // after a detached launch left `sudo` running (`process.kill` → EPERM against a process that
      // had already become root in its own session), where the same abort against an attached
      // launch killed it outright. sudo relays SIGTERM to the command it runs, which is the reach
      // that was actually needed.
      options: { ...options, env: childEnv },
    };
  }

  /**
   * Make sure a cancelled or timed-out launch is actually over.
   *
   * `execFile` rejects the moment it *calls* kill; it never confirms death. With `sudo` in front
   * that gap is real and was reproduced: an abort landing within a few milliseconds of the launch
   * left both `sudo` and the CLI running after the caller had been told the phase was cancelled —
   * an agent still editing the workspace while the job was recorded as stopped, and the engine's
   * post-cancellation working-tree check taken with a live writer behind it.
   *
   * SIGTERM first, because sudo relays it to the command and the CLI can exit cleanly; SIGKILL only
   * once the grace has elapsed, since killing the helper outright would orphan what it launched.
   *
   * `tracked` seeds the accumulator from a set `_execTracked` has already been building *while the
   * launch was still alive* (see there for why: by the time this function is entered, a descendant
   * that `execFile`'s own `timeout`/`signal` handling has already reparented to init is no longer
   * reachable from `pid` at all, seeded or not — the seed is what still remembers it).
   */
  async ensureTerminated(child, { graceMs = this.terminationGraceMs, poll = 50, tracked: seed = null } = {}) {
    const pid = child?.pid ?? null;
    // Nothing was ever launched — an injected runner with no real child, say. Vacuously nothing to
    // confirm, and nothing this function's own limitation below applies to.
    if (!pid) return true;

    const deadline = Date.now() + graceMs;
    const tracked = seed ?? new Map(); // descendant pid -> /proc start-time, recorded at first sight

    // Re-evaluated on every round via Node's own bookkeeping, never snapshotted once at entry: a
    // verdict computed before this function was even called (as an earlier version did) could
    // already be stale by the time it is used to decide whether to signal `pid` at all.
    const directChildGone = () => child.exitCode !== null || child.signalCode !== null;

    // What has to be reached is what was *launched*, not the helper — killing the helper alone is
    // what reparents a CLI that ignores SIGTERM to init and then calls it terminated. Accumulated
    // rather than snapshotted, and re-read on every round: this function is first entered after
    // `execFile` has already delivered its own SIGTERM, so by the time a single `/proc` scan
    // finishes the direct child can already be gone and its own children reparented to init.
    const rescan = () => rescanTracked(tracked, [pid, ...tracked.keys()]);
    await rescan();

    // A tracked descendant only counts as a survivor if its CURRENT `/proc` start-time still matches
    // the one recorded when this module first saw it. A bare pid number is not an identity — the
    // kernel is free to reuse it the instant its holder is reaped, and signalling a reused pid
    // signals a process this module has never heard of and has no business touching. `rescanTracked`
    // already prunes anything whose start-time no longer matches, so survival here just means
    // "still present in `tracked`, and actually alive right now".
    const survivors = () => {
      const found = [];
      if (!directChildGone() && stillRunning(pid)) found.push(pid);
      for (const descendant of tracked.keys()) found.push(descendant);
      return found;
    };

    const send = (signal, pids) => {
      for (const target of pids) {
        try {
          process.kill(target, signal);
        } catch { /* already gone, or not ours to signal */ }
      }
    };

    // SIGTERM to the direct child only, and only if it is not already gone: sudo relays it, and the
    // CLI gets to exit cleanly. A tracked descendant gets no separate SIGTERM of its own here — it
    // is reached once the grace elapses, exactly as it always was.
    if (!directChildGone()) send('SIGTERM', [pid]);
    while (Date.now() < deadline) {
      await rescan();
      if (survivors().length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, poll));
    }

    // Out of grace. Everything that was launched, not just the helper — killing the helper alone is
    // what creates the orphan.
    await rescan();
    send('SIGKILL', survivors());
    for (let i = 0; i < 20; i++) {
      await rescan();
      const left = survivors();
      if (left.length === 0) break;
      send('SIGKILL', left);
      await new Promise((resolve) => setTimeout(resolve, poll));
    }

    // Whatever this search found is now (best-effort) dead — but temporal `/proc`-ancestry sampling
    // can never prove that is the WHOLE tree, and an independent review reproduced exactly why: a
    // descendant that forked and `setsid`-detached in a gap this scan never covered — before the
    // first poll tick, between two ticks, or between the last tick and the direct child's own death
    // — is structurally indistinguishable from one that never existed. One or more samples having
    // run, or every tracked pid having disappeared, proves only that nothing THIS SEARCH HAPPENED TO
    // SEE survived; it is not a claim about anything else. So this reports unconfirmed
    // UNCONDITIONALLY for every timeout or abort once a real child was launched — never `true` from
    // this point on — so the durable fence (`OrchestrationEngine._fenceLease`) always engages rather
    // than sometimes rounding an unproven search up to a false "confirmed". A normal, successful
    // completion never reaches this function at all: only a timeout or an abort does.
    //
    // Closing this for good, rather than living with it as a documented trade-off, needs a
    // kernel-backed per-invocation containment primitive whose membership is provably empty — a
    // dedicated PID namespace, where the kernel itself kills every process in it the moment the
    // namespace's own init exits, or a cgroup with `cgroup.kill`/`cgroup.procs`, which (unlike
    // `/proc` ppid-chasing) tracks membership independently of reparenting. That is a materially
    // larger, more platform-specific undertaking than this fix and is tracked as a follow-up rather
    // than attempted here; see the module doc for the full trade-off.
    return false;
  }

  /**
   * Turn a helper's own refusal into the failure it is.
   *
   * `sudo: a password is required`, `sudo: unknown user`, `sudo: unable to execute …` are all
   * sudo declining to run anything — no phase happened. Classified as a launch failure they read
   * as "the phase did not complete", which sends an operator to look at the project instead of at
   * the configuration, and is exactly the unactionable message this module exists to replace.
   */
  helperFailure(err, plan) {
    if (plan?.mode !== 'sudo') return null;
    // sudo refuses *before* it execs anything, so its refusal is the first thing on the stream.
    // Matching anywhere in stderr meant the agent's own output decided the classification: a Bash
    // tool that ran sudo, or a host whose `/etc/hosts` makes real sudo print
    // `sudo: unable to resolve host …` as a warning on every single invocation, turned every failed
    // phase into a configuration fault and sent the operator to read the sudoers policy.
    // The *leading* block of `sudo:` lines, not merely the first one: on a host whose /etc/hosts
    // does not name it, real sudo prints `sudo: unable to resolve host …` as a warning ahead of its
    // actual refusal, so looking only at the first line traded a false positive for a false
    // negative on exactly the same hosts. The block ends at the first line that is not sudo's,
    // because sudo has said everything it is going to say before it execs anything.
    const leading = [];
    for (const line of String(err?.stderr ?? '').split('\n')) {
      if (line.trim() === '') continue;
      if (!line.startsWith('sudo:')) break;
      leading.push(line);
    }
    const first = leading.find((line) => SUDO_REFUSAL.test(line));
    if (!first) return null;
    // And it has to be a refusal exit: 1 for policy, 126/127 for a command sudo could not run.
    if (![1, 126, 127].includes(err?.code)) return null;
    return new PrivilegeDropError(
      PrivilegeFailure.HELPER_REFUSED,
      `the privilege-drop helper refused the launch: ${first.slice(0, 200)}`,
    );
  }

  /**
   * Wrap an exec-shaped function so every call through it is dropped.
   *
   * Wrapping the seam rather than each call site is the point: a new launch added to the backend
   * later is dropped by construction, and there is no un-dropped path left to forget about.
   */
  wrap(exec) {
    return async (file, argv, options = {}) => {
      // Resolved once and threaded through, so the plan that built the argv is the same plan the
      // failure is interpreted against.
      const plan = await this.plan();
      const invocation = await this.invocation(file, argv, options, plan);
      return this._execTracked(exec, invocation, plan, options);
    };
  }
}

/** Whether a pid is still there. EPERM means "there, and not ours to signal" — still there. */
function stillRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Every currently-live pid's parent and `/proc` start-time, in one pass.
 *
 * Start-time (field 22 of `/proc/<pid>/stat`, a raw kernel clock-tick count that is unique for the
 * lifetime of a pid slot) is what turns a bare pid number into an actual identity check: the kernel
 * is free to reuse a pid the instant its previous holder is reaped, and a bare `process.kill(pid,
 * sig)` cannot tell "the process this module has been tracking" from "whatever unrelated process the
 * kernel handed that number to next". Comparing start-times closes that gap — recorded once, at
 * first sight, and checked again immediately before every signal.
 *
 * Returns an empty map on a system without `/proc` rather than throwing: the caller then does what
 * it did before, which is signal the direct child and confirm what it can.
 */
async function procSnapshot() {
  let entries;
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return new Map();
  }
  const snapshot = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    try {
      const stat = await fsp.readFile(`/proc/${entry}/stat`, 'utf8');
      // The comm field is parenthesised and may contain spaces and parentheses of its own, so the
      // fields are read from after the LAST ')': state, ppid, …, start-time (field 22 overall, index
      // 19 of this array once the first two — pid and comm — are accounted for by the split point).
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(after[1]);
      const startTime = after[19];
      if (!Number.isInteger(ppid) || startTime === undefined) return;
      snapshot.set(Number(entry), { ppid, startTime });
    } catch { /* the process ended while we were reading it */ }
  }));
  return snapshot;
}

/** Every pid whose recorded parent, within one already-taken snapshot, traces back to `pid`. */
export function descendantsIn(snapshot, pid) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift();
    for (const [candidate, info] of snapshot) {
      if (info.ppid === current && candidate !== pid && !found.includes(candidate)) {
        found.push(candidate);
        queue.push(candidate);
      }
    }
  }
  return found;
}

/**
 * Grow `tracked` (a `Map<pid, startTime>`) with every live descendant of `roots`, then prune any
 * entry whose current `/proc` start-time no longer matches what was recorded when it was first
 * seen — because that pid is either gone outright, or has been handed by the kernel to a process
 * this module never launched and has no business tracking, let alone signalling.
 *
 * One `/proc` snapshot per call, shared across the whole accumulate-then-prune pass, so an entry is
 * never accumulated from one instant and pruned against a different, later one. `snapshot` is
 * injectable — defaulting to a real `/proc` read — so a test can drive the identity-check logic
 * deterministically with a scripted sequence of snapshots, including a pid reused with a different
 * start-time, without needing the kernel to actually reuse one on cue.
 */
export async function rescanTracked(tracked, roots, { snapshot: takeSnapshot = procSnapshot } = {}) {
  const snapshot = await takeSnapshot();
  for (const root of roots) {
    for (const descendant of descendantsIn(snapshot, root)) {
      if (!tracked.has(descendant)) {
        const info = snapshot.get(descendant);
        if (info) tracked.set(descendant, info.startTime);
      }
    }
  }
  for (const [pid, startTime] of [...tracked]) {
    const info = snapshot.get(pid);
    if (!info || info.startTime !== startTime) tracked.delete(pid);
  }
  return snapshot;
}

/** Build the dropper this deployment's configuration calls for. */
export function privilegeDropperFor(config, { forbiddenEnv = [], forbiddenEnvPrefixes = [], ...overrides } = {}) {
  return new PrivilegeDropper({
    // `?? 'host'` rather than a silent `undefined`: an object that is not a loaded configuration
    // must not be read as "container, nothing to do". The strict mode is the safe guess, and an
    // unknown value is refused outright when the plan is resolved.
    deployMode: config?.deployMode ?? 'host',
    user: config?.tmuxUser ?? '',
    sudoExecutable: config?.sudoExecutable ?? '',
    forbiddenEnv,
    forbiddenEnvPrefixes,
    ...overrides,
  });
}
