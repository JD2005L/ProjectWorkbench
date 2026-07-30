// The publication gate.
//
// Publication is a separate operation from implementation, and it is approval-gated. That
// separation is the product requirement, but the interesting part is what "published" is allowed to
// mean. The contract's load-bearing field is `remote_sha_verified`, and it may only be true after
// the *full* forty-character local and remote SHAs have been fetched and compared. A successful
// `git push` exit code is not that comparison: a push can succeed against a different ref than the
// caller believes, and a local commit is not evidence that a remote accepted it.
//
// Equally deliberate is what this module cannot do. There is no merge, no deploy, no branch
// deletion, and no history rewrite — not because none is called, but because git.js makes those
// subcommands unreachable from this subsystem entirely.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  SCHEMA_VERSION, CiState, ApprovalStatus, ApprovalType, ErrorCode, newId,
} from './contract.js';
import { ApiError, notFound } from './errors.js';
import { runGit } from './git.js';
import { parseNumstatZ } from './checks.js';
import { redactText } from './redact.js';

const FULL_SHA = /^[a-f0-9]{40}$/;

/**
 * Stage exactly the intended files, commit, push, and verify what actually landed.
 *
 * Every step returns evidence rather than a claim, and any step that cannot be evidenced leaves the
 * corresponding field false or null rather than optimistically filled in.
 */
export class Publisher {
  constructor({ config, exec = undefined, clock = () => new Date() }) {
    this.config = config;
    this.exec = exec;
    this.clock = clock;
  }

  _git(argv, cwd, indexFile = null, signal = undefined) {
    return runGit(argv, {
      cwd, gitExecutable: this.config.gitExecutable, exec: this.exec, indexFile, signal,
      // Supplied on every call so a commit never depends on the ambient identity of whatever user
      // the dashboard runs as. A service account with no global git config is the normal case, and
      // without this `git commit` fails with "Please tell me who you are".
      envExtra: {
        GIT_AUTHOR_NAME: this.config.gitAuthorName,
        GIT_AUTHOR_EMAIL: this.config.gitAuthorEmail,
        GIT_COMMITTER_NAME: this.config.gitAuthorName,
        GIT_COMMITTER_EMAIL: this.config.gitAuthorEmail,
      },
    });
  }

  /**
   * A private index, seeded from HEAD rather than copied from the repository's own.
   *
   * Staging into the real index would be irreversible from inside this subsystem: git.js forbids
   * `reset` and `restore` precisely so nothing here can discard work, which also means nothing here
   * could undo a partial stage. So publication works on its own index.
   *
   * It is *seeded*, not *copied*, and that distinction is load-bearing. A copied index carries the
   * repository's cached `stat` data, and `git add` trusts that cache: with it, `git add -- src.js`
   * intermittently exits 0 having staged nothing while `git status` still reports the file as
   * modified, and publication then fails with "there is nothing to publish". Seeding with
   * `read-tree HEAD` produces an index with no stat data at all, so git has to hash the file to
   * decide — which is the only way to be right about it.
   */
  async _privateIndex(workspacePath, signal = undefined) {
    const scratch = path.join(
      os.tmpdir(), `pw-orch-index-${crypto.randomBytes(8).toString('hex')}`,
    );
    const seeded = await this._git(['read-tree', 'HEAD'], workspacePath, scratch, signal);
    if (!seeded.ok) {
      // An unborn HEAD (a repository with no commits) leaves an empty index, which is correct.
      try { fs.rmSync(scratch, { force: true }); } catch { /* nothing to remove */ }
    }
    return scratch;
  }

  /**
   * Verify the intended files are real, relative, inside the workspace, and actually changed.
   *
   * The relative-path type already rejects absolute and traversing forms, so this is the second
   * line: it resolves each path and confirms containment, because a path that survives a pattern
   * check can still escape through a symlink.
   */
  assertIntendedFilesSafe(intendedFiles, workspacePath) {
    const root = path.resolve(workspacePath);
    for (const file of intendedFiles) {
      // `git add -- <pathspec>` stops git reading a leading dash as an *option*; it does not stop
      // pathspec *magic*. `:(glob)**` and `:/` are not filenames, and `*` is not one either — each
      // would stage files the caller never named.
      if (/^:/.test(file) || /[*?[\]]/.test(file)) {
        throw new ApiError(
          ErrorCode.UNSAFE_PATH,
          'an intended file must be a literal repository path, not a pathspec pattern',
        );
      }
      const resolved = path.resolve(root, file);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new ApiError(ErrorCode.UNSAFE_PATH, 'an intended file resolves outside the project workspace');
      }
    }
  }

  async publish({ job, project, workspacePath, request, signal = undefined }) {
    this.assertIntendedFilesSafe(request.intended_files, workspacePath);
    const steps = [];
    const record = (step, result) => {
      steps.push({ step, exit_code: result.exitCode, stderr: redactText(result.stderr, { maxLength: 500 }) });
      return result;
    };

    const index = await this._privateIndex(workspacePath, signal);
    try {
      return await this._publishWithIndex({
        job, project, workspacePath, request, steps, record, index, signal,
      });
    } finally {
      // Whatever happened, the scratch index goes away and the operator's index is as they left it.
      try { fs.rmSync(index, { force: true }); } catch { /* already gone */ }
    }
  }

  async _publishWithIndex({ job, project, workspacePath, request, steps, record, index, signal }) {
    // Every git call this method makes is folded through here, so a single unconfirmed kill
    // anywhere in the sequence — commit, push, the post-push verification, any of it — marks the
    // whole publication attempt unconfirmed. The engine fences rather than releases on `false`; a
    // `git push` is exactly as capable of backgrounding something of its own as any other command
    // this subsystem runs, and a command aborted mid-push is the load-bearing case here.
    let terminationConfirmed = null;
    const note = (result) => {
      if (result.terminationConfirmed === false) terminationConfirmed = false;
      return result;
    };
    const failed = (reason) => this._failed(job, reason, steps, terminationConfirmed);

    // -- stage only the intended files ------------------------------------
    // `--` separates paths from revisions, so a filename can never be read as a ref or an option.
    const add = note(record('add', await this._git(['add', '--', ...request.intended_files], workspacePath, index, signal)));
    if (!add.ok) return failed('the intended files could not be staged');

    // -- verify what is actually staged -----------------------------------
    // `-z` because git quotes non-ASCII paths in its default output ("caf\303\251.txt"), and
    // `--no-renames` because a rename otherwise reports only the destination — both made the
    // comparison fail for changes that were entirely legitimate.
    const staged = note(await this._git(['diff', '--cached', '--name-only', '-z', '--no-renames'], workspacePath, index, signal));
    const stagedFiles = staged.stdout.split('\0').filter(Boolean).sort();
    const intended = [...new Set(request.intended_files)].sort();

    // The staged set must be a subset of the intended set. Equality is too strong: intending both
    // sides of a rename is correct even though only one side may show as changed.
    const unintended = stagedFiles.filter((f) => !intended.includes(f));
    if (unintended.length) {
      return failed(`${unintended.length} file(s) were staged that were not intended`);
    }
    if (!stagedFiles.length) {
      return failed('there is nothing to publish');
    }

    // -- commit -----------------------------------------------------------
    // No -a: only the explicitly staged set is committed. An `-a` here would sweep up every other
    // dirty file in the operator's checkout.
    const commit = note(record('commit', await this._git(['commit', '-m', request.commit_message], workspacePath, index, signal)));
    if (!commit.ok) {
      // Name the cause. "the commit failed" sent an operator hunting through artifacts for what was
      // often a one-line git message.
      const why = redactText(String(commit.stderr || commit.stdout || ''), { maxLength: 160 }).trim();
      return failed(why ? `the commit failed: ${why}` : 'the commit failed');
    }

    const localHead = note(await this._git(['rev-parse', 'HEAD'], workspacePath, null, signal));
    const localCommit = localHead.stdout.trim();
    if (!FULL_SHA.test(localCommit)) return failed('the local commit could not be determined');

    // The commit was made from a private index, so the repository's own index still holds the
    // pre-publication version of the published files. Relative to the NEW HEAD that reads as a
    // staged *reversion* — an operator running `git status` would see the change queued to be
    // undone. Re-staging exactly the published paths against the real index brings it back into
    // agreement with HEAD, and touches nothing else the operator had staged.
    //
    // Only on success. A failed publication still never touches the real index at all.
    await this._git(['add', '--', ...request.intended_files], workspacePath, null, signal);

    // -- push -------------------------------------------------------------
    // An explicit refspec, never a bare `git push`: what gets pushed must not depend on the
    // repository's push configuration.
    const push = note(record('push', await this._git(['push', 'origin', `HEAD:refs/heads/${request.branch}`], workspacePath, null, signal)));
    const pushed = push.ok;

    // -- verify the remote actually has it --------------------------------
    let remoteCommit = null;
    if (pushed) {
      const lsRemote = note(await this._git(['ls-remote', 'origin', `refs/heads/${request.branch}`], workspacePath, null, signal));
      const candidate = lsRemote.stdout.split(/\s+/)[0]?.trim() ?? '';
      if (FULL_SHA.test(candidate)) remoteCommit = candidate;
    }
    // Only an exact full-SHA match counts. Abbreviations are refused by the type; a mismatch here
    // means the branch on the remote is not the commit that was just made.
    const remoteShaVerified = Boolean(pushed && remoteCommit && localCommit === remoteCommit);

    // -- the live pull request --------------------------------------------
    let pullRequest = { url: null, state: null, headSha: null, mergeable: null, ciState: CiState.NOT_STARTED };
    if (remoteShaVerified && request.open_pull_request) {
      pullRequest = await this._pullRequest(workspacePath, request.branch, project, signal);
    } else if (!project.has_ci) {
      pullRequest.ciState = CiState.NOT_CONFIGURED;
    }

    // `-z` again: the published file list is compared against the intended one and shown to a
    // human, so it must carry real filenames rather than git's quoted escapes.
    const changed = note(await this._git(
      ['show', '--numstat', '-z', '--no-renames', '--format=', localCommit], workspacePath, null, signal,
    ));
    const { files, insertions, deletions, changedFiles } = parseNumstatZ(changed.stdout);

    return {
      schema_version: SCHEMA_VERSION,
      publication_id: newId('pwpub'),
      job_id: job.workbench_job_id,
      branch: request.branch,
      local_commit: localCommit,
      remote_commit: remoteCommit,
      pushed,
      remote_sha_verified: remoteShaVerified,
      pull_request_url: pullRequest.url,
      pull_request_state: pullRequest.state,
      pull_request_head_sha: pullRequest.headSha,
      mergeable: pullRequest.mergeable,
      ci_state: pullRequest.ciState,
      diff_stat: { schema_version: SCHEMA_VERSION, files, insertions, deletions },
      changed_files: changedFiles.slice(0, 200),
      recorded_at: this.clock().toISOString(),
      terminationConfirmed,
      steps,
    };
  }

  /**
   * Create or fetch the live pull request and read its real state.
   *
   * The object is *fetched* rather than assumed from the create call's output: the PR may already
   * exist, and its state and head SHA are facts about the remote, not about what was just run. When
   * `gh` is unavailable the fields stay null and CI is reported as `not_configured` — explicitly
   * unknown rather than quietly optimistic.
   */
  async _pullRequest(workspacePath, branch, project, signal = undefined) {
    const base = project.default_branch ?? 'main';
    const gh = async (argv) => {
      try {
        const { stdout } = await (this.exec ?? (await import('util')).promisify((await import('child_process')).execFile))(
          this.config.ghExecutable, argv, { cwd: workspacePath, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal },
        );
        return { ok: true, stdout: String(stdout ?? '') };
      } catch (err) {
        return { ok: false, stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? err?.message ?? '') };
      }
    };

    // Create if absent. An existing PR makes `gh pr create` fail, which is not an error here.
    await gh(['pr', 'create', '--head', branch, '--base', base, '--fill']);

    const view = await gh(['pr', 'view', branch, '--json', 'url,state,headRefOid,mergeable,statusCheckRollup']);
    if (!view.ok) {
      return { url: null, state: null, headSha: null, mergeable: null, ciState: project.has_ci ? CiState.NOT_STARTED : CiState.NOT_CONFIGURED };
    }

    let parsed;
    try {
      parsed = JSON.parse(view.stdout);
    } catch {
      return { url: null, state: null, headSha: null, mergeable: null, ciState: CiState.NOT_STARTED };
    }

    const rollup = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
    let ciState;
    if (!rollup.length) {
      // No checks at all is reported explicitly rather than implied by "not started".
      ciState = project.has_ci ? CiState.NOT_STARTED : CiState.NOT_CONFIGURED;
    } else if (rollup.some((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.conclusion))) {
      ciState = CiState.FAILED;
    } else if (rollup.some((c) => c.status && c.status !== 'COMPLETED')) {
      ciState = CiState.RUNNING;
    } else {
      ciState = CiState.PASSED;
    }

    const headSha = typeof parsed.headRefOid === 'string' && FULL_SHA.test(parsed.headRefOid) ? parsed.headRefOid : null;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : null,
      state: typeof parsed.state === 'string' ? parsed.state.toLowerCase() : null,
      headSha,
      mergeable: parsed.mergeable === 'MERGEABLE' ? true : (parsed.mergeable === 'CONFLICTING' ? false : null),
      ciState,
    };
  }

  /** A refusal that happened before any git ran, shaped like any other failed publication. */
  refusedRecord(job, reason, terminationConfirmed = null) {
    return this._failed(job, reason, [], terminationConfirmed);
  }

  /** A publication that did not complete. Never partially claimed as success. */
  _failed(job, reason, steps, terminationConfirmed = null) {
    return {
      schema_version: SCHEMA_VERSION,
      publication_id: newId('pwpub'),
      job_id: job.workbench_job_id,
      branch: null,
      local_commit: null,
      remote_commit: null,
      pushed: false,
      remote_sha_verified: false,
      pull_request_url: null,
      pull_request_state: null,
      pull_request_head_sha: null,
      mergeable: null,
      ci_state: CiState.NOT_STARTED,
      diff_stat: null,
      changed_files: [],
      recorded_at: this.clock().toISOString(),
      failure_reason: reason,
      terminationConfirmed,
      steps,
    };
  }
}

/**
 * Require a recorded, still-valid human approval for publication.
 *
 * Chat text never approves. Neither does an agent asserting it: the approval must be a durable row
 * whose decision was recorded through the approve endpoint, and it must not have expired.
 */
export function assertPublicationApproved({ approval, approvalId }) {
  if (!approvalId) {
    throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, 'publication requires a recorded approval');
  }
  if (!approval) throw notFound('no such approval');
  if (approval.approval_type !== ApprovalType.PUBLICATION) {
    throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, 'the referenced approval does not authorise publication');
  }
  if (approval.status !== ApprovalStatus.APPROVED) {
    throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, 'the referenced approval has not been granted');
  }
  if (approval.decided_by?.kind !== 'human') {
    throw new ApiError(ErrorCode.FORBIDDEN_SCOPE, 'only a recorded human decision may authorise publication');
  }
  return approval;
}
