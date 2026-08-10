// GOA-4 — the shared gate has to actually be shared.
//
// The canonical gate is `cd app && npm ci && npm test`, and it stays canonical. But the GOA runtime
// has no route to the npm registry at all, so `npm ci` cannot run there; `app/package.json` declares
// exactly one runtime dependency, `express`; and GOA's run of the full suite reported 68 failures,
// 67 of which were that absence and 1 of which was a real finding. Neither side's totals were
// comparable to the other's on the same SHA — and coordination rule 7 requires both sides to record
// that no concrete blocker remains, which is not possible from incomparable numbers.
//
// `npm run test:offline` is the answer: one command, no install step, running every test that does
// not need express. What this file protects is the property that makes it useful — the subset is a
// function of the COMMIT, not of the machine, and nothing is dropped silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyTests } from '../scripts/pw-test-offline.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(REPO, 'scripts', 'pw-test-offline.mjs');

test('the subset excludes exactly what needs express, and nothing else', () => {
  const { included, excluded } = classifyTests();
  const excludedNames = excluded.map((e) => e.name);

  // Direct and transitive dependency edges.
  for (const name of ['smoke.test.mjs', 'deploy-route.test.mjs', 'user-lifecycle.test.mjs']) {
    assert.ok(excludedNames.includes(name), `${name} boots the dashboard and must be excluded`);
  }
  for (const name of ['orch-api-auth.test.mjs', 'orch-lease-fence.test.mjs']) {
    const entry = excluded.find((e) => e.name === name);
    assert.ok(entry, `${name} reaches express transitively and must be excluded`);
    assert.match(entry.reason, /orchestrator\/api\.js/, 'and the reason must name the edge, not just the file');
  }

  // The tests that carry this repair — all dependency-free by construction, so GOA can run them.
  for (const name of [
    'pw-env.test.mjs', 'pw-mem-high.test.mjs', 'pw-tmux-server.test.mjs',
    'deploy-mode.test.mjs', 'tmux-hermetic.test.mjs', 'install-sh.test.mjs',
  ]) {
    assert.ok(included.includes(name), `${name} needs no dependency and must be runnable offline`);
  }

  assert.ok(included.length >= 40, `the subset collapsed to ${included.length} files — that is a classifier bug, not a pass`);
});

test('REGRESSION: mentioning app/server.js is not booting it', () => {
  // The first cut excluded a dozen files that need nothing, because it matched the string anywhere —
  // including test/release-version.test.mjs, whose classifier test lists 'app/server.js' as DATA,
  // and several files that merely name it in a comment. A subset that quietly shrinks is worse than
  // no subset: its total still looks like coverage.
  const { included } = classifyTests();
  for (const name of ['release-version.test.mjs', 'pw-tmux-restore.test.mjs', 'secret-crypto.test.mjs', 'users-file.test.mjs']) {
    assert.ok(included.includes(name), `${name} only refers to app/server.js, it does not launch it`);
  }
});

test('classification does not depend on what is installed on this machine', async (t) => {
  // The point of the offline gate is comparable numbers across environments, which requires the file
  // list to be identical whether or not express happens to be present. Proven on a synthetic tree
  // classified twice — once with a populated node_modules, once with none — rather than by moving
  // the real one out from under a suite that is running.
  const dir = await fsp.mkdtemp('/tmp/pw-offline-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app');
  const tests = path.join(dir, 'test');
  await fsp.mkdir(app, { recursive: true });
  await fsp.mkdir(tests, { recursive: true });
  await fsp.writeFile(path.join(app, 'api.js'), "import express from 'express';\nexport const app = express();\n");
  await fsp.writeFile(path.join(app, 'pure.js'), "export const two = 2;\n");
  await fsp.writeFile(path.join(tests, 'needs-dep.test.mjs'), "import { app } from '../app/api.js';\nvoid app;\n");
  await fsp.writeFile(path.join(tests, 'pure.test.mjs'), "import { two } from '../app/pure.js';\nvoid two;\n");
  await fsp.writeFile(path.join(tests, 'boots.test.mjs'),
    "const s = new URL('../app/server.js', import.meta.url);\nvoid s;\n");

  const opts = { runtimeDeps: new Set(['express']), repoRoot: dir };
  const without = classifyTests(tests, opts);

  // Now make express genuinely resolvable in that tree and classify again.
  const nm = path.join(app, 'node_modules', 'express');
  await fsp.mkdir(nm, { recursive: true });
  await fsp.writeFile(path.join(nm, 'package.json'), '{"name":"express","version":"4.0.0","main":"index.js"}');
  await fsp.writeFile(path.join(nm, 'index.js'), 'export default function express() {}\n');
  const withDep = classifyTests(tests, opts);

  assert.deepEqual(withDep, without,
    'the same commit must select the same files on GOA as on PVI2, with or without node_modules');
  assert.deepEqual(without.included, ['pure.test.mjs']);
  assert.deepEqual(without.excluded.map((e) => e.name).sort(), ['boots.test.mjs', 'needs-dep.test.mjs']);
});

test('every exclusion is reported, so nothing is dropped silently', async () => {
  const { stdout } = await execFileAsync('node', [RUNNER, '--list'], { maxBuffer: 4 * 1024 * 1024 });
  const { included, excluded } = classifyTests();
  assert.match(stdout, new RegExp(`# offline subset: ${included.length} file\\(s\\); ${excluded.length} excluded`));
  for (const e of excluded) {
    assert.ok(stdout.includes(`excluded ${e.name}`), `${e.name} must be named in the report`);
  }
});

test('the runner is wired into package.json and pins a short, isolated tmux socket root', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test ../test/*.test.mjs', 'the canonical gate must stay exactly as it was');
  assert.match(pkg.scripts['test:offline'], /pw-test-offline\.mjs/);

  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /mkdtempSync\(path\.join\('\/tmp'/,
    'sun_path is capped at 108 bytes and CI temp dirs are deep; the socket root has to be short');
  for (const leak of ['TMUX_PANE', 'PW_TMUX_HOST_MODE', 'PW_DEPLOY_MODE', 'NOTIFY_SOCKET']) {
    assert.ok(src.includes(leak), `the runner must clear ambient ${leak} or it tests one mode twice`);
  }
});

test('GOA-4: the cross-contract fixture honours PW_ORCHESTRATOR_CONTRACT_ROOT like the pin script does', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'orch-contract-fixture.test.mjs'), 'utf8');
  assert.ok(!/const ORCHESTRATOR_ROOT = '\/opt/.test(src),
    'THE REGRESSION: a hardcoded sibling path cannot be redirected in a CI checkout, so the '
    + 'cross-contract assertions bound only on PVI2 and skipped everywhere else');
  assert.match(src, /import \{[^}]*ORCHESTRATOR_ROOT[^}]*\} from '\.\.\/scripts\/orch-contract-pin\.mjs'/,
    'one override must move both the pin script and the fixture test');
});
