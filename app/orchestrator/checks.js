// Deterministic verification, and the artifact store that holds its output.
//
// This is where "evidence, not narrative" is actually enforced. A phase result is a model's account
// of what it did; a `Check` is an exit code. The orchestrator is given the latter, and the two are
// never conflated — `Check` even refuses to record a passing outcome alongside a non-zero failure
// count, so an optimistic caller cannot construct a passing check from a failing run.
//
// Every check is an *allowlisted, canonicalised* entry: the caller names a check kind, never a
// command. `required_checks` in a task contract selects from this catalogue, so there is no typed
// field anywhere that carries a shell string.

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  SCHEMA_VERSION, CheckKind, CheckOutcome, ArtifactKind, MAX_ARTIFACT_BYTES, MAX_EXCERPT_BYTES,
  newId,
} from './contract.js';
import { ApiError, notFound, payloadTooLarge } from './errors.js';
import { ErrorCode } from './contract.js';
import { redactText, scanForSecrets } from './redact.js';
import { runGit } from './git.js';

const execFileAsync = promisify(execFile);

/**
 * The check catalogue.
 *
 * `command` is a fixed argv template, not a string to be interpolated. `fromProject` marks the
 * checks whose command comes from the project's *configured* verification commands rather than from
 * here — those are still not caller-supplied, they are operator-supplied at install time.
 */
export const CHECK_CATALOGUE = Object.freeze({
  targeted_test: { kind: CheckKind.TARGETED_TEST, fromProject: true, index: 0, name: 'targeted tests' },
  full_test_suite: { kind: CheckKind.FULL_TEST_SUITE, fromProject: true, index: 0, name: 'full test suite' },
  canonical_verification: { kind: CheckKind.CANONICAL_VERIFICATION, fromProject: true, allCommands: true, name: 'canonical verification' },
  diff_check: { kind: CheckKind.DIFF_CHECK, git: ['diff', '--check'], name: 'git diff --check' },
  secret_scan: { kind: CheckKind.SECRET_SCAN, internal: 'secret_scan', name: 'added-line secret scan' },
  contract_check: { kind: CheckKind.CONTRACT_CHECK, internal: 'contract_check', name: 'contract fixture check' },
});

/** Names a caller may put in `required_checks`. Anything else is refused, not ignored. */
export const ALLOWED_CHECK_NAMES = Object.freeze(Object.keys(CHECK_CATALOGUE));

export function canonicaliseCheckName(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!Object.hasOwn(CHECK_CATALOGUE, key)) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, 'unknown check', {
      fieldErrors: [{ field: 'required_checks', message: `must be one of: ${ALLOWED_CHECK_NAMES.join(', ')}` }],
    });
  }
  return key;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/**
 * Bounded, redacted storage for raw evidence.
 *
 * Raw logs stay here, on the ProjectWorkbench side. Events carry headline numbers and an
 * `artifact_id`; a caller that wants detail asks for a bounded excerpt. That is what stops a whole
 * test log flooding the orchestrator's reasoning context — and it is why the excerpt API takes an
 * opaque id and a byte offset rather than anything resembling a path.
 */
export class ArtifactStore {
  constructor({ config, repo, store, clock = () => new Date() }) {
    this.config = config;
    this.repo = repo;
    this.store = store;
    this.clock = clock;
  }

  _pathFor(artifactId) {
    // The id is generated here and matches a strict pattern, so it cannot traverse. Verified again
    // rather than assumed, because this is the one place an id becomes a filesystem path.
    if (!/^pwart_[a-f0-9]{32}$/.test(artifactId)) {
      throw new ApiError(ErrorCode.UNSAFE_PATH, 'invalid artifact reference');
    }
    return path.join(this.config.artifactDir, `${artifactId}.txt`);
  }

  /** Persist evidence, returning its metadata. Content is redacted *before* it is written. */
  async write({ jobId, kind = ArtifactKind.LOG, name, content, summary = null }) {
    const artifactId = newId('pwart');
    const redacted = redactText(String(content ?? ''), { maxLength: MAX_ARTIFACT_BYTES });
    const body = Buffer.from(redacted, 'utf8');
    if (body.length > MAX_ARTIFACT_BYTES) throw payloadTooLarge('the artifact exceeds the configured limit');

    await fs.mkdir(this.config.artifactDir, { recursive: true });
    await fs.writeFile(this._pathFor(artifactId), body, { mode: 0o600 });

    const metadata = {
      schema_version: SCHEMA_VERSION,
      artifact_id: artifactId,
      job_id: jobId,
      kind,
      name,
      media_type: 'text/plain',
      size_bytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      created_at: this.clock().toISOString(),
      redacted: true,
      summary: summary ? redactText(summary, { maxLength: 2_000 }) : null,
    };
    await this.store.transact((tx) => { this.repo.putArtifact(tx, metadata); });
    return metadata;
  }

  metadata(artifactId) {
    const record = this.repo.getArtifact(artifactId);
    if (!record) throw notFound('no such artifact');
    return record;
  }

  /** A bounded window. Re-redacted on the way out: the stored copy is not the last line of defence. */
  async excerpt({ artifactId, byteOffset = 0, maxBytes = 8_192 }) {
    const metadata = this.metadata(artifactId);
    const bounded = Math.min(Math.max(1, maxBytes), MAX_EXCERPT_BYTES);
    const filePath = this._pathFor(artifactId);

    let buffer = Buffer.alloc(0);
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const chunk = Buffer.alloc(bounded);
        const { bytesRead } = await handle.read(chunk, 0, bounded, byteOffset);
        buffer = chunk.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      throw notFound('the artifact content is no longer available');
    }

    return {
      schema_version: SCHEMA_VERSION,
      artifact_id: artifactId,
      job_id: metadata.job_id,
      content: redactText(buffer.toString('utf8'), { maxLength: MAX_EXCERPT_BYTES }),
      truncated: byteOffset + buffer.length < metadata.size_bytes,
      byte_offset: byteOffset,
      total_bytes: metadata.size_bytes,
    };
  }
}

// ---------------------------------------------------------------------------
// running checks
// ---------------------------------------------------------------------------

/** Parse headline counts out of common test-runner output. Absent counts stay null, never zero. */
export function parseTestCounts(output) {
  const text = String(output ?? '');
  // node:test / TAP
  const tapPass = /^#\s*pass\s+(\d+)$/m.exec(text);
  const tapFail = /^#\s*fail\s+(\d+)$/m.exec(text);
  if (tapPass || tapFail) {
    return { passed: tapPass ? Number(tapPass[1]) : null, failed: tapFail ? Number(tapFail[1]) : null };
  }
  // pytest
  const pytest = /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/.exec(text);
  if (pytest) return { passed: Number(pytest[1]), failed: pytest[2] ? Number(pytest[2]) : 0 };
  // jest / vitest
  const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/.exec(text);
  if (jest) return { passed: Number(jest[2]), failed: jest[1] ? Number(jest[1]) : 0 };
  return { passed: null, failed: null };
}

/**
 * A `Check` record.
 *
 * The consistency rules mirror the contract's own validators, and they matter: a check that did not
 * run may not report results, and a passing check may not carry failures. Constructing the record
 * through here is what makes "targeted tests passed" impossible to confuse with "the suite passed" —
 * they are different kinds, recorded separately.
 */
export function buildCheck({ jobId, kind, name, outcome, command = null, exitCode = null, passed = null, failed = null, durationSeconds = null, artifactId = null, recordedAt }) {
  if (outcome === CheckOutcome.PASSED && (failed ?? 0) > 0) {
    throw new Error('a passed check cannot report failures');
  }
  if (outcome === CheckOutcome.NOT_RUN && (exitCode !== null || passed !== null)) {
    throw new Error('a check that did not run cannot report results');
  }
  return {
    schema_version: SCHEMA_VERSION,
    check_id: newId('pwchk'),
    job_id: jobId,
    kind,
    name,
    outcome,
    command: command ? redactText(command, { maxLength: 2_000 }) : null,
    exit_code: exitCode,
    passed_count: passed,
    failed_count: failed,
    duration_seconds: durationSeconds,
    artifact_id: artifactId,
    recorded_at: recordedAt,
  };
}

export class CheckRunner {
  constructor({ config, repo, store, artifacts, exec = execFileAsync, clock = () => new Date() }) {
    this.config = config;
    this.repo = repo;
    this.store = store;
    this.artifacts = artifacts;
    this.exec = exec;
    this.clock = clock;
  }

  /**
   * Run one allowlisted check in a workspace.
   *
   * A configured verification command is split on whitespace and executed with no shell. That is a
   * deliberate limitation: it means an operator cannot configure `a && b` or a pipeline, and must
   * instead point at a script. A shell here would make every configured command a shell-injection
   * surface for anything that can influence configuration.
   */
  async run({ jobId, checkName, project, cwd }) {
    const key = canonicaliseCheckName(checkName);
    const spec = CHECK_CATALOGUE[key];
    const startedAt = Date.now();
    const recordedAt = this.clock().toISOString();

    if (spec.internal === 'secret_scan') return this._secretScan({ jobId, cwd, spec, recordedAt, startedAt });
    if (spec.git) return this._gitCheck({ jobId, cwd, spec, recordedAt, startedAt });

    const commands = this._commandsFor(spec, project);
    if (!commands.length) {
      // Configured but not available for this project. Reported explicitly as not_run — never as
      // passed, which is the whole reason CheckOutcome has a NOT_RUN member.
      return {
        check: buildCheck({
          jobId, kind: spec.kind, name: spec.name, outcome: CheckOutcome.NOT_RUN, recordedAt,
        }),
        artifact: null,
        terminationConfirmed: null,
      };
    }

    let combined = '';
    let lastExit = 0;
    // `null` until a command actually reports an unconfirmed kill — never rounded up to "confirmed"
    // just because a later command in the chain never ran (it was never reached, so it never had a
    // verdict to report either way, and the loop already stops at the first non-zero exit below).
    let terminationConfirmed = null;
    for (const command of commands) {
      const [file, ...args] = command.split(/\s+/).filter(Boolean);
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this._exec(file, args, cwd);
      combined += `$ ${command}\n${outcome.stdout}${outcome.stderr}\n`;
      lastExit = outcome.exitCode;
      if (outcome.terminationConfirmed === false) {
        terminationConfirmed = false;
        // Stop the chain immediately: whichever command was scheduled next never gets to run once
        // one already could not be confirmed dead.
        break;
      }
      if (lastExit !== 0) break;
    }

    if (terminationConfirmed === false) {
      // The artifact write below is real disk I/O plus a store transaction, and can throw for
      // reasons that have nothing to do with the kill (ENOSPC, a store contention error). An
      // unconfirmed kill must be reported before that fallible work ever runs, so an unrelated
      // secondary failure there can never be the thing that erases this verdict on its way out.
      return {
        check: buildCheck({
          jobId, kind: spec.kind, name: spec.name, outcome: CheckOutcome.FAILED,
          command: commands.join(' && '), exitCode: lastExit,
          durationSeconds: (Date.now() - startedAt) / 1_000, recordedAt,
        }),
        artifact: null,
        terminationConfirmed,
      };
    }

    const counts = parseTestCounts(combined);
    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.TEST_REPORT, name: `${key}.log`, content: combined,
      summary: `${spec.name}: exit ${lastExit}`,
    });

    return {
      check: buildCheck({
        jobId,
        kind: spec.kind,
        name: spec.name,
        outcome: lastExit === 0 ? CheckOutcome.PASSED : CheckOutcome.FAILED,
        command: commands.join(' && '),
        exitCode: lastExit,
        // A passing run with no parseable counts reports null rather than inventing a zero.
        passed: lastExit === 0 ? counts.passed : counts.passed,
        failed: lastExit === 0 ? 0 : (counts.failed ?? null),
        durationSeconds: (Date.now() - startedAt) / 1_000,
        artifactId: artifact.artifact_id,
        recordedAt,
      }),
      artifact,
      terminationConfirmed,
    };
  }

  _commandsFor(spec, project) {
    const configured = project?.verification_commands ?? [];
    if (spec.allCommands) return [...configured];
    const single = configured[spec.index ?? 0];
    return single ? [single] : [];
  }

  async _exec(file, args, cwd) {
    try {
      const { stdout, stderr } = await this.exec(file, args, {
        cwd, timeout: this.config.checkTimeoutMs, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      return { exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), terminationConfirmed: null };
    } catch (err) {
      return {
        exitCode: Number.isInteger(err?.code) ? err.code : 1,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? err?.message ?? ''),
        // `null` for an ordinary non-zero exit (the common case — most checks are SUPPOSED to be
        // able to fail); `false` only when `PrivilegeDropper._execTracked` actually killed this
        // command and could not confirm its whole descendant tree died with it. The engine must
        // fence on `false`, never merely record the check as failed.
        terminationConfirmed: err?.terminationConfirmed ?? null,
      };
    }
  }

  async _gitCheck({ jobId, cwd, spec, recordedAt, startedAt }) {
    const result = await runGit(spec.git, { cwd, gitExecutable: this.config.gitExecutable, exec: this.exec });
    if (result.terminationConfirmed === false) {
      // Same rule as the configured-command path above: stop before the fallible artifact write,
      // not after it.
      return {
        check: buildCheck({
          jobId, kind: spec.kind, name: spec.name, outcome: CheckOutcome.FAILED,
          command: `git ${spec.git.join(' ')}`, exitCode: result.exitCode,
          durationSeconds: (Date.now() - startedAt) / 1_000, recordedAt,
        }),
        artifact: null,
        terminationConfirmed: false,
      };
    }
    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.LOG, name: `${spec.kind}.log`,
      content: `$ git ${spec.git.join(' ')}\n${result.stdout}${result.stderr}`,
      summary: `${spec.name}: exit ${result.exitCode}`,
    });
    return {
      check: buildCheck({
        jobId, kind: spec.kind, name: spec.name,
        outcome: result.ok ? CheckOutcome.PASSED : CheckOutcome.FAILED,
        command: `git ${spec.git.join(' ')}`, exitCode: result.exitCode,
        failed: result.ok ? 0 : null,
        durationSeconds: (Date.now() - startedAt) / 1_000,
        artifactId: artifact.artifact_id, recordedAt,
      }),
      artifact,
      terminationConfirmed: result.terminationConfirmed,
    };
  }

  /**
   * Scan *added* lines for credential shapes.
   *
   * Added lines specifically: the question a publication gate needs answered is "did this change
   * introduce a secret", not "does this repository contain a file that mentions one".
   */
  async _secretScan({ jobId, cwd, spec, recordedAt, startedAt }) {
    const diff = await runGit(['diff', 'HEAD', '--unified=0'], { cwd, gitExecutable: this.config.gitExecutable, exec: this.exec });
    if (diff.terminationConfirmed === false) {
      // Same rule again: an unconfirmed kill on the diff this scan depends on stops here, before the
      // added-line parsing, the scan, and the fallible artifact write that follow.
      return {
        check: buildCheck({
          jobId, kind: spec.kind, name: spec.name, outcome: CheckOutcome.FAILED,
          command: 'git diff HEAD --unified=0 | added-line credential scan', exitCode: diff.exitCode,
          durationSeconds: (Date.now() - startedAt) / 1_000, recordedAt,
        }),
        artifact: null,
        terminationConfirmed: false,
      };
    }
    const addedLines = [];
    let currentFile = null;
    let lineNumber = 0;
    for (const line of diff.stdout.split('\n')) {
      if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) { lineNumber = Number(hunk[1]); continue; }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push({ file: currentFile, line: lineNumber, text: line.slice(1) });
        lineNumber += 1;
      }
    }

    const findings = scanForSecrets(addedLines);
    const report = findings.length
      ? findings.map((f) => `${f.file}:${f.line}: ${f.rule}`).join('\n')
      : 'no credential-shaped content found in added lines';
    const artifact = await this.artifacts.write({
      jobId, kind: ArtifactKind.LOG, name: 'secret-scan.log', content: report,
      summary: `${findings.length} finding(s) across ${addedLines.length} added line(s)`,
    });

    return {
      check: buildCheck({
        jobId, kind: spec.kind, name: spec.name,
        outcome: findings.length ? CheckOutcome.FAILED : CheckOutcome.PASSED,
        command: 'git diff HEAD --unified=0 | added-line credential scan',
        exitCode: findings.length ? 1 : 0,
        failed: findings.length, passed: findings.length ? null : addedLines.length,
        durationSeconds: (Date.now() - startedAt) / 1_000,
        artifactId: artifact.artifact_id, recordedAt,
      }),
      artifact,
      terminationConfirmed: diff.terminationConfirmed,
    };
  }
}

/**
 * Parse `--numstat -z` output.
 *
 * `-z` matters: without it git *quotes* any path containing non-ASCII bytes, so `café.txt` comes
 * back as the literal `"caf\303\251.txt"` and every comparison against a real filename fails.
 * With `--no-renames` each record is `added\tremoved\tpath`, NUL-terminated.
 */
export function parseNumstatZ(stdout) {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const changedFiles = [];
  for (const record of String(stdout).split('\0').filter(Boolean)) {
    const [added, removed, file] = record.split('\t');
    if (file === undefined) continue;
    files += 1;
    // A binary file reports `-` for both counts rather than a number.
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
    changedFiles.push(file);
  }
  return { files, insertions, deletions, changedFiles };
}

/** Changed-file and diff statistics, taken from git rather than from a model's account. */
export async function diffStat({ cwd, gitExecutable, exec, against = 'HEAD' }) {
  const numstat = await runGit(['diff', against, '--numstat', '-z', '--no-renames'], { cwd, gitExecutable, exec });
  const { files, insertions, deletions, changedFiles } = parseNumstatZ(numstat.stdout);
  return {
    stat: { schema_version: SCHEMA_VERSION, files, insertions, deletions },
    changed_files: changedFiles,
    terminationConfirmed: numstat.terminationConfirmed,
  };
}

export { fsSync };
