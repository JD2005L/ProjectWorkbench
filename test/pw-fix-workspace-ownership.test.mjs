// Safety contract for scripts/pw-fix-workspace-ownership.
//
// The Deploy Centre now calls this after every runAsRoot deploy (server.js
// reclaimWorkspaceOwnership) to heal root-owned drift a root deploy leaves in a
// workspace — the recurring "VisualIdentity publish committed as root, now admin
// cannot commit" problem. That auto-repair is only safe because the tool: scopes to
// the ONE named project, PRUNES _inbox/_outbox and canonical, and is a clean no-op
// when there is nothing to fix (so re-running it on every deploy costs nothing and
// can never surprise anyone). Those are the properties pinned here.
//
// The chown itself needs root (chowning to another user), so these run the DRY RUN,
// which needs no privilege and reports exactly what --apply would touch. That is the
// classification logic; the privileged step is a straight fchown of the same set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pw-fix-workspace-ownership');

function scratchWorkspaces() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ws-own-'));
  const mk = (rel, body = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  return { root, mk };
}

const run = (args, root) =>
  execFileAsync(TOOL, args, { env: { ...process.env, PW_WORKSPACES: root, PW_TERMINAL_USER: process.env.USER || 'admin' } })
    .then((r) => ({ code: 0, out: r.stdout + r.stderr }))
    .catch((e) => ({ code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') }));

test('a clean workspace is a no-op (so re-running after every deploy is free)', async () => {
  const { root, mk } = scratchWorkspaces();
  try {
    mk('VisualIdentity/src/publish.js');
    mk('VisualIdentity/.git/index');
    const { code, out } = await run(['VisualIdentity'], root);
    assert.equal(code, 0, out);
    assert.match(out, /root-owned: 0/, 'nothing is root-owned here, so nothing is fixable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a named project scopes the walk to just that project', async () => {
  const { root, mk } = scratchWorkspaces();
  try {
    mk('VisualIdentity/styles.css');
    mk('Bi-Tools/app.cs');
    const { out } = await run(['VisualIdentity'], root);
    assert.match(out, /VisualIdentity/);
    assert.doesNotMatch(out, /Bi-Tools/, 'an unrelated project must not be walked when one is named');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical is never walked when scanning all projects (it is the live app, not drift)', async () => {
  const { root, mk } = scratchWorkspaces();
  try {
    mk('canonical/app/server.js');
    mk('VisualIdentity/styles.css');
    const { out } = await run([], root); // no project arg => every project except canonical
    assert.match(out, /VisualIdentity/);
    assert.doesNotMatch(out, /canonical/, 'canonical is pruned from the project list, never walked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('naming canonical explicitly is refused with a boundary message', async () => {
  const { root, mk } = scratchWorkspaces();
  try {
    mk('canonical/app/server.js');
    const { out } = await run(['canonical'], root);
    assert.match(out, /canonical: SKIPPED/, 'canonical must be refused as a boundary, never chowned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the tool exists at the sibling path server.js resolves', () => {
  // reclaimWorkspaceOwnership() builds exactly this path (app/ -> ../scripts). If the
  // tool is renamed or moved, the auto-repair silently no-ops; fail loudly here instead.
  assert.ok(fs.existsSync(TOOL), `expected the ownership tool at ${TOOL}`);
  assert.ok((fs.statSync(TOOL).mode & 0o111) !== 0, 'the tool must be executable');
});
