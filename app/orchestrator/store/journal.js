// A durable, crash-safe, single-writer store built on a write-ahead journal and periodic snapshots.
//
// Why not SQLite: ProjectWorkbench's installer bootstraps Node 20 and CI runs Node 20, while
// `node:sqlite` needs 22.5+. A native module (better-sqlite3) would need a toolchain on every
// deployment host, which is exactly the kind of environment-specific requirement this product is
// supposed to avoid. So the durability primitives are built here, in the standard library, and the
// tests go after them directly — torn writes, mid-file corruption, stale locks, kill -9.
//
// The design, and the reasoning behind each part:
//
//   * **Append-only journal, one line per transaction.** A transaction is durable exactly when its
//     line is fsynced. There is no half-committed batch: the line is written whole or the checksum
//     rejects it on replay. That is what stops a crash leaving "a job that was implementing" with
//     no event explaining it.
//   * **CRC32 per line.** A torn *final* line is a crash and is discarded. A bad line with good
//     lines after it is corruption, not a crash, and the store refuses to open. Silently skipping
//     it would mean quietly losing durable evidence, which is worse than being down.
//   * **Absolute, idempotent operations.** Counters are recorded as values, never deltas, so
//     replaying a record that a snapshot already contains is harmless. This is what makes the
//     snapshot/truncate sequence safe to be interrupted anywhere.
//   * **Single in-process writer plus a cross-process lock file.** Two writers on one journal would
//     interleave lines; two *processes* would also both believe they own the project lanes.
//   * **Frozen deep copies.** Callers get snapshots, not references, so durable state cannot be
//     mutated by a route handler that forgot to clone.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

export class JournalCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptError';
  }
}

export class StoreLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreLockedError';
  }
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return ((c ^ -1) >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return value;
}

/** Store a frozen deep copy so neither side can mutate the other's view. */
function snapshotRecord(record) {
  return deepFreeze(structuredClone(record));
}

function fsyncDir(dirPath) {
  // A rename is only durable once the *directory* entry is synced. Not every filesystem or platform
  // permits opening a directory; a failure here is not fatal, so it is deliberately swallowed.
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — very much alive.
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * Collects the operations of one transaction. The callback runs synchronously and purely: it may
 * read committed state and stage writes, but nothing is applied until the batch is durable.
 */
class Transaction {
  constructor(store) {
    this._store = store;
    this.ops = [];
    this._pendingCounters = new Map();
  }

  put(kind, id, record) {
    this.ops.push({ op: 'put', kind, id, rec: structuredClone(record) });
    return this;
  }

  delete(kind, id) {
    this.ops.push({ op: 'del', kind, id });
    return this;
  }

  /**
   * Allocate the next value of a durable counter, returning it immediately.
   *
   * Recorded as an absolute value rather than an increment: replay must be idempotent, and an
   * event sequence that could be re-issued after a crash would corrupt every consumer's resume
   * cursor.
   */
  nextSequence(name) {
    const current = this._pendingCounters.has(name)
      ? this._pendingCounters.get(name)
      : this._store.counter(name);
    const next = current + 1;
    this._pendingCounters.set(name, next);
    this.ops.push({ op: 'seq', name, value: next });
    return next;
  }

  /** Set a durable counter to an exact value (used by reconciliation and migrations). */
  setCounter(name, value) {
    this._pendingCounters.set(name, value);
    this.ops.push({ op: 'seq', name, value });
    return this;
  }

  setMeta(key, value) {
    this.ops.push({ op: 'meta', key, value });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class JournalStore {
  constructor(options) {
    this.journalPath = options.journalPath;
    this.snapshotPath = options.snapshotPath;
    this.lockPath = options.lockPath;
    this.compactEveryRecords = options.compactEveryRecords ?? 2_000;

    /** @type {Map<string, Map<string, object>>} */
    this._kinds = new Map();
    /** @type {Map<string, number>} */
    this._counters = new Map();
    /** @type {Map<string, unknown>} */
    this._meta = new Map();

    this._fd = null;
    this._recordsSinceSnapshot = 0;
    this._writeChain = Promise.resolve();
    this._closed = false;
    this._releaseLock = null;
  }

  static async open(options) {
    const store = new JournalStore(options);
    await store._open(options.migrations ?? []);
    return store;
  }

  // -- reads -----------------------------------------------------------------

  get schemaVersion() {
    return Number(this._meta.get('schemaVersion') ?? 0);
  }

  get(kind, id) {
    return this._kinds.get(kind)?.get(id);
  }

  has(kind, id) {
    return Boolean(this._kinds.get(kind)?.has(id));
  }

  list(kind, filter = null) {
    const bucket = this._kinds.get(kind);
    if (!bucket) return [];
    const out = [];
    for (const record of bucket.values()) {
      if (!filter || filter(record)) out.push(record);
    }
    return out;
  }

  counter(name) {
    return this._counters.get(name) ?? 0;
  }

  meta(key) {
    return this._meta.get(key);
  }

  /** The read-only view handed to a transaction callback. */
  _view() {
    return {
      get: (kind, id) => this.get(kind, id),
      has: (kind, id) => this.has(kind, id),
      list: (kind, filter) => this.list(kind, filter),
      counter: (name) => this.counter(name),
      meta: (key) => this.meta(key),
    };
  }

  // -- writes ----------------------------------------------------------------

  /**
   * Run one atomic transaction.
   *
   * `fn(tx, state)` is synchronous by design: an `await` inside a transaction would let another
   * transaction's reads see a half-built batch, and the whole point of this layer is that no
   * observer ever sees one. Transactions are serialised, so a read-modify-write inside `fn` sees
   * the previous transaction's committed result.
   */
  transact(fn) {
    const run = async () => {
      if (this._closed) throw new Error('store is closed');
      const tx = new Transaction(this);
      const result = fn(tx, this._view());
      if (result && typeof result.then === 'function') {
        throw new Error('transaction callbacks must be synchronous');
      }
      if (tx.ops.length) {
        this._append(tx.ops);
        this._apply(tx.ops);
        this._recordsSinceSnapshot += 1;
        if (this._recordsSinceSnapshot >= this.compactEveryRecords) this._compact();
      }
      return result;
    };

    // Serialise: each transaction waits for the previous one, and a failure does not poison the
    // chain for subsequent callers.
    const queued = this._writeChain.then(run, run);
    this._writeChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  _append(ops) {
    const payload = Buffer.from(JSON.stringify({ ops }), 'utf8');
    const line = Buffer.concat([Buffer.from(`${crc32(payload)} `, 'utf8'), payload, Buffer.from('\n', 'utf8')]);
    fs.writeSync(this._fd, line);
    fs.fsyncSync(this._fd);
  }

  _apply(ops) {
    for (const op of ops) {
      switch (op.op) {
        case 'put': {
          let bucket = this._kinds.get(op.kind);
          if (!bucket) { bucket = new Map(); this._kinds.set(op.kind, bucket); }
          bucket.set(op.id, snapshotRecord(op.rec));
          break;
        }
        case 'del':
          this._kinds.get(op.kind)?.delete(op.id);
          break;
        case 'seq':
          this._counters.set(op.name, op.value);
          break;
        case 'meta':
          this._meta.set(op.key, op.value);
          break;
        default:
          throw new JournalCorruptError(`unknown journal operation: ${op.op}`);
      }
    }
  }

  // -- lifecycle -------------------------------------------------------------

  async _open(migrations) {
    for (const target of [this.journalPath, this.snapshotPath, this.lockPath]) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
    }
    this._acquireLock();

    try {
      this._loadSnapshot();
      this._replayJournal();

      const maxVersion = migrations.reduce((acc, m) => Math.max(acc, m.version), 0);
      if (this.schemaVersion > maxVersion) {
        throw new Error(
          `the store was written by a newer schema (v${this.schemaVersion}) than this build understands (v${maxVersion})`,
        );
      }

      this._fd = fs.openSync(this.journalPath, 'a');
      await this._runMigrations(migrations);
    } catch (err) {
      this._releaseLockNow();
      if (this._fd !== null) { try { fs.closeSync(this._fd); } catch { /* ignore */ } this._fd = null; }
      throw err;
    }
  }

  async _runMigrations(migrations) {
    const pending = migrations
      .filter((m) => m.version > this.schemaVersion)
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      // One transaction per migration: an interrupted upgrade resumes at the first migration that
      // did not commit, rather than re-running a partially applied one.
      // eslint-disable-next-line no-await-in-loop
      await this.transact((tx, state) => {
        migration.up(tx, state);
        tx.setMeta('schemaVersion', migration.version);
        tx.setMeta('schemaMigratedAt', new Date().toISOString());
      });
    }
  }

  _loadSnapshot() {
    if (!fs.existsSync(this.snapshotPath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    } catch (err) {
      throw new JournalCorruptError(`snapshot is unreadable: ${err.message}`);
    }
    for (const [kind, records] of Object.entries(parsed.kinds ?? {})) {
      const bucket = new Map();
      for (const [id, record] of Object.entries(records)) bucket.set(id, snapshotRecord(record));
      this._kinds.set(kind, bucket);
    }
    for (const [name, value] of Object.entries(parsed.counters ?? {})) this._counters.set(name, value);
    for (const [key, value] of Object.entries(parsed.meta ?? {})) this._meta.set(key, value);
  }

  _replayJournal() {
    if (!fs.existsSync(this.journalPath)) return;
    const raw = fs.readFileSync(this.journalPath, 'utf8');
    if (!raw.length) return;

    const lines = raw.split('\n');
    // A trailing newline yields a final empty element; a crash mid-append does not.
    const endsClean = lines[lines.length - 1] === '';
    if (endsClean) lines.pop();

    let applied = 0;
    let truncateAt = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.length) continue;
      const decoded = this._decodeLine(line);
      if (decoded === null) {
        const isFinalLine = i === lines.length - 1;
        if (isFinalLine && !endsClean) {
          // A torn write: the process died partway through the append. Drop it and truncate so the
          // next append starts from a clean boundary.
          truncateAt = lines.slice(0, i).reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0);
          break;
        }
        throw new JournalCorruptError(
          `journal record ${i + 1} of ${lines.length} failed its checksum; refusing to open rather than lose durable state`,
        );
      }
      this._apply(decoded);
      applied += 1;
    }

    if (truncateAt !== null) fs.truncateSync(this.journalPath, truncateAt);
    this._recordsSinceSnapshot = applied;
  }

  _decodeLine(line) {
    const space = line.indexOf(' ');
    if (space !== 8) return null;
    const expected = line.slice(0, space);
    const payload = Buffer.from(line.slice(space + 1), 'utf8');
    if (crc32(payload) !== expected) return null;
    try {
      const parsed = JSON.parse(payload.toString('utf8'));
      return Array.isArray(parsed.ops) ? parsed.ops : null;
    } catch {
      return null;
    }
  }

  /**
   * Write a snapshot and truncate the journal.
   *
   * Ordering matters: snapshot to a temp file, fsync, rename (atomic), fsync the directory, only
   * then truncate. A crash anywhere in that sequence leaves either the old snapshot plus a full
   * journal, or the new snapshot plus a journal whose records it already contains — and because
   * every operation is absolute, replaying those records changes nothing.
   */
  _compact() {
    const kinds = {};
    for (const [kind, bucket] of this._kinds) kinds[kind] = Object.fromEntries(bucket);
    const body = JSON.stringify({
      version: 1,
      writtenAt: new Date().toISOString(),
      kinds,
      counters: Object.fromEntries(this._counters),
      meta: Object.fromEntries(this._meta),
    });

    const tmp = `${this.snapshotPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.snapshotPath);
    fsyncDir(path.dirname(this.snapshotPath));

    fs.closeSync(this._fd);
    fs.truncateSync(this.journalPath, 0);
    this._fd = fs.openSync(this.journalPath, 'a');
    fs.fsyncSync(this._fd);
    this._recordsSinceSnapshot = 0;
  }

  async close() {
    if (this._closed) return;
    // Let any queued transaction finish before tearing the file descriptor out from under it.
    await this._writeChain;
    this._closed = true;
    if (this._fd !== null) {
      try { fs.fsyncSync(this._fd); } catch { /* ignore */ }
      try { fs.closeSync(this._fd); } catch { /* ignore */ }
      this._fd = null;
    }
    this._releaseLockNow();
  }

  // -- cross-process lock ----------------------------------------------------

  _acquireLock() {
    const payload = JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        const onExit = () => this._releaseLockNow();
        process.on('exit', onExit);
        this._releaseLock = () => {
          process.removeListener('exit', onExit);
          try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
        };
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { /* unreadable */ }

        // Only reclaim a lock this host can prove is dead. A lock from another host cannot be
        // checked, so it is respected — releasing it would let two writers share one journal.
        const sameHost = holder?.host === os.hostname();
        if (holder && sameHost && !processAlive(holder.pid)) {
          try { fs.unlinkSync(this.lockPath); } catch { /* raced with another reclaimer */ }
          continue;
        }
        throw new StoreLockedError(
          `the orchestrator store at ${this.journalPath} is locked by another process`
          + (holder?.pid ? ` (pid ${holder.pid} on ${holder.host})` : ''),
        );
      }
    }
    throw new StoreLockedError(`could not acquire the orchestrator store lock at ${this.lockPath}`);
  }

  _releaseLockNow() {
    if (this._releaseLock) {
      this._releaseLock();
      this._releaseLock = null;
    }
  }
}
