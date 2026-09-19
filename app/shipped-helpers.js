// Where a script this repository ships actually lives, in either install layout.
//
// The two layouts disagree, and neither is wrong:
//
//   host       install.sh puts executables on PATH (/usr/local/bin, /usr/local/sbin). It populates
//              <install>/scripts with only a couple of files, so a sibling copy of any other script
//              is absent on a clean install — and stale on one that an older deploy path populated.
//   container  install.sh refuses to run at all (it is the host-mode path only). The image COPYs
//              scripts/ to <install>/scripts, and nothing is placed on PATH.
//
// So a constant naming one of those locations hardcodes an install mode into product logic, which
// is the one thing the coordination rules say not to do: environment specifics belong in resolution,
// not in divergent behaviour. Both callers were doing it, in opposite directions — the wake helper
// assumed PATH (missing in a container) and the ownership helper assumed the sibling directory
// (absent, or stale, on a host). This resolves it once, for both.
//
// Preference is the INSTALLED location first. On a host that is the copy install.sh maintains, and
// the same binary the tmux wake hooks invoke, so the dashboard and the hooks can never end up
// running two different versions of the same script. A container has no such copy and falls through
// to the image's scripts directory.
import fsSync from 'fs';
import path from 'path';

export const SHIPPED_HELPER_DIRS = Object.freeze(['/usr/local/bin', '/usr/local/sbin']);

/**
 * @param {string} name        the script's filename, e.g. 'pw-claude-wake'
 * @param {object} o
 * @param {string} o.appDir    the directory app/server.js lives in; its ../scripts is the fallback
 * @param {string[]} [o.dirs]  installed locations to prefer, in order
 * @param {(p:string)=>boolean} [o.isFile] existence probe, injected for tests
 * @returns {string} the first candidate that exists, else the sibling path — never an empty string,
 *   so a caller that cannot find the helper still fails naming a real location rather than ''.
 */
export function resolveShippedHelper(name, { appDir, dirs = SHIPPED_HELPER_DIRS, isFile = defaultIsFile } = {}) {
  if (!name || name.includes('/')) throw new Error(`resolveShippedHelper: expected a bare script name, got ${JSON.stringify(name)}`);
  const sibling = path.join(appDir, '..', 'scripts', name);
  for (const dir of [...dirs]) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return sibling;
}

function defaultIsFile(p) {
  try { return fsSync.statSync(p).isFile(); } catch { return false; }
}
