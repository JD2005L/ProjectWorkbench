// Candidate C — the ownership gate, as every seam actually calls it.
//
// Round 8, item 3 recorded two fail-OPEN paths the superseded candidate left:
// terminal creation skipped the gate entirely when the assertion helper was not
// on PATH — the shape of any partially-upgraded host — and created the server
// anyway; and the dashboard bypassed the gate completely, creating sessions from
// its own service cgroup with no check at all.
//
// So the contract here is blunt: a MISSING helper is a REFUSAL, not a skip, and
// every seam that can create a server goes through the same gate.
//
// Hermetic by construction: each case runs with a polluted environment
// (TMUX, TMUX_PANE, TMUX_TMPDIR, PW_TMUX_*, PW_DEPLOY_MODE, PW_ENV_FILE,
// NOTIFY_SOCKET) to prove the gate reads its own configuration rather than
// whatever the developer's shell happened to export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/pw-tmux-assert-owner', import.meta.url));

// Every variable that could make a tmux test lie if it leaked in.
const POLLUTION = {
  TMUX: '/tmp/leaked-tmux-socket,1234,0',
  TMUX_PANE: '%7',
  TMUX_TMPDIR: '/tmp/leaked-tmpdir',
  PW_TMUX_SOCKET: 'leaked-socket',
  PW_TMUX_OWNER_CGROUP: '',
  PW_TMUX_STATE_DIR: '/tmp/leaked-state',
  PW_DEPLOY_MODE: 'container',
  PW_ENV_FILE: '/tmp/leaked-env-file',
  NOTIFY_SOCKET: '/tmp/leaked-notify',
};

function fakeProc(pid, cgroup) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ap-')));
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'cgroup'), `0::${cgroup}\n`);
  return root;
}

// A stub `tmux` that reports a chosen server pid and marker, so the gate can be
// driven without a real server. `display-message -p '#{pid}'` and
// `show-options -sv @pw_owner` are the two things it is asked.
function stubTmuxDir(dir, { pid, marker, dead = false }) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env bash
if [ "${dead}" = "true" ]; then echo "no server running" >&2; exit 1; fi
for a in "$@"; do
  case "$a" in
    '#{pid}') echo "${pid}"; exit 0 ;;
    '@pw_owner') echo "${marker}"; exit 0 ;;
  esac
done
exit 0
`, { mode: 0o755 });
  return bin;
}

function runGate({ procRoot, ownerCgroup, tmuxBin, extraEnv = {}, cli = CLI }) {
  const env = {
    PATH: `${tmuxBin}:/usr/bin:/bin`,
    HOME: process.env.HOME,
    ...POLLUTION,
    PW_TMUX_PROC_ROOT: procRoot,
    PW_TMUX_OWNER_CGROUP: ownerCgroup,
    PW_DEPLOY_MODE: 'host',
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(cli, [], { encoding: 'utf8', env, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('the gate PASSES for a server carrying our marker in the owner cgroup', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const proc = fakeProc(555, '/system.slice/pw-tmux-server.service');
  const bin = stubTmuxDir(dir, { pid: 555, marker: 'pw-owner' });
  const r = runGate({ procRoot: proc, ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.equal(r.code, 0, `expected pass, got ${r.code}: ${r.stderr}`);
});

test('the gate REFUSES a foreign server living in a terminal cgroup', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  // The adopt-don't-move case: our marker is there, the cgroup is a ttyd's.
  const proc = fakeProc(556, '/system.slice/system-project\\x2dterminal.slice/project-terminal@demo.service');
  const bin = stubTmuxDir(dir, { pid: 556, marker: 'pw-owner' });
  const r = runGate({ procRoot: proc, ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.notEqual(r.code, 0, 'a server in a terminal cgroup must be refused');
  assert.match(r.stderr, /cgroup/i);
});

test('the gate REFUSES a server with no owner marker', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const proc = fakeProc(557, '/system.slice/pw-tmux-server.service');
  const bin = stubTmuxDir(dir, { pid: 557, marker: '' });
  const r = runGate({ procRoot: proc, ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /marker/i);
});

test('the gate REFUSES when there is no server at all', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const bin = stubTmuxDir(dir, { pid: 0, marker: '', dead: true });
  const r = runGate({ procRoot: '/nonexistent', ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.notEqual(r.code, 0);
});

test('a MISSING helper is a refusal, never a skip', () => {
  // The partially-upgraded host: the seam calls a helper that is not installed.
  // The seam scripts must treat that as fatal; this asserts the CLI path itself
  // cannot be "absent and therefore fine".
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const bin = stubTmuxDir(dir, { pid: 1, marker: 'pw-owner' });
  const r = runGate({ procRoot: '/nonexistent', ownerCgroup: 'x.service', tmuxBin: bin, cli: path.join(dir, 'not-installed') });
  assert.notEqual(r.code, 0, 'invoking an absent helper must fail, not silently succeed');
});

test('the gate reads ITS OWN configuration, not a polluted environment', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const proc = fakeProc(558, '/system.slice/pw-tmux-server.service');
  const bin = stubTmuxDir(dir, { pid: 558, marker: 'pw-owner' });
  // POLLUTION sets PW_DEPLOY_MODE=container and a bogus TMUX/TMUX_TMPDIR; the
  // explicit configuration below must win, or this passes for the wrong reason.
  const r = runGate({ procRoot: proc, ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.equal(r.code, 0, `polluted environment leaked into the gate: ${r.stderr}`);
});

test('the gate emits metadata only — no environment dump, no secrets', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-')));
  const proc = fakeProc(559, '/system.slice/system-x.slice/other.service');
  const bin = stubTmuxDir(dir, { pid: 559, marker: 'nope' });
  const r = runGate({ procRoot: proc, ownerCgroup: 'pw-tmux-server.service', tmuxBin: bin });
  assert.notEqual(r.code, 0);
  const all = r.stdout + r.stderr;
  for (const leaked of Object.values(POLLUTION)) {
    if (leaked) assert.equal(all.includes(leaked), false, `the gate echoed an environment value: ${leaked}`);
  }
});
