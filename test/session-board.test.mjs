// The session board is only worth having if a dead session cannot hold a file and
// a live one cannot be missed. Both are process questions, so both are tested
// against synthesized /proc content rather than whatever happens to be running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BOARD_DIR, BOARD_DIR_ENV, LIMITS,
  resolveBoardDir, resolveRegistryDir, projectOf,
  procStart, isLive, sidecarPath, normalizeEntry, mergeEntry,
  readEntry, writeEntry, readRegistry, loadBoard, staleSidecars, findCollisions,
} from '../app/session-board.js';

// /proc/<pid>/stat with the comm field deliberately containing a space and a
// parenthesis, which is what breaks a naive split-on-space parser.
// Real stat has ~52 fields, so starttime (index 19 after the comm field) sits in
// the middle. The fixture must match that or it tests a layout /proc never emits.
function statLine({ state = 'S', starttime = 111 } = {}) {
  const f = [state, ...Array(18).fill('0'), String(starttime), ...Array(32).fill('0')];
  return `4242 (claude (code)) ${f.join(' ')}\n`;
}

function fakeFs({ procs = {}, files = {}, dirs = {} } = {}) {
  return {
    readFileSync(p, _enc) {
      const s = String(p);
      const m = /^\/proc\/(\d+)\/stat$/.exec(s);
      if (m) {
        if (!(m[1] in procs)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return procs[m[1]];
      }
      if (s in files) return files[s];
      const e = new Error(`ENOENT ${s}`); e.code = 'ENOENT'; throw e;
    },
    readdirSync(p) {
      const s = String(p);
      if (s in dirs) return dirs[s];
      const e = new Error(`ENOENT ${s}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// --- resolution --------------------------------------------------------------

test('the board directory is a knob with a documented default', () => {
  // Where the default can be created (a PW host); the container-mode fallback is tested below.
  assert.equal(resolveBoardDir({}, { fsImpl: { accessSync: () => {} } }), DEFAULT_BOARD_DIR);
  assert.equal(resolveBoardDir({ [BOARD_DIR_ENV]: '/tmp/elsewhere' }), '/tmp/elsewhere');
  assert.equal(BOARD_DIR_ENV, 'PW_SESSION_BOARD_DIR');
});

test('the registry directory follows the convention the other PW scripts use', () => {
  assert.equal(resolveRegistryDir({ PW_CLAUDE_SESSIONS_DIR: '/x' }), '/x');
  assert.equal(resolveRegistryDir({ HOME: '/home/someone' }), '/home/someone/.claude/sessions');
});

test('a worktree reports the same project as its workspace', () => {
  // Two sessions in different worktrees of one repo still collide on a push and
  // on a shared branch; calling them separate projects would hide that.
  assert.equal(projectOf('/opt/project-workbench/workspaces/ProjectWorkbench/app'), 'ProjectWorkbench');
  assert.equal(projectOf('/opt/project-workbench/worktrees/MMLOperations-ssl-bootstrap-20261016'), 'MMLOperations');
  assert.equal(projectOf('/home/admin'), '');
  assert.equal(projectOf(undefined), '');
});

// --- liveness ----------------------------------------------------------------

test('the stat parser survives a comm field containing a space and a paren', () => {
  const fsImpl = fakeFs({ procs: { 900: statLine({ starttime: 777 }) } });
  assert.deepEqual(procStart(900, { readFileSync: fsImpl.readFileSync }), { state: 'S', starttime: '777' });
});

test('a recycled pid does NOT count as live, which is the whole point', () => {
  const o = { readFileSync: fakeFs({ procs: { 900: statLine({ starttime: 777 }) } }).readFileSync };
  assert.equal(isLive({ pid: 900, procStart: '777' }, o), true, 'same start time: live');
  assert.equal(isLive({ pid: 900, procStart: '42' }, o), false, 'pid reused by a different process');
  assert.equal(isLive({ pid: 901, procStart: '777' }, o), false, 'no such process');
});

test('a zombie is not live, and pid 1 or a bad pid is never trusted', () => {
  const o = { readFileSync: fakeFs({ procs: { 900: statLine({ state: 'Z', starttime: '7' }) } }).readFileSync };
  assert.equal(isLive({ pid: 900, procStart: '7' }, o), false);
  assert.equal(isLive({ pid: 1 }, o), false);
  assert.equal(isLive({ pid: 'nonsense' }, o), false);
  assert.equal(isLive({}, o), false);
});

test('a registry entry with no recorded start time still resolves on process existence', () => {
  const o = { readFileSync: fakeFs({ procs: { 900: statLine({}) } }).readFileSync };
  assert.equal(isLive({ pid: 900 }, o), true);
});

test('a sidecar is refused for a pid that cannot own one', () => {
  assert.equal(sidecarPath('/b', 42), '/b/42.json');
  for (const bad of [0, 1, -5, 'x', null]) assert.throws(() => sidecarPath('/b', bad), /refusing a sidecar/);
});

// --- the entry shape ---------------------------------------------------------

test('every field is bounded, and the file list is de-duplicated newest-first', () => {
  const e = normalizeEntry({
    pid: 7,
    task: 'x'.repeat(LIMITS.task + 50),
    waitingOn: 'y'.repeat(LIMITS.waitingOn + 50),
    branch: 'b'.repeat(LIMITS.branch + 50),
    filesInFlight: ['/a', '/a', '/b', ...Array.from({ length: LIMITS.files + 20 }, (_, i) => `/f${i}`)],
  });
  assert.equal(e.task.length, LIMITS.task);
  assert.equal(e.waitingOn.length, LIMITS.waitingOn);
  assert.equal(e.branch.length, LIMITS.branch);
  assert.equal(e.filesInFlight.length, LIMITS.files);
  assert.deepEqual(e.filesInFlight.slice(0, 2), ['/a', '/b'], 'de-duplicated, order preserved');
  assert.ok(e.updatedAt, 'always stamped');
});

test('newlines in a task cannot break the board into a second row', () => {
  assert.equal(normalizeEntry({ pid: 7, task: 'one\ntwo\t three' }).task, 'one two three');
});

test('merging leaves an absent field alone, clears on empty string, and prepends files', () => {
  const prev = normalizeEntry({ pid: 7, task: 'original', waitingOn: 'CI', filesInFlight: ['/old'] });
  const untouched = mergeEntry(prev, { pid: 7, addFiles: ['/new'] });
  assert.equal(untouched.task, 'original', 'a file hook must not erase the task');
  assert.equal(untouched.waitingOn, 'CI');
  assert.deepEqual(untouched.filesInFlight, ['/new', '/old'], 'newest claim first');

  const cleared = mergeEntry(prev, { pid: 7, task: '', filesInFlight: [] });
  assert.equal(cleared.task, '', 'an explicit empty string clears');
  assert.deepEqual(cleared.filesInFlight, []);

  const fresh = mergeEntry(null, { pid: 7, task: 'first' });
  assert.equal(fresh.task, 'first');
  assert.equal(fresh.pid, 7);
});

// --- the join ----------------------------------------------------------------

const REG_DIR = '/reg';
const BOARD_DIR = '/board';

function scenario() {
  return fakeFs({
    procs: {
      100: statLine({ starttime: 'aaa' }), // live, reporting
      200: statLine({ starttime: 'bbb' }), // live, not reporting
      300: statLine({ starttime: 'zzz' }), // pid reused -> must be dropped
    },
    dirs: {
      [REG_DIR]: ['100.json', '200.json', '300.json', '400.json', 'README', 'notes.txt'],
      [BOARD_DIR]: ['100.json', '300.json', '999.json'],
    },
    files: {
      [`${REG_DIR}/100.json`]: JSON.stringify({ pid: 100, procStart: 'aaa', sessionId: 's-100', cwd: '/opt/project-workbench/workspaces/Alpha', tmuxPane: 'pw_Alpha:@1', kind: 'interactive' }),
      [`${REG_DIR}/200.json`]: JSON.stringify({ pid: 200, procStart: 'bbb', sessionId: 's-200', cwd: '/opt/project-workbench/workspaces/Beta' }),
      [`${REG_DIR}/300.json`]: JSON.stringify({ pid: 300, procStart: 'ccc', sessionId: 's-300', cwd: '/opt/project-workbench/workspaces/Alpha' }),
      [`${REG_DIR}/400.json`]: '{ this is not json',
      [`${BOARD_DIR}/100.json`]: JSON.stringify({ pid: 100, project: 'Alpha', branch: 'main', task: 'editing the thing', filesInFlight: ['/opt/project-workbench/workspaces/Alpha/x.cshtml'], updatedAt: new Date().toISOString() }),
      [`${BOARD_DIR}/300.json`]: JSON.stringify({ pid: 300, project: 'Alpha', task: 'from a session that died', filesInFlight: ['/opt/project-workbench/workspaces/Alpha/x.cshtml'] }),
      [`${BOARD_DIR}/999.json`]: JSON.stringify({ pid: 999, task: 'orphan' }),
    },
  });
}

test('the registry reader skips non-session files and a file caught mid-write', () => {
  const rows = readRegistry(REG_DIR, { fsImpl: scenario() });
  assert.deepEqual(rows.map((r) => r.pid).sort((a, b) => a - b), [100, 200, 300]);
});

test('a missing registry or board directory is empty, not an error', () => {
  const empty = fakeFs({});
  assert.deepEqual(readRegistry('/nope', { fsImpl: empty }), []);
  assert.deepEqual(loadBoard({ boardDir: '/nope', registryDir: '/nope', fsImpl: empty }), []);
  assert.deepEqual(staleSidecars({ boardDir: '/nope', registryDir: '/nope', fsImpl: empty }), []);
});

test('the board shows live sessions only, and says which ones are silent', () => {
  const rows = loadBoard({ boardDir: BOARD_DIR, registryDir: REG_DIR, fsImpl: scenario() });
  assert.deepEqual(rows.map((r) => r.pid), [100, 200], 'the recycled pid 300 is gone; sorted by project then pid');

  const a = rows.find((r) => r.pid === 100);
  assert.equal(a.project, 'Alpha');
  assert.equal(a.task, 'editing the thing');
  assert.equal(a.reporting, true);
  assert.equal(a.tmux, 'pw_Alpha:@1');
  assert.ok(a.staleMs !== null && a.staleMs < 60000);

  const b = rows.find((r) => r.pid === 200);
  assert.equal(b.reporting, false, 'running but silent is still on the board');
  assert.equal(b.project, 'Beta', 'the project falls back to the registry cwd');
  assert.deepEqual(b.filesInFlight, []);
  assert.equal(b.staleMs, null);
});

test('a dead session cannot hold a file', () => {
  // pid 300's sidecar claims the same file as pid 100's. Only the live one counts.
  const rows = loadBoard({ boardDir: BOARD_DIR, registryDir: REG_DIR, fsImpl: scenario() });
  const res = findCollisions(rows, { file: '/opt/project-workbench/workspaces/Alpha/x.cshtml' });
  assert.deepEqual(res.exact.map((r) => r.pid), [100]);
});

test('stale sidecars are reported, never deleted by the reader', () => {
  const stale = staleSidecars({ boardDir: BOARD_DIR, registryDir: REG_DIR, fsImpl: scenario() });
  assert.deepEqual(stale.sort((a, b) => a - b), [300, 999]);
});

// --- collisions --------------------------------------------------------------

test('an exact holder is a conflict; the same project is context; self never collides', () => {
  const rows = loadBoard({ boardDir: BOARD_DIR, registryDir: REG_DIR, fsImpl: scenario() });
  const file = '/opt/project-workbench/workspaces/Alpha/x.cshtml';

  const other = findCollisions(rows, { file });
  assert.deepEqual(other.exact.map((r) => r.pid), [100]);
  assert.equal(other.project, 'Alpha');

  const self = findCollisions(rows, { file, excludePid: 100 });
  assert.deepEqual(self.exact, [], 'the holder does not conflict with itself');

  const sibling = findCollisions(rows, { file: '/opt/project-workbench/workspaces/Alpha/untouched.cs' });
  assert.deepEqual(sibling.exact, [], 'a different file is not a conflict');
  assert.deepEqual(sibling.sameProject.map((r) => r.pid), [100], 'but the busy project is still worth knowing');
});

test('a relative path and an un-normalized path find the same holder', () => {
  const rows = loadBoard({ boardDir: BOARD_DIR, registryDir: REG_DIR, fsImpl: scenario() });
  const messy = '/opt/project-workbench/workspaces/Alpha/./sub/../x.cshtml';
  assert.deepEqual(findCollisions(rows, { file: messy }).exact.map((r) => r.pid), [100]);
});

// --- real filesystem ---------------------------------------------------------

test('a write is atomic and round-trips, leaving no temporary file behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-board-'));
  try {
    const written = writeEntry(dir, { pid: 4242, task: 'real io', filesInFlight: ['/a'] });
    assert.equal(written.task, 'real io');
    assert.deepEqual(fs.readdirSync(dir), ['4242.json'], 'the .tmp was renamed, not left');
    assert.equal(readEntry(dir, 4242).task, 'real io');
    assert.equal(readEntry(dir, 4243), null, 'a missing sidecar reads as null, not a throw');

    writeEntry(dir, mergeEntry(readEntry(dir, 4242), { pid: 4242, addFiles: ['/b'] }));
    const after = readEntry(dir, 4242);
    assert.deepEqual(after.filesInFlight, ['/b', '/a']);
    assert.equal(after.task, 'real io', 'a second writer preserved the first writer\'s task');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt sidecar reads as absent rather than poisoning the board', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pw-board-'));
  try {
    fs.writeFileSync(path.join(dir, '4242.json'), '{ truncated');
    assert.equal(readEntry(dir, 4242), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// GOA (PW_PER_USER_CLAUDE): every person's Claude has its own config dir, so its sessions
// register under <PW_USER_CRED_BASE>/<user>/claude/sessions, not ~/.claude/sessions. And in
// container mode the pane account cannot create /opt/project-workbench/state.
test('per-user Claude config dirs are all read, and the board falls back to a writable home', async (t) => {
  const { resolveRegistryDirs, resolveBoardDir, readRegistry } = await import('../app/session-board.js');
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const root = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'pw-board-goa-'));
  t.after(() => fsm.rmSync(root, { recursive: true, force: true }));
  const home = pathm.join(root, 'home'), base = pathm.join(root, 'pw-users');
  const reg = (dir, pid) => { fsm.mkdirSync(dir, { recursive: true }); fsm.writeFileSync(pathm.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: `s${pid}`, cwd: '/w' })); };
  reg(pathm.join(home, '.claude', 'sessions'), 11);
  reg(pathm.join(base, 'james%2Elevac', 'claude', 'sessions'), 22);
  reg(pathm.join(base, 'kevin%2Echarlebois', 'claude', 'sessions'), 33);
  reg(pathm.join(base, 'kevin%2Echarlebois', 'claude', 'sessions'), 22); // the same pid twice: one session
  fsm.mkdirSync(pathm.join(base, 'kevin%2Echarlebois', 'not-claude', 'sessions'), { recursive: true });
  const env = { HOME: home, PW_USER_CRED_BASE: base, CLAUDE_CONFIG_DIR: pathm.join(base, 'james%2Elevac', 'claude') };
  const dirs = resolveRegistryDirs(env);
  assert.deepEqual(dirs.sort(), [pathm.join(home, '.claude', 'sessions'), pathm.join(base, 'james%2Elevac', 'claude', 'sessions'), pathm.join(base, 'kevin%2Echarlebois', 'claude', 'sessions')].sort());
  assert.deepEqual(readRegistry(dirs).map((r) => r.pid).sort((a, b) => a - b), [11, 22, 33]);
  assert.deepEqual(resolveRegistryDirs({ ...env, PW_CLAUDE_SESSIONS_DIR: '/only' }), ['/only'], 'an explicit dir still wins');

  assert.equal(resolveBoardDir({ PW_SESSION_BOARD_DIR: '/x', HOME: home }), '/x');
  const denied = { accessSync: (d) => { const e = new Error('no'); e.code = d === '/opt/project-workbench' ? 'EACCES' : 'ENOENT'; throw e; } };
  assert.equal(resolveBoardDir({ HOME: home }, { fsImpl: denied }), pathm.join(home, '.local', 'state', 'pw-session-board'));
  const ok = { accessSync: () => {} };
  assert.equal(resolveBoardDir({ HOME: home }, { fsImpl: ok }), '/opt/project-workbench/state/sessions');
});
