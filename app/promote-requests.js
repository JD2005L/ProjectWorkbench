// Promote requests: the dashboard half of "the agent asks, an administrator approves".
//
// The agent (or anyone on the box) asks for a promote; the host service pw-promote-runner
// snapshots the workspace and dry-runs the promote against that snapshot; an administrator
// reviews the dry run in Settings > System & Updates and approves; the runner then promotes
// exactly that snapshot. See deploy/host/files/usr/local/sbin/pw-promote-runner for the host
// side and the reasons for each of its checks.
//
// Everything lives in a spool that only root can read or write (/etc/project-workbench/promote,
// 0700): this process is root in its container, the runner is root on the host, and the agent
// account is neither. Files, by writer:
//
//   requests/<id>/request.json     dashboard   who asked, when, their note
//   requests/<id>/superseded.json  dashboard   a newer request replaced this one before approval
//   requests/<id>/rejected.json    dashboard   an administrator declined it
//   requests/<id>/approval.json    dashboard   approver, digest approved, expiry
//   requests/<id>/status.json      runner      snapshot / dry run / promote progress and result
//   requests/<id>/*.log            runner      dry-run and promote output
//   queue/<id>.dryrun|.promote     dashboard   work for the runner (pw-promote.path watches it)
//
// No file has two writers, so a request's state is DERIVED from what exists (deriveState).
// Authorization is not decided here: server.js gates submit/read on trusted-local or admin, and
// approve/reject on a real signed-in administrator who re-enters their password.
import fsDefault from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROMOTE_ID_RE = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
export const APPROVAL_TTL_MS = 24 * 3600 * 1000;
export const DRY_RUN_FRESH_MS = 24 * 3600 * 1000;
// States in which a request still occupies the single promote slot.
const PENDING = new Set(['queued', 'snapshotting', 'dry-running', 'awaiting-approval', 'stale']);
const BUSY = new Set(['approved', 'promoting']);
const LOG_TAIL_BYTES = 256 * 1024;

export class PromoteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function deriveState({ status, approval, rejection, superseded }, now) {
  const s = status?.state;
  if (s === 'promoting' || s === 'promoted' || s === 'failed' || s === 'refused') return s;
  if (rejection) return 'rejected';
  if (superseded) return 'superseded';
  if (s === 'dry-run-failed') return 'dry-run-failed';
  if (approval) return Date.parse(approval.expiresAt) > now ? 'approved' : 'expired';
  if (s === 'dry-run-ok') return now - Date.parse(status.finishedAt) > DRY_RUN_FRESH_MS ? 'stale' : 'awaiting-approval';
  if (s === 'snapshotting' || s === 'dry-running') return s;
  return 'queued';
}

export function createPromoteRequests({ spool, fsp = fsDefault, now = () => Date.now() }) {
  const requestsDir = path.join(spool, 'requests');
  const queueDir = path.join(spool, 'queue');
  const dirOf = (id) => path.join(requestsDir, id);

  // Every mutation runs one at a time, so "is anything busy?" and the write that follows cannot
  // interleave with another request's.
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  async function installed() {
    try {
      const [r, q] = await Promise.all([fsp.stat(requestsDir), fsp.stat(queueDir)]);
      return r.isDirectory() && q.isDirectory();
    } catch { return false; }
  }
  async function readJson(file) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
  }
  async function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.rename(tmp, file);
  }
  async function tail(file) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, size - len);
      return (size > len ? '…(earlier output trimmed)\n' : '') + buf.toString('utf8');
    } catch { return null; } finally { await handle?.close().catch(() => {}); }
  }

  async function load(id, { logs = false } = {}) {
    if (!PROMOTE_ID_RE.test(String(id))) return null;
    const dir = dirOf(id);
    const [request, status, approval, rejection, superseded] = await Promise.all(
      ['request.json', 'status.json', 'approval.json', 'rejected.json', 'superseded.json'].map((f) => readJson(path.join(dir, f))));
    if (!request) return null;
    const state = deriveState({ status, approval, rejection, superseded }, now());
    const out = {
      id, state,
      createdAt: request.createdAt, requestedBy: request.requestedBy, note: request.note || '',
      head: status?.head || null, digest: status?.digest || null, files: status?.files ?? null, bytes: status?.bytes ?? null,
      snapshotAt: status?.snapshotAt || null, promoteStartedAt: status?.promoteStartedAt || null, finishedAt: status?.finishedAt || null,
      error: status?.error || null, exitCode: status?.exitCode ?? null, updatedAt: status?.updatedAt || request.createdAt,
      approval: approval ? { by: approval.approvedBy, at: approval.approvedAt, expiresAt: approval.expiresAt } : null,
      rejection: rejection ? { by: rejection.by, at: rejection.at, reason: rejection.reason || '' } : null,
      supersededBy: superseded?.by || null,
    };
    if (logs) {
      out.dryRunLog = await tail(path.join(dir, 'dry-run.log'));
      out.promoteLog = await tail(path.join(dir, 'promote.log'));
    }
    return out;
  }

  async function list(limit = 10) {
    let names = [];
    try { names = await fsp.readdir(requestsDir); } catch { return []; }
    const ids = names.filter((n) => PROMOTE_ID_RE.test(n)).sort().reverse().slice(0, Math.max(1, Math.min(50, limit)));
    return (await Promise.all(ids.map((id) => load(id)))).filter(Boolean);
  }

  function newId() {
    const d = new Date(now());
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z-${crypto.randomBytes(4).toString('hex')}`;
  }

  const submit = ({ note = '', requestedBy }) => serial(async () => {
    if (!(await installed())) throw new PromoteError(503, 'promote_not_installed', 'Promote approvals are not installed on this host (see deploy/host/README.md).');
    const recent = await list(50);
    const busy = recent.find((r) => BUSY.has(r.state));
    if (busy) throw new PromoteError(409, 'promote_busy', `Request ${busy.id} is ${busy.state}; wait for it to finish.`);
    const id = newId();
    const at = new Date(now()).toISOString();
    // A new request replaces any that has not been approved yet: there is one promote slot, and
    // reviewing a dry run of superseded code would be reviewing the wrong thing.
    for (const r of recent.filter((x) => PENDING.has(x.state))) {
      await writeJson(path.join(dirOf(r.id), 'superseded.json'), { by: id, at });
    }
    await fsp.mkdir(dirOf(id), { mode: 0o700 });
    await writeJson(path.join(dirOf(id), 'request.json'), {
      id, createdAt: at, requestedBy: String(requestedBy || 'unknown').slice(0, 120), note: String(note || '').slice(0, 2000),
    });
    await writeJson(path.join(queueDir, `${id}.dryrun`), { id, job: 'dryrun', at });
    return load(id);
  });

  const approve = (id, { approver, digest }) => serial(async () => {
    const r = await load(id);
    if (!r) throw new PromoteError(404, 'promote_not_found', 'No such promote request.');
    if (r.state !== 'awaiting-approval') {
      throw new PromoteError(409, 'promote_not_approvable', r.state === 'stale'
        ? 'This dry run is more than a day old; ask for a fresh request.'
        : `This request is ${r.state} and cannot be approved.`);
    }
    if (!digest || digest !== r.digest) throw new PromoteError(409, 'promote_digest_mismatch', 'The reviewed snapshot does not match this request; reload and review again.');
    const busy = (await list(50)).find((x) => BUSY.has(x.state));
    if (busy) throw new PromoteError(409, 'promote_busy', `Request ${busy.id} is ${busy.state}.`);
    const approvedAt = now();
    await writeJson(path.join(dirOf(id), 'approval.json'), {
      id, approvedBy: approver, approvedAt: new Date(approvedAt).toISOString(),
      expiresAt: new Date(approvedAt + APPROVAL_TTL_MS).toISOString(), digest,
    });
    await writeJson(path.join(queueDir, `${id}.promote`), { id, job: 'promote', at: new Date(approvedAt).toISOString() });
    return load(id);
  });

  const reject = (id, { by, reason = '' }) => serial(async () => {
    const r = await load(id);
    if (!r) throw new PromoteError(404, 'promote_not_found', 'No such promote request.');
    if (!PENDING.has(r.state) && r.state !== 'dry-run-failed') throw new PromoteError(409, 'promote_not_rejectable', `This request is ${r.state}.`);
    await writeJson(path.join(dirOf(id), 'rejected.json'), { by, at: new Date(now()).toISOString(), reason: String(reason).slice(0, 2000) });
    return load(id);
  });

  return { installed, list, load, submit, approve, reject };
}
