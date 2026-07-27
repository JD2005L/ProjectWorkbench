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
import { parseModelAliases } from './attestation.js';

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

  // The router mounts ahead of the dashboard's CSRF guard and body parser, so an overlapping
  // prefix silently takes over those routes: `/api` swallows every dashboard API call and `/` bricks
  // the instance while still reporting itself up. Validated as strictly as the instance id.
  const basePath = str(env.PW_ORCHESTRATOR_BASE_PATH, '/api/orchestrator/v1');
  if (enabled) {
    const segments = basePath.split('/');
    const wellFormed = basePath.startsWith('/')
      && segments.length > 1
      && segments.slice(1).every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..');
    if (!wellFormed) {
      throw new Error('PW_ORCHESTRATOR_BASE_PATH must be an absolute path of simple, non-traversing segments');
    }
    // The danger is the base path being an *ancestor* of a dashboard route, which would capture it.
    // Living *under* one is fine and is what the contract's own `/api/orchestrator/v1` does — the
    // router only matches its exact prefix.
    const reserved = ['/api', '/login', '/logout', '/healthz', '/settings', '/term', '/pty', '/preview', '/static', '/agents.md'];
    const swallows = reserved.some((route) => route === basePath || `${route}/`.startsWith(`${basePath}/`));
    if (swallows) {
      throw new Error(`PW_ORCHESTRATOR_BASE_PATH '${basePath}' would capture a dashboard route`);
    }
  }

  const dataDir = str(env.PW_ORCHESTRATOR_DATA_DIR, '/var/lib/project-workbench/orchestrator');

  return Object.freeze({
    enabled,
    instanceId: instanceIdRaw || null,

    // ---- HTTP surface ----
    basePath,
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
    // Defaults to the dashboard's own PW_TMUX_SOCKET so the lane lands on the tmux server the
    // human terminals actually use. Overriding it is how the test suite stays out of the live
    // namespace entirely; defaulting it to empty would silently create a second, parallel server.
    tmuxSocket: str(env.PW_ORCHESTRATOR_TMUX_SOCKET, str(env.PW_TMUX_SOCKET, '')),
    // Host-mode deployments run the dashboard as root but every terminal as `admin`. The lane must
    // drop the same way, or it creates a root-owned session the dashboard cannot see or reap, and
    // writes root-owned files into a workspace whose human terminal runs as admin.
    deployMode: String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host',
    tmuxUser: str(env.PW_ORCHESTRATOR_TMUX_USER, 'admin'),

    // ---- coding backend ----
    backendExecutable: str(env.PW_ORCHESTRATOR_CLAUDE_BIN, 'claude'),
    backendTimeoutMs: int(env.PW_ORCHESTRATOR_BACKEND_TIMEOUT_MS, 1_800_000, { min: 1_000, max: 21_600_000 }),
    checkTimeoutMs: int(env.PW_ORCHESTRATOR_CHECK_TIMEOUT_MS, 900_000, { min: 1_000, max: 21_600_000 }),
    defaultMaxPhaseTurns: int(env.PW_ORCHESTRATOR_MAX_PHASE_TURNS, 10, { min: 1, max: 60 }),
    // Alias -> concrete model ids, used to attest that the session is running what was requested.
    // An alias never equals what the CLI reports back (`sonnet` -> `claude-sonnet-5`), so the
    // comparison has to go through an explicit mapping; comparing the alias to itself would be no
    // check at all. Setting this REPLACES the measured defaults rather than extending them.
    modelAliases: parseModelAliases(env.PW_ORCHESTRATOR_MODEL_ALIASES),
    // Separation of duty on approvals, on by default. Turning it off lets one credential request
    // and approve its own work, which makes the publication gate satisfiable by the machine alone.
    requireSeparateApprover: !['false', '0', 'no', 'off'].includes(
      String(env.PW_ORCHESTRATOR_REQUIRE_SEPARATE_APPROVER ?? '').trim().toLowerCase(),
    ),

    // ---- leases ----
    leaseTtlMs: int(env.PW_ORCHESTRATOR_LEASE_TTL_MS, 300_000, { min: 5_000, max: 86_400_000 }),

    // ---- publication ----
    gitExecutable: str(env.PW_ORCHESTRATOR_GIT_BIN, 'git'),
    // The identity publication commits under. Explicit, because a service account routinely has no
    // global git identity — and without one `git commit` fails, which made publication report "the
    // commit failed" on any host where nobody had configured one. It is also better attribution:
    // the commit records that this instance's orchestration subsystem made it, not whichever
    // identity happened to be on the box.
    gitAuthorName: str(env.PW_ORCHESTRATOR_GIT_AUTHOR_NAME, 'ProjectWorkbench Orchestrator'),
    gitAuthorEmail: str(
      env.PW_ORCHESTRATOR_GIT_AUTHOR_EMAIL,
      // `.invalid` is the reserved non-resolvable TLD: a valid address shape that cannot receive mail.
      `orchestrator@${(instanceIdRaw || 'project-workbench').toLowerCase()}.invalid`,
    ),
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
