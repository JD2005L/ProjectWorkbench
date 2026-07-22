// LDAP bind credential staging: private 0600 temp file (never argv), removed on
// success, failure, AND spawn error; startup scavenging clears stale pw-ldap-*
// dirs left by a crashed process without touching anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stageLdapSecret, scavengeLdapStaging, ldapBindOnce } from '../app/ldap-staging.js';

const newBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-staging-testbase-'));
const entries = (dir) => fs.readdirSync(dir).sort();
const HOUR = 60 * 60 * 1000;

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('stageLdapSecret: 0600 file inside a private 0700 dir, exact content, idempotent cleanup', () => {
  const base = newBase();
  try {
    const staged = stageLdapSecret('s3cret-pw', base);
    assert.ok(staged.file.startsWith(base + path.sep));
    assert.match(path.basename(path.dirname(staged.file)), /^pw-ldap-/);
    assert.equal(fs.statSync(staged.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(staged.file)).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(staged.file, 'utf8'), 's3cret-pw'); // verbatim, no trailing newline
    staged.cleanup();
    assert.equal(fs.existsSync(path.dirname(staged.file)), false);
    staged.cleanup(); // second call must not throw
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ldapBindOnce success: password via -y file only (never argv), staging removed after bind', async () => {
  const base = newBase();
  try {
    let seen;
    const spawnFn = (cmd, args) => {
      const yFile = args[args.indexOf('-y') + 1];
      seen = {
        cmd,
        args,
        mode: fs.statSync(yFile).mode & 0o777,
        content: fs.readFileSync(yFile, 'utf8'),
      };
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    const ok = await ldapBindOnce('CN=user', 'topsecret', { url: 'ldaps://dc:636', cacert: '/ca.crt', spawnFn, baseDir: base });
    assert.equal(ok, true);
    assert.equal(seen.cmd, 'ldapwhoami');
    assert.ok(!seen.args.includes('topsecret'), 'password must never appear in argv');
    assert.equal(seen.mode, 0o600);
    assert.equal(seen.content, 'topsecret');
    assert.deepEqual(entries(base), [], 'staging dir must be removed after the bind returns');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ldapBindOnce bind failure: rejects with stderr, staging removed', async () => {
  const base = newBase();
  try {
    const spawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stderr.emit('data', 'ldap_bind: Invalid credentials (49)');
        child.emit('close', 49);
      });
      return child;
    };
    await assert.rejects(
      ldapBindOnce('CN=user', 'wrong', { url: 'ldaps://dc:636', cacert: '/ca.crt', spawnFn, baseDir: base }),
      /Invalid credentials/,
    );
    assert.deepEqual(entries(base), [], 'staging dir must be removed on bind failure');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ldapBindOnce spawn error: rejects, staging removed', async () => {
  const base = newBase();
  try {
    const spawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ldapwhoami ENOENT')));
      return child;
    };
    await assert.rejects(
      ldapBindOnce('CN=user', 'pw', { url: 'ldaps://dc:636', cacert: '/ca.crt', spawnFn, baseDir: base }),
      /ENOENT/,
    );
    assert.deepEqual(entries(base), [], 'staging dir must be removed on spawn error');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ldapBindOnce synchronous spawn throw: rejects AND staging removed immediately', async () => {
  const base = newBase();
  try {
    const spawnFn = () => { throw new Error('posix_spawn EAGAIN'); };
    await assert.rejects(
      ldapBindOnce('CN=user', 'pw', { url: 'ldaps://dc:636', cacert: '/ca.crt', spawnFn, baseDir: base }),
      /EAGAIN/,
    );
    assert.deepEqual(entries(base), [], 'staging dir must be removed when spawn throws synchronously — not left for startup scavenging');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scavenge removes only stale pw-ldap-* dirs owned by us; everything else untouched', () => {
  const base = newBase();
  try {
    const old = (Date.now() - 2 * HOUR) / 1000;
    const mk = (name, { dir = true, stale = false } = {}) => {
      const p = path.join(base, name);
      if (dir) { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'pw'), 'residue'); }
      else fs.writeFileSync(p, 'x');
      if (stale) fs.utimesSync(p, old, old);
      return p;
    };
    mk('pw-ldap-stale1', { stale: true });
    mk('pw-ldap-stale2', { stale: true });
    mk('pw-ldap-fresh1');
    mk('unrelated-old-dir', { stale: true });
    mk('pw-ldap-notadir', { dir: false, stale: true });
    mk('keep.txt', { dir: false, stale: true });

    const removed = scavengeLdapStaging(base).sort();
    assert.deepEqual(removed, ['pw-ldap-stale1', 'pw-ldap-stale2']);
    assert.deepEqual(entries(base), ['keep.txt', 'pw-ldap-fresh1', 'pw-ldap-notadir', 'unrelated-old-dir']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scavenge is bounded by maxRemovals', () => {
  const base = newBase();
  try {
    const old = (Date.now() - 2 * HOUR) / 1000;
    for (let i = 0; i < 5; i++) {
      const p = path.join(base, `pw-ldap-stale${i}`);
      fs.mkdirSync(p);
      fs.utimesSync(p, old, old);
    }
    const removed = scavengeLdapStaging(base, { maxRemovals: 3 });
    assert.equal(removed.length, 3);
    assert.equal(entries(base).length, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scavenge on a missing base dir is a defensive no-op', () => {
  assert.deepEqual(scavengeLdapStaging('/nonexistent/definitely-not-here-pw'), []);
});
