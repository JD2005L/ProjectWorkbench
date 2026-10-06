// Turn context — what of a finished Claude turn may leave the pane account's helper.
//
// Every excerpt that goes anywhere — TypeSafe AI's Jev as decision state, Hermes as the requested
// action, the tab and rail tooltips — is made the same way, and the ORDER is the point:
//
//   1. sanitize the WHOLE text: compatibility-fold it (NFKC) and drop the bidi, format and
//      invisible characters that are only ever an evasion inside a token;
//   2. redact secrets from the WHOLE text;
//   3. only then cut — at a paragraph boundary, else a sentence boundary, else a grapheme
//      boundary — with an explicit marker wherever text was dropped.
//
// The previous order (cut the last 2500 characters, redact only what went to Hermes) leaked in two
// ways: the tail half of a token cut by the window is too short for its pattern to match, and a
// value whose `password:` key fell on the other side of the cut is just a word. Jev saw the raw text.
//
// Redaction is deliberately greedy. A path or a SHA that looks random is redacted with the rest;
// losing it costs a little context, keeping a credential costs the credential.

import crypto from 'node:crypto';

export const TRUNCATION_MARKER = '…[truncated]';
// The pilot measured accuracy on the last 2500 characters of the final message; the state now also
// carries the request, so the message keeps slightly less and the whole state stays near the pilot's
// ~950 input tokens.
export const STATE_ASSISTANT_CHARS = 2400;
export const STATE_USER_CHARS = 800;
// The requested action: what Hermes and the tooltip show. One or two sentences, never a transcript.
export const ASK_CHARS = 280;

// ---------------------------------------------------------------- sanitizing

const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// C0/C1 controls except tab and newline (CR is folded into LF first).
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Characters with no visible meaning anywhere: soft hyphen, grapheme joiner, Hangul fillers,
// zero-width space, word joiner and invisible operators, BOM.
const INVISIBLE = /[­͏ᅟᅠ឴឵᠋-᠏​⁠-⁤ㅤ﻿ﾠ]/g;
// Joiners carry meaning in emoji and in Indic scripts; between two ASCII characters they only
// split a token so its pattern no longer matches.
const JOINER_IN_TOKEN = /(?<=[\x21-\x7E])[‌‍]+(?=[\x21-\x7E])/g;
// Likewise combining marks stacked on an ASCII letter (after NFKC, an accented letter that has a
// precomposed form no longer carries a separate mark).
const MARK_ON_ASCII = /(?<=[A-Za-z0-9_])\p{M}+/gu;

export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFKC')
    .replace(BIDI, '')
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '')
    .replace(JOINER_IN_TOKEN, '')
    .replace(MARK_ON_ASCII, '');
}

// ---------------------------------------------------------------- redaction

// Words that make a key name a secret's key. A key that only REFERS to a secret (a slug, a path,
// a file, a type) is left alone: "secret_ref: pvi-authority/deploy-key" is how a session is told
// to name a credential, and redacting it would hide what is needed.
const SECRET_WORD = '(?:pass(?:word|wd|phrase)?|pwd|secrets?|tokens?|api[_-]?keys?|apikey|access[_-]?keys?|private[_-]?keys?|account[_-]?keys?|signing[_-]?keys?|encryption[_-]?keys?|client[_-]?secrets?|credentials?|auth(?:orization)?|cookies?|session[_-]?(?:id|key|secret))';
const KEY_VALUE = new RegExp(
  // the key: an identifier containing a secret word (bounded, so a long run cannot backtrack)
  `(\\b[A-Za-z0-9_.-]{0,40}?${SECRET_WORD}[A-Za-z0-9_.-]{0,40})`
  // the separator: a closing quote or markdown emphasis, then = : or =>, up to two line breaks
  + `(["'\`]?[*_]{0,3}[ \\t]*(?:=>|[:=])[ \\t]*(?:\\n[ \\t]*){0,2}[*_]{0,3}[ \\t]*)`
  // the value: quoted, backticked, or a bare run
  + `("(?:[^"\\\\\\n]|\\\\.){1,512}"|'(?:[^'\\\\\\n]|\\\\.){1,512}'|\`[^\`\\n]{1,512}\`|[^\\s"'\`,;<>(){}\\[\\]]{1,512})`,
  'gi',
);
const SAFE_KEY = /(?:ref|reference|slug|name|path|file|dir|type|kind|len|length|count|ttl|expiry|expires|url|uri|env|var|hint|rotat\w*|scopes?)$/i;

const VENDOR_TOKEN = new RegExp('\\b(?:' + [
  'sk-[A-Za-z0-9_-]{16,}',                       // OpenAI / Anthropic
  '(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}', // Stripe
  'whsec_[A-Za-z0-9]{10,}',
  'gh[pousr]_[A-Za-z0-9]{20,}',                  // GitHub
  'github_pat_[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{16,}',                    // GitLab
  'xox[abeoprs]-[A-Za-z0-9-]{10,}',              // Slack
  'xapp-[A-Za-z0-9-]{10,}',
  'vck_[A-Za-z0-9]{12,}',                        // Vercel
  'pwat_[A-Za-z0-9_-]{16,}',                     // Project Workbench agent tokens
  'npm_[A-Za-z0-9]{30,}',
  'pypi-[A-Za-z0-9_-]{40,}',
  'hf_[A-Za-z0-9]{30,}',
  'dop_v1_[a-f0-9]{40,}',
  'AIza[0-9A-Za-z_-]{35}',                       // Google
  'ya29\\.[0-9A-Za-z_-]{20,}',
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}', // SendGrid
  '(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}', // AWS key ids
].join('|') + ')', 'g');

// A long run with the character-class churn of random data. Identifiers, paths and words have
// few lower/upper/digit transitions; keys and encoded secrets have many.
function looksRandom(run) {
  const alnum = run.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length < 16) return false;
  let transitions = 0;
  let prev = '';
  for (const ch of alnum) {
    const cls = ch >= 'a' && ch <= 'z' ? 'l' : ch >= 'A' && ch <= 'Z' ? 'u' : 'd';
    if (prev && cls !== prev) transitions++;
    prev = cls;
  }
  return transitions >= Math.max(6, 0.3 * alnum.length);
}

export function redactSecrets(text) {
  return String(text ?? '')
    // Whole key blocks, header to footer — to the end of the text when the footer is missing.
    .replace(/-----BEGIN [A-Z0-9 ]{1,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,64}-----|$)/g, '[redacted key block]')
    // scheme://user:secret@host
    .replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:@/?#]{1,256}):([^\s@/?#]{1,256})@/gi, '$1$2:[redacted]@')
    // JSON Web Tokens, signed or not.
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, '[redacted token]')
    .replace(VENDOR_TOKEN, '[redacted token]')
    .replace(/\b(Bearer|Basic|Token|Digest)([ \t]+)[A-Za-z0-9._~+/=-]{8,}/g, '$1$2[redacted]')
    .replace(KEY_VALUE, (match, key, sep) => (SAFE_KEY.test(key) ? match : `${key}${sep}[redacted]`))
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, (run) => (looksRandom(run) ? '[redacted value]' : run));
}

// ---------------------------------------------------------------- bounded excerpts

const SENTENCES = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PARAGRAPH_BREAK = /(\n[ \t]*\n\s*)/;

// The segments of `str` nearest its end (or start) that could fill `budget`. Only a window of the
// string is segmented, so a megabyte paragraph costs no more than a short one; the segment the
// window cut through is dropped rather than trusted.
function edgeSegments(str, segmenter, budget, fromEnd) {
  const span = budget * 2 + 64;
  const sliced = str.length > span;
  const region = !sliced ? str : fromEnd ? str.slice(-span) : str.slice(0, span);
  const parts = [...segmenter.segment(region)].map((s) => s.segment);
  if (sliced && parts.length) { if (fromEnd) parts.shift(); else parts.pop(); }
  return parts;
}

function fill(parts, budget, fromEnd) {
  let out = '';
  const order = fromEnd ? [...parts].reverse() : parts;
  for (const part of order) {
    const next = fromEnd ? part + out : out + part;
    if (next.length > budget) break;
    out = next;
  }
  return out;
}

function within(text, budget, fromEnd) {
  const pieces = text.split(PARAGRAPH_BREAK); // [para, sep, para, sep, …, para]
  const paras = [];
  for (let i = 0; i < pieces.length; i += 2) paras.push({ text: pieces[i], sep: pieces[i + 1] || '' });
  let out = '';
  const order = fromEnd ? [...paras].reverse() : paras;
  for (const [n, para] of order.entries()) {
    // The separator between this paragraph and what is already kept.
    const joiner = !out ? '' : fromEnd ? para.sep : order[n - 1].sep;
    const whole = fromEnd ? para.text + joiner + out : out + joiner + para.text;
    if (whole.length <= budget) { out = whole; continue; }
    // This paragraph does not fit whole: take the sentences at its kept edge that do.
    const room = budget - out.length - joiner.length;
    const sentences = room > 0 ? fill(edgeSegments(para.text, SENTENCES, room, fromEnd), room, fromEnd) : '';
    if (sentences.trim()) out = fromEnd ? sentences + joiner + out : out + joiner + sentences;
    else if (!out) out = fill(edgeSegments(para.text, GRAPHEMES, budget, fromEnd), budget, fromEnd);
    break;
  }
  return out.trim();
}

/** `text` cut to at most `max` characters, keeping its head or its tail, marked where cut. */
export function boundedExcerpt(text, { max, keep = 'tail' }) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const budget = max - TRUNCATION_MARKER.length - 1;
  if (budget <= 0) return TRUNCATION_MARKER.slice(0, Math.max(0, max));
  const body = within(s, budget, keep !== 'head');
  if (!body) return TRUNCATION_MARKER;
  return keep === 'head' ? `${body} ${TRUNCATION_MARKER}` : `${TRUNCATION_MARKER} ${body}`;
}

// ---------------------------------------------------------------- the requested action

const ASK_CUE = /\?|\b(?:should I|shall I|want me to|would you like|do you want|can you|could you|would you|please|let me know|tell me|confirm|approve|approval|your call|up to you|which (?:one|option)|decide|go ahead)\b/i;
const BLOCK_CUE = /\b(?:blocked|blocker|can(?:no|')t|cannot|unable to|could ?not|couldn't|permission|denied|forbidden|unauthori[sz]ed|401|403|credentials?|tokens?|passwords?|secrets?|sign[- ]?in|log[- ]?in|login|firewall|access|someone (?:with|who)|(?:needs?|requires?) (?:a |an )?(?:human|person|admin|you|someone)|you(?:'ll| will)? need to|manual(?:ly)?)\b/i;
const FAIL_CUE = /\b(?:fail(?:ed|ure|s|ing)?|errors?|errored|exception|crash(?:ed)?|broken|did ?not|didn't|could ?not|couldn't|cannot|unable)\b/i;

function proseBlocks(text) {
  return String(text ?? '')
    .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g, '$1\n\n') // fenced code is never the ask
    .split(/\n[ \t]*\n/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// A redaction marker says "token" or "key" — it must not make a paragraph look like the ask.
const cueTest = (re, text) => re.test(text.replace(/\[redacted[^\]]*\]/g, ' '));

function lastMatching(list, re) {
  for (let i = list.length - 1; i >= 0; i--) if (cueTest(re, list[i])) return list[i];
  return null;
}

// One block made concise: the sentence that carries the cue, with the one before it when it fits.
function concise(block, cue, max) {
  if (block.length <= max) return block;
  const sentences = [...SENTENCES.segment(block)].map((s) => s.segment.trim()).filter(Boolean);
  let at = -1;
  for (let i = sentences.length - 1; i >= 0; i--) if (cueTest(cue, sentences[i])) { at = i; break; }
  if (at < 0) at = sentences.length - 1;
  const budget = max - 2 * (TRUNCATION_MARKER.length + 1);
  let start = at;
  let picked = sentences[at];
  if (picked.length > budget) {
    picked = fill(edgeSegments(picked, GRAPHEMES, budget, false), budget, false).trim();
  } else if (at > 0 && sentences[at - 1].length + 1 + picked.length <= budget) {
    picked = `${sentences[at - 1]} ${picked}`;
    start = at - 1;
  }
  const cutBefore = start > 0;
  const cutAfter = at < sentences.length - 1 || picked.length < sentences[at].length;
  return `${cutBefore ? `${TRUNCATION_MARKER} ` : ''}${picked}${cutAfter ? ` ${TRUNCATION_MARKER}` : ''}`;
}

/**
 * The part of a (redacted) final message that says what is being asked for: the last paragraph
 * that asks, or for a blocked turn the last that names the block, or for a failure the last that
 * names it — else the final paragraph. Code blocks and every other paragraph are left out.
 */
export function requestedAction(text, { outcome = 'needs_input', max = ASK_CHARS } = {}) {
  const blocks = proseBlocks(redactSecrets(text));
  if (!blocks.length) return null;
  const order = outcome === 'blocked' ? [BLOCK_CUE, ASK_CUE] : outcome === 'failed' ? [FAIL_CUE, BLOCK_CUE] : [ASK_CUE, BLOCK_CUE];
  for (const cue of order) {
    const block = lastMatching(blocks, cue);
    if (block) return concise(block, cue, max);
  }
  return concise(blocks[blocks.length - 1], ASK_CUE, max);
}

// ---------------------------------------------------------------- identity and the whole context

/** A digest of the message's words, unchanged by line endings, trailing blanks or Unicode form. */
export function normalizedDigest(text) {
  const norm = String(text ?? '').replace(/\r\n?/g, '\n').normalize('NFC').replace(/[ \t]+$/gm, '').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

function safe(text) {
  return redactSecrets(sanitizeText(text)).trim();
}

/**
 * The bounded structured state for one turn: the final message (its tail) and the request that
 * started the turn (its head), each sanitized and redacted whole before it is cut, plus a digest
 * of the message's words for the turn's identity.
 */
export function turnContext({ assistantText, userText }) {
  const user = typeof userText === 'string' ? safe(userText) : '';
  return {
    assistant: boundedExcerpt(safe(assistantText), { max: STATE_ASSISTANT_CHARS, keep: 'tail' }),
    user: user ? boundedExcerpt(user, { max: STATE_USER_CHARS, keep: 'head' }) : null,
    digest: normalizedDigest(assistantText),
  };
}
