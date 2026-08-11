// The one authoritative, NON-SECRET environment contract.
//
// ============================================================================
// WHY THIS EXISTS
//
// Four entrypoints need the same answers about where this instance keeps its
// state: the dashboard (app/server.js), initial terminal creation
// (scripts/project-terminal-start), persistence restore
// (scripts/pw-tmux-restore) and the host-mode tmux owner's restore. Before this
// module each of them carried its OWN defaults, and those defaults were
// host-mode paths.
//
// On a container-mode instance that is not a cosmetic inconsistency. The
// registry lives at a different path, only the dashboard's environment named it,
// and no restore unit exported it — so pw-tmux-restore resolved the host default,
// found nothing, and refused to restore EVERY session while still exiting 0.
// Reproduced as an A/B differing only in PW_REGISTRY_PATH: default path -> 0
// sessions created, exit 0; real path -> 1 session created, exit 0. A total
// refusal was indistinguishable from a clean no-op.
//
// MODE-NEUTRAL BY CONSTRUCTION. The schema is declared once here, for both
// deploy modes, even though the first wiring is host systemd units. A
// host-shaped schema that container mode could not reuse would simply recreate
// the original defect at the next integration.
//
// NON-SECRET ONLY. Every entry is a path, an enum or a boolean. Secret MATERIAL
// stays in its protected source; PW_SECRET_KEY_PATH names where the key lives
// and is not itself sensitive. Nothing here may be copied into logs, tests or
// coordination artifacts — and no entry's VALUE is a credential, which is what
// makes this file safe to render into a world-readable environment file.
// ============================================================================

import path from 'node:path';

// Distinct from a generic failure so a supervisor and an operator can tell
// "this instance is misconfigured" from "this script hit a runtime error".
// 78 is EX_CONFIG from sysexits.h, which is exactly this meaning.
export const CONFIG_ERROR_EXIT = 78;

// `access` is what a consumer must be able to DO with the path, which is the
// part that broke in practice: PW_APP_DIR's default is root-owned 0700 on a
// container-mode instance, so it existed but was unreadable to the account
// restore runs as. Existence alone was never the requirement.
//
// `requiredWhen` keeps the contract honest about conditionality: the per-user
// credential inputs are only required when the feature is on, so a shared-login
// instance is not forced to configure them.
export const ENV_SCHEMA = Object.freeze([
  {
    name: 'PW_DEPLOY_MODE',
    kind: 'enum',
    values: ['host', 'container'],
    default: 'host',
    requiredWhen: 'never',
    semantics: 'Which terminal model this instance runs: host systemd units, or the container sidecar + ttyd spawned by the dashboard.',
    note: 'Documented backward-compatible default is host. Container deployments must set it explicitly.',
  },
  {
    name: 'PW_REGISTRY_PATH',
    kind: 'file',
    access: 'read',
    default: '/opt/project-workbench/projects.json',
    requiredWhen: 'restoring',
    semantics: 'The project registry. Maps a tmux session name back to its project and primaryUser.',
  },
  {
    name: 'PW_APP_DIR',
    kind: 'dir',
    access: 'read',
    default: '/opt/project-workbench/app',
    requiredWhen: 'restoring',
    semantics: 'Where the application modules live, including the credential-resolution helper the restore path invokes.',
    helper: 'project-terminal-credentials.mjs',
  },
  {
    name: 'PW_TMUX_STATE_DIR',
    kind: 'dir',
    access: 'read-write',
    default: '/var/lib/project-workbench/tmux-persist',
    requiredWhen: 'restoring',
    semantics: 'Where the session manifest and captured pane content are persisted between reboots.',
  },
  {
    name: 'PW_PER_USER_CLAUDE',
    kind: 'boolean',
    default: 'false',
    requiredWhen: 'never',
    semantics: 'Whether a project terminal runs on its owner\'s own Claude login and GitHub token instead of the shared box login.',
  },
  {
    name: 'PW_USERS_PATH',
    kind: 'file',
    access: 'read',
    default: '/etc/project-workbench/users.json',
    requiredWhen: 'per-user',
    semantics: 'The user store. Resolves a project\'s primaryUser to a record, including their encrypted GitHub token.',
  },
  {
    name: 'PW_SECRET_KEY_PATH',
    kind: 'file',
    access: 'read',
    default: '/etc/project-workbench/.secret-key',
    // 'propagated', not 'per-user': it belongs to the contract and must reach the
    // consumer, but the restore entry point must NOT preflight it. Restore never
    // reads the key — it hands the path to app/project-terminal-credentials.mjs,
    // which decrypts as the credential owner and already fails closed per session.
    // Preflighting it would preempt that per-session refusal, and the key is
    // typically 0600 to an account restore does not run as, so it would refuse on
    // a correctly configured host. Keeping this distinct is what stops the schema
    // and its shell consumer from disagreeing about what "required" means.
    requiredWhen: 'propagated',
    semantics: 'Path to the AES key used to decrypt stored tokens. The PATH is configuration; the KEY is not, and never enters this contract.',
    note: 'Accepted into the schema per the Round 4 disposition: app/project-terminal-credentials.mjs reads it from the environment, so an instance that overrides it must be able to tell the restore path.',
  },
  {
    name: 'PW_USER_CRED_BASE',
    kind: 'dir',
    access: 'read-write',
    default: '/home/admin/pw-users',
    requiredWhen: 'per-user',
    semantics: 'Root of the per-user credential tree, owned by the account the panes run as.',
  },
]);

export const ENV_NAMES = Object.freeze(ENV_SCHEMA.map((e) => e.name));

export function schemaEntry(name) {
  return ENV_SCHEMA.find((e) => e.name === name) || null;
}

function truthy(v) {
  return String(v ?? '').toLowerCase() === 'true';
}

// Resolve every entry against an environment, applying defaults. Never throws:
// resolution and validation are separate so a caller can report ALL problems at
// once instead of failing on the first.
export function resolveEnvConfig(env = {}) {
  const cfg = {};
  for (const entry of ENV_SCHEMA) {
    const raw = env[entry.name];
    let value = raw === undefined || raw === '' ? entry.default : String(raw);
    if (entry.kind === 'enum' && !entry.values.includes(String(value).toLowerCase())) {
      value = entry.default;
    }
    cfg[entry.name] = value;
  }
  cfg.perUserEnabled = truthy(cfg.PW_PER_USER_CLAUDE);
  cfg.deployMode = String(cfg.PW_DEPLOY_MODE).toLowerCase() === 'container' ? 'container' : 'host';
  return cfg;
}

// Which entries a given operation actually requires. `restoring` is the one that
// matters for pw-tmux-restore: it is only meaningful when there is a manifest to
// replay, which is what keeps a genuinely absent manifest a clean no-op rather
// than a configuration error.
export function requiredFor(cfg, operation) {
  return ENV_SCHEMA.filter((e) => {
    if (e.requiredWhen === 'never' || e.requiredWhen === 'propagated') return false;
    if (e.requiredWhen === 'restoring') return operation === 'restoring';
    if (e.requiredWhen === 'per-user') return operation === 'restoring' && cfg.perUserEnabled;
    return false;
  });
}

// Validate paths with an injected accessor so this is unit-testable without a
// filesystem, and so the caller decides whether "readable" means readable by
// root or by the workspace account.
//
// Returns every failure, each naming the variable, the path and the reason —
// which is what makes the resulting error actionable rather than "restore
// failed".
export async function validateEnvConfig({ cfg, operation = 'restoring', statPath }) {
  const failures = [];
  for (const entry of requiredFor(cfg, operation)) {
    const value = cfg[entry.name];
    if (!value) {
      failures.push({ name: entry.name, path: '', reason: 'unset with no default' });
      continue;
    }
    if (!path.isAbsolute(value)) {
      failures.push({ name: entry.name, path: value, reason: 'not an absolute path' });
      continue;
    }
    const probe = await statPath(value, entry);
    if (!probe.exists) {
      failures.push({ name: entry.name, path: value, reason: 'does not exist' });
      continue;
    }
    if (entry.kind === 'dir' && !probe.isDirectory) {
      failures.push({ name: entry.name, path: value, reason: 'is not a directory' });
      continue;
    }
    if (entry.kind === 'file' && !probe.isFile) {
      failures.push({ name: entry.name, path: value, reason: 'is not a regular file' });
      continue;
    }
    if (!probe.readable) {
      failures.push({ name: entry.name, path: value, reason: 'is not readable by this account' });
      continue;
    }
    if (entry.access === 'read-write' && probe.writable === false) {
      failures.push({ name: entry.name, path: value, reason: 'is not writable by this account' });
      continue;
    }
    if (entry.helper && probe.helperMissing) {
      failures.push({ name: entry.name, path: path.join(value, entry.helper), reason: 'required helper is missing or unreadable' });
    }
  }
  return { ok: failures.length === 0, failures };
}

// Render the non-secret environment file that host systemd units load via
// EnvironmentFile= and the container sidecar loads via --env-file. Same schema,
// same names, both modes — a container restore path passes these explicitly
// rather than inventing container-only names.
export function renderEnvFile(cfg = {}, { header = true } = {}) {
  const resolved = resolveEnvConfig(cfg);
  const lines = header
    ? [
      '# Project Workbench non-secret environment contract — generated.',
      '# Loaded by the dashboard, terminal creation, persistence restore and the',
      '# tmux owner, so all four agree about where this instance keeps its state.',
      '# NON-SECRET ONLY: paths, one enum, one boolean. Never key material.',
    ]
    : [];
  for (const entry of ENV_SCHEMA) lines.push(`${entry.name}=${resolved[entry.name]}`);
  return `${lines.join('\n')}\n`;
}

// Human-readable contract, for docs and for an operator staring at a failure.
export function describeEnvSchema() {
  return ENV_SCHEMA.map((e) => ({
    name: e.name,
    kind: e.kind,
    access: e.access || 'n/a',
    default: e.default,
    requiredWhen: e.requiredWhen,
    semantics: e.semantics,
  }));
}
