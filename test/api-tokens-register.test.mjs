// The one machine-API assertion that genuinely needs a terminal: a correctly scoped token
// registering a real project, end to end.
//
// Split out from test/api-tokens-surface.test.mjs because it needs the full tmux fixture, which
// cannot start from inside a workbench pane (the owner-cgroup gate rejects a fixture-spawned
// server). The refusal paths and the Settings administration are asserted there, without tmux,
// so they stay runnable while writing the code; this file is the CI half.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withCockpit } from './cockpit-instance-fixture.mjs';

const SCOPE = 'projects:register';

test('a scoped token registers a project end to end', { timeout: 60000 }, async () => {
  await withCockpit(async ({ base }) => {
    const created = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ci-register', scopes: [SCOPE] }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, `token creation must succeed: ${JSON.stringify(created)}`);

    const name = 'tok' + crypto.randomBytes(3).toString('hex');
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({ name, port: String(21000 + crypto.randomInt(0, 8000)) }),
    });
    // One read: the template message would consume the body even on success, and the json() read
    // after it then throws "Body is unusable" — which is exactly how this test arrived broken.
    const body = await res.text();
    assert.equal(res.status, 200, `a scoped token must register a project: ${body}`);
    assert.equal(JSON.parse(body).ok, true);

    // It must really be in the registry, not merely accepted.
    const status = await fetch(`${base}/api/projects/status`).then((r) => r.json());
    assert.ok(status.projects.some((p) => p.name === name), 'the project must appear in the registry');
  });
});

test('the project a token registers is attributable to that token in the audit log', { timeout: 60000 }, async () => {
  // A machine call has no req.user, so without the apiToken fallback in audit() the project_add
  // entry would record user:null -- an anonymous actor for a privileged, credentialed action.
  await withCockpit(async ({ base, dir }) => {
    const created = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'audit-probe', scopes: [SCOPE] }),
    }).then((r) => r.json());
    assert.equal(created.ok, true);

    const name = 'aud' + crypto.randomBytes(3).toString('hex');
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({ name, port: String(22000 + crypto.randomInt(0, 8000)) }),
    });
    // Read once, for the same reason as above: an assertion's message argument is evaluated
    // eagerly, so a body-consuming await in it spends the body even when the assertion passes.
    const registerBody = await res.text();
    assert.equal(res.status, 200, registerBody);

    // The fixture isolates PW_AUDIT_LOG into its temp dir and exposes it, so this asserts for
    // real rather than skipping when the path is not writable.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const local = path.join(dir, 'audit.log');
    assert.ok(fs.existsSync(local), 'the isolated audit log must exist');
    const entries = fs.readFileSync(local, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const add = entries.find((e) => e.event === 'project_add' && e.project === name);
    assert.ok(add, 'the registration must be audited');
    assert.equal(add.apiTokenId, created.record.id, 'attributed to the token that did it');
    assert.equal(add.role, 'service-token');
    assert.equal(add.hasPreview, false, 'whether the project has a preview is audited, as a boolean');
  });
});

// The /newpackage path: one call, with only a projects:register token, must leave a project whose
// Preview pane works -- the block stored, nginx routing /preview/<name>/, nothing auto-started.
// The refusals are asserted without tmux in test/project-add-preview.test.mjs.
test('a scoped token registers a project with a preview in one call', { timeout: 90000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-reg-nginx-'));
  const nginxConf = path.join(tmp, 'nginx.conf');
  try {
    await withCockpit(async ({ base, dir }) => {
      const created = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'preview-register', scopes: [SCOPE] }),
      }).then((r) => r.json());
      assert.equal(created.ok, true, `token creation must succeed: ${JSON.stringify(created)}`);
      const register = async (fields) => {
        const res = await fetch(`${base}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${created.token}` },
          body: JSON.stringify(fields),
        });
        const text = await res.text();
        assert.equal(res.status, 200, text);
        return JSON.parse(text);
      };
      const config = async (name) => (await fetch(`${base}/api/projects/config`).then((r) => r.json()))
        .projects.find((p) => p.name === name);
      const termPort = () => 23000 + crypto.randomInt(0, 6000);

      // 1. A command alone: the port is allocated, and the response says which.
      const auto = 'pva' + crypto.randomBytes(3).toString('hex');
      const autoBody = await register({ name: auto, port: String(termPort()), previewCmd: 'npm run dev -- --port ${PORT}' });
      assert.equal(autoBody.ok, true);
      assert.equal(autoBody.name, auto);
      assert.ok(Number.isInteger(autoBody.preview?.port) && autoBody.preview.port >= 7790,
        `an allocated preview port must be reported: ${JSON.stringify(autoBody)}`);
      const autoCfg = await config(auto);
      assert.deepEqual(autoCfg.preview, { cmd: 'npm run dev -- --port ${PORT}', port: autoBody.preview.port, env: {} });
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).find((p) => p.name === auto);
      assert.deepEqual(raw.preview, { cmd: 'npm run dev -- --port ${PORT}', port: autoBody.preview.port },
        'stored as { cmd, port } with no empty env');

      // nginx was regenerated with the new project's preview route.
      const conf = fs.readFileSync(nginxConf, 'utf8');
      assert.match(conf, new RegExp(`location /preview/${auto}/ \\{[\\s\\S]*?proxy_pass http://127\\.0\\.0\\.1:${autoBody.preview.port}/;`),
        'the new project must be routed at /preview/<name>/');

      // Registered, not started: the operator presses Start in the pane.
      const status = await fetch(`${base}/api/preview/${encodeURIComponent(auto)}/status`).then((r) => r.json());
      assert.equal(status.configured, true);
      assert.equal(status.active, false, 'registration must not auto-start the preview');

      // 2. An explicit port and env, sent as a JSON number and a multi-line string.
      const explicit = 'pve' + crypto.randomBytes(3).toString('hex');
      const previewPort = 30000 + crypto.randomInt(0, 5000);
      const explicitBody = await register({ name: explicit, port: String(termPort()), previewCmd: 'hugo server',
        previewPort, previewEnv: '# comment\nHUGO_ENV=dev\nGREETING=a=b' });
      assert.deepEqual(explicitBody.preview, { port: previewPort });
      assert.deepEqual((await config(explicit)).preview, { cmd: 'hugo server', port: previewPort, env: { HUGO_ENV: 'dev', GREETING: 'a=b' } });

      // 3. No command: no preview stored, and the response still carries the key.
      const none = 'pvn' + crypto.randomBytes(3).toString('hex');
      const noneBody = await register({ name: none, port: String(termPort()), previewPort: 31999, previewEnv: 'A=1' });
      assert.ok('preview' in noneBody, 'an updated workbench always answers with a preview key');
      assert.equal(noneBody.preview, null);
      assert.equal((await config(none)).preview, null);
      const noneRaw = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')).find((p) => p.name === none);
      assert.ok(!('preview' in noneRaw), 'no preview key may be stored without a command');

      // Audited as a boolean only -- never the command or the env.
      const entries = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const audited = (name) => entries.find((e) => e.event === 'project_add' && e.project === name);
      assert.equal(audited(auto).hasPreview, true);
      assert.equal(audited(explicit).hasPreview, true);
      assert.equal(audited(none).hasPreview, false);
      const log = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
      assert.doesNotMatch(log, /hugo server|HUGO_ENV|npm run dev/, 'the audit log must not carry preview values');
    }, { env: { PW_NGINX_CONF: nginxConf, PW_NGINX_TEST_CMD: 'true', PW_NGINX_RELOAD_CMD: 'true' } });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
