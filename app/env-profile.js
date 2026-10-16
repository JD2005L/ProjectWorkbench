// The three-category environment model: common, corporate, personal.
//
// ============================================================================
// WHY THIS EXISTS
//
// Every environment difference in this product already reaches the shared code
// as a PW_* variable — app/ branches on configuration, never on who is running
// it. What was missing is anywhere to say WHICH variable belongs to WHICH
// environment. That knowledge lived in prose: DEPLOY.md's knob table,
// DECISIONS.md standing rules, and a 254 KB coordination file. Nothing checked
// it, so the two instances could disagree with the documentation and with each
// other and only a deploy would find out. That is the GOA-1 failure class:
// a required knob that only ONE entrypoint's environment named, which turned a
// total refusal into a clean exit 0.
//
// So the classification becomes data — one profile per category under
// environments/ — and the rules below become a test.
//
// CATEGORIES ARE THE TAXONOMY; ENVIRONMENT IDENTITIES ARE NOT. This module may
// name the three categories, because the categories ARE the mechanism. It must
// never name a concrete instance (a site, a host, an organisation): that is the
// invariant the shared trees exist to keep, and a loader that knew about `goa`
// would be the first file to break it. A profile names its own instances; the
// loader only ever sees a category.
//
// NON-SECRET ONLY, for the same reason as app/env-schema.js: a profile is a
// world-readable file in a repository that gets rendered into an environment
// file. A secret's NAME may be declared (so an operator knows the instance needs
// it); its VALUE may never appear. `findViolations` enforces that rather than
// trusting it.
// ============================================================================

import path from 'node:path';

// `common` is not an environment — it is the trunk every environment inherits.
// The other two are the environments that exist today. A fourth environment is a
// new directory plus a new entry here; nothing else in the product changes.
export const CATEGORIES = Object.freeze(['common', 'corporate', 'personal']);
export const ENVIRONMENT_CATEGORIES = Object.freeze(CATEGORIES.filter((c) => c !== 'common'));

export const PROFILE_FILENAME = 'profile.json';
export const EVIDENCE_LEVELS = Object.freeze(['verified', 'reconstructed']);

// A value this shaped is key material, whatever the variable is called. Checked
// on the VALUE, because the name is the part an author controls and therefore
// the part that lies: `PW_SECRET_KEY_PATH=/etc/...` is configuration, while
// `PW_SOMETHING_HARMLESS=<64 hex>` is a leak.
const KEYLIKE = /^[A-Fa-f0-9]{24,}$|^[A-Za-z0-9+/]{32,}={0,2}$/;
// Names whose value is legitimately a long hex digest, not a credential.
const DIGEST_NAME = /(_SHA256|_SHA|_DIGEST|_FINGERPRINT)$/;
// Names that may only ever be DECLARED, never valued, in a profile.
const SECRET_NAME = /(_TOKEN|_PASSWORD|_SECRET)$/;

export function looksSecret(name, value) {
  if (SECRET_NAME.test(name)) return true;
  if (DIGEST_NAME.test(name)) return false;
  const v = String(value ?? '');
  if (v.includes('/') || v.includes(' ')) return false; // a path or a phrase
  return KEYLIKE.test(v);
}

// Load every profile under `dir`. Injected readers keep this unit-testable and
// let a caller decide what "readable" means, matching app/env-schema.js.
export async function loadProfiles({ dir, readdir, readFile }) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const profiles = [];
  for (const name of entries) {
    const file = path.join(dir, name, PROFILE_FILENAME);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      profiles.push({ dirName: name, file, parseError: 'no profile.json' });
      continue;
    }
    try {
      const data = JSON.parse(raw);
      profiles.push({ ...data, dirName: name, file });
    } catch (err) {
      profiles.push({ dirName: name, file, parseError: err.message });
    }
  }
  return profiles;
}

export function splitByCategory(profiles) {
  const common = profiles.find((p) => p.category === 'common') || null;
  const environments = profiles.filter((p) => p.category && p.category !== 'common');
  return { common, environments };
}

const envOf = (p) => (p && p.env && typeof p.env === 'object' ? p.env : {});
const listOf = (p, k) => (Array.isArray(p?.[k]) ? p[k] : []);

// The effective environment for one category: the common trunk, then that
// environment's own values. Declared-only secrets are returned separately so a
// caller renders a placeholder rather than an empty assignment.
export function mergedEnv(profiles, category) {
  const { common, environments } = splitByCategory(profiles);
  const target = environments.find((p) => p.category === category);
  if (!target) return null;
  return {
    env: { ...envOf(common), ...envOf(target) },
    secretEnv: [...new Set([...listOf(common, 'secretEnv'), ...listOf(target, 'secretEnv')])],
  };
}

// Every rule, reported together rather than throwing on the first, so one run
// tells an operator everything that is wrong with the classification.
//
// `knownKnobs` is the set of variables the source tree actually reads. Passing it
// is what catches a knob that was renamed in code and left behind in a profile —
// dead configuration that reads as intentional.
export function findViolations(profiles, { knownKnobs = null } = {}) {
  const v = [];
  const add = (rule, detail) => v.push({ rule, detail });

  for (const p of profiles) {
    if (p.parseError) add('parses', `${p.file}: ${p.parseError}`);
  }
  const ok = profiles.filter((p) => !p.parseError);

  // --- shape -----------------------------------------------------------------
  for (const p of ok) {
    if (!CATEGORIES.includes(p.category)) {
      add('category-known', `${p.file}: category ${JSON.stringify(p.category)} is not one of ${CATEGORIES.join(', ')}`);
      continue;
    }
    if (p.dirName !== p.category) {
      add('dir-matches-category', `${p.file}: directory ${p.dirName} but category ${p.category}`);
    }
    if (!p.title) add('has-title', `${p.file}: no title`);
    if (!EVIDENCE_LEVELS.includes(p.evidence)) {
      add('evidence-declared', `${p.file}: evidence must be one of ${EVIDENCE_LEVELS.join(', ')}`);
    }
    if (p.evidence === 'reconstructed' && !p.evidenceNote) {
      add('reconstructed-is-explained', `${p.file}: reconstructed profiles must carry evidenceNote saying what would confirm them`);
    }
  }

  const { common, environments } = splitByCategory(ok);
  if (!common) add('common-exists', 'no profile declares category "common"');
  for (const c of CATEGORIES) {
    const n = ok.filter((p) => p.category === c).length;
    if (n > 1) add('one-profile-per-category', `${n} profiles declare category ${c}`);
  }

  // --- no overlaps -----------------------------------------------------------
  // The rule that gives the model its value, in both directions.
  const commonEnv = envOf(common);
  for (const p of environments) {
    for (const name of Object.keys(envOf(p))) {
      if (name in commonEnv) {
        add('common-not-repeated', `${name} is set in common AND in ${p.category} — remove it from one (same value => common, differing => environments only)`);
      }
    }
  }
  if (environments.length > 1) {
    const first = envOf(environments[0]);
    for (const [name, value] of Object.entries(first)) {
      const inAll = environments.every((p) => envOf(p)[name] === value);
      if (inAll) {
        add('identical-belongs-to-common', `${name}=${value} is identical in every environment — move it to the common profile`);
      }
    }
  }

  // --- declared vs unconfirmed vs forbidden ----------------------------------
  for (const p of ok) {
    const env = envOf(p);
    for (const name of listOf(p, 'unconfirmedEnv')) {
      if (name in env) add('unconfirmed-is-not-declared', `${p.category}: ${name} is both declared in env and listed unconfirmed`);
    }
    for (const name of listOf(p, 'forbiddenEnv')) {
      if (name in env) add('forbidden-not-set', `${p.category}: ${name} is forbidden here but declared in its own env`);
      if (name in commonEnv) add('forbidden-not-in-common', `${name} is forbidden in ${p.category} but set in the common profile, which ${p.category} inherits`);
    }
  }

  // --- secrets ---------------------------------------------------------------
  for (const p of ok) {
    const declared = new Set(listOf(p, 'secretEnv'));
    for (const [name, value] of Object.entries(envOf(p))) {
      if (looksSecret(name, value)) {
        add('no-secret-values', `${p.category}: ${name} must be declared in secretEnv with no value, not assigned in env`);
      }
      if (declared.has(name)) {
        add('secret-declared-only', `${p.category}: ${name} is in secretEnv and must not also carry a value`);
      }
    }
  }

  // --- the knobs are real ----------------------------------------------------
  if (knownKnobs) {
    for (const p of ok) {
      const names = [
        ...Object.keys(envOf(p)),
        ...listOf(p, 'unconfirmedEnv'),
        ...listOf(p, 'forbiddenEnv'),
        ...listOf(p, 'secretEnv'),
      ];
      for (const name of names) {
        if (!name.startsWith('PW_')) continue; // NODE_ENV and friends are not ours to verify
        if (!knownKnobs.has(name)) {
          add('knob-exists-in-source', `${p.category}: ${name} is not read anywhere in app/ or scripts/ — dead configuration`);
        }
      }
    }
  }

  return v;
}
