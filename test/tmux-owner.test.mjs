// Candidate C — who owns the live tmux server?
//
// The Round 8 refutation of the superseded candidate found that readiness proved
// the wrong thing: it asked "does a `_keepalive` session exist on this socket",
// never "is the server I am supervising actually mine". With a client-created
// server already present, the owner unit reported ready — releasing the `After=`
// barrier for every terminal — while supervising a foreign server living in a
// ttyd's cgroup.
//
// So ownership is two independent facts, and BOTH must hold:
//
//   1. the server carries our owner marker (a tmux *server option*, so it belongs
//      to the server rather than to any client's environment); and
//   2. the server process's cgroup is the expected owner's cgroup.
//
// The same review also warned that the cgroup half cannot discriminate in a test
// where every process shares the runner's cgroup — only the marker can. So every
// cgroup assertion here runs against a FAKED /proc with controlled contents, and
// none of it is described as proof of a same-cgroup comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OWNER_MARKER_OPTION,
  expectedOwnerCgroup,
  ownerRemediation,
  readProcessCgroup,
  cgroupMatchesOwner,
  assessOwnership,
} from '../app/tmux-owner.js';

function fakeProc(pid, cgroupText) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-proc-')));
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'cgroup'), cgroupText);
  return root;
}

const HOST_OWNER_CGROUP = '/system.slice/pw-tmux-server.service';
const FOREIGN_TTYD_CGROUP = '/system.slice/system-project\\x2dterminal.slice/project-terminal@demo.service';

// ---------------------------------------------------------------------------
// The marker option
// ---------------------------------------------------------------------------

test('the owner marker is a server option, not an environment variable', () => {
  // A client-inherited environment variable would make the race test vacuous a
  // second way (Round 8, item 2). It must live on the server.
  assert.match(OWNER_MARKER_OPTION, /^@/, 'a tmux user option starts with @');
  assert.equal(OWNER_MARKER_OPTION.includes(' '), false);
});

// ---------------------------------------------------------------------------
// Expected owner resolution — from configuration, never a baked-in deployment
// ---------------------------------------------------------------------------

test('expectedOwnerCgroup resolves the host owner unit by default', () => {
  assert.equal(expectedOwnerCgroup({}), 'pw-tmux-server.service');
  assert.equal(expectedOwnerCgroup({ PW_DEPLOY_MODE: 'host' }), 'pw-tmux-server.service');
});

test('expectedOwnerCgroup resolves the container sidecar owner in container mode', () => {
  assert.equal(expectedOwnerCgroup({ PW_DEPLOY_MODE: 'container' }), 'pw-tmux.slice');
});

test('expectedOwnerCgroup is overridable by configuration for other topologies', () => {
  assert.equal(expectedOwnerCgroup({ PW_TMUX_OWNER_CGROUP: 'custom-owner.service' }), 'custom-owner.service');
  assert.equal(
    expectedOwnerCgroup({ PW_DEPLOY_MODE: 'container', PW_TMUX_OWNER_CGROUP: 'custom-owner.service' }),
    'custom-owner.service',
    'an explicit override wins over the mode default',
  );
});

test('a custom owner adapter never recommends restarting an unrelated default unit', () => {
  const message = ownerRemediation({
    PW_DEPLOY_MODE: 'container',
    PW_TMUX_OWNER_CGROUP: 'custom-owner.scope',
  });
  assert.match(message, /custom-owner\.scope/);
  assert.match(message, /configured.*supervisor/i);
  assert.doesNotMatch(message, /systemctl restart pw-tmux(?:-server)?\.service/);
  assert.doesNotMatch(message, /tmux kill-server/);
});

// ---------------------------------------------------------------------------
// Reading a process cgroup — against a faked /proc
// ---------------------------------------------------------------------------

test('readProcessCgroup reads the cgroup v2 line for a pid', () => {
  const proc = fakeProc(4242, `0::${HOST_OWNER_CGROUP}\n`);
  assert.equal(readProcessCgroup({ pid: 4242, procRoot: proc }), HOST_OWNER_CGROUP);
});

test('readProcessCgroup handles a cgroup v1 style file by preferring the unified line', () => {
  const proc = fakeProc(7, `12:pids:/system.slice/other.service\n0::${HOST_OWNER_CGROUP}\n`);
  assert.equal(readProcessCgroup({ pid: 7, procRoot: proc }), HOST_OWNER_CGROUP);
});

test('readProcessCgroup supports a pure cgroup v1 process file', () => {
  const proc = fakeProc(8, `12:pids:${HOST_OWNER_CGROUP}\n11:memory:${HOST_OWNER_CGROUP}\n`);
  assert.equal(readProcessCgroup({ pid: 8, procRoot: proc }), HOST_OWNER_CGROUP);
});

test('readProcessCgroup returns null for a pid that is gone, rather than guessing', () => {
  const proc = fakeProc(1, '0::/x\n');
  assert.equal(readProcessCgroup({ pid: 999999, procRoot: proc }), null);
});

test('cgroupMatchesOwner accepts the owner unit and REJECTS a terminal cgroup', () => {
  assert.equal(cgroupMatchesOwner(HOST_OWNER_CGROUP, 'pw-tmux-server.service'), true);
  // The exact adopt-don't-move case: a server living in a ttyd's cgroup.
  assert.equal(cgroupMatchesOwner(FOREIGN_TTYD_CGROUP, 'pw-tmux-server.service'), false);
  assert.equal(cgroupMatchesOwner('/system.slice/project-workbench.service', 'pw-tmux-server.service'), false);
  assert.equal(cgroupMatchesOwner(null, 'pw-tmux-server.service'), false);
});

test('cgroupMatchesOwner is not fooled by a unit name that merely contains the owner name', () => {
  assert.equal(cgroupMatchesOwner('/system.slice/not-pw-tmux-server.service.d', 'pw-tmux-server.service'), false);
  assert.equal(cgroupMatchesOwner('/system.slice/pw-tmux-server.service.evil', 'pw-tmux-server.service'), false);
});

// ---------------------------------------------------------------------------
// The whole assessment — both facts, independently
// ---------------------------------------------------------------------------

test('ownership requires BOTH the marker and the cgroup', () => {
  const proc = fakeProc(100, `0::${HOST_OWNER_CGROUP}\n`);
  const base = { pid: 100, procRoot: proc, expectedOwner: 'pw-tmux-server.service', expectedMarker: 'pw-owner' };

  const good = assessOwnership({ ...base, marker: 'pw-owner' });
  assert.equal(good.owned, true);
  assert.equal(good.markerOk, true);
  assert.equal(good.cgroupOk, true);

  // Marker present, cgroup foreign — this is exactly what the superseded
  // candidate reported as ready.
  const foreignProc = fakeProc(101, `0::${FOREIGN_TTYD_CGROUP}\n`);
  const wrongCgroup = assessOwnership({ ...base, pid: 101, procRoot: foreignProc, marker: 'pw-owner' });
  assert.equal(wrongCgroup.owned, false);
  assert.equal(wrongCgroup.markerOk, true);
  assert.equal(wrongCgroup.cgroupOk, false);
  assert.match(wrongCgroup.reason, /cgroup/i);

  // Right cgroup, no marker — a server someone else created inside our unit.
  const noMarker = assessOwnership({ ...base, marker: '' });
  assert.equal(noMarker.owned, false);
  assert.equal(noMarker.markerOk, false);
  assert.match(noMarker.reason, /marker/i);
});

test('a server that is not running at all is not owned, and says so distinctly', () => {
  const verdict = assessOwnership({ pid: null, procRoot: '/nonexistent', expectedOwner: 'pw-tmux-server.service', expectedMarker: 'pw-owner', marker: '' });
  assert.equal(verdict.owned, false);
  assert.match(verdict.reason, /no running tmux server|not running/i);
});

test('the verdict never carries anything but metadata', () => {
  const proc = fakeProc(100, `0::${HOST_OWNER_CGROUP}\n`);
  const verdict = assessOwnership({ pid: 100, procRoot: proc, expectedOwner: 'pw-tmux-server.service', expectedMarker: 'pw-owner', marker: 'pw-owner' });
  for (const key of Object.keys(verdict)) {
    assert.ok(['owned', 'markerOk', 'cgroupOk', 'reason', 'pid', 'cgroup'].includes(key), `unexpected field ${key}`);
  }
});
