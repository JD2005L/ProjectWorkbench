// The authoritative non-secret environment contract for a Project Workbench instance.
//
// WHY THIS EXISTS (GOA-1 / HJ-24-5)
//
// Every entry point resolved its own paths from its own defaults:
//
//   app/server.js               PW_REGISTRY_PATH || '/opt/project-workbench/projects.json'
//   scripts/project-terminal-start   the same expression again, in bash
//   scripts/pw-tmux-restore     the same expression a third time
//   systemd/pw-tmux-persist.service  set none of them — only HOME/LANG/LC_ALL
//
// So an instance whose registry is NOT at the compiled-in default (GOA keeps it elsewhere, and
// exports PW_REGISTRY_PATH only into the dashboard container) had a restore entrypoint that could
// not find it. `resolve_session_credentials` then returned 1 for EVERY session, the caller turned
// that into `CREATED[$s]="skip"`, and the script still `exit 0`d — so a reboot refused to restore
// every session and reported success. The trigger was a path default mismatch, but the outcome was
// indistinguishable from "nothing to restore".
//
// The same gap is HJ-24-5 from the other side: the dedicated owner unit runs `pw-tmux-restore`
// through ExecStartPost without loading PW_PER_USER_CLAUDE, and that script reads an absent flag as
// the legitimate disabled/shared-credential mode — so an owner restart could restore and resume a
// session under shared credentials on a per-user-enabled install.
//
// One file, one list of keys, one set of defaults, read by every entry point in both deploy modes:
//
//   host      /etc/project-workbench/pw.env via `EnvironmentFile=` on the dashboard, both terminal
//             units, pw-tmux-persist.service, pw-tmux-save.service and pw-tmux-server.service
//   container the same file via podman `--env-file` on the app container and the tmux sidecar
//
// Two rules the file itself cannot enforce, so they are stated here and enforced by the consumers:
//
//   1. MISCONFIGURATION IS NOT "NOTHING TO DO". An authoritative path that is missing or unusable
//      must fail visibly and non-zero. Exiting 0 having restored nothing is the bug above.
//   2. IDENTITY RESOLUTION STAYS FAIL-CLOSED. Nothing here relaxes it: a session whose owner,
//      credentials or fingerprint stamp cannot be resolved is still refused, never restored under
//      the shared login. This contract only removes the case where the refusal was caused by the
//      product looking in the wrong place and then calling it success.
//
// NOTHING SECRET LIVES HERE. Paths, a mode, and a feature flag. Tokens stay encrypted in the users
// store, and per-user credential material stays under PW_USER_CRED_BASE, owned by the pane account.

/**
 * The contract. `kind` drives validation:
 *   'mode'  one of host|container
 *   'flag'  true|false
 *   'file'  must exist and be readable when required
 *   'dir'   must exist and be a directory when required
 *   'path'  a path that need not exist yet (it is created, or it is a socket root)
 *
 * `required` marks the values a restore/terminal entry point cannot work without. `modes` records
 * which deployment models the key is meaningful for; every key is WRITTEN in both modes so the two
 * environments can be diffed against each other.
 */
export const PW_ENV_KEYS = Object.freeze([
  { key: 'PW_DEPLOY_MODE', kind: 'mode', required: true, modes: ['host', 'container'],
    purpose: 'which terminal model this instance runs (see app/deploy-mode.js)' },
  { key: 'PW_APP_DIR', kind: 'dir', required: true, modes: ['host', 'container'],
    purpose: 'dashboard app directory; holds project-terminal-credentials.mjs, the fail-closed credential helper' },
  { key: 'PW_REGISTRY_PATH', kind: 'file', required: true, modes: ['host', 'container'],
    purpose: 'the project registry every entry point must agree on' },
  { key: 'PW_CANONICAL_REGISTRY', kind: 'path', required: false, modes: ['host', 'container'],
    purpose: 'the registry that means "this instance is NOT isolated" (see app/isolation.js)' },
  { key: 'PW_USERS_PATH', kind: 'file', required: false, modes: ['host', 'container'],
    purpose: 'the users store credential ownership resolves against' },
  { key: 'PW_SESSIONS_PATH', kind: 'path', required: false, modes: ['host', 'container'],
    purpose: 'dashboard login sessions' },
  { key: 'PW_WORKSPACES', kind: 'dir', required: false, modes: ['host', 'container'],
    purpose: 'project workspace root' },
  { key: 'PW_AUDIT_LOG', kind: 'path', required: false, modes: ['host', 'container'],
    purpose: 'append-only audit log' },
  { key: 'PW_PER_USER_CLAUDE', kind: 'flag', required: true, modes: ['host', 'container'],
    purpose: 'per-user CLI credentials on/off — an absent value reads as "off", which is why the restore entrypoint must be told explicitly' },
  { key: 'PW_USER_CRED_BASE', kind: 'path', required: false, modes: ['host', 'container'],
    purpose: 'root of the per-user credential tree, owned by the pane account' },
  { key: 'PW_TMUX_STATE_DIR', kind: 'dir', required: true, modes: ['host', 'container'],
    purpose: 'tmux persistence manifest + captured scrollback' },
  { key: 'PW_TMUX_OWNER_REQUIRED', kind: 'flag', required: false, modes: ['host'],
    purpose: 'refuse to create a terminal unless the dedicated tmux owner is proven live' },
  { key: 'TMUX_TMPDIR', kind: 'path', required: false, modes: ['container'],
    purpose: 'the bind-mounted tmux socket root shared with the sidecar' },
]);

export const PW_ENV_PATH = '/etc/project-workbench/pw.env';

const KEY_BY_NAME = new Map(PW_ENV_KEYS.map((k) => [k.key, k]));

/** Documented defaults, by mode. These are exactly the compiled-in fallbacks they replace. */
export function defaultPwEnv(mode = 'host') {
  const base = {
    PW_DEPLOY_MODE: mode,
    PW_APP_DIR: '/opt/project-workbench/app',
    PW_REGISTRY_PATH: '/opt/project-workbench/projects.json',
    PW_CANONICAL_REGISTRY: '/opt/project-workbench/projects.json',
    PW_USERS_PATH: '/etc/project-workbench/users.json',
    PW_SESSIONS_PATH: '/var/lib/project-workbench/sessions.json',
    PW_WORKSPACES: '/opt/project-workbench/workspaces',
    PW_AUDIT_LOG: '/var/log/project-workbench/audit.log',
    PW_PER_USER_CLAUDE: 'false',
    PW_USER_CRED_BASE: '/home/admin/pw-users',
    PW_TMUX_STATE_DIR: '/var/lib/project-workbench/tmux-persist',
  };
  if (mode === 'host') base.PW_TMUX_OWNER_REQUIRED = 'true';
  else base.TMUX_TMPDIR = '/opt/project-workbench/run/tmux';
  return base;
}

/**
 * Parse the `KEY=VALUE` subset systemd's `EnvironmentFile=` and podman's `--env-file` both accept:
 * comments, blank lines, no interpolation, optional single/double quotes around the value. Anything
 * else is reported rather than silently dropped — a typo'd key in an authoritative file is exactly
 * the failure this contract exists to stop.
 */
export function parseEnvFile(text) {
  const values = {};
  const errors = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`line ${i + 1}: not a KEY=VALUE assignment: ${JSON.stringify(raw)}`);
      return;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`line ${i + 1}: not a usable variable name: ${JSON.stringify(key)}`);
      return;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });
  return { values, errors };
}

/** Render the file. Deterministic order and inline purpose comments, so two instances can be diffed. */
export function serialisePwEnv(values, { mode = values.PW_DEPLOY_MODE || 'host', generator = 'scripts/pw-env-write' } = {}) {
  const out = [
    '# Project Workbench — authoritative non-secret environment contract.',
    '#',
    `# Generated by ${generator}. Edit freely: the installer never overwrites an existing file.`,
    '# Consumed by the dashboard, both terminal units, the tmux persistence units and the dedicated',
    '# tmux owner via EnvironmentFile=, and by the container-mode app/sidecar via --env-file.',
    '#',
    '# NOTHING SECRET BELONGS IN THIS FILE. Paths, the deploy mode, and feature flags only.',
    '',
  ];
  for (const spec of PW_ENV_KEYS) {
    const value = values[spec.key];
    if (value === undefined || value === null || value === '') continue;
    const scope = spec.modes.length === 1 ? ` (${spec.modes[0]} mode only)` : '';
    out.push(`# ${spec.purpose}${scope}`);
    out.push(`${spec.key}=${value}`);
    out.push('');
  }
  void mode;
  return out.join('\n');
}

/**
 * Validate resolved values against the contract. `exists`/`isDir` are injected so this is testable
 * without a filesystem and usable against a candidate file before it is installed.
 *
 * @returns {{errors: string[], warnings: string[]}} `errors` are refusals; `warnings` are values the
 *          contract does not know about (a typo, or a key a newer version added).
 */
export function validatePwEnv(values = {}, { exists = () => true, isDir = () => true, checkPaths = true } = {}) {
  const errors = [];
  const warnings = [];
  for (const spec of PW_ENV_KEYS) {
    const value = values[spec.key];
    if (value === undefined || value === '') {
      if (spec.required) errors.push(`${spec.key} is required (${spec.purpose}) but is not set`);
      continue;
    }
    if (spec.kind === 'mode' && !['host', 'container'].includes(String(value).toLowerCase())) {
      errors.push(`${spec.key}=${JSON.stringify(value)} is not one of host|container`);
    }
    if (spec.kind === 'flag' && !['true', 'false', '1', '0'].includes(String(value).toLowerCase())) {
      errors.push(`${spec.key}=${JSON.stringify(value)} is not a boolean (true|false)`);
    }
    if ((spec.kind === 'file' || spec.kind === 'dir' || spec.kind === 'path') && !String(value).startsWith('/')) {
      errors.push(`${spec.key}=${JSON.stringify(value)} must be an absolute path`);
    }
    if (!checkPaths || !spec.required) continue;
    if (spec.kind === 'file' && !exists(value)) {
      errors.push(`${spec.key}=${value} does not exist (${spec.purpose})`);
    }
    if (spec.kind === 'dir' && (!exists(value) || !isDir(value))) {
      errors.push(`${spec.key}=${value} is not a directory (${spec.purpose})`);
    }
  }
  for (const key of Object.keys(values)) {
    if (!KEY_BY_NAME.has(key)) warnings.push(`${key} is not part of the Project Workbench environment contract`);
  }
  return { errors, warnings };
}

/**
 * Merge file values under the live environment. Already-set variables WIN: systemd has already
 * applied `EnvironmentFile=` by the time a unit's script runs, an operator's explicit export is a
 * deliberate override, and a test that sets a path must not have it replaced by the host's real one.
 */
export function resolvePwEnv({ env = {}, fileText = '', mode = null } = {}) {
  const parsed = parseEnvFile(fileText);
  const resolvedMode = String(mode || env.PW_DEPLOY_MODE || parsed.values.PW_DEPLOY_MODE || 'host').toLowerCase();
  const values = { ...defaultPwEnv(resolvedMode === 'container' ? 'container' : 'host') };
  for (const [k, v] of Object.entries(parsed.values)) values[k] = v;
  for (const spec of PW_ENV_KEYS) {
    const live = env[spec.key];
    if (live !== undefined && live !== '') values[spec.key] = String(live);
  }
  return { values, errors: parsed.errors };
}
