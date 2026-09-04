#!/usr/bin/env node
// Bounded, explicit operator action: inventory — and optionally repair — the git
// credential artifacts that already exist in registered project workspaces.
//
//   node scripts/pw-git-credential-audit.mjs            # dry run, report only
//   node scripts/pw-git-credential-audit.mjs --json      # same, machine readable
//   node scripts/pw-git-credential-audit.mjs --apply     # repair the eligible subset
//
// Why this exists: artifacts written before the credential boundary landed are
// owned by root and were created by a root process writing through a pathname
// into a directory the pane account controls. They keep working, so nothing
// forces them to be fixed — an operator has to be able to see them and correct
// them deliberately.
//
// What makes it bounded:
//   * SCOPE IS THE REGISTRY. It reads the same projects.json the dashboard uses
//     and inspects nothing else. There is no filesystem walk, so an unregistered
//     repository is never touched or even opened.
//   * It runs the work AS THE RESOLVED WORKSPACE OWNER, through the same
//     privilege-drop helper the dashboard uses (app/credential-writer.mjs). This
//     process may be root; the repository work never is.
//   * It takes the credential serialization domain, so a repair cannot overlap a
//     live rotation, revocation, or project rename/delete.
//   * It REPORTS states it cannot service — a `.git` file / linked worktree, a
//     foreign-owned repository, a directory planted at the credential path — and
//     refuses them. It never removes a tree and never recursively chowns.
//   * Output is file METADATA only. No credential value is ever read into this
//     process, printed, or logged.
//
// Everything environment-specific arrives as configuration: PW_REGISTRY_PATH,
// PW_WORKSPACES, and the same terminal-owner resolution the dashboard performs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { makePasswdLookup, resolveTerminalOwner } from '../app/terminal-owner.js';
import { makeSecretCrypto } from '../app/secret-crypto.js';
import { loadUsersFile } from '../app/users-file.js';
import { credentialDropArgv, credentialExecutionPlan, spawnCredentialJob } from '../app/user-credentials.js';
import { makeCredentialLockDomain } from '../app/credential-domain-lock.js';

const execFileAsync = promisify(execFile);
const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const CREDENTIAL_HELPER = path.join(APP_DIR, 'credential-writer.mjs');

function usage() {
  process.stdout.write(`Usage: pw-git-credential-audit [--apply] [--json]

  (default)  report the credential state of every registered project
  --apply    repair the eligible subset, as the resolved workspace owner
  --json     emit the raw report instead of a table
`);
}

// Rewrite one project's credential pair from the AUTHORITATIVE current state.
//
// This is how a root-owned artifact is dealt with. It is never read, never
// copied, never compared: the current credential is written into a fresh
// owner-owned file which is renamed over it (the owner may do that because it
// owns the DIRECTORY), and the old inode simply goes away unread. With no
// current credential the pair is revoked instead — an explicit safe state that
// cannot use or expose the old value.
async function resyncFromAuthoritativeState({ project, token, workspaceRoot, registeredPaths, expectedUid, argv }) {
  return spawnCredentialJob({
    spawn,
    argv,
    job: {
      action: 'git-credential',
      workspaceRoot,
      projectPath: project.path,
      registeredPaths,
      token,
      expectedUid,
    },
    timeoutMs: 120000,
  });
}

const STATUS_NOTE = {
  ok: 'correct',
  absent: 'no credential yet',
  'needs-repair': 'REPAIRABLE',
  'unsupported-artifact': 'REFUSED — inspect by hand',
  'linked-worktree': 'REFUSED — .git file / linked worktree',
  'unsupported-repository': 'REFUSED — unusable repository path',
  'unsupported-workspace': 'REFUSED — outside the configured workspace',
  'foreign-git': 'REFUSED — .git not owned by the workspace owner',
  'no-repository': 'no workspace or no .git',
  error: 'ERROR',
};

function renderTable(report) {
  const rows = report.projects;
  const width = Math.max(7, ...rows.map((r) => String(r.project).length));
  const lines = [
    `workspace root : ${report.workspaceRoot}`,
    `projects       : ${report.inspected}`,
    `mode           : ${report.applied ? 'APPLY (repairs performed)' : 'dry run (nothing changed)'}`,
    '',
    `${'PROJECT'.padEnd(width)}  ${'STATUS'.padEnd(22)}  ${'ACTION'.padEnd(13)}  DETAIL`,
  ];
  for (const r of rows) {
    const mode = r.artifact?.present ? ` [mode ${r.artifact.mode.toString(8)}, uid ${r.artifact.uid}]` : '';
    lines.push(
      `${String(r.project).padEnd(width)}  ${String(r.status).padEnd(22)}  ${String(r.action ?? '-').padEnd(13)}  ` +
      `${STATUS_NOTE[r.status] || r.status}${mode}${r.detail ? ` — ${r.detail}` : ''}`,
    );
  }
  const repaired = rows.filter((r) => r.action === 'repaired' || r.action === 'resynced' || r.action === 'revoked').length;
  const repairable = rows.filter((r) => r.status === 'needs-repair').length;
  const refused = rows.filter((r) => r.action === 'refused' || r.status === 'error').length;
  // Counted separately and named in the summary because it is the one finding this
  // command cannot fix: the artifact is correct and the REMOTE is wrong. Left out
  // of the summary it would sit in the table under action `none` and read as fine,
  // which is how it went unnoticed until git failed in a pane.
  const unusable = rows.filter((r) => r.status === 'unusable-credential').length;
  lines.push('', `repairable: ${repairable}   repaired: ${repaired}   refused/unserviceable: ${refused}   unusable: ${unusable}`);
  if (!report.applied && repairable) lines.push('Re-run with --apply to repair the repairable rows.');
  if (unusable) {
    lines.push(
      '',
      'UNUSABLE means the credential is correct but the remote URL asks for a username it cannot satisfy,',
      'so git prompts and fails with no tty. Not repaired here: which remote is right is your call.',
      'PW stores the token in the username field, so the remote must NOT carry one:',
      '  git -C <workspace> remote set-url origin https://github.com/<org>/<repo>.git',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { usage(); return; }
  const apply = args.includes('--apply');
  const asJson = args.includes('--json');
  const unknown = args.filter((a) => !['--apply', '--json'].includes(a));
  if (unknown.length) {
    process.stderr.write(`pw-git-credential-audit: unknown argument ${unknown[0]}\n`);
    usage();
    process.exitCode = 2;
    return;
  }

  const registryPath = process.env.PW_REGISTRY_PATH || '/etc/project-workbench/projects.json';
  const workspaceRoot = process.env.PW_WORKSPACES || '/opt/project-workbench/workspaces';

  let projects;
  try {
    projects = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`pw-git-credential-audit: cannot read the project registry at ${registryPath}: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(projects)) {
    process.stderr.write(`pw-git-credential-audit: ${registryPath} does not contain a project array\n`);
    process.exitCode = 1;
    return;
  }

  // The owner is resolved from passwd, INDEPENDENTLY of whoever runs this — an
  // ownership check against our own uid could not fail when run as root.
  let owner;
  try {
    owner = await resolveTerminalOwner(process.env, makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile }));
  } catch (e) {
    process.stderr.write(`pw-git-credential-audit: cannot resolve the workspace owner account: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  const currentUid = process.getuid?.() ?? null;
  const plan = credentialExecutionPlan({ owner, currentUid });
  const expectedUid = owner ? Number(owner.uid) : currentUid;
  if (apply && plan.drop === false && owner && currentUid !== Number(owner.uid)) {
    process.stderr.write('pw-git-credential-audit: refusing to repair without a usable privilege drop to the workspace owner\n');
    process.exitCode = 1;
    return;
  }

  const domain = makeCredentialLockDomain({
    lockPaths: {
      lifecycle: process.env.PW_LIFECYCLE_LOCK_PATH || path.join(path.dirname(process.env.PW_USERS_PATH || '/etc/project-workbench/users.json'), '.pw-lifecycle.lock'),
      workspace: process.env.PW_WORKSPACE_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-workspace.lock'),
      projects: process.env.PW_PROJECTS_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-projects.lock'),
      credential: process.env.PW_CREDENTIAL_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-credential.lock'),
    },
  });

  const job = {
    action: 'git-credential-audit',
    workspaceRoot,
    projects: projects.map((p) => ({ name: p?.name, path: p?.path })).filter((p) => p.path),
    expectedUid,
    apply,
  };
  const argv = plan.drop
    ? credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath: CREDENTIAL_HELPER })
    : [process.execPath, CREDENTIAL_HELPER];

  let report;
  try {
    // Repairs must not overlap a live rotation, revocation, or project mutation.
    report = await domain.withLocks(['lifecycle', 'projects', 'credential'], async () => {
      const audited = await spawnCredentialJob({ spawn, argv, job, timeoutMs: 120000 });
      if (!apply) return audited;

      // Rows the owner-side helper deliberately refused to convert: an artifact
      // owned by somebody else. Rewrite those from the authoritative credential
      // state instead of touching the old bytes.
      const needResync = audited.projects.filter((r) => r.resyncRequired);
      if (!needResync.length) return audited;

      const secretKeyPath = process.env.PW_SECRET_KEY_PATH || '/etc/project-workbench/.secret-key';
      const usersPath = process.env.PW_USERS_PATH || '/etc/project-workbench/users.json';
      let decrypt;
      let users = [];
      try {
        // PROVE the authoritative state is readable before converting anything.
        // Neither loader announces its own absence: loadUsersFile() returns an
        // empty list for a missing store, and makeSecretCrypto() does not touch
        // the key until something is decrypted. Taken at face value, both would
        // resolve to "this project has no credential" and REVOKE a perfectly
        // good one. An absent store is missing information, not an answer.
        await fs.access(usersPath);
        const crypto_ = makeSecretCrypto({ secretKeyPath });
        crypto_.encrypt('probe');
        decrypt = crypto_.decrypt;
        users = await loadUsersFile(usersPath);
      } catch (e) {
        // Refusing to act and still printing an actionable-looking row would be a
        // false success: the operator would read "resync-required" as a plan, and
        // the exit code as agreement. Mark the affected rows BLOCKED and fail.
        process.stderr.write(`pw-git-credential-audit: cannot read the authoritative credential state (${e.message}); ` +
          'refusing to guess — no artifact was converted\n');
        return {
          ...audited,
          blocked: true,
          projects: audited.projects.map((r) => (r.resyncRequired
            ? { ...r, action: 'blocked', resyncRequired: false, detail: 'the authoritative credential state could not be read, so nothing was converted' }
            : r)),
        };
      }

      const byPath = new Map(projects.filter((p) => p?.path).map((p) => [p.path, p]));
      const registeredPaths = job.projects.map((p) => p.path);
      const resolved = new Map();
      for (const row of needResync) {
        const project = byPath.get(row.path);
        // Revocation must be a POSITIVE authoritative decision — this project has
        // no owner, or its owner holds no token — never the residue of a lookup
        // that failed. Anything unresolved is blocked and reported.
        const blocked = (why) => resolved.set(row.path, {
          ...row, action: 'blocked', resyncRequired: false, detail: why,
        });
        let token = '';
        if (!project) { blocked('the project is no longer in the registry'); continue; }
        if (project.primaryUser) {
          const record = users.find((u) => u.username === project.primaryUser);
          if (!record) { blocked(`primaryUser "${project.primaryUser}" does not resolve to a user record`); continue; }
          if (record.ghToken) {
            try { token = decrypt(record.ghToken) || ''; } catch { token = ''; }
            if (!token) { blocked(`the credential for "${project.primaryUser}" could not be decrypted`); continue; }
          }
        }
        try {
          const result = await resyncFromAuthoritativeState({
            project, token, workspaceRoot, registeredPaths, expectedUid, argv,
          });
          resolved.set(row.path, token
            ? { ...row, action: 'resynced', detail: 'rewritten from the current credential; the old value was discarded unread', artifact: result.artifact }
            : { ...row, action: 'revoked', detail: 'no current credential for this project; the unusable artifact and its helper were removed' });
        } catch (e) {
          resolved.set(row.path, { ...row, action: 'failed', detail: e.message });
        }
      }
      return { ...audited, projects: audited.projects.map((r) => resolved.get(r.path) ?? r) };
    });
  } catch (e) {
    process.stderr.write(`pw-git-credential-audit: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTable(report));
  // Anything the operator still has to deal with by hand is a nonzero exit, so
  // this is usable from a check.
  if (report.blocked
    || report.projects.some((r) => r.status === 'error' || r.action === 'failed' || r.action === 'blocked')) {
    process.exitCode = 1;
  }
}

await main();
