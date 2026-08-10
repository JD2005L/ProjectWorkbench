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
  const repaired = rows.filter((r) => r.action === 'repaired').length;
  const repairable = rows.filter((r) => r.status === 'needs-repair').length;
  const refused = rows.filter((r) => r.action === 'refused' || r.status === 'error').length;
  lines.push('', `repairable: ${repairable}   repaired: ${repaired}   refused/unserviceable: ${refused}`);
  if (!report.applied && repairable) lines.push('Re-run with --apply to repair the repairable rows.');
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
    report = await domain.withLocks(['lifecycle', 'projects', 'credential'], () =>
      spawnCredentialJob({ spawn, argv, job, timeoutMs: 120000 }));
  } catch (e) {
    process.stderr.write(`pw-git-credential-audit: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTable(report));
  // Anything the operator still has to deal with by hand is a nonzero exit, so
  // this is usable from a check.
  if (report.projects.some((r) => r.status === 'error' || r.action === 'failed')) process.exitCode = 1;
}

await main();
