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

tmuxTest('the disabled/off case is still stamped exactly "off", never left unstamped', async () => {
  const credentials = async () => ({ key: CREDENTIALS_OFF, tokens: [] });
  await withLane({ credentials }, async ({ tmux, manager, project, token }) => {
    await ensure(manager, project, token);
    const stamped = await tmux.getSessionCredKey('pw_Demo');
    assert.equal(stamped.ok, true);
    assert.equal(stamped.key, CREDENTIALS_OFF);
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
