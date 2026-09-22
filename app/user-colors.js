// Which colour identifies a person in the cockpit tab strip.
//
// Per-launcher credentials (PW_PER_LAUNCHER_CLAUDE) mean two people's tabs sit
// side by side in ONE project's tab strip, each spending a different Copilot /
// Claude seat. The colour exists so that is visible at a glance: the tab you are
// about to type into is billed to whoever launched it, and nothing else in the
// strip says so.
//
// It is AWARENESS, not a control. Every pane still runs as the same OS account,
// so a colour cannot stop anyone typing in anyone else's tab — see
// docs/per-user-claude-credentials.md.
//
// Assignment is deliberate-then-deterministic:
//   1. an operator's explicit mapping (workbench.json `userTabColors`) always wins,
//      because "my colour is orange" is a human agreement, not something to derive;
//   2. anyone unmapped gets a stable colour hashed from their username, so a new
//      teammate is never colourless and never changes colour between requests.
//
// The fallback pool EXCLUDES colours already claimed by the explicit mapping.
// Otherwise a hash collision would silently paint a third person in the colour
// the team had agreed means "Kevin", which is worse than having no colour at all.

// Deliberately chosen against the cockpit's dark panels (--bg #070c18) and kept
// distinguishable from the strip's existing state colours: --cyan marks 'resuming',
// --amber2 marks 'attention', --ok marks 'working'. A tab's owner colour is drawn
// as its own dot + left edge so it never competes with those.
export const USER_TAB_PALETTE = Object.freeze({
  orange: '#f97316',
  yellow: '#fbbf24',
  violet: '#a78bfa',
  green:  '#4ade80',
  pink:   '#f472b6',
  blue:   '#60a5fa',
  teal:   '#2dd4bf',
  lime:   '#a3e635',
  red:    '#fb7185',
  sky:    '#7dd3fc',
});

export const USER_TAB_COLOR_NAMES = Object.freeze(Object.keys(USER_TAB_PALETTE));

// A mapping is operator-supplied config, so it is validated rather than trusted:
// unknown colours, non-string keys and a runaway file all degrade to "no override"
// for the offending entry instead of throwing and taking the tab strip down.
const MAX_ENTRIES = 500;

export function normalizeUserTabColors(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_ENTRIES) break;
    // Prototype keys would land on Object.prototype rather than the map.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const username = String(key || '').trim();
    if (!username || username.length > 255) continue;
    const color = String(value ?? '').trim().toLowerCase();
    if (!Object.hasOwn(USER_TAB_PALETTE, color)) continue;
    out[username] = color;
    n += 1;
  }
  return out;
}

// djb2 — the same hash projHue() uses for project monogram hues, for the same
// reason: it must be stable across processes and restarts, so a tab does not
// change colour when the dashboard is restarted.
function hashName(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The palette NAME for a user, or '' when there is no user to colour. */
export function resolveUserTabColor(username, overrides = {}) {
  const name = String(username || '').trim();
  if (!name) return '';
  const map = normalizeUserTabColors(overrides);
  if (map[name]) return map[name];
  const claimed = new Set(Object.values(map));
  const pool = USER_TAB_COLOR_NAMES.filter((c) => !claimed.has(c));
  // Everything claimed: fall back to the whole palette rather than no colour.
  const candidates = pool.length ? pool : USER_TAB_COLOR_NAMES;
  return candidates[hashName(name) % candidates.length];
}

/** CSS colour for a palette name; '' for anything unknown, so callers can omit the style. */
export function userTabColorCss(color) {
  const key = String(color || '').trim().toLowerCase();
  return Object.hasOwn(USER_TAB_PALETTE, key) ? USER_TAB_PALETTE[key] : '';
}

/**
 * The instance's colour assignments, from the two places a choice can live.
 *
 * Precedence, and why:
 *   1. the person's own stored choice (`tabColor` on their user record) — a colour is
 *      part of how a team refers to each other ("the orange tabs are James"), so the
 *      person and their administrator can set it deliberately;
 *   2. the operator map in workbench.json (`userTabColors`) — how this was configured
 *      before there was any UI for it, kept working rather than silently discarded;
 *   3. nothing: resolveUserTabColor() then hashes a stable colour out of whatever is
 *      left unclaimed by 1 and 2.
 *
 * Merging them into ONE map is what makes 3 behave: the hash draws only from colours
 * nobody has claimed, and it cannot tell a record choice from an operator one.
 */
export function mergeUserTabColors(userRecords = [], operatorMap = {}) {
  const chosen = {};
  for (const u of userRecords || []) {
    if (u && u.username && u.tabColor) chosen[u.username] = u.tabColor;
  }
  return { ...normalizeUserTabColors(operatorMap), ...normalizeUserTabColors(chosen) };
}

/**
 * Who has explicitly claimed each colour — for a picker, so two people cannot end up
 * agreeing on the same colour and undoing the point of having one.
 *
 * Only EXPLICIT claims count. A hashed colour is not a claim: it moves aside on its own
 * the moment somebody chooses that colour deliberately, so refusing a deliberate choice
 * because a hash happened to land there would be backwards.
 */
export function userTabColorClaims(userRecords = [], operatorMap = {}) {
  const claims = {};
  for (const [username, color] of Object.entries(mergeUserTabColors(userRecords, operatorMap))) {
    if (!claims[color]) claims[color] = username;
  }
  return claims;
}

/** The palette as the UI needs it: a name and the colour it draws. */
export function userTabPaletteList() {
  return USER_TAB_COLOR_NAMES.map((name) => ({ name, css: USER_TAB_PALETTE[name] }));
}

/** A colour name as it may be stored on a user record: a palette name, or '' for automatic. */
export function normalizeUserTabColorChoice(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  return Object.hasOwn(USER_TAB_PALETTE, v) ? v : null;   // null = invalid, caller rejects
}
