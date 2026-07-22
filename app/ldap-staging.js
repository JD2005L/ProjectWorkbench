// LDAP bind credential staging. The bind password is handed to ldapwhoami via
// `-y <file>` using a private 0600 file inside a fresh 0700 mkdtemp dir —
// NOT `-w <pw>` (world-readable in /proc/<pid>/cmdline; this host also grants
// interactive shells to terminal roles) and NOT `-y /dev/stdin` (a Node-spawned
// pipe cannot be re-opened as /dev/stdin — ldapwhoami fails with ENXIO, which
// breaks every bind). The dir is removed as soon as the bind returns, on
// success, bind failure, and spawn error alike; scavengeLdapStaging() covers
// the remaining hole (process killed mid-bind) at next startup.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function stageLdapSecret(secret, baseDir = os.tmpdir()) {
 const dir = fsSync.mkdtempSync(path.join(baseDir, 'pw-ldap-'));
 const file = path.join(dir, 'pw');
 // Verbatim, no trailing newline, so -y reads the password exactly.
 fsSync.writeFileSync(file, String(secret), { mode: 0o600 });
 const cleanup = () => { try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch {} };
 return { dir, file, cleanup };
}

export function ldapBindOnce(bindDn, password, { url, cacert, timeoutMs = 10000, spawnFn = spawn, baseDir = os.tmpdir(), env = process.env } = {}) {
 return new Promise((resolve, reject) => {
  let staged;
  try { staged = stageLdapSecret(password, baseDir); }
  catch (e) { return reject(new Error('LDAP credential staging failed: ' + (e.message || e))); }
  // spawn can also throw synchronously (EAGAIN/EMFILE, bad options); the
  // staged secret must not outlive that either.
  let child;
  try {
   child = spawnFn('ldapwhoami', ['-x', '-H', url, '-D', bindDn, '-y', staged.file],
    { timeout: timeoutMs, env: { ...env, LDAPTLS_CACERT: cacert, LDAPTLS_REQCERT: 'demand' } });
  } catch (e) {
   staged.cleanup();
   return reject(new Error(e.message || 'LDAP bind failed'));
  }
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', e => { staged.cleanup(); reject(new Error(e.message || 'LDAP bind failed')); });
  child.on('close', code => { staged.cleanup(); if (code === 0) resolve(true); else reject(new Error((stderr.trim() || `ldapwhoami exited ${code}`))); });
 });
}

// Startup scavenging: remove pw-ldap-* staging dirs a crashed prior process
// left behind. Deliberately narrow — name pattern, directory, owned by this
// uid, untouched for maxAgeMs — and bounded so a hostile/degenerate tmpdir
// cannot stall startup. Everything else in the tmpdir is left alone.
export function scavengeLdapStaging(baseDir = os.tmpdir(), { maxAgeMs = 60 * 60 * 1000, maxRemovals = 50 } = {}) {
 const removed = [];
 let names;
 try { names = fsSync.readdirSync(baseDir); } catch { return removed; }
 const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
 const now = Date.now();
 for (const name of names) {
  if (removed.length >= maxRemovals) break;
  if (!/^pw-ldap-[A-Za-z0-9]+$/.test(name)) continue;
  const p = path.join(baseDir, name);
  try {
   const st = fsSync.lstatSync(p);
   if (!st.isDirectory()) continue;
   if (uid !== -1 && st.uid !== uid) continue;
   if (now - st.mtimeMs < maxAgeMs) continue;
   fsSync.rmSync(p, { recursive: true, force: true });
   removed.push(name);
  } catch {}
 }
 return removed;
}
