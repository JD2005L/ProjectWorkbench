#!/usr/bin/env node
// Run the dependency-free subset of the test suite — the "offline gate" (GOA-4).
//
// WHY THIS EXISTS
//
// The canonical gate is `cd app && npm ci && npm test`, and it stays canonical. But the GOA runtime
// has no route to the npm registry at all, so `npm ci` cannot run there, and `app/package.json`
// declares exactly one runtime dependency: `express`. The result was that GOA's runs reported 68
// failures, 67 of which were "express is missing" and one of which was a real finding — and neither
// side's totals were comparable to the other's. Under coordination rule 7, a change is mutually
// accepted only after BOTH sides record that no concrete blocker remains, which is impossible when
// neither can reproduce the other's numbers on the same SHA.
//
// So: one command, on any machine, with no install step, that runs every test which does not need
// `express` and reports a total both sides can compare against the same commit.
//
// SELECTION IS DETERMINISTIC AND DOES NOT DEPEND ON WHAT IS INSTALLED.
//
// The subset is computed the same way whether or not `express` happens to be present, so the file
// list — and therefore the totals — are a property of the commit, not of the machine. A file is
// excluded when either:
//
//   1. its transitive import graph, followed through this repository's own files, reaches a bare
//      `express` specifier (e.g. test -> app/orchestrator/api.js -> express); or
//   2. it launches the dashboard as a child process, which needs express at runtime even though no
//      import in the test itself says so. `node --test` cannot see that edge, so it is detected by
//      the test referring to `app/server.js`.
//
// Rule 2 is a source-text heuristic and is deliberately conservative: a false positive costs
// coverage in this subset only, never correctness, because the excluded files still run in the
// canonical gate. Every exclusion is REPORTED, so nothing is silently dropped — a subset that
// quietly shrank would be worse than no subset at all.
//
//   node scripts/pw-test-offline.mjs            # run the subset
//   node scripts/pw-test-offline.mjs --list     # print the classification and exit
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(REPO, 'test');

/** Bare specifiers that mean "this needs something npm had to install". */
const RUNTIME_DEPS = new Set(Object.keys(
  JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'package.json'), 'utf8')).dependencies || {},
));

const IMPORT_RE = /(?:^|[^\w.])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])import\s*['"]([^'"]+)['"]/g;

function specifiers(text) {
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (spec) out.push(spec);
  }
  return out;
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** Walk this repository's own import graph and report the first runtime dependency it reaches. */
function reachesRuntimeDep(entry, seen = new Set(), runtimeDeps = RUNTIME_DEPS, repoRoot = REPO) {
  if (seen.has(entry)) return null;
  seen.add(entry);
  let text;
  try { text = fs.readFileSync(entry, 'utf8'); } catch { return null; }
  for (const spec of specifiers(text)) {
    if (spec.startsWith('node:')) continue;
    if (!spec.startsWith('.')) {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (runtimeDeps.has(pkg)) return { dep: pkg, via: entry, repoRoot };
      continue;
    }
    const local = resolveLocal(entry, spec);
    if (!local) continue;
    const found = reachesRuntimeDep(local, seen, runtimeDeps, repoRoot);
    if (found) return found;
  }
  return null;
}

/** Comments removed, so an explanation of a boot is never mistaken for one. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

/**
 * Does this test boot the dashboard as a child process? `node --test` cannot see that edge, so it
 * is detected from the source — but only where server.js is RESOLVED TO A PATH, which is what a
 * launcher does:
 *
 *     const serverJs = fileURLToPath(new URL('../app/server.js', import.meta.url));   // a boot
 *     for (const file of ['app/server.js', ...])                                      // not a boot
 *
 * The second is test/release-version.test.mjs classifying filenames, and the loose check that
 * matched it excluded a dozen files that need nothing at all — a subset that quietly shrinks is
 * worse than no subset, because its total looks like coverage.
 */
function spawnsDashboard(file) {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  return /(?:new URL|fileURLToPath|require\.resolve|path\.(?:join|resolve))\s*\([^)]*app[/\\]server\.js/.test(code);
}

export function classifyTests(dir = TEST_DIR, { runtimeDeps = RUNTIME_DEPS, repoRoot = REPO } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  const included = [];
  const excluded = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const dep = reachesRuntimeDep(file, new Set(), runtimeDeps, repoRoot);
    if (dep) {
      excluded.push({ name, reason: `imports '${dep.dep}' (via ${path.relative(repoRoot, dep.via)})` });
      continue;
    }
    if (spawnsDashboard(file)) {
      excluded.push({ name, reason: "boots app/server.js, which needs 'express' at runtime" });
      continue;
    }
    included.push(name);
  }
  return { included, excluded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { included, excluded } = classifyTests();
  const list = process.argv.includes('--list');

  process.stdout.write(`# offline subset: ${included.length} file(s); ${excluded.length} excluded\n`);
  for (const e of excluded) process.stdout.write(`#   excluded ${e.name}: ${e.reason}\n`);
  if (list) {
    for (const f of included) process.stdout.write(`#   included ${f}\n`);
    process.exit(0);
  }
  if (!included.length) {
    process.stderr.write('no dependency-free tests were selected — that is a bug in the classifier, not a pass\n');
    process.exit(1);
  }

  // A SHORT, isolated tmux socket root. sun_path is capped at 108 bytes and CI temp paths are
  // routinely deep enough to blow it; the resulting "File name too long" reads like a socket
  // resolution bug and is easy to misdiagnose. Isolated so this run can never reach a real server.
  const tmuxRoot = fs.mkdtempSync(path.join('/tmp', 'pwo'));
  const env = { ...process.env, TMUX_TMPDIR: tmuxRoot };
  // Ambient tmux/PW state decides which BRANCH the scripts under test take (see test/tmux-env.mjs);
  // a runner that leaked it would silently test one mode twice.
  for (const key of ['TMUX', 'TMUX_PANE', 'PW_TMUX_HOST_MODE', 'PW_TMUX_SOCKET', 'PW_DEPLOY_MODE', 'NOTIFY_SOCKET']) {
    delete env[key];
  }

  const child = spawn(process.execPath, ['--test', ...included.map((f) => path.join(TEST_DIR, f))], {
    cwd: path.join(REPO, 'app'),
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    try { fs.rmSync(tmuxRoot, { recursive: true, force: true }); } catch { /* fine */ }
    process.exit(signal ? 1 : (code ?? 1));
  });
  void os;
}
