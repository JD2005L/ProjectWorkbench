// Increment 5 — the named orchestrator lane.
//
// The contract's hardest requirement here is a negative one: a human's interactive Claude window
// must never be adopted, reused, or disturbed. So these tests run against a *private tmux server*
// (its own socket, never the live one), plant a human window alongside the lane, and assert after
// every operation — including a forced replacement — that the human window's id, pane pid and
// working directory are byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { loadOrchestratorConfig, laneNaming } from '../app/orchestrator/config.js';
import { TmuxAdapter, OrchestratorSessionManager } from '../app/orchestrator/session.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { ApiError } from '../app/orchestrator/errors.js';
import { deriveSessionKey, OrchestratorSessionStatus } from '../app/orchestrator/contract.js';

const execFileAsync = promisify(execFile);

const HAVE_TMUX = await execFileAsync('tmux', ['-V']).then(() => true).catch(() => false);
const tmuxTest = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'tmux is not installed' }, fn);

const ORCH = 'orch-test';
const INSTANCE = 'wb-test-01';

/**
 * Stand up an isolated fixture: a private tmux server on its own socket, a temporary workspace
 * root, and a temporary store. Nothing here can reach the live tmux server or a real project.
 */
async function withLane(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-lane-'));
  const socket = `pworchtest${process.pid}${Number(process.hrtime.bigint() % 100000n)}`;
  const workspaceRoot = path.join(dir, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'Demo'), { recursive: true });

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_WORKSPACES: workspaceRoot,
    PW_ORCHESTRATOR_TMUX_SOCKET: socket,
  });

  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 500,
  });
  const repo = new OrchestratorRepository(store);
  const tmux = new TmuxAdapter({ socket, executable: 'tmux' });
  const backend = new FakeCodingBackend();
  const manager = new OrchestratorSessionManager({ config, store, repo, tmux, backend });

  const project = {
    project_id: 'Demo', display_name: 'Demo', capabilities: [], verification_commands: [],
    default_branch: 'main', has_ci: false, publication_note: null, workspace_subdir: 'Demo',
  };
  const token = { token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'], scopes: [] };

  try {
    await fn({ config, store, repo, tmux, manager, project, token, backend, workspaceRoot, socket });
  } finally {
    // kill-server stops the server but leaves the socket file behind; teardown must leave no
    // tmux artefact at all, so the socket is unlinked too.
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    for (const base of [process.env.TMUX_TMPDIR, '/tmp'].filter(Boolean)) {
      fs.rmSync(path.join(base, `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    }
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ensure = (manager, project, token, overrides = {}) => manager.ensureSession({
  token,
  project,
  request: {
    orchestrator_instance_id: ORCH, project_id: project.project_id,
    role: null, reserved_tmux_window: null, cli_backend: 'claude-code', force_replace: false,
    ...overrides,
  },
  correlationId: 'corr-1',
  idempotencyKey: 'idem-1',
});

/** Everything about a window that must not change when it is not ours to touch. */
async function windowFingerprints(tmux, session) {
  const windows = await tmux.listWindows(session);
  return Object.fromEntries(windows.map((w) => [w.name, `${w.id}|${w.panePid}|${w.paneCurrentPath}`]));
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

test('lane: naming follows the §5 convention and is configuration-driven', () => {
  const stock = loadOrchestratorConfig({ PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1' });
  assert.deepEqual(laneNaming(stock, 'PVHGateway'), {
    role: 'pvi2-orchestrator',
    reservedWindow: 'orch_pvibot',
    tmuxSession: 'pw_PVHGateway',
    displayName: 'pvibot-orchestrator-pvhgateway',
  });

  const custom = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true', PW_ORCHESTRATOR_INSTANCE_ID: 'wb-1',
    PW_ORCHESTRATOR_ROLE: 'lab-orch', PW_ORCHESTRATOR_WINDOW: 'lab_lane',
    PW_ORCHESTRATOR_TMUX_PREFIX: 'lab_', PW_ORCHESTRATOR_DISPLAY_PREFIX: 'labbot-',
  });
  assert.deepEqual(laneNaming(custom, 'PVHGateway'), {
    role: 'lab-orch', reservedWindow: 'lab_lane', tmuxSession: 'lab_PVHGateway',
    displayName: 'labbot-pvhgateway',
  });
});

// ---------------------------------------------------------------------------
// creation, reuse, replacement
// ---------------------------------------------------------------------------

tmuxTest('lane: first ensure creates the reserved window and reports missing, not ready', async () => {
  await withLane(async ({ manager, project, token, tmux, config, workspaceRoot }) => {
    const session = await ensure(manager, project, token);

    assert.equal(session.session_key, deriveSessionKey(ORCH, INSTANCE, 'Demo', 'pvi2-orchestrator'));
    assert.equal(session.project_tmux_session, 'pw_Demo');
    assert.equal(session.reserved_tmux_window, 'orch_pvibot');
    assert.equal(session.role, 'pvi2-orchestrator');
    assert.equal(session.cli_display_name, 'pvibot-orchestrator-demo');
    assert.equal(session.workbench_instance_id, INSTANCE);
    // A freshly created lane has verified nothing, so it must not claim to be ready.
    assert.equal(session.status, OrchestratorSessionStatus.MISSING);
    assert.equal(session.effective, null);
    assert.equal(session.last_verified_at, null);

    const windows = await tmux.listWindows('pw_Demo');
    const lane = windows.find((w) => w.name === 'orch_pvibot');
    assert.ok(lane, 'the reserved window must exist');
    assert.equal(lane.role, 'pvi2-orchestrator', 'the lane must carry its role marker');
    assert.equal(lane.projectId, 'Demo');
    assert.equal(lane.sessionKey, session.session_key);
    assert.equal(lane.paneCurrentPath, fs.realpathSync(path.join(workspaceRoot, 'Demo')));
  });
});

tmuxTest('lane: a second ensure reuses the same lane and creates no second window', async () => {
  await withLane(async ({ manager, project, token, tmux }) => {
    const first = await ensure(manager, project, token);
    const before = await windowFingerprints(tmux, 'pw_Demo');

    const second = await ensure(manager, project, token);
    assert.equal(second.session_key, first.session_key);
    assert.equal(second.created_at, first.created_at, 'reuse must not recreate the lane');

    const after = await windowFingerprints(tmux, 'pw_Demo');
    assert.deepEqual(after, before, 'reuse must leave every window exactly as it was');
    const lanes = (await tmux.listWindows('pw_Demo')).filter((w) => w.name === 'orch_pvibot');
    assert.equal(lanes.length, 1);
  });
});

tmuxTest("lane: a human's interactive window is never adopted and never disturbed", async () => {
  await withLane(async ({ manager, project, token, tmux, socket }) => {
    // A human is already working in this project: their own window, and a Claude one.
    await tmux.raw(['new-session', '-d', '-s', 'pw_Demo', '-n', 'bash', 'sleep 600']);
    await tmux.raw(['new-window', '-t', 'pw_Demo', '-n', 'claude.exe', 'sleep 600']);
    const before = await windowFingerprints(tmux, 'pw_Demo');
    assert.deepEqual(Object.keys(before).sort(), ['bash', 'claude.exe']);

    const session = await ensure(manager, project, token);
    const afterCreate = await windowFingerprints(tmux, 'pw_Demo');
    for (const name of ['bash', 'claude.exe']) {
      assert.equal(afterCreate[name], before[name], `${name} must be untouched by lane creation`);
    }
    assert.ok(afterCreate.orch_pvibot, 'the lane is a new window, never an adopted one');

    // A forced replacement must still only touch the orchestrator-owned window.
    const replaced = await ensure(manager, project, token, { force_replace: true });
    const afterReplace = await windowFingerprints(tmux, 'pw_Demo');
    for (const name of ['bash', 'claude.exe']) {
      assert.equal(afterReplace[name], before[name], `${name} must be untouched by a forced replacement`);
    }
    assert.notEqual(afterReplace.orch_pvibot, afterCreate.orch_pvibot, 'the lane itself must have been replaced');
    assert.equal(replaced.session_key, session.session_key);

    // The human windows must still carry no role marker — they were never marked as ours.
    const windows = await tmux.listWindows('pw_Demo');
    for (const w of windows.filter((x) => x.name !== 'orch_pvibot')) {
      assert.equal(w.role, null, `${w.name} must not have been marked as an orchestrator lane`);
    }
  });
});

tmuxTest('lane: a window occupying the reserved name without the role marker is refused, not killed', async () => {
  await withLane(async ({ manager, project, token, tmux }) => {
    // Something else is already called orch_pvibot but carries no marker. Killing it would be
    // destroying a window this service cannot prove it owns.
    await tmux.raw(['new-session', '-d', '-s', 'pw_Demo', '-n', 'orch_pvibot', 'sleep 600']);
    const before = await windowFingerprints(tmux, 'pw_Demo');

    await assert.rejects(ensure(manager, project, token), (err) => err instanceof ApiError && err.code === 'conflict');
    await assert.rejects(
      ensure(manager, project, token, { force_replace: true }),
      (err) => err instanceof ApiError && err.code === 'conflict',
      'not even force_replace may destroy an unowned window',
    );

    assert.deepEqual(await windowFingerprints(tmux, 'pw_Demo'), before);
  });
});

tmuxTest('lane: a lane marked for another project is replaced rather than reused', async () => {
  await withLane(async ({ manager, project, token, tmux, store, repo }) => {
    const first = await ensure(manager, project, token);
    // Corrupt the marker so the window claims to belong to a different project — the "stale lane"
    // case the contract requires be replaced.
    await tmux.setWindowOption('pw_Demo', 'orch_pvibot', '@pw_project', 'SomethingElse');
    const before = await windowFingerprints(tmux, 'pw_Demo');

    const second = await ensure(manager, project, token);
    const after = await windowFingerprints(tmux, 'pw_Demo');
    assert.notEqual(after.orch_pvibot, before.orch_pvibot, 'a stale lane must be replaced');
    assert.equal(second.session_key, first.session_key);

    const lane = (await tmux.listWindows('pw_Demo')).find((w) => w.name === 'orch_pvibot');
    assert.equal(lane.projectId, 'Demo');
  });
});

tmuxTest('lane: uniqueness is per (orchestrator, workbench, project, role)', async () => {
  await withLane(async ({ manager, project, token, store }) => {
    await ensure(manager, project, token);
    const otherOrchestrator = { ...token, orchestrator_instance_id: 'orch-other' };
    // A different orchestrator must get a different registry key, and must not silently take over
    // the first one's lane.
    await assert.rejects(
      manager.ensureSession({
        token: otherOrchestrator,
        project,
        request: {
          orchestrator_instance_id: 'orch-other', project_id: 'Demo', role: null,
          reserved_tmux_window: null, cli_backend: 'claude-code', force_replace: false,
        },
        correlationId: 'c', idempotencyKey: 'i2',
      }),
      (err) => err instanceof ApiError && err.code === 'conflict',
      'a second orchestrator must not take over the reserved window',
    );
    assert.equal(store.list('sessions').length, 1);
  });
});

tmuxTest('lane: the recorded session survives a restart of the workbench process', async () => {
  await withLane(async ({ manager, project, token, config, store }) => {
    const first = await ensure(manager, project, token);
    assert.ok(store.get('sessions', first.session_key));

    // Re-open the store as a fresh process would, and confirm the lane record is durable.
    await store.close();
    const reopened = await JournalStore.open({
      journalPath: config.journalPath, snapshotPath: config.snapshotPath,
      lockPath: config.lockPath, compactEveryRecords: 500,
    });
    const record = reopened.get('sessions', first.session_key);
    assert.equal(record.project_id, 'Demo');
    assert.equal(record.role, 'pvi2-orchestrator');
    await reopened.close();
    // Reopen once more so the fixture's own close() is a no-op rather than an error.
    const final = await JournalStore.open({
      journalPath: config.journalPath, snapshotPath: config.snapshotPath,
      lockPath: config.lockPath, compactEveryRecords: 500,
    });
    await final.close();
  });
});

// ---------------------------------------------------------------------------
// model and effort verification (contract §6)
// ---------------------------------------------------------------------------

tmuxTest('lane: verification reports real effective settings and marks the lane ready', async () => {
  await withLane(async ({ manager, project, token, backend }) => {
    const session = await ensure(manager, project, token);
    backend.mirrorRequested = true;

    const result = await manager.verifySession({
      token, project,
      request: {
        session_key: session.session_key, phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
      },
      correlationId: 'corr-2',
    });

    assert.equal(result.session_key, session.session_key);
    assert.deepEqual(
      { model_alias: result.effective.model_alias, effort: result.effective.effort },
      { model_alias: 'sonnet', effort: 'high' },
    );
    assert.equal(result.backend, 'claude-code');
    assert.ok(result.checked_at);

    const reread = await ensure(manager, project, token);
    assert.equal(reread.status, OrchestratorSessionStatus.READY, 'a verified lane becomes ready');
    assert.ok(reread.last_verified_at, 'ready requires a verification time');
    assert.ok(reread.effective, 'ready requires captured effective settings');
  });
});

tmuxTest('lane: an unverifiable configuration returns effective: null and never a guess', async () => {
  await withLane(async ({ manager, project, token, backend }) => {
    const session = await ensure(manager, project, token);
    // The CLI cannot be queried. The contract offers no way to say "probably correct".
    backend.mirrorRequested = false;
    backend.effective = null;

    const result = await manager.verifySession({
      token, project,
      request: {
        session_key: session.session_key, phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
      },
      correlationId: 'corr-3',
    });
    assert.equal(result.effective, null);
    assert.ok(result.detail, 'an unverifiable answer should say why');

    const reread = await ensure(manager, project, token);
    assert.notEqual(reread.status, OrchestratorSessionStatus.READY, 'unverified must never read as ready');
  });
});

tmuxTest('lane: a drifted session reports what is actually active, not what was asked for', async () => {
  await withLane(async ({ manager, project, token, backend }) => {
    const session = await ensure(manager, project, token);
    backend.mirrorRequested = false;
    backend.effective = { model_alias: 'haiku', effort: 'low' };

    const result = await manager.verifySession({
      token, project,
      request: {
        session_key: session.session_key, phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
      },
      correlationId: 'corr-4',
    });
    assert.equal(result.effective.model_alias, 'haiku');
    assert.equal(result.effective.effort, 'low');
  });
});

tmuxTest('lane: a verification probe that could not confirm a kill was dead is surfaced, not folded into an ordinary "unverifiable" answer', async () => {
  // The real backend's `verifyConfiguration` throws exactly this shape (kind + terminationConfirmed)
  // once its fingerprint/auth probe reports an unconfirmed kill — this proves `verifySession`'s
  // existing catch, unmodified, still carries that verdict through to the caller rather than
  // collapsing it into the same undifferentiated "the coding backend could not be queried" every
  // other failure gets. `engine.js` reads exactly this field to decide whether to fence the project's
  // lease instead of releasing it.
  await withLane(async ({ manager, project, token, backend }) => {
    const session = await ensure(manager, project, token);
    backend.verifyConfiguration = async () => {
      const error = new Error('a probe before the launch could not confirm a kill was actually dead');
      error.kind = 'phase_failed';
      error.terminationConfirmed = false;
      throw error;
    };

    const result = await manager.verifySession({
      token, project,
      request: {
        session_key: session.session_key, phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
      },
      correlationId: 'corr-verdict',
    });

    assert.equal(result.effective, null, 'an unconfirmed probe kill can never be reported as verified');
    assert.equal(result.terminationConfirmed, false, 'the verdict must survive verifySession\'s own catch, not be dropped');
  });
});

tmuxTest('lane: verifying an unknown or foreign session key is refused', async () => {
  await withLane(async ({ manager, project, token }) => {
    await assert.rejects(
      manager.verifySession({
        token, project,
        request: {
          session_key: 'someone-else:wb:Demo:pvi2-orchestrator', phase_class: 'implementation',
          requested: { model_alias: 'sonnet', effort: 'high' },
        },
        correlationId: 'c',
      }),
      (err) => err instanceof ApiError && ['not_found', 'forbidden_scope'].includes(err.code),
    );
  });
});
