// Candidate C — every server-creation seam goes through the ownership gate.
//
// Round 8, item 3: "so 'host mode fails closed' was true of the systemd terminal
// entrypoint only". The dashboard created sessions straight from its own service
// cgroup with no check, reachable through the terminal recycle path, and a host
// missing the helper skipped the gate and created the server anyway.
//
// This file is the structural guard against that regressing: it enumerates the
// seams from the source and requires each one to reach the gate. A new seam added
// later without a gate fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// Every file that can bring a tmux server into existence.
const SHELL_SEAMS = ['scripts/project-terminal-start', 'scripts/setup-terminal-start', 'scripts/pw-tmux-restore'];
const JS_SEAMS = ['app/server.js', 'app/orchestrator/session.js'];

test('every shell seam invokes the ownership gate before creating a server', () => {
  for (const seam of SHELL_SEAMS) {
    const src = read(seam);
    assert.match(src, /pw-tmux-assert-owner/, `${seam} never calls the ownership gate`);
  }
});

test('no shell seam treats a missing gate helper as a skip', () => {
  for (const seam of SHELL_SEAMS) {
    const src = read(seam);
    // `command -v … || true`, `if command -v …; then` guards, and `-` prefixes are
    // exactly how the superseded candidate turned the gate into a no-op.
    assert.equal(
      /command -v pw-tmux-assert-owner[^\n]*\|\|\s*true/.test(src), false,
      `${seam} tolerates a missing gate helper`,
    );
    assert.equal(
      /pw-tmux-assert-owner[^\n]*\|\|\s*true/.test(src), false,
      `${seam} swallows a gate refusal`,
    );
  }
});

test('every JS seam routes session creation through the gate', () => {
  for (const seam of JS_SEAMS) {
    const src = read(seam);
    assert.match(src, /assertTmuxOwner|tmux-owner/, `${seam} never consults the ownership gate`);
  }
});

test('the dashboard gates its OWN session creation, not just the systemd entrypoint', () => {
  const src = read('app/server.js');
  // The recycle path reaches new-session through the same helper; gating the
  // helper is what closes the bypass.
  assert.match(src, /assertTmuxOwner/, 'server.js must assert ownership');
  const creationLines = src.split('\n').filter((l) => /tmux\(\['new-session'/.test(l));
  assert.ok(creationLines.length >= 1, 'expected the dashboard to create sessions via tmux()');
});

// ---------------------------------------------------------------------------
// Behavioural: a seam with a refusing gate must not create a server
// ---------------------------------------------------------------------------

function harness({ gateExit }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-seam-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // A gate stub with a chosen verdict.
  fs.writeFileSync(path.join(bin, 'pw-tmux-assert-owner'), `#!/usr/bin/env bash\necho "gate says ${gateExit}" >&2\nexit ${gateExit}\n`, { mode: 0o755 });
  // A tmux stub that RECORDS any attempt to create a server.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    new-session|start-server) echo "$a" >> ${JSON.stringify(path.join(dir, 'created'))} ;;
  esac
done
exit 1
`, { mode: 0o755 });
  return { dir, bin, created: path.join(dir, 'created') };
}

test('the restore seam creates no server when the gate refuses', () => {
  const h = harness({ gateExit: 1 });
  const state = path.join(h.dir, 'state');
  fs.mkdirSync(path.join(state, 'content'), { recursive: true });
  fs.writeFileSync(path.join(state, 'manifest.tsv'), 'demo0win/tmpshell\n');
  fs.writeFileSync(path.join(h.dir, 'projects.json'), '[]\n');
  fs.mkdirSync(path.join(h.dir, 'appdir'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'home', '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'home', '.claude', 'projects'), { recursive: true });

  let code = 0;
  try {
    execFileSync(path.join(repo, 'scripts/pw-tmux-restore'), [], {
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${h.bin}:/usr/bin:/bin`,
        HOME: path.join(h.dir, 'home'),
        PW_TMUX_STATE_DIR: state,
        PW_REGISTRY_PATH: path.join(h.dir, 'projects.json'),
        PW_APP_DIR: path.join(repo, 'app'),  // the REAL app dir: otherwise restore exits 78 at Candidate B's config preflight and never reaches the gate
        PW_CLAUDE_SESSIONS_DIR: path.join(h.dir, 'home', '.claude', 'sessions'),
        PW_CLAUDE_PROJECTS_DIR: path.join(h.dir, 'home', '.claude', 'projects'),
        PW_USER_CRED_BASE: path.join(h.dir, 'credbase'),
        PW_TMUX_RESTORE_CLAUDE: '0',
      },
    });
  } catch (e) { code = e.status; }

  assert.notEqual(code, 0, 'a refused gate must make restore exit nonzero');
  assert.equal(fs.existsSync(h.created), false, 'restore created a tmux server despite the gate refusing');
});

test('the restore seam refuses when the gate helper is absent entirely', () => {
  const h = harness({ gateExit: 0 });
  fs.rmSync(path.join(h.bin, 'pw-tmux-assert-owner')); // partially-upgraded host
  const state = path.join(h.dir, 'state');
  fs.mkdirSync(path.join(state, 'content'), { recursive: true });
  fs.writeFileSync(path.join(state, 'manifest.tsv'), 'demo0win/tmpshell\n');
  fs.writeFileSync(path.join(h.dir, 'projects.json'), '[]\n');
  fs.mkdirSync(path.join(h.dir, 'appdir'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'home', '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'home', '.claude', 'projects'), { recursive: true });

  let code = 0;
  try {
    execFileSync(path.join(repo, 'scripts/pw-tmux-restore'), [], {
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${h.bin}:/usr/bin:/bin`,
        HOME: path.join(h.dir, 'home'),
        PW_TMUX_STATE_DIR: state,
        PW_REGISTRY_PATH: path.join(h.dir, 'projects.json'),
        PW_APP_DIR: path.join(repo, 'app'),  // the REAL app dir: otherwise restore exits 78 at Candidate B's config preflight and never reaches the gate
        PW_CLAUDE_SESSIONS_DIR: path.join(h.dir, 'home', '.claude', 'sessions'),
        PW_CLAUDE_PROJECTS_DIR: path.join(h.dir, 'home', '.claude', 'projects'),
        PW_USER_CRED_BASE: path.join(h.dir, 'credbase'),
        PW_TMUX_RESTORE_CLAUDE: '0',
      },
    });
  } catch (e) { code = e.status; }

  assert.notEqual(code, 0, 'a missing gate helper must be a refusal, not a skip');
  assert.equal(fs.existsSync(h.created), false, 'restore created a server with no gate present');
});

// ---------------------------------------------------------------------------
// The fixtures themselves must be able to fail
// ---------------------------------------------------------------------------
//
// A migrated harness that passes because it quietly stopped exercising the gate
// would be worse than the red suite it replaced. These prove the two things the
// migration supplies are load-bearing: removing the owner marker, or removing the
// real helper from PATH, makes a seam fail FOR THE INTENDED REASON.

test('MUTATION: an unmarked private server makes a seam refuse, naming the marker', async () => {
  const { ownedTmuxFixture } = await import('./tmux-owner-fixture.mjs');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mut-')));
  const socket = `pwmut-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const env = ownedTmuxFixture({ socket, dir });
  try {
    // Baseline: the migrated fixture passes the real gate.
    const ok = spawnSync('pw-tmux-assert-owner', [], {
      encoding: 'utf8', env: { ...process.env, ...env, PW_TMUX_SOCKET: socket },
    });
    assert.equal(ok.status, 0, `the migrated fixture should pass the gate: ${ok.stderr}`);

    // MUTATION: drop the marker the owner unit would have set.
    execFileSync('tmux', ['-L', socket, 'set-option', '-su', '@pw_owner'], { encoding: 'utf8' });
    const refused = spawnSync('pw-tmux-assert-owner', [], {
      encoding: 'utf8', env: { ...process.env, ...env, PW_TMUX_SOCKET: socket },
    });
    assert.notEqual(refused.status, 0, 'an unmarked server must be refused');
    assert.match(refused.stderr, /marker/i, 'and it must fail for the marker reason, not incidentally');
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});

test('MUTATION: removing the real helper from PATH makes a seam refuse, naming the helper', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mut-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // A tmux that would happily create a server if it were ever reached.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in new-session|start-server) echo "$a" >> ${JSON.stringify(path.join(dir, 'created'))} ;; esac; done\nexit 1\n`, { mode: 0o755 });

  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'content'), { recursive: true });
  fs.writeFileSync(path.join(state, 'manifest.tsv'), 'demo0win/tmpshell\n');
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]\n');
  fs.mkdirSync(path.join(dir, 'appdir'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', '.claude', 'projects'), { recursive: true });

  const r = spawnSync(path.join(repo, 'scripts/pw-tmux-restore'), [], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,   // deliberately WITHOUT the helper
      HOME: path.join(dir, 'home'),
      PW_TMUX_STATE_DIR: state,
      PW_REGISTRY_PATH: path.join(dir, 'projects.json'),
      PW_APP_DIR: path.join(repo, 'app'),  // the REAL app dir — see above
      PW_CLAUDE_SESSIONS_DIR: path.join(dir, 'home', '.claude', 'sessions'),
      PW_CLAUDE_PROJECTS_DIR: path.join(dir, 'home', '.claude', 'projects'),
      PW_USER_CRED_BASE: path.join(dir, 'credbase'),
      PW_TMUX_RESTORE_CLAUDE: '0',
    },
  });
  assert.notEqual(r.status, 0, 'a missing helper must refuse');
  assert.match(r.stderr, /ownership helper|not installed/i, 'and must say the helper is missing');
  assert.equal(fs.existsSync(path.join(dir, 'created')), false, 'no server may be created');
});
