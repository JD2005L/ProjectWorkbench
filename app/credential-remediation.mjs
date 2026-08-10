// Finding and safely repairing credential artifacts that the old root-write path already created.
//
// Fixing the write path stops NEW bad artifacts. It does nothing about the ones already on disk, and
// GOA has confirmed at least one live: a root-owned `0600` `.pw-credentials` inside a `.git` owned
// by the unprivileged pane account. That file is both a boundary violation and a working failure —
// the pane account cannot read it, so git authentication silently fails for the user it belongs to,
// and no amount of correct future behaviour repairs it.
//
// HOW IT IS REPAIRED, AND WHY NOT BY CHOWN
//
// Not with `chown`. Root chowning a file inside a directory the pane account controls is the same
// class of mistake as writing it there in the first place: the path can be swapped underneath, and
// it needs root at the moment we are trying to stop using root. And certainly not with a recursive
// chown of the workspace — that rewrites files the product never created, which is destructive and
// unasked for.
//
// Instead: REPLACE, as the owner. Running as the workspace account, unlink the bad artifact and
// write a fresh one through the same atomic, no-follow path a normal rotation uses. The pane account
// can unlink a file inside its own directory regardless of who owns the file, so this needs no
// privilege at all — and the result is owned by the right account by construction rather than by a
// follow-up fix-up. Where the current token is not available, the artifact is removed and the
// configuration cleared, because a credential nobody can read is worth less than no credential.
//
// WHAT IS VALIDATED BEFORE ANYTHING IS TOUCHED
//
// The workspace must be a real directory, `.git` must be a real directory owned by the expected
// account, and the artifact must be a regular file. Symlinks are never followed and never
// "repaired" — a link at that path is reported and unlinked as a link, never resolved. A workspace
// whose `.git` is not owned by the expected account is reported and skipped, not forced.
//
// Nothing here reads the artifact's contents, and no credential material enters a report.

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  inspectCredentialStore, removeCredentialStore, writeCredentialStore,
  CREDENTIAL_FILENAME, CredentialBoundaryError,
} from './git-credential-store.mjs';

export { CREDENTIAL_FILENAME };

/** Is this workspace shaped the way remediation requires? Never follows, never modifies. */
export async function classifyWorkspace({ projectPath, expectUid }) {
  if (!projectPath || !path.isAbsolute(projectPath)) {
    return { usable: false, reason: 'project path is not absolute' };
  }
  let wsStat;
  try {
    wsStat = await fsp.lstat(projectPath);
  } catch {
    return { usable: false, reason: 'workspace does not exist' };
  }
  if (wsStat.isSymbolicLink()) return { usable: false, reason: 'workspace path is a symlink' };
  if (!wsStat.isDirectory()) return { usable: false, reason: 'workspace path is not a directory' };

  let gitStat;
  try {
    gitStat = await fsp.lstat(path.join(projectPath, '.git'));
  } catch {
    return { usable: false, reason: 'no .git directory' };
  }
  if (gitStat.isSymbolicLink()) return { usable: false, reason: '.git is a symlink' };
  if (!gitStat.isDirectory()) return { usable: false, reason: '.git is not a directory' };
  if (expectUid !== undefined && expectUid !== null && gitStat.uid !== expectUid) {
    return { usable: false, reason: `.git is owned by uid ${gitStat.uid}, not the expected workspace owner`, gitUid: gitStat.uid };
  }
  return { usable: true, gitUid: gitStat.uid };
}

/**
 * What credential artifacts exist across these workspaces, and which need repair. Read-only.
 *
 * @param {object}   o
 * @param {string[]} o.projectPaths  absolute workspace paths (from the registry; never globbed)
 * @param {number}   [o.expectUid]   the account artifacts should belong to
 * @returns {Promise<{scanned:number, findings:Array}>} findings carry paths and status, never content
 */
export async function inventoryCredentialArtifacts({ projectPaths = [], expectUid }) {
  const findings = [];
  for (const projectPath of projectPaths) {
    const shape = await classifyWorkspace({ projectPath, expectUid });
    if (!shape.usable) {
      // Only worth reporting when there is actually an artifact to worry about; a project without a
      // .git is simply not cloned yet.
      const peek = await inspectCredentialStore({ projectPath }).catch(() => ({ kind: 'absent' }));
      if (peek.kind !== 'absent') {
        findings.push({ projectPath, status: 'unsafe-workspace', reason: shape.reason, kind: peek.kind });
      }
      continue;
    }
    const found = await inspectCredentialStore({ projectPath });
    if (found.kind === 'absent') continue;

    if (found.kind !== 'regular') {
      findings.push({ projectPath, status: 'unsafe-artifact', kind: found.kind, path: found.path });
      continue;
    }
    const wrongOwner = expectUid !== undefined && expectUid !== null && found.uid !== expectUid;
    const wrongMode = found.mode !== 0o600;
    const extraLinks = found.nlink > 1;
    findings.push({
      projectPath,
      path: found.path,
      kind: 'regular',
      uid: found.uid,
      mode: found.mode,
      nlink: found.nlink,
      status: (wrongOwner || wrongMode || extraLinks) ? 'needs-remediation' : 'ok',
      reasons: [
        ...(wrongOwner ? ['owned by another account'] : []),
        ...(wrongMode ? [`mode is ${found.mode.toString(8)}, not 600`] : []),
        ...(extraLinks ? [`link count is ${found.nlink}`] : []),
      ],
    });
  }
  return { scanned: projectPaths.length, findings };
}

/**
 * Repair one workspace's artifact by replacing it as the owner.
 *
 * @param {object}   o
 * @param {string}   o.projectPath
 * @param {number}   [o.expectUid]
 * @param {string}   [o.token]     the current token; when absent the artifact is removed instead of
 *                                 rewritten, because an unreadable credential is worse than none
 * @param {boolean}  [o.dryRun]    report what would happen and change nothing
 */
export async function remediateCredentialArtifact({ projectPath, expectUid, token = '', dryRun = false }) {
  const shape = await classifyWorkspace({ projectPath, expectUid });
  if (!shape.usable) {
    return { projectPath, action: 'skipped', reason: shape.reason };
  }
  const found = await inspectCredentialStore({ projectPath });
  if (found.kind === 'absent') return { projectPath, action: 'absent' };

  const needsWork = found.kind !== 'regular'
    || found.nlink > 1
    || found.mode !== 0o600
    || (expectUid !== undefined && expectUid !== null && found.uid !== expectUid);
  if (!needsWork) return { projectPath, action: 'already-correct' };

  if (dryRun) {
    return { projectPath, action: 'would-remediate', kind: found.kind, uid: found.uid, mode: found.mode };
  }

  try {
    // Unlink first, in every case. For a symlink this removes the LINK, never its target. For a
    // foreign-owned regular file this is what a chown would otherwise have been needed for, and the
    // pane account may do it because it owns the containing directory.
    const removed = await removeCredentialStore({ projectPath, expectUid });
    if (!token) {
      return { projectPath, action: 'removed', previousKind: found.kind, removed: removed.action };
    }
    const written = await writeCredentialStore({ projectPath, token, expectUid });
    return { projectPath, action: 'replaced', previousKind: found.kind, previousUid: found.uid, path: written.path };
  } catch (e) {
    if (e instanceof CredentialBoundaryError) {
      return { projectPath, action: 'failed', reason: e.reason };
    }
    return { projectPath, action: 'failed', reason: `unexpected error (${e?.code || 'unknown'})` };
  }
}
