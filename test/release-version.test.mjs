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
//
// AND — the round this file was rewritten in — that the second check is ever actually MADE. It was
// not, on the event that ships a release: a direct push to main resolved its own branch as the base
// to compare against, found the merge base was HEAD, concluded "nothing proposed here" and passed.
// A gate that compares a thing to itself does not fail; it just stops being a gate. The range now
// comes from the CI event (test/release-guard-lib.mjs), and the fixture tests below prove the
// difference on a repository built to have exactly that defect in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RELEASE_VERSION, VERSION_PATTERN, readReleaseVersion } from '../app/version.js';
import {
  ZERO_SHA, changedFiles, evaluateRelease, isDeployable, resolveComparison,
} from './release-guard-lib.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

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
    'test/release-guard-lib.mjs',
    '.github/workflows/ci.yml',
    'README.md',
    'DEPLOY.md',
    'install-notes.md',
    'bin/pw',
  ]) {
    assert.ok(!isDeployable(file), `expected ${file} to be classified as non-deployable`);
  }
});

// --- fixture repositories -----------------------------------------------------

function runIn(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A repository whose default branch is `main` regardless of the host git's init.defaultBranch. */
function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runIn(dir, 'init', '-q');
  runIn(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  runIn(dir, 'config', 'user.email', 'test@example.com');
  runIn(dir, 'config', 'user.name', 'Test');
  return dir;
}

/**
 * A repository shaped like this one: a release identifier, deployable content, and content that is
 * not deployable. `main` is left pointing at a second commit that ships `app/server.js` — with or
 * without the bump that is supposed to accompany it.
 */
function releaseFixture({ bumpTo = null, alsoTouch = [], onBranch = null } = {}) {
  const dir = initRepo('pw-release-fx-');
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
  fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'base');
  const before = runIn(dir, 'rev-parse', 'HEAD');

  if (onBranch) runIn(dir, 'checkout', '-q', '-b', onBranch);
  for (const file of alsoTouch.length ? alsoTouch : ['app/server.js']) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `changed ${file}\n`);
  }
  if (bumpTo) fs.writeFileSync(path.join(dir, 'app', 'VERSION'), `${bumpTo}\n`);
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'ship it');
  const after = runIn(dir, 'rev-parse', 'HEAD');

  const version = fs.readFileSync(path.join(dir, 'app', 'VERSION'), 'utf8').trim();
  return { dir, before, after, version };
}

/** The environment a GitHub Actions runner presents for one event, payload file included. */
function actionsEnv(dir, eventName, payload, extra = {}) {
  const file = path.join(dir, `event-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: file, ...extra };
}

function pushEvent({ before, after, branch = 'main', defaultBranch = 'main' }) {
  return {
    before, after, ref: `refs/heads/${branch}`,
    repository: { default_branch: defaultBranch },
  };
}

/** The superseded resolution, replicated exactly: base branch, merge base, and an early return when
 *  the merge base IS HEAD. Kept so "this used to pass" is demonstrated rather than asserted. */
function legacyWouldSkip(dir) {
  const base = ['origin/main', 'main'].find((ref) => {
    try { runIn(dir, 'rev-parse', '--verify', `${ref}^{commit}`); return true; } catch { return false; }
  });
  if (!base) return true;
  return runIn(dir, 'merge-base', 'HEAD', base) === runIn(dir, 'rev-parse', 'HEAD');
}

// --- the vacuous pass, and its repair -----------------------------------------

test('REGRESSION: a direct push to main that ships app/ without a bump is CAUGHT — the superseded guard compared main to itself and passed', () => {
  const fx = releaseFixture();
  try {
    // The defect, demonstrated rather than described: on this exact repository the old resolution
    // finds the merge base of main and main, sees HEAD, and returns "nothing proposed".
    assert.equal(legacyWouldSkip(fx.dir), true, 'sanity: this fixture reproduces the vacuous-pass shape');

    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after }), { GITHUB_REF_NAME: 'main' });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.kind, 'push-to-release-branch');
    assert.equal(comparison.from, fx.before, 'the range must come from the push event, not from the branch it landed on');
    assert.notEqual(comparison.from, fx.after, 'a range whose endpoints are the same commit is the bug');

    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison });
    assert.equal(verdict.status, 'violation', `the missing bump must be caught: ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, /app\/server\.js/, 'the failure must name the shipping file');
    assert.match(verdict.reason, /1\.26\.0101\.0000/, 'the failure must name the identifier that did not move');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a push to main carrying a forward bump passes', () => {
  const fx = releaseFixture({ bumpTo: '1.26.0102.0000' });
  try {
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after }), { GITHUB_REF_NAME: 'main' });
    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: resolveComparison({ repoDir: fx.dir, env }) });
    assert.equal(verdict.status, 'ok', JSON.stringify(verdict));
    assert.equal(verdict.previous, '1.26.0101.0000');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a push to main whose "bump" moves sideways or backwards is still a violation', () => {
  for (const bumpTo of ['1.26.0101.0000', '1.25.1231.2359']) {
    const fx = releaseFixture({ bumpTo });
    try {
      const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after }), { GITHUB_REF_NAME: 'main' });
      const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: resolveComparison({ repoDir: fx.dir, env }) });
      assert.equal(verdict.status, 'violation', `${bumpTo} must not count as a bump: ${JSON.stringify(verdict)}`);
    } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
  }
});

test('a push to main that ships nothing deployable needs no bump', () => {
  const fx = releaseFixture({ alsoTouch: ['docs/plan.md', 'test/foo.test.mjs', '.github/workflows/test.yml'] });
  try {
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after }), { GITHUB_REF_NAME: 'main' });
    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: resolveComparison({ repoDir: fx.dir, env }) });
    assert.equal(verdict.status, 'no-deployable-change', JSON.stringify(verdict));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

/**
 * A release push carries as many commits as the pusher had locally. That is what makes a NARROWER
 * comparison worse than no comparison: it looks like a check and reports success.
 *
 * A: base · B: ships app/server.js, no bump · C: docs only · main = C.
 *
 * With the event's `before` unavailable, HEAD^..HEAD is B..C — docs only — and the guard passes while
 * B ships to every instance with a stale release identifier. Nothing about that run looks wrong.
 */
function multiCommitPushFixture() {
  const dir = initRepo('pw-release-multi-');
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
  fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'A: base');
  const a = runIn(dir, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v2 SHIPPED, no bump");\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'B: ship app/server.js without a bump');
  const b = runIn(dir, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan, revised\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'C: docs only');
  const c = runIn(dir, 'rev-parse', 'HEAD');

  return { dir, a, b, c, version: fs.readFileSync(path.join(dir, 'app', 'VERSION'), 'utf8').trim() };
}

test('REGRESSION: a multi-commit release push with an unresolvable range FAILS CLOSED — a narrower comparison would have missed the shipping commit', () => {
  const fx = multiCommitPushFixture();
  try {
    // The hole, measured rather than described: the narrow range really does miss the shipping file.
    assert.deepEqual(changedFiles(fx.dir, 'HEAD^', 'HEAD').filter(isDeployable), [],
      'sanity: HEAD^..HEAD is docs-only, which is why reducing the range to it passes');
    assert.deepEqual(changedFiles(fx.dir, fx.a, fx.c).filter(isDeployable), ['app/server.js'],
      'sanity: the push as a whole DOES ship deployable content');

    for (const before of [ZERO_SHA, '', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']) {
      const env = actionsEnv(fx.dir, 'push', pushEvent({ before, after: fx.c }), { GITHUB_REF_NAME: 'main' });
      const comparison = resolveComparison({ repoDir: fx.dir, env });
      assert.equal(comparison.unresolved, true, `before=${JSON.stringify(before)} must not resolve to a range: ${JSON.stringify(comparison)}`);
      assert.equal(comparison.from, undefined, 'an unresolvable release push must not fall back to a narrower range');
      assert.equal(comparison.skip, undefined, 'an unresolvable release push must not become a skipped test either');

      const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison });
      assert.equal(verdict.status, 'violation', `must fail the CI test, not pass or skip: ${JSON.stringify(verdict)}`);
      assert.equal(verdict.code, 'unresolvable-release-range');
      assert.match(verdict.reason, /fetch-depth/, 'the failure must tell an operator how to make the range available');
    }
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the SAME multi-commit push is gated normally once its range is available', () => {
  const fx = multiCommitPushFixture();
  try {
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.a, after: fx.c }), { GITHUB_REF_NAME: 'main' });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.kind, 'push-to-release-branch');
    assert.equal(comparison.from, fx.a);
    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison });
    assert.equal(verdict.status, 'violation', JSON.stringify(verdict));
    assert.match(verdict.reason, /app\/server\.js/, 'the commit that actually shipped must be named');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a release push with no parent at all fails closed too — a root commit is not an excuse to skip', () => {
  const dir = initRepo('pw-release-root-');
  try {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v1");\n');
    runIn(dir, 'add', '-A');
    runIn(dir, 'commit', '-q', '-m', 'root');
    const env = actionsEnv(dir, 'push', pushEvent({ before: ZERO_SHA, after: runIn(dir, 'rev-parse', 'HEAD') }), { GITHUB_REF_NAME: 'main' });
    const comparison = resolveComparison({ repoDir: dir, env });
    assert.equal(comparison.unresolved, true, JSON.stringify(comparison));
    const verdict = evaluateRelease({ repoDir: dir, version: '1.26.0101.0000', comparison });
    assert.equal(verdict.status, 'violation');
    assert.equal(verdict.code, 'unresolvable-release-range');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a push whose branch the runner does not name is treated as a release push, not as "nothing proposed"', () => {
  const fx = releaseFixture();
  try {
    // No GITHUB_REF_NAME, and a payload with no `ref` either. Falling back to branch topology here is
    // what would reintroduce the vacuous pass, because HEAD is main.
    const env = actionsEnv(fx.dir, 'push', { before: fx.before, after: fx.after, repository: { default_branch: 'main' } });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.kind, 'push-to-release-branch');
    assert.equal(comparison.from, fx.before);
    assert.equal(evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison }).status, 'violation');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a push whose base branch is not in the checkout is still checked, from the event range', () => {
  const fx = releaseFixture({ onBranch: 'feature' });
  try {
    // A shallow-ish checkout of a feature branch: no main, no origin/main. There is no base to
    // measure against — but the push event still knows what it introduced, so this must be a real
    // comparison rather than a skip.
    runIn(fx.dir, 'branch', '-D', 'main');
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after, branch: 'feature' }), { GITHUB_REF_NAME: 'feature' });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.skip, undefined, `a push must not skip when its own range is available: ${JSON.stringify(comparison)}`);
    assert.equal(comparison.from, fx.before);
    assert.equal(evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison }).status, 'violation');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

/**
 * A force-push replaces the branch's tree; it does not add to it. The authoritative question is
 * therefore "what does the NEW tree contain that the OLD tree did not", and three-dot cannot ask it:
 * `B...C` diffs merge-base(B, C) against C, so everything B introduced and C rolled back is invisible.
 *
 * A: server.js=v1, VERSION 1.26.0101.0000
 * B: the old release tip, from A — server.js=v2, VERSION 1.26.0102.0000
 * C: the force-pushed replacement, from A — docs only (optionally carrying B's VERSION forward)
 *
 * main = C, and the push event says before=B. `B...C` is measured from A, so it reports only what C
 * added since A — docs, and a VERSION that moved FORWARD. The rollback of app/server.js from v2 to v1
 * — a real change to what every instance runs — does not appear at all.
 */
function forcePushFixture({ keepVersion = false } = {}) {
  const dir = initRepo('pw-release-force-');
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
  fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v1");\n');
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'A: base');
  const a = runIn(dir, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v2");\n');
  fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0102.0000\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'B: old release tip');
  const b = runIn(dir, 'rev-parse', 'HEAD');

  // The force-push: main is moved back to A and a different commit is built there. B stays a real,
  // resolvable object — this is the "divergent but resolvable" case, not the unresolvable one.
  runIn(dir, 'checkout', '-q', '-B', 'main', a);
  fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan, rewritten\n');
  if (keepVersion) fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0102.0000\n');
  runIn(dir, 'add', '-A');
  runIn(dir, 'commit', '-q', '-m', 'C: force-pushed replacement');
  const c = runIn(dir, 'rev-parse', 'HEAD');

  return { dir, a, b, c, version: fs.readFileSync(path.join(dir, 'app', 'VERSION'), 'utf8').trim() };
}

test('REGRESSION: a divergent force-push is measured old tree -> new tree, not from the merge base', () => {
  const fx = forcePushFixture({ keepVersion: true });
  try {
    // The hole, measured: three-dot sees no deployable change at all, two-dot sees the rollback.
    assert.deepEqual(changedFiles(fx.dir, fx.b, fx.c, 'three-dot').filter(isDeployable), [],
      'sanity: from the merge base, the rolled-back file is invisible — which is why the guard passed');
    assert.deepEqual(changedFiles(fx.dir, fx.b, fx.c, 'two-dot').filter(isDeployable), ['app/server.js'],
      'sanity: old tree -> new tree DOES contain the rollback');

    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.b, after: fx.c }), { GITHUB_REF_NAME: 'main' });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.from, fx.b, 'the range still starts at the pushed-away tip');
    assert.equal(comparison.diffMode, 'two-dot', 'a push range is an old-tree/new-tree question, never a merge-base one');

    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison });
    assert.equal(verdict.status, 'violation', `a rolled-back app/server.js must be caught: ${JSON.stringify(verdict)}`);
    assert.match(verdict.reason, /app\/server\.js/, 'the rolled-back file must be named');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a force-push that rolls the release identifier BACKWARDS is a violation', () => {
  const fx = forcePushFixture({ keepVersion: false });
  try {
    // C carries A's identifier, so relative to the tip it replaced the release number moved backwards.
    assert.equal(fx.version, '1.26.0101.0000');
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.b, after: fx.c }), { GITHUB_REF_NAME: 'main' });
    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: resolveComparison({ repoDir: fx.dir, env }) });
    assert.equal(verdict.status, 'violation', JSON.stringify(verdict));
    assert.match(verdict.reason, /move forwards|1\.26\.0102\.0000/, 'the backwards move must be named, not just the file list');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a fast-forward push is unaffected: both range forms agree when the old tip is an ancestor', () => {
  const fx = releaseFixture();
  try {
    assert.deepEqual(
      changedFiles(fx.dir, fx.before, fx.after, 'two-dot'),
      changedFiles(fx.dir, fx.before, fx.after, 'three-dot'),
      'the ordinary case must not change meaning',
    );
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after }), { GITHUB_REF_NAME: 'main' });
    const verdict = evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: resolveComparison({ repoDir: fx.dir, env }) });
    assert.equal(verdict.status, 'violation', JSON.stringify(verdict));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

// --- everything the repair had to leave alone ---------------------------------

test('PRESERVED: a pull request still compares against its base branch, not against push before/after', () => {
  const fx = releaseFixture({ onBranch: 'feature' });
  try {
    // A push payload is present and would name a useless range (the head commit twice) — the PR path
    // must not read it at all.
    const env = actionsEnv(
      fx.dir, 'pull_request',
      { ...pushEvent({ before: fx.after, after: fx.after, branch: 'feature' }), pull_request: { number: 1 } },
      { GITHUB_REF_NAME: 'feature', GITHUB_BASE_REF: 'main' },
    );
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.kind, 'pull-request');
    assert.equal(comparison.from, fx.before, 'a PR is measured from its merge base with the base branch');
    assert.equal(evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison }).status, 'violation');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('PRESERVED: a push to a NON-default branch keeps branch-versus-base semantics', () => {
  const fx = releaseFixture({ onBranch: 'feature' });
  try {
    const env = actionsEnv(fx.dir, 'push', pushEvent({ before: fx.before, after: fx.after, branch: 'feature' }), { GITHUB_REF_NAME: 'feature' });
    const comparison = resolveComparison({ repoDir: fx.dir, env });
    assert.equal(comparison.kind, 'branch');
    assert.equal(comparison.base, 'main');
    assert.equal(comparison.from, fx.before);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('PRESERVED: with no CI event at all, a checkout is measured against its base branch, and the base branch proposes nothing', () => {
  const fx = releaseFixture({ onBranch: 'feature' });
  try {
    const onFeature = resolveComparison({ repoDir: fx.dir, env: {} });
    assert.equal(onFeature.kind, 'branch');
    assert.equal(onFeature.from, fx.before);
    assert.equal(evaluateRelease({ repoDir: fx.dir, version: fx.version, comparison: onFeature }).status, 'violation');

    runIn(fx.dir, 'checkout', '-q', 'main');
    const onMain = resolveComparison({ repoDir: fx.dir, env: {} });
    assert.equal(onMain.nothingProposed, true, `a local checkout of the base branch proposes nothing: ${JSON.stringify(onMain)}`);
    assert.equal(evaluateRelease({ repoDir: fx.dir, version: '1.26.0101.0000', comparison: onMain }).status, 'nothing-proposed');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('PRESERVED: a checkout with no base branch at all skips out loud rather than passing', () => {
  const dir = initRepo('pw-release-nobase-');
  try {
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    runIn(dir, 'add', '-A');
    runIn(dir, 'commit', '-q', '-m', 'only');
    runIn(dir, 'branch', '-m', 'main', 'detached-work'); // no main, no origin/main: a tarball or shallow export
    const comparison = resolveComparison({ repoDir: dir, env: {} });
    assert.match(comparison.skip || '', /no base branch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PRESERVED: proposal comparisons stay three-dot, so a branch is never blamed for what landed on its base', () => {
  const dir = initRepo('pw-release-proposal-');
  try {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0101.0000\n');
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v1");\n');
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan\n');
    runIn(dir, 'add', '-A');
    runIn(dir, 'commit', '-q', '-m', 'A: base');
    const a = runIn(dir, 'rev-parse', 'HEAD');

    // Somebody else's work lands on main, with its own bump.
    fs.writeFileSync(path.join(dir, 'app', 'server.js'), 'console.log("v2, landed on main");\n');
    fs.writeFileSync(path.join(dir, 'app', 'VERSION'), '1.26.0102.0000\n');
    runIn(dir, 'add', '-A');
    runIn(dir, 'commit', '-q', '-m', 'D: landed on main');
    const d = runIn(dir, 'rev-parse', 'HEAD');

    // A docs-only branch cut from A, which knows nothing about D.
    runIn(dir, 'checkout', '-q', '-b', 'feature', a);
    fs.writeFileSync(path.join(dir, 'docs', 'plan.md'), '# plan, edited on the branch\n');
    runIn(dir, 'add', '-A');
    runIn(dir, 'commit', '-q', '-m', 'E: docs only');

    // This is what three-dot is FOR: measured from main's tip, the branch would appear to change
    // app/server.js (backwards, to v1) purely because main moved on without it.
    assert.deepEqual(changedFiles(dir, d, 'HEAD', 'two-dot').filter(isDeployable), ['app/server.js'],
      'sanity: an old-tree/new-tree comparison against the base TIP would blame the branch for D');

    for (const env of [
      actionsEnv(dir, 'pull_request', { pull_request: { number: 1 } }, { GITHUB_REF_NAME: 'feature', GITHUB_BASE_REF: 'main' }),
      actionsEnv(dir, 'push', pushEvent({ before: a, after: runIn(dir, 'rev-parse', 'HEAD'), branch: 'feature' }), { GITHUB_REF_NAME: 'feature' }),
      {},
    ]) {
      const comparison = resolveComparison({ repoDir: dir, env });
      assert.equal(comparison.diffMode, 'three-dot', `a proposal must keep merge-base semantics: ${JSON.stringify(comparison)}`);
      assert.equal(comparison.from, a, 'a proposal is measured from its merge base');
      assert.equal(evaluateRelease({ repoDir: dir, version: '1.26.0101.0000', comparison }).status, 'no-deployable-change',
        'a docs-only branch must not be blamed for main\'s landed app change');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PRESERVED: a rename cannot smuggle deployable content past the guard', () => {
  const dir = initRepo('pw-rename-guard-');
  try {
    const run = (...args) => runIn(dir, ...args);
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

    const deployable = changedFiles(dir, base, head).filter(isDeployable);

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
    // And the whole point of surfacing them: this is a violation, not a pass.
    assert.equal(
      evaluateRelease({ repoDir: dir, version: '1.26.0101.0000', comparison: { kind: 'test', from: base, to: head } }).status,
      'violation',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- and finally, this checkout ------------------------------------------------

test('release: a change to deployable release content carries a release bump with it', (t) => {
  const comparison = resolveComparison({ repoDir: REPO });
  const verdict = evaluateRelease({ repoDir: REPO, version: RELEASE_VERSION, comparison });
  if (verdict.status === 'skipped') {
    t.skip(verdict.reason);
    return;
  }
  assert.notEqual(verdict.status, 'violation', verdict.reason);
});
