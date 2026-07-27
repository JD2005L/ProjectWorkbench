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
  ATTESTATION_CONTRACT_VERSION,
} from './contract.js';
import { laneNaming } from './config.js';
import { resolveWorkspacePath } from './projects.js';

const execFileAsync = promisify(execFile);

// tmux escapes control characters in `-F` output (a 0x1F byte comes back as the four characters
// `\037`), so the field separator has to be printable. This sequence is not a legal tmux window
// name and does not occur in a filesystem path in practice.
const FIELD_SEP = '<|pwsep|>';

/**
 * Pane commands that count as "an idle shell".
 *
 * Reclaiming an unmarked window is only safe when nothing is running in it. A window whose pane is
 * running anything else belongs to whoever started it.
 */
const IDLE_SHELLS = Object.freeze(new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', '-bash', '-sh', '-zsh']));

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
  constructor({ socket = '', executable = 'tmux', timeoutMs = 15_000, deployMode = 'container', user = '' } = {}) {
    this.socket = socket;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    // In host mode the dashboard runs as root but every project terminal runs as `admin`, so it
    // execs `sudo -u admin tmux …`. The lane must take the same path: talking to root's tmux server
    // would create a second session the dashboard cannot see or reap, and would run the coding CLI
    // as root in a workspace whose human terminal, inbox and git all run as admin.
    this.deployMode = deployMode;
    this.user = user;
  }

  args(rest) {
    return this.socket ? ['-L', this.socket, ...rest] : [...rest];
  }

  /** The argv actually executed, exposed so a test can assert the privilege path. */
  spawnArgs(argv) {
    const tmuxArgv = this.args(argv);
    if (this.deployMode === 'host' && this.user) {
      return { file: 'sudo', argv: ['-u', this.user, this.executable, ...tmuxArgv] };
    }
    return { file: this.executable, argv: tmuxArgv };
  }

  async raw(argv) {
    const { file, argv: spawned } = this.spawnArgs(argv);
    return execFileAsync(file, spawned, { timeout: this.timeoutMs });
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
      '#{pane_current_command}',
      `#{${MARKER.ROLE}}`, `#{${MARKER.PROJECT}}`, `#{${MARKER.SESSION_KEY}}`, `#{${MARKER.ORCHESTRATOR}}`,
    ].join(FIELD_SEP);
    let stdout;
    try {
      ({ stdout } = await this.raw(['list-windows', '-t', `=${session}`, '-F', format]));
    } catch {
      return [];
    }
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [id, index, name, panePid, paneCurrentPath, paneCommand, role, projectId, sessionKey, orchestrator] = line.split(FIELD_SEP);
      return {
        id,
        index: Number(index),
        name,
        panePid: Number(panePid),
        paneCurrentPath,
        paneCommand: paneCommand || null,
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

  /**
   * Address a window by its tmux window id (`@N`), never by name.
   *
   * `=name` looks like an exact-match target, and it is — except that tmux resolves an all-digit
   * target as a window *index* first. A reserved window called `1` therefore resolves to whatever
   * window sits at index 1, which is how a human's window came to be marked and then killed. A
   * window id is unambiguous and cannot collide with an index.
   */
  async killWindowById(windowId) {
    await this.raw(['kill-window', '-t', windowId]);
  }

  async setWindowOptionById(windowId, option, value) {
    await this.raw(['set-option', '-w', '-t', windowId, option, value]);
  }

  /** Resolve a window by exact name, returning its id — or null when there is no such window. */
  async findWindow(session, name) {
    const windows = await this.listWindows(session);
    return windows.find((w) => w.name === name) ?? null;
  }

  async setWindowOption(session, window, option, value) {
    const found = await this.findWindow(session, window);
    if (!found) throw new Error(`no window named ${window} in ${session}`);
    await this.setWindowOptionById(found.id, option, value);
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
    // Per-lane serialisation. Concurrent ensures raced through the exists-check and each created a
    // window with the same name, after which the lane could not be addressed or repaired at all.
    this._laneLocks = new Map();
  }

  /** Run `fn` with the named lane held exclusively within this process. */
  async _withLaneLock(key, fn) {
    const previous = this._laneLocks.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    this._laneLocks.set(key, previous.then(() => held));
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._laneLocks.get(key) === held) this._laneLocks.delete(key);
    }
  }

  now() { return this.clock().toISOString(); }

  laneFor(project, request = {}) {
    const naming = laneNaming(this.config, project.project_id);
    const requestedWindow = request.reserved_tmux_window || naming.reservedWindow;
    // tmux resolves an all-digit target as a window index before trying it as a name, so a numeric
    // reserved-window name would silently address whichever window sits at that index.
    if (/^\d+$/.test(requestedWindow)) {
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        'the reserved window name must not be numeric: tmux would resolve it as a window index',
      );
    }
    return {
      ...naming,
      // A request may override the role and window, but only within the configured convention —
      // both are slugs validated upstream, so neither can become a tmux target expression.
      role: request.role || naming.role,
      reservedWindow: requestedWindow,
    };
  }

  /**
   * Create or adopt the project's orchestrator lane.
   *
   * Returns `status: missing` on first creation. A lane becomes `ready` only once
   * `verifySession` has captured real effective settings — the contract's session model rejects a
   * `ready` session without both, so claiming readiness early would be caught on the other side.
   */
  async ensureSession(args) {
    const lane = this.laneFor(args.project, args.request);
    return this._withLaneLock(`${lane.tmuxSession}:${lane.reservedWindow}`, () => this._ensureSession(args));
  }

  async _ensureSession({ token, project, request, correlationId = null }) {
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
    let laneWindowId = null;
    if (existing) {
      const ownedByThisLane = existing.role === lane.role
        && existing.projectId === project.project_id
        && existing.sessionKey === sessionKey
        && existing.orchestrator === token.orchestrator_instance_id;

      const markedByUs = Boolean(existing.role) && existing.role === lane.role;

      if (!markedByUs) {
        // An unmarked window on the reserved name. Usually somebody else's — but there is one case
        // where it is provably ours: a host reboot. `pw-tmux-save` records session, window name and
        // cwd, not tmux user options, so `pw-tmux-restore` recreates the lane by name as a plain
        // shell with the marker gone. Refusing forever meant every job for the project blocked at
        // "ensuring the orchestrator lane" until a human killed the window by hand.
        //
        // The proof of ownership comes from this instance's own durable record — not from the
        // window, which by definition has nothing left to say. All of it must line up: we recorded
        // this lane, in this session, under this window name, and what is there now is an idle
        // shell in the right directory carrying no other role marker.
        const recorded = this.store.get('sessions', sessionKey);
        const reclaimable = Boolean(recorded)
          && recorded.project_tmux_session === lane.tmuxSession
          && recorded.reserved_tmux_window === lane.reservedWindow
          && recorded.workspace_path === workspacePath
          && !existing.role && !existing.projectId && !existing.sessionKey && !existing.orchestrator
          && existing.paneCurrentPath === workspacePath
          // An idle shell, which is what pw-tmux-restore leaves behind. Anything actually running
          // is somebody's work: the previous code claimed to check this and did not, so a human's
          // window sitting in the workspace could be adopted — and, once its cwd moved, killed as
          // a stale lane.
          && IDLE_SHELLS.has(existing.paneCommand ?? '');

        if (!reclaimable) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            `the reserved window '${lane.reservedWindow}' is occupied by a window this instance does not own`,
          );
        }

        // Re-mark in place rather than killing and recreating: the window is ours, and replacing it
        // would be a gratuitous change to what the operator is looking at.
        await this.tmux.setWindowOptionById(existing.id, MARKER.ROLE, lane.role);
        await this.tmux.setWindowOptionById(existing.id, MARKER.PROJECT, project.project_id);
        await this.tmux.setWindowOptionById(existing.id, MARKER.SESSION_KEY, sessionKey);
        await this.tmux.setWindowOptionById(existing.id, MARKER.ORCHESTRATOR, token.orchestrator_instance_id);

        const reclaimed = {
          ...recorded,
          // A restored shell has verified nothing: whatever the pre-reboot session knew is gone.
          effective: null,
          last_verified_at: null,
          cli_session_id: null,
          status: OrchestratorSessionStatus.MISSING,
          last_used_at: this.now(),
          lane_window_id: existing.id,
          reclaimed_at: this.now(),
        };
        await this.store.transact((tx) => { this.repo.putSession(tx, reclaimed); });
        return this._publicSession(reclaimed);
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
        // By id: the window was resolved from an exact-name match in listWindows, and killing by
        // name would reintroduce the index ambiguity this whole path exists to avoid.
        await this.tmux.killWindowById(existing.id);
        laneWindowId = await this._createLane(lane, workspacePath, project, sessionKey, token);
        replaced = true;
      }
    } else {
      laneWindowId = await this._createLane(lane, workspacePath, project, sessionKey, token);
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
      lane_window_id: laneWindowId ?? prior?.lane_window_id ?? null,
      last_verified_at: lastVerifiedAt,
      last_used_at: this.now(),
      created_at: createdAt,
      workspace_path: workspacePath,
      correlation_id: correlationId,
    };

    await this.store.transact((tx) => { this.repo.putSession(tx, record); });
    return this._publicSession(record);
  }

  /**
   * Create the lane: temporary name, mark, then rename into place.
   *
   * Creating it under the reserved name and marking afterwards is not atomic — a crash in between
   * leaves an *unmarked* window squatting the reserved name, which `ensureSession` then refuses to
   * touch forever, including under force_replace. Marking under a scratch name and renaming last
   * means the reserved name only ever appears on a window that is already marked.
   */
  async _createLane(lane, workspacePath, project, sessionKey, token) {
    const scratch = `${lane.reservedWindow}_new`;
    await this.tmux.newWindow(lane.tmuxSession, scratch, workspacePath);
    const created = await this.tmux.findWindow(lane.tmuxSession, scratch);
    if (!created) throw new ApiError(ErrorCode.CONFLICT, 'the orchestrator lane could not be created');

    // Address by window id from here on: a name can be ambiguous, an id cannot.
    await this.tmux.setWindowOptionById(created.id, MARKER.ROLE, lane.role);
    await this.tmux.setWindowOptionById(created.id, MARKER.PROJECT, project.project_id);
    await this.tmux.setWindowOptionById(created.id, MARKER.SESSION_KEY, sessionKey);
    await this.tmux.setWindowOptionById(created.id, MARKER.ORCHESTRATOR, token.orchestrator_instance_id);
    await this.tmux.raw(['rename-window', '-t', created.id, lane.reservedWindow]);
    return created.id;
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
        // The version the CALLER spoke. A peer that cannot express provenance is not told a setting
        // is effective when the only basis is launch enforcement.
        //
        // The `??` fires only for an internal caller — the engine verifying on its own behalf,
        // where there is no peer and this instance plainly speaks its own contract. A *peer* can
        // never reach here without the field: `VerifySessionRequest` carries the contract's own
        // default and the API applies it, so an omitted version is a declaration made on the
        // contract's terms. A version that is present and different is refused downstream.
        attestationContractVersion: request.attestation_contract_version ?? ATTESTATION_CONTRACT_VERSION,
        // The caller's binding, not one invented here. A peer that sends the default `unbound` has
        // not bound its request to a run, so nothing can be attested to that run.
        runId: request.run_id ?? 'unbound',
        configGeneration: Number.isInteger(request.config_generation) ? request.config_generation : 0,
        verificationNonce: request.verification_nonce ?? null,
      });
    } catch (err) {
      // A backend that cannot answer is reported as unverifiable rather than as a server error: the
      // orchestrator's correct response is to block the job, and it needs the contract shape to
      // reach that decision.
      return this._verificationResponse(record, null, err?.kind
        ? `the coding backend could not be queried (${err.kind})`
        : 'the coding backend could not be queried', null);
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

    // `outcome` carries the attestation, the provenance, the observed model and the operator
    // requirement. Omitting it here nulled all four, so a launch-enforced verification reached the
    // peer as `attestation: null` — and since the contract derives `effective` from the attestation,
    // every job blocked while the audit line still recorded it as verified.
    return this._verificationResponse(updated, effective, outcome.detail ?? null, outcome);
  }

  /**
   * The `SessionVerificationResponse` payload, plus the fields the engine needs.
   *
   * `observed_model`, `requirement` and `cli_session_id` are ProjectWorkbench-side and are stripped
   * before the response reaches the wire — the contract model forbids extra fields — but dropping
   * them here entirely meant the engine never learned the session id (so the verified session was
   * never resumed) and the operator never saw *why* every job was blocking.
   */
  _verificationResponse(record, effective, detail, outcome = null) {
    return {
      schema_version: SCHEMA_VERSION,
      session_key: record.session_key,
      effective: effective ? { schema_version: SCHEMA_VERSION, ...effective } : null,
      backend: record.cli_backend,
      checked_at: this.now(),
      detail: detail ?? null,
      observed_model: outcome?.observed_model ?? null,
      requirement: outcome?.requirement ?? null,
      cli_session_id: outcome?.cli_session_id ?? record.cli_session_id ?? null,
      provenance: outcome?.provenance ?? null,
      settings_attestation: outcome?.settings_attestation ?? null,
    };
  }

  /** The `OrchestratorSession` contract payload — internal bookkeeping fields are not exposed. */
  _publicSession(record) {
    const {
      workspace_path: _workspacePath, correlation_id: _correlationId,
      lane_window_id: _laneWindowId, reclaimed_at: _reclaimedAt, ...rest
    } = record;
    return rest;
  }
}
