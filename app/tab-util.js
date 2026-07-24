// Deterministic, collision-free names for repeatable CLI tab launchers.
//
// The cockpit new-tab menu offers the Claude / Copilot launchers repeatedly.
// tmux windows are addressed by index (not name), so duplicate names are safe,
// but a readable suffix (" 2", " 3", ...) keeps the strip legible when several
// of the same launcher are open. `existing` is anything with a `.has(name)`
// method (a Set in the browser).
export function uniqueTabName(base, existing) {
  if (!existing || !existing.has(base)) return base;
  let n = 2;
  while (existing.has(base + ' ' + n)) n++;
  return base + ' ' + n;
}

// The exact function source is injected into the cockpit client script (which
// is assembled as a string) so the browser runs the same implementation these
// tests cover — one source of truth, no drift.
export const uniqueTabNameClientSrc = uniqueTabName.toString();