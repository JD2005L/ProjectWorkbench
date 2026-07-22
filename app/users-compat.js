// Backward-compat: legacy user records (GOA / pre-role fork) used
// `isAdmin: boolean` with no `role`/`projects`/`id`. Canonical authorizes on
// `role`+`projects` and resolves sessions by `id`, so map legacy records
// forward on load: isAdmin?admin:developer, projects '*' (mirroring what the
// pre-consolidation code derived inline). Canonical-native records (which
// already set `role`) keep their role untouched. The obsolete `isAdmin` field
// is dropped in either case, so the next saveUsers() persists canonical
// records only.
export function normalizeUserRecord(u) {
 if (!u || typeof u !== 'object') return u;
 if (('isAdmin' in u) && u.role == null) {
  u.role = u.isAdmin === true ? 'admin' : 'developer';
  if (u.projects === undefined) u.projects = '*';
 }
 if ('isAdmin' in u) delete u.isAdmin;
 if (u.id == null) u.id = u.username;
 return u;
}
