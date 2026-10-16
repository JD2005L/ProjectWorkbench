// The three-category environment model — corporate, personal, common — is a
// GATE, not documentation.
//
// The classification it checks used to live only in prose (DEPLOY.md's knob
// table, DECISIONS.md standing rules, a 254 KB coordination file), so the two
// instances could drift from the documentation and from each other and only a
// deploy would notice. These tests make the three categories decidable:
//   * the shared trunk may not know which environment it is running on;
//   * a value that is the same everywhere lives in exactly one place;
//   * a value that differs lives in the environments and not in the trunk;
//   * a standing "never ship X to Y" rule fails here instead of in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, ENVIRONMENT_CATEGORIES, EVIDENCE_LEVELS,
  loadProfiles, splitByCategory, findViolations, mergedEnv, looksSecret,
} from '../app/env-profile.js';
import { ENV_NAMES, resolveEnvConfig } from '../app/env-schema.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVS = path.join(REPO, 'environments');

const profiles = await loadProfiles({ dir: ENVS, readdir: fsp.readdir, readFile: fsp.readFile });

// ---------------------------------------------------------------------------
// The knob inventory: what the source tree actually reads from the environment.
// Scanned rather than listed, so a renamed variable cannot leave a profile
// quietly describing configuration nothing consumes.
// ---------------------------------------------------------------------------
async function walk(dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(js|mjs|cjs|sh|conf|service|in)$/.test(e.name) || !path.extname(e.name)) out.push(p);
  }
  return out;
}

const KNOB = /PW_[A-Z0-9_]+/g;
async function knobInventory() {
  const found = new Set();
  // Every tree that reads the environment, not just the Node app: a knob can be
  // consumed only by a deploy hook or a unit file (PW_DOTNET_CHANNELS is read by
  // the Containerfile alone), and a scan that missed those would call a live knob
  // dead configuration.
  const roots = ['app', 'scripts', 'deploy', 'systemd'].map((d) => path.join(REPO, d));
  const files = (await Promise.all(roots.map((r) => walk(r)))).flat();
  files.push(path.join(REPO, 'install.sh'), path.join(REPO, 'Containerfile'));
  for (const f of files) {
    let src;
    try { src = await fsp.readFile(f, 'utf8'); } catch { continue; }
    // Only count a name that is actually READ from an environment object or
    // expanded by a shell, not one merely mentioned in a comment.
    for (const m of src.matchAll(/(?:process\.)?env\??(?:\.|\[')(PW_[A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/\$\{?(PW_[A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/^\s*(?:export\s+|ARG\s+|ENV\s+|Environment=)?(PW_[A-Z0-9_]+)=/gm)) found.add(m[1]);
    for (const m of src.matchAll(/_ENV\s*=\s*'(PW_[A-Z0-9_]+)'/g)) found.add(m[1]);
  }
  for (const n of ENV_NAMES) found.add(n); // the declared contract is read by construction
  return found;
}
const knownKnobs = await knobInventory();

test('the knob inventory found the real variables, so the gate below has teeth', () => {
  assert.ok(knownKnobs.size > 100, `scanned only ${knownKnobs.size} knobs`);
  for (const sentinel of ['PW_DEPLOY_MODE', 'PW_AUTH_MODE', 'PW_TURN_OUTCOME', 'PW_DEPLOY_CENTRE', 'PW_PER_USER_CLAUDE']) {
    assert.ok(knownKnobs.has(sentinel), `inventory missed ${sentinel}`);
  }
});

// ---------------------------------------------------------------------------
// The three categories, and nothing else
// ---------------------------------------------------------------------------
test('exactly the three categories exist, one directory each', () => {
  const found = profiles.map((p) => p.category).sort();
  assert.deepEqual(found, [...CATEGORIES].sort());
  for (const p of profiles) assert.equal(p.dirName, p.category);
});

test('every environment profile declares its evidence level honestly', () => {
  const { environments } = splitByCategory(profiles);
  assert.equal(environments.length, ENVIRONMENT_CATEGORIES.length);
  for (const p of environments) {
    assert.ok(EVIDENCE_LEVELS.includes(p.evidence), `${p.category}: evidence ${p.evidence}`);
    assert.ok(Array.isArray(p.instances) && p.instances.length, `${p.category}: must name the instances it serves`);
  }
});

// ---------------------------------------------------------------------------
// THE gate: no overlaps
// ---------------------------------------------------------------------------
test('no overlaps: the classification satisfies every rule', () => {
  const violations = findViolations(profiles, { knownKnobs });
  assert.deepEqual(violations, [], violations.map((x) => `[${x.rule}] ${x.detail}`).join('\n'));
});

test('the overlap rules actually fire (the gate is not vacuous)', () => {
  const common = { dirName: 'common', category: 'common', title: 't', evidence: 'verified', env: { PW_BASE_PATH: '/x' } };
  const a = { dirName: 'corporate', category: 'corporate', title: 't', evidence: 'verified', instances: ['a'], env: { PW_BASE_PATH: '/x', PW_AUTH_MODE: 'ldap' } };
  const b = { dirName: 'personal', category: 'personal', title: 't', evidence: 'verified', instances: ['b'], env: { PW_AUTH_MODE: 'ldap' } };
  const rules = findViolations([common, a, b]).map((x) => x.rule);
  assert.ok(rules.includes('common-not-repeated'), 'a knob in common AND an environment must be rejected');
  assert.ok(rules.includes('identical-belongs-to-common'), 'a knob identical in every environment must be rejected');
});

test('a secret value in a profile is rejected; a declared secret name is allowed', () => {
  assert.ok(looksSecret('PW_INTERNAL_HANDOFF_TOKEN', ''), 'a *_TOKEN name may never be valued');
  assert.ok(looksSecret('PW_ANYTHING', 'd31de4a146e0e3f3d8586c224158c537'), 'key-shaped value caught on shape, not name');
  assert.ok(!looksSecret('PW_SECRET_KEY_PATH', '/etc/project-workbench/.secret-key'), 'a path is configuration');
  assert.ok(!looksSecret('PW_ORCHESTRATOR_CLI_SHA256', 'a'.repeat(64)), 'a digest is not a credential');

  const bad = [{ dirName: 'personal', category: 'personal', title: 't', evidence: 'verified', instances: ['x'], env: { PW_INTERNAL_HANDOFF_TOKEN: 'abc' } }];
  assert.ok(findViolations(bad).some((x) => x.rule === 'no-secret-values'));
});

// ---------------------------------------------------------------------------
// Standing decisions, enforced
// ---------------------------------------------------------------------------
test('turn outcomes (Jev) never reach the corporate environment — DECISIONS.md 2026-10-05', () => {
  const { common, environments } = splitByCategory(profiles);
  const corporate = environments.find((p) => p.category === 'corporate');
  const personal = environments.find((p) => p.category === 'personal');

  assert.ok(corporate.forbiddenEnv.includes('PW_TURN_OUTCOME'), 'the corporate profile must forbid it explicitly');
  for (const name of corporate.forbiddenEnv) {
    assert.ok(!(name in (corporate.env || {})), `${name} forbidden but set`);
    assert.ok(!(name in (common.env || {})), `${name} forbidden for corporate but inherited from common`);
  }
  // And the effective environment, which is what an installer would render.
  const effective = mergedEnv(profiles, 'corporate').env;
  for (const name of corporate.forbiddenEnv) assert.ok(!(name in effective), `${name} present in the merged corporate env`);
  assert.equal(mergedEnv(profiles, 'personal').env.PW_TURN_OUTCOME, 'on', 'personal opts in');
  assert.equal(personal.env.PW_TURN_OUTCOME, 'on');
});

test('the two environments really are the two terminal models, declared not inferred', () => {
  const { environments } = splitByCategory(profiles);
  const modes = Object.fromEntries(environments.map((p) => [p.category, mergedEnv(profiles, p.category).env.PW_DEPLOY_MODE]));
  assert.equal(modes.corporate, 'container');
  assert.equal(modes.personal, 'host');
  for (const p of environments) {
    assert.equal(p.terminalModel, modes[p.category], `${p.category}: terminalModel must match its PW_DEPLOY_MODE`);
  }
});

test('each environment resolves the whole declared env-schema contract', () => {
  for (const category of ENVIRONMENT_CATEGORIES) {
    const cfg = resolveEnvConfig(mergedEnv(profiles, category).env);
    for (const name of ENV_NAMES) {
      assert.ok(cfg[name], `${category}: ${name} did not resolve`);
      assert.ok(path.isAbsolute(cfg[name]) || ['host', 'container', 'true', 'false'].includes(cfg[name]), `${category}: ${name}=${cfg[name]}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The common trunk may not know which environment it is
// ---------------------------------------------------------------------------
// Residual, deliberate exemptions. This list may SHRINK but never grow: an
// addition means new code learned an instance's name, which is the drift the
// whole model exists to prevent.
const INSTANCE_NAME_EXEMPTIONS = Object.freeze([
  // A default role label, live on the personal instance because its env does not
  // set PW_ORCHESTRATOR_ROLE. Renaming it changes a running value, so it is
  // scheduled in environments/README.md rather than changed here.
  { file: 'app/orchestrator/config.js', token: 'pvi2-orchestrator' },
]);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

test('no file in the shared trunk branches on an environment identity', async () => {
  const { common } = splitByCategory(profiles);
  // Enforced on what the profile says is enforced, so the declaration cannot
  // promise more than the gate delivers. Every enforced tree must also be a
  // shared one — enforcing a tree nobody calls common would be meaningless.
  assert.ok(Array.isArray(common.enforcedTrees) && common.enforcedTrees.length, 'common must declare enforcedTrees');
  for (const t of common.enforcedTrees) {
    assert.ok(common.sharedTrees.includes(t), `${t} is enforced but not declared a shared tree`);
  }

  const files = (await Promise.all(
    common.enforcedTrees.map((t) => walk(path.join(REPO, t))),
  )).flat().filter((f) => /\.(js|mjs)$/.test(f));
  assert.ok(files.length > 20, `only ${files.length} files scanned`);

  const identities = /\b(goa|govalta|pvi2|pvie|pve)\b/i;
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(REPO, f);
    const code = stripComments(await fsp.readFile(f, 'utf8'));
    for (const line of code.split('\n')) {
      const m = line.match(identities);
      if (!m) continue;
      if (INSTANCE_NAME_EXEMPTIONS.some((e) => e.file === rel && line.includes(e.token))) continue;
      offenders.push(`${rel}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `shared code naming an environment:\n${offenders.join('\n')}`);
});

test('the exemption list is exactly as long as it was when written', () => {
  // Shrinking this is progress and should update the number. Growing it is the
  // regression; a reviewer sees the count change either way.
  assert.equal(INSTANCE_NAME_EXEMPTIONS.length, 1);
});
