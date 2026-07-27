// Increment 12 — an end-to-end smoke over the real process boundaries.
//
// Everything else in the orchestration suite exercises modules in-process. This file boots the
// actual `app/server.js` on an alternate port and runs the actual stdio MCP adapter as a child
// process, both with synthetic credentials and throwaway paths, because a subsystem that works when
// imported can still fail to *mount* — wrong middleware order, a bad top-level await, a path that
// only resolves under the test runner's cwd.
//
// It also asserts the two things an operator cares about most: that the subsystem is genuinely
// inert when disabled, and that teardown leaves no listener, process, or file behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));
const mcpBin = fileURLToPath(new URL('../bin/pw-orchestrator-mcp.mjs', import.meta.url));
const appDir = path.dirname(serverJs);

const INSTANCE = 'wb-smoke-01';
const ORCH = 'orch-smoke';
// Synthetic throughout: this token exists only inside the temp directory this test creates.
const TOKEN = 'smoke-synthetic-token-000000000000000000';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A disposable instance: temp registry, users, sessions, workspaces, and orchestrator state. */
function makeInstance(port, { orchestrator = true, dataDirSuffix = 'orch' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-orch-smoke-'));
  fs.mkdirSync(path.join(dir, 'workspaces', 'Demo'), { recursive: true });

  const tokensPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokensPath, JSON.stringify({
    schema_version: '1.0',
    tokens: [{
      token_id: 'smoke', orchestrator_instance_id: ORCH, secret_sha256: sha256(TOKEN),
      projects: ['Demo'], scopes: ['jobs:read', 'jobs:write', 'session:manage', 'publish'],
    }],
  }));

  const projectsPath = path.join(dir, 'orchestrator-projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify({
    schema_version: '1.0',
    projects: { Demo: { display_name: 'Demo', capabilities: ['implementation'], verification_commands: ['true'] } },
  }));

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    // The existing isolation switch: no host tmux, ttyd, nginx or systemd side effects.
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
  };
  const orchestratorEnv = {
    PW_ORCHESTRATOR_ENABLED: 'true',
    PW_ORCHESTRATOR_INSTANCE_ID: INSTANCE,
    PW_ORCHESTRATOR_DATA_DIR: path.join(dir, dataDirSuffix),
    PW_ORCHESTRATOR_TOKENS_PATH: tokensPath,
    PW_ORCHESTRATOR_PROJECTS_PATH: projectsPath,
    PW_ORCHESTRATOR_AUDIT_LOG: path.join(dir, 'orch-audit.log'),
  };
  return {
    dir, tokensPath, projectsPath,
    env: orchestrator ? { ...env, ...orchestratorEnv } : env,
    orchestratorEnv: { ...env, ...orchestratorEnv },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withServer(inst, port, fn) {
  const logs = [];
  const child = spawn(process.execPath, [serverJs], { cwd: appDir, env: inst.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`${base}/healthz`)).status === 200; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
    assert.ok(up, `server did not come up on :${port}\n--- logs ---\n${logs.join('')}`);
    await fn(base, logs);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

const call = (base, pathname, { token = TOKEN, method = 'GET', body, headers = {} } = {}) => {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}/api/orchestrator/v1${pathname}`, init)
    .then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
};

// ---------------------------------------------------------------------------

test('smoke: with the orchestrator disabled the subsystem is completely inert', { timeout: 40_000 }, async () => {
  const port = 3971;
  const inst = makeInstance(port, { orchestrator: false });
  try {
    await withServer(inst, port, async (base) => {
      // The dashboard is entirely unaffected.
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal((await fetch(`${base}/login`)).status, 200);

      // And the orchestration surface simply is not there.
      const res = await fetch(`${base}/api/orchestrator/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 404, 'a disabled subsystem must not answer on its base path');
    });
    // No durable state may have been created: no journal, no lock, no snapshot, no artifacts.
    for (const leftover of ['orch', 'orch-audit.log']) {
      assert.equal(fs.existsSync(path.join(inst.dir, leftover)), false, `${leftover} must not exist when disabled`);
    }
  } finally {
    inst.cleanup();
  }
});

test('smoke: the mounted HTTP surface authenticates, discovers, and refuses correctly', { timeout: 40_000 }, async () => {
  const port = 3972;
  const inst = makeInstance(port);
  try {
    await withServer(inst, port, async (base) => {
      // Unauthenticated.
      const anonymous = await call(base, '/projects', { token: null });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.json.error, 'unauthenticated');

      // Health, through the real mount.
      const health = await call(base, '/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.instance_id, INSTANCE);
      assert.equal(health.json.contract_version, '1.0');
      assert.equal(health.json.backends[0].backend, 'claude-code');
      // No account address, org id, or token may appear anywhere in a health payload.
      const healthBlob = JSON.stringify(health.json);
      assert.ok(!healthBlob.includes('@'), 'no address may appear in health');
      assert.ok(!healthBlob.includes(TOKEN));

      // Readiness reports components without secrets.
      const readiness = await call(base, '/readiness');
      assert.equal(readiness.status, 200);
      assert.deepEqual(
        readiness.json.components.map((c) => c.component).sort(),
        ['attestation', 'queue', 'runner', 'store'],
      );
      // The attestation capability is published so an orchestrator can see the KIND of evidence
      // this instance produces before submitting work that might only block.
      assert.equal(readiness.json.attestation.model, 'runtime_reported');
      assert.ok(['launch_enforced', 'unavailable'].includes(readiness.json.attestation.effort));
      assert.equal(readiness.json.attestation.contract_version, '1.0');
      // The binary identity travels with it, and no credential does.
      const blob = JSON.stringify(readiness.json.attestation);
      assert.ok(!blob.includes(TOKEN));
      assert.ok(!/sk-ant|ghp_|Bearer /.test(blob));
      assert.ok(!JSON.stringify(readiness.json).includes(TOKEN));

      // Discovery.
      const projects = await call(base, '/projects');
      assert.deepEqual(projects.json.map((p) => p.project_id), ['Demo']);
      const capabilities = await call(base, '/projects/Demo/capabilities');
      assert.deepEqual(capabilities.json.capabilities, ['implementation']);

      // An ungranted project is refused.
      assert.equal((await call(base, '/projects/Other/capabilities')).status, 403);

      // A mutation without an idempotency key is refused.
      const noKey = await call(base, '/jobs', { method: 'POST', body: {} });
      assert.equal(noKey.status, 400);

      // The dashboard's own routes still behave. The guard only engages for traffic that arrived
      // through nginx — a direct loopback request is "trusted local" and is deliberately exempt —
      // so the forwarding headers have to be present for this to test anything.
      const viaProxy = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.5', 'X-Real-IP': '10.0.0.5' };
      const foreignOrigin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { ...viaProxy, Origin: 'http://attacker.example' },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      });
      assert.equal(foreignOrigin.status, 403, 'the dashboard CSRF guard must still reject a foreign origin');

      // And the orchestration surface is deliberately NOT subject to it: a bearer credential is not
      // replayed by a browser on a foreign origin, so the gate would only break honest clients.
      const orchestrationViaProxy = await fetch(`${base}/api/orchestrator/v1/projects`, {
        headers: { ...viaProxy, Origin: 'http://attacker.example', Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(orchestrationViaProxy.status, 200);
    });
  } finally {
    inst.cleanup();
  }
});

test('smoke: the stdio MCP adapter speaks the protocol and exposes only the closed tool set', { timeout: 40_000 }, async () => {
  // Its own data directory: the HTTP surface and the stdio adapter both take the single-writer
  // store lock, so sharing one would (correctly) refuse to start.
  const inst = makeInstance(3973, { dataDirSuffix: 'mcp-orch' });
  try {
    const child = spawn(process.execPath, [mcpBin], {
      cwd: appDir,
      env: { ...inst.orchestratorEnv, PW_ORCHESTRATOR_SERVICE_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(String(d)));
    const responses = [];
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += String(d);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) responses.push(JSON.parse(line));
        index = buffer.indexOf('\n');
      }
    });

    const send = async (message) => {
      const before = responses.length;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      for (let i = 0; i < 200 && responses.length === before; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(responses.length > before, `no response to ${message.method}\n--- stderr ---\n${stderr.join('')}`);
      return responses[responses.length - 1];
    };

    try {
      const initialized = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      assert.equal(initialized.result.serverInfo.name, 'project-workbench-orchestrator');
      // Sampling must not be advertised, over any transport.
      assert.deepEqual(Object.keys(initialized.result.capabilities), ['tools']);

      const tools = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const names = tools.result.tools.map((t) => t.name);
      assert.ok(names.includes('pw_health'));
      assert.ok(names.includes('pw_publish'));
      for (const forbidden of ['pw_run_shell', 'pw_read_file', 'pw_list_directory']) {
        assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
      }

      const called = await send({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'pw_list_projects', arguments: {} },
      });
      const payload = JSON.parse(called.result.content[0].text);
      assert.deepEqual(payload.map((p) => p.project_id), ['Demo']);

      const refused = await send({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'pw_run_shell', arguments: { cmd: 'id' } },
      });
      assert.ok(refused.error, 'an unknown tool must be refused');
      assert.equal(refused.error.data.error, 'not_found');

      // The credential never appears in the adapter's own diagnostics.
      assert.ok(!stderr.join('').includes(TOKEN));
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    inst.cleanup();
  }
});

test('smoke: a misconfigured orchestrator does not take the dashboard down with it', { timeout: 40_000 }, async () => {
  const port = 3974;
  const inst = makeInstance(port);
  // Enabled but with no instance id: the subsystem must refuse to start, and say so.
  delete inst.env.PW_ORCHESTRATOR_INSTANCE_ID;
  try {
    await withServer(inst, port, async (base, logs) => {
      assert.equal((await fetch(`${base}/healthz`)).status, 200, 'the dashboard must still serve');
      assert.equal((await fetch(`${base}/login`)).status, 200);
      const res = await fetch(`${base}/api/orchestrator/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 404, 'the orchestration surface must be absent, not half-mounted');
      assert.match(logs.join(''), /orchestrator.*disabled/i, 'the operator must be told why');
    });
  } finally {
    inst.cleanup();
  }
});

test('smoke: teardown leaves no listener, no process, and no temp directory behind', { timeout: 40_000 }, async () => {
  const port = 3975;
  const inst = makeInstance(port);
  let dir;
  try {
    dir = inst.dir;
    await withServer(inst, port, async (base) => {
      assert.equal((await call(base, '/health')).status, 200);
    });
    // The port must be free again — a listener surviving the test would leak into the next one.
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'the port must be released');
  } finally {
    inst.cleanup();
  }
  assert.equal(fs.existsSync(dir), false, 'the temp directory must be gone');
});
