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
//     /usr/bin/sudo -n -H -u admin -- /abs/path/to/claude.exe --model … --effort …
//
// `sudo` is looked up at an absolute path and checked to be a root-owned setuid binary that is not
// group- or world-writable; the CLI is required to be an absolute path so neither `sudo`'s
// `secure_path` nor the caller's PATH chooses the program; and the argv is built by the backend, not
// by a caller. Fingerprinting continues to hash, stat and ELF-check *the CLI*, never `sudo`.

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
  constructor(failure, detail) {
    super(detail);
    this.name = 'PrivilegeDropError';
    this.failure = failure;
    this.kind = 'privilege_drop_failed';
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

  let line;
  try {
    const { stdout } = await exec(getentExecutable, ['passwd', name], { timeout: timeoutMs });
    line = String(stdout).split('\n').find((l) => l.startsWith(`${name}:`));
  } catch {
    line = null;
  }
  if (!line) {
    throw new PrivilegeDropError(
      PrivilegeFailure.USER_UNRESOLVABLE,
      `the configured unprivileged account '${name}' does not exist on this host`,
    );
  }

  // name:passwd:uid:gid:gecos:home:shell — a home directory containing a colon is not expressible
  // in this format, so the split is exact rather than best-effort.
  const fields = line.split(':');
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
    deployMode = 'container',
    user = '',
    sudoExecutable = '',
    forbiddenEnv = [],
    exec = execFileAsync,
    stat = fsp.stat,
    // Injected so the decision is deterministic under test and does not depend on who happens to
    // be running the suite.
    currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
    resolveUser = resolveDropUser,
    resolveHelper = resolveSudo,
  } = {}) {
    this.deployMode = deployMode;
    this.user = user;
    this.sudoExecutable = sudoExecutable;
    this.forbiddenEnv = Object.freeze([...forbiddenEnv]);
    this.exec = exec;
    this.stat = stat;
    this.currentUid = currentUid;
    this.resolveUser = resolveUser;
    this.resolveHelper = resolveHelper;
    this._plan = null;
  }

  /**
   * How this instance will launch the CLI.
   *
   * `direct` in container mode — where the whole container already runs as the unprivileged user and
   * nothing needs dropping — and in the one host case that is genuinely already correct: this
   * process is *itself* the configured account. That is not a fallback to root; if the ids differ at
   * all, a drop is required and its absence is fatal.
   */
  async plan() {
    if (!this._plan) this._plan = this._resolvePlan();
    return this._plan;
  }

  async _resolvePlan() {
    if (this.deployMode !== 'host') return Object.freeze({ mode: 'direct', reason: 'container' });

    // Validated before anything is resolved or executed, so a malformed name never reaches getent.
    const target = await this.resolveUser(this.user, { exec: this.exec });

    const uid = this.currentUid();
    if (uid !== null && uid === target.uid) {
      return Object.freeze({ mode: 'direct', reason: 'already_target_user', target });
    }

    const sudo = await this.resolveHelper(this.sudoExecutable, { stat: this.stat });
    return Object.freeze({ mode: 'sudo', sudo, target });
  }

  /** The environment the CLI is launched with, corrected for the account it now runs as. */
  dropEnv(env, target) {
    const next = { ...(env ?? {}) };
    for (const key of this.forbiddenEnv) delete next[key];
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
   * Translate one launch into the argv actually executed.
   *
   * Exposed separately from `wrap` so a test can assert the exact argv and environment without
   * spawning anything.
   */
  async invocation(file, argv, options = {}) {
    const plan = await this.plan();
    if (plan.mode === 'direct') return { file, argv: [...argv], options: { ...options } };

    if (!file || !path.isAbsolute(String(file))) {
      // sudo would otherwise resolve the name through its own `secure_path`, which is a PATH lookup
      // by another name: the file that ran and the file that was fingerprinted could differ.
      throw new PrivilegeDropError(
        PrivilegeFailure.EXECUTABLE_NOT_ABSOLUTE,
        'the coding CLI must be configured as an absolute path before it can be run as the unprivileged account',
      );
    }

    return {
      file: plan.sudo,
      // -n so a sudoers rule needing a password fails immediately instead of hanging until the
      // phase deadline; -H so HOME is the target's whatever env_reset is set to; -- so no later
      // element can be read as an option to sudo. The CLI's own argv follows unchanged.
      argv: ['-n', '-H', '-u', plan.target.name, '--', String(file), ...argv],
      options: { ...options, env: this.dropEnv(options.env, plan.target) },
    };
  }

  /**
   * Wrap an exec-shaped function so every call through it is dropped.
   *
   * Wrapping the seam rather than each call site is the point: a new launch added to the backend
   * later is dropped by construction, and there is no un-dropped path left to forget about.
   */
  wrap(exec) {
    return async (file, argv, options = {}) => {
      const invocation = await this.invocation(file, argv, options);
      return exec(invocation.file, invocation.argv, invocation.options);
    };
  }
}

/** Build the dropper this deployment's configuration calls for. */
export function privilegeDropperFor(config, { forbiddenEnv = [], ...overrides } = {}) {
  return new PrivilegeDropper({
    deployMode: config.deployMode,
    user: config.tmuxUser,
    sudoExecutable: config.sudoExecutable ?? '',
    forbiddenEnv,
    ...overrides,
  });
}
