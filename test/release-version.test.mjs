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

test('release: a change to the deployable app carries a release bump with it', (t) => {
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

  const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean);

  // `app/` is what gets copied to a live instance, so it is what the release identifier describes.
  // Tests, docs and CI configuration are not deployed and do not need a release of their own.
  const deployable = changed.filter((file) => file.startsWith('app/')
    && file !== 'app/VERSION'
    && !file.startsWith('app/node_modules/'));
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
