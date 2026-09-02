// The container-mode project preview must run as the PANE ACCOUNT, not as the
// dashboard's root uid.
//
// It is the one root spawn that runs the project's OWN code, in the project's
// workspace, with HOME and DOTNET_CLI_HOME pointed into that tree. Undropped, every
// file the app and the SDK create there is root-owned in a tree the agent owns:
// `<ws>/.dotnet` (the whole NuGet cache), `bin/`, `obj/`, and the app's own
// `App_Data/` — including a mode 0600 DataProtection key the pane account cannot
// even read. The agent then cannot build its own project, and `git` cannot add an
// object whose fanout directory root happened to create. Host mode never had this:
// systemd/project-preview@.service runs the same command under `User=`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTerminalPriv, agentSpawnDrop } from '../app/terminal-priv.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const CONTAINER = { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001', PW_TERMINAL_USER: 'admin' };

test('agentSpawnDrop: passthrough when the drop is off (host mode, or no PW_TERMINAL_UID)', () => {
  for (const env of [{}, { PW_TERMINAL_UID: '1001' }, { PW_DEPLOY_MODE: 'host', PW_TERMINAL_UID: '1001' }, { PW_DEPLOY_MODE: 'container' }]) {
    assert.deepEqual(agentSpawnDrop(resolveTerminalPriv(env)), [], JSON.stringify(env));
  }
  assert.deepEqual(agentSpawnDrop(null), []);
});

test('agentSpawnDrop: container + uid => bare setpriv prefix, no env token', () => {
  const argv = agentSpawnDrop(resolveTerminalPriv(CONTAINER));
  assert.deepEqual(argv, ['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--init-groups']);
  // Deliberately NOT `/usr/bin/env HOME=…` like agentLoginDrop: this seam's caller
  // passes its own env object to spawn(), and an env token list would clobber the
  // PORT/BASEPATH/DOTNET_* the preview is configured with.
  assert.ok(!argv.includes('/usr/bin/env'), 'agentSpawnDrop must not re-exec through env(1)');
  assert.ok(!argv.some((t) => t.startsWith('HOME=')), 'agentSpawnDrop must not override the caller HOME');
});

/** One top-level function's source text — same structural slice test/autoupdater-env.test.mjs uses. */
function functionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `app/server.js no longer defines ${name}() — this contract needs updating, not deleting`);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:async function |function |const |let |app\.|module\.)/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('startPreviewUnit drops to the terminal account before running project code', () => {
  const body = functionSource(read('app/server.js'), 'startPreviewUnit');
  assert.match(body, /agentSpawnDrop\(TERMINAL_PRIV\)/, 'the container-mode preview spawn no longer drops privileges');
  assert.match(body, /spawn\(argv\[0\],\s*argv\.slice\(1\)/, 'startPreviewUnit no longer spawns through the dropped argv');
  // The exact shape of the regression: bash invoked directly, as root.
  assert.ok(!/spawn\('bash',\s*\['-c',\s*previewCommand\(p\)\]/.test(body), 'startPreviewUnit spawns bash undropped again');
  // USER/LOGNAME still say root without this — the process is admin but announces itself as root.
  assert.match(body, /env\.USER = TERMINAL_PRIV\.user/, 'the dropped preview still advertises USER=root');
});

// THIS TEST EXISTS BECAUSE THE SWEEP BELOW MISSED A SEAM. The cwd-keyed audit
// declared the preview the only workspace-rooted spawn and passed — while the
// deploy runner was writing to workspaces as root the whole time, because a slot
// script `cd`s itself and its exec carries no `cwd` for a sweep to key on. It
// re-broke Bi-Tools two days later: `git pull` under root rewrote tracked source
// as root:root and the agent hit EACCES on its own files. So operator-authored
// deploy text gets its own contract, keyed on the TEXT rather than on the cwd.
test('NO DRIFT: operator-authored deploy shell text never reaches execFileAsync undropped', () => {
  const src = read('app/server.js');
  for (const m of src.matchAll(/execFileAsync\(\s*'bash'\s*,\s*\[\s*'-c'\s*,\s*([A-Za-z_$][\w.$]*)/g)) {
    assert.ok(
      !/^(tc\.script|tc\.versionCmd|versionCmd)$/.test(m[1]),
      `deploy slot text \`${m[1]}\` is executed without the privilege drop — route it through deployExec()`,
    );
  }
  // The definition plus all three call sites: the deploy script, the post-deploy
  // version probe, and getDeployedVersion's status probe.
  assert.equal([...src.matchAll(/deployExec\(/g)].length, 4, 'deployExec() is no longer the single deploy exec seam');
  const body = functionSource(src, 'getDeployedVersion');
  assert.match(body, /deployExec\(pc\[target\]/, 'the deploy status probe bypasses deployExec()');
});

test('deployExec keeps the root escape hatch explicit and carries the pane HOME', () => {
  const src = read('app/server.js');
  const start = src.indexOf('function deployExec(');
  assert.notEqual(start, -1, 'app/server.js no longer defines deployExec()');
  const body = src.slice(start, src.indexOf('\nasync function', start));
  assert.match(body, /tc\?\.runAsRoot \? \[\] : agentSpawnDrop\(TERMINAL_PRIV\)/, 'the runAsRoot opt-out is gone or no longer gates the drop');
  // Dropping the uid without the HOME makes `dotnet publish` and `git` look in
  // /root and fail on permissions — a different outage, not a fix.
  for (const v of ['HOME', 'USER', 'LOGNAME']) {
    assert.ok(body.includes(`execEnv.${v} = TERMINAL_PRIV.`), `the dropped deploy no longer sets ${v}`);
  }
});

test('NO DRIFT: the preview is the only thing the dashboard spawns INTO a workspace', () => {
  const src = read('app/server.js');
  // Root running with a workspace as cwd is only safe while it cannot write there.
  // The two survivors are read-only probes inside getLocalVersion() (a find(1) mtime
  // scan and `git rev-parse`). A third one appearing here means someone added a root
  // call site into a pane-owned tree and it needs auditing, not a bumped number.
  const probes = [...src.matchAll(/cwd\s*:\s*projectPath\b/g)];
  assert.equal(probes.length, 2, `expected exactly the 2 read-only getLocalVersion probes with cwd:projectPath, found ${probes.length}`);
  const spawns = [...src.matchAll(/spawn\((?:[^()]|\([^()]*\))*\{\s*cwd\s*,/g)];
  assert.equal(spawns.length, 1, `expected exactly 1 spawn() with a workspace cwd (the dropped preview), found ${spawns.length}`);
});
