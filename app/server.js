import express from 'express';
import fs from 'fs/promises';
import path from 'path';
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
const defaultWorkbenchSettings = { permissionMode:'skip', mcpMode:'isolated', enabledClis:['claude'], updateClis:['claude'] };
const SUPPORTED_CLIS = {
 claude:  { label:'Claude Code',        pkg:'@anthropic-ai/claude-code', bin:'claude',  authCmd:'claude /login',                              notes:'Anthropic. Wrapper enforces permissions/MCP/shared-memory policy.' },
 codex:   { label:'OpenAI Codex CLI',   pkg:'@openai/codex',             bin:'codex',   authCmd:'codex login',                                notes:'OpenAI. Sign in with ChatGPT or set OPENAI_API_KEY.' },
 copilot: { label:'GitHub Copilot CLI', pkg:'@github/copilot',           bin:'copilot', authCmd:'gh auth login --git-protocol=https --web',   notes:'GitHub. Auth via gh CLI; copilot reads gh credentials.' }
};

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

async function loadProjects(){ const raw = await fs.readFile(registryPath,'utf8').catch(()=> '[]'); return JSON.parse(raw); }
async function saveProjects(projects){ await fs.writeFile(registryPath, JSON.stringify(projects, null, 2)+'\n'); }
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
 let active = false, since = null, pid = null;
 try {
  const { stdout } = await execFileAsync('systemctl',['show',unit,'--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp,Result','--no-pager'],{timeout:5000});
  const kv = Object.fromEntries(stdout.split('\n').filter(Boolean).map(l=>{ const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1)]; }));
  active = (kv.ActiveState === 'active');
  since = kv.ActiveEnterTimestamp || null;
  pid = Number(kv.MainPID) || null;
 } catch {}
 const ready = active ? await probePreviewReady(p.preview.port) : false;
 return { configured:true, active, ready, since, pid, port:Number(p.preview.port), basepath:`/preview/${p.name}`, url:`/preview/${p.name}/` };
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
async function newTmuxWindow(p,name='new task'){
 const safeName = String(name || 'new task').replace(/[\r\n\t]/g,' ').trim().slice(0,80) || 'new task';
 await tmux(['new-window','-t',tmuxSession(p.name),'-c',p.path,'-n',safeName,'env','HOME=/home/admin','LANG=C.UTF-8','LC_ALL=C.UTF-8','TERM=screen-256color','COLORTERM=truecolor','PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin','bash','--noprofile','--norc']);
}
async function requireProject(req,res){ const p = await projectByName(req.params.project); if(!p){ res.status(404).json({ok:false,error:'Unknown project'}); return null; } return p; }
const pendingDir = '/var/lib/project-workbench/pending';
function pendingMarkerPath(p){ return path.join(pendingDir, p.name); }
async function readPending(p){ try { const stat = await fs.stat(pendingMarkerPath(p)); return { pending: true, since: stat.mtime.toISOString() }; } catch { return { pending: false }; } }
async function clearPending(p){ await fs.rm(pendingMarkerPath(p), { force: true }).catch(()=>{}); }
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
  `PW_PERMISSION_MODE=${s.permissionMode === 'prompt' ? 'prompt' : 'skip'}`,
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
  out[key] = { key, label:cfg.label, pkg:cfg.pkg, bin:cfg.bin, authCmd:cfg.authCmd, notes:cfg.notes, installed:!!version, version: version || 'not installed', authenticated };
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
 const setupRoute = `    location /pty/_setup/ {\n        proxy_pass http://127.0.0.1:${setupTtydPort}/pty/_setup/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`;
 const locations = projects.map(p => `    location /pty/${p.name}/ {\n        sub_filter_once off;\n        sub_filter_types text/html;\n        sub_filter '</head>' '<script src="/terminal-preload.js"></script></head>';\n        proxy_pass http://127.0.0.1:${p.port}/pty/${p.name}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`).join('');
 const previewRoutes = previewProjects.map(p => `    location /preview/${p.name}/ {\n        proxy_pass http://127.0.0.1:${p.preview.port}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix /preview/${p.name};\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/${p.name}/)(.*)$ /preview/${p.name}/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n        proxy_send_timeout 86400;\n    }\n`).join('');
 const refererMaps = previewProjects.length ? `map $http_referer $pw_preview_name {\n    default "";\n    "~^https?://[^/]+/preview/(?<pname>[^/]+)/" "$pname";\n}\nmap $pw_preview_name $pw_preview_port {\n    default 0;\n${previewProjects.map(p => `    "${p.name}" ${p.preview.port};`).join('\n')}\n}\n` : '';
 const knownDashboardPaths = '^/(api|pty|term|file|manage|preview|terminal-preload|terminal-paste|healthz|favicon|robots)(/|$|\\.|\\?)';
 const previewFallbackLocation = previewProjects.length ? `    location @pw_preview_fallback {\n        proxy_pass http://127.0.0.1:$pw_preview_port$request_uri;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix /preview/$pw_preview_name;\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/)(.*)$ /preview/$pw_preview_name/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n    }\n` : '';
 const rootLocation = previewProjects.length
  ? `    location / {\n        set $pw_route dashboard;\n        if ($pw_preview_port) { set $pw_route preview; }\n        if ($request_uri ~ "${knownDashboardPaths}") { set $pw_route dashboard; }\n        if ($pw_route = preview) { return 418; }\n        error_page 418 = @pw_preview_fallback;\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n`
  : `    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }\n`;
 return `map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n${refererMaps}server {\n    listen 80 default_server;\n    server_name _;\n    auth_basic "Project Workbench";\n    auth_basic_user_file /etc/nginx/.htpasswd;\n    client_max_body_size 100m;\n${rootLocation}${setupRoute}${locations}${previewRoutes}${previewFallbackLocation}}\n`;
}
async function applyRouting(projects){
 await fs.writeFile(nginxPath, nginxConfig(projects));
 await sh('nginx',['-t']);
 await sh('systemctl',['reload','nginx']);
 await sh('systemctl',['daemon-reload']);
}
async function cloneWorkspace(p){
 await fs.mkdir(workspaceRoot,{recursive:true});
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

const homeCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;background:#0f172a;color:#e5e7eb}a{color:#93c5fd}.grid article .prow{display:grid;grid-template-columns:1fr 110px;gap:.5rem;align-items:end;margin-top:.45rem}.grid article .prow.envrow{grid-template-columns:1fr}.grid article .prow label{margin:.25rem 0 0}.grid article .prow textarea{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;width:100%;min-width:0;box-sizing:border-box;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:2.4rem}.empty-state{background:#111827;border:1px solid #334155;border-radius:14px;padding:2rem 1.75rem;text-align:center;max-width:640px;margin:1.5rem auto}.empty-state h2{margin:0 0 .35rem;font-size:1.45rem}.empty-state p{margin:0 0 1.25rem;color:#cbd5e1;line-height:1.45}.empty-state .step{display:flex;align-items:center;gap:.85rem;text-align:left;padding:.75rem .9rem;border:1px solid #1f2937;border-radius:10px;background:#0b1220;margin:.5rem 0}.empty-state .step .num{display:inline-flex;align-items:center;justify-content:center;width:1.8rem;height:1.8rem;border-radius:50%;background:#1e3a8a;color:#bfdbfe;font-weight:700;flex:0 0 1.8rem}.empty-state .step .meta{flex:1 1 auto;min-width:0}.empty-state .step .meta b{display:block;color:#f8fafc}.empty-state .step .meta span{color:#94a3b8;font-size:.85rem}.empty-state .step .button{margin:0}.empty-add{background:#0b1220;border:1px dashed #475569;border-radius:10px;padding:.65rem .85rem;color:#94a3b8;font-size:.9rem;margin-bottom:1rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:1rem}.manage-grid{margin-top:1.25rem}article{background:#111827;border:1px solid #374151;border-radius:12px;padding:1rem;transition:border-color .2s,box-shadow .2s}article.pending{border-color:#3b82f6;box-shadow:0 0 0 1px rgba(59,130,246,.35),0 8px 28px -12px rgba(59,130,246,.55)}.button{display:inline-block;background:#2563eb;color:white;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button.danger{background:#991b1b}.muted{color:#9ca3af;font-size:.9rem}code{color:#bfdbfe;word-break:break-all}.repo{color:#93c5fd;text-decoration:none;font-size:.9rem}.repo:hover{text-decoration:underline}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5rem;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #1f2937}.hero h1{margin:0;font-size:2rem;line-height:1.1}.subtitle{margin:.45rem 0 0;color:#cbd5e1}.hero-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.55rem;min-width:260px}.action-row{display:flex;gap:.55rem;align-items:center;justify-content:flex-end;flex-wrap:wrap}.iconBtn{width:2.65rem;height:2.65rem;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem;line-height:1}.meta-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;align-items:center;gap:.35rem;background:#111827;border:1px solid #334155;border-radius:999px;padding:.35rem .65rem;color:#cbd5e1;font-size:.9rem}.subtle{color:#94a3b8;font-size:.8rem}.top{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}input{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.55rem;width:100%;box-sizing:border-box;min-width:0}label{display:block;margin:.5rem 0}.row{display:grid;grid-template-columns:1fr 1.5fr .5fr auto;gap:.5rem;align-items:end}.grid article .row{display:grid;grid-template-columns:3fr 1fr;gap:.5rem;align-items:end}.grid article .row label:nth-of-type(1){grid-column:1;grid-row:1}.grid article .row label:nth-of-type(3){grid-column:2;grid-row:1}.grid article .row label:nth-of-type(2){grid-column:1/-1;grid-row:2}.grid article .row .button{grid-column:1/-1;grid-row:3;justify-self:start;margin-top:.35rem}.grid article h2{margin:0 0 .5rem;font-size:1.15rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.pending-dot{display:none;width:.6em;height:.6em;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 .18em rgba(59,130,246,.25);animation:pwPulse 1.6s ease-in-out infinite}article.pending .pending-dot{display:inline-block}.pending-label{display:none;color:#93c5fd;font-size:.78rem;font-weight:500;letter-spacing:.02em}article.pending .pending-label{display:inline}@keyframes pwPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}.pencilBtn{background:transparent;border:1px solid #374151;color:#cbd5e1}.pencilBtn:hover{background:#1e293b;border-color:#94a3b8;color:#fff}.pencilBtn.active{background:#1e3a8a;border-color:#3b82f6;color:#fff}body.editing-order .order-grid article{cursor:grab;border-style:dashed;border-color:#3b82f6;position:relative}body.editing-order .order-grid article.dragging{opacity:.45;cursor:grabbing}body.editing-order .order-grid article *{user-select:none}body.editing-order .order-grid article a,body.editing-order .order-grid article button{pointer-events:none;opacity:.65}body.editing-order .order-grid article form input,body.editing-order .order-grid article form .button{pointer-events:none;opacity:.55}body.editing-order .order-grid article::before{content:'⠿';position:absolute;top:6px;right:14px;color:#60a5fa;font-size:20px;font-family:monospace;line-height:1;letter-spacing:-2px}@media(max-width:800px){.row{grid-template-columns:1fr}.hero{flex-direction:column}.hero-actions{align-items:flex-start}.meta-row{justify-content:flex-start}}`;

const wizardCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-box footer{display:flex;justify-content:flex-end;gap:.5rem;padding:.8rem 1.25rem;border-top:1px solid #1f2937;align-items:center}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.modal-box section{margin-bottom:1.25rem}.modal-box section h3{margin:0 0 .35rem;font-size:1rem;color:#bfdbfe}.section-help{margin:0 0 .55rem;color:#94a3b8;font-size:.85rem}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .75rem;align-items:center;padding:.55rem .7rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#111827}.cli-row .meta{display:flex;flex-direction:column;gap:.15rem;min-width:0}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.8rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .5rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}.cli-row .actions .button{padding:.4rem .65rem;font-size:.82rem;margin:0}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}.env-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.env-grid label{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#cbd5e1}.env-grid select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.45rem;font:inherit}.heal-row{display:flex;gap:.5rem;flex-wrap:wrap}.heal-out{margin:.5rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.6rem .8rem;font-size:.82rem;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block}#authFrame.hidden{display:none}#authHint{color:#94a3b8;font-size:.85rem;margin:.3rem 0 .5rem}#saveStatus{color:#bbf7d0;font-size:.85rem;margin-right:auto}#saveStatus.err{color:#fca5a5}@media(max-width:640px){.cli-row{grid-template-columns:1fr}.env-grid{grid-template-columns:1fr}}`;

const wizardScript = `<script>(function(){const open=document.getElementById('setupBtn');const backdrop=document.getElementById('setupBackdrop');if(!open||!backdrop)return;const closeBtn=document.getElementById('setupCloseBtn');const cancelBtn=document.getElementById('setupCancelBtn');const saveBtn=document.getElementById('setupSaveBtn');const cliRows=document.getElementById('cliRows');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const saveStatus=document.getElementById('saveStatus');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');let state=null;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setHealOut(t,err){healOut.textContent=t||'';healOut.classList.toggle('show',!!t);healOut.classList.toggle('err',!!err)}function setSave(t,err){saveStatus.textContent=t||'';saveStatus.classList.toggle('err',!!err)}function render(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+escHtml(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+escHtml(c.version)+'</span>'+(c.authenticated?'<span class="signed-in" title="Credentials detected on disk">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button type="button" class="button secondary inst">'+(c.installed?'Update':'Install')+'</button><button type="button" class="button auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+escHtml(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');const orig=btn.textContent;btn.disabled=true;btn.textContent='Installing…';setSave('');try{const r=await fetch('/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');const v=row.querySelector('.version');v.textContent=j.version;v.classList.add('installed');btn.textContent='Update';setSave(c.label+': '+j.version)}catch(e){btn.textContent=orig;setSave(e.message,true)}finally{btn.disabled=false}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setSave('');try{const r=await fetch('/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(authFrame.src.indexOf('/pty/_setup/')<0)authFrame.src='/pty/_setup/';authFrame.classList.remove('hidden');authHint.textContent='Running: '+j.command+' — complete the prompts in the terminal below.'}catch(e){setSave(e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}permMode.value=state.settings.permissionMode||'skip';mcpMode.value=state.settings.mcpMode||'inherit'}async function load(){setSave('Loading…');try{const r=await fetch('/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');render();setSave('')}catch(e){setSave(e.message,true)}}function show(){backdrop.classList.remove('hidden');load()}function hide(){backdrop.classList.add('hidden');authFrame.src='about:blank';authFrame.classList.add('hidden');authHint.textContent='Click "Sign in" on a CLI above to send its login command here.';setHealOut('');setSave('')}open.onclick=show;closeBtn.onclick=hide;cancelBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});saveBtn.onclick=async()=>{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);saveBtn.disabled=true;setSave('Saving…');try{const r=await fetch('/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setSave('Saved.')}catch(e){setSave(e.message,true)}finally{saveBtn.disabled=false}};async function heal(url,btn){btn.disabled=true;setHealOut('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');setHealOut(j.message||'OK')}catch(e){setHealOut(e.message,true)}finally{btn.disabled=false}}healNginx.onclick=()=>heal('/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('/api/setup/heal/dirs',healDirs)})();</script>`;

const wizardModalHtml = `<div id="setupBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box"><header><h2>Setup Wizard</h2><button class="modal-close" id="setupCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><section><h3>CLIs</h3><p class="section-help">Pick which assistants this instance offers. "Auto-update" CLIs are upgraded nightly by the update timer.</p><div id="cliRows"></div></section><section><h3>Sign in</h3><p class="section-help">Sign-in opens the shared setup terminal at <code>/pty/_setup/</code>. Tokens land in <code>/home/admin</code> and apply to every project.</p><div id="authHint">Click "Sign in" on a CLI above to send its login command here.</div><iframe id="authFrame" class="hidden" title="Setup auth terminal"></iframe></section><section><h3>Environment</h3><div class="env-grid"><label>Permission mode<select id="permMode"><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option><option value="prompt">Prompt for each permission (default)</option></select></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select></label></div></section><section><h3>Heal</h3><p class="section-help">Self-repair common installation drift. Run if a route is missing or a runtime path looks broken.</p><div class="heal-row"><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button><button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button></div><pre class="heal-out" id="healOut"></pre></section></div><footer><span id="saveStatus"></span><button class="button secondary" id="setupCancelBtn" type="button">Close</button><button class="button" id="setupSaveBtn" type="button">Save settings</button></footer></div></div>`;

const modalBaseCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.button{display:inline-block;background:#2563eb;color:#fff;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button:disabled{opacity:.55;cursor:not-allowed}.subtle{color:#94a3b8;font-size:.8rem}`;

const previewCss = `.modal-box.preview{max-width:1180px;height:90vh}.modal-box.preview .body{padding:0;display:flex;flex-direction:column;gap:0}.preview-toolbar{display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;border-bottom:1px solid #1f2937;background:#0b1220;flex-wrap:wrap}.preview-toolbar .pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .65rem;border-radius:999px;background:#111827;border:1px solid #334155;color:#cbd5e1;font-size:.82rem}.preview-toolbar .pill .dot{width:.55em;height:.55em;border-radius:50%;background:#64748b;box-shadow:0 0 0 .2em rgba(100,116,139,.15)}.preview-toolbar .pill.running{color:#bbf7d0;border-color:#166534}.preview-toolbar .pill.running .dot{background:#22c55e;box-shadow:0 0 0 .2em rgba(34,197,94,.25);animation:pwPulse 1.6s ease-in-out infinite}.preview-toolbar .pill.starting{color:#fde68a;border-color:#854d0e}.preview-toolbar .pill.starting .dot{background:#facc15;box-shadow:0 0 0 .2em rgba(250,204,21,.25);animation:pwPulse 1.2s ease-in-out infinite}.preview-toolbar .pill.error{color:#fecaca;border-color:#7f1d1d}.preview-toolbar .pill.error .dot{background:#ef4444}.preview-toolbar .spacer{flex:1 1 auto}.preview-toolbar .button{margin:0;padding:.45rem .8rem;font-size:.85rem}.preview-toolbar .button.icon{padding:.45rem .55rem}.preview-toolbar a.button{text-decoration:none}.preview-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;background:#0f172a}.preview-empty{display:grid;place-items:center;flex:1 1 auto;color:#94a3b8;text-align:center;padding:2rem;font-size:.95rem}.preview-empty.hidden{display:none}.preview-empty>div{max-width:780px}.preview-empty code{color:#bfdbfe;display:block;margin-top:.55rem;font-size:.8rem;background:#020617;border:1px solid #1f2937;border-radius:6px;padding:.55rem .7rem;text-align:left;white-space:pre-wrap;word-break:break-word}#previewFrame{flex:1 1 auto;width:100%;border:0;background:#fff;display:block}#previewFrame.hidden{display:none}.preview-logs{display:none;flex:0 0 auto;max-height:32%;border-top:1px solid #1f2937;background:#020617;color:#bbf7d0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.55rem .85rem;overflow:auto;white-space:pre-wrap}.preview-logs.show{display:block}.preview-logs.err{color:#fca5a5}.preview-statusline{padding:.4rem .85rem;font-size:.82rem;color:#94a3b8;border-bottom:1px solid #1f2937;background:#0b1220;display:none}.preview-statusline.show{display:block}.preview-statusline.err{color:#fca5a5}`;

const previewModalHtml = `<div id="previewBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box preview"><header><h2 id="previewTitle">Preview</h2><button class="modal-close" id="previewCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><div class="preview-toolbar"><span class="pill" id="previewPill"><span class="dot"></span><span id="previewPillLabel">checking…</span></span><span class="subtle" id="previewMeta"></span><span class="spacer"></span><button class="button" id="previewStartBtn" type="button">Start</button><button class="button secondary" id="previewRestartBtn" type="button">Restart</button><button class="button secondary" id="previewStopBtn" type="button">Stop</button><button class="button secondary" id="previewReloadBtn" type="button" title="Reload iframe">↻</button><a class="button secondary" id="previewOpenBtn" target="_blank" rel="noopener" title="Open in new tab">Open ↗</a><button class="button secondary" id="previewLogsBtn" type="button">Logs</button></div><div class="preview-statusline" id="previewStatusline"></div><div class="preview-body"><div class="preview-empty" id="previewEmpty">Preview is not running.</div><iframe id="previewFrame" class="hidden" title="Project preview"></iframe><pre class="preview-logs" id="previewLogs"></pre></div></div></div></div>`;

const previewScript = `<script>(function(){const backdrop=document.getElementById('previewBackdrop');if(!backdrop)return;const title=document.getElementById('previewTitle');const pill=document.getElementById('previewPill');const pillLabel=document.getElementById('previewPillLabel');const meta=document.getElementById('previewMeta');const startBtn=document.getElementById('previewStartBtn');const stopBtn=document.getElementById('previewStopBtn');const restartBtn=document.getElementById('previewRestartBtn');const reloadBtn=document.getElementById('previewReloadBtn');const openBtn=document.getElementById('previewOpenBtn');const logsBtn=document.getElementById('previewLogsBtn');const closeBtn=document.getElementById('previewCloseBtn');const empty=document.getElementById('previewEmpty');const frame=document.getElementById('previewFrame');const logs=document.getElementById('previewLogs');const statusline=document.getElementById('previewStatusline');let project=null;let pollTimer=null;let logsTimer=null;let lastIframeUrl='';let showingLogs=false;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatusLine(t,err){statusline.textContent=t||'';statusline.classList.toggle('show',!!t);statusline.classList.toggle('err',!!err)}function setPill(state,label){pill.classList.remove('running','starting','error');if(state)pill.classList.add(state);pillLabel.textContent=label}function setEmpty(msg){empty.innerHTML='<div>'+msg+'</div>';empty.classList.remove('hidden');frame.classList.add('hidden');if(frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}function loadIframe(url){if(lastIframeUrl===url)return;lastIframeUrl=url;empty.classList.add('hidden');frame.classList.remove('hidden');frame.src=url}async function fetchStatus(){if(!project)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');applyStatus(j)}catch(e){setStatusLine(e.message||String(e),true)}}function applyStatus(s){meta.textContent=s.port?'port '+s.port+(s.pid?' · pid '+s.pid:''):'';if(!s.configured){setPill('error','not configured');setEmpty('Preview is not configured for this project.<br><br>Open <a class="repo" href="/manage">Manage Projects</a> and set a <strong>Preview command</strong>.<br><br>Examples:<code>dotnet watch run --project ProVisionI_Portal/ProVisionI_Portal.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code>');startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;openBtn.removeAttribute('href');return}openBtn.href=s.url||'#';if(s.active&&s.ready){setPill('running','running');setStatusLine('');loadIframe(s.url);startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else if(s.active&&!s.ready){setPill('starting','waiting for port '+s.port);setStatusLine('Server unit is active; waiting for the dev server to bind to 127.0.0.1:'+s.port+'…');setEmpty('Starting… waiting for the framework to bind to port <strong>'+s.port+'</strong>.<br><span class="subtle">First boot of dotnet watch can take 10–30s.</span>');startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else{setPill('','stopped');setStatusLine('');setEmpty('Preview is stopped. Click <strong>Start</strong> to launch:<code>'+escHtml(s.cmd||'')+'</code>');startBtn.disabled=false;stopBtn.disabled=true;restartBtn.disabled=false}}async function action(url){startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;setStatusLine('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');applyStatus(j);if(showingLogs)refreshLogs()}catch(e){setStatusLine(e.message||String(e),true)}}async function refreshLogs(){if(!project||!showingLogs)return;try{const r=await fetch('/api/preview/'+encodeURIComponent(project)+'/logs?lines=300',{cache:'no-store'});const j=await r.json();if(j.ok){logs.textContent=j.log||'(no log output yet)';logs.scrollTop=logs.scrollHeight}}catch{}}function toggleLogs(){showingLogs=!showingLogs;logs.classList.toggle('show',showingLogs);logsBtn.textContent=showingLogs?'Hide logs':'Logs';if(showingLogs){refreshLogs();logsTimer=setInterval(refreshLogs,3000)}else{clearInterval(logsTimer);logsTimer=null}}function show(name){project=name;title.textContent='Preview — '+name;showingLogs=false;logs.classList.remove('show');logs.textContent='';logsBtn.textContent='Logs';setPill('','checking…');setStatusLine('');setEmpty('Loading…');backdrop.classList.remove('hidden');fetchStatus();pollTimer=setInterval(fetchStatus,2500)}function hide(){backdrop.classList.add('hidden');project=null;if(pollTimer){clearInterval(pollTimer);pollTimer=null}if(logsTimer){clearInterval(logsTimer);logsTimer=null}if(frame.src&&frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}startBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/start');stopBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/stop');restartBtn.onclick=()=>action('/api/preview/'+encodeURIComponent(project)+'/restart');reloadBtn.onclick=()=>{if(frame.src&&frame.src!=='about:blank'){const u=frame.src;frame.src='about:blank';setTimeout(()=>{lastIframeUrl='';loadIframe(u)},50)}};logsBtn.onclick=toggleLogs;closeBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});window.pwPreview={open:show,close:hide};document.addEventListener('click',e=>{const btn=e.target.closest('[data-preview]');if(!btn)return;e.preventDefault();show(btn.dataset.preview)})})();</script>`;

const reorderScript = `<script>(function(){const btn=document.getElementById('editOrderBtn');const grid=document.querySelector('.order-grid');if(!btn||!grid)return;let editing=false;let dragSrc=null;function setEditing(on){editing=on;document.body.classList.toggle('editing-order',on);btn.classList.toggle('active',on);btn.textContent=on?'✓':'✎';grid.querySelectorAll('article[data-name]').forEach(a=>{a.draggable=on})}btn.onclick=()=>setEditing(!editing);grid.addEventListener('dragstart',e=>{if(!editing)return;const a=e.target.closest('article[data-name]');if(!a){e.preventDefault();return}dragSrc=a;a.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',a.dataset.name)}catch{}});grid.addEventListener('dragover',e=>{if(!editing||!dragSrc)return;const target=e.target.closest('article[data-name]');if(!target||target===dragSrc)return;e.preventDefault();const rect=target.getBoundingClientRect();const after=(e.clientY-rect.top)>rect.height/2;if(after)target.parentNode.insertBefore(dragSrc,target.nextSibling);else target.parentNode.insertBefore(dragSrc,target)});grid.addEventListener('dragend',async()=>{if(!editing)return;if(dragSrc)dragSrc.classList.remove('dragging');dragSrc=null;const order=[...grid.querySelectorAll('article[data-name]')].map(c=>c.dataset.name);try{await fetch('/api/projects/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})})}catch{}})})();</script>`;

app.get('/', async (_req,res)=>{
 const projects = await loadProjects(); const claudeVersion = await getClaudeVersion(); const updateStamp = await getClaudeUpdateStamp();
 const rows = projects.map(p=>{
  const previewBtn = hasPreview(p)
   ? `<button class="button secondary" type="button" data-preview="${esc(p.name)}">Preview</button>`
   : `<button class="button secondary" type="button" data-preview="${esc(p.name)}" title="Preview command not yet configured — click to set up">Preview…</button>`;
  return `<article data-name="${esc(p.name)}" data-project="${esc(p.name)}"><h2>${esc(p.name)} <span class="pending-dot" aria-hidden="true"></span><span class="pending-label">ready</span></h2><p><code>${esc(p.path)}</code></p><p><a class="button" href="/term/${encodeURIComponent(p.name)}/">Open Claude terminal</a> ${previewBtn}</p><p><a class="repo" href="${esc(p.repo)}" target="_blank" rel="noopener">Github Repo</a></p></article>`;
 }).join('\n');
 const emptyState = `<div class="empty-state"><h2>Welcome to Project Workbench</h2><p>LAN-internal browser terminals backed by Claude Code (or your CLI of choice). Two steps to get started:</p><div class="step"><span class="num">1</span><div class="meta"><b>Sign in your AI CLI</b><span>Authenticate Claude Code (or Codex / Copilot) once in the shared setup terminal.</span></div><button id="emptyWizardBtn" class="button" type="button">Open Setup Wizard</button></div><div class="step"><span class="num">2</span><div class="meta"><b>Add your first project</b><span>Clone a repo into a workspace and get a browser terminal + live preview.</span></div><a class="button" href="/manage">Manage Projects</a></div></div>`;
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Workbench</title><style>${homeCss}${wizardCss}${previewCss}</style></head><body><header class="hero"><div><h1>Project Workbench</h1><p class="subtitle">Protected project terminals with Claude Code CLI</p></div><div class="hero-actions"><div class="meta-row"><span class="badge">Claude Code: <b>${esc(claudeVersion)}</b></span></div><div class="subtle">Last update check: ${esc(updateStamp)}</div><div class="action-row"><button id="editOrderBtn" class="button secondary pencilBtn iconBtn" type="button" title="Drag cards to reorder" aria-label="Edit order">✎</button><button id="setupBtn" class="button secondary" type="button">Setup Wizard</button><a class="button secondary" href="/manage">Manage Projects</a></div></div></header>${rows ? `<div class="grid order-grid">${rows}</div>` : emptyState}${wizardModalHtml}${previewModalHtml}<script>async function pwRefreshStatus(){try{const r=await fetch('/api/projects/status',{cache:'no-store'});const out=await r.json();if(!out?.ok)return;const map=Object.create(null);for(const p of out.projects)map[p.name]=p;document.querySelectorAll('article[data-project]').forEach(a=>{const s=map[a.dataset.project];a.classList.toggle('pending',!!(s&&s.pending))})}catch{}}pwRefreshStatus();setInterval(()=>{if(!document.hidden)pwRefreshStatus()},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pwRefreshStatus()});document.getElementById('emptyWizardBtn')?.addEventListener('click',()=>document.getElementById('setupBtn')?.click());</script>${reorderScript}${wizardScript}${previewScript}</body></html>`);
});

app.get('/manage', async (req,res)=>{
 const projects = await loadProjects(); const msg = req.query.msg ? `<p class="badge">${esc(req.query.msg)}</p>` : '';
 const placeholder = 'e.g. dotnet watch --project Foo/Foo.csproj --non-interactive --no-hot-reload run --no-launch-profile    |    npm run dev -- --host 127.0.0.1 --port ${PORT}';
 const envPlaceholder = '# one KEY=VALUE per line; lines starting with # ignored\n# ASPNETCORE_ENVIRONMENT=Development\n# DATABASE_URL=postgres://localhost/foo';
 const rows = projects.map(p=>{
  const cmd = esc(p.preview?.cmd || '');
  const previewPortVal = p.preview?.port ? esc(p.preview.port) : '';
  const envText = esc(Object.entries(p.preview?.env || {}).map(([k,v])=>`${k}=${v}`).join('\n'));
  return `<article data-name="${esc(p.name)}"><form method="post" action="/manage/update/${encodeURIComponent(p.name)}"><div class="row"><label>Name<input name="name" value="${esc(p.name)}" required></label><label>Repo<input name="repo" value="${esc(p.repo)}" required></label><label>Port<input name="port" type="number" value="${esc(p.port)}" required></label></div><div class="prow"><label>Preview command<br><span class="muted">Use <code>\${PORT}</code> and <code>\${BASEPATH}</code> (= <code>/preview/${esc(p.name)}</code>). Empty disables preview.</span><textarea name="previewCmd" rows="2" placeholder="${esc(placeholder)}">${cmd}</textarea></label><label>Preview port<input name="previewPort" type="number" value="${previewPortVal}" placeholder="auto"></label></div><div class="prow envrow"><label>Preview env<br><span class="muted">Per-project env vars exported before the cmd runs. Reserved: <code>PORT</code>, <code>BASEPATH</code>. ASP.NET tip: leave <code>ASPNETCORE_ENVIRONMENT</code> unset so projects with Windows-only Dev branches fall through to a Linux-safe code path.</span><textarea name="previewEnv" rows="3" placeholder="${esc(envPlaceholder)}">${envText}</textarea></label></div><p class="muted"><code>${esc(p.path)}</code></p><button class="button" type="submit">Update</button></form><form method="post" action="/manage/delete/${encodeURIComponent(p.name)}" onsubmit="return confirm('Delete ${esc(p.name)} and remove its local workspace?')"><label class="muted"><input type="checkbox" name="confirm" value="yes" required style="width:auto"> Delete local workspace content too</label><button class="button danger" type="submit">Delete project</button></form></article>`;
 }).join('\n');
 const emptyHint = projects.length === 0 ? `<p class="empty-add">No projects yet — fill in the form below to clone your first one. Workspaces live at <code>${esc(workspaceRoot)}/&lt;Name&gt;</code> and get their own browser terminal at <code>/term/&lt;Name&gt;/</code>.</p>` : '';
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Projects</title><style>${homeCss}</style></head><body><div class="top"><h1>Manage Projects</h1><a class="button secondary" href="/">Dashboard</a></div>${msg}${emptyHint}<article><h2>Add project</h2><form method="post" action="/manage/add"><div class="row"><label>Name<input name="name" placeholder="RepoName" required pattern="[A-Za-z0-9._-]+"></label><label>Repo URL<input name="repo" placeholder="https://github.com/owner/RepoName.git" required></label><label>Port<input name="port" type="number" placeholder="auto"></label><button class="button" type="submit">Add + clone</button></div><p class="muted">Configure preview command after the project is added.</p></form></article><div class="grid manage-grid">${rows}</div></body></html>`);
});

app.post('/manage/add', async (req,res,next)=>{ try {
 const name = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim();
 if(!validName(name)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!repo) throw new Error('Repository URL is required');
 const projects = await loadProjects();
 if(projects.some(p=>p.name===name)) throw new Error('A project named "'+name+'" already exists');
 const port = Number(req.body.port) || nextPort(projects);
 if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
 if(allUsedPorts(projects).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
 const p = { name, repo, path: workspacePath(name), port };
 await cloneWorkspace(p); projects.push(p); await saveProjects(projects); await applyRouting(projects); await startProject(p);
 res.redirect('/manage?msg='+encodeURIComponent(`Added ${name}`));
 } catch(e){ next(e); }});

app.post('/manage/update/:oldName', async (req,res,next)=>{ try {
 const oldName = req.params.oldName; const newName = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim(); const port = Number(req.body.port);
 const previewCmd = String(req.body.previewCmd || '').trim();
 const previewPortRaw = String(req.body.previewPort || '').trim();
 const previewEnvRaw = String(req.body.previewEnv || '');
 if(!validName(newName)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!repo) throw new Error('Repository URL is required');
 const projects = await loadProjects(); const p = projects.find(x=>x.name===oldName); if(!p) throw new Error('Project "'+oldName+'" not found');
 if(newName!==oldName && projects.some(x=>x.name===newName)) throw new Error('A project named "'+newName+'" already exists');
 if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
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
 await stopProject(oldName); const oldPath = p.path; p.name = newName; p.repo = repo; p.port = port; p.path = workspacePath(newName);
 if(previewBlock) p.preview = previewBlock; else delete p.preview;
 if(oldPath !== p.path){ try { await fs.rename(oldPath,p.path); } catch { /* absent workspace is okay */ } }
 await saveProjects(projects); await applyRouting(projects); await startProject(p); res.redirect('/manage?msg='+encodeURIComponent(`Updated ${newName}`));
 } catch(e){ next(e); }});

app.post('/manage/delete/:name', async (req,res,next)=>{ try {
 if(req.body.confirm !== 'yes') throw new Error('Delete confirmation required'); const name = req.params.name; const projects = await loadProjects(); const idx = projects.findIndex(p=>p.name===name); if(idx<0) throw new Error('Project not found'); const [p] = projects.splice(idx,1);
 await stopProject(name); await removeWorkspace(p); await saveProjects(projects); await applyRouting(projects); res.redirect('/manage?msg='+encodeURIComponent(`Deleted ${name} and removed local workspace`));
 } catch(e){ next(e); }});

app.get('/api/projects/status', async (_req,res)=>{ try {
 const projects = await loadProjects();
 const out = await Promise.all(projects.map(async p => ({ name: p.name, ...(await readPending(p)) })));
 res.json({ ok:true, projects: out });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/projects/:name/clear-pending', async (req,res)=>{ try {
 const p = await projectByName(req.params.name); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 await clearPending(p); res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/projects/reorder', async (req,res)=>{ try {
 const order = req.body?.order;
 if(!Array.isArray(order)) return res.status(400).json({ok:false,error:'order must be an array of names'});
 const projects = await loadProjects();
 const byName = new Map(projects.map(p=>[p.name,p]));
 const ordered = [];
 for(const n of order){ if(typeof n==='string' && byName.has(n)){ ordered.push(byName.get(n)); byName.delete(n); } }
 for(const p of byName.values()) ordered.push(p);
 await saveProjects(ordered);
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/term/:project/windows', async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 res.json({ok:true,windows});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows', async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await newTmuxWindow(p, req.body?.name || 'new task');
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows/:index/select', async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await tmux(['select-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/term/:project/windows/:index/rename', async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const name = String(req.body?.name || '').replace(/[\r\n\t]/g,' ').trim().slice(0,80);
 if(!name) return res.status(400).json({ok:false,error:'Window name required'});
 await tmux(['rename-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`,name]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete('/api/term/:project/windows/:index', async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 if(windows.length <= 1) return res.status(400).json({ok:false,error:'Cannot close the last session'});
 await tmux(['kill-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/term/:project/', async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); const projectJson = JSON.stringify(p.name);
 await clearPending(p);
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} terminal</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#1f1f1f;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}body{display:flex;flex-direction:column}iframe{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;background:#1f1f1f}#topBar{flex:0 0 34px;width:100%;height:34px;background:linear-gradient(180deg,rgba(15,23,42,.96),rgba(15,23,42,.82));color:#dbeafe;border-bottom:1px solid #334155;font:13px system-ui;box-shadow:0 2px 10px #0008;display:flex;align-items:center;justify-content:space-between;gap:8px;letter-spacing:.01em;padding:0 14px;box-sizing:border-box}.leftInfo{display:flex;align-items:center;gap:12px;min-width:0}.backLink{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:3px 9px;background:#0f172a}.backLink:hover{background:#1e293b;color:#fff}.projectInfo{font-weight:700;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fileInfo{color:#dbeafe;font-weight:500}#fileBtn{background:transparent;border:0;color:#dbeafe;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;padding:4px 0}#fileBtn:hover{color:#fff}#fileBtn::before{content:'⬇'}body.shade-open #fileBtn::before{content:'⬆'}#tray{flex:0 0 auto;max-height:0;overflow:hidden;background:rgba(15,23,42,.98);color:#e5e7eb;border-bottom:0 solid #334155;box-shadow:0 6px 18px #0008;transition:max-height .18s ease,padding .18s ease,border-width .18s ease;padding:0 18px;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"header header" "list dropzone" "status status";gap:12px;align-items:stretch}#inboxHeader{grid-area:header}#inboxList{grid-area:list}#drop,#preview{grid-area:dropzone}#status{grid-area:status}body.has-preview #drop{display:none}body:not(.has-preview) #preview{display:none}@media(max-width:640px){#tray{grid-template-columns:1fr;grid-template-areas:"header" "dropzone" "list" "status"}#topBar{padding:0 8px;gap:6px}.leftInfo{gap:6px;min-width:0}.backLink{padding:3px 7px;font-size:12px}.projectInfo{display:none}.previewBtn{padding:3px 9px;font-size:12px;margin-right:4px}.fileInfo{display:none}#fileBtn{font-size:18px;padding:4px 6px}.tabStrip{padding:0 4px;gap:3px}.tabStrip .tab{max-width:140px;padding:2px 6px}.tabStrip .tab .name{max-width:100px}.tabStrip .newTab{padding:1px 7px;font-size:13px}}body.shade-open #tray{max-height:560px;border-bottom-width:1px;padding:14px 18px 16px}#drop{border:2px dashed #64748b;border-radius:14px;padding:30px 18px;text-align:center;background:#111827;outline:none;cursor:pointer;min-height:130px;display:flex;flex-direction:column;justify-content:center;width:100%;box-sizing:border-box}#status{white-space:pre-wrap;color:#94a3b8;font-size:13px;line-height:1.35}button,label{font:inherit}.close{display:none}code{color:#bfdbfe}img{max-width:100%;max-height:380px;border-radius:8px;margin-top:0;border:1px solid #334155;display:block}.previewItem{position:relative;display:inline-block;max-width:100%}.previewItem a{display:block}.previewClear{position:absolute;top:6px;right:6px;background:rgba(15,23,42,.9);border:1px solid #334155;color:#fca5a5;border-radius:50%;width:26px;height:26px;line-height:22px;text-align:center;font-size:16px;cursor:pointer;padding:0;font-family:inherit}.previewClear:hover{background:#0f172a;color:#fff;border-color:#94a3b8}.tabStrip{flex:1 1 auto;display:flex;align-items:center;gap:4px;overflow-x:auto;min-width:0;padding:0 10px;scrollbar-width:thin}.tabStrip::-webkit-scrollbar{height:6px}.tabStrip::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}.tabStrip .tab{display:inline-flex;align-items:center;gap:4px;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:3px 8px;color:#cbd5e1;cursor:pointer;font-size:12px;line-height:1.4;white-space:nowrap;user-select:none;max-width:180px;flex:0 0 auto}.tabStrip .tab:hover{background:#1e293b;color:#fff}.tabStrip .tab.active{background:#1e3a8a;border-color:#3b82f6;color:#fff}.tabStrip .tab .name{overflow:hidden;text-overflow:ellipsis;max-width:140px;cursor:pointer}.tabStrip .tab.active .name{cursor:text}.tabStrip .tab .name.editing{outline:1px solid #60a5fa;background:#0f172a;border-radius:3px;padding:0 4px;max-width:none;cursor:text}.inboxHeader{display:flex;justify-content:space-between;align-items:center;color:#cbd5e1;font-size:12px;letter-spacing:.02em;margin-top:2px;min-height:22px}.inboxHeader .clear{font-size:12px;color:#fca5a5;background:transparent;border:1px solid #4b5563;border-radius:6px;padding:3px 8px;cursor:pointer}.inboxHeader .clear:hover{background:#1f2937;color:#fff;border-color:#94a3b8}.inboxList{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;border-top:1px solid #1f2937;padding-top:6px;margin:0;scrollbar-width:thin}.inboxList::-webkit-scrollbar{width:6px}.inboxList::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}.inboxList .row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;background:#0f172a;border:1px solid transparent}.inboxList .row:hover{background:#1e293b;border-color:#334155}.inboxList .thumb{width:36px;height:36px;background:#1f2937;border-radius:4px;display:flex;align-items:center;justify-content:center;flex:0 0 36px;overflow:hidden;color:#64748b;font-size:11px;font-weight:600}.inboxList .thumb img{width:100%;height:100%;object-fit:cover;border-radius:4px;border:0;margin:0;max-height:none}.inboxList .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}.inboxList .nameCol .name{font-size:12px;color:#e5e7eb;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.inboxList .nameCol .meta{font-size:11px;color:#94a3b8}.inboxList .del{flex:0 0 auto;color:#fca5a5;background:transparent;border:0;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px;font-family:inherit}.inboxList .del:hover{background:#1f2937;color:#fff}#pwHoverPreview{position:fixed;z-index:9999;pointer-events:none;background:#0f172a;border:1px solid #475569;border-radius:8px;padding:6px;box-shadow:0 14px 36px rgba(0,0,0,.7);display:none;max-width:440px}#pwHoverPreview img{display:block;max-width:420px;max-height:420px;border-radius:4px;border:0;margin:0}#pwHoverPreview .card{padding:14px;color:#cbd5e1;font:13px system-ui;max-width:320px;word-break:break-all;line-height:1.45}#pwHoverPreview .card .meta{margin-top:6px;color:#94a3b8;font-size:11px}.tabStrip .tab .x{opacity:.55;font-size:14px;line-height:1;padding:0 3px;border-radius:3px}.tabStrip .tab .x:hover{opacity:1;color:#fca5a5;background:#0f172a}.tabStrip .newTab{background:transparent;border:1px dashed #475569;color:#94a3b8;cursor:pointer;padding:2px 8px;border-radius:6px;font-size:14px;line-height:1.2;flex:0 0 auto}.tabStrip .newTab:hover{color:#fff;border-color:#94a3b8}.previewBtn{background:transparent;border:1px solid #334155;color:#bfdbfe;border-radius:999px;padding:3px 11px;cursor:pointer;font:inherit;margin-right:8px;letter-spacing:.02em}.previewBtn:hover{background:#1e293b;color:#fff;border-color:#94a3b8}${modalBaseCss}${previewCss}</style></head><body><div id="topBar"><div class="leftInfo"><a class="backLink" href="/">← Back</a><span class="projectInfo">Project: ${esc(p.name)}</span></div><div id="tabStrip" class="tabStrip"></div><button class="previewBtn" type="button" data-preview="${esc(p.name)}" title="Open live preview window">Preview</button><button id="fileBtn" type="button" title="Open file shade"><span class="fileInfo">Files / paste or drop into project</span></button></div><div id="tray"><div id="drop" tabindex="0"><div>Paste/drop/select files here</div><div style="color:#94a3b8;margin-top:6px">PDF, txt, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status">Saved files go to <code>${esc(p.path)}/_inbox</code>. The path will be inserted into the terminal.</div><div id="preview"></div><div id="inboxHeader" class="inboxHeader"></div><div id="inboxList" class="inboxList"></div><button class="close" id="close">Close</button></div><iframe id="term" src="/pty/${encodeURIComponent(p.name)}/"></iframe><script>const project=${projectJson};const tray=document.getElementById('tray'),drop=document.getElementById('drop'),file=document.getElementById('file'),status=document.getElementById('status'),preview=document.getElementById('preview'),inboxHeader=document.getElementById('inboxHeader'),inboxList=document.getElementById('inboxList'),frame=document.getElementById('term');let previewTimer=null;const hoverPanel=Object.assign(document.createElement('div'),{id:'pwHoverPreview'});document.body.appendChild(hoverPanel);function setStatus(t,bad=false){status.textContent=t;status.style.color=bad?'#fca5a5':'#bbf7d0'}function clearPreview(){preview.innerHTML='';document.body.classList.remove('has-preview');setStatus('');if(previewTimer){clearTimeout(previewTimer);previewTimer=null}}function showPreview(url,name,isImage){if(!url&&!name)return clearPreview();if(previewTimer){clearTimeout(previewTimer);previewTimer=null}document.body.classList.add('has-preview');const safeName=escHtml(name||'file');if(isImage&&url){preview.innerHTML='<div class="previewItem"><a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+safeName+'"></a><button class="previewClear" type="button" title="Clear preview">×</button></div>'}else{preview.innerHTML='<div class="previewItem"><div style="padding:18px;border:1px solid #334155;border-radius:8px;color:#cbd5e1;text-align:center;display:flex;align-items:center;justify-content:center;min-height:130px;word-break:break-all;background:#111827">'+safeName+'</div><button class="previewClear" type="button" title="Clear preview">×</button></div>'}preview.querySelector('.previewClear').onclick=clearPreview;previewTimer=setTimeout(clearPreview,15000)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function refreshInbox(){try{const r=await fetch('/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const out=await r.json();if(!out?.ok){inboxHeader.innerHTML='';inboxList.innerHTML='';return}const files=out.files||[];if(files.length===0){inboxHeader.innerHTML='<span>No saved files yet.</span>';inboxList.innerHTML='';return}inboxHeader.innerHTML='<span>'+files.length+' saved file'+(files.length===1?'':'s')+' — click a row to insert its path</span><button class="clear" type="button">Clear all</button>';inboxHeader.querySelector('.clear').onclick=async()=>{if(!confirm('Delete all '+files.length+' files in this project\\'s inbox?'))return;await fetch('/api/inbox/'+encodeURIComponent(project),{method:'DELETE'});refreshInbox()};inboxList.innerHTML='';for(const f of files){const row=document.createElement('div');row.className='row';row.title='Click to insert path: '+f.path;const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);row.innerHTML='<div class="thumb">'+(isImg?'<img src="'+f.url+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+escHtml(f.name)+'</div><div class="meta">'+fmtSize(f.size)+'</div></div><button class="del" type="button" title="Delete">×</button>';row.onclick=ev=>{if(ev.target.closest('.del'))return;if(insertPath(f.path)){setStatus('Inserted:\\n'+f.path)}else{setStatus('Could not insert (no terminal focus)',true)}};row.onmouseenter=()=>{hoverPanel.innerHTML=isImg?'<img src="'+f.url+'">':'<div class="card">'+escHtml(f.name)+'<div class="meta">'+fmtSize(f.size)+'</div></div>';hoverPanel.style.display='block';const rct=row.getBoundingClientRect(),pw=hoverPanel.offsetWidth,ph=hoverPanel.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;let lf=rct.right+10;if(lf+pw>vw-8)lf=Math.max(8,rct.left-pw-10);let tp=rct.top-4;if(tp+ph>vh-8)tp=Math.max(8,vh-ph-8);if(tp<8)tp=8;hoverPanel.style.left=lf+'px';hoverPanel.style.top=tp+'px'};row.onmouseleave=()=>{hoverPanel.style.display='none'};row.querySelector('.del').onclick=async ev=>{ev.stopPropagation();hoverPanel.style.display='none';await fetch('/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(f.name),{method:'DELETE'});refreshInbox()};inboxList.appendChild(row)}}catch{}}function openTray(msg){document.body.classList.add('shade-open');setTimeout(()=>drop.focus(),50);if(msg)setStatus(msg);refreshInbox()}function closeTray(){document.body.classList.remove('shade-open');clearPreview();frame.contentWindow?.focus()}function toggleTray(){document.body.classList.contains('shade-open')?closeTray():openTray()}document.getElementById('fileBtn').onclick=toggleTray;document.getElementById('close').onclick=closeTray;function insertPath(path){try{if(frame.contentWindow.__pwSendToTerminal?.(path))return true}catch{}try{const ta=frame.contentDocument.querySelector('textarea.xterm-helper-textarea')||frame.contentDocument.querySelector('textarea');if(!ta)return false;ta.focus();const dt=new DataTransfer();dt.setData('text/plain',path);ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true}catch{return false}}async function upload(blob,name='clipboard-file'){if(!blob)return setStatus('No file received.',true);setStatus('Saving file...');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const res=await fetch('/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name,mime:blob.type||'application/octet-stream',data})});const out=await res.json().catch(()=>null);if(!res.ok||!out?.ok)throw new Error(out?.error||'Upload failed');const ok=insertPath(out.path);try{await navigator.clipboard.writeText(out.path)}catch{}showPreview(out.url,name||'file',(blob.type||'').startsWith('image/'));setStatus('Saved and '+(ok?'inserted':'copied')+':\\n'+out.path);refreshInbox()}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name).catch(e=>setStatus(e.message||String(e),true));drop.addEventListener('dragover',e=>{e.preventDefault();drop.style.borderColor='#60a5fa'});drop.addEventListener('dragleave',()=>drop.style.borderColor='#64748b');drop.addEventListener('drop',e=>{e.preventDefault();drop.style.borderColor='#64748b';upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name).catch(err=>setStatus(err.message||String(err),true))});window.addEventListener('paste',e=>{const items=[...(e.clipboardData?.items||[])];const item=items.find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();openTray('Saving pasted file...');upload(f,f?.name||'clipboard-file').catch(err=>setStatus(err.message||String(err),true))},true);let dragDepth=0;window.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();dragDepth++;openTray('Drop files here to save them into _inbox.')}},true);window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.style.borderColor='#60a5fa'}},true);window.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)drop.style.borderColor='#64748b'}},true);window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();dragDepth=0;drop.style.borderColor='#64748b';openTray();upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name).catch(err=>setStatus(err.message||String(err),true))}},true);window.addEventListener('message',e=>{const d=e.data;if(!d||typeof d!=='object')return;if(d.type==='pw-open-image-tray'){openTray(d.message||'Paste the file here.')}else if(d.type==='pw-paste-saved'){openTray();const base=(d.path||'').split('/').pop()||'file';showPreview(d.url,base,/\\.(png|jpe?g|webp|gif|bmp)$/i.test(base));setStatus('Saved and inserted:\\n'+d.path);refreshInbox()}else if(d.type==='pw-paste-error'){openTray();setStatus('Paste failed: '+d.error,true)}});const tabStrip=document.getElementById('tabStrip');const tabsBase='/api/term/'+encodeURIComponent(project)+'/windows';let lastTabsKey='';let editingIdx=null;let editAfterRender=false;function startEdit(label,w){editingIdx=w.index;const original=label.textContent;label.contentEditable='true';label.classList.add('editing');label.focus();const sel=window.getSelection();const range=document.createRange();range.selectNodeContents(label);sel.removeAllRanges();sel.addRange(range);let done=false;const finish=async save=>{if(done)return;done=true;label.contentEditable='false';label.classList.remove('editing');label.removeEventListener('keydown',onKey);label.removeEventListener('blur',onBlur);const next=label.textContent.trim();editingIdx=null;if(save&&next&&next!==w.name){try{await fetch(tabsBase+'/'+w.index+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:next})})}catch{}lastTabsKey='';refreshTabs()}else if(!save){label.textContent=original}};const onKey=ev=>{if(ev.key==='Enter'){ev.preventDefault();finish(true)}else if(ev.key==='Escape'){ev.preventDefault();finish(false)}};const onBlur=()=>finish(true);label.addEventListener('keydown',onKey);label.addEventListener('blur',onBlur)}async function refreshTabs(){if(editingIdx!=null)return;try{const r=await fetch(tabsBase,{cache:'no-store'});const out=await r.json();if(!out?.ok){tabStrip.innerHTML='';lastTabsKey='';return}const key=JSON.stringify(out.windows);if(key===lastTabsKey)return;lastTabsKey=key;renderTabs(out.windows)}catch{}}function renderTabs(windows){tabStrip.innerHTML='';for(const w of windows){const tab=document.createElement('div');tab.className='tab'+(w.active?' active':'');tab.title=w.active?'Click name to rename':'Window '+w.index+': '+(w.name||'');const label=document.createElement('span');label.className='name';label.textContent=w.name||('#'+w.index);label.onclick=ev=>{if(!w.active)return;ev.stopPropagation();startEdit(label,w)};tab.appendChild(label);if(windows.length>1){const x=document.createElement('span');x.className='x';x.textContent='×';x.title='Close window';x.onclick=async ev=>{ev.stopPropagation();if(!confirm('Close window "'+(w.name||w.index)+'"? Any running process in it will be killed.'))return;await fetch(tabsBase+'/'+w.index,{method:'DELETE'});lastTabsKey='';refreshTabs()};tab.appendChild(x)}tab.onclick=async()=>{if(w.active)return;await fetch(tabsBase+'/'+w.index+'/select',{method:'POST'});lastTabsKey='';refreshTabs()};tabStrip.appendChild(tab)}const plus=document.createElement('button');plus.className='newTab';plus.textContent='+ New Session';plus.title='Create a new CLI session';plus.onclick=async()=>{await fetch(tabsBase,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});editAfterRender=true;lastTabsKey='';refreshTabs()};tabStrip.appendChild(plus);if(editAfterRender){editAfterRender=false;const ai=windows.find(w=>w.active);if(ai){const tabs=tabStrip.querySelectorAll('.tab');const i=windows.indexOf(ai);const lbl=tabs[i]?.querySelector('.name');if(lbl)startEdit(lbl,ai)}}}refreshTabs();setInterval(()=>{if(!document.hidden)refreshTabs()},2000);async function pwHeartbeat(){if(document.hidden)return;try{await fetch('/api/projects/'+encodeURIComponent(project)+'/clear-pending',{method:'POST'})}catch{}}pwHeartbeat();setInterval(pwHeartbeat,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)pwHeartbeat()});</script>${previewModalHtml}${previewScript}</body></html>`);
});

app.post('/api/upload/:project', async (req,res)=>{ const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'}); const {filename='clipboard-file', mime='', data=''} = req.body || {}; const ext = path.extname(filename) || (mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('pdf') ? '.pdf' : mime.includes('text') ? '.txt' : '.bin'); const safe = slug(path.basename(filename, path.extname(filename))); const stamp = new Date().toISOString().replace(/[:.]/g,'-'); const inbox = path.join(p.path, '_inbox'); await fs.mkdir(inbox, {recursive:true}); const full = path.join(inbox, `${stamp}-${safe}${ext}`); await fs.writeFile(full, Buffer.from(data, 'base64')); return res.json({ok:true,path:full,url:`/file/${encodeURIComponent(p.name)}/${encodeURIComponent(path.basename(full))}`}); });
app.get('/file/:project/:file', async (req,res)=>{ const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); res.sendFile(path.join(p.path, '_inbox', path.basename(req.params.file))); });

app.get('/api/inbox/:project', async (req,res)=>{ try {
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

app.delete('/api/inbox/:project/:file', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const name = path.basename(req.params.file); if(!name || name==='.' || name==='..') return res.status(400).json({ok:false,error:'Invalid file'});
 await fs.rm(path.join(p.path,'_inbox',name), {force:true});
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete('/api/inbox/:project', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const inbox = path.join(p.path, '_inbox');
 try { const entries = await fs.readdir(inbox); await Promise.all(entries.map(n => fs.rm(path.join(inbox,n),{force:true,recursive:true}))); } catch {}
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
app.get('/api/preview/:project/status', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const status = await previewStatus(p);
 res.json({ ok:true, project:p.name, cmd:p.preview?.cmd || '', ...status });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/start', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project. Edit it on the Manage page.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/stop', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 await sh('systemctl',['stop',previewUnit(p.name)]).catch(()=>{});
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/preview/:project/restart', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/preview/:project/logs', async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const lines = Math.min(2000, Math.max(20, Number(req.query.lines) || 200));
 const log = await previewLogs(p.name, lines);
 res.json({ ok:true, log });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get('/api/setup/state', async (_req,res)=>{ try {
 const [settings, clis] = await Promise.all([loadWorkbenchSettings(), getCliStatuses()]);
 const updateStamp = await getClaudeUpdateStamp();
 res.json({ ok:true, settings, clis, updateStamp });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/state', async (req,res)=>{ try {
 const s = await loadWorkbenchSettings();
 const body = req.body || {};
 if(typeof body.permissionMode === 'string') s.permissionMode = body.permissionMode === 'prompt' ? 'prompt' : 'skip';
 if(typeof body.mcpMode === 'string' && ['inherit','isolated','custom'].includes(body.mcpMode)) s.mcpMode = body.mcpMode;
 if(Array.isArray(body.enabledClis)) s.enabledClis = [...new Set(body.enabledClis.filter(c => c in SUPPORTED_CLIS))];
 if(Array.isArray(body.updateClis)) s.updateClis = [...new Set(body.updateClis.filter(c => c in SUPPORTED_CLIS))];
 await saveWorkbenchSettings(s);
 res.json({ ok:true, settings:s });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/heal/nginx', async (_req,res)=>{ try {
 const projects = await loadProjects();
 await applyRouting(projects);
 res.json({ ok:true, message:`Regenerated nginx config from projects.json (${projects.length} project route${projects.length===1?'':'s'} + /pty/_setup/) and reloaded nginx.` });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/heal/dirs', async (_req,res)=>{ try {
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

app.post('/api/setup/cli/install', async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const { stdout, stderr } = await sh('npm',['install','-g',`${cfg.pkg}@latest`],{timeout:300000});
 const version = await getCliVersion(cfg.bin);
 res.json({ ok:true, version: version || 'not installed', log:(stdout+stderr).slice(-1500) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post('/api/setup/cli/auth', async (req,res)=>{ try {
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
app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).type('html').send(`<h1>Workbench error</h1><pre>${esc(err.message || err)}</pre><p><a href="/manage">Back to Manage</a></p>`); });
app.listen(3000,'127.0.0.1',()=>console.log('dashboard listening on 127.0.0.1:3000'));
