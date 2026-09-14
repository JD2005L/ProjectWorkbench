// Contract for the recovery seam that fixed the permanently dead project tab
// (2026-09-14): a container-mode terminal showed "can't find session: pw_<project>"
// forever once its tmux session went away, because the command ttyd re-runs on every
// reconnect was a bare `attach-session`. ttyd's "Press ⏎ to Reconnect" just re-ran the
// same failing attach, and POST /api/term/:project/recycle has no button on it, so the
// project stayed unusable until an admin re-saved it. The host-mode seam
// (scripts/project-terminal-start) has always handed ttyd `new-session -A` for exactly
// this reason; both deployments must now self-heal.
//
// Source-assertion style, like test/per-user-stale-grandfather.test.mjs: these paths
// need a live tmux server, a ttyd binary and a credential drop to exercise directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
const HOST_SEAM = readFileSync(new URL('../scripts/project-terminal-start', import.meta.url), 'utf8');

// The container-mode ttyd spawn, from `spawn('ttyd'` to the end of its argv array.
// (non-greedy to the argv array's real end: it contains a nested `['-L',TMUX_SOCKET]`.)
const ttydSpawn = SRC.match(/const proc = spawn\('ttyd',\[[\s\S]*?\],\{/);

test("the command ttyd re-runs recreates a missing session instead of failing to attach", () => {
  assert.ok(ttydSpawn, 'could not find the container-mode ttyd spawn');
  const argv = ttydSpawn[0];
  assert.match(argv, /'new-session','-A','-s',sess/,
    'ttyd must be handed `new-session -A`, so a reconnect rebuilds a missing session');
  assert.doesNotMatch(argv, /'attach-session'/,
    'a bare attach-session is what made a missing session a permanently dead tab');
});

test('the rebuilt session gets the same pane shape ensureTmuxSession would have created', () => {
  const argv = ttydSpawn[0];
  // cwd, first window name, pane environment and credential shell all come from the
  // descriptor ensureTmuxSession computed — not tmux defaults.
  for(const part of ["'-c',launch.cwd", "'-n',launch.firstName", '...launch.env', "'bash',...launch.shellArgs"]){
    assert.ok(argv.includes(part), `the ttyd argv must carry ${part}`);
  }
  assert.match(SRC, /const launch = await ensureTmuxSession\(p\);/,
    'startProject must take the descriptor from ensureTmuxSession rather than rebuild it');
});

test('every ensureTmuxSession return path hands back the descriptor', () => {
  const body = SRC.slice(
    SRC.indexOf('async function ensureTmuxSession(p){'),
    SRC.indexOf('async function ensureProjectTmuxSession(p){'),
  );
  assert.ok(body, 'could not isolate ensureTmuxSession');
  // Both attach paths (grandfathered, exact match) plus the create path.
  assert.equal((body.match(/return launch;/g) || []).length, 3,
    'all three ensureTmuxSession return paths must hand back the launch descriptor');
  assert.doesNotMatch(body, /\breturn;/,
    'a bare return would give startProject an undefined descriptor to build the ttyd argv from');
});

test('the ttyd argv clears the tmux ownership gate, like the host-mode seam does', () => {
  // `new-session -A` can bring the SERVER into existence, so it is a server-creation
  // seam and must not reach tmux ungated — the bypass Round 8 found.
  const gateToSpawn = SRC.slice(
    SRC.indexOf('const launch = await ensureTmuxSession(p);'),
    SRC.indexOf("const proc = spawn('ttyd'"),
  );
  assert.match(gateToSpawn, /await assertTmuxOwner\(\{ env: process\.env \}\);/,
    'the gate must be cleared between ensuring the session and handing ttyd a creating command');
});

test('the host-mode seam still hands ttyd the same self-healing command', () => {
  // Parity is the whole point: if this regresses, the two deployments diverge again.
  const exec = HOST_SEAM.slice(HOST_SEAM.indexOf('exec "${PW_TTYD_BIN:-/usr/bin/ttyd}"'));
  assert.match(exec, /new-session -A -s "\$session"/,
    'project-terminal-start must keep handing ttyd new-session -A');
});
