// GOA-1 / HJ-24-5 — the authoritative non-secret environment contract.
//
// The failure this locks down: `pw-tmux-restore` resolved its registry, app dir and state dir from
// its own compiled-in defaults, and no persistence unit set any of them. On an instance whose
// registry is not at the default path, `resolve_session_credentials` returned 1 for EVERY session,
// the caller turned each one into `CREATED[$s]="skip"`, and the script still exited 0. A reboot
// refused to restore every session and reported success — a path mismatch that was
// indistinguishable from "there was nothing to restore".
//
// Two halves are checked here: the contract itself (app/pw-env.js — keys, defaults, parsing,
// validation, precedence) and its shell counterpart (scripts/pw-env.sh), because the entry points
// that got this wrong are shell scripts and a JS-only contract would not have caught any of it.
//
// Dependency-free by construction: no `express`, no dashboard boot, so GOA can run this file on the
// exact head without an npm registry (see scripts/pw-test-offline.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PW_ENV_KEYS, PW_ENV_PATH, defaultPwEnv, parseEnvFile, serialisePwEnv, validatePwEnv, resolvePwEnv,
} from '../app/pw-env.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_LIB = path.join(REPO, 'scripts', 'pw-env.sh');
const ENV_WRITE = path.join(REPO, 'scripts', 'pw-env-write');

/** Run a snippet with scripts/pw-env.sh sourced, in a clean-ish environment. */
async function sh(snippet, env = {}) {
  const script = `set -uo pipefail\n. ${JSON.stringify(ENV_LIB)}\n${snippet}\n`;
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

async function tmp(prefix = 'pw-env-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// --- the contract itself ------------------------------------------------------------------

test('the contract covers every path, mode and per-user value the entry points disagreed about', () => {
  const keys = PW_ENV_KEYS.map((k) => k.key);
  for (const required of [
    'PW_DEPLOY_MODE',        // the mode
    'PW_APP_DIR', 'PW_REGISTRY_PATH', 'PW_USERS_PATH', 'PW_SESSIONS_PATH',
    'PW_WORKSPACES', 'PW_AUDIT_LOG', 'PW_CANONICAL_REGISTRY', 'PW_TMUX_STATE_DIR', // the paths
    'PW_PER_USER_CLAUDE', 'PW_USER_CRED_BASE',                                     // the per-user values
    'PW_TMUX_OWNER_REQUIRED', 'TMUX_TMPDIR',                                       // the per-mode values
  ]) {
    assert.ok(keys.includes(required), `${required} must be part of the contract`);
  }
  // The four that a restore/terminal entry point genuinely cannot work without.
  const mandatory = PW_ENV_KEYS.filter((k) => k.required).map((k) => k.key).sort();
  assert.deepEqual(mandatory, ['PW_APP_DIR', 'PW_DEPLOY_MODE', 'PW_PER_USER_CLAUDE', 'PW_REGISTRY_PATH', 'PW_TMUX_STATE_DIR']);
});

test('defaults are exactly the compiled-in fallbacks they replace, per mode', () => {
  const host = defaultPwEnv('host');
  assert.equal(host.PW_REGISTRY_PATH, '/opt/project-workbench/projects.json');
  assert.equal(host.PW_APP_DIR, '/opt/project-workbench/app');
  assert.equal(host.PW_TMUX_STATE_DIR, '/var/lib/project-workbench/tmux-persist');
  assert.equal(host.PW_USER_CRED_BASE, '/home/admin/pw-users');
  assert.equal(host.PW_PER_USER_CLAUDE, 'false');
  assert.equal(host.PW_TMUX_OWNER_REQUIRED, 'true', 'host mode gates terminal creation on proven ownership');
  assert.equal(host.TMUX_TMPDIR, undefined, 'host mode must never pin a socket root — it shares the per-user default');

  const container = defaultPwEnv('container');
  assert.equal(container.TMUX_TMPDIR, '/opt/project-workbench/run/tmux', 'the sidecar bind mount');
  assert.equal(container.PW_TMUX_OWNER_REQUIRED, undefined, 'the host owner gate is meaningless in container mode');
});

test('parsing accepts the systemd/podman subset and reports anything else', () => {
  const { values, errors } = parseEnvFile([
    '# a comment',
    '',
    'PW_DEPLOY_MODE=host',
    '  PW_REGISTRY_PATH = /srv/projects.json  ',
    'PW_USERS_PATH="/srv/users.json"',
    "PW_WORKSPACES='/srv/ws'",
    'not an assignment',
    '9BAD=x',
  ].join('\n'));
  assert.equal(values.PW_DEPLOY_MODE, 'host');
  assert.equal(values.PW_REGISTRY_PATH, '/srv/projects.json');
  assert.equal(values.PW_USERS_PATH, '/srv/users.json', 'double quotes are stripped');
  assert.equal(values.PW_WORKSPACES, '/srv/ws', 'single quotes are stripped');
  assert.equal(errors.length, 2, `a typo in an authoritative file must be reported, not dropped: ${JSON.stringify(errors)}`);
});

test('validation refuses a missing required value, a bad mode, a bad flag and a relative path', () => {
  const ok = validatePwEnv(defaultPwEnv('host'), { checkPaths: false });
  assert.deepEqual(ok.errors, []);

  assert.match(validatePwEnv({ ...defaultPwEnv('host'), PW_DEPLOY_MODE: 'containr' }, { checkPaths: false }).errors.join(), /host\|container/);
  assert.match(validatePwEnv({ ...defaultPwEnv('host'), PW_PER_USER_CLAUDE: 'yes' }, { checkPaths: false }).errors.join(), /not a boolean/);
  assert.match(validatePwEnv({ ...defaultPwEnv('host'), PW_REGISTRY_PATH: 'projects.json' }, { checkPaths: false }).errors.join(), /absolute path/);

  const missing = { ...defaultPwEnv('host') };
  delete missing.PW_TMUX_STATE_DIR;
  assert.match(validatePwEnv(missing, { checkPaths: false }).errors.join(), /PW_TMUX_STATE_DIR is required/);

  const unknown = validatePwEnv({ ...defaultPwEnv('host'), PW_REGISTRY_PATHH: '/x' }, { checkPaths: false });
  assert.match(unknown.warnings.join(), /PW_REGISTRY_PATHH/, 'a near-miss key must be surfaced');
});

test('REGRESSION: a required path that does not exist is an error, not a silent no-op', () => {
  const { errors } = validatePwEnv(defaultPwEnv('host'), { exists: () => false, isDir: () => false });
  assert.match(errors.join('\n'), /PW_REGISTRY_PATH=.*does not exist/);
  assert.match(errors.join('\n'), /PW_TMUX_STATE_DIR=.*is not a directory/);
  assert.match(errors.join('\n'), /PW_APP_DIR=.*is not a directory/);
});

test('already-set environment wins over the file, which wins over the defaults', () => {
  const { values } = resolvePwEnv({
    env: { PW_REGISTRY_PATH: '/from/env.json' },
    fileText: 'PW_REGISTRY_PATH=/from/file.json\nPW_USERS_PATH=/from/file-users.json\n',
  });
  assert.equal(values.PW_REGISTRY_PATH, '/from/env.json', 'systemd has already applied EnvironmentFile= by the time a script runs');
  assert.equal(values.PW_USERS_PATH, '/from/file-users.json');
  assert.equal(values.PW_TMUX_STATE_DIR, '/var/lib/project-workbench/tmux-persist', 'unset keys keep the documented default');
});

test('the rendered file round-trips through the parser and carries no secrets', () => {
  const text = serialisePwEnv(defaultPwEnv('container'));
  const { values, errors } = parseEnvFile(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(values, defaultPwEnv('container'));
  assert.match(text, /NOTHING SECRET/);
  assert.ok(!/TOKEN|PASSWORD|SECRET_KEY|ghp_|enc:/i.test(text.replace(/NOTHING SECRET.*/i, '')),
    'the contract must never carry credential material');
});

// --- the shell half -----------------------------------------------------------------------

test('pw-env.sh loads the file, and an already-set variable is never clobbered', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'pw.env');
  await fsp.writeFile(file, '# comment\nPW_REGISTRY_PATH=/from/file.json\nPW_APP_DIR="/from/file-app"\n\n');
  const r = await sh('pw_env_load; printf "%s|%s" "$PW_REGISTRY_PATH" "$PW_APP_DIR"', {
    PW_ENV_FILE: file, PW_REGISTRY_PATH: '/already/set.json',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '/already/set.json|/from/file-app');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('pw-env.sh treats an absent file as "use the defaults", not an error', async () => {
  const r = await sh('pw_env_load && printf ok', { PW_ENV_FILE: '/nonexistent/pw.env' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'ok');
});

test('REGRESSION: pw_env_require_* exits EX_CONFIG naming the variable and the path', async () => {
  const dir = await tmp();
  const missing = path.join(dir, 'nope.json');

  const file = await sh(`PW_REGISTRY_PATH=${missing} pw_env_require_file PW_REGISTRY_PATH "the project registry"; printf reached`);
  assert.equal(file.code, 78, 'EX_CONFIG, so a unit or an operator sees a real failure');
  assert.ok(!file.stdout.includes('reached'), 'it must stop, not continue');
  assert.match(file.stderr, /PW_REGISTRY_PATH/);
  assert.match(file.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(file.stderr, /nothing to do/);

  const dirCase = await sh(`PW_TMUX_STATE_DIR=${missing} pw_env_require_dir PW_TMUX_STATE_DIR "the persistence state dir"`);
  assert.equal(dirCase.code, 78);
  assert.match(dirCase.stderr, /is not a directory/);

  const unset = await sh('pw_env_require_file PW_REGISTRY_PATH "the project registry"');
  assert.equal(unset.code, 78);
  assert.match(unset.stderr, /is not set/);

  const present = await sh(`PW_TMUX_STATE_DIR=${dir} pw_env_require_dir PW_TMUX_STATE_DIR "state"; printf ok`);
  assert.equal(present.code, 0, present.stderr);
  assert.equal(present.stdout, 'ok');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('pw_env_deploy_mode mirrors app/deploy-mode.js, including the refusals', async () => {
  assert.equal((await sh('pw_env_deploy_mode', { PW_DEPLOY_MODE: 'Container' })).stdout, 'container');
  assert.equal((await sh('pw_env_deploy_mode', { PW_DEPLOY_MODE: 'host' })).stdout, 'host');
  assert.equal((await sh('pw_env_deploy_mode')).stdout, 'host', 'a plain host install stays host');

  const typo = await sh('pw_env_deploy_mode', { PW_DEPLOY_MODE: 'containr' });
  assert.notEqual(typo.code, 0);
  assert.match(typo.stderr, /host\|container/);

  const evidence = await sh('pw_env_deploy_mode', { container: 'podman' });
  assert.notEqual(evidence.code, 0);
  assert.match(evidence.stderr, /containerised/);
});

// --- the generator ------------------------------------------------------------------------

test('pw-env-write renders both modes, and never overwrites an operator’s file without --force', async () => {
  const dir = await tmp();
  const out = path.join(dir, 'pw.env');

  await execFileAsync('node', [ENV_WRITE, '--mode', 'host', '--out', out]);
  const first = await fsp.readFile(out, 'utf8');
  assert.match(first, /^PW_DEPLOY_MODE=host$/m);
  assert.ok(!/TMUX_TMPDIR/.test(first), 'host mode must not pin a socket root');

  await fsp.writeFile(out, `${first}\n# operator tuning\nPW_PER_USER_CLAUDE=true\n`);
  const kept = await execFileAsync('node', [ENV_WRITE, '--mode', 'host', '--out', out]);
  assert.match(kept.stdout, /already exists/);
  assert.match(await fsp.readFile(out, 'utf8'), /operator tuning/, 'a re-run of the installer must not undo operator tuning');

  await execFileAsync('node', [ENV_WRITE, '--mode', 'container', '--out', out, '--force']);
  const container = await fsp.readFile(out, 'utf8');
  assert.match(container, /^PW_DEPLOY_MODE=container$/m);
  assert.match(container, /^TMUX_TMPDIR=/m);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('pw-env-write takes live values from the environment and refuses an ambiguous mode', async () => {
  const dir = await tmp();
  const out = path.join(dir, 'pw.env');
  await execFileAsync('node', [ENV_WRITE, '--out', out], {
    env: { ...process.env, PW_DEPLOY_MODE: 'host', PW_REGISTRY_PATH: '/srv/registry.json', PW_PER_USER_CLAUDE: 'true' },
  });
  const text = await fsp.readFile(out, 'utf8');
  assert.match(text, /^PW_REGISTRY_PATH=\/srv\/registry\.json$/m);
  assert.match(text, /^PW_PER_USER_CLAUDE=true$/m);

  await assert.rejects(
    () => execFileAsync('node', [ENV_WRITE, '--out', path.join(dir, 'x.env')], {
      env: { ...process.env, PW_DEPLOY_MODE: 'containr' },
    }),
    (e) => e.code === 78 && /PW_DEPLOY_MODE/.test(e.stderr),
    'the generator must not invent a mode either',
  );

  await fsp.rm(dir, { recursive: true, force: true });
});

test('pw-env-write --check validates a real file and exits non-zero on a broken one', async () => {
  const dir = await tmp();
  const good = path.join(dir, 'good.env');
  const state = path.join(dir, 'state');
  const registry = path.join(dir, 'projects.json');
  await fsp.mkdir(state);
  await fsp.writeFile(registry, '[]');
  await fsp.writeFile(good, serialisePwEnv({
    ...defaultPwEnv('host'), PW_APP_DIR: path.join(REPO, 'app'), PW_REGISTRY_PATH: registry, PW_TMUX_STATE_DIR: state,
  }));
  const ok = await execFileAsync('node', [ENV_WRITE, '--check', '--out', good]);
  assert.match(ok.stdout, /ok \(/);

  const bad = path.join(dir, 'bad.env');
  await fsp.writeFile(bad, 'PW_DEPLOY_MODE=host\nPW_APP_DIR=/nope\nPW_REGISTRY_PATH=/nope.json\nPW_TMUX_STATE_DIR=/nope\nPW_PER_USER_CLAUDE=false\n');
  await assert.rejects(
    () => execFileAsync('node', [ENV_WRITE, '--check', '--out', bad]),
    (e) => e.code === 78 && /does not exist|is not a directory/.test(e.stderr),
  );

  await fsp.rm(dir, { recursive: true, force: true });
});

test('the committed example matches what the generator produces for a host install', () => {
  // Documentation drifting away from the generator is how an operator ends up hand-writing a file
  // with a key the product no longer reads.
  const example = fs.readFileSync(path.join(REPO, 'config', 'pw.env.example'), 'utf8');
  assert.equal(example, serialisePwEnv(defaultPwEnv('host')));
  assert.equal(PW_ENV_PATH, '/etc/project-workbench/pw.env');
});

// --- the units that consume it ---------------------------------------------------------------

const SYSTEMD = path.join(REPO, 'systemd');
const unit = (name) => fs.readFileSync(path.join(SYSTEMD, name), 'utf8');

test('REGRESSION: every host-mode entry point loads the contract via EnvironmentFile=', () => {
  // HJ-24-5's evidence, as an invariant. pw-tmux-persist.service (and the new owner unit) used to
  // set only HOME/LANG/LC_ALL, so the restore entrypoint could not see PW_PER_USER_CLAUDE,
  // PW_REGISTRY_PATH, PW_APP_DIR or PW_USER_CRED_BASE at all.
  for (const name of [
    'project-workbench.service',      // the dashboard
    'project-terminal@.service',      // terminal creation
    'project-setup-terminal.service', // the setup/auth terminal
    'pw-tmux-persist.service',        // persistence restore + snapshot
    'pw-tmux-save.service',           // the periodic snapshot
    'pw-tmux-server.service',         // the dedicated host owner (runs pw-tmux-restore on start)
  ]) {
    assert.match(unit(name), /^EnvironmentFile=-?\/etc\/project-workbench\/pw\.env$/m,
      `${name} must read the authoritative environment contract`);
  }
});

test('container mode receives the same contract through its supported env-file mechanism', () => {
  const sidecar = unit('pw-tmux.service');
  assert.match(sidecar, /--env-file=\/etc\/project-workbench\/pw\.env/,
    'the sidecar owns the tmux server and runs the same keepalive; it needs the same values');
  assert.match(sidecar, /pw-env-write/, 'the unit must say how the file is produced');
});

test('the contract file itself carries no secret material', () => {
  const example = fs.readFileSync(path.join(REPO, 'config', 'pw.env.example'), 'utf8');
  for (const forbidden of [/PW_SECRET_KEY/, /ghToken/, /PW_INTERNAL_HANDOFF_TOKEN/, /PW_BOOTSTRAP_ADMIN_PASSWORD/, /PW_LDAP_BIND/]) {
    assert.ok(!forbidden.test(example), `the contract must never carry ${forbidden}`);
  }
});

test('install.sh ships the shell half and generates the contract without clobbering operator edits', () => {
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.match(sh, /pw-env\.sh"?\s+\/usr\/local\/lib\/pw-env\.sh/,
    'the entry points source /usr/local/lib/pw-env.sh once installed');
  assert.match(sh, /pw-env-write/, 'the installer must generate the contract');
  assert.ok(!/pw-env-write[^\n]*--force/.test(sh),
    'a re-run of the installer must never overwrite an operator’s tuned contract');
});

test('REGRESSION: a key that does not apply to the mode is never written, whatever the ambient environment says', async (t) => {
  // Found by the offline runner (scripts/pw-test-offline.mjs), which pins TMUX_TMPDIR to an isolated
  // socket root. The generator copies live environment values, so `pw-env-write --mode host` run
  // from ANY shell with TMUX_TMPDIR set — a tmux pane, a test harness, a container-oriented
  // developer's terminal — wrote a socket root into a HOST contract. Host mode has to share the
  // per-user default socket with project-terminal-start and app/server.js; a pinned root there is
  // the "second, invisible server that no terminal ever attaches to" the keepalive warns about, and
  // every session would look lost.
  const dir = await tmp();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'pw.env');

  await execFileAsync('node', [ENV_WRITE, '--mode', 'host', '--out', out], {
    env: { ...process.env, TMUX_TMPDIR: '/some/ambient/socket/root', PW_TMUX_OWNER_REQUIRED: 'true' },
  });
  const host = await fsp.readFile(out, 'utf8');
  assert.ok(!/TMUX_TMPDIR/.test(host), 'a container-only key must not reach a host contract');
  assert.match(host, /^PW_TMUX_OWNER_REQUIRED=true$/m, 'and a host-only key must still be written');

  // The mirror image: a host-only key must not reach a container contract.
  await execFileAsync('node', [ENV_WRITE, '--mode', 'container', '--out', out, '--force'], {
    env: { ...process.env, TMUX_TMPDIR: '/opt/project-workbench/run/tmux', PW_TMUX_OWNER_REQUIRED: 'true' },
  });
  const container = await fsp.readFile(out, 'utf8');
  assert.ok(!/PW_TMUX_OWNER_REQUIRED/.test(container), 'the host owner gate is meaningless in container mode');
  assert.match(container, /^TMUX_TMPDIR=\/opt\/project-workbench\/run\/tmux$/m);

  // And serialisation filters on the mode it is given, not on what happens to be in the object.
  assert.ok(!/TMUX_TMPDIR/.test(serialisePwEnv({ ...defaultPwEnv('host'), TMUX_TMPDIR: '/x' }, { mode: 'host' })));
});
