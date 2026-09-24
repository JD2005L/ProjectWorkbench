// Reading project source for the agent API (docs/agent-mcp.md).
//
// The path comes from a CALLER here, not from a fixed box name, so confinement is
// the whole job. Three controls, tested in the order they matter: the request
// cannot describe an escape, a resolved symlink cannot leave the tree, and the
// credential deny-list catches the obvious — while the real protection remains
// that a token only reaches projects its acting user reaches and every read is
// audited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWorkspacePath, isDeniedWorkspacePath, resolveInsideWorkspace,
  applyWorkspaceRead, applyWorkspaceTree, WorkspacePathError,
  WORKSPACE_READ_MAX_BYTES, WORKSPACE_TREE_MAX_ENTRIES,
} from '../app/workspace-file.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'server.js'), 'export const hello = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2\n');
  fs.writeFileSync(path.join(root, '.git', '.pw-credentials'), 'https://x:token@github.com\n');
  fs.writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0\n');
  return { root, outside };
}

const refuses = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error instanceof WorkspacePathError, `expected a WorkspacePathError, got ${error}`);
  assert.equal(error.code, code, error.message);
};

test('a request cannot describe an escape, so a traversal never reaches the filesystem', () => {
  assert.equal(normalizeWorkspacePath('app/server.js'), 'app/server.js');
  assert.equal(normalizeWorkspacePath('./app//server.js'), 'app/server.js');
  assert.equal(normalizeWorkspacePath(''), '');
  assert.equal(normalizeWorkspacePath('.'), '');
  for (const bad of ['/etc/passwd', '../secrets', 'app/../../etc/passwd', 'C:\\windows', 'app/\0x']) {
    assert.throws(() => normalizeWorkspacePath(bad), WorkspacePathError, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeWorkspacePath('a/'.repeat(300)), /too long/);
});

test('credential-shaped paths are denied by name', () => {
  for (const denied of ['.env', '.env.production', '.git/.pw-credentials', '.git-credentials', '.netrc',
    '.npmrc', 'deploy/id_rsa', 'certs/site.pem', 'app/.claude/settings.json', '.ssh/config', 'x.key']) {
    assert.equal(isDeniedWorkspacePath(denied), true, `${denied} must be denied`);
  }
  for (const fine of ['app/server.js', 'README.md', 'docs/env-notes.md', 'src/keyboard.ts', 'test/keys.test.mjs']) {
    assert.equal(isDeniedWorkspacePath(fine), false, `${fine} must be readable`);
  }
});

test('a symlink that leaves the tree is refused, which is the control a deny-list cannot provide', async (t) => {
  const { root, outside } = workspace(t);
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(root, 'escape.txt'));
  fs.symlinkSync(outside, path.join(root, 'escape-dir'));
  fs.symlinkSync(path.join(root, 'app', 'server.js'), path.join(root, 'inside-link.js'));

  await refuses(resolveInsideWorkspace({ fsp, path, projectPath: root, relative: 'escape.txt' }), 'workspace_path_escape');
  await refuses(applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'escape.txt' }), 'workspace_path_escape');
  await refuses(applyWorkspaceTree({ fsp, path, projectPath: root, relative: 'escape-dir' }), 'workspace_path_escape');

  // A link that stays inside is fine: confinement is about where it lands.
  const inside = await applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'inside-link.js' });
  assert.match(inside.text, /export const hello/);
});

test('reading a file is capped, and a binary says what it is instead of shipping half of itself', async (t) => {
  const { root } = workspace(t);
  const out = await applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'app/server.js' });
  assert.deepEqual([out.path, out.binary, out.truncated], ['app/server.js', false, false]);
  assert.match(out.text, /export const hello = 1;/);

  fs.writeFileSync(path.join(root, 'big.txt'), 'y'.repeat(4096));
  const capped = await applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'big.txt', maxBytes: 100 });
  assert.equal(capped.text.length, 100);
  assert.equal(capped.truncated, true);
  assert.equal(capped.size, 4096, 'the real size is reported even when the read is not');
  assert.ok(WORKSPACE_READ_MAX_BYTES >= 64 * 1024, 'the shipped cap is a real one');

  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
  const binary = await applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'blob.bin' });
  assert.deepEqual([binary.binary, binary.text], [true, '']);

  await refuses(applyWorkspaceRead({ fsp, path, projectPath: root, relative: '.env' }), 'workspace_path_denied');
  await refuses(applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'app' }), 'workspace_path_is_dir');
  await refuses(applyWorkspaceRead({ fsp, path, projectPath: root, relative: 'nope.txt' }), 'workspace_path_missing');
});

test('listing shows what is there, marks what it will not read, and is bounded', async (t) => {
  const { root } = workspace(t);
  const listed = await applyWorkspaceTree({ fsp, path, projectPath: root, relative: '' });
  const byName = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
  assert.equal(byName['README.md'].type, 'file');
  assert.equal(byName['README.md'].size, 7);
  assert.equal(byName.app.type, 'dir');
  // Present but flagged: hiding it would invite a caller to keep guessing at it.
  assert.equal(byName['.env'].denied, true);
  assert.equal(byName['.env'].size, undefined, 'a denied entry gives up no detail, not even its size');
  assert.equal(byName['.git'].denied, undefined, 'the directory itself is visible; its credential file is not');
  await refuses(applyWorkspaceRead({ fsp, path, projectPath: root, relative: '.git/.pw-credentials' }), 'workspace_path_denied');

  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
  const bounded = await applyWorkspaceTree({ fsp, path, projectPath: root, relative: '', maxEntries: 5 });
  assert.equal(bounded.entries.length, 5);
  assert.equal(bounded.truncated, true);
  assert.ok(WORKSPACE_TREE_MAX_ENTRIES >= 100);
  await refuses(applyWorkspaceTree({ fsp, path, projectPath: root, relative: 'README.md' }), 'workspace_path_not_dir');
});
