// Repeatable CLI tab launchers must produce unique, readable window names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueTabName, uniqueTabNameClientSrc } from '../app/tab-util.js';

test('returns base when not present', () => {
  assert.equal(uniqueTabName('Claude Code', new Set()), 'Claude Code');
  assert.equal(uniqueTabName('Claude Code', new Set(['Other'])), 'Claude Code');
});

test('suffixes " 2", " 3" on collision', () => {
  assert.equal(uniqueTabName('Claude Code', new Set(['Claude Code'])), 'Claude Code 2');
  assert.equal(uniqueTabName('Claude Code', new Set(['Claude Code', 'Claude Code 2'])), 'Claude Code 3');
});

test('base free even if a suffixed name exists', () => {
  assert.equal(uniqueTabName('X', new Set(['X 2'])), 'X');
});

test('missing existing => base', () => {
  assert.equal(uniqueTabName('X'), 'X');
  assert.equal(uniqueTabName('X', null), 'X');
});

test('injected client source matches module behaviour', () => {
  assert.match(uniqueTabNameClientSrc, /function uniqueTabName\(base, ?existing\)/);
  const fn = new Function(`${uniqueTabNameClientSrc}; return uniqueTabName;`)();
  assert.equal(fn('Claude Code', new Set(['Claude Code'])), 'Claude Code 2');
  assert.equal(fn('Base', new Set()), 'Base');
});