// Bootstrap and mounting for the orchestration subsystem.
//
// The whole subsystem is inert unless an operator has enabled it. That is the portability rule that
// makes this a canonical product change rather than a deployment-specific one: a ProjectWorkbench
// upgrade must alter nothing for an install that has not configured an orchestrator — no new
// listener, no new files, no journal, no lock, no behaviour change on any existing route.

import { loadOrchestratorConfig } from './config.js';
import { JournalStore } from './store/journal.js';
import { OrchestratorRepository } from './store/repo.js';
import { ProjectConfigStore } from './projects.js';
import { ArtifactStore, CheckRunner } from './checks.js';
import { OrchestrationEngine } from './engine.js';
import { OrchestratorSessionManager, TmuxAdapter } from './session.js';
import { ClaudeCodeBackend } from './runner/claude.js';
import { createOrchestratorRouter } from './api.js';
import { privilegeDropperFor } from './runner/privilege.js';

/** Schema migrations for the durable store. Append-only: never edit a released migration. */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'initial-orchestration-schema',
    up: (tx) => {
      // The journal is schemaless; this records the baseline so a later migration can tell a fresh
      // store from one written before a change, and so a downgrade fails closed.
      tx.setMeta('contractVersion', '1.0');
    },
  },
]);

/**
 * Build the subsystem. Returns `null` when it is not enabled.
 *
 * Constructed here rather than at import time so that a disabled instance never opens the store,
 * never takes the lock, and never creates a directory.
 */
export async function createOrchestratorSubsystem({ env = process.env, workbenchVersion = null, audit = null } = {}) {
  const config = loadOrchestratorConfig(env);
  if (!config.enabled) return null;

  const store = await JournalStore.open({
    journalPath: config.journalPath,
    snapshotPath: config.snapshotPath,
    lockPath: config.lockPath,
    compactEveryRecords: config.compactEveryRecords,
    migrations: MIGRATIONS,
  });

  // Everything from here on can throw — reconciliation writes to the journal, and a full or
  // read-only disk is the likely cause. Without this the dashboard would run for its whole
  // lifetime holding the store lock with no orchestrator behind it, and no sibling process could
  // ever take it.
  try {
    return await buildSubsystem({ config, store, workbenchVersion, audit });
  } catch (err) {
    await store.close().catch(() => {});
    throw err;
  }
}

async function buildSubsystem({ config, store, workbenchVersion, audit }) {
  const repo = new OrchestratorRepository(store);
  const projectStore = new ProjectConfigStore(config.projectsPath);
  const artifacts = new ArtifactStore({ config, repo, store });
  // System-command privilege dropper: drops to the unprivileged account for git, gh, and check
  // commands so they never create root-owned artifacts in an admin-owned workspace.
  const commandDropper = privilegeDropperFor(config);
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  // Eager validation: resolve the privilege-drop plan at boot. If the configured account cannot be
  // resolved through NSS or sudo is unusable, fail NOW rather than on the first job — hours later.
  // This is the "fail closed at boot" gate: the orchestrator refuses to start when a drop is
  // required but cannot be made. Without this, the failure was lazy and the wording overstated
  // what was actually enforced.
  if (config.deployMode === 'host' && process.getuid?.() === 0) {
    await commandDropper.plan();
  }

  const droppedExec = commandDropper.wrapCommand(execFileAsync);
  const checkRunner = new CheckRunner({ config, repo, store, artifacts, exec: droppedExec });
  const backend = new ClaudeCodeBackend({ config });
  const tmux = new TmuxAdapter({
    socket: config.tmuxSocket, deployMode: config.deployMode, user: config.tmuxUser,
  });
  const sessionManager = new OrchestratorSessionManager({ config, store, repo, tmux, backend });
  const engine = new OrchestrationEngine({
    config, store, repo, backend, sessionManager, artifacts, checkRunner, projectStore, audit,
    exec: droppedExec,
  });

  // A job recorded as workspace-active when the process died is in an unknown state. Reconciling
  // *before* serving means the first request never sees a job that claims to be running with no
  // worker behind it.
  const reconciled = await engine.reconcileOnStart();

  const router = createOrchestratorRouter({
    config, store, repo, backend, engine, sessionManager, workbenchVersion, audit,
  });

  return {
    config, store, repo, projectStore, artifacts, checkRunner, backend, sessionManager, engine,
    router, reconciled,
    close: async () => {
      await engine.drain().catch(() => {});
      await store.close();
    },
  };
}

/**
 * Mount the subsystem onto an Express app.
 *
 * Mounted *before* the dashboard's global body parser and CSRF guard. Both are deliberate: the
 * orchestration routes enforce their own, much smaller body limit, and the Origin/Referer gate
 * exists because nginx Basic Auth is replayed by browsers on any origin — which a bearer service
 * token is not. Applying it here would break honest scripted clients without adding a control.
 */
export async function mountOrchestrator(app, options = {}) {
  const subsystem = await createOrchestratorSubsystem(options);
  if (!subsystem) return null;
  app.use(subsystem.config.basePath, subsystem.router);
  return subsystem;
}

export { loadOrchestratorConfig };
