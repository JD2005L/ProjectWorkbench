// AES-256-GCM secret encryption, extracted out of app/server.js so a SECOND
// entrypoint (app/project-terminal-credentials.mjs, the host-mode terminal
// startup path) can decrypt a user's GitHub token with the EXACT SAME
// implementation server.js uses — not a hand-copied second one that could
// silently drift (wrong IV/tag layout, wrong key derivation) from the real
// thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSecretCrypto } from '../app/secret-crypto.js';

function tmpKeyFile(hex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-secret-crypto-'));
  const file = path.join(dir, '.secret-key');
  fs.writeFileSync(file, hex);
  return { dir, file };
}

test('round-trips a plaintext through encrypt/decrypt', () => {
  const { dir, file } = tmpKeyFile(crypto.randomBytes(32).toString('hex') + '\n');
  const { encrypt, decrypt } = makeSecretCrypto({ secretKeyPath: file });
  const enc = encrypt('ghp_super_secret_token');
  assert.match(enc, /^enc:/);
  assert.equal(enc.includes('ghp_super_secret_token'), false);
  assert.equal(decrypt(enc), 'ghp_super_secret_token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty plaintext encrypts/decrypts to an empty string without touching the key', () => {
  const { dir, file } = tmpKeyFile(crypto.randomBytes(32).toString('hex'));
  fs.rmSync(file); // key file missing entirely — must not matter for empty input
  const { encrypt, decrypt } = makeSecretCrypto({ secretKeyPath: file });
  assert.equal(encrypt(''), '');
  assert.equal(decrypt(''), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('decrypt passes through a plaintext value that was never encrypted (no enc: prefix)', () => {
  const { dir, file } = tmpKeyFile(crypto.randomBytes(32).toString('hex'));
  const { decrypt } = makeSecretCrypto({ secretKeyPath: file });
  assert.equal(decrypt('plain-legacy-value'), 'plain-legacy-value');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REGRESSION: a tampered ciphertext fails the GCM auth tag rather than decrypting to garbage', () => {
  const { dir, file } = tmpKeyFile(crypto.randomBytes(32).toString('hex'));
  const { encrypt, decrypt } = makeSecretCrypto({ secretKeyPath: file });
  const enc = encrypt('ghp_x');
  const buf = Buffer.from(enc.slice(4), 'base64');
  buf[buf.length - 1] ^= 0xff; // flip the last ciphertext byte
  const tampered = 'enc:' + buf.toString('base64');
  assert.throws(() => decrypt(tampered));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing key file throws an actionable error naming the path', () => {
  const { decrypt } = makeSecretCrypto({ secretKeyPath: '/tmp/pw-does-not-exist-secret-key' });
  assert.throws(() => decrypt('enc:abcd'), /Encryption key not found at \/tmp\/pw-does-not-exist-secret-key/);
});

test('a key of the wrong length is refused rather than silently truncated/padded', () => {
  const { dir, file } = tmpKeyFile('deadbeef'); // 4 bytes, not 32
  const { decrypt } = makeSecretCrypto({ secretKeyPath: file });
  assert.throws(() => decrypt('enc:abcd'), /32 bytes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the key is cached after first successful read (one fs read per process, matching server.js)', () => {
  const { dir, file } = tmpKeyFile(crypto.randomBytes(32).toString('hex'));
  const { encrypt } = makeSecretCrypto({ secretKeyPath: file });
  const first = encrypt('a');
  fs.rmSync(file); // if getEncryptionKey() re-read now, this would throw
  assert.doesNotThrow(() => encrypt('b'));
  fs.rmSync(dir, { recursive: true, force: true });
});
