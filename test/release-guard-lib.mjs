// What the release guard compares, and what it concludes.
//
// Extracted from test/release-version.test.mjs because the decision it makes is the whole gate, and
// a decision that can only be exercised by whatever the current checkout happens to be is a decision
// nobody can test. Everything here takes a repo directory and an environment, so a fixture repo plus
// a synthetic GitHub Actions event can prove the guard fires — including in the one case where it
// used to be silently unable to.
//
// THE DEFECT THIS EXISTS TO FIX. The guard asked "what does this branch change relative to its
// base?", and resolved the base as `origin/main`. On a pull request that is exactly right. On a
// direct PUSH TO MAIN — the event that actually ships a release — HEAD *is* origin/main, the merge
// base is HEAD, and the guard returned early with "on the base branch itself: nothing proposed". So
// the one check standing between deployable content and a live instance passed by comparing main to
// itself, and reported success. A green run meant nothing at precisely the moment it mattered.
//
// The fix is to stop inferring the range and read it from the event GitHub Actions already provides:
// a push carries `before` and `after`, which is literally "what this push introduced". PR behaviour,
// local behaviour, `--no-renames` classification and shallow-checkout handling are unchanged; only
// the push-to-the-release-branch case, which had no working answer, gained one.
//
// This lives under test/ deliberately: it is CI logic, it never ships, and it must NOT be
// deployable content itself (see isDeployable below — anything under app/ would oblige every edit
// to this file to carry a release bump).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { VERSION_PATTERN } from '../app/version.js';

/** git's "no such commit" sentinel: a push event's `before` on a newly created branch. */
export const ZERO_SHA = '0'.repeat(40);

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Whether a ref resolves to a real commit in THIS checkout — false on a shallow clone, or a
 *  force-pushed-away `before` whose object is simply not here. */
export function gitVerify(repoDir, ref) {
  try { git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]); return true; } catch { return false; }
}

/**
 * Files touched between two refs, both endpoints of a rename included. Plain `--name-only` prints
 * only the destination when Git's rename detection fires (the default since Git 2.9), so a
 * content-identical rename of `install.sh` to anything else would report only the new, unclassified
 * name and the deployable source name would never appear in the diff at all — a version bump
 * requirement erased by a `git mv`. `--no-renames` turns every rename back into an independent
 * delete + add pair so both names surface and get classified on their own.
 */
export function changedFiles(repoDir, fromRef, toRef) {
  return git(repoDir, ['diff', '--no-renames', '--name-only', `${fromRef}...${toRef}`])
    .split('\n').filter(Boolean);
}

/**
 * Whether a changed file is release content — part of what a deployed instance actually runs, so the
 * release identifier is obligated to move when it changes. `app/` is copied wholesale to every
 * instance. `install.sh` lives outside `app/` but is the root-level entry point that puts it there —
 * a behavioural fix to it (e.g. which directory `bin/` lands in) changes what a fresh install runs,
 * exactly like a change under `app/` would. Docs, tests and CI configuration never reach a live
 * instance and carry no release of their own.
 */
export function isDeployable(file) {
  if (file === 'install.sh') return true;
  return file.startsWith('app/') && file !== 'app/VERSION' && !file.startsWith('app/node_modules/');
}

/** `1.YY.MMDD.hhmm` as an ordered tuple, so "newer" is a comparison rather than a string guess. */
export function ordinal(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`not a release identifier: ${version}`);
  return match.slice(1).map(Number);
}

export function isAfter(candidate, previous) {
  const a = ordinal(candidate);
  const b = ordinal(previous);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The GitHub Actions event payload, or null outside Actions (and on an unreadable payload). */
export function readEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try { return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { return null; }
}

function branchOf(env, event) {
  return String(env.GITHUB_REF_NAME || String(event?.ref || '').replace(/^refs\/heads\//, '') || '');
}

/**
 * The branch releases land on. Taken from the event payload the runner supplies rather than
 * hardcoded, so a repository that renames its default branch keeps the gate; `main` only backstops a
 * payload that does not say.
 */
function defaultBranchOf(event) {
  return String(event?.repository?.default_branch || 'main');
}

/**
 * What this branch is being proposed against.
 *
 * `GITHUB_BASE_REF` is set on a pull request; a push to a branch has to fall back to `main`. Returns
 * null when nothing usable resolves — a shallow clone, a tarball, an export — and the caller then
 * skips out loud rather than passing on the strength of a lookup that never happened.
 */
export function baseRef(repoDir, env = process.env) {
  const candidates = [];
  if (env.GITHUB_BASE_REF) candidates.push(`origin/${env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    if (gitVerify(repoDir, ref)) return ref;
  }
  return null;
}

/**
 * The two endpoints the guard compares, chosen from what the CI event actually is.
 *
 * Returns one of:
 *   { kind, from, to }           — compare these; `to` is always the checked-out tree's HEAD
 *   { kind: 'on-base', ... }     — this checkout proposes nothing (local main, no event)
 *   { skip: reason }             — the range cannot be established here; say so out loud
 *
 * The rule, in order: a push to the release branch (or to a branch this runner cannot name) is
 * measured by the event's own before → HEAD; anything else is measured against its base branch; and
 * a push whose base branch is not in the checkout falls back to the event range rather than skipping,
 * because a push always knows its own range.
 *
 * It never returns a range whose endpoints are the same commit: that is the vacuous pass this
 * function exists to make impossible.
 */
export function resolveComparison({ repoDir, env = process.env, event = readEvent(env) } = {}) {
  const eventName = String(env.GITHUB_EVENT_NAME || '');

  /** What a push event itself says it introduced: `before` → HEAD. */
  const pushRange = () => {
    const before = String(event?.before || '');
    if (before && before !== ZERO_SHA && gitVerify(repoDir, before)) {
      return { kind: 'push-to-release-branch', from: before, to: 'HEAD' };
    }
    // No usable `before`: a branch just created (all-zero sentinel), a force-push whose old tip is
    // no longer here, a shallow checkout, or a payload the runner did not supply. The first parent
    // is still a real, different commit — narrower than the full push when it moved several commits
    // at once, but never a comparison of HEAD with itself.
    if (gitVerify(repoDir, 'HEAD^')) {
      return {
        kind: 'push-to-release-branch-parent',
        from: 'HEAD^',
        to: 'HEAD',
        note: `no usable push 'before' SHA (${before || 'absent'}); compared against HEAD's first parent instead`,
      };
    }
    return { skip: `push with no usable 'before' SHA (${before || 'absent'}) and no parent commit to compare against` };
  };

  const branch = branchOf(env, event);
  // An UNIDENTIFIABLE branch is treated as the release branch on purpose. Guessing "some feature
  // branch" is the guess that reintroduces the vacuous pass when it is wrong; guessing "the release
  // branch" can only make the guard stricter.
  if (eventName === 'push' && (branch === '' || branch === defaultBranchOf(event))) return pushRange();

  // Pull requests, pushes to any other branch, and local runs: what this branch proposes against its
  // base. Unchanged — this is the case the original guard got right.
  const base = baseRef(repoDir, env);
  const unestablished = (reason) => (eventName === 'push' ? pushRange() : { skip: reason });
  if (!base) return unestablished('no base branch in this checkout, so what changed cannot be established');
  let mergeBase;
  try {
    mergeBase = git(repoDir, ['merge-base', 'HEAD', base]);
  } catch {
    // A push event still knows its own range even when the base branch is not in this checkout, so
    // it gets checked rather than skipped; anything else has nothing left to ask.
    return unestablished(`no merge base with ${base} in this checkout (a shallow clone cannot answer this)`);
  }
  if (mergeBase === git(repoDir, ['rev-parse', 'HEAD'])) {
    return { kind: 'on-base', base, nothingProposed: true };
  }
  return { kind: eventName.startsWith('pull_request') ? 'pull-request' : 'branch', from: mergeBase, to: 'HEAD', base };
}

/**
 * The verdict: does the release identifier honour what this comparison contains?
 *
 * Compared by CONTENT against the `from` side rather than by presence in the diff, so a bump that is
 * staged but not yet committed still counts locally, and so a "bump" that moves sideways or
 * backwards is caught rather than accepted for having touched the file.
 */
export function evaluateRelease({ repoDir, version, comparison }) {
  if (comparison.skip) return { status: 'skipped', reason: comparison.skip };
  if (comparison.nothingProposed) return { status: 'nothing-proposed' };

  const deployable = changedFiles(repoDir, comparison.from, comparison.to).filter(isDeployable);
  if (deployable.length === 0) return { status: 'no-deployable-change', deployable };

  let previous;
  try {
    previous = git(repoDir, ['show', `${comparison.from}:app/VERSION`]).trim();
  } catch {
    // No release identifier existed at the other end of the comparison (a repository before app/
    // had one). There is nothing to move forwards from; the format assertion still applies.
    return { status: 'no-previous-version', deployable };
  }

  if (version === previous) {
    return {
      status: 'violation',
      reason: `these files ship but app/VERSION is still ${previous}:\n  ${deployable.join('\n  ')}`,
      previous, deployable,
    };
  }
  if (!isAfter(version, previous)) {
    return {
      status: 'violation',
      reason: `the release identifier must move forwards: ${previous} -> ${version}`,
      previous, deployable,
    };
  }
  return { status: 'ok', previous, deployable };
}
