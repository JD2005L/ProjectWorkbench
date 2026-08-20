// What `deploy-local.sh` actually promotes, against the closure `app/server.js`
// actually needs.
//
// THE DEFECT. All three promotion paths copied a hand-listed SUBSET of the app
// tree — `app/server.js`, `app/orchestrator/`, `scripts/*` — and nothing else.
// That worked only because every other module server.js imports happened to be
// present in the live tree already. It had already failed once (hence the
// comment at the orchestrator copy: "copying server.js alone leaves the live app
// unable to start at all"), and it failed again the moment server.js gained
// `./workspace-file.js` and `./workspace-writer.mjs`: the promoted artifact dies
// with ERR_MODULE_NOT_FOUND before it can serve anything.
//
// A hand-maintained subset cannot be made safe by adding two more filenames to
// it — the next module will be omitted the same way. So the contract tested here
// is a CLOSURE contract, derived from the real import graph and the real tracked
// tree rather than from a list:
//
//   every promotion path must land the complete tracked app runtime closure,
//   excluding node_modules and untracked runtime state, such that the promoted
//   artifact can actually start.
//
// NOTHING PRODUCTION MAY BE TOUCHED, AND THAT IS ENFORCED BEFORE EXECUTION.
//
// The first run of this harness DID touch the live deployment, and that is
// recorded here as a harness defect rather than as evidence of anything. The
// inside-container path writes to LIVE_APP, which was a hardcoded
// /opt/project-workbench/app with no override, so pointing the harness at a temp
// tree did nothing: the script promoted into the live app directory. Recovery
// was performed and independently verified out of band.
//
// The lesson is the gate below. A safety property that is only checked by
// assertions AFTER the command runs is not a safety property — by then the write
// has happened. So `runDeploy` refuses to invoke deploy-local.sh at all unless
// the script demonstrably routes every destination through an overridable
// variable (assertInjectableTargets), and the refusal is a test failure with
// nothing executed. On top of that:
//
//   - every destination is a private temp tree, asserted to be under os.tmpdir()
//   - `sudo`, `podman`, `systemctl`, `tmux` and `pgrep` are replaced by stubs on
//     PATH; the faked `pgrep` is what makes restart_pw_node find no processes to
//     signal, so no real node/systemd/podman/tmux is ever touched
//   - service/container/image names are overridden to names that exist nowhere
//   - the live app directory is fingerprinted before and after every invocation
//     and asserted unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { selfOwnedTerminalEnv } from './terminal-owner-fixture.mjs';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEPLOY_LOCAL = path.join(REPO, 'deploy-local.sh');
const APP = path.join(REPO, 'app');

// ---------------------------------------------------------------------------
// What the app actually needs
// ---------------------------------------------------------------------------

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Every local module reachable from an entry point, as app-relative paths.
 *
 * Derived from the source rather than declared, so a module added to server.js
 * tomorrow is covered by this test the day it lands — which is precisely what a
 * hand-maintained copy list cannot do.
 */
function importClosure(entryAbs) {
  const seen = new Set();
  const queue = [entryAbs];
  while (queue.length) {
    const file = queue.shift();
    const rel = path.relative(APP, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const [, spec] of src.matchAll(SPECIFIER)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/** Every tracked file under app/ in a checkout, as app-relative paths. */
function trackedAppFiles(repoDir) {
  return execFileSync('git', ['-C', repoDir, 'ls-files', '--', 'app/'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((f) => f.slice('app/'.length)).sort();
}

/** Every file actually present in a promoted tree, ignoring the live node_modules. */
function promotedFiles(appDir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
      const next = rel ? path.join(rel, e.name) : e.name;
      if (next === 'node_modules') continue;
      if (e.isDirectory()) walk(next); else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

// ---------------------------------------------------------------------------
// A disposable stage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The gate that must hold BEFORE the script is allowed to run
// ---------------------------------------------------------------------------

const DEFAULT_LIVE_APP = '/opt/project-workbench/app';

/**
 * The injectable-target contract, checked against the script SOURCE.
 *
 * Every destination deploy-local.sh writes to has to be resolvable to a
 * disposable path by the caller. Without this the inside-container path resolves
 * LIVE_APP to the live deployment no matter what the harness passes, and running
 * it is a production write — which is exactly what happened the first time.
 *
 * Takes the source text so the gate itself can be proven capable of failing.
 */
export function missingInjectableTargets(src) {
  const required = [
    ['LIVE_APP', /^LIVE_APP="\$\{PW_LIVE_APP:-\/opt\/project-workbench\/app\}"/m],
    ['LIVE_SCRIPTS', /^LIVE_SCRIPTS="\$\{PW_LIVE_SCRIPTS:-\/opt\/project-workbench\/scripts\}"/m],
    ['SRC', /^SRC="\$\{PW_SOURCE_DIR:-[^"]+\}"/m],
  ];
  return required.filter(([, re]) => !re.test(src)).map(([name]) => name);
}

/**
 * A cheap fingerprint of the live app directory — read-only, and absent on a
 * runner that has no deployment, where there is nothing to protect.
 */
function liveFingerprint() {
  try {
    return fs.readdirSync(DEFAULT_LIVE_APP, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules')
      .map((e) => {
        const st = fs.lstatSync(path.join(DEFAULT_LIVE_APP, e.name));
        return `${e.name}:${st.size}:${st.mtimeMs}:${st.ino}`;
      })
      .sort().join('\n');
  } catch {
    return null;
  }
}

/**
 * PATH stubs for everything the script would otherwise run for real. `sudo`
 * simply execs its argv (the temp trees belong to this user); `podman`,
 * `systemctl` and `tmux` only record that they were called; and `pgrep` reports
 * nothing, which is what keeps restart_pw_node from signalling any real process.
 */
function stubBin(dir, logFile) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sudo'), `#!/usr/bin/env bash
printf 'sudo %s\\n' "$*" >> ${JSON.stringify(logFile)}
# -n / -u are never used by deploy-local.sh; refuse rather than guess.
case "$1" in -*) printf 'REFUSED unexpected sudo flag: %s\\n' "$*" >> ${JSON.stringify(logFile)}; exit 64;; esac
exec "$@"
`, { mode: 0o755 });
  for (const name of ['podman', 'systemctl', 'tmux']) {
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash
printf '${name} %s\\n' "$*" >> ${JSON.stringify(logFile)}
exit 0
`, { mode: 0o755 });
  }
  // No PIDs, so restart_pw_node's loop body never runs and nothing is signalled.
  fs.writeFileSync(path.join(dir, 'pgrep'), `#!/usr/bin/env bash
printf 'pgrep %s\\n' "$*" >> ${JSON.stringify(logFile)}
exit 1
`, { mode: 0o755 });
}

/**
 * Untracked and ignored state an operator or a stray process can leave in `app/`.
 *
 * NONE of it may be promoted. A manifest built from `ls -A` copies every one of
 * these — which is how a local `.env`, a scratch credential or an operator
 * directory ends up published into a live deployment. Only Git-tracked content
 * is app source.
 */
const SENTINELS = [
  '.env',
  '.secret-key',
  'local-notes.txt',
  'operator-state/scratch.txt',
  'orchestrator/.env.local',
  'node_modules/marker.txt',
];

/**
 * A disposable checkout of this repository's tracked app/scripts/deploy-local.sh,
 * committed so "tracked" is a real Git fact, then polluted with SENTINELS so
 * "untracked" is a real Git fact too.
 */
function makeSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  // Copy the working tree's app/, scripts/ and the script itself — deliberately
  // NOT via git ls-files, which is the mechanism under test.
  execFileSync('bash', ['-c',
    `set -e; cd ${JSON.stringify(REPO)}; tar -c --exclude=./app/node_modules -f - ./app ./scripts ./deploy-local.sh ./Containerfile .gitignore `
    + `| tar -x -C ${JSON.stringify(dir)}`], { timeout: 120000 });

  // The script under test must be this repository's, byte for byte.
  assert.equal(
    fs.readFileSync(path.join(dir, 'deploy-local.sh'), 'utf8'),
    fs.readFileSync(DEPLOY_LOCAL, 'utf8'),
    'the disposable checkout must carry the real deploy-local.sh, unmodified',
  );

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'tracked app tree');

  // Planted AFTER the commit, so every one of these is genuinely untracked or
  // ignored rather than merely named in a list.
  for (const rel of SENTINELS) {
    const full = path.join(dir, 'app', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `SENTINEL ${rel} — must never be promoted\n`);
  }
  const untracked = git('status', '--porcelain', '--ignored', '--', 'app/').trim();
  for (const rel of SENTINELS) {
    assert.ok(untracked.includes(rel.split('/')[0]), `sanity: app/${rel} must be untracked or ignored in the fixture`);
  }
  return dir;
}

/**
 * A stage with a source tree (`$SRC`, what --full and the host hot path write
 * into) and a live tree (`$LIVE_APP`, what the inside-container path writes
 * into), each optionally pre-seeded.
 *
 * `node_modules` is symlinked rather than copied: the live tree already has its
 * dependencies installed, which is exactly why a promotion must NOT ship them —
 * and it lets the promoted artifact actually start.
 *
 * The SOURCE the script promotes FROM is a disposable checkout too, not this
 * repository. That is what makes it possible to plant untracked and ignored
 * state in `app/` and require that a promotion leaves it behind — which cannot
 * be tested against the real working tree without writing secret-shaped files
 * into it.
 */
function makeStage({ seed = 'empty' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-promote-')));
  const stage = {
    root,
    repo: makeSourceRepo(path.join(root, 'repo')),
    src: path.join(root, 'source'),
    srcApp: path.join(root, 'source', 'app'),
    srcScripts: path.join(root, 'source', 'scripts'),
    live: path.join(root, 'live', 'app'),
    liveScripts: path.join(root, 'live', 'scripts'),
    bin: path.join(root, 'bin'),
    log: path.join(root, 'commands.log'),
  };
  for (const d of [stage.srcApp, stage.srcScripts, stage.live, stage.liveScripts]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(stage.log, '');
  stubBin(stage.bin, stage.log);

  if (seed === 'stale') {
    // The faithful reported shape: the live tree carries the PREVIOUS release,
    // so only what this branch added is missing. `git archive` of the merge base
    // is that release, without hardcoding which files are new.
    const base = execFileSync('git', ['-C', REPO, 'merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim();
    for (const dest of [stage.srcApp, stage.live]) {
      const tar = execFileSync('git', ['-C', REPO, 'archive', base, 'app/'], { maxBuffer: 256 * 1024 * 1024 });
      execFileSync('tar', ['-x', '--strip-components=1', '-C', dest], { input: tar });
    }
  }
  for (const dest of [stage.srcApp, stage.live]) {
    fs.symlinkSync(path.join(APP, 'node_modules'), path.join(dest, 'node_modules'));
  }
  return stage;
}

const cleanup = (stage) => fs.rmSync(stage.root, { recursive: true, force: true });

/**
 * Run the real deploy-local.sh in one of its three shapes, against the stage
 * only — or REFUSE, before executing anything, if the script cannot be aimed
 * away from the live deployment.
 */
function runDeploy(stage, { full = false, insideContainer = false } = {}) {
  // The gate, first and unconditionally. A failure here means nothing ran.
  const missing = missingInjectableTargets(fs.readFileSync(DEPLOY_LOCAL, 'utf8'));
  assert.deepEqual(missing, [],
    'REFUSING to run deploy-local.sh: it does not expose overridable destination(s) '
    + `${missing.join(', ')}, so a promotion would write into the live deployment. `
    + 'Nothing was executed.');

  // Belt and braces: whatever we are about to pass must be disposable.
  const tmp = fs.realpathSync(os.tmpdir());
  for (const target of [stage.src, stage.live, stage.liveScripts]) {
    assert.ok(target.startsWith(tmp), `refusing to aim a promotion at ${target}, which is not under ${tmp}`);
  }
  const before = liveFingerprint();

  const env = {
    PATH: `${stage.bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    // Inside-container detection is "$SRC/app does not exist". Point it at a
    // path that cannot exist to take that branch.
    PW_SOURCE_DIR: insideContainer ? path.join(stage.root, 'no-such-source') : stage.src,
    PW_LIVE_APP: stage.live,
    PW_LIVE_SCRIPTS: stage.liveScripts,
    // Names that exist nowhere, so a stub that somehow failed to intercept still
    // could not reach a real unit, container or image.
    PW_SERVICE: 'pw-promotion-test-nonexistent.service',
    PW_CONTAINER: 'pw-promotion-test-nonexistent',
    PW_IMAGE: 'pw-promotion-test-nonexistent:latest',
  };
  // Run the script FROM the disposable checkout: it resolves REPO_DIR from its
  // own location, so this is what makes the promotion SOURCE controllable. The
  // bytes are asserted identical to this repository's copy in makeSourceRepo.
  const script = path.join(stage.repo, 'deploy-local.sh');
  const res = execFileSync('bash', [script, ...(full ? ['--full'] : [])], {
    cwd: stage.repo, env, input: 'y\n', encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
  });

  assert.equal(liveFingerprint(), before, 'the live app directory must be byte-for-byte untouched by a promotion test');
  const commands = fs.readFileSync(stage.log, 'utf8');
  // Only FILESYSTEM-MUTATING commands are checked for the live path. The host
  // hot path ends with a `podman exec … bash -c` whose inline snippet names
  // /opt/project-workbench/app on purpose — that is the path INSIDE the
  // container, it is stubbed here, and mentioning it is not a write.
  const mutating = commands.split('\n').filter((l) => /^sudo (cp|mkdir|mv|rm|install|tee)\b/.test(l));
  assert.deepEqual(mutating.filter((l) => l.includes(DEFAULT_LIVE_APP)), [],
    'no promotion command may write into the live deployment');
  return { stdout: res, commands };
}

// ---------------------------------------------------------------------------
// Does the promoted artifact actually resolve its own imports?
// ---------------------------------------------------------------------------

/**
 * Start the PROMOTED server.js — not the repo's — on a private, isolated
 * instance, and report whether it came up. This is the check a closure
 * assertion cannot fake: a missing module is a hard ERR_MODULE_NOT_FOUND at
 * startup, which is exactly how the defect presented in production.
 */
async function bootPromoted(appDir, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-promote-run-'));
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    PW_ISOLATED: '1',
    PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
    PW_USERS_PATH: path.join(dir, 'users.json'),
    PW_SESSIONS_PATH: path.join(dir, 'sessions.json'),
    PW_WORKSPACES: path.join(dir, 'workspaces'),
    PW_SECRET_KEY_PATH: path.join(dir, '.secret-key'),
    PW_DEPLOY_CONFIG: path.join(dir, 'deploy-config.json'),
    PW_DEPLOY_LOG: path.join(dir, 'deploy-log.jsonl'),
    PW_AUDIT_LOG: path.join(dir, 'audit.log'),
    ...selfOwnedTerminalEnv(),
  };
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  let up = false;
  try {
    for (let i = 0; i < 80 && !up; i++) {
      if (child.exitCode !== null) break;
      try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 125));
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => {
      const tk = spawn('tmux', ['-L', `pwprev-${child.pid}`, 'kill-server']);
      tk.on('exit', resolve);
      tk.on('error', resolve);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { up, log: logs.join('') };
}

/** Every closure member is present in the promoted tree, named individually when not. */
function assertClosurePresent(appDir, label) {
  const closure = importClosure(path.join(APP, 'server.js'));
  const missing = closure.filter((rel) => !fs.existsSync(path.join(appDir, rel)));
  assert.deepEqual(missing, [], `${label}: the promoted tree cannot resolve server.js's imports; missing ${missing.join(', ')}`);
  // Runtime data that no import statement mentions: version.js reads ./VERSION,
  // and without package.json's "type":"module" node refuses every .js here.
  for (const extra of ['VERSION', 'package.json']) {
    assert.ok(fs.existsSync(path.join(appDir, extra)), `${label}: ${extra} must travel with the app`);
  }
}

// ---------------------------------------------------------------------------

test('the harness refuses to run a script it cannot aim away from the live deployment', () => {
  // This gate is the whole reason the harness is safe, so it has to be shown
  // capable of failing. The first shape below is what deploy-local.sh looked
  // like when running this harness wrote into the live app directory.
  const hardcoded = 'SRC="${PW_SOURCE_DIR:-/opt/project-workbench/source}"\n'
    + 'LIVE_APP="/opt/project-workbench/app"\n'
    + 'LIVE_SCRIPTS="/opt/project-workbench/scripts"\n';
  assert.deepEqual(missingInjectableTargets(hardcoded), ['LIVE_APP', 'LIVE_SCRIPTS'],
    'a hardcoded destination must be reported, and reported BEFORE anything runs');

  const injectable = 'SRC="${PW_SOURCE_DIR:-/opt/project-workbench/source}"\n'
    + 'LIVE_APP="${PW_LIVE_APP:-/opt/project-workbench/app}"\n'
    + 'LIVE_SCRIPTS="${PW_LIVE_SCRIPTS:-/opt/project-workbench/scripts}"\n';
  assert.deepEqual(missingInjectableTargets(injectable), []);

  // And the default must stay the live path: this seam exists to be overridable
  // in a test, not to change where a real operator's deploy lands.
  assert.match(fs.readFileSync(DEPLOY_LOCAL, 'utf8'), /PW_LIVE_APP:-\/opt\/project-workbench\/app/,
    'the production default must be unchanged');
});

test('deploy-local.sh is syntactically valid', async () => {
  await execFileAsync('bash', ['-n', DEPLOY_LOCAL]);
});

test('sanity: server.js imports more than the hand-listed subset the script used to copy', () => {
  const closure = importClosure(path.join(APP, 'server.js'));
  assert.ok(closure.includes('server.js'), 'the entry point is in its own closure');
  assert.ok(closure.some((f) => f.startsWith('orchestrator/')), 'the orchestrator subtree is reachable');
  const topLevel = closure.filter((f) => !f.includes('/') && f !== 'server.js');
  assert.ok(topLevel.length > 5,
    `server.js depends on ${topLevel.length} sibling modules; a copy list naming only server.js cannot be right`);
});

const PATHS = [
  { label: '--full staging', opts: { full: true }, dest: (s) => s.srcApp, scripts: (s) => s.srcScripts },
  { label: 'hot deploy from the host', opts: {}, dest: (s) => s.srcApp, scripts: (s) => s.srcScripts },
  { label: 'hot deploy inside the container', opts: { insideContainer: true }, dest: (s) => s.live, scripts: (s) => s.liveScripts },
];

let nextPort = 3981;

for (const { label, opts, dest, scripts } of PATHS) {
  for (const seed of ['empty', 'stale']) {
    test(`${label} promotes the complete runtime closure (${seed} destination)`, { timeout: 120000 }, async () => {
      const stage = makeStage({ seed });
      try {
        const { commands } = runDeploy(stage, opts);
        const appDir = dest(stage);

        assertClosurePresent(appDir, `${label}/${seed}`);

        // The manifest contract: exactly the tracked files, nested paths
        // included — not a top-level name list, and nothing untracked.
        const expected = trackedAppFiles(stage.repo);
        assert.ok(expected.includes('orchestrator/store/repo.js'), 'sanity: the manifest reaches nested modules');
        if (seed === 'empty') {
          // Exact parity is only meaningful against a destination that started
          // empty; a stale one legitimately still holds the previous release.
          const surplus = promotedFiles(appDir).filter((f) => !expected.includes(f));
          assert.deepEqual(surplus, [],
            `${label}: these were promoted but are not tracked app source: ${surplus.join(', ')}`);
        }
        const absent = expected.filter((f) => !fs.existsSync(path.join(appDir, f)));
        assert.deepEqual(absent, [], `${label}/${seed}: tracked app files were not promoted: ${absent.join(', ')}`);

        // Paths, modes and symlinks survive the promotion. A tracked mode
        // matters: scripts/ ships executables, and app/ could tomorrow.
        for (const rel of ['VERSION', 'server.js', 'orchestrator/store/repo.js']) {
          const from = fs.lstatSync(path.join(stage.repo, 'app', rel));
          const to = fs.lstatSync(path.join(appDir, rel));
          assert.equal(to.mode & 0o7777, from.mode & 0o7777, `${label}: mode of ${rel} must be preserved`);
          assert.equal(to.isSymbolicLink(), from.isSymbolicLink(), `${label}: link-ness of ${rel} must be preserved`);
        }
        const trackedLinks = expected.filter((f) => fs.lstatSync(path.join(stage.repo, 'app', f)).isSymbolicLink());
        for (const link of trackedLinks) {
          assert.equal(fs.lstatSync(path.join(appDir, link)).isSymbolicLink(), true,
            `${label}: tracked symlink ${link} must arrive as a symlink, not as a copy of its target`);
        }

        // Untracked and ignored state stays where it was.
        for (const rel of SENTINELS) {
          assert.equal(fs.existsSync(path.join(appDir, rel)), false,
            `${label}/${seed}: app/${rel} is untracked or ignored and must NEVER be promoted`);
        }

        // node_modules is the live tree's own; a promotion must not ship or
        // clobber it.
        assert.equal(fs.lstatSync(path.join(appDir, 'node_modules')).isSymbolicLink(), true,
          'the live tree keeps its own installed dependencies');
        assert.equal(commands.includes('node_modules'), false, 'no command may name node_modules');

        // scripts still land where they are meant to.
        assert.ok(fs.existsSync(path.join(scripts(stage), 'entrypoint.sh')), `${label}: scripts must still be promoted`);

        // And the promoted artifact starts, which is the check a file list cannot fake.
        const boot = await bootPromoted(appDir, nextPort++);
        assert.ok(boot.up, `${label}/${seed}: the promoted artifact must start\n--- log ---\n${boot.log}`);
        assert.equal(boot.log.includes('ERR_MODULE_NOT_FOUND'), false, boot.log);
      } finally { cleanup(stage); }
    });
  }
}

test('session-safe semantics: only the --full path rebuilds or restarts the service', { timeout: 120000 }, async () => {
  for (const { label, opts } of PATHS) {
    const stage = makeStage({ seed: 'stale' });
    try {
      const { commands: cmds } = runDeploy(stage, opts);
      if (opts.full) {
        assert.match(cmds, /podman build/, `${label}: --full still rebuilds the image`);
        assert.match(cmds, /systemctl .*restart/, `${label}: --full still restarts the service`);
      } else {
        // Matched against logged INVOCATIONS (each stub logs `<name> <args>`),
        // not against the command text: `app/tmux-owner.js` is a file being
        // promoted, not a tmux call.
        const invoked = (bin) => new RegExp(`^(sudo )?${bin}\\b`, 'm').test(cmds);
        assert.equal(/podman build/.test(cmds), false, `${label}: a hot deploy must never rebuild the image`);
        assert.equal(invoked('systemctl'), false, `${label}: a hot deploy must never restart the service`);
        assert.equal(invoked('tmux'), false, `${label}: a hot deploy must never touch tmux sessions`);
      }
    } finally { cleanup(stage); }
  }
});

test('MUTATION CONTROL: omitting any one imported module makes the promoted artifact unresolvable', { timeout: 120000 }, async () => {
  // Without this, "it started" proves nothing — a boot check that cannot fail is
  // not a check. Each control removes exactly one module from an otherwise
  // complete promotion and demands the specific failure the reviewer reproduced.
  const closure = importClosure(path.join(APP, 'server.js'));
  const victims = closure.filter((f) => f !== 'server.js').sort().slice(0, 2);
  assert.equal(victims.length, 2, 'the closure must have modules to remove');

  for (const victim of victims) {
    const stage = makeStage({ seed: 'stale' });
    try {
      runDeploy(stage, {});
      const appDir = stage.srcApp;
      assert.ok(fs.existsSync(path.join(appDir, victim)), `${victim} must have been promoted before it can be removed`);
      fs.rmSync(path.join(appDir, victim));

      const boot = await bootPromoted(appDir, nextPort++);
      assert.equal(boot.up, false, `removing ${victim} must break the promoted artifact, or this check has no teeth`);
      assert.match(boot.log, /ERR_MODULE_NOT_FOUND/, `removing ${victim} must fail exactly as the reviewer reproduced`);
      assert.ok(boot.log.includes(path.basename(victim)), `the failure must name ${victim}:\n${boot.log}`);
    } finally { cleanup(stage); }
  }
});

test('the promoted artifact carries the release identifier this checkout ships', { timeout: 120000 }, async () => {
  // A promotion that silently keeps the old app/VERSION makes every downstream
  // answer wrong — the cockpit footer, the deploy log, an operator comparing
  // environments. No import mentions VERSION, so a closure walk cannot see it;
  // and version.js REFUSES a missing or malformed one, so a successful boot is
  // itself evidence that a valid VERSION travelled with the app.
  const stage = makeStage({ seed: 'stale' });
  try {
    const expected = fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim();
    const stale = fs.readFileSync(path.join(stage.srcApp, 'VERSION'), 'utf8').trim();
    assert.notEqual(expected, stale, 'this checkout must ship a release identifier the seeded tree does not have');

    runDeploy(stage, {});

    assert.equal(fs.readFileSync(path.join(stage.srcApp, 'VERSION'), 'utf8').trim(), expected,
      `the promoted artifact must carry ${expected}, not the stale ${stale}`);
    const boot = await bootPromoted(stage.srcApp, nextPort++);
    assert.ok(boot.up, `and version.js must accept it at startup\n--- log ---\n${boot.log}`);
  } finally { cleanup(stage); }
});
