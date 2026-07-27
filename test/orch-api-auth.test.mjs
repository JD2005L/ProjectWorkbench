// Increment 4 — the HTTP surface: authorization, scoping, limits, and discovery.
//
// The orchestration API is not a browser API. It carries a dedicated scoped service token, it is
// exempt from the dashboard's Origin/Referer CSRF gate (a bearer credential is not replayed by a
// browser), and — critically — the separation runs both ways: a dashboard session cookie must not
// authenticate an orchestration call, and a service token must not reach a dashboard route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from '../app/node_modules/express/index.js';

import { createOrchestratorRouter } from '../app/orchestrator/api.js';
import { loadOrchestratorConfig } from '../app/orchestrator/config.js';
import { JournalStore } from '../app/orchestrator/store/journal.js';
import { OrchestratorRepository } from '../app/orchestrator/store/repo.js';
import { FakeCodingBackend } from '../app/orchestrator/runner/fake.js';
import { isSafeProjectId, assertSafeProjectId, resolveWorkspacePath } from '../app/orchestrator/projects.js';
import { ApiError } from '../app/orchestrator/errors.js';

const INSTANCE = 'wb-test-01';
const ORCH = 'orch-test';
const SECRET = 'test-service-token-aaaaaaaaaaaaaaaaaaaa';
const OTHER_SECRET = 'other-service-token-bbbbbbbbbbbbbbbbbbb';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Boot a bare express app carrying only the orchestration router, on an ephemeral port. */
async function withApi(fn, { tokens, projects, envOverrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-api-'));
  const tokensPath = path.join(dir, 'tokens.json');
  const projectsPath = path.join(dir, 'orchestrator-projects.json');

  fs.writeFileSync(tokensPath, JSON.stringify({
    schema_version: '1.0',
    tokens: tokens ?? [{
      token_id: 'primary',
      orchestrator_instance_id: ORCH,
      secret_sha256: sha256(SECRET),
      projects: ['Demo'],
      scopes: ['jobs:read', 'jobs:write', 'session:manage', 'publish'],
    }],
  }));
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: projects ?? {
      Demo: {
        display_name: 'Demo project',
        capabilities: ['implementation', 'targeted_tests', 'full_test_suite', 'independent_review', 'publication'],
        verification_commands: ['npm test'],
        default_branch: 'main',
        has_ci: true,
      },
    },
  }));

  const config = loadOrchestratorConfig({
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, 'data'),
    PW_ORCHESTRATOR_TOKENS_PATH: tokensPath,
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_ORCHESTRATOR_MAX_BODY_BYTES: '4096',
    ...envOverrides,
  });
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(config.workspaceRoot, 'Demo'), { recursive: true });

  const store = await JournalStore.open({
    journalPath: config.journalPath,
    snapshotPath: config.snapshotPath,
    lockPath: config.lockPath,
    compactEveryRecords: config.compactEveryRecords,
  });
  const repo = new OrchestratorRepository(store);
  const router = createOrchestratorRouter({
    config, store, repo, backend: new FakeCodingBackend(), workbenchVersion: 'test',
  });

  const app = express();
  app.use(config.basePath, router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}${config.basePath}`;

  const call = async (method, pathname, { body, token = SECRET, headers = {}, raw } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = raw ?? JSON.stringify(body);
    }
    const res = await fetch(base + pathname, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  try {
    await fn({ call, base, config, store, repo });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

test('api: a request with no credential is refused with the contract envelope', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects', { token: null });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'unauthenticated');
    assert.equal(res.json.schema_version, '1.0');
    // Nothing about the expected credential may be disclosed.
    assert.ok(!res.text.includes('sha256'));
    assert.ok(!res.text.toLowerCase().includes('token_id'));
  });
});

test('api: a wrong, malformed, or disabled credential is refused identically', async () => {
  await withApi(async ({ call }) => {
    for (const token of [OTHER_SECRET, 'not-a-token', '', `${SECRET}x`, SECRET.slice(0, -1)]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call('GET', '/projects', { token: token || null });
      assert.equal(res.status, 401, `token ${JSON.stringify(token)} must not authenticate`);
      assert.equal(res.json.error, 'unauthenticated');
    }
    // A non-Bearer scheme is not accepted either.
    const basic = await call('GET', '/projects', { token: null, headers: { Authorization: `Basic ${Buffer.from(SECRET).toString('base64')}` } });
    assert.equal(basic.status, 401);
  });
});

test('api: a disabled token stops working without needing to be deleted (rotation support)', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects');
    assert.equal(res.status, 401);
  }, {
    tokens: [{
      token_id: 'retired', orchestrator_instance_id: ORCH, secret_sha256: sha256(SECRET),
      projects: ['Demo'], scopes: ['jobs:read'], disabled: true,
    }],
  });
});

test('api: two live tokens are accepted at once, so a rotation has no outage window', async () => {
  await withApi(async ({ call }) => {
    for (const token of [SECRET, OTHER_SECRET]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call('GET', '/projects', { token });
      assert.equal(res.status, 200, 'both the outgoing and incoming token must work during a rotation');
    }
  }, {
    tokens: [
      { token_id: 'old', orchestrator_instance_id: ORCH, secret_sha256: sha256(SECRET), projects: ['Demo'], scopes: ['jobs:read'] },
      { token_id: 'new', orchestrator_instance_id: ORCH, secret_sha256: sha256(OTHER_SECRET), projects: ['Demo'], scopes: ['jobs:read'] },
    ],
  });
});

test('api: a token lacking the operation scope is refused with forbidden_scope', async () => {
  await withApi(async ({ call }) => {
    const readable = await call('GET', '/projects');
    assert.equal(readable.status, 200);

    const res = await call('POST', '/projects/Demo/session/ensure', {
      body: { orchestrator_instance_id: ORCH, project_id: 'Demo' },
      headers: { 'Idempotency-Key': 'k1' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden_scope');
  }, {
    tokens: [{
      token_id: 'read-only', orchestrator_instance_id: ORCH, secret_sha256: sha256(SECRET),
      projects: ['Demo'], scopes: ['jobs:read'],
    }],
  });
});

test('api: the fingerprint endpoint is authenticated, read-only, and carries no secret', async () => {
  // The counterpart to `scripts/pw-orch-fingerprint.mjs`, for an administrator who is not on this
  // host. Authenticated because it names an internal binary path and the instance's own identity;
  // read-only because pinning is the orchestrator's decision, never something this side pushes.
  const { FINGERPRINT_REPORT_FIELDS } = await import('../app/orchestrator/bootstrap.js');

  await withApi(async ({ call }) => {
    const anonymous = await call('GET', '/instance/attestation-fingerprint', { token: 'wrong-secret' });
    assert.equal(anonymous.status, 401, 'the report must not be readable without a credential');

    const res = await call('GET', '/instance/attestation-fingerprint');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(Object.keys(res.json).sort(), [...FINGERPRINT_REPORT_FIELDS].sort());

    // Nothing that should not travel. The report is pasted into tickets and stored in another
    // host's registry, so this asserts the absence directly rather than trusting the allowlist.
    const serialised = JSON.stringify(res.json);
    for (const secret of ['sk-ant', 'Bearer', 'access_token', 'refresh_token', SECRET]) {
      assert.ok(!serialised.includes(secret), `the report leaked ${secret}`);
    }

    // Writing is not offered: pinning is the orchestrator's decision.
    const write = await call('POST', '/instance/attestation-fingerprint', {
      body: {}, headers: { 'Idempotency-Key': 'fp-1' },
    });
    assert.equal(write.status, 404);
  });
});

test('api: a body that fails schema validation is a typed refusal, not an internal error', async () => {
  // Found by the nonce requirement below, and much wider than it: `validate()` throws its own
  // `ValidationError`, which `sendError` did not recognise — so EVERY route that validates a body
  // answered a malformed payload with 500 `internal_error`, no field errors, and the explanation
  // swallowed as potentially sensitive. A caller could not tell a bad request from a broken server,
  // and the contract's `validation_failed` envelope was unreachable from the one place it is for.
  const { validate } = await import('../app/orchestrator/validate.js');
  const { ApiError, errorEnvelope, statusForCode } = await import('../app/orchestrator/errors.js');
  let thrown = null;
  try {
    validate({ name: 'Probe', fields: { needed: { type: 'shortText', required: true } } }, {});
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a missing required field must throw');
  assert.ok(thrown instanceof ApiError, 'a schema failure must be a typed API error, not a bare Error');
  assert.equal(statusForCode(thrown.code), 400);
  const envelope = errorEnvelope(thrown, 'corr-1');
  assert.equal(envelope.error, 'validation_failed');
  assert.deepEqual(envelope.field_errors.map((f) => f.field), ['needed']);
});

test('api: a verification that carries no nonce is refused rather than answered unbound', async () => {
  // The contract dropped the default: every other security-relevant default on this surface
  // refuses, and a fixed, publicly-known nonce would be the one that does not. Defaulting here
  // meant a peer that simply omitted the field got a well-formed answer back — one that stayed
  // valid across every later verification of the same job, including after the lane had been
  // relaunched with different flags.
  await withApi(async ({ call }) => {
    const res = await call('POST', '/projects/Demo/session/verify', {
      body: {
        session_key: `${ORCH}:wb-test-01:Demo:pvi2-orchestrator`,
        phase_class: 'implementation',
        requested: { model_alias: 'sonnet', effort: 'high' },
        run_id: 'job_1:implementation',
        config_generation: 3,
      },
      headers: { 'Idempotency-Key': 'verify-1' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'validation_failed');
    assert.ok(
      res.json.field_errors?.some((e) => e.field === 'verification_nonce'),
      `the refusal must name the missing field: ${JSON.stringify(res.json)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// scoping: instance and project
// ---------------------------------------------------------------------------

test('api: a payload claiming a different orchestrator instance than the token is refused', async () => {
  await withApi(async ({ call }) => {
    const res = await call('POST', '/projects/Demo/session/ensure', {
      body: { orchestrator_instance_id: 'someone-else', project_id: 'Demo' },
      headers: { 'Idempotency-Key': 'k1' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden_scope');
  });
});

test('api: a project the token was not granted is not found or not authorized, never served', async () => {
  await withApi(async ({ call }) => {
    const capabilities = await call('GET', '/projects/Secret/capabilities');
    assert.equal(capabilities.status, 403);
    assert.equal(capabilities.json.error, 'project_not_authorized');

    // The project listing must not disclose it either.
    const listed = await call('GET', '/projects');
    assert.deepEqual(listed.json.map((p) => p.project_id), ['Demo']);
  }, {
    projects: {
      Demo: { display_name: 'Demo', capabilities: ['implementation'] },
      Secret: { display_name: 'Secret', capabilities: ['implementation'] },
    },
  });
});

test('api: a project id that tries to traverse the workspace root is rejected as invalid', async () => {
  await withApi(async ({ call }) => {
    for (const bad of ['..', '../etc', 'a%2Fb', '.', 'a b']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call('GET', `/projects/${encodeURIComponent(bad)}/capabilities`);
      assert.ok([400, 403, 404].includes(res.status), `${bad} produced ${res.status}`);
      assert.ok(['validation_failed', 'project_not_authorized', 'not_found'].includes(res.json?.error), `${bad} -> ${res.json?.error}`);
      // Whatever the outcome, no filesystem detail may be reflected back.
      assert.ok(!res.text.includes('/tmp/'), 'a path must never appear in an error body');
    }
  });
});

test('api: an unconfigured project offers no capabilities — absent never means assume yes', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects/Demo/capabilities');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.capabilities, []);
    assert.equal(res.json.has_ci, false);
    assert.equal(res.json.default_branch, null);
  }, { projects: { Demo: { display_name: 'Demo' } } });
});

// ---------------------------------------------------------------------------
// discovery payloads
// ---------------------------------------------------------------------------

test('api: health reports the instance, the contract version, and backend auth without secrets', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.schema_version, '1.0');
    assert.equal(res.json.instance_id, INSTANCE);
    assert.equal(res.json.contract_version, '1.0');
    assert.equal(res.json.reachable, true);
    assert.ok(Array.isArray(res.json.backends) && res.json.backends.length >= 1);
    const backend = res.json.backends[0];
    assert.equal(backend.backend, 'claude-code');
    assert.ok(['ok', 'degraded', 'down'].includes(backend.state));
    // Subscription OAuth is the only representable method; an API key cannot even be expressed.
    assert.equal(backend.method, 'subscription_oauth');
    assert.ok(!JSON.stringify(res.json).toLowerCase().includes('api_key'));
    assert.ok(res.json.checked_at);
  });
});

test('api: capabilities describe what the lane can do, and the commands PW (not the caller) runs', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects/Demo/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.json.project_id, 'Demo');
    assert.equal(res.json.workbench_instance_id, INSTANCE);
    assert.ok(res.json.capabilities.includes('implementation'));
    assert.deepEqual(res.json.verification_commands, ['npm test']);
    assert.equal(res.json.default_branch, 'main');
    assert.equal(res.json.has_ci, true);
  });
});

test('api: the project list carries the owning instance on every entry', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects');
    assert.equal(res.status, 200);
    // §4 declares the response model as `list[Project]`, so the body is a bare array.
    assert.ok(Array.isArray(res.json), 'the contract declares list[Project], not an envelope');
    const [project] = res.json;
    assert.equal(project.workbench_instance_id, INSTANCE, 'an instance is configured, never inferred');
    assert.equal(project.project_id, 'Demo');
    assert.equal(project.authorized, true);
    assert.equal(project.default_backend, 'claude-code');
  });
});

// ---------------------------------------------------------------------------
// limits, correlation, and error hygiene
// ---------------------------------------------------------------------------

test('api: an oversized body is refused with payload_too_large rather than parsed', async () => {
  await withApi(async ({ call }) => {
    const res = await call('POST', '/jobs', { raw: JSON.stringify({ pad: 'x'.repeat(8_000) }) });
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'payload_too_large');
  });
});

test('api: malformed JSON is a clean validation failure, not a stack trace', async () => {
  await withApi(async ({ call }) => {
    const res = await call('POST', '/jobs', { raw: '{"task": ' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'validation_failed');
    assert.ok(!/at\s+\w+\s+\(/.test(res.text), 'no stack frame may appear in an error body');
    assert.ok(!res.text.includes('node_modules'));
  });
});

test('api: the correlation id is echoed so a caller can tie a refusal to its request', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects/Nope/capabilities', { headers: { 'X-Correlation-Id': 'corr-abc-1' } });
    assert.equal(res.json.correlation_id, 'corr-abc-1');
    assert.equal(res.headers.get('x-correlation-id'), 'corr-abc-1');

    // A hostile correlation id is bounded and sanitised rather than reflected.
    const hostile = await call('GET', '/projects/Nope/capabilities', { headers: { 'X-Correlation-Id': '<script>alert(1)</script>' } });
    assert.ok(!String(hostile.json.correlation_id ?? '').includes('<script>'));
  });
});

test('api: an unknown path under the base returns the contract 404, not an HTML page', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/nope/nowhere');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
    assert.ok(!res.text.includes('<html'));
  });
});

test('api: the rate limit refuses with 429 and a Retry-After rather than queueing', async () => {
  await withApi(async ({ call }) => {
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call('GET', '/projects');
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'the configured rate limit must eventually refuse');
    assert.equal(limited.json.error, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 0);
  }, { envOverrides: { PW_ORCHESTRATOR_RATE_LIMIT: '5' } });
});

test('api: safe methods do not require an idempotency key, mutations do', async () => {
  await withApi(async ({ call }) => {
    assert.equal((await call('GET', '/projects')).status, 200);
    const res = await call('POST', '/projects/Demo/session/ensure', {
      body: { orchestrator_instance_id: ORCH, project_id: 'Demo' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'validation_failed');
    assert.ok(res.json.field_errors.some((f) => /idempotency/i.test(f.field)));
  });
});

// ---------------------------------------------------------------------------
// path containment (exercised directly: the MCP adapter takes project_id as a typed
// argument, with none of the URL normalisation that hides these cases over HTTP)
// ---------------------------------------------------------------------------

test('projects: a project id that is a relative-path element is not a valid slug', () => {
  for (const bad of ['.', '..', 'a/b', 'a\\b', '', ' ', 'a b', '../..', 'x'.repeat(101)]) {
    assert.equal(isSafeProjectId(bad), false, `${JSON.stringify(bad)} must not be accepted`);
    assert.throws(() => assertSafeProjectId(bad), ApiError);
  }
  for (const good of ['Demo', 'PVHGateway', 'my.project-1', 'a_b']) {
    assert.equal(isSafeProjectId(good), true, `${good} should be accepted`);
  }
});

test('projects: a workspace that resolves outside the root is refused, symlinks included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-path-'));
  try {
    const root = path.join(dir, 'workspaces');
    const outside = path.join(dir, 'elsewhere');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(root, 'Demo'), { recursive: true });
    // A workspace entry that is a symlink pointing out of the root: lexically it looks contained,
    // which is exactly why the check resolves the real path instead of comparing strings.
    fs.symlinkSync(outside, path.join(root, 'Escaped'), 'dir');

    const config = { workspaceRoot: root };
    assert.equal(
      resolveWorkspacePath(config, { workspace_subdir: 'Demo' }),
      fs.realpathSync(path.join(root, 'Demo')),
    );
    assert.throws(
      () => resolveWorkspacePath(config, { workspace_subdir: 'Escaped' }),
      (err) => err instanceof ApiError && err.code === 'unsafe_path',
    );
    assert.throws(
      () => resolveWorkspacePath(config, { workspace_subdir: '../elsewhere' }),
      (err) => err instanceof ApiError && err.code === 'unsafe_path',
    );
    assert.throws(
      () => resolveWorkspacePath(config, { workspace_subdir: '/etc' }),
      (err) => err instanceof ApiError && err.code === 'unsafe_path',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// separation from the browser surface
// ---------------------------------------------------------------------------

test('api: a bearer call needs no Origin header — it is not a browser route', async () => {
  await withApi(async ({ call }) => {
    // The dashboard's CSRF gate exists because nginx Basic Auth is replayed by browsers on any
    // origin. A service token is never replayed that way, so requiring Origin here would only
    // break honest scripted clients without adding a control.
    const res = await call('POST', '/projects/Demo/session/ensure', {
      body: { orchestrator_instance_id: ORCH, project_id: 'Demo' },
      headers: { 'Idempotency-Key': 'k1' },
    });
    assert.notEqual(res.status, 403, 'no Origin/Referer gate may apply to the orchestration API');
  });
});

test('api: a dashboard session cookie cannot authenticate an orchestration call', async () => {
  await withApi(async ({ call }) => {
    const res = await call('GET', '/projects', {
      token: null,
      headers: { Cookie: 'pw_session=a-valid-looking-dashboard-session' },
    });
    assert.equal(res.status, 401, 'browser session state must never authorise the machine surface');
    assert.equal(res.json.error, 'unauthenticated');
  });
});
