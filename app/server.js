import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const app = express();
const execFileAsync = promisify(execFile);
// Data/host paths are env-overridable so an isolated test/verify instance never
// mutates the shared host. ISOLATED = an explicit PW_ISOLATED=1, or a registry
// path pointed away from the canonical location (e.g. a throwaway test registry).
const CANONICAL_REGISTRY = '/opt/project-workbench/projects.json';
const registryPath = process.env.PW_REGISTRY_PATH || CANONICAL_REGISTRY;
const workspaceRoot = process.env.PW_WORKSPACES || '/opt/project-workbench/workspaces';
const nginxPath = process.env.PW_NGINX_CONF || '/etc/nginx/sites-available/project-workbench';
const ISOLATED = process.env.PW_ISOLATED === '1' || registryPath !== CANONICAL_REGISTRY;
const managedProjects = ['AmrikPublic','HarmaniPublic','IPSpeaker_ESP32','ProVisionIPortal','ProVisionIPublic','SunEstateHomesCA'];
const workbenchSettingsPath = '/etc/project-workbench/workbench.json';
const wrapperEnvPath = '/etc/project-workbench/claude-wrapper.env';
const emptyMcpPath = '/etc/project-workbench/empty-mcp.json';
const setupTtydPort = 7680;
const setupTmuxSession = 'pw_setup';
const internalHandoffToken = process.env.PW_INTERNAL_HANDOFF_TOKEN || '';
// `prompt` (safer default) makes Claude ask before each tool use; `skip` passes
// --dangerously-skip-permissions and runs every tool unattended.
const defaultWorkbenchSettings = { permissionMode:'prompt', mcpMode:'isolated', enabledClis:['claude'], updateClis:['claude'] };
const PERMISSION_MODES = ['prompt','skip'];
function normalizePermissionMode(v){ return PERMISSION_MODES.includes(v) ? v : 'prompt'; }
const SUPPORTED_CLIS = {
 claude:  { label:'Claude Code',        pkg:'@anthropic-ai/claude-code', bin:'claude',  authCmd:'claude /login',                              notes:'Anthropic. Wrapper enforces permissions/MCP/shared-memory policy.' },
 codex:   { label:'OpenAI Codex CLI',   pkg:'@openai/codex',             bin:'codex',   authCmd:'codex login',                                notes:'OpenAI. Sign in with ChatGPT or set OPENAI_API_KEY.' },
 copilot: { label:'GitHub Copilot CLI', pkg:'@github/copilot',           bin:'copilot', authCmd:'gh auth login --git-protocol=https --web',   notes:'GitHub. Auth via gh CLI; copilot reads gh credentials.' }
};

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// A request is "trusted local" only when it reaches the loopback-bound app
// (127.0.0.1:3000) directly rather than through nginx — which always sets
// X-Forwarded-For / X-Real-IP on its proxy to :3000. Such a caller is an on-box
// process (the installer / deploy) that already has root, so it is safe to let
// past the CSRF and admin gates for self-heal. Browser/LAN traffic always
// arrives via nginx and therefore carries those forwarding headers.
function isTrustedLocal(req){
 if(req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
 const ip = req.socket?.remoteAddress || '';
 return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// CSRF guard: require that mutating requests come from a page on this workbench.
// nginx in front gates with Basic Auth (which the browser caches and replays on
// any origin), so we additionally check that Origin or Referer matches Host on
// non-safe methods. Same-origin fetch() and form POST both send Origin in every
// browser that ships today. Scripted clients can pass `-H 'Origin: <host>'`.
app.use((req, res, next) => {
 const method = req.method.toUpperCase();
 if(method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
 if(isTrustedLocal(req)) return next();
 const host = req.get('host') || '';
 const origin = req.get('origin');
 const referer = req.get('referer');
 let claimed = '';
 if(origin){ try { claimed = new URL(origin).host; } catch {} }
 else if(referer){ try { claimed = new URL(referer).host; } catch {} }
 if(claimed && host && claimed === host) return next();
 res.status(403).type('text/plain').send('CSRF check failed: Origin/Referer must match Host on mutating requests.\nIf scripting the API, set Origin to your workbench host.');
});

// attachUser must run on every request so route handlers can read req.user.
// It does not block — enforcement is done per-route via requireAuth/requireAdmin/etc.
app.use(attachUser);

async function loadProjects(){ const raw = await fs.readFile(registryPath,'utf8').catch(()=> '[]'); return JSON.parse(raw); }
async function saveProjects(projects){ await fs.writeFile(registryPath, JSON.stringify(projects, null, 2)+'\n'); }
// Serialize every projects.json read-modify-write transaction. Concurrent POSTs
// from two browser tabs would otherwise both loadProjects() against the same
// pre-edit snapshot, mutate independently, then last-write-wins on saveProjects.
let projectsLock = Promise.resolve();
async function withProjectsLock(fn){
 const prev = projectsLock;
 let release;
 projectsLock = new Promise(r => { release = r; });
 try { await prev; return await fn(); } finally { release(); }
}

// ============================================================================
// Auth (Phase 1): users.json + cookie sessions + per-project grants.
// PW_AUTH_ENFORCE controls whether unauthenticated requests are blocked. When
// false (the safe default for code-only rollouts), the dashboard treats anon
// requests as an implicit admin so existing terminals/Claude sessions keep
// working until an operator creates a real admin via `pw-user add` and flips
// the env var. Throughout Phase 1, nginx Basic Auth remains the outer gate.
// ============================================================================
// PW_AUTH_MODE selects the credential backend: `local` (default) verifies a
// scrypt password stored on the user record; `ldap` authenticates against a
// directory via simple bind over TLS and treats the local record as an access
// whitelist. Both modes share ONE user record and ONE server-side revocable
// session store. Data paths are env-overridable (for tests / alt layouts).
const AUTH_MODE = (process.env.PW_AUTH_MODE || 'local').toLowerCase() === 'ldap' ? 'ldap' : 'local';
const usersPath = process.env.PW_USERS_PATH || '/etc/project-workbench/users.json';
const sessionsPath = process.env.PW_SESSIONS_PATH || '/var/lib/project-workbench/sessions.json';
const auditLogPath = process.env.PW_AUDIT_LOG || '/var/log/project-workbench/audit.log';
const AUTH_ENFORCE = String(process.env.PW_AUTH_ENFORCE || '').toLowerCase() === 'true';
console.log(`[auth] mode=${AUTH_MODE} enforce=${AUTH_ENFORCE}`);
// LDAP settings (ldap mode only). Generic, de-GOA'd defaults; a directory
// deployment overlays PW_LDAP_URL / PW_LDAP_SUFFIX / PW_LOGIN_ORG via env.
const LDAP_URL = process.env.PW_LDAP_URL || 'ldaps://ldap.example.com:636';
const LDAP_SUFFIX = process.env.PW_LDAP_SUFFIX || '@example.com';
const LDAP_CACERT = process.env.PW_LDAP_CACERT || '/etc/ssl/certs/ca-certificates.crt';
const LDAP_BIND_ATTEMPTS = Number(process.env.PW_LDAP_BIND_ATTEMPTS) || 4;
const LOGIN_ORG = process.env.PW_LOGIN_ORG || (AUTH_MODE === 'ldap' ? 'your directory account' : '');
const SESSION_COOKIE = 'pw_session';
const SESSION_TTL_MS = (Number(process.env.PW_SESSION_HOURS) || 720) * 60 * 60 * 1000;
const ROLES = ['admin','developer','content_editor','viewer'];
const TERMINAL_ROLES = new Set(['admin','developer']);
// Roles allowed to drop files into a project's _inbox (uploads + per-file
// delete). content_editor needs this for the PVIKPBot/content-handoff flow
// without getting raw shell. viewer remains read-only.
const INBOX_WRITE_ROLES = new Set(['admin','developer','content_editor']);
const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(plain){
 const salt = crypto.randomBytes(16);
 const hash = await scryptAsync(String(plain), salt, 64, { N:16384, r:8, p:1 });
 return `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}
async function verifyPassword(plain, stored){
 try {
  const [scheme, saltB64, hashB64] = String(stored||'').split('$');
  if(scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(String(plain), salt, expected.length, { N:16384, r:8, p:1 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, Buffer.from(actual));
 } catch { return false; }
}

async function loadUsers(){
 try { const raw = await fs.readFile(usersPath,'utf8'); const data = JSON.parse(raw); return Array.isArray(data?.users) ? data.users : []; }
 catch(e){ if(e.code === 'ENOENT') return []; throw e; }
}
async function saveUsers(users){
 await fs.mkdir(path.dirname(usersPath),{recursive:true});
 await fs.writeFile(usersPath, JSON.stringify({ users }, null, 2)+'\n');
 await fs.chmod(usersPath, 0o600).catch(()=>{});
}

// ---- LDAP (ldap mode) --------------------------------------------------------
// Simple bind over TLS via ldapwhoami (no native deps). The DC cert is validated
// against the system CA bundle (LDAPTLS_CACERT).
function ldapBindOnce(bindDn, password){
 return new Promise((resolve, reject) => {
  execFile('ldapwhoami', ['-x', '-H', LDAP_URL, '-D', bindDn, '-w', password],
   { timeout: 10000, env: { ...process.env, LDAPTLS_CACERT: LDAP_CACERT, LDAPTLS_REQCERT: 'demand' } },
   (err, stdout, stderr) => {
    if(err) reject(new Error((stderr || err.message || 'LDAP bind failed').trim()));
    else resolve(true);
   });
 });
}
// True only for connection/TLS-level failures (retryable across a DC round-robin);
// a real bind result (bad password, signing-required, success) is never retried.
function isRetryableLdapError(msg){
 if(/Invalid credentials|AcceptSecurityContext|Strong\(er\) authentication|data 5[0-9a-f]{2}/i.test(msg)) return false;
 return /Can't contact LDAP server|Connect error|ldap_start_tls|\(-1\)|\(-11\)|ETIMEDOUT|Timed out|Connection refused|connection reset|Network is unreachable/i.test(msg);
}
async function ldapBind(username, password){
 const bindDn = username.includes('@') ? username : username + LDAP_SUFFIX;
 let lastErr;
 for(let attempt = 1; attempt <= LDAP_BIND_ATTEMPTS; attempt++){
  try { return await ldapBindOnce(bindDn, password); }
  catch(e){ lastErr = e; if(!isRetryableLdapError(e.message) || attempt === LDAP_BIND_ATTEMPTS) throw e; }
 }
 throw lastErr;
}
/** Normalise a directory identity to a bare lowercase username (ldap mode only):
 *  EXAMPLE\jane.doe → jane.doe · jane.doe@example.com → jane.doe · jane.doe.z → jane.doe */
function normalizeUsername(raw){
 if(!raw) return '';
 let s = String(raw).trim();
 const bsIdx = s.lastIndexOf('\\'); if(bsIdx >= 0) s = s.slice(bsIdx + 1);
 const atIdx = s.indexOf('@'); if(atIdx >= 0) s = s.slice(0, atIdx);
 s = s.toLowerCase().trim();
 if(/\.[a-z]$/.test(s)) s = s.slice(0, -2);   // strip admin-account suffix (.z, .a…)
 return s;
}
// Shared credential check for every login entry point. `ldap`: bind is
// authoritative and the account must already exist on the whitelist; `local`:
// the scrypt hash on the record is verified. Returns the user record or null;
// in `ldap` mode MAY throw when the bind itself fails (caller treats as invalid).
async function authenticate(rawUsername, password){
 if(AUTH_MODE === 'ldap'){
  await ldapBind(String(rawUsername || ''), password);
  const username = normalizeUsername(rawUsername);
  const users = await loadUsers();
  return users.find(x => x.username === username) || null;
 }
 const username = String(rawUsername || '').trim();
 const users = await loadUsers();
 const u = users.find(x => x.username === username);
 if(!u || !u.passwordHash) return null;
 return (await verifyPassword(password, u.passwordHash)) ? u : null;
}

let sessionsCache = null;
let sessionsLock = Promise.resolve();
async function withSessionsLock(fn){
 const prev = sessionsLock;
 let release;
 sessionsLock = new Promise(r => { release = r; });
 try { await prev; return await fn(); } finally { release(); }
}
async function loadSessions(){
 if(sessionsCache) return sessionsCache;
 try { const raw = await fs.readFile(sessionsPath,'utf8'); const data = JSON.parse(raw); sessionsCache = Array.isArray(data?.sessions) ? data.sessions : []; }
 catch { sessionsCache = []; }
 return sessionsCache;
}
async function saveSessions(){
 if(!sessionsCache) return;
 await fs.mkdir(path.dirname(sessionsPath),{recursive:true});
 await fs.writeFile(sessionsPath, JSON.stringify({ sessions: sessionsCache }, null, 2)+'\n');
 await fs.chmod(sessionsPath, 0o600).catch(()=>{});
}
async function createSession(userId){
 return withSessionsLock(async () => {
  const sessions = await loadSessions();
  const id = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  sessions.push({ id, userId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime()+SESSION_TTL_MS).toISOString() });
  await saveSessions();
  return id;
 });
}
async function revokeSession(id){
 return withSessionsLock(async () => {
  const sessions = await loadSessions();
  const i = sessions.findIndex(s => s.id === id);
  if(i >= 0){ sessions.splice(i,1); await saveSessions(); }
 });
}
async function lookupSession(id){
 if(!id) return null;
 const sessions = await loadSessions();
 const s = sessions.find(x => x.id === id);
 if(!s) return null;
 if(new Date(s.expiresAt) < new Date()){ await revokeSession(id); return null; }
 return s;
}
async function purgeExpiredSessions(){
 return withSessionsLock(async () => {
  const sessions = await loadSessions();
  const now = new Date();
  const kept = sessions.filter(s => new Date(s.expiresAt) >= now);
  if(kept.length !== sessions.length){ sessionsCache = kept; await saveSessions(); }
 });
}

function userHasProjectAccess(user, projectName){
 if(!user) return false;
 if(user.role === 'admin') return true;
 if(user.projects === '*') return true;
 return Array.isArray(user.projects) && user.projects.includes(projectName);
}
function filterProjectsForUser(projects, user){
 if(!user || user.role === 'admin' || user.projects === '*') return projects;
 const allowed = new Set(Array.isArray(user.projects) ? user.projects : []);
 return projects.filter(p => allowed.has(p.name));
}

// Cookie helpers (cookie-parser kept out of the dep tree to avoid native build).
function getCookie(req, name){
 const raw = req.headers.cookie || '';
 for(const c of raw.split(/;\s*/)){
  const i = c.indexOf('=');
  if(i > 0 && c.slice(0,i) === name){ try { return decodeURIComponent(c.slice(i+1)); } catch { return c.slice(i+1); } }
 }
 return null;
}
function isHttps(req){ return req.protocol === 'https' || req.get('x-forwarded-proto') === 'https'; }
function setSessionCookie(req, res, value, maxAgeSec){
 const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','SameSite=Lax'];
 if(typeof maxAgeSec === 'number') parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
 if(isHttps(req)) parts.push('Secure');
 res.append('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(req, res){ setSessionCookie(req, res, '', 0); }

// Implicit admin used when PW_AUTH_ENFORCE=false and no session cookie present.
// This is the soft-mode back-compat path; flipping enforce=true makes anon
// requests get a 401 / login redirect.
const IMPLICIT_ADMIN = Object.freeze({ id:'anon-admin', username:'(anonymous)', role:'admin', projects:'*', implicit:true });

async function attachUser(req, res, next){
 try {
  const sid = getCookie(req, SESSION_COOKIE);
  if(sid){
   const sess = await lookupSession(sid);
   if(sess){
    const users = await loadUsers();
    const u = users.find(x => x.id === sess.userId);
    if(u){ req.user = u; req.sessionId = sid; return next(); }
   }
  }
  req.user = AUTH_ENFORCE ? null : IMPLICIT_ADMIN;
  return next();
 } catch(e){ next(e); }
}

function wantsJson(req){
 return req.path.startsWith('/api/') || (req.get('accept') || '').includes('json');
}
function requireAuth(req, res, next){
 if(req.user) return next();
 if(wantsJson(req)) return res.status(401).json({ ok:false, error:'Authentication required' });
 return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || req.url));
}
function requireAdmin(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(req.user.role === 'admin') return next();
 if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Admin role required' });
 return res.status(403).type('html').send(`<h1>403 — Admin access required</h1><p>Your account (<b>${esc(req.user.username)}</b>, role: <b>${esc(req.user.role)}</b>) cannot access this page.</p><p><a href="/">Back to dashboard</a></p>`);
}
// Self-heal endpoints accept either an admin session or a trusted on-box caller
// (installer/deploy hitting 127.0.0.1:3000 directly), so a redeploy can heal
// nginx without an interactive admin login even when auth enforcement is on.
function requireAdminOrLocal(req, res, next){
 if(isTrustedLocal(req)) return next();
 return requireAdmin(req, res, next);
}
function requireProjectAccess(req, res, next){
 const projectName = req.params.project || req.params.name || req.params.oldName;
 if(!projectName){ if(wantsJson(req)) return res.status(400).json({ok:false,error:'No project in route'}); return res.status(400).send('No project in route'); }
 if(!req.user) return requireAuth(req, res, next);
 if(userHasProjectAccess(req.user, projectName)) return next();
 if(wantsJson(req)) return res.status(403).json({ ok:false, error:`Not authorized for project "${projectName}"` });
 return res.status(403).type('html').send(`<h1>403 — Project access denied</h1><p>You are not authorized to access <b>${esc(projectName)}</b>.</p><p><a href="/">Back to dashboard</a></p>`);
}
function requireTerminalAccess(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(!TERMINAL_ROLES.has(req.user.role)){
  if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Terminal/Claude access requires admin or developer role' });
  const hint = req.user.role === 'content_editor' ? ' The PVIKPBot supervised workflow is planned for Phase 2.' : '';
  return res.status(403).type('html').send(`<h1>403 — Terminal access denied</h1><p>Your role (<b>${esc(req.user.role)}</b>) cannot open project terminals.${hint}</p><p><a href="/">Back to dashboard</a></p>`);
 }
 return requireProjectAccess(req, res, next);
}
function requireInboxWrite(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(!INBOX_WRITE_ROLES.has(req.user.role)){
  if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Uploading requires admin, developer, or content_editor role' });
  return res.status(403).type('html').send(`<h1>403 — Upload denied</h1><p>Your role (<b>${esc(req.user.role)}</b>) cannot upload to project inboxes.</p><p><a href="/">Back to dashboard</a></p>`);
 }
 return requireProjectAccess(req, res, next);
}

async function audit(event, detail = {}, req = null){
 try {
  const entry = {
   ts: new Date().toISOString(),
   event,
   user: req?.user?.username ?? null,
   role: req?.user?.role ?? null,
   ip: req ? (req.get('x-forwarded-for')?.split(',')[0]?.trim() || req.ip || '') : '',
   ...detail,
  };
  await fs.mkdir(path.dirname(auditLogPath),{recursive:true});
  await fs.appendFile(auditLogPath, JSON.stringify(entry)+'\n');
 } catch { /* never fail a request for audit */ }
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function slug(s){ return String(s ?? '').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120) || 'clipboard-file'; }
function validName(name){ return /^[A-Za-z0-9._-]+$/.test(String(name || '')); }
function workspacePath(name){ return path.join(workspaceRoot, name); }
async function projectByName(name){ return (await loadProjects()).find(p => p.name === name); }
function allUsedPorts(projects){ const out = new Set(); for(const p of projects){ const a = Number(p?.port); if(Number.isFinite(a)) out.add(a); const b = Number(p?.preview?.port); if(Number.isFinite(b) && b > 0) out.add(b); } return out; }
function nextPort(projects){ const used = allUsedPorts(projects); let port = 7681; while(used.has(port)) port++; return port; }
function nextPreviewPort(projects){ const used = allUsedPorts(projects); let port = 7790; while(used.has(port)) port++; return port; }
function validPort(n){ return Number.isInteger(n) && n >= 1024 && n <= 65535; }
function hasPreview(p){ return !!(p && p.preview && typeof p.preview.cmd === 'string' && p.preview.cmd.trim() && Number(p.preview.port) > 0); }
function previewUnit(name){ return `project-preview@${name}.service`; }
async function sh(cmd,args,opts={}){ return execFileAsync(cmd,args,{timeout:120000,...opts}); }
function tmuxSession(name){ return 'pw_' + String(name).replace(/[^A-Za-z0-9_]/g,'_'); }
async function probePreviewReady(port){ try { await execFileAsync('bash',['-c',`exec 3<>/dev/tcp/127.0.0.1/${Number(port)}`],{timeout:1500}); return true; } catch { return false; } }
async function previewStatus(p){
 if(!hasPreview(p)) return { configured:false, active:false, ready:false };
 const unit = previewUnit(p.name);
 let active = false, since = null, pid = null, result = null, exitCode = null;
 try {
  const { stdout } = await execFileAsync('systemctl',['show',unit,'--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,Result,ExecMainStatus','--no-pager'],{timeout:5000});
  const kv = Object.fromEntries(stdout.split('\n').filter(Boolean).map(l=>{ const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1)]; }));
  active = (kv.ActiveState === 'active');
  since = kv.ActiveEnterTimestamp || null;
  pid = Number(kv.MainPID) || null;
  result = kv.Result || null;
  const ec = Number(kv.ExecMainStatus);
  exitCode = Number.isFinite(ec) ? ec : null;
 } catch {}
 const ready = active ? await probePreviewReady(p.preview.port) : false;
 // When the unit isn't active and failed (or was active with bad exit), include
 // the last few log lines so the user sees why instead of "Preview is stopped".
 let lastError = null;
 if(!active && result && result !== 'success'){
  try { lastError = (await previewLogs(p.name, 15)).trim().slice(-1500); } catch {}
 }
 return { configured:true, active, ready, since, pid, port:Number(p.preview.port), basepath:`/preview/${p.name}`, url:`/preview/${p.name}/`, result, exitCode, lastError };
}
async function previewLogs(name, lines=200){
 try { const { stdout } = await execFileAsync('journalctl',['-u',previewUnit(name),'--no-pager','-n',String(Number(lines)||200),'-o','cat'],{timeout:5000}); return stdout; }
 catch(e){ return `[no logs] ${e.message || e}`; }
}
async function startPreviewUnit(p){ if(!hasPreview(p)) throw new Error('Preview is not configured for this project'); await sh('systemctl',['restart',previewUnit(p.name)]); }
async function stopPreviewUnit(name){ await sh('systemctl',['stop',previewUnit(name)]).catch(()=>{}); await sh('systemctl',['disable',previewUnit(name)]).catch(()=>{}); }
async function tmux(args,opts={}){ return execFileAsync('sudo',['-u','admin','tmux',...args],{timeout:10000,...opts}); }
function parseTmuxWindows(stdout){
 return String(stdout || '').split('\n').filter(Boolean).map(line=>{
  const parts = line.split('|');
  const index = Number(parts[0]);
  // bell = tmux's window_bell_flag, set when monitor-bell catches a BEL in a
  // window that isn't being viewed (e.g. Claude rings the terminal bell when
  // it finishes a turn). tmux clears it automatically when the window is
  // selected, so the front-end gets "clear on click" for free.
  return { index, name:parts[1] || `#${parts[0]}`, active:parts[2] === '1', bell:parts[3] === '1' };
 }).filter(w=>Number.isFinite(w.index));
}
async function listTmuxWindows(project){
 const { stdout } = await tmux(['list-windows','-t',tmuxSession(project),'-F','#{window_index}|#{window_name}|#{window_active}|#{window_bell_flag}']);
 return parseTmuxWindows(stdout);
}

async function tmuxWindowDetails(project){
 const fmt = '#{window_index}|#{window_name}|#{window_active}|#{window_bell_flag}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}';
 const { stdout } = await tmux(['list-windows','-t',tmuxSession(project),'-F',fmt]);
 return String(stdout || '').split('\n').filter(Boolean).map(line=>{
  const parts = line.split('|');
  return { index:Number(parts[0]), name:parts[1]||`#${parts[0]}`, active:parts[2]==='1', bell:parts[3]==='1', command:parts[4]||'', path:parts[5]||'', panePid:parts[6]||'' };
 }).filter(w=>Number.isFinite(w.index));
}
function shellQuote(s){ return JSON.stringify(String(s)); }
async function ensureProjectTmuxSession(p){
 try { await tmux(['has-session','-t',tmuxSession(p.name)]); return; } catch {}
 const cmd = `env HOME=/home/admin LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=screen-256color COLORTERM=truecolor PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin bash --noprofile --norc`;
 await tmux(['new-session','-d','-s',tmuxSession(p.name),'-c',p.path,cmd]);
 await tmux(['send-keys','-t',tmuxSession(p.name),`printf 'Project workspace: %s\nClaude: %s\nPersistent console: tmux session %s\nTip: run claude from here after auth is completed.\n\n' ${shellQuote(p.path)} ${shellQuote('/usr/local/bin/claude')} ${shellQuote(tmuxSession(p.name))}`,'C-m']);
}
async function ensurePvikpbotClaude(p){
 await ensureProjectTmuxSession(p);
 let details = await tmuxWindowDetails(p.name).catch(()=>[]);
 let win = details.find(w => w.name === 'PVIKPBot') || null;
 if(!win){
  await fs.mkdir(path.join(p.path,'.pvikpbot'),{recursive:true});
  const policyPath = path.join(p.path,'.pvikpbot','PVIKPBOT.md');
  await fs.writeFile(policyPath, `PVIKPBot is the supervised assistant session for approved ProVisionI work on ${p.name}.

- Operate only on instructions relayed through PVI Authority / Hermes-James approval.
- Do not expose secrets or raw credentials.
- For approved website/project changes, implement, verify, commit, and push only the approved scope.
`, { flag:'wx' }).catch(e=>{ if(e.code !== 'EEXIST') throw e; });
  await newTmuxWindow(p,'PVIKPBot','/usr/local/bin/claude --name PVIKPBot');
  await new Promise(r=>setTimeout(r,1200));
  details = await tmuxWindowDetails(p.name);
  win = details.find(w => w.name === 'PVIKPBot') || null;
 } else if(!/claude(\.exe)?$/.test(win.command)){
  // Claude Code often shows pane_current_command as node, so Ctrl-C can be
  // swallowed by the interactive TUI and leave the old MCP config loaded. For
  // authority handoffs, start a fresh PVIKPBot window so updated MCP policy
  // (including the PVI Authority completion callback) is definitely loaded.
  await tmux(['kill-window','-t',`${tmuxSession(p.name)}:${win.index}`]).catch(()=>{});
  await newTmuxWindow(p,'PVIKPBot','/usr/local/bin/claude --name PVIKPBot');
  await new Promise(r=>setTimeout(r,1800));
  details = await tmuxWindowDetails(p.name);
  win = details.find(w => w.name === 'PVIKPBot') || win;
 }
 if(!win) throw new Error('PVIKPBot window could not be created');
 await tmux(['select-window','-t',`${tmuxSession(p.name)}:${win.index}`]).catch(()=>{});
 return win;
}
async function waitForPanePrompt(target,timeoutMs=30000){
 const deadline = Date.now() + timeoutMs;
 while(Date.now() < deadline){
  const { stdout } = await tmux(['capture-pane','-p','-t',target]).catch(()=>({stdout:''}));
  if(/bypass permissions on|\/rc|Claude Code/.test(stdout)) return true;
  await new Promise(r=>setTimeout(r,750));
 }
 return false;
}
async function injectPvikpbotPrompt(p,prompt){
 const text = String(prompt || '').trim();
 if(!text) throw new Error('prompt is required');
 const win = await ensurePvikpbotClaude(p);
 const target = `${tmuxSession(p.name)}:${win.index}`;
 const ready = await waitForPanePrompt(target);
 if(!ready) throw new Error('PVIKPBot Claude session did not become ready for prompt injection');
 // Claude Code runs as a full-screen TUI (pane_current_command often appears as
 // `node`). tmux paste-buffer can report success while the TUI ignores the
 // bracketed paste, leaving the handoff invisible. Send literal keystrokes in
 // bounded chunks instead, then press Enter once.
 const chunkSize = 700;
 let chunks = 0;
 for(let i=0; i<text.length; i+=chunkSize){
  await tmux(['send-keys','-t',target,'-l',text.slice(i,i+chunkSize)],{maxBuffer:1024*1024});
  chunks += 1;
  await new Promise(r=>setTimeout(r,120));
 }
 await tmux(['send-keys','-t',target,'Enter']);
 return { window: win.index, command: win.command || 'unknown', ready, injection:'send-keys-literal', chunks };
}
async function newTmuxWindow(p,name='new task',cmd=''){
 const safeName = String(name || 'new task').replace(/[\r\n\t]/g,' ').trim().slice(0,80) || 'new task';
 await tmux(['new-window','-t',tmuxSession(p.name),'-c',p.path,'-n',safeName,'env','HOME=/home/admin','LANG=C.UTF-8','LC_ALL=C.UTF-8','TERM=screen-256color','COLORTERM=truecolor','PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin','bash','--noprofile','--norc']);
 const trimmedCmd = String(cmd || '').trim();
 if(trimmedCmd){
  await new Promise(r=>setTimeout(r,80));
  await tmux(['send-keys','-t',`${tmuxSession(p.name)}:${safeName}`,trimmedCmd,'C-m']);
 }
}
async function requireProject(req,res){ const p = await projectByName(req.params.project); if(!p){ res.status(404).json({ok:false,error:'Unknown project'}); return null; } return p; }
async function sweepOrphanTmuxSessions(){
 // Kill any pw_* tmux session whose project no longer exists in projects.json.
 // Defensive against drift (e.g. a project was deleted while the dashboard was down).
 try {
  const { stdout } = await tmux(['list-sessions','-F','#{session_name}']);
  const projects = await loadProjects();
  const expected = new Set([setupTmuxSession, ...projects.map(p => tmuxSession(p.name))]);
  for(const session of stdout.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('pw_'))){
   if(!expected.has(session)){
    console.log(`[orphan-sweep] killing tmux session: ${session}`);
    await tmux(['kill-session','-t',session]).catch(()=>{});
   }
  }
 } catch {}
}
const pendingDir = '/var/lib/project-workbench/pending';
function pendingMarkerPath(p){ return path.join(pendingDir, p.name); }
async function readPending(p){ try { const stat = await fs.stat(pendingMarkerPath(p)); return { pending: true, since: stat.mtime.toISOString() }; } catch { return { pending: false }; } }
async function clearPending(p){ await fs.rm(pendingMarkerPath(p), { force: true }).catch(()=>{}); }
// True when the project has a finished-but-unviewed tab: any background tmux
// window (not the one currently shown) whose terminal-bell flag is set. This is
// the same per-window signal the terminal tab strip flashes on, and it clears
// itself when the user selects that window. Used to light the dashboard project
// card. Returns false if the session isn't running.
async function projectHasUnreadBell(p){
 try { return (await listTmuxWindows(p.name)).some(w => w.bell && !w.active); }
 catch { return false; }
}
async function getClaudeVersion(){ try { const { stdout } = await sh('claude',['--version'],{timeout:5000}); return stdout.trim() || 'unknown'; } catch { return 'unavailable'; } }
async function getClaudeUpdateStamp(){ try { const stat = await fs.stat('/var/log/claude-code-update.log'); return stat.mtime.toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'); } catch { return 'never'; } }

async function loadWorkbenchSettings(){
 try { const raw = await fs.readFile(workbenchSettingsPath,'utf8'); return { ...defaultWorkbenchSettings, ...JSON.parse(raw) }; }
 catch { return { ...defaultWorkbenchSettings }; }
}
async function saveWorkbenchSettings(s){
 await fs.mkdir(path.dirname(workbenchSettingsPath),{recursive:true});
 await fs.writeFile(workbenchSettingsPath, JSON.stringify(s,null,2)+'\n');
 await syncWrapperEnv(s);
}
async function syncWrapperEnv(s){
 const body = [
  '# Generated by Project Workbench Setup Wizard',
  'PW_SHARED_MEMORY=/opt/project-workbench/memory',
  `PW_MCP_MODE=${['inherit','isolated','custom'].includes(s.mcpMode) ? s.mcpMode : 'inherit'}`,
  `PW_MCP_CONFIG=${emptyMcpPath}`,
  `PW_PERMISSION_MODE=${normalizePermissionMode(s.permissionMode)}`,
  ''
 ].join('\n');
 await fs.writeFile(wrapperEnvPath, body);
}
async function getCliVersion(bin){
 try { const { stdout } = await sh(bin,['--version'],{timeout:5000}); return (stdout.trim().split('\n')[0]) || 'unknown'; }
 catch { return null; }
}
const CLI_AUTH_PATHS = {
 claude:  ['/home/admin/.claude/.credentials.json'],
 codex:   ['/home/admin/.codex/auth.json','/home/admin/.config/codex/auth.json'],
 copilot: ['/home/admin/.config/gh/hosts.yml']
};
async function getCliAuth(key){
 for(const p of (CLI_AUTH_PATHS[key] || [])){
  try { const st = await fs.stat(p); if(st.isFile() && st.size > 0) return true; } catch {}
 }
 return false;
}
async function getCliStatuses(){
 const out = {};
 for(const [key,cfg] of Object.entries(SUPPORTED_CLIS)){
  const [version, authenticated] = await Promise.all([getCliVersion(cfg.bin), getCliAuth(key)]);
  // Drop pkg/bin/authCmd from this response — the wizard UI doesn't display
  // them and we'd rather not advertise the internal command/package layout.
  out[key] = { key, label:cfg.label, notes:cfg.notes, installed:!!version, version: version || 'not installed', authenticated };
 }
 return out;
}
async function ensureSetupTerminal(){
 await sh('systemctl',['enable','project-setup-terminal.service']).catch(()=>{});
 await sh('systemctl',['start','project-setup-terminal.service']).catch(()=>{});
 for(let i=0;i<20;i++){
  try { await tmux(['has-session','-t',setupTmuxSession]); return true; } catch {}
  await new Promise(r=>setTimeout(r,150));
 }
 return false;
}

function nginxConfig(projects){
 const previewProjects = projects.filter(hasPreview);
 // Internal endpoint that nginx auth_request calls. Forwards Cookie to the
 // dashboard so it can decide based on the app session.
 const authCheckRoute = `    location = /pw-auth-check {\n        internal;\n        proxy_pass http://127.0.0.1:3000/api/auth/check$is_args$args;\n        proxy_pass_request_body off;\n        proxy_set_header Content-Length "";\n        proxy_set_header Host $host;\n        proxy_set_header Cookie $http_cookie;\n    }\n`;
 // Setup terminal is admin-only — the wizard signs in CLIs whose tokens land
 // in /home/admin and apply to every project.
 const setupRoute = `    location /pty/_setup/ {\n        auth_request /pw-auth-check;\n        proxy_pass http://127.0.0.1:${setupTtydPort}/pty/_setup/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`;
 // Accept-Encoding is cleared so ttyd serves uncompressed HTML — otherwise
 // sub_filter can't match '</head>' inside a gzipped body and the preload
 // script tag is silently dropped, breaking mouse-drag-copy (OSC 52 sniffer).
 // auth_request gates each terminal/preview block per-project; in soft mode
 // (PW_AUTH_ENFORCE=false) the dashboard returns 200 for anonymous callers.
 const locations = projects.map(p => `    location /pty/${p.name}/ {\n        auth_request /pw-auth-check;\n        sub_filter_once off;\n        sub_filter_types text/html;\n        sub_filter '</head>' '<script src="/terminal-preload.js"></script></head>';\n        proxy_set_header Accept-Encoding "";\n        proxy_pass http://127.0.0.1:${p.port}/pty/${p.name}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`).join('');
 const previewRoutes = previewProjects.map(p => `    location /preview/${p.name}/ {\n        auth_request /pw-auth-check;\n        proxy_pass http://127.0.0.1:${p.preview.port}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix /preview/${p.name};\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/${p.name}/)(.*)$ /preview/${p.name}/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n        proxy_send_timeout 86400;\n    }\n`).join('');
 const refererMaps = previewProjects.length ? `map $http_referer $pw_preview_name {\n    default "";\n    "~^https?://[^/]+/preview/(?<pname>[^/]+)/" "$pname";\n}\nmap $pw_preview_name $pw_preview_port {\n    default 0;\n${previewProjects.map(p => `    "${p.name}" ${p.preview.port};`).join('\n')}\n}\n` : '';
 const knownDashboardPaths = '^/(api|pty|term|file|manage|preview|terminal-preload|terminal-paste|healthz|favicon|robots)(/|$|\\.|\\?)';
 const previewFallbackLocation = previewProjects.length ? `    location @pw_preview_fallback {\n        proxy_pass http://127.0.0.1:$pw_preview_port$request_uri;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix /preview/$pw_preview_name;\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/)(.*)$ /preview/$pw_preview_name/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n    }\n` : '';
 const rootLocation = previewProjects.length
  ? `    location / {\n        set $pw_route dashboard;\n        if ($pw_preview_port) { set $pw_route preview; }\n        if ($request_uri ~ "${knownDashboardPaths}") { set $pw_route dashboard; }\n        if ($pw_route = preview) { return 418; }\n        error_page 418 = @pw_preview_fallback;\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n`
  : `    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }\n`;
 return `map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n${refererMaps}server {\n    listen 80 default_server;\n    server_name _;\n    client_max_body_size 100m;\n${rootLocation}${authCheckRoute}${setupRoute}${locations}${previewRoutes}${previewFallbackLocation}}\n`;
}
async function applyRouting(projects){
 // An isolated instance must never rewrite the shared host nginx config unless
 // an explicit PW_NGINX_CONF (a throwaway path) was provided.
 if(ISOLATED && !process.env.PW_NGINX_CONF){ console.log('[isolated] skip host nginx write'); return; }
 const newConfig = nginxConfig(projects);
 let prev = null;
 try { prev = await fs.readFile(nginxPath,'utf8'); } catch {}
 await fs.writeFile(nginxPath, newConfig);
 try {
  await sh('nginx',['-t']);
 } catch(e){
  // Roll back to the previous working config so an unrelated edit doesn't
  // brick the reverse proxy. Surface nginx's diagnostic (it usually pinpoints
  // the offending line/location) so the user can see what they broke.
  if(prev !== null){ try { await fs.writeFile(nginxPath, prev); } catch {} }
  const stderr = String(e.stderr || e.message || e).trim().slice(-2000);
  const wrapped = new Error(`nginx rejected the generated config; previous config restored.\n\n${stderr}`);
  wrapped.cause = e;
  throw wrapped;
 }
 await sh('systemctl',['reload','nginx']);
 await sh('systemctl',['daemon-reload']);
}
async function cloneWorkspace(p){
 await fs.mkdir(workspaceRoot,{recursive:true});
 try { await fs.access(path.join(p.path,'.git')); await sh('chown',['-R','admin:admin',p.path]).catch(()=>{}); return; } catch {}
 if(!p.repo){
  // No repo configured: stand up an empty local workspace on demand and
  // initialise it as a git repo so Claude/tools get a sane git context, the
  // .git check above keeps a re-add idempotent, and a remote can be attached
  // later from the terminal. An existing folder at this path is adopted in
  // place — git init never touches existing files.
  await fs.mkdir(p.path,{recursive:true});
  await sh('chown',['-R','admin:admin',p.path]).catch(()=>{});
  await sh('sudo',['-u','admin','git','-C',p.path,'init','-b','main']).catch(()=>{});
  await sh('sudo',['-u','admin','git','-C',p.path,'config','--global','--add','safe.directory',p.path]).catch(()=>{});
  return;
 }
 try { await fs.rm(p.path,{recursive:true,force:true}); } catch {}
 await sh('sudo',['-u','admin','git','clone',p.repo,p.path],{timeout:300000});
 await sh('chown',['-R','admin:admin',p.path]).catch(()=>{});
 await sh('sudo',['-u','admin','git','-C',p.path,'config','--global','--add','safe.directory',p.path]).catch(()=>{});
}
async function trustClaudeProject(p){
 const script = `import json, os, sys
path=sys.argv[1]
conf=os.path.expanduser('~/.claude.json')
try:
    data=json.load(open(conf))
except Exception:
    data={}
projects=data.setdefault('projects', {})
entry=projects.setdefault(path, {})
entry.setdefault('allowedTools', [])
entry.setdefault('mcpContextUris', [])
entry.setdefault('mcpServers', {})
entry.setdefault('enabledMcpjsonServers', [])
entry.setdefault('disabledMcpjsonServers', [])
entry['hasTrustDialogAccepted']=True
entry.setdefault('projectOnboardingSeenCount', 0)
entry.setdefault('hasClaudeMdExternalIncludesApproved', False)
entry.setdefault('hasClaudeMdExternalIncludesWarningShown', False)
entry.setdefault('hasCompletedProjectOnboarding', True)
entry.setdefault('lastGracefulShutdown', True)
tmp=conf+'.tmp'
json.dump(data, open(tmp,'w'), indent=2)
os.replace(tmp, conf)
`;
 await sh('sudo',['-u','admin','python3','-c',script,p.path]).catch(()=>{});
}
async function startProject(p){
 await trustClaudeProject(p);
 await sh('systemctl',['enable',`project-terminal@${p.name}.service`]);
 await sh('systemctl',['restart',`project-terminal@${p.name}.service`]);
}
async function stopProject(name){ await sh('systemctl',['disable','--now',`project-terminal@${name}.service`]).catch(()=>{}); await stopPreviewUnit(name); await sh('sudo',['-u','admin','tmux','kill-session','-t',`pw_${name.replace(/[^A-Za-z0-9_]/g,'_')}`]).catch(()=>{}); }
async function removeWorkspace(p){ const full = path.resolve(p.path); const root = path.resolve(workspaceRoot); if(!full.startsWith(root + path.sep)) throw new Error('Refusing to delete outside workspace root'); await fs.rm(full,{recursive:true,force:true}); }


const landingCss = `body.landing{margin:0;min-height:100vh;background:radial-gradient(120% 90% at 80% -10%,#0d1a33 0%,var(--bg) 55%);color:var(--text);font-family:var(--font)}
.lHero{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:24px 34px 20px;border-bottom:1px solid var(--line);background:rgba(10,17,30,.55);backdrop-filter:blur(8px);flex-wrap:wrap}
.lBrand{display:flex;align-items:center;gap:14px}
.lBrand .brandGlyph{width:40px;height:40px;border-radius:11px;font:900 14px/1 var(--mono);display:inline-grid;place-items:center;background:linear-gradient(135deg,var(--cyan),var(--blue));color:#04101f;box-shadow:0 8px 24px -6px rgba(56,189,248,.45)}
.lBrand h1{margin:0;font-size:21px;letter-spacing:.01em}
.lBrand p{margin:2px 0 0;color:var(--dim);font-size:12.5px}
.lActions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.lMain{max-width:1080px;margin:32px auto 60px;padding:0 26px;display:flex;flex-direction:column;gap:18px}
.lGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.lCard{background:linear-gradient(180deg,var(--panel),#0a1120);border:1px solid var(--line);border-radius:16px;padding:20px 22px;animation:lIn .5s cubic-bezier(.22,.9,.3,1) both;animation-delay:calc(var(--i,0)*55ms)}
@keyframes lIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.lProj{transition:transform .2s,border-color .2s,box-shadow .2s}
.lProj:hover{border-color:var(--line2);transform:translateY(-2px);box-shadow:0 18px 40px -18px rgba(0,0,0,.9)}
.lProjHead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.lProjHead h3{margin:0;font-size:15.5px;color:#f4f8ff}
.pk-mono{display:inline-grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:9px;font:700 12px/1 var(--mono);background:hsl(var(--h) 55% 15%);color:hsl(var(--h) 88% 70%);border:1px solid hsl(var(--h) 55% 28%);text-transform:uppercase}
.lPath{display:block;font:11px var(--mono);color:var(--faint);word-break:break-all;margin-bottom:12px}
.lActs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.lNone{color:var(--faint);font-size:12px;font-style:italic}
.lBtn{display:inline-flex;align-items:center;gap:6px;background:#0d1526;border:1px solid var(--line);color:#cfe3fb;border-radius:9px;padding:8px 14px;cursor:pointer;font:600 12.5px var(--font);text-decoration:none;transition:border-color .15s,background .15s,color .15s,filter .15s}
.lBtn:hover{border-color:var(--line2);background:var(--panel2);color:#fff}
.lBtn.primary{background:linear-gradient(135deg,var(--cyan),var(--blue));border:1px solid transparent;color:#04101f;font-weight:700}
.lBtn.primary:hover{filter:brightness(1.12);color:#04101f}
.lOnboard{max-width:640px}
.lOnboard h2{margin:0 0 4px;font-size:20px}
.lLead{margin:0 0 14px;color:var(--dim);font-size:13.5px;line-height:1.5}
.lStep{display:flex;align-items:center;gap:14px;border:1px solid var(--line);background:#0a1120;border-radius:12px;padding:13px 15px;margin-top:10px;flex-wrap:wrap}
.lNum{display:inline-grid;place-items:center;width:30px;height:30px;flex:0 0 30px;border-radius:50%;background:#12233f;border:1px solid #2f65b0;color:#9fd3ff;font-weight:800;font-size:13px}
.lStepMeta{flex:1 1 auto;min-width:180px}
.lStepMeta b{display:block;color:#f4f8ff;font-size:13.5px}
.lStepMeta span{color:var(--dim);font-size:12px;line-height:1.45}
.badge{display:inline-flex;align-items:center;gap:.35rem;background:#0d1526;border:1px solid var(--line);border-radius:999px;padding:6px 12px;color:var(--dim);font-size:12.5px}
.badge b{color:#f4f8ff}
@media(max-width:640px){.lHero{padding:18px 18px 14px}.lMain{padding:0 14px;margin-top:20px}}`;

const wizardCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-box footer{display:flex;justify-content:flex-end;gap:.5rem;padding:.8rem 1.25rem;border-top:1px solid #1f2937;align-items:center}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.modal-box section{margin-bottom:1.25rem}.modal-box section h3{margin:0 0 .35rem;font-size:1rem;color:#bfdbfe}.section-help{margin:0 0 .55rem;color:#94a3b8;font-size:.85rem}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .75rem;align-items:center;padding:.55rem .7rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#111827}.cli-row .meta{display:flex;flex-direction:column;gap:.15rem;min-width:0}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.8rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .5rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}.cli-row .actions .button{padding:.4rem .65rem;font-size:.82rem;margin:0}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}.env-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.env-grid label{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#cbd5e1}.env-grid select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.45rem;font:inherit}.env-grid .opt-help{font-size:.78rem;color:#94a3b8;line-height:1.45;margin-top:.15rem;min-height:2.6em}.env-grid .opt-help.warn{color:#fca5a5}.env-grid .opt-help b{color:#fde68a}.heal-row{display:flex;gap:.5rem;flex-wrap:wrap}.heal-out{margin:.5rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.6rem .8rem;font-size:.82rem;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block}#authFrame.hidden{display:none}#authHint{color:#94a3b8;font-size:.85rem;margin:.3rem 0 .5rem}#saveStatus{color:#bbf7d0;font-size:.85rem;margin-right:auto}#saveStatus.err{color:#fca5a5}@media(max-width:640px){.cli-row{grid-template-columns:1fr}.env-grid{grid-template-columns:1fr}}`;

const wizardScript = `<script>(function(){const open=document.getElementById('setupBtn');const backdrop=document.getElementById('setupBackdrop');if(!backdrop)return;const closeBtn=document.getElementById('setupCloseBtn');const cancelBtn=document.getElementById('setupCancelBtn');const saveBtn=document.getElementById('setupSaveBtn');const cliRows=document.getElementById('cliRows');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const saveStatus=document.getElementById('saveStatus');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');let state=null;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setHealOut(t,err){healOut.textContent=t||'';healOut.classList.toggle('show',!!t);healOut.classList.toggle('err',!!err)}function setSave(t,err){saveStatus.textContent=t||'';saveStatus.classList.toggle('err',!!err)}function render(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+escHtml(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+escHtml(c.version)+'</span>'+(c.authenticated?'<span class="signed-in" title="Credentials detected on disk">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button type="button" class="button secondary inst">'+(c.installed?'Update':'Install')+'</button><button type="button" class="button auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+escHtml(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');const orig=btn.textContent;btn.disabled=true;btn.textContent='Installing…';setSave('');try{const r=await fetch('/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');const v=row.querySelector('.version');v.textContent=j.version;v.classList.add('installed');btn.textContent='Update';setSave(c.label+': '+j.version)}catch(e){btn.textContent=orig;setSave(e.message,true)}finally{btn.disabled=false}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setSave('');try{const r=await fetch('/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(authFrame.src.indexOf('/pty/_setup/')<0)authFrame.src='/pty/_setup/';authFrame.classList.remove('hidden');authHint.textContent='Running: '+j.command+' — complete the prompts in the terminal below.'}catch(e){setSave(e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderOptHelp()}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest. Use this unless you fully trust everyone with dashboard access.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude will execute any shell command, file write, or tool call without asking. Anyone with basic-auth access effectively has shell on this box.'};const MCP_HELP={inherit:'Claude uses the MCP servers configured on your Anthropic account (whatever <code>~/.claude.json</code> currently has).',isolated:'Forces Claude to use an empty MCP config so no external MCP servers load. Good when you want this box self-contained or your account MCP is unreachable from the LAN.',custom:'Use a custom MCP JSON config file. Path is set via the <code>PW_MCP_CONFIG</code> env var the wrapper reads.'};function renderOptHelp(){const ph=document.getElementById('permHelp');const mh=document.getElementById('mcpHelp');if(ph){ph.innerHTML=PERM_HELP[permMode.value]||'';ph.classList.toggle('warn',permMode.value==='skip')}if(mh)mh.innerHTML=MCP_HELP[mcpMode.value]||''}permMode&&permMode.addEventListener('change',renderOptHelp);mcpMode&&mcpMode.addEventListener('change',renderOptHelp);async function load(){setSave('Loading…');try{const r=await fetch('/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');render();setSave('')}catch(e){setSave(e.message,true)}}function show(){backdrop.classList.remove('hidden');load()}function hide(){backdrop.classList.add('hidden');authFrame.src='about:blank';authFrame.classList.add('hidden');authHint.textContent='Click "Sign in" on a CLI above to send its login command here.';setHealOut('');setSave('')}if(open)open.onclick=show;if(closeBtn)closeBtn.onclick=hide;if(cancelBtn)cancelBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});saveBtn.onclick=async()=>{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);saveBtn.disabled=true;setSave('Saving…');try{const r=await fetch('/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setSave('Saved.')}catch(e){setSave(e.message,true)}finally{saveBtn.disabled=false}};async function heal(url,btn){btn.disabled=true;setHealOut('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');setHealOut(j.message||'OK')}catch(e){setHealOut(e.message,true)}finally{btn.disabled=false}}healNginx.onclick=()=>heal('/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('/api/setup/heal/dirs',healDirs);load()})();</script>`;

const wizardModalHtml = `<div id="setupBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box"><header><h2>Setup Wizard</h2><button class="modal-close" id="setupCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><section><h3>CLIs</h3><p class="section-help">Pick which assistants this instance offers. "Auto-update" CLIs are upgraded nightly by the update timer.</p><div id="cliRows"></div></section><section><h3>Sign in</h3><p class="section-help">Sign-in opens the shared setup terminal at <code>/pty/_setup/</code>. Tokens land in <code>/home/admin</code> and apply to every project.</p><div id="authHint">Click "Sign in" on a CLI above to send its login command here.</div><iframe id="authFrame" class="hidden" title="Setup auth terminal"></iframe></section><section><h3>Environment</h3><div class="env-grid"><label>Permission mode<select id="permMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="permHelp"></span></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="mcpHelp"></span></label></div></section><section><h3>Heal</h3><p class="section-help">Self-repair common installation drift. Run if a route is missing or a runtime path looks broken.</p><div class="heal-row"><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button><button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button></div><pre class="heal-out" id="healOut"></pre></section></div><footer><span id="saveStatus"></span><button class="button secondary" id="setupCancelBtn" type="button">Close</button><button class="button" id="setupSaveBtn" type="button">Save settings</button></footer></div></div>`;

const modalBaseCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.button{display:inline-block;background:#2563eb;color:#fff;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button:disabled{opacity:.55;cursor:not-allowed}.subtle{color:#94a3b8;font-size:.8rem}`;

const previewCss = `.modal-box.preview{max-width:1180px;height:90vh}.modal-box.preview .body{padding:0;display:flex;flex-direction:column;gap:0}.preview-toolbar{display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;border-bottom:1px solid #1f2937;background:#0b1220;flex-wrap:wrap}.preview-toolbar .pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .65rem;border-radius:999px;background:#111827;border:1px solid #334155;color:#cbd5e1;font-size:.82rem}.preview-toolbar .pill .dot{width:.55em;height:.55em;border-radius:50%;background:#64748b;box-shadow:0 0 0 .2em rgba(100,116,139,.15)}.preview-toolbar .pill.running{color:#bbf7d0;border-color:#166534}.preview-toolbar .pill.running .dot{background:#22c55e;box-shadow:0 0 0 .2em rgba(34,197,94,.25);animation:pwPulse 1.6s ease-in-out infinite}.preview-toolbar .pill.starting{color:#fde68a;border-color:#854d0e}.preview-toolbar .pill.starting .dot{background:#facc15;box-shadow:0 0 0 .2em rgba(250,204,21,.25);animation:pwPulse 1.2s ease-in-out infinite}.preview-toolbar .pill.error{color:#fecaca;border-color:#7f1d1d}.preview-toolbar .pill.error .dot{background:#ef4444}.preview-toolbar .spacer{flex:1 1 auto}.preview-toolbar .button{margin:0;padding:.45rem .8rem;font-size:.85rem}.preview-toolbar .button.icon{padding:.45rem .55rem}.preview-toolbar a.button{text-decoration:none}.preview-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;background:#0f172a}.preview-empty{display:grid;place-items:center;flex:1 1 auto;color:#94a3b8;text-align:center;padding:2rem;font-size:.95rem}.preview-empty.hidden{display:none}.preview-empty>div{max-width:780px}.preview-empty code{color:#bfdbfe;display:block;margin-top:.55rem;font-size:.8rem;background:#020617;border:1px solid #1f2937;border-radius:6px;padding:.55rem .7rem;text-align:left;white-space:pre-wrap;word-break:break-word}#previewFrame{flex:1 1 auto;width:100%;border:0;background:#fff;display:block}#previewFrame.hidden{display:none}.preview-logs{display:none;flex:0 0 auto;max-height:32%;border-top:1px solid #1f2937;background:#020617;color:#bbf7d0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.55rem .85rem;overflow:auto;white-space:pre-wrap}.preview-logs.show{display:block}.preview-logs.err{color:#fca5a5}.preview-statusline{padding:.4rem .85rem;font-size:.82rem;color:#94a3b8;border-bottom:1px solid #1f2937;background:#0b1220;display:none}.preview-statusline.show{display:block}.preview-statusline.err{color:#fca5a5}`;

const previewModalHtml = `<div id="previewBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box preview"><header><h2 id="previewTitle">Preview</h2><button class="modal-close" id="previewCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><div class="preview-toolbar"><span class="pill" id="previewPill"><span class="dot"></span><span id="previewPillLabel">checking…</span></span><span class="subtle" id="previewMeta"></span><span class="spacer"></span><button class="button" id="previewStartBtn" type="button">Start</button><button class="button secondary" id="previewRestartBtn" type="button">Restart</button><button class="button secondary" id="previewStopBtn" type="button">Stop</button><button class="button secondary" id="previewReloadBtn" type="button" title="Reload iframe">↻</button><a class="button secondary" id="previewOpenBtn" target="_blank" rel="noopener" title="Open in new tab">Open ↗</a><button class="button secondary" id="previewLogsBtn" type="button">Logs</button></div><div class="preview-statusline" id="previewStatusline"></div><div class="preview-body"><div class="preview-empty" id="previewEmpty">Preview is not running.</div><iframe id="previewFrame" class="hidden" title="Project preview"></iframe><pre class="preview-logs" id="previewLogs"></pre></div></div></div></div>`;

const previewScript = `<script>(function(){const backdrop=document.getElementById('previewBackdrop');if(!backdrop)return;const title=document.getElementById('previewTitle');const pill=document.getElementById('previewPill');const pillLabel=document.getElementById('previewPillLabel');const meta=document.getElementById('previewMeta');const startBtn=document.getElementById('previewStartBtn');const stopBtn=document.getElementById('previewStopBtn');const restartBtn=document.getElementById('previewRestartBtn');const reloadBtn=document.getElementById('previewReloadBtn');const openBtn=document.getElementById('previewOpenBtn');const logsBtn=document.getElementById('previewLogsBtn');const closeBtn=document.getElementById('previewCloseBtn');const empty=document.getElementById('previewEmpty');const frame=document.getElementById('previewFrame');const logs=document.getElementById('previewLogs');const statusline=document.getElementById('previewStatusline');let project=null;let pollTimer=null;let logsTimer=null;let lastIframeUrl='';let showingLogs=false;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatusLine(t,err){statusline.textContent=t||'';statusline.classList.toggle('show',!!t);statusline.classList.toggle('err',!!err)}function setPill(state,label){pill.classList.remove('running','starting','error');if(state)pill.classList.add(state);pillLabel.textContent=label}function setEmpty(msg){empty.innerHTML='<div>'+msg+'</div>';empty.classList.remove('hidden');frame.classList.add('hidden');if(frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}function loadIframe(url){if(lastIframeUrl===url)return;lastIframeUrl=url;empty.classList.add('hidden');frame.classList.remove('hidden');frame.src=url}async function fetchStatus(){if(!project)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');applyStatus(j)}catch(e){setStatusLine(e.message||String(e),true)}}function applyStatus(s){meta.textContent=s.port?'port '+s.port+(s.pid?' · pid '+s.pid:''):'';if(!s.configured){setPill('error','not configured');setEmpty('Preview is not configured for this project.<br><br>Open <a class="repo" href="/manage">Manage Projects</a> and set a <strong>Preview command</strong>.<br><br>Examples:<code>dotnet watch run --project ProVisionI_Portal/ProVisionI_Portal.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code>');startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;openBtn.removeAttribute('href');return}openBtn.href=s.url||'#';if(s.active&&s.ready){setPill('running','running');setStatusLine('');loadIframe(s.url);startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else if(s.active&&!s.ready){setPill('starting','waiting for port '+s.port);setStatusLine('Server unit is active; waiting for the dev server to bind to 127.0.0.1:'+s.port+'…');setEmpty('Starting… waiting for the framework to bind to port <strong>'+s.port+'</strong>.<br><span class="subtle">First boot of dotnet watch can take 10–30s.</span>');startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else{if(s.result&&s.result!=='success'){const tag=s.result==='exit-code'?('exit code '+(s.exitCode??'?')):s.result;setPill('error','exited ('+tag+')');setStatusLine('');let msg='Preview process exited ('+tag+').';if(s.lastError){msg+='<br><br>Recent log output:<code>'+escHtml(s.lastError)+'</code>'}msg+='<br>Click <strong>Start</strong> to retry:<code>'+escHtml(s.cmd||'')+'</code>';setEmpty(msg)}else{setPill('','stopped');setStatusLine('');setEmpty('Preview is stopped. Click <strong>Start</strong> to launch:<code>'+escHtml(s.cmd||'')+'</code>')}startBtn.disabled=false;stopBtn.disabled=true;restartBtn.disabled=false}}async function action(url){startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;setStatusLine('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');applyStatus(j);if(showingLogs)refreshLogs()}catch(e){setStatusLine(e.message||String(e),true)}}async function refreshLogs(){if(!project||!showingLogs)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/logs?lines=300',{cache:'no-store'});const j=await r.json();if(j.ok){logs.textContent=j.log||'(no log output yet)';logs.scrollTop=logs.scrollHeight}}catch{}}function toggleLogs(){showingLogs=!showingLogs;logs.classList.toggle('show',showingLogs);logsBtn.textContent=showingLogs?'Hide logs':'Logs';if(showingLogs){refreshLogs();logsTimer=setInterval(refreshLogs,3000)}else{clearInterval(logsTimer);logsTimer=null}}function show(name){project=name;title.textContent='Preview — '+name;showingLogs=false;logs.classList.remove('show');logs.textContent='';logsBtn.textContent='Logs';setPill('','checking…');setStatusLine('');setEmpty('Loading…');backdrop.classList.remove('hidden');fetchStatus();pollTimer=setInterval(fetchStatus,2500)}function hide(){backdrop.classList.add('hidden');project=null;if(pollTimer){clearInterval(pollTimer);pollTimer=null}if(logsTimer){clearInterval(logsTimer);logsTimer=null}if(frame.src&&frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}startBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/start');stopBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/stop');restartBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/restart');reloadBtn.onclick=()=>{if(frame.src&&frame.src!=='about:blank'){const u=frame.src;frame.src='about:blank';setTimeout(()=>{lastIframeUrl='';loadIframe(u)},50)}};logsBtn.onclick=toggleLogs;closeBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});window.pwPreview={open:show,close:hide};document.addEventListener('click',e=>{const btn=e.target.closest('[data-preview]');if(!btn)return;e.preventDefault();show(btn.dataset.preview)})})();</script>`;


// ============================================================================
// Cockpit UI (2026-07 redesign): design tokens, force-motion standard, and the
// right-edge project rail with piano-key done-lighting. The rail consumes
// GET /api/projects/status (pending = Stop-hook marker OR live tmux bell) and
// lights a key amber until that project is viewed. See standards/force-motion/
// on branch chore/force-motion-standard for the canonical motion snippet.
// ============================================================================
const forceMotionScript = `<script>/* pw-force-motion — Project Workbench standard: show animations regardless of the OS "reduce motion" setting (spuriously ON for RDP sessions, most VMs, "best performance" Windows). Keep FIRST in <head>. */
(function () {
  "use strict";
  try {
    var native = window.matchMedia;
    if (native) {
      native = native.bind(window);
      var fake = function (q) {
        return {
          media: q, matches: /no-preference/i.test(q), onchange: null,
          addListener: function () {}, removeListener: function () {},
          addEventListener: function () {}, removeEventListener: function () {},
          dispatchEvent: function () { return false; }
        };
      };
      window.matchMedia = function (q) {
        return (typeof q === "string" && /prefers-reduced-motion/i.test(q)) ? fake(q) : native(q);
      };
    }
  } catch (e) {}
  function walk(sheet) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; }
    if (!rules) return;
    for (var i = rules.length - 1; i >= 0; i--) {
      var r = rules[i], cond = (r && (r.conditionText || (r.media && r.media.mediaText))) || "";
      if (r && r.type === 4 && /prefers-reduced-motion\\s*:\\s*reduce/i.test(cond)) {
        try { sheet.deleteRule(i); } catch (e) {}
      } else if (r && r.styleSheet) {
        walk(r.styleSheet);
      }
    }
  }
  function run() { var s = document.styleSheets; for (var i = 0; i < s.length; i++) walk(s[i]); }
  run();
  document.addEventListener("DOMContentLoaded", run);
  window.addEventListener("load", run);
})();
</script>`;

function projHue(name){ let h = 5381; const s = String(name); for(let i=0;i<s.length;i++) h = ((h<<5)+h+s.charCodeAt(i))|0; return ((h%360)+360)%360; }
function projMonogram(name){
 const parts = String(name).replace(/[_\-.]+/g,' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/\s+/).filter(Boolean);
 if(parts.length >= 2) return (parts[0][0]+parts[1][0]).toUpperCase();
 return (parts[0]||'?').slice(0,2).toUpperCase();
}

const designTokensCss = `:root{--bg:#05080f;--bg2:#0a101d;--panel:#0c1424;--panel2:#101a2e;--line:#1b2740;--line2:#2b3d61;--text:#e7eef9;--dim:#8ea3c0;--faint:#5b6d89;--cyan:#38bdf8;--blue:#2563eb;--amber:#fbbf24;--amber2:#f59e0b;--ok:#34d399;--err:#f87171;--topbar-h:42px;--rail-w:58px;--rail-wo:246px;--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace}
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.16s}\n@keyframes pwPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}`;
const cockpitCss = `html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font)}
#shell{display:flex;width:100%;height:100%}
#stage{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;position:relative;background:#1f1f1f}
iframe#term{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;background:#1f1f1f}
#topBar{flex:0 0 var(--topbar-h);height:var(--topbar-h);display:flex;align-items:center;gap:10px;padding:0 10px 0 12px;box-sizing:border-box;background:linear-gradient(180deg,rgba(13,21,38,.97),rgba(9,15,28,.92));border-bottom:1px solid var(--line);box-shadow:0 6px 18px -8px rgba(0,0,0,.8);position:relative;z-index:12;font:13px var(--font);color:var(--dim)}
.tbActions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.tabScroller{flex:1 1 auto;display:flex;align-items:center;gap:4px;min-width:0}
.tabArrow{flex:0 0 auto;display:none;align-items:center;justify-content:center;width:22px;height:26px;padding:0;background:#0d1526;border:1px solid var(--line);border-radius:7px;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;user-select:none}
.tabArrow:hover{background:var(--panel2);color:#fff;border-color:var(--line2)}
.tabArrow:disabled{opacity:.3;cursor:default}
.tabScroller.overflow .tabArrow{display:inline-flex}
.tabStrip{flex:1 1 auto;display:flex;align-items:center;gap:5px;overflow-x:auto;min-width:0;padding:0 4px;scrollbar-width:none;scroll-behavior:smooth}
.tabStrip::-webkit-scrollbar{display:none}
.tabStrip .tab{display:inline-flex;align-items:center;gap:5px;background:#0b1322;border:1px solid var(--line);border-radius:8px;padding:4px 9px;color:var(--dim);cursor:pointer;font-size:12px;line-height:1.4;white-space:nowrap;user-select:none;max-width:190px;flex:0 0 auto;transition:background .15s,border-color .15s,color .15s}
.tabStrip .tab:hover{background:var(--panel2);color:#fff;border-color:var(--line2)}
.tabStrip .tab.active{background:linear-gradient(180deg,#12233f,#0e1a30);border-color:#2f65b0;color:#fff;box-shadow:inset 0 0 0 1px rgba(56,189,248,.15),0 0 12px -4px rgba(56,189,248,.5)}
.tabStrip .tab.attention{border-color:var(--amber2);color:#ffe9b8;animation:pwTabPulse 1.5s ease-in-out infinite}
.tabStrip .tab.attention:hover{color:#fff;border-color:var(--amber)}
@keyframes pwTabPulse{0%,100%{background:#221703;box-shadow:0 0 4px rgba(245,158,11,.25)}50%{background:#3a2705;box-shadow:0 0 14px rgba(251,191,36,.4);border-color:var(--amber)}}
.tabStrip .tab .name{overflow:hidden;text-overflow:ellipsis;max-width:140px;cursor:pointer}
.tabStrip .tab.active .name{cursor:text}
.tabStrip .tab .name.editing{outline:1px solid var(--cyan);background:#0a1120;border-radius:3px;padding:0 4px;max-width:none;cursor:text}
.tabStrip .tab .x{opacity:.5;font-size:14px;line-height:1;padding:0 3px;border-radius:3px}
.tabStrip .tab .x:hover{opacity:1;color:var(--err);background:#0a1120}
.tabStrip .newTab{background:transparent;border:1px dashed #33507e;color:var(--faint);cursor:pointer;padding:2px 9px;border-radius:8px;font-size:14px;line-height:1.3;flex:0 0 auto;transition:.15s}
.tabStrip .newTab:hover{color:var(--cyan);border-color:var(--cyan)}
.previewBtn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid var(--line);color:#bcd7f5;border-radius:999px;padding:4px 12px;cursor:pointer;font:600 12px var(--font);letter-spacing:.02em;transition:.15s}
.previewBtn:hover{background:var(--panel2);color:#fff;border-color:var(--line2)}
.pbDot{width:6px;height:6px;border-radius:50%;background:var(--faint)}
#fileBtn{display:inline-flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);border-radius:999px;color:#bcd7f5;font:600 12px var(--font);cursor:pointer;padding:4px 12px;transition:.15s}
#fileBtn:hover{background:var(--panel2);color:#fff;border-color:var(--line2)}
#fileBtn::before{content:'⬇';font-size:11px}
body.shade-open #fileBtn::before{content:'⬆'}
.railBtn{display:none;place-items:center;width:32px;height:32px;background:#0d1526;border:1px solid var(--line);border-radius:8px;color:var(--dim);cursor:pointer;font-size:14px}
#trayShield{position:absolute;left:0;right:0;top:var(--topbar-h);bottom:0;background:transparent;z-index:9;display:none;cursor:pointer}
body.shade-open #trayShield{display:block}
#tray{position:absolute;left:0;right:0;top:var(--topbar-h);z-index:10;background:rgba(10,17,30,.97);backdrop-filter:blur(10px);color:var(--text);border-bottom:1px solid var(--line2);box-shadow:0 24px 48px -12px rgba(0,0,0,.85);padding:14px 18px 16px;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"header header" "list dropzone" "status status";gap:12px;align-items:stretch;max-height:calc(100vh - var(--topbar-h) - 16px);overflow:auto;transform:translateY(-102%);opacity:0;pointer-events:none;transition:transform .3s cubic-bezier(.32,.72,.24,1),opacity .2s ease;will-change:transform,opacity;font:13px var(--font)}
#inboxHeader{grid-area:header}#inboxList{grid-area:list}#drop,#preview{grid-area:dropzone}#status{grid-area:status}
body.has-preview #drop{display:none}body:not(.has-preview) #preview{display:none}
body.shade-open #tray{transform:translateY(0);opacity:1;pointer-events:auto}
#drop{border:2px dashed #33507e;border-radius:14px;padding:30px 18px;text-align:center;background:var(--panel);outline:none;cursor:pointer;min-height:130px;display:flex;flex-direction:column;justify-content:center;width:100%;box-sizing:border-box;color:var(--dim);transition:border-color .15s,background .15s}
#drop:hover{border-color:var(--cyan);background:var(--panel2)}
#drop .dropHint{color:var(--faint);margin-top:6px;font-size:12px}
#status{white-space:pre-wrap;color:var(--faint);font-size:13px;line-height:1.35}
button,label{font:inherit}
.close{display:none}
code{color:#9fd3ff;word-break:break-all;font-family:var(--mono)}
#tray img{max-width:100%;max-height:380px;border-radius:8px;margin-top:0;border:1px solid var(--line2);display:block}
.previewItem{position:relative;display:inline-block;max-width:100%}
.previewItem a{display:block}
.previewClear{position:absolute;top:6px;right:6px;background:rgba(10,17,30,.92);border:1px solid var(--line2);color:#fca5a5;border-radius:50%;width:26px;height:26px;line-height:22px;text-align:center;font-size:16px;cursor:pointer;padding:0;font-family:inherit}
.previewClear:hover{background:#0a1120;color:#fff;border-color:var(--dim)}
.inboxHeader{display:flex;justify-content:space-between;align-items:center;color:var(--dim);font-size:12px;letter-spacing:.02em;margin-top:2px;min-height:22px}
.inboxHeader .clear{font-size:12px;color:#fca5a5;background:transparent;border:1px solid #3d4f6e;border-radius:7px;padding:3px 9px;cursor:pointer}
.inboxHeader .clear:hover{background:var(--panel2);color:#fff;border-color:var(--dim)}
.inboxList{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;border-top:1px solid var(--line);padding-top:6px;margin:0;scrollbar-width:thin}
.inboxList::-webkit-scrollbar{width:6px}
.inboxList::-webkit-scrollbar-thumb{background:var(--line2);border-radius:3px}
.inboxList .row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:7px;cursor:pointer;background:var(--panel);border:1px solid transparent}
.inboxList .row:hover{background:var(--panel2);border-color:var(--line2)}
.inboxList .thumb{width:36px;height:36px;background:#16223a;border-radius:5px;display:flex;align-items:center;justify-content:center;flex:0 0 36px;overflow:hidden;color:var(--faint);font-size:11px;font-weight:600}
.inboxList .thumb img{width:100%;height:100%;object-fit:cover;border-radius:5px;border:0;margin:0;max-height:none}
.inboxList .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}
.inboxList .nameCol .name{font-size:12px;color:var(--text);text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
.inboxList .nameCol .meta{font-size:11px;color:var(--faint)}
.inboxList .del{flex:0 0 auto;color:#fca5a5;background:transparent;border:0;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px;font-family:inherit}
.inboxList .del:hover{background:var(--panel2);color:#fff}
#pwHoverPreview{position:fixed;z-index:9999;pointer-events:none;background:#0d1526;border:1px solid var(--line2);border-radius:9px;padding:6px;box-shadow:0 14px 36px rgba(0,0,0,.75);display:none;max-width:440px}
#pwHoverPreview img{display:block;max-width:420px;max-height:420px;border-radius:5px;border:0;margin:0}
#pwHoverPreview .card{padding:14px;color:var(--dim);font:13px var(--font);max-width:320px;word-break:break-all;line-height:1.45}
#pwHoverPreview .card .meta{margin-top:6px;color:var(--faint);font-size:11px}
.tabMenu{position:fixed;z-index:9999;background:#0d1526;border:1px solid var(--line2);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.7);padding:.35rem;min-width:220px;max-width:380px;display:flex;flex-direction:column;gap:2px;font:13px var(--font)}
.tabMenuItem{background:transparent;border:0;color:var(--text);text-align:left;padding:.45rem .6rem;border-radius:7px;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:2px}
.tabMenuItem:hover{background:var(--panel2)}
.tabMenuItem .ti-name{font-weight:600;color:#f4f8ff}
.tabMenuItem .ti-cmd{color:var(--faint);font:11px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
.tabMenuItem.blank{border-top:1px solid var(--line);margin-top:2px;padding-top:.5rem;color:var(--dim)}
.tabMenuItem.empty{color:var(--faint);font-style:italic;cursor:default}
.tabMenuItem.empty:hover{background:transparent}
#rail{order:-1;flex:0 0 var(--rail-w);width:var(--rail-w);position:relative;z-index:14;transition:width .32s cubic-bezier(.32,.72,.24,1),flex-basis .32s cubic-bezier(.32,.72,.24,1)}
body.rail-open #rail{flex-basis:var(--rail-wo);width:var(--rail-wo)}
#railPanel{position:absolute;top:0;left:0;bottom:0;width:var(--rail-w);display:flex;flex-direction:column;background:linear-gradient(180deg,#0a1120,#070c16 55%,#0a1120);border-right:1px solid var(--line);overflow:hidden;container-type:inline-size;transition:width .26s cubic-bezier(.32,.72,.24,1),box-shadow .26s ease,border-color .26s ease}
body.rail-open #railPanel{width:var(--rail-wo)}
#railPanel::before{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 40% at 0% 0%,rgba(56,189,248,.05),transparent 60%)}
@media(min-width:641px){body:not(.rail-open) #rail:hover #railPanel,body:not(.rail-open) #rail:focus-within #railPanel{width:var(--rail-wo);box-shadow:26px 0 60px -18px rgba(0,0,0,.85);border-right-color:var(--line2);transition-delay:.14s}}
.railHead{flex:0 0 var(--topbar-h);height:var(--topbar-h);border-bottom:1px solid var(--line);box-sizing:border-box;display:flex;align-items:stretch}
#railToggle{flex:1 1 auto;display:flex;align-items:center;gap:9px;background:transparent;border:0;padding:0 14px;cursor:pointer;color:var(--dim);min-width:0}
#railToggle:hover{background:rgba(255,255,255,.03);color:#fff}
#railToggle:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
#railToggle .brandGlyph{display:inline-grid;place-items:center;width:28px;height:28px;flex:0 0 28px;border-radius:8px;background:linear-gradient(135deg,var(--cyan),var(--blue));color:#04101f;font:900 10px/1 var(--mono);letter-spacing:0;margin-left:1px;box-shadow:0 4px 14px -4px rgba(56,189,248,.55)}
.railBrandName{flex:1 1 auto;text-align:left;font-size:11.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#dbe9fb;white-space:nowrap;opacity:0;transform:translateX(-8px);transition:opacity .2s .05s,transform .2s .05s}
#railToggle .chev{display:inline-block;color:var(--faint);font-size:16px;line-height:1;opacity:0;transition:transform .3s cubic-bezier(.32,.72,.24,1),opacity .2s}
body.rail-open #railToggle .chev{transform:rotate(180deg)}
.railKeys{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:10px 8px 10px 0;display:flex;flex-direction:column;gap:7px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.pkey{position:relative;display:flex;align-items:center;gap:9px;height:46px;flex:0 0 46px;padding:0 10px 0 12px;border:1px solid var(--line);border-left:0;border-radius:0 11px 11px 0;background:linear-gradient(180deg,var(--panel),#0a1120);color:var(--dim);text-decoration:none;box-sizing:border-box;transition:transform .18s cubic-bezier(.34,1.4,.44,1),background .18s,border-color .18s,box-shadow .18s,color .18s;animation:pkIn .5s cubic-bezier(.22,.9,.3,1) both;animation-delay:calc(var(--i)*38ms)}
@keyframes pkIn{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
.pkey:hover{transform:translateX(4px);color:#fff;border-color:var(--line2);background:linear-gradient(180deg,var(--panel2),#0c1424)}
.pkey:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
.pk-edge{position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:hsl(var(--h) 50% 34% / .85);transition:background .2s,box-shadow .2s}
.pkey.current{border-color:#2f65b0;background:linear-gradient(180deg,#10233f,#0b1830);color:#eaf4ff;box-shadow:inset 0 0 0 1px rgba(56,189,248,.13),0 0 18px -6px rgba(56,189,248,.5)}
.pkey.current .pk-edge{background:linear-gradient(180deg,var(--cyan),var(--blue));box-shadow:0 0 10px rgba(56,189,248,.67)}
.pk-mono{display:inline-grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:9px;font:700 12px/1 var(--mono);background:hsl(var(--h) 55% 15%);color:hsl(var(--h) 88% 70%);border:1px solid hsl(var(--h) 55% 28%);transition:border-color .2s,color .2s,background .2s,box-shadow .2s;text-transform:uppercase}
.pk-meta{display:flex;flex-direction:column;gap:2px;min-width:0;opacity:0;transform:translateX(-10px);transition:opacity .22s .06s,transform .22s .06s}
.pk-name{font-size:12.5px;font-weight:650;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.pk-sub{font-size:10.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.pkey.lit .pk-sub{color:#ffd98a}
.pk-dot{position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:#334155;opacity:0;transition:opacity .2s}
.pkey.lit{border-color:#a16207;background:linear-gradient(180deg,#221a06,#140f03);color:#ffe9b8}
.pkey.lit .pk-edge{background:linear-gradient(180deg,var(--amber),var(--amber2));box-shadow:0 0 12px rgba(251,191,36,.8);animation:pkGlow 1.8s ease-in-out infinite}
.pkey.lit .pk-mono{border-color:#b45309;color:#ffd98a;background:#271c04;box-shadow:0 0 14px -2px rgba(245,158,11,.35)}
.pkey.lit .pk-dot{opacity:1;background:var(--amber);box-shadow:0 0 8px var(--amber);animation:pkGlow 1.8s ease-in-out infinite}
@keyframes pkGlow{0%,100%{opacity:.6}50%{opacity:1}}
.pkey.struck{animation:pkStrike .85s cubic-bezier(.2,.8,.3,1)}
@keyframes pkStrike{0%{transform:translateX(0)}18%{transform:translateX(9px);box-shadow:0 0 0 1px var(--amber),0 0 34px rgba(251,191,36,.85);background:#3a2b07}60%{transform:translateX(2px)}100%{transform:none}}
.railFoot{flex:0 0 auto;border-top:1px solid var(--line);padding:8px;display:flex;flex-direction:column;gap:4px}
.railAct{display:flex;align-items:center;gap:9px;height:34px;padding:0 4px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dim);text-decoration:none;cursor:pointer;font:600 12px var(--font);white-space:nowrap;box-sizing:border-box;width:100%;text-align:left}
.railAct:hover{background:var(--panel2);color:#fff;border-color:var(--line)}
.railActIco{display:inline-grid;place-items:center;width:26px;height:26px;flex:0 0 26px;font-size:13px}
.railActLabel{opacity:0;transform:translateX(-8px);transition:opacity .22s,transform .22s}
.railWho{display:flex;align-items:center;gap:2px;padding:4px 4px 2px;color:var(--faint);font-size:11.5px;min-width:0}
.railWhoDot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px rgba(52,211,153,.5);margin:0 9px}
.railWhoName{opacity:0;transition:opacity .22s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container (min-width:180px){.railBrandName{opacity:1;transform:none}#railToggle .chev{opacity:1}.pk-meta{opacity:1;transform:none}.railActLabel{opacity:1;transform:none}.railWhoName{opacity:1}}
#railScrim{display:none}
@media(max-width:640px){
#rail{position:fixed;top:0;left:0;bottom:0;z-index:60;transform:translateX(-100%);transition:transform .3s cubic-bezier(.32,.72,.24,1);width:var(--rail-wo);flex-basis:var(--rail-wo)}
body.rail-mobile-open #rail{transform:none}
#railPanel{width:var(--rail-wo);border-right:1px solid var(--line2);box-shadow:26px 0 60px rgba(0,0,0,.75)}
#railScrim{display:block;position:fixed;inset:0;background:rgba(2,6,14,.6);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .25s;z-index:55}
body.rail-mobile-open #railScrim{opacity:1;pointer-events:auto}
.railBtn{display:inline-grid}
#topBar{padding:0 8px;gap:6px}
.tabStrip{padding:0 4px;gap:3px}
.tabStrip .tab{max-width:140px;padding:2px 6px}
.tabStrip .tab .name{max-width:100px}
.tabStrip .newTab{padding:1px 7px;font-size:13px}
.previewBtn{padding:3px 9px;font-size:11px}
#fileBtn{padding:3px 9px;font-size:11px}
#fileBtn::before{content:'⬇'}
.fileInfo{display:none}
#tray{grid-template-columns:1fr;grid-template-areas:"header" "dropzone" "list" "status"}
}`;

function railHtml(projects, currentName, user){
 const isAdmin = user.role === 'admin';
 const keys = projects.map((p,i)=>{
  const cur = p.name === currentName;
  return `<a class="pkey${cur?' current':''}" href="/term/${encodeURIComponent(p.name)}/" data-project="${esc(p.name)}" style="--h:${projHue(p.name)};--i:${i}"${cur?' aria-current="page"':''}><span class="pk-edge"></span><span class="pk-mono">${esc(projMonogram(p.name))}</span><span class="pk-meta"><span class="pk-name">${esc(p.name)}</span><span class="pk-sub">${cur?'active session':''}</span></span><span class="pk-dot" aria-hidden="true"></span></a>`;
 }).join('');
 const adminActs = isAdmin
  ? `<a class="railAct" id="manageEntry" href="/manage" title="Manage projects"><span class="railActIco">✎</span><span class="railActLabel">Manage projects</span></a><a class="railAct" href="/settings" title="Settings"><span class="railActIco">⚙</span><span class="railActLabel">Settings</span></a>`
  : '';
 const who = user.implicit
  ? `<span class="railWho" title="PW_AUTH_ENFORCE off — anonymous admin"><span class="railWhoDot"></span><span class="railWhoName">anonymous</span></span>`
  : `<span class="railWho" title="${esc(user.username)} · ${esc(user.role)}"><span class="railWhoDot"></span><span class="railWhoName">${esc(user.username)} · ${esc(user.role)}</span></span><button id="railLogout" class="railAct" type="button" title="Sign out"><span class="railActIco">↪</span><span class="railActLabel">Sign out</span></button>`;
 return `<aside id="rail" aria-label="Projects"><div id="railPanel"><div class="railHead"><button id="railToggle" type="button" aria-expanded="false" title="Pin the project rail open"><span class="brandGlyph" aria-hidden="true">&gt;_</span><span class="railBrandName">Workbench</span><span class="chev" aria-hidden="true">›</span></button></div><nav id="railKeys" class="railKeys">${keys}</nav><div class="railFoot">${adminActs}${who}</div></div></aside><div id="railScrim" aria-hidden="true"></div>`;
}

const railScript = `<script>(function(){
const rail=document.getElementById('rail');if(!rail)return;
const KEYS=document.getElementById('railKeys');
const toggle=document.getElementById('railToggle');
const railBtn=document.getElementById('railBtn');
const scrim=document.getElementById('railScrim');
const CUR=(typeof project!=='undefined')?project:null;
function isMobile(){return window.matchMedia('(max-width:640px)').matches}
function setOpen(open,persist){document.body.classList.toggle('rail-open',open);toggle.setAttribute('aria-expanded',open?'true':'false');toggle.title=open?'Unpin the project rail':'Pin the project rail open';if(persist){try{localStorage.setItem('pwRailOpen',open?'1':'0')}catch{}}}
let saved='0';try{saved=localStorage.getItem('pwRailOpen')||'0'}catch{}
setOpen(saved==='1'&&!isMobile(),false);
toggle.onclick=()=>setOpen(!document.body.classList.contains('rail-open'),!isMobile());
function setMobileOpen(on){document.body.classList.toggle('rail-mobile-open',on);if(on){document.body.classList.add('rail-open');toggle.setAttribute('aria-expanded','true')}else{let keep='0';try{keep=localStorage.getItem('pwRailOpen')||'0'}catch{}if(keep!=='1'){document.body.classList.remove('rail-open');toggle.setAttribute('aria-expanded','false')}}}
if(railBtn)railBtn.onclick=()=>setMobileOpen(!document.body.classList.contains('rail-mobile-open'));
if(scrim)scrim.onclick=()=>setMobileOpen(false);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('rail-mobile-open'))setMobileOpen(false)});
const logout=document.getElementById('railLogout');
if(logout)logout.onclick=async()=>{try{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'}})}catch{}location.href='/login'};
const baseTitle=(CUR?CUR+' — ':'')+'Workbench';
document.title=baseTitle;
let first=true;
async function refreshRail(){try{
const r=await fetch('/api/projects/status',{cache:'no-store'});const j=await r.json();if(!j||!j.ok)return;
let anyLit=false;
for(const p of (j.projects||[])){
const key=KEYS.querySelector('[data-project="'+p.name+'"]');if(!key)continue;
const lit=!!p.pending&&p.name!==CUR;if(lit)anyLit=true;
const was=key.classList.contains('lit');
key.classList.toggle('lit',lit);
const sub=key.querySelector('.pk-sub');
if(sub)sub.textContent=(p.name===CUR)?'active session':(lit?'finished — click to view':'');
if(lit&&!was&&!first){key.classList.add('struck');key.addEventListener('animationend',()=>key.classList.remove('struck'),{once:true})}
}
document.title=(anyLit?'● ':'')+baseTitle;
first=false;
}catch{}}
window.__pwRailRefresh=refreshRail;
refreshRail();setInterval(()=>{if(!document.hidden)refreshRail()},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshRail()});
})();</script>`;


// ============================================================================
// Manage Projects modal (admin-only, lives on the cockpit). Project list +
// tabbed editor (General / Preview / Terminal tabs / Danger). Talks to the
// existing /manage/* endpoints (now JSON-aware) and /api/projects/config.
// Drag the list to reorder (rail order = projects.json order).
// ============================================================================
const manageModalHtml = `<style>
.modal-box.pm{max-width:1060px;height:min(86vh,760px)}
.pm .pmHint{color:var(--faint);font-size:12px;font-weight:400;margin-left:10px}
.pm .body{padding:0;display:flex;min-height:0}
.pmBody{display:grid;grid-template-columns:252px minmax(0,1fr);width:100%;min-height:0}
.pmListWrap{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;background:#0a1120}
.pmAdd{margin:10px;display:flex;align-items:center;gap:8px;background:transparent;border:1px dashed #33507e;border-radius:10px;color:var(--dim);padding:9px 11px;cursor:pointer;font:600 12.5px var(--font);transition:.15s}
.pmAdd:hover{color:var(--cyan);border-color:var(--cyan)}
.pmAdd.sel{color:var(--cyan);border-color:var(--cyan);background:rgba(56,189,248,.06)}
.pmItems{flex:1 1 auto;overflow-y:auto;padding:0 10px 10px;display:flex;flex-direction:column;gap:5px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.pmItem{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--dim);cursor:pointer;user-select:none;transition:border-color .15s,background .15s,transform .15s}
.pmItem:hover{background:var(--panel2);border-color:var(--line2);color:#fff}
.pmItem.sel{border-color:#2f65b0;background:linear-gradient(180deg,#10233f,#0b1830);color:#eaf4ff}
.pmItem.dragging{opacity:.45}
.pmDrag{color:#3d5170;font-size:14px;cursor:grab;flex:0 0 auto;letter-spacing:-2px}
.pmItem .pmMono{display:inline-grid;place-items:center;width:26px;height:26px;flex:0 0 26px;border-radius:8px;font:700 10.5px/1 var(--mono);background:hsl(var(--h) 55% 15%);color:hsl(var(--h) 88% 70%);border:1px solid hsl(var(--h) 55% 28%);text-transform:uppercase}
.pmItem .pmIname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}
.pmItem .pmPort{color:var(--faint);font:10.5px var(--mono)}
.pmDetail{display:flex;flex-direction:column;min-width:0;min-height:0}
.pmTabs{display:flex;gap:6px;padding:12px 16px 0;border-bottom:1px solid var(--line);flex:0 0 auto}
.pmTabs button{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dim);padding:8px 12px 10px;font:600 12.5px var(--font);cursor:pointer;border-radius:8px 8px 0 0;transition:.15s}
.pmTabs button:hover{color:#fff;background:rgba(255,255,255,.03)}
.pmTabs button.active{color:var(--cyan);border-bottom-color:var(--cyan)}
.pmTabs button.dangerTab.active{color:var(--err);border-bottom-color:var(--err)}
.pmPanes{flex:1 1 auto;overflow-y:auto;padding:18px 20px 20px;min-height:0;scrollbar-width:thin}
.pmPane{display:none;flex-direction:column;gap:14px;max-width:640px}
.pmPane.active{display:flex}
.pmField{display:flex;flex-direction:column;gap:5px}
.pmField>span{font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.pmField input,.pmField textarea{background:#070d19;color:var(--text);border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:13px var(--font);box-sizing:border-box;width:100%;transition:border-color .15s}
.pmField textarea{font:12px/1.5 var(--mono);resize:vertical}
.pmField input:focus,.pmField textarea:focus{outline:none;border-color:var(--cyan)}
.pmField .pmHelp{font-size:11.5px;color:var(--faint);line-height:1.5;text-transform:none;letter-spacing:0;font-weight:400}
.pmField .pmHelp code{font-family:var(--mono);color:#9fd3ff;font-size:11px}
.pmRow2{display:grid;grid-template-columns:2fr 1fr;gap:12px}
.pmCallout{border:1px solid #4a3a10;background:#1a1404;color:#fde68a;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5}
.pmCallout.red{border-color:#5b1a1a;background:#180808;color:#fecaca}
.pmExamples{border:1px solid var(--line);border-radius:10px;background:#0a1120}
.pmExamples summary{cursor:pointer;padding:9px 12px;font-size:12px;color:var(--dim);user-select:none}
.pmExamples div{padding:2px 12px 10px;display:flex;flex-direction:column;gap:6px}
.pmExamples code{display:block;background:#070d19;border:1px solid var(--line);border-radius:7px;padding:7px 9px;font:11px/1.5 var(--mono);color:#9fd3ff;white-space:pre-wrap;word-break:break-all;cursor:pointer}
.pmExamples code:hover{border-color:var(--line2)}
.pmTabRows{display:flex;flex-direction:column;gap:7px}
.pmTabRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.7fr) auto auto;gap:7px;align-items:center}
.pmTabRow input[type=text]{padding:7px 9px;font:12px var(--mono)}
.pmTabRow label{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dim);white-space:nowrap;margin:0}
.pmTabRow label input{width:auto;accent-color:var(--cyan)}
.pmTabRow .rm{background:transparent;border:1px solid #3d4f6e;color:#fca5a5;border-radius:7px;padding:4px 9px;cursor:pointer;line-height:1;font-size:13px}
.pmTabRow .rm:hover{background:var(--panel2);color:#fff}
.pmAddTab{align-self:flex-start;background:transparent;border:1px dashed #33507e;color:var(--dim);border-radius:9px;padding:6px 12px;cursor:pointer;font:600 12px var(--font)}
.pmAddTab:hover{color:var(--cyan);border-color:var(--cyan)}
.pmDelArm{display:flex;gap:9px;align-items:center}
.pmDelArm input{flex:1 1 auto}
.pmDelBtn{background:#7f1d1d;border:0;color:#fff;border-radius:9px;padding:9px 14px;font:600 12.5px var(--font);cursor:pointer;white-space:nowrap}
.pmDelBtn:disabled{opacity:.4;cursor:not-allowed}
.pmDelBtn:not(:disabled):hover{background:#991b1b}
.pm footer{display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid var(--line)}
#pmStatus{flex:1 1 auto;font-size:12.5px;color:var(--ok);min-height:1.2em;white-space:pre-wrap}
#pmStatus.err{color:var(--err)}
#pmSave{background:linear-gradient(135deg,var(--cyan),var(--blue));border:0;color:#04101f;border-radius:10px;padding:10px 18px;font:700 13px var(--font);cursor:pointer;transition:filter .15s}
#pmSave:hover{filter:brightness(1.12)}
#pmSave:disabled{opacity:.5;cursor:not-allowed;filter:none}
.pmEmptyDetail{margin:auto;color:var(--faint);font-size:13px;text-align:center;padding:40px}
@media(max-width:760px){.pmBody{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.pmListWrap{border-right:0;border-bottom:1px solid var(--line);max-height:200px}.modal-box.pm{height:94vh}}
</style>
<div id="pmBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-label="Manage projects"><div class="modal-box pm"><header><h2>Projects<span class="pmHint">drag to reorder — the rail follows this order</span></h2><button class="modal-close" id="pmClose" aria-label="Close" type="button">×</button></header><div class="body"><div class="pmBody"><div class="pmListWrap"><button class="pmAdd" id="pmAddBtn" type="button">+ New project</button><div class="pmItems" id="pmItems"></div></div><div class="pmDetail" id="pmDetail"><div class="pmTabs" id="pmTabs" role="tablist"><button type="button" data-t="general" class="active">General</button><button type="button" data-t="preview">Preview</button><button type="button" data-t="tabs">Terminal tabs</button><button type="button" data-t="danger" class="dangerTab">Danger</button></div><div class="pmPanes">
<section class="pmPane active" data-p="general"><div class="pmField"><span>Name</span><input id="pmName" type="text" pattern="[A-Za-z0-9._-]+" maxlength="120" autocomplete="off"><span class="pmHelp">Letters, digits, dot, dash, underscore. Renaming moves the workspace folder.</span></div><div class="pmField"><span>Repo URL <em style="text-transform:none;font-style:normal;font-weight:400">(optional)</em></span><input id="pmRepo" type="text" placeholder="https://github.com/owner/Repo.git — blank = local-only workspace" autocomplete="off"></div><div class="pmRow2"><div class="pmField"><span>Terminal port</span><input id="pmPort" type="number" min="1024" max="65535"></div><div class="pmField"><span>Workspace</span><span class="pmHelp" id="pmPath" style="padding-top:9px;word-break:break-all"></span></div></div><div class="pmCallout" id="pmRestartNote">Saving restarts this project's terminal service — running processes in its tabs are killed.</div></section>
<section class="pmPane" data-p="preview"><div class="pmField"><span>Preview command</span><textarea id="pmPrevCmd" rows="3" placeholder="empty = preview disabled"></textarea><span class="pmHelp">Runs inside the workspace. Use <code>\${PORT}</code> and <code>\${BASEPATH}</code>; the app must bind <code>127.0.0.1:\${PORT}</code>.</span></div><details class="pmExamples"><summary>Examples — click one to use it</summary><div><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>dotnet watch run --project Foo/Foo.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code><code>python3 -m http.server \${PORT} --bind 127.0.0.1</code></div></details><div class="pmRow2"><div class="pmField"><span>Preview port</span><input id="pmPrevPort" type="number" min="1024" max="65535" placeholder="auto"></div><div></div></div><div class="pmField"><span>Environment</span><textarea id="pmPrevEnv" rows="4" placeholder="# one KEY=VALUE per line&#10;# ASPNETCORE_ENVIRONMENT=Development"></textarea><span class="pmHelp">Exported before the command runs. <code>PORT</code> and <code>BASEPATH</code> are reserved.</span></div></section>
<section class="pmPane" data-p="tabs"><div class="pmField"><span>Tab templates</span><span class="pmHelp">Named tabs offered in the terminal's <b>+</b> menu. <b>auto-start</b> spawns the tab when the project's tmux session is first created. Empty command = plain bash.</span></div><div class="pmTabRows" id="pmTabRows"></div><button class="pmAddTab" id="pmAddTabBtn" type="button">+ Add tab template</button></section>
<section class="pmPane" data-p="danger"><div class="pmCallout red"><b>Delete project</b> — stops its terminal service, kills its tmux session, removes it from the registry <b>and deletes the workspace folder</b> shown in General. Repos without a remote copy are gone for good.</div><div class="pmDelArm"><input id="pmDelName" type="text" placeholder="type the project name to arm" autocomplete="off"><button class="pmDelBtn" id="pmDelBtn" type="button" disabled>Delete project</button></div></section>
</div></div></div></div><footer><span id="pmStatus"></span><button id="pmSave" type="button">Save changes</button></footer></div></div>`;

const manageModalScript = `<script>(function(){
const backdrop=document.getElementById('pmBackdrop');if(!backdrop)return;
const items=document.getElementById('pmItems'),addBtn=document.getElementById('pmAddBtn'),tabsBar=document.getElementById('pmTabs'),panes=[...document.querySelectorAll('.pmPane')],saveBtn=document.getElementById('pmSave'),statusEl=document.getElementById('pmStatus'),closeBtn=document.getElementById('pmClose');
const fName=document.getElementById('pmName'),fRepo=document.getElementById('pmRepo'),fPort=document.getElementById('pmPort'),fPath=document.getElementById('pmPath'),fPrevCmd=document.getElementById('pmPrevCmd'),fPrevPort=document.getElementById('pmPrevPort'),fPrevEnv=document.getElementById('pmPrevEnv'),tabRows=document.getElementById('pmTabRows'),addTabBtn=document.getElementById('pmAddTabBtn'),delName=document.getElementById('pmDelName'),delBtn=document.getElementById('pmDelBtn'),restartNote=document.getElementById('pmRestartNote');
const CUR=(typeof project!=='undefined')?project:null;
let cfg=null,sel=null,mode='edit',formDirty=false,reloadOnClose=false,navTarget=null,busy=false,curNow=CUR;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function hue(name){let h=5381;const s=String(name);for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return((h%360)+360)%360}
function mono(name){const p=String(name).replace(/[_\\-.]+/g,' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/\\s+/).filter(Boolean);if(p.length>=2)return(p[0][0]+p[1][0]).toUpperCase();return(p[0]||'?').slice(0,2).toUpperCase()}
function setStatus(t,err){statusEl.textContent=t||'';statusEl.classList.toggle('err',!!err)}
function markDirty(){formDirty=true}
[fName,fRepo,fPort,fPrevCmd,fPrevPort,fPrevEnv].forEach(el=>el.addEventListener('input',markDirty));
function activatePane(id){tabsBar.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.t===id));panes.forEach(p=>p.classList.toggle('active',p.dataset.p===id))}
tabsBar.addEventListener('click',e=>{const b=e.target.closest('button[data-t]');if(b&&mode==='edit')activatePane(b.dataset.t)});
function renderList(){items.innerHTML='';for(const p of cfg.projects){const row=document.createElement('div');row.className='pmItem'+(mode==='edit'&&p.name===sel?' sel':'');row.dataset.name=p.name;row.draggable=true;row.style.setProperty('--h',hue(p.name));row.innerHTML='<span class="pmDrag" title="Drag to reorder">⠿</span><span class="pmMono">'+esc(mono(p.name))+'</span><span class="pmIname">'+esc(p.name)+'</span><span class="pmPort">:'+esc(p.port)+'</span>';row.onclick=()=>select(p.name);items.appendChild(row)}addBtn.classList.toggle('sel',mode==='add')}
function tabRowHtml(t){t=t||{};return '<div class="pmTabRow"><input type="text" class="tt-name" placeholder="Tab name" value="'+esc(t.name||'')+'"><input type="text" class="tt-cmd" placeholder="Optional command" value="'+esc(t.cmd||'')+'"><label><input type="checkbox" class="tt-auto"'+(t.autoStart?' checked':'')+'> auto-start</label><button type="button" class="rm" title="Remove">×</button></div>'}
tabRows.addEventListener('click',e=>{const rm=e.target.closest('.rm');if(rm){rm.closest('.pmTabRow').remove();markDirty()}});
tabRows.addEventListener('input',markDirty);
addTabBtn.onclick=()=>{tabRows.insertAdjacentHTML('beforeend',tabRowHtml({autoStart:true}));tabRows.lastElementChild.querySelector('.tt-name').focus();markDirty()};
document.querySelectorAll('.pmExamples code').forEach(c=>c.addEventListener('click',()=>{fPrevCmd.value=c.textContent;markDirty()}));
function envText(env){return Object.entries(env||{}).map(([k,v])=>k+'='+v).join('\\n')}
function fillForm(p){fName.value=p?p.name:'';fRepo.value=p?(p.repo||''):'';fPort.value=p?p.port:'';fPort.placeholder=p?'':(cfg.suggestedPort||'auto');fPath.textContent=p?p.path:'(created under /opt/project-workbench/workspaces/<Name>)';fPrevCmd.value=p&&p.preview?p.preview.cmd:'';fPrevPort.value=p&&p.preview&&p.preview.port?p.preview.port:'';fPrevPort.placeholder=cfg.suggestedPreviewPort||'auto';fPrevEnv.value=p&&p.preview?envText(p.preview.env):'';tabRows.innerHTML=(p&&p.tabs||[]).map(tabRowHtml).join('');delName.value='';delBtn.disabled=true;formDirty=false}
function select(name){if(busy)return;if(formDirty&&!confirm('Discard unsaved changes?'))return;mode='edit';sel=name;const p=cfg.projects.find(x=>x.name===name);fillForm(p);restartNote.textContent=(name===CUR?'You are looking at this project\\u2019s terminal right now — saving restarts it and kills this very session\\u2019s processes.':'Saving restarts this project\\u2019s terminal service — running processes in its tabs are killed.');tabsBar.style.display='';saveBtn.textContent='Save changes';activatePane('general');renderList();setStatus('')}
function startAdd(){if(busy)return;if(formDirty&&!confirm('Discard unsaved changes?'))return;mode='add';sel=null;fillForm(null);tabsBar.style.display='none';activatePane('general');saveBtn.textContent='Create project';renderList();setStatus('Preview, tab templates and more are configurable after the project exists.');setTimeout(()=>fName.focus(),40)}
addBtn.onclick=startAdd;
delName.addEventListener('input',()=>{delBtn.disabled=delName.value.trim()!==sel});
async function api(url,params){const r=await fetch(url,{method:'POST',headers:{'Accept':'application/json'},body:params});let j=null;try{j=await r.json()}catch{}if(!j)throw new Error('Unexpected response ('+r.status+')');if(!j.ok)throw new Error(j.error||('Request failed ('+r.status+')'));return j}
async function refreshCfg(){const r=await fetch('/api/projects/config',{cache:'no-store'});cfg=await r.json();if(!cfg.ok)throw new Error(cfg.error||'config load failed')}
function collectTabs(){const arr=[];tabRows.querySelectorAll('.pmTabRow').forEach(row=>{const n=row.querySelector('.tt-name').value.trim();if(!n)return;arr.push({name:n,cmd:row.querySelector('.tt-cmd').value,autoStart:row.querySelector('.tt-auto').checked})});return arr}
saveBtn.onclick=async()=>{if(busy)return;busy=true;saveBtn.disabled=true;try{
if(mode==='add'){const name=fName.value.trim();setStatus('Creating'+(fRepo.value.trim()?' — cloning can take a minute…':'…'));const params=new URLSearchParams({name,repo:fRepo.value.trim(),port:fPort.value||''});await api('/manage/add',params);reloadOnClose=true;await refreshCfg();busy=false;sel=name;mode='edit';select(name);setStatus('Created '+name+' — configure Preview and Terminal tabs, or just close to reload.')}
else{const oldName=sel;const newName=fName.value.trim();setStatus('Saving — restarting terminal service…');const params=new URLSearchParams({name:newName,repo:fRepo.value.trim(),port:fPort.value||'',previewCmd:fPrevCmd.value,previewPort:fPrevPort.value||'',previewEnv:fPrevEnv.value,tabs:JSON.stringify(collectTabs())});await api('/manage/update/'+encodeURIComponent(oldName),params);reloadOnClose=true;if(oldName===curNow){curNow=newName;navTarget=(curNow===CUR)?null:'/term/'+encodeURIComponent(curNow)+'/'}await refreshCfg();busy=false;sel=newName;formDirty=false;select(newName);setStatus('Saved '+newName+' — terminal restarted.')}
}catch(e){setStatus(e.message||String(e),true)}finally{busy=false;saveBtn.disabled=false}};
delBtn.onclick=async()=>{if(busy||delBtn.disabled)return;if(!confirm('Really delete "'+sel+'" AND its workspace folder? This cannot be undone.'))return;busy=true;delBtn.disabled=true;try{setStatus('Deleting '+sel+'…');await api('/manage/delete/'+encodeURIComponent(sel),new URLSearchParams({confirm:'yes'}));reloadOnClose=true;if(sel===curNow)navTarget='/';await refreshCfg();busy=false;sel=null;formDirty=false;if(cfg.projects.length){select(cfg.projects[0].name);setStatus('Deleted.')}else{navTarget=navTarget||'/';closeModal()}}catch(e){setStatus(e.message||String(e),true)}finally{busy=false}};
let dragSrc=null;
items.addEventListener('dragstart',e=>{const row=e.target.closest('.pmItem');if(!row)return;dragSrc=row;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',row.dataset.name)}catch{}});
items.addEventListener('dragover',e=>{if(!dragSrc)return;const t=e.target.closest('.pmItem');if(!t||t===dragSrc)return;e.preventDefault();const r=t.getBoundingClientRect();if((e.clientY-r.top)>r.height/2)t.parentNode.insertBefore(dragSrc,t.nextSibling);else t.parentNode.insertBefore(dragSrc,t)});
items.addEventListener('dragend',async()=>{if(!dragSrc)return;dragSrc.classList.remove('dragging');dragSrc=null;const order=[...items.querySelectorAll('.pmItem')].map(r=>r.dataset.name);try{const rr=await fetch('/api/projects/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})});const jj=await rr.json().catch(()=>null);if(!jj||!jj.ok)throw new Error((jj&&jj.error)||('HTTP '+rr.status));reloadOnClose=true;cfg.projects.sort((a,b)=>order.indexOf(a.name)-order.indexOf(b.name));setStatus('Order saved — the rail follows it.')}catch(e){setStatus('Reorder failed: '+(e.message||e),true)}});
async function openModal(){backdrop.classList.remove('hidden');setStatus('Loading…');try{await refreshCfg();setStatus('');if(cfg.projects.length){select(sel&&cfg.projects.some(p=>p.name===sel)?sel:(cfg.projects.some(p=>p.name===CUR)?CUR:cfg.projects[0].name))}else startAdd()}catch(e){setStatus(e.message||String(e),true)}}
function closeModal(){if(busy)return;if(formDirty&&!confirm('Discard unsaved changes?'))return;backdrop.classList.add('hidden');if(navTarget){location.href=navTarget}else if(reloadOnClose){location.reload()}}
closeBtn.onclick=closeModal;
backdrop.addEventListener('click',e=>{if(e.target===backdrop)closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))closeModal()});
const entry=document.getElementById('manageEntry');
if(entry)entry.addEventListener('click',e=>{e.preventDefault();openModal()});
window.pwManage={open:openModal};
try{const qs=new URLSearchParams(location.search);if(qs.get('manage')==='1'){qs.delete('manage');history.replaceState(null,'',location.pathname+(qs.toString()?'?'+qs.toString():'')+location.hash);openModal()}}catch{}
})();</script>`;


app.get('/', requireAuth, async (req,res)=>{
 const allProjects = await loadProjects();
 const projects = filterProjectsForUser(allProjects, req.user);
 const isAdmin = req.user.role === 'admin';
 const canOpenTerminal = TERMINAL_ROLES.has(req.user.role);
 const canUpload = INBOX_WRITE_ROLES.has(req.user.role);
 // Cockpit-first: terminal-capable users land straight in the cockpit of the
 // project they last visited (pw_last cookie), with the project rail for
 // switching. `/` only renders as a page when there is no cockpit to go to:
 // empty registry (admin onboarding / no-grants message) or roles that cannot
 // open terminals. First-run nudges live on the landing + /settings, never at
 // the cost of reaching a working cockpit.
 if(canOpenTerminal && projects.length){
  const lastName = getCookie(req, 'pw_last');
  const target = projects.find(p => p.name === lastName) || projects[0];
  return res.redirect(`/term/${encodeURIComponent(target.name)}/${req.query.manage === '1' ? '?manage=1' : ''}`);
 }
 const claudeVersion = await getClaudeVersion();
 const updateStamp = await getClaudeUpdateStamp();
 let content;
 if(isAdmin){
  content = `<section class="lCard lOnboard" style="--i:0"><h2>Let's get this workbench running</h2><p class="lLead">Two steps and you land in your first cockpit.</p><div class="lStep"><span class="lNum">1</span><div class="lStepMeta"><b>Sign in your AI CLI</b><span>Install and authenticate Claude Code (or Codex / Copilot); tokens apply to every project terminal.</span></div><button class="lBtn" id="openWizardBtn" type="button">Open Setup Wizard</button></div><div class="lStep"><span class="lNum">2</span><div class="lStepMeta"><b>Add your first project</b><span>Clone a repo — or start an empty local workspace — and land straight in its cockpit.</span></div><button class="lBtn primary" id="openManageBtn" type="button">Add project</button></div></section>`;
 } else if(projects.length === 0){
  content = `<section class="lCard" style="--i:0"><h2>${allProjects.length === 0 ? 'Nothing here yet' : 'No projects assigned'}</h2><p class="lLead">Your account (<b>${esc(req.user.username)}</b>, role: <b>${esc(req.user.role)}</b>) has no project grants yet. Ask an admin to grant access.</p></section>`;
 } else {
  const cards = projects.map((p,i)=>{
   const acts = [
    canUpload ? `<a class="lBtn primary" href="/files/${encodeURIComponent(p.name)}/">Drop files</a>` : '',
    hasPreview(p) ? `<button class="lBtn" type="button" data-preview="${esc(p.name)}">Preview</button>` : ''
   ].join('');
   return `<article class="lCard lProj" style="--h:${projHue(p.name)};--i:${i}"><div class="lProjHead"><span class="pk-mono">${esc(projMonogram(p.name))}</span><h3>${esc(p.name)}</h3></div><code class="lPath">${esc(p.path)}</code><div class="lActs">${acts || '<span class="lNone">read-only access</span>'}</div></article>`;
  }).join('');
  content = `<div class="lGrid">${cards}</div>`;
 }
 const userChip = req.user.implicit
  ? `<span class="badge" title="PW_AUTH_ENFORCE is OFF; all requests treated as admin">anonymous · enforce off</span>`
  : `<span class="badge"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span><button id="logoutBtn" class="lBtn" type="button">Sign out</button>`;
 const adminCta = isAdmin ? `<a class="lBtn" href="/settings">Settings</a>` : '';
 const adminModals = isAdmin ? wizardModalHtml + manageModalHtml : '';
 const adminScripts = isAdmin ? wizardScript + manageModalScript + `<script>document.getElementById('openWizardBtn')?.addEventListener('click',()=>document.getElementById('setupBackdrop')?.classList.remove('hidden'));document.getElementById('openManageBtn')?.addEventListener('click',()=>window.pwManage&&window.pwManage.open());</script>` : '';
 const firstRunScript = isAdmin
  ? `<script>(async()=>{try{const k='pw_firstrun_dismissed';if(sessionStorage.getItem(k))return;const r=await fetch('/api/system/firstrun',{cache:'no-store'});const j=await r.json();if(j?.firstRunNeeded){document.getElementById('setupBackdrop')?.classList.remove('hidden');sessionStorage.setItem(k,'1')}}catch{}})();</script>`
  : '';
 const logoutScript = req.user.implicit ? '' : `<script>document.getElementById('logoutBtn')?.addEventListener('click',async()=>{try{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'}})}catch{}location.href='/login'});</script>`;
 const previewBits = !canOpenTerminal && projects.some(hasPreview) ? previewModalHtml + previewScript : '';
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Workbench</title><style>${designTokensCss}${landingCss}${statusBarCss}${modalBaseCss}${wizardCss}${previewCss}</style></head><body class="landing"><header class="lHero"><div class="lBrand"><span class="brandGlyph">&gt;_</span><div><h1>Project Workbench</h1><p>Terminal cockpits for every project, with Claude Code on tap.</p></div></div><div class="lActions">${userChip}${adminCta}</div></header><main class="lMain">${content}</main>${adminModals}${previewBits}${adminScripts}${firstRunScript}${logoutScript}${footer}</body></html>`);
});

app.get('/manage', requireAdmin, async (req,res)=>{
 // The old server-rendered manage page is retired: project management now
 // lives in the cockpit's Manage modal. Deep-link by redirecting into the
 // last-visited (or first) project's cockpit with ?manage=1.
 const projects = filterProjectsForUser(await loadProjects(), req.user);
 if(projects.length === 0) return res.redirect('/?manage=1');
 const lastName = getCookie(req, 'pw_last');
 const target = projects.find(p => p.name === lastName) || projects[0];
 res.redirect(`/term/${encodeURIComponent(target.name)}/?manage=1`);
});

app.post('/manage/add', requireAdmin, async (req,res,next)=>{ try {
 const name = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim();
 if(!validName(name)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 await withProjectsLock(async () => {
  const projects = await loadProjects();
  if(projects.some(p=>p.name===name)) throw new Error('A project named "'+name+'" already exists');
  const port = Number(req.body.port) || nextPort(projects);
  if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
  if(allUsedPorts(projects).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
  const p = repo ? { name, repo, path: workspacePath(name), port } : { name, path: workspacePath(name), port };
  await cloneWorkspace(p); projects.push(p); await saveProjects(projects); await applyRouting(projects); await startProject(p);
 });
 await audit('project_add', { project: name, port: Number(req.body.port) || null, repo }, req);
 if(wantsJson(req)) return res.json({ok:true,name});
 res.redirect('/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.post('/manage/update/:oldName', requireAdmin, async (req,res,next)=>{ try {
 const oldName = req.params.oldName; const newName = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim(); const port = Number(req.body.port);
 const previewCmd = String(req.body.previewCmd || '').trim();
 const previewPortRaw = String(req.body.previewPort || '').trim();
 const previewEnvRaw = String(req.body.previewEnv || '');
 if(!validName(newName)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
 await withProjectsLock(async () => {
 const projects = await loadProjects(); const p = projects.find(x=>x.name===oldName); if(!p) throw new Error('Project "'+oldName+'" not found');
 if(newName!==oldName && projects.some(x=>x.name===newName)) throw new Error('A project named "'+newName+'" already exists');
 const others = projects.filter(x=>x.name!==oldName);
 if(allUsedPorts(others).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
 let previewBlock = null;
 if(previewCmd){
  let previewPort = Number(previewPortRaw) || Number(p.preview?.port) || nextPreviewPort(others);
  if(!validPort(previewPort)) throw new Error('Preview port must be between 1024 and 65535');
  if(previewPort === port) throw new Error('Preview port cannot match this project\'s terminal port');
  if(allUsedPorts(others).has(previewPort)) throw new Error('Preview port '+previewPort+' is already in use by another project');
  const env = {};
  for(const raw of previewEnvRaw.split(/\r?\n/)){
   const line = raw.replace(/^\s+|\s+$/g,'');
   if(!line || line.startsWith('#')) continue;
   const i = line.indexOf('=');
   if(i < 1) throw new Error(`Bad env line (need KEY=VALUE): ${line.slice(0,60)}`);
   const k = line.slice(0,i).replace(/\s+$/,'');
   const v = line.slice(i+1);
   if(k === 'PORT' || k === 'BASEPATH') throw new Error(`${k} is reserved and cannot be set via preview env`);
   if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid env var name: ${k}`);
   env[k] = v;
  }
  previewBlock = { cmd: previewCmd, port: previewPort };
  if(Object.keys(env).length) previewBlock.env = env;
 }
 // Parse tab templates (JSON, serialized client-side).
 let tabs = [];
 if(req.body.tabs){
  let parsed;
  try { parsed = JSON.parse(String(req.body.tabs)); } catch { throw new Error('Tab templates are not valid JSON'); }
  if(!Array.isArray(parsed)) throw new Error('Tab templates must be an array');
  const seen = new Set();
  for(const raw of parsed){
   const name = String(raw?.name || '').replace(/[\r\n\t]/g,' ').trim().slice(0,80);
   if(!name) continue;
   if(seen.has(name)) throw new Error(`Duplicate tab name: ${name}`);
   seen.add(name);
   tabs.push({ name, cmd: String(raw?.cmd || '').replace(/\r/g,''), autoStart: !!raw?.autoStart });
  }
 }
 await stopProject(oldName); const oldPath = p.path; p.name = newName; if(repo) p.repo = repo; else delete p.repo; p.port = port; p.path = workspacePath(newName);
 if(previewBlock) p.preview = previewBlock; else delete p.preview;
 if(tabs.length) p.tabs = tabs; else delete p.tabs;
 if(oldPath !== p.path){ try { await fs.rename(oldPath,p.path); } catch { /* absent workspace is okay */ } }
 await saveProjects(projects); await applyRouting(projects); await startProject(p);
 });
 await audit('project_update', { oldName, newName, port }, req);
 if(wantsJson(req)) return res.json({ok:true,name:newName});
 res.redirect('/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.post('/manage/delete/:name', requireAdmin, async (req,res,next)=>{ try {
 if(req.body.confirm !== 'yes') throw new Error('Delete confirmation required'); const name = req.params.name;
 await withProjectsLock(async () => {
  const projects = await loadProjects(); const idx = projects.findIndex(p=>p.name===name); if(idx<0) throw new Error('Project not found'); const [p] = projects.splice(idx,1);
  await stopProject(name); await removeWorkspace(p); await saveProjects(projects); await applyRouting(projects);
 });
 await audit('project_delete', { project: name }, req);
 if(wantsJson(req)) return res.json({ok:true});
 res.redirect('/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.get('/api/projects/status', requireAuth, async (req,res)=>{ try {
 const all = await loadProjects();
 const projects = filterProjectsForUser(all, req.user);
 const out = await Promise.all(projects.map(async p => {
  const [pend, bell] = await Promise.all([readPending(p), projectHasUnreadBell(p)]);
  // OR the (legacy, hook-driven) file marker with the live tmux-bell signal so
  // the card lights up on a finished-but-unviewed tab even without the Stop hook.
  return { name: p.name, ...pend, bell, pending: pend.pending || bell };
 }));
 res.json({ ok:true, projects: out });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/projects/:name/clear-pending', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.name); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 await clearPending(p); res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/projects/reorder', requireAdmin, async (req,res)=>{ try {
 const order = req.body?.order;
 if(!Array.isArray(order)) return res.status(400).json({ok:false,error:'order must be an array of names'});
 await withProjectsLock(async () => {
  const projects = await loadProjects();
  const byName = new Map(projects.map(p=>[p.name,p]));
  const ordered = [];
  for(const n of order){ if(typeof n==='string' && byName.has(n)){ ordered.push(byName.get(n)); byName.delete(n); } }
  for(const p of byName.values()) ordered.push(p);
  await saveProjects(ordered);
 });
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});


app.post('/api/internal/pvikpbot/handoff', async (req,res)=>{ try {
 const auth = String(req.get('authorization') || '');
 const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.get('x-pw-handoff-token') || '').trim();
 if(!internalHandoffToken || token !== internalHandoffToken) return res.status(403).json({ok:false,error:'forbidden'});
 const project = String(req.body?.project || req.body?.projectName || '').trim();
 const prompt = String(req.body?.prompt || '');
 if(!project) return res.status(400).json({ok:false,error:'project is required'});
 const p = await projectByName(project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const injected = await injectPvikpbotPrompt(p,prompt);
 await audit('pvikpbot_handoff', { project:p.name, promptBytes:Buffer.byteLength(prompt), injected }, req);
 res.json({ok:true,project:p.name,...injected});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/projects/config', requireAdmin, async (_req,res)=>{ try {
 const projects = await loadProjects();
 res.json({ ok:true,
  projects: projects.map(p => ({ name:p.name, repo:p.repo||'', port:p.port, path:p.path,
   preview: p.preview ? { cmd:p.preview.cmd||'', port:p.preview.port||'', env:p.preview.env||{} } : null,
   tabs: Array.isArray(p.tabs) ? p.tabs : [] })),
  suggestedPort: nextPort(projects), suggestedPreviewPort: nextPreviewPort(projects) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/term/:project/windows', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 res.json({ok:true,windows});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await newTmuxWindow(p, req.body?.name || 'new task', req.body?.cmd || '');
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows/:index/select', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await tmux(['select-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows/:index/rename', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const name = String(req.body?.name || '').replace(/[\r\n\t]/g,' ').trim().slice(0,80);
 if(!name) return res.status(400).json({ok:false,error:'Window name required'});
 await tmux(['rename-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`,name]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete('/api/term/:project/windows/:index', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 if(windows.length <= 1) return res.status(400).json({ok:false,error:'Cannot close the last session'});
 await tmux(['kill-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/term/:project/', requireTerminalAccess, async (req,res)=>{ await audit('terminal_open', { project: req.params.project }, req);
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); const projectJson = JSON.stringify(p.name).replace(/</g,'\\u003c');
 const railProjects = filterProjectsForUser(await loadProjects(), req.user);
 res.append('Set-Cookie', `pw_last=${encodeURIComponent(p.name)}; Path=/; Max-Age=31536000; SameSite=Lax`);
 const adminManage = req.user.role === 'admin' ? (manageModalHtml + manageModalScript) : '';
 const tabPresetsJson = JSON.stringify(Array.isArray(p.tabs) ? p.tabs : []).replace(/</g,'\\u003c');
 const _ws = await loadWorkbenchSettings();
 const cliTabsJson = JSON.stringify((_ws.enabledClis||[]).filter(k=>k in SUPPORTED_CLIS).map(k=>({label:SUPPORTED_CLIS[k].label,bin:SUPPORTED_CLIS[k].bin}))).replace(/</g,'\\u003c');
 await clearPending(p);
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Workbench</title><style>${designTokensCss}${cockpitCss}${modalBaseCss}${previewCss}</style></head><body><div id="shell"><main id="stage"><div id="topBar"><div id="tabScroller" class="tabScroller"><button id="tabArrowL" class="tabArrow" type="button" aria-label="Scroll tabs left" tabindex="-1">‹</button><div id="tabStrip" class="tabStrip"></div><button id="tabArrowR" class="tabArrow" type="button" aria-label="Scroll tabs right" tabindex="-1">›</button></div><div class="tbActions"><button class="previewBtn" type="button" data-preview="${esc(p.name)}" title="Open live preview window"><span class="pbDot"></span>Preview</button><button id="fileBtn" type="button" title="Files — paste or drop into project"><span class="fileInfo">Files</span></button><button id="railBtn" class="railBtn" type="button" aria-label="Toggle project rail">☰</button></div></div><div id="tray"><div id="drop" tabindex="0"><div>Paste/drop/select files here</div><div class="dropHint">PDF, txt, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status">Saved files go to <code>${esc(p.path)}/_inbox</code>. The path will be inserted into the terminal.</div><div id="preview"></div><div id="inboxHeader" class="inboxHeader"></div><div id="inboxList" class="inboxList"></div><button class="close" id="close">Close</button></div><div id="trayShield" aria-hidden="true"></div><iframe id="term" src="/pty/${encodeURIComponent(p.name)}/"></iframe></main>${railHtml(railProjects, p.name, req.user)}</div><script>const project=${projectJson};const tabPresets=${tabPresetsJson};const cliTabs=${cliTabsJson};const tray=document.getElementById('tray'),drop=document.getElementById('drop'),file=document.getElementById('file'),status=document.getElementById('status'),preview=document.getElementById('preview'),inboxHeader=document.getElementById('inboxHeader'),inboxList=document.getElementById('inboxList'),frame=document.getElementById('term');let previewTimer=null;const hoverPanel=Object.assign(document.createElement('div'),{id:'pwHoverPreview'});document.body.appendChild(hoverPanel);function setStatus(t,bad=false){status.textContent=t;status.style.color=bad?'#fca5a5':'#bbf7d0'}function clearPreview(){preview.innerHTML='';document.body.classList.remove('has-preview');setStatus('');if(previewTimer){clearTimeout(previewTimer);previewTimer=null}}function showPreview(url,name,isImage){if(!url&&!name)return clearPreview();if(previewTimer){clearTimeout(previewTimer);previewTimer=null}document.body.classList.add('has-preview');const safeName=escHtml(name||'file');if(isImage&&url){preview.innerHTML='<div class="previewItem"><a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+safeName+'"></a><button class="previewClear" type="button" title="Clear preview">×</button></div>'}else{preview.innerHTML='<div class="previewItem"><div style="padding:18px;border:1px solid #334155;border-radius:8px;color:#cbd5e1;text-align:center;display:flex;align-items:center;justify-content:center;min-height:130px;word-break:break-all;background:#111827">'+safeName+'</div><button class="previewClear" type="button" title="Clear preview">×</button></div>'}preview.querySelector('.previewClear').onclick=clearPreview;previewTimer=setTimeout(closeTray,15000)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function refreshInbox(){try{const r=await fetch('/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const out=await r.json();if(!out?.ok){inboxHeader.innerHTML='';inboxList.innerHTML='';return}const files=out.files||[];if(files.length===0){inboxHeader.innerHTML='<span>No saved files yet.</span>';inboxList.innerHTML='';return}inboxHeader.innerHTML='<span>'+files.length+' saved file'+(files.length===1?'':'s')+' — click a row to insert its path</span><button class="clear" type="button">Clear all</button>';inboxHeader.querySelector('.clear').onclick=async()=>{if(!confirm('Delete all '+files.length+' files in this project\\'s inbox?'))return;await fetch('/api/inbox/'+encodeURIComponent(project),{method:'DELETE'});refreshInbox()};inboxList.innerHTML='';for(const f of files){const row=document.createElement('div');row.className='row';row.title='Click to insert path: '+f.path;const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);row.innerHTML='<div class="thumb">'+(isImg?'<img src="'+f.url+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+escHtml(f.name)+'</div><div class="meta">'+fmtSize(f.size)+'</div></div><button class="del" type="button" title="Delete">×</button>';row.onclick=ev=>{if(ev.target.closest('.del'))return;if(insertPath(f.path)){setStatus('Inserted:\\n'+f.path)}else{setStatus('Could not insert (no terminal focus)',true)}};row.onmouseenter=()=>{hoverPanel.innerHTML=isImg?'<img src="'+f.url+'">':'<div class="card">'+escHtml(f.name)+'<div class="meta">'+fmtSize(f.size)+'</div></div>';hoverPanel.style.display='block';const rct=row.getBoundingClientRect(),pw=hoverPanel.offsetWidth,ph=hoverPanel.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;let lf=rct.right+10;if(lf+pw>vw-8)lf=Math.max(8,rct.left-pw-10);let tp=rct.top-4;if(tp+ph>vh-8)tp=Math.max(8,vh-ph-8);if(tp<8)tp=8;hoverPanel.style.left=lf+'px';hoverPanel.style.top=tp+'px'};row.onmouseleave=()=>{hoverPanel.style.display='none'};row.querySelector('.del').onclick=async ev=>{ev.stopPropagation();hoverPanel.style.display='none';await fetch('/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(f.name),{method:'DELETE'});refreshInbox()};inboxList.appendChild(row)}}catch{}}function openTray(msg){document.body.classList.add('shade-open');setTimeout(()=>drop.focus(),50);if(msg)setStatus(msg);refreshInbox()}function closeTray(){document.body.classList.remove('shade-open');clearPreview();focusTerminal()}function focusTerminal(){try{const ta=frame.contentDocument?.querySelector('textarea.xterm-helper-textarea');if(ta){ta.focus();return}}catch{}try{frame.contentWindow?.focus()}catch{}}function toggleTray(){document.body.classList.contains('shade-open')?closeTray():openTray()}document.getElementById('fileBtn').onclick=toggleTray;document.getElementById('close').onclick=closeTray;document.getElementById('trayShield').onclick=closeTray;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('shade-open'))closeTray()});function insertPath(path){try{if(frame.contentWindow.__pwSendToTerminal?.(path))return true}catch{}try{const ta=frame.contentDocument.querySelector('textarea.xterm-helper-textarea')||frame.contentDocument.querySelector('textarea');if(!ta)return false;ta.focus();const dt=new DataTransfer();dt.setData('text/plain',path);ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true}catch{return false}}async function upload(blob,name='clipboard-file'){if(!blob)return setStatus('No file received.',true);setStatus('Saving file...');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const res=await fetch('/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name,mime:blob.type||'application/octet-stream',data})});const out=await res.json().catch(()=>null);if(!res.ok||!out?.ok)throw new Error(out?.error||'Upload failed');const ok=insertPath(out.path);try{await navigator.clipboard.writeText(out.path)}catch{}showPreview(out.url,name||'file',(blob.type||'').startsWith('image/'));setStatus('Saved and '+(ok?'inserted':'copied')+':\\n'+out.path);refreshInbox()}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name).catch(e=>setStatus(e.message||String(e),true));drop.addEventListener('dragover',e=>{e.preventDefault();drop.style.borderColor='#60a5fa'});drop.addEventListener('dragleave',()=>drop.style.borderColor='#64748b');/* drop handler removed — the window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads because e.preventDefault() stops the browser default but not other listeners. */window.addEventListener('paste',e=>{const items=[...(e.clipboardData?.items||[])];const item=items.find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();openTray('Saving pasted file...');upload(f,f?.name||'clipboard-file').catch(err=>setStatus(err.message||String(err),true))},true);let dragDepth=0;window.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();dragDepth++;openTray('Drop files here to save them into _inbox.')}},true);window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.style.borderColor='#60a5fa'}},true);window.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)drop.style.borderColor='#64748b'}},true);window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();dragDepth=0;drop.style.borderColor='#64748b';openTray();upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name).catch(err=>setStatus(err.message||String(err),true))}},true);window.addEventListener('message',e=>{const d=e.data;if(!d||typeof d!=='object')return;if(d.type==='pw-open-image-tray'){openTray(d.message||'Paste the file here.')}else if(d.type==='pw-paste-saved'){openTray();const base=(d.path||'').split('/').pop()||'file';showPreview(d.url,base,/\\.(png|jpe?g|webp|gif|bmp)$/i.test(base));setStatus('Saved and inserted:\\n'+d.path);refreshInbox()}else if(d.type==='pw-paste-error'){openTray();setStatus('Paste failed: '+d.error,true)}});const TAB_DEBUG=/[?&]tabdebug\b/.test(location.search)||localStorage.getItem('pwTabDebug')==='1';console.info('[pw-tabs] tab-attention diagnostics: window.__pwTabs = latest tmux window state; set localStorage.pwTabDebug=1 (or add ?tabdebug) then reload to trace bell flags every poll.'+(TAB_DEBUG?' [tracing ON]':''));const tabStrip=document.getElementById('tabStrip');const tabScroller=document.getElementById('tabScroller');const tabArrowL=document.getElementById('tabArrowL');const tabArrowR=document.getElementById('tabArrowR');function updateTabArrows(){const of=tabStrip.scrollWidth-tabStrip.clientWidth>1;tabScroller.classList.toggle('overflow',of);if(of){const mx=tabStrip.scrollWidth-tabStrip.clientWidth;tabArrowL.disabled=tabStrip.scrollLeft<=1;tabArrowR.disabled=tabStrip.scrollLeft>=mx-1}}function scrollTabs(dir){tabStrip.scrollBy({left:dir*Math.max(120,Math.round(tabStrip.clientWidth*0.6)),behavior:'smooth'})}tabArrowL.onclick=()=>scrollTabs(-1);tabArrowR.onclick=()=>scrollTabs(1);tabStrip.addEventListener('scroll',updateTabArrows,{passive:true});window.addEventListener('resize',updateTabArrows);const tabsBase='/api/term/'+encodeURIComponent(project)+'/windows';let lastTabsKey='';let editingIdx=null;let editAfterRender=false;function startEdit(label,w){editingIdx=w.index;const original=label.textContent;label.contentEditable='true';label.classList.add('editing');label.focus();const sel=window.getSelection();const range=document.createRange();range.selectNodeContents(label);sel.removeAllRanges();sel.addRange(range);let done=false;const finish=async save=>{if(done)return;done=true;label.contentEditable='false';label.classList.remove('editing');label.removeEventListener('keydown',onKey);label.removeEventListener('blur',onBlur);const next=label.textContent.trim();editingIdx=null;if(save&&next&&next!==w.name){try{await fetch(tabsBase+'/'+w.index+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:next})})}catch{}lastTabsKey='';refreshTabs()}else if(!save){label.textContent=original}};const onKey=ev=>{if(ev.key==='Enter'){ev.preventDefault();finish(true)}else if(ev.key==='Escape'){ev.preventDefault();finish(false)}};const onBlur=()=>finish(true);label.addEventListener('keydown',onKey);label.addEventListener('blur',onBlur)}function closeTabMenu(){document.querySelector('.tabMenu')?.remove();document.removeEventListener('click',closeTabMenu,true);document.removeEventListener('keydown',tabMenuKey,true)}function tabMenuKey(e){if(e.key==='Escape')closeTabMenu()}async function spawnTab(name,cmd){editAfterRender=!name;await fetch(tabsBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name||'new task',cmd:cmd||''})});lastTabsKey='';refreshTabs()}function openTabMenu(anchor,windows){closeTabMenu();const menu=document.createElement('div');menu.className='tabMenu';menu.addEventListener('click',e=>e.stopPropagation());const existing=new Set((windows||[]).map(w=>w.name));const usable=(tabPresets||[]).filter(t=>t&&t.name&&!existing.has(t.name));for(const t of usable){const item=document.createElement('button');item.type='button';item.className='tabMenuItem';item.innerHTML='<span class="ti-name">'+escHtml(t.name)+'</span>'+(t.cmd?'<span class="ti-cmd">'+escHtml(t.cmd)+'</span>':'');item.onclick=()=>{spawnTab(t.name,t.cmd||'');closeTabMenu()};menu.appendChild(item)}if(usable.length===0&&(tabPresets||[]).length>0){const note=document.createElement('div');note.className='tabMenuItem empty';note.textContent='All tab templates are already open';menu.appendChild(note)}const cliUsable=(cliTabs||[]).filter(c=>!existing.has(c.label));const hasAbove=(tabPresets||[]).length>0;for(let i=0;i<cliUsable.length;i++){const c=cliUsable[i];const item=document.createElement('button');item.type='button';item.className='tabMenuItem'+(i===0&&hasAbove?' blank':'');item.innerHTML='<span class="ti-name">'+escHtml(c.label)+'</span><span class="ti-cmd">'+escHtml(c.bin)+'</span>';item.onclick=()=>{spawnTab(c.label,c.bin);closeTabMenu()};menu.appendChild(item)}const blank=document.createElement('button');blank.type='button';blank.className='tabMenuItem blank';blank.innerHTML='<span class="ti-name">+ Blank tab</span><span class="ti-cmd">plain bash, name it after creation</span>';blank.onclick=()=>{spawnTab('','');closeTabMenu()};menu.appendChild(blank);document.body.appendChild(menu);const r=anchor.getBoundingClientRect();const mw=menu.offsetWidth||220;let lf=r.left;if(lf+mw>window.innerWidth-8)lf=Math.max(8,window.innerWidth-mw-8);menu.style.left=lf+'px';menu.style.top=(r.bottom+4)+'px';setTimeout(()=>{document.addEventListener('click',closeTabMenu,true);document.addEventListener('keydown',tabMenuKey,true)},0)}async function refreshTabs(){if(editingIdx!=null)return;try{const r=await fetch(tabsBase,{cache:'no-store'});const out=await r.json();if(!out?.ok){tabStrip.innerHTML='';lastTabsKey='';return}window.__pwTabs=out.windows;if(TAB_DEBUG)console.debug('[pw-tabs]',new Date().toLocaleTimeString(),(out.windows||[]).map(w=>'#'+w.index+' '+(w.name||'')+' active='+(w.active?1:0)+' bell='+(w.bell?1:0)).join('  |  '));const key=JSON.stringify(out.windows);if(key===lastTabsKey)return;lastTabsKey=key;renderTabs(out.windows)}catch{}}function renderTabs(windows){tabStrip.innerHTML='';for(const w of windows){const tab=document.createElement('div');const needsAttention=w.bell&&!w.active;if(needsAttention&&TAB_DEBUG)console.log('[pw-tabs] ATTENTION \u2192 #'+w.index+' '+(w.name||''));tab.className='tab'+(w.active?' active':'')+(needsAttention?' attention':'');tab.title=w.active?'Click name to rename':(needsAttention?'Finished — click to view':'Window '+w.index+': '+(w.name||''));const label=document.createElement('span');label.className='name';label.textContent=w.name||('#'+w.index);label.onclick=ev=>{if(!w.active)return;ev.stopPropagation();startEdit(label,w)};tab.appendChild(label);if(windows.length>1){const x=document.createElement('span');x.className='x';x.textContent='×';x.title='Close window';x.onclick=async ev=>{ev.stopPropagation();if(!confirm('Close window "'+(w.name||w.index)+'"? Any running process in it will be killed.'))return;await fetch(tabsBase+'/'+w.index,{method:'DELETE'});lastTabsKey='';refreshTabs()};tab.appendChild(x)}tab.onclick=async()=>{if(w.active)return;await fetch(tabsBase+'/'+w.index+'/select',{method:'POST'});lastTabsKey='';refreshTabs()};tabStrip.appendChild(tab)}const plus=document.createElement('button');plus.className='newTab';plus.textContent='+';plus.title='New tab';plus.onclick=ev=>{ev.stopPropagation();openTabMenu(plus,windows)};tabStrip.appendChild(plus);const _act=tabStrip.querySelector('.tab.active');if(_act)try{_act.scrollIntoView({inline:'nearest',block:'nearest'})}catch{}requestAnimationFrame(updateTabArrows);if(editAfterRender){editAfterRender=false;const ai=windows.find(w=>w.active);if(ai){const tabs=tabStrip.querySelectorAll('.tab');const i=windows.indexOf(ai);const lbl=tabs[i]?.querySelector('.name');if(lbl)startEdit(lbl,ai)}}}refreshTabs();setInterval(()=>{if(!document.hidden)refreshTabs()},2000);async function pwHeartbeat(){if(document.hidden)return;try{await fetch('/api/projects/'+encodeURIComponent(project)+'/clear-pending',{method:'POST'})}catch{}}pwHeartbeat();setInterval(pwHeartbeat,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pwHeartbeat()});</script>${railScript}${adminManage}${previewModalHtml}${previewScript}</body></html>`);
});

// Lightweight /files/<name>/ page: drop tray + inbox list, no terminal iframe.
// Lets content_editor (and other inbox-write roles) drop files into a project's
// _inbox without granting raw shell. Hand-off path for the planned PVIKPBot
// content workflow.
app.get('/files/:project/', requireInboxWrite, async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project');
 const claudeVersion = await getClaudeVersion();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 const projectJson = JSON.stringify(p.name).replace(/</g,'\\u003c');
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Files</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;background:#0f172a;color:#e5e7eb}.f-header{display:flex;align-items:center;gap:1rem;padding:.95rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.f-header h1{margin:0;font-size:1.15rem}.f-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.f-header .back:hover{background:#1e293b;color:#fff}.f-header .grow{flex:1}.f-header .who{font-size:.85rem;color:#cbd5e1}.f-main{max-width:920px;margin:1.5rem auto;padding:0 1.5rem 3rem}.f-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.f-card h2{margin:0 0 .25rem;font-size:1.1rem;color:#bfdbfe}.f-card .muted{color:#94a3b8;font-size:.85rem;margin:.15rem 0 0}#drop{border:2px dashed #64748b;border-radius:14px;padding:42px 18px;text-align:center;background:#0b1220;cursor:pointer;color:#cbd5e1;font-size:.95rem;margin-top:.75rem}#drop:hover{background:#152033;border-color:#94a3b8}#drop.over{border-color:#60a5fa;background:#152033}#drop .hint{color:#94a3b8;font-size:.82rem;margin-top:.4rem}#status{margin-top:.65rem;font-size:.85rem;color:#bbf7d0;white-space:pre-wrap;min-height:1.3em}#status.err{color:#fca5a5}.ilist{display:flex;flex-direction:column;gap:.35rem;margin-top:.5rem}.irow{display:flex;align-items:center;gap:.65rem;padding:.5rem .65rem;background:#0b1220;border:1px solid #1f2937;border-radius:8px}.irow .thumb{width:36px;height:36px;background:#1f2937;border-radius:4px;flex:0 0 36px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:11px;font-weight:600;overflow:hidden}.irow .thumb img{width:100%;height:100%;object-fit:cover}.irow .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}.irow .nameCol .name{color:#e5e7eb;font-size:.88rem;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.irow .nameCol .meta{color:#94a3b8;font-size:.75rem}.irow .copyBtn,.irow .del,.irow a{background:transparent;border:1px solid #334155;color:#cbd5e1;border-radius:6px;padding:3px 9px;font-size:.78rem;cursor:pointer;text-decoration:none}.irow .copyBtn:hover,.irow a:hover{background:#1e293b;color:#fff}.irow .del{color:#fca5a5;border-color:#7f1d1d}.irow .del:hover{background:#7f1d1d;color:#fff}.empty{color:#94a3b8;font-style:italic;font-size:.85rem;padding:.75rem 0}${statusBarCss}</style></head><body><header class="f-header"><a class="back" href="/">← Dashboard</a><h1>Files — ${esc(p.name)}</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><main class="f-main"><div class="f-card"><h2>Drop or paste files</h2><p class="muted">Saved files go to <code>${esc(p.path)}/_inbox</code>. Click <b>Copy path</b> to grab the absolute path and hand it to whatever consumes the inbox (Claude conversation, PVIKPBot, etc.).</p><div id="drop" tabindex="0">Drop files here, paste from clipboard, or click to pick<div class="hint">PDF, text, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status"></div></div><div class="f-card"><h2>Inbox</h2><div class="ilist" id="ilist"><div class="empty">Loading…</div></div></div></main>${footer}<script>const project=${projectJson};const drop=document.getElementById('drop');const file=document.getElementById('file');const status=document.getElementById('status');const ilist=document.getElementById('ilist');function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatus(t,err){status.textContent=t||'';status.classList.toggle('err',!!err)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}async function refreshInbox(){try{const r=await fetch('/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const j=await r.json();if(!j.ok){ilist.innerHTML='<div class="empty">'+esc(j.error||'failed')+'</div>';return}const files=j.files||[];if(!files.length){ilist.innerHTML='<div class="empty">No saved files yet.</div>';return}ilist.innerHTML=files.map(f=>{const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);return '<div class="irow" data-n="'+esc(f.name)+'" data-p="'+esc(f.path)+'"><div class="thumb">'+(isImg?'<img src="'+esc(f.url)+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+esc(f.name)+'</div><div class="meta">'+fmtSize(f.size)+' · '+esc(f.mtime||'')+'</div></div><a href="'+esc(f.url)+'" target="_blank" rel="noopener">Open</a><button class="copyBtn" type="button">Copy path</button><button class="del" type="button">Delete</button></div>'}).join('')}catch(e){ilist.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}ilist.addEventListener('click',async e=>{const row=e.target.closest('.irow');if(!row)return;if(e.target.classList.contains('del')){if(!confirm('Delete "'+row.dataset.n+'"?'))return;const r=await fetch('/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(row.dataset.n),{method:'DELETE'});const j=await r.json();setStatus(j.ok?'Deleted '+row.dataset.n:'Error: '+j.error,!j.ok);refreshInbox()}else if(e.target.classList.contains('copyBtn')){try{await navigator.clipboard.writeText(row.dataset.p);setStatus('Copied path: '+row.dataset.p)}catch(err){setStatus('Could not copy: '+err.message,true)}}});async function upload(blob,name){if(!blob){setStatus('No file received.',true);return}setStatus('Saving '+(name||'file')+'…');try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const r=await fetch('/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name||'clipboard-file',mime:blob.type||'application/octet-stream',data})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Upload failed');try{await navigator.clipboard.writeText(j.path)}catch{}setStatus('Saved and path copied to clipboard:\\n'+j.path);refreshInbox()}catch(e){setStatus(e.message||String(e),true)}}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name);['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));['dragleave','dragend'].forEach(ev=>drop.addEventListener(ev,()=>drop.classList.remove('over')));/* drop handler removed — window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads. */window.addEventListener('paste',e=>{const item=[...(e.clipboardData?.items||[])].find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();upload(f,f?.name||'clipboard-file')},true);['dragenter','dragover'].forEach(ev=>window.addEventListener(ev,e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.classList.add('over')}},true));window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();drop.classList.remove('over');upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name)}},true);refreshInbox();</script></body></html>`);
});

app.post('/api/upload/:project', requireInboxWrite, async (req,res)=>{ const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'}); const {filename='clipboard-file', mime='', data=''} = req.body || {}; const ext = path.extname(filename) || (mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('pdf') ? '.pdf' : mime.includes('text') ? '.txt' : '.bin'); const safe = slug(path.basename(filename, path.extname(filename))); const stamp = new Date().toISOString().replace(/[:.]/g,'-'); const inbox = path.join(p.path, '_inbox'); await fs.mkdir(inbox, {recursive:true}); const full = path.join(inbox, `${stamp}-${safe}${ext}`); await fs.writeFile(full, Buffer.from(data, 'base64')); await audit('upload', { project: p.name, filename: path.basename(full), bytes: Buffer.byteLength(data, 'base64') }, req); return res.json({ok:true,path:full,url:`/file/${encodeURIComponent(p.name)}/${encodeURIComponent(path.basename(full))}`}); });
app.get('/file/:project/:file', requireAuth, requireProjectAccess, async (req,res)=>{ const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); res.sendFile(path.join(p.path, '_inbox', path.basename(req.params.file))); });

app.get('/api/inbox/:project', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const inbox = path.join(p.path, '_inbox');
 let entries; try { entries = await fs.readdir(inbox, {withFileTypes:true}); } catch { return res.json({ok:true,files:[]}); }
 const files = await Promise.all(entries.filter(e=>e.isFile()).map(async e => {
  const full = path.join(inbox, e.name); const st = await fs.stat(full);
  return { name: e.name, size: st.size, mtime: st.mtime.toISOString(), path: full, url: `/file/${encodeURIComponent(p.name)}/${encodeURIComponent(e.name)}` };
 }));
 files.sort((a,b)=>b.mtime.localeCompare(a.mtime));
 res.json({ok:true,files});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete('/api/inbox/:project/:file', requireInboxWrite, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const name = path.basename(req.params.file); if(!name || name==='.' || name==='..') return res.status(400).json({ok:false,error:'Invalid file'});
 await fs.rm(path.join(p.path,'_inbox',name), {force:true});
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete('/api/inbox/:project', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const inbox = path.join(p.path, '_inbox');
 try { const entries = await fs.readdir(inbox); await Promise.all(entries.map(n => fs.rm(path.join(inbox,n),{force:true,recursive:true}))); } catch {}
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
app.get('/api/preview/:project/status', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const status = await previewStatus(p);
 res.json({ ok:true, project:p.name, cmd:p.preview?.cmd || '', ...status });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/start', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project. Edit it on the Manage page.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/stop', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 await sh('systemctl',['stop',previewUnit(p.name)]).catch(()=>{});
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/restart', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/preview/:project/logs', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const lines = Math.min(2000, Math.max(20, Number(req.query.lines) || 200));
 const log = await previewLogs(p.name, lines);
 res.json({ ok:true, log });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/setup/state', requireAdmin, async (_req,res)=>{ try {
 const [settings, clis] = await Promise.all([loadWorkbenchSettings(), getCliStatuses()]);
 const updateStamp = await getClaudeUpdateStamp();
 res.json({ ok:true, settings, clis, updateStamp });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/state', requireAdmin, async (req,res)=>{ try {
 const s = await loadWorkbenchSettings();
 const body = req.body || {};
 if(typeof body.permissionMode === 'string') s.permissionMode = normalizePermissionMode(body.permissionMode);
 if(typeof body.mcpMode === 'string' && ['inherit','isolated','custom'].includes(body.mcpMode)) s.mcpMode = body.mcpMode;
 if(Array.isArray(body.enabledClis)) s.enabledClis = [...new Set(body.enabledClis.filter(c => c in SUPPORTED_CLIS))];
 if(Array.isArray(body.updateClis)) s.updateClis = [...new Set(body.updateClis.filter(c => c in SUPPORTED_CLIS))];
 await saveWorkbenchSettings(s);
 await audit('setup_state_change', { permissionMode: s.permissionMode, mcpMode: s.mcpMode, enabledClis: s.enabledClis, updateClis: s.updateClis }, req);
 res.json({ ok:true, settings:s });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/heal/nginx', requireAdminOrLocal, async (_req,res)=>{ try {
 const projects = await loadProjects();
 await applyRouting(projects);
 res.json({ ok:true, message:`Regenerated nginx config from projects.json (${projects.length} project route${projects.length===1?'':'s'} + /pty/_setup/) and reloaded nginx.` });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/heal/dirs', requireAdminOrLocal, async (_req,res)=>{ try {
 const steps = [];
 for(const d of [pendingDir,'/etc/project-workbench','/opt/project-workbench/workspaces','/opt/project-workbench/memory']){
  await fs.mkdir(d,{recursive:true}); steps.push(`ok dir: ${d}`);
 }
 try { await fs.access(emptyMcpPath); steps.push(`ok file: ${emptyMcpPath}`); }
 catch { await fs.writeFile(emptyMcpPath,'{}\n'); steps.push(`created: ${emptyMcpPath}`); }
 await syncWrapperEnv(await loadWorkbenchSettings()); steps.push(`refreshed: ${wrapperEnvPath}`);
 try { await fs.access('/usr/local/bin/claude'); steps.push('ok wrapper: /usr/local/bin/claude'); }
 catch { steps.push('MISSING /usr/local/bin/claude — run update-claude-code to reinstall'); }
 await sh('systemctl',['enable','--now','project-setup-terminal.service']).catch(()=>{});
 steps.push('enabled+started: project-setup-terminal.service');
 res.json({ ok:true, message: steps.join('\n') });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/cli/install', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const { stdout, stderr } = await sh('npm',['install','-g',`${cfg.pkg}@latest`],{timeout:300000});
 const version = await getCliVersion(cfg.bin);
 res.json({ ok:true, version: version || 'not installed', log:(stdout+stderr).slice(-1500) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/cli/auth', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const ready = await ensureSetupTerminal();
 if(!ready) return res.status(503).json({ok:false,error:'Setup terminal failed to start. Check `systemctl status project-setup-terminal.service`.'});
 await tmux(['send-keys','-t',setupTmuxSession,cfg.authCmd,'Enter']);
 res.json({ ok:true, command: cfg.authCmd });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/terminal-preload.js', async (_req,res)=>{ res.type('application/javascript').send(await fs.readFile('/opt/project-workbench/app/terminal-preload.js','utf8')); });
app.get('/terminal-paste.js', async (_req,res)=>{ res.type('application/javascript').send(await fs.readFile('/opt/project-workbench/app/terminal-paste.js','utf8')); });
app.get('/healthz', (_req,res)=>res.json({ok:true}));
// Public-readable agent guide. Lives in the repo at AGENTS.md and is the
// canonical place for an external AI agent to learn how to discover sessions,
// inject prompts, hand off files, etc. on this PW instance. No auth so a
// remote agent can curl it without first negotiating credentials.
app.get('/agents.md', async (_req,res) => {
 try {
  // Prefer the live-deployed source-tree copy; fall back to the dashboard's
  // installed copy if the source tree isn't present (e.g. tarball install).
  for(const candidate of ['/opt/project-workbench/source/AGENTS.md','/opt/project-workbench/app/AGENTS.md']){
   try { const txt = await fs.readFile(candidate,'utf8'); res.type('text/markdown; charset=utf-8').send(txt); return; } catch {}
  }
  res.status(404).type('text/plain').send('AGENTS.md not installed on this instance.');
 } catch(e){ res.status(500).type('text/plain').send(String(e.message||e)); }
});

// ============================================================================
// Footer status bar shared between dashboard and settings page.
// ============================================================================
function statusBarHtml({ claudeVersion, updateStamp, user, enforce }){
 const u = user && !user.implicit
  ? `<span class="sb-user"><b>${esc(user.username)}</b> · ${esc(user.role)}</span>`
  : `<span class="sb-user subtle">anonymous (enforce ${enforce ? 'on' : 'off'})</span>`;
 const enforceTag = enforce ? '<span class="sb-tag warn">enforce</span>' : '<span class="sb-tag">soft</span>';
 return `<footer id="pwStatusBar"><span class="sb-item">Claude Code: <b>${esc(claudeVersion)}</b></span><span class="sb-sep">·</span><span class="sb-item">Last update check: <b>${esc(updateStamp)}</b></span><span class="sb-sep">·</span><span class="sb-item">Auth: ${enforceTag}</span><span class="sb-grow"></span>${u}</footer>`;
}
const statusBarCss = `#pwStatusBar{position:fixed;left:0;right:0;bottom:0;background:rgba(15,23,42,.92);border-top:1px solid #1f2937;color:#94a3b8;font:12px system-ui,-apple-system,Segoe UI,sans-serif;padding:5px 14px;display:flex;align-items:center;gap:10px;backdrop-filter:blur(8px);z-index:50}#pwStatusBar b{color:#e5e7eb;font-weight:600}#pwStatusBar .sb-sep{opacity:.45}#pwStatusBar .sb-grow{flex:1}#pwStatusBar .sb-tag{padding:1px 7px;border-radius:999px;background:#1f2937;color:#cbd5e1;font-size:11px;border:1px solid #334155}#pwStatusBar .sb-tag.warn{color:#fde68a;border-color:#854d0e;background:#3b2e0a}body{padding-bottom:32px}`;

// ============================================================================
// Settings page (admin-only). Tabbed surface — primary settings destination.
// Setup Wizard still exists as a focused guided modal launched from here.
// ============================================================================
const settingsCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}.s-header{display:flex;align-items:center;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.s-header h1{margin:0;font-size:1.2rem}.s-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.s-header .back:hover{background:#1e293b;color:#fff}.s-header .grow{flex:1}.s-header .who{font-size:.85rem;color:#cbd5e1}.s-header .who b{color:#fff}.s-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0;min-height:calc(100vh - 60px - 32px)}.s-tabs{border-right:1px solid #1f2937;padding:1rem .5rem;background:#0b1220}.s-tabs button{display:block;width:100%;text-align:left;background:transparent;color:#cbd5e1;border:0;padding:.55rem .85rem;border-radius:8px;font:inherit;cursor:pointer;margin:1px 0}.s-tabs button:hover{background:#1e293b;color:#fff}.s-tabs button.active{background:#1e3a8a;color:#fff;font-weight:600}.s-main{padding:1.5rem 2rem;overflow:auto;min-width:0}.s-main section{display:none}.s-main section.active{display:block}.s-main h2{margin:0 0 .25rem;font-size:1.3rem}.s-main .lead{margin:0 0 1.25rem;color:#94a3b8;font-size:.92rem}.s-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.s-card h3{margin:0 0 .5rem;font-size:1.05rem;color:#bfdbfe}.s-card .muted{color:#94a3b8;font-size:.85rem}.button{display:inline-block;background:#2563eb;color:#fff;padding:.55rem .85rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button.danger{background:#991b1b}.button:hover{filter:brightness(1.1)}.button:disabled{opacity:.5;cursor:not-allowed}input,select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;font:inherit;box-sizing:border-box}input[type=text],input[type=password]{width:100%}.row-form{display:grid;grid-template-columns:minmax(140px,1fr) minmax(140px,1fr) minmax(140px,2fr) minmax(140px,1fr) auto;gap:.5rem;align-items:end}.row-form label{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;color:#cbd5e1;min-width:0}.utable{width:100%;border-collapse:collapse;font-size:.9rem}.utable th{text-align:left;padding:.55rem .55rem;border-bottom:1px solid #1f2937;color:#94a3b8;font-weight:600;font-size:.78rem;letter-spacing:.02em;text-transform:uppercase}.utable td{padding:.6rem .55rem;border-bottom:1px solid #1f2937;vertical-align:middle}.utable tr:hover td{background:rgba(30,41,59,.4)}.utable td.actions{text-align:right;white-space:nowrap}.utable .role-pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#1f2937;border:1px solid #334155;color:#cbd5e1;font-size:.74rem}.utable .role-pill.admin{color:#fde68a;border-color:#854d0e;background:#3b2e0a}.utable .role-pill.developer{color:#bbf7d0;border-color:#166534;background:#0b291a}.utable .role-pill.content_editor{color:#bfdbfe;border-color:#1e3a8a;background:#0b1a3a}.utable .role-pill.viewer{color:#cbd5e1;border-color:#334155;background:#1f2937}.utable .grants{font:11px ui-monospace,Menlo,monospace;color:#94a3b8;word-break:break-word;max-width:380px;display:inline-block;margin-right:6px}.tiny{padding:3px 9px;font-size:.78rem;margin:0 2px}.status-line{margin-top:.65rem;font-size:.82rem;color:#bbf7d0;min-height:1.2em}.status-line.err{color:#fca5a5}.env-grid2{display:grid;grid-template-columns:1fr 1fr;gap:.85rem}.env-grid2 label{display:flex;flex-direction:column;gap:.3rem;color:#cbd5e1;font-size:.85rem}.opt-help{font-size:.78rem;color:#94a3b8;line-height:1.45;margin-top:.2rem;min-height:2.4em}.opt-help.warn{color:#fca5a5}.opt-help b{color:#fde68a}.heal-out{margin:.55rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.55rem .75rem;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .85rem;align-items:center;padding:.55rem .75rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#0b1220}.cli-row .meta{min-width:0;display:flex;flex-direction:column;gap:.15rem}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.78rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .55rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block;margin-top:.5rem}#authFrame.hidden{display:none}.check-list{margin:0;padding:0;list-style:none}.check-list li{padding:.3rem 0;color:#cbd5e1;font-size:.9rem;display:flex;align-items:center;gap:.5rem}.check-list .ok{color:#86efac}.check-list .warn{color:#fde68a}.check-list .err{color:#fca5a5}
.um-form{display:flex;flex-direction:column;gap:.9rem}.um-form label{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#cbd5e1}.um-form label.inline{flex-direction:row;align-items:center;gap:.45rem}.um-form label.inline input[type=checkbox]{width:auto;margin:0}.proj-picker{border:1px solid #1f2937;border-radius:8px;padding:.5rem .65rem;background:#0b1220}.proj-picker .star{display:flex;align-items:center;gap:.45rem;color:#fde68a;font-size:.85rem;padding-bottom:.45rem;border-bottom:1px solid #1f2937;margin-bottom:.45rem}.proj-picker .star input{width:auto;margin:0}.proj-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.3rem .85rem;max-height:240px;overflow-y:auto}.proj-list.disabled{opacity:.45;pointer-events:none}.proj-list label{flex-direction:row;align-items:center;gap:.4rem;font-size:.82rem;color:#cbd5e1;padding:.2rem 0;cursor:pointer}.proj-list label input{width:auto;margin:0}.proj-list .empty{color:#94a3b8;font-style:italic;font-size:.82rem}@media(max-width:780px){.s-layout{grid-template-columns:1fr}.s-tabs{display:flex;flex-wrap:wrap;border-right:0;border-bottom:1px solid #1f2937;padding:.5rem}.s-tabs button{width:auto}.row-form{grid-template-columns:1fr}.env-grid2{grid-template-columns:1fr}}`;

const settingsScript = `<script>(function(){const tabs=document.querySelectorAll('.s-tabs button');const sections=document.querySelectorAll('.s-main section');function activate(id){tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===id));sections.forEach(s=>s.classList.toggle('active',s.id==='tab-'+id));try{history.replaceState(null,'','#'+id)}catch{}}tabs.forEach(b=>b.addEventListener('click',()=>activate(b.dataset.tab)));const init=(location.hash||'#users').slice(1);activate(['users','clis','env','system','firstrun'].includes(init)?init:'users');function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatus(el,t,err){if(!el)return;el.textContent=t||'';el.classList.toggle('err',!!err)}
// --- Users tab ---
const uTable=document.getElementById('uTable');const uStatus=document.getElementById('uStatus');const uAddBtn=document.getElementById('uAddBtn');
// Project list cache for the picker — admins see all projects via /api/projects/status.
let pwProjects=[];async function loadProjectList(){try{const r=await fetch('/api/projects/status',{cache:'no-store'});const j=await r.json();if(j?.ok)pwProjects=(j.projects||[]).map(p=>p.name).sort((a,b)=>a.localeCompare(b))}catch{}}
async function loadUsers(){uTable.innerHTML='<tr><td colspan="5" class="muted">loading…</td></tr>';try{const r=await fetch('/api/users',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'load failed');renderUsers(j.users)}catch(e){uTable.innerHTML='<tr><td colspan="5" class="muted">'+esc(e.message)+'</td></tr>'}}
function projectsCellHtml(p){if(p==='*')return '<span class="role-pill admin">all projects</span>';if(!Array.isArray(p)||p.length===0)return '<span class="muted">none</span>';return p.map(x=>'<code class="grants">'+esc(x)+'</code>').join('')}
function renderUsers(users){if(!users.length){uTable.innerHTML='<tr><td colspan="5" class="muted">no users yet — click + Add user above</td></tr>';return}window._pwUsers=users;uTable.innerHTML='<tr><th>Username</th><th>Role</th><th>Projects</th><th>Last login</th><th></th></tr>'+users.map(u=>'<tr data-u="'+esc(u.username)+'"><td><b>'+esc(u.username)+'</b></td><td><span class="role-pill '+esc(u.role)+'">'+esc(u.role)+'</span></td><td>'+projectsCellHtml(u.projects)+'</td><td class="muted">'+esc(u.lastLoginAt||'never')+'</td><td class="actions"><button class="button secondary tiny" data-edit="'+esc(u.username)+'">Edit</button><button class="button secondary tiny" data-pw="'+esc(u.username)+'">Password</button><button class="button danger tiny" data-del="'+esc(u.username)+'">Delete</button></td></tr>').join('')}
uTable.addEventListener('click',async e=>{const t=e.target;if(t.dataset.del){if(!confirm('Delete user "'+t.dataset.del+'"? Their active sessions will be revoked.'))return;const r=await fetch('/api/users/'+encodeURIComponent(t.dataset.del),{method:'DELETE'});const j=await r.json();setStatus(uStatus,j.ok?'Deleted '+t.dataset.del:'Error: '+j.error,!j.ok);loadUsers()}else if(t.dataset.pw){const p=prompt('New password for "'+t.dataset.pw+'" (≥8 chars):');if(!p)return;const r=await fetch('/api/users/'+encodeURIComponent(t.dataset.pw)+'/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});const j=await r.json();setStatus(uStatus,j.ok?'Password reset for '+t.dataset.pw:'Error: '+j.error,!j.ok)}else if(t.dataset.edit){const u=(window._pwUsers||[]).find(x=>x.username===t.dataset.edit);if(u)umOpen('edit',u)}});
// --- User modal (used for both Add and Edit) ---
const umBackdrop=document.getElementById('umBackdrop');const umTitle=document.getElementById('umTitle');const umUsername=document.getElementById('umUsername');const umRole=document.getElementById('umRole');const umProjStar=document.getElementById('umProjStar');const umProjList=document.getElementById('umProjList');const umPassword=document.getElementById('umPassword');const umPwLabel=document.getElementById('umPwLabel');const umStatus=document.getElementById('umStatus');const umSave=document.getElementById('umSave');const umCancel=document.getElementById('umCancel');const umClose=document.getElementById('umClose');let umMode='add';let umOriginalUsername=null;
function renderProjList(selected){if(!pwProjects.length){umProjList.innerHTML='<span class="empty">No projects in <code>projects.json</code> yet — add one from the dashboard\\'s Manage page first.</span>';return}const sel=new Set(Array.isArray(selected)?selected:[]);umProjList.innerHTML=pwProjects.map(p=>'<label><input type="checkbox" value="'+esc(p)+'"'+(sel.has(p)?' checked':'')+'>'+esc(p)+'</label>').join('')}
function syncStarDisabled(){umProjList.classList.toggle('disabled',umProjStar.checked)}
umProjStar.addEventListener('change',syncStarDisabled);
function umOpen(mode,user){umMode=mode;umOriginalUsername=user?.username||null;umTitle.textContent=mode==='add'?'Add user':('Edit user — '+user.username);umUsername.value=user?.username||'';umRole.value=user?.role||'developer';const isStar=user?.projects==='*';umProjStar.checked=isStar;renderProjList(isStar?[]:user?.projects);syncStarDisabled();umPassword.value='';umPwLabel.style.display=mode==='add'?'':'none';umPassword.required=mode==='add';setStatus(umStatus,'');umBackdrop.classList.remove('hidden');setTimeout(()=>umUsername.focus(),30)}
function umCloseFn(){umBackdrop.classList.add('hidden')}
umCancel.addEventListener('click',umCloseFn);umClose.addEventListener('click',umCloseFn);umBackdrop.addEventListener('click',e=>{if(e.target===umBackdrop)umCloseFn()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!umBackdrop.classList.contains('hidden'))umCloseFn()});
uAddBtn.addEventListener('click',()=>{if(!pwProjects.length){loadProjectList().then(()=>umOpen('add',null))}else{umOpen('add',null)}});
umSave.addEventListener('click',async()=>{const username=umUsername.value.trim();if(!/^[A-Za-z0-9._-]+$/.test(username)){setStatus(umStatus,'Username must be letters, digits, dot, dash, underscore (no spaces).',true);return}const role=umRole.value;const projects=umProjStar.checked?'*':[...umProjList.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.value);const body={username,role,projects};if(umMode==='add'){if(umPassword.value.length<8){setStatus(umStatus,'Password must be at least 8 characters.',true);return}body.password=umPassword.value}umSave.disabled=true;setStatus(umStatus,'Saving…');try{let r,j;if(umMode==='add'){r=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}else{const patchBody={};if(username!==umOriginalUsername)patchBody.username=username;if(role!==undefined)patchBody.role=role;patchBody.projects=projects;r=await fetch('/api/users/'+encodeURIComponent(umOriginalUsername),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patchBody)})}j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setStatus(uStatus,(umMode==='add'?'Added ':'Updated ')+username);umCloseFn();loadUsers()}catch(e){setStatus(umStatus,e.message,true)}finally{umSave.disabled=false}});
loadProjectList();loadUsers();
// --- CLIs + Environment + System tabs (reuse existing /api/setup/* endpoints) ---
const cliRows=document.getElementById('cliRows');const cliStatus=document.getElementById('cliStatus');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const envStatus=document.getElementById('envStatus');const envSave=document.getElementById('envSave');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const sysVer=document.getElementById('sysVer');const sysChecks=document.getElementById('sysChecks');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');let state=null;async function loadState(){try{const r=await fetch('/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');renderClis();renderEnv()}catch(e){setStatus(cliStatus,e.message,true)}}async function loadSystem(){try{const r=await fetch('/api/system/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');sysVer.innerHTML='Claude Code <b>'+esc(j.claudeVersion)+'</b> · Last updater run: <b>'+esc(j.updateStamp)+'</b> · Users: <b>'+j.userCount+'</b>';const c=j.checks;const items=[['claudeInstalled','Claude Code CLI installed'],['claudeAuthenticated','Claude Code signed in'],['atLeastOneAdmin','At least one admin user defined'],['atLeastOneEnabledCli','At least one CLI enabled in settings'],['wrapperEnvPresent','Wrapper env (/etc/project-workbench/claude-wrapper.env) present'],['authEnforce','Auth enforce mode ON (PW_AUTH_ENFORCE=true)']];sysChecks.innerHTML=items.map(([k,label])=>{const ok=!!c[k];const cls=k==='authEnforce'&&!ok?'warn':(ok?'ok':'err');const icon=ok?'✓':(k==='authEnforce'?'⚠':'✗');return '<li class="'+cls+'">'+icon+' '+esc(label)+'</li>'}).join('')}catch(e){sysChecks.innerHTML='<li class="err">'+esc(e.message)+'</li>'}}function renderClis(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+esc(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+esc(c.version)+'</span>'+(c.authenticated?'<span class="signed-in">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button class="button secondary tiny inst">'+(c.installed?'Update':'Install')+'</button><button class="button tiny auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+esc(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');btn.disabled=true;btn.textContent='Installing…';setStatus(cliStatus,'');try{const r=await fetch('/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');setStatus(cliStatus,c.label+': '+j.version);loadState();loadSystem()}catch(e){setStatus(cliStatus,e.message,true);loadState()}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setStatus(cliStatus,'');try{const r=await fetch('/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(authFrame.src.indexOf('/pty/_setup/')<0)authFrame.src='/pty/_setup/';authFrame.classList.remove('hidden');authHint.textContent='Running: '+j.command+' — complete the prompts in the terminal below.'}catch(e){setStatus(cliStatus,e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest default.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude runs every tool unattended. Anyone with dashboard access effectively has shell on this box.'};const MCP_HELP={inherit:'Use the MCP servers configured on your Anthropic account.',isolated:'Use an empty MCP config so no external MCP servers load.',custom:'Use a custom MCP JSON via <code>PW_MCP_CONFIG</code>.'};function renderEnv(){permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderEnvHelp()}function renderEnvHelp(){document.getElementById('permHelp').innerHTML=PERM_HELP[permMode.value]||'';document.getElementById('permHelp').classList.toggle('warn',permMode.value==='skip');document.getElementById('mcpHelp').innerHTML=MCP_HELP[mcpMode.value]||''}permMode.addEventListener('change',renderEnvHelp);mcpMode.addEventListener('change',renderEnvHelp);envSave.onclick=async()=>{envSave.disabled=true;setStatus(envStatus,'Saving…');try{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);const r=await fetch('/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();setStatus(envStatus,j.ok?'Saved.':'Error: '+j.error,!j.ok)}catch(e){setStatus(envStatus,e.message,true)}finally{envSave.disabled=false}};async function heal(url,btn){btn.disabled=true;healOut.className='heal-out show';healOut.textContent='Working…';try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');healOut.textContent=j.message||'OK';healOut.className='heal-out show'}catch(e){healOut.textContent=e.message;healOut.className='heal-out show err'}finally{btn.disabled=false;loadSystem()}}healNginx.onclick=()=>heal('/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('/api/setup/heal/dirs',healDirs);loadState();loadSystem();
// --- First Run tab: launch wizard modal ---
document.getElementById('rerunWizardBtn')?.addEventListener('click',()=>{document.getElementById('setupBackdrop')?.classList.remove('hidden')});})();</script>`;

app.get('/settings', requireAdmin, async (req,res) => {
 const claudeVersion = await getClaudeVersion();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings — Project Workbench</title><style>${settingsCss}${statusBarCss}${modalBaseCss}${wizardCss}</style></head><body><header class="s-header"><a class="back" href="/">← Dashboard</a><h1>Settings</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><div class="s-layout"><nav class="s-tabs"><button data-tab="users" class="active">Users &amp; Roles</button><button data-tab="clis">CLIs &amp; Sign-in</button><button data-tab="env">Environment</button><button data-tab="system">System &amp; Updates</button><button data-tab="firstrun">First Run</button></nav><main class="s-main">
<section id="tab-users" class="active"><h2>Users &amp; Roles</h2><p class="lead">Manage who can sign in and which projects they can see. Users live in <code>/etc/project-workbench/users.json</code>; passwords are hashed with scrypt and never displayed.</p><div class="s-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:1rem"><h3 style="margin:0">Current users</h3><button class="button" id="uAddBtn" type="button">+ Add user</button></div><table class="utable" id="uTable" style="margin-top:1rem"></table><div class="status-line" id="uStatus"></div></div></section>
<section id="tab-clis"><h2>CLIs &amp; Sign-in</h2><p class="lead">Install or update each assistant, then sign in. Tokens land in <code>/home/admin</code> and apply to every project terminal.</p><div class="s-card"><div id="cliRows"></div><div class="status-line" id="cliStatus"></div></div><div class="s-card"><h3>Sign-in terminal</h3><div id="authHint" class="muted">Click <b>Sign in</b> on a CLI above. The login command is sent into the shared setup terminal below.</div><iframe id="authFrame" class="hidden" title="Setup auth terminal"></iframe></div></section>
<section id="tab-env"><h2>Environment</h2><p class="lead">Wrapper-level policy applied to every Claude session this instance launches.</p><div class="s-card"><div class="env-grid2"><label>Permission mode<select id="permMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="permHelp"></span></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="mcpHelp"></span></label></div><button class="button" id="envSave" style="margin-top:1rem">Save environment</button><div class="status-line" id="envStatus"></div></div></section>
<section id="tab-system"><h2>System &amp; Updates</h2><p class="lead">Self-repair, version info, and a readiness checklist.</p><div class="s-card"><h3>Versions</h3><div id="sysVer" class="muted">loading…</div></div><div class="s-card"><h3>Readiness checklist</h3><ul class="check-list" id="sysChecks"><li class="muted">loading…</li></ul></div><div class="s-card"><h3>Heal</h3><p class="muted">Regenerate the nginx config from <code>projects.json</code>, or re-create runtime dirs / wrapper symlink if something looks broken.</p><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button> <button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button><pre class="heal-out" id="healOut"></pre></div><div class="s-card"><h3>Audit log</h3><p class="muted">Sensitive events are appended as JSONL to <code>/var/log/project-workbench/audit.log</code>. Tail it from a shell: <code>sudo tail -F /var/log/project-workbench/audit.log</code></p></div></section>
<section id="tab-firstrun"><h2>First Run / Rerun Setup Wizard</h2><p class="lead">A guided walkthrough that installs and signs in a CLI, then sets the permission and MCP policy. Use this on first install or to repair a broken instance.</p><div class="s-card"><button class="button" id="rerunWizardBtn" type="button">Open Setup Wizard</button></div></section>
</main></div>
<div id="umBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box" style="max-width:560px"><header><h2 id="umTitle">Add user</h2><button class="modal-close" id="umClose" aria-label="Close" type="button">×</button></header><div class="body"><form id="umForm" class="um-form" onsubmit="return false"><label>Username<input type="text" id="umUsername" required pattern="[A-Za-z0-9._-]+" maxlength="64" autocomplete="off"></label><label>Role<select id="umRole" required><option value="developer">developer</option><option value="content_editor">content_editor</option><option value="viewer">viewer</option><option value="admin">admin</option></select></label><label>Projects<div class="proj-picker"><label class="star inline"><input type="checkbox" id="umProjStar"> All projects (<code>*</code>) — admin behaves like this regardless of selection</label><div class="proj-list" id="umProjList"></div></div></label><label id="umPwLabel">Password (≥8 chars)<input type="password" id="umPassword" minlength="8" autocomplete="new-password"></label><div class="status-line" id="umStatus"></div></form></div><footer><button class="button secondary" id="umCancel" type="button">Cancel</button><button class="button" id="umSave" type="button">Save</button></footer></div></div>
${wizardModalHtml}${wizardScript}${settingsScript}${footer}</body></html>`);
});

// ============================================================================
// Auth routes (Phase 1)
// ============================================================================
const loginCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e5e7eb}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:2rem 1.75rem;max-width:380px;width:calc(100% - 2rem);box-shadow:0 30px 80px rgba(0,0,0,.6)}h1{margin:0 0 .35rem;font-size:1.45rem}.sub{margin:0 0 1.5rem;color:#94a3b8;font-size:.9rem}label{display:block;margin:.75rem 0 .3rem;font-size:.85rem;color:#cbd5e1}input{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.6rem;width:100%;box-sizing:border-box;font:inherit}.button{display:inline-block;background:#2563eb;color:white;padding:.65rem 1rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit;width:100%;margin-top:1rem}.button:hover{background:#1d4ed8}.err{margin-top:.85rem;color:#fca5a5;font-size:.85rem;min-height:1.2em}.foot{margin-top:1.25rem;color:#64748b;font-size:.75rem;text-align:center}`;
app.get('/login', (req,res) => {
 if(req.user && !req.user.implicit){ return res.redirect(req.query.next ? String(req.query.next) : '/'); }
 const next = req.query.next ? String(req.query.next) : '/';
 const msg = req.query.msg ? String(req.query.msg) : '';
 const sub = AUTH_MODE === 'ldap' ? `Sign in with ${esc(LOGIN_ORG || 'your directory account')}.` : 'Sign in to continue.';
 const uph = AUTH_MODE === 'ldap' ? 'firstname.lastname' : 'username';
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Project Workbench</title><style>${loginCss}</style></head><body><div class="card"><h1>Project Workbench</h1><p class="sub">${sub}</p><form id="loginForm"><label>Username<input id="u" name="username" autocomplete="username" placeholder="${uph}" autofocus required></label><label>Password<input id="p" name="password" type="password" autocomplete="current-password" required></label><button class="button" type="submit">Sign in</button><div class="err" id="err">${esc(msg)}</div></form></div><script>const next=${JSON.stringify(next)};document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();const u=document.getElementById('u').value;const p=document.getElementById('p').value;const err=document.getElementById('err');err.textContent='Signing in…';try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const j=await r.json();if(!j.ok){err.textContent=j.error||'Login failed';return}location.href=next}catch(e){err.textContent=e.message||String(e)}});</script></body></html>`);
});

app.post('/api/auth/login', async (req,res) => {
 try {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if(!username || !password){ await audit('login_fail', { reason:'missing-fields', username }, req); return res.status(400).json({ ok:false, error:'Username and password required' }); }
  let u = null;
  try { u = await authenticate(username, password); }
  catch(e){ await audit('login_fail', { reason:'ldap-bind', username }, req); return res.status(401).json({ ok:false, error:'Invalid username or password' }); }
  if(!u){ await audit('login_fail', { reason:'invalid', username }, req); return res.status(401).json({ ok:false, error:'Invalid username or password' }); }
  const sid = await createSession(u.id);
  setSessionCookie(req, res, sid, Math.floor(SESSION_TTL_MS / 1000));
  // Record lastLoginAt opportunistically (best-effort; re-load so we mutate the persisted record).
  try { const list = await loadUsers(); const rec = list.find(x => x.id === u.id); if(rec){ rec.lastLoginAt = new Date().toISOString(); await saveUsers(list); } } catch {}
  req.user = u;
  await audit('login_ok', { username }, req);
  res.json({ ok:true, user: { username:u.username, role:u.role, projects:u.projects } });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post('/api/auth/logout', async (req,res) => {
 try {
  const sid = getCookie(req, SESSION_COOKIE);
  if(sid) await revokeSession(sid);
  clearSessionCookie(req, res);
  await audit('logout', {}, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.get('/api/auth/me', (req,res) => {
 if(!req.user){ return res.status(401).json({ ok:false, authenticated:false, enforce: AUTH_ENFORCE }); }
 res.json({ ok:true, authenticated: !req.user.implicit, enforce: AUTH_ENFORCE, user: { username:req.user.username, role:req.user.role, projects:req.user.projects, implicit: !!req.user.implicit } });
});

// nginx auth_request subrequest. Returns 200 if the cookie's user can access
// ?project=<name>; 401/403 otherwise. nginx then allows or blocks the parent.
// ?admin=1 forces an admin-only check regardless of project (used for the
// shared setup terminal at /pty/_setup/).
app.get('/api/auth/check', async (req,res) => {
 try {
  const project = String(req.query.project || '');
  const adminOnly = String(req.query.admin || '') === '1';
  if(!req.user){
   if(!AUTH_ENFORCE) return res.status(200).end(); // soft mode: allow.
   return res.status(401).end();
  }
  if(adminOnly){
   return res.status(req.user.role === 'admin' ? 200 : 403).end();
  }
  if(req.user.role === 'admin') return res.status(200).end();
  if(project){
   if(!TERMINAL_ROLES.has(req.user.role)) return res.status(403).end();
   if(!userHasProjectAccess(req.user, project)) return res.status(403).end();
  }
  return res.status(200).end();
 } catch { res.status(500).end(); }
});

// ============================================================================
// User management (admin-only). All mutations audited. Never echoes hashes.
// Last-admin guard prevents accidental lockout.
// ============================================================================
function safeUserShape(u){
 return { username: u.username, role: u.role, projects: u.projects, createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null };
}
function isAdmin(u){ return u && u.role === 'admin'; }
function countAdmins(users){ return users.filter(isAdmin).length; }
function validNewUsername(s){ return typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s) && s.length >= 1 && s.length <= 64; }
function normalizeProjects(value){
 if(value === '*') return '*';
 if(value === undefined) return [];
 if(!Array.isArray(value)) throw new Error('projects must be "*" or an array of project names');
 const out = [];
 for(const v of value){ const s = String(v || '').trim(); if(s && !out.includes(s)) out.push(s); }
 return out;
}

app.get('/api/users', requireAdmin, async (_req,res) => {
 try { const users = await loadUsers(); res.json({ ok:true, users: users.map(safeUserShape) }); }
 catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post('/api/users', requireAdmin, async (req,res) => {
 try {
  const username = String(req.body?.username || '').trim();
  const role = String(req.body?.role || '');
  const password = String(req.body?.password || '');
  if(!validNewUsername(username)) return res.status(400).json({ ok:false, error:'Invalid username (letters/digits/._- only, max 64)' });
  if(!ROLES.includes(role)) return res.status(400).json({ ok:false, error:`role must be one of: ${ROLES.join(', ')}` });
  if(AUTH_MODE !== 'ldap' && password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  let projects;
  try { projects = normalizeProjects(req.body?.projects); } catch(e){ return res.status(400).json({ ok:false, error: e.message }); }
  const users = await loadUsers();
  if(users.some(u => u.username === username)) return res.status(409).json({ ok:false, error:`User "${username}" already exists` });
  const passwordHash = AUTH_MODE === 'ldap' ? undefined : await hashPassword(password);
  const now = new Date().toISOString();
  const id = 'u-' + crypto.randomBytes(6).toString('base64url');
  const rec = { id, username, role, projects, createdAt: now, lastLoginAt: null };
  if(passwordHash) rec.passwordHash = passwordHash;
  users.push(rec);
  await saveUsers(users);
  await audit('user_create', { username, role, projects }, req);
  res.json({ ok:true, user: safeUserShape({ username, role, projects, createdAt: now, lastLoginAt: null }) });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.patch('/api/users/:username', requireAdmin, async (req,res) => {
 try {
  const target = req.params.username;
  const users = await loadUsers();
  const u = users.find(x => x.username === target);
  if(!u) return res.status(404).json({ ok:false, error:`User "${target}" not found` });
  const newUsername = req.body?.username !== undefined ? String(req.body.username).trim() : undefined;
  const newRole = req.body?.role !== undefined ? String(req.body.role) : undefined;
  const newProjects = req.body?.projects !== undefined ? req.body.projects : undefined;
  if(newUsername !== undefined){
   if(!validNewUsername(newUsername)) return res.status(400).json({ ok:false, error:'Invalid username' });
   if(newUsername !== u.username && users.some(x => x.username === newUsername)) return res.status(409).json({ ok:false, error:`Username "${newUsername}" already exists` });
  }
  if(newRole !== undefined && !ROLES.includes(newRole)) return res.status(400).json({ ok:false, error:`role must be one of: ${ROLES.join(', ')}` });
  let projectsResolved = u.projects;
  if(newProjects !== undefined){
   try { projectsResolved = normalizeProjects(newProjects); } catch(e){ return res.status(400).json({ ok:false, error: e.message }); }
  }
  if(newRole !== undefined && newRole !== 'admin' && u.role === 'admin' && countAdmins(users) <= 1){
   return res.status(409).json({ ok:false, error:'Refusing to demote the last admin (you would lock yourself out)' });
  }
  const before = { username: u.username, role: u.role, projects: u.projects };
  if(newUsername !== undefined) u.username = newUsername;
  if(newRole !== undefined) u.role = newRole;
  if(newProjects !== undefined) u.projects = projectsResolved;
  await saveUsers(users);
  await audit('user_update', { target, before, after: { username: u.username, role: u.role, projects: u.projects } }, req);
  res.json({ ok:true, user: safeUserShape(u) });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post('/api/users/:username/password', requireAdmin, async (req,res) => {
 try {
  if(AUTH_MODE === 'ldap') return res.status(400).json({ ok:false, error:'Passwords are managed by the directory (ldap mode)' });
  const target = req.params.username;
  const password = String(req.body?.password || '');
  if(password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  const users = await loadUsers();
  const u = users.find(x => x.username === target);
  if(!u) return res.status(404).json({ ok:false, error:`User "${target}" not found` });
  u.passwordHash = await hashPassword(password);
  await saveUsers(users);
  await audit('user_password_change', { target }, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.delete('/api/users/:username', requireAdmin, async (req,res) => {
 try {
  const target = req.params.username;
  const users = await loadUsers();
  const i = users.findIndex(u => u.username === target);
  if(i < 0) return res.status(404).json({ ok:false, error:`User "${target}" not found` });
  if(isAdmin(users[i]) && countAdmins(users) <= 1){
   return res.status(409).json({ ok:false, error:'Refusing to delete the last admin (you would lock yourself out)' });
  }
  const [removed] = users.splice(i, 1);
  await saveUsers(users);
  try {
   const sessions = await loadSessions();
   const remaining = sessions.filter(s => s.userId !== removed.id);
   if(remaining.length !== sessions.length){ sessionsCache = remaining; await saveSessions(); }
  } catch {}
  await audit('user_delete', { target }, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// ============================================================================
// System status / readiness (admin-only). Used by Settings → System tab and
// by the first-run wizard auto-trigger to decide whether to prompt.
// ============================================================================
app.get('/api/system/status', requireAdmin, async (_req,res) => {
 try {
  const [claudeVersion, updateStamp, users, settings] = await Promise.all([
   getClaudeVersion(), getClaudeUpdateStamp(), loadUsers(), loadWorkbenchSettings(),
  ]);
  const checks = {
   claudeInstalled: claudeVersion !== 'unavailable',
   claudeAuthenticated: await getCliAuth('claude'),
   atLeastOneAdmin: users.some(u => u.role === 'admin'),
   atLeastOneEnabledCli: (settings.enabledClis || []).length > 0,
   authEnforce: AUTH_ENFORCE,
   wrapperEnvPresent: await fs.access(wrapperEnvPath).then(() => true).catch(() => false),
  };
  const firstRunNeeded = !checks.claudeInstalled || !checks.claudeAuthenticated || !checks.atLeastOneAdmin;
  res.json({ ok:true, claudeVersion, updateStamp, userCount: users.length, settings, checks, firstRunNeeded });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// Returns minimal first-run hint to any authenticated/implicit user so the
// dashboard knows whether to auto-prompt the wizard.
app.get('/api/system/firstrun', async (_req,res) => {
 try {
  const [claudeVersion, users, claudeAuth] = await Promise.all([getClaudeVersion(), loadUsers(), getCliAuth('claude')]);
  const needed = claudeVersion === 'unavailable' || !claudeAuth || users.length === 0;
  res.json({ ok:true, firstRunNeeded: needed });
 } catch { res.json({ ok:true, firstRunNeeded: false }); }
});

app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).type('html').send(`<h1>Workbench error</h1><pre>${esc(err.message || err)}</pre><p><a href="/manage">Back to Manage</a></p>`); });
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT,'127.0.0.1',()=>{ console.log(`dashboard listening on 127.0.0.1:${PORT}`); if(!ISOLATED) sweepOrphanTmuxSessions(); });
