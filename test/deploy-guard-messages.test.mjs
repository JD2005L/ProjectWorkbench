import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'scripts', 'pw-deploy-guard-messages.py');
const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('the pushed gate refuses deployment when the remote cannot be refreshed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deploy-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const workspace = path.join(dir, 'workspace');
  const config = path.join(dir, 'deploy-config.json');
  const marker = path.join(dir, 'published');

  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['clone', remote, workspace]);
  run(workspace, 'config', 'user.email', 'test@example.invalid');
  run(workspace, 'config', 'user.name', 'PW test');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'release\n');
  run(workspace, 'add', 'README.md');
  run(workspace, 'commit', '-m', 'release');
  run(workspace, 'branch', '-M', 'main');
  run(workspace, 'push', '-u', 'origin', 'main');
  run(workspace, 'remote', 'set-head', 'origin', 'main');

  fs.writeFileSync(config, JSON.stringify({ demo: { prod: {
    script: `WS=${JSON.stringify(workspace)}\nprintf published > ${JSON.stringify(marker)}`,
  } } }, null, 2));
  execFileSync('python3', [tool, 'add-gates', '--config', config, '--yes', '--only', 'pushed']);
  const script = JSON.parse(fs.readFileSync(config, 'utf8')).demo.prod.script;
  fs.renameSync(remote, `${remote}.offline`);

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /could not reach the remote/i);
  assert.equal(fs.existsSync(marker), false, 'the publish command must never run on stale remote state');
});
