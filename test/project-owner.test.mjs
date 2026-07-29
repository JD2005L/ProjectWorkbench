// The single decision "who is this project's credential owner, and what's
// their (already-decrypted) GitHub token" — shared by app/server.js (the
// dashboard) and app/project-terminal-credentials.mjs (the host-mode systemd
// terminal-startup path), so both entrypoints enforce the EXACT SAME
// fail-closed contract (AC1 of the PR #20 remediation): shared credentials
// are the intended behaviour only when the feature is off or the project has
// no primaryUser; every other failure (users store unreadable — handled by
// the caller before this is even called — a primaryUser that doesn't resolve
// to a user record, an undecryptable token) throws rather than degrading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectCredentialOwner } from '../app/project-owner.js';

const noopDecrypt = (v) => v;

test('feature off -> null (shared), regardless of primaryUser', () => {
  const owner = resolveProjectCredentialOwner({
    perUserEnabled: false,
    project: { name: 'demo', primaryUser: 'alice' },
    users: [{ username: 'alice', ghToken: 'ghp_x' }],
    decrypt: noopDecrypt,
  });
  assert.equal(owner, null);
});

test('no primaryUser -> null (shared), the other intentional case', () => {
  const owner = resolveProjectCredentialOwner({
    perUserEnabled: true,
    project: { name: 'demo' },
    users: [{ username: 'alice' }],
    decrypt: noopDecrypt,
  });
  assert.equal(owner, null);
});

test('resolves the owner and decrypts their token', () => {
  const owner = resolveProjectCredentialOwner({
    perUserEnabled: true,
    project: { name: 'demo', primaryUser: 'alice' },
    users: [{ username: 'alice', ghToken: 'enc:whatever' }],
    decrypt: (v) => (v === 'enc:whatever' ? 'ghp_plain' : ''),
  });
  assert.deepEqual(owner, { username: 'alice', ghToken: 'ghp_plain' });
});

test('an owner with no token resolves with an empty ghToken, not a failure', () => {
  const owner = resolveProjectCredentialOwner({
    perUserEnabled: true,
    project: { name: 'demo', primaryUser: 'alice' },
    users: [{ username: 'alice' }],
    decrypt: noopDecrypt,
  });
  assert.deepEqual(owner, { username: 'alice', ghToken: '' });
});

test('REGRESSION: a primaryUser that does not resolve to any user record THROWS, never returns null', () => {
  assert.throws(() => resolveProjectCredentialOwner({
    perUserEnabled: true,
    project: { name: 'demo', primaryUser: 'ghost' },
    users: [{ username: 'alice' }],
    decrypt: noopDecrypt,
  }), /primaryUser "ghost" does not exist/);
});

test('REGRESSION: a decrypt failure THROWS rather than silently treating the owner as tokenless', () => {
  assert.throws(() => resolveProjectCredentialOwner({
    perUserEnabled: true,
    project: { name: 'demo', primaryUser: 'alice' },
    users: [{ username: 'alice', ghToken: 'enc:corrupt' }],
    decrypt: () => { throw new Error('Unsupported state or unable to authenticate data'); },
  }), /Unsupported state/);
});
