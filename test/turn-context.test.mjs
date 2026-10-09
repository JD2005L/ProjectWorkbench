// Turn context (app/turn-context.js): what of a Claude turn may leave the pane account's helper —
// to TypeSafe AI's Jev as decision state, to Hermes as the requested action, to the tab tooltip.
//
// The invariant every test here protects: a secret is removed from the WHOLE message before any
// cut is made. Cutting first can leave the tail half of a token (too short for its pattern to
// match) or a value whose `password:` key fell on the other side of the cut, and that half then
// leaves the box. So secrets are planted ACROSS every truncation boundary, at every offset.
//
// Test secrets are assembled at runtime so no file in the repo carries a literal token shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeText, redactSecrets, boundedExcerpt, requestedAction, normalizedDigest, turnContext,
  TRUNCATION_MARKER, STATE_ASSISTANT_CHARS, STATE_USER_CHARS, ASK_CHARS,
} from '../app/turn-context.js';

const j = (...parts) => parts.join('');
const rep = (s, n) => s.repeat(n).slice(0, n);
const ALNUM = 'aB3dE9fG2hJ7kL4mN8pQ1rS6tU5vW0xY';

// [label, the full text to plant, the parts of it that must never be seen again]
const SECRETS = [
  ['github classic token', j('gh', 'p_', rep(ALNUM, 36)), [rep(ALNUM, 36).slice(4, 20)]],
  ['github fine-grained token', j('github', '_pat_', rep('11ABCDEFG0' + ALNUM, 82)), [rep('11ABCDEFG0' + ALNUM, 82).slice(30, 50)]],
  ['openai project key', j('sk', '-proj-', rep(ALNUM, 56)), [rep(ALNUM, 56).slice(10, 30)]],
  ['anthropic key', j('sk', '-ant-api03-', rep(ALNUM + '_-', 93)), [rep(ALNUM + '_-', 93).slice(40, 60)]],
  ['aws access key id', j('AK', 'IA', 'Q3EGRZ7XMPLAV2KS'), ['Q3EGRZ7XMPLAV2KS']],
  ['aws secret (assignment)', j('aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY'), ['wJalrXUtnFEMI', 'bPxRfiCYzEXAMPLE']],
  ['slack bot token', j('xo', 'xb-', '2468013579-1357924680135-', rep(ALNUM, 24)), [rep(ALNUM, 24).slice(2, 18)]],
  ['vercel key', j('vc', 'k_', rep(ALNUM, 24)), [rep(ALNUM, 24).slice(3, 19)]],
  ['google api key', j('AI', 'za', 'Sy', rep(ALNUM, 33)), [rep(ALNUM, 33).slice(5, 25)]],
  ['pw agent token', j('pw', 'at_', rep(ALNUM, 40)), [rep(ALNUM, 40).slice(6, 26)]],
  ['npm token', j('np', 'm_', rep(ALNUM, 36)), [rep(ALNUM, 36).slice(8, 28)]],
  ['jwt', j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), ['eyJzdWIiOiIx', 'dozjgNryP4J3']],
  ['pem private key', j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', '\nQyNTUxOQAAACBnRWpvZmQ1dHlLbnRoaXNpc25vdGFyZWFsa2V5YXRhbGwAAAAA\n', '-----END ', 'OPENSSH PRIVATE KEY-----'), ['b3BlbnNzaC1rZXkt', 'QyNTUxOQAAACBn', 'PRIVATE KEY']],
  ['password assignment', 'password: Hunter2-Correct-Horse-Battery', ['Hunter2-Correct', 'Horse-Battery']],
  ['json client secret', '"client_secret": "s3cr3t-Value-0042-zz"', ['s3cr3t-Value']],
  ['connection string', 'Server=db01;User ID=sa;Password=2#gN=uVeL;Encrypt=True', ['2#gN=uVeL']],
  ['url credentials', 'https://deploy:Sup3rS3cret!x@git.example.com/repo.git', ['Sup3rS3cret']],
  ['bearer header', j('Authorization: Bearer ', 'abcDEF123ghiJKL456mnoPQR789stu'), ['abcDEF123ghiJKL456']],
  ['env token', j('GITHUB_TOKEN=', rep(ALNUM, 40)), [rep(ALNUM, 40).slice(12, 30)]],
  ['high-entropy blob', 'Xq7Lp2Vb9Kd4Rt8Zm1Wn6Hc3Fg5Js0YaQ', ['Xq7Lp2Vb9Kd4', 'Zm1Wn6Hc3Fg5']],
];

function leaks(out, fragments) {
  // Nothing of the value may survive, not even a fragment of it.
  return fragments.filter((f) => out.includes(f));
}

// ---------------------------------------------------------------- redaction

test('every secret format is removed, including disguised and split-by-invisible-character forms', () => {
  for (const [label, secret, fragments] of SECRETS) {
    const out = redactSecrets(`Here it is: ${secret} — rotate it.`);
    assert.deepEqual(leaks(out, fragments), [], label);
    assert.match(out, /\[redacted[^\]]*\]/, label);
  }
  // Full-width compatibility characters and a zero-width joiner inside a token are evasions.
  const disguised = j('ｇｈｐ＿', rep(ALNUM, 36)).replace('3dE9', '3d‍E9');
  assert.equal(redactSecrets(sanitizeText(disguised)).includes(rep(ALNUM, 36).slice(10, 26)), false);
});

test('ordinary prose, paths, versions and short identifiers survive redaction', () => {
  const prose = 'Committed 1a2b3c4 on fix/turn-outcome-context-durability; VERSION is 1.26.1006.1830.\n\nShould I open /opt/project-workbench/app/server.js next?';
  assert.equal(redactSecrets(prose), prose);
});

test('sanitizing strips bidi controls and C0 controls but keeps newlines, tabs and emoji ZWJ sequences', () => {
  const out = sanitizeText('a‮b\u0007c\r\nd\te 👩‍💻');
  assert.equal(out, 'abc\nd\te 👩‍💻');
});

// ---------------------------------------------------------------- bounded excerpts

test('a short text is returned whole, with no marker', () => {
  assert.equal(boundedExcerpt('Done. Tests pass.', { max: 100, keep: 'tail' }), 'Done. Tests pass.');
  assert.equal(boundedExcerpt('Do X.', { max: 100, keep: 'head' }), 'Do X.');
});

test('a tail excerpt keeps whole trailing paragraphs and says it was cut', () => {
  const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} explains step ${i}. It has two sentences.`);
  const out = boundedExcerpt(paras.join('\n\n'), { max: 400, keep: 'tail' });
  assert.ok(out.length <= 400, `${out.length}`);
  assert.ok(out.startsWith(TRUNCATION_MARKER));
  assert.ok(out.endsWith(paras[29]));
  const body = out.slice(TRUNCATION_MARKER.length).trimStart();
  // The cut fell on a paragraph or a sentence boundary: what is kept starts a sentence.
  assert.match(body, /^(Paragraph \d+|It has)/);
});

test('a head excerpt keeps leading sentences and marks the cut at its end', () => {
  const text = 'Implement the hardening. ' + 'Each sentence adds detail here. '.repeat(60);
  const out = boundedExcerpt(text, { max: 200, keep: 'head' });
  assert.ok(out.length <= 200);
  assert.ok(out.startsWith('Implement the hardening.'));
  assert.ok(out.endsWith(TRUNCATION_MARKER));
  assert.match(out.slice(0, -TRUNCATION_MARKER.length).trimEnd(), /\.$/, 'cut at a sentence end');
});

test('one giant sentence is cut on a grapheme boundary, never through a surrogate pair, flag or ZWJ emoji', () => {
  const unit = 'x🇨🇦👩‍💻é𝒳日';
  for (let pad = 0; pad < 12; pad++) {
    const text = 'y'.repeat(pad) + unit.repeat(200);
    for (const keep of ['head', 'tail']) {
      const out = boundedExcerpt(text, { max: 120, keep });
      assert.ok(out.length <= 120);
      assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), false, 'no lone surrogate');
      const body = keep === 'tail' ? out.slice(TRUNCATION_MARKER.length).trimStart() : out.slice(0, -TRUNCATION_MARKER.length).trimEnd();
      const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(body)].map((s) => s.segment);
      for (const g of graphemes) assert.ok(['x', 'y', '🇨🇦', '👩‍💻', 'é', '𝒳', '日'].includes(g), `split grapheme ${JSON.stringify(g)}`);
    }
  }
});

test('CJK sentence punctuation is a sentence boundary too', () => {
  const text = '最初の文です。' + '説明が続きます。'.repeat(80) + '承認してください。';
  const out = boundedExcerpt(text, { max: 60, keep: 'tail' });
  assert.ok(out.endsWith('承認してください。'));
  assert.match(out.slice(TRUNCATION_MARKER.length).trimStart(), /^(説明が続きます。)*承認してください。$/);
});

// ---------------------------------------------------------------- redact before cut

test('a secret straddling the tail cut never leaves the helper, at any offset', () => {
  for (const [label, secret, fragments] of SECRETS) {
    for (let shift = -70; shift <= 70; shift += 7) {
      // One unbroken run, so the cut lands on a grapheme a fixed distance from the END; moving
      // the length of what FOLLOWS the secret walks that cut across the secret, offset by offset.
      const before = 'w'.repeat(900);
      const after = ' ' + 'z'.repeat(STATE_ASSISTANT_CHARS - 40 + shift) + ' Should I continue?';
      const { assistant } = turnContext({ assistantText: before + ' ' + secret + after, userText: null });
      assert.deepEqual(leaks(assistant, fragments), [], `${label} @${shift}`);
      assert.ok(assistant.length <= STATE_ASSISTANT_CHARS);
    }
  }
});

test('a secret straddling the head cut of the user request never leaves the helper, at any offset', () => {
  for (const [label, secret, fragments] of SECRETS) {
    for (let shift = -70; shift <= 70; shift += 7) {
      const before = 'Please deploy ' + 'q'.repeat(Math.max(0, STATE_USER_CHARS - 60 + shift));
      const { user } = turnContext({ assistantText: 'Done.', userText: before + ' ' + secret + ' ' + 'r'.repeat(600) });
      assert.deepEqual(leaks(user, fragments), [], `${label} @${shift}`);
      assert.ok(user.length <= STATE_USER_CHARS);
    }
  }
});

test('a key on one side of the cut and its value on the other is still redacted', () => {
  // Truncating first would keep "Hunter2…" with no "password:" in front of it.
  const text = 'a'.repeat(5000) + ' password: ' + '\n\n' + 'Hunter2-Correct-Horse-Battery is the value. ' + 'b'.repeat(STATE_ASSISTANT_CHARS - 80);
  const { assistant } = turnContext({ assistantText: text, userText: null });
  assert.equal(assistant.includes('Hunter2'), false);
});

// ---------------------------------------------------------------- requested action

test('the requested action is the ask, not the unrelated paragraphs around it', () => {
  const text = [
    'I refactored the upload module and added retries with jitter.',
    'Unrelated: the CHANGELOG had a typo in the 1.4 entry, fixed.',
    '```\nnpm test\n# 412 passing\n```',
    'Should I deploy this to staging now, or wait for the review?',
  ].join('\n\n');
  const ask = requestedAction(text, { outcome: 'needs_input' });
  assert.equal(ask, 'Should I deploy this to staging now, or wait for the review?');
  assert.ok(!ask.includes('CHANGELOG') && !ask.includes('npm test'));
});

test('for a blocked turn the block is the requested action, even with a later offer', () => {
  const text = [
    'The fix is committed locally.',
    'I could not push: the deploy key was rejected with 403 Forbidden. Someone with access to the staging credentials needs to rotate it.',
    'Want me to open a PR from a fork instead?',
  ].join('\n\n');
  const ask = requestedAction(text, { outcome: 'blocked' });
  assert.match(ask, /403 Forbidden/);
  assert.ok(!ask.includes('committed locally'));
});

test('a redaction marker is not mistaken for the block', () => {
  const text = `I could not sign in to the registry.\n\nFor the record, the old value was ${j('gh', 'p_', rep(ALNUM, 36))}.`;
  assert.equal(requestedAction(text, { outcome: 'blocked' }), 'I could not sign in to the registry.');
});

test('a long ask is trimmed to its asking sentences, bounded, with the marker', () => {
  const para = 'Background sentence number one is long and detailed. '.repeat(12) + 'Do you want me to merge PR #82 now?';
  const ask = requestedAction(para, { outcome: 'needs_input' });
  assert.ok(ask.length <= ASK_CHARS);
  assert.ok(ask.endsWith('Do you want me to merge PR #82 now?'));
  assert.ok(ask.startsWith(TRUNCATION_MARKER));
});

test('the requested action carries no secret even when the ask quotes one', () => {
  const text = `Blocked: the token ${j('gh', 'p_', rep(ALNUM, 36))} was rejected. Can you rotate it?`;
  const ask = requestedAction(redactSecrets(text), { outcome: 'blocked' });
  assert.equal(ask.includes(rep(ALNUM, 36).slice(0, 12)), false);
  assert.equal(requestedAction('', { outcome: 'needs_input' }), null);
});

// ---------------------------------------------------------------- identity

test('the digest is stable across invisible differences and changes with the words', () => {
  const a = normalizedDigest('Should I deploy?\r\n');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(normalizedDigest('Should I deploy?  \n'), a);
  assert.equal(normalizedDigest('Should I deploy?'.normalize('NFD')), a);
  assert.notEqual(normalizedDigest('Should I deploy now?'), a);
});

test('turn context is bounded structured state with an explicit null when there is no request', () => {
  const ctx = turnContext({ assistantText: 'Done. Want me to deploy?', userText: null });
  assert.deepEqual(Object.keys(ctx).sort(), ['assistant', 'digest', 'user']);
  assert.equal(ctx.user, null);
  assert.equal(ctx.assistant, 'Done. Want me to deploy?');
});
