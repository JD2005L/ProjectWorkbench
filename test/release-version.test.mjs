// The release identifier is what a deployed instance reports about itself, so a change that ships
// without moving it makes every downstream answer wrong: the cockpit footer, the deploy log, and an
// operator comparing three environments to see which one is behind.
//
// Nothing in `npm test` checked it. `app/version.js` validates the format and
// `tools/verify/version-footer.mjs` asserts the footer wiring, but that suite is browser-level and
// needs a running instance and a password file, so it does not gate a pull request — which is how a
// deployable change reached a green CI with `app/VERSION` untouched.
//
// Two things are checked here. The format, always, because it costs nothing. And the bump itself,
// whenever git can tell us what changed: if anything under `app/` moved, the release identifier has
// to move with it, forwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RELEASE_VERSION, VERSION_PATTERN, readReleaseVersion } from '../app/version.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** `1.YY.MMDD.hhmm` as an ordered tuple, so "newer" is a comparison rather than a string guess. */
function ordinal(version) {
  const match = VERSION_PATTERN.exec(version);
  assert.ok(match, `not a release identifier: ${version}`);
  return match.slice(1).map(Number);
}

function isAfter(candidate, previous) {
  const a = ordinal(candidate);
  const b = ordinal(previous);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function git(...args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Files touched between two refs, both endpoints of a rename included. Plain `--name-only` prints
 * only the destination when Git's rename detection fires (the default since Git 2.9), so a
 * content-identical rename of `install.sh` to anything else would report only the new, unclassified
 * name and the deployable source name would never appear in the diff at all — a version bump
 * requirement erased by a `git mv`. `--no-renames` turns every rename back into an independent
 * delete + add pair so both names surface and get classified on their own.
 */
function changedFiles(repoDir, fromRef, toRef) {
  return execFileSync(
    'git',
    ['-C', repoDir, 'diff', '--no-renames', '--name-only', `${fromRef}...${toRef}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim().split('\n').filter(Boolean);
}

/**
 * Whether a changed file is release content — part of what a deployed instance actually runs, so the
 * release identifier is obligated to move when it changes. `app/` is copied wholesale to every
 * instance. `install.sh` lives outside `app/` but is the root-level entry point that puts it there —
 * a behavioural fix to it (e.g. which directory `bin/` lands in) changes what a fresh install runs,
 * exactly like a change under `app/` would. Docs, tests and CI configuration never reach a live
 * instance and carry no release of their own.
 */
function isDeployable(file) {
  if (file === 'install.sh') return true;
  return file.startsWith('app/') && file !== 'app/VERSION' && !file.startsWith('app/node_modules/');
}

/**
 * What this branch is being proposed against.
 *
 * `GITHUB_BASE_REF` is set on a pull request; a push to a branch has to fall back to `main`. Returns
 * null when nothing usable resolves — a shallow clone, a tarball, an export — and the caller then
 * skips out loud rather than passing on the strength of a lookup that never happened.
 */
function baseRef() {
  const candidates = [];
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    try {
      git('rev-parse', '--verify', `${ref}^{commit}`);
      return ref;
    } catch { /* not in this checkout */ }
  }
  return null;
}

test('release: the version this instance reports is a well-formed release identifier', () => {
  assert.match(RELEASE_VERSION, VERSION_PATTERN, 'release version must be 1.YY.MMDD.hhmm');
  // The pattern alone accepts month 13 and minute 60; version.js rejects them, and that rejection is
  // load-bearing because a nonsense identifier is worse than an old one — it sorts unpredictably.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-release-'));
  try {
    for (const bad of ['1.26.1332.2460', '1.26.0229.1200', '2.26.0729.1200', '1.26.0729.175', '']) {
      const file = path.join(dir, 'VERSION');
      fs.writeFileSync(file, `${bad}\n`);
      assert.throws(
        () => readReleaseVersion(new URL(`file://${file}`)),
        /Invalid Project Workbench release version/,
        `must refuse ${JSON.stringify(bad)}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release: the deployable-content classifier matches install.sh and app/, not docs/tests/CI', () => {
  for (const file of ['install.sh', 'app/server.js', 'app/index.html', 'app/lib/foo.js']) {
    assert.ok(isDeployable(file), `expected ${file} to be classified as deployable`);
  }
  for (const file of [
    'app/VERSION',
    'app/node_modules/foo/index.js',
    'docs/orchestrator-api.md',
    'test/install-sh.test.mjs',
    'test/release-version.test.mjs',
    '.github/workflows/ci.yml',
    'README.md',
    'DEPLOY.md',
    'install-notes.md',
    'bin/pw',
  ]) {
    assert.ok(!isDeployable(file), `expected ${file} to be classified as non-deployable`);
  }
});

test('REGRESSION: a rename cannot smuggle deployable content past the guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-rename-guard-'));
  try {
    const run = (...args) => execFileSync(
      'git',
      ['-C', dir, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');

    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'install.sh'), '#!/bin/sh\necho install\n');
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("server");\n');
    fs.writeFileSync(path.join(dir, 'app', 'leftover.js'), 'console.log("leftover");\n');
    fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(dir, 'test', 'foo.test.mjs'), '// test\n');
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    const base = run('rev-parse', 'HEAD');

    // Every rename below is content-identical (100% similarity), the case Git is most confident
    // about — and so the case most likely to collapse to a destination-only diff entry.
    run('mv', 'install.sh', 'installer-renamed.sh'); // rename OUT of deployable, by exact-name rule
    run('mv', path.join('app', 'server.js'), 'server-renamed.js'); // rename OUT of deployable, out of app/
    run('rm', '-q', path.join('app', 'leftover.js')); // delete of deployable content
    run('mv', path.join('docs', 'plan.md'), path.join('app', 'plan.js')); // rename IN to deployable
    run('mv', path.join('test', 'foo.test.mjs'), path.join('test', 'bar.test.mjs')); // non-deployable -> non-deployable
    run('mv', path.join('.github', 'workflows', 'ci.yml'), path.join('.github', 'workflows', 'ci2.yml')); // CI -> CI
    run('commit', '-q', '-m', 'rename everything, forget the VERSION bump');
    const head = run('rev-parse', 'HEAD');

    const changed = changedFiles(dir, base, head);
    const deployable = changed.filter(isDeployable);

    assert.ok(deployable.includes('install.sh'), 'a rename out of install.sh must still surface the deployable source name');
    assert.ok(deployable.includes('app/server.js'), 'a rename of app/server.js out of app/ must still surface the deployable source name');
    assert.ok(deployable.includes('app/leftover.js'), 'a delete of deployable content must still be caught');
    assert.ok(deployable.includes('app/plan.js'), 'a rename into app/ must be caught by the destination name');
    assert.ok(!deployable.includes('server-renamed.js'), 'the non-deployable destination name alone must not be why this is caught');
    assert.ok(
      !deployable.some((f) => f.includes('foo.test.mjs') || f.includes('bar.test.mjs')),
      'a rename within test/ must stay non-deployable',
    );
    assert.ok(
      !deployable.some((f) => f.includes('ci.yml') || f.includes('ci2.yml')),
      'a rename within CI config must stay non-deployable',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release: a change to deployable release content carries a release bump with it', (t) => {
  const base = baseRef();
  if (!base) {
    t.skip('no base branch in this checkout, so what changed cannot be established');
    return;
  }

  let mergeBase;
  try {
    mergeBase = git('merge-base', 'HEAD', base);
  } catch {
    t.skip(`no merge base with ${base} in this checkout (a shallow clone cannot answer this)`);
    return;
  }
  if (mergeBase === git('rev-parse', 'HEAD')) return; // On the base branch itself: nothing proposed.

  const changed = changedFiles(REPO, mergeBase, 'HEAD');

  const deployable = changed.filter(isDeployable);
  if (deployable.length === 0) return;

  // Compared by content against the base rather than by presence in the diff, so a bump that is
  // staged but not yet committed still counts locally, and so a "bump" that moves sideways or
  // backwards is caught rather than accepted for having touched the file.
  const previous = git('show', `${mergeBase}:app/VERSION`).trim();
  assert.notEqual(
    RELEASE_VERSION,
    previous,
    `these files ship but app/VERSION is still ${previous}:\n  ${deployable.join('\n  ')}`,
  );
  assert.ok(
    isAfter(RELEASE_VERSION, previous),
    `the release identifier must move forwards: ${previous} -> ${RELEASE_VERSION}`,
  );
});
