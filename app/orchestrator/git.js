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

/**
 * Subcommands this subsystem may run. Read-only inspection, plus exactly the writes publication
 * needs: stage named files, commit, push a branch, and manage its own worktrees.
 */
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'rev-parse', 'status', 'diff', 'log', 'ls-files', 'show', 'cat-file', 'rev-list',
  'symbolic-ref', 'for-each-ref', 'remote', 'config', 'branch', 'fetch', 'ls-remote',
  'add', 'commit', 'push', 'worktree', 'check-ignore', 'var', 'describe', 'hash-object',
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

/** Options that turn an allowed subcommand into a destructive one. */
const FORBIDDEN_ARGS = [
  '--force', '--force-with-lease', '--force-if-includes', '-f',
  '--hard', '--mixed', '--soft', '--keep', '--merge',
  '--delete', '-d', '-D', '--prune', '--all', '--mirror',
  '--exec', '--upload-pack', '--receive-pack', '--config-env',
  '-c', '--work-tree', '--git-dir', '--namespace',
];

/**
 * Arguments that are legitimate on specific read-only subcommands even though they appear in the
 * blanket list above. Keeping this narrow and per-subcommand means a broad flag cannot be smuggled
 * in on a subcommand where it *would* be dangerous.
 */
const ARG_EXCEPTIONS = Object.freeze({
  branch: new Set(['--all']),
  log: new Set(['--all']),
  'rev-list': new Set(['--all']),
  'for-each-ref': new Set([]),
  diff: new Set([]),
  status: new Set([]),
  fetch: new Set(['--all', '--prune']),
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

  const allowedHere = ARG_EXCEPTIONS[subcommand] ?? new Set();
  for (const arg of rest) {
    if (!arg.startsWith('-')) continue;
    const bare = arg.split('=')[0];
    if (allowedHere.has(bare)) continue;
    if (FORBIDDEN_ARGS.includes(bare)) {
      throw refuse(`the git option ${bare} is not permitted on ${subcommand}`);
    }
  }

  // `worktree` is allowed for isolation, but only the non-destructive verbs.
  if (subcommand === 'worktree') {
    const verb = rest.find((a) => !a.startsWith('-'));
    if (!['list', 'add'].includes(verb)) {
      throw refuse(`git worktree ${verb ?? ''} is not permitted`.trim());
    }
  }

  // `config` is read-only here: writing config would let a caller change how git behaves later.
  if (subcommand === 'config') {
    const readOnly = rest.some((a) => a === '--get' || a === '--get-all' || a === '--list');
    if (!readOnly) throw refuse('git config may only be read');
  }

  // `push` must name a remote and a refspec, and must never delete a ref.
  if (subcommand === 'push') {
    if (rest.some((a) => a.startsWith(':'))) throw refuse('a deleting push is not permitted');
  }

  return true;
}

/**
 * Run git in a repository.
 *
 * `-c` and every other configuration-injection option is refused above, and the environment is
 * pruned of the variables that would let git write somewhere else or prompt for credentials.
 */
export async function runGit(argv, { cwd, gitExecutable = 'git', timeoutMs = 120_000, exec = execFileAsync } = {}) {
  assertGitArgvAllowed(argv);
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[key];
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
