// An allowlisted git runner.
//
// The contract says cancellation preserves the working tree: "No reset, no stash, no clean, no
// discard." A comment saying so is not a control. This module is the control — every git invocation
// in the orchestration subsystem goes through `runGit`, and the destructive subcommands are not
// merely unused, they are *unreachable*. A future change that adds `git checkout -- .` somewhere in
// a recovery path fails here rather than silently destroying an operator's uncommitted work.
//
// The same allowlist is what stops a typed field becoming an arbitrary command: no caller supplies
// a subcommand, and the argument scan rejects anything that could be read as a dangerous option.

import { execFile } from 'child_process';
import { promisify } from 'util';

import { ApiError } from './errors.js';
import { ErrorCode } from './contract.js';

const execFileAsync = promisify(execFile);

/** The only environment variables a caller may set. Deliberately not a general escape hatch. */
const GIT_IDENTITY_VARS = Object.freeze([
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

/**
 * Subcommands this subsystem may run. Read-only inspection, plus exactly the writes publication
 * needs: stage named files, commit, push a branch, and manage its own worktrees.
 */
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'rev-parse', 'status', 'diff', 'log', 'ls-files', 'show', 'cat-file', 'rev-list',
  'symbolic-ref', 'for-each-ref', 'remote', 'config', 'branch', 'fetch', 'ls-remote',
  'add', 'commit', 'push', 'worktree', 'check-ignore', 'var', 'describe', 'hash-object',
  // Seeds a scratch index from a commit. Writes ONLY the index — never the working tree, because
  // the options that would do that (-u, -m, --reset) are not in the option allowlist below, and
  // runGit additionally refuses read-tree unless an explicit private index file is supplied.
  'read-tree',
]));

/**
 * Subcommands that can destroy uncommitted work or rewrite history. Listed explicitly so the
 * refusal message can name what was attempted, and so the set is auditable at a glance.
 */
export const FORBIDDEN_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'reset', 'checkout', 'restore', 'clean', 'stash', 'rm', 'mv', 'rebase', 'merge',
  'cherry-pick', 'revert', 'filter-branch', 'filter-repo', 'update-ref', 'reflog',
  'gc', 'prune', 'am', 'apply', 'switch', 'bisect', 'submodule', 'replace', 'notes',
  'update-index', 'symbolic-ref-d', 'fsck', 'repack',
]));

/**
 * Per-subcommand option allowlists.
 *
 * An earlier version denylisted exact option strings, which three real bypasses walked straight
 * through: `push -fu` clusters to `-f -u` (force push), `push origin +HEAD:refs/heads/main` forces
 * via the refspec rather than a flag, and `fetch origin +refs/heads/main:refs/heads/feature`
 * clobbers a local branch holding unpushed commits. An allowlist has the opposite failure mode:
 * something legitimate gets refused until it is added deliberately, which is the direction this
 * module should fail in.
 */
const ALLOWED_OPTIONS = Object.freeze({
  'rev-parse': new Set(['--abbrev-ref', '--short', '--verify', '--quiet', '--is-inside-work-tree', '--show-toplevel', '--git-dir']),
  status: new Set(['--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=all', '--untracked-files=no', '-z']),
  diff: new Set(['--check', '--cached', '--staged', '--name-only', '--numstat', '--stat', '--unified=0', '--no-renames', '-z', '--no-color']),
  log: new Set(['--oneline', '--format', '--pretty', '-n', '--max-count', '--no-color']),
  'ls-files': new Set(['--others', '--exclude-standard', '--cached', '-z']),
  show: new Set(['--numstat', '--stat', '--format=', '--name-only', '--no-color', '-z', '--no-renames']),
  'cat-file': new Set(['-t', '-p', '-e']),
  'rev-list': new Set(['--count', '--max-count', '-n']),
  'symbolic-ref': new Set(['--short', '-q']),
  'for-each-ref': new Set(['--format', '--count']),
  remote: new Set([]),
  config: new Set(['--get', '--get-all', '--list']),
  branch: new Set(['--list', '--show-current', '--format']),
  fetch: new Set(['--prune', '--quiet', '--no-tags']),
  'ls-remote': new Set(['--heads', '--tags', '--quiet']),
  add: new Set(['--']),
  commit: new Set(['-m', '--message', '--quiet']),
  push: new Set(['--quiet', '--porcelain', '--set-upstream']),
  worktree: new Set(['--detach', '-b']),
  'check-ignore': new Set(['--quiet', '-q']),
  var: new Set([]),
  describe: new Set(['--tags', '--always']),
  'hash-object': new Set([]),
  // No options at all. -u/--reset/-m would touch the working tree; omitting them from this set is
  // what makes read-tree an index-only operation.
  'read-tree': new Set([]),
});

/** Verbs each multi-verb subcommand may use. */
const ALLOWED_VERBS = Object.freeze({
  worktree: new Set(['list', 'add']),
  remote: new Set(['get-url', 'show', '-v']),
});

function refuse(message) {
  // DIRECT_CODING_FORBIDDEN is the closest contract code: the caller asked for a capability this
  // service does not offer, rather than sending a malformed request.
  return new ApiError(ErrorCode.DIRECT_CODING_FORBIDDEN, message);
}

/**
 * Validate a git argv. Exported separately from the runner so the allowlist can be asserted
 * directly, without a repository and without running anything.
 */
export function assertGitArgvAllowed(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw refuse('an empty git invocation is not permitted');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw refuse('git arguments must be plain strings');
    }
  }

  // A leading global option could relocate the repository or inject configuration, so the
  // subcommand must be the first argument.
  const [subcommand, ...rest] = argv;
  if (subcommand.startsWith('-')) {
    throw refuse('git global options are not permitted; the subcommand must come first');
  }
  if (FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand)) {
    throw refuse(`git ${subcommand} can destroy uncommitted work or rewrite history and is not permitted`);
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw refuse(`git ${subcommand} is not in the permitted set`);
  }

  const allowedHere = ALLOWED_OPTIONS[subcommand] ?? new Set();
  let afterDoubleDash = false;
  for (const arg of rest) {
    // Everything after `--` is a pathspec, not an option.
    if (afterDoubleDash) continue;
    if (arg === '--') { afterDoubleDash = true; continue; }
    if (!arg.startsWith('-')) continue;

    // A short-option cluster is expanded by git: `-fu` is `-f -u`, and denylisting the literal
    // string `-f` never saw it. Refusing clusters outright keeps the check readable.
    if (/^-[A-Za-z]{2,}$/.test(arg)) {
      throw refuse(`clustered git short options (${arg}) are not permitted on ${subcommand}`);
    }
    const bare = arg.split('=')[0];
    if (!allowedHere.has(bare) && !allowedHere.has(`${bare}=`) && !allowedHere.has(arg)) {
      throw refuse(`the git option ${bare} is not permitted on ${subcommand}`);
    }
  }

  const verbs = ALLOWED_VERBS[subcommand];
  if (verbs) {
    const verb = rest.find((a) => !a.startsWith('-'));
    if (!verbs.has(verb)) throw refuse(`git ${subcommand} ${verb ?? ''} is not permitted`.trim());
  }

  // read-tree may only ever write a caller-supplied scratch index. Enforced in runGit, which has
  // the indexFile in hand; asserted here so the intent is visible next to the allowlist.

  // `config` is read-only here. Writing config would let a caller change how git behaves on every
  // later invocation — hooks, safe.directory, credential helpers — which is a durable escalation
  // rather than a single command.
  if (subcommand === 'config') {
    const reads = rest.some((a) => a === '--get' || a === '--get-all' || a === '--list');
    if (!reads) throw refuse('git config may only be read');
  }

  // A refspec is a second way to force, needing no flag at all: `+src:dst` overwrites the
  // destination regardless of fast-forward, and `:dst` deletes it.
  if (subcommand === 'push' || subcommand === 'fetch') {
    for (const arg of rest) {
      if (arg.startsWith('-')) continue;
      if (arg.startsWith(':')) throw refuse(`a deleting ${subcommand} refspec is not permitted`);
      if (arg.startsWith('+')) throw refuse(`a forced ${subcommand} refspec is not permitted`);
    }
  }

  return true;
}

/**
 * Run git in a repository.
 *
 * `-c` and every other configuration-injection option is refused above, and the environment is
 * pruned of the variables that would let git write somewhere else or prompt for credentials.
 */
export async function runGit(argv, { cwd, gitExecutable = 'git', timeoutMs = 120_000, exec = execFileAsync, indexFile = null, envExtra = null } = {}) {
  assertGitArgvAllowed(argv);
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[key];
  }
  // An explicitly supplied private index — never inherited from the ambient environment, which is
  // why the variable is stripped first. Publication stages into a throwaway copy of the index so a
  // failure cannot leave the operator's staged work rearranged, and git.js deliberately offers no
  // way to unstage.
  // read-tree writes an index. Without an explicit scratch index it would write the repository's
  // own — which is the one thing this module exists to keep out of.
  if (argv[0] === 'read-tree' && !indexFile) {
    throw new ApiError(
      ErrorCode.DIRECT_CODING_FORBIDDEN,
      'git read-tree is only permitted against an explicit private index',
    );
  }
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  // Explicit, caller-supplied variables — currently only the commit identity. Passed as environment
  // rather than `-c`, which the allowlist refuses because it is a general configuration-injection
  // vector. Restricted to a named set: a blanket assign here would let a caller re-inject the very
  // variables the prune above exists to strip, or override the private scratch index that makes a
  // failed publication a no-op.
  if (envExtra) {
    for (const key of GIT_IDENTITY_VARS) {
      if (typeof envExtra[key] === 'string') env[key] = envExtra[key];
    }
  }
  // A prompt would hang the phase rather than fail it.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = env.GIT_ASKPASS ?? '/bin/true';

  try {
    const { stdout, stderr } = await exec(gitExecutable, argv, {
      cwd, timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    return {
      ok: false,
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
      killed: Boolean(err?.killed),
    };
  }
}

/**
 * Capture the repository facts a job's baseline depends on.
 *
 * Deliberately all read-only: establishing a baseline must never be able to change the thing it is
 * measuring, and a dirty tree is a fact to be recorded, not a problem to be tidied away.
 */
export async function repositoryBaseline({ cwd, gitExecutable = 'git', exec }) {
  const opts = { cwd, gitExecutable, exec };
  const [head, branch, statusOut, remote] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], opts),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts),
    runGit(['status', '--porcelain=v1'], opts),
    runGit(['remote', 'get-url', 'origin'], opts),
  ]);

  const dirtyFiles = statusOut.stdout.split('\n').filter(Boolean);
  return {
    is_repository: head.ok,
    head_sha: head.ok ? head.stdout.trim() : null,
    branch: branch.ok ? branch.stdout.trim() : null,
    // Recorded, never "fixed". The contract requires a dirty primary checkout be preserved.
    dirty: dirtyFiles.length > 0,
    dirty_file_count: dirtyFiles.length,
    has_remote: remote.ok,
  };
}

/** A stable fingerprint of the working tree, used to prove cancellation changed nothing. */
export async function workingTreeFingerprint({ cwd, gitExecutable = 'git', exec }) {
  const opts = { cwd, gitExecutable, exec };
  const [status, head, diff] = await Promise.all([
    runGit(['status', '--porcelain=v1', '--untracked-files=all'], opts),
    runGit(['rev-parse', 'HEAD'], opts),
    runGit(['diff'], opts),
  ]);
  return {
    status: status.stdout,
    head: head.stdout.trim(),
    diff: diff.stdout,
  };
}
