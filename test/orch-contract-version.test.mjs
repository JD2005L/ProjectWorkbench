// The attestation contract version a peer asks for, and what happens when this build cannot meet it.
//
// Found by the real orchestrator harness, not by anything here. `VerifySessionRequest` carries
// `attestation_contract_version` — "the attestation contract the orchestrator speaks; a peer that
// cannot meet it should say so rather than answering in a shape that implies checks it never
// performed". ProjectWorkbench accepted the field and threw it away: in `session.js` the line meant
// to forward it was a **duplicate `sessionKey:` key**, so the object literal silently overwrote the
// pass-through with a value it already had.
//
// The comment above that line described exactly what it was supposed to do, which is what made the
// defect invisible to review — the code read correctly and did nothing. Nothing failed, because a
// silently discarded field cannot fail: PW answered every peer in 1.1 shape whatever it asked for.
//
// So these tests do not merely check that a value arrives. They check that it *participates*: a
// version this build cannot meet must produce no attestation at all, because the alternative is
// answering a 1.0 peer in a shape that claims checks it has no way to interpret.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildAttestation, DEFAULT_MODEL_ALIASES } from '../app/orchestrator/attestation.js';
import { ATTESTATION_CONTRACT_VERSION, AuthMode, Provenance } from '../app/orchestrator/contract.js';
import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { TmuxAdapter, OrchestratorSessionManager } from '../app/orchestrator/session.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';

const execFileAsync = promisify(execFile);
// The end-to-end cases stand up a private tmux server. Skipped rather than passed vacuously where
// tmux is absent — the unit cases above still cover the refusal itself.
const HAVE_TMUX = await execFileAsync('tmux', ['-V']).then(() => true).catch(() => false);
const tmuxTest = (name, fn) => test(name, { skip: HAVE_TMUX ? false : 'tmux is not installed' }, fn);

const INSTANCE = 'wb-test-01';
const ORCH = 'orch-test';

const FINGERPRINT = Object.freeze({
  ok: true,
  realpath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
  version: '2.1.220 (Claude Code)',
  capabilities: {
    '--effort': { declared: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    '--model': { declared: true, values: null },
  },
});

const BINDING = Object.freeze({
  session_key: `${ORCH}:${INSTANCE}:Demo:pvi2-orchestrator`,
  run_id: 'fcb8ceac-504f-4bb3-8f73-c963b7eae1af',
  verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  config_generation: 3,
  at: '2026-07-27T12:00:00.000Z',
  auth_mode: AuthMode.SUBSCRIPTION,
});

const INIT = Object.freeze({
  model: 'claude-sonnet-5', apiKeySource: 'none', claude_code_version: '2.1.220',
  session_id: BINDING.run_id,
});

const build = (overrides = {}) => buildAttestation({
  requested: { model_alias: 'sonnet', effort: 'high' },
  aliases: DEFAULT_MODEL_ALIASES,
  init: INIT,
  fingerprint: FINGERPRINT,
  argvOwnedByServer: true,
  binding: BINDING,
  instanceId: INSTANCE,
  argv: ['-p', 'x', '--model', 'sonnet', '--effort', 'high'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// the version participates, rather than being carried and ignored
// ---------------------------------------------------------------------------

test('contract version: the version this build implements is stamped on the envelope', () => {
  const attestation = build({ attestationContractVersion: ATTESTATION_CONTRACT_VERSION }).settings_attestation;
  assert.equal(attestation.envelope.contract_version, ATTESTATION_CONTRACT_VERSION);
});

test('contract version: a peer asking for one this build cannot meet gets no attestation', () => {
  // Failing closed is the whole point of the field. Answering a 1.0 peer in 1.1 shape would imply
  // checks it cannot interpret; answering it in 1.0 shape would imply checks this build did not
  // make. The honest answer is no attestation, which blocks the job and says why.
  const result = build({ attestationContractVersion: '1.0' });
  assert.equal(result.settings_attestation, null);
  assert.equal(result.effective, null);
  assert.equal(result.blocking, true);
  assert.match(result.detail, /attestation contract 1\.0/);
  assert.match(result.detail, new RegExp(ATTESTATION_CONTRACT_VERSION.replace('.', '\\.')));
});

test('contract version: a future version is refused too, not optimistically accepted', () => {
  // Not "at least 1.1". A peer speaking 2.0 expects checks this build has never heard of, and
  // answering it at all is the failure mode — a newer peer is not a superset of an older one.
  for (const asked of ['2.0', '1.2', '0.9']) {
    const result = build({ attestationContractVersion: asked });
    assert.equal(result.settings_attestation, null, `${asked} must not be answered`);
    assert.equal(result.blocking, true);
  }
});

test('contract version: a missing or malformed version fails closed, never defaults to agreement', () => {
  // Absence is not assent. `null` is what `session.js` passes when the request carried no version,
  // and it must not be read as agreement — a peer that says nothing has not told us it can read
  // the shape we are about to send. (A peer that omits the field over HTTP is a different case:
  // the contract gives `VerifySessionRequest` its own default and the API applies it, so that peer
  // has declared a version on the contract's terms. `undefined` therefore means "no peer in the
  // picture", not "a silent peer", and is the one value that may inherit this build's own version.)
  for (const asked of [null, '', 'one-point-one', '1', {}, 1.1, ['1.1']]) {
    const result = build({ attestationContractVersion: asked });
    assert.equal(result.settings_attestation, null, `${JSON.stringify(asked)} must not be answered`);
    assert.equal(result.blocking, true);
  }
});

// ---------------------------------------------------------------------------
// end to end, through the real session manager — where the defect actually lived
// ---------------------------------------------------------------------------

async function withSessions(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-ver-'));
  // A socket NAME, not a path: tmux resolves `-L` under its own runtime directory.
  const socket = `pworchver${process.pid}${Number(process.hrtime.bigint() % 100000n)}`;
  const workspaceRoot = path.join(dir, 'workspaces');
  fs.mkdirSync(path.join(workspaceRoot, 'Demo'), { recursive: true });

  const projectsPath = path.join(dir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: {
      Demo: {
        display_name: 'Demo', capabilities: ['implementation'],
        verification_commands: ['true'], default_branch: 'main', has_ci: false,
      },
    },
  }));

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: workspaceRoot,
    // A private tmux namespace: these tests must never touch a human's lanes.
    PW_ORCHESTRATOR_TMUX_SOCKET: socket,
  });
  const store = await JournalStore.open({
    journalPath: config.journalPath, snapshotPath: config.snapshotPath,
    lockPath: config.lockPath, compactEveryRecords: 1_000,
  });
  try {
    const repo = new OrchestratorRepository(store);
    const backend = new FakeCodingBackend();
    backend.mirrorRequested = true;
    const tmux = new TmuxAdapter({ socket, executable: 'tmux' });
    const sessions = new OrchestratorSessionManager({ config, store, repo, tmux, backend });
    await fn({ sessions, backend, store, config });
  } finally {
    await store.close();
    // kill-server stops the server but leaves the socket file behind; teardown must leave no tmux
    // artefact at all, so the socket is unlinked too — as `orch-session.test.mjs` already does.
    await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
    for (const base of [process.env.TMUX_TMPDIR, '/tmp'].filter(Boolean)) {
      fs.rmSync(path.join(base, `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOKEN = Object.freeze({
  token_id: 't', orchestrator_instance_id: ORCH, projects: ['Demo'],
  scopes: ['jobs:read', 'jobs:write', 'session:manage'],
});
const PROJECT = Object.freeze({
  project_id: 'Demo', display_name: 'Demo', capabilities: [], verification_commands: [],
  default_branch: 'main', has_ci: false, publication_note: null, workspace_subdir: 'Demo',
});

tmuxTest('contract version: the requested version reaches the backend through the session manager', async () => {
  // The regression proper. `session.js` built its call to `verifyConfiguration` with a duplicate
  // `sessionKey:` key where the contract-version pass-through belonged, so the field arrived at the
  // API, passed validation, and stopped there. Asserting on what the backend was *called with* is
  // the only way to see that: every response-shaped assertion passed while the field was discarded.
  await withSessions(async ({ sessions, backend }) => {
    const session = await sessions.ensureSession({
      token: TOKEN, project: PROJECT,
      request: { orchestrator_instance_id: ORCH, project_id: 'Demo', cli_backend: 'claude-code', force_replace: false },
      correlationId: 'c1', idempotencyKey: 'k1',
    });

    await sessions.verifySession({
      token: TOKEN, project: PROJECT,
      request: {
        session_key: session.session_key,
        phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
        run_id: 'job_1:implementation',
        config_generation: 3,
        verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        attestation_contract_version: ATTESTATION_CONTRACT_VERSION,
      },
      correlationId: 'c2',
    });

    const verify = backend.invocations.filter((i) => i.kind === 'verify').at(-1);
    assert.ok(verify, 'the backend must have been asked to verify');
    assert.equal(
      verify.attestationContractVersion, ATTESTATION_CONTRACT_VERSION,
      'the version the caller asked for must reach the backend, not be dropped in the literal',
    );
    // And the session key still arrives — the duplicate key it was hiding behind was not wrong,
    // merely redundant, and removing it must not take the real field with it.
    assert.equal(verify.sessionKey, session.session_key);
  });
});

tmuxTest('contract version: a peer speaking an older contract is refused end to end', async () => {
  await withSessions(async ({ sessions, backend }) => {
    const session = await sessions.ensureSession({
      token: TOKEN, project: PROJECT,
      request: { orchestrator_instance_id: ORCH, project_id: 'Demo', cli_backend: 'claude-code', force_replace: false },
      correlationId: 'c1', idempotencyKey: 'k1',
    });

    const response = await sessions.verifySession({
      token: TOKEN, project: PROJECT,
      request: {
        session_key: session.session_key,
        phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
        run_id: 'job_1:implementation',
        config_generation: 3,
        verification_nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        attestation_contract_version: '1.0',
      },
      correlationId: 'c2',
    });

    const verify = backend.invocations.filter((i) => i.kind === 'verify').at(-1);
    assert.equal(verify.attestationContractVersion, '1.0');
    // `SessionVerificationResponse` derives `effective` from the attestation, so a null attestation
    // is the shape that blocks the job — and the detail has to name both versions, or an operator
    // sees a refusal with no way to tell which side needs upgrading.
    assert.equal(response.attestation ?? null, null);
    assert.match(response.detail, /1\.0/);
  });
});
