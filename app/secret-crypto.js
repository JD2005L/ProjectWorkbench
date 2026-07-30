// AES-256-GCM secret encryption for values stored in users.json (GitHub
// tokens, deploy passwords). Extracted out of server.js so a SECOND
// entrypoint — app/project-terminal-credentials.mjs, invoked by
// scripts/project-terminal-start for the host-mode systemd-launched terminal
// — decrypts a user's token with the EXACT SAME code path server.js uses.
// Two independent implementations of "read the key, decrypt the ciphertext"
// is exactly the kind of duplication that drifts silently; a single shared
// module cannot drift from itself.

import fsSync from 'node:fs';
import crypto from 'node:crypto';

export function makeSecretCrypto({ secretKeyPath }) {
  let cachedKey = null;
  function getEncryptionKey() {
    if (cachedKey) return cachedKey;
    try {
      const hex = fsSync.readFileSync(secretKeyPath, 'utf8').trim();
      const key = Buffer.from(hex, 'hex');
      if (key.length !== 32) throw new Error('Key must be 32 bytes');
      cachedKey = key;
      return cachedKey;
    } catch (e) {
      throw new Error('Encryption key not found at ' + secretKeyPath + ': ' + e.message);
    }
  }
  function encrypt(plaintext) {
    if (!plaintext) return '';
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
  }
  function decrypt(ciphertext) {
    if (!ciphertext) return '';
    if (!ciphertext.startsWith('enc:')) return ciphertext;
    const key = getEncryptionKey();
    const buf = Buffer.from(ciphertext.slice(4), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
  }
  return { encrypt, decrypt, getEncryptionKey };
}
