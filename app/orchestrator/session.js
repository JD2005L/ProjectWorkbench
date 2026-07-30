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
import { defaultLaneCredentialResolver } from './lane-credentials.js';
import { sessionCredentialState } from '../user-credentials.js';

const execFileAsync = promisify(execFile);

// tmux escapes control characters in `-F` output (a 0x1F byte comes back as the four characters
// `\037`), so the field separator has to be printable. This sequence is not a legal tmux window
// name and does not occur in a filesystem path in practice.
const FIELD_SEP = '<|pwsep|>';

// Same non-secret session-level fingerprint app/server.js stamps — a lane's
// tmux session is shared with human windows and must be judged against the
// exact same per-user-credential identity contract they are (see
// app/orchestrator/lane-credentials.js).
const CRED_KEY_OPTION = '@pw_cred_key';

/**
 * Pane commands that count as "an idle shell".
 *
 * Reclaiming an unmarked window is only safe when nothing is running in it. A window whose pane is
 * running anything else belongs to whoever started it.
 */
const IDLE_SHELLS = Object.freeze(new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', '-bash', '-sh', '-zsh']));

/**
 * The pane launch command carrying the resolved per-user credential
 * environment — `null` when there is nothing to apply (disabled mode, or the
 * legitimate no-primaryUser/off case, where `cred.tokens` is empty), so the
 * caller passes no `command` at all and tmux spawns its ordinary default
 * shell, byte-identical to before this existed.
 *
 * Resolving credentials (see app/orchestrator/lane-credentials.js) only
 * decides WHAT the pane should run under; without this, that decision was
 * never applied anywhere — only its fingerprint got stamped, so a session
 * could look correctly attributed while its pane ran under the shared/
 * default login the whole time. Mirrors app/server.js's
 * ensureProjectTmuxSession's identical construction (same `env KEY=VAL...
 * bash <shellArgs>` shape, same unquoted join — these tokens are
 * server-computed paths, not external input).
 */
function laneLaunchCommand(cred) {
  if (!cred?.tokens?.length) return null;
  const shellArgs = cred.shellArgs?.length ? cred.shellArgs : ['--noprofile', '--norc'];
  return ['env', ...cred.tokens].join(' ') + ' bash ' + shellArgs.join(' ');
}

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
 *
 * `exec` is what actually launches tmux, and in host mode it must be the *same*
 * `PrivilegeDropper.wrapCommand`-wrapped function `git.js` and `checks.js` run through — never a
 * privilege drop this class resolves for itself. Two independently-resolved drops for the same
 * account can disagree (one keyed on the account name and re-resolved through NSS at exec time, the
 * other pinned to the uid validated once at boot), and disagreeing here means talking to a
 * *different* tmux socket namespace than the one everything else believes it is using — the exact
 * failure mode this module's own docs warn about for the dashboard's root tmux server. Sharing one
 * dropper instance makes that structurally impossible rather than merely unlikely. Defaults to a
 * bare exec, which is what container mode — and every hermetic test — needs: nothing to drop.
 */
export class TmuxAdapter {
  constructor({ socket = '', executable = 'tmux', timeoutMs = 15_000, exec = execFileAsync } = {}) {
    this.socket = socket;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.exec = exec;
  }

  args(rest) {
    return this.socket ? ['-L', this.socket, ...rest] : [...rest];
  }

  async raw(argv) {
    return this.exec(this.executable, this.args(argv), { timeout: this.timeoutMs });
  }

  async hasSession(session) {
    try {
      await this.raw(['has-session', '-t', `=${session}`]);
      return true;
    } catch (err) {
      // tmux exiting non-zero because the session genuinely does not exist yet is the ordinary,
      // expected case here — swallowed into `false` as always. But a `false` this module cannot
      // vouch for — tmux itself killed without confirming its own descendant tree died — must not
      // be indistinguishable from "no such session": the caller needs to fence, not proceed as
      // though nothing happened.
      if (err?.terminationConfirmed === false) throw err;
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
    } catch (err) {
      // Same distinction as `hasSession`: an ordinary tmux failure reads as "no windows", but a
      // kill this module cannot confirm was actually carried out must reach the caller, not be
      // rounded down to an empty, unremarkable list.
      if (err?.terminationConfirmed === false) throw err;
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

  /**
   * Reads the SESSION-level (not per-window) credential fingerprint stamp —
   * the same @pw_cred_key option app/server.js stamps on sessions it creates,
   * since this lane lives inside a session shared with human windows and
   * must be judged against the exact same identity contract they are.
   *
   * Mirrors app/server.js's readSessionCredKey: omits -q deliberately, since
   * that flag makes tmux collapse a genuinely-unset option and every OTHER
   * kind of failure (session vanished, control-plane error, corrupt server)
   * into the same empty-stdout/exit-0 result. Only tmux's own "invalid
   * option" error counts as a real "nothing stamped" signal; anything else
   * resolves ok:false, which callers must fail closed on — never coerce into
   * "unstamped".
   */
  async getSessionCredKey(session) {
    try {
      // Deliberately NOT `=${session}`: unlike has-session/list-windows
      // (name lookups, where the = prefix disambiguates an exact name from
      // a prefix match), tmux's show-options/set-option -t target parser
      // does not resolve a session by its `=name` form and reports "no such
      // session" even when the session plainly exists — confirmed directly
      // against a real tmux server. A bare session name is what
      // app/server.js's own (already-proven) readSessionCredKey uses too.
      const { stdout } = await this.raw(['show-options', '-t', session, '-v', CRED_KEY_OPTION]);
      return { ok: true, key: String(stdout || '').trim() };
    } catch (e) {
      const stderr = String(e?.stderr || e?.message || '');
      if (/invalid option/i.test(stderr)) return { ok: true, key: '' };
      return { ok: false, error: stderr.trim() || String(e) };
    }
  }

  /**
   * Stamps the fingerprint AND reads it back to confirm the write actually
   * landed — mirrors app/server.js's stampSessionCredKey. Throws (fail
   * closed) if the set fails, or if the read-back does not match exactly.
   */
  async setSessionCredKey(session, key) {
    await this.raw(['set-option', '-t', session, CRED_KEY_OPTION, key]);
    const verify = await this.getSessionCredKey(session);
    if (!verify.ok || verify.key !== key) {
      throw new Error(`could not verify credential fingerprint stamp on session "${session}" (wrote ${JSON.stringify(key)}, read back ${verify.ok ? JSON.stringify(verify.key) : `unreadable: ${verify.error}`})`);
    }
  }
}

/**
 * Owns the lane lifecycle and the model/effort verification that gates every phase.
 */
export class OrchestratorSessionManager {
  constructor({
    config, store, repo, tmux, backend, clock = () => new Date(),
    // Resolves { key, tokens } for a project id — see
    // app/orchestrator/lane-credentials.js. Defaults to the cheap, safe
    // resolver that reads PW_PER_USER_CLAUDE straight from the environment
    // and costs nothing when it is not enabled (the common case for a test
    // that does not care about per-user credentials at all); production
    // wiring (app/orchestrator/index.js) always injects the real one.
    credentials = defaultLaneCredentialResolver,
  }) {
    this.config = config;
    this.store = store;
    this.repo = repo;
    this.tmux = tmux;
    this.backend = backend;
    this.clock = clock;
    this.credentials = credentials;
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
   * Resolves the per-project credential context — the SAME resolution `ensureSession()` uses to
   * decide the fingerprint it stamps on the lane's tmux pane. Exposed so a caller that spawns a
   * coding-CLI process directly (the engine's `_runPhase`/`_runReview`, and this class's own
   * `verifySession()`, none of which go through the tmux pane) applies EXACTLY what the lane is
   * attributed as, rather than resolving its own possibly-drifted answer.
   *
   * SECURITY: resolving fresh on every call (by design — a genuinely stale session must always be
   * caught) means the underlying identity CAN change between `ensureSession()` and a later call in
   * the same job — a token rotated, `primaryUser` reassigned, or the feature toggled OFF. This
   * unconditionally compares the freshly resolved fingerprint against what is CURRENTLY stamped on
   * the project's lane session — via `sessionCredentialState()`, the exact same staleness logic
   * `_ensureSession()` itself already uses, so "legitimately never stamped and currently off" is
   * still recognised as current rather than reported as a phantom mismatch — and throws
   * (fail-closed) on any real mismatch or an unreadable stamp, exactly as it throws on a
   * resolution/materialization failure.
   *
   * An earlier version of this check skipped itself entirely whenever the FRESH resolution had no
   * tokens (`cred.tokens.length === 0`), on the theory that disabled mode has nothing real to
   * protect. That reasoning has it backwards for the enable-to-disable direction: a lane stamped
   * for a REAL per-user identity, with the feature then toggled off (or `primaryUser` removed)
   * mid-job, resolves to "off" — exactly the case that early return let through unchecked, letting a
   * real spawned process run under the shared/default login while the pane's own stamp still
   * claimed per-user attribution. There is no shortcut here: every resolution, in every direction,
   * is checked against the stamp.
   */
  async resolveCredentials(projectId) {
    const cred = await this.credentials(projectId);
    const lane = this.laneFor({ project_id: projectId }, {});
    const stamped = await this.tmux.getSessionCredKey(lane.tmuxSession);
    if (!stamped.ok) {
      throw new Error(`project "${projectId}"'s lane session credential fingerprint could not be verified (${stamped.error}) — refusing to run under a possibly-mismatched identity`);
    }
    const state = sessionCredentialState({ perUserEnabled: true, desiredKey: cred.key, stampedKey: stamped.key });
    if (state.stale) {
      throw new Error(`project "${projectId}"'s credential context has changed since its lane session was last verified (${state.reason}: stamped "${stamped.key}", now resolves to "${cred.key}") — refusing to run under a possibly-mismatched identity`);
    }
    return cred;
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

    // Resolve the project's CURRENT per-user credential context (see
    // app/orchestrator/lane-credentials.js) unconditionally, BEFORE touching
    // the session at all — for a fresh session this is what must be stamped
    // once it exists; for an existing one it is exactly what its stamped
    // fingerprint must match before this lane is allowed to touch it. Throws
    // (fail-closed) on any resolution/materialization failure — this lane
    // never falls back to the shared login on a failure any more than
    // app/server.js's own credentialContext() does.
    let cred;
    try {
      cred = await this.credentials(project.project_id);
    } catch (e) {
      throw new ApiError(
        ErrorCode.WORKBENCH_UNAVAILABLE,
        `cannot resolve the current credential context for project "${project.project_id}": ${e?.message || e}`,
      );
    }

    // The project's tmux session is shared with human windows. Create it only if absent, and never
    // recreate it: doing so would kill every window an operator has open.
    const sessionExisted = await this.tmux.hasSession(lane.tmuxSession);
    if (!sessionExisted) {
      await this.tmux.newSession(lane.tmuxSession, workspacePath, laneLaunchCommand(cred));
      // The session's initial window is a plain shell, not the lane. Rename it so it cannot be
      // mistaken for one and so the lane is always created explicitly, marked, below.
      await this.tmux.raw(['rename-window', '-t', `=${lane.tmuxSession}:0`, 'shell']).catch(() => {});
      // Stamp the fingerprint before ANY window (let alone the lane) is
      // created in this brand-new session, and verify the read-back — a
      // session whose stamp cannot be confirmed must not be used as though
      // it were correctly attributed.
      try {
        await this.tmux.setSessionCredKey(lane.tmuxSession, cred.key);
      } catch (e) {
        throw new ApiError(
          ErrorCode.WORKBENCH_UNAVAILABLE,
          `project "${project.project_id}": could not verify the credential fingerprint stamp on its freshly created session: ${e?.message || e}`,
        );
      }
    } else {
      // An EXISTING session must have its stamp verified against the
      // CURRENT credential context before this lane touches it at all —
      // never mix identities. Unreadable/corrupt is fail-closed exactly like
      // a resolution failure; a genuine mismatch (owner rotated a token, was
      // reassigned, or the feature was toggled) is refused with an
      // actionable conflict rather than silently proceeding under a stale
      // identity.
      const stamped = await this.tmux.getSessionCredKey(lane.tmuxSession);
      if (!stamped.ok) {
        throw new ApiError(
          ErrorCode.WORKBENCH_UNAVAILABLE,
          `project "${project.project_id}": the existing session's credential fingerprint could not be verified (${stamped.error})`,
        );
      }
      // cred.key already reflects the fully-resolved desired state (a real
      // fingerprint, or CREDENTIALS_OFF ONLY for the legitimate
      // PW_PER_USER_CLAUDE-disabled case — this.credentials already fails
      // closed on every other "off-looking" case, including no primaryUser)
      // — perUserEnabled: true here just means "trust desiredKey as-is", not
      // a re-statement of the feature flag.
      const state = sessionCredentialState({ perUserEnabled: true, desiredKey: cred.key, stampedKey: stamped.key });
      if (state.stale) {
        throw new ApiError(
          ErrorCode.CONFLICT,
          `project "${project.project_id}"'s existing session credentials are stale (${state.reason}) relative to the current owner — refusing to touch it under a possibly-mismatched identity`,
        );
      }
      if (!stamped.key) {
        // Legitimately never stamped and nothing to be stale about (a
        // session created before this feature existed, or genuinely off):
        // adopt the stamp now, same upgrade-hygiene as app/server.js's
        // ensureTmuxSession.
        await this.tmux.setSessionCredKey(lane.tmuxSession, cred.key).catch((e) => {
          throw new ApiError(
            ErrorCode.WORKBENCH_UNAVAILABLE,
            `project "${project.project_id}": could not verify the credential fingerprint stamp on its existing session: ${e?.message || e}`,
          );
        });
      }
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

        if (cred.tokens.length > 0) {
          // A restored plain shell cannot be carrying the per-user credential environment this
          // project currently resolves to: pw-tmux-restore recreated this window from a saved
          // manifest, before this lane ever launched it, so whatever process is running in it was
          // never handed CLAUDE_CONFIG_DIR. Re-marking it in place would make it LOOK correctly
          // attributed — the marker matches, and the session's own @pw_cred_key was already
          // verified above — while the pane itself keeps running under the shared/default login.
          // That gap is exactly what this feature exists to prevent, so a fresh relaunch through
          // the SAME path a brand-new lane takes (below, via the shared replaced-record bookkeeping)
          // is required here instead of the disabled-mode re-mark-in-place below.
          await this.tmux.killWindowById(existing.id);
          laneWindowId = await this._createLane(lane, workspacePath, project, sessionKey, token, cred);
          replaced = true;
        } else {
          // Disabled mode (or the legitimate no-primaryUser case): a plain shell IS the correct
          // environment, so re-marking in place — rather than a gratuitous kill+recreate — is
          // exactly right, unchanged from before per-user credential application existed.
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
      } else {
        if (existing.orchestrator && existing.orchestrator !== token.orchestrator_instance_id) {
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
          laneWindowId = await this._createLane(lane, workspacePath, project, sessionKey, token, cred);
          replaced = true;
        }
      }
    } else {
      laneWindowId = await this._createLane(lane, workspacePath, project, sessionKey, token, cred);
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
  async _createLane(lane, workspacePath, project, sessionKey, token, cred) {
    const scratch = `${lane.reservedWindow}_new`;
    await this.tmux.newWindow(lane.tmuxSession, scratch, workspacePath, laneLaunchCommand(cred));
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

    // Resolved fresh via resolveCredentials() — the SAME resolution ensureSession() uses to decide
    // the fingerprint stamped on the lane, cross-checked against that exact stamp — and applied to
    // the verification probe itself: checking sign-in status and effective model/effort under a
    // DIFFERENT identity than the one that will actually run the job would make "verified" attest
    // to nothing. A resolution failure OR a drifted identity (the stamp no longer matches a fresh
    // resolution) is reported exactly like a backend-query failure (below): unverifiable, never
    // silently probed under a substituted login.
    let cred;
    try {
      cred = await this.resolveCredentials(project.project_id);
    } catch (e) {
      return this._verificationResponse(record, null, `cannot resolve the current credential context: ${e?.message || e}`, null);
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
        credentialTokens: cred.tokens,
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
        : 'the coding backend could not be queried', null, err?.terminationConfirmed ?? null);
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
   *
   * `terminationConfirmed` is the same kind of internal-only rider: the verification launch runs in
   * the project's own workspace and can fail to confirm a kill exactly like a coding phase can, and
   * the engine must fence rather than release when it does. `null` for the overwhelming majority of
   * calls (nothing was ever killed), so it is likewise stripped at every wire boundary rather than
   * added to a contract that has nothing to do with lease safety.
   */
  _verificationResponse(record, effective, detail, outcome = null, terminationConfirmed = null) {
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
      terminationConfirmed,
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
