// Runtime configuration for the orchestration subsystem.
//
// Two portability rules are enforced here rather than trusted to reviewers:
//
//   1. Nothing identifying an environment has a default. The workbench instance id in particular is
//      never inferred from the hostname — a project is routed to an instance because an operator
//      configured it, which is what makes the same source safe on every deployment.
//   2. The subsystem is off unless explicitly enabled. A canonical ProjectWorkbench upgrade must
//      change nothing for an install that has not configured an orchestrator.
//
// Every path, name, limit and identity below is settable. The defaults are the contract §5
// conventions, so a stock deployment is contract-conformant without configuration, while a
// deployment with different conventions is configured rather than patched.

import path from 'path';
import { PATTERNS } from './contract.js';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

function bool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
}

function int(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function str(raw, fallback) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  return value.length ? value : fallback;
}

/**
 * Resolve the orchestration configuration from an environment mapping.
 *
 * Throws when the subsystem is enabled but cannot be configured safely. Failing to boot is the
 * correct outcome: silently serving with a guessed identity would let one deployment accept work
 * intended for another.
 */
export function loadOrchestratorConfig(env = process.env) {
  const enabled = bool(env.PW_ORCHESTRATOR_ENABLED, false);
  const instanceIdRaw = str(env.PW_ORCHESTRATOR_INSTANCE_ID, '');

  if (enabled) {
    if (!instanceIdRaw) {
      throw new Error(
        'PW_ORCHESTRATOR_ENABLED is set but PW_ORCHESTRATOR_INSTANCE_ID is missing: the workbench '
        + 'instance id must be configured explicitly and is never inferred from the host',
      );
    }
    if (!PATTERNS.identifier.test(instanceIdRaw) || instanceIdRaw.length > 128) {
      throw new Error('PW_ORCHESTRATOR_INSTANCE_ID is not a valid instance id');
    }
  }

  const dataDir = str(env.PW_ORCHESTRATOR_DATA_DIR, '/var/lib/project-workbench/orchestrator');

  return Object.freeze({
    enabled,
    instanceId: instanceIdRaw || null,

    // ---- HTTP surface ----
    basePath: str(env.PW_ORCHESTRATOR_BASE_PATH, '/api/orchestrator/v1'),
    maxBodyBytes: int(env.PW_ORCHESTRATOR_MAX_BODY_BYTES, 1_048_576, { min: 1_024, max: 33_554_432 }),
    maxEventsPerPage: int(env.PW_ORCHESTRATOR_MAX_EVENTS_PER_PAGE, 200, { min: 1, max: 200 }),
    rateLimitPerMinute: int(env.PW_ORCHESTRATOR_RATE_LIMIT, 120, { min: 1, max: 100_000 }),

    // ---- identity and authorization ----
    // Tokens live in a file so they can be rotated without a redeploy and never appear in source,
    // in a unit file, or in this object.
    tokensPath: str(env.PW_ORCHESTRATOR_TOKENS_PATH, '/etc/project-workbench/orchestrator-tokens.json'),
    tokens: Object.freeze([]),
    // Which projects this instance offers to an orchestrator, and what each project's lane can do.
    // Separate from the dashboard's projects.json so enabling orchestration for one project is not
    // a change to the registry every human terminal depends on.
    projectsPath: str(env.PW_ORCHESTRATOR_PROJECTS_PATH, '/etc/project-workbench/orchestrator-projects.json'),

    // ---- durable state ----
    dataDir,
    journalPath: str(env.PW_ORCHESTRATOR_JOURNAL, path.join(dataDir, 'orchestrator.journal')),
    snapshotPath: str(env.PW_ORCHESTRATOR_SNAPSHOT, path.join(dataDir, 'orchestrator.snapshot.json')),
    lockPath: str(env.PW_ORCHESTRATOR_LOCK, path.join(dataDir, 'orchestrator.lock')),
    artifactDir: str(env.PW_ORCHESTRATOR_ARTIFACT_DIR, path.join(dataDir, 'artifacts')),
    auditLogPath: str(env.PW_ORCHESTRATOR_AUDIT_LOG, '/var/log/project-workbench/orchestrator-audit.log'),
    compactEveryRecords: int(env.PW_ORCHESTRATOR_COMPACT_EVERY, 2_000, { min: 50, max: 1_000_000 }),

    // ---- workspaces and lanes ----
    // PW_WORKSPACES is the existing dashboard variable; reusing it keeps one source of truth for
    // where project checkouts live.
    workspaceRoot: str(env.PW_WORKSPACES, '/opt/project-workbench/workspaces'),
    worktreeDir: str(env.PW_ORCHESTRATOR_WORKTREE_DIR, path.join(dataDir, 'worktrees')),
    role: str(env.PW_ORCHESTRATOR_ROLE, 'pvi2-orchestrator'),
    reservedWindow: str(env.PW_ORCHESTRATOR_WINDOW, 'orch_pvibot'),
    tmuxPrefix: str(env.PW_ORCHESTRATOR_TMUX_PREFIX, 'pw_'),
    displayNamePrefix: str(env.PW_ORCHESTRATOR_DISPLAY_PREFIX, 'pvibot-orchestrator-'),
    // Non-empty selects an alternate tmux server socket, which is how the test suite stays out of
    // the live tmux namespace entirely.
    tmuxSocket: str(env.PW_ORCHESTRATOR_TMUX_SOCKET, ''),

    // ---- coding backend ----
    backendExecutable: str(env.PW_ORCHESTRATOR_CLAUDE_BIN, 'claude'),
    backendTimeoutMs: int(env.PW_ORCHESTRATOR_BACKEND_TIMEOUT_MS, 1_800_000, { min: 1_000, max: 21_600_000 }),
    checkTimeoutMs: int(env.PW_ORCHESTRATOR_CHECK_TIMEOUT_MS, 900_000, { min: 1_000, max: 21_600_000 }),
    defaultMaxPhaseTurns: int(env.PW_ORCHESTRATOR_MAX_PHASE_TURNS, 10, { min: 1, max: 60 }),
    // How the effective *effort* may be evidenced. Claude Code reports the active model in its
    // init event but not the active effort, and silently ignores an unrecognised --effort value.
    // The default therefore reports `effective: null` and blocks, which is what the contract
    // requires when a setting cannot be determined. Setting this to 'argv' is an explicit operator
    // decision to accept that ProjectWorkbench passed the flag on every invocation as evidence; it
    // is labelled `argv-attested` in every response so the orchestrator can see what it is holding.
    effortAttestation: str(env.PW_ORCHESTRATOR_EFFORT_ATTESTATION, 'none') === 'argv' ? 'argv' : 'none',

    // ---- leases ----
    leaseTtlMs: int(env.PW_ORCHESTRATOR_LEASE_TTL_MS, 300_000, { min: 5_000, max: 86_400_000 }),

    // ---- publication ----
    gitExecutable: str(env.PW_ORCHESTRATOR_GIT_BIN, 'git'),
    ghExecutable: str(env.PW_ORCHESTRATOR_GH_BIN, 'gh'),
  });
}

/** Lane naming derived from configuration, so a deployment with other conventions configures them. */
export function laneNaming(config, projectId) {
  return {
    role: config.role,
    reservedWindow: config.reservedWindow,
    tmuxSession: config.tmuxPrefix + String(projectId).replace(/[^A-Za-z0-9_]/g, '_'),
    displayName: `${config.displayNamePrefix}${String(projectId).toLowerCase()}`,
  };
}
