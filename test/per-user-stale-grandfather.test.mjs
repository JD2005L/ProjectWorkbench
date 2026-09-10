// Contract for the stale-session handling that fixed the PW_PER_USER_CLAUDE 502
// (2026-09-10): flipping the flag makes every live session's stamp stale, and the
// ATTACH paths used to throw — which took ttyd, and the whole project, down (502)
// even though the tmux server was healthy. They must now GRANDFATHER a stale but
// RESOLVED-owner session (attach it, leave it flagged for a deliberate recycle),
// while still failing closed on the cases where identity CANNOT be established.
//
// These paths need a live tmux server + credential drop, so the behaviour is pinned
// by source assertion (the same style used for the git-credential boundary tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');

test('attach paths grandfather a stale-but-resolved session instead of 502-ing', () => {
  // Both attach paths (ensureTmuxSession, ensureProjectTmuxSession) now warn + attach.
  const grandfathered = SRC.match(/attaching grandfathered — POST \$\{BASE\}\/api\/term/g) || [];
  assert.ok(grandfathered.length >= 2, `expected both attach paths to grandfather, found ${grandfathered.length}`);
  // The old "refuse to attach a stale session" throw is gone from BOTH attach paths.
  assert.doesNotMatch(SRC, /Refusing to attach a possibly-mismatched identity/,
    'the stale-attach refusal (the 502 cause) must no longer throw');
});

test('the still-fail-closed cases are preserved', () => {
  // Cannot VERIFY the stamp (cannot tell) — still refuse, in both attach paths.
  assert.ok((SRC.match(/Refusing to attach under an unverifiable identity/g) || []).length >= 2,
    'an unverifiable stamp must still fail closed on attach');
  // Cannot RESOLVE the owner — credentialContext still refuses the shared fallback.
  assert.match(SRC, /Refusing to fall back to the shared Claude\/GitHub login/,
    'a resolution failure must still fail closed (no silent shared fallback)');
  // Creating a NEW window in a stale session is still refused (no mixed-attribution).
  assert.match(SRC, /Refusing to create a mixed-attribution window/,
    'new-window creation must still fail closed against mixed attribution');
});

test('a grandfathered session is left flagged, not re-stamped', () => {
  // The grandfather branch returns BEFORE the adopt-the-stamp line, so the stale
  // stamp survives and credentialsStale() keeps reporting it until a real recycle.
  // (If it re-stamped, the drift would vanish and the operator would never know to
  // migrate it.) Pinned by the branch returning with only a console.warn.
  assert.match(SRC, /attaching grandfathered[\s\S]{0,200}?\n\s*return;/,
    'the grandfather branch must return (attach) without re-stamping');
});
