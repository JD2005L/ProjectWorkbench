// Inbox pins — files a person wants kept past the inbox expiry.
//
// Every project's `_inbox` expires files older than PW_INBOX_EXPIRY_DAYS (see the
// sweep in server.js). A pinned file is skipped by that sweep for as long as it
// stays pinned; once unpinned it is ordinary again, so if it is already past its
// age the next sweep removes it.
//
// The pins live in ONE root-owned file outside every workspace, not beside the
// files: a workspace belongs to the pane account, so anything its sessions run —
// an AI agent included — could otherwise pin or unpin files on a person's behalf.
// Pins are keyed by file name, which is what the box worker addresses files by.
// A pin whose file is gone is dropped at the next sweep (pruneMissing).

import path from 'node:path';

export function createInboxPins({ fsp, file, writeFileAtomic }) {
  let cache = null; // { [project]: string[] }
  let chain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`[inbox-pins] unreadable ${file}: ${error?.message || error}; treating as empty`);
      cache = {};
    }
    for (const [project, names] of Object.entries(cache)) {
      if (!Array.isArray(names)) delete cache[project];
    }
    return cache;
  }

  // Writes are serialised so two quick toggles cannot overwrite each other.
  function mutate(fn) {
    const run = chain.then(async () => {
      const state = await load();
      const changed = fn(state);
      if (changed) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    async pinned(project) {
      const state = await load();
      return new Set(state[project] || []);
    },
    setPinned(project, name, on) {
      return mutate((state) => {
        const names = new Set(state[project] || []);
        const had = names.has(name);
        if (on) names.add(name); else names.delete(name);
        if (had === !!on) return false;
        if (names.size) state[project] = [...names].sort(); else delete state[project];
        return true;
      });
    },
    // Forget pins for files that no longer exist (deleted, renamed, or the whole
    // project removed), so a later upload with the same name is not silently pinned.
    pruneMissing(project, existingNames) {
      const existing = new Set(existingNames);
      return mutate((state) => {
        const names = state[project] || [];
        const kept = names.filter((n) => existing.has(n));
        if (kept.length === names.length) return false;
        if (kept.length) state[project] = kept; else delete state[project];
        return true;
      });
    },
  };
}

/** When a file would expire, or null when it never will (pinned, or expiry off). */
export function inboxExpiresAt({ mtime, pinned, maxAgeDays }) {
  const days = Number(maxAgeDays);
  if (pinned || !(days > 0)) return null;
  const t = Date.parse(mtime);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString();
}
