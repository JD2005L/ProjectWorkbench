// What a local deploy IS, for as long as anyone cares about it.
//
// The local backend used to have no such thing. A deploy was a single HTTP
// request: the script ran, the whole output came back at the end, and the client
// painted it into a div. Close the modal and the div went with it — the run was
// still executing on the box, with no way to see it again — and History kept only
// a result and a 5000-character snippet nobody could reach from the table. The
// external service backend has had jobs, live logs and retained detail all along
// (app/deployment/routes.js `/jobs/:id/log`); this gives the local one the same
// three properties: an identity, progress while it runs, and retrievable detail
// afterwards.
//
// In-flight output lives in memory and is written to disk once, on completion.
// A dashboard restart therefore loses the log of a run in progress — which is
// honest, because the spawned script's pipes die with the process that owns them;
// what it must not do is lose a FINISHED run, so the write happens before the
// route answers.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// A deploy that prints more than this is misbehaving, and the interesting part of
// a failure is the end. Keep the tail and say so, rather than growing without
// bound in a long-lived process.
export const RUN_OUTPUT_CAP = 256 * 1024;
export const RUNS_KEPT_PER_SLOT = 20;

const slotKey = (project, target) => `${project}\u0000${target}`;
// Only ever used to build a filename, so it must not be able to escape the
// directory or collide across slots that differ only in punctuation.
const safe = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);

export function createDeployRuns({
  dir, cap = RUN_OUTPUT_CAP, keep = RUNS_KEPT_PER_SLOT,
  now = () => new Date(), newId = () => crypto.randomBytes(6).toString('hex'),
} = {}) {
  const active = new Map();   // slot -> running run
  const recent = new Map();   // slot -> last finished run (this process)

  const summary = run => ({
    id: run.id, project: run.project, target: run.target, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt || null,
    user: run.user || null, deployUser: run.deployUser || null, identitySource: run.identitySource || null,
    version: run.version || null, duration: run.duration || null, option: run.option || null,
    describe: run.describe || null, error: run.error || null,
    bytes: run.bytes, truncated: !!run.truncated,
  });

  function filePath(run) {
    return path.join(dir, `${run.startedAt.replace(/[:.]/g, '-')}-${safe(run.project)}-${safe(run.target)}-${run.id}.json`);
  }

  // The in-flight run for a slot, if this process is running one.
  function activeRun(project, target) { return active.get(slotKey(project, target)) || null; }

  function start(details) {
    const key = slotKey(details.project, details.target);
    const existing = active.get(key);
    // One run per slot. Two operators pressing Deploy on the same target used to
    // race each other's script; now the second one is told to watch the first.
    if (existing) return { started: false, run: summary(existing) };
    const run = {
      ...details, id: newId(), status: 'running',
      startedAt: now().toISOString(), output: '', bytes: 0, truncated: false,
    };
    active.set(key, run);
    return { started: true, run: summary(run), id: run.id };
  }

  function append(id, chunk) {
    const run = [...active.values()].find(value => value.id === id);
    if (!run || !chunk) return;
    const text = String(chunk);
    run.bytes += text.length;
    run.output += text;
    if (run.output.length > cap) {
      run.output = run.output.slice(run.output.length - cap);
      run.truncated = true;
    }
  }

  async function prune(project, target) {
    let entries;
    try { entries = await fs.readdir(dir); }
    catch { return; }
    const prefix = `-${safe(project)}-${safe(target)}-`;
    const mine = entries.filter(name => name.includes(prefix) && name.endsWith('.json')).sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - keep))) {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }

  async function finish(id, result) {
    const key = [...active.keys()].find(value => active.get(value).id === id);
    if (!key) return null;
    const run = active.get(key);
    Object.assign(run, result, { finishedAt: now().toISOString(), status: result.status || 'failed' });
    active.delete(key);
    recent.set(key, run);
    // 0600: a slot script's output is whatever the project chose to print, which
    // on this instance includes host names, share paths and service accounts.
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath(run), `${JSON.stringify({ ...summary(run), output: run.output }, null, 2)}\n`, { mode: 0o600 });
      await prune(run.project, run.target);
    } catch { /* a run that cannot be archived still has to return its result */ }
    return summary(run);
  }

  // The newest run for a slot: the one in flight, else this process's last one,
  // else the newest archived file (so a dashboard restart does not blank History
  // or the panel).
  async function latest(project, target) {
    const running = activeRun(project, target);
    if (running) return { ...summary(running), output: running.output, offset: running.bytes };
    const remembered = recent.get(slotKey(project, target));
    if (remembered) return { ...summary(remembered), output: remembered.output, offset: remembered.bytes };
    let entries;
    try { entries = await fs.readdir(dir); }
    catch { return null; }
    const prefix = `-${safe(project)}-${safe(target)}-`;
    const name = entries.filter(value => value.includes(prefix) && value.endsWith('.json')).sort().pop();
    if (!name) return null;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      return { ...saved, offset: saved.bytes ?? (saved.output || '').length };
    } catch { return null; }
  }

  async function byId(project, id) {
    // Alphanumeric only: this value reaches a filename lookup, so it must not be
    // able to carry a path. Not hex-only — the id format is this module's to
    // change, and a test that fakes readable ids should not have to know it.
    if (!/^[A-Za-z0-9]{2,32}$/.test(String(id || ''))) return null;
    for (const map of [active, recent]) {
      for (const run of map.values()) {
        if (run.id === id && run.project === project) return { ...summary(run), output: run.output, offset: run.bytes };
      }
    }
    let entries;
    try { entries = await fs.readdir(dir); }
    catch { return null; }
    const name = entries.find(value => value.endsWith(`-${id}.json`));
    if (!name) return null;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (saved.project !== project) return null;   // the route already checked access to THIS project
      return { ...saved, offset: saved.bytes ?? (saved.output || '').length };
    } catch { return null; }
  }

  // Incremental read for a poller. `after` is a byte count over everything ever
  // written, so a client that fell behind the truncation window is told rather
  // than silently handed a fragment from the wrong place.
  function since(run, after) {
    const from = Number.isFinite(after) && after >= 0 ? after : 0;
    const windowStart = run.bytes - (run.output || '').length;
    if (from >= run.bytes) return { chunk: '', offset: run.bytes, behind: false };
    if (from < windowStart) return { chunk: run.output, offset: run.bytes, behind: true };
    return { chunk: run.output.slice(from - windowStart), offset: run.bytes, behind: false };
  }

  return { start, append, finish, latest, byId, since, activeRun, summary, dir,
    // Synchronous existence check for startup wiring; the directory is created on
    // the first finish, so its absence is not an error.
    exists: () => fsSync.existsSync(dir) };
}
