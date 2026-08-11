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
  return [...installSh.matchAll(/install\s+-m\s+0644\s+"\$SRC_DIR\/(systemd\/[^"]+)"\s+(\/etc\/systemd\/system\/\S+)/g)]
    .map((m) => ({ source: m[1], dest: m[2] }));
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
export function seamReferences() {
  const seamFiles = [
    ...fs.readdirSync(path.join(REPO, 'scripts')).map((f) => `scripts/${f}`),
    ...fs.readdirSync(path.join(REPO, 'app')).filter((f) => f.endsWith('.js')).map((f) => `app/${f}`),
  ].filter((p) => fs.statSync(path.join(REPO, p)).isFile());

  const refs = new Map(); // name -> Set(seam files)
  const note = (name, file) => {
    if (!refs.has(name)) refs.set(name, new Set());
    refs.get(name).add(file);
  };
  for (const file of seamFiles) {
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
 * Replay install.sh's file manifest into a staging root, using the real
 * `install(1)` with the real modes. This is the installer's OWN manifest — parsed
 * out of install.sh, never restated — so what gets staged is what a host receives.
 *
 * Returns the destinations written, relative to the host paths they represent.
 */
export function stageInstall(stageRoot, installSh) {
  const staged = { units: [], helpers: [] };
  const put = (source, dest, mode) => {
    const target = path.join(stageRoot, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO, source), target);
    fs.chmodSync(target, mode);
    return { source, dest, target, mode };
  };
  for (const [dest, entry] of helperManifest(installSh)) {
    staged.helpers.push(put(entry.source, dest, entry.mode));
  }
  for (const unit of installedUnits(installSh)) {
    staged.units.push(put(unit.source, unit.dest, 0o644));
  }
  return staged;
}
