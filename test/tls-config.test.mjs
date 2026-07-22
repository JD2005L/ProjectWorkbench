// TLS must be explicit opt-in via env (never inferred from cert files existing
// on disk), byte-identical to canonical HTTP-only output when off, and must
// never redirect through attacker-controlled $host when on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTlsConfig, renderNginxServers } from '../app/tls-config.js';

const fakeFs = (files, { unreadable = [] } = {}) => ({
  existsSync: (p) => p in files,
  statSync: (p) => {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => files[p] };
  },
  accessSync: (p) => {
    if (unreadable.includes(p)) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
  },
  constants: { R_OK: 4 },
});

const CERT = '/etc/ssl/pw/c.crt';
const KEY = '/etc/ssl/pw/k.key';
const bothFiles = fakeFs({ [CERT]: true, [KEY]: true });

test('disabled by default — even when cert/key files exist on disk', () => {
  for (const env of [
    {},
    { PW_TLS_ENABLED: '0' },
    { PW_TLS_ENABLED: 'false' },
    { PW_TLS_ENABLED: '' },
    { PW_TLS_CERT: CERT, PW_TLS_KEY: KEY }, // paths alone must NOT activate TLS
  ]) {
    assert.deepEqual(resolveTlsConfig(env, bothFiles), { enabled: false });
  }
});

test('enabling requires cert, key, and server name', () => {
  const base = { PW_TLS_ENABLED: '1', PW_TLS_CERT: CERT, PW_TLS_KEY: KEY, PW_TLS_SERVER_NAME: 'pw.example.com' };
  for (const missing of ['PW_TLS_CERT', 'PW_TLS_KEY', 'PW_TLS_SERVER_NAME']) {
    const env = { ...base };
    delete env[missing];
    assert.throws(() => resolveTlsConfig(env, bothFiles), new RegExp(missing));
  }
});

test('enabling with unusable cert/key paths fails fast', () => {
  const env = { PW_TLS_ENABLED: '1', PW_TLS_CERT: CERT, PW_TLS_KEY: KEY, PW_TLS_SERVER_NAME: 'pw.example.com' };
  assert.throws(() => resolveTlsConfig(env, fakeFs({ [KEY]: true })), /PW_TLS_CERT/);
  assert.throws(() => resolveTlsConfig(env, fakeFs({ [CERT]: true })), /PW_TLS_KEY/);
  assert.throws(() => resolveTlsConfig(env, fakeFs({ [CERT]: false, [KEY]: true })), /PW_TLS_CERT/); // not a regular file
  assert.throws(() => resolveTlsConfig(env, fakeFs({ [CERT]: true, [KEY]: true }, { unreadable: [KEY] })), /PW_TLS_KEY/); // exists but not readable
});

test('happy path: enabled config resolved, default_server off unless opted in', () => {
  const env = { PW_TLS_ENABLED: 'true', PW_TLS_CERT: CERT, PW_TLS_KEY: KEY, PW_TLS_SERVER_NAME: 'pw.example.com' };
  assert.deepEqual(resolveTlsConfig(env, bothFiles), {
    enabled: true, cert: CERT, key: KEY, serverName: 'pw.example.com', defaultServer: false,
  });
  assert.equal(resolveTlsConfig({ ...env, PW_TLS_DEFAULT_SERVER: '1' }, bothFiles).defaultServer, true);
});

// Config values are interpolated verbatim into the generated nginx file, so
// their shapes must be too strict to smuggle nginx syntax.
test('server name must be a concrete safe hostname/IPv4 (nginx + redirect safe)', () => {
  const env = (name) => ({ PW_TLS_ENABLED: '1', PW_TLS_CERT: CERT, PW_TLS_KEY: KEY, PW_TLS_SERVER_NAME: name });
  for (const good of ['pw.example.com', 'goa-pw01.goa.internal', '10.62.5.20', 'localhost', 'PW.Example.Com']) {
    assert.equal(resolveTlsConfig(env(good), bothFiles).serverName, good, `should accept ${good}`);
  }
  for (const bad of [
    'pw.example.com;}',            // nginx directive injection
    'pw.example.com{',             // block injection
    'a b.example.com',             // whitespace
    'pw.example.com\nreturn 301',  // newline / control char
    'pw.example.com\x07',          // control char
    'evil$host',                   // nginx variable
    '*.example.com',               // wildcard — not a concrete redirect target
    '*',                           // universal wildcard
    'host/path',                   // slash — not a hostname
    'host:443',                    // port does not belong in server_name here
    '-leadinghyphen.example.com',  // invalid label
    'trailingdot.example.com.',    // trailing dot form rejected for redirect use
    '..',
  ]) {
    assert.throws(() => resolveTlsConfig(env(bad), bothFiles), /PW_TLS_SERVER_NAME/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('cert/key paths must be plain absolute paths (no nginx metacharacters)', () => {
  const env = (cert, key = KEY) => ({ PW_TLS_ENABLED: '1', PW_TLS_CERT: cert, PW_TLS_KEY: key, PW_TLS_SERVER_NAME: 'pw.example.com' });
  for (const good of ['/etc/nginx/conf.d/ssl/pw-fullchain.crt', '/etc/ssl/pw/c.crt', '/opt/pw-certs/2026/server_cert.pem']) {
    const fsAll = fakeFs({ [good]: true, [KEY]: true });
    assert.equal(resolveTlsConfig(env(good), fsAll).cert, good, `should accept ${good}`);
  }
  for (const bad of [
    '/etc/ssl/pw.crt;include /etc/evil.conf',  // directive injection
    '/etc/ssl/pw.crt\nssl_password_file /x',   // newline injection
    '/etc/ssl/{pw}.crt',                        // braces
    '/etc/ssl/pw cert.crt',                     // whitespace
    '/etc/ssl/$host.crt',                       // nginx variable
    'relative/path.crt',                        // not absolute
    '/etc/ssl/pw\x1b.crt',                      // control char
  ]) {
    const fsAll = fakeFs({ [bad]: true, [KEY]: true });
    assert.throws(() => resolveTlsConfig(env(bad), fsAll), /PW_TLS_CERT/, `should reject ${JSON.stringify(bad)}`);
    const fsKey = fakeFs({ [CERT]: true, [bad]: true });
    assert.throws(() => resolveTlsConfig(env(CERT, bad), fsKey), /PW_TLS_KEY/, `should reject key ${JSON.stringify(bad)}`);
  }
});

test('TLS off: rendered config is byte-identical to the canonical HTTP-only output', () => {
  const out = renderNginxServers('PRELUDE\n', 'BODY\n', { enabled: false });
  assert.equal(out, 'PRELUDE\nserver {\n    listen 80 default_server;\n    server_name _;\nBODY\n}\n');
});

const FULL_BODY =
  '    client_max_body_size 100m;\n' +
  'EXTRA-NGINX-MARKER\n' +
  '    location /api/deploy/ { }\n' +
  '    location /api/upload-stream/ { }\n' +
  '    location / { }\n' +
  '    location = /pw-auth-check { auth_request off; }\n' +
  '    location /pty/demo/ { auth_request /pw-auth-check; }\n' +
  '    location /preview/demo/ { }\n';

test('TLS on: HTTPS block carries the full body; port 80 is redirect-only; no $host', () => {
  const tls = { enabled: true, cert: CERT, key: KEY, serverName: 'pw.example.com', defaultServer: false };
  const out = renderNginxServers('P\n', FULL_BODY, tls);
  assert.ok(out.includes('return 301 https://pw.example.com$request_uri;'), 'redirect must target the configured server name');
  assert.ok(!out.includes('$host'), 'must not build a redirect (or anything) from unvalidated $host');
  assert.ok(!out.includes('default_server'), 'default_server must be explicit opt-in');
  assert.ok(out.includes('listen 443 ssl;'));
  assert.ok((out.match(/server_name pw\.example\.com;/g) || []).length >= 2, 'both blocks bind the configured name');
  assert.ok(out.includes(`ssl_certificate ${CERT};`));
  assert.ok(out.includes(`ssl_certificate_key ${KEY};`));
  // Body (auth_request, pty, preview, upload, deploy, extra-nginx) appears exactly
  // once, inside the 443 server; the :80 block carries no locations.
  for (const marker of ['EXTRA-NGINX-MARKER', '/api/deploy/', '/api/upload-stream/', 'auth_request /pw-auth-check', '/pty/demo/', '/preview/demo/']) {
    const first = out.indexOf(marker);
    assert.ok(first > out.indexOf('listen 443'), `${marker} must live in the HTTPS server`);
    assert.equal(out.indexOf(marker, first + 1), -1, `${marker} duplicated`);
  }
  assert.equal((out.match(/return 301/g) || []).length, 1);
});

test('TLS on with explicit default_server opt-in', () => {
  const tls = { enabled: true, cert: CERT, key: KEY, serverName: 'pw.example.com', defaultServer: true };
  const out = renderNginxServers('P\n', 'B\n', tls);
  assert.ok(out.includes('listen 80 default_server;'));
  assert.ok(out.includes('listen 443 ssl default_server;'));
});
