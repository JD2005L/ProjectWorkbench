// OSC 52 clipboard sniffing must survive ARBITRARY WebSocket frame
// fragmentation: the ESC ] 5 2 ; prefix, the payload, and the terminator can
// each be split at any byte boundary, and a frame can carry several sequences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreload, osc52, b64 } from './preload-harness.mjs';

test('whole sequence in one frame', () => {
  const h = loadPreload();
  h.frame('some output ' + osc52('hello') + ' more');
  assert.deepEqual(h.copies, ['hello']);
});

test('prefix ESC]52; itself split across frames', () => {
  const h = loadPreload();
  h.frame('tail of output \x1b]5');
  h.frame('2;c;' + b64('split-prefix') + '\x07');
  assert.deepEqual(h.copies, ['split-prefix']);
});

test('prefix split right after a completed sequence in the same frame', () => {
  const h = loadPreload();
  h.frame(osc52('one') + '\x1b]');
  h.frame('52;c;' + b64('two') + '\x07');
  assert.deepEqual(h.copies, ['one', 'two']);
});

test('payload split across frames', () => {
  const h = loadPreload();
  const seq = osc52('payload-split');
  h.frame(seq.slice(0, 12));
  h.frame(seq.slice(12));
  assert.deepEqual(h.copies, ['payload-split']);
});

test('ST terminator (ESC \\) split across frames', () => {
  const h = loadPreload();
  const seq = osc52('st-split', '\x1b\\');
  h.frame(seq.slice(0, -1)); // ends with the lone ESC of the terminator
  h.frame(seq.slice(-1));
  assert.deepEqual(h.copies, ['st-split']);
});

test('multiple complete sequences in one frame (BEL and ST terminated)', () => {
  const h = loadPreload();
  h.frame(osc52('a') + 'noise' + osc52('b', '\x1b\\') + osc52('c'));
  assert.deepEqual(h.copies, ['a', 'b', 'c']);
});

test('multiple sequences with a trailing partial, completed next frame', () => {
  const h = loadPreload();
  const tail = osc52('gamma');
  h.frame(osc52('alpha') + osc52('beta') + tail.slice(0, 9));
  h.frame(tail.slice(9));
  assert.deepEqual(h.copies, ['alpha', 'beta', 'gamma']);
});

test('one-character frames: arbitrary fragmentation torture', () => {
  const h = loadPreload();
  const stream = 'plain \x1b[31mred\x1b[0m ' + osc52('alpha') + ' mid ' + osc52('beta', '\x1b\\') + ' end';
  for (const ch of stream) h.frame(ch);
  assert.deepEqual(h.copies, ['alpha', 'beta']);
});

test('normal non-OSC traffic never copies', () => {
  const h = loadPreload();
  h.frame('just regular terminal output\n');
  h.frame('with \x1b[1;32mSGR colors\x1b[0m and a lone \x1b too');
  assert.deepEqual(h.copies, []);
});

test('oversized unterminated sequence is dropped (bounded buffer); later sequences still work', () => {
  const h = loadPreload();
  h.frame('\x1b]52;c;' + 'A'.repeat(3_000_000));
  h.frame('B'.repeat(1_500_000)); // pushes the buffered sequence past the 4MB bound
  h.frame('C'.repeat(64) + '\x07'); // stray terminator of the dropped sequence
  h.frame(osc52('after-reset'));
  assert.deepEqual(h.copies, ['after-reset']);
});

test('malformed sequence (non-base64 payload) with terminator does not stall later sequences', () => {
  const h = loadPreload();
  h.frame('\x1b]52;c;not*base64!\x07' + osc52('good'));
  h.frame(osc52('after'));
  assert.deepEqual(h.copies, ['good', 'after']);
});
