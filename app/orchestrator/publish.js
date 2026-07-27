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

import path from 'path';

import {
  SCHEMA_VERSION, CiState, ApprovalStatus, ApprovalType, ErrorCode, newId,
} from './contract.js';
import { ApiError, notFound } from './errors.js';
import { runGit } from './git.js';
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

  _git(argv, cwd) {
    return runGit(argv, { cwd, gitExecutable: this.config.gitExecutable, exec: this.exec });
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
      const resolved = path.resolve(root, file);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new ApiError(ErrorCode.UNSAFE_PATH, 'an intended file resolves outside the project workspace');
      }
    }
  }

  async publish({ job, project, workspacePath, request }) {
    this.assertIntendedFilesSafe(request.intended_files, workspacePath);
    const steps = [];
    const record = (step, result) => {
      steps.push({ step, exit_code: result.exitCode, stderr: redactText(result.stderr, { maxLength: 500 }) });
      return result;
    };

    // -- stage only the intended files ------------------------------------
    // `--` separates paths from revisions, so a filename can never be read as a ref or an option.
    const add = record('add', await this._git(['add', '--', ...request.intended_files], workspacePath));
    if (!add.ok) return this._failed(job, 'the intended files could not be staged', steps);

    // -- verify what is actually staged -----------------------------------
    // Staging is not the same as having staged *only* what was asked for: a pre-existing index entry
    // would ride along into the commit unnoticed.
    const staged = await this._git(['diff', '--cached', '--name-only'], workspacePath);
    const stagedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const intended = [...request.intended_files].sort();
    if (JSON.stringify(stagedFiles) !== JSON.stringify(intended)) {
      return this._failed(
        job,
        `the staged set does not match the intended set (${stagedFiles.length} staged, ${intended.length} intended)`,
        steps,
      );
    }
    if (!stagedFiles.length) {
      return this._failed(job, 'there is nothing to publish', steps);
    }

    // -- commit -----------------------------------------------------------
    // No -a: only the explicitly staged set is committed. An `-a` here would sweep up every other
    // dirty file in the operator's checkout.
    const commit = record('commit', await this._git(['commit', '-m', request.commit_message], workspacePath));
    if (!commit.ok) return this._failed(job, 'the commit failed', steps);

    const localHead = await this._git(['rev-parse', 'HEAD'], workspacePath);
    const localCommit = localHead.stdout.trim();
    if (!FULL_SHA.test(localCommit)) return this._failed(job, 'the local commit could not be determined', steps);

    // -- push -------------------------------------------------------------
    // An explicit refspec, never a bare `git push`: what gets pushed must not depend on the
    // repository's push configuration.
    const push = record('push', await this._git(['push', 'origin', `HEAD:refs/heads/${request.branch}`], workspacePath));
    const pushed = push.ok;

    // -- verify the remote actually has it --------------------------------
    let remoteCommit = null;
    if (pushed) {
      const lsRemote = await this._git(['ls-remote', 'origin', `refs/heads/${request.branch}`], workspacePath);
      const candidate = lsRemote.stdout.split(/\s+/)[0]?.trim() ?? '';
      if (FULL_SHA.test(candidate)) remoteCommit = candidate;
    }
    // Only an exact full-SHA match counts. Abbreviations are refused by the type; a mismatch here
    // means the branch on the remote is not the commit that was just made.
    const remoteShaVerified = Boolean(pushed && remoteCommit && localCommit === remoteCommit);

    // -- the live pull request --------------------------------------------
    let pullRequest = { url: null, state: null, headSha: null, mergeable: null, ciState: CiState.NOT_STARTED };
    if (remoteShaVerified && request.open_pull_request) {
      pullRequest = await this._pullRequest(workspacePath, request.branch, project);
    } else if (!project.has_ci) {
      pullRequest.ciState = CiState.NOT_CONFIGURED;
    }

    const changed = await this._git(['show', '--numstat', '--format=', localCommit], workspacePath);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    const changedFiles = [];
    for (const line of changed.stdout.split('\n').filter(Boolean)) {
      const [added, removed, file] = line.split('\t');
      files += 1;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
      if (file) changedFiles.push(file);
    }

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
  async _pullRequest(workspacePath, branch, project) {
    const base = project.default_branch ?? 'main';
    const gh = async (argv) => {
      try {
        const { stdout } = await (this.exec ?? (await import('util')).promisify((await import('child_process')).execFile))(
          this.config.ghExecutable, argv, { cwd: workspacePath, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
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

  /** A publication that did not complete. Never partially claimed as success. */
  _failed(job, reason, steps) {
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
