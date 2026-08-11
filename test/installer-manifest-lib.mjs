// The installer manifest, derived from install.sh and the unit files themselves.
//
// Shared by test/installer-manifest.test.mjs (does install.sh ship everything the
// installed units and seams reach?) and test/installer-host-smoke.test.mjs (does
// the staged result actually execute?). It lives outside the `*.test.mjs` glob on
// purpose — `npm test` collects `../test/*.test.mjs`, so importing a test file
// from a test file would register its cases twice.
//
// Nothing here is hand-curated. Every set is read out of a real file, because the
// defect this exists to prevent — a helper referenced by a unit that install.sh
// never ships — is precisely what a hand-maintained list forgets.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/**
 * The default install prefix, taken from install.sh rather than repeated here, so
 * a change of prefix cannot silently stop the $APP_DIR branch from matching.
 */
export function installPrefix(installSh) {
  const m = /^PW_INSTALL_DIR="\$\{PW_INSTALL_DIR:-([^}"]+)\}"/m.exec(installSh);
  if (!m) throw new Error('install.sh no longer declares a default PW_INSTALL_DIR');
  return m[1];
}

/**
 * Unit files install.sh copies to /etc/systemd/system. Drop-ins are included: a
 * drop-in can carry Exec* directives too.
 *
 * Deliberately NOT "every file in systemd/". systemd/pw-tmux.service is the
 * container sidecar, which install.sh never installs and refuses to run beside —
 * holding a host installer responsible for a container unit's paths would be
 * wrong, and would have forced this check to be weakened until it passed.
 */
export function installedUnits(installSh) {
  // Two shapes: a verbatim `install -m 0644`, and `render_unit`, which substitutes
  // the deployment's prefix and account before writing. Both must be in scope, or
  // moving a unit to the rendering path would silently drop it out of every check.
  return [...installSh.matchAll(/(?:install\s+-m\s+0644|render_unit)\s+"\$SRC_DIR\/(systemd\/[^"]+)"\s+(\/etc\/systemd\/system\/\S+)/g)]
    .map((m) => ({ source: m[1], dest: m[2] }));
}

/**
 * The placeholders install.sh substitutes when it renders a unit, and the values a
 * default install would give them.
 *
 * `PW_INSTALL_DIR` is an advertised override. Until units were rendered, every
 * `/opt/project-workbench` in a unit file was a literal, so setting the override
 * produced an install whose units pointed at a tree that was never populated —
 * the advertised knob was a lie. The same applies to the account: the owner unit
 * must name the account the installer actually created.
 */
export function installDefaults(installSh) {
  const user = /^PW_USER=([A-Za-z0-9._-]+)/m.exec(installSh);
  if (!user) throw new Error('install.sh no longer declares PW_USER');
  return { prefix: installPrefix(installSh), user: user[1], home: `/home/${user[1]}` };
}

export function renderUnit(text, { prefix, user, home }) {
  return text
    .replaceAll('@PW_INSTALL_DIR@', prefix)
    .replaceAll('@PW_USER@', user)
    .replaceAll('@PW_GROUP@', user)
    .replaceAll('@PW_HOME@', home);
}

/** Any placeholder left unrendered — a live unit must never contain one. */
export function unrenderedPlaceholders(text) {
  return [...new Set([...text.matchAll(/@[A-Z][A-Z0-9_]*@/g)].map((m) => m[0]))];
}

/** Executables install.sh installs, keyed by destination path. */
export function helperManifest(installSh) {
  const manifest = new Map();
  for (const m of installSh.matchAll(/install\s+-m\s+([0-7]{3,4})\s+"\$SRC_DIR\/(scripts\/[^"]+)"\s+(\S+)/g)) {
    manifest.set(m[3], { mode: parseInt(m[1], 8), source: m[2] });
  }
  return manifest;
}

/**
 * Every program a unit will execute.
 *
 * systemd allows a line continuation, and allows any run of the prefix characters
 * `-@+!:` before the path (`ExecStartPre=-/usr/bin/podman …`). Both are handled,
 * because a parser that quietly dropped a continued or prefixed ExecStart would be
 * a check that cannot fail — the exact failure mode this file is here to end.
 */
export function execProgramsIn(unitText) {
  const joined = unitText.replace(/\\\n\s*/g, ' ');
  const programs = [];
  for (const line of joined.split('\n')) {
    const m = /^\s*(Exec(?:Start|StartPre|StartPost|Stop|StopPost|Reload|Condition))\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (!value) continue; // `ExecStart=` on its own resets the list
    const argv = value.replace(/^[-@+!:]+/, '').trim().split(/\s+/);
    // A bare name is resolved from $PATH and is covered by the seam derivation.
    if (!argv[0] || !argv[0].startsWith('/')) continue;
    programs.push({ directive: m[1], program: argv[0], argv });
  }
  return programs;
}

/** `Environment=K=V` lines, in unit order. */
export function unitEnvironment(unitText) {
  const env = {};
  for (const m of unitText.replace(/\\\n\s*/g, ' ').matchAll(/^\s*Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return env;
}

/**
 * Helpers the seams invoke. A seam reaches a helper one of two ways: by bare name
 * through $PATH (`command -v pw-tmux-assert-owner`), or by absolute /usr/local
 * path. Both are read out of the sources.
 */
export function seamFiles() {
  // RECURSIVE, and `.mjs` as well as `.js`. A flat readdir of app/ missed every
  // orchestrator seam — app/orchestrator/config.js names /usr/local/bin/claude —
  // so a helper reached only from a subdirectory was invisible to this audit.
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(child);
      } else if (entry.isFile() && (rel.startsWith('scripts') || /\.(js|mjs)$/.test(entry.name))) {
        out.push(child);
      }
    }
  };
  walk('scripts');
  walk('app');
  return out;
}

export function seamReferences() {
  const refs = new Map(); // name -> Set(seam files)
  const note = (name, file) => {
    if (!refs.has(name)) refs.set(name, new Set());
    refs.get(name).add(file);
  };
  for (const file of seamFiles()) {
    const src = read(file);
    for (const m of src.matchAll(/command -v\s+([A-Za-z0-9._-]+)/g)) note(m[1], file);
    for (const m of src.matchAll(/\/usr\/local\/(?:bin|sbin)\/([A-Za-z0-9._-]+)/g)) note(m[1], file);
  }
  return refs;
}

/** Names this repository owns, i.e. would have to ship itself. */
export function repoOwnedScripts() {
  return new Set(fs.readdirSync(path.join(REPO, 'scripts')));
}

/**
 * The audit. Pure over its inputs so the mutation tests can re-run it against a
 * deliberately broken installer or unit.
 *
 * @returns {{violations: string[], checked: string[], external: string[]}}
 */
export function auditInstallerManifest({ installSh, unitFor, scriptsOnDisk, seamRefs }) {
  const violations = [];
  const checked = [];
  const external = [];

  const appDir = `${installPrefix(installSh)}/app/`;
  const manifest = helperManifest(installSh);

  const requireInstalled = (absPath, why) => {
    const entry = manifest.get(absPath);
    if (!entry) {
      violations.push(
        `${why} references ${absPath}, which install.sh never installs — ` +
        'on a real host that path does not exist (systemd reports 203/EXEC)',
      );
      return;
    }
    if (!(entry.mode & 0o111)) {
      violations.push(`${why} references ${absPath}, which install.sh installs with mode ${entry.mode.toString(8)} — not executable`);
      return;
    }
    if (!scriptsOnDisk.has(path.basename(entry.source))) {
      violations.push(`install.sh ships ${entry.source}, which does not exist in the repository`);
      return;
    }
    // The SOURCE file's mode is deliberately not asserted. `install -m 0755` sets
    // the destination mode explicitly, so a 0644 file in the repository still lands
    // executable on the host — two shipped seams are 0644 in git for exactly that
    // reason. What decides whether the host can exec the file is the mode on the
    // install line, checked above.
    checked.push(absPath);
  };

  for (const unit of installedUnits(installSh)) {
    for (const { directive, program } of execProgramsIn(unitFor(unit.source))) {
      const isLocalBin = /^\/usr\/local\/(bin|sbin)\//.test(program);
      const isRepoOwned = scriptsOnDisk.has(path.basename(program));

      if (isLocalBin || isRepoOwned) {
        requireInstalled(program, `${unit.source} ${directive}=`);
      } else if (program.startsWith(appDir)) {
        // Shipped by the app copy rather than by `install`. Assert the copy exists
        // rather than assuming it.
        if (!/cp -a "\$SRC_DIR\/app\/\." "\$APP_DIR\/"/.test(installSh)) {
          violations.push(`${unit.source} ${directive}= references ${program}, but install.sh no longer copies app/ into $APP_DIR`);
        } else {
          checked.push(program);
        }
      } else {
        external.push(`${unit.source} ${directive}=${program}`);
      }
    }
  }

  for (const [name, files] of seamRefs) {
    if (!scriptsOnDisk.has(name)) continue; // not ours to ship (claude, node, tmux…)
    const dests = [...manifest.keys()].filter((d) => path.basename(d) === name);
    if (dests.length === 0) {
      violations.push(
        `seam(s) ${[...files].join(', ')} invoke ${name}, which install.sh never installs — ` +
        'a missing helper is a refusal, not a skip',
      );
      continue;
    }
    for (const dest of dests) requireInstalled(dest, `seam(s) ${[...files].join(', ')}`);
  }

  return { violations, checked: [...new Set(checked)], external };
}

/** The audit, bound to this repository, with any input overridable for mutation tests. */
export function auditThisRepo(overrides = {}) {
  return auditInstallerManifest({
    installSh: read('install.sh'),
    unitFor: (rel) => read(rel),
    scriptsOnDisk: repoOwnedScripts(),
    seamRefs: seamReferences(),
    ...overrides,
  });
}

/**
 * Replay install.sh's file manifest into a staging root, through the real
 * `install(1)` with the real modes — the same program install.sh runs, so the
 * staged mode and ownership semantics are the installer's, not a reimplementation
 * of them. (An earlier revision of this comment claimed `install(1)` while the
 * code used copyFileSync + chmod. It now does what it says.)
 *
 * Units go through the same placeholder rendering install.sh applies, so a staged
 * unit is byte-for-byte what a host of that shape receives. `vars` lets a test
 * stage a NON-DEFAULT PW_INSTALL_DIR / account and prove the override is real.
 *
 * This is the installer's OWN manifest — parsed out of install.sh, never restated.
 */
export function stageInstall(stageRoot, installSh, vars = null) {
  const values = vars ?? installDefaults(installSh);
  const staged = { units: [], helpers: [], vars: values };

  // BATCHED, by (destination directory, mode). `install -m MODE src… DIR` is one
  // process for a whole group instead of one per file.
  //
  // This is not micro-optimisation. Staging happens in every test in three files,
  // and a per-file spawn made it ~300 extra processes per suite run — enough, on a
  // loaded host, to push the orchestrator's process-kill timing assertions past
  // their deadlines and fail a suite that has nothing to do with the installer.
  // Verified: the reviewed head passes the full gate on the same machine where the
  // unbatched version failed it.
  const groups = new Map();
  const single = [];
  const queue = (sourceAbs, dest, mode) => {
    // Batching relies on `install` preserving the basename into a directory, so a
    // destination that renames its source must still go one at a time.
    if (path.basename(sourceAbs) !== path.basename(dest)) {
      single.push({ sourceAbs, dest, mode });
      return;
    }
    const key = `${path.dirname(dest)} ${mode}`;
    if (!groups.has(key)) groups.set(key, { dir: path.dirname(dest), mode, sources: [] });
    groups.get(key).sources.push(sourceAbs);
  };

  for (const [dest, entry] of helperManifest(installSh)) {
    queue(path.join(REPO, entry.source), dest, entry.mode);
    staged.helpers.push({ source: entry.source, dest, target: path.join(stageRoot, dest), mode: entry.mode });
  }
  for (const unit of installedUnits(installSh)) {
    // Render first, into a scratch file, then install THAT — mirroring install.sh.
    const scratch = path.join(stageRoot, '.render', path.basename(unit.dest));
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.writeFileSync(scratch, renderUnit(read(unit.source), values));
    queue(scratch, unit.dest, 0o644);
    staged.units.push({ source: unit.source, dest: unit.dest, target: path.join(stageRoot, unit.dest), mode: 0o644 });
  }

  const mode8 = (m) => m.toString(8).padStart(4, '0');
  for (const { dir, mode, sources } of groups.values()) {
    const targetDir = path.join(stageRoot, dir);
    fs.mkdirSync(targetDir, { recursive: true });
    execFileSync('install', ['-m', mode8(mode), ...sources, targetDir]);
  }
  for (const { sourceAbs, dest, mode } of single) {
    const target = path.join(stageRoot, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync('install', ['-m', mode8(mode), sourceAbs, target]);
  }
  return staged;
}

// ---------------------------------------------------------------------------
// Owner <-> executor socket identity
// ---------------------------------------------------------------------------

/**
 * tmux's default socket, as tmux itself computes it: `$TMUX_TMPDIR/tmux-<uid>/<name>`,
 * with TMUX_TMPDIR defaulting to /tmp and the name defaulting to `default`.
 *
 * This rule is not taken on trust — test/tmux-owner-socket-parity.test.mjs verifies
 * it against the real tmux binary inside a private TMUX_TMPDIR before relying on it.
 */
export function tmuxDefaultSocket({ tmuxTmpdir, uid, name = 'default' }) {
  return `${tmuxTmpdir || '/tmp'}/tmux-${uid}/${name}`;
}

/**
 * The uid an account resolves to.
 *
 * Returns a real number where the account exists (a deployment host), and a stable
 * symbolic token where it does not (a CI runner has no `admin`). The token keeps the
 * parity comparison meaningful everywhere instead of skipping: two sides agree iff
 * they name the same account, which is precisely the invariant under test, and a
 * mutation that changes the account still breaks it.
 */
export function resolveUid(user) {
  try {
    const out = execFileSync('getent', ['passwd', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const fields = out.split('\n')[0].split(':');
    if (fields.length === 7 && /^\d+$/.test(fields[2])) return Number(fields[2]);
  } catch { /* no such account here; fall through to the symbolic form */ }
  return `uid(${user})`;
}

/** `User=` / `Group=` as a rendered unit declares them. Absent means root. */
export function unitAccount(unitText) {
  const pick = (key) => {
    const m = new RegExp(`^\\s*${key}=(.*)$`, 'm').exec(unitText.replace(/\\\n\s*/g, ' '));
    return m ? m[1].trim() : null;
  };
  return { user: pick('User'), group: pick('Group') };
}
