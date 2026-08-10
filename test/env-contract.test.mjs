// Candidate B — the non-secret environment contract (GOA-1 + HJ-24-5).
//
// The defect: four entrypoints each carried their own host-mode defaults for the
// same paths. On a container-mode instance the registry lives elsewhere, only the
// dashboard's environment named it, and no restore unit exported it — so
// pw-tmux-restore resolved the host default, refused EVERY session, and still
// exited 0. A total refusal was indistinguishable from a clean no-op.
//
// Two properties are locked down here:
//   1. the schema is declared ONCE and cannot drift from its shell consumer;
//   2. a present manifest plus unusable required config is a DISTINCT nonzero
//      failure, while an absent manifest stays a clean zero-exit no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ENV_SCHEMA, ENV_NAMES, CONFIG_ERROR_EXIT, resolveEnvConfig, validateEnvConfig,
  requiredFor, renderEnvFile, describeEnvSchema, schemaEntry,
} from '../app/env-schema.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESTORE = path.join(REPO, 'scripts', 'pw-tmux-restore');
const SEP = '\x1f';

// --- the schema is mode-neutral and non-secret --------------------------------

test('every entry is non-secret: a path, an enum or a boolean — never key material', () => {
  for (const e of ENV_SCHEMA) {
    assert.ok(['file', 'dir', 'enum', 'boolean'].includes(e.kind), `${e.name} has kind ${e.kind}`);
    assert.ok(e.semantics && e.semantics.length > 20, `${e.name} must document its semantics`);
    assert.ok(['never', 'restoring', 'per-user', 'propagated'].includes(e.requiredWhen), `${e.name} requiredWhen`);
    if (e.kind === 'file' || e.kind === 'dir') {
      assert.ok(['read', 'read-write'].includes(e.access), `${e.name} must declare required access`);
      assert.ok(path.isAbsolute(e.default), `${e.name} default must be absolute`);
    }
  }
});

test('the schema covers the eight variables the contract names, including PW_SECRET_KEY_PATH', () => {
  assert.deepEqual([...ENV_NAMES].sort(), [
    'PW_APP_DIR', 'PW_DEPLOY_MODE', 'PW_PER_USER_CLAUDE', 'PW_REGISTRY_PATH',
    'PW_SECRET_KEY_PATH', 'PW_TMUX_STATE_DIR', 'PW_USERS_PATH', 'PW_USER_CRED_BASE',
  ]);
  // Accepted into the schema by the Round 4 disposition specifically because
  // app/project-terminal-credentials.mjs reads it from the environment.
  // 'propagated', not 'per-user': in the contract and propagated, but never
  // preflighted by restore — see the dedicated test below. This is what keeps the
  // schema and its shell consumer from disagreeing about what "required" means.
  assert.equal(schemaEntry('PW_SECRET_KEY_PATH').requiredWhen, 'propagated');
});

test('PW_SECRET_KEY_PATH is read from the environment by the helper the restore path invokes', async () => {
  const src = await fsp.readFile(path.join(REPO, 'app', 'project-terminal-credentials.mjs'), 'utf8');
  // If this ever stops being true the schema entry is dead weight; if the schema
  // entry were removed while this remained, GOA-1's failure class returns.
  assert.match(src, /process\.env\.PW_SECRET_KEY_PATH/);
});

test('mode-neutral: nothing in the schema is host-only or container-only', () => {
  // Structural, not lexical: no entry may be scoped to a mode, and both modes
  // must resolve. PW_DEPLOY_MODE's own semantics necessarily names both models.
  for (const e of ENV_SCHEMA) {
    assert.ok(!('mode' in e) && !('modes' in e), `${e.name} must not be scoped to one deploy mode`);
  }
  assert.equal(resolveEnvConfig({}).deployMode, 'host', 'documented backward-compatible default');
  assert.equal(resolveEnvConfig({ PW_DEPLOY_MODE: 'container' }).deployMode, 'container');
  assert.equal(resolveEnvConfig({ PW_DEPLOY_MODE: 'nonsense' }).deployMode, 'host', 'an unknown mode falls back, never throws');
});

// --- resolution and conditional requirement -----------------------------------

test('defaults apply, and an empty string is treated as unset', () => {
  const cfg = resolveEnvConfig({ PW_REGISTRY_PATH: '', PW_USERS_PATH: '/custom/users.json' });
  assert.equal(cfg.PW_REGISTRY_PATH, '/opt/project-workbench/projects.json');
  assert.equal(cfg.PW_USERS_PATH, '/custom/users.json');
});

test('per-user inputs are required only when the feature is on', () => {
  const off = requiredFor(resolveEnvConfig({}), 'restoring').map((e) => e.name);
  assert.ok(!off.includes('PW_SECRET_KEY_PATH'), 'a shared-login instance need not configure credential inputs');
  const on = requiredFor(resolveEnvConfig({ PW_PER_USER_CLAUDE: 'true' }), 'restoring').map((e) => e.name);
  for (const n of ['PW_USERS_PATH', 'PW_USER_CRED_BASE']) {
    assert.ok(on.includes(n), `${n} must be required when per-user is on`);
  }
  assert.ok(!on.includes('PW_SECRET_KEY_PATH'), 'the key path is propagated, never preflighted');
});

test('nothing is required when there is no manifest to replay', () => {
  assert.deepEqual(requiredFor(resolveEnvConfig({ PW_PER_USER_CLAUDE: 'true' }), 'idle'), []);
});

// --- validation reports every failure, actionably -----------------------------

const probe = (over = {}) => async (p) => ({
  exists: true, isFile: true, isDirectory: true, readable: true, writable: true, helperMissing: false, ...(over[p] || {}),
});

test('validation names the variable, the path and the reason for each failure', async () => {
  const cfg = resolveEnvConfig({});
  const res = await validateEnvConfig({
    cfg,
    statPath: probe({ '/opt/project-workbench/projects.json': { exists: false } }),
  });
  assert.equal(res.ok, false);
  const f = res.failures.find((x) => x.name === 'PW_REGISTRY_PATH');
  assert.ok(f, 'the failing variable must be named');
  assert.equal(f.path, '/opt/project-workbench/projects.json');
  assert.equal(f.reason, 'does not exist');
});

test('EXISTS BUT UNREADABLE is a failure — the GOA PW_APP_DIR case', async () => {
  // The default app dir is root-owned 0700 on a container-mode instance: present,
  // and still unusable to the account restore runs as. Existence was never the
  // requirement.
  const res = await validateEnvConfig({
    cfg: resolveEnvConfig({}),
    statPath: probe({ '/opt/project-workbench/app': { readable: false } }),
  });
  assert.equal(res.ok, false);
  assert.match(res.failures.find((x) => x.name === 'PW_APP_DIR').reason, /not readable/);
});

test('a missing required helper under PW_APP_DIR is reported against that path', async () => {
  const res = await validateEnvConfig({
    cfg: resolveEnvConfig({}),
    statPath: probe({ '/opt/project-workbench/app': { helperMissing: true } }),
  });
  assert.match(res.failures.find((x) => x.name === 'PW_APP_DIR').reason, /helper is missing/);
  assert.match(res.failures.find((x) => x.name === 'PW_APP_DIR').path, /project-terminal-credentials\.mjs$/);
});

test('all failures are reported at once, not just the first', async () => {
  const res = await validateEnvConfig({
    cfg: resolveEnvConfig({ PW_PER_USER_CLAUDE: 'true' }),
    statPath: async () => ({ exists: false }),
  });
  assert.ok(res.failures.length >= 5, `expected every required entry to be reported, got ${res.failures.length}`);
});

test('a relative path is rejected without touching the filesystem', async () => {
  const probedPaths = [];
  const res = await validateEnvConfig({
    cfg: resolveEnvConfig({ PW_REGISTRY_PATH: 'relative/projects.json' }),
    statPath: async (p) => { probedPaths.push(p); return { exists: true, isFile: true, isDirectory: true, readable: true, writable: true }; },
  });
  assert.match(res.failures.find((x) => x.name === 'PW_REGISTRY_PATH').reason, /absolute/);
  assert.ok(
    !probedPaths.includes('relative/projects.json'),
    'a relative path must be refused before it is ever handed to the filesystem',
  );
});

test('a read-write entry that is only readable fails', async () => {
  const res = await validateEnvConfig({
    cfg: resolveEnvConfig({}),
    statPath: probe({ '/var/lib/project-workbench/tmux-persist': { writable: false } }),
  });
  assert.match(res.failures.find((x) => x.name === 'PW_TMUX_STATE_DIR').reason, /not writable/);
});

// --- the rendered file, and the no-drift guarantee ----------------------------

test('the rendered env file carries every name and no secret material', () => {
  const out = renderEnvFile({ PW_DEPLOY_MODE: 'container', PW_SECRET_KEY_PATH: '/etc/project-workbench/.secret-key' });
  for (const n of ENV_NAMES) assert.match(out, new RegExp(`^${n}=`, 'm'), `${n} must be rendered`);
  assert.match(out, /^PW_DEPLOY_MODE=container$/m);
  assert.ok(!/BEGIN|PRIVATE KEY|ghp_|github_pat_/.test(out), 'no credential material may be rendered');
  assert.equal(describeEnvSchema().length, ENV_SCHEMA.length);
});

test('NO DRIFT: every variable the shell consumer validates is declared in the schema', async () => {
  const sh = await fsp.readFile(RESTORE, 'utf8');
  const validated = [...sh.matchAll(/require_readable\s+(PW_[A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(validated.length >= 4, `expected the preflight to validate several entries, saw ${validated.length}`);
  for (const name of validated) {
    assert.ok(ENV_NAMES.includes(name), `${name} is validated in pw-tmux-restore but absent from app/env-schema.js`);
  }
  // And the reverse for the entries that carry a path: a schema entry the shell
  // never checks would be a contract nobody enforces.
  for (const e of ENV_SCHEMA.filter((x) => x.requiredWhen !== 'never')) {
    assert.ok(
      sh.includes(e.name),
      `${e.name} is required by the schema but pw-tmux-restore never mentions it`,
    );
  }
});

test('NO DRIFT: the shell consumer uses the same distinct configuration exit code', async () => {
  const sh = await fsp.readFile(RESTORE, 'utf8');
  assert.match(sh, new RegExp(`CONFIG_ERROR_EXIT=${CONFIG_ERROR_EXIT}\\b`));
});

// --- end to end: the distinction that GOA-1 is about --------------------------

async function restoreRun(t, { manifest, env = {} }) {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwenv-'));
  t.after(() => fsp.rm(state, { recursive: true, force: true }));
  await fsp.mkdir(path.join(state, 'content'), { recursive: true });
  if (manifest) {
    const row = ['pw_Thing', '0', 'shell', REPO, '0', '', ''].join(SEP);
    await fsp.writeFile(path.join(state, 'manifest.tsv'), `${row}\n`);
  }
  const res = await execFileAsync(RESTORE, [], {
    env: {
      ...process.env,
      TMUX_TMPDIR: '/tmp/pwiso',
      PW_TMUX_SOCKET: `envtest-${Math.abs(Date.now() % 100000)}-${manifest ? 'm' : 'n'}`,
      PW_TMUX_STATE_DIR: state,
      PW_TMUX_RESTORE_CLAUDE: '0',
      ...env,
    },
    timeout: 60000,
  }).then(() => ({ code: 0 }), (e) => ({ code: e.code ?? 1 }));
  const log = await fsp.readFile(path.join(state, 'persist.log'), 'utf8').catch(() => '');
  return { ...res, log };
}

test('E2E: a present manifest plus an unusable registry exits with the distinct config code', async (t) => {
  const r = await restoreRun(t, {
    manifest: true,
    env: { PW_REGISTRY_PATH: '/nonexistent/projects.json', PW_APP_DIR: path.join(REPO, 'app') },
  });
  assert.equal(r.code, CONFIG_ERROR_EXIT, 'must be the distinct configuration failure, not a generic 1 and not 0');
  assert.match(r.log, /CONFIGURATION ERROR/);
  assert.match(r.log, /restored NOTHING/);
  assert.match(r.log, /PW_REGISTRY_PATH=\/nonexistent\/projects\.json: does not exist/);
  assert.ok(!/restore complete/.test(r.log), 'a configuration failure must never claim completion');
});

test('E2E: an absent manifest stays a clean zero-exit no-op even when config is unusable', async (t) => {
  const r = await restoreRun(t, {
    manifest: false,
    env: { PW_REGISTRY_PATH: '/nonexistent/projects.json', PW_APP_DIR: '/nonexistent/app' },
  });
  assert.equal(r.code, 0, 'nothing to restore is not a configuration error');
  assert.match(r.log, /no manifest; nothing to restore/);
  assert.ok(!/CONFIGURATION ERROR/.test(r.log));
});

test('E2E: an unreadable PW_APP_DIR is caught even though the path exists', async (t) => {
  const r = await restoreRun(t, {
    manifest: true,
    env: { PW_REGISTRY_PATH: path.join(REPO, 'app', 'package.json'), PW_APP_DIR: '/proc/1/fd' },
  });
  assert.equal(r.code, CONFIG_ERROR_EXIT);
  assert.match(r.log, /PW_APP_DIR=\/proc\/1\/fd/);
});

test('E2E: per-user inputs are only demanded when the feature is on', async (t) => {
  const base = { PW_REGISTRY_PATH: path.join(REPO, 'app', 'package.json'), PW_APP_DIR: path.join(REPO, 'app') };
  const off = await restoreRun(t, { manifest: true, env: { ...base, PW_USERS_PATH: '/nonexistent/users.json' } });
  assert.notEqual(off.code, CONFIG_ERROR_EXIT, 'with the feature off, an unused credential input is not an error');

  const on = await restoreRun(t, {
    manifest: true,
    env: { ...base, PW_PER_USER_CLAUDE: 'true', PW_USERS_PATH: '/nonexistent/users.json' },
  });
  assert.equal(on.code, CONFIG_ERROR_EXIT);
  assert.match(on.log, /PW_USERS_PATH=\/nonexistent\/users\.json: does not exist/);
});

// Scoped to exactly what the contract names — registry, app helper, users path,
// credential base. PW_SECRET_KEY_PATH is carried by the schema and propagated,
// but deliberately NOT preflighted: this script never reads the key, it hands the
// path to app/project-terminal-credentials.mjs, which decrypts as the credential
// owner and already fails closed per session. Preflighting it would preempt that
// per-session refusal — several existing fail-closed regressions assert it — and
// the key is typically 0600 to an account this script does not run as, so it
// would also refuse on a correctly configured host.
test('PW_SECRET_KEY_PATH is propagated but NOT preflighted, and an unreadable key does not block restore', async (t) => {
  const sh = await fsp.readFile(RESTORE, 'utf8');
  assert.ok(!/require_readable PW_SECRET_KEY_PATH/.test(sh), 'the key path must not be preflighted');
  assert.match(sh, /PW_SECRET_KEY_PATH is deliberately NOT preflighted/, 'and the reason must be recorded where it is not done');

  const r = await restoreRun(t, {
    manifest: true,
    env: {
      PW_REGISTRY_PATH: path.join(REPO, 'app', 'package.json'),
      PW_APP_DIR: path.join(REPO, 'app'),
      PW_PER_USER_CLAUDE: 'true',
      PW_USERS_PATH: path.join(REPO, 'app', 'package.json'),
      PW_SECRET_KEY_PATH: '/nonexistent/.secret-key',
    },
  });
  assert.notEqual(r.code, CONFIG_ERROR_EXIT, 'an unreadable key is the helper\'s fail-closed concern, not a preflight refusal');
});

// --- Round 8 acceptance requirements ------------------------------------------

// B-1. The superseded candidate gated its registry/app-dir requirement on a shell
// contract library being resolvable, so on a partial deployment — `app/` and
// `scripts/` copied without running the installer, a documented habit on this
// fleet — the refusal silently disappeared and the script exited 0 having
// restored nothing. This implementation carries no shell library at all: the
// preflight is inline, and app/env-schema.js is consumed only by install.sh and
// by these tests. This proves that property rather than asserting it.
test('B-1: the configuration refusal does not depend on ANY helper being resolvable', async (t) => {
  const iso = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwb1-'));
  t.after(() => fsp.rm(iso, { recursive: true, force: true }));

  // The script, alone. No sibling app/, no scripts/ peers, no installed copy.
  const lone = path.join(iso, 'pw-tmux-restore');
  await fsp.copyFile(RESTORE, lone);
  await fsp.chmod(lone, 0o755);
  assert.equal(
    await fsp.readdir(iso).then((e) => e.join(',')),
    'pw-tmux-restore',
    'the isolation must be real: nothing else may be reachable beside the script',
  );

  const state = path.join(iso, 'state');
  await fsp.mkdir(path.join(state, 'content'), { recursive: true });
  const row = ['pw_Thing', '0', 'shell', REPO, '0', '', ''].join(SEP);
  await fsp.writeFile(path.join(state, 'manifest.tsv'), `${row}\n`);

  const res = await execFileAsync(lone, [], {
    env: {
      ...process.env,
      TMUX_TMPDIR: '/tmp/pwiso',
      PW_TMUX_SOCKET: `b1-${Math.abs(Date.now() % 100000)}`,
      PW_TMUX_STATE_DIR: state,
      PW_TMUX_RESTORE_CLAUDE: '0',
      PW_REGISTRY_PATH: '/nonexistent/projects.json',
      PW_APP_DIR: '/nonexistent/app',
    },
    timeout: 60000,
  }).then(() => ({ code: 0 }), (e) => ({ code: e.code ?? 1 }));

  assert.equal(res.code, CONFIG_ERROR_EXIT, 'a partial deployment must still refuse, not exit 0');
  const log = await fsp.readFile(path.join(state, 'persist.log'), 'utf8');
  assert.match(log, /CONFIGURATION ERROR/);
  assert.match(log, /restored NOTHING/);
});

// B-2. A manifest that exists but cannot be read is misconfiguration, not an
// empty manifest. Previously the read redirect failed, the loop body never ran,
// and the script exited 0 while the unit reported success.
test('B-2: an unreadable manifest is a distinct configuration failure, not exit 0', async (t) => {
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwb2-'));
  t.after(() => fsp.rm(state, { recursive: true, force: true }));
  await fsp.mkdir(path.join(state, 'content'), { recursive: true });
  const manifest = path.join(state, 'manifest.tsv');
  const row = ['pw_Thing', '0', 'shell', REPO, '0', '', ''].join(SEP);
  await fsp.writeFile(manifest, `${row}\n`);
  await fsp.chmod(manifest, 0o000);

  const res = await execFileAsync(RESTORE, [], {
    env: {
      ...process.env,
      TMUX_TMPDIR: '/tmp/pwiso',
      PW_TMUX_SOCKET: `b2-${Math.abs(Date.now() % 100000)}`,
      PW_TMUX_STATE_DIR: state,
      PW_TMUX_RESTORE_CLAUDE: '0',
      PW_REGISTRY_PATH: path.join(REPO, 'app', 'package.json'),
      PW_APP_DIR: path.join(REPO, 'app'),
    },
    timeout: 60000,
  }).then(() => ({ code: 0 }), (e) => ({ code: e.code ?? 1 }));

  assert.equal(res.code, CONFIG_ERROR_EXIT, 'an unreadable manifest must not read as an empty one');
  const log = await fsp.readFile(path.join(state, 'persist.log'), 'utf8');
  assert.match(log, /manifest exists but is not readable/);
  assert.ok(!/restore complete/.test(log));
});

// The credential base is the one required entry that may legitimately not exist
// yet — app/user-credentials.js creates it on first use — so "required" has to
// mean usable, not already-created. Demanding it pre-exist broke 24 existing
// fail-closed regressions whose fixtures never create it.
test('the credential base may be absent as long as it could be created', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwcb-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const sh = await fsp.readFile(RESTORE, 'utf8');
  assert.match(sh, /require_cred_base/, 'the base must use the absent-or-usable check, not require_readable');
  // Absent with a writable parent is acceptable; absent with a nonexistent
  // parent is not. Both encoded in the script's own helper.
  assert.match(sh, /absent and its parent .* does not exist/);
  assert.match(sh, /absent and its parent .* is not writable/);
});

// --- the observing unit ------------------------------------------------------

test('pw-tmux-persist.service invokes restore WITHOUT suppressing failure', async () => {
  const unit = await fsp.readFile(path.join(REPO, 'systemd', 'pw-tmux-persist.service'), 'utf8');
  // This is what makes the distinct nonzero exit observable at all. If a `-`
  // ever appears here, a misconfigured instance goes back to looking healthy.
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/pw-tmux-restore$/m);
  assert.ok(!/ExecStart=-/.test(unit), 'the observing unit must not suppress restore failure');
});

test('the units that consume the contract load it from one place', async () => {
  for (const u of ['project-workbench.service', 'project-terminal@.service', 'project-setup-terminal.service', 'pw-tmux-persist.service']) {
    const text = await fsp.readFile(path.join(REPO, 'systemd', u), 'utf8');
    assert.match(text, /^EnvironmentFile=-\/etc\/project-workbench\/pw\.env$/m, `${u} must load the contract`);
  }
});
