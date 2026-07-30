// Round 6, item B: app/orchestrator/session.js creates a project's shared
// tmux session (~line 249, before this fix) and its lane window (~line 388)
// with no credential/fingerprint check at all — the reviewer's own probe
// observed newWindow() called with no preceding stamp read. This lane lives
// inside a session shared with human windows and must be judged against the
// exact same per-user-credential identity contract they are: resolve the
// CURRENT context, verify/stamp @pw_cred_key before ANY use, and never mix
// identities.
//
// These tests inject a fake `credentials` resolver into OrchestratorSessionManager
// (the real one, app/orchestrator/lane-credentials.js, is exercised directly in
// test/orch-lane-credentials.test.mjs) so the exact race the reviewer's probe
// found — an owner rotating between two ensureSession() calls — can be forced
// deterministically, against a REAL tmux server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { TmuxAdapter, OrchestratorSessionManager } from '../app/orchestrator/session.js';
import { resolveWorkspacePath } from '../app/orchestrator/projects.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { ApiError } from '../app/orchestrator/errors.js';
import { CREDENTIALS_OFF } from '../app/user-credentials.js';

const execFileAsync = promisify(execFile);
const HAVE_TMUX = await execFileAsync('tmux', ['-V']).then(() => true).catch(() => false);
const tmuxTest = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'tmux is not installed' }, fn);

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';

async function withLane({ credentials }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-lane-cred-'));
  const socket = `pworchcredtest${process.pid}${Number(process.hrtime.bigint() % 100000n)}`;
  const workspaceRoot = path.join(dir, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'Demo'), { recursive: true });

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_WORKSPACES: workspaceRoot, PW_ORCHESTRATOR_TMUX_SOCKET: socket,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 500,
  });
  const repo = new OrchestratorRepository(store);
  const tmux = new TmuxAdapter({ socket, executable: 'tmux' });
  const backend = new FakeCodingBackend();
  const manager = new OrchestratorSessionManager({ config, store, repo, tmux, backend, credentials });

  const project = {
    project_id: 'Demo', display_name: 'Demo', capabilities: [], verification_commands: [],
    default_branch: 'main', has_ci: false, publication_note: null, workspace_subdir: 'Demo',
  };
  const token = { token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'], scopes: [] };

  try {
    await fn({ config, store, tmux, manager, project, token, socket });
  } finally {
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    try { fs.rmSync(`/tmp/tmux-${process.getuid()}/${socket}`, { force: true }); } catch { /* fine */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ensure = (manager, project, token) => manager.ensureSession({
  token, project,
  request: {
    orchestrator_instance_id: ORCH, project_id: project.project_id,
    role: null, reserved_tmux_window: null, cli_backend: 'claude-code', force_replace: false,
  },
  correlationId: 'corr-1',
});

// Reads a pane's REAL process environment directly — tmux's own "session
// environment" (show-environment) is a separate tracked concept from what
// actually reaches the pane's process; only /proc/<pid>/environ proves what
// the launched shell actually saw. Mirrors test/project-terminal-start.test.mjs
// and test/pw-tmux-restore.test.mjs's identical helper.
async function paneEnvironByTarget(socket, target) {
  const { stdout: pidOut } = await execFileAsync('tmux', ['-L', socket, 'list-panes', '-t', target, '-F', '#{pane_pid}']);
  const pid = pidOut.trim().split('\n')[0];
  const raw = await fs.promises.readFile(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

tmuxTest('a fresh session is stamped with the resolved fingerprint before any window is created', async () => {
  let calls = 0;
  const credentials = async () => { calls += 1; return { key: 'aaaaaaaaaaaaaaaa', tokens: ['CLAUDE_CONFIG_DIR=/tmp/x'] }; };
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await ensure(manager, project, token);
    assert.ok(calls >= 1, 'the credential resolver must have been consulted');
    const stamped = await tmux.getSessionCredKey('pw_Demo');
    assert.equal(stamped.ok, true);
    assert.equal(stamped.key, 'aaaaaaaaaaaaaaaa');
  });
});

tmuxTest('REGRESSION: the resolved per-user credential environment actually reaches BOTH the fresh session and the lane window — not just the fingerprint stamp', async () => {
  const configDir = '/tmp/pw-orch-cred-probe-' + process.pid;
  const credentials = async () => ({
    key: 'dddddddddddddddd',
    tokens: [`CLAUDE_CONFIG_DIR=${configDir}`],
    shellArgs: ['--noprofile', '--norc'],
  });
  await withLane({ credentials }, async ({ tmux, manager, project, token, socket }) => {
    await ensure(manager, project, token);

    // The fingerprint stamp alone proves attribution was DECIDED — it says
    // nothing about whether the pane's actual process ever received the
    // credentials that decision resolved to. Read the real pane environment
    // for both windows this call created: the session's initial window
    // (`newSession`) and the reserved lane window (`newWindow`, via
    // `_createLane`) — the reviewer's exact finding was that neither call
    // is passed the resolved credential environment at all.
    const lane = manager.laneFor(project, {});
    const initialEnv = await paneEnvironByTarget(socket, 'pw_Demo:shell');
    assert.equal(initialEnv.CLAUDE_CONFIG_DIR, configDir,
      'the freshly created session\'s initial window must carry the resolved per-user CLAUDE_CONFIG_DIR, not the shared/default one');

    const laneWindow = await tmux.findWindow('pw_Demo', lane.reservedWindow);
    assert.ok(laneWindow, 'sanity: the lane window must exist');
    const laneEnv = await paneEnvironByTarget(socket, laneWindow.id);
    assert.equal(laneEnv.CLAUDE_CONFIG_DIR, configDir,
      'the lane window — where the coding CLI actually runs — must carry the resolved per-user CLAUDE_CONFIG_DIR, not the shared/default one');
  });
});

tmuxTest('the disabled/off case is still stamped exactly "off", never left unstamped, and the pane is unmodified', async () => {
  const credentials = async () => ({ key: CREDENTIALS_OFF, tokens: [] });
  await withLane({ credentials }, async ({ tmux, manager, project, token, socket }) => {
    await ensure(manager, project, token);
    const stamped = await tmux.getSessionCredKey('pw_Demo');
    assert.equal(stamped.ok, true);
    assert.equal(stamped.key, CREDENTIALS_OFF);
    // Disabled mode must be byte-identical to before the credential-env fix:
    // no forced launch command at all, so no CLAUDE_CONFIG_DIR appears from
    // this code path (whatever the pane's ordinary default shell env is).
    const initialEnv = await paneEnvironByTarget(socket, 'pw_Demo:shell');
    assert.equal('CLAUDE_CONFIG_DIR' in initialEnv, false, 'disabled mode must never set CLAUDE_CONFIG_DIR');
    const lane = manager.laneFor(project, {});
    const laneWindow = await tmux.findWindow('pw_Demo', lane.reservedWindow);
    const laneEnv = await paneEnvironByTarget(socket, laneWindow.id);
    assert.equal('CLAUDE_CONFIG_DIR' in laneEnv, false, 'disabled mode must never set CLAUDE_CONFIG_DIR');
  });
});

tmuxTest('REGRESSION (reviewer probe): a rotated owner is caught BEFORE newWindow ever runs — no stamp read, no mixed identity', async () => {
  let key = 'aaaaaaaaaaaaaaaa';
  const credentials = async () => ({ key, tokens: [] });
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await ensure(manager, project, token);
    const before = await tmux.listWindows('pw_Demo');
    assert.equal(before.length, 2, 'sanity: the shell window plus the lane window');

    // The owner rotates between two ensureSession() calls for the SAME
    // project — exactly what the reviewer's probe forced to observe
    // newWindow() being reached with no preceding stamp verification.
    key = 'bbbbbbbbbbbbbbbb';

    await assert.rejects(
      ensure(manager, project, token),
      (err) => err instanceof ApiError && /stale/i.test(err.message),
      'a session stamped for the OLD owner must refuse to be touched by the new one',
    );

    // The lane window must be untouched — never killed, never recreated,
    // never handed a second identity.
    const after = await tmux.listWindows('pw_Demo');
    assert.equal(after.length, 2, 'no window may have been added or replaced by the refused call');
    assert.deepEqual(after.map((w) => w.id).sort(), before.map((w) => w.id).sort(), 'window identities must be byte-identical — nothing was killed and recreated');
    const stamped = await tmux.getSessionCredKey('pw_Demo');
    assert.equal(stamped.key, 'aaaaaaaaaaaaaaaa', 'the OLD fingerprint must still be the one stamped — never silently overwritten by the rejected attempt');
  });
});

tmuxTest('REGRESSION: an unreadable existing stamp fails closed rather than being treated as unstamped', async () => {
  const credentials = async () => ({ key: 'cccccccccccccccc', tokens: [] });
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await ensure(manager, project, token);

    // Simulate a corrupt/unreadable stamp by breaking getSessionCredKey for
    // this one adapter instance (a real tmux control-plane failure is
    // exercised end-to-end in test/user-lifecycle-locking.test.mjs's tmux
    // shim; here the concern is specifically session.js's OWN handling of
    // ok:false, decoupled from tmux's exact failure mode).
    const originalGet = tmux.getSessionCredKey.bind(tmux);
    tmux.getSessionCredKey = async (session) => {
      const real = await originalGet(session);
      return { ok: false, error: 'simulated control-plane failure', key: real.key };
    };

    await assert.rejects(
      ensure(manager, project, token),
      (err) => err instanceof ApiError && /could not be verified/i.test(err.message),
    );
  });
});

tmuxTest('REGRESSION: a credential resolution failure (not "off") never falls back to the shared login', async () => {
  const credentials = async () => { throw new Error('simulated: primaryUser does not resolve to a user record'); };
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await assert.rejects(
      ensure(manager, project, token),
      (err) => err instanceof ApiError && /cannot resolve the current credential context/i.test(err.message),
    );
    assert.equal(await tmux.hasSession('pw_Demo'), false, 'no session (and therefore no shared-login fallback) may be created on a resolution failure');
  });
});

// ---------------------------------------------------------------------------
// reboot / restore / reclaim
//
// scripts/pw-tmux-restore recreates a project's tmux session and windows from
// a saved manifest — including, when the orchestrator's lane window happened
// to be idle at save time, a PLAIN unmarked shell sitting on the lane's
// reserved window name. The FIRST ensureSession() call after a restart finds
// that window, recognises it as provably its own (via the durable session
// record — see session.js's `reclaimable` check) and "reclaims" it. Before
// this fix, reclaiming meant re-marking the window in place: the session's
// own @pw_cred_key stamp and the window's role markers both end up looking
// exactly like a correctly-attributed lane, while the pane itself is still
// whatever plain shell pw-tmux-restore actually launched it with — which was
// never handed CLAUDE_CONFIG_DIR, because pw-tmux-restore ran before the
// orchestrator ever got a chance to launch that window itself.
// ---------------------------------------------------------------------------

/** Simulates exactly what pw-tmux-restore leaves behind: an UNMARKED plain idle shell sitting on
 * the lane's reserved window name, in the right directory — the one shape session.js's own
 * `reclaimable` check is designed to recognise as "provably ours, just needs re-attributing". */
async function simulateRebootRestoredLane(tmux, session, windowName, cwd) {
  const before = await tmux.findWindow(session, windowName);
  if (before) await tmux.killWindowById(before.id);
  await tmux.newWindow(session, windowName, cwd);
  const restored = await tmux.findWindow(session, windowName);
  return restored.id;
}

tmuxTest('REGRESSION: a reboot-restored plain shell on the lane\'s window name is NOT accepted as-is when credentials are enabled — it is relaunched with the resolved environment', async () => {
  const configDir = '/tmp/pw-orch-reclaim-probe-' + process.pid;
  const credentials = async () => ({
    key: 'eeeeeeeeeeeeeeee',
    tokens: [`CLAUDE_CONFIG_DIR=${configDir}`],
    shellArgs: ['--noprofile', '--norc'],
  });
  await withLane({ credentials }, async ({ config, tmux, manager, project, token, socket }) => {
    // A normal first ensureSession(): real lane, real credential env, real fingerprint.
    await ensure(manager, project, token);
    const lane = manager.laneFor(project, {});
    const workspacePath = resolveWorkspacePath(config, project);

    // Simulate the reboot: pw-tmux-restore recreates the SAME-named window as a plain, unmarked,
    // uncredentialed idle shell — the session's own @pw_cred_key stamp is untouched by this (a
    // real restore, already fixed in an earlier round, keeps the SESSION-level stamp current; this
    // test isolates the WINDOW-level gap specifically). Same cwd as the real lane, matching exactly
    // what a real restore leaves (and what session.js's own `reclaimable` check requires).
    const restoredWindowId = await simulateRebootRestoredLane(tmux, 'pw_Demo', lane.reservedWindow, workspacePath);
    const restoredEnv = await paneEnvironByTarget(socket, restoredWindowId);
    assert.equal('CLAUDE_CONFIG_DIR' in restoredEnv, false, 'sanity: the simulated restored shell must start uncredentialed, like a real restore leaves it');

    // The next ensureSession() (what the engine calls before running any phase) must not silently
    // accept this plain shell as the lane just because its name and the session's own stamp check
    // out — it must relaunch it with the actual resolved credential environment.
    await ensure(manager, project, token);

    const reclaimedWindow = await tmux.findWindow('pw_Demo', lane.reservedWindow);
    assert.ok(reclaimedWindow, 'sanity: the lane window must still exist under its reserved name');
    assert.notEqual(reclaimedWindow.id, restoredWindowId,
      'the plain restored shell must have been killed and replaced, not re-marked in place — its tmux window id must change');
    const reclaimedEnv = await paneEnvironByTarget(socket, reclaimedWindow.id);
    assert.equal(reclaimedEnv.CLAUDE_CONFIG_DIR, configDir,
      'the relaunched lane window must carry the resolved per-user CLAUDE_CONFIG_DIR — a restored lane must never be accepted while still running the shared/default shell');
  });
});

tmuxTest('a reboot-restored plain shell IS accepted as-is (re-marked, never killed) when credentials are disabled', async () => {
  const credentials = async () => ({ key: CREDENTIALS_OFF, tokens: [] });
  await withLane({ credentials }, async ({ config, tmux, manager, project, token }) => {
    await ensure(manager, project, token);
    const lane = manager.laneFor(project, {});
    const workspacePath = resolveWorkspacePath(config, project);

    // Same simulated restore, but for a project where a plain shell IS the correct environment —
    // there is nothing to relaunch for, and killing/recreating it would be a gratuitous disruption
    // to whatever the operator is looking at.
    const restoredWindowId = await simulateRebootRestoredLane(tmux, 'pw_Demo', lane.reservedWindow, workspacePath);

    await ensure(manager, project, token);

    const reclaimedWindow = await tmux.findWindow('pw_Demo', lane.reservedWindow);
    assert.equal(reclaimedWindow.id, restoredWindowId,
      'disabled mode must re-mark the restored shell in place — unchanged from before per-user credential application existed');
  });
});

// ---------------------------------------------------------------------------
// SECURITY: credential drift between ensureSession() (which decides what is
// STAMPED and what the pane is LAUNCHED with) and every later resolution —
// verifySession()'s probe, and engine.js's per-phase resolveCredentials()
// call (see app/orchestrator/engine.js's _runPhase()/_runReview()).
//
// Each of these resolves the project's credential context FRESH,
// independently, on every call — by design, so a genuinely stale session is
// always caught. But nothing compared a FRESH resolution against what the
// lane was actually stamped/launched with: if the underlying state changes
// mid-job (a token rotated, primaryUser reassigned, the feature toggled)
// between ensureSession() and a later call, that later call would silently
// resolve to the NEW identity and apply IT to a real spawned process or
// verification probe — while the pane itself (and the stamp) still say the
// OLD one. A job's automated work and its own attributed pane would then be
// running under two different identities at once.
// ---------------------------------------------------------------------------

tmuxTest('SECURITY REGRESSION: a credential resolution AFTER ensureSession() must fail closed when the underlying identity has drifted, never silently apply the newly-resolved one', async () => {
  const configDirA = '/tmp/pw-orch-drift-A-' + process.pid;
  const configDirB = '/tmp/pw-orch-drift-B-' + process.pid;
  let active = 'A';
  const credentials = async () => (active === 'A'
    ? { key: 'a000000000000000', tokens: [`CLAUDE_CONFIG_DIR=${configDirA}`], shellArgs: ['--noprofile', '--norc'] }
    : { key: 'b111111111111111', tokens: [`CLAUDE_CONFIG_DIR=${configDirB}`], shellArgs: ['--noprofile', '--norc'] });

  await withLane({ credentials }, async ({ manager, project, token }) => {
    // ensureSession() resolves and stamps identity A — the lane's pane is launched under A.
    await ensure(manager, project, token);

    // The underlying credential state changes mid-job — a token rotated, the owner was
    // reassigned, whatever the cause. Nothing about the ALREADY-STAMPED, already-launched pane
    // changes; only what a FRESH resolution would now produce does.
    active = 'B';

    // engine.js's _runPhase()/_runReview() call this exact method before spawning a phase. It must
    // never silently hand back identity B's tokens for a job whose lane is stamped for A — that
    // would spawn a REAL Claude process under a DIFFERENT identity than the one this job's pane
    // (and its own fingerprint stamp) claims to be running under.
    await assert.rejects(
      manager.resolveCredentials(project.project_id),
      /drift|changed|stale|mismatch/i,
      'a credential resolution that disagrees with what the lane is currently stamped/launched under must fail closed, not silently hand back the new identity',
    );
  });
});

tmuxTest('a credential resolution that has NOT drifted (repeated identical resolution) still succeeds normally', async () => {
  const configDir = '/tmp/pw-orch-nodrift-' + process.pid;
  const credentials = async () => ({
    key: 'c222222222222222', tokens: [`CLAUDE_CONFIG_DIR=${configDir}`], shellArgs: ['--noprofile', '--norc'],
  });
  await withLane({ credentials }, async ({ manager, project, token }) => {
    await ensure(manager, project, token);
    // Same identity resolves again — the common case (nothing changed) must not be treated as drift.
    const cred = await manager.resolveCredentials(project.project_id);
    assert.deepEqual(cred.tokens, [`CLAUDE_CONFIG_DIR=${configDir}`]);
  });
});

tmuxTest('SECURITY REGRESSION: an enable-to-disable drift must fail closed too — a fresh "off" resolution is not exempt from the stamp check', async () => {
  // The specific gap an independent exact-head review found: resolveCredentials() skipped its own
  // drift check whenever the FRESH resolution had no tokens (i.e. resolved to "off"), on the theory
  // that disabled mode has nothing real to protect. That reasoning has it backwards for THIS
  // direction: if the lane is stamped for a REAL per-user identity (PW_PER_USER_CLAUDE was on when
  // ensureSession() ran) and the feature is toggled off — or the project's primaryUser is removed —
  // mid-job, a later resolution correctly resolves to "off" and MUST still be compared against the
  // stamp: silently returning it lets a real spawned process run under the shared/default login
  // while the lane's own pane and fingerprint stamp still claim to be attributed to the per-user
  // owner.
  const configDirA = '/tmp/pw-orch-drift-off-A-' + process.pid;
  let enabled = true;
  const credentials = async () => (enabled
    ? { key: 'd333333333333333', tokens: [`CLAUDE_CONFIG_DIR=${configDirA}`], shellArgs: ['--noprofile', '--norc'] }
    : { key: CREDENTIALS_OFF, tokens: [], shellArgs: ['--noprofile', '--norc'] });

  await withLane({ credentials }, async ({ manager, project, token }) => {
    await ensure(manager, project, token); // stamps the REAL per-user fingerprint

    enabled = false; // PW_PER_USER_CLAUDE toggled off (or primaryUser removed) mid-job

    await assert.rejects(
      manager.resolveCredentials(project.project_id),
      /drift|changed|stale|mismatch/i,
      'a fresh "off" resolution against a lane stamped for a REAL per-user identity must still fail closed — never silently apply the shared/default login to a phase whose pane claims per-user attribution',
    );
  });
});

tmuxTest('SECURITY REGRESSION: an unreadable stamp must fail closed even when the fresh resolution is "off"', async () => {
  // The same gap, for the OTHER field the old early-return skipped checking: stamp READABILITY.
  // A control-plane failure reading the stamp is exactly as dangerous as a real mismatch — it means
  // this code genuinely does not know what the lane is currently attributed to, and "off" being the
  // fresh answer must not be treated as license to skip finding that out.
  const credentials = async () => ({ key: CREDENTIALS_OFF, tokens: [] });
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await ensure(manager, project, token);
    const originalGet = tmux.getSessionCredKey.bind(tmux);
    tmux.getSessionCredKey = async (session) => {
      const real = await originalGet(session);
      return { ok: false, error: 'simulated control-plane failure', key: real.key };
    };
    await assert.rejects(
      manager.resolveCredentials(project.project_id),
      /could not be verified|verify/i,
      'an unreadable stamp must fail closed regardless of what the fresh resolution says',
    );
  });
});

tmuxTest('a disabled-mode resolution that has NOT drifted (stamped "off", resolves "off" again) still succeeds normally', async () => {
  // The common, legitimate case for a project that has never used per-user credentials at all:
  // stamped "off", resolves "off" again. Must not be treated as drift — this is what the previous
  // (flawed) early-return was trying to protect, just via the wrong mechanism.
  const credentials = async () => ({ key: CREDENTIALS_OFF, tokens: [] });
  await withLane({ credentials }, async ({ manager, project, token }) => {
    await ensure(manager, project, token);
    const cred = await manager.resolveCredentials(project.project_id);
    assert.equal(cred.key, CREDENTIALS_OFF);
    assert.deepEqual(cred.tokens, []);
  });
});
