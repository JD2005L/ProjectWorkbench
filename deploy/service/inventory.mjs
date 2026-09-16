import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, readSnapshot } from './safe-files.mjs';

const RULES = [
  ['namespace-entry', /\bnsenter\b|\/proc\/1\/root\b|\/host(?:\/|\b)/],
  ['privilege-switching', /\b(?:sudo|su|runuser|setpriv)\b/],
  ['container-assumptions', /\b(?:podman|docker|CONTAINER_HOST|DOCKER_HOST|PW_DEPLOY_MODE)\b/],
  ['service-control', /\bsystemctl\b|\bservice\s+\S+\s+(?:start|stop|restart|reload)\b/],
  ['absolute-host-paths', /\/(?:etc|var|opt|root|home|run|usr\/local)\//],
  ['remote-or-optional-toolchain', /\b(?:ssh|scp|rsync|winrm|smbclient|dotnet)\b/],
  ['mutable-checkout', /\bgit\s+(?:pull|checkout|reset|clean)\b/],
];

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function inventorySlots(configuration) {
  if (!record(configuration)) throw new Error('Saved deployment configuration must be an object');
  const slots = [];
  for (const [project, targets] of Object.entries(configuration)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(project) || !record(targets)) {
      throw new Error('Saved deployment configuration contains an invalid project entry');
    }
    for (const target of ['dev', 'prod']) {
      if (!Object.hasOwn(targets, target)) continue;
      const slot = targets[target];
      if (!record(slot) || (slot.script !== undefined && typeof slot.script !== 'string')
          || (slot.versionCmd !== undefined && typeof slot.versionCmd !== 'string')) {
        throw new Error('Saved deployment slot contains invalid script metadata');
      }
      const script = slot.script || '', version = slot.versionCmd || '';
      const text = `${script}\n${version}`;
      const flags = RULES.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
      if (slot.runAsRoot === true) flags.push('legacy-root-grant');
      slots.push({
        project, target, scriptPresent: !!script.trim(), versionCommandPresent: !!version.trim(), flags,
      });
    }
  }
  return { schemaVersion: 1, kind: 'heuristic-migration-inventory', slots };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node inventory.mjs --config /absolute/protected/deploy-config.json\nRead-only: reports slot identifiers and review flags, never script bodies or credentials.\n');
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Supply one --config path');
  const file = process.argv[3];
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\0-\x1f\x7f]/.test(file)) {
    throw new Error('Inventory input must be a normalized absolute path');
  }
  const snapshot = await readSnapshot(file, {
    owner: null, parentsOwner: null, writable: true, writableParents: true, maxBytes: 16 * 1024 * 1024,
  });
  const report = inventorySlots(parseJson(snapshot.bytes, 'Saved deployment configuration'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Inventory refused: ${error.message}\n`); process.exitCode = 1; });
}
