// Ownership of pane-visible files must follow the account panes ACTUALLY run as,
// in BOTH deploy modes.
//
// Regression: the per-user credential feature derived ownership from
// terminal-priv's `enabled` flag. That flag is deliberately false in host mode
// (PW spawns panes via `sudo -u admin tmux`, so there is no setpriv drop to do),
// which made the handover a silent no-op there — the dashboard runs as root, so
// the credential directory stayed root-owned 0700 and the `admin` pane could
// neither traverse nor write it. The feature was inert on every host-mode
// instance while appearing to work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalPriv } from '../app/terminal-priv.js';
import {
  HOST_TERMINAL_USER,
  isValidAccountName,
  makePasswdLookup,
  parsePasswdEntry,
  resolveTerminalOwner,
  terminalOwnerPlan,
} from '../app/terminal-owner.js';

const ADMIN_LINE = 'admin:x:1000:1000:admin,,,:/home/admin:/bin/bash';

test('REGRESSION: host mode has no setpriv drop but still needs a non-root owner', async () => {
  for (const env of [{}, { PW_DEPLOY_MODE: 'host' }, { PW_DEPLOY_MODE: 'host', PW_TERMINAL_UID: '1001' }]) {
    // terminal-priv correctly reports "no drop here"...
    assert.equal(resolveTerminalPriv(env).enabled, false, JSON.stringify(env));
    // ...but the pane is still not root, so a handover is still required.
    const plan = terminalOwnerPlan(env);
    assert.equal(plan.kind, 'named', JSON.stringify(env));
    assert.equal(plan.user, HOST_TERMINAL_USER);

    const owner = await resolveTerminalOwner(env, async () => parsePasswdEntry(ADMIN_LINE, 'admin'));
    assert.deepEqual(
      { uid: owner.uid, gid: owner.gid, user: owner.user, source: owner.source },
      { uid: 1000, gid: 1000, user: 'admin', source: 'passwd' },
      'host-mode credential paths must be handed to the sudo -u account',
    );
    assert.notEqual(owner.uid, 0, 'never leave a pane-visible path owned by root');
  }
});

test('container + PW_TERMINAL_UID: the configured uid is authoritative, no passwd needed', async () => {
  const env = { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001', PW_TERMINAL_USER: 'admin' };
  assert.deepEqual(terminalOwnerPlan(env), { kind: 'numeric', uid: 1001, gid: 1001, user: 'admin' });
  // No lookup supplied on purpose: container mode must not depend on passwd.
  const owner = await resolveTerminalOwner(env, null);
  assert.deepEqual(owner, { uid: 1001, gid: 1001, user: 'admin', source: 'PW_TERMINAL_UID' });
});

test('container without PW_TERMINAL_UID: pane is root too, so no handover', async () => {
  const env = { PW_DEPLOY_MODE: 'container' };
  assert.equal(terminalOwnerPlan(env).kind, 'none');
  assert.equal(await resolveTerminalOwner(env, null), null);
});

test('an unusable container uid/gid refuses rather than guessing', async () => {
  for (const env of [
    { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '0' },
    { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '0' },
    { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: 'root' },
  ]) {
    assert.equal(terminalOwnerPlan(env).kind, 'invalid', JSON.stringify(env));
    await assert.rejects(() => resolveTerminalOwner(env, null), /terminal owner/);
  }
});

test('host mode refuses when the account does not resolve (never falls back to root)', async () => {
  await assert.rejects(
    () => resolveTerminalOwner({ PW_DEPLOY_MODE: 'host' }, async () => null),
    /did not resolve/,
  );
  await assert.rejects(
    () => resolveTerminalOwner({ PW_DEPLOY_MODE: 'host' }, null),
    /no passwd lookup/,
  );
});

test('parsePasswdEntry accepts a plain entry and rejects every unusable shape', () => {
  assert.deepEqual(parsePasswdEntry(ADMIN_LINE), { name: 'admin', uid: 1000, gid: 1000, home: '/home/admin' });
  assert.deepEqual(parsePasswdEntry(ADMIN_LINE, 'admin').uid, 1000);

  const rejected = {
    'name mismatch': [ADMIN_LINE, 'someone-else'],
    'uid 0 (root)': ['admin:x:0:1000::/home/admin:/bin/bash'],
    'gid 0 (root group)': ['admin:x:1000:0::/home/admin:/bin/bash'],
    'non-numeric uid': ['admin:x:abc:1000::/home/admin:/bin/bash'],
    'relative home': ['admin:x:1000:1000::home/admin:/bin/bash'],
    'empty home': ['admin:x:1000:1000:::/bin/bash'],
    'six fields': ['admin:x:1000:1000::/home/admin'],
    'eight fields': [`${ADMIN_LINE}:extra`],
    'empty name': [':x:1000:1000::/home/admin:/bin/bash'],
    'not a string': [null],
  };
  for (const [why, args] of Object.entries(rejected)) {
    assert.equal(parsePasswdEntry(...args), null, `should reject: ${why}`);
  }
});

test('account names are validated before reaching getent', () => {
  for (const ok of ['admin', 'pw-agent', 'svc_user', 'a.b', 'machine$']) assert.ok(isValidAccountName(ok), ok);
  for (const bad of ['-rf', '', 'a b', 'a;id', '../root', 'a'.repeat(33), 'a\nb', null, 42]) {
    assert.equal(isValidAccountName(bad), false, JSON.stringify(bad));
  }
  assert.ok(isValidAccountName(HOST_TERMINAL_USER), 'the shipped host account must itself be valid');
});

test('lookup prefers getent (covers LDAP) and falls back to /etc/passwd', async () => {
  const viaGetent = makePasswdLookup({ execFile: async () => ({ stdout: `${ADMIN_LINE}\n` }) });
  assert.equal((await viaGetent('admin')).uid, 1000);

  // getent absent -> file fallback
  const viaFile = makePasswdLookup({
    execFile: async () => { throw new Error('getent: not found'); },
    readFile: async () => `root:x:0:0::/root:/bin/sh\n${ADMIN_LINE}\n`,
  });
  assert.equal((await viaFile('admin')).uid, 1000);

  // Neither source knows the account.
  const nowhere = makePasswdLookup({
    execFile: async () => ({ stdout: '' }),
    readFile: async () => 'root:x:0:0::/root:/bin/sh\n',
  });
  assert.equal(await nowhere('admin'), null);
});

test('an ambiguous directory (two entries for one name) is refused, not guessed', async () => {
  const lookup = makePasswdLookup({
    execFile: async () => ({ stdout: `${ADMIN_LINE}\nadmin:x:4242:4242::/srv/admin:/bin/sh\n` }),
    // The file fallback must NOT be consulted to paper over the ambiguity.
    readFile: async () => `${ADMIN_LINE}\n`,
  });
  assert.equal(await lookup('admin'), null);
});

test('a hostile account name never reaches the lookup backends', async () => {
  let called = false;
  const lookup = makePasswdLookup({
    execFile: async () => { called = true; return { stdout: `${ADMIN_LINE}\n` }; },
    readFile: async () => { called = true; return `${ADMIN_LINE}\n`; },
  });
  assert.equal(await lookup('-o/etc/shadow'), null);
  assert.equal(await lookup('admin;id'), null);
  assert.equal(called, false, 'invalid names must be rejected before any backend call');
});

test('a root passwd entry is refused even if the directory returns one', async () => {
  const lookup = makePasswdLookup({ execFile: async () => ({ stdout: 'admin:x:0:0::/root:/bin/sh\n' }) });
  assert.equal(await lookup('admin'), null);
  await assert.rejects(() => resolveTerminalOwner({ PW_DEPLOY_MODE: 'host' }, lookup), /did not resolve/);
});
