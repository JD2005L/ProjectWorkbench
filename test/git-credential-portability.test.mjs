// The credential boundary is shared product code: the same frozen source has to
// verify and run in every environment. Environment-specific paths, identities and
// mechanics belong in validated configuration or adapters — never in the product
// logic, and never as an unchecked assumption about the host.
//
// This file pins that property down so a future change cannot quietly reintroduce
// a fork.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  planGitCredentialTarget,
  nodeJobDeps,
  openPinnedGitDir,
  resolveProcfsPath,
  DEFAULT_PROCFS_PATH,
} from '../app/git-credentials.js';

const NEW_SOURCES = ['git-credentials.js', 'credential-domain-lock.js']
  .map((f) => fileURLToPath(new URL(`../app/${f}`, import.meta.url)));

test('the descriptor-pinning mechanism is configurable rather than hard-coded', () => {
  assert.equal(DEFAULT_PROCFS_PATH, '/proc');
  assert.equal(resolveProcfsPath({}), '/proc');
  assert.equal(resolveProcfsPath({ PW_PROCFS_PATH: '/alt/proc' }), '/alt/proc');
});

test('an unusable procfs is refused with an actionable, environment-neutral diagnostic', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-port-')));
  const projectPath = path.join(root, 'demo');
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', projectPath]);
  const plan = planGitCredentialTarget({ workspaceRoot: root, projectPath, registeredPaths: [projectPath] });

  const before = process.cwd();
  try {
    await assert.rejects(
      openPinnedGitDir({
        deps: nodeJobDeps(),
        rootAbs: plan.rootAbs,
        components: plan.components,
        expectedUid: process.getuid(),
        procfs: path.join(root, 'not-a-procfs'),
      }),
      /PW_PROCFS_PATH/,
      'the refusal must name the setting an operator can correct',
    );
  } finally {
    process.chdir(before);
  }
});

test('the credential boundary embeds no environment-specific host, path or identity', () => {
  // Deployment specifics reach this code through configuration (PW_* settings)
  // and through the existing privilege-drop adapter, never as literals.
  const forbidden = [
    /\bpvi2?\b/i,
    /\bgoa\b/i,
    /\bproject-workbench\/workspaces\b/,
    /\/etc\/project-workbench\b/,
    /\/home\/admin\b/,
    /\b\d{1,3}(\.\d{1,3}){3}\b/,
    /\.local\b/,
  ];
  for (const file of NEW_SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      const hit = src.match(pattern);
      assert.equal(hit, null, `${path.basename(file)} embeds an environment-specific literal: ${hit && hit[0]}`);
    }
  }
});

test('no credential-boundary source hard-codes a workspace owner account name', () => {
  for (const file of NEW_SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      if (line.replace(/^\s+/, '').startsWith('//')) continue;
      assert.equal(/['"]admin['"]/.test(line), false, `${path.basename(file)} hard-codes an account name: ${line.trim().slice(0, 100)}`);
    }
  }
});
