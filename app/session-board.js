// The shared session board: what every Claude session on this host is doing.
//
// ============================================================================
// WHY THIS EXISTS
//
// Claude Code already keeps a per-session registry at ~/.claude/sessions/<pid>.json
// (pid, sessionId, cwd, startedAt, version, peerFeatures, kind, tmux pane). That
// answers "which sessions exist and where". It does not answer the question that
// actually costs work: WHAT is each one doing, and which files is it holding.
//
// The gap has real cost. Two sessions edited the same Allocation.cshtml in
// ProVisionIPortal and found out by chance; in this repo another session modified
// app/server.js, app/ci-results.js and app/credential-writer.mjs underneath a
// session that only noticed because it diffed before staging. 160 peer sessions
// were live on this host when that happened.
//
// So this module joins a PW-owned sidecar (the task-level fields) onto the
// harness registry (identity and liveness). It never writes into the registry:
// those files belong to Claude Code, and a status board has no business editing
// them.
//
// LIVENESS IS A PROCESS QUESTION. A sidecar is trusted only while its pid is
// running AND its /proc start time still matches the one the registry recorded.
// Without that second check a recycled pid makes a dead session's claims look
// current, which is worse than no board at all — it would route work away from a
// file nobody holds. This mirrors pw-claude-hibernate, which learned the same
// lesson about markers that cannot distinguish a live conversation from a corpse.
//
// EVERY FIELD IS BOUNDED. A board is written by a hook on every edit, by every
// session, forever. Unbounded strings and an unbounded file list would make it
// grow without limit and eventually cost more to read than it saves.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BOARD_DIR = '/opt/project-workbench/state/sessions';
export const BOARD_DIR_ENV = 'PW_SESSION_BOARD_DIR';

// Caps. Generous enough for real use, small enough that the whole board stays a
// cheap read even with every session on the host reporting.
export const LIMITS = Object.freeze({ task: 300, waitingOn: 300, branch: 120, files: 40, pathLen: 400 });

export function resolveBoardDir(env = process.env) {
  return env[BOARD_DIR_ENV] || DEFAULT_BOARD_DIR;
}
export function resolveRegistryDir(env = process.env) {
  return env.PW_CLAUDE_SESSIONS_DIR || path.join(env.HOME || os.homedir(), '.claude', 'sessions');
}

const clip = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n));

// A workspace or a worktree resolves to the same project name, because two
// sessions in different worktrees of one repo still collide on a push and on a
// shared branch — treating them as unrelated projects would hide exactly the
// conflict this board is for.
export function projectOf(cwd) {
  const s = String(cwd || '');
  let m = /\/project-workbench\/workspaces\/([^/]+)/.exec(s);
  if (m) return m[1];
  m = /\/project-workbench\/worktrees\/([^/]+?)-[^/]*$/.exec(s);
  if (m) return m[1];
  m = /\/project-workbench\/worktrees\/([^/]+)/.exec(s);
  return m ? m[1] : '';
}

// ---- liveness ---------------------------------------------------------------
// procStart is field 22 of /proc/<pid>/stat, after the comm field, which may
// itself contain spaces and parentheses — hence the slice from the LAST ')'.
export function procStart(pid, { procRoot = '/proc', readFileSync = fs.readFileSync } = {}) {
  try {
    const s = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(') ') + 2).split(' ');
    return { state: String(f[0] ?? '').trim(), starttime: String(f[19] ?? '').trim() };
  } catch { return null; }
}

export function isLive(entry, opts = {}) {
  const pid = Number(entry?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const st = procStart(pid, opts);
  if (!st || st.state === 'Z') return false;
  // The registry records procStart as a string; compare as strings so a missing
  // or reformatted value never silently passes a numeric coercion.
  if (entry.procStart != null && String(entry.procStart) !== String(st.starttime)) return false;
  return true;
}

// ---- the sidecar ------------------------------------------------------------
export function sidecarPath(boardDir, pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) throw new Error(`refusing a sidecar for pid ${pid}`);
  return path.join(boardDir, `${n}.json`);
}

// Normalising on the way IN is what keeps every reader cheap and every field
// bounded, rather than hoping each writer behaves.
export function normalizeEntry(raw = {}) {
  const files = Array.isArray(raw.filesInFlight) ? raw.filesInFlight : [];
  return {
    pid: Number(raw.pid) || 0,
    sessionId: clip(raw.sessionId, 64),
    project: clip(raw.project, 120),
    branch: clip(raw.branch, LIMITS.branch),
    task: clip(raw.task, LIMITS.task),
    waitingOn: clip(raw.waitingOn, LIMITS.waitingOn),
    // Most recent first, de-duplicated, capped: the newest claim is the one a
    // colliding session needs to see.
    filesInFlight: [...new Set(files.map((f) => clip(f, LIMITS.pathLen)).filter(Boolean))].slice(0, LIMITS.files),
    updatedAt: clip(raw.updatedAt, 40) || new Date().toISOString(),
  };
}

export function readEntry(boardDir, pid, { readFileSync = fs.readFileSync } = {}) {
  try {
    return normalizeEntry(JSON.parse(readFileSync(sidecarPath(boardDir, pid), 'utf8')));
  } catch { return null; }
}

// Written tmp-then-rename so a reader never sees a half-written board, and so two
// hooks racing in one session leave a whole file rather than a torn one.
export function writeEntry(boardDir, entry, { fsImpl = fs } = {}) {
  const e = normalizeEntry(entry);
  const dest = sidecarPath(boardDir, e.pid);
  const tmp = `${dest}.${process.pid}.tmp`;
  fsImpl.mkdirSync(boardDir, { recursive: true });
  fsImpl.writeFileSync(tmp, `${JSON.stringify(e, null, 2)}\n`, { mode: 0o644 });
  fsImpl.renameSync(tmp, dest);
  return e;
}

// A field given as undefined is left alone; '' clears it. That distinction is
// what lets one hook set filesInFlight without erasing the task another set.
export function mergeEntry(previous, update) {
  const base = previous ? normalizeEntry(previous) : normalizeEntry({ pid: update.pid });
  const next = { ...base };
  for (const k of ['sessionId', 'project', 'branch', 'task', 'waitingOn']) {
    if (update[k] !== undefined) next[k] = update[k];
  }
  if (update.pid !== undefined) next.pid = update.pid;
  if (update.filesInFlight !== undefined) next.filesInFlight = update.filesInFlight;
  else if (update.addFiles) next.filesInFlight = [...update.addFiles, ...base.filesInFlight];
  next.updatedAt = update.updatedAt || new Date().toISOString();
  return normalizeEntry(next);
}

// ---- the join ---------------------------------------------------------------
export function readRegistry(registryDir, { fsImpl = fs } = {}) {
  let names = [];
  try { names = fsImpl.readdirSync(registryDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const r = JSON.parse(fsImpl.readFileSync(path.join(registryDir, n), 'utf8'));
      if (Number.isInteger(Number(r.pid))) out.push(r);
    } catch { /* a registry file mid-write is not an error here */ }
  }
  return out;
}

// The board: one row per LIVE registered session, with whatever the sidecar knows.
// A session with no sidecar still appears — "running, said nothing" is useful, and
// omitting it would make the board look authoritative when it is merely quiet.
export function loadBoard({ boardDir, registryDir, fsImpl = fs, procRoot = '/proc', now = Date.now() } = {}) {
  const rows = [];
  for (const reg of readRegistry(registryDir, { fsImpl })) {
    if (!isLive(reg, { procRoot, readFileSync: fsImpl.readFileSync })) continue;
    const side = readEntry(boardDir, reg.pid, { readFileSync: fsImpl.readFileSync });
    rows.push({
      pid: Number(reg.pid),
      sessionId: String(reg.sessionId || ''),
      cwd: String(reg.cwd || ''),
      project: side?.project || projectOf(reg.cwd),
      tmux: String(reg.tmuxPane || reg.tmux || ''),
      kind: String(reg.kind || ''),
      branch: side?.branch || '',
      task: side?.task || '',
      waitingOn: side?.waitingOn || '',
      filesInFlight: side?.filesInFlight || [],
      updatedAt: side?.updatedAt || '',
      staleMs: side?.updatedAt ? Math.max(0, now - Date.parse(side.updatedAt)) : null,
      reporting: !!side,
    });
  }
  return rows.sort((a, b) => (a.project || '').localeCompare(b.project || '') || a.pid - b.pid);
}

// Sidecars whose session is gone. Returned rather than deleted: a caller decides
// whether this run is allowed to prune.
export function staleSidecars({ boardDir, registryDir, fsImpl = fs, procRoot = '/proc' } = {}) {
  const live = new Set(loadBoard({ boardDir, registryDir, fsImpl, procRoot }).map((r) => r.pid));
  let names = [];
  try { names = fsImpl.readdirSync(boardDir); } catch { return []; }
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .filter((pid) => !live.has(pid));
}

// ---- the question the board exists to answer --------------------------------
// Who else is holding this path? Exact path first, then the same project, because
// "another session is working in this repo" is itself worth knowing before a
// branch change or a push even when the file lists do not intersect.
export function findCollisions(rows, { file = '', project = '', excludePid = 0 } = {}) {
  const target = file ? path.resolve(file) : '';
  const proj = project || (target ? projectOf(target) : '');
  const exact = [];
  const sameProject = [];
  for (const r of rows) {
    if (r.pid === Number(excludePid)) continue;
    const holds = target && r.filesInFlight.some((f) => path.resolve(f) === target);
    if (holds) exact.push(r);
    else if (proj && r.project === proj) sameProject.push(r);
  }
  return { file: target, project: proj, exact, sameProject };
}
