// Explicit, opt-in TLS for the generated nginx config. TLS is OFF unless
// PW_TLS_ENABLED is set — cert files merely existing on disk never activate it.
// When enabled, PW_TLS_CERT / PW_TLS_KEY must point at readable files and
// PW_TLS_SERVER_NAME names this instance: it is both the server_name and the
// 80→443 redirect target, so the redirect never echoes the client-controlled
// $host. PW_TLS_DEFAULT_SERVER=1 additionally claims default_server on both
// listeners (single-site hosts only) — never claimed implicitly.
import fsSync from 'node:fs';

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

// These values are interpolated verbatim into the generated nginx config, so
// their shapes are kept too strict to smuggle nginx syntax (or an open
// redirect) through them:
// - server name: a concrete RFC-1123 hostname or IPv4 address — no wildcards,
//   variables, ports, paths, whitespace, or control characters. It doubles as
//   the redirect target, so it must be a literal.
// - cert/key: plain absolute file paths from a conservative character set —
//   no whitespace, `;`, braces, `$`, or control characters.
const SERVER_NAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const NGINX_PATH_RE = /^\/[A-Za-z0-9._@+,=-]+(\/[A-Za-z0-9._@+,=-]+)*$/;

export function resolveTlsConfig(env = process.env, fsImpl = fsSync) {
 if (!truthy(env.PW_TLS_ENABLED)) return { enabled: false };
 const cert = env.PW_TLS_CERT || '';
 const key = env.PW_TLS_KEY || '';
 const serverName = (env.PW_TLS_SERVER_NAME || '').trim();
 if (!cert) throw new Error('PW_TLS_ENABLED is set but PW_TLS_CERT is not configured');
 if (!key) throw new Error('PW_TLS_ENABLED is set but PW_TLS_KEY is not configured');
 if (!serverName) throw new Error('PW_TLS_ENABLED is set but PW_TLS_SERVER_NAME is not configured (needed for server_name and the HTTPS redirect target)');
 if (!SERVER_NAME_RE.test(serverName)) throw new Error(`PW_TLS_SERVER_NAME must be a concrete hostname or IPv4 address (it is embedded in nginx server_name and the HTTPS redirect): ${JSON.stringify(serverName)}`);
 for (const [label, p] of [['PW_TLS_CERT', cert], ['PW_TLS_KEY', key]]) {
  if (!NGINX_PATH_RE.test(p)) throw new Error(`${label} must be a plain absolute file path safe to embed in nginx config: ${JSON.stringify(p)}`);
 }
 for (const [label, p] of [['PW_TLS_CERT', cert], ['PW_TLS_KEY', key]]) {
  let ok = false;
  try {
   ok = fsImpl.existsSync(p) && fsImpl.statSync(p).isFile();
   if (ok && fsImpl.accessSync) fsImpl.accessSync(p, fsSync.constants.R_OK);
  } catch { ok = false; }
  if (!ok) throw new Error(`${label} does not point to a readable file: ${p}`);
 }
 return { enabled: true, cert, key, serverName, defaultServer: truthy(env.PW_TLS_DEFAULT_SERVER) };
}

// Wraps the shared prelude/body into server block(s). With TLS off the output
// is byte-identical to the canonical HTTP-only config; with TLS on, :80 is a
// redirect-only block and the full body moves to the :443 ssl server.
export function renderNginxServers(prelude, body, tls) {
 if (!tls || !tls.enabled) {
  return `${prelude}server {\n    listen 80 default_server;\n    server_name _;\n${body}}\n`;
 }
 const dfl = tls.defaultServer ? ' default_server' : '';
 return `${prelude}server {\n    listen 80${dfl};\n    server_name ${tls.serverName};\n    return 301 https://${tls.serverName}$request_uri;\n}\nserver {\n    listen 443 ssl${dfl};\n    server_name ${tls.serverName};\n    ssl_certificate ${tls.cert};\n    ssl_certificate_key ${tls.key};\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 1d;\n${body}}\n`;
}
