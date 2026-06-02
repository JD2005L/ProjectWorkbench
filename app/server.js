import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const app = express();
const execFileAsync = promisify(execFile);
const registryPath = '/opt/project-workbench/projects.json';
const workspaceRoot = '/opt/project-workbench/workspaces';
const nginxPath = '/etc/nginx/sites-available/project-workbench';
const managedProjects = ['AmrikPublic','HarmaniPublic','IPSpeaker_ESP32','ProVisionIPortal','ProVisionIPublic','SunEstateHomesCA'];
const workbenchSettingsPath = '/etc/project-workbench/workbench.json';
const wrapperEnvPath = '/etc/project-workbench/claude-wrapper.env';
const emptyMcpPath = '/etc/project-workbench/empty-mcp.json';
const setupTtydPort = 7680;
const setupTmuxSession = 'pw_setup';
// `prompt` (safer default) makes Claude ask before each tool use; `skip` passes
// --dangerously-skip-permissions and runs every tool unattended.
const defaultWorkbenchSettings = { permissionMode:'prompt', mcpMode:'isolated', enabledClis:['claude'], updateClis:['claude'] };
const PERMISSION_MODES = ['prompt','skip'];
function normalizePermissionMode(v){ return PERMISSION_MODES.includes(v) ? v : 'prompt'; }
const SUPPORTED_CLIS = {
 claude:  { label:'Claude Code',        pkg:'@anthropic-ai/claude-code', bin:'claude',  authCmd:'claude login',                               notes:'Anthropic. Wrapper enforces permissions/MCP/shared-memory policy.' },
 codex:   { label:'OpenAI Codex CLI',   pkg:'@openai/codex',             bin:'codex',   authCmd:'codex login',                                notes:'OpenAI. Sign in with ChatGPT or set OPENAI_API_KEY.' },
 copilot: { label:'GitHub Copilot CLI', pkg:'@github/copilot',           bin:'copilot', authCmd:'copilot login',                              notes:'GitHub. Authenticate with your GitHub account.' }
};
const setupTerminalServicePath = '/etc/systemd/system/project-setup-terminal.service';
const dashboardServiceName = 'project-workbench.service';
const setupTerminalServiceUnit = `[Unit]
Description=ttyd setup/auth terminal for Project Workbench Setup Wizard
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=admin
Group=admin
Environment=HOME=/home/admin
ExecStart=/usr/local/bin/setup-terminal-start
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
`;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// CSRF guard: require that mutating requests come from a page on this workbench.
// nginx in front gates with Basic Auth (which the browser caches and replays on
// any origin), so we additionally check that Origin or Referer matches Host on
// non-safe methods. Same-origin fetch() and form POST both send Origin in every
// browser that ships today. Scripted clients can pass `-H 'Origin: <host>'`.
app.use((req, res, next) => {
 const method = req.method.toUpperCase();
 if(method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
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
const usersPath = '/etc/project-workbench/users.json';
const sessionsPath = '/var/lib/project-workbench/sessions.json';
const auditLogPath = '/var/log/project-workbench/audit.log';
const AUTH_ENFORCE = String(process.env.PW_AUTH_ENFORCE || '').toLowerCase() === 'true';
const SESSION_COOKIE = 'pw_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  return { index, name:parts[1] || `#${parts[0]}`, active:parts[2] === '1' };
 }).filter(w=>Number.isFinite(w.index));
}
async function listTmuxWindows(project){
 const { stdout } = await tmux(['list-windows','-t',tmuxSession(project),'-F','#{window_index}|#{window_name}|#{window_active}']);
 return parseTmuxWindows(stdout);
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
async function getInstalledCliSummary(){
 const parts = [];
 for(const [key,cfg] of Object.entries(SUPPORTED_CLIS)){
  const v = await getCliVersion(cfg.bin);
  if(v){
   const ver = v.replace(new RegExp('^'+cfg.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*','i'),'');
   parts.push(`${cfg.label} ${ver}`);
  }
 }
 return parts.length ? parts.join(', ') : 'no CLI installed';
}
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
 claude:  ['/home/admin/.claude/.credentials.json','/root/.claude/.credentials.json'],
 codex:   ['/home/admin/.codex/auth.json','/home/admin/.config/codex/auth.json','/root/.codex/auth.json','/root/.config/codex/auth.json'],
 copilot: ['/home/admin/.config/gh/hosts.yml','/root/.copilot/config.json']
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
function combinedOutput(e){
 return [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n').trim();
}
function trimmedOutput(s, max=1800){
 const out = String(s || '').trim();
 return out.length > max ? out.slice(-max) : out;
}
function dashboardHomeFixHint(reason=''){
 return [reason,'Run:','sudo systemctl edit project-workbench.service','Drop-in content:','[Service]\nEnvironment=HOME=/root','Then run:','sudo systemctl daemon-reload',`sudo systemctl restart ${dashboardServiceName}`].filter(Boolean).join('\n\n');
}
function setupTerminalServiceFixHint(reason=''){
 return [reason,`Create ${setupTerminalServicePath} with:`,setupTerminalServiceUnit,'Then run:','sudo systemctl daemon-reload','sudo systemctl enable --now project-setup-terminal.service'].filter(Boolean).join('\n\n');
}
async function commandPath(bin){
 try { const { stdout } = await sh('which',[bin],{timeout:5000}); return stdout.trim().split('\n')[0] || null; }
 catch { return null; }
}
async function systemctlShow(unit, props){
 try {
  const { stdout } = await sh('systemctl',['show',unit,`--property=${props.join(',')}`,'--no-pager'],{timeout:5000});
  return Object.fromEntries(stdout.split('\n').filter(Boolean).map(line=>{ const i = line.indexOf('='); return [line.slice(0,i), line.slice(i+1)]; }));
 } catch(e){ return { _error: trimmedOutput(combinedOutput(e)) }; }
}
async function serviceLogs(unit, lines=25){
 try { const { stdout } = await sh('journalctl',['-u',unit,'--no-pager','-n',String(Number(lines)||25),'-o','cat'],{timeout:5000}); return trimmedOutput(stdout,1600); }
 catch(e){ return trimmedOutput(combinedOutput(e),800); }
}
async function diagnoseSetupTerminalService(){
 const props = await systemctlShow('project-setup-terminal.service',['LoadState','ActiveState','SubState','FragmentPath']);
 if(props.LoadState !== 'loaded' || !props.FragmentPath){
  return { ok:false, hint: setupTerminalServiceFixHint('project-setup-terminal.service is missing, so Sign in cannot open the shared setup terminal.'), props };
 }
 if(props.ActiveState === 'active') return { ok:true, hint:null, props };
 const logs = await serviceLogs('project-setup-terminal.service',20);
 return { ok:false, hint:[`project-setup-terminal.service is installed but not running (state: ${props.ActiveState || 'unknown'}/${props.SubState || 'unknown'}).`,'Run:','sudo systemctl enable --now project-setup-terminal.service','Inspect:','sudo systemctl status project-setup-terminal.service --no-pager','sudo journalctl -u project-setup-terminal.service -n 50 --no-pager',logs ? `Recent logs:\n${logs}` : ''].filter(Boolean).join('\n\n'), props };
}
async function runDiagnostic(id,label,fn){
 try {
  const result = await fn();
  return { id, label, ok: !!result.ok, hint: result.ok ? null : (result.hint || 'No remediation hint provided.') };
 } catch(e){
  return { id, label, ok:false, hint: trimmedOutput(combinedOutput(e)) || 'Diagnostic check failed.' };
 }
}
async function runDiagnostics(){
 return Promise.all([
  runDiagnostic('admin-user','Service user (admin) exists', async ()=>{
   const homeExists = await fs.access('/home/admin').then(()=>true).catch(()=>false);
   let userExists = true;
   try { await sh('id',['admin'],{timeout:5000}); } catch { userExists = false; }
   if(homeExists && userExists) return { ok:true };
   return { ok:false, hint:[!userExists ? 'The "admin" user is missing.' : '', !homeExists ? '/home/admin is missing.' : '', 'Run:', 'sudo useradd -r -m -d /home/admin -s /bin/bash admin'].filter(Boolean).join('\n\n') };
  }),
  runDiagnostic('setup-terminal-service','Setup terminal service exists and is running', async ()=>diagnoseSetupTerminalService()),
  runDiagnostic('npm-registry','npm can reach the registry from the dashboard service', async ()=>{
   const npmPath = await commandPath('npm');
   if(!npmPath) return { ok:false, hint:'npm is not installed or not on PATH for the dashboard service.' };
   if(!process.env.HOME){
    return { ok:false, hint: dashboardHomeFixHint('HOME is not set for the Project Workbench service. npm installs commonly fail from systemd when HOME is missing.') };
   }
   try {
    await sh('npm',['ping','--silent'],{timeout:15000, env:{ ...process.env, HOME: process.env.HOME }});
    return { ok:true };
   } catch(e){
    const detail = trimmedOutput(combinedOutput(e));
    if(/ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|network/i.test(detail)){
     return { ok:false, hint:[`npm could not reach the registry from the dashboard service.`, dashboardHomeFixHint('If HOME is missing in systemd, fix that first.'), 'If HOME is already set, also verify proxy and firewall settings, then retry:', 'npm ping'].filter(Boolean).join('\n\n') };
    }
    return { ok:false, hint:[`npm ping failed from the dashboard service.`, detail ? `Details:\n${detail}` : '', dashboardHomeFixHint('If installs are timing out, verify HOME first.')].filter(Boolean).join('\n\n') };
   }
  }),
  runDiagnostic('ttyd-binary','ttyd is installed and executable', async ()=>{
   const ttydPath = await commandPath('ttyd');
   if(!ttydPath){
    return { ok:false, hint:['ttyd is not installed or not on PATH.','Download ttyd and run:','sudo chcon -t bin_t /usr/local/bin/ttyd'].join('\n\n') };
   }
   try {
    await sh(ttydPath,['--version'],{timeout:5000});
    return { ok:true };
   } catch(e){
    const detail = trimmedOutput(combinedOutput(e));
    return { ok:false, hint:[`ttyd exists at ${ttydPath} but could not be executed. SELinux labelling is a common cause.`, detail ? `Details:\n${detail}` : '', 'Download ttyd and run:', 'sudo chcon -t bin_t /usr/local/bin/ttyd'].filter(Boolean).join('\n\n') };
   }
  }),
  runDiagnostic('tmux-binary','tmux is installed', async ()=>{
   const tmuxPath = await commandPath('tmux');
   if(!tmuxPath) return { ok:false, hint:['tmux is not installed.','Run:','sudo dnf install -y tmux'].join('\n\n') };
   try { await sh(tmuxPath,['-V'],{timeout:5000}); return { ok:true }; }
   catch(e){
    const detail = trimmedOutput(combinedOutput(e));
    return { ok:false, hint:[`tmux exists at ${tmuxPath} but could not be executed.`, detail ? `Details:\n${detail}` : '', 'Run:','sudo dnf install -y tmux'].filter(Boolean).join('\n\n') };
   }
  }),
  runDiagnostic('nginx-setup-route','nginx exposes the /pty/_setup/ route', async ()=>{
   const conf = await fs.readFile(nginxPath,'utf8');
   const hasRoute = conf.includes('location /pty/_setup/') && conf.includes(`proxy_pass http://127.0.0.1:${setupTtydPort}/pty/_setup/;`);
   if(hasRoute) return { ok:true };
   return { ok:false, hint:['The nginx config is missing the /pty/_setup/ proxy route used by the sign-in iframe.','Run Heal > Regenerate nginx to add missing routes.','Equivalent shell fix:','sudo systemctl reload nginx'].join('\n\n') };
  })
 ]);
}
async function ensureSetupTerminal(){
 try {
  const { stdout } = await sh('systemctl',['is-active','project-setup-terminal.service'],{timeout:3000});
  if(stdout.trim() === 'active') return { ok:true };
 } catch {}
 await sh('systemctl',['enable','--now','project-setup-terminal.service']).catch(()=>{});
 for(let i=0;i<20;i++){
  try {
   const { stdout } = await sh('systemctl',['is-active','project-setup-terminal.service'],{timeout:3000});
   if(stdout.trim() === 'active') return { ok:true };
  } catch {}
  await new Promise(r=>setTimeout(r,300));
 }
 return { ok:false, error:'project-setup-terminal.service failed to start. Run: sudo systemctl status project-setup-terminal.service --no-pager' };
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
 await sh('chmod',['755',path.dirname(workspaceRoot)]).catch(()=>{});
 await sh('chown',['admin:admin',workspaceRoot]).catch(()=>{});
 try { await fs.access(path.join(p.path,'.git')); await sh('chown',['-R','admin:admin',p.path]).catch(()=>{}); return; } catch {}
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

const homeCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;background:#0f172a;color:#e5e7eb}a{color:#93c5fd}.grid article .prow{display:grid;grid-template-columns:1fr 110px;gap:.5rem;align-items:end;margin-top:.45rem}.grid article .prow.envrow,.grid article .prow.tabrow{grid-template-columns:1fr}.grid article .prow label{margin:.25rem 0 0}.grid article .prow textarea{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;width:100%;min-width:0;box-sizing:border-box;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:2.4rem}.tab-tpls{display:flex;flex-direction:column;gap:.35rem;margin:.35rem 0 0}.tab-tpl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto auto;gap:.4rem;align-items:center}.tab-tpl input[type=text]{padding:.35rem .55rem;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.tab-tpl label.cb{margin:0;display:inline-flex;align-items:center;gap:.3rem;font-size:.78rem;color:#cbd5e1;white-space:nowrap}.tab-tpl label.cb input[type=checkbox]{width:auto}.tab-tpl .tt-rm{background:transparent;border:1px solid #4b5563;color:#fca5a5;border-radius:6px;padding:2px 8px;font:inherit;cursor:pointer;line-height:1}.tab-tpl .tt-rm:hover{background:#1f2937;color:#fff}.tinybtn{padding:.3rem .6rem;font-size:.82rem;margin:.4rem 0 0}@media(max-width:640px){.tab-tpl{grid-template-columns:1fr 1fr}.tab-tpl label.cb,.tab-tpl .tt-rm{grid-column:span 2;justify-self:start}}.empty-state{background:#111827;border:1px solid #334155;border-radius:14px;padding:2rem 1.75rem;text-align:center;max-width:640px;margin:1.5rem auto}.empty-state h2{margin:0 0 .35rem;font-size:1.45rem}.empty-state p{margin:0 0 1.25rem;color:#cbd5e1;line-height:1.45}.empty-state .step{display:flex;align-items:center;gap:.85rem;text-align:left;padding:.75rem .9rem;border:1px solid #1f2937;border-radius:10px;background:#0b1220;margin:.5rem 0}.empty-state .step .num{display:inline-flex;align-items:center;justify-content:center;width:1.8rem;height:1.8rem;border-radius:50%;background:#1e3a8a;color:#bfdbfe;font-weight:700;flex:0 0 1.8rem;font-size:.85rem}.empty-state .step .num.done{background:#065f46;color:#6ee7b7;font-size:1rem}.empty-state .step .meta{flex:1 1 auto;min-width:0}.empty-state .step .meta b{display:block;color:#f8fafc}.empty-state .step .meta span{color:#94a3b8;font-size:.85rem}.empty-state .step .button{margin:0;white-space:nowrap;padding:.5rem .7rem;font-size:.85rem}.empty-add{background:#0b1220;border:1px dashed #475569;border-radius:10px;padding:.65rem .85rem;color:#94a3b8;font-size:.9rem;margin-bottom:1rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:1rem}.manage-grid{margin-top:1.25rem}article{background:#111827;border:1px solid #374151;border-radius:12px;padding:1rem;transition:border-color .2s,box-shadow .2s}article.pending{border-color:#3b82f6;box-shadow:0 0 0 1px rgba(59,130,246,.35),0 8px 28px -12px rgba(59,130,246,.55)}.button{display:inline-block;background:#2563eb;color:white;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button.danger{background:#991b1b}.muted{color:#9ca3af;font-size:.9rem}code{color:#bfdbfe;word-break:break-all}.repo{color:#93c5fd;text-decoration:none;font-size:.9rem}.repo:hover{text-decoration:underline}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5rem;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #1f2937}.hero h1{margin:0;font-size:2rem;line-height:1.1}.subtitle{margin:.45rem 0 0;color:#cbd5e1}.hero-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.55rem;min-width:260px}.action-row{display:flex;gap:.55rem;align-items:center;justify-content:flex-end;flex-wrap:wrap}.iconBtn{width:2.65rem;height:2.65rem;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem;line-height:1}.meta-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;align-items:center;gap:.35rem;background:#111827;border:1px solid #334155;border-radius:999px;padding:.35rem .65rem;color:#cbd5e1;font-size:.9rem}.subtle{color:#94a3b8;font-size:.8rem}.top{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}input{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.55rem;width:100%;box-sizing:border-box;min-width:0}label{display:block;margin:.5rem 0}.row{display:grid;grid-template-columns:1fr 1.5fr .5fr auto;gap:.5rem;align-items:end}.grid article .row{display:grid;grid-template-columns:3fr 1fr;gap:.5rem;align-items:end}.grid article .row label:nth-of-type(1){grid-column:1;grid-row:1}.grid article .row label:nth-of-type(3){grid-column:2;grid-row:1}.grid article .row label:nth-of-type(2){grid-column:1/-1;grid-row:2}.grid article .row .button{grid-column:1/-1;grid-row:3;justify-self:start;margin-top:.35rem}.grid article h2{margin:0 0 .5rem;font-size:1.15rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.pending-dot{display:none;width:.6em;height:.6em;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 .18em rgba(59,130,246,.25);animation:pwPulse 1.6s ease-in-out infinite}article.pending .pending-dot{display:inline-block}.pending-label{display:none;color:#93c5fd;font-size:.78rem;font-weight:500;letter-spacing:.02em}article.pending .pending-label{display:inline}@keyframes pwPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}.pencilBtn{background:transparent;border:1px solid #374151;color:#cbd5e1}.pencilBtn:hover{background:#1e293b;border-color:#94a3b8;color:#fff}.pencilBtn.active{background:#1e3a8a;border-color:#3b82f6;color:#fff}body.editing-order .order-grid article{cursor:grab;border-style:dashed;border-color:#3b82f6;position:relative}body.editing-order .order-grid article.dragging{opacity:.45;cursor:grabbing}body.editing-order .order-grid article *{user-select:none}body.editing-order .order-grid article a,body.editing-order .order-grid article button{pointer-events:none;opacity:.65}body.editing-order .order-grid article form input,body.editing-order .order-grid article form .button{pointer-events:none;opacity:.55}body.editing-order .order-grid article::before{content:'⠿';position:absolute;top:6px;right:14px;color:#60a5fa;font-size:20px;font-family:monospace;line-height:1;letter-spacing:-2px}.val-hint{display:block;font-size:.78rem;min-height:1.1em;margin-top:.2rem;color:#94a3b8;position:absolute;left:0;bottom:-1.3rem}.val-hint.err{color:#fca5a5}@media(max-width:800px){.row{grid-template-columns:1fr}.hero{flex-direction:column}.hero-actions{align-items:flex-start}.meta-row{justify-content:flex-start}}`;

const wizardCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-box footer{display:flex;justify-content:flex-end;gap:.5rem;padding:.8rem 1.25rem;border-top:1px solid #1f2937;align-items:center}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.modal-box section{margin-bottom:1.25rem}.modal-box section h3{margin:0 0 .35rem;font-size:1rem;color:#bfdbfe}.section-help{margin:0 0 .55rem;color:#94a3b8;font-size:.85rem}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .75rem;align-items:center;padding:.55rem .7rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#111827}.cli-row .meta{display:flex;flex-direction:column;gap:.15rem;min-width:0}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.8rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .5rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}.cli-row .actions .button{padding:.4rem .65rem;font-size:.82rem;margin:0}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}.env-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.env-grid label{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#cbd5e1}.env-grid select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.45rem;font:inherit}.env-grid .opt-help{font-size:.78rem;color:#94a3b8;line-height:1.45;margin-top:.15rem;min-height:2.6em}.env-grid .opt-help.warn{color:#fca5a5}.env-grid .opt-help b{color:#fde68a}.heal-row{display:flex;gap:.5rem;flex-wrap:wrap}.heal-out{margin:.5rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.6rem .8rem;font-size:.82rem;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block}#authFrame.hidden{display:none}#authHint{color:#94a3b8;font-size:.85rem;margin:.3rem 0 .5rem}#saveStatus{color:#bbf7d0;font-size:.85rem;margin-right:auto}#saveStatus.err{color:#fca5a5}@media(max-width:640px){.cli-row{grid-template-columns:1fr}.env-grid{grid-template-columns:1fr}}`;

const wizardScript = `<script>(function(){const open=document.getElementById('setupBtn');const backdrop=document.getElementById('setupBackdrop');if(!backdrop)return;const closeBtn=document.getElementById('setupCloseBtn');const cancelBtn=document.getElementById('setupCancelBtn');const saveBtn=document.getElementById('setupSaveBtn');const cliRows=document.getElementById('wzCliRows');const permMode=document.getElementById('wzPermMode');const mcpMode=document.getElementById('wzMcpMode');const saveStatus=document.getElementById('saveStatus');let state=null;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setSave(t,err){saveStatus.textContent=t||'';saveStatus.classList.toggle('err',!!err)}function render(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+escHtml(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+escHtml(c.version)+'</span>'+(c.authenticated?'<span class="signed-in" title="Credentials detected on disk">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button type="button" class="button secondary inst">'+(c.installed?'Update':'Install')+'</button><button type="button" class="button auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+escHtml(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');const orig=btn.textContent;btn.disabled=true;btn.textContent='Installing…';setSave('');try{const r=await fetch('/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');const v=row.querySelector('.version');v.textContent=j.version;v.classList.add('installed');btn.textContent='Update';setSave(c.label+': '+j.version)}catch(e){btn.textContent=orig;setSave(e.message,true)}finally{btn.disabled=false}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setSave('');try{const r=await fetch('/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(window.pwOpenAuthModal){window.pwOpenAuthModal(c.label,j.command)}else{setSave('Auth modal not available',true)}}catch(e){setSave(e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderOptHelp()}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest. Use this unless you fully trust everyone with dashboard access.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude will execute any shell command, file write, or tool call without asking. Anyone with basic-auth access effectively has shell on this box.'};const MCP_HELP={inherit:'Claude uses the MCP servers configured on your Anthropic account (whatever <code>~/.claude.json</code> currently has).',isolated:'Forces Claude to use an empty MCP config so no external MCP servers load. Good when you want this box self-contained or your account MCP is unreachable from the LAN.',custom:'Use a custom MCP JSON config file. Path is set via the <code>PW_MCP_CONFIG</code> env var the wrapper reads.'};function renderOptHelp(){const ph=document.getElementById('wzPermHelp');const mh=document.getElementById('wzMcpHelp');if(ph){ph.innerHTML=PERM_HELP[permMode.value]||'';ph.classList.toggle('warn',permMode.value==='skip')}if(mh)mh.innerHTML=MCP_HELP[mcpMode.value]||''}permMode&&permMode.addEventListener('change',renderOptHelp);mcpMode&&mcpMode.addEventListener('change',renderOptHelp);async function load(){setSave('Loading…');try{const r=await fetch('/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');render();setSave('')}catch(e){setSave(e.message,true)}}function show(){backdrop.classList.remove('hidden');load()}function hide(){backdrop.classList.add('hidden');setSave('')}if(open)open.onclick=show;if(closeBtn)closeBtn.onclick=hide;if(cancelBtn)cancelBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});saveBtn.onclick=async()=>{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);saveBtn.disabled=true;setSave('Saving…');try{const r=await fetch('/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setSave('Saved.')}catch(e){setSave(e.message,true)}finally{saveBtn.disabled=false}};load()})();</script>`;

const wizardModalHtml = `<div id="setupBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box"><header><h2>Setup Wizard</h2><button class="modal-close" id="setupCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><section><h3>CLIs</h3><p class="section-help">Pick which assistants this instance offers. "Auto-update" CLIs are upgraded nightly by the update timer.</p><div id="wzCliRows"></div></section><section><h3>Environment</h3><div class="env-grid"><label>Permission mode<select id="wzPermMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="wzPermHelp"></span></label><label>MCP mode<select id="wzMcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="wzMcpHelp"></span></label></div></section></div><footer><span id="saveStatus"></span><button class="button secondary" id="setupCancelBtn" type="button">Close</button><button class="button" id="setupSaveBtn" type="button">Save settings</button></footer></div></div>`;

const modalBaseCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.button{display:inline-block;background:#2563eb;color:#fff;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button:disabled{opacity:.55;cursor:not-allowed}.subtle{color:#94a3b8;font-size:.8rem}`;

const previewCss = `.modal-box.preview{max-width:1180px;height:90vh}.modal-box.preview .body{padding:0;display:flex;flex-direction:column;gap:0}.preview-toolbar{display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;border-bottom:1px solid #1f2937;background:#0b1220;flex-wrap:wrap}.preview-toolbar .pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .65rem;border-radius:999px;background:#111827;border:1px solid #334155;color:#cbd5e1;font-size:.82rem}.preview-toolbar .pill .dot{width:.55em;height:.55em;border-radius:50%;background:#64748b;box-shadow:0 0 0 .2em rgba(100,116,139,.15)}.preview-toolbar .pill.running{color:#bbf7d0;border-color:#166534}.preview-toolbar .pill.running .dot{background:#22c55e;box-shadow:0 0 0 .2em rgba(34,197,94,.25);animation:pwPulse 1.6s ease-in-out infinite}.preview-toolbar .pill.starting{color:#fde68a;border-color:#854d0e}.preview-toolbar .pill.starting .dot{background:#facc15;box-shadow:0 0 0 .2em rgba(250,204,21,.25);animation:pwPulse 1.2s ease-in-out infinite}.preview-toolbar .pill.error{color:#fecaca;border-color:#7f1d1d}.preview-toolbar .pill.error .dot{background:#ef4444}.preview-toolbar .spacer{flex:1 1 auto}.preview-toolbar .button{margin:0;padding:.45rem .8rem;font-size:.85rem}.preview-toolbar .button.icon{padding:.45rem .55rem}.preview-toolbar a.button{text-decoration:none}.preview-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;background:#0f172a}.preview-empty{display:grid;place-items:center;flex:1 1 auto;color:#94a3b8;text-align:center;padding:2rem;font-size:.95rem}.preview-empty.hidden{display:none}.preview-empty>div{max-width:780px}.preview-empty code{color:#bfdbfe;display:block;margin-top:.55rem;font-size:.8rem;background:#020617;border:1px solid #1f2937;border-radius:6px;padding:.55rem .7rem;text-align:left;white-space:pre-wrap;word-break:break-word}#previewFrame{flex:1 1 auto;width:100%;border:0;background:#fff;display:block}#previewFrame.hidden{display:none}.preview-logs{display:none;flex:0 0 auto;max-height:32%;border-top:1px solid #1f2937;background:#020617;color:#bbf7d0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.55rem .85rem;overflow:auto;white-space:pre-wrap}.preview-logs.show{display:block}.preview-logs.err{color:#fca5a5}.preview-statusline{padding:.4rem .85rem;font-size:.82rem;color:#94a3b8;border-bottom:1px solid #1f2937;background:#0b1220;display:none}.preview-statusline.show{display:block}.preview-statusline.err{color:#fca5a5}`;

const previewModalHtml = `<div id="previewBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box preview"><header><h2 id="previewTitle">Preview</h2><button class="modal-close" id="previewCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><div class="preview-toolbar"><span class="pill" id="previewPill"><span class="dot"></span><span id="previewPillLabel">checking…</span></span><span class="subtle" id="previewMeta"></span><span class="spacer"></span><button class="button" id="previewStartBtn" type="button">Start</button><button class="button secondary" id="previewRestartBtn" type="button">Restart</button><button class="button secondary" id="previewStopBtn" type="button">Stop</button><button class="button secondary" id="previewReloadBtn" type="button" title="Reload iframe">↻</button><a class="button secondary" id="previewOpenBtn" target="_blank" rel="noopener" title="Open in new tab">Open ↗</a><button class="button secondary" id="previewLogsBtn" type="button">Logs</button></div><div class="preview-statusline" id="previewStatusline"></div><div class="preview-body"><div class="preview-empty" id="previewEmpty">Preview is not running.</div><iframe id="previewFrame" class="hidden" title="Project preview"></iframe><pre class="preview-logs" id="previewLogs"></pre></div></div></div></div>`;

const previewScript = `<script>(function(){const backdrop=document.getElementById('previewBackdrop');if(!backdrop)return;const title=document.getElementById('previewTitle');const pill=document.getElementById('previewPill');const pillLabel=document.getElementById('previewPillLabel');const meta=document.getElementById('previewMeta');const startBtn=document.getElementById('previewStartBtn');const stopBtn=document.getElementById('previewStopBtn');const restartBtn=document.getElementById('previewRestartBtn');const reloadBtn=document.getElementById('previewReloadBtn');const openBtn=document.getElementById('previewOpenBtn');const logsBtn=document.getElementById('previewLogsBtn');const closeBtn=document.getElementById('previewCloseBtn');const empty=document.getElementById('previewEmpty');const frame=document.getElementById('previewFrame');const logs=document.getElementById('previewLogs');const statusline=document.getElementById('previewStatusline');let project=null;let pollTimer=null;let logsTimer=null;let lastIframeUrl='';let showingLogs=false;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatusLine(t,err){statusline.textContent=t||'';statusline.classList.toggle('show',!!t);statusline.classList.toggle('err',!!err)}function setPill(state,label){pill.classList.remove('running','starting','error');if(state)pill.classList.add(state);pillLabel.textContent=label}function setEmpty(msg){empty.innerHTML='<div>'+msg+'</div>';empty.classList.remove('hidden');frame.classList.add('hidden');if(frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}function loadIframe(url){if(lastIframeUrl===url)return;lastIframeUrl=url;empty.classList.add('hidden');frame.classList.remove('hidden');frame.src=url}async function fetchStatus(){if(!project)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');applyStatus(j)}catch(e){setStatusLine(e.message||String(e),true)}}function applyStatus(s){meta.textContent=s.port?'port '+s.port+(s.pid?' · pid '+s.pid:''):'';if(!s.configured){setPill('error','not configured');setEmpty('Preview is not configured for this project.<br><br>Open <a class="repo" href="/manage">Manage Projects</a> and set a <strong>Preview command</strong>.<br><br>Examples:<code>dotnet watch run --project ProVisionI_Portal/ProVisionI_Portal.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code>');startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;openBtn.removeAttribute('href');return}openBtn.href=s.url||'#';if(s.active&&s.ready){setPill('running','running');setStatusLine('');loadIframe(s.url);startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else if(s.active&&!s.ready){setPill('starting','waiting for port '+s.port);setStatusLine('Server unit is active; waiting for the dev server to bind to 127.0.0.1:'+s.port+'…');setEmpty('Starting… waiting for the framework to bind to port <strong>'+s.port+'</strong>.<br><span class="subtle">First boot of dotnet watch can take 10–30s.</span>');startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else{if(s.result&&s.result!=='success'){const tag=s.result==='exit-code'?('exit code '+(s.exitCode??'?')):s.result;setPill('error','exited ('+tag+')');setStatusLine('');let msg='Preview process exited ('+tag+').';if(s.lastError){msg+='<br><br>Recent log output:<code>'+escHtml(s.lastError)+'</code>'}msg+='<br>Click <strong>Start</strong> to retry:<code>'+escHtml(s.cmd||'')+'</code>';setEmpty(msg)}else{setPill('','stopped');setStatusLine('');setEmpty('Preview is stopped. Click <strong>Start</strong> to launch:<code>'+escHtml(s.cmd||'')+'</code>')}startBtn.disabled=false;stopBtn.disabled=true;restartBtn.disabled=false}}async function action(url){startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;setStatusLine('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');applyStatus(j);if(showingLogs)refreshLogs()}catch(e){setStatusLine(e.message||String(e),true)}}async function refreshLogs(){if(!project||!showingLogs)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/logs?lines=300',{cache:'no-store'});const j=await r.json();if(j.ok){logs.textContent=j.log||'(no log output yet)';logs.scrollTop=logs.scrollHeight}}catch{}}function toggleLogs(){showingLogs=!showingLogs;logs.classList.toggle('show',showingLogs);logsBtn.textContent=showingLogs?'Hide logs':'Logs';if(showingLogs){refreshLogs();logsTimer=setInterval(refreshLogs,3000)}else{clearInterval(logsTimer);logsTimer=null}}function show(name){project=name;title.textContent='Preview — '+name;showingLogs=false;logs.classList.remove('show');logs.textContent='';logsBtn.textContent='Logs';setPill('','checking…');setStatusLine('');setEmpty('Loading…');backdrop.classList.remove('hidden');fetchStatus();pollTimer=setInterval(fetchStatus,2500)}function hide(){backdrop.classList.add('hidden');project=null;if(pollTimer){clearInterval(pollTimer);pollTimer=null}if(logsTimer){clearInterval(logsTimer);logsTimer=null}if(frame.src&&frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}startBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/start');stopBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/stop');restartBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/restart');reloadBtn.onclick=()=>{if(frame.src&&frame.src!=='about:blank'){const u=frame.src;frame.src='about:blank';setTimeout(()=>{lastIframeUrl='';loadIframe(u)},50)}};logsBtn.onclick=toggleLogs;closeBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});window.pwPreview={open:show,close:hide};document.addEventListener('click',e=>{const btn=e.target.closest('[data-preview]');if(!btn)return;e.preventDefault();show(btn.dataset.preview)})})();</script>`;

const reorderScript = `<script>(function(){const btn=document.getElementById('editOrderBtn');const grid=document.querySelector('.order-grid');if(!btn||!grid)return;let editing=false;let dragSrc=null;function setEditing(on){editing=on;document.body.classList.toggle('editing-order',on);btn.classList.toggle('active',on);btn.textContent=on?'✓':'✎';grid.querySelectorAll('article[data-name]').forEach(a=>{a.draggable=on})}btn.onclick=()=>setEditing(!editing);grid.addEventListener('dragstart',e=>{if(!editing)return;const a=e.target.closest('article[data-name]');if(!a){e.preventDefault();return}dragSrc=a;a.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',a.dataset.name)}catch{}});grid.addEventListener('dragover',e=>{if(!editing||!dragSrc)return;const target=e.target.closest('article[data-name]');if(!target||target===dragSrc)return;e.preventDefault();const rect=target.getBoundingClientRect();const after=(e.clientY-rect.top)>rect.height/2;if(after)target.parentNode.insertBefore(dragSrc,target.nextSibling);else target.parentNode.insertBefore(dragSrc,target)});grid.addEventListener('dragend',async()=>{if(!editing)return;if(dragSrc)dragSrc.classList.remove('dragging');dragSrc=null;const order=[...grid.querySelectorAll('article[data-name]')].map(c=>c.dataset.name);try{await fetch('/api/projects/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})})}catch{}})})();</script>`;

app.get('/', requireAuth, async (req,res)=>{
 const allProjects = await loadProjects();
 const projects = filterProjectsForUser(allProjects, req.user);
 const cliSummary = await getInstalledCliSummary(); const updateStamp = await getClaudeUpdateStamp();
 const isAdmin = req.user.role === 'admin';
 const canOpenTerminal = TERMINAL_ROLES.has(req.user.role);
 const canUpload = INBOX_WRITE_ROLES.has(req.user.role);
 const rows = projects.map(p=>{
  const previewBtn = hasPreview(p)
   ? `<button class="button secondary" type="button" data-preview="${esc(p.name)}">Preview</button>`
   : `<button class="button secondary" type="button" data-preview="${esc(p.name)}" title="Preview command not yet configured — click to set up">Preview…</button>`;
  // Show a primary "Open terminal" for admin/developer; show a
  // primary "Drop files" for content_editor (no terminal, but they upload
  // to _inbox). viewer gets only the disabled "Terminal — restricted" label.
  // Labeled generically because a project's tmux tabs can run any CLI
  // (Claude, Codex, Copilot, plain bash, dev servers, etc.).
  const termBtn = canOpenTerminal
   ? `<a class="button" href="/term/${encodeURIComponent(p.name)}/">Open terminal</a>`
   : (canUpload
      ? `<a class="button" href="/files/${encodeURIComponent(p.name)}/">Drop files</a>`
      : `<span class="button" style="opacity:.55;cursor:not-allowed" title="Your role cannot open raw terminals">Terminal — restricted</span>`);
  return `<article data-name="${esc(p.name)}" data-project="${esc(p.name)}"><h2>${esc(p.name)} <span class="pending-dot" aria-hidden="true"></span><span class="pending-label">ready</span></h2><p><code>${esc(p.path)}</code></p><p>${termBtn} ${previewBtn}</p><p><a class="repo" href="${esc(p.repo)}" target="_blank" rel="noopener">Github Repo</a></p></article>`;
 }).join('\n');
 const noGrantsState = `<div class="empty-state"><h2>No projects assigned</h2><p>Your account (<b>${esc(req.user.username)}</b>, role: <b>${esc(req.user.role)}</b>) has no project grants yet. Ask an admin to grant access.</p></div>`;
 const step1Done = (await Promise.all(Object.keys(SUPPORTED_CLIS).map(k => getCliAuth(k)))).some(Boolean);
 const step2Done = projects.length > 0;
 const emptyState = `<div class="empty-state"><h2>Welcome to Project Workbench</h2><p>LAN-internal browser terminals backed by your AI CLI of choice. Two steps to get started:</p><div class="step"><span class="num${step1Done?' done':''}">${step1Done?'✓':'1'}</span><div class="meta"><b>Sign in your AI CLI</b><span>Authenticate Claude Code (or Codex / Copilot) and create your first user.</span></div><a class="button" href="/settings#firstrun">Open Settings</a></div><div class="step"><span class="num${step2Done?' done':''}">${step2Done?'✓':'2'}</span><div class="meta"><b>Add your first project</b><span>Clone a repo into a workspace and get a browser terminal + live preview.</span></div><a class="button" href="/manage">Manage Projects</a></div></div>`;
 const gridSection = rows
  ? `${isAdmin ? '<div class="grid-tools"><button id="editOrderBtn" class="button secondary pencilBtn tinybtn" type="button" title="Drag cards to reorder">✎ Reorder</button> <a class="button secondary tinybtn" href="/manage">Manage projects</a></div>' : ''}<div class="grid order-grid">${rows}</div>`
  : (isAdmin ? emptyState : (allProjects.length === 0 ? emptyState : noGrantsState));
 const userChip = req.user.implicit
  ? `<span class="subtle" title="PW_AUTH_ENFORCE is OFF; all requests treated as admin">anonymous (enforce off)</span>`
  : `<span class="badge" title="Role: ${esc(req.user.role)}"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span> <button id="logoutBtn" class="button secondary tinybtn" type="button">Sign out</button>`;
 const adminCta = isAdmin ? `<a class="button" href="/settings">Settings</a>` : '';
 const adminModals = isAdmin ? `${wizardModalHtml}` : '';
 const adminScripts = isAdmin ? `${reorderScript}${wizardScript}` : '';
 const logoutScript = req.user.implicit ? '' : `<script>document.getElementById('logoutBtn')?.addEventListener('click',async()=>{try{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'}})}catch{}location.href='/login'});</script>`;
 // First-run auto-launch (admin only): if claude isn't installed/signed-in or
 // no users exist, open the wizard modal on dashboard load. One-shot only.
 const firstRunScript = isAdmin
  ? `<script>(async()=>{try{const k='pw_firstrun_dismissed';if(sessionStorage.getItem(k))return;const r=await fetch('/api/system/firstrun',{cache:'no-store'});const j=await r.json();if(j?.firstRunNeeded){document.getElementById('setupBackdrop')?.classList.remove('hidden');sessionStorage.setItem(k,'1')}}catch{}})();</script>`
  : '';
 const footer = statusBarHtml({ cliSummary, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Workbench</title><style>${homeCss}${wizardCss}${previewCss}${statusBarCss}.grid-tools{display:flex;gap:.5rem;margin:.5rem 0 1rem}.hero{padding-bottom:.6rem;margin-bottom:1rem}.hero-actions{flex-direction:row!important;align-items:center!important;gap:.55rem;min-width:0!important}.hero-actions .button,.hero-actions .badge{margin:0}.hero-actions .tinybtn{margin:0}</style></head><body><header class="hero"><div><h1>Project Workbench</h1><p class="subtitle">LAN-internal browser terminals backed by your AI CLI of choice</p></div><div class="hero-actions">${userChip}${adminCta}</div></header>${gridSection}${adminModals}${previewModalHtml}<script>async function pwRefreshStatus(){try{const r=await fetch('/api/projects/status',{cache:'no-store'});const out=await r.json();if(!out?.ok)return;const map=Object.create(null);for(const p of out.projects)map[p.name]=p;document.querySelectorAll('article[data-project]').forEach(a=>{const s=map[a.dataset.project];a.classList.toggle('pending',!!(s&&s.pending))})}catch{}}pwRefreshStatus();setInterval(()=>{if(!document.hidden)pwRefreshStatus()},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pwRefreshStatus()});</script>${adminScripts}${previewScript}${logoutScript}${firstRunScript}${footer}</body></html>`);
});

app.get('/manage', requireAdmin, async (req,res)=>{
 const projects = await loadProjects(); const msg = req.query.msg ? `<p class="badge">${esc(req.query.msg)}</p>` : '';
 const placeholder = 'e.g. dotnet watch --project Foo/Foo.csproj --non-interactive --no-hot-reload run --no-launch-profile    |    npm run dev -- --host 127.0.0.1 --port ${PORT}';
 const envPlaceholder = '# one KEY=VALUE per line; lines starting with # ignored\n# ASPNETCORE_ENVIRONMENT=Development\n# DATABASE_URL=postgres://localhost/foo';
 const rows = projects.map(p=>{
  const cmd = esc(p.preview?.cmd || '');
  const previewPortVal = p.preview?.port ? esc(p.preview.port) : '';
  const envText = esc(Object.entries(p.preview?.env || {}).map(([k,v])=>`${k}=${v}`).join('\n'));
  const tabs = Array.isArray(p.tabs) ? p.tabs : [];
  const tabsJson = esc(JSON.stringify(tabs));
  const tabRows = tabs.map(t => `<div class="tab-tpl"><input type="text" class="tt-name" placeholder="Tab name" value="${esc(t.name||'')}"><input type="text" class="tt-cmd" placeholder="Optional command (typed on first session creation)" value="${esc(t.cmd||'')}"><label class="cb"><input type="checkbox" class="tt-auto"${t.autoStart?' checked':''}> auto-start</label><button type="button" class="tt-rm" title="Remove">×</button></div>`).join('');
  return `<article data-name="${esc(p.name)}"><form method="post" action="/manage/update/${encodeURIComponent(p.name)}" class="pwForm"><div class="row"><label>Name<input name="name" value="${esc(p.name)}" required></label><label>Repo<input name="repo" value="${esc(p.repo)}" required></label><label>Port<input name="port" type="number" value="${esc(p.port)}" required></label></div><div class="prow"><label>Preview command<br><span class="muted">Use <code>\${PORT}</code> and <code>\${BASEPATH}</code> (= <code>/preview/${esc(p.name)}</code>). Empty disables preview.</span><textarea name="previewCmd" rows="2" placeholder="${esc(placeholder)}">${cmd}</textarea></label><label>Preview port<input name="previewPort" type="number" value="${previewPortVal}" placeholder="auto"></label></div><div class="prow envrow"><label>Preview env<br><span class="muted">Per-project env vars exported before the cmd runs. Reserved: <code>PORT</code>, <code>BASEPATH</code>.</span><textarea name="previewEnv" rows="3" placeholder="${esc(envPlaceholder)}">${envText}</textarea></label></div><div class="prow tabrow"><label>Tab templates<br><span class="muted">Named tabs that show in the terminal's <b>+</b> dropdown. Mark <b>auto-start</b> to spawn the tab the first time this project's tmux session is created. Empty cmd = plain bash named after the tab. Cmd is typed via <code>send-keys</code> so the shell stays open after it exits.</span><div class="tab-tpls">${tabRows}</div><button type="button" class="button secondary tinybtn" data-add-tab>+ Add tab</button><input type="hidden" name="tabs" value="${tabsJson}"></label></div><p class="muted"><code>${esc(p.path)}</code></p><button class="button" type="submit">Update</button></form><form method="post" action="/manage/delete/${encodeURIComponent(p.name)}" onsubmit="return confirm('Delete ${esc(p.name)} and remove its local workspace?')"><label class="muted"><input type="checkbox" name="confirm" value="yes" required style="width:auto"> Delete local workspace content too</label><button class="button danger" type="submit">Delete project</button></form></article>`;
 }).join('\n');
 const emptyHint = projects.length === 0 ? `<p class="empty-add">No projects yet — fill in the form below to clone your first one. Workspaces live at <code>${esc(workspaceRoot)}/&lt;Name&gt;</code> and get their own browser terminal at <code>/term/&lt;Name&gt;/</code>.</p>` : '';
 const tabsScript = `<script>(function(){function rowHtml(t){t=t||{};return '<div class="tab-tpl"><input type="text" class="tt-name" placeholder="Tab name" value="'+esc(t.name||'')+'"><input type="text" class="tt-cmd" placeholder="Optional command (typed on first session creation)" value="'+esc(t.cmd||'')+'"><label class="cb"><input type="checkbox" class="tt-auto"'+(t.autoStart?' checked':'')+'> auto-start</label><button type="button" class="tt-rm" title="Remove">×</button></div>'}function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function sync(form){const tpls=form.querySelector('.tab-tpls');const hidden=form.querySelector('input[name=tabs]');if(!tpls||!hidden)return;const arr=[];tpls.querySelectorAll('.tab-tpl').forEach(r=>{const n=r.querySelector('.tt-name').value.trim();if(!n)return;arr.push({name:n,cmd:r.querySelector('.tt-cmd').value,autoStart:r.querySelector('.tt-auto').checked})});hidden.value=JSON.stringify(arr)}document.querySelectorAll('form.pwForm').forEach(form=>{const tpls=form.querySelector('.tab-tpls');const addBtn=form.querySelector('[data-add-tab]');if(tpls){tpls.addEventListener('input',()=>sync(form));tpls.addEventListener('change',()=>sync(form));tpls.addEventListener('click',e=>{const rm=e.target.closest('.tt-rm');if(rm){rm.closest('.tab-tpl').remove();sync(form)}})}if(addBtn){addBtn.addEventListener('click',()=>{tpls.insertAdjacentHTML('beforeend',rowHtml({autoStart:true}));tpls.lastElementChild.querySelector('.tt-name').focus()})}form.addEventListener('submit',()=>sync(form))})})();</script>`;
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Projects</title><style>${homeCss}</style></head><body><div class="top"><h1>Manage Projects</h1><a class="button secondary" href="/">Dashboard</a></div>${msg}${emptyHint}<article><h2>Add project</h2><form method="post" action="/manage/add"><div class="row"><label style="position:relative">Name<input name="name" id="projNameInput" placeholder="RepoName" required pattern="[A-Za-z0-9._-]+" oninput="this.parentElement.querySelector('.val-hint').textContent=/^[A-Za-z0-9._-]*$/.test(this.value)?'':'Use letters, digits, dot, dash, or underscore only (no spaces)';this.parentElement.querySelector('.val-hint').className='val-hint'+((/^[A-Za-z0-9._-]*$/.test(this.value))?'':' err')"><span class="val-hint"></span></label><label>Repo URL<input name="repo" placeholder="https://github.com/owner/RepoName.git" required></label><label>Port<input name="port" type="number" placeholder="auto"></label><button class="button" type="submit">Add + clone</button></div><p class="muted">Configure preview and tab templates after the project is added.</p></form></article><div class="grid manage-grid">${rows}</div>${tabsScript}</body></html>`);
});

app.post('/manage/add', requireAdmin, async (req,res,next)=>{ try {
 const name = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim();
 if(!validName(name)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!repo) throw new Error('Repository URL is required');
 await withProjectsLock(async () => {
  const projects = await loadProjects();
  if(projects.some(p=>p.name===name)) throw new Error('A project named "'+name+'" already exists');
  const port = Number(req.body.port) || nextPort(projects);
  if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
  if(allUsedPorts(projects).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
  const p = { name, repo, path: workspacePath(name), port };
  await cloneWorkspace(p); projects.push(p); await saveProjects(projects); await applyRouting(projects); await startProject(p);
 });
 await audit('project_add', { project: name, port: Number(req.body.port) || null, repo }, req);
 res.redirect('/manage?msg='+encodeURIComponent(`Added ${name}`));
 } catch(e){ next(e); }});

app.post('/manage/update/:oldName', requireAdmin, async (req,res,next)=>{ try {
 const oldName = req.params.oldName; const newName = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim(); const port = Number(req.body.port);
 const previewCmd = String(req.body.previewCmd || '').trim();
 const previewPortRaw = String(req.body.previewPort || '').trim();
 const previewEnvRaw = String(req.body.previewEnv || '');
 if(!validName(newName)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!repo) throw new Error('Repository URL is required');
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
 await stopProject(oldName); const oldPath = p.path; p.name = newName; p.repo = repo; p.port = port; p.path = workspacePath(newName);
 if(previewBlock) p.preview = previewBlock; else delete p.preview;
 if(tabs.length) p.tabs = tabs; else delete p.tabs;
 if(oldPath !== p.path){ try { await fs.rename(oldPath,p.path); } catch { /* absent workspace is okay */ } }
 await saveProjects(projects); await applyRouting(projects); await startProject(p);
 });
 await audit('project_update', { oldName, newName, port }, req);
 res.redirect('/manage?msg='+encodeURIComponent(`Updated ${newName}`));
 } catch(e){ next(e); }});

app.post('/manage/delete/:name', requireAdmin, async (req,res,next)=>{ try {
 if(req.body.confirm !== 'yes') throw new Error('Delete confirmation required'); const name = req.params.name;
 await withProjectsLock(async () => {
  const projects = await loadProjects(); const idx = projects.findIndex(p=>p.name===name); if(idx<0) throw new Error('Project not found'); const [p] = projects.splice(idx,1);
  await stopProject(name); await removeWorkspace(p); await saveProjects(projects); await applyRouting(projects);
 });
 await audit('project_delete', { project: name }, req);
 res.redirect('/manage?msg='+encodeURIComponent(`Deleted ${name} and removed local workspace`));
 } catch(e){ next(e); }});

app.get('/api/projects/status', requireAuth, async (req,res)=>{ try {
 const all = await loadProjects();
 const projects = filterProjectsForUser(all, req.user);
 const out = await Promise.all(projects.map(async p => ({ name: p.name, ...(await readPending(p)) })));
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
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); const projectJson = JSON.stringify(p.name);
 const tabPresetsJson = JSON.stringify(Array.isArray(p.tabs) ? p.tabs : []);
 await clearPending(p);
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} terminal</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1f1f1f;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}body{display:flex;flex-direction:column;position:relative}iframe{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;background:#1f1f1f}#trayShield{position:absolute;left:0;right:0;top:34px;bottom:0;background:transparent;z-index:5;display:none;cursor:pointer}body.shade-open #trayShield{display:block}#topBar{flex:0 0 34px;width:100%;height:34px;background:linear-gradient(180deg,rgba(15,23,42,.96),rgba(15,23,42,.82));color:#dbeafe;border-bottom:1px solid #334155;font:13px system-ui;box-shadow:0 2px 10px #0008;display:flex;align-items:center;justify-content:space-between;gap:8px;letter-spacing:.01em;padding:0 14px;box-sizing:border-box}.leftInfo{display:flex;align-items:center;gap:12px;min-width:0}.backLink{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:3px 9px;background:#0f172a}.backLink:hover{background:#1e293b;color:#fff}.projectInfo{font-weight:700;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fileInfo{color:#dbeafe;font-weight:500}#fileBtn{background:transparent;border:0;color:#dbeafe;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;padding:4px 0}#fileBtn:hover{color:#fff}#fileBtn::before{content:'⬇'}body.shade-open #fileBtn::before{content:'⬆'}#tray{position:absolute;left:0;right:0;top:34px;z-index:10;background:rgba(15,23,42,.98);color:#e5e7eb;border-bottom:1px solid #334155;box-shadow:0 12px 28px rgba(0,0,0,.55);padding:14px 18px 16px;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"header header" "list dropzone" "status status";gap:12px;align-items:stretch;max-height:calc(100vh - 34px - 16px);overflow:auto;transform:translateY(-100%);opacity:0;pointer-events:none;transition:transform .28s cubic-bezier(.4,0,.2,1),opacity .18s ease;will-change:transform,opacity}#inboxHeader{grid-area:header}#inboxList{grid-area:list}#drop,#preview{grid-area:dropzone}#status{grid-area:status}body.has-preview #drop{display:none}body:not(.has-preview) #preview{display:none}@media(max-width:640px){#tray{grid-template-columns:1fr;grid-template-areas:"header" "dropzone" "list" "status"}#topBar{padding:0 8px;gap:6px}.leftInfo{gap:6px;min-width:0}.backLink{padding:3px 7px;font-size:12px}.projectInfo{display:none}.previewBtn{padding:3px 9px;font-size:12px;margin-right:4px}.fileInfo{display:none}#fileBtn{font-size:18px;padding:4px 6px}.tabStrip{padding:0 4px;gap:3px}.tabStrip .tab{max-width:140px;padding:2px 6px}.tabStrip .tab .name{max-width:100px}.tabStrip .newTab{padding:1px 7px;font-size:13px}}body.shade-open #tray{transform:translateY(0);opacity:1;pointer-events:auto}#drop{border:2px dashed #64748b;border-radius:14px;padding:30px 18px;text-align:center;background:#111827;outline:none;cursor:pointer;min-height:130px;display:flex;flex-direction:column;justify-content:center;width:100%;box-sizing:border-box}#status{white-space:pre-wrap;color:#94a3b8;font-size:13px;line-height:1.35}button,label{font:inherit}.close{display:none}code{color:#bfdbfe}img{max-width:100%;max-height:380px;border-radius:8px;margin-top:0;border:1px solid #334155;display:block}.previewItem{position:relative;display:inline-block;max-width:100%}.previewItem a{display:block}.previewClear{position:absolute;top:6px;right:6px;background:rgba(15,23,42,.9);border:1px solid #334155;color:#fca5a5;border-radius:50%;width:26px;height:26px;line-height:22px;text-align:center;font-size:16px;cursor:pointer;padding:0;font-family:inherit}.previewClear:hover{background:#0f172a;color:#fff;border-color:#94a3b8}.tabStrip{flex:1 1 auto;display:flex;align-items:center;gap:4px;overflow-x:auto;min-width:0;padding:0 10px;scrollbar-width:thin}.tabStrip::-webkit-scrollbar{height:6px}.tabStrip::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}.tabStrip .tab{display:inline-flex;align-items:center;gap:4px;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:3px 8px;color:#cbd5e1;cursor:pointer;font-size:12px;line-height:1.4;white-space:nowrap;user-select:none;max-width:180px;flex:0 0 auto}.tabStrip .tab:hover{background:#1e293b;color:#fff}.tabStrip .tab.active{background:#1e3a8a;border-color:#3b82f6;color:#fff}.tabStrip .tab .name{overflow:hidden;text-overflow:ellipsis;max-width:140px;cursor:pointer}.tabStrip .tab.active .name{cursor:text}.tabStrip .tab .name.editing{outline:1px solid #60a5fa;background:#0f172a;border-radius:3px;padding:0 4px;max-width:none;cursor:text}.inboxHeader{display:flex;justify-content:space-between;align-items:center;color:#cbd5e1;font-size:12px;letter-spacing:.02em;margin-top:2px;min-height:22px}.inboxHeader .clear{font-size:12px;color:#fca5a5;background:transparent;border:1px solid #4b5563;border-radius:6px;padding:3px 8px;cursor:pointer}.inboxHeader .clear:hover{background:#1f2937;color:#fff;border-color:#94a3b8}.inboxList{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;border-top:1px solid #1f2937;padding-top:6px;margin:0;scrollbar-width:thin}.inboxList::-webkit-scrollbar{width:6px}.inboxList::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}.inboxList .row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;background:#0f172a;border:1px solid transparent}.inboxList .row:hover{background:#1e293b;border-color:#334155}.inboxList .thumb{width:36px;height:36px;background:#1f2937;border-radius:4px;display:flex;align-items:center;justify-content:center;flex:0 0 36px;overflow:hidden;color:#64748b;font-size:11px;font-weight:600}.inboxList .thumb img{width:100%;height:100%;object-fit:cover;border-radius:4px;border:0;margin:0;max-height:none}.inboxList .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}.inboxList .nameCol .name{font-size:12px;color:#e5e7eb;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.inboxList .nameCol .meta{font-size:11px;color:#94a3b8}.inboxList .del{flex:0 0 auto;color:#fca5a5;background:transparent;border:0;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px;font-family:inherit}.inboxList .del:hover{background:#1f2937;color:#fff}#pwHoverPreview{position:fixed;z-index:9999;pointer-events:none;background:#0f172a;border:1px solid #475569;border-radius:8px;padding:6px;box-shadow:0 14px 36px rgba(0,0,0,.7);display:none;max-width:440px}#pwHoverPreview img{display:block;max-width:420px;max-height:420px;border-radius:4px;border:0;margin:0}#pwHoverPreview .card{padding:14px;color:#cbd5e1;font:13px system-ui;max-width:320px;word-break:break-all;line-height:1.45}#pwHoverPreview .card .meta{margin-top:6px;color:#94a3b8;font-size:11px}.tabStrip .tab .x{opacity:.55;font-size:14px;line-height:1;padding:0 3px;border-radius:3px}.tabStrip .tab .x:hover{opacity:1;color:#fca5a5;background:#0f172a}.tabStrip .newTab{background:transparent;border:1px dashed #475569;color:#94a3b8;cursor:pointer;padding:2px 8px;border-radius:6px;font-size:14px;line-height:1.2;flex:0 0 auto}.tabStrip .newTab:hover{color:#fff;border-color:#94a3b8}.tabMenu{position:fixed;z-index:9999;background:#0f172a;border:1px solid #334155;border-radius:8px;box-shadow:0 14px 36px rgba(0,0,0,.65);padding:.35rem;min-width:220px;max-width:380px;display:flex;flex-direction:column;gap:2px;font:13px system-ui,-apple-system,Segoe UI,sans-serif}.tabMenuItem{background:transparent;border:0;color:#e5e7eb;text-align:left;padding:.45rem .6rem;border-radius:6px;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:2px}.tabMenuItem:hover{background:#1e293b}.tabMenuItem .ti-name{font-weight:600;color:#f8fafc}.tabMenuItem .ti-cmd{color:#94a3b8;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}.tabMenuItem.blank{border-top:1px solid #1f2937;margin-top:2px;padding-top:.5rem;color:#cbd5e1}.tabMenuItem.empty{color:#64748b;font-style:italic;cursor:default}.tabMenuItem.empty:hover{background:transparent}.previewBtn{background:transparent;border:1px solid #334155;color:#bfdbfe;border-radius:999px;padding:3px 11px;cursor:pointer;font:inherit;margin-right:8px;letter-spacing:.02em}.previewBtn:hover{background:#1e293b;color:#fff;border-color:#94a3b8}${modalBaseCss}${previewCss}</style></head><body><div id="topBar"><div class="leftInfo"><a class="backLink" href="/">← Back</a><span class="projectInfo">Project: ${esc(p.name)}</span></div><div id="tabStrip" class="tabStrip"></div><button class="previewBtn" type="button" data-preview="${esc(p.name)}" title="Open live preview window">Preview</button><button id="fileBtn" type="button" title="Open file shade"><span class="fileInfo">Files / paste or drop into project</span></button></div><div id="tray"><div id="drop" tabindex="0"><div>Paste/drop/select files here</div><div style="color:#94a3b8;margin-top:6px">PDF, txt, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status">Saved files go to <code>${esc(p.path)}/_inbox</code>. The path will be inserted into the terminal.</div><div id="preview"></div><div id="inboxHeader" class="inboxHeader"></div><div id="inboxList" class="inboxList"></div><button class="close" id="close">Close</button></div><div id="trayShield" aria-hidden="true"></div><iframe id="term" src="/pty/${encodeURIComponent(p.name)}/"></iframe><script>const project=${projectJson};const tabPresets=${tabPresetsJson};const tray=document.getElementById('tray'),drop=document.getElementById('drop'),file=document.getElementById('file'),status=document.getElementById('status'),preview=document.getElementById('preview'),inboxHeader=document.getElementById('inboxHeader'),inboxList=document.getElementById('inboxList'),frame=document.getElementById('term');let previewTimer=null;const hoverPanel=Object.assign(document.createElement('div'),{id:'pwHoverPreview'});document.body.appendChild(hoverPanel);function setStatus(t,bad=false){status.textContent=t;status.style.color=bad?'#fca5a5':'#bbf7d0'}function clearPreview(){preview.innerHTML='';document.body.classList.remove('has-preview');setStatus('');if(previewTimer){clearTimeout(previewTimer);previewTimer=null}}function showPreview(url,name,isImage){if(!url&&!name)return clearPreview();if(previewTimer){clearTimeout(previewTimer);previewTimer=null}document.body.classList.add('has-preview');const safeName=escHtml(name||'file');if(isImage&&url){preview.innerHTML='<div class="previewItem"><a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+safeName+'"></a><button class="previewClear" type="button" title="Clear preview">×</button></div>'}else{preview.innerHTML='<div class="previewItem"><div style="padding:18px;border:1px solid #334155;border-radius:8px;color:#cbd5e1;text-align:center;display:flex;align-items:center;justify-content:center;min-height:130px;word-break:break-all;background:#111827">'+safeName+'</div><button class="previewClear" type="button" title="Clear preview">×</button></div>'}preview.querySelector('.previewClear').onclick=clearPreview;previewTimer=setTimeout(closeTray,15000)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function refreshInbox(){try{const r=await fetch('/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const out=await r.json();if(!out?.ok){inboxHeader.innerHTML='';inboxList.innerHTML='';return}const files=out.files||[];if(files.length===0){inboxHeader.innerHTML='<span>No saved files yet.</span>';inboxList.innerHTML='';return}inboxHeader.innerHTML='<span>'+files.length+' saved file'+(files.length===1?'':'s')+' — click a row to insert its path</span><button class="clear" type="button">Clear all</button>';inboxHeader.querySelector('.clear').onclick=async()=>{if(!confirm('Delete all '+files.length+' files in this project\\'s inbox?'))return;await fetch('/api/inbox/'+encodeURIComponent(project),{method:'DELETE'});refreshInbox()};inboxList.innerHTML='';for(const f of files){const row=document.createElement('div');row.className='row';row.title='Click to insert path: '+f.path;const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);row.innerHTML='<div class="thumb">'+(isImg?'<img src="'+f.url+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+escHtml(f.name)+'</div><div class="meta">'+fmtSize(f.size)+'</div></div><button class="del" type="button" title="Delete">×</button>';row.onclick=ev=>{if(ev.target.closest('.del'))return;if(insertPath(f.path)){setStatus('Inserted:\\n'+f.path)}else{setStatus('Could not insert (no terminal focus)',true)}};row.onmouseenter=()=>{hoverPanel.innerHTML=isImg?'<img src="'+f.url+'">':'<div class="card">'+escHtml(f.name)+'<div class="meta">'+fmtSize(f.size)+'</div></div>';hoverPanel.style.display='block';const rct=row.getBoundingClientRect(),pw=hoverPanel.offsetWidth,ph=hoverPanel.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;let lf=rct.right+10;if(lf+pw>vw-8)lf=Math.max(8,rct.left-pw-10);let tp=rct.top-4;if(tp+ph>vh-8)tp=Math.max(8,vh-ph-8);if(tp<8)tp=8;hoverPanel.style.left=lf+'px';hoverPanel.style.top=tp+'px'};row.onmouseleave=()=>{hoverPanel.style.display='none'};row.querySelector('.del').onclick=async ev=>{ev.stopPropagation();hoverPanel.style.display='none';await fetch('/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(f.name),{method:'DELETE'});refreshInbox()};inboxList.appendChild(row)}}catch{}}function openTray(msg){document.body.classList.add('shade-open');setTimeout(()=>drop.focus(),50);if(msg)setStatus(msg);refreshInbox()}function closeTray(){document.body.classList.remove('shade-open');clearPreview();focusTerminal()}function focusTerminal(){try{const ta=frame.contentDocument?.querySelector('textarea.xterm-helper-textarea');if(ta){ta.focus();return}}catch{}try{frame.contentWindow?.focus()}catch{}}function toggleTray(){document.body.classList.contains('shade-open')?closeTray():openTray()}document.getElementById('fileBtn').onclick=toggleTray;document.getElementById('close').onclick=closeTray;document.getElementById('trayShield').onclick=closeTray;function insertPath(path){try{if(frame.contentWindow.__pwSendToTerminal?.(path))return true}catch{}try{const ta=frame.contentDocument.querySelector('textarea.xterm-helper-textarea')||frame.contentDocument.querySelector('textarea');if(!ta)return false;ta.focus();const dt=new DataTransfer();dt.setData('text/plain',path);ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true}catch{return false}}async function upload(blob,name='clipboard-file'){if(!blob)return setStatus('No file received.',true);setStatus('Saving file...');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const res=await fetch('/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name,mime:blob.type||'application/octet-stream',data})});const out=await res.json().catch(()=>null);if(!res.ok||!out?.ok)throw new Error(out?.error||'Upload failed');const ok=insertPath(out.path);try{await navigator.clipboard.writeText(out.path)}catch{}showPreview(out.url,name||'file',(blob.type||'').startsWith('image/'));setStatus('Saved and '+(ok?'inserted':'copied')+':\\n'+out.path);refreshInbox()}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name).catch(e=>setStatus(e.message||String(e),true));drop.addEventListener('dragover',e=>{e.preventDefault();drop.style.borderColor='#60a5fa'});drop.addEventListener('dragleave',()=>drop.style.borderColor='#64748b');/* drop handler removed — the window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads because e.preventDefault() stops the browser default but not other listeners. */window.addEventListener('paste',e=>{const items=[...(e.clipboardData?.items||[])];const item=items.find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();openTray('Saving pasted file...');upload(f,f?.name||'clipboard-file').catch(err=>setStatus(err.message||String(err),true))},true);let dragDepth=0;window.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();dragDepth++;openTray('Drop files here to save them into _inbox.')}},true);window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.style.borderColor='#60a5fa'}},true);window.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)drop.style.borderColor='#64748b'}},true);window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();dragDepth=0;drop.style.borderColor='#64748b';openTray();upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name).catch(err=>setStatus(err.message||String(err),true))}},true);window.addEventListener('message',e=>{const d=e.data;if(!d||typeof d!=='object')return;if(d.type==='pw-open-image-tray'){openTray(d.message||'Paste the file here.')}else if(d.type==='pw-paste-saved'){openTray();const base=(d.path||'').split('/').pop()||'file';showPreview(d.url,base,/\\.(png|jpe?g|webp|gif|bmp)$/i.test(base));setStatus('Saved and inserted:\\n'+d.path);refreshInbox()}else if(d.type==='pw-paste-error'){openTray();setStatus('Paste failed: '+d.error,true)}});const tabStrip=document.getElementById('tabStrip');const tabsBase='/api/term/'+encodeURIComponent(project)+'/windows';let lastTabsKey='';let editingIdx=null;let editAfterRender=false;function startEdit(label,w){editingIdx=w.index;const original=label.textContent;label.contentEditable='true';label.classList.add('editing');label.focus();const sel=window.getSelection();const range=document.createRange();range.selectNodeContents(label);sel.removeAllRanges();sel.addRange(range);let done=false;const finish=async save=>{if(done)return;done=true;label.contentEditable='false';label.classList.remove('editing');label.removeEventListener('keydown',onKey);label.removeEventListener('blur',onBlur);const next=label.textContent.trim();editingIdx=null;if(save&&next&&next!==w.name){try{await fetch(tabsBase+'/'+w.index+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:next})})}catch{}lastTabsKey='';refreshTabs()}else if(!save){label.textContent=original}};const onKey=ev=>{if(ev.key==='Enter'){ev.preventDefault();finish(true)}else if(ev.key==='Escape'){ev.preventDefault();finish(false)}};const onBlur=()=>finish(true);label.addEventListener('keydown',onKey);label.addEventListener('blur',onBlur)}function closeTabMenu(){document.querySelector('.tabMenu')?.remove();document.removeEventListener('click',closeTabMenu,true);document.removeEventListener('keydown',tabMenuKey,true)}function tabMenuKey(e){if(e.key==='Escape')closeTabMenu()}async function spawnTab(name,cmd){editAfterRender=!name;await fetch(tabsBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name||'new task',cmd:cmd||''})});lastTabsKey='';refreshTabs()}function openTabMenu(anchor,windows){closeTabMenu();const menu=document.createElement('div');menu.className='tabMenu';menu.addEventListener('click',e=>e.stopPropagation());const existing=new Set((windows||[]).map(w=>w.name));const usable=(tabPresets||[]).filter(t=>t&&t.name&&!existing.has(t.name));for(const t of usable){const item=document.createElement('button');item.type='button';item.className='tabMenuItem';item.innerHTML='<span class="ti-name">'+escHtml(t.name)+'</span>'+(t.cmd?'<span class="ti-cmd">'+escHtml(t.cmd)+'</span>':'');item.onclick=()=>{spawnTab(t.name,t.cmd||'');closeTabMenu()};menu.appendChild(item)}if(usable.length===0&&(tabPresets||[]).length>0){const note=document.createElement('div');note.className='tabMenuItem empty';note.textContent='All tab templates are already open';menu.appendChild(note)}const blank=document.createElement('button');blank.type='button';blank.className='tabMenuItem blank';blank.innerHTML='<span class="ti-name">+ Blank tab</span><span class="ti-cmd">plain bash, name it after creation</span>';blank.onclick=()=>{spawnTab('','');closeTabMenu()};menu.appendChild(blank);document.body.appendChild(menu);const r=anchor.getBoundingClientRect();const mw=menu.offsetWidth||220;let lf=r.left;if(lf+mw>window.innerWidth-8)lf=Math.max(8,window.innerWidth-mw-8);menu.style.left=lf+'px';menu.style.top=(r.bottom+4)+'px';setTimeout(()=>{document.addEventListener('click',closeTabMenu,true);document.addEventListener('keydown',tabMenuKey,true)},0)}async function refreshTabs(){if(editingIdx!=null)return;try{const r=await fetch(tabsBase,{cache:'no-store'});const out=await r.json();if(!out?.ok){tabStrip.innerHTML='';lastTabsKey='';return}const key=JSON.stringify(out.windows);if(key===lastTabsKey)return;lastTabsKey=key;renderTabs(out.windows)}catch{}}function renderTabs(windows){tabStrip.innerHTML='';for(const w of windows){const tab=document.createElement('div');tab.className='tab'+(w.active?' active':'');tab.title=w.active?'Click name to rename':'Window '+w.index+': '+(w.name||'');const label=document.createElement('span');label.className='name';label.textContent=w.name||('#'+w.index);label.onclick=ev=>{if(!w.active)return;ev.stopPropagation();startEdit(label,w)};tab.appendChild(label);if(windows.length>1){const x=document.createElement('span');x.className='x';x.textContent='×';x.title='Close window';x.onclick=async ev=>{ev.stopPropagation();if(!confirm('Close window "'+(w.name||w.index)+'"? Any running process in it will be killed.'))return;await fetch(tabsBase+'/'+w.index,{method:'DELETE'});lastTabsKey='';refreshTabs()};tab.appendChild(x)}tab.onclick=async()=>{if(w.active)return;await fetch(tabsBase+'/'+w.index+'/select',{method:'POST'});lastTabsKey='';refreshTabs()};tabStrip.appendChild(tab)}const plus=document.createElement('button');plus.className='newTab';plus.textContent='+';plus.title='New tab';plus.onclick=ev=>{ev.stopPropagation();openTabMenu(plus,windows)};tabStrip.appendChild(plus);if(editAfterRender){editAfterRender=false;const ai=windows.find(w=>w.active);if(ai){const tabs=tabStrip.querySelectorAll('.tab');const i=windows.indexOf(ai);const lbl=tabs[i]?.querySelector('.name');if(lbl)startEdit(lbl,ai)}}}refreshTabs();setInterval(()=>{if(!document.hidden)refreshTabs()},2000);async function pwHeartbeat(){if(document.hidden)return;try{await fetch('/api/projects/'+encodeURIComponent(project)+'/clear-pending',{method:'POST'})}catch{}}pwHeartbeat();setInterval(pwHeartbeat,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pwHeartbeat()});</script>${previewModalHtml}${previewScript}</body></html>`);
});

// Lightweight /files/<name>/ page: drop tray + inbox list, no terminal iframe.
// Lets content_editor (and other inbox-write roles) drop files into a project's
// _inbox without granting raw shell. Hand-off path for the planned PVIKPBot
// content workflow.
app.get('/files/:project/', requireInboxWrite, async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project');
 const cliSummary = await getInstalledCliSummary();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ cliSummary, updateStamp, user: req.user, enforce: AUTH_ENFORCE }); = JSON.stringify(p.name);
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Files</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;background:#0f172a;color:#e5e7eb}.f-header{display:flex;align-items:center;gap:1rem;padding:.95rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.f-header h1{margin:0;font-size:1.15rem}.f-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.f-header .back:hover{background:#1e293b;color:#fff}.f-header .grow{flex:1}.f-header .who{font-size:.85rem;color:#cbd5e1}.f-main{max-width:920px;margin:1.5rem auto;padding:0 1.5rem 3rem}.f-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.f-card h2{margin:0 0 .25rem;font-size:1.1rem;color:#bfdbfe}.f-card .muted{color:#94a3b8;font-size:.85rem;margin:.15rem 0 0}#drop{border:2px dashed #64748b;border-radius:14px;padding:42px 18px;text-align:center;background:#0b1220;cursor:pointer;color:#cbd5e1;font-size:.95rem;margin-top:.75rem}#drop:hover{background:#152033;border-color:#94a3b8}#drop.over{border-color:#60a5fa;background:#152033}#drop .hint{color:#94a3b8;font-size:.82rem;margin-top:.4rem}#status{margin-top:.65rem;font-size:.85rem;color:#bbf7d0;white-space:pre-wrap;min-height:1.3em}#status.err{color:#fca5a5}.ilist{display:flex;flex-direction:column;gap:.35rem;margin-top:.5rem}.irow{display:flex;align-items:center;gap:.65rem;padding:.5rem .65rem;background:#0b1220;border:1px solid #1f2937;border-radius:8px}.irow .thumb{width:36px;height:36px;background:#1f2937;border-radius:4px;flex:0 0 36px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:11px;font-weight:600;overflow:hidden}.irow .thumb img{width:100%;height:100%;object-fit:cover}.irow .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}.irow .nameCol .name{color:#e5e7eb;font-size:.88rem;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.irow .nameCol .meta{color:#94a3b8;font-size:.75rem}.irow .copyBtn,.irow .del,.irow a{background:transparent;border:1px solid #334155;color:#cbd5e1;border-radius:6px;padding:3px 9px;font-size:.78rem;cursor:pointer;text-decoration:none}.irow .copyBtn:hover,.irow a:hover{background:#1e293b;color:#fff}.irow .del{color:#fca5a5;border-color:#7f1d1d}.irow .del:hover{background:#7f1d1d;color:#fff}.empty{color:#94a3b8;font-style:italic;font-size:.85rem;padding:.75rem 0}${statusBarCss}</style></head><body><header class="f-header"><a class="back" href="/">← Dashboard</a><h1>Files — ${esc(p.name)}</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><main class="f-main"><div class="f-card"><h2>Drop or paste files</h2><p class="muted">Saved files go to <code>${esc(p.path)}/_inbox</code>. Click <b>Copy path</b> to grab the absolute path and hand it to whatever consumes the inbox (Claude conversation, PVIKPBot, etc.).</p><div id="drop" tabindex="0">Drop files here, paste from clipboard, or click to pick<div class="hint">PDF, text, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status"></div></div><div class="f-card"><h2>Inbox</h2><div class="ilist" id="ilist"><div class="empty">Loading…</div></div></div></main>${footer}<script>const project=${projectJson};const drop=document.getElementById('drop');const file=document.getElementById('file');const status=document.getElementById('status');const ilist=document.getElementById('ilist');function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatus(t,err){status.textContent=t||'';status.classList.toggle('err',!!err)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}async function refreshInbox(){try{const r=await fetch('/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const j=await r.json();if(!j.ok){ilist.innerHTML='<div class="empty">'+esc(j.error||'failed')+'</div>';return}const files=j.files||[];if(!files.length){ilist.innerHTML='<div class="empty">No saved files yet.</div>';return}ilist.innerHTML=files.map(f=>{const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);return '<div class="irow" data-n="'+esc(f.name)+'" data-p="'+esc(f.path)+'"><div class="thumb">'+(isImg?'<img src="'+esc(f.url)+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+esc(f.name)+'</div><div class="meta">'+fmtSize(f.size)+' · '+esc(f.mtime||'')+'</div></div><a href="'+esc(f.url)+'" target="_blank" rel="noopener">Open</a><button class="copyBtn" type="button">Copy path</button><button class="del" type="button">Delete</button></div>'}).join('')}catch(e){ilist.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}ilist.addEventListener('click',async e=>{const row=e.target.closest('.irow');if(!row)return;if(e.target.classList.contains('del')){if(!confirm('Delete "'+row.dataset.n+'"?'))return;const r=await fetch('/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(row.dataset.n),{method:'DELETE'});const j=await r.json();setStatus(j.ok?'Deleted '+row.dataset.n:'Error: '+j.error,!j.ok);refreshInbox()}else if(e.target.classList.contains('copyBtn')){try{await navigator.clipboard.writeText(row.dataset.p);setStatus('Copied path: '+row.dataset.p)}catch(err){setStatus('Could not copy: '+err.message,true)}}});async function upload(blob,name){if(!blob){setStatus('No file received.',true);return}setStatus('Saving '+(name||'file')+'…');try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const r=await fetch('/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name||'clipboard-file',mime:blob.type||'application/octet-stream',data})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Upload failed');try{await navigator.clipboard.writeText(j.path)}catch{}setStatus('Saved and path copied to clipboard:\\n'+j.path);refreshInbox()}catch(e){setStatus(e.message||String(e),true)}}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name);['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));['dragleave','dragend'].forEach(ev=>drop.addEventListener(ev,()=>drop.classList.remove('over')));/* drop handler removed — window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads. */window.addEventListener('paste',e=>{const item=[...(e.clipboardData?.items||[])].find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();upload(f,f?.name||'clipboard-file')},true);['dragenter','dragover'].forEach(ev=>window.addEventListener(ev,e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.classList.add('over')}},true));window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();drop.classList.remove('over');upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name)}},true);refreshInbox();</script></body></html>`);
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

app.post('/api/setup/heal/nginx', requireAdmin, async (_req,res)=>{ try {
 const projects = await loadProjects();
 await applyRouting(projects);
 res.json({ ok:true, message:`Regenerated nginx config from projects.json (${projects.length} project route${projects.length===1?'':'s'} + /pty/_setup/) and reloaded nginx.` });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/heal/dirs', requireAdmin, async (_req,res)=>{ try {
 const steps = [];
 for(const d of [pendingDir,'/etc/project-workbench','/opt/project-workbench/workspaces','/opt/project-workbench/memory']){
  await fs.mkdir(d,{recursive:true}); steps.push(`ok dir: ${d}`);
 }
 // Ensure workspaces is writable by admin (git clone runs as admin)
 await sh('chmod',['755','/opt/project-workbench']).catch(()=>{});
 await sh('chown',['admin:admin','/opt/project-workbench/workspaces']).catch(()=>{});
 await sh('chmod',['755','/opt/project-workbench/workspaces']).catch(()=>{});
 steps.push('chmod 755 /opt/project-workbench + chown admin:admin workspaces');
 try { await fs.access(emptyMcpPath); steps.push(`ok file: ${emptyMcpPath}`); }
 catch { await fs.writeFile(emptyMcpPath,'{}\n'); steps.push(`created: ${emptyMcpPath}`); }
 await syncWrapperEnv(await loadWorkbenchSettings()); steps.push(`refreshed: ${wrapperEnvPath}`);
 try { await fs.access('/usr/local/bin/claude'); steps.push('ok wrapper: /usr/local/bin/claude'); }
 catch { steps.push('MISSING /usr/local/bin/claude — run update-claude-code to reinstall'); }
 await sh('systemctl',['enable','--now','project-setup-terminal.service']).catch(()=>{});
 steps.push('enabled+started: project-setup-terminal.service');
 res.json({ ok:true, message: steps.join('\n') });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

function explainCliInstallError(e){
 const detail = trimmedOutput(combinedOutput(e));
 if(/ENOENT/i.test(detail) && /npm/i.test(detail)) return 'npm is not installed or not on PATH for the dashboard service.';
 if(/ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|network/i.test(detail)){
  return ['npm could not reach the registry.', !process.env.HOME ? dashboardHomeFixHint('HOME is not set for the Project Workbench service.') : 'If HOME is already set, verify outbound proxy/firewall access from the systemd service.', 'Try `npm ping` from the same service context after fixing HOME/network access.'].filter(Boolean).join('\n\n');
 }
 if(!process.env.HOME && /HOME|cache|prefix|permission|EACCES/i.test(detail)) return dashboardHomeFixHint('HOME is not set for the Project Workbench service.');
 return detail || (e?.message || String(e));
}
app.post('/api/setup/cli/install', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const npmEnv = { ...process.env, HOME: process.env.HOME || '/root' };
 const { stdout, stderr } = await sh('npm',['install','-g',`${cfg.pkg}@latest`],{timeout:300000, env:npmEnv});
 const version = await getCliVersion(cfg.bin);
 res.json({ ok:true, version: version || 'not installed', log:(stdout+stderr).slice(-1500) });
} catch(e){ res.status(500).json({ok:false,error:explainCliInstallError(e)}); }});

app.post('/api/setup/cli/auth', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const ready = await ensureSetupTerminal();
 if(!ready.ok) return res.status(503).json({ok:false,error:ready.error});
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
function statusBarHtml({ cliSummary, updateStamp, user, enforce }){
 const u = user && !user.implicit
  ? `<span class="sb-user"><b>${esc(user.username)}</b> · ${esc(user.role)}</span>`
  : `<span class="sb-user subtle">anonymous (enforce ${enforce ? 'on' : 'off'})</span>`;
 const enforceTag = enforce ? '<span class="sb-tag warn">enforce</span>' : '<span class="sb-tag">soft</span>';
 return `<footer id="pwStatusBar"><span class="sb-item">CLIs: <b>${esc(cliSummary)}</b></span><span class="sb-sep">·</span><span class="sb-item">Last update check: <b>${esc(updateStamp)}</b></span><span class="sb-sep">·</span><span class="sb-item">Auth: ${enforceTag}</span><span class="sb-grow"></span>${u}</footer>`;
}
const statusBarCss = `#pwStatusBar{position:fixed;left:0;right:0;bottom:0;background:rgba(15,23,42,.92);border-top:1px solid #1f2937;color:#94a3b8;font:12px system-ui,-apple-system,Segoe UI,sans-serif;padding:5px 14px;display:flex;align-items:center;gap:10px;backdrop-filter:blur(8px);z-index:50}#pwStatusBar b{color:#e5e7eb;font-weight:600}#pwStatusBar .sb-sep{opacity:.45}#pwStatusBar .sb-grow{flex:1}#pwStatusBar .sb-tag{padding:1px 7px;border-radius:999px;background:#1f2937;color:#cbd5e1;font-size:11px;border:1px solid #334155}#pwStatusBar .sb-tag.warn{color:#fde68a;border-color:#854d0e;background:#3b2e0a}body{padding-bottom:32px}`;

// ============================================================================
// Settings page (admin-only). Tabbed surface — primary settings destination.
// Setup Wizard still exists as a focused guided modal launched from here.
// ============================================================================
const settingsCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}.s-header{display:flex;align-items:center;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.s-header h1{margin:0;font-size:1.2rem}.s-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.s-header .back:hover{background:#1e293b;color:#fff}.s-header .grow{flex:1}.s-header .who{font-size:.85rem;color:#cbd5e1}.s-header .who b{color:#fff}.s-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0;min-height:calc(100vh - 60px - 32px)}.s-tabs{border-right:1px solid #1f2937;padding:1rem .5rem;background:#0b1220}.s-tabs button{display:block;width:100%;text-align:left;background:transparent;color:#cbd5e1;border:0;padding:.55rem .85rem;border-radius:8px;font:inherit;cursor:pointer;margin:1px 0}.s-tabs button:hover{background:#1e293b;color:#fff}.s-tabs button.active{background:#1e3a8a;color:#fff;font-weight:600}.s-main{padding:1.5rem 2rem;overflow:auto;min-width:0}.s-main section{display:none}.s-main section.active{display:block}.s-main h2{margin:0 0 .25rem;font-size:1.3rem}.s-main .lead{margin:0 0 1.25rem;color:#94a3b8;font-size:.92rem}.s-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.s-card h3{margin:0 0 .5rem;font-size:1.05rem;color:#bfdbfe}.s-card .muted{color:#94a3b8;font-size:.85rem}.button{display:inline-block;background:#2563eb;color:#fff;padding:.55rem .85rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button.danger{background:#991b1b}.button:hover{filter:brightness(1.1)}.button:disabled{opacity:.5;cursor:not-allowed}input,select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;font:inherit;box-sizing:border-box}input[type=text],input[type=password]{width:100%}.row-form{display:grid;grid-template-columns:minmax(140px,1fr) minmax(140px,1fr) minmax(140px,2fr) minmax(140px,1fr) auto;gap:.5rem;align-items:end}.row-form label{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;color:#cbd5e1;min-width:0}.utable{width:100%;border-collapse:collapse;font-size:.9rem}.utable th{text-align:left;padding:.55rem .55rem;border-bottom:1px solid #1f2937;color:#94a3b8;font-weight:600;font-size:.78rem;letter-spacing:.02em;text-transform:uppercase}.utable td{padding:.6rem .55rem;border-bottom:1px solid #1f2937;vertical-align:middle}.utable tr:hover td{background:rgba(30,41,59,.4)}.utable td.actions{text-align:right;white-space:nowrap}.utable .role-pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#1f2937;border:1px solid #334155;color:#cbd5e1;font-size:.74rem}.utable .role-pill.admin{color:#fde68a;border-color:#854d0e;background:#3b2e0a}.utable .role-pill.developer{color:#bbf7d0;border-color:#166534;background:#0b291a}.utable .role-pill.content_editor{color:#bfdbfe;border-color:#1e3a8a;background:#0b1a3a}.utable .role-pill.viewer{color:#cbd5e1;border-color:#334155;background:#1f2937}.utable .grants{font:11px ui-monospace,Menlo,monospace;color:#94a3b8;word-break:break-word;max-width:380px;display:inline-block;margin-right:6px}.tiny{padding:3px 9px;font-size:.78rem;margin:0 2px}.status-line{margin-top:.65rem;font-size:.82rem;color:#bbf7d0;min-height:1.2em}.status-line.err{color:#fca5a5}.env-grid2{display:grid;grid-template-columns:1fr 1fr;gap:.85rem}.env-grid2 label{display:flex;flex-direction:column;gap:.3rem;color:#cbd5e1;font-size:.85rem}.opt-help{font-size:.78rem;color:#94a3b8;line-height:1.45;margin-top:.2rem;min-height:2.4em}.opt-help.warn{color:#fca5a5}.opt-help b{color:#fde68a}.heal-out{margin:.55rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.55rem .75rem;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .85rem;align-items:center;padding:.55rem .75rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#0b1220}.cli-row .meta{min-width:0;display:flex;flex-direction:column;gap:.15rem}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.78rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .55rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block;margin-top:.5rem}#authFrame.hidden{display:none}.check-list{margin:0;padding:0;list-style:none}.check-list li{padding:.3rem 0;color:#cbd5e1;font-size:.9rem;display:flex;align-items:center;gap:.5rem}.check-list .ok{color:#86efac}.check-list .warn{color:#fde68a}.check-list .err{color:#fca5a5}.diag-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.65rem}.diag-item{border:1px solid #1f2937;border-radius:10px;padding:.75rem .85rem;background:#0b1220}.diag-item.ok{border-color:#166534}.diag-item.err{border-color:#7f1d1d}.diag-top{display:flex;align-items:flex-start;gap:.55rem;color:#cbd5e1;font-size:.9rem}.diag-top .ok{color:#86efac}.diag-top .err{color:#fca5a5}.diag-hint{margin:.6rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.6rem .75rem;white-space:pre-wrap;word-break:break-word;color:#e5e7eb;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto}
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
const cliRows=document.getElementById('cliRows');const cliStatus=document.getElementById('cliStatus');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const envStatus=document.getElementById('envStatus');const envSave=document.getElementById('envSave');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const sysVer=document.getElementById('sysVer');const sysChecks=document.getElementById('sysChecks');const sysDiag=document.getElementById('sysDiag');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');const authBackdrop=document.getElementById('authBackdrop');const authCloseBtn=document.getElementById('authCloseBtn');const authTitle=document.getElementById('authTitle');function openAuthModal(){authBackdrop.classList.remove('hidden')}window.pwOpenAuthModal=function(label,command){authTitle.textContent='Sign in — '+label;if(authFrame.src.indexOf('/pty/_setup/')<0)authFrame.src='/pty/_setup/';authHint.textContent='Type: '+command+' — then complete the prompts in the terminal.';authBackdrop.classList.remove('hidden')};function closeAuthModal(){authBackdrop.classList.add('hidden');authFrame.src='about:blank';authHint.textContent='Waiting for sign-in command…';authTitle.textContent='Sign-in terminal'}authCloseBtn.onclick=closeAuthModal;authBackdrop.addEventListener('click',e=>{if(e.target===authBackdrop)closeAuthModal()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!authBackdrop.classList.contains('hidden'))closeAuthModal()});let state=null;async function loadState(){try{const r=await fetch('/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');renderClis();renderEnv()}catch(e){setStatus(cliStatus,e.message,true)}}function renderDiagnostics(diags){if(!Array.isArray(diags)||!diags.length){sysDiag.innerHTML='<li class="muted">No diagnostics returned.</li>';return}sysDiag.innerHTML=diags.map(d=>{const ok=!!d.ok;return '<li class="diag-item '+(ok?'ok':'err')+'"><div class="diag-top"><span class="'+(ok?'ok':'err')+'">'+(ok?'✓':'✗')+'</span><span>'+esc(d.label)+'</span></div>'+(ok?'':'<pre class="diag-hint">'+esc(d.hint||'No remediation hint provided.')+'</pre>')+'</li>'}).join('')}async function loadSystem(){try{const r=await fetch('/api/system/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');sysVer.innerHTML='CLIs: <b>'+esc(j.cliSummary)+'</b> · Last updater run: <b>'+esc(j.updateStamp)+'</b> · Users: <b>'+j.userCount+'</b>';const c=j.checks;const items=[['atLeastOneCliInstalled','At least one AI CLI installed'],['atLeastOneCliSignedIn','At least one CLI signed in'],['atLeastOneAdmin','At least one admin user defined'],['atLeastOneEnabledCli','At least one CLI enabled in settings'],['wrapperEnvPresent','Wrapper env (/etc/project-workbench/claude-wrapper.env) present'],['authEnforce','Auth enforce mode ON (PW_AUTH_ENFORCE=true)']];sysChecks.innerHTML=items.map(([k,label])=>{const ok=!!c[k];const cls=k==='authEnforce'&&!ok?'warn':(ok?'ok':'err');const icon=ok?'✓':(k==='authEnforce'?'⚠':'✗');return '<li class="'+cls+'">'+icon+' '+esc(label)+'</li>'}).join('')}catch(e){sysChecks.innerHTML='<li class="err">'+esc(e.message)+'</li>'}try{const r=await fetch('/api/system/diagnostics',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'diagnostics failed');renderDiagnostics(j.diagnostics)}catch(e){sysDiag.innerHTML='<li class="diag-item err"><div class="diag-top"><span class="err">✗</span><span>Diagnostics unavailable</span></div><pre class="diag-hint">'+esc(e.message)+'</pre></li>'}}function renderClis(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+esc(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+esc(c.version)+'</span>'+(c.authenticated?'<span class="signed-in">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button class="button secondary tiny inst">'+(c.installed?'Update':'Install')+'</button><button class="button tiny auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+esc(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');btn.disabled=true;btn.textContent='Installing…';setStatus(cliStatus,'');try{const r=await fetch('/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');setStatus(cliStatus,c.label+': '+j.version);loadState();loadSystem()}catch(e){setStatus(cliStatus,e.message,true);loadState();loadSystem()}finally{btn.disabled=false;btn.textContent=c.installed?'Update':'Install'}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setStatus(cliStatus,'');try{const r=await fetch('/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');authTitle.textContent='Sign in — '+c.label;if(authFrame.src.indexOf('/pty/_setup/')<0)authFrame.src='/pty/_setup/';authHint.textContent='Type: '+j.command+' — then complete the prompts in the terminal.';openAuthModal()}catch(e){setStatus(cliStatus,e.message,true);loadSystem()}finally{btn.disabled=false}};cliRows.appendChild(row)}}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest default.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude runs every tool unattended. Anyone with dashboard access effectively has shell on this box.'};const MCP_HELP={inherit:'Use the MCP servers configured on your Anthropic account.',isolated:'Use an empty MCP config so no external MCP servers load.',custom:'Use a custom MCP JSON via <code>PW_MCP_CONFIG</code>.'};function renderEnv(){permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderEnvHelp()}function renderEnvHelp(){document.getElementById('permHelp').innerHTML=PERM_HELP[permMode.value]||'';document.getElementById('permHelp').classList.toggle('warn',permMode.value==='skip');document.getElementById('mcpHelp').innerHTML=MCP_HELP[mcpMode.value]||''}permMode.addEventListener('change',renderEnvHelp);mcpMode.addEventListener('change',renderEnvHelp);envSave.onclick=async()=>{envSave.disabled=true;setStatus(envStatus,'Saving…');try{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);const r=await fetch('/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();setStatus(envStatus,j.ok?'Saved.':'Error: '+j.error,!j.ok)}catch(e){setStatus(envStatus,e.message,true)}finally{envSave.disabled=false}};async function heal(url,btn){btn.disabled=true;healOut.className='heal-out show';healOut.textContent='Working…';try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');healOut.textContent=j.message||'OK';healOut.className='heal-out show'}catch(e){healOut.textContent=e.message;healOut.className='heal-out show err'}finally{btn.disabled=false;loadSystem()}}healNginx.onclick=()=>heal('/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('/api/setup/heal/dirs',healDirs);loadState();loadSystem();
// --- First Run tab: launch wizard modal ---
document.getElementById('rerunWizardBtn')?.addEventListener('click',()=>{document.getElementById('setupBackdrop')?.classList.remove('hidden')});})();</script>`;

app.get('/settings', requireAdmin, async (req,res) => {
 const cliSummary = await getInstalledCliSummary();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ cliSummary, updateStamp, user: req.user, enforce: AUTH_ENFORCE });<style>${settingsCss}${statusBarCss}${modalBaseCss}${wizardCss}</style></head><body><header class="s-header"><a class="back" href="/">← Dashboard</a><h1>Settings</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><div class="s-layout"><nav class="s-tabs"><button data-tab="users" class="active">Users &amp; Roles</button><button data-tab="clis">CLIs &amp; Sign-in</button><button data-tab="env">Environment</button><button data-tab="system">System &amp; Updates</button><button data-tab="firstrun">First Run</button></nav><main class="s-main">
<section id="tab-users" class="active"><h2>Users &amp; Roles</h2><p class="lead">Manage who can sign in and which projects they can see. Users live in <code>/etc/project-workbench/users.json</code>; passwords are hashed with scrypt and never displayed.</p><div class="s-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:1rem"><h3 style="margin:0">Current users</h3><button class="button" id="uAddBtn" type="button">+ Add user</button></div><table class="utable" id="uTable" style="margin-top:1rem"></table><div class="status-line" id="uStatus"></div></div></section>
<section id="tab-clis"><h2>CLIs &amp; Sign-in</h2><p class="lead">Install or update each assistant, then sign in. Tokens land in <code>/home/admin</code> and apply to every project terminal.</p><div class="s-card"><div id="cliRows"></div><div class="status-line" id="cliStatus"></div></div></section>
<div id="authBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box" style="max-width:800px;height:70vh"><header><h2 id="authTitle">Sign-in terminal</h2><button class="modal-close" id="authCloseBtn" aria-label="Close" type="button">×</button></header><div class="body" style="flex:1;display:flex;flex-direction:column;overflow:hidden"><div id="authHint" class="muted" style="margin-bottom:.5rem">Waiting for sign-in command…</div><iframe id="authFrame" style="flex:1;width:100%;border:none;border-radius:6px;background:#000" title="Setup auth terminal"></iframe></div></div></div>
<section id="tab-env"><h2>Environment</h2><p class="lead">Wrapper-level policy applied to every Claude session this instance launches.</p><div class="s-card"><div class="env-grid2"><label>Permission mode<select id="permMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="permHelp"></span></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="mcpHelp"></span></label></div><button class="button" id="envSave" style="margin-top:1rem">Save environment</button><div class="status-line" id="envStatus"></div></div></section>
<section id="tab-system"><h2>System &amp; Updates</h2><p class="lead">Self-repair, version info, and a readiness checklist.</p><div class="s-card"><h3>Versions</h3><div id="sysVer" class="muted">loading…</div></div><div class="s-card"><h3>Readiness checklist</h3><ul class="check-list" id="sysChecks"><li class="muted">loading…</li></ul></div><div class="s-card"><h3>Diagnostics</h3><ul class="diag-list" id="sysDiag"><li class="muted">loading…</li></ul></div><div class="s-card"><h3>Heal</h3><p class="muted">Regenerate the nginx config from <code>projects.json</code>, or re-create runtime dirs / wrapper symlink if something looks broken.</p><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button> <button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button><pre class="heal-out" id="healOut"></pre></div><div class="s-card"><h3>Audit log</h3><p class="muted">Sensitive events are appended as JSONL to <code>/var/log/project-workbench/audit.log</code>. Tail it from a shell: <code>sudo tail -F /var/log/project-workbench/audit.log</code></p></div></section>
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
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Project Workbench</title><style>${loginCss}</style></head><body><div class="card"><h1>Project Workbench</h1><p class="sub">Sign in to continue.</p><form id="loginForm"><label>Username<input id="u" name="username" autocomplete="username" autofocus required></label><label>Password<input id="p" name="password" type="password" autocomplete="current-password" required></label><button class="button" type="submit">Sign in</button><div class="err" id="err">${esc(msg)}</div></form></div><script>const next=${JSON.stringify(next)};document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();const u=document.getElementById('u').value;const p=document.getElementById('p').value;const err=document.getElementById('err');err.textContent='Signing in…';try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const j=await r.json();if(!j.ok){err.textContent=j.error||'Login failed';return}location.href=next}catch(e){err.textContent=e.message||String(e)}});</script></body></html>`);
});

app.post('/api/auth/login', async (req,res) => {
 try {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if(!username || !password){ await audit('login_fail', { reason:'missing-fields', username }, req); return res.status(400).json({ ok:false, error:'Username and password required' }); }
  const users = await loadUsers();
  const u = users.find(x => x.username === username);
  if(!u){ await audit('login_fail', { reason:'unknown-user', username }, req); return res.status(401).json({ ok:false, error:'Invalid username or password' }); }
  const ok = await verifyPassword(password, u.passwordHash);
  if(!ok){ await audit('login_fail', { reason:'bad-password', username }, req); return res.status(401).json({ ok:false, error:'Invalid username or password' }); }
  const sid = await createSession(u.id);
  setSessionCookie(req, res, sid, Math.floor(SESSION_TTL_MS / 1000));
  // Record lastLoginAt opportunistically (best-effort, don't fail the login if it can't write).
  try { u.lastLoginAt = new Date().toISOString(); await saveUsers(users); } catch {}
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
  if(password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  let projects;
  try { projects = normalizeProjects(req.body?.projects); } catch(e){ return res.status(400).json({ ok:false, error: e.message }); }
  const users = await loadUsers();
  if(users.some(u => u.username === username)) return res.status(409).json({ ok:false, error:`User "${username}" already exists` });
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const id = 'u-' + crypto.randomBytes(6).toString('base64url');
  users.push({ id, username, passwordHash, role, projects, createdAt: now, lastLoginAt: null });
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
app.get('/api/system/diagnostics', requireAdmin, async (_req,res) => {
 try { res.json({ ok:true, diagnostics: await runDiagnostics() }); }
 catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.get('/api/system/status', requireAdmin, async (_req,res) => {
 try {
  const [cliSummary, updateStamp, users, settings] = await Promise.all([
   getInstalledCliSummary(), getClaudeUpdateStamp(), loadUsers(), loadWorkbenchSettings(),
  ]);
  const cliStatuses = await getCliStatuses();
  const checks = {
   atLeastOneCliInstalled: Object.values(cliStatuses).some(c => c.installed),
   atLeastOneCliSignedIn: Object.values(cliStatuses).some(c => c.installed && c.authenticated),
   atLeastOneAdmin: users.some(u => u.role === 'admin'),
   atLeastOneEnabledCli: (settings.enabledClis || []).length > 0,
   authEnforce: AUTH_ENFORCE,
   wrapperEnvPresent: await fs.access(wrapperEnvPath).then(() => true).catch(() => false),
  };
  const firstRunNeeded = !checks.atLeastOneCliInstalled || !checks.atLeastOneCliSignedIn || !checks.atLeastOneAdmin;
  res.json({ ok:true, cliSummary, updateStamp, userCount: users.length, settings, checks, firstRunNeeded });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// Returns minimal first-run hint to any authenticated/implicit user so the
// dashboard knows whether to auto-prompt the wizard.
app.get('/api/system/firstrun', async (_req,res) => {
 try {
  const [cliStatuses, users] = await Promise.all([getCliStatuses(), loadUsers()]);
  const anyInstalled = Object.values(cliStatuses).some(c => c.installed);
  const anyAuthed   = Object.values(cliStatuses).some(c => c.installed && c.authenticated);
  const needed = !anyInstalled || !anyAuthed || users.length === 0;
  res.json({ ok:true, firstRunNeeded: needed });
 } catch { res.json({ ok:true, firstRunNeeded: false }); }
});

app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).type('html').send(`<h1>Workbench error</h1><pre>${esc(err.message || err)}</pre><p><a href="/manage">Back to Manage</a></p>`); });
app.listen(3000,'127.0.0.1',()=>{ console.log('dashboard listening on 127.0.0.1:3000'); sweepOrphanTmuxSessions(); });
