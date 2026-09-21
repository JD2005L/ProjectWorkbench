// The cockpit tab strip colours a tab by WHOSE Claude/Copilot account its pane runs
// on. Two properties matter more than the colours themselves:
//
//   * an operator's explicit mapping is honoured exactly — "orange is James" is a
//     human agreement, and a tab that quietly picks its own colour makes the strip
//     lie about who is spending a seat;
//   * a colour is STABLE for a given username, across processes and restarts, so a
//     tab does not change identity-colour under someone mid-session.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USER_TAB_PALETTE,
  USER_TAB_COLOR_NAMES,
  normalizeUserTabColors,
  resolveUserTabColor,
  userTabColorCss,
} from '../app/user-colors.js';

test('an explicit mapping is honoured exactly', () => {
  const map = { 'james.levac': 'orange', 'kevin.charlebois': 'yellow' };
  assert.equal(resolveUserTabColor('james.levac', map), 'orange');
  assert.equal(resolveUserTabColor('kevin.charlebois', map), 'yellow');
  assert.equal(userTabColorCss(resolveUserTabColor('james.levac', map)), USER_TAB_PALETTE.orange);
});

test('an unmapped user still gets a colour, and always the SAME one', () => {
  const map = { 'james.levac': 'orange' };
  const first = resolveUserTabColor('someone.new', map);
  assert.ok(first, 'a colourless tab would be indistinguishable from the shared login');
  assert.ok(USER_TAB_COLOR_NAMES.includes(first));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(resolveUserTabColor('someone.new', map), first, 'the hashed colour must not vary between calls');
  }
});

test('the hashed fallback never steals a colour the operator assigned', () => {
  // Every palette colour but one is claimed; the only colour left is the one the
  // unmapped user must get. If the fallback ignored the mapping it could hand out
  // "Kevin's yellow" to a third person, and the strip would be actively misleading.
  const claimed = {};
  for (const [i, color] of USER_TAB_COLOR_NAMES.entries()) {
    if (color === 'lime') continue;
    claimed[`user${i}`] = color;
  }
  assert.equal(resolveUserTabColor('unmapped.person', claimed), 'lime');
});

test('when every colour is claimed, a colour is still returned', () => {
  const claimed = {};
  for (const [i, color] of USER_TAB_COLOR_NAMES.entries()) claimed[`user${i}`] = color;
  const got = resolveUserTabColor('unmapped.person', claimed);
  assert.ok(USER_TAB_COLOR_NAMES.includes(got), 'a duplicate colour beats no colour at all');
});

test('no user means no colour', () => {
  assert.equal(resolveUserTabColor('', { a: 'orange' }), '');
  assert.equal(resolveUserTabColor(null), '');
  assert.equal(resolveUserTabColor(undefined), '');
});

test('operator config is validated, never trusted', () => {
  // Built via JSON.parse so "__proto__" is a real OWN property: an object literal
  // would set the prototype instead, and the test would pass without testing anything.
  const raw = JSON.parse('{"good.user":"Orange  ","bad.color":"chartreuse","bad.type":42,"":"orange","__proto__":"orange"}');
  const got = normalizeUserTabColors(raw);
  assert.deepEqual({ ...got }, { 'good.user': 'orange' });
  assert.equal(Object.getPrototypeOf({}).orange, undefined, 'prototype must be untouched');
  assert.equal(Object.getPrototypeOf(got), Object.prototype, 'the result must be an ordinary object');
});

test('a malformed or missing mapping degrades to "no overrides", never throws', () => {
  for (const bad of [null, undefined, 'orange', 42, ['orange']]) {
    assert.deepEqual(normalizeUserTabColors(bad), {}, `${JSON.stringify(bad)} must be ignored`);
  }
});

test('unknown colour names render as no style rather than invalid CSS', () => {
  assert.equal(userTabColorCss('chartreuse'), '');
  assert.equal(userTabColorCss(''), '');
  assert.equal(userTabColorCss('toString'), '', 'an inherited property is not a palette entry');
});

test('the palette is all real hex colours and has no duplicates', () => {
  const values = Object.values(USER_TAB_PALETTE);
  for (const v of values) assert.match(v, /^#[0-9a-f]{6}$/, `${v} must be a hex colour`);
  assert.equal(new Set(values).size, values.length, 'two names for one colour cannot be told apart');
});
