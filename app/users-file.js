// Reading users.json — shared by app/server.js and
// app/project-terminal-credentials.mjs (the host-mode systemd terminal
// startup path) so both see the exact same records, including the legacy
// isAdmin -> role/projects/id normalization, rather than two independently
// maintained readers that could drift.
import fs from 'node:fs/promises';
import { normalizeUserRecord } from './users-compat.js';

export async function loadUsersFile(usersPath) {
  try {
    const raw = await fs.readFile(usersPath, 'utf8');
    const data = JSON.parse(raw);
    return (Array.isArray(data?.users) ? data.users : []).map(normalizeUserRecord);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
