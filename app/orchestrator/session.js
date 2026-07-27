// The named orchestrator lane, and model/effort verification.
//
// The lane is a reserved tmux window inside the project's existing session, so an operator watching
// the dashboard sees the orchestrator's work in the same place they see their own. That visibility
// is the point — but it also means this code runs inside a session full of *human* windows, and the
// governing rule is therefore a negative one:
//
//   A window is the orchestrator's lane only if it carries the role marker this service set.
//
// Not "it has the right name". A window that happens to be called `orch_pvibot` but carries no
// marker belongs to somebody else, and is refused rather than replaced — because killing a window
// this service cannot prove it owns is exactly the failure mode the contract is written to prevent.
// Identification by marker is also what stops a human's interactive Claude window ever being
// adopted: nothing but this code ever sets the marker.

import { execFile } from 'child_process';
import { promisify } from 'util';

import { ApiError, notFound } from './errors.js';
import {
  SCHEMA_VERSION, ErrorCode, CodingBackend, OrchestratorSessionStatus, deriveSessionKey,
} from './contract.js';
import { laneNaming } from './config.js';
import { resolveWorkspacePath } from './projects.js';

const execFileAsync = promisify(execFile);

// tmux escapes control characters in `-F` output (a 0x1F byte comes back as the four characters
// `\037`), so the field separator has to be printable. This sequence is not a legal tmux window
// name and does not occur in a filesystem path in practice.
const FIELD_SEP = '<|pwsep|>';

/** tmux user options carrying the lane's identity. Only this service ever writes them. */
const MARKER = Object.freeze({
  ROLE: '@pw_role',
  PROJECT: '@pw_project',
  SESSION_KEY: '@pw_session_key',
  ORCHESTRATOR: '@pw_orchestrator',
});

/**
 * A thin, injectable tmux wrapper.
 *
 * `socket` selects an alternate tmux server, which is how the test suite stays entirely out of the
 * live tmux namespace: a private server, its own windows, killed on teardown.
 */
export class TmuxAdapter {
  constructor({ socket = '', executable = 'tmux', timeoutMs = 15_000 } = {}) {
    this.socket = socket;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
  }

  args(rest) {
    return this.socket ? ['-L', this.socket, ...rest] : [...rest];
  }

  async raw(argv) {
    return execFileAsync(this.executable, this.args(argv), { timeout: this.timeoutMs });
  }

  async hasSession(session) {
    try {
      await this.raw(['has-session', '-t', `=${session}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List windows with their identity markers.
   *
   * `=` prefixes force exact-name matching. Without them tmux treats the target as a prefix or
   * pattern, which would let a lookup for `orch_pvibot` silently resolve to a human's window whose
   * name merely starts the same way.
   */
  async listWindows(session) {
    const format = [
      '#{window_id}', '#{window_index}', '#{window_name}', '#{pane_pid}', '#{pane_current_path}',
      `#{${MARKER.ROLE}}`, `#{${MARKER.PROJECT}}`, `#{${MARKER.SESSION_KEY}}`, `#{${MARKER.ORCHESTRATOR}}`,
    ].join(FIELD_SEP);
    let stdout;
    try {
      ({ stdout } = await this.raw(['list-windows', '-t', `=${session}`, '-F', format]));
    } catch {
      return [];
    }
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [id, index, name, panePid, paneCurrentPath, role, projectId, sessionKey, orchestrator] = line.split(FIELD_SEP);
      return {
        id,
        index: Number(index),
        name,
        panePid: Number(panePid),
        paneCurrentPath,
        role: role || null,
        projectId: projectId || null,
        sessionKey: sessionKey || null,
        orchestrator: orchestrator || null,
      };
    });
  }

  async newSession(session, cwd, command) {
    await this.raw(['new-session', '-d', '-s', session, '-c', cwd, ...(command ? [command] : [])]);
  }

  async newWindow(session, name, cwd, command) {
    await this.raw(['new-window', '-d', '-t', `=${session}`, '-n', name, '-c', cwd, ...(command ? [command] : [])]);
  }

  async killWindow(session, name) {
    await this.raw(['kill-window', '-t', `=${session}:=${name}`]);
  }

  async setWindowOption(session, window, option, value) {
    await this.raw(['set-option', '-w', '-t', `=${session}:=${window}`, option, value]);
  }

  /** Write a line into the lane's pane so a watching operator sees progress. */
  async displayMessage(session, window, text) {
    // `run-shell` would execute; `send-keys` would type into whatever is running. Neither is right
    // for a status line, so the text is echoed via a literal-mode send that cannot be interpreted
    // as a command by the pane's shell.
    await this.raw(['display-message', '-t', `=${session}:=${window}`, '-p', text]).catch(() => {});
  }
}

/**
 * Owns the lane lifecycle and the model/effort verification that gates every phase.
 */
export class OrchestratorSessionManager {
  constructor({ config, store, repo, tmux, backend, clock = () => new Date() }) {
    this.config = config;
    this.store = store;
    this.repo = repo;
    this.tmux = tmux;
    this.backend = backend;
    this.clock = clock;
  }

  now() { return this.clock().toISOString(); }

  laneFor(project, request = {}) {
    const naming = laneNaming(this.config, project.project_id);
    return {
      ...naming,
      // A request may override the role and window, but only within the configured convention —
      // both are slugs validated upstream, so neither can become a tmux target expression.
      role: request.role || naming.role,
      reservedWindow: request.reserved_tmux_window || naming.reservedWindow,
    };
  }

  /**
   * Create or adopt the project's orchestrator lane.
   *
   * Returns `status: missing` on first creation. A lane becomes `ready` only once
   * `verifySession` has captured real effective settings — the contract's session model rejects a
   * `ready` session without both, so claiming readiness early would be caught on the other side.
   */
  async ensureSession({ token, project, request, correlationId = null }) {
    const lane = this.laneFor(project, request);
    const sessionKey = deriveSessionKey(
      token.orchestrator_instance_id, this.config.instanceId, project.project_id, lane.role,
    );
    const workspacePath = resolveWorkspacePath(this.config, project);

    // The project's tmux session is shared with human windows. Create it only if absent, and never
    // recreate it: doing so would kill every window an operator has open.
    if (!(await this.tmux.hasSession(lane.tmuxSession))) {
      await this.tmux.newSession(lane.tmuxSession, workspacePath);
      // The session's initial window is a plain shell, not the lane. Rename it so it cannot be
      // mistaken for one and so the lane is always created explicitly, marked, below.
      await this.tmux.raw(['rename-window', '-t', `=${lane.tmuxSession}:0`, 'shell']).catch(() => {});
    }

    const existing = (await this.tmux.listWindows(lane.tmuxSession))
      .find((w) => w.name === lane.reservedWindow);

    let replaced = false;
    if (existing) {
      const ownedByThisLane = existing.role === lane.role
        && existing.projectId === project.project_id
        && existing.sessionKey === sessionKey
        && existing.orchestrator === token.orchestrator_instance_id;

      const markedByUs = Boolean(existing.role) && existing.role === lane.role;

      if (!markedByUs) {
        // Somebody else's window is sitting on the reserved name. Refuse — including under
        // force_replace. This service does not destroy windows it cannot prove it owns.
        throw new ApiError(
          ErrorCode.CONFLICT,
          `the reserved window '${lane.reservedWindow}' is occupied by a window this instance does not own`,
        );
      }

      if (markedByUs && existing.orchestrator && existing.orchestrator !== token.orchestrator_instance_id) {
        // The lane belongs to a *different* orchestrator instance. Uniqueness is enforced on
        // (orchestrator, workbench, project, role), so this is a conflict, not a takeover.
        throw new ApiError(
          ErrorCode.CONFLICT,
          'the reserved window is held by a different orchestrator instance',
        );
      }

      const stale = !ownedByThisLane || existing.paneCurrentPath !== workspacePath;
      if (stale || request.force_replace) {
        await this.tmux.killWindow(lane.tmuxSession, lane.reservedWindow);
        await this._createLane(lane, workspacePath, project, sessionKey, token);
        replaced = true;
      }
    } else {
      await this._createLane(lane, workspacePath, project, sessionKey, token);
    }

    const prior = this.store.get('sessions', sessionKey);
    const createdAt = prior && !replaced ? prior.created_at : this.now();

    // A replacement invalidates any previously captured settings: the new process was launched
    // fresh and has verified nothing.
    const effective = replaced ? null : (prior?.effective ?? null);
    const lastVerifiedAt = replaced ? null : (prior?.last_verified_at ?? null);

    const record = {
      schema_version: SCHEMA_VERSION,
      session_key: sessionKey,
      orchestrator_instance_id: token.orchestrator_instance_id,
      workbench_instance_id: this.config.instanceId,
      project_id: project.project_id,
      role: lane.role,
      project_tmux_session: lane.tmuxSession,
      reserved_tmux_window: lane.reservedWindow,
      cli_backend: request.cli_backend || CodingBackend.CLAUDE_CODE,
      cli_session_id: replaced ? null : (prior?.cli_session_id ?? null),
      cli_display_name: lane.displayName,
      requested: replaced ? null : (prior?.requested ?? null),
      effective,
      status: effective && lastVerifiedAt ? OrchestratorSessionStatus.READY : OrchestratorSessionStatus.MISSING,
      last_verified_at: lastVerifiedAt,
      last_used_at: this.now(),
      created_at: createdAt,
      workspace_path: workspacePath,
      correlation_id: correlationId,
    };

    await this.store.transact((tx) => { this.repo.putSession(tx, record); });
    return this._publicSession(record);
  }

  async _createLane(lane, workspacePath, project, sessionKey, token) {
    await this.tmux.newWindow(lane.tmuxSession, lane.reservedWindow, workspacePath);
    // Mark immediately after creation. Until the markers are set the window is indistinguishable
    // from a human's, so nothing else may happen in between.
    await this.tmux.setWindowOption(lane.tmuxSession, lane.reservedWindow, MARKER.ROLE, lane.role);
    await this.tmux.setWindowOption(lane.tmuxSession, lane.reservedWindow, MARKER.PROJECT, project.project_id);
    await this.tmux.setWindowOption(lane.tmuxSession, lane.reservedWindow, MARKER.SESSION_KEY, sessionKey);
    await this.tmux.setWindowOption(lane.tmuxSession, lane.reservedWindow, MARKER.ORCHESTRATOR, token.orchestrator_instance_id);
  }

  /**
   * Report what model and effort are *actually* active.
   *
   * `effective: null` is a legitimate answer and means "could not determine". The contract offers
   * no way to say "probably correct", and reporting a guess would defeat the entire control: the
   * orchestrator treats null as unverifiable and blocks the job before any file is read.
   */
  async verifySession({ token, project, request, correlationId = null }) {
    const record = this.store.get('sessions', request.session_key);
    if (!record) throw notFound('no such orchestrator session on this instance');
    if (record.orchestrator_instance_id !== token.orchestrator_instance_id
      || record.project_id !== project.project_id) {
      // Another orchestrator's lane is not this caller's to inspect.
      throw notFound('no such orchestrator session on this instance');
    }

    let outcome;
    try {
      outcome = await this.backend.verifyConfiguration({
        requested: request.requested,
        phaseClass: request.phase_class,
        sessionKey: record.session_key,
        cliSessionId: record.cli_session_id,
        cwd: record.workspace_path,
        displayName: record.cli_display_name,
      });
    } catch (err) {
      // A backend that cannot answer is reported as unverifiable rather than as a server error: the
      // orchestrator's correct response is to block the job, and it needs the contract shape to
      // reach that decision.
      return this._verificationResponse(record, null, err?.kind
        ? `the coding backend could not be queried (${err.kind})`
        : 'the coding backend could not be queried');
    }

    const effective = outcome.effective ?? null;
    const updated = {
      ...record,
      requested: { schema_version: SCHEMA_VERSION, ...request.requested },
      effective,
      last_verified_at: effective ? this.now() : null,
      status: effective ? OrchestratorSessionStatus.READY : OrchestratorSessionStatus.MISSING,
      cli_session_id: outcome.cli_session_id ?? record.cli_session_id ?? null,
      last_used_at: this.now(),
      correlation_id: correlationId,
    };
    await this.store.transact((tx) => { this.repo.putSession(tx, updated); });

    return this._verificationResponse(updated, effective, outcome.detail ?? null);
  }

  _verificationResponse(record, effective, detail) {
    return {
      schema_version: SCHEMA_VERSION,
      session_key: record.session_key,
      effective: effective ? { schema_version: SCHEMA_VERSION, ...effective } : null,
      backend: record.cli_backend,
      checked_at: this.now(),
      detail: detail ?? null,
    };
  }

  /** The `OrchestratorSession` contract payload — internal bookkeeping fields are not exposed. */
  _publicSession(record) {
    const {
      workspace_path: _workspacePath, correlation_id: _correlationId, ...rest
    } = record;
    return rest;
  }
}
