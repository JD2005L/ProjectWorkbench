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
  });
});
