import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { Readable } from 'stream';
import { promisify } from 'util';
import { RELEASE_VERSION } from './version.js';
import { resolveIsolation } from './isolation.js';
import { resolveTlsConfig, renderNginxServers } from './tls-config.js';
import { ldapBindOnce as ldapBindOnceStaged, scavengeLdapStaging } from './ldap-staging.js';
import { deployCss } from './deploy-css.js';
import { resolveDeployReauth } from './deploy-reauth.js';
import { resolveTerminalPriv, wrapAgentEnv, agentLoginDrop, agentSpawnDrop } from './terminal-priv.js';
import { hostTerminalUser, makePasswdLookup, resolveTerminalOwner } from './terminal-owner.js';
import { ensureUserCredentials, pruneCredentials, credentialDropArgv, credentialExecutionPlan, spawnCredentialJob, credentialFingerprint, sessionCredentialState, userClaudeConfigDir, CREDENTIALS_OFF, checkUserSignedIn } from './user-credentials.js';
import { makeSecretCrypto } from './secret-crypto.js';
import { resolveProjectCredentialOwner } from './project-owner.js';
import { INBOX_DIR, OUTBOX_DIR, runWorkspaceJob, runWorkspaceRead, runWorkspaceWrite, workspaceJobArgv } from './workspace-file.js';
import { repairWorkspaceBoxes } from './workspace-box-owner.js';
import { loadUsersFile } from './users-file.js';
import { writeFileAtomic } from './atomic-file.js';
import { normalizeTask, evaluateDue, resolveTargets, preserveBookkeeping, guardedGitCommand, SCHEDULE_LIMITS, NORTH_AMERICAN_TIMEZONES, buildTaskCommand, taskWindowDisposition } from './scheduled-tasks.js';
import { withLifecycleLock } from './lifecycle-lock.js';
import { makeCredentialLockDomain } from './credential-domain-lock.js';
import { assertTmuxOwner } from './tmux-owner-gate.js';
import { resolveLifecycleTarget, reservedUsernameConflict, reconciliationStillCurrent } from './user-lifecycle.js';
import { uniqueTabNameClientSrc } from './tab-util.js';
import { mountOrchestrator } from './orchestrator/index.js';

const app = express();
const BASE = (process.env.PW_BASE_PATH || '').replace(/\/+$/, '');
const execFileAsync = promisify(execFile);
const DEPLOY_CENTRE = ['true','1'].includes(String(process.env.PW_DEPLOY_CENTRE || '').toLowerCase());
// Data/host paths are env-overridable so an isolated test/verify instance never
// mutates the shared host. ISOLATED = an explicit PW_ISOLATED=1, or a registry
// path other than the canonical one (see app/isolation.js — deployments that
// intentionally keep the real registry elsewhere, like GOA under /etc, opt into
// host mode by setting PW_CANONICAL_REGISTRY to that path).
const { registryPath, isolated: ISOLATED } = resolveIsolation(process.env);
const deployConfigPath = process.env.PW_DEPLOY_CONFIG || '/etc/project-workbench/deploy-config.json';
const deployLogPath = process.env.PW_DEPLOY_LOG || '/etc/project-workbench/deploy-log.jsonl';
const SECRET_KEY_PATH = process.env.PW_SECRET_KEY_PATH || '/etc/project-workbench/.secret-key';
const workspaceRoot = process.env.PW_WORKSPACES || '/opt/project-workbench/workspaces';
const nginxPath = process.env.PW_NGINX_CONF || '/etc/nginx/sites-available/project-workbench';
// Optional operator-supplied nginx locations injected into the generated server
// block (e.g. sibling-app reverse proxies like /pulse/, /n8n/, /teamkb/ that are
// specific to one deployment). Keeps env-specific service names OUT of the common
// repo. The file's contents are pasted verbatim at server scope, ahead of the
// catch-all `location /`; nginx -t validates it and applyRouting rolls back on
// error. Default: file absent → nothing injected (byte-identical output).
const extraNginxPath = process.env.PW_EXTRA_NGINX || '/etc/project-workbench/extra-nginx.conf';
// TLS for the generated nginx config is explicit opt-in (PW_TLS_ENABLED plus
// PW_TLS_CERT/PW_TLS_KEY/PW_TLS_SERVER_NAME, see app/tls-config.js and
// DEPLOY.md); resolveTlsConfig throws at startup when enabled but unusable.
const TLS = resolveTlsConfig(process.env);
const DEPLOY_MODE = (process.env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host';
const TMUX_SOCKET = process.env.PW_TMUX_SOCKET || (ISOLATED ? 'pwprev-' + process.pid : '');
const nginxTestCmd = process.env.PW_NGINX_TEST_CMD || '';
const nginxReloadCmd = process.env.PW_NGINX_RELOAD_CMD || '';
// Overridable like every other state path (registry, users, sessions, deploy
// config, scheduled tasks). Without it an isolated instance read the real
// /etc/project-workbench/workbench.json, so a test's behaviour — which CLIs are
// enabled, which timezone is displayed — depended on production settings, and a
// settings write from an isolated instance would have landed on the live file.
const workbenchSettingsPath = process.env.PW_WORKBENCH_SETTINGS || '/etc/project-workbench/workbench.json';
const wrapperEnvPath = '/etc/project-workbench/claude-wrapper.env';
const emptyMcpPath = '/etc/project-workbench/empty-mcp.json';
// Per-user CLI credentials: when ON, a project's terminal runs on its assigned
// owner's (primaryUser's) own Claude login + GitHub token instead of the shared
// box login. Opt-in (default OFF = today's single shared login, upstream-generic).
const PER_USER_CLAUDE = String(process.env.PW_PER_USER_CLAUDE || '').toLowerCase() === 'true';
const USER_CRED_BASE = process.env.PW_USER_CRED_BASE || '/home/admin/pw-users';
// The shared/default Claude config (source for seeding managed MCP servers into
// each per-user config dir so team MCP — teamkb/pulse/skillhub — still loads).
const sharedClaudeJson = path.join(process.env.HOME || '/home/admin', '.claude.json');
const setupTtydPort = 7680;
const setupTmuxSession = 'pw_setup';
const internalHandoffToken = process.env.PW_INTERNAL_HANDOFF_TOKEN || '';
// `prompt` (safer default) makes Claude ask before each tool use; `skip` passes
// --dangerously-skip-permissions and runs every tool unattended.
const defaultWorkbenchSettings = { permissionMode:'prompt', mcpMode:'isolated', enabledClis:['claude'], updateClis:['claude'], timezone:'', defaultProject:'' };
const PERMISSION_MODES = ['prompt','skip'];
function normalizePermissionMode(v){ return PERMISSION_MODES.includes(v) ? v : 'prompt'; }
const SUPPORTED_CLIS = {
 claude:  { label:'Claude Code',        pkg:'@anthropic-ai/claude-code', bin:'claude',  authCmd:'claude /login',                              notes:'Anthropic. Wrapper enforces permissions/MCP/shared-memory policy.' },
 codex:   { label:'OpenAI Codex CLI',   pkg:'@openai/codex',             bin:'codex',   authCmd:'codex login',                                notes:'OpenAI. Sign in with ChatGPT or set OPENAI_API_KEY.' },
 copilot: { label:'GitHub Copilot CLI', pkg:'@github/copilot',           bin:'copilot', authCmd:'gh auth login --git-protocol=https --web',   notes:'GitHub. Auth via gh CLI; copilot reads gh credentials.' }
};

// The orchestration API mounts before the dashboard's body parser and CSRF guard, and only when an
// operator has enabled it. Both placements are deliberate: it enforces its own much smaller body
// limit, and the Origin/Referer gate below exists because nginx Basic Auth is replayed by browsers
// on any origin — which a bearer service token is not. It is a machine surface with a dedicated
// scoped credential and shares no credential material with the dashboard in either direction.
// When disabled (the default) nothing here runs: no store, no lock, no listener, no behaviour change.
let orchestrator = null;
try {
 orchestrator = await mountOrchestrator(app, {
  workbenchVersion: RELEASE_VERSION,
  audit: (event, detail) => { audit(event, detail).catch(() => {}); },
 });
 if(orchestrator) console.log(`[orchestrator] mounted at ${orchestrator.config.basePath} as instance ${orchestrator.config.instanceId} (${orchestrator.reconciled} job(s) reconciled)`);
} catch(err) {
 // The orchestrator failed to start. This is NOT silent: the error is logged at ERROR level and
 // the orchestrator is NOT available. The dashboard continues because taking down every human
 // terminal, preview and inbox over an orchestrator misconfiguration is disproportionate — but
 // orchestration is refused, not degraded. No jobs can be submitted or run until an operator
 // fixes the configuration and restarts. This is fail-open for terminals, fail-closed for
 // orchestration: the subsystem does not silently fall back to running as root.
 console.error('[orchestrator] REFUSED TO START — orchestration is unavailable until this is fixed:', err?.message);
 console.error('[orchestrator] The orchestrator is disabled. No jobs will be accepted.');
}

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
async function saveProjects(projects){ await writeFileAtomic(registryPath, JSON.stringify(projects, null, 2)+'\n', { mode: 0o644 }); }

// ---------------------------------------------------------------- scheduled tasks
//
// Definitions live beside the registry, in a file that is bind-mounted 1:1 into
// the containers, so editing it needs no restart and the file is visible from the
// same place on a host install.
const scheduledTasksPath = process.env.PW_SCHEDULED_TASKS || path.join(path.dirname(registryPath), 'scheduled-tasks.json');
async function loadScheduledTasks(){
 let raw;
 try { raw = JSON.parse(await fs.readFile(scheduledTasksPath,'utf8')); }
 catch { return []; }
 if(!Array.isArray(raw)) return [];
 const tz = await displayTimeZone();
 const out = [];
 for(const item of raw){
  // One malformed task must not silence the rest: it is dropped with a reason
  // rather than taking the whole schedule down.
  try { out.push(normalizeTask(item, { defaultTimeZone: tz, agentBins: taskKnownAgentBins })); }
  catch(e){ console.error(`[tasks] ignoring invalid task ${JSON.stringify(item?.id ?? '?')}: ${e.message}`); }
 }
 return out;
}
async function saveScheduledTasks(tasks){
 await writeFileAtomic(scheduledTasksPath, JSON.stringify(tasks, null, 2)+'\n', { mode: 0o644 });
}

// A task that is mid-run must not be started again by the next tick. Keyed by id,
// in memory only: a restart clears it, which is correct — nothing is running then.
const tasksInFlight = new Set();

// Two different questions, deliberately not one list.
//
// VALIDATION asks "is this a known agent" — every CLI this build supports. A task
// must not become unloadable because a CLI was temporarily uninstalled or switched
// off: the definition is still valid, it just cannot run right now, and silently
// dropping it would remove a scheduled job an operator believes exists.
const taskKnownAgentBins = Object.values(SUPPORTED_CLIS).map(c => c.bin);

// THE PICKER asks "which can actually run tonight" — enabled in settings AND
// present on disk. Offering a CLI that is switched off, or enabled but not
// installed, is offering a task that fails at 17:00 with nobody watching.
async function activeAgentBins(){
 const settings = await loadWorkbenchSettings();
 const enabled = new Set(settings.enabledClis || []);
 const pairs = await Promise.all(Object.entries(SUPPORTED_CLIS).map(async ([key,cfg]) =>
  [cfg.bin, enabled.has(key) && !!(await getCliVersion(cfg.bin))]));
 return pairs.filter(([,ok]) => ok).map(([bin]) => bin);
}

// Run one task now. The command is injected as a tmux window per project, so it
// executes as the pane account (never as this root process) and its output stays
// readable in a tab afterwards, which is the whole reason to prefer this over a
// headless exec for work an operator wants to inspect.
async function runScheduledTask(task, { trigger = 'schedule', dueAt = Date.now(), actor = null } = {}){
 if(tasksInFlight.has(task.id)) return { skipped:'already running' };
 tasksInFlight.add(task.id);
 try {
  const projects = await loadProjects();
  const { matched, missing } = resolveTargets(task, projects);
  const results = [];
  for(const name of matched){
   const p = projects.find(x => x.name === name);
   try {
    // Create the session if the project has none, then add the window: a task
    // firing after hours must not depend on someone having opened the project.
    await ensureTmuxSession(p);
    // REUSE BEFORE CREATE. tmux allows duplicate window names, so calling
    // new-window unconditionally stacked another `<task.window>` tab onto every
    // project on every firing. See taskWindowDisposition() for the rules.
    const sameName = (await tmuxWindowDetails(name).catch(()=>[])).filter(w => w.name === task.window);
    const d = taskWindowDisposition({ existing: sameName });
    if(d.action === 'skip'){
     results.push({ project:name, ok:true, skipped:true, detail:d.reason, duplicates:d.duplicates });
    } else if(d.action === 'reuse'){
     const cmd = buildTaskCommand(task);
     // By INDEX, never by name. With two windows sharing a name, `send-keys -t
     // <session>:<name>` does not pick one — tmux 3.3a REFUSES the ambiguous
     // target with "can't find window: <name>", so the prompt was never
     // delivered at all and the stacked tabs sat empty. Reproduced in
     // test/scheduled-tasks-api.test.mjs.
     if(cmd) await tmux(['send-keys','-t',`${tmuxSession(name)}:${d.index}`,cmd,'C-m']);
     results.push({ project:name, ok:true, reused:true, duplicates:d.duplicates });
    } else {
     await newTmuxWindow(p, task.window, buildTaskCommand(task));
     results.push({ project:name, ok:true, created:true });
    }
   } catch(e){ results.push({ project:name, ok:false, error: e?.message || String(e) }); }
  }
  const failed = results.filter(r => !r.ok);
  const skipped = results.filter(r => r.skipped);
  const reused = results.filter(r => r.reused);
  const dupes = results.filter(r => (r.duplicates || 0) > 1);
  // A skip is deliberate, not an error — but it does mean the task did not run
  // there, so it must not read as a clean 'ok'. Constrained to the three values
  // normalizeTask() accepts, or it would be dropped to null on the next read.
  const status = !results.length ? 'failed'
   : failed.length === results.length ? 'failed'
   : failed.length ? 'partial'
   : skipped.length ? 'partial'
   : 'ok';
  const detail = [
   `${results.length - failed.length - skipped.length}/${results.length} project(s)`,
   ...(reused.length ? [`reused: ${reused.map(r=>r.project).join(', ')}`] : []),
   ...(skipped.length ? [`skipped (busy): ${skipped.map(r=>r.project).join(', ')}`] : []),
   ...(dupes.length ? [`duplicate windows to clean up: ${dupes.map(r=>`${r.project}x${r.duplicates}`).join(', ')}`] : []),
   ...(missing.length ? [`unknown: ${missing.join(', ')}`] : []),
   ...failed.slice(0,5).map(f => `${f.project}: ${f.error}`),
  ].join(' · ');

  // Record the SCHEDULED instant, not the finish time, so a late run does not
  // push tomorrow's deadline later.
  const all = await loadScheduledTasks();
  const next = all.map(t => t.id === task.id
   ? { ...t, lastRun: new Date(dueAt).toISOString(), lastStatus: status, lastDetail: detail }
   : t);
  await saveScheduledTasks(next);
  await audit('task_run', { task: task.id, trigger, status, projects: results.length, failed: failed.length, actor }, null);
  console.log(`[tasks] ${task.id} (${trigger}): ${status} — ${detail}`);
  return { status, detail, results, missing };
 } finally { tasksInFlight.delete(task.id); }
}

// The ticker. 30s is fine for minute-resolution schedules and cheap: one small
// file read per tick, and evaluateDue() is pure arithmetic.
let taskTickTimer = null;
function startTaskScheduler(){
 if(taskTickTimer) return;
 const tick = async () => {
  try {
   const tasks = await loadScheduledTasks();
   const now = Date.now();
   for(const t of tasks){
    const verdict = evaluateDue(t, now);
    if(verdict.due) await runScheduledTask(t, { trigger:'schedule', dueAt: verdict.dueAt });
   }
  } catch(e){ console.error('[tasks] tick failed:', e?.message || e); }
 };
 taskTickTimer = setInterval(tick, 30_000);
 taskTickTimer.unref?.();
 // Not on the boot tick: a restart during the minute a daily task is due would
 // otherwise fire it before projects have their sessions back.
 setTimeout(tick, 45_000);
 console.log('[tasks] scheduler armed');
}

// Configure a project's workspace-local git credentials.
//
// THE DASHBOARD DOES NOT TOUCH THE REPOSITORY. Everything below decides WHAT the
// state should be; the state is then applied by app/credential-writer.mjs
// running as the validated workspace owner, which pins the repository by
// descriptor and makes the whole file+config transition all-or-nothing. See
// app/git-credentials.js for why a root write into a pane-owned tree was a local
// privilege escalation, and why a pathname is never used twice.
//
// The desired state is resolved from disk INSIDE the serialization domain, so a
// caller holding a `users` snapshot taken before the lock can no longer write a
// token that was rotated in the meantime. An empty token means REVOKE.
//
// Failures propagate. They are not swallowed: a credential that could not be
// written, and a revocation that could not be confirmed, are exactly the states
// an operator has to hear about.
async function syncProjectCredentials(project){
 if(!project?.path) return { applied:false, skipped:'no-path' };
 return credentialDomain.withLocks(['lifecycle','projects','credential'], async () => {
  const projects = await loadProjects();
  // An absolute path is only ever eligible when it is the EXACT registered
  // workspace path of a project, checked inside the helper against this list.
  const registeredPaths = projects.map(p => p?.path).filter(Boolean);
  const users = await loadUsers();
  const owner = project.primaryUser ? users.find(u => u.username === project.primaryUser) : null;
  const token = owner?.ghToken ? (decrypt(owner.ghToken) || '') : '';
  const terminal = await terminalOwner();
  const plan = credentialExecutionPlan({ owner: terminal, currentUid: process.getuid?.() ?? null });
  // Resolved from passwd, INDEPENDENTLY of whoever this process happens to be:
  // an ownership assertion against our own uid passes identically for the
  // correct and the defective outcome, and is therefore not evidence.
  const expectedUid = terminal ? Number(terminal.uid) : (process.getuid?.() ?? null);
  return runGitCredentialHelperJob({
   action: 'git-credential',
   workspaceRoot,
   projectPath: project.path,
   registeredPaths,
   token,
   expectedUid,
  }, plan);
 });
}

// ── Per-user CLI credentials (opt-in via PW_PER_USER_CLAUDE) ────────────────
// A project is "owned" by its primaryUser. When per-user creds are enabled, the
// project's terminal launches with CLAUDE_CONFIG_DIR pointed at that owner's
// private config dir, so Claude runs on the owner's OWN login/seat. The first
// `claude` run in the project triggers the owner's OAuth login into that dir;
// it then persists. Copilot rides on the owner's GitHub token (GH_TOKEN), which
// is delivered through a 0600 rcfile — never argv (see user-credentials.js).
// NOTE: all sessions still run as one OS user — this gives per-user
// accountability/seat-usage, NOT hard OS isolation between users on the box.
function userClaudeDir(username){ return userClaudeConfigDir(USER_CRED_BASE, username); }
// Whether this owner has completed their own Claude login (GET /api/users'
// claudeSignedIn column). Routed through the SAME privilege-dropped helper
// as every other read of the credential tree — never fs.stat() as this
// (possibly root) process — because stat() follows a symlink at the final
// component, and a pane user could plant one at
// <base>/<victim>/claude/.credentials.json pointing anywhere readable by
// root, turning the boolean claudeSignedIn field into a 1-bit oracle for an
// arbitrary path's existence/size. Purely informational: any failure here
// (helper unavailable, drop failed) degrades to "not shown as signed in"
// rather than breaking the whole user list.
async function userClaudeSignedIn(username){
 try {
  return await checkUserSignedIn({
   fsp: fs, base: USER_CRED_BASE, username,
   owner: await terminalOwner(), currentUid: process.getuid?.() ?? null, runJob: runCredentialJob,
  });
 } catch(e){
  console.warn(`[per-user-claude] ${username}: could not determine Claude sign-in status: ${e?.message || e}`);
  return false;
 }
}
// The account agent panes run as. Resolved once and memoised — but ONLY on
// success: a passwd lookup that merely failed (an unanswered directory query)
// must not disable per-user credentials for the life of the process, whereas a
// stable answer never changes underneath us.
const passwdLookup = makePasswdLookup({ execFile: execFileAsync, readFile: fs.readFile });
let terminalOwnerCache;
async function terminalOwner(){
 if(terminalOwnerCache !== undefined) return terminalOwnerCache;
 const owner = await resolveTerminalOwner(process.env, passwdLookup);
 terminalOwnerCache = owner;
 return owner;
}
// Who owns workspace content, and who runs workspace git. Never the literal
// 'admin': the pane account is deployment-specific, which is the whole reason
// terminal-owner.js exists and why tmux() resolves the account rather than
// naming one. Falls back to the same hostTerminalUser() default tmux() uses, so
// the two cannot disagree about whose files these are.
//
// The chown spec is numeric whenever the uid/gid are known, because a name does
// not have to resolve inside this process's view of /etc/passwd — the container
// deployment configures the owner by uid precisely because of that.
async function workspaceOwner(){
 let owner = null;
 try { owner = await terminalOwner(); } catch { owner = null; }
 const user = owner?.user || hostTerminalUser(process.env);
 const spec = Number.isInteger(owner?.uid) && Number.isInteger(owner?.gid)
  ? `${owner.uid}:${owner.gid}`
  : `${user}:${user}`;
 return { user, spec };
}
// NOTHING under `<project>/_inbox` or `<project>/_outbox` is touched by this
// process.
//
// Both boxes belong to the pane account, so replacing either with a symlink is
// within that account's authority — and this dashboard runs as root. The
// superseded upload path did a root mkdir, a root writeFile and then
// `chown <owner> <_inbox> <file>`, and every one of those follows a link at the
// final component (GNU chown takes no -h and no -P here): with
// `_inbox -> /some/root/dir` the chown converted the TARGET and left the link
// untouched. The same substitution made every other route on both boxes a root
// primitive as well — readdir/stat disclosed a root-only directory, sendFile and
// download served root-only bytes, `rm <box>/<name>` deleted an arbitrary root
// file by basename, and the recursive clear-all emptied an arbitrary root
// directory. No amount of lstat-ing first repairs that, because check-then-use
// is still a race.
//
// So every box operation goes to app/workspace-writer.mjs running AS the
// terminal owner, through the same fixed-argv drop the credential helper uses,
// with payloads streamed on its stdin/stdout. No chown is needed for a write:
// the file is created by its eventual owner. See app/workspace-file.js.
const WORKSPACE_HELPER = path.join(path.dirname(new URL(import.meta.url).pathname), 'workspace-writer.mjs');
// A handover that cannot be arranged FAILS the request. Falling back to doing
// the work as root is the defect itself, and swallowing the failure — as the old
// best-effort chown did — makes the boundary invisible rather than present.
async function workspaceArgv(){
 let owner;
 try { owner = await terminalOwner(); }
 catch(e){
  throw new Error(`Refused: the terminal owner could not be resolved, and the dashboard will not touch a workspace as root (${e?.message || e})`);
 }
 const plan = credentialExecutionPlan({ owner, currentUid: process.getuid?.() ?? null });
 return workspaceJobArgv({ plan, execPath: process.execPath, helperPath: WORKSPACE_HELPER });
}
async function boxWrite(project, box, name, source, { allowEmpty = false } = {}){
 return runWorkspaceWrite({
  spawn, argv: await workspaceArgv(), source,
  job: { action:'box-write', projectPath: project.path, box, name, allowEmpty },
 });
}
async function boxJob(project, box, action, name){
 return runWorkspaceJob({ spawn, argv: await workspaceArgv(), job: { action, projectPath: project.path, box, name } });
}
async function boxRead(project, box, name){
 return runWorkspaceRead({ spawn, argv: await workspaceArgv(), job: { action:'box-read', projectPath: project.path, box, name } });
}
// The absolute path and download URL a listing carries. Pure string composition —
// the dashboard learns the NAMES from the worker and never touches the directory.
function boxFileFacts(p, box, name){
 return {
  path: path.join(p.path, box, name),
  url: box === OUTBOX_DIR
   ? `${BASE}/api/outbox/${encodeURIComponent(p.name)}/file/${encodeURIComponent(name)}`
   : `${BASE}/file/${encodeURIComponent(p.name)}/${encodeURIComponent(name)}`,
 };
}
// An upload name is always `<ISO stamp>-<slug><ext>`, built here so the worker
// only ever receives a single, already-safe path component.
function inboxUploadName(filename, ext){
 const safe = slug(path.basename(filename, path.extname(filename)));
 const stamp = new Date().toISOString().replace(/[:.]/g,'-');
 return `${stamp}-${safe}${ext}`;
}
// `Received 0 bytes` is the streaming route's own 400, not a server fault.
function uploadStatus(e){ return e?.code === 'empty-payload' ? 400 : 500; }
// RFC 6266, the same shape express's res.download produced. Built here rather
// than pulled from express's transitive `content-disposition` dependency, which
// this app does not declare.
function attachmentHeader(name){
 const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
 return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
// Stream one box entry to the client through the dropped worker. Replaces
// res.sendFile/res.download, which resolved the path in THIS process and would
// therefore still traverse a substituted box; an O_NOFOLLOW open here would not
// help either, because it only guards the final component.
async function sendBoxFile(res, p, box, rawName, { attachment = false } = {}){
 const name = path.basename(String(rawName || ''));
 let out;
 try {
  out = await boxRead(p, box, name);
 } catch(e){
  return res.status(e?.code === 'not-found' ? 404 : 500).send(e?.code === 'not-found' ? 'Not found' : 'Could not read file');
 }
 res.type(path.extname(name) || 'application/octet-stream');
 res.setHeader('Content-Length', String(out.result.bytes));
 // No byte ranges: a range would cost a second privileged round trip per
 // request, and nothing in the drawer seeks within a file drop.
 res.setHeader('Accept-Ranges', 'none');
 if(attachment) res.setHeader('Content-Disposition', attachmentHeader(name));
 const stop = ()=>{ try { out.child.kill('SIGTERM'); } catch {} };
 res.on('close', stop);
 out.stream.on('error', ()=>{ stop(); res.destroy(); });
 return out.stream.pipe(res);
}
// Credential-tree work is NEVER done by this root process: the tree lives under
// an account every terminal shares, so a root write there is a symlink attack
// away from being a local root escalation. We drop to that account and run
// app/credential-writer.mjs, handing it the job (token included) on stdin so it
// never reaches a command line. See app/user-credentials.js for the full note.
const CREDENTIAL_HELPER = path.join(path.dirname(new URL(import.meta.url).pathname), 'credential-writer.mjs');
function runCredentialJob(job, plan){
 const argv = credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath: CREDENTIAL_HELPER });
 return spawnCredentialJob({ spawn, argv, job });
}
// The git-credential job ALWAYS runs in a one-shot child process, even when no
// privilege drop is needed (dashboard and panes share an account): it pins the
// repository by chdir()ing into it, and chdir is process-global — the dashboard
// must never move. The drop itself still goes through the same vetted
// abstraction as every other credential job.
function gitCredentialArgv(plan){
 return plan.drop
  ? credentialDropArgv({ owner: plan.owner, execPath: process.execPath, helperPath: CREDENTIAL_HELPER })
  : [process.execPath, CREDENTIAL_HELPER];
}
function runGitCredentialHelperJob(job, plan){
 return spawnCredentialJob({ spawn, argv: gitCredentialArgv(plan), job });
}
// Drop credential trees that no longer belong to a current user. Called after a
// deletion and once at boot, so a tree orphaned while the service was down (or
// by an out-of-band edit of users.json) does not linger with a live token in it.
async function pruneUserCredentialTrees(users){
 if(!PER_USER_CLAUDE) return { removed: [] };
 const list = users || await loadUsers();
 return pruneCredentials({
  fsp: fs, base: USER_CRED_BASE, keep: list.map(u => u.username).filter(Boolean),
  owner: await terminalOwner(), currentUid: process.getuid?.() ?? null, runJob: runCredentialJob,
 });
}
// Hand back any box the SUPERSEDED root upload path created, once at boot.
//
// Every box operation now runs as the terminal owner (see workspace-file.js),
// but the directories the old root path had already made are `root:root`, and
// the worker cannot create its O_EXCL temp file in one:
//
//   Paste failed: EACCES ... open '<project>/_inbox/.pw-inbox-<pid>-<rand>.part'
//
// So on every instance that predates the boundary, uploads into an ALREADY-USED
// box fail and nothing repairs them. Same shape as pruneUserCredentialTrees:
// state that went stale while the old code was in charge, repaired once on the
// way up rather than discovered by a user.
//
// Only when this process is actually root — nothing to hand over when the
// dashboard and the panes already share an account, and a non-root chown would
// only ever be EPERM. The handover itself is race-proof by construction
// (open O_NOFOLLOW|O_DIRECTORY, then fchown the handle); see
// app/workspace-box-owner.js for why that is not the vulnerability round 17
// removed.
async function repairLegacyBoxOwnership(){
 if(ISOLATED) return { repaired: [], refused: [] };
 if((process.getuid?.() ?? null) !== 0) return { repaired: [], refused: [] };
 const owner = await terminalOwner();
 if(!Number.isInteger(owner?.uid) || !Number.isInteger(owner?.gid)) return { repaired: [], refused: [] };
 return repairWorkspaceBoxes({ fsp: fs, projects: await loadProjects(), owner });
}
// What a project's tmux session should be launched with. `tokens` are extra
// non-secret `env` KEY=VALUE entries; `shellArgs` is the pane shell's argv tail;
// `key` is the credential fingerprint stamped on the session (see CRED_KEY_OPTION).
const DEFAULT_SHELL_ARGS = ['--noprofile','--norc'];
// Resolve the project's credential owner, or `null` for the two cases where
// shared credentials are the INTENDED behaviour: the feature is off, or the
// project intentionally has no primaryUser. Every other failure — the users
// store cannot be read, the primaryUser doesn't resolve to a record, the
// owner's GitHub token cannot be decrypted — THROWS. It must never be
// swallowed into a `null` here, because the only caller-visible difference
// between "no owner" and "owner resolution failed" is whether the session
// launches under the shared identity, and AC1 is exactly that a failure must
// never do that silently (or warning-only).
async function projectCredentialOwner(project){
 if(!PER_USER_CLAUDE || !project?.primaryUser) return null;
 const users = await loadUsers();
 // Delegates to app/project-owner.js so this dashboard path and
 // app/project-terminal-credentials.mjs (the host-mode systemd terminal
 // startup path) enforce the identical fail-closed contract — one
 // implementation, not two that could drift.
 return resolveProjectCredentialOwner({ perUserEnabled: PER_USER_CLAUDE, project, users, decrypt });
}
// The fingerprint a project SHOULD be running on, computed without creating or
// touching anything — cheap enough for the status poll. Propagates the same
// failures as projectCredentialOwner(); callers that are read-only status
// polls (not launches) decide separately how to surface that.
async function desiredCredentialKey(project){
 const owner = await projectCredentialOwner(project);
 if(!owner) return CREDENTIALS_OFF;
 return credentialFingerprint({ username: owner.username, configDir: userClaudeDir(owner.username), ghToken: owner.ghToken });
}
// What a session should launch with. THROWS — never falls back to the shared
// login — when the feature is on, the project has a primaryUser, and that
// owner's credentials cannot be resolved or materialized for any reason
// (unreadable users store, undecryptable token, missing owner record, a
// failing privilege-dropped helper). A working shared session that nobody
// asked for is not an acceptable substitute for a broken private one: it is
// exactly the silent identity swap this feature must not perform. Callers
// (ensureTmuxSession / newTmuxWindow) are already wrapped by route-level
// try/catch, so this failure reaches the operator as a real error instead of
// vanishing into a console.warn.
async function credentialContext(project){
 const off = { tokens: [], shellArgs: DEFAULT_SHELL_ARGS, key: CREDENTIALS_OFF };
 let owner;
 try {
  owner = await projectCredentialOwner(project);
 } catch(e){
  throw new Error(`[per-user-claude] project "${project?.name || '?'}" cannot resolve its credential owner (primaryUser "${project?.primaryUser || ''}"): ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
 }
 if(!owner) return off;
 try {
  const cred = await ensureUserCredentials({
   fsp: fs, base: USER_CRED_BASE, username: owner.username,
   ghToken: owner.ghToken, sharedClaudeJson,
   owner: await terminalOwner(), currentUid: process.getuid?.() ?? null, runJob: runCredentialJob,
  });
  return {
   tokens: ['CLAUDE_CONFIG_DIR=' + cred.configDir],
   shellArgs: cred.envFile ? ['--noprofile','--rcfile',cred.envFile] : DEFAULT_SHELL_ARGS,
   key: cred.fingerprint,
  };
 } catch(e){
  throw new Error(`[per-user-claude] project "${project.name}" (owner "${owner.username}") credential materialization failed: ${e?.message || e}. Refusing to fall back to the shared Claude/GitHub login.`);
 }
}

// Serialize every projects.json read-modify-write transaction, cross-process
// (app/lifecycle-lock.js) — not just in-process. Concurrent POSTs from two
// browser tabs against ONE dashboard process were already covered by a bare
// in-process promise chain, but that gave no protection at all across TWO
// real dashboard processes (a rolling restart overlap, two instances): each
// would loadProjects() its own snapshot, mutate independently, and
// last-write-wins on saveProjects — the exact same defect class closed for
// users.json (round 3) and sessions.json (round 5, item 4). Every call site
// already does its own load/mutate/save inside the callback, so only the
// serialization mechanism changes here, not the call signature.
const PROJECTS_LOCK_PATH = process.env.PW_PROJECTS_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-projects.lock');
// projects.json transactions — and ONLY those. This section legitimately spans
// long external work (clone, chown, routing, systemd), so it must never hold a
// lock that anything latency-sensitive waits on. Credential work reaches the
// same exclusion by taking this lock itself, from the top of the canonical
// order, in its own short section: see syncProjectCredentials() and
// app/credential-domain-lock.js.
async function withProjectsLock(fn){
 return credentialDomain.withLocks(['projects'], fn);
}
// Long, external, latency-unbounded workspace work — clone, chown, rm -rf,
// routing, systemd. It serializes project mutations against each other exactly
// as the projects lock used to, but nothing latency-sensitive waits on it, so a
// 300s clone can no longer stall a token rotation or a login. The registry
// transaction inside it stays SHORT and is what the credential path waits on.
async function withWorkspaceLock(fn){
 return credentialDomain.withLocks(['workspace'], fn);
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
// Optional reverse-proxy / AD pre-auth. When PW_AUTH_HEADER is set (e.g.
// 'x-remote-user'), a TRUSTED upstream (an AD-authenticated nginx that
// overwrites the header on every request) supplies the signed-in username and
// attachUser trusts it — no login page needed. Default '' = DISABLED, so a
// non-AD install never trusts a client-spoofable header. The header user must
// still exist in users.json (the allowlist) to gain a role/projects.
const AUTH_HEADER = (process.env.PW_AUTH_HEADER || '').toLowerCase();
// Dev-only bypass: treat this username as authenticated when no cookie/header
// resolves. Never set in production.
const DEV_USER = process.env.PW_DEV_USER || '';
if(DEV_USER) console.warn('[auth] PW_DEV_USER is set — dev-only bypass active. Do not use in production.');
// Optional sibling-app SSO: when PW_SSO_USER_HEADER is set (e.g. 'X-PW-User'),
// /api/auth/check emits the authenticated username in that response header so
// an nginx auth_request can propagate it to sister apps (e.g. Pulse). The
// sister-app nginx wiring (auth_request_set + proxy_set_header) is env-specific.
// Default '' = DISABLED.
const SSO_USER_HEADER = process.env.PW_SSO_USER_HEADER || '';
console.log(`[auth] mode=${AUTH_MODE} enforce=${AUTH_ENFORCE}${AUTH_HEADER ? ` proxyHeader=${AUTH_HEADER}` : ''}${SSO_USER_HEADER ? ` ssoHeader=${SSO_USER_HEADER}` : ''}`);
console.log(`[deploy] centre=${DEPLOY_CENTRE ? 'on' : 'off'}`);
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

// Legacy GOA `isAdmin` records are mapped to canonical role/projects/id shape
// (and the obsolete flag dropped) by normalizeUserRecord — see app/users-compat.js.
// Shared with app/project-terminal-credentials.mjs (see app/users-file.js) so
// both entrypoints read users.json identically.
async function loadUsers(){ return loadUsersFile(usersPath); }
async function saveUsers(users){
 await fs.mkdir(path.dirname(usersPath),{recursive:true});
 await writeFileAtomic(usersPath, JSON.stringify({ users }, null, 2)+'\n', { mode: 0o600 });
}

// Cross-process serialization for the ENTIRE user lifecycle: every users.json
// read-modify-write (create, rename, delete, reconcile, password change,
// login's lastLoginAt, saving a deploy password) funnels through ONE lock, so
// a rolling restart overlapping the old and new dashboard process, a second
// instance, or just two requests in this SAME process can never interleave
// two snapshot-based read-modify-write cycles against the same file — the
// in-process-only tail chain this replaces (app/user-store.js, still used
// and tested standalone) could not see across a process boundary at all, and
// two DIFFERENT serialization mechanisms guarding the same file would not
// compose (one write landing "between" the other's read and save is exactly
// how an update gets silently lost). Rename/delete additionally hold this
// SAME lock across their project-reference and credential-tree effects, not
// just the users.json write — see the route handlers below.
const LIFECYCLE_LOCK_PATH = process.env.PW_LIFECYCLE_LOCK_PATH || path.join(path.dirname(usersPath), '.pw-lifecycle.lock');
const CREDENTIAL_LOCK_PATH = process.env.PW_CREDENTIAL_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-credential.lock');
const WORKSPACE_LOCK_PATH = process.env.PW_WORKSPACE_LOCK_PATH || path.join(path.dirname(registryPath), '.pw-workspace.lock');
// ONE serialization domain for user-lifecycle, project and credential work,
// acquired in a single canonical order so the composition cannot deadlock and
// an out-of-order acquisition is refused rather than hanging.
const credentialDomain = makeCredentialLockDomain({
 lockPaths: { lifecycle: LIFECYCLE_LOCK_PATH, workspace: WORKSPACE_LOCK_PATH, projects: PROJECTS_LOCK_PATH, credential: CREDENTIAL_LOCK_PATH },
});
async function withUsersLock(mutate){
 return credentialDomain.withLocks(['lifecycle'], async () => {
  const users = await loadUsers();
  const outcome = await mutate(users);
  if(outcome === false) return { changed:false, result: outcome };
  await saveUsers(users);
  return { changed:true, result: outcome };
 });
}

// ---- LDAP (ldap mode) --------------------------------------------------------
// Simple bind over TLS via ldapwhoami (no native deps). The DC cert is validated
// against the system CA bundle (LDAPTLS_CACERT).
// Bind password travels via a private 0600 temp file (never argv, never
// /dev/stdin) and the staging dir is removed as soon as the bind returns —
// see app/ldap-staging.js for the full rationale.
function ldapBindOnce(bindDn, password){
 return ldapBindOnceStaged(bindDn, password, { url: LDAP_URL, cacert: LDAP_CACERT });
}
// A process killed mid-bind can still strand a staging dir; sweep stale ones
// (pattern/uid/age-guarded, bounded) once at startup.
try {
 const swept = scavengeLdapStaging();
 if(swept.length) console.log(`[ldap] scavenged ${swept.length} stale credential staging dir(s)`);
} catch {}
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
  if(!password) return null;   // never attempt an (unauthenticated) empty-password bind
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

// Cross-process serialized, exactly like users.json's withUsersLock: no
// process-local cache (a process-local cache is precisely what made the
// original in-process-only sessionsLock lose sessions across processes — two
// dashboard processes each kept their OWN sessionsCache, and whichever one's
// whole-file write landed last silently discarded every session the OTHER
// process had created or revoked in the meantime). Every mutation reloads
// the current on-disk sessions under the SAME cross-process lifecycle lock
// app/lifecycle-lock.js already provides for users.json, so two real
// processes racing create/revoke/purge can never lose or resurrect a session.
const SESSIONS_LOCK_PATH = process.env.PW_SESSIONS_LOCK_PATH || path.join(path.dirname(sessionsPath), '.pw-sessions.lock');
async function loadSessions(){
 try { const raw = await fs.readFile(sessionsPath,'utf8'); const data = JSON.parse(raw); return Array.isArray(data?.sessions) ? data.sessions : []; }
 catch(e){ if(e.code === 'ENOENT') return []; throw e; }
}
async function saveSessions(sessions){
 await fs.mkdir(path.dirname(sessionsPath),{recursive:true});
 await writeFileAtomic(sessionsPath, JSON.stringify({ sessions }, null, 2)+'\n', { mode: 0o600 });
}
// Per-user landing memory: the project each account opened last. Held server-side
// rather than only in the pw_last cookie, because a cookie is per-device and the
// cockpit is meant to feel like the same desk from any workstation — sign out, move
// machine, sign in, same project.
// This is convenience state, not authorization state: a lost write costs one extra
// redirect. It takes a lock anyway, purely so a read-modify-write cannot clobber
// OTHER users' entries.
const userStatePath = process.env.PW_USER_STATE_PATH || path.join(path.dirname(sessionsPath), 'user-state.json');
const USER_STATE_LOCK_PATH = process.env.PW_USER_STATE_LOCK_PATH || path.join(path.dirname(userStatePath), '.pw-user-state.lock');
async function loadUserState(){
 try { const d = JSON.parse(await fs.readFile(userStatePath,'utf8')); return (d && typeof d.users === 'object' && d.users) ? d.users : {}; }
 catch { return {}; }
}
async function lastProjectForUser(username){
 if(!username) return '';
 const v = (await loadUserState())[username]?.lastProject;
 return typeof v === 'string' ? v : '';
}
async function rememberLastProject(username, project){
 if(!username || !project) return;
 try {
  await withLifecycleLock(USER_STATE_LOCK_PATH, async () => {
   const users = await loadUserState();
   if(users[username]?.lastProject === project) return;
   users[username] = { ...(users[username]||{}), lastProject: project };
   await fs.mkdir(path.dirname(userStatePath),{recursive:true});
   await writeFileAtomic(userStatePath, JSON.stringify({ users }, null, 2)+'\n', { mode: 0o600 });
  });
 } catch { /* a landing pointer is never worth failing a page render over */ }
}
// Where a sign-in lands, in order: what THIS user opened last, then the pw_last
// cookie (covers implicit-admin mode, which has no username, and the first login
// after an upgrade), then the operator's configured default, then the top of the
// rail. Every candidate is checked against the caller's VISIBLE projects, so a
// remembered or configured project the user may no longer open cannot leak.
async function landingProject(req, projects){
 const [remembered, settings] = await Promise.all([
  lastProjectForUser(req.user?.username),
  loadWorkbenchSettings(),
 ]);
 const cookieLast = getCookie(req, 'pw_last');
 return projects.find(p => p.name === remembered)
     || projects.find(p => p.name === cookieLast)
     || projects.find(p => p.name === settings.defaultProject)
     || projects[0];
}
// One global default, so ticking the box on a project claims it and unticking only
// releases it when this project is the current claimant — unticking project B must
// not silently clear a default that points at project A. prevName keeps the claim
// across a rename.
async function applyDefaultProjectFlag(prevName, projectName, raw){
 const want = raw === 'yes' || raw === '1' || raw === 'on' || raw === true;
 const settings = await loadWorkbenchSettings();
 const cur = typeof settings.defaultProject === 'string' ? settings.defaultProject : '';
 const claimed = cur === projectName || (!!prevName && cur === prevName);
 const next = want ? projectName : (claimed ? '' : cur);
 if(next === cur) return;
 settings.defaultProject = next;
 await saveWorkbenchSettings(settings);
}
async function withSessionsLock(mutate){
 return withLifecycleLock(SESSIONS_LOCK_PATH, async () => {
  const sessions = await loadSessions();
  const outcome = await mutate(sessions);
  if(outcome === false) return { changed:false, result: outcome };
  await saveSessions(sessions);
  return { changed:true, result: outcome };
 });
}
async function createSession(userId){
 const { result: id } = await withSessionsLock((sessions) => {
  const newId = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  sessions.push({ id: newId, userId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime()+SESSION_TTL_MS).toISOString() });
  return newId;
 });
 return id;
}
async function revokeSession(id){
 await withSessionsLock((sessions) => {
  const i = sessions.findIndex(s => s.id === id);
  if(i < 0) return false;
  sessions.splice(i,1);
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
 await withSessionsLock((sessions) => {
  const now = new Date();
  const before = sessions.length;
  const kept = sessions.filter(s => new Date(s.expiresAt) >= now);
  if(kept.length === before) return false;
  sessions.length = 0;
  sessions.push(...kept);
 });
}

function userHasProjectAccess(user, projectName){
 if(!user) return false;
 if(user.role === 'admin') return true;
 if(user.projects === '*') return true;
 return Array.isArray(user.projects) && user.projects.includes(projectName);
}
function filterProjectsForUser(projects, user){
 if(!user) return projects;
 if(user.role === 'admin') return projects;
 const visible = projects.filter(p => !p.adminOnly);
 if(user.projects === '*') return visible;
 const allowed = new Set(Array.isArray(user.projects) ? user.projects : []);
 return visible.filter(p => allowed.has(p.name));
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
  // Optional trusted reverse-proxy / AD pre-auth (PW_AUTH_HEADER) or dev bypass
  // (PW_DEV_USER). Only consulted when explicitly enabled; the resolved user
  // must exist in users.json to authenticate (preserves the allowlist gate).
  if(AUTH_HEADER || DEV_USER){
   const raw = (AUTH_HEADER ? req.get(AUTH_HEADER) : '') || DEV_USER || '';
   const username = normalizeUsername(raw);
   if(username){
    const users = await loadUsers();
    const u = users.find(x => x.username === username);
    if(u){ req.user = u; return next(); }
   }
  }
  req.user = AUTH_ENFORCE ? null : IMPLICIT_ADMIN;
  return next();
 } catch(e){ next(e); }
}

function wantsJson(req){
 return req.path.startsWith(BASE + '/api/') || (req.get('accept') || '').includes('json');
}
function requireAuth(req, res, next){
 if(req.user) return next();
 if(wantsJson(req)) return res.status(401).json({ ok:false, error:'Authentication required' });
 return res.redirect(BASE + '/login?next=' + encodeURIComponent(req.originalUrl || req.url));
}
function requireAdmin(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(req.user.role === 'admin') return next();
 if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Admin role required' });
 return res.status(403).type('html').send(`<h1>403 — Admin access required</h1><p>Your account (<b>${esc(req.user.username)}</b>, role: <b>${esc(req.user.role)}</b>) cannot access this page.</p><p><a href="${BASE}/">Back to dashboard</a></p>`);
}
// Self-heal endpoints accept either an admin session or a trusted on-box caller
// (installer/deploy hitting 127.0.0.1:3000 directly), so a redeploy can heal
// nginx without an interactive admin login even when auth enforcement is on.
function requireAdminOrLocal(req, res, next){
 if(isTrustedLocal(req)) return next();
 return requireAdmin(req, res, next);
}
async function requireProjectAccess(req, res, next){
 try {
  const projectName = req.params.project || req.params.name || req.params.oldName;
  if(!projectName){ if(wantsJson(req)) return res.status(400).json({ok:false,error:'No project in route'}); return res.status(400).send('No project in route'); }
  if(!req.user) return requireAuth(req, res, next);
  if(req.user.role !== 'admin'){
   const projects = await loadProjects();
   const proj = projects.find(x => x.name === projectName);
   if(proj?.adminOnly){
    if(wantsJson(req)) return res.status(403).json({ ok:false, error:`Not authorized for project "${projectName}"` });
    return res.status(403).type('html').send(`<h1>403 — Project access denied</h1><p>You are not authorized to access <b>${esc(projectName)}</b>.</p><p><a href="${BASE}/">Back to dashboard</a></p>`);
   }
  }
  if(userHasProjectAccess(req.user, projectName)) return next();
  if(wantsJson(req)) return res.status(403).json({ ok:false, error:`Not authorized for project "${projectName}"` });
  return res.status(403).type('html').send(`<h1>403 — Project access denied</h1><p>You are not authorized to access <b>${esc(projectName)}</b>.</p><p><a href="${BASE}/">Back to dashboard</a></p>`);
 } catch(e){ next(e); }
}
function requireTerminalAccess(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(!TERMINAL_ROLES.has(req.user.role)){
  if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Terminal/Claude access requires admin or developer role' });
  const hint = req.user.role === 'content_editor' ? ' The PVIKPBot supervised workflow is planned for Phase 2.' : '';
  return res.status(403).type('html').send(`<h1>403 — Terminal access denied</h1><p>Your role (<b>${esc(req.user.role)}</b>) cannot open project terminals.${hint}</p><p><a href="${BASE}/">Back to dashboard</a></p>`);
 }
 return requireProjectAccess(req, res, next);
}
function requireInboxWrite(req, res, next){
 if(!req.user) return requireAuth(req, res, next);
 if(!INBOX_WRITE_ROLES.has(req.user.role)){
  if(wantsJson(req)) return res.status(403).json({ ok:false, error:'Uploading requires admin, developer, or content_editor role' });
  return res.status(403).type('html').send(`<h1>403 — Upload denied</h1><p>Your role (<b>${esc(req.user.role)}</b>) cannot upload to project inboxes.</p><p><a href="${BASE}/">Back to dashboard</a></p>`);
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

// ── Deploy Centre credential encryption (AES-256-GCM) ───────────────────────
// Shared with app/project-terminal-credentials.mjs (see app/secret-crypto.js)
// so the host-mode terminal-startup path decrypts a user's GitHub token with
// the exact same implementation, not a second hand-copied one that could
// silently drift from it.
const { encrypt, decrypt } = makeSecretCrypto({ secretKeyPath: SECRET_KEY_PATH });

// ─── Deploy Centre helpers ──────────────────────────────────────────────────
async function loadDeployConfig(){ try { return JSON.parse(await fs.readFile(deployConfigPath,'utf8')); } catch { return {}; } }
async function saveDeployConfig(cfg){ await fs.mkdir(path.dirname(deployConfigPath),{recursive:true}); await fs.writeFile(deployConfigPath, JSON.stringify(cfg,null,2)+'\n'); }
async function appendDeployLog(entry){ await fs.mkdir(path.dirname(deployLogPath),{recursive:true}); await fs.appendFile(deployLogPath, JSON.stringify(entry)+'\n'); }
async function readDeployLog(project){
 try {
  const raw = await fs.readFile(deployLogPath,'utf8');
  const lines = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return project ? lines.filter(e => e.project === project) : lines;
 } catch { return []; }
}
// Run a deploy slot's operator-authored shell text as the PANE ACCOUNT.
//
// Same rule startPreviewUnit() and app/workspace-file.js state: root performs no
// filesystem operation below a path the terminal account controls. A deploy slot
// is the largest such operation in the product — arbitrary shell, authored in the
// UI, run on the workspace.
//
// THIS IS THE SEAM THAT RE-BROKE Bi-Tools AFTER THE PREVIEW WAS FIXED. Five of
// this instance's slots `git pull` into the workspace before publishing, and a
// fast-forward merge performed by root rewrites every working-tree file the merge
// touches — tracked source included — as root:root. The agent in the pane then
// gets `EACCES: permission denied, open '<ws>/Pages/Dashboards/X.cshtml'` on a
// file it wrote itself the day before, plus root-owned `.git/objects/<xx>` fanout
// directories that make a later `git add` fail intermittently.
//
// A cwd-keyed audit does NOT find this seam: the slot script `cd`s itself, so the
// exec passes no `cwd` at all. See test/preview-privilege.test.mjs.
//
// HOME MATTERS AS MUCH AS THE UID. Dropped to admin while still carrying the
// dashboard's root HOME, `dotnet publish` would look for /root/.nuget and `git`
// for /root/.git-credentials, and the deploy would fail on permissions instead of
// running. So HOME/USER/LOGNAME travel with the drop — which also makes the
// deploy's git identity the same one the agent in the pane already uses.
//
// ESCAPE HATCH: a slot that genuinely needs root (on this instance TeamKB,
// TeamPulse and VisualIdentity — podman, systemctl, host paths outside the
// workspace) sets `"runAsRoot": true` on its target in deploy-config.json.
// Deliberately not a UI field: it is a privilege grant, so it should take an
// operator editing the registry. POST /api/deploy/config spreads the existing
// target object, so saving a script from the UI preserves the flag.
function deployExec(tc, argvTail, env, timeoutMs){
 const drop = tc?.runAsRoot ? [] : agentSpawnDrop(TERMINAL_PRIV);
 const execEnv = { ...env };
 if(drop.length){ execEnv.HOME = TERMINAL_PRIV.home; execEnv.USER = TERMINAL_PRIV.user; execEnv.LOGNAME = TERMINAL_PRIV.user; }
 const argv = [...drop, ...argvTail];
 return execFileAsync(argv[0], argv.slice(1), { timeout: timeoutMs, env: execEnv });
}
async function getDeployedVersion(project, target, cfg, env){
 const pc = cfg[project]; if(!pc || !pc[target]) return null;
 const versionCmd = pc[target].versionCmd;
 if(!versionCmd) return null;
 try {
  const execEnv = env ? {...process.env, ...env} : {...process.env};
  const { stdout } = await deployExec(pc[target], ['bash','-c',versionCmd], execEnv, 30000);
  return stdout.trim() || null;
 } catch { return null; }
}
function getDeployEnv(users, preferredUser){
 if(preferredUser?.deployPassword) return { DEPLOY_USER: preferredUser.deployUser || preferredUser.username, DEPLOY_PASSWORD: decrypt(preferredUser.deployPassword) };
 const fallback = users.find(u => u.deployPassword);
 if(fallback) return { DEPLOY_USER: fallback.deployUser || fallback.username, DEPLOY_PASSWORD: decrypt(fallback.deployPassword) };
 return null;
}
const DEFAULT_DEPLOY_SLOTS = { dev:{ label:'Development', icon:'🧪' }, prod:{ label:'Production', icon:'🚀' } };
function deploySlot(project, target){
 const d = DEFAULT_DEPLOY_SLOTS[target] || { label:target, icon:'' };
 const o = (project && project.deploySlots && project.deploySlots[target]) || {};
 return { label: o.label || d.label, icon: (o.icon != null ? o.icon : d.icon), options: Array.isArray(o.options) ? o.options : [] };
}
function deployOptionSelect(slot){
 if(!slot.options || !slot.options.length) return '';
 const opts = slot.options.map(o => `<option value="${esc(String(o.value))}">${esc(String(o.label||o.value))}</option>`).join('');
 return `<select class="deploy-option" title="Release level" style="background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:6px;padding:.25rem .4rem;font-size:.8rem;margin-right:.4rem">${opts}</select>`;
}
async function getLocalVersion(projectPath){
 try {
  const { stdout } = await execFileAsync('bash',['-c',
   "find . \\( -name .git -o -name node_modules -o -name bin -o -name obj -o -name .vs -o -name dist -o -name .publish-output \\) -prune -o -type f -printf '%T@\\n' 2>/dev/null | sort -nr | head -1"
  ],{timeout:15000, cwd:projectPath});
  const epoch = parseFloat(stdout.trim());
  if(!Number.isFinite(epoch) || epoch <= 0) return null;
  const d = new Date(epoch*1000);
  const p2 = n => String(n).padStart(2,'0');
  const version = `V1.${p2(d.getFullYear()%100)}.${p2(d.getMonth()+1)}${p2(d.getDate())}.${p2(d.getHours())}${p2(d.getMinutes())}`;
  let hash = '';
  try { hash = (await execFileAsync('git',['rev-parse','--short','HEAD'],{timeout:5000,cwd:projectPath})).stdout.trim(); } catch {}
  return { version, hash };
 } catch { return null; }
}
const DEPLOY_STAMP_RE = /^V1\.\d{2}\.\d{4}\.\d{4}$/;
function sourceNewer(src, dep){
 return !!src && !!dep && DEPLOY_STAMP_RE.test(src) && DEPLOY_STAMP_RE.test(dep) && src > dep;
}
// Rendered unconditionally and hidden when it does not apply, because a deploy
// changes the answer and the client has to be able to correct it in place. It used
// to be emitted only when true, so after a successful deploy the version text was
// rewritten and the badge was left behind — claiming the working copy was newer
// than a build that had just superseded it.
function sourceNewerBadge(src, dep){
 const on = sourceNewer(src, dep);
 return `<span class="src-newer-badge" style="${'display:inline-block;margin-left:.5rem;font-size:.72rem;font-weight:600;color:#fde68a;background:rgba(245,158,11,.15);border:1px solid #b45309;border-radius:999px;padding:.05rem .5rem;white-space:nowrap'}"`
  + (on ? '' : ' hidden')
  + ` title="Working copy is newer than the deployed build — deploy to update">⬆ source newer</span>`;
}
function hasDeployConfigFor(projectName, cfg){
 return !!(cfg && cfg[projectName]);
}
// Registry URLs are operator-supplied and get rendered straight into an href, so
// only http(s) may survive: a stored javascript: or data: URL would otherwise be
// one-click script execution for whoever opens the menu. Anything unparseable or
// off-scheme is dropped rather than escaped, because there is no safe way to
// render it as a link at all.
//
// URL CREDENTIALS ARE DROPPED THE SAME WAY. `new URL(...).href` preserves
// `username:password@` userinfo verbatim, and projectLinksMenu() renders the URL
// twice — once in the href, once as VISIBLE TEXT in the menu row — so a repo
// configured as a clone URL with a token in it (`https://user:ghp_…@github.com/…`)
// published that token to everyone who could open the cockpit, and shipped it in
// the href of every click. The whole link is omitted rather than stripped: a link
// that silently drops half of what an operator configured is its own kind of
// wrong, and there is no way to render the credential safely.
function safeHttpUrl(v){
 const s = String(v ?? '').trim();
 if(!s) return '';
 try {
  const u = new URL(s);
  if(u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  // Either half alone is userinfo: `https://:pw@host` carries no username.
  if(u.username || u.password) return '';
  return u.href;
 }
 catch { return ''; }
}
// repo is stored as a clone URL; drop the .git so the link opens the browsable page.
function repoBrowseUrl(repo){
 const u = safeHttpUrl(repo);
 return u ? u.replace(/\.git$/, '') : '';
}
function projectLinkItems(p){
 return [
  { label:'GitHub repo', url: repoBrowseUrl(p?.repo) },
  { label:'Dev site',    url: safeHttpUrl(p?.devUrl) },
  { label:'Prod site',   url: safeHttpUrl(p?.prodUrl) },
 ].filter(l => l.url);
}
function projectLinksMenu(p){
 const items = projectLinkItems(p);
 const body = items.length
  ? items.map(l => `<a class="tabMenuItem" role="menuitem" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span class="ti-name">${esc(l.label)}</span><span class="ti-cmd">${esc(l.url)}</span></a>`).join('')
  : `<span class="tabMenuItem empty">No links configured — add them in Manage projects</span>`;
 return `<div class="tabMenu projLinks" id="projLinksMenu" role="menu" aria-label="Project links" hidden>${body}</div>`;
}
const projLinksScript = `<script>(function(){const btn=document.getElementById('projChipBtn'),menu=document.getElementById('projLinksMenu');if(!btn||!menu)return;function close(){menu.hidden=true;btn.setAttribute('aria-expanded','false')}function open(){menu.hidden=false;btn.setAttribute('aria-expanded','true')}btn.addEventListener('click',e=>{e.stopPropagation();menu.hidden?open():close()});document.addEventListener('click',e=>{if(!menu.hidden&&!btn.contains(e.target)&&!menu.contains(e.target))close()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){close();btn.focus()}});menu.addEventListener('click',e=>{if(e.target.closest('a'))close()})})();</script>`;
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
// Container mode has no project-preview@.service, so preview runs are managed
// by this node process with recent stdout/stderr kept for the logs endpoint.
const previewProcs = new Map();
const PREVIEW_LOG_MAX = 500;
function previewState(name){ return previewProcs.get(name) || null; }
function previewCommand(p){
 const port = Number(p.preview.port);
 const basepath = `${BASE}/preview/${p.name}`;
 return p.preview.cmd.replace(/\$\{PORT\}/g, String(port)).replace(/\$\{BASEPATH\}/g, basepath);
}
async function previewStatus(p){
 if(!hasPreview(p)) return { configured:false, active:false, ready:false };
 if(DEPLOY_MODE === 'container'){
  const state = previewState(p.name);
  const active = !!(state && state.proc && state.proc.exitCode === null);
  const pid = active ? state.pid : null;
  const since = state ? state.since : null;
  const result = state ? state.result : null;
  const exitCode = state ? state.exitCode : null;
  const ready = active ? await probePreviewReady(p.preview.port) : false;
  let lastError = null;
  if(!active && state && result && result !== 'success'){
   lastError = state.log.slice(-15).join('\n').slice(-1500);
  }
  return { configured:true, active, ready, since, pid, port:Number(p.preview.port), basepath:`${BASE}/preview/${p.name}`, url:`${BASE}/preview/${p.name}/`, result, exitCode, lastError, cmd:previewCommand(p) };
 }
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
 return { configured:true, active, ready, since, pid, port:Number(p.preview.port), basepath:`${BASE}/preview/${p.name}`, url:`${BASE}/preview/${p.name}/`, result, exitCode, lastError };
}
async function previewLogs(name, lines=200){
 if(DEPLOY_MODE === 'container'){
  const state = previewState(name);
  if(!state) return '(no preview has been started)';
  return state.log.slice(-lines).join('\n');
 }
 try { const { stdout } = await execFileAsync('journalctl',['-u',previewUnit(name),'--no-pager','-n',String(Number(lines)||200),'-o','cat'],{timeout:5000}); return stdout; }
 catch(e){ return `[no logs] ${e.message || e}`; }
}
async function startPreviewUnit(p){
 if(!hasPreview(p)) throw new Error('Preview is not configured for this project');
 if(DEPLOY_MODE !== 'container'){ await sh('systemctl',['restart',previewUnit(p.name)]); return; }
 await stopPreviewUnit(p.name);
 const port = Number(p.preview.port);
 const basepath = `${BASE}/preview/${p.name}`;
 const cwd = p.path || workspacePath(p.name);
 const userEnv = (p.preview && p.preview.env && typeof p.preview.env === 'object') ? p.preview.env : {};
 const env = { ...process.env, ...userEnv, PORT:String(port), BASEPATH:basepath, DOTNET_ENVIRONMENT:'Development', ASPNETCORE_ENVIRONMENT:'Development', DOTNET_CLI_HOME:path.join(cwd,'.dotnet'), HOME:cwd };
 // THE PREVIEW RUNS AS THE PANE ACCOUNT, NOT AS ROOT. Same rule app/workspace-file.js
 // states for the boxes: the root dashboard performs no filesystem operation below a
 // path the terminal account controls. This spawn is the strongest form of one — it
 // runs the PROJECT's own code, in the project's workspace, with HOME and
 // DOTNET_CLI_HOME pointed INTO that tree. Undropped it made everything the app and
 // the SDK create root-owned inside a tree the agent owns: the whole
 // `<ws>/.dotnet` NuGet cache, `bin/`, `obj/`, and the app's own `App_Data/`
 // (SQLite db + DataProtection keys, the last of them mode 0600 and so unreadable
 // to the account that has to run the app next). The agent in the pane then cannot
 // build, and `dotnet` cannot rewrite its own cache. Host mode never had this: the
 // unit runs the same command under `User=` (systemd/project-preview@.service).
 // setpriv execs in place, so proc.pid below is still the shell stopPreviewUnit signals.
 const drop = agentSpawnDrop(TERMINAL_PRIV);
 if(drop.length){ env.USER = TERMINAL_PRIV.user; env.LOGNAME = TERMINAL_PRIV.user; }
 const argv = [...drop,'bash','-c',previewCommand(p)];
 const proc = spawn(argv[0],argv.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});
 const state = { proc, pid:proc.pid, since:new Date().toISOString(), exitCode:null, result:null, log:[], stopping:false };
 function appendLog(line){ state.log.push(line); if(state.log.length > PREVIEW_LOG_MAX) state.log.shift(); }
 proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(appendLog));
 proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(appendLog));
 proc.on('exit', (code, signal) => { state.exitCode = state.stopping ? null : code; state.result = state.stopping ? null : (code === 0 ? 'success' : (signal ? 'signal' : 'exit-code')); state.proc = null; state.stopping = false; });
 proc.on('error', e => { appendLog(`[spawn error] ${e.message}`); state.result = 'spawn-error'; state.proc = null; });
 previewProcs.set(p.name, state);
}
async function stopPreviewUnit(name){
 if(DEPLOY_MODE !== 'container'){ await sh('systemctl',['stop',previewUnit(name)]).catch(()=>{}); await sh('systemctl',['disable',previewUnit(name)]).catch(()=>{}); return; }
 const state = previewState(name);
 if(state && state.proc && state.proc.exitCode === null){
  state.stopping = true;
  state.proc.kill('SIGTERM');
  await new Promise(r=>setTimeout(r,2000));
  if(state.proc && state.proc.exitCode === null) state.proc.kill('SIGKILL');
 }
}
// Commands that can bring a tmux server into existence. Anything here must pass
// the ownership gate first — the dashboard creating a session from its OWN
// service cgroup is exactly the bypass Round 8 found, and the terminal recycle
// path reaches it.
const TMUX_SERVER_CREATING = new Set(['new-session','start-server','new-window']);
async function tmux(args,opts={}){
 if(TMUX_SERVER_CREATING.has(args[0])){
  // Refuses on a foreign server AND when the helper is unavailable; never skips.
  await assertTmuxOwner({ env: process.env });
 }
 if(DEPLOY_MODE === 'container') return execFileAsync('tmux',['-u',...(TMUX_SOCKET?['-L',TMUX_SOCKET]:[]),...args],{timeout:10000,...opts});
 // hostTerminalUser() (not a literal) so the account panes run as and the account
 // per-user credential files are chowned to cannot drift apart — see terminal-owner.js.
 return execFileAsync('sudo',['-u',hostTerminalUser(process.env),'tmux',...(TMUX_SOCKET?['-L',TMUX_SOCKET]:[]),...args],{timeout:10000,...opts});
}
function parseTmuxWindows(stdout){
 return String(stdout || '').split('\n').filter(Boolean).map(line=>{
  const parts = line.split('|');
  const index = Number(parts[0]);
  // bell = tmux's window_bell_flag, set when monitor-bell catches a BEL in a
  // window that isn't being viewed (e.g. Claude rings the terminal bell when
  // it finishes a turn). tmux clears it automatically when the window is
  // selected, so the front-end gets "clear on click" for free.
  const bell = parts[3] === '1';
  return { index, name:parts[1] || `#${parts[0]}`, active:parts[2] === '1', bell, attached:Number(parts[4]) || 0, activity:Number(parts[5]) || 0 };
 }).filter(w=>Number.isFinite(w.index));
}
// "Working" detection. Raw output-freshness is not enough: merely VIEWING a
// session makes tmux resize the window to the client (SIGWINCH), and any
// full-screen TUI — idle Claude included — repaints itself, which stamps
// window_activity once. So a window only counts as working when its activity
// timestamp keeps ADVANCING across server samples for a sustained streak:
// Claude's spinner repaints ~1/s for the whole turn (including silent tool
// runs) and qualifies within ~WORK_HOLD_S seconds, while a one-shot
// attach/resize/keystroke redraw stamps one time, never advances, and is
// dropped at the next sample. Applies to any CLI or long-running command that
// produces steady output; no hooks needed. Tracker is in-memory: a dashboard
// restart just re-arms the streaks within a few seconds.
const WORK_GRACE_S = 15; // once working, output pauses up to this long don't drop it
const paneWorkTracker = new Map(); // "session:windowIndex" → {activity, sampleAt, slots, changes, lastSustainedAt, on}
function computeWorking(sessionName, w, now){
 if(paneWorkTracker.size > 2000){
  for(const [k,v] of paneWorkTracker){ if(now - v.sampleAt > 600) paneWorkTracker.delete(k); }
 }
 // Cadence model. Real work (Claude's TUI repaints ~1/s for the whole turn,
 // builds, dev servers) moves the activity stamp at nearly EVERY look; every
 // noise source — window creation + command echo, attach/resize/focus
 // repaints, a user clicking around — moves it a handful of times and then
 // freezes. So we track observed stamp CHANGES against observed sample SLOTS
 // over a sliding window and require an ongoing change cadence to enter:
 //   any window:        ≥3 changes spanning ≥5s, latest output ≤6s old
 //   + active+attached: ≥70% of slots saw a change, slots spanning ≥8s
 //     (that's where viewer-induced repaints live, so demand real density)
 // Once ON, the state is held server-side through pauses up to the grace
 // window — it survives page refreshes and quiet stretches, and ends at the
 // done-bell or when the cadence truly stops.
 const key = sessionName + ':' + w.index;
 const prev = paneWorkTracker.get(key);
 const stampAge = w.activity > 0 ? now - w.activity : Infinity;
 const advanced = prev ? w.activity > prev.activity : stampAge <= 2;
 const slots = prev ? prev.slots.filter(t => now - t <= 12) : [];
 const changes = prev ? prev.changes.filter(t => now - t <= 12) : [];
 if(advanced) changes.push(now);
 if(!slots.length || now - slots[slots.length - 1] >= 1.5) slots.push(now);
 const changeSpan = changes.length ? changes[changes.length - 1] - changes[0] : 0;
 const slotSpan = slots.length ? now - slots[0] : 0;
 const ratio = slots.length ? Math.min(changes.length, slots.length) / slots.length : 0;
 const base = changes.length >= 3 && changeSpan >= 5 && stampAge <= 6;
 const sustained = (w.attached === 0 || !w.active)
  ? base
  : (base && slots.length >= 4 && slotSpan >= 8 && ratio >= 0.7);
 let lastSustainedAt = sustained ? now : (prev ? prev.lastSustainedAt : null);
 const on = !w.bell && (sustained || (!!(prev && prev.on) && lastSustainedAt != null && now - lastSustainedAt <= WORK_GRACE_S));
 paneWorkTracker.set(key, { activity: w.activity, sampleAt: now, slots, changes, lastSustainedAt, on });
 if(process.env.PW_WORK_DEBUG && sessionName === 'pw_AmrikPublic') console.log('[workdbg]', JSON.stringify({ key, now, act: w.activity, stampAge, ch: changes.length, chSpan: changeSpan, sl: slots.length, slSpan: slotSpan, ratio: +ratio.toFixed(2), sustained, active: w.active, attached: w.attached, on }));
 return on;
}
async function listTmuxWindows(project){
 const { stdout } = await tmux(['list-windows','-t',tmuxSession(project),'-F','#{window_index}|#{window_name}|#{window_active}|#{window_bell_flag}|#{session_attached}|#{window_activity}']);
 const now = Math.floor(Date.now()/1000);
 const session = tmuxSession(project);
 return parseTmuxWindows(stdout).map(w => ({ ...w, working: computeWorking(session, w, now) }));
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
const projectTerminals = new Map();
// Non-root agent terminals (see terminal-priv.js). The setpriv drop is gated to
// container mode, where PW tmux() runs as root and can lower privileges; in host
// mode PW already spawns panes via 'sudo -u admin', so a second setpriv
// --init-groups there fails ("initgroups failed: Operation not permitted").
// Unset PW_TERMINAL_UID (or host mode) => passthrough, byte-identical upstream.
const TERMINAL_PRIV = resolveTerminalPriv(process.env);
function agentEnvTokens(canonicalTokens){ return wrapAgentEnv(TERMINAL_PRIV, canonicalTokens); }
const agentLoginDropArgv = agentLoginDrop(TERMINAL_PRIV);
// A live session's panes keep the environment they were created with, so
// enabling PW_PER_USER_CLAUDE or reassigning a project's primaryUser cannot
// retroactively re-key a running session. Stamp the credential fingerprint on
// the session at creation so that drift is DETECTABLE, and let an operator
// reconcile it deliberately (POST /api/term/:project/recycle) rather than
// silently killing a session that may be holding running work.
const CRED_KEY_OPTION = '@pw_cred_key';
// Reads the session's stamped credential fingerprint. Deliberately omits `-q`
// (which makes tmux swallow ALL errors — a genuinely-unset option, a session
// that no longer exists, and a control-plane hiccup all collapse to the same
// empty-stdout/exit-0 result, indistinguishable from each other): without it,
// a truly-unset option fails with tmux's own "invalid option" error, which is
// the ONLY case this treats as a real, positive "nothing stamped" signal.
// Anything else — the session vanished, a socket error, a corrupt server —
// comes back `ok:false`, and callers must fail closed on that, never coerce
// it into "unstamped" (that ambiguity is exactly what let a stale identity
// through before this fix).
async function readSessionCredKey(sess){
 try {
  const { stdout } = await tmux(['show-options','-t',sess,'-v',CRED_KEY_OPTION]);
  return { ok:true, key: String(stdout || '').trim() };
 } catch(e){
  const stderr = String(e?.stderr || e?.message || '');
  if(/invalid option/i.test(stderr)) return { ok:true, key:'' };
  return { ok:false, error: stderr.trim() || String(e) };
 }
}
// Stamps the fingerprint AND reads it back to confirm the write actually
// landed — a `set-option` that exits nonzero, or one that "succeeds" but a
// control-plane hiccup silently drops, must not be trusted without checking.
async function stampSessionCredKey(sess,key){
 await tmux(['set-option','-t',sess,CRED_KEY_OPTION,key]);
 const verify = await readSessionCredKey(sess);
 if(!verify.ok || verify.key !== key){
  throw new Error(`could not verify the credential fingerprint stamp on session "${sess}" (wrote ${JSON.stringify(key)}, read back ${verify.ok ? JSON.stringify(verify.key) : `unreadable: ${verify.error}`})`);
 }
}
// Is this project's live session running on credentials other than the ones it
// would get today? Still checks the session's stamp even while the feature is
// off — a real per-user fingerprint left over from when it was on is exactly
// as stale as any other mismatch (see the round-4 fix to sessionCredentialState
// in app/user-credentials.js) — but skips resolving a project owner (and its
// loadUsers/decrypt cost) in that case, since the desired state is unconditionally
// 'off' regardless of the project. This is a READ-ONLY status poll across every project, not a launch path, so a
// broken project's credential owner (e.g. a dangling primaryUser) must not
// throw and 500 the whole /api/projects/status response for every other
// project too. But it must also never silently report "not stale" when it
// cannot tell — that would just move AC1's silent-shared-fallback failure
// mode into the status poll instead of removing it. So an unresolvable owner
// is reported stale (visible, actionable) rather than swallowed either way.
async function credentialsStale(p){
 const sess = tmuxSession(p.name);
 try { await tmux(['has-session','-t',sess]); } catch { return false; }
 const stamped = await readSessionCredKey(sess);
 if(!stamped.ok){
  console.warn(`[per-user-claude] ${p?.name || '?'}: cannot read the session's credential fingerprint — reporting stale: ${stamped.error}`);
  return true;
 }
 if(!PER_USER_CLAUDE){
  // Desired is unconditionally 'off' while disabled — no need to resolve a
  // project owner (and pay loadUsers/decrypt cost) just to learn that. A
  // real per-user fingerprint left stamped from when the feature was on is
  // still reported stale here, via sessionCredentialState's own enforcement
  // of "disabled always desires off" — see app/user-credentials.js.
  return sessionCredentialState({ perUserEnabled: false, desiredKey: CREDENTIALS_OFF, stampedKey: stamped.key }).stale;
 }
 const desired = await desiredCredentialKey(p).then(key => ({ ok:true, key })).catch(e => ({ ok:false, e }));
 if(!desired.ok){
  console.warn(`[per-user-claude] ${p?.name || '?'}: cannot determine desired credential state — reporting stale: ${desired.e?.message || desired.e}`);
  return true;
 }
 return sessionCredentialState({ perUserEnabled: PER_USER_CLAUDE, desiredKey: desired.key, stampedKey: stamped.key }).stale;
}
// Unified existing-session policy (both for this function and for
// scripts/project-terminal-start, which applies the identical rule in bash):
// the underlying tmux session may keep running either way — this function
// never kills one — but ATTACHING to (or creating) one always resolves the
// CURRENT owner and requires an exact fingerprint match first. A session
// that does not exist yet is created fresh with the current owner's real
// materialized credentials (fail-closed: never the shared login on a
// resolution failure). A session that DOES exist is only handed off to
// (ttyd, a new window, boot) when its stamped fingerprint matches the
// CURRENT desired one exactly (or the "legitimately never stamped, and
// desired is genuinely shared/off" case) — a mismatch (the owner rotated a
// token, was renamed, or reassigned) or an unresolvable owner (dangling
// primaryUser, corrupt token, unreadable users store) both refuse to attach
// with an actionable recycle-required error. Continuity of an already-open
// terminal is NOT a reason to attach under an unverified or stale identity —
// attribution safety comes first; POST /api/term/:project/recycle is the
// deliberate, explicit way to reconcile a stale session.
async function ensureTmuxSession(p){
 const sess = tmuxSession(p.name);
 let exists = true;
 try { await tmux(['has-session','-t',sess]); } catch { exists = false; }
 // Resolves AND materializes the current owner's credentials unconditionally
 // — for a fresh session this IS what a new pane needs; for an existing one
 // it is exactly what its stamped fingerprint must match before attaching is
 // allowed. THROWS (fail-closed) on any resolution/materialization failure,
 // for either case — see the policy note above.
 const cred = await credentialContext(p);
 if(exists){
  const stamped = await readSessionCredKey(sess);
  if(!stamped.ok){
   throw new Error(`[per-user-claude] project "${p.name}"'s existing session credential fingerprint could not be verified (${stamped.error}). Refusing to attach under an unverifiable identity — recycle required: POST ${BASE}/api/term/${encodeURIComponent(p.name)}/recycle.`);
  }
  const state = sessionCredentialState({ perUserEnabled: PER_USER_CLAUDE, desiredKey: cred.key, stampedKey: stamped.key });
  if(state.stale){
   throw new Error(`[per-user-claude] project "${p.name}"'s existing session credentials are stale (${state.reason}) relative to the current owner. Refusing to attach a possibly-mismatched identity — recycle required: POST ${BASE}/api/term/${encodeURIComponent(p.name)}/recycle.`);
  }
  // Exact match (or nothing to be stale about): safe to attach. Adopt the
  // stamp on a legacy-unstamped session now that we've confirmed there is
  // nothing to be stale about (sessionCredentialState already only reports
  // stale:false-unstamped for the legitimate off case).
  if(!stamped.key) await stampSessionCredKey(sess, cred.key);
  return;
 }
 const cwd = p.path || workspacePath(p.name);
 // The per-user credential tokens go INSIDE agentEnvTokens(), not after it: when the setpriv
 // drop is active agentEnvTokens() returns a `setpriv … /usr/bin/env KEY=VAL…` argv, and only
 // tokens passed through it get the HOME/PATH rewriting and USER=/LOGNAME= insertion applied.
 const env = agentEnvTokens(['env','HOME=/root','LANG=C.UTF-8','LC_ALL=C.UTF-8','TERM=xterm-256color','COLORTERM=truecolor','IS_SANDBOX=1','COPILOT_AUTO_UPDATE=false','DISABLE_AUTOUPDATER=1','PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin',...cred.tokens]);
 const tabs = Array.isArray(p.tabs) ? p.tabs : [];
 const firstName = tabs[0]?.name || 'Base';
 await tmux(['new-session','-d','-s',sess,'-c',cwd,'-n',firstName,...env,'bash',...cred.shellArgs]);
 await stampSessionCredKey(sess, cred.key);
 if(tabs[0]?.cmd?.trim()) await tmux(['send-keys','-t',`${sess}:${firstName}`,tabs[0].cmd.trim(),'C-m']);
 for(let i=1; i<tabs.length; i++){
  const t = tabs[i]; if(!t?.name) continue;
  await tmux(['new-window','-t',sess,'-c',cwd,'-n',t.name,...env,'bash',...cred.shellArgs]);
  if(t.cmd?.trim()){ await new Promise(r=>setTimeout(r,80)); await tmux(['send-keys','-t',`${sess}:${t.name}`,t.cmd.trim(),'C-m']); }
 }
 await tmux(['select-window','-t',`${sess}:0`]).catch(()=>{});
}
async function ensureProjectTmuxSession(p){
 // Same unified existing-session policy as ensureTmuxSession: resolves the
 // current owner unconditionally and requires an exact fingerprint match
 // before handing off to an EXISTING session; fail-closed on resolution
 // failure or mismatch either way. See ensureTmuxSession's policy comment.
 const sess = tmuxSession(p.name);
 let exists = true;
 try { await tmux(['has-session','-t',sess]); } catch { exists = false; }
 const cred = await credentialContext(p);
 if(exists){
  const stamped = await readSessionCredKey(sess);
  if(!stamped.ok){
   throw new Error(`[per-user-claude] project "${p.name}"'s existing session credential fingerprint could not be verified (${stamped.error}). Refusing to attach under an unverifiable identity — recycle required: POST ${BASE}/api/term/${encodeURIComponent(p.name)}/recycle.`);
  }
  const state = sessionCredentialState({ perUserEnabled: PER_USER_CLAUDE, desiredKey: cred.key, stampedKey: stamped.key });
  if(state.stale){
   throw new Error(`[per-user-claude] project "${p.name}"'s existing session credentials are stale (${state.reason}) relative to the current owner. Refusing to attach a possibly-mismatched identity — recycle required: POST ${BASE}/api/term/${encodeURIComponent(p.name)}/recycle.`);
  }
  if(!stamped.key) await stampSessionCredKey(sess, cred.key);
  return;
 }
 // DISABLE_AUTOUPDATER, here and in every other pane-creating seam (scripts/project-terminal-start,
 // scripts/pw-tmux-restore, newTmuxWindow, ensureTmuxSession): a pane's environment is fixed at
 // creation, so a seam that omits it produces panes Claude Code nags in — and may self-update
 // under — for the life of the session. See test/autoupdater-env.test.mjs.
 const cmd = agentEnvTokens(['env','HOME=/home/admin','LANG=C.UTF-8','LC_ALL=C.UTF-8','TERM=screen-256color','COLORTERM=truecolor','DISABLE_AUTOUPDATER=1','PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin',...cred.tokens]).join(' ') + ' bash ' + cred.shellArgs.join(' ');
 await tmux(['new-session','-d','-s',sess,'-c',p.path,cmd]);
 await stampSessionCredKey(sess, cred.key);
 await tmux(['send-keys','-t',sess,`printf 'Project workspace: %s\nClaude: %s\nPersistent console: tmux session %s\nTip: run claude from here after auth is completed.\n\n' ${shellQuote(p.path)} ${shellQuote('/usr/local/bin/claude')} ${shellQuote(sess)}`,'C-m']);
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
 const sess = tmuxSession(p.name);
 // A new window gets today's credentials, which may differ from the ones the
 // session was created with; that is why drift is reported per session and
 // reconciled by recreating it, rather than left to accumulate silently. The
 // LIVE session's stamped fingerprint must match exactly before adding to
 // it — otherwise a new window lands under a different identity than the
 // rest of the session (mixed-attribution panes), which is never allowed
 // implicitly; POST /api/term/:project/recycle is the deliberate fix.
 const cred = await credentialContext(p);
 const stamped = await readSessionCredKey(sess);
 if(!stamped.ok){
  throw new Error(`[per-user-claude] project "${p.name}"'s existing session credential fingerprint could not be verified (${stamped.error}). Refusing to create a window under an unverifiable identity.`);
 }
 const state = sessionCredentialState({ perUserEnabled: PER_USER_CLAUDE, desiredKey: cred.key, stampedKey: stamped.key });
 if(state.stale){
  throw new Error(`[per-user-claude] project "${p.name}"'s existing session credentials are stale (${state.reason}) relative to the current owner. Refusing to create a mixed-attribution window — recycle required: POST ${BASE}/api/term/${encodeURIComponent(p.name)}/recycle.`);
 }
 if(!stamped.key) await stampSessionCredKey(sess, cred.key);
 const winEnv = agentEnvTokens(['env','HOME=/home/admin','LANG=C.UTF-8','LC_ALL=C.UTF-8','TERM=screen-256color','COLORTERM=truecolor','DISABLE_AUTOUPDATER=1','PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin',...cred.tokens]);
 // -P -F gives back the index of the window we just made. Send by INDEX, not by
 // name: tmux permits duplicate window names, and `send-keys -t <session>:<name>`
 // then REFUSES the ambiguous target ("can't find window: <name>") rather than
 // choosing — so once a second window of the same name existed, the command was
 // silently never delivered. That is what broke the eod-commit task on every run
 // after its first. Verified against tmux 3.3a.
 const { stdout: newIdx } = await tmux(['new-window','-t',sess,'-c',p.path,'-n',safeName,'-P','-F','#{window_index}',...winEnv,'bash',...cred.shellArgs]);
 const idx = String(newIdx || '').trim();
 const trimmedCmd = String(cmd || '').trim();
 if(trimmedCmd){
  await new Promise(r=>setTimeout(r,80));
  // Fall back to the name only if tmux somehow gave us no index, so this can
  // never become a silent no-op.
  await tmux(['send-keys','-t',`${sess}:${idx || safeName}`,trimmedCmd,'C-m']);
 }
 return idx;
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
// Explicit acknowledgement suppresses re-latching: the cockpit GET or a
// successful terminal-window selection clears the marker shortly before tmux
// attachment state settles. The grace period prevents that transient bell state
// from immediately recreating a completion the user has just acknowledged.
const recentlyViewed = new Map(); // project name → ms epoch of last clearPending
async function clearPending(p){ recentlyViewed.set(p.name, Date.now()); await fs.rm(pendingMarkerPath(p), { force: true }).catch(()=>{}); }
async function projectSignals(p){
 // bell: finished-but-unviewed — a bell on a background window, or on the
 // ACTIVE window while no client is attached (tmux sets window_bell_flag in
 // that case and clears it on the next attach, so viewing self-heals; a bell
 // on the active window of an attached session never flags — the viewer saw
 // it live). working: any window with fresh output (see parseTmuxWindows).
 // Both false if the session isn't running.
 try {
  const ws = await listTmuxWindows(p.name);
  return {
   bell: ws.some(w => w.bell && (!w.active || w.attached === 0)),
   working: ws.some(w => w.working),
   attached: ws.length > 0 && ws[0].attached > 0,
  };
 } catch { return { bell:false, working:false, attached:false }; }
}
// The installed package's own version, which is the authoritative answer and does
// not depend on which `claude` happens to be first on PATH — a wrapper, a stale
// symlink, or the binary. `claude --version` also appends a product name
// ("2.1.220 (Claude Code)") that reads as noise beside the "Claude Code:" label
// already in the footer. Falls back to exec'ing the CLI where the package cannot
// be located.
async function readInstalledCliVersion(pkg){
 try {
  const { stdout } = await sh('npm',['root','-g'],{timeout:5000});
  const root = stdout.trim();
  if(!root) return null;
  const raw = await fs.readFile(path.join(root, pkg, 'package.json'),'utf8');
  const v = JSON.parse(raw).version;
  return typeof v === 'string' && v ? v : null;
 } catch { return null; }
}
async function getClaudeVersion(){
 const fromPkg = await readInstalledCliVersion('@anthropic-ai/claude-code');
 if(fromPkg) return fromPkg;
 try { const { stdout } = await sh('claude',['--version'],{timeout:5000}); return stdout.trim().replace(/\s*\(.*\)\s*$/,'') || 'unknown'; } catch { return 'unavailable'; }
}
// Where the CLI updater records what it checked and when.
//
// It used to be inferred from the mtime of /var/log/claude-code-update.log, which
// cannot work on a container install: the updater is a host unit writing the
// host's /var/log, and neither PW container mounts /var/log — so the dashboard
// stat'd its own empty one and the UI read "never" no matter how often the timer
// ran. /etc/project-workbench is bind-mounted 1:1 into the containers, so the
// updater stamps there and both sides genuinely see the same file. The log mtime
// is kept as a fallback so a host install that predates the stamp still answers.
const cliUpdateStampsPath = process.env.PW_CLI_UPDATE_STAMPS || '/etc/project-workbench/cli-updates.tsv';
// Which zone timestamps are shown in. UTC is correct for a log and wrong for a
// glanceable footer: an operator comparing "checked at" against their own clock
// should not have to do the offset in their head. Configurable rather than
// hardcoded — PW_TIMEZONE wins, then workbench.json's `timezone`, then whatever
// the process is running in (UTC, in a container). Not cached, so editing the
// setting takes effect on the next render rather than on the next restart.
async function displayTimeZone(){
 let tz = String(process.env.PW_TIMEZONE || '').trim();
 if(!tz){ try { tz = String((await loadWorkbenchSettings()).timezone || '').trim(); } catch { tz = ''; } }
 if(!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
 // A bad zone must not throw on every page render.
 try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'UTC'; }
 return tz;
}
function fmtUpdateStamp(iso, tz){
 const d = new Date(iso);
 if(Number.isNaN(d.getTime())) return null;
 try {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year:'numeric', month:'2-digit', day:'2-digit',
   hour:'2-digit', minute:'2-digit', hour12:false, timeZoneName:'short' }).format(d);
  return parts.replace(',', '');
 } catch { return d.toISOString().replace('T',' ').replace(/:\d\d\.\d+Z$/,' UTC'); }
}
async function readCliUpdateStamps(){
 try {
  const raw = await fs.readFile(cliUpdateStampsPath,'utf8');
  const out = {};
  for(const line of raw.split('\n')){
   const [cli, at, status] = line.split('\t');
   if(cli && at) out[cli] = { at, status: (status || 'ok').trim() };
  }
  return out;
 } catch { return {}; }
}
async function getClaudeUpdateStamp(){
 const stamps = await readCliUpdateStamps();
 // The footer answers "when did the updater last run", so the most recent of the
 // per-CLI stamps is the honest value — not claude's specifically.
 const latest = Object.values(stamps).map(s => s.at).filter(Boolean).sort().pop();
 if(latest) return fmtUpdateStamp(latest, await displayTimeZone()) || 'never';
 try { const stat = await fs.stat('/var/log/claude-code-update.log'); return stat.mtime.toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'); } catch { return 'never'; }
}

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
 const stamps = await readCliUpdateStamps();
 const tz = await displayTimeZone();
 for(const [key,cfg] of Object.entries(SUPPORTED_CLIS)){
  const [version, authenticated] = await Promise.all([getCliVersion(cfg.bin), getCliAuth(key)]);
  const stamp = stamps[key];
  // Drop pkg/bin/authCmd from this response — the wizard UI doesn't display
  // them and we'd rather not advertise the internal command/package layout.
  out[key] = { key, label:cfg.label, notes:cfg.notes, installed:!!version, version: version || 'not installed', authenticated,
   // Per-CLI, because auto-update is a per-CLI switch: one CLI can be failing
   // its checks while another is current, and a single global date hides that.
   lastUpdate: (stamp && fmtUpdateStamp(stamp.at, tz)) || 'never',
   lastUpdateOk: stamp ? stamp.status === 'ok' : null };
 }
 return out;
}
let setupTtydProc = null;
async function ensureSetupTerminal(){
 if(DEPLOY_MODE === 'container'){
  if(ISOLATED) return true;
  if(setupTtydProc && setupTtydProc.exitCode === null) return true;
  setupTtydProc = spawn('ttyd',['--interface','127.0.0.1','--port',String(setupTtydPort),'--base-path',`${BASE}/pty/_setup/`,'--writable',...agentLoginDropArgv,'bash','--login'],{
   stdio:'ignore', detached:true, env:{...process.env, HOME:'/root'}
  });
  setupTtydProc.unref();
  setupTtydProc.on('exit',()=>{ setupTtydProc = null; });
  for(let i=0;i<20;i++){
   try { const r = await fetch(`http://127.0.0.1:${setupTtydPort}${BASE}/pty/_setup/`); if(r.ok) return true; } catch {}
   await new Promise(r=>setTimeout(r,250));
  }
  return false;
 }
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
 // Optional env-specific sibling-app locations (see extraNginxPath). Read at
 // generation time so an operator can drop/edit the file and re-heal nginx
 // without an app restart. Best-effort: a missing file injects nothing.
 let extraLocations = '';
 try { extraLocations = fsSync.readFileSync(extraNginxPath, 'utf8'); } catch {}
 if(extraLocations && !extraLocations.endsWith('\n')) extraLocations += '\n';
 const ttydProxyBase = DEPLOY_MODE === 'container' ? BASE : '';
 // Internal endpoint that nginx auth_request calls. Forwards Cookie to the
 // dashboard so it can decide based on the app session.
 const authCheckRoute = `    location = /pw-auth-check {\n        internal;\n        proxy_pass http://127.0.0.1:3000${BASE}/api/auth/check$is_args$args;\n        proxy_pass_request_body off;\n        proxy_set_header Content-Length "";\n        proxy_set_header Host $host;\n        proxy_set_header Cookie $http_cookie;\n        proxy_set_header X-Original-URI $request_uri;\n    }\n`;
 // Setup terminal is admin-only — the wizard signs in CLIs whose tokens land
 // in /home/admin and apply to every project.
 const setupRoute = `    location ${BASE}/pty/_setup/ {\n        auth_request /pw-auth-check;\n        proxy_pass http://127.0.0.1:${setupTtydPort}${ttydProxyBase}/pty/_setup/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`;
 // Accept-Encoding is cleared so ttyd serves uncompressed HTML — otherwise
 // sub_filter can't match '</head>' inside a gzipped body and the preload
 // script tag is silently dropped, breaking mouse-drag-copy (OSC 52 sniffer).
 // auth_request gates each terminal/preview block per-project; in soft mode
 // (PW_AUTH_ENFORCE=false) the dashboard returns 200 for anonymous callers.
 const locations = projects.map(p => `    location ${BASE}/pty/${p.name}/ {\n        auth_request /pw-auth-check;\n        sub_filter_once off;\n        sub_filter_types text/html;\n        sub_filter '</head>' '<script src="${BASE}/terminal-preload.js"></script></head>';\n        proxy_set_header Accept-Encoding "";\n        proxy_pass http://127.0.0.1:${p.port}${ttydProxyBase}/pty/${p.name}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_read_timeout 86400;\n    }\n`).join('');
 const previewRoutes = previewProjects.map(p => `    location ${BASE}/preview/${p.name}/ {\n        auth_request /pw-auth-check;\n        proxy_pass http://127.0.0.1:${p.preview.port}/;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix ${BASE}/preview/${p.name};\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/${p.name}/)(.*)$ ${BASE}/preview/${p.name}/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n        proxy_send_timeout 86400;\n    }\n`).join('');
 const refererMaps = previewProjects.length ? `map $http_referer $pw_preview_name {\n    default "";\n    "~^https?://[^/]+${BASE}/preview/(?<pname>[^/]+)/" "$pname";\n}\nmap $pw_preview_name $pw_preview_port {\n    default 0;\n${previewProjects.map(p => `    "${p.name}" ${p.preview.port};`).join('\n')}\n}\n` : '';
 const dashboardPathNames = ['api','pty','term','file','manage','preview','terminal-preload','terminal-paste','healthz','favicon','robots',...(DEPLOY_CENTRE?['deploy']:[])].join('|');
 const knownDashboardPaths = `^${BASE || ''}/(${dashboardPathNames})(/|$|\\.|\\?)`;
 const previewFallbackLocation = previewProjects.length ? `    location @pw_preview_fallback {\n        proxy_pass http://127.0.0.1:$pw_preview_port$request_uri;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Forwarded-Prefix ${BASE}/preview/$pw_preview_name;\n        proxy_redirect ~^(https?://[^/]+)?/(?!preview/)(.*)$ ${BASE}/preview/$pw_preview_name/$2;\n        proxy_buffering off;\n        proxy_read_timeout 86400;\n    }\n` : '';
 const rootLocation = previewProjects.length
  ? `    location / {\n        set $pw_route dashboard;\n        if ($pw_preview_port) { set $pw_route preview; }\n        if ($request_uri ~ "${knownDashboardPaths}") { set $pw_route dashboard; }\n        if ($pw_route = preview) { return 418; }\n        error_page 418 = @pw_preview_fallback;\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n`
  : `    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }\n`;
 const deployRoute = DEPLOY_CENTRE ? `    location ${BASE}/api/deploy/ {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_read_timeout 600s;\n        proxy_send_timeout 600s;\n    }\n` : '';
 // Streaming inbox uploads: lift the 100m body cap and pass the body through
 // unbuffered so multi-GB zips stream straight to the app (auth is enforced by
 // express on the endpoint itself, same as the JSON upload route).
 const uploadRoute = `    location ${BASE}/api/upload-stream/ {\n        client_max_body_size 0;\n        proxy_request_buffering off;\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_read_timeout 3600s;\n        proxy_send_timeout 3600s;\n    }\n`;
 const _pwPrelude = `map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n${refererMaps}`;
 const _pwBody = `    client_max_body_size 100m;\n${extraLocations}${deployRoute}${uploadRoute}${rootLocation}${authCheckRoute}${setupRoute}${locations}${previewRoutes}${previewFallbackLocation}`;
 // TLS off → byte-identical canonical HTTP-only server. TLS on → :80 redirects
 // to the configured server name (never the client-controlled $host) and the
 // full body — auth_request, /pty, previews, uploads, deploy, extra-nginx —
 // moves unchanged into the :443 ssl server. See app/tls-config.js.
 return renderNginxServers(_pwPrelude, _pwBody, TLS);
}
function splitCommandLine(cmd){
 const out = [];
 let cur = '', quote = null, escNext = false;
 for(const ch of String(cmd || '')){
  if(escNext){ cur += ch; escNext = false; continue; }
  if(ch === '\\' && quote !== "'"){ escNext = true; continue; }
  if(quote){ if(ch === quote) quote = null; else cur += ch; continue; }
  if(ch === '"' || ch === "'"){ quote = ch; continue; }
  if(/\s/.test(ch)){ if(cur){ out.push(cur); cur = ''; } continue; }
  cur += ch;
 }
 if(escNext) cur += '\\';
 if(quote) throw new Error(`Unclosed quote in command: ${cmd}`);
 if(cur) out.push(cur);
 return out;
}
async function runConfiguredCommand(configured, fallbackCmd, fallbackArgs, opts={}){
 if(configured){
  const argv = splitCommandLine(configured);
  if(!argv.length) throw new Error('Configured command is empty');
  return sh(argv[0], argv.slice(1), opts);
 }
 return sh(fallbackCmd, fallbackArgs, opts);
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
  await runConfiguredCommand(nginxTestCmd, 'nginx', ['-t']);
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
 await runConfiguredCommand(nginxReloadCmd, 'systemctl', ['reload','nginx']);
 if(!nginxReloadCmd) await sh('systemctl',['daemon-reload']);
}
async function cloneWorkspace(p, token){
 const own = await workspaceOwner();
 await fs.mkdir(workspaceRoot,{recursive:true});
 try { await fs.access(path.join(p.path,'.git')); await sh('chown',['-R',own.spec,p.path]).catch(()=>{}); return; } catch {}
 if(!p.repo){
  // No repo configured: stand up an empty local workspace on demand and
  // initialise it as a git repo so Claude/tools get a sane git context, the
  // .git check above keeps a re-add idempotent, and a remote can be attached
  // later from the terminal. An existing folder at this path is adopted in
  // place — git init never touches existing files.
  await fs.mkdir(p.path,{recursive:true});
  await sh('chown',['-R',own.spec,p.path]).catch(()=>{});
  await sh('sudo',['-u',own.user,'git','-C',p.path,'init','-b','main']).catch(()=>{});
  await sh('sudo',['-u',own.user,'git','-C',p.path,'config','--global','--add','safe.directory',p.path]).catch(()=>{});
  return;
 }
 try { await fs.rm(p.path,{recursive:true,force:true}); } catch {}
 if(token){
  // Authenticate the clone via a temporary credential store, so the token never
  // appears in argv, the remote URL, or any error output shown to the user.
  // NOT in workspaceRoot: that directory is owned by the pane account, so a
  // symlink pre-planted at a predictable name would have had this root process
  // write the decrypted token wherever the planter chose. mkdtemp gives an
  // unguessable 0700 directory beside the registry, which only root can reach.
  const credDir = await fs.mkdtemp(path.join(path.dirname(registryPath), '.pw-clone-'));
  const credFile = path.join(credDir, 'credentials');
  try {
   await fs.writeFile(credFile, 'https://' + token + ':x-oauth-basic@github.com\n', { mode: 0o600 });
   await execFileAsync('git',['-c','credential.helper=','-c','credential.helper=store --file=' + credFile,'clone','--',p.repo,p.path],{timeout:300000});
  } finally { await fs.rm(credDir,{recursive:true,force:true}).catch(()=>{}); }
 } else {
  await sh('sudo',['-u',own.user,'git','clone',p.repo,p.path],{timeout:300000});
 }
 await sh('chown',['-R',own.spec,p.path]).catch(()=>{});
 await sh('sudo',['-u',own.user,'git','-C',p.path,'config','--global','--add','safe.directory',p.path]).catch(()=>{});
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
 await sh('sudo',['-u',(await workspaceOwner()).user,'python3','-c',script,p.path]).catch(()=>{});
}
async function startProject(p){
 if(DEPLOY_MODE === 'container'){
  if(ISOLATED){ await ensureTmuxSession(p); return; }
  if(projectTerminals.has(p.name)){ const t = projectTerminals.get(p.name); try { t.proc.kill(); } catch {} projectTerminals.delete(p.name); }
  const basePath = `${BASE}/pty/${p.name}/`;
  try { await execFileAsync('pkill',['-f',`ttyd.*--base-path.*${basePath}`],{timeout:3000}); await new Promise(r=>setTimeout(r,500)); } catch {}
  await ensureTmuxSession(p);
  const port = Number(p.port);
  const sess = tmuxSession(p.name);
  const proc = spawn('ttyd',['--interface','127.0.0.1','--port',String(port),'--base-path',basePath,'--writable','-t','disableLeaveAlert=true','tmux',...(TMUX_SOCKET?['-L',TMUX_SOCKET]:[]),'attach-session','-t',sess],{
   stdio:'ignore', detached:true, env:{...process.env, HOME:'/root', TERM:'xterm-256color'}
  });
  proc.unref();
  proc.on('exit',()=>{ projectTerminals.delete(p.name); });
  projectTerminals.set(p.name, { proc, port });
  return;
 }
 await trustClaudeProject(p);
 await sh('systemctl',['enable',`project-terminal@${p.name}.service`]);
 await sh('systemctl',['restart',`project-terminal@${p.name}.service`]);
}
// applyRouting publishes a live nginx location; startProject is what makes
// something listen behind it. Routing first means a failed start leaves nginx
// proxying to a port nothing is on — a bare 502 with nothing saying why. That is
// how a newly added project presented, and how every save blocked by the tmux
// ownership gate presented: registry written, session already stopped, route
// live, terminal gone, and the only symptom a gateway error.
//
// So: start, then route, and if the start fails say which half of the operation
// succeeded. The caller's error handler surfaces this to the operator.
async function startThenRoute(p, projects){
 try { await startProject(p); }
 catch(e){
  const detail = e?.message || String(e);
  console.error(`[manage] ${p.name}: registry saved but the terminal did not start: ${detail}`);
  throw new Error(`Saved "${p.name}", but its terminal could not be started: ${detail}`);
 }
 await applyRouting(projects);
}
async function stopProject(name){
 if(DEPLOY_MODE === 'container'){
  if(projectTerminals.has(name)){ const t = projectTerminals.get(name); try { t.proc.kill(); } catch {} projectTerminals.delete(name); }
  await tmux(['kill-session','-t',tmuxSession(name)]).catch(()=>{});
  await stopPreviewUnit(name);
  return;
 }
 await sh('systemctl',['disable','--now',`project-terminal@${name}.service`]).catch(()=>{}); await stopPreviewUnit(name); await sh('sudo',['-u',(await workspaceOwner()).user,'tmux','kill-session','-t',`pw_${name.replace(/[^A-Za-z0-9_]/g,'_')}`]).catch(()=>{});
}
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
.lCard{background:linear-gradient(180deg,var(--panel),#0a1120);border:1px solid var(--line);border-radius:16px;padding:20px 22px;animation:lIn .5s cubic-bezier(.22,.9,.3,1) backwards;animation-delay:calc(var(--i,0)*55ms)}
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

const wizardScript = `<script>(function(){const open=document.getElementById('setupBtn');const backdrop=document.getElementById('setupBackdrop');if(!backdrop)return;const closeBtn=document.getElementById('setupCloseBtn');const cancelBtn=document.getElementById('setupCancelBtn');const saveBtn=document.getElementById('setupSaveBtn');const cliRows=document.getElementById('cliRows');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const saveStatus=document.getElementById('saveStatus');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');let state=null;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setHealOut(t,err){healOut.textContent=t||'';healOut.classList.toggle('show',!!t);healOut.classList.toggle('err',!!err)}function setSave(t,err){saveStatus.textContent=t||'';saveStatus.classList.toggle('err',!!err)}function render(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+escHtml(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+escHtml(c.version)+'</span>'+(c.authenticated?'<span class="signed-in" title="Credentials detected on disk">Signed in</span>':'')+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button type="button" class="button secondary inst">'+(c.installed?'Update':'Install')+'</button><button type="button" class="button auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+escHtml(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');const orig=btn.textContent;btn.disabled=true;btn.textContent='Installing…';setSave('');try{const r=await fetch('${BASE}/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');const v=row.querySelector('.version');v.textContent=j.version;v.classList.add('installed');btn.textContent='Update';setSave(c.label+': '+j.version)}catch(e){btn.textContent=orig;setSave(e.message,true)}finally{btn.disabled=false}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setSave('');try{const r=await fetch('${BASE}/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(authFrame.src.indexOf('${BASE}/pty/_setup/')<0)authFrame.src='${BASE}/pty/_setup/';authFrame.classList.remove('hidden');authHint.textContent='Running: '+j.command+' — complete the prompts in the terminal below.'}catch(e){setSave(e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderOptHelp()}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest. Use this unless you fully trust everyone with dashboard access.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude will execute any shell command, file write, or tool call without asking. Anyone with basic-auth access effectively has shell on this box.'};const MCP_HELP={inherit:'Claude uses the MCP servers configured on your Anthropic account (whatever <code>~/.claude.json</code> currently has).',isolated:'Forces Claude to use an empty MCP config so no external MCP servers load. Good when you want this box self-contained or your account MCP is unreachable from the LAN.',custom:'Use a custom MCP JSON config file. Path is set via the <code>PW_MCP_CONFIG</code> env var the wrapper reads.'};function renderOptHelp(){const ph=document.getElementById('permHelp');const mh=document.getElementById('mcpHelp');if(ph){ph.innerHTML=PERM_HELP[permMode.value]||'';ph.classList.toggle('warn',permMode.value==='skip')}if(mh)mh.innerHTML=MCP_HELP[mcpMode.value]||''}permMode&&permMode.addEventListener('change',renderOptHelp);mcpMode&&mcpMode.addEventListener('change',renderOptHelp);async function load(){setSave('Loading…');try{const r=await fetch('${BASE}/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');render();setSave('')}catch(e){setSave(e.message,true)}}function show(){backdrop.classList.remove('hidden');load()}function hide(){backdrop.classList.add('hidden');authFrame.src='about:blank';authFrame.classList.add('hidden');authHint.textContent='Click "Sign in" on a CLI above to send its login command here.';setHealOut('');setSave('')}if(open)open.onclick=show;if(closeBtn)closeBtn.onclick=hide;if(cancelBtn)cancelBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});saveBtn.onclick=async()=>{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);saveBtn.disabled=true;setSave('Saving…');try{const r=await fetch('${BASE}/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setSave('Saved.')}catch(e){setSave(e.message,true)}finally{saveBtn.disabled=false}};async function heal(url,btn){btn.disabled=true;setHealOut('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');setHealOut(j.message||'OK')}catch(e){setHealOut(e.message,true)}finally{btn.disabled=false}}healNginx.onclick=()=>heal('${BASE}/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('${BASE}/api/setup/heal/dirs',healDirs);load()})();</script>`;

const wizardModalHtml = `<div id="setupBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box"><header><h2>Setup Wizard</h2><button class="modal-close" id="setupCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><section><h3>CLIs</h3><p class="section-help">Pick which assistants this instance offers. "Auto-update" CLIs are upgraded nightly by the update timer.</p><div id="cliRows"></div></section><section><h3>Sign in</h3><p class="section-help">Sign-in opens the shared setup terminal at <code>${BASE}/pty/_setup/</code>. Tokens land in <code>/home/admin</code> and apply to every project.</p><div id="authHint">Click "Sign in" on a CLI above to send its login command here.</div><iframe id="authFrame" class="hidden" title="Setup auth terminal"></iframe></section><section><h3>Environment</h3><div class="env-grid"><label>Permission mode<select id="permMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="permHelp"></span></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="mcpHelp"></span></label></div></section><section><h3>Heal</h3><p class="section-help">Self-repair common installation drift. Run if a route is missing or a runtime path looks broken.</p><div class="heal-row"><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button><button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button></div><pre class="heal-out" id="healOut"></pre></section></div><footer><span id="saveStatus"></span><button class="button secondary" id="setupCancelBtn" type="button">Close</button><button class="button" id="setupSaveBtn" type="button">Save settings</button></footer></div></div>`;

const modalBaseCss = `.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}.modal-backdrop.hidden{display:none}.modal-box{background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:14px;max-width:920px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.7)}.modal-box header{display:flex;justify-content:space-between;align-items:center;padding:.95rem 1.25rem;border-bottom:1px solid #1f2937}.modal-box header h2{margin:0;font-size:1.2rem}.modal-box .body{padding:1rem 1.25rem;overflow:auto;flex:1 1 auto}.modal-close{background:transparent;border:0;color:#cbd5e1;font-size:1.6rem;cursor:pointer;line-height:1;padding:0 .25rem}.modal-close:hover{color:#fff}.button{display:inline-block;background:#2563eb;color:#fff;padding:.6rem .85rem;border-radius:8px;text-decoration:none;margin:.15rem;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button:disabled{opacity:.55;cursor:not-allowed}.subtle{color:#94a3b8;font-size:.8rem}`;

const previewCss = `.modal-box.preview{max-width:1180px;height:90vh}.modal-box.preview .body{padding:0;display:flex;flex-direction:column;gap:0}.preview-toolbar{display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;border-bottom:1px solid #1f2937;background:#0b1220;flex-wrap:wrap}.preview-toolbar .pill{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .65rem;border-radius:999px;background:#111827;border:1px solid #334155;color:#cbd5e1;font-size:.82rem}.preview-toolbar .pill .dot{width:.55em;height:.55em;border-radius:50%;background:#64748b;box-shadow:0 0 0 .2em rgba(100,116,139,.15)}.preview-toolbar .pill.running{color:#bbf7d0;border-color:#166534}.preview-toolbar .pill.running .dot{background:#22c55e;box-shadow:0 0 0 .2em rgba(34,197,94,.25);animation:pwPulse 1.6s ease-in-out infinite}.preview-toolbar .pill.starting{color:#fde68a;border-color:#854d0e}.preview-toolbar .pill.starting .dot{background:#facc15;box-shadow:0 0 0 .2em rgba(250,204,21,.25);animation:pwPulse 1.2s ease-in-out infinite}.preview-toolbar .pill.error{color:#fecaca;border-color:#7f1d1d}.preview-toolbar .pill.error .dot{background:#ef4444}.preview-toolbar .spacer{flex:1 1 auto}.preview-toolbar .button{margin:0;padding:.45rem .8rem;font-size:.85rem}.preview-toolbar .button.icon{padding:.45rem .55rem}.preview-toolbar a.button{text-decoration:none}.preview-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;background:#0f172a}.preview-empty{display:grid;place-items:center;flex:1 1 auto;color:#94a3b8;text-align:center;padding:2rem;font-size:.95rem}.preview-empty.hidden{display:none}.preview-empty>div{max-width:780px}.preview-empty code{color:#bfdbfe;display:block;margin-top:.55rem;font-size:.8rem;background:#020617;border:1px solid #1f2937;border-radius:6px;padding:.55rem .7rem;text-align:left;white-space:pre-wrap;word-break:break-word}#previewFrame{flex:1 1 auto;width:100%;border:0;background:#fff;display:block}#previewFrame.hidden{display:none}.preview-logs{display:none;flex:0 0 auto;max-height:32%;border-top:1px solid #1f2937;background:#020617;color:#bbf7d0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.55rem .85rem;overflow:auto;white-space:pre-wrap}.preview-logs.show{display:block}.preview-logs.err{color:#fca5a5}.preview-statusline{padding:.4rem .85rem;font-size:.82rem;color:#94a3b8;border-bottom:1px solid #1f2937;background:#0b1220;display:none}.preview-statusline.show{display:block}.preview-statusline.err{color:#fca5a5}`;

const previewModalHtml = `<div id="previewBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box preview"><header><h2 id="previewTitle">Preview</h2><button class="modal-close" id="previewCloseBtn" aria-label="Close" type="button">×</button></header><div class="body"><div class="preview-toolbar"><span class="pill" id="previewPill"><span class="dot"></span><span id="previewPillLabel">checking…</span></span><span class="subtle" id="previewMeta"></span><span class="spacer"></span><button class="button" id="previewStartBtn" type="button">Start</button><button class="button secondary" id="previewRestartBtn" type="button">Restart</button><button class="button secondary" id="previewStopBtn" type="button">Stop</button><button class="button secondary" id="previewReloadBtn" type="button" title="Reload iframe">↻</button><a class="button secondary" id="previewOpenBtn" target="_blank" rel="noopener" title="Open in new tab">Open ↗</a><button class="button secondary" id="previewLogsBtn" type="button">Logs</button></div><div class="preview-statusline" id="previewStatusline"></div><div class="preview-body"><div class="preview-empty" id="previewEmpty">Preview is not running.</div><iframe id="previewFrame" class="hidden" title="Project preview"></iframe><pre class="preview-logs" id="previewLogs"></pre></div></div></div></div>`;

const previewScript = `<script>(function(){const backdrop=document.getElementById('previewBackdrop');if(!backdrop)return;const title=document.getElementById('previewTitle');const pill=document.getElementById('previewPill');const pillLabel=document.getElementById('previewPillLabel');const meta=document.getElementById('previewMeta');const startBtn=document.getElementById('previewStartBtn');const stopBtn=document.getElementById('previewStopBtn');const restartBtn=document.getElementById('previewRestartBtn');const reloadBtn=document.getElementById('previewReloadBtn');const openBtn=document.getElementById('previewOpenBtn');const logsBtn=document.getElementById('previewLogsBtn');const closeBtn=document.getElementById('previewCloseBtn');const empty=document.getElementById('previewEmpty');const frame=document.getElementById('previewFrame');const logs=document.getElementById('previewLogs');const statusline=document.getElementById('previewStatusline');let project=null;let pollTimer=null;let logsTimer=null;let lastIframeUrl='';let showingLogs=false;function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatusLine(t,err){statusline.textContent=t||'';statusline.classList.toggle('show',!!t);statusline.classList.toggle('err',!!err)}function setPill(state,label){pill.classList.remove('running','starting','error');if(state)pill.classList.add(state);pillLabel.textContent=label}function setEmpty(msg){empty.innerHTML='<div>'+msg+'</div>';empty.classList.remove('hidden');frame.classList.add('hidden');if(frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}function loadIframe(url){if(lastIframeUrl===url)return;lastIframeUrl=url;empty.classList.add('hidden');frame.classList.remove('hidden');frame.src=url}async function fetchStatus(){if(!project)return;try{const r=await fetch('${BASE}/api/preview/'+encodeURIComponent(project)+'/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');applyStatus(j)}catch(e){setStatusLine(e.message||String(e),true)}}function applyStatus(s){meta.textContent=s.port?'port '+s.port+(s.pid?' · pid '+s.pid:''):'';if(!s.configured){setPill('error','not configured');setEmpty('Preview is not configured for this project.<br><br>Open <a class="repo" href="${BASE}/manage">Manage Projects</a> and set a <strong>Preview command</strong>.<br><br>Examples:<code>dotnet watch run --project ProVisionI_Portal/ProVisionI_Portal.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code>');startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;openBtn.removeAttribute('href');return}openBtn.href=s.url||'#';if(s.active&&s.ready){setPill('running','running');setStatusLine('');loadIframe(s.url);startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else if(s.active&&!s.ready){setPill('starting','waiting for port '+s.port);setStatusLine('Server unit is active; waiting for the dev server to bind to 127.0.0.1:'+s.port+'…');setEmpty('Starting… waiting for the framework to bind to port <strong>'+s.port+'</strong>.<br><span class="subtle">First boot of dotnet watch can take 10–30s.</span>');startBtn.disabled=true;stopBtn.disabled=false;restartBtn.disabled=false}else{if(s.result&&s.result!=='success'){const tag=s.result==='exit-code'?('exit code '+(s.exitCode??'?')):s.result;setPill('error','exited ('+tag+')');setStatusLine('');let msg='Preview process exited ('+tag+').';if(s.lastError){msg+='<br><br>Recent log output:<code>'+escHtml(s.lastError)+'</code>'}msg+='<br>Click <strong>Start</strong> to retry:<code>'+escHtml(s.cmd||'')+'</code>';setEmpty(msg)}else{setPill('','stopped');setStatusLine('');setEmpty('Preview is stopped. Click <strong>Start</strong> to launch:<code>'+escHtml(s.cmd||'')+'</code>')}startBtn.disabled=false;stopBtn.disabled=true;restartBtn.disabled=false}}async function action(url){startBtn.disabled=true;stopBtn.disabled=true;restartBtn.disabled=true;setStatusLine('Working…');try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');applyStatus(j);if(showingLogs)refreshLogs()}catch(e){setStatusLine(e.message||String(e),true)}}async function refreshLogs(){if(!project||!showingLogs)return;try{const r=await fetch('${BASE}/api/preview/'+encodeURIComponent(project)+'/logs?lines=300',{cache:'no-store'});const j=await r.json();if(j.ok){logs.textContent=j.log||'(no log output yet)';logs.scrollTop=logs.scrollHeight}}catch{}}function toggleLogs(){showingLogs=!showingLogs;logs.classList.toggle('show',showingLogs);logsBtn.textContent=showingLogs?'Hide logs':'Logs';if(showingLogs){refreshLogs();logsTimer=setInterval(refreshLogs,3000)}else{clearInterval(logsTimer);logsTimer=null}}function show(name){project=name;title.textContent='Preview — '+name;showingLogs=false;logs.classList.remove('show');logs.textContent='';logsBtn.textContent='Logs';setPill('','checking…');setStatusLine('');setEmpty('Loading…');backdrop.classList.remove('hidden');fetchStatus();pollTimer=setInterval(fetchStatus,2500)}function hide(){backdrop.classList.add('hidden');project=null;if(pollTimer){clearInterval(pollTimer);pollTimer=null}if(logsTimer){clearInterval(logsTimer);logsTimer=null}if(frame.src&&frame.src!=='about:blank'){frame.src='about:blank';lastIframeUrl=''}}startBtn.onclick=()=>action('${BASE}/api/preview/'+encodeURIComponent(project)+'/start');stopBtn.onclick=()=>action('${BASE}/api/preview/'+encodeURIComponent(project)+'/stop');restartBtn.onclick=()=>action('${BASE}/api/preview/'+encodeURIComponent(project)+'/restart');reloadBtn.onclick=()=>{if(frame.src&&frame.src!=='about:blank'){const u=frame.src;frame.src='about:blank';setTimeout(()=>{lastIframeUrl='';loadIframe(u)},50)}};logsBtn.onclick=toggleLogs;closeBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});window.pwPreview={open:show,close:hide};document.addEventListener('click',e=>{const btn=e.target.closest('[data-preview]');if(!btn)return;e.preventDefault();show(btn.dataset.preview)})})();</script>`;


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

const designTokensCss = `:root{--bg:#070c18;--bg2:#0e1728;--panel:#141f38;--panel2:#1c2a49;--line:#2a3a5c;--line2:#3d5480;--text:#eaf1fb;--dim:#a7bbd6;--faint:#94a9c7;--elev:#1a2742;--elev2:#24345a;--elev3:#2e4069;--cyan:#38bdf8;--blue:#2563eb;--amber:#fbbf24;--amber2:#f59e0b;--ok:#34d399;--err:#f87171;--topbar-h:42px;--rail-w:64px;--rail-wo:246px;--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace}
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:.16s}\n@keyframes pwPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}`;
// deployCss (fully scoped) is imported from app/deploy-css.js.

const deployModalHtml = `<div id="deployBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box" style="max-width:900px"><header><h2 id="deployModalTitle">Deploy</h2><button class="modal-close" id="deployCloseBtn" aria-label="Close" type="button">×</button></header><div class="body" id="deployModalBody" style="padding:1rem 1.25rem"><p class="muted">Loading…</p></div></div></div>`;
const deployModalScript = `<script>(function(){const backdrop=document.getElementById('deployBackdrop');if(!backdrop)return;const title=document.getElementById('deployModalTitle');const body=document.getElementById('deployModalBody');const closeBtn=document.getElementById('deployCloseBtn');let project=null;function escHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function hide(){backdrop.classList.add('hidden');project=null}closeBtn.onclick=hide;backdrop.addEventListener('click',e=>{if(e.target===backdrop)hide()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!backdrop.classList.contains('hidden'))hide()});async function show(name){backdrop.__pwRefresh=()=>show(name);project=name;title.textContent='Deploy — '+name;body.innerHTML='<p class="muted">Loading…</p>';backdrop.classList.remove('hidden');try{const r=await fetch('${BASE}/api/deploy/'+encodeURIComponent(name)+'/card',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'load failed');body.innerHTML=j.html;bindDeployActions(body)}catch(e){body.innerHTML='<p style="color:#fca5a5">'+escHtml(e.message||String(e))+'</p>'}}function bindDeployActions(container){container.querySelectorAll('.deploy-tab').forEach(t=>{t.addEventListener('click',()=>{container.querySelectorAll('.deploy-tab').forEach(b=>b.classList.remove('active'));t.classList.add('active');container.querySelectorAll('.deploy-tab-panel').forEach(p=>p.style.display='none');const panel=container.querySelector('#'+t.dataset.tab);if(panel)panel.style.display='block'})});container.querySelectorAll('.deploy-btn').forEach(btn=>{btn.addEventListener('click',async()=>{const card=btn.closest('.target-card');const target=card.dataset.target;const output=card.querySelector('.deploy-output');const isProd=target==='prod';const opt=(card.querySelector('.deploy-option')||{}).value||'';if((isProd||(opt&&opt!=='draft'))&&!confirm('Confirm \"'+(card.dataset.label||'this slot')+'\"'+(opt?' ('+opt+')':'')+' for '+project+'? This action is logged.'))return;btn.disabled=true;btn.textContent='Deploying…';output.className='deploy-output show';output.textContent='Running deployment script…';async function runDeploy(pw,save){const bd={option:opt};if(pw){bd.password=pw;if(save)bd.savePassword=true}const r=await fetch('${BASE}/api/deploy/'+encodeURIComponent(project)+'/'+target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(bd)});return r.json()}try{let j=await runDeploy('',false);if(!j.ok&&j.needPassword){const pw=prompt(j.error||'Enter your domain password for deployment:');if(!pw){output.textContent='Deployment cancelled.';return}const save=confirm('Save this password securely so you are not asked again? It is stored encrypted on the server and reused for future deployments.');output.textContent='Running deployment script…';j=await runDeploy(pw,save)}output.textContent=(j.ok?'✅ SUCCESS':'❌ FAILED')+' ('+(j.duration||'?')+'s)\\nVersion: '+(j.version||'unknown')+'\\n\\n'+(j.output||j.error||'');const vEl=card.querySelector('.current-version');if(vEl&&j.version)vEl.textContent=j.version;const nb=card.querySelector('.src-newer-badge');if(nb&&typeof j.sourceNewer==='boolean')nb.hidden=!j.sourceNewer;const ldEl=card.querySelector('.last-deploy-info');if(ldEl&&j.ok)ldEl.textContent='Just now by '+(j.user||'you')}catch(e){output.textContent=e.message||String(e)}finally{btn.textContent='Deploy';btn.disabled=false}})});container.querySelectorAll('.save-config').forEach(btn=>{btn.addEventListener('click',async()=>{const card=btn.closest('.target-card');const target=card.dataset.target;const script=card.querySelector('.deploy-script').value;const versionCmd=card.querySelector('.version-cmd').value;try{const r=await fetch('${BASE}/api/deploy/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,target,script,versionCmd})});const j=await r.json();if(!j.ok)throw new Error(j.error);btn.textContent='Saved ✓';setTimeout(()=>{btn.textContent='Save'},2000)}catch(e){alert(e.message||String(e))}})})}window.pwDeploy={open:show,close:hide};document.addEventListener('click',e=>{const btn=e.target.closest('[data-deploy]');if(!btn)return;e.preventDefault();show(btn.dataset.deploy)})})();</script>`;

const deployScript = `<script>
(function(){
 function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]))}
 document.querySelectorAll('.save-config').forEach(btn=>{
  btn.onclick=async()=>{
   const card=btn.closest('.target-card');
   const project=card.dataset.project;
   const target=card.dataset.target;
   const script=card.querySelector('.deploy-script').value;
   const versionCmd=card.querySelector('.version-cmd').value;
   btn.disabled=true;btn.textContent='Saving…';
   try{
    const r=await fetch('${BASE}/api/deploy/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,target,script,versionCmd})});
    const j=await r.json();
    if(!j.ok)throw new Error(j.error);
    btn.textContent='Saved ✓';setTimeout(()=>{btn.textContent='Save';btn.disabled=false},1500);
   }catch(e){alert(e.message);btn.textContent='Save';btn.disabled=false}
  };
 });
 document.querySelectorAll('.deploy-btn').forEach(btn=>{
  btn.onclick=async()=>{
   const card=btn.closest('.target-card');
   const project=card.dataset.project;
   const target=card.dataset.target;
   const output=card.querySelector('.deploy-output');
   const isProd=target==='prod';
   const opt=(card.querySelector('.deploy-option')||{}).value||'';
   if((isProd||(opt&&opt!=='draft')) && !confirm('Confirm "'+(card.dataset.label||'this slot')+'"'+(opt?' ('+opt+')':'')+' for '+project+'? This action is logged.'))return;
   btn.disabled=true;btn.textContent='Deploying…';output.className='deploy-output show';output.textContent='Running deployment script…';
   async function runDeploy(pw,save){
    const bd={option:opt};
    if(pw){bd.password=pw;if(save)bd.savePassword=true}
    const r=await fetch('${BASE}/api/deploy/'+encodeURIComponent(project)+'/'+target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(bd)});
    return r.json();
   }
   try{
    // Request first, exactly as the cockpit modal does: the server verifies the
    // saved password itself and answers needPassword only when there is none or
    // it no longer verifies. Prompting up-front here is what made a stored
    // password useless on this page.
    let j=await runDeploy('',false);
    if(!j.ok&&j.needPassword){
     const pw=prompt(j.error||'Enter your domain password for deployment:');
     if(!pw){output.textContent='Deployment cancelled.';return}
     const save=confirm('Save this password securely so you are not asked again? It is stored encrypted on the server and reused for future deployments.');
     output.textContent='Running deployment script…';
     j=await runDeploy(pw,save);
    }
    if(!j.ok){output.textContent='❌ FAILED\\n'+(j.error||'deploy failed')+(j.output?'\\n\\n'+j.output:'');throw new Error(j.error||'deploy failed')}
    output.textContent='✅ SUCCESS ('+j.duration+'s)\\nVersion: '+(j.version||'unknown')+'\\n\\n'+j.output;
    const vEl=card.querySelector('.current-version');
    if(vEl&&j.version)vEl.textContent=j.version;
    // This page keeps its badge in .version-line via markSrcNewer, so reuse that
    // rather than introducing a second mechanism: a deploy changes the comparison
    // and the badge has to follow it here too.
    markSrcNewer(card, j.version||'');
    const ldEl=card.querySelector('.last-deploy-info');
    if(ldEl)ldEl.textContent='Just now by '+j.user;
   }catch(e){output.textContent=output.textContent||e.message}finally{btn.textContent='Deploy';btn.disabled=false}
  };
 });
 document.querySelectorAll('.toggle-log').forEach(btn=>{
  btn.onclick=async()=>{
   const card=btn.closest('.project-card');
   const logDiv=card.querySelector('.deploy-log');
   if(logDiv.style.display==='block'){logDiv.style.display='none';btn.textContent='Show history';return}
   const project=card.dataset.project;
   try{
    const r=await fetch('${BASE}/api/deploy/'+encodeURIComponent(project)+'/log');
    const j=await r.json();if(!j.ok)throw new Error(j.error);
    if(!j.log.length){logDiv.innerHTML='<p class="muted">No deployments yet.</p>'}
    else{logDiv.innerHTML='<table class="log-table"><thead><tr><th>When</th><th>Target</th><th>Version</th><th>User</th><th>Status</th><th>Duration</th></tr></thead><tbody>'+j.log.slice(-20).reverse().map(e=>'<tr><td>'+esc(e.ts?.replace('T',' ').replace(/\\.\\d+Z/,' UTC'))+'</td><td>'+esc(e.target)+'</td><td><span class="version">'+esc(e.version||'—')+'</span></td><td>'+esc(e.user)+'</td><td><span class="badge '+(e.status==='success'?'ok':'fail')+'">'+esc(e.status)+'</span></td><td>'+(e.duration||'—')+'s</td></tr>').join('')+'</tbody></table>'}
    logDiv.style.display='block';btn.textContent='Hide history';
   }catch(e){logDiv.innerHTML='<p class="muted">Error: '+esc(e.message)+'</p>';logDiv.style.display='block'}
  };
 });
 function srcCmp(src,dep){var re=/^V1\\.\\d{2}\\.\\d{4}\\.\\d{4}$/;return !!src&&!!dep&&re.test(src)&&re.test(dep)&&src>dep;}
 function markSrcNewer(card,dep){
  var pc=card.closest('.project-card');var se=pc&&pc.querySelector('.version.source');
  var src=se?se.textContent.trim():'';var line=card.querySelector('.version-line');if(!line)return;
  var badge=line.querySelector('.src-newer');
  if(srcCmp(src,dep)){
   if(!badge){badge=document.createElement('span');badge.className='src-newer';badge.title='Working copy is newer than the deployed build — deploy to update';badge.textContent='⬆ source newer';badge.style.cssText='display:inline-block;margin-left:.5rem;font-size:.72rem;font-weight:600;color:#fde68a;background:rgba(245,158,11,.15);border:1px solid #b45309;border-radius:999px;padding:.05rem .5rem;white-space:nowrap';line.appendChild(badge);}
  }else if(badge){badge.remove();}
 }
 async function probeTarget(card){
  if(!card || card.dataset.probeable!=='1') return;
  const project=card.dataset.project, target=card.dataset.target;
  const vEl=card.querySelector('.current-version');
  const btn=card.querySelector('.probe-btn');
  if(vEl){vEl.textContent='…';vEl.title='';}
  if(btn)btn.disabled=true;
  try{
   const r=await fetch('${BASE}/api/deploy/'+encodeURIComponent(project)+'/'+target+'/version');
   const j=await r.json();
   if(!j.ok)throw new Error(j.error||'probe failed');
   if(vEl)vEl.textContent=j.version||'—';
   markSrcNewer(card, j.version||'');
  }catch(e){ if(vEl){vEl.textContent='⚠';vEl.title=e.message;} markSrcNewer(card,''); }
  finally{ if(btn)btn.disabled=false; }
 }
 document.querySelectorAll('.probe-btn').forEach(btn=>{ btn.onclick=()=>probeTarget(btn.closest('.target-card')); });
 const probeAllBtn=document.getElementById('probe-all');
 async function probeAll(){
  const cards=[...document.querySelectorAll('.target-card[data-probeable="1"]')];
  if(!cards.length)return;
  if(probeAllBtn){probeAllBtn.disabled=true;probeAllBtn.classList.add('probing');probeAllBtn.textContent='Probing…';}
  let i=0; const POOL=5;
  const worker=async()=>{ while(i<cards.length){ await probeTarget(cards[i++]); } };
  await Promise.all(Array.from({length:Math.min(POOL,cards.length)},worker));
  if(probeAllBtn){probeAllBtn.disabled=false;probeAllBtn.classList.remove('probing');probeAllBtn.textContent='↻ Probe all';}
 }
 if(probeAllBtn)probeAllBtn.onclick=probeAll;
 probeAll();
})();
</script>`;

const cockpitCss = `html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font)}
#shell{display:flex;width:100%;height:100%}
#stage{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;position:relative;background:#1f1f1f}
iframe#term{border:0;width:100%;flex:1 1 auto;min-height:0;display:block;background:#1f1f1f}
#topBar{flex:0 0 var(--topbar-h);height:var(--topbar-h);display:flex;align-items:center;gap:10px;padding:0 10px 0 12px;box-sizing:border-box;background:linear-gradient(180deg,rgba(13,21,38,.97),rgba(9,15,28,.92));border-bottom:1px solid var(--line);box-shadow:0 6px 18px -8px rgba(0,0,0,.8);position:relative;z-index:12;font:13px var(--font);color:var(--dim)}
.projChip{display:inline-flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;padding:3px 12px 3px 4px;border:1px solid #2f65b0;border-radius:999px;background:linear-gradient(180deg,#10233f,#0b1830);box-shadow:inset 0 0 0 1px rgba(56,189,248,.12),0 0 12px -5px rgba(56,189,248,.5)}
.pcMono{display:inline-grid;place-items:center;width:24px;height:24px;flex:0 0 24px;border-radius:999px;font:700 10.5px/1 var(--mono);background:hsl(var(--h) 55% 16%);color:hsl(var(--h) 90% 72%);border:1px solid hsl(var(--h) 55% 30%);text-transform:uppercase}
.pcName{font-weight:650;font-size:13px;color:#eaf4ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.projChipWrap{position:relative;display:inline-flex;flex:0 1 auto;min-width:0}
button.projChip{appearance:none;font:inherit;cursor:pointer;text-align:left}
button.projChip:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.pcCaret{color:var(--dim);font-size:10px;line-height:1;flex:0 0 auto;transition:color .12s}
button.projChip[aria-expanded="true"] .pcCaret{color:var(--cyan)}
/* Two classes so it beats .tabMenu's position:fixed regardless of source order. */
.tabMenu.projLinks{position:absolute;top:calc(100% + 6px);left:0;min-width:260px}
.tabMenu.projLinks[hidden]{display:none}
.tabMenu.projLinks .tabMenuItem{text-decoration:none}
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
.tabStrip .tab .live{width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--ok);animation:pwLivePulse 1.5s ease-in-out infinite}
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
#tray{position:absolute;left:0;right:0;top:var(--topbar-h);z-index:10;background:var(--elev);backdrop-filter:blur(10px);color:var(--text);border-bottom:2px solid var(--line2);box-shadow:0 28px 56px -10px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05);padding:14px 18px 16px;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"tabs tabs" "header header" "list dropzone" "status status";gap:12px;align-items:stretch;max-height:calc(100vh - var(--topbar-h) - 16px);overflow:auto;transform:translateY(-102%);opacity:0;pointer-events:none;transition:transform .3s cubic-bezier(.32,.72,.24,1),opacity .2s ease;will-change:transform,opacity;font:13px var(--font)}
#inboxHeader{grid-area:header}#inboxList{grid-area:list}#drop,#preview{grid-area:dropzone}#status{grid-area:status}
#trayTabs{grid-area:tabs;display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px}
.trayTab{appearance:none;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--dim);font:600 13px var(--font);padding:5px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.trayTab:hover{color:var(--text);background:var(--panel2)}
.trayTab[aria-selected="true"]{color:var(--cyan);background:var(--panel);border-color:var(--line2)}
.trayTab:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
.trayCount{background:var(--panel2);border:1px solid var(--line2);border-radius:999px;font-size:11px;line-height:1;padding:2px 7px;color:var(--dim);min-width:10px;text-align:center}
.trayTab[aria-selected="true"] .trayCount{color:var(--text)}
.trayPanel{display:contents}
.trayPanel[hidden]{display:none}
.trayEmpty{color:var(--faint);font-style:italic;font-size:12px;padding:8px 2px}
#outboxHeader{grid-area:header}#outboxList{grid-area:list}#outboxStatus{grid-area:status;white-space:pre-wrap;color:var(--faint);font-size:13px;line-height:1.35}
#tray.tray-outbox{grid-template-areas:"tabs tabs" "header header" "list list" "status status"}
#outboxList .row{cursor:default}
.inboxList .row .dl{background:transparent;border:1px solid var(--line2);color:var(--cyan);border-radius:6px;padding:2px 9px;font-size:12px;cursor:pointer;text-decoration:none;flex:0 0 auto}
.inboxList .row .dl:hover{background:var(--panel2);color:var(--text)}
body.has-preview #drop{display:none}body:not(.has-preview) #preview{display:none}
body.shade-open #tray{transform:translateY(0);opacity:1;pointer-events:auto}
#drop{border:2px dashed #4d70ad;border-radius:14px;padding:30px 18px;text-align:center;background:var(--elev2);outline:none;cursor:pointer;min-height:130px;display:flex;flex-direction:column;justify-content:center;width:100%;box-sizing:border-box;color:var(--dim);transition:border-color .15s,background .15s}
#drop:hover{border-color:var(--cyan);background:var(--elev3)}
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
.inboxHeader .clear{font-size:12px;color:#fca5a5;background:transparent;border:1px solid #5a7099;border-radius:7px;padding:3px 9px;cursor:pointer}
.inboxHeader .clear:hover{background:var(--panel2);color:#fff;border-color:var(--dim)}
.inboxList{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;border-top:1px solid var(--line2);padding-top:6px;margin:0;scrollbar-width:thin}
.inboxList::-webkit-scrollbar{width:6px}
.inboxList::-webkit-scrollbar-thumb{background:var(--line2);border-radius:3px}
.inboxList .row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:7px;cursor:pointer;background:var(--elev2);border:1px solid var(--line2)}
.inboxList .row:hover{background:var(--elev3);border-color:var(--cyan)}
.inboxList .thumb{width:36px;height:36px;background:var(--elev3);border:1px solid var(--line2);box-sizing:border-box;border-radius:5px;display:flex;align-items:center;justify-content:center;flex:0 0 36px;overflow:hidden;color:var(--faint);font-size:11px;font-weight:600}
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
.tabMenu{position:fixed;z-index:9999;background:var(--elev);border:1px solid var(--line2);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.7);padding:.35rem;min-width:220px;max-width:380px;display:flex;flex-direction:column;gap:2px;font:13px var(--font)}
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
/* overflow-x:hidden is load-bearing, not tidying: .pk-name is always in the DOM
   with white-space:nowrap, so the clip is what hides project names while the rail
   is collapsed and reveals them when the panel widens to --rail-wo. Do not
   "fix" it to visible.
   What the clip must never eat is the monogram. Budget across the collapsed
   64px rail: 1px panel border + 12px tile padding-left + 32px .pk-mono
   (flex:0 0 32px, so it does not shrink) = 45px that has to survive. A
   scrollbar-less content box was 63-14=49px, leaving only 4px of slack; a thin
   scrollbar takes ~8-12px out of that same box, so the monogram lost up to 12px
   the moment a project list got long enough to scroll — clipped mid-glyph.
   scrollbar-gutter:stable reserves that space whether or not the scrollbar is
   present, so the collapsed geometry stops depending on how many projects exist,
   and padding-right drops to 6px to pay for the reservation. */
.railKeys{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding:10px 6px 10px 0;display:flex;flex-direction:column;gap:7px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.pkey{position:relative;display:flex;align-items:center;gap:9px;height:46px;flex:0 0 46px;padding:0 10px 0 12px;border:1px solid var(--line);border-left:0;border-radius:0 11px 11px 0;background:linear-gradient(180deg,var(--panel),#0a1120);color:var(--dim);text-decoration:none;box-sizing:border-box;transition:transform .18s cubic-bezier(.34,1.4,.44,1),background .18s,border-color .18s,box-shadow .18s,color .18s,opacity .2s,filter .2s;animation:pkIn .5s cubic-bezier(.22,.9,.3,1) backwards;animation-delay:calc(var(--i)*38ms)}
@keyframes pkIn{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
/* The pin is a sibling of the link, not a descendant: a button inside an <a> is
   invalid content and was reachable only by mouse at tabindex="-1". So the ROW
   owns the geometry and the slide-out, because a transform on the link alone
   would leave the pin behind while the tile travels. Hover styling keys off the
   row too, so pointing at the pin still lights its tile. */
.railKeysList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.pkeyRow{position:relative;flex:0 0 46px;transition:transform .18s cubic-bezier(.34,1.4,.44,1)}
.pkeyRow:hover{transform:translateX(4px)}
.pkeyRow.pinned{transform:translateX(10px)}
.pkeyRow.pinned:hover{transform:translateX(12px)}
.pkey:hover,.pkeyRow:hover .pkey{color:#fff;border-color:var(--line2);background:linear-gradient(180deg,var(--panel2),#0c1424)}
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
.pk-live{position:absolute;bottom:7px;right:7px;width:7px;height:7px;border-radius:50%;background:var(--ok);opacity:0;transition:opacity .25s}
.pkey.working .pk-live{opacity:1;animation:pwLivePulse 1.5s ease-in-out infinite}
.pkey.working .pk-mono{box-shadow:0 0 12px -2px rgba(52,211,153,.4)}
@keyframes pwLivePulse{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.5);opacity:.8}50%{box-shadow:0 0 0 5px rgba(52,211,153,0);opacity:1}}
.pkey.lit{border-color:#a16207;background:linear-gradient(180deg,#221a06,#140f03);color:#ffe9b8}
.pkey.lit .pk-edge{background:linear-gradient(180deg,var(--amber),var(--amber2));box-shadow:0 0 12px rgba(251,191,36,.8);animation:pkGlow 1.8s ease-in-out infinite}
.pkey.lit .pk-mono{border-color:#b45309;color:#ffd98a;background:#271c04;box-shadow:0 0 14px -2px rgba(245,158,11,.35)}
.pkey.lit .pk-dot{opacity:1;background:var(--amber);box-shadow:0 0 8px var(--amber);animation:pkGlow 1.8s ease-in-out infinite}
@keyframes pkGlow{0%,100%{opacity:.6}50%{opacity:1}}
.pkey.pinned{border-color:hsl(var(--h) 60% 45%);box-shadow:0 6px 18px -8px rgba(0,0,0,.95),0 0 14px -4px hsl(var(--h) 70% 55% / .5)}
.pkey.pinned:not(.current):not(.lit) .pk-edge{background:hsl(var(--h) 65% 52% / .95);box-shadow:0 0 10px hsl(var(--h) 70% 55% / .6)}
.pkey.pinned:not(.lit) .pk-mono{background:hsl(var(--h) 78% 58%);color:#070b12;border-color:hsl(var(--h) 90% 75%);box-shadow:0 0 12px -2px hsl(var(--h) 75% 60% / .6);font-weight:800}
.railKeys.has-pins .pkey:not(.pinned):not(.current):not(.lit):not(.working){opacity:.5;filter:saturate(.5) brightness(.82)}
.railKeys.has-pins .pkey:not(.pinned):hover{opacity:1;filter:none}
.pkey.pinned.lit{border-color:#a16207;box-shadow:0 6px 18px -8px rgba(0,0,0,.95),0 0 16px -3px rgba(251,191,36,.6)}
/* Which project am I actually in? Answered by geometry, not by colour.
   Colour is the crowded channel here: pins claim the hue-filled monogram and the lean-out, attention
   claims amber, and at the collapsed 64px width all that survived of "current" was a 3px edge sitting
   among other coloured 3px edges — so every emphasised key looked equally emphasised. The active key
   instead squares off and runs into the workspace, the way a tab joins its panel. Nothing else in the
   rail uses the right-hand edge, it reads at 64px, and it composes: a project that is both active and
   asking for attention keeps its amber and still shows which one you are standing in.
   Placed after the pinned/lit rules deliberately — those set border-color, and the merge needs the
   right-hand border gone whatever else the key is. */
.pkey.current{border-radius:0;border-right-color:transparent}
.pkey.current .pk-edge{top:0;bottom:0;width:5px;border-radius:0}
.pkey.current::after{content:'';position:absolute;top:-1px;bottom:-1px;left:100%;width:16px;background:linear-gradient(180deg,#10233f,#0b1830);border-top:1px solid #2f65b0;border-bottom:1px solid #2f65b0;pointer-events:none}
.pkey.current.lit::after{background:linear-gradient(180deg,#221a06,#140f03);border-color:#a16207}
.pk-pin{position:absolute;right:7px;top:50%;transform:translateY(-50%);width:22px;height:22px;display:none;place-items:center;font-size:11px;line-height:1;border-radius:6px;cursor:pointer;opacity:0;filter:grayscale(1) brightness(1.5);transition:opacity .15s,filter .15s,background .15s;user-select:none;z-index:2;appearance:none;background:transparent;border:0;color:inherit;font-family:inherit;padding:0}
.pkeyRow:hover .pk-pin{opacity:.55}
/* opacity:0 by default, so a keyboard user landing on it must be able to see it —
   a focusable control that stays invisible while focused is worse than one that
   cannot be focused at all. */
.pk-pin:focus-visible{opacity:1;outline:2px solid var(--cyan);outline-offset:1px;background:rgba(255,255,255,.07)}
.pk-pin:hover{opacity:1;background:rgba(255,255,255,.07)}
.pkeyRow.pinned .pk-pin{filter:none;opacity:.9}
.railAct.off .autoPinIco{filter:grayscale(1);opacity:.5}
#autoPinState{color:var(--ok);font-weight:800}
.railAct.off #autoPinState{color:var(--faint)}
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
@container (min-width:180px){.railBrandName{opacity:1;transform:none}#railToggle .chev{opacity:1}.pk-meta{opacity:1;transform:none}.railActLabel{opacity:1;transform:none}.railWhoName{opacity:1}.pk-pin{display:grid}}
#railScrim{display:none}
@media(max-width:640px){
#rail{position:fixed;top:0;left:0;bottom:0;z-index:60;transform:translateX(-100%);transition:transform .3s cubic-bezier(.32,.72,.24,1);width:var(--rail-wo);flex-basis:var(--rail-wo)}
body.rail-mobile-open #rail{transform:none}
#railPanel{width:var(--rail-wo);border-right:1px solid var(--line2);box-shadow:26px 0 60px rgba(0,0,0,.75)}
#railScrim{display:block;position:fixed;inset:0;background:rgba(2,6,14,.6);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .25s;z-index:55}
body.rail-mobile-open #railScrim{opacity:1;pointer-events:auto}
.railBtn{display:inline-grid}
#topBar{padding:0 8px;gap:6px}
.pcName{max-width:110px;font-size:12px}
.tabStrip{padding:0 4px;gap:3px}
.tabStrip .tab{max-width:140px;padding:2px 6px}
.tabStrip .tab .name{max-width:100px}
.tabStrip .newTab{padding:1px 7px;font-size:13px}
.previewBtn{padding:3px 9px;font-size:11px}
#fileBtn{padding:3px 9px;font-size:11px}
#fileBtn::before{content:'⬇'}
.fileInfo{display:none}
#tray{grid-template-columns:1fr;grid-template-areas:"tabs" "header" "dropzone" "list" "status"}
#tray.tray-outbox{grid-template-areas:"tabs" "header" "list" "status"}
}`;

function railHtml(projects, currentName, user, deployConfigured=false){
 const isAdmin = user.role === 'admin';
 const keys = projects.map((p,i)=>{
  const cur = p.name === currentName;
  // The pin is a real <button> beside the link, not a role="button" span inside
  // it: <a> may not contain interactive content, and at tabindex="-1" the only
  // way to pin was with a mouse. aria-pressed carries the state that the tile's
  // colour used to carry alone. The custom properties sit on the row so both
  // children inherit them.
  return `<li class="pkeyRow" style="--h:${projHue(p.name)};--i:${i}"><a class="pkey${cur?' current':''}" href="${BASE}/term/${encodeURIComponent(p.name)}/" data-project="${esc(p.name)}"${cur?' aria-current="page"':''}><span class="pk-edge"></span><span class="pk-mono">${esc(projMonogram(p.name))}</span><span class="pk-meta"><span class="pk-name">${esc(p.name)}</span><span class="pk-sub">${cur?'active session':''}</span></span><span class="pk-dot" aria-hidden="true"></span><span class="pk-live" aria-hidden="true"></span></a><button class="pk-pin" type="button" data-project="${esc(p.name)}" aria-pressed="false" aria-label="Pin ${esc(p.name)}"><span aria-hidden="true">📌</span></button></li>`;
 }).join('');
 const adminActs = isAdmin
  ? `<a class="railAct" id="manageEntry" href="${BASE}/manage" title="Manage projects"><span class="railActIco">✎</span><span class="railActLabel">Manage projects</span></a><a class="railAct" href="${BASE}/settings" title="Settings"><span class="railActIco">⚙</span><span class="railActLabel">Settings</span></a>`
  : '';
 const deployAct = DEPLOY_CENTRE && deployConfigured
  ? `<a class="railAct" id="deployEntry" href="${BASE}/deploy?project=${encodeURIComponent(currentName)}" data-deploy="${esc(currentName)}" title="Deploy this project"><span class="railActIco">🚀</span><span class="railActLabel">Deploy</span></a>`
  : '';
 const who = user.implicit
  ? `<span class="railWho" title="PW_AUTH_ENFORCE off — anonymous admin"><span class="railWhoDot"></span><span class="railWhoName">anonymous</span></span>`
  : `<span class="railWho" title="${esc(user.username)} · ${esc(user.role)}"><span class="railWhoDot"></span><span class="railWhoName">${esc(user.username)} · ${esc(user.role)}</span></span><button id="railLogout" class="railAct" type="button" title="Sign out"><span class="railActIco">↪</span><span class="railActLabel">Sign out</span></button>`;
 const autoPinBtn = `<button id="autoPinBtn" class="railAct" type="button" role="switch" aria-pressed="true" title="Auto-pin projects when a session finishes"><span class="railActIco autoPinIco">📌</span><span class="railActLabel">Auto-pin on done · <b id="autoPinState">on</b></span></button>`;
 return `<aside id="rail" aria-label="Projects"><div id="railPanel"><div class="railHead"><button id="railToggle" type="button" aria-expanded="false" title="Pin the project rail open"><span class="brandGlyph" aria-hidden="true">&gt;_</span><span class="railBrandName">Workbench</span><span class="chev" aria-hidden="true">›</span></button></div><nav id="railKeys" class="railKeys" aria-label="Projects"><ul class="railKeysList">${keys}</ul></nav><div class="railFoot">${autoPinBtn}${deployAct}${adminActs}${who}</div></div></aside><div id="railScrim" aria-hidden="true"></div>`;
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
if(logout)logout.onclick=async()=>{try{await fetch('${BASE}/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'}})}catch{}location.href='${BASE}/login'};
let pinned=new Set();try{pinned=new Set(JSON.parse(localStorage.getItem('pwPinned')||'[]'))}catch{}
let autoPin=true;try{autoPin=(localStorage.getItem('pwAutoPin')||'1')==='1'}catch{}
function savePins(){try{localStorage.setItem('pwPinned',JSON.stringify([...pinned]))}catch{}}
function applyPins(){KEYS.classList.toggle('has-pins',pinned.size>0);KEYS.querySelectorAll('.pkey').forEach(k=>{const n=k.dataset.project;const on=pinned.has(n);k.classList.toggle('pinned',on);const row=k.closest('.pkeyRow');if(row)row.classList.toggle('pinned',on);const pb=row&&row.querySelector('.pk-pin');if(pb){pb.title=on?'Unpin':'Pin — lean this project out while you work with it';pb.setAttribute('aria-pressed',on?'true':'false');pb.setAttribute('aria-label',(on?'Unpin ':'Pin ')+n)}})}
const autoBtn=document.getElementById('autoPinBtn');
function renderAuto(){if(!autoBtn)return;autoBtn.setAttribute('aria-pressed',autoPin?'true':'false');autoBtn.classList.toggle('off',!autoPin);const st=document.getElementById('autoPinState');if(st)st.textContent=autoPin?'on':'off'}
if(autoBtn)autoBtn.onclick=()=>{autoPin=!autoPin;try{localStorage.setItem('pwAutoPin',autoPin?'1':'0')}catch{}renderAuto()};
KEYS.addEventListener('click',e=>{const pb=e.target.closest('.pk-pin');if(!pb)return;e.preventDefault();e.stopPropagation();const n=pb.dataset.project;if(!n)return;if(pinned.has(n))pinned.delete(n);else pinned.add(n);savePins();applyPins()});
applyPins();renderAuto();
const baseTitle=(CUR?CUR+' — ':'')+'Workbench';
document.title=baseTitle;
let first=true;
async function refreshRail(){try{
const r=await fetch('${BASE}/api/projects/status',{cache:'no-store'});if(r.status===401){if(window.pwAuthLost)window.pwAuthLost();return}const j=await r.json();if(!j||!j.ok)return;
let anyLit=false;
for(const p of (j.projects||[])){
const key=KEYS.querySelector('[data-project="'+p.name+'"]');if(!key)continue;
const lit=!!p.pending&&p.name!==CUR;if(lit)anyLit=true;
const was=key.classList.contains('lit');
key.classList.toggle('lit',lit);
key.classList.toggle('working',!!p.working);
const sub=key.querySelector('.pk-sub');
if(sub)sub.textContent=(p.name===CUR)?(p.working?'working…':'active session'):(lit?'finished — click to view':(p.working?'working…':''));
if(lit&&!was&&!first){key.classList.add('struck');key.addEventListener('animationend',()=>key.classList.remove('struck'),{once:true})}
if(lit&&autoPin&&!pinned.has(p.name)){pinned.add(p.name);savePins();applyPins()}
}
const known=new Set((j.projects||[]).map(x=>x.name));
let pruned=false;for(const n of [...pinned]){if(!known.has(n)){pinned.delete(n);pruned=true}}
if(pruned){savePins();applyPins()}
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
.pmField input,.pmField textarea,.pmField select{background:#070d19;color:var(--text);border:1px solid var(--line);border-radius:9px;padding:9px 11px;font:13px var(--font);box-sizing:border-box;width:100%;transition:border-color .15s}
.pmField textarea{font:12px/1.5 var(--mono);resize:vertical}
.pmField input:focus,.pmField textarea:focus,.pmField select:focus{outline:none;border-color:var(--cyan)}
.pmField .pmHelp{font-size:11.5px;color:var(--faint);line-height:1.5;text-transform:none;letter-spacing:0;font-weight:400}
.pmField .pmHelp code{font-family:var(--mono);color:#9fd3ff;font-size:11px}
.pmField input[type=checkbox]{width:auto;padding:0;accent-color:var(--cyan)}
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
<section class="pmPane active" data-p="general"><div class="pmField"><span>Name</span><input id="pmName" type="text" pattern="[A-Za-z0-9._-]+" maxlength="120" autocomplete="off"><span class="pmHelp">Letters, digits, dot, dash, underscore. Renaming moves the workspace folder.</span></div><div class="pmField"><span>Repo URL <em style="text-transform:none;font-style:normal;font-weight:400">(optional)</em></span><input id="pmRepo" type="text" placeholder="https://github.com/owner/Repo.git — blank = local-only workspace" autocomplete="off"></div><div class="pmField"><span>Dev site URL <em style="text-transform:none;font-style:normal;font-weight:400">(optional)</em></span><input id="pmDevUrl" type="url" placeholder="http://host:port/ — shown in the project name menu" autocomplete="off"></div><div class="pmField"><span>Prod site URL <em style="text-transform:none;font-style:normal;font-weight:400">(optional)</em></span><input id="pmProdUrl" type="url" placeholder="https://host/ — shown in the project name menu" autocomplete="off"></div><div class="pmField"><span>Git identity <em style="text-transform:none;font-style:normal;font-weight:400">(for private repos)</em></span><select id="pmPrimaryUser"></select><span class="pmHelp">Choose which user's GitHub token authenticates this workspace's git. Blank leaves git unauthenticated.</span></div><div class="pmRow2"><div class="pmField"><span>Terminal port</span><input id="pmPort" type="number" min="1024" max="65535"></div><div class="pmField"><span>Workspace</span><span class="pmHelp" id="pmPath" style="padding-top:9px;word-break:break-all"></span></div></div><label class="pmField"><span>Admin only</span><span class="pmHelp"><input type="checkbox" id="pmAdminOnly"> Admin only — hidden from non-admins</span></label><label class="pmField"><span>Sign-in landing</span><span class="pmHelp"><input type="checkbox" id="pmDefaultProject"> Default project at sign-in — used for a user's first login, or when the project they last opened is gone. Everyone else resumes whatever they had open last. Only one project can hold this.</span></label><div class="pmCallout" id="pmRestartNote">Saving restarts this project's terminal service — running processes in its tabs are killed.</div></section>
<section class="pmPane" data-p="preview"><div class="pmField"><span>Preview command</span><textarea id="pmPrevCmd" rows="3" placeholder="empty = preview disabled"></textarea><span class="pmHelp">Runs inside the workspace. Use <code>\${PORT}</code> and <code>\${BASEPATH}</code>; the app must bind <code>127.0.0.1:\${PORT}</code>.</span></div><details class="pmExamples"><summary>Examples — click one to use it</summary><div><code>npm run dev -- --host 127.0.0.1 --port \${PORT}</code><code>dotnet watch run --project Foo/Foo.csproj --urls http://127.0.0.1:\${PORT} --non-interactive</code><code>hugo server --bind 127.0.0.1 --port \${PORT} --baseURL http://127.0.0.1:\${PORT}\${BASEPATH}/ --appendPort=false</code><code>python3 -m http.server \${PORT} --bind 127.0.0.1</code></div></details><div class="pmRow2"><div class="pmField"><span>Preview port</span><input id="pmPrevPort" type="number" min="1024" max="65535" placeholder="auto"></div><div></div></div><div class="pmField"><span>Environment</span><textarea id="pmPrevEnv" rows="4" placeholder="# one KEY=VALUE per line&#10;# ASPNETCORE_ENVIRONMENT=Development"></textarea><span class="pmHelp">Exported before the command runs. <code>PORT</code> and <code>BASEPATH</code> are reserved.</span></div></section>
<section class="pmPane" data-p="tabs"><div class="pmField"><span>Tab templates</span><span class="pmHelp">Named tabs offered in the terminal's <b>+</b> menu. <b>auto-start</b> spawns the tab when the project's tmux session is first created. Empty command = plain bash.</span></div><div class="pmTabRows" id="pmTabRows"></div><button class="pmAddTab" id="pmAddTabBtn" type="button">+ Add tab template</button></section>
<section class="pmPane" data-p="danger"><div class="pmCallout red"><b>Delete project</b> — stops its terminal service, kills its tmux session, removes it from the registry <b>and deletes the workspace folder</b> shown in General. Repos without a remote copy are gone for good.</div><div class="pmDelArm"><input id="pmDelName" type="text" placeholder="type the project name to arm" autocomplete="off"><button class="pmDelBtn" id="pmDelBtn" type="button" disabled>Delete project</button></div></section>
</div></div></div></div><footer><span id="pmStatus"></span><button id="pmSave" type="button">Save changes</button></footer></div></div>`;

const manageModalScript = `<script>(function(){
const backdrop=document.getElementById('pmBackdrop');if(!backdrop)return;
const items=document.getElementById('pmItems'),addBtn=document.getElementById('pmAddBtn'),tabsBar=document.getElementById('pmTabs'),panes=[...document.querySelectorAll('.pmPane')],saveBtn=document.getElementById('pmSave'),statusEl=document.getElementById('pmStatus'),closeBtn=document.getElementById('pmClose');
const fName=document.getElementById('pmName'),fRepo=document.getElementById('pmRepo'),fDevUrl=document.getElementById('pmDevUrl'),fProdUrl=document.getElementById('pmProdUrl'),fPort=document.getElementById('pmPort'),fPath=document.getElementById('pmPath'),fAdminOnly=document.getElementById('pmAdminOnly'),fDefaultProject=document.getElementById('pmDefaultProject'),fPrimaryUser=document.getElementById('pmPrimaryUser'),fPrevCmd=document.getElementById('pmPrevCmd'),fPrevPort=document.getElementById('pmPrevPort'),fPrevEnv=document.getElementById('pmPrevEnv'),tabRows=document.getElementById('pmTabRows'),addTabBtn=document.getElementById('pmAddTabBtn'),delName=document.getElementById('pmDelName'),delBtn=document.getElementById('pmDelBtn'),restartNote=document.getElementById('pmRestartNote');
const CUR=(typeof project!=='undefined')?project:null;
let cfg=null,sel=null,mode='edit',formDirty=false,reloadOnClose=false,navTarget=null,busy=false,curNow=CUR;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function hue(name){let h=5381;const s=String(name);for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))|0;return((h%360)+360)%360}
function mono(name){const p=String(name).replace(/[_\\-.]+/g,' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/\\s+/).filter(Boolean);if(p.length>=2)return(p[0][0]+p[1][0]).toUpperCase();return(p[0]||'?').slice(0,2).toUpperCase()}
function setStatus(t,err){statusEl.textContent=t||'';statusEl.classList.toggle('err',!!err)}
function markDirty(){formDirty=true}
[fName,fRepo,fDevUrl,fProdUrl,fPort,fPrimaryUser,fAdminOnly,fPrevCmd,fPrevPort,fPrevEnv].forEach(el=>el.addEventListener('input',markDirty));
fAdminOnly.addEventListener('change',markDirty);fDefaultProject.addEventListener('change',markDirty);fPrimaryUser.addEventListener('change',markDirty);
function activatePane(id){tabsBar.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.t===id));panes.forEach(p=>p.classList.toggle('active',p.dataset.p===id))}
tabsBar.addEventListener('click',e=>{const b=e.target.closest('button[data-t]');if(b&&mode==='edit')activatePane(b.dataset.t)});
function renderList(){items.innerHTML='';for(const p of cfg.projects){const row=document.createElement('div');row.className='pmItem'+(mode==='edit'&&p.name===sel?' sel':'');row.dataset.name=p.name;row.draggable=true;row.style.setProperty('--h',hue(p.name));row.innerHTML='<span class="pmDrag" title="Drag to reorder">⠿</span><span class="pmMono">'+esc(mono(p.name))+'</span><span class="pmIname">'+esc(p.name)+'</span><span class="pmPort">:'+esc(p.port)+'</span>';row.onclick=()=>select(p.name);items.appendChild(row)}addBtn.classList.toggle('sel',mode==='add')}
function tabRowHtml(t){t=t||{};return '<div class="pmTabRow"><input type="text" class="tt-name" placeholder="Tab name" value="'+esc(t.name||'')+'"><input type="text" class="tt-cmd" placeholder="Optional command" value="'+esc(t.cmd||'')+'"><label><input type="checkbox" class="tt-auto"'+(t.autoStart?' checked':'')+'> auto-start</label><button type="button" class="rm" title="Remove">×</button></div>'}
tabRows.addEventListener('click',e=>{const rm=e.target.closest('.rm');if(rm){rm.closest('.pmTabRow').remove();markDirty()}});
tabRows.addEventListener('input',markDirty);
addTabBtn.onclick=()=>{tabRows.insertAdjacentHTML('beforeend',tabRowHtml({autoStart:true}));tabRows.lastElementChild.querySelector('.tt-name').focus();markDirty()};
document.querySelectorAll('.pmExamples code').forEach(c=>c.addEventListener('click',()=>{fPrevCmd.value=c.textContent;markDirty()}));
function envText(env){return Object.entries(env||{}).map(([k,v])=>k+'='+v).join('\\n')}
function primaryOptions(selected){return '<option value="">— none —</option>'+((cfg&&cfg.users)||[]).map(u=>'<option value="'+esc(u.username)+'"'+(selected===u.username?' selected':'')+'>'+esc(u.username)+(u.hasToken?' ✓':'')+'</option>').join('')}
function fillForm(p){fName.value=p?p.name:'';fRepo.value=p?(p.repo||''):'';fDevUrl.value=p?(p.devUrl||''):'';fProdUrl.value=p?(p.prodUrl||''):'';fPrimaryUser.innerHTML=primaryOptions(p?p.primaryUser:'');fPort.value=p?p.port:'';fPort.placeholder=p?'':(cfg.suggestedPort||'auto');fPath.textContent=p?p.path:'(created under /opt/project-workbench/workspaces/<Name>)';fAdminOnly.checked=!!(p&&p.adminOnly);fDefaultProject.checked=!!(p&&cfg&&cfg.defaultProject===p.name);fPrevCmd.value=p&&p.preview?p.preview.cmd:'';fPrevPort.value=p&&p.preview&&p.preview.port?p.preview.port:'';fPrevPort.placeholder=cfg.suggestedPreviewPort||'auto';fPrevEnv.value=p&&p.preview?envText(p.preview.env):'';tabRows.innerHTML=(p&&p.tabs||[]).map(tabRowHtml).join('');delName.value='';delBtn.disabled=true;formDirty=false}
function select(name){if(busy)return;if(formDirty&&!confirm('Discard unsaved changes?'))return;mode='edit';sel=name;const p=cfg.projects.find(x=>x.name===name);fillForm(p);restartNote.textContent=(name===CUR?'You are looking at this project\\u2019s terminal right now — saving restarts it and kills this very session\\u2019s processes.':'Saving restarts this project\\u2019s terminal service — running processes in its tabs are killed.');tabsBar.style.display='';saveBtn.textContent='Save changes';activatePane('general');renderList();setStatus('')}
function startAdd(){if(busy)return;if(formDirty&&!confirm('Discard unsaved changes?'))return;mode='add';sel=null;fillForm(null);tabsBar.style.display='none';activatePane('general');saveBtn.textContent='Create project';renderList();setStatus('Preview, tab templates and more are configurable after the project exists.');setTimeout(()=>fName.focus(),40)}
addBtn.onclick=startAdd;
delName.addEventListener('input',()=>{delBtn.disabled=delName.value.trim()!==sel});
async function api(url,params){const r=await fetch(url,{method:'POST',headers:{'Accept':'application/json'},body:params});let j=null;try{j=await r.json()}catch{}if(!j)throw new Error('Unexpected response ('+r.status+')');if(!j.ok)throw new Error(j.error||('Request failed ('+r.status+')'));return j}
async function refreshCfg(){const r=await fetch('${BASE}/api/projects/config',{cache:'no-store'});cfg=await r.json();if(!cfg.ok)throw new Error(cfg.error||'config load failed')}
function collectTabs(){const arr=[];tabRows.querySelectorAll('.pmTabRow').forEach(row=>{const n=row.querySelector('.tt-name').value.trim();if(!n)return;arr.push({name:n,cmd:row.querySelector('.tt-cmd').value,autoStart:row.querySelector('.tt-auto').checked})});return arr}
saveBtn.onclick=async()=>{if(busy)return;busy=true;saveBtn.disabled=true;try{
if(mode==='add'){const name=fName.value.trim();setStatus('Creating'+(fRepo.value.trim()?' — cloning can take a minute…':'…'));const params=new URLSearchParams({name,repo:fRepo.value.trim(),devUrl:fDevUrl.value.trim(),prodUrl:fProdUrl.value.trim(),port:fPort.value||'',primaryUser:fPrimaryUser.value||'',adminOnly:fAdminOnly.checked?'yes':'',defaultProject:fDefaultProject.checked?'yes':''});await api('${BASE}/manage/add',params);reloadOnClose=true;await refreshCfg();busy=false;sel=name;mode='edit';select(name);setStatus('Created '+name+' — configure Preview and Terminal tabs, or just close to reload.')}
else{const oldName=sel;const newName=fName.value.trim();setStatus('Saving — restarting terminal service…');const params=new URLSearchParams({name:newName,repo:fRepo.value.trim(),devUrl:fDevUrl.value.trim(),prodUrl:fProdUrl.value.trim(),port:fPort.value||'',primaryUser:fPrimaryUser.value||'',adminOnly:fAdminOnly.checked?'yes':'',defaultProject:fDefaultProject.checked?'yes':'',previewCmd:fPrevCmd.value,previewPort:fPrevPort.value||'',previewEnv:fPrevEnv.value,tabs:JSON.stringify(collectTabs())});await api('${BASE}/manage/update/'+encodeURIComponent(oldName),params);reloadOnClose=true;if(oldName===curNow){curNow=newName;navTarget=(curNow===CUR)?null:'${BASE}/term/'+encodeURIComponent(curNow)+'/'}await refreshCfg();busy=false;sel=newName;formDirty=false;select(newName);setStatus('Saved '+newName+' — terminal restarted.')}
}catch(e){setStatus(e.message||String(e),true)}finally{busy=false;saveBtn.disabled=false}};
delBtn.onclick=async()=>{if(busy||delBtn.disabled)return;if(!confirm('Really delete "'+sel+'" AND its workspace folder? This cannot be undone.'))return;busy=true;delBtn.disabled=true;try{setStatus('Deleting '+sel+'…');await api('${BASE}/manage/delete/'+encodeURIComponent(sel),new URLSearchParams({confirm:'yes'}));reloadOnClose=true;if(sel===curNow)navTarget='${BASE}/';await refreshCfg();busy=false;sel=null;formDirty=false;if(cfg.projects.length){select(cfg.projects[0].name);setStatus('Deleted.')}else{navTarget=navTarget||'${BASE}/';closeModal()}}catch(e){setStatus(e.message||String(e),true)}finally{busy=false}};
let dragSrc=null;
items.addEventListener('dragstart',e=>{const row=e.target.closest('.pmItem');if(!row)return;dragSrc=row;row.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',row.dataset.name)}catch{}});
items.addEventListener('dragover',e=>{if(!dragSrc)return;const t=e.target.closest('.pmItem');if(!t||t===dragSrc)return;e.preventDefault();const r=t.getBoundingClientRect();if((e.clientY-r.top)>r.height/2)t.parentNode.insertBefore(dragSrc,t.nextSibling);else t.parentNode.insertBefore(dragSrc,t)});
items.addEventListener('dragend',async()=>{if(!dragSrc)return;dragSrc.classList.remove('dragging');dragSrc=null;const order=[...items.querySelectorAll('.pmItem')].map(r=>r.dataset.name);try{const rr=await fetch('${BASE}/api/projects/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})});const jj=await rr.json().catch(()=>null);if(!jj||!jj.ok)throw new Error((jj&&jj.error)||('HTTP '+rr.status));reloadOnClose=true;cfg.projects.sort((a,b)=>order.indexOf(a.name)-order.indexOf(b.name));setStatus('Order saved — the rail follows it.')}catch(e){setStatus('Reorder failed: '+(e.message||e),true)}});
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


app.get(BASE + '/', requireAuth, async (req,res)=>{
 const allProjects = await loadProjects();
 const projects = filterProjectsForUser(allProjects, req.user);
 const isAdmin = req.user.role === 'admin';
 const canOpenTerminal = TERMINAL_ROLES.has(req.user.role);
 const canUpload = INBOX_WRITE_ROLES.has(req.user.role);
 // Cockpit-first: terminal-capable users land straight in the cockpit of the
 // project they last visited (see landingProject), with the project rail for
 // switching. `/` only renders as a page when there is no cockpit to go to:
 // empty registry (admin onboarding / no-grants message) or roles that cannot
 // open terminals. First-run nudges live on the landing + /settings, never at
 // the cost of reaching a working cockpit.
 if(canOpenTerminal && projects.length){
  const target = await landingProject(req, projects);
  return res.redirect(BASE + '/term/' + encodeURIComponent(target.name) + '/' + (req.query.manage === '1' ? '?manage=1' : ''));
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
    canUpload ? `<a class="lBtn primary" href="${BASE}/files/${encodeURIComponent(p.name)}/">Drop files</a>` : '',
    hasPreview(p) ? `<button class="lBtn" type="button" data-preview="${esc(p.name)}">Preview</button>` : ''
   ].join('');
   return `<article class="lCard lProj" style="--h:${projHue(p.name)};--i:${i}"><div class="lProjHead"><span class="pk-mono">${esc(projMonogram(p.name))}</span><h3>${esc(p.name)}</h3></div><code class="lPath">${esc(p.path)}</code><div class="lActs">${acts || '<span class="lNone">read-only access</span>'}</div></article>`;
  }).join('');
  content = `<div class="lGrid">${cards}</div>`;
 }
 const userChip = req.user.implicit
  ? `<span class="badge" title="PW_AUTH_ENFORCE is OFF; all requests treated as admin">anonymous · enforce off</span>`
  : `<span class="badge"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span><button id="logoutBtn" class="lBtn" type="button">Sign out</button>`;
 const adminCta = isAdmin ? `<a class="lBtn" href="${BASE}/settings">Settings</a>` : '';
 const adminModals = isAdmin ? wizardModalHtml + manageModalHtml : '';
 const adminScripts = isAdmin ? wizardScript + manageModalScript + `<script>document.getElementById('openWizardBtn')?.addEventListener('click',()=>document.getElementById('setupBackdrop')?.classList.remove('hidden'));document.getElementById('openManageBtn')?.addEventListener('click',()=>window.pwManage&&window.pwManage.open());</script>` : '';
 const firstRunScript = isAdmin
  ? `<script>(async()=>{try{const k='pw_firstrun_dismissed';if(sessionStorage.getItem(k))return;const r=await fetch('${BASE}/api/system/firstrun',{cache:'no-store'});const j=await r.json();if(j?.firstRunNeeded){document.getElementById('setupBackdrop')?.classList.remove('hidden');sessionStorage.setItem(k,'1')}}catch{}})();</script>`
  : '';
 const logoutScript = req.user.implicit ? '' : `<script>document.getElementById('logoutBtn')?.addEventListener('click',async()=>{try{await fetch('${BASE}/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'}})}catch{}location.href='${BASE}/login'});</script>`;
 const previewBits = !canOpenTerminal && projects.some(hasPreview) ? previewModalHtml + previewScript : '';
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Workbench</title><style>${designTokensCss}${landingCss}${statusBarCss}${modalBaseCss}${wizardCss}${previewCss}</style></head><body class="landing"><header class="lHero"><div class="lBrand"><span class="brandGlyph">&gt;_</span><div><h1>Project Workbench</h1><p>Terminal cockpits for every project, with Claude Code on tap.</p></div></div><div class="lActions">${userChip}${adminCta}</div></header><main class="lMain">${content}</main>${adminModals}${previewBits}${adminScripts}${firstRunScript}${logoutScript}${footer}</body></html>`);
});

app.get(BASE + '/manage', requireAdmin, async (req,res)=>{
 // The old server-rendered manage page is retired: project management now
 // lives in the cockpit's Manage modal. Deep-link by redirecting into the
 // last-visited (or first) project's cockpit with ?manage=1.
 const projects = filterProjectsForUser(await loadProjects(), req.user);
 if(projects.length === 0) return res.redirect(BASE + '/?manage=1');
 const target = await landingProject(req, projects);
 res.redirect(BASE + '/term/' + encodeURIComponent(target.name) + '/?manage=1');
});

app.post(BASE + '/manage/add', requireAdmin, async (req,res,next)=>{ try {
 const name = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim();
 if(!validName(name)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 let added = null;
 await withWorkspaceLock(async () => {
  const projects = await loadProjects();
  if(projects.some(p=>p.name===name)) throw new Error('A project named "'+name+'" already exists');
  const port = Number(req.body.port) || nextPort(projects);
  if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
  if(allUsedPorts(projects).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
  const p = repo ? { name, repo, path: workspacePath(name), port } : { name, path: workspacePath(name), port };
  if(req.body.adminOnly === 'yes') p.adminOnly = true;
  // Validated on the way in, so the registry never stores a URL the link menu
  // would have to refuse to render.
  const devUrl = safeHttpUrl(req.body.devUrl); if(devUrl) p.devUrl = devUrl;
  const prodUrl = safeHttpUrl(req.body.prodUrl); if(prodUrl) p.prodUrl = prodUrl;
  const primaryUser = String(req.body.primaryUser || '').trim();
  if(primaryUser) p.primaryUser = primaryUser;
  const users = await loadUsers();
  // Default the project's git identity to the adding admin when they have a token
  // and none was chosen, so the clone (and later pull/push) can authenticate.
  if(!p.primaryUser && users.find(u=>u.username===req.user?.username)?.ghToken) p.primaryUser = req.user.username;
  const credUser = p.primaryUser ? users.find(u=>u.username===p.primaryUser) : null;
  let cloneToken = null; try { if(credUser?.ghToken) cloneToken = decrypt(credUser.ghToken); } catch {}
  // The clone happens with NO registry lock held — it is network work with a
  // 300s timeout, and a token rotation must not queue behind it.
  await cloneWorkspace(p, cloneToken);
  // Short registry transaction, re-validated against fresh state.
  const published = await withProjectsLock(async () => {
   const fresh = await loadProjects();
   if(fresh.some(x=>x.name===name)) throw new Error('A project named "'+name+'" already exists');
   if(allUsedPorts(fresh).has(port)) throw new Error('Port '+port+' is already in use by another project (terminal or preview)');
   fresh.push(p); await saveProjects(fresh);
   return fresh;
  });
  await startThenRoute(p, published);
  added = p;
 });
 // Outside the projects lock on purpose: this is a SHORT ordered transition
 // (lifecycle > projects > credential) and must not be reached while the clone
 // above is still running, or every login waits behind the network.
 if(added?.primaryUser){ await syncProjectCredentials(added); }
 await applyDefaultProjectFlag(null, name, req.body.defaultProject);
 await audit('project_add', { project: name, port: Number(req.body.port) || null, repo }, req);
 if(wantsJson(req)) return res.json({ok:true,name});
 res.redirect(BASE + '/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.post(BASE + '/manage/update/:oldName', requireAdmin, async (req,res,next)=>{ try {
 const oldName = req.params.oldName; const newName = String(req.body.name || '').trim(); const repo = String(req.body.repo || '').trim(); const port = Number(req.body.port);
 const previewCmd = String(req.body.previewCmd || '').trim();
 const previewPortRaw = String(req.body.previewPort || '').trim();
 const previewEnvRaw = String(req.body.previewEnv || '');
 const primaryUser = String(req.body.primaryUser || '').trim();
 if(!validName(newName)) throw new Error('Invalid project name (letters, digits, dot, dash, underscore only)');
 if(!validPort(port)) throw new Error('Port must be between 1024 and 65535');
 let updated = null;
 await withWorkspaceLock(async () => {
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
 await stopProject(oldName); const oldPath = p.path; p.name = newName; if(repo) p.repo = repo; else delete p.repo; const devUrl = safeHttpUrl(req.body.devUrl); if(devUrl) p.devUrl = devUrl; else delete p.devUrl; const prodUrl = safeHttpUrl(req.body.prodUrl); if(prodUrl) p.prodUrl = prodUrl; else delete p.prodUrl; p.port = port; p.path = workspacePath(newName);
 if(req.body.adminOnly === 'yes') p.adminOnly = true; else delete p.adminOnly;
 if(primaryUser) p.primaryUser = primaryUser; else delete p.primaryUser;
 if(previewBlock) p.preview = previewBlock; else delete p.preview;
 if(tabs.length) p.tabs = tabs; else delete p.tabs;
 if(oldPath !== p.path){ try { await fs.rename(oldPath,p.path); } catch { /* absent workspace is okay */ } }
 // Short registry transaction only; the stop/rename/start around it are long.
 await withProjectsLock(async () => { await saveProjects(projects); });
 await startThenRoute(p, projects);
 updated = p;
 });
 // Same reason as /manage/add: the credential transition is short and ordered,
 // and is taken after the long project work has released its lock.
 if(updated){ await syncProjectCredentials(updated); }
 await applyDefaultProjectFlag(oldName, newName, req.body.defaultProject);
 await audit('project_update', { oldName, newName, port }, req);
 if(wantsJson(req)) return res.json({ok:true,name:newName});
 res.redirect(BASE + '/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.post(BASE + '/manage/delete/:name', requireAdmin, async (req,res,next)=>{ try {
 if(req.body.confirm !== 'yes') throw new Error('Delete confirmation required'); const name = req.params.name;
 await withWorkspaceLock(async () => {
  const projects = await loadProjects(); const idx = projects.findIndex(p=>p.name===name); if(idx<0) throw new Error('Project not found'); const [p] = projects.splice(idx,1);
  await stopProject(name); await removeWorkspace(p);
  await withProjectsLock(async () => { await saveProjects(projects); });
  await applyRouting(projects);
 });
 await applyDefaultProjectFlag(name, name, '');
 await audit('project_delete', { project: name }, req);
 if(wantsJson(req)) return res.json({ok:true});
 res.redirect(BASE + '/manage');
 } catch(e){ if(wantsJson(req)) return res.status(400).json({ok:false,error:e.message||String(e)}); next(e); }});

app.get(BASE + '/api/projects/status', requireAuth, async (req,res)=>{ try {
 const all = await loadProjects();
 const projects = filterProjectsForUser(all, req.user);
 const out = await Promise.all(projects.map(async p => {
  const [pend, sig] = await Promise.all([readPending(p), projectSignals(p)]);
  // Latch: the live tmux bell is one-shot — ANY attach (stray old tab, test
  // visit, automation selecting windows) clears it. So the moment a poll
  // observes it, persist the done state as the pending marker; it then
  // survives everything and clears only when the user actually views the
  // project (cockpit GET / explicit terminal selection → clearPending).
  // …but never latch while a client is attached: the viewer's live flag
  // governs then, and re-latching would outlive their genuine view of the
  // finished tab. Leaving without viewing it re-latches on the next
  // detached poll (the background-window flag survives detach).
  if(sig.bell && !sig.attached && !pend.pending && Date.now() - (recentlyViewed.get(p.name) || 0) > 12000){
   await fs.writeFile(pendingMarkerPath(p), new Date().toISOString()+'\n').catch(()=>{});
   pend.pending = true; pend.since = new Date().toISOString();
  }
  return { name: p.name, ...pend, bell: sig.bell, working: sig.working, pending: pend.pending || sig.bell, credentialsStale: await credentialsStale(p) };
 }));
 res.json({ ok:true, projects: out });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/projects/reorder', requireAdmin, async (req,res)=>{ try {
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


app.post(BASE + '/api/internal/pvikpbot/handoff', async (req,res)=>{ try {
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

app.get(BASE + '/api/projects/config', requireAdmin, async (_req,res)=>{ try {
 const [projects, users, settings] = await Promise.all([loadProjects(), loadUsers(), loadWorkbenchSettings()]);
 res.json({ ok:true, defaultProject: settings.defaultProject || '',
  projects: projects.map(p => ({ name:p.name, repo:p.repo||'', devUrl:p.devUrl||'', prodUrl:p.prodUrl||'', port:p.port, path:p.path, adminOnly: !!p.adminOnly, primaryUser:p.primaryUser||'',
   preview: p.preview ? { cmd:p.preview.cmd||'', port:p.preview.port||'', env:p.preview.env||{} } : null,
   tabs: Array.isArray(p.tabs) ? p.tabs : [] })),
  users: users.map(u => ({ username:u.username, hasToken: !!u.ghToken })),
  suggestedPort: nextPort(projects), suggestedPreviewPort: nextPreviewPort(projects) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get(BASE + '/api/term/:project/windows', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 res.json({ok:true,windows});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/term/:project/windows', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await newTmuxWindow(p, req.body?.name || 'new task', req.body?.cmd || '');
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/term/:project/windows/:index/select', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await tmux(['select-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 await clearPending(p);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/term/:project/windows/:index/rename', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const name = String(req.body?.name || '').replace(/[\r\n\t]/g,' ').trim().slice(0,80);
 if(!name) return res.status(400).json({ok:false,error:'Window name required'});
 await tmux(['rename-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`,name]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete(BASE + '/api/term/:project/windows/:index', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 const windows = await listTmuxWindows(p.name);
 if(windows.length <= 1) return res.status(400).json({ok:false,error:'Cannot close the last session'});
 await tmux(['kill-window','-t',`${tmuxSession(p.name)}:${Number(req.params.index)}`]);
 res.json({ok:true,windows:await listTmuxWindows(p.name)});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

// Explicit credential reconciliation. Panes inherit their environment at
// creation, so a session started before PW_PER_USER_CLAUDE was enabled (or
// before a project changed hands) keeps the old credentials until it is
// recreated. That recreation is destructive — it discards every window's running
// process — so it is never done implicitly: /api/projects/status reports
// credentialsStale and an operator calls this.
app.post(BASE + '/api/term/:project/recycle', requireTerminalAccess, async (req,res)=>{ try {
 const p = await requireProject(req,res); if(!p) return;
 await audit('session_recycle', { project: p.name, reason: 'credential reconciliation' }, req);
 await tmux(['kill-session','-t',tmuxSession(p.name)]).catch(()=>{});
 await ensureTmuxSession(p);
 res.json({ ok:true, credentialsStale: await credentialsStale(p), windows: await listTmuxWindows(p.name) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get(BASE + '/term/:project/', requireTerminalAccess, async (req,res)=>{ await audit('terminal_open', { project: req.params.project }, req);
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project'); const projectJson = JSON.stringify(p.name).replace(/</g,'\\u003c');
 const railProjects = filterProjectsForUser(await loadProjects(), req.user);
 res.append('Set-Cookie', `pw_last=${encodeURIComponent(p.name)}; Path=/; Max-Age=31536000; SameSite=Lax`);
 void rememberLastProject(req.user?.username, p.name);   // deliberately not awaited
 const adminManage = req.user.role === 'admin' ? (manageModalHtml + manageModalScript) : '';
 const tabPresetsJson = JSON.stringify(Array.isArray(p.tabs) ? p.tabs : []).replace(/</g,'\\u003c');
 const _ws = await loadWorkbenchSettings();
 const cliTabsJson = JSON.stringify((_ws.enabledClis||[]).filter(k=>k in SUPPORTED_CLIS).map(k=>({label:SUPPORTED_CLIS[k].label,bin:SUPPORTED_CLIS[k].bin}))).replace(/</g,'\\u003c');
 await clearPending(p);
 let deployConfigured = false;
 if(DEPLOY_CENTRE){
  const dCfg = await loadDeployConfig();
  deployConfigured = hasDeployConfigFor(p.name, dCfg);
 }
 // No client-side "do we have a saved password?" hint: both deploy surfaces now
 // request first and let the server answer needPassword, so a hint could only
 // disagree with it.
 const deployBits = DEPLOY_CENTRE && deployConfigured ? `${deployModalHtml}${deployModalScript}` : '';
 const [claudeVersion, updateStamp] = await Promise.all([getClaudeVersion(), getClaudeUpdateStamp()]);
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Workbench</title><style>${designTokensCss}${DEPLOY_CENTRE && deployConfigured ? deployCss : ''}${cockpitCss}${statusBarCss}${modalBaseCss}${previewCss}</style></head><body class="pw-cockpit"><div id="shell"><main id="stage"><div id="topBar"><div class="projChipWrap"><button type="button" class="projChip" id="projChipBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="projLinksMenu" title="${esc(p.name)} — project links"><span class="pcMono" style="--h:${projHue(p.name)}">${esc(projMonogram(p.name))}</span><span class="pcName">${esc(p.name)}</span><span class="pcCaret" aria-hidden="true">▾</span></button>${projectLinksMenu(p)}</div><div id="tabScroller" class="tabScroller"><button id="tabArrowL" class="tabArrow" type="button" aria-label="Scroll tabs left" tabindex="-1">‹</button><div id="tabStrip" class="tabStrip"></div><button id="tabArrowR" class="tabArrow" type="button" aria-label="Scroll tabs right" tabindex="-1">›</button></div><div class="tbActions"><button class="previewBtn" type="button" data-preview="${esc(p.name)}" title="Open live preview window"><span class="pbDot"></span>Preview</button><button id="fileBtn" type="button" title="Files — paste or drop into project"><span class="fileInfo">Files</span></button><button id="railBtn" class="railBtn" type="button" aria-label="Toggle project rail">☰</button></div></div><div id="tray"><div id="trayTabs" role="tablist" aria-label="Project files"><button id="trayTabInbox" class="trayTab" role="tab" aria-selected="true" aria-controls="trayInboxPanel" type="button">Inbox<span id="trayInboxCount" class="trayCount" hidden></span></button><button id="trayTabOutbox" class="trayTab" role="tab" aria-selected="false" aria-controls="trayOutboxPanel" tabindex="-1" type="button">Outbox<span id="trayOutboxCount" class="trayCount" hidden></span></button></div><div id="trayInboxPanel" class="trayPanel" role="tabpanel" aria-labelledby="trayTabInbox"><div id="drop" tabindex="0"><div>Paste/drop/select files here</div><div class="dropHint">PDF, txt, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status">Saved files go to <code>${esc(p.path)}/_inbox</code>. The path will be inserted into the terminal.</div><div id="preview"></div><div id="inboxHeader" class="inboxHeader"></div><div id="inboxList" class="inboxList"></div></div><div id="trayOutboxPanel" class="trayPanel" role="tabpanel" aria-labelledby="trayTabOutbox" hidden><div id="outboxHeader" class="inboxHeader"></div><div id="outboxList" class="inboxList"></div><div id="outboxStatus"></div></div><button class="close" id="close">Close</button></div><div id="trayShield" aria-hidden="true"></div><iframe id="term" allow="clipboard-write; clipboard-read" src="${BASE}/pty/${encodeURIComponent(p.name)}/"></iframe></main>${railHtml(railProjects, p.name, req.user, deployConfigured)}</div><script>const project=${projectJson};const tabPresets=${tabPresetsJson};let pwAuthRedirecting=false;window.pwAuthLost=function(){if(pwAuthRedirecting)return true;pwAuthRedirecting=true;location.href='${BASE}/login?next='+encodeURIComponent(location.pathname);return true};const cliTabs=${cliTabsJson};const tray=document.getElementById('tray'),drop=document.getElementById('drop'),file=document.getElementById('file'),status=document.getElementById('status'),preview=document.getElementById('preview'),inboxHeader=document.getElementById('inboxHeader'),inboxList=document.getElementById('inboxList'),frame=document.getElementById('term');let previewTimer=null;function pwRefitTerm(){try{var h=Math.round(frame.getBoundingClientRect().height);if(h<8)return;frame.style.maxHeight=(h-1)+'px';frame.getBoundingClientRect();requestAnimationFrame(function(){frame.style.maxHeight=''})}catch(e){}}frame.addEventListener('load',function(){setTimeout(pwRefitTerm,200);setTimeout(pwRefitTerm,700);setTimeout(pwRefitTerm,1500)});window.addEventListener('resize',function(){setTimeout(pwRefitTerm,80)});const hoverPanel=Object.assign(document.createElement('div'),{id:'pwHoverPreview'});document.body.appendChild(hoverPanel);function setStatus(t,bad=false){status.textContent=t;status.style.color=bad?'#fca5a5':'#bbf7d0'}function clearPreview(){preview.innerHTML='';document.body.classList.remove('has-preview');setStatus('');if(previewTimer){clearTimeout(previewTimer);previewTimer=null}}function showPreview(url,name,isImage){if(!url&&!name)return clearPreview();if(previewTimer){clearTimeout(previewTimer);previewTimer=null}document.body.classList.add('has-preview');const safeName=escHtml(name||'file');if(isImage&&url){preview.innerHTML='<div class="previewItem"><a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+safeName+'"></a><button class="previewClear" type="button" title="Clear preview">×</button></div>'}else{preview.innerHTML='<div class="previewItem"><div style="padding:18px;border:1px solid #334155;border-radius:8px;color:#cbd5e1;text-align:center;display:flex;align-items:center;justify-content:center;min-height:130px;word-break:break-all;background:#111827">'+safeName+'</div><button class="previewClear" type="button" title="Clear preview">×</button></div>'}preview.querySelector('.previewClear').onclick=clearPreview;previewTimer=setTimeout(closeTray,15000)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}function escHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function refreshInbox(){try{const r=await fetch('${BASE}/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const out=await r.json();if(!out?.ok){inboxHeader.innerHTML='';inboxList.innerHTML='';return}const files=out.files||[];setTrayCount(trayInboxCount,files.length);if(files.length===0){inboxHeader.innerHTML='<span>No saved files yet.</span>';inboxList.innerHTML='';return}inboxHeader.innerHTML='<span>'+files.length+' saved file'+(files.length===1?'':'s')+' — click a row to insert its path</span><button class="clear" type="button">Clear all</button>';inboxHeader.querySelector('.clear').onclick=async()=>{if(!confirm('Delete all '+files.length+' files in this project\\'s inbox?'))return;await fetch('${BASE}/api/inbox/'+encodeURIComponent(project),{method:'DELETE'});refreshInbox()};inboxList.innerHTML='';for(const f of files){const row=document.createElement('div');row.className='row';row.title='Click to insert path: '+f.path;const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);row.innerHTML='<div class="thumb">'+(isImg?'<img src="'+f.url+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+escHtml(f.name)+'</div><div class="meta">'+fmtSize(f.size)+'</div></div><button class="del" type="button" title="Delete">×</button>';row.onclick=ev=>{if(ev.target.closest('.del'))return;if(insertPath(f.path)){setStatus('Inserted:\\n'+f.path)}else{setStatus('Could not insert (no terminal focus)',true)}};row.onmouseenter=()=>{hoverPanel.innerHTML=isImg?'<img src="'+f.url+'">':'<div class="card">'+escHtml(f.name)+'<div class="meta">'+fmtSize(f.size)+'</div></div>';hoverPanel.style.display='block';const rct=row.getBoundingClientRect(),pw=hoverPanel.offsetWidth,ph=hoverPanel.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;let lf=rct.right+10;if(lf+pw>vw-8)lf=Math.max(8,rct.left-pw-10);let tp=rct.top-4;if(tp+ph>vh-8)tp=Math.max(8,vh-ph-8);if(tp<8)tp=8;hoverPanel.style.left=lf+'px';hoverPanel.style.top=tp+'px'};row.onmouseleave=()=>{hoverPanel.style.display='none'};row.querySelector('.del').onclick=async ev=>{ev.stopPropagation();hoverPanel.style.display='none';await fetch('${BASE}/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(f.name),{method:'DELETE'});refreshInbox()};inboxList.appendChild(row)}}catch{}}const trayTabInbox=document.getElementById('trayTabInbox'),trayTabOutbox=document.getElementById('trayTabOutbox'),trayInboxPanel=document.getElementById('trayInboxPanel'),trayOutboxPanel=document.getElementById('trayOutboxPanel'),trayInboxCount=document.getElementById('trayInboxCount'),trayOutboxCount=document.getElementById('trayOutboxCount'),outboxHeader=document.getElementById('outboxHeader'),outboxList=document.getElementById('outboxList'),outboxStatus=document.getElementById('outboxStatus');function setTrayCount(el,n){el.textContent=String(n);el.hidden=!n}function setOutboxStatus(t,bad=false){outboxStatus.textContent=t||'';outboxStatus.style.color=bad?'#fca5a5':'#bbf7d0'}function selectTrayTab(which){const inbox=which==='inbox';trayTabInbox.setAttribute('aria-selected',inbox?'true':'false');trayTabOutbox.setAttribute('aria-selected',inbox?'false':'true');trayTabInbox.tabIndex=inbox?0:-1;trayTabOutbox.tabIndex=inbox?-1:0;trayInboxPanel.hidden=!inbox;trayOutboxPanel.hidden=inbox;tray.classList.toggle('tray-outbox',!inbox);if(inbox)refreshInbox();else refreshOutbox()}trayTabInbox.addEventListener('click',()=>selectTrayTab('inbox'));trayTabOutbox.addEventListener('click',()=>selectTrayTab('outbox'));document.getElementById('trayTabs').addEventListener('keydown',e=>{const k=e.key;let which=null;if(k==='Home')which='inbox';else if(k==='End')which='outbox';else if(k==='ArrowLeft'||k==='ArrowRight')which=trayOutboxPanel.hidden?'outbox':'inbox';else return;e.preventDefault();selectTrayTab(which);(which==='inbox'?trayTabInbox:trayTabOutbox).focus()});async function refreshOutbox(){try{if(!outboxList.childElementCount)outboxList.innerHTML='<div class="trayEmpty">Loading…</div>';const r=await fetch('${BASE}/api/outbox/'+encodeURIComponent(project),{cache:'no-store'});if(r.status===401)return void window.pwAuthLost();const out=await r.json().catch(()=>null);if(!out||!out.ok){outboxHeader.innerHTML='';outboxList.innerHTML='<div class="trayEmpty">'+escHtml((out&&out.error)||('Could not load outbox (HTTP '+r.status+')'))+'</div>';return}const files=out.files||[];setTrayCount(trayOutboxCount,files.length);if(files.length===0){outboxHeader.innerHTML='<span>No files from the agent yet — anything it saves to _outbox appears here.</span>';outboxList.innerHTML='';return}outboxHeader.innerHTML='<span>'+files.length+' file'+(files.length===1?'':'s')+' from the agent — download or clean up</span><button class="clear" type="button">Clear all</button>';outboxHeader.querySelector('.clear').onclick=async()=>{if(!confirm('Delete all '+files.length+' files in this project\\'s outbox?'))return;const rr=await fetch('${BASE}/api/outbox/'+encodeURIComponent(project),{method:'DELETE'});const jj=await rr.json().catch(()=>null);setOutboxStatus(jj&&jj.ok?'Outbox cleared.':'Error: '+((jj&&jj.error)||('HTTP '+rr.status)),!(jj&&jj.ok));refreshOutbox()};outboxList.innerHTML='';for(const f of files){const row=document.createElement('div');row.className='row';const when=f.mtime?new Date(f.mtime).toLocaleString():'';row.innerHTML='<div class="thumb"><span>FILE</span></div><div class="nameCol"><div class="name">'+escHtml(f.name)+'</div><div class="meta">'+fmtSize(f.size)+(when?' · '+escHtml(when):'')+'</div></div><a class="dl" href="'+escHtml(f.url)+'" download>Download</a><button class="del" type="button" title="Delete">×</button>';row.querySelector('.del').onclick=async ev=>{ev.stopPropagation();if(!confirm('Delete "'+f.name+'" from the outbox?'))return;const rr=await fetch('${BASE}/api/outbox/'+encodeURIComponent(project)+'/file/'+encodeURIComponent(f.name),{method:'DELETE'});const jj=await rr.json().catch(()=>null);setOutboxStatus(jj&&jj.ok?'Deleted '+f.name:'Error: '+((jj&&jj.error)||('HTTP '+rr.status)),!(jj&&jj.ok));refreshOutbox()};outboxList.appendChild(row)}}catch(e){outboxHeader.innerHTML='';outboxList.innerHTML='<div class="trayEmpty">'+escHtml(e.message||String(e))+'</div>'}}function openTray(msg){document.body.classList.add('shade-open');setTimeout(()=>{if(trayOutboxPanel.hidden)drop.focus();else trayTabOutbox.focus()},50);if(msg)setStatus(msg);refreshInbox();refreshOutbox()}function closeTray(){document.body.classList.remove('shade-open');clearPreview();focusTerminal()}function focusTerminal(){try{const ta=frame.contentDocument?.querySelector('textarea.xterm-helper-textarea');if(ta){ta.focus();return}}catch{}try{frame.contentWindow?.focus()}catch{}}function toggleTray(){document.body.classList.contains('shade-open')?closeTray():openTray()}document.getElementById('fileBtn').onclick=toggleTray;document.getElementById('close').onclick=closeTray;document.getElementById('trayShield').onclick=closeTray;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('shade-open'))closeTray()});function insertPath(path){try{if(frame.contentWindow.__pwSendToTerminal?.(path))return true}catch{}try{const ta=frame.contentDocument.querySelector('textarea.xterm-helper-textarea')||frame.contentDocument.querySelector('textarea');if(!ta)return false;ta.focus();const dt=new DataTransfer();dt.setData('text/plain',path);ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true}catch{return false}}function uploadStream(blob,name){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST','${BASE}/api/upload-stream/'+encodeURIComponent(project)+'?filename='+encodeURIComponent(name||'upload.bin'));x.setRequestHeader('Content-Type','application/octet-stream');x.upload.onprogress=e=>{if(e.lengthComputable)setStatus('Uploading '+(name||'file')+'… '+Math.round(e.loaded/e.total*100)+'% ('+fmtSize(e.loaded)+' / '+fmtSize(e.total)+')')};x.onerror=()=>reject(new Error('Network error during upload'));x.onabort=()=>reject(new Error('Upload cancelled'));x.onload=()=>{let j=null;try{j=JSON.parse(x.responseText)}catch{}if(x.status>=200&&x.status<300&&j&&j.ok)resolve(j);else reject(new Error((j&&j.error)||('Upload failed (HTTP '+x.status+')')))};x.send(blob)})}async function upload(blob,name='clipboard-file'){if(!blob)return setStatus('No file received.',true);selectTrayTab('inbox');let out;if(blob.size>8*1024*1024){out=await uploadStream(blob,name)}else{setStatus('Saving file...');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const res=await fetch('${BASE}/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name,mime:blob.type||'application/octet-stream',data})});out=await res.json().catch(()=>null);if(!res.ok||!out?.ok)throw new Error(out?.error||'Upload failed')}const ok=insertPath(out.path);try{await navigator.clipboard.writeText(out.path)}catch{}showPreview(out.url,name||'file',(blob.type||'').startsWith('image/'));setStatus('Saved and '+(ok?'inserted':'copied')+':\\n'+out.path);refreshInbox()}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name).catch(e=>setStatus(e.message||String(e),true));drop.addEventListener('dragover',e=>{e.preventDefault();drop.style.borderColor='#60a5fa'});drop.addEventListener('dragleave',()=>drop.style.borderColor='#64748b');/* drop handler removed — the window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads because e.preventDefault() stops the browser default but not other listeners. */window.addEventListener('paste',e=>{const items=[...(e.clipboardData?.items||[])];const item=items.find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();openTray('Saving pasted file...');upload(f,f?.name||'clipboard-file').catch(err=>setStatus(err.message||String(err),true))},true);let dragDepth=0;window.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();dragDepth++;openTray('Drop files here to save them into _inbox.')}},true);window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.style.borderColor='#60a5fa'}},true);window.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)drop.style.borderColor='#64748b'}},true);window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();dragDepth=0;drop.style.borderColor='#64748b';openTray();upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name).catch(err=>setStatus(err.message||String(err),true))}},true);window.addEventListener('message',e=>{const d=e.data;if(!d||typeof d!=='object')return;if(d.type==='pw-open-image-tray'){openTray(d.message||'Paste the file here.')}else if(d.type==='pw-paste-saved'){openTray();const base=(d.path||'').split('/').pop()||'file';showPreview(d.url,base,/\\.(png|jpe?g|webp|gif|bmp)$/i.test(base));setStatus('Saved and inserted:\\n'+d.path);refreshInbox()}else if(d.type==='pw-paste-error'){openTray();setStatus('Paste failed: '+d.error,true)}});const TAB_DEBUG=/[?&]tabdebug\b/.test(location.search)||localStorage.getItem('pwTabDebug')==='1';console.info('[pw-tabs] tab-attention diagnostics: window.__pwTabs = latest tmux window state; set localStorage.pwTabDebug=1 (or add ?tabdebug) then reload to trace bell flags every poll.'+(TAB_DEBUG?' [tracing ON]':''));const tabStrip=document.getElementById('tabStrip');const tabScroller=document.getElementById('tabScroller');const tabArrowL=document.getElementById('tabArrowL');const tabArrowR=document.getElementById('tabArrowR');function updateTabArrows(){const of=tabStrip.scrollWidth-tabStrip.clientWidth>1;tabScroller.classList.toggle('overflow',of);if(of){const mx=tabStrip.scrollWidth-tabStrip.clientWidth;tabArrowL.disabled=tabStrip.scrollLeft<=1;tabArrowR.disabled=tabStrip.scrollLeft>=mx-1}}function scrollTabs(dir){tabStrip.scrollBy({left:dir*Math.max(120,Math.round(tabStrip.clientWidth*0.6)),behavior:'smooth'})}tabArrowL.onclick=()=>scrollTabs(-1);tabArrowR.onclick=()=>scrollTabs(1);tabStrip.addEventListener('scroll',updateTabArrows,{passive:true});window.addEventListener('resize',updateTabArrows);const tabsBase='${BASE}/api/term/'+encodeURIComponent(project)+'/windows';let lastTabsKey='';let editingIdx=null;let editAfterRender=false;function startEdit(label,w){editingIdx=w.index;const original=label.textContent;label.contentEditable='true';label.classList.add('editing');label.focus();const sel=window.getSelection();const range=document.createRange();range.selectNodeContents(label);sel.removeAllRanges();sel.addRange(range);let done=false;const finish=async save=>{if(done)return;done=true;label.contentEditable='false';label.classList.remove('editing');label.removeEventListener('keydown',onKey);label.removeEventListener('blur',onBlur);const next=label.textContent.trim();editingIdx=null;if(save&&next&&next!==w.name){try{await fetch(tabsBase+'/'+w.index+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:next})})}catch{}lastTabsKey='';refreshTabs()}else if(!save){label.textContent=original}};const onKey=ev=>{if(ev.key==='Enter'){ev.preventDefault();finish(true)}else if(ev.key==='Escape'){ev.preventDefault();finish(false)}};const onBlur=()=>finish(true);label.addEventListener('keydown',onKey);label.addEventListener('blur',onBlur)}function closeTabMenu(){document.querySelector('.tabMenu')?.remove();document.removeEventListener('click',closeTabMenu,true);document.removeEventListener('keydown',tabMenuKey,true)}function tabMenuKey(e){if(e.key==='Escape')closeTabMenu()}${uniqueTabNameClientSrc}async function spawnTab(name,cmd){editAfterRender=!name;await fetch(tabsBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name||'new task',cmd:cmd||''})});lastTabsKey='';refreshTabs()}function openTabMenu(anchor,windows){closeTabMenu();const menu=document.createElement('div');menu.className='tabMenu';menu.addEventListener('click',e=>e.stopPropagation());const existing=new Set((windows||[]).map(w=>w.name));const usable=(tabPresets||[]).filter(t=>t&&t.name&&!existing.has(t.name));for(const t of usable){const item=document.createElement('button');item.type='button';item.className='tabMenuItem';item.innerHTML='<span class="ti-name">'+escHtml(t.name)+'</span>'+(t.cmd?'<span class="ti-cmd">'+escHtml(t.cmd)+'</span>':'');item.onclick=()=>{spawnTab(t.name,t.cmd||'');closeTabMenu()};menu.appendChild(item)}const cliUsable=(cliTabs||[]);const hasAbove=(tabPresets||[]).length>0;for(let i=0;i<cliUsable.length;i++){const c=cliUsable[i];const item=document.createElement('button');item.type='button';item.className='tabMenuItem'+(i===0&&hasAbove?' blank':'');item.innerHTML='<span class="ti-name">'+escHtml(c.label)+'</span><span class="ti-cmd">'+escHtml(c.bin)+'</span>';item.onclick=()=>{spawnTab(uniqueTabName(c.label,existing),c.bin);closeTabMenu()};menu.appendChild(item)}const blank=document.createElement('button');blank.type='button';blank.className='tabMenuItem blank';blank.innerHTML='<span class="ti-name">+ Blank tab</span><span class="ti-cmd">plain bash, name it after creation</span>';blank.onclick=()=>{spawnTab('','');closeTabMenu()};menu.appendChild(blank);document.body.appendChild(menu);const r=anchor.getBoundingClientRect();const mw=menu.offsetWidth||220;let lf=r.left;if(lf+mw>window.innerWidth-8)lf=Math.max(8,window.innerWidth-mw-8);menu.style.left=lf+'px';menu.style.top=(r.bottom+4)+'px';setTimeout(()=>{document.addEventListener('click',closeTabMenu,true);document.addEventListener('keydown',tabMenuKey,true)},0)}async function refreshTabs(){if(editingIdx!=null)return;try{const r=await fetch(tabsBase,{cache:'no-store'});if(r.status===401)return void window.pwAuthLost();const out=await r.json();if(!out?.ok){tabStrip.innerHTML='';lastTabsKey='';return}window.__pwTabs=out.windows;if(TAB_DEBUG)console.debug('[pw-tabs]',new Date().toLocaleTimeString(),(out.windows||[]).map(w=>'#'+w.index+' '+(w.name||'')+' active='+(w.active?1:0)+' bell='+(w.bell?1:0)).join('  |  '));const key=JSON.stringify(out.windows);if(key===lastTabsKey)return;lastTabsKey=key;renderTabs(out.windows)}catch{}}function renderTabs(windows){tabStrip.innerHTML='';for(const w of windows){const tab=document.createElement('div');const needsAttention=w.bell&&!w.active;if(needsAttention&&TAB_DEBUG)console.log('[pw-tabs] ATTENTION \u2192 #'+w.index+' '+(w.name||''));tab.className='tab'+(w.active?' active':'')+(needsAttention?' attention':'');tab.title=w.active?'Click name to rename':(needsAttention?'Finished — click to view':'Window '+w.index+': '+(w.name||''));if(w.working){const lv=document.createElement('span');lv.className='live';lv.title='Working…';tab.appendChild(lv)}const label=document.createElement('span');label.className='name';label.textContent=w.name||('#'+w.index);label.onclick=ev=>{if(!w.active)return;ev.stopPropagation();startEdit(label,w)};tab.appendChild(label);if(windows.length>1){const x=document.createElement('span');x.className='x';x.textContent='×';x.title='Close window';x.onclick=async ev=>{ev.stopPropagation();if(!confirm('Close window "'+(w.name||w.index)+'"? Any running process in it will be killed.'))return;await fetch(tabsBase+'/'+w.index,{method:'DELETE'});lastTabsKey='';refreshTabs()};tab.appendChild(x)}tab.onclick=async()=>{await fetch(tabsBase+'/'+w.index+'/select',{method:'POST'});lastTabsKey='';refreshTabs()};tabStrip.appendChild(tab)}const plus=document.createElement('button');plus.className='newTab';plus.textContent='+';plus.title='New tab';plus.onclick=ev=>{ev.stopPropagation();openTabMenu(plus,windows)};tabStrip.appendChild(plus);const _act=tabStrip.querySelector('.tab.active');if(_act)try{_act.scrollIntoView({inline:'nearest',block:'nearest'})}catch{}requestAnimationFrame(updateTabArrows);if(editAfterRender){editAfterRender=false;const ai=windows.find(w=>w.active);if(ai){const tabs=tabStrip.querySelectorAll('.tab');const i=windows.indexOf(ai);const lbl=tabs[i]?.querySelector('.name');if(lbl)startEdit(lbl,ai)}}}refreshTabs();setInterval(()=>{if(!document.hidden)refreshTabs()},2000);</script>${projLinksScript}${railScript}${adminManage}${previewModalHtml}${previewScript}${deployBits}${footer}</body></html>`);
});

// Lightweight /files/<name>/ page: drop tray + inbox list, no terminal iframe.
// Lets content_editor (and other inbox-write roles) drop files into a project's
// _inbox without granting raw shell. Hand-off path for the planned PVIKPBot
// content workflow.
app.get(BASE + '/files/:project/', requireInboxWrite, async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project');
 const claudeVersion = await getClaudeVersion();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 const projectJson = JSON.stringify(p.name).replace(/</g,'\\u003c');
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)} — Files</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;background:#0f172a;color:#e5e7eb}.f-header{display:flex;align-items:center;gap:1rem;padding:.95rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.f-header h1{margin:0;font-size:1.15rem}.f-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.f-header .back:hover{background:#1e293b;color:#fff}.f-header .grow{flex:1}.f-header .who{font-size:.85rem;color:#cbd5e1}.f-main{max-width:920px;margin:1.5rem auto;padding:0 1.5rem 3rem}.f-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.f-card h2{margin:0 0 .25rem;font-size:1.1rem;color:#bfdbfe}.f-card .muted{color:#94a3b8;font-size:.85rem;margin:.15rem 0 0}#drop{border:2px dashed #64748b;border-radius:14px;padding:42px 18px;text-align:center;background:#0b1220;cursor:pointer;color:#cbd5e1;font-size:.95rem;margin-top:.75rem}#drop:hover{background:#152033;border-color:#94a3b8}#drop.over{border-color:#60a5fa;background:#152033}#drop .hint{color:#94a3b8;font-size:.82rem;margin-top:.4rem}#status{margin-top:.65rem;font-size:.85rem;color:#bbf7d0;white-space:pre-wrap;min-height:1.3em}#status.err{color:#fca5a5}.ilist{display:flex;flex-direction:column;gap:.35rem;margin-top:.5rem}.irow{display:flex;align-items:center;gap:.65rem;padding:.5rem .65rem;background:#0b1220;border:1px solid #1f2937;border-radius:8px}.irow .thumb{width:36px;height:36px;background:#1f2937;border-radius:4px;flex:0 0 36px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:11px;font-weight:600;overflow:hidden}.irow .thumb img{width:100%;height:100%;object-fit:cover}.irow .nameCol{flex:1 1 auto;min-width:0;overflow:hidden}.irow .nameCol .name{color:#e5e7eb;font-size:.88rem;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.irow .nameCol .meta{color:#94a3b8;font-size:.75rem}.irow .copyBtn,.irow .del,.irow a{background:transparent;border:1px solid #334155;color:#cbd5e1;border-radius:6px;padding:3px 9px;font-size:.78rem;cursor:pointer;text-decoration:none}.irow .copyBtn:hover,.irow a:hover{background:#1e293b;color:#fff}.irow .del{color:#fca5a5;border-color:#7f1d1d}.irow .del:hover{background:#7f1d1d;color:#fff}.empty{color:#94a3b8;font-style:italic;font-size:.85rem;padding:.75rem 0}${statusBarCss}</style></head><body><header class="f-header"><a class="back" href="${BASE}/">← Dashboard</a><h1>Files — ${esc(p.name)}</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><main class="f-main"><div class="f-card"><h2>Drop or paste files</h2><p class="muted">Saved files go to <code>${esc(p.path)}/_inbox</code>. Click <b>Copy path</b> to grab the absolute path and hand it to whatever consumes the inbox (Claude conversation, PVIKPBot, etc.).</p><div id="drop" tabindex="0">Drop files here, paste from clipboard, or click to pick<div class="hint">PDF, text, images, docs, etc.</div><input id="file" type="file" style="display:none"></div><div id="status"></div></div><div class="f-card"><h2>Inbox</h2><div class="ilist" id="ilist"><div class="empty">Loading…</div></div></div><div class="f-card"><h2>Outbox <span class="muted" style="font-weight:400">— files the agent left for you</span></h2><div class="ilist" id="olist"><div class="empty">Loading…</div></div></div></main>${footer}<script>const project=${projectJson};const drop=document.getElementById('drop');const file=document.getElementById('file');const status=document.getElementById('status');const ilist=document.getElementById('ilist');const olist=document.getElementById('olist');function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatus(t,err){status.textContent=t||'';status.classList.toggle('err',!!err)}function fmtSize(b){if(b<1024)return b+' B';if(b<1024*1024)return Math.round(b/1024)+' KB';return (b/1024/1024).toFixed(1)+' MB'}async function refreshInbox(){try{const r=await fetch('${BASE}/api/inbox/'+encodeURIComponent(project),{cache:'no-store'});const j=await r.json();if(!j.ok){ilist.innerHTML='<div class="empty">'+esc(j.error||'failed')+'</div>';return}const files=j.files||[];if(!files.length){ilist.innerHTML='<div class="empty">No saved files yet.</div>';return}ilist.innerHTML=files.map(f=>{const isImg=/\\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);return '<div class="irow" data-n="'+esc(f.name)+'" data-p="'+esc(f.path)+'"><div class="thumb">'+(isImg?'<img src="'+esc(f.url)+'">':'<span>FILE</span>')+'</div><div class="nameCol"><div class="name">'+esc(f.name)+'</div><div class="meta">'+fmtSize(f.size)+' · '+esc(f.mtime||'')+'</div></div><a href="'+esc(f.url)+'" target="_blank" rel="noopener">Open</a><button class="copyBtn" type="button">Copy path</button><button class="del" type="button">Delete</button></div>'}).join('')}catch(e){ilist.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}ilist.addEventListener('click',async e=>{const row=e.target.closest('.irow');if(!row)return;if(e.target.classList.contains('del')){if(!confirm('Delete "'+row.dataset.n+'"?'))return;const r=await fetch('${BASE}/api/inbox/'+encodeURIComponent(project)+'/'+encodeURIComponent(row.dataset.n),{method:'DELETE'});const j=await r.json();setStatus(j.ok?'Deleted '+row.dataset.n:'Error: '+j.error,!j.ok);refreshInbox()}else if(e.target.classList.contains('copyBtn')){try{await navigator.clipboard.writeText(row.dataset.p);setStatus('Copied path: '+row.dataset.p)}catch(err){setStatus('Could not copy: '+err.message,true)}}});function uploadStream(blob,name){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST','${BASE}/api/upload-stream/'+encodeURIComponent(project)+'?filename='+encodeURIComponent(name||'upload.bin'));x.setRequestHeader('Content-Type','application/octet-stream');x.upload.onprogress=e=>{if(e.lengthComputable)setStatus('Uploading '+(name||'file')+'… '+Math.round(e.loaded/e.total*100)+'% ('+fmtSize(e.loaded)+' / '+fmtSize(e.total)+')')};x.onerror=()=>reject(new Error('Network error during upload'));x.onabort=()=>reject(new Error('Upload cancelled'));x.onload=()=>{let j=null;try{j=JSON.parse(x.responseText)}catch{}if(x.status>=200&&x.status<300&&j&&j.ok)resolve(j);else reject(new Error((j&&j.error)||('Upload failed (HTTP '+x.status+')')))};x.send(blob)})}async function upload(blob,name){if(!blob){setStatus('No file received.',true);return}try{let j;if(blob.size>8*1024*1024){j=await uploadStream(blob,name)}else{setStatus('Saving '+(name||'file')+'…');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(new Error('Could not read file'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)});const r=await fetch('${BASE}/api/upload/'+encodeURIComponent(project),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:name||'clipboard-file',mime:blob.type||'application/octet-stream',data})});j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Upload failed')}try{await navigator.clipboard.writeText(j.path)}catch{}setStatus('Saved and path copied to clipboard:\\n'+j.path);refreshInbox()}catch(e){setStatus(e.message||String(e),true)}}drop.onclick=()=>file.click();file.onchange=()=>upload(file.files[0],file.files[0]?.name);['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));['dragleave','dragend'].forEach(ev=>drop.addEventListener(ev,()=>drop.classList.remove('over')));/* drop handler removed — window-capture 'drop' below handles uploads for both the dropzone and anywhere-in-window. Two listeners caused duplicate uploads. */window.addEventListener('paste',e=>{const item=[...(e.clipboardData?.items||[])].find(i=>i.kind==='file');if(!item)return;e.preventDefault();const f=item.getAsFile();upload(f,f?.name||'clipboard-file')},true);['dragenter','dragover'].forEach(ev=>window.addEventListener(ev,e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();drop.classList.add('over')}},true));window.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();drop.classList.remove('over');upload(e.dataTransfer.files[0],e.dataTransfer.files[0]?.name)}},true);async function refreshOutbox(){try{const r=await fetch('${BASE}/api/outbox/'+encodeURIComponent(project),{cache:'no-store'});const j=await r.json();if(!j.ok){olist.innerHTML='<div class="empty">'+esc(j.error||'failed')+'</div>';return}const files=j.files||[];if(!files.length){olist.innerHTML='<div class="empty">No files from the agent yet.</div>';return}olist.innerHTML=files.map(f=>'<div class="irow" data-n="'+esc(f.name)+'"><div class="thumb"><span>FILE</span></div><div class="nameCol"><div class="name">'+esc(f.name)+'</div><div class="meta">'+fmtSize(f.size)+' · '+esc(f.mtime||'')+'</div></div><a href="'+esc(f.url)+'">Download</a><button class="del" type="button">Delete</button></div>').join('')}catch(e){olist.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}olist.addEventListener('click',async e=>{const row=e.target.closest('.irow');if(!row)return;if(e.target.classList.contains('del')){if(!confirm('Delete "'+row.dataset.n+'"?'))return;const r=await fetch('${BASE}/api/outbox/'+encodeURIComponent(project)+'/file/'+encodeURIComponent(row.dataset.n),{method:'DELETE'});const j=await r.json();setStatus(j.ok?'Deleted '+row.dataset.n:'Error: '+j.error,!j.ok);refreshOutbox()}});refreshOutbox();refreshInbox();</script></body></html>`);
});

// `allowEmpty` keeps this route's long-standing behaviour: a genuinely empty
// file is an odd but legitimate thing to drop here. The streaming route below
// rejects 0 bytes, because there an empty body means the browser's read failed.
app.post(BASE + '/api/upload/:project', requireInboxWrite, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const {filename='clipboard-file', mime='', data=''} = req.body || {};
 const ext = path.extname(filename) || (mime.includes('jpeg') ? '.jpg' : mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('pdf') ? '.pdf' : mime.includes('text') ? '.txt' : '.bin');
 const out = await boxWrite(p, INBOX_DIR, inboxUploadName(filename, ext), Readable.from([Buffer.from(data, 'base64')]), {allowEmpty:true});
 await audit('upload', { project: p.name, filename: path.basename(out.path), bytes: out.bytes }, req);
 return res.json({ok:true,path:out.path,url:`${BASE}/file/${encodeURIComponent(p.name)}/${encodeURIComponent(path.basename(out.path))}`});
} catch(e){ return res.status(uploadStatus(e)).json({ok:false,error:e.message}); } });
// Streaming upload for large files: the raw request body is piped straight to
// disk — no base64, no JSON, no whole-file buffering. The JSON path above tops
// out around 75MB (100mb express/nginx caps ÷ base64 inflation) and the
// browser's data-URL read silently returns empty past ~0.5GB, which used to
// land a 0-byte file that still reported success.
app.post(BASE + '/api/upload-stream/:project', requireInboxWrite, async (req,res)=>{
 try {
  const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
  const filename = String(req.query.filename || 'upload.bin');
  const ext = path.extname(filename) || '.bin';
  // The request body is piped straight through to the (unprivileged) worker, so
  // an upload of any size still never lands in this process's memory — and an
  // abort mid-stream stands the worker down, which unlinks its temp rather than
  // publishing a truncated file.
  const out = await boxWrite(p, INBOX_DIR, inboxUploadName(filename, ext), req);
  await audit('upload', { project: p.name, filename: path.basename(out.path), bytes: out.bytes }, req);
  return res.json({ok:true,path:out.path,bytes:out.bytes,url:`${BASE}/file/${encodeURIComponent(p.name)}/${encodeURIComponent(path.basename(out.path))}`});
 } catch(e){ res.status(uploadStatus(e)).json({ok:false,error:e.message}); }
});
// The inbox download. A missing entry is now a 404 rather than the 500 express's
// default error handler produced from sendFile's ENOENT — the outbox twin below
// already answered 404, and the two had no business disagreeing.
app.get(BASE + '/file/:project/:file', requireAuth, requireProjectAccess, async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project');
 return sendBoxFile(res, p, INBOX_DIR, req.params.file);
});

app.get(BASE + '/api/inbox/:project', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const out = await boxJob(p, INBOX_DIR, 'box-list');
 const files = out.files.map(f => ({ ...f, ...boxFileFacts(p, INBOX_DIR, f.name) }));
 files.sort((a,b)=>b.mtime.localeCompare(a.mtime));
 res.json({ok:true,files});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete(BASE + '/api/inbox/:project/:file', requireInboxWrite, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const name = path.basename(req.params.file); if(!name || name==='.' || name==='..') return res.status(400).json({ok:false,error:'Invalid file'});
 await boxJob(p, INBOX_DIR, 'box-delete', name);
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.delete(BASE + '/api/inbox/:project', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 // A clear-all that cannot be performed is now REPORTED. The superseded route
 // swallowed every failure and answered ok, which is exactly how a refusal to
 // touch a substituted box would have looked like a successful wipe.
 await boxJob(p, INBOX_DIR, 'box-clear');
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
// _outbox: files an agent WRITES for the user to download (mirror of _inbox).
// Listing/downloading needs project access; mutations need terminal access.
app.get(BASE + '/api/outbox/:project', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const out = await boxJob(p, OUTBOX_DIR, 'box-list');
 const files = out.files.map(f => ({ ...f, ...boxFileFacts(p, OUTBOX_DIR, f.name) }));
 files.sort((a,b)=>b.mtime.localeCompare(a.mtime));
 res.json({ok:true,files});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
// Download one outbox file (served as an attachment under /api/ so nginx always routes it).
app.get(BASE + '/api/outbox/:project/file/:name', requireAuth, requireProjectAccess, async (req,res)=>{
 const p = await projectByName(req.params.project); if(!p) return res.status(404).send('Unknown project');
 const name = path.basename(req.params.name); if(!name || name==='.' || name==='..') return res.status(400).send('Invalid file');
 return sendBoxFile(res, p, OUTBOX_DIR, name, {attachment:true});
});
app.delete(BASE + '/api/outbox/:project/file/:name', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const name = path.basename(req.params.name); if(!name || name==='.' || name==='..') return res.status(400).json({ok:false,error:'Invalid file'});
 await boxJob(p, OUTBOX_DIR, 'box-delete', name);
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
app.delete(BASE + '/api/outbox/:project', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 // As with the inbox clear above: a refusal is reported rather than swallowed.
 await boxJob(p, OUTBOX_DIR, 'box-clear');
 res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});
app.get(BASE + '/api/preview/:project/status', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const status = await previewStatus(p);
 res.json({ ok:true, project:p.name, cmd:p.preview?.cmd || '', ...status });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/preview/:project/start', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project. Edit it on the Manage page.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/preview/:project/stop', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(DEPLOY_MODE === 'container') await stopPreviewUnit(p.name);
 else await sh('systemctl',['stop',previewUnit(p.name)]).catch(()=>{});
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/preview/:project/restart', requireTerminalAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 if(!hasPreview(p)) return res.status(400).json({ok:false,error:'Preview is not configured for this project.'});
 await startPreviewUnit(p);
 res.json({ ok:true, ...(await previewStatus(p)) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get(BASE + '/api/preview/:project/logs', requireAuth, requireProjectAccess, async (req,res)=>{ try {
 const p = await projectByName(req.params.project); if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
 const lines = Math.min(2000, Math.max(20, Number(req.query.lines) || 200));
 const log = await previewLogs(p.name, lines);
 res.json({ ok:true, log });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get(BASE + '/api/setup/state', requireAdmin, async (_req,res)=>{ try {
 const [settings, clis] = await Promise.all([loadWorkbenchSettings(), getCliStatuses()]);
 const updateStamp = await getClaudeUpdateStamp();
 res.json({ ok:true, settings, clis, updateStamp });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

// ---- scheduled tasks -------------------------------------------------------
app.get(BASE + '/api/tasks', requireAdmin, async (_req,res)=>{ try {
 const [tasks, projects, agents] = await Promise.all([loadScheduledTasks(), loadProjects(), activeAgentBins()]);
 const tz = await displayTimeZone();
 res.json({ ok:true, timeZone: tz, limits: SCHEDULE_LIMITS, timeZones: NORTH_AMERICAN_TIMEZONES, agents,
  projects: projects.map(p => p.name),
  // A template rather than a hidden default: the operator sees exactly what
  // would run and can edit it before saving.
  gitTemplate: guardedGitCommand(),
  tasks: tasks.map(t => ({ ...t, running: tasksInFlight.has(t.id),
   lastRunDisplay: t.lastRun ? (fmtUpdateStamp(t.lastRun, tz) || t.lastRun) : 'never',
   // What will actually be typed into the tab, agent wrapper included, so the
   // operator sees the composition rather than inferring it.
   effectiveCommand: buildTaskCommand(t),
   // A task can outlive the CLI it names. Say so in the list rather than letting
   // it fail unattended.
   agentUnavailable: !!(t.prompt && t.prompt.trim() && !agents.includes(t.agent)) })) });
} catch(e){ res.status(500).json({ok:false,error:e.message}); }});

app.post(BASE + '/api/tasks', requireAdmin, async (req,res)=>{ try {
 const tz = await displayTimeZone();
 let incoming;
 try { incoming = normalizeTask(req.body, { defaultTimeZone: tz, agentBins: taskKnownAgentBins }); }
 catch(e){ return res.status(400).json({ok:false,error:e.message}); }
 const tasks = await loadScheduledTasks();
 const existing = tasks.find(t => t.id === incoming.id);
 // The submitter owns the definition; the scheduler owns the history.
 const merged = preserveBookkeeping(incoming, existing);
 const next = existing ? tasks.map(t => t.id === merged.id ? merged : t) : [...tasks, merged];
 await saveScheduledTasks(next);
 await audit(existing ? 'task_update' : 'task_create', { task: merged.id, enabled: merged.enabled }, req);
 res.json({ ok:true, task: merged });
} catch(e){ res.status(500).json({ok:false,error:e.message}); }});

app.delete(BASE + '/api/tasks/:id', requireAdmin, async (req,res)=>{ try {
 const tasks = await loadScheduledTasks();
 const id = String(req.params.id);
 if(!tasks.some(t => t.id === id)) return res.status(404).json({ok:false,error:'No such task'});
 await saveScheduledTasks(tasks.filter(t => t.id !== id));
 await audit('task_delete', { task: id }, req);
 res.json({ ok:true });
} catch(e){ res.status(500).json({ok:false,error:e.message}); }});

app.post(BASE + '/api/tasks/:id/run', requireAdmin, async (req,res)=>{ try {
 const tasks = await loadScheduledTasks();
 const task = tasks.find(t => t.id === String(req.params.id));
 if(!task) return res.status(404).json({ok:false,error:'No such task'});
 // Run now ignores `enabled` and the clock deliberately — it is the operator
 // asking, not the schedule. It still records lastRun, so the schedule does not
 // fire the same work again an hour later.
 const out = await runScheduledTask(task, { trigger:'manual', dueAt: Date.now(), actor: req.user?.username || null });
 res.json({ ok:true, ...out });
} catch(e){ res.status(500).json({ok:false,error:e.message}); }});

app.post(BASE + '/api/setup/state', requireAdmin, async (req,res)=>{ try {
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

app.post(BASE + '/api/setup/heal/nginx', requireAdminOrLocal, async (_req,res)=>{ try {
 const projects = await loadProjects();
 await applyRouting(projects);
 res.json({ ok:true, message:`Regenerated nginx config from projects.json (${projects.length} project route${projects.length===1?'':'s'} + /pty/_setup/) and reloaded nginx.` });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/setup/heal/dirs', requireAdminOrLocal, async (_req,res)=>{ try {
 const steps = [];
 for(const d of [pendingDir,'/etc/project-workbench','/opt/project-workbench/workspaces','/opt/project-workbench/memory']){
  await fs.mkdir(d,{recursive:true}); steps.push(`ok dir: ${d}`);
 }
 // The Stop hook runs as admin and must be able to drop markers in pendingDir.
 const pendingOwner = await workspaceOwner(); await sh('chown',[pendingOwner.spec,pendingDir]).catch(()=>{}); steps.push(`ok owner ${pendingOwner.user}: ${pendingDir}`);
 try { await fs.access(emptyMcpPath); steps.push(`ok file: ${emptyMcpPath}`); }
 catch { await fs.writeFile(emptyMcpPath,'{}\n'); steps.push(`created: ${emptyMcpPath}`); }
 await syncWrapperEnv(await loadWorkbenchSettings()); steps.push(`refreshed: ${wrapperEnvPath}`);
 try { await fs.access('/usr/local/bin/claude'); steps.push('ok wrapper: /usr/local/bin/claude'); }
 catch { steps.push('MISSING /usr/local/bin/claude — run update-claude-code to reinstall'); }
 await sh('systemctl',['enable','--now','project-setup-terminal.service']).catch(()=>{});
 steps.push('enabled+started: project-setup-terminal.service');
 res.json({ ok:true, message: steps.join('\n') });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/setup/cli/install', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const { stdout, stderr } = await sh('npm',['install','-g',`${cfg.pkg}@latest`],{timeout:300000});
 const version = await getCliVersion(cfg.bin);
 res.json({ ok:true, version: version || 'not installed', log:(stdout+stderr).slice(-1500) });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.post(BASE + '/api/setup/cli/auth', requireAdmin, async (req,res)=>{ try {
 const cli = String(req.body?.cli || '');
 const cfg = SUPPORTED_CLIS[cli]; if(!cfg) return res.status(400).json({ok:false,error:'Unknown CLI'});
 const ready = await ensureSetupTerminal();
 if(!ready) return res.status(503).json({ok:false,error:'Setup terminal failed to start. Check `systemctl status project-setup-terminal.service`.'});
 await tmux(['send-keys','-t',setupTmuxSession,cfg.authCmd,'Enter']);
 res.json({ ok:true, command: cfg.authCmd });
} catch(e){ res.status(500).json({ok:false,error:e.message||String(e)}); }});

app.get(BASE + '/terminal-preload.js', async (_req,res)=>{ res.type('application/javascript').send(await fs.readFile('/opt/project-workbench/app/terminal-preload.js','utf8')); });
app.get(BASE + '/terminal-paste.js', async (_req,res)=>{ res.type('application/javascript').send(await fs.readFile('/opt/project-workbench/app/terminal-paste.js','utf8')); });
app.get(BASE + '/healthz', (_req,res)=>res.json({ok:true}));
// Public-readable agent guide. Lives in the repo at AGENTS.md and is the
// canonical place for an external AI agent to learn how to discover sessions,
// inject prompts, hand off files, etc. on this PW instance. No auth so a
// remote agent can curl it without first negotiating credentials.
app.get(BASE + '/agents.md', async (_req,res) => {
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
 return `<footer id="pwStatusBar"><span class="sb-item sb-version">Release: <b>${esc(RELEASE_VERSION)}</b></span><span class="sb-sep">·</span><span class="sb-item">Claude Code: <b>${esc(claudeVersion)}</b></span><span class="sb-sep">·</span><span class="sb-item">Last update check: <b>${esc(updateStamp)}</b></span><span class="sb-sep">·</span><span class="sb-item">Auth: ${enforceTag}</span><span class="sb-grow"></span>${u}</footer>`;
}
const statusBarCss = `#pwStatusBar{height:32px;box-sizing:border-box;position:fixed;left:0;right:0;bottom:0;background:rgba(15,23,42,.92);border-top:1px solid #1f2937;color:#94a3b8;font:12px system-ui,-apple-system,Segoe UI,sans-serif;padding:5px 14px;display:flex;align-items:center;gap:10px;backdrop-filter:blur(8px);z-index:50;overflow:hidden;white-space:nowrap}#pwStatusBar b{color:#e5e7eb;font-weight:600}#pwStatusBar .sb-sep{opacity:.45}#pwStatusBar .sb-grow{flex:1}#pwStatusBar .sb-tag{padding:1px 7px;border-radius:999px;background:#1f2937;color:#cbd5e1;font-size:11px;border:1px solid #334155}#pwStatusBar .sb-tag.warn{color:#fde68a;border-color:#854d0e;background:#3b2e0a}#pwStatusBar .sb-version{white-space:nowrap}body{padding-bottom:32px}body.pw-cockpit{padding-bottom:0}body.pw-cockpit #shell{height:calc(100% - 32px)}`;

// ============================================================================
// Settings page (admin-only). Tabbed surface — primary settings destination.
// Setup Wizard still exists as a focused guided modal launched from here.
// ============================================================================
const settingsCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}.s-header{display:flex;align-items:center;gap:1rem;padding:1rem 1.5rem;border-bottom:1px solid #1f2937;background:#0b1220}.s-header h1{margin:0;font-size:1.2rem}.s-header .back{color:#bfdbfe;text-decoration:none;border:1px solid #334155;border-radius:999px;padding:5px 12px;background:#0f172a;font-size:.85rem}.s-header .back:hover{background:#1e293b;color:#fff}.s-header .grow{flex:1}.s-header .who{font-size:.85rem;color:#cbd5e1}.s-header .who b{color:#fff}.s-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0;min-height:calc(100vh - 60px - 32px)}.s-tabs{border-right:1px solid #1f2937;padding:1rem .5rem;background:#0b1220}.s-tabs button{display:block;width:100%;text-align:left;background:transparent;color:#cbd5e1;border:0;padding:.55rem .85rem;border-radius:8px;font:inherit;cursor:pointer;margin:1px 0}.s-tabs button:hover{background:#1e293b;color:#fff}.s-tabs button.active{background:#1e3a8a;color:#fff;font-weight:600}.s-main{padding:1.5rem 2rem;overflow:auto;min-width:0}.s-main section{display:none}.s-main section.active{display:block}.s-main h2{margin:0 0 .25rem;font-size:1.3rem}.s-main .lead{margin:0 0 1.25rem;color:#94a3b8;font-size:.92rem}.s-card{background:#111827;border:1px solid #334155;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}.s-card h3{margin:0 0 .5rem;font-size:1.05rem;color:#bfdbfe}.s-card .muted{color:#94a3b8;font-size:.85rem}.button{display:inline-block;background:#2563eb;color:#fff;padding:.55rem .85rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit}.button.secondary{background:#374151}.button.danger{background:#991b1b}.button:hover{filter:brightness(1.1)}.button:disabled{opacity:.5;cursor:not-allowed}input,select{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;font:inherit;box-sizing:border-box}input[type=text],input[type=password]{width:100%}.row-form{display:grid;grid-template-columns:minmax(140px,1fr) minmax(140px,1fr) minmax(140px,2fr) minmax(140px,1fr) auto;gap:.5rem;align-items:end}.row-form label{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;color:#cbd5e1;min-width:0}.utable{width:100%;border-collapse:collapse;font-size:.9rem}.utable th{text-align:left;padding:.55rem .55rem;border-bottom:1px solid #1f2937;color:#94a3b8;font-weight:600;font-size:.78rem;letter-spacing:.02em;text-transform:uppercase}.utable td{padding:.6rem .55rem;border-bottom:1px solid #1f2937;vertical-align:middle}.utable tr:hover td{background:rgba(30,41,59,.4)}.utable td.actions{text-align:right;white-space:nowrap}.utable .role-pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#1f2937;border:1px solid #334155;color:#cbd5e1;font-size:.74rem}.utable .role-pill.admin{color:#fde68a;border-color:#854d0e;background:#3b2e0a}.utable .role-pill.developer{color:#bbf7d0;border-color:#166534;background:#0b291a}.utable .role-pill.content_editor{color:#bfdbfe;border-color:#1e3a8a;background:#0b1a3a}.utable .role-pill.viewer{color:#cbd5e1;border-color:#334155;background:#1f2937}.utable .grants{font:11px ui-monospace,Menlo,monospace;color:#94a3b8;word-break:break-word;max-width:380px;display:inline-block;margin-right:6px}.tiny{padding:3px 9px;font-size:.78rem;margin:0 2px}.status-line{margin-top:.65rem;font-size:.82rem;color:#bbf7d0;min-height:1.2em}.status-line.err{color:#fca5a5}.env-grid2{display:grid;grid-template-columns:1fr 1fr;gap:.85rem}.env-grid2 label{display:flex;flex-direction:column;gap:.3rem;color:#cbd5e1;font-size:.85rem}.opt-help{font-size:.78rem;color:#94a3b8;line-height:1.45;margin-top:.2rem;min-height:2.4em}.opt-help.warn{color:#fca5a5}.opt-help b{color:#fde68a}.heal-out{margin:.55rem 0 0;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:.55rem .75rem;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#bbf7d0;display:none}.heal-out.show{display:block}.heal-out.err{color:#fca5a5}.cli-row{display:grid;grid-template-columns:1fr auto auto;gap:.5rem .85rem;align-items:center;padding:.55rem .75rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.5rem;background:#0b1220}.cli-row .meta{min-width:0;display:flex;flex-direction:column;gap:.15rem}.cli-row .label{font-weight:600}.cli-row .version{color:#94a3b8;font-size:.78rem}.cli-row .version.installed{color:#bbf7d0}.cli-row .signed-in{color:#86efac;font-size:.7rem;background:rgba(16,185,129,.12);border:1px solid #166534;border-radius:999px;padding:0 .55rem;align-self:flex-start;line-height:1.5;margin-top:.1rem}.cli-row .cli-checked{color:#94a3b8;font-size:.72rem;margin-top:.1rem}.t-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.65rem .9rem;margin-bottom:.75rem}.t-grid label{display:flex;flex-direction:column;gap:.2rem;font-size:.85rem;color:#cbd5e1}/* display:flex above outranks the UA [hidden] rule, so a hidden field stays visible unless this re-asserts it — the same trap as .tabMenu vs .projLinks[hidden]. */.t-grid label[hidden]{display:none}.t-grid label.t-check{flex-direction:row;align-items:center;gap:.4rem}.t-grid label.t-check input{width:auto}.t-cmd{display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:#cbd5e1}.t-cmd textarea{font:12px var(--mono,monospace);background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.5rem;resize:vertical}.t-agentrow{display:flex;align-items:center;gap:.6rem;margin:.5rem 0 .2rem;font-size:.85rem;color:#cbd5e1}.t-agentrow label{display:flex;align-items:center;gap:.35rem}.t-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin:.6rem 0 .2rem}.task-row{display:flex;align-items:center;gap:.75rem;justify-content:space-between;padding:.55rem .75rem;border:1px solid #1f2937;border-radius:8px;margin-bottom:.4rem;background:#0b1220}.task-row .tr-main{display:flex;flex-direction:column;gap:.15rem;min-width:0}.task-row .tr-name{font-weight:600}.task-row .tr-when,.task-row .tr-last{font-size:.76rem;color:#94a3b8;overflow:hidden;text-overflow:ellipsis}.task-row .tr-last.ok{color:#86efac}.task-row .tr-last.bad{color:#fca5a5}.task-row .tr-off{font-size:.7rem;color:#fca5a5}.task-row .tr-run{font-size:.7rem;color:#fde68a}.task-row .tr-acts{display:flex;gap:.3rem;flex:0 0 auto}.cli-row .cli-checked.bad{color:#fca5a5}.cli-row .note{color:#94a3b8;font-size:.78rem;grid-column:1/-1;margin-top:.15rem}.cli-row .checks{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}.cli-row .actions{display:flex;gap:.35rem}.cli-row label{margin:0;font-size:.85rem;color:#cbd5e1;display:inline-flex;align-items:center;gap:.3rem}.cli-row label input{width:auto}#authFrame{width:100%;height:340px;border:1px solid #334155;border-radius:8px;background:#1f1f1f;display:block;margin-top:.5rem}#authFrame.hidden{display:none}.check-list{margin:0;padding:0;list-style:none}.check-list li{padding:.3rem 0;color:#cbd5e1;font-size:.9rem;display:flex;align-items:center;gap:.5rem}.check-list .ok{color:#86efac}.check-list .warn{color:#fde68a}.check-list .err{color:#fca5a5}
.um-form{display:flex;flex-direction:column;gap:.9rem}.um-form label{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#cbd5e1}.um-form label.inline{flex-direction:row;align-items:center;gap:.45rem}.um-form label.inline input[type=checkbox]{width:auto;margin:0}.proj-picker{border:1px solid #1f2937;border-radius:8px;padding:.5rem .65rem;background:#0b1220}.proj-picker .star{display:flex;align-items:center;gap:.45rem;color:#fde68a;font-size:.85rem;padding-bottom:.45rem;border-bottom:1px solid #1f2937;margin-bottom:.45rem}.proj-picker .star input{width:auto;margin:0}.proj-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.3rem .85rem;max-height:240px;overflow-y:auto}.proj-list.disabled{opacity:.45;pointer-events:none}.proj-list label{flex-direction:row;align-items:center;gap:.4rem;font-size:.82rem;color:#cbd5e1;padding:.2rem 0;cursor:pointer}.proj-list label input{width:auto;margin:0}.proj-list .empty{color:#94a3b8;font-style:italic;font-size:.82rem}@media(max-width:780px){.s-layout{grid-template-columns:1fr}.s-tabs{display:flex;flex-wrap:wrap;border-right:0;border-bottom:1px solid #1f2937;padding:.5rem}.s-tabs button{width:auto}.row-form{grid-template-columns:1fr}.env-grid2{grid-template-columns:1fr}}`;

const settingsScript = `<script>(function(){const tabs=document.querySelectorAll('.s-tabs button');const sections=document.querySelectorAll('.s-main section');function activate(id){tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===id));sections.forEach(s=>s.classList.toggle('active',s.id==='tab-'+id));try{history.replaceState(null,'','#'+id)}catch{}}tabs.forEach(b=>b.addEventListener('click',()=>activate(b.dataset.tab)));const init=(location.hash||'#users').slice(1);activate(['users','clis','env','system','firstrun'].includes(init)?init:'users');function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function setStatus(el,t,err){if(!el)return;el.textContent=t||'';el.classList.toggle('err',!!err)}
// --- Users tab ---
const uTable=document.getElementById('uTable');const uStatus=document.getElementById('uStatus');const uAddBtn=document.getElementById('uAddBtn');
// Project list cache for the picker — admins see all projects via /api/projects/status.
let pwProjects=[];async function loadProjectList(){try{const r=await fetch('${BASE}/api/projects/status',{cache:'no-store'});const j=await r.json();if(j?.ok)pwProjects=(j.projects||[]).map(p=>p.name).sort((a,b)=>a.localeCompare(b))}catch{}}
async function loadUsers(){uTable.innerHTML='<tr><td colspan="${DEPLOY_CENTRE ? '8' : '7'}" class="muted">loading…</td></tr>';try{const r=await fetch('${BASE}/api/users',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'load failed');renderUsers(j.users)}catch(e){uTable.innerHTML='<tr><td colspan="${DEPLOY_CENTRE ? '8' : '7'}" class="muted">'+esc(e.message)+'</td></tr>'}}
function projectsCellHtml(p){if(p==='*')return '<span class="role-pill admin">all projects</span>';if(!Array.isArray(p)||p.length===0)return '<span class="muted">none</span>';return p.map(x=>'<code class="grants">'+esc(x)+'</code>').join('')}
function deployPwCellHtml(u){return ${DEPLOY_CENTRE ? "(u.hasDeployPassword?'<td><span class=\"role-pill\" style=\"color:#93c5fd;border-color:#1e40af;background:rgba(59,130,246,.12)\">set</span></td>':'<td><span class=\"role-pill\">none</span></td>')" : "''"}}
function tokenCellHtml(u){return u.hasToken?'<td><span class="role-pill" style="color:#86efac;border-color:#166534;background:rgba(16,185,129,.12)">✓ token</span></td>':'<td><span class="role-pill">none</span></td>'}
function renderUsers(users){if(!users.length){uTable.innerHTML='<tr><td colspan="${DEPLOY_CENTRE ? '8' : '7'}" class="muted">no users yet — click + Add user above</td></tr>';return}window._pwUsers=users;uTable.innerHTML='<tr><th>Username</th><th>Role</th><th>Git token</th><th>Claude</th><th>Projects</th>${DEPLOY_CENTRE ? '<th>Deploy PW</th>' : ''}<th>Last login</th><th></th></tr>'+users.map(u=>'<tr data-u="'+esc(u.username)+'"><td><b>'+esc(u.username)+'</b></td><td><span class="role-pill '+esc(u.role)+'">'+esc(u.role)+'</span></td>'+tokenCellHtml(u)+'<td>'+(u.claudeSignedIn===true?'<span class="signed-in" title="This user completed their own Claude login">✓ signed in</span>':(u.claudeSignedIn===false?'<span class="muted" title="Owner has not completed their Claude login yet — they run claude once in a project they own">not yet</span>':'<span class="muted" title="Per-user Claude login is off (PW_PER_USER_CLAUDE)">·</span>'))+'</td>'+'<td>'+projectsCellHtml(u.projects)+'</td>'+deployPwCellHtml(u)+'<td class="muted">'+esc(u.lastLoginAt||'never')+'</td><td class="actions"><button class="button secondary tiny" data-edit="'+esc(u.username)+'">Edit</button><button class="button secondary tiny" data-pw="'+esc(u.username)+'">Password</button><button class="button danger tiny" data-del="'+esc(u.username)+'">Delete</button></td></tr>').join('')}
uTable.addEventListener('click',async e=>{const t=e.target;if(t.dataset.del){if(!confirm('Delete user "'+t.dataset.del+'"? Their active sessions will be revoked.'))return;const r=await fetch('${BASE}/api/users/'+encodeURIComponent(t.dataset.del),{method:'DELETE'});const j=await r.json();setStatus(uStatus,j.ok?'Deleted '+t.dataset.del:'Error: '+j.error,!j.ok);loadUsers()}else if(t.dataset.pw){const p=prompt('New password for "'+t.dataset.pw+'" (≥8 chars):');if(!p)return;const r=await fetch('${BASE}/api/users/'+encodeURIComponent(t.dataset.pw)+'/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});const j=await r.json();setStatus(uStatus,j.ok?'Password reset for '+t.dataset.pw:'Error: '+j.error,!j.ok)}else if(t.dataset.edit){const u=(window._pwUsers||[]).find(x=>x.username===t.dataset.edit);if(u)umOpen('edit',u)}});
// --- User modal (used for both Add and Edit) ---
const umBackdrop=document.getElementById('umBackdrop');const umTitle=document.getElementById('umTitle');const umUsername=document.getElementById('umUsername');const umRole=document.getElementById('umRole');const umProjStar=document.getElementById('umProjStar');const umProjList=document.getElementById('umProjList');const umPassword=document.getElementById('umPassword');const umPwLabel=document.getElementById('umPwLabel');const umGhToken=document.getElementById('umGhToken');${DEPLOY_CENTRE ? "const umDeployPw=document.getElementById('umDeployPw');" : ''}const umStatus=document.getElementById('umStatus');const umSave=document.getElementById('umSave');const umCancel=document.getElementById('umCancel');const umClose=document.getElementById('umClose');let umMode='add';let umOriginalUsername=null;
function renderProjList(selected){if(!pwProjects.length){umProjList.innerHTML='<span class="empty">No projects in <code>projects.json</code> yet — add one from the dashboard\\'s Manage page first.</span>';return}const sel=new Set(Array.isArray(selected)?selected:[]);umProjList.innerHTML=pwProjects.map(p=>'<label><input type="checkbox" value="'+esc(p)+'"'+(sel.has(p)?' checked':'')+'>'+esc(p)+'</label>').join('')}
function syncStarDisabled(){umProjList.classList.toggle('disabled',umProjStar.checked)}
umProjStar.addEventListener('change',syncStarDisabled);
function umOpen(mode,user){umMode=mode;umOriginalUsername=user?.username||null;umTitle.textContent=mode==='add'?'Add user':('Edit user — '+user.username);umUsername.value=user?.username||'';umRole.value=user?.role||'developer';const isStar=user?.projects==='*';umProjStar.checked=isStar;renderProjList(isStar?[]:user?.projects);syncStarDisabled();umPassword.value='';umPwLabel.style.display=mode==='add'?'':'none';umPassword.required=mode==='add';umGhToken.value='';umGhToken.placeholder=user?.hasToken?'(stored — leave blank to keep)':'ghp_… (optional)';${DEPLOY_CENTRE ? "umDeployPw.value='';umDeployPw.placeholder=user?.hasDeployPassword?'(stored — leave blank to keep)':'optional';" : ''}setStatus(umStatus,'');umBackdrop.classList.remove('hidden');setTimeout(()=>umUsername.focus(),30)}
function umCloseFn(){umBackdrop.classList.add('hidden')}
umCancel.addEventListener('click',umCloseFn);umClose.addEventListener('click',umCloseFn);umBackdrop.addEventListener('click',e=>{if(e.target===umBackdrop)umCloseFn()});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!umBackdrop.classList.contains('hidden'))umCloseFn()});
uAddBtn.addEventListener('click',()=>{if(!pwProjects.length){loadProjectList().then(()=>umOpen('add',null))}else{umOpen('add',null)}});
umSave.addEventListener('click',async()=>{const username=umUsername.value.trim();if(!/^[A-Za-z0-9._-]+$/.test(username)){setStatus(umStatus,'Username must be letters, digits, dot, dash, underscore (no spaces).',true);return}const role=umRole.value;const projects=umProjStar.checked?'*':[...umProjList.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.value);const body={username,role,projects};const ghToken=umGhToken.value.trim();if(ghToken)body.ghToken=ghToken;${DEPLOY_CENTRE ? "const deployPassword=umDeployPw.value.trim();" : ''}if(umMode==='add'){if(umPassword.value.length<8){setStatus(umStatus,'Password must be at least 8 characters.',true);return}body.password=umPassword.value}${DEPLOY_CENTRE ? "if(deployPassword)body.deployPassword=deployPassword;" : ''}umSave.disabled=true;setStatus(umStatus,'Saving…');try{let r,j;if(umMode==='add'){r=await fetch('${BASE}/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}else{const patchBody={};if(ghToken)patchBody.ghToken=ghToken;if(username!==umOriginalUsername)patchBody.username=username;if(role!==undefined)patchBody.role=role;patchBody.projects=projects;${DEPLOY_CENTRE ? "if(deployPassword)patchBody.deployPassword=deployPassword;" : ''}r=await fetch('${BASE}/api/users/'+encodeURIComponent(umOriginalUsername),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patchBody)})}j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');setStatus(uStatus,(umMode==='add'?'Added ':'Updated ')+username);umCloseFn();loadUsers()}catch(e){setStatus(umStatus,e.message,true)}finally{umSave.disabled=false}});
loadProjectList();loadUsers();
// --- CLIs + Environment + System tabs (reuse existing /api/setup/* endpoints) ---
const cliRows=document.getElementById('cliRows');const cliStatus=document.getElementById('cliStatus');const permMode=document.getElementById('permMode');const mcpMode=document.getElementById('mcpMode');const envStatus=document.getElementById('envStatus');const envSave=document.getElementById('envSave');const healNginx=document.getElementById('healNginxBtn');const healDirs=document.getElementById('healDirsBtn');const healOut=document.getElementById('healOut');const sysVer=document.getElementById('sysVer');const sysChecks=document.getElementById('sysChecks');const authFrame=document.getElementById('authFrame');const authHint=document.getElementById('authHint');let state=null;async function loadState(){try{const r=await fetch('${BASE}/api/setup/state',{cache:'no-store'});state=await r.json();if(!state.ok)throw new Error(state.error||'load failed');renderClis();renderEnv()}catch(e){setStatus(cliStatus,e.message,true)}}async function loadSystem(){try{const r=await fetch('${BASE}/api/system/status',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'status failed');sysVer.innerHTML='Claude Code <b>'+esc(j.claudeVersion)+'</b> · Last updater run: <b>'+esc(j.updateStamp)+'</b> · Users: <b>'+j.userCount+'</b>';const c=j.checks;const items=[['claudeInstalled','Claude Code CLI installed'],['claudeAuthenticated','Claude Code signed in'],['atLeastOneAdmin','At least one admin user defined'],['atLeastOneEnabledCli','At least one CLI enabled in settings'],['wrapperEnvPresent','Wrapper env (/etc/project-workbench/claude-wrapper.env) present'],['authEnforce','Auth enforce mode ON (PW_AUTH_ENFORCE=true)']];sysChecks.innerHTML=items.map(([k,label])=>{const ok=!!c[k];const cls=k==='authEnforce'&&!ok?'warn':(ok?'ok':'err');const icon=ok?'✓':(k==='authEnforce'?'⚠':'✗');return '<li class="'+cls+'">'+icon+' '+esc(label)+'</li>'}).join('')}catch(e){sysChecks.innerHTML='<li class="err">'+esc(e.message)+'</li>'}}function renderClis(){cliRows.innerHTML='';const enabled=new Set(state.settings.enabledClis||[]);const upd=new Set(state.settings.updateClis||[]);for(const c of Object.values(state.clis)){const row=document.createElement('div');row.className='cli-row';row.dataset.cli=c.key;row.innerHTML='<div class="meta"><span class="label">'+esc(c.label)+'</span><span class="version'+(c.installed?' installed':'')+'">'+esc(c.version)+'</span>'+(c.authenticated?'<span class="signed-in">Signed in</span>':'')+'<span class="cli-checked'+(c.lastUpdateOk===false?' bad':'')+'" title="When the auto-updater last checked this CLI">'+(c.lastUpdate==='never'?'never checked':(c.lastUpdateOk===false?'check failed \u00b7 ':'checked ')+esc(c.lastUpdate))+'</span>'+'</div><div class="checks"><label><input type="checkbox" class="en"'+(enabled.has(c.key)?' checked':'')+'>Enable</label><label><input type="checkbox" class="up"'+(upd.has(c.key)?' checked':'')+'>Auto-update</label></div><div class="actions"><button class="button secondary tiny inst">'+(c.installed?'Update':'Install')+'</button><button class="button tiny auth">'+(c.authenticated?'Reauthenticate':'Sign in')+'</button></div><div class="note">'+esc(c.notes)+'</div>';row.querySelector('.inst').onclick=async()=>{const btn=row.querySelector('.inst');btn.disabled=true;btn.textContent='Installing…';setStatus(cliStatus,'');try{const r=await fetch('${BASE}/api/setup/cli/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'install failed');setStatus(cliStatus,c.label+': '+j.version);loadState();loadSystem()}catch(e){setStatus(cliStatus,e.message,true);loadState()}};row.querySelector('.auth').onclick=async()=>{const btn=row.querySelector('.auth');btn.disabled=true;setStatus(cliStatus,'');try{const r=await fetch('${BASE}/api/setup/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:c.key})});const j=await r.json();if(!j.ok)throw new Error(j.error||'auth start failed');if(authFrame.src.indexOf('${BASE}/pty/_setup/')<0)authFrame.src='${BASE}/pty/_setup/';authFrame.classList.remove('hidden');authHint.textContent='Running: '+j.command+' — complete the prompts in the terminal below.'}catch(e){setStatus(cliStatus,e.message,true)}finally{btn.disabled=false}};cliRows.appendChild(row)}}const PERM_HELP={prompt:'Claude pauses and asks before each tool use (file edit, shell command, etc.). Safest default.',skip:'<b>Warning:</b> passes <code>--dangerously-skip-permissions</code>. Claude runs every tool unattended. Anyone with dashboard access effectively has shell on this box.'};const MCP_HELP={inherit:'Use the MCP servers configured on your Anthropic account.',isolated:'Use an empty MCP config so no external MCP servers load.',custom:'Use a custom MCP JSON via <code>PW_MCP_CONFIG</code>.'};function renderEnv(){permMode.value=state.settings.permissionMode||'prompt';mcpMode.value=state.settings.mcpMode||'isolated';renderEnvHelp()}function renderEnvHelp(){document.getElementById('permHelp').innerHTML=PERM_HELP[permMode.value]||'';document.getElementById('permHelp').classList.toggle('warn',permMode.value==='skip');document.getElementById('mcpHelp').innerHTML=MCP_HELP[mcpMode.value]||''}permMode.addEventListener('change',renderEnvHelp);mcpMode.addEventListener('change',renderEnvHelp);envSave.onclick=async()=>{envSave.disabled=true;setStatus(envStatus,'Saving…');try{const enabledClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.en').checked).map(r=>r.dataset.cli);const updateClis=[...cliRows.querySelectorAll('.cli-row')].filter(r=>r.querySelector('.up').checked).map(r=>r.dataset.cli);const r=await fetch('${BASE}/api/setup/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissionMode:permMode.value,mcpMode:mcpMode.value,enabledClis,updateClis})});const j=await r.json();setStatus(envStatus,j.ok?'Saved.':'Error: '+j.error,!j.ok)}catch(e){setStatus(envStatus,e.message,true)}finally{envSave.disabled=false}};async function heal(url,btn){btn.disabled=true;healOut.className='heal-out show';healOut.textContent='Working…';try{const r=await fetch(url,{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'failed');healOut.textContent=j.message||'OK';healOut.className='heal-out show'}catch(e){healOut.textContent=e.message;healOut.className='heal-out show err'}finally{btn.disabled=false;loadSystem()}}healNginx.onclick=()=>heal('${BASE}/api/setup/heal/nginx',healNginx);healDirs.onclick=()=>heal('${BASE}/api/setup/heal/dirs',healDirs);loadState();loadSystem();
/* ---- scheduled tasks ---- */
const tRows=document.getElementById('taskRows'),tStatus=document.getElementById('taskStatus');
const tF={id:'tId',name:'tName',window:'tWindow',kind:'tKind',at:'tAt',every:'tEvery',tz:'tTz',weekdays:'tWeekdays',enabled:'tEnabled',target:'tTarget',pick:'tPick',cmd:'tCmd',prompt:'tPrompt',agent:'tAgent'};
const el=k=>document.getElementById(tF[k]);
let taskState={tasks:[],projects:[],gitTemplate:'',timeZone:'',timeZones:[]};
let wantTz='';
function tSay(m,bad){tStatus.textContent=m||'';tStatus.style.color=bad?'#fca5a5':'#bbf7d0'}
function renderAgentOptions(){
 const sel=el('agent'),want=sel.value||'claude',list=taskState.agents||[];
 sel.innerHTML=list.map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join('');
 // An agent that is no longer active must stay selectable while editing that task,
 // or saving would quietly repoint it at a different CLI.
 if(want&&!list.includes(want))sel.insertAdjacentHTML('afterbegin','<option value="'+esc(want)+'">'+esc(want)+' (not currently available)</option>');
 if([...sel.options].some(o=>o.value===want))sel.value=want;
 // With no usable agent, say so instead of showing an empty control.
 if(!sel.options.length)sel.innerHTML='<option value="">no agent enabled &amp; installed</option>';
}
function renderTzOptions(){
 const sel=el('tz');
 sel.innerHTML=(taskState.timeZones||[]).map(z=>'<option value="'+esc(z.id)+'">'+esc(z.label)+'</option>').join('');
 const v=wantTz||taskState.timeZone||'';
 if(v&&![...sel.options].some(o=>o.value===v))sel.insertAdjacentHTML('afterbegin','<option value="'+esc(v)+'">'+esc(v)+'</option>');
 if(v)sel.value=v;
}
function syncKind(){const daily=el('kind').value==='daily';document.getElementById('tAtWrap').hidden=!daily;document.getElementById('tEveryWrap').hidden=daily;document.getElementById('tPickWrap').hidden=el('target').value!=='some'}
el('kind').addEventListener('change',syncKind);el('target').addEventListener('change',syncKind);
function fillTaskForm(t){
 el('id').value=t?t.id:'';el('name').value=t?t.name:'';el('window').value=t?t.window:'';
 el('kind').value=t?t.schedule.kind:'daily';el('at').value=t&&t.schedule.at?t.schedule.at:'17:00';
 el('every').value=t&&t.schedule.everyMinutes?t.schedule.everyMinutes:30;
 wantTz=t?t.timeZone:'';renderTzOptions();el('weekdays').checked=!!(t&&t.schedule.weekdaysOnly);
 el('enabled').checked=t?t.enabled!==false:true;el('cmd').value=t?(t.command||''):'';el('prompt').value=t?(t.prompt||''):'';
 el('agent').value=(t&&t.agent)||'claude';renderAgentOptions();
 el('target').value=t&&t.target!=='all'?'some':'all';
 [...el('pick').options].forEach(o=>{o.selected=!!(t&&Array.isArray(t.target)&&t.target.includes(o.value))});
 document.getElementById('taskFormTitle').textContent=t?('Edit '+t.id):'Add a task';syncKind();
}
function renderTasks(){
 el('pick').innerHTML=taskState.projects.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
 if(!taskState.tasks.length){tRows.innerHTML='<p class="muted">No scheduled tasks yet.</p>';return}
 tRows.innerHTML=taskState.tasks.map(t=>{
  const when=t.schedule.kind==='daily'?('daily '+t.schedule.at+(t.schedule.weekdaysOnly?' (weekdays)':'')+' '+esc(t.timeZone)):('every '+t.schedule.everyMinutes+'m');
  const who=t.target==='all'?'all projects':(t.target.length+' project'+(t.target.length===1?'':'s'));
  const cls=t.lastStatus==='ok'?'ok':(t.lastStatus?'bad':'');
  return '<div class="task-row" data-id="'+esc(t.id)+'"><div class="tr-main"><span class="tr-name">'+esc(t.name)+'</span>'
   +(t.enabled?'':'<span class="tr-off">disabled</span>')+(t.running?'<span class="tr-run">running…</span>':'')
   +(t.agentUnavailable?'<span class="tr-off" title="This task names an agent that is not enabled or not installed, so its prompt will fail">agent unavailable: '+esc(t.agent)+'</span>':'')
   +'<span class="tr-when">'+when+' · '+who+'</span>'
   +'<span class="tr-last '+cls+'">last: '+esc(t.lastRunDisplay)+(t.lastStatus?(' · '+esc(t.lastStatus)):'')+(t.lastDetail?(' — '+esc(t.lastDetail)):'')+'</span></div>'
   +'<div class="tr-acts"><button class="button secondary tiny t-edit" type="button">Edit</button><button class="button secondary tiny t-run" type="button">Run now</button><button class="button secondary tiny t-del" type="button">Delete</button></div></div>';
 }).join('');
}
async function loadTasks(){
 try{const r=await fetch('${BASE}/api/tasks',{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'load failed');
  taskState={tasks:j.tasks||[],projects:j.projects||[],gitTemplate:j.gitTemplate||'',timeZone:j.timeZone||'',timeZones:j.timeZones||[],agents:j.agents||['claude']};
  renderTzOptions();renderAgentOptions();renderTasks();
 }catch(e){tRows.innerHTML='<p class="muted">'+esc(e.message)+'</p>'}
}
tRows.addEventListener('click',async e=>{
 const row=e.target.closest('.task-row');if(!row)return;const id=row.dataset.id;
 const t=taskState.tasks.find(x=>x.id===id);
 if(e.target.classList.contains('t-edit')){fillTaskForm(t);document.getElementById('tId').focus();return}
 if(e.target.classList.contains('t-del')){
  if(!confirm('Delete task "'+id+'"? This does not undo anything it already did.'))return;
  const r=await fetch('${BASE}/api/tasks/'+encodeURIComponent(id),{method:'DELETE'});const j=await r.json();
  tSay(j.ok?('Deleted '+id):('Error: '+j.error),!j.ok);loadTasks();return}
 if(e.target.classList.contains('t-run')){
  if(!confirm('Run "'+id+'" now in '+(t&&t.target==='all'?'every project':'its projects')+'?'))return;
  e.target.disabled=true;tSay('Running '+id+'…');
  try{const r=await fetch('${BASE}/api/tasks/'+encodeURIComponent(id)+'/run',{method:'POST'});const j=await r.json();
   tSay(j.ok?(id+': '+(j.status||'done')+' — '+(j.detail||'')):('Error: '+j.error),!j.ok||j.status==='failed');
  }catch(err){tSay(err.message,true)}finally{e.target.disabled=false;loadTasks()}}
});
document.getElementById('tGit').onclick=()=>{el('cmd').value=taskState.gitTemplate;if(!el('name').value)el('name').value='End-of-day commit & push';if(!el('id').value)el('id').value='eod-commit';if(!el('window').value)el('window').value='eod'};
document.getElementById('tReset').onclick=()=>fillTaskForm(null);
document.getElementById('tSave').onclick=async()=>{
 const kind=el('kind').value;
 const body={id:el('id').value.trim().toLowerCase(),name:el('name').value.trim(),window:el('window').value.trim(),
  enabled:el('enabled').checked,timeZone:el('tz').value.trim(),command:el('cmd').value,prompt:el('prompt').value,agent:el('agent').value,
  schedule:kind==='daily'?{kind:'daily',at:el('at').value.trim(),weekdaysOnly:el('weekdays').checked}:{kind:'interval',everyMinutes:Number(el('every').value)},
  target:el('target').value==='all'?'all':[...el('pick').selectedOptions].map(o=>o.value)};
 try{const r=await fetch('${BASE}/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();if(!j.ok)throw new Error(j.error||'save failed');
  tSay('Saved '+j.task.id);fillTaskForm(null);loadTasks();
 }catch(e){tSay(e.message,true)}
};
fillTaskForm(null);loadTasks();
// --- First Run tab: launch wizard modal ---
document.getElementById('rerunWizardBtn')?.addEventListener('click',()=>{document.getElementById('setupBackdrop')?.classList.remove('hidden')});})();</script>`;

app.get(BASE + '/settings', requireAdmin, async (req,res) => {
 const claudeVersion = await getClaudeVersion();
 const updateStamp = await getClaudeUpdateStamp();
 const footer = statusBarHtml({ claudeVersion, updateStamp, user: req.user, enforce: AUTH_ENFORCE });
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings — Project Workbench</title><style>${settingsCss}${statusBarCss}${modalBaseCss}${wizardCss}</style></head><body><header class="s-header"><a class="back" href="${BASE}/">← Dashboard</a><h1>Settings</h1><span class="grow"></span><span class="who"><b>${esc(req.user.username)}</b> · ${esc(req.user.role)}</span></header><div class="s-layout"><nav class="s-tabs"><button data-tab="users" class="active">Users &amp; Roles</button><button data-tab="clis">CLIs &amp; Sign-in</button><button data-tab="env">Environment</button><button data-tab="tasks">Scheduled tasks</button><button data-tab="system">System &amp; Updates</button><button data-tab="firstrun">First Run</button></nav><main class="s-main">
<section id="tab-users" class="active"><h2>Users &amp; Roles</h2><p class="lead">Manage who can sign in and which projects they can see. Users live in <code>/etc/project-workbench/users.json</code>; passwords are hashed with scrypt and never displayed. When per-user Claude is enabled (<code>PW_PER_USER_CLAUDE</code>), the <b>Claude</b> column shows whether a user has completed their own Claude login — used automatically for the projects they own (their <code>primaryUser</code> assignment).</p><div class="s-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:1rem"><h3 style="margin:0">Current users</h3><button class="button" id="uAddBtn" type="button">+ Add user</button></div><table class="utable" id="uTable" style="margin-top:1rem"></table><div class="status-line" id="uStatus"></div></div></section>
<section id="tab-clis"><h2>CLIs &amp; Sign-in</h2><p class="lead">Install or update each assistant, then sign in. Tokens land in <code>/home/admin</code> and apply to every project terminal.</p><div class="s-card"><div id="cliRows"></div><div class="status-line" id="cliStatus"></div></div><div class="s-card"><h3>Sign-in terminal</h3><div id="authHint" class="muted">Click <b>Sign in</b> on a CLI above. The login command is sent into the shared setup terminal below.</div><iframe id="authFrame" class="hidden" title="Setup auth terminal"></iframe></div></section>
<section id="tab-env"><h2>Environment</h2><p class="lead">Wrapper-level policy applied to every Claude session this instance launches.</p><div class="s-card"><div class="env-grid2"><label>Permission mode<select id="permMode"><option value="prompt">Prompt for each permission (default, recommended)</option><option value="skip">Skip permission prompts (--dangerously-skip-permissions)</option></select><span class="opt-help" id="permHelp"></span></label><label>MCP mode<select id="mcpMode"><option value="inherit">Inherit (account MCP)</option><option value="isolated">Isolated (no external MCP)</option><option value="custom">Custom config</option></select><span class="opt-help" id="mcpHelp"></span></label></div><button class="button" id="envSave" style="margin-top:1rem">Save environment</button><div class="status-line" id="envStatus"></div></div></section>
<section id="tab-tasks"><h2>Scheduled tasks</h2><p class="lead">Run a command in your projects on a clock. Each run opens a named tab in the project's terminal, so you can read what it did afterwards.</p>
<div class="s-card"><h3>Tasks</h3><div id="taskRows"><p class="muted">loading…</p></div><div id="taskStatus" class="muted"></div></div>
<div class="s-card"><h3 id="taskFormTitle">Add a task</h3>
<div class="t-grid">
<label>Id<input id="tId" type="text" placeholder="eod-commit" autocomplete="off"><span class="pmHelp">Lowercase letters, digits and dashes. Reusing an id edits that task.</span></label>
<label>Name<input id="tName" type="text" placeholder="End-of-day commit &amp; push" autocomplete="off"></label>
<label>Tab name<input id="tWindow" type="text" placeholder="eod" autocomplete="off"><span class="pmHelp">The tmux window each run opens.</span></label>
<label>When<select id="tKind"><option value="daily">Daily at a time</option><option value="interval">Every N minutes</option></select></label>
<label id="tAtWrap">Time<input id="tAt" type="text" placeholder="17:00" autocomplete="off"><span class="pmHelp">24-hour, in the timezone below.</span></label>
<label id="tEveryWrap" hidden>Minutes<input id="tEvery" type="number" min="5" step="5" placeholder="30"></label>
<label>Timezone<select id="tTz"></select><span class="pmHelp">Defaults to the dashboard timezone.</span></label>
<label class="t-check"><input id="tWeekdays" type="checkbox">Weekdays only</label>
<label class="t-check"><input id="tEnabled" type="checkbox" checked>Enabled</label>
<label>Projects<select id="tTarget"><option value="all">All projects</option><option value="some">Only the ones I pick</option></select></label>
<label id="tPickWrap" hidden>Pick projects<select id="tPick" multiple size="6"></select></label>
</div>
<label class="t-cmd">Shell commands <em style="text-transform:none;font-style:normal;font-weight:400">(optional — run first)</em><textarea id="tCmd" rows="7" spellcheck="false" placeholder="Runs in each project&#39;s workspace. One command per line."></textarea></label><div class="t-agentrow"><label>Agent<select id="tAgent"></select></label><span class="pmHelp">Used only if the prompt below is filled in.</span></div><label class="t-cmd">Agent prompt <em style="text-transform:none;font-style:normal;font-weight:400">(optional — runs after the shell commands)</em><textarea id="tPrompt" rows="5" spellcheck="false" placeholder="Plain English. Wrapped as: claude -p &#39;…&#39;"></textarea></label>
<div class="t-actions"><button class="button" id="tSave" type="button">Save task</button><button class="button secondary" id="tReset" type="button">Clear form</button><button class="button secondary" id="tGit" type="button">Use the guarded git template</button></div>
<p class="muted">The git template skips clean repos, skips detached HEAD, commits locally when there is no upstream, and never force-pushes.</p>
</div></section><section id="tab-system"><h2>System &amp; Updates</h2><p class="lead">Self-repair, version info, and a readiness checklist.</p><div class="s-card"><h3>Versions</h3><div id="sysVer" class="muted">loading…</div></div><div class="s-card"><h3>Readiness checklist</h3><ul class="check-list" id="sysChecks"><li class="muted">loading…</li></ul></div><div class="s-card"><h3>Heal</h3><p class="muted">Regenerate the nginx config from <code>projects.json</code>, or re-create runtime dirs / wrapper symlink if something looks broken.</p><button class="button" id="healNginxBtn" type="button">Regenerate nginx + reload</button> <button class="button secondary" id="healDirsBtn" type="button">Verify runtime dirs / wrapper</button><pre class="heal-out" id="healOut"></pre></div><div class="s-card"><h3>Audit log</h3><p class="muted">Sensitive events are appended as JSONL to <code>/var/log/project-workbench/audit.log</code>. Tail it from a shell: <code>sudo tail -F /var/log/project-workbench/audit.log</code></p></div></section>
<section id="tab-firstrun"><h2>First Run / Rerun Setup Wizard</h2><p class="lead">A guided walkthrough that installs and signs in a CLI, then sets the permission and MCP policy. Use this on first install or to repair a broken instance.</p><div class="s-card"><button class="button" id="rerunWizardBtn" type="button">Open Setup Wizard</button></div></section>
</main></div>
<div id="umBackdrop" class="modal-backdrop hidden" role="dialog" aria-modal="true"><div class="modal-box" style="max-width:560px"><header><h2 id="umTitle">Add user</h2><button class="modal-close" id="umClose" aria-label="Close" type="button">×</button></header><div class="body"><form id="umForm" class="um-form" onsubmit="return false"><label>Username<input type="text" id="umUsername" required pattern="[A-Za-z0-9._-]+" maxlength="64" autocomplete="off"></label><label>Role<select id="umRole" required><option value="developer">developer</option><option value="content_editor">content_editor</option><option value="viewer">viewer</option><option value="admin">admin</option></select></label><label>Projects<div class="proj-picker"><label class="star inline"><input type="checkbox" id="umProjStar"> All projects (<code>*</code>) — admin behaves like this regardless of selection</label><div class="proj-list" id="umProjList"></div></div></label><label id="umPwLabel">Password (≥8 chars)<input type="password" id="umPassword" minlength="8" autocomplete="new-password"></label><label>GitHub token <span class="muted">(encrypted; optional)</span><input type="password" id="umGhToken" autocomplete="new-password" placeholder="ghp_… (leave blank to keep)"></label>${DEPLOY_CENTRE ? '<label>Deploy password <span class="muted">(encrypted; optional)</span><input type="password" id="umDeployPw" autocomplete="new-password" placeholder="optional"></label>' : ''}<div class="status-line" id="umStatus"></div></form></div><footer><button class="button secondary" id="umCancel" type="button">Cancel</button><button class="button" id="umSave" type="button">Save</button></footer></div></div>
${wizardModalHtml}${wizardScript}${settingsScript}${footer}</body></html>`);
});

// ============================================================================
// Auth routes (Phase 1)
// ============================================================================
const loginCss = `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e5e7eb}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:2rem 1.75rem;max-width:380px;width:calc(100% - 2rem);box-shadow:0 30px 80px rgba(0,0,0,.6)}h1{margin:0 0 .35rem;font-size:1.45rem}.sub{margin:0 0 1.5rem;color:#94a3b8;font-size:.9rem}label{display:block;margin:.75rem 0 .3rem;font-size:.85rem;color:#cbd5e1}input{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:8px;padding:.6rem;width:100%;box-sizing:border-box;font:inherit}.button{display:inline-block;background:#2563eb;color:white;padding:.65rem 1rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit;width:100%;margin-top:1rem}.button:hover{background:#1d4ed8}.err{margin-top:.85rem;color:#fca5a5;font-size:.85rem;min-height:1.2em}.foot{margin-top:1.25rem;color:#64748b;font-size:.75rem;text-align:center}`;
app.get(BASE + '/login', (req,res) => {
 if(req.user && !req.user.implicit){ return res.redirect(req.query.next ? String(req.query.next) : BASE + '/'); }
 const next = req.query.next ? String(req.query.next) : BASE + '/';
 const msg = req.query.msg ? String(req.query.msg) : '';
 const sub = AUTH_MODE === 'ldap' ? `Sign in with ${esc(LOGIN_ORG || 'your directory account')}.` : 'Sign in to continue.';
 const uph = AUTH_MODE === 'ldap' ? 'firstname.lastname' : 'username';
 res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${forceMotionScript}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Project Workbench</title><style>${loginCss}</style></head><body><div class="card"><h1>Project Workbench</h1><p class="sub">${sub}</p><form id="loginForm"><label>Username<input id="u" name="username" autocomplete="username" placeholder="${uph}" autofocus required></label><label>Password<input id="p" name="password" type="password" autocomplete="current-password" required></label><button class="button" type="submit">Sign in</button><div class="err" id="err">${esc(msg)}</div></form></div><script>const next=${JSON.stringify(next)};document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();const u=document.getElementById('u').value;const p=document.getElementById('p').value;const err=document.getElementById('err');err.textContent='Signing in…';try{const r=await fetch('${BASE}/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const j=await r.json();if(!j.ok){err.textContent=j.error||'Login failed';return}location.href=next}catch(e){err.textContent=e.message||String(e)}});</script></body></html>`);
});

app.post(BASE + '/api/auth/login', async (req,res) => {
 try {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if(!username || !password){ await audit('login_fail', { reason:'missing-fields', username }, req); return res.status(400).json({ ok:false, error:'Username and password required' }); }
  // The ENTIRE login flow — authenticate (password verification against the
  // CURRENT users.json), the lastLoginAt update, and session creation — runs
  // inside ONE acquisition of the cross-process users lifecycle lock,
  // nesting session creation inside it exactly like DELETE
  // /api/users/:username already nests its own session purge (users lock
  // outer, sessions lock inner: one consistent global order, never the
  // reverse, never held across the other — rules out a login-vs-delete
  // lock-ordering deadlock by construction).
  //
  // This closes a real orphaned-session race: authenticate() used to read
  // users.json OUTSIDE any lock DELETE also respected, so a login racing a
  // concurrent delete of the SAME account could authenticate against a
  // user record that was about to be removed, and create a session AFTER
  // DELETE's session-purge step had already run against an already-vacated
  // victim. Now, whichever of the two critical sections runs first is
  // authoritative for the other: if DELETE runs first, a subsequent login's
  // authenticate() (reading users.json fresh, from inside the SAME lock)
  // correctly fails closed with 401 and creates no session; if login runs
  // first, it fully completes (session included) before DELETE can even
  // start, so DELETE's own fresh read of sessions.json sees and purges that
  // session too. Either ordering: no orphan, no revived session.
  const outcome = await credentialDomain.withLocks(['lifecycle'], async () => {
   let u = null;
   try { u = await authenticate(username, password); }
   catch(e){ return { authError: 'ldap-bind' }; }
   if(!u) return { authError: 'invalid' };
   try {
    const users = await loadUsers();
    const rec = users.find(x => x.id === u.id);
    if(rec){ rec.lastLoginAt = new Date().toISOString(); await saveUsers(users); }
   } catch { /* best-effort; never fails the login itself */ }
   const sid = await createSession(u.id);
   return { user: u, sid };
  });
  if(outcome.authError){
   await audit('login_fail', { reason: outcome.authError, username }, req);
   return res.status(401).json({ ok:false, error:'Invalid username or password' });
  }
  setSessionCookie(req, res, outcome.sid, Math.floor(SESSION_TTL_MS / 1000));
  req.user = outcome.user;
  await audit('login_ok', { username }, req);
  res.json({ ok:true, user: { username:outcome.user.username, role:outcome.user.role, projects:outcome.user.projects } });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post(BASE + '/api/auth/logout', async (req,res) => {
 try {
  const sid = getCookie(req, SESSION_COOKIE);
  if(sid) await revokeSession(sid);
  clearSessionCookie(req, res);
  await audit('logout', {}, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.get(BASE + '/api/auth/me', (req,res) => {
 if(!req.user){ return res.status(401).json({ ok:false, authenticated:false, enforce: AUTH_ENFORCE }); }
 res.json({ ok:true, authenticated: !req.user.implicit, enforce: AUTH_ENFORCE, user: { username:req.user.username, role:req.user.role, projects:req.user.projects, implicit: !!req.user.implicit } });
});

// nginx auth_request subrequest. Returns 200 if the cookie's user can access
// ?project=<name>; 401/403 otherwise. nginx then allows or blocks the parent.
// ?admin=1 forces an admin-only check regardless of project (used for the
// shared setup terminal at /pty/_setup/).
app.get(BASE + '/api/auth/check', async (req,res) => {
 try {
  // nginx's auth_request does NOT forward the parent request's query string, so
  // derive the project/setup scope from the ORIGINAL request path (X-Original-URI)
  // when the query params are absent. Without this, the raw ttyd pty and live
  // preview would be reachable regardless of per-project grants or adminOnly.
  const orig = String(req.headers['x-original-uri'] || '');
  let project = String(req.query.project || '');
  let adminOnly = String(req.query.admin || '') === '1';
  if(!project && !adminOnly && orig){
   if(/\/pty\/_setup\//.test(orig)) adminOnly = true;
   else { const m = orig.match(/\/(?:pty|preview)\/([^\/?]+)/); if(m){ try { project = decodeURIComponent(m[1]); } catch { project = m[1]; } } }
  }
  if(!req.user){
   if(!AUTH_ENFORCE) return res.status(200).end(); // soft mode: allow.
   return res.status(401).end();
  }
  // Optional sibling-app SSO: propagate the authenticated username so an
  // nginx auth_request can forward it to sister apps (opt-in via PW_SSO_USER_HEADER).
  if(SSO_USER_HEADER && !req.user.implicit) res.set(SSO_USER_HEADER, req.user.username);
  if(adminOnly){
   return res.status(req.user.role === 'admin' ? 200 : 403).end();
  }
  if(req.user.role === 'admin') return res.status(200).end();
  if(project){
   if(!TERMINAL_ROLES.has(req.user.role)) return res.status(403).end();
   if(!userHasProjectAccess(req.user, project)) return res.status(403).end();
   const projects = await loadProjects();
   const proj = projects.find(x => x.name === project);
   if(proj?.adminOnly) return res.status(403).end();
  }
  return res.status(200).end();
 } catch { res.status(500).end(); }
});

// ============================================================================
// User management (admin-only). All mutations audited. Never echoes hashes.
// Last-admin guard prevents accidental lockout.
// ============================================================================
function safeUserShape(u){
 const out = { username: u.username, role: u.role, projects: u.projects, hasToken: !!u.ghToken, createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
  // Surfaced so a stuck rename reconciliation (see reconcileRenameCredentials)
  // is visible — including WHICH operation, not just that one exists — to an
  // admin rather than a hidden users.json-only field. Contains no secret.
  pendingCredentialSync: u.pendingCredentialSync ? { opId: u.pendingCredentialSync.opId, fromUsername: u.pendingCredentialSync.fromUsername, toUsername: u.pendingCredentialSync.toUsername } : null };
 if(DEPLOY_CENTRE) out.hasDeployPassword = !!u.deployPassword;
 return out;
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

app.get(BASE + '/api/users', requireAdmin, async (_req,res) => {
 try {
  const users = await loadUsers();
  const out = await Promise.all(users.map(async u => ({ ...safeUserShape(u), claudeSignedIn: PER_USER_CLAUDE ? await userClaudeSignedIn(u.username) : null })));
  res.json({ ok:true, perUserClaude: PER_USER_CLAUDE, users: out });
 }
 catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post(BASE + '/api/users', requireAdmin, async (req,res) => {
 try {
  const username = String(req.body?.username || '').trim();
  const role = String(req.body?.role || '');
  const password = String(req.body?.password || '');
  const ghToken = typeof req.body?.ghToken === 'string' ? req.body.ghToken.trim() : '';
  const deployPassword = DEPLOY_CENTRE && typeof req.body?.deployPassword === 'string' ? req.body.deployPassword.trim() : '';
  if(!validNewUsername(username)) return res.status(400).json({ ok:false, error:'Invalid username (letters/digits/._- only, max 64)' });
  if(!ROLES.includes(role)) return res.status(400).json({ ok:false, error:`role must be one of: ${ROLES.join(', ')}` });
  if(AUTH_MODE !== 'ldap' && password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  let projects;
  try { projects = normalizeProjects(req.body?.projects); } catch(e){ return res.status(400).json({ ok:false, error: e.message }); }
  // Hashing is slow by design; do it BEFORE acquiring the lifecycle lock so a
  // create never holds the cross-process lock — blocking every other
  // rename/delete/reconcile in the meantime — for the length of a scrypt hash.
  const passwordHash = AUTH_MODE === 'ldap' ? undefined : await hashPassword(password);
  const now = new Date().toISOString();
  const id = 'u-' + crypto.randomBytes(6).toString('base64url');
  const rec = { id, username, role, projects, createdAt: now, lastLoginAt: null };
  if(passwordHash) rec.passwordHash = passwordHash;
  if(ghToken) rec.ghToken = encrypt(ghToken);
  if(deployPassword) rec.deployPassword = encrypt(deployPassword);
  const result = await credentialDomain.withLocks(['lifecycle'], async () => {
   const users = await loadUsers();
   if(users.some(u => u.username === username)) return { failure:{ status:409, error:`User "${username}" already exists` } };
   // A username still reserved by someone ELSE's unfinished rename (see
   // reconcileRenameCredentials) must not be handed to a brand-new account —
   // that account's credential tree would land on a namespace that may not
   // have been pruned of the departing identity's OAuth/token material yet.
   const reserveErr = reservedUsernameConflict(users, username, null);
   if(reserveErr) return { failure:{ status:409, error: reserveErr } };
   users.push(rec);
   await saveUsers(users);
   return { ok:true };
  });
  if(result.failure) return res.status(result.failure.status).json({ ok:false, error: result.failure.error });
  await audit('user_create', { username, role, projects, hasToken: !!ghToken }, req);
  res.json({ ok:true, user: safeUserShape(rec) });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// Finish a rename's outstanding project-reference + credential-tree
// reconciliation. Called from WITHIN a withLifecycleLock() critical section
// by the PATCH route below (on the request that started — or is retrying —
// a rename), by the explicit recovery endpoint (POST
// /api/users/:username/reconcile), and by DELETE (to sweep a lingering
// old-name reference an unfinished rename left behind). Every step here is
// idempotent: it has to be, since any caller may be retrying after a partial
// prior failure.
//
// Refuses — rather than reassigning or pruning — when `fromUsername` is now
// held by a DIFFERENT current user than `userId`. That means the old
// identity was reclaimed by someone else (reservedUsernameConflict is
// supposed to prevent that at create/rename time; this is the defense-in-
// depth check for when it's bypassed some other way — an out-of-band edit,
// data older than that check). Blindly proceeding would hand that person's
// projects, or their credential tree at the same path, to the renamed
// account. This is the one case reconciliation cannot make progress on by
// itself — it stays pending until an admin resolves the naming conflict.
async function reconcileRenameCredentials({ userId, fromUsername, toUsername }){
 const currentUsers = await loadUsers();
 const claimant = currentUsers.find(u => u.username === fromUsername);
 if(claimant && claimant.id !== userId){
  throw new Error(`cannot reconcile: username "${fromUsername}" is now held by a different account — resolve the naming conflict before retrying`);
 }
 await withProjectsLock(async () => {
  const projects = await loadProjects();
  let changed = false;
  for(const p of projects){ if(p.primaryUser === fromUsername){ p.primaryUser = toUsername; changed = true; } }
  if(changed) await saveProjects(projects);
 });
 const projects = await loadProjects();
 for(const p of projects){ if(p.primaryUser === toUsername) await syncProjectCredentials(p); }
 await pruneUserCredentialTrees(currentUsers);
}

app.patch(BASE + '/api/users/:username', requireAdmin, async (req,res) => {
 try {
  const target = req.params.username;
  const newUsername = req.body?.username !== undefined ? String(req.body.username).trim() : undefined;
  const newRole = req.body?.role !== undefined ? String(req.body.role) : undefined;
  const newProjects = req.body?.projects !== undefined ? req.body.projects : undefined;
  const newToken = req.body?.ghToken !== undefined ? String(req.body.ghToken || '').trim() : undefined;
  const newDeployPw = DEPLOY_CENTRE && req.body?.deployPassword !== undefined ? String(req.body.deployPassword || '').trim() : undefined;

  // The ENTIRE operation — validating, mutating users.json, repointing
  // project.primaryUser references, resyncing git credentials, pruning the
  // old credential-tree namespace, and clearing the pending marker — runs
  // inside ONE cross-process lock acquisition. That is what makes "read the
  // marker, act on it, clear it" safe as a single atomic-feeling sequence: a
  // concurrent rename replacing the marker between our read and our clear
  // (the ABA this review round flagged) is now structurally impossible,
  // because nothing else — not another request in this process, not another
  // process — can be inside this same critical section at the same time.
  const result = await credentialDomain.withLocks(['lifecycle'], async () => {
   const users = await loadUsers();
   // Resolve by exact current username first; only falls back to an
   // unfinished rename's ORIGINAL name if there is no current match. This is
   // what makes a LITERAL replay of PATCH /api/users/alice {username:
   // "alicia"} idempotent even after users.json already committed the
   // rename to "alicia" — the URL still names "alice", which no longer
   // matches any current username, but does match the pending marker's
   // fromUsername.
   const u = resolveLifecycleTarget(users, target);
   if(!u) return { failure: { status:404, error:`User "${target}" not found` } };
   if(newUsername !== undefined){
    if(!validNewUsername(newUsername)) return { failure: { status:400, error:'Invalid username' } };
    if(newUsername !== u.username){
     if(users.some(x => x.username === newUsername)) return { failure: { status:409, error:`Username "${newUsername}" already exists` } };
     const reserveErr = reservedUsernameConflict(users, newUsername, u.id);
     if(reserveErr) return { failure: { status:409, error: reserveErr } };
    }
   }
   if(newRole !== undefined && !ROLES.includes(newRole)) return { failure: { status:400, error:`role must be one of: ${ROLES.join(', ')}` } };
   let projectsResolved = u.projects;
   if(newProjects !== undefined){
    try { projectsResolved = normalizeProjects(newProjects); } catch(e){ return { failure: { status:400, error: e.message } }; }
   }
   if(newRole !== undefined && newRole !== 'admin' && u.role === 'admin' && countAdmins(users) <= 1){
    return { failure: { status:409, error:'Refusing to demote the last admin (you would lock yourself out)' } };
   }
   const before = { username: u.username, role: u.role, projects: u.projects };
   const isNewRename = newUsername !== undefined && newUsername !== u.username;
   if(newUsername !== undefined) u.username = newUsername;
   if(newRole !== undefined) u.role = newRole;
   if(newProjects !== undefined) u.projects = projectsResolved;
   if(newToken !== undefined){ if(newToken) u.ghToken = encrypt(newToken); else delete u.ghToken; }
   if(newDeployPw !== undefined){ if(newDeployPw) u.deployPassword = encrypt(newDeployPw); else delete u.deployPassword; }
   if(isNewRename){
    // Chain from any UNFINISHED prior rename's original fromUsername (and
    // keep its opId's provenance implicit — a fresh opId below still
    // represents "the same logical rename operation, now including this
    // further name change"), so renaming again before the first
    // reconciliation ever succeeded still collapses to one reconciliation
    // (old1 -> old2 -> new), not two.
    u.pendingCredentialSync = { opId: crypto.randomUUID(), fromUsername: u.pendingCredentialSync?.fromUsername || before.username, toUsername: u.username };
   }
   // else: leave any existing u.pendingCredentialSync untouched — a retry
   // with no new rename in THIS request body still carries forward whatever
   // reconciliation was left unfinished, so the effect below can complete it.
   const opId = u.pendingCredentialSync?.opId || null;
   const tokenChanged = newToken !== undefined;
   await saveUsers(users);

   let stillPending = !!opId;
   if(opId || tokenChanged){
    try {
     if(opId){
      await reconcileRenameCredentials({ userId: u.id, fromUsername: u.pendingCredentialSync.fromUsername, toUsername: u.username });
      // Re-read fresh and clear ONLY if the opId we started with is still
      // the current one. Under this lock nothing else could have changed
      // it — this is the same ABA guard as a defense-in-depth belt, proven
      // in isolation by test/user-lifecycle-core.test.mjs.
      const freshAfterEffect = await loadUsers();
      const stillSame = freshAfterEffect.find(x => x.id === u.id);
      if(reconciliationStillCurrent(stillSame, opId)){
       delete stillSame.pendingCredentialSync;
       await saveUsers(freshAfterEffect);
       // Keep the record we're about to return to the caller (`u`, captured
       // before the effect ran) consistent with what was just persisted —
       // otherwise a successful same-request reconciliation would still
       // report a marker in THIS response that the very next GET wouldn't.
       delete u.pendingCredentialSync;
       stillPending = false;
      }
     } else {
      const projects = await loadProjects();
      for(const p of projects){ if(p.primaryUser === u.username) await syncProjectCredentials(p); }
     }
    } catch(e){
     throw new Error(`user "${u.username}" was updated in users.json, but syncing dependent project/credential state failed: ${e?.message || e}. users.json reflects the change${opId ? ' and a pending reconciliation marker was recorded' : ''}; retry this request${opId ? `, or POST ${BASE}/api/users/${encodeURIComponent(u.username)}/reconcile,` : ''} once the underlying issue is resolved.`);
    }
   }
   return { after: u, before, pending: stillPending };
  });

  if(result.failure) return res.status(result.failure.status).json({ ok:false, error: result.failure.error });
  await audit('user_update', { target, before: result.before, after: { username: result.after.username, role: result.after.role, projects: result.after.projects, hasToken: !!result.after.ghToken }, pendingCredentialSync: result.pending }, req);
  res.json({ ok:true, user: safeUserShape(result.after) });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// Explicit recovery for a rename whose reconciliation is stuck (surfaced via
// GET /api/users' pendingCredentialSync) — lets an admin retry it without
// having to reconstruct and resend the original rename request.
app.post(BASE + '/api/users/:username/reconcile', requireAdmin, async (req,res) => {
 try {
  const target = req.params.username;
  const result = await credentialDomain.withLocks(['lifecycle'], async () => {
   const users = await loadUsers();
   const u = resolveLifecycleTarget(users, target);
   if(!u) return { failure: { status:404, error:`User "${target}" not found` } };
   if(!u.pendingCredentialSync) return { pending:false, username: u.username };
   const opId = u.pendingCredentialSync.opId;
   await reconcileRenameCredentials({ userId: u.id, fromUsername: u.pendingCredentialSync.fromUsername, toUsername: u.username });
   const fresh = await loadUsers();
   const stillSame = fresh.find(x => x.id === u.id);
   if(reconciliationStillCurrent(stillSame, opId)){
    delete stillSame.pendingCredentialSync;
    await saveUsers(fresh);
   }
   return { pending:false, reconciled:true, username: u.username };
  });
  if(result.failure) return res.status(result.failure.status).json({ ok:false, error: result.failure.error });
  await audit('user_reconcile', { target: result.username }, req);
  res.json({ ok:true, pending: result.pending, reconciled: !!result.reconciled });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.post(BASE + '/api/users/:username/password', requireAdmin, async (req,res) => {
 try {
  if(AUTH_MODE === 'ldap') return res.status(400).json({ ok:false, error:'Passwords are managed by the directory (ldap mode)' });
  const target = req.params.username;
  const password = String(req.body?.password || '');
  if(password.length < 8) return res.status(400).json({ ok:false, error:'Password must be at least 8 characters' });
  const users = await loadUsers();
  if(!users.some(x => x.username === target)) return res.status(404).json({ ok:false, error:`User "${target}" not found` });
  // Hash before opening the transaction — it is slow by design, and holding the
  // store across it would serialize every other user write behind it.
  const passwordHash = await hashPassword(password);
  const updated = await withUsersLock((fresh)=>{ const rec = fresh.find(x => x.username === target); if(!rec) return false; rec.passwordHash = passwordHash; });
  if(updated.result === false) return res.status(404).json({ ok:false, error:`User "${target}" not found` });
  await audit('user_password_change', { target }, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

app.delete(BASE + '/api/users/:username', requireAdmin, async (req,res) => {
 try {
  const target = req.params.username;
  // The ENTIRE operation — snapshot, cleanup, and the final irreversible
  // removal — runs inside ONE cross-process lock acquisition, by the
  // victim's IMMUTABLE id throughout (never by username again, which a
  // concurrent rename or a recreate-under-the-vacated-name could otherwise
  // make point at the wrong account by the time phase 3 runs).
  const result = await credentialDomain.withLocks(['lifecycle'], async () => {
   // Phase 1: validate against a current snapshot WITHOUT mutating anything.
   // The identity itself is only removed in phase 3, once every dependent
   // piece of state has actually been revoked — see the phase-2 comment.
   const users = await loadUsers();
   const victim = resolveLifecycleTarget(users, target);
   if(!victim) return { failure: { status:404, error:`User "${target}" not found` } };
   if(isAdmin(victim) && countAdmins(users) <= 1){
    return { failure: { status:409, error:'Refusing to delete the last admin (you would lock yourself out)' } };
   }
   const remainingUsers = users.filter(u => u.id !== victim.id);
   // An unfinished rename (see reconcileRenameCredentials) can leave a
   // project still pointing at the OLD username while this record already
   // carries the CURRENT one. Deleting the identity must revoke that
   // reference too — but only if the old name has not since been reclaimed
   // by a different account, which now legitimately owns whatever it names.
   const oldName = victim.pendingCredentialSync?.fromUsername;
   const oldNameStillOurs = oldName && !remainingUsers.some(u => u.username === oldName);
   const namesToClear = new Set([victim.username, ...(oldNameStillOurs ? [oldName] : [])]);

   // Phase 2: revoke project references, git credentials, the per-user
   // credential tree, and sessions — BEFORE the irreversible identity
   // removal, and with failures propagating rather than being swallowed. If
   // any of this fails, the request aborts here: users.json is untouched,
   // so the operation is safely retryable (this is the primary cleanup
   // contract; boot-time pruning of orphaned credential trees remains
   // defense in depth only, for trees orphaned some other way — a
   // service-down window, an out-of-band edit of users.json).
   try {
    // Run every fallible step BEFORE persisting anything, so a later failure
    // (e.g. the credential-tree prune) cannot leave projects.json
    // half-revoked while the account still exists. syncProjectCredentials
    // is given the project as if its reference were already cleared
    // (remainingUsers already excludes the victim either way), so this is
    // safe to repeat on a retry.
    const projectsBeforeCleanup = await loadProjects();
    for(const p of projectsBeforeCleanup){
     if(namesToClear.has(p.primaryUser)) await syncProjectCredentials({ ...p, primaryUser: undefined });
    }
    await pruneUserCredentialTrees(remainingUsers);

    // Still holding the SAME (cross-process) lifecycle lock throughout, but
    // also acquire the established in-process project/session locks around
    // their own writes — belt and suspenders, and what keeps a completely
    // unrelated plain project edit (/manage/update, which never touches the
    // lifecycle lock) or a concurrent login/logout correctly serialized
    // against these specific writes too.
    await withProjectsLock(async () => {
     const fresh = await loadProjects();
     let changed = false;
     for(const p of fresh){ if(namesToClear.has(p.primaryUser)){ delete p.primaryUser; changed = true; } }
     if(changed) await saveProjects(fresh);
    });
    await withSessionsLock((sessions) => {
     const before = sessions.length;
     const kept = sessions.filter(s => s.userId !== victim.id);
     if(kept.length === before) return false;
     sessions.length = 0;
     sessions.push(...kept);
    });
   } catch(e){
    return { failure: { status:500, error:
     `could not fully revoke "${victim.username}"'s project references, git credentials, credential tree, or sessions, so the account was NOT deleted — retry once the underlying issue is fixed: ${e?.message || e}` } };
   }

   // Phase 3: the irreversible step, by IMMUTABLE ID. Re-read fresh (still
   // inside the lock — nothing else could have touched this record in the
   // meantime, but re-reading rather than reusing the phase-1 snapshot costs
   // nothing and defends against a future refactor that loosens that).
   const finalUsers = await loadUsers();
   const i = finalUsers.findIndex(u => u.id === victim.id);
   if(i < 0) return { failure: { status:404, error:`User "${target}" not found` } };
   if(isAdmin(finalUsers[i]) && countAdmins(finalUsers) <= 1){
    return { failure: { status:409, error:'Refusing to delete the last admin (you would lock yourself out)' } };
   }
   finalUsers.splice(i, 1);
   await saveUsers(finalUsers);
   return { removedUsername: victim.username };
  });

  if(result.failure) return res.status(result.failure.status).json({ ok:false, error: result.failure.error });
  await audit('user_delete', { target: result.removedUsername }, req);
  res.json({ ok:true });
 } catch(e){ res.status(500).json({ ok:false, error: e.message || String(e) }); }
});

// ============================================================================
// System status / readiness (admin-only). Used by Settings → System tab and
// by the first-run wizard auto-trigger to decide whether to prompt.
// ============================================================================
app.get(BASE + '/api/system/status', requireAdmin, async (_req,res) => {
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
app.get(BASE + '/api/system/firstrun', async (_req,res) => {
 try {
  const [claudeVersion, users, claudeAuth] = await Promise.all([getClaudeVersion(), loadUsers(), getCliAuth('claude')]);
  const needed = claudeVersion === 'unavailable' || !claudeAuth || users.length === 0;
  res.json({ ok:true, firstRunNeeded: needed });
 } catch { res.json({ ok:true, firstRunNeeded: false }); }
});

if(DEPLOY_CENTRE){
 const fmtDeployLog = (entry) => entry ? `${entry.ts?.replace('T',' ').replace(/\.\d+Z/,' UTC')} by ${entry.user}` : 'Never deployed';

 async function deployPageCard(p, cfg, isAdmin){
  const devCfg = cfg[p.name]?.dev || {};
  const prodCfg = cfg[p.name]?.prod || {};
  const devSlot = deploySlot(p,'dev'); const prodSlot = deploySlot(p,'prod');
  const devOptSel = deployOptionSelect(devSlot); const prodOptSel = deployOptionSelect(prodSlot);
  const localVersion = await getLocalVersion(p.path || workspacePath(p.name));
  const log = await readDeployLog(p.name);
  const devLog = log.filter(e=>e.target==='dev').slice(-1)[0];
  const prodLog = log.filter(e=>e.target==='prod').slice(-1)[0];
  return `<div class="project-card" data-project="${esc(p.name)}">
   <h2>${esc(p.name)}</h2>
   <div class="local-version">Source: <span class="version source"${localVersion?.hash?` title="newest source change in the working copy · HEAD ${esc(localVersion.hash)}"`:''}>${esc(localVersion?.version||'—')}</span></div>
   <div class="targets">
    <div class="target-card dev" data-project="${esc(p.name)}" data-target="dev" data-probeable="${devCfg.versionCmd?'1':'0'}" data-label="${esc(devSlot.label)}"${devCfg.reauth?' data-reauth="1"':''}>
     <h3>${devSlot.icon?esc(devSlot.icon)+' ':''}${esc(devSlot.label)}</h3>
     <div class="version-line">Version: <span class="version current-version">—</span>${devCfg.versionCmd?`<button class="button secondary small probe-btn" type="button" title="Re-check deployed version">↻</button>`:''}</div>
     <div class="last-deploy">Last: <span class="last-deploy-info">${esc(fmtDeployLog(devLog))}</span></div>
     ${devCfg.script ? `${devOptSel}<button class="button small deploy-btn" type="button">Deploy</button>` : (isAdmin ? `<span class="no-config">Configure script below</span>` : `<span class="no-config">Not configured</span>`)}
     <div class="deploy-output"></div>
     ${isAdmin ? `<div class="config-section">
      <label>Deploy script (bash)</label>
      <textarea class="deploy-script" placeholder="#!/bin/bash&#10;ssh devserver 'cd /app && git pull && npm install && pm2 restart all'">${esc(devCfg.script||'')}</textarea>
      <label>Version check command</label>
      <input class="version-cmd" placeholder="ssh devserver 'cat /app/package.json | jq -r .version'" value="${esc(devCfg.versionCmd||'')}">
      <button class="button secondary small save-config" type="button" style="margin-top:.5rem">Save</button>
     </div>` : ''}
    </div>
    <div class="target-card prod" data-project="${esc(p.name)}" data-target="prod" data-probeable="${prodCfg.versionCmd?'1':'0'}" data-label="${esc(prodSlot.label)}"${prodCfg.reauth?' data-reauth="1"':''}>
     <h3>${prodSlot.icon?esc(prodSlot.icon)+' ':''}${esc(prodSlot.label)}</h3>
     <div class="version-line">Version: <span class="version current-version">—</span>${prodCfg.versionCmd?`<button class="button secondary small probe-btn" type="button" title="Re-check deployed version">↻</button>`:''}</div>
     <div class="last-deploy">Last: <span class="last-deploy-info">${esc(fmtDeployLog(prodLog))}</span></div>
     ${prodCfg.script ? `${prodOptSel}<button class="button danger small deploy-btn" type="button">Deploy</button>` : (isAdmin ? `<span class="no-config">Configure script below</span>` : `<span class="no-config">Not configured</span>`)}
     <div class="deploy-output"></div>
     ${isAdmin ? `<div class="config-section">
      <label>Deploy script (bash)</label>
      <textarea class="deploy-script" placeholder="#!/bin/bash&#10;ssh prodserver 'cd /app && git pull origin main && npm ci --production && pm2 restart all'">${esc(prodCfg.script||'')}</textarea>
      <label>Version check command</label>
      <input class="version-cmd" placeholder="ssh prodserver 'cat /app/package.json | jq -r .version'" value="${esc(prodCfg.versionCmd||'')}">
      <button class="button secondary small save-config" type="button" style="margin-top:.5rem">Save</button>
     </div>` : ''}
    </div>
   </div>
   <button class="button secondary small toggle-log" type="button" style="margin-top:.8rem">Show history</button>
   <div class="deploy-log" style="display:none"></div>
  </div>`;
 }

 async function deployModalCard(p, cfg, isAdmin, deployEnv){
  const devCfg = cfg[p.name]?.dev || {};
  const prodCfg = cfg[p.name]?.prod || {};
  const devSlot = deploySlot(p,'dev'); const prodSlot = deploySlot(p,'prod');
  const devOptSel = deployOptionSelect(devSlot); const prodOptSel = deployOptionSelect(prodSlot);
  const [devVersion, prodVersion, localVersion, allLog] = await Promise.all([
   getDeployedVersion(p.name,'dev',cfg,deployEnv),
   getDeployedVersion(p.name,'prod',cfg,deployEnv),
   getLocalVersion(p.path || workspacePath(p.name)),
   readDeployLog(p.name)
  ]);
  const devLog = allLog.filter(e=>e.target==='dev').slice(-1)[0];
  const prodLog = allLog.filter(e=>e.target==='prod').slice(-1)[0];
  const historyRows = allLog.slice().reverse().slice(0,50).map(e => `<tr><td>${esc(e.ts?.replace('T',' ').replace(/\.\d+Z/,' UTC')||'')}</td><td>${esc(e.target||'')}</td><td class="${e.status==='success'||e.ok?'ok':'fail'}">${e.status==='success'||e.ok?'✅ OK':'❌ Failed'}</td><td>${esc(e.version||'—')}</td><td>${esc(e.user||'')}</td><td>${e.duration?e.duration+'s':'—'}</td></tr>`).join('');
  return `<div class="deploy-tabs"><button class="deploy-tab active" data-tab="deploy-panel">Deploy</button><button class="deploy-tab" data-tab="history-panel">History</button></div>
   <div id="deploy-panel" class="deploy-tab-panel">
   <div class="local-version">Source: <span class="version source"${localVersion?.hash?` title="newest source change in the working copy · HEAD ${esc(localVersion.hash)}"`:''}>${esc(localVersion?.version||'—')}</span></div>
   <div class="targets">
    <div class="target-card dev" data-project="${esc(p.name)}" data-target="dev" data-label="${esc(devSlot.label)}"${devCfg.reauth?' data-reauth="1"':''}>
     <h3>${devSlot.icon?esc(devSlot.icon)+' ':''}${esc(devSlot.label)}</h3>
     <div>Version: <span class="version current-version">${esc(devVersion||'—')}</span>${sourceNewerBadge(localVersion?.version, devVersion)}</div>
     <div class="last-deploy">Last: <span class="last-deploy-info">${esc(fmtDeployLog(devLog))}</span></div>
     ${devCfg.script ? `${devOptSel}<button class="button small deploy-btn" type="button">Deploy</button>` : `<span class="no-config">Not configured</span>`}
     <div class="deploy-output"></div>
     ${isAdmin ? `<div class="config-section">
      <label>Deploy script (bash)</label>
      <textarea class="deploy-script">${esc(devCfg.script||'')}</textarea>
      <label>Version check command</label>
      <input class="version-cmd" value="${esc(devCfg.versionCmd||'')}">
      <button class="button secondary small save-config" type="button" style="margin-top:.5rem">Save</button>
     </div>` : ''}
    </div>
    <div class="target-card prod" data-project="${esc(p.name)}" data-target="prod" data-label="${esc(prodSlot.label)}"${prodCfg.reauth?' data-reauth="1"':''}>
     <h3>${prodSlot.icon?esc(prodSlot.icon)+' ':''}${esc(prodSlot.label)}</h3>
     <div>Version: <span class="version current-version">${esc(prodVersion||'—')}</span>${sourceNewerBadge(localVersion?.version, prodVersion)}</div>
     <div class="last-deploy">Last: <span class="last-deploy-info">${esc(fmtDeployLog(prodLog))}</span></div>
     ${prodCfg.script ? `${prodOptSel}<button class="button danger small deploy-btn" type="button">Deploy</button>` : `<span class="no-config">Not configured</span>`}
     <div class="deploy-output"></div>
     ${isAdmin ? `<div class="config-section">
      <label>Deploy script (bash)</label>
      <textarea class="deploy-script">${esc(prodCfg.script||'')}</textarea>
      <label>Version check command</label>
      <input class="version-cmd" value="${esc(prodCfg.versionCmd||'')}">
      <button class="button secondary small save-config" type="button" style="margin-top:.5rem">Save</button>
     </div>` : ''}
    </div>
   </div>
   </div>
   <div id="history-panel" class="deploy-tab-panel" style="display:none">
    ${allLog.length ? `<table class="log-table"><thead><tr><th>Time</th><th>Target</th><th>Result</th><th>Version</th><th>User</th><th>Duration</th></tr></thead><tbody>${historyRows}</tbody></table>` : `<p class="muted">No deployment history yet.</p>`}
   </div>`;
 }

 app.get(BASE + '/deploy', requireAuth, async (req,res)=>{
  const isAdmin = req.user?.role === 'admin';
  const projects = await loadProjects();
  const cfg = await loadDeployConfig();
  const visibleProjects = filterProjectsForUser(projects, req.user);
  const cards = await Promise.all(visibleProjects.map(p => deployPageCard(p, cfg, isAdmin)));
  const noProjects = visibleProjects.length === 0 ? `<p class="muted">No projects configured. <a href="${BASE}/manage">Add a project</a> first.</p>` : '';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deployment Centre — Project Workbench</title><style>${deployCss}</style></head><body class="deploy-page"><div class="top"><div><h1>Deployment Centre</h1><p class="subtitle">Deploy projects to dev or production servers</p></div><div class="top-actions"><button id="probe-all" class="button secondary" type="button" title="Re-check the deployed version for every project">↻ Probe all</button><a class="button secondary" href="${BASE}/">Dashboard</a></div></div>${noProjects}${cards.join('\n')}${deployScript}</body></html>`);
 });

 app.post(BASE + '/api/deploy/config', requireAdmin, async (req,res)=>{
  try {
   const { project, target, script, versionCmd } = req.body || {};
   if(!project || !validName(project)) return res.status(400).json({ok:false,error:'Invalid project name'});
   if(!['dev','prod'].includes(target)) return res.status(400).json({ok:false,error:'Target must be dev or prod'});
   if(project === '__proto__' || project === 'constructor' || project === 'prototype') return res.status(400).json({ok:false,error:'Invalid project name'});
   const cfg = await loadDeployConfig();
   if(!cfg[project]) cfg[project] = {};
   cfg[project][target] = { ...(cfg[project][target]||{}), script: String(script||'').trim(), versionCmd: String(versionCmd||'').trim() };
   await saveDeployConfig(cfg);
   await audit('deploy_config_update', { project, target }, req);
   res.json({ok:true});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
 });

 app.get(BASE + '/api/deploy/status', requireAuth, async (req,res)=>{
  try {
   const projects = filterProjectsForUser(await loadProjects(), req.user);
   const cfg = await loadDeployConfig();
   const users = await loadUsers();
   const currentUser = users.find(u => u.username === req.user?.username);
   const deployEnv = getDeployEnv(users, currentUser);
   const status = await Promise.all(projects.map(async p => ({
    name: p.name,
    dev: { version: await getDeployedVersion(p.name,'dev',cfg,deployEnv), configured: !!(cfg[p.name]?.dev?.script) },
    prod: { version: await getDeployedVersion(p.name,'prod',cfg,deployEnv), configured: !!(cfg[p.name]?.prod?.script) },
   })));
   res.json({ok:true, projects: status});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
 });

 app.post(BASE + '/api/deploy/:project/:target', requireAuth, requireProjectAccess, async (req,res)=>{
  const { project, target } = req.params;
  if(!validName(project)) return res.status(400).json({ok:false,error:'Invalid project name'});
  if(!['dev','prod'].includes(target)) return res.status(400).json({ok:false,error:'Target must be dev or prod'});
  const p = await projectByName(project);
  if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
  const cfg = await loadDeployConfig();
  const tc = cfg[project]?.[target];
  if(!tc || !tc.script) return res.status(400).json({ok:false,error:`No deployment script configured for ${project}/${target}`});
  const users = await loadUsers();
  const currentUser = users.find(u => u.username === req.user?.username);
  const submitted = req.body?.password || '';
  let storedPw = '';
  if(currentUser?.deployPassword){ try { storedPw = decrypt(currentUser.deployPassword); } catch { storedPw = ''; } }
  // Verify the saved password first (no prompt); the client only asks the user
  // when the server answers needPassword. See app/deploy-reauth.js.
  const decision = await resolveDeployReauth({
   reauth: !!tc.reauth, submitted, stored: storedPw, savePassword: !!req.body?.savePassword,
   verify: (pw) => authenticate(req.user?.username, pw),
  });
  if(!decision.ok){
   await audit('deploy_reauth_failed', { project, target, staleStored: decision.staleStored }, req);
   return res.status(401).json({ ok:false, needPassword:true, staleStored: decision.staleStored, error: decision.error });
  }
  const effectivePassword = decision.password;
  // Persist a freshly-entered password if the user opted in (encrypted at rest).
  // Re-resolve the record inside the store: `users` above was read before the
  // directory bind and is now potentially stale.
  if(decision.save){
   try {
    await withUsersLock((users)=>{ const rec = users.find(x => x.username === req.user?.username); if(!rec) return false; rec.deployPassword = encrypt(submitted); });
   }
   catch(e){ /* non-fatal: the deploy still proceeds if saving fails */ }
  }
  const allowedOpts = (deploySlot(p, target).options || []).map(o => String(o.value));
  let option = String(req.body?.option || '').trim();
  if(allowedOpts.length){ if(!option) option = allowedOpts[0]; if(!allowedOpts.includes(option)) return res.status(400).json({ok:false,error:'Invalid option for this slot'}); }
  else option = '';
  const deployPassword = effectivePassword || '';
  const deployUser = currentUser?.deployUser || currentUser?.username || req.user?.username || '';
  const start = Date.now();
  let output = '', status = 'success', version = null;
  try {
   const result = await deployExec(tc, ['bash','-c',tc.script,'pw-deploy',option], {...process.env, DEPLOY_PROJECT:project, DEPLOY_TARGET:target, DEPLOY_USER:deployUser, DEPLOY_PASSWORD:deployPassword, DEPLOY_OPTION:option}, 300000);
   output = (result.stdout || '') + (result.stderr || '');
  } catch(e) {
   status = 'failed';
   output = (e.stdout || '') + (e.stderr || '') + '\n' + (e.message || '');
  }
  const duration = ((Date.now()-start)/1000).toFixed(1);
  if(tc.versionCmd){
   try { const { stdout } = await deployExec(tc, ['bash','-c',tc.versionCmd], {...process.env, DEPLOY_USER:deployUser, DEPLOY_PASSWORD:deployPassword, DEPLOY_OPTION:option}, 30000); version = stdout.trim()||null; } catch {}
  }
  const logEntry = { ts: new Date().toISOString(), project, target, option: option||undefined, version, user: req.user?.username||'unknown', status, duration, outputSnippet: output.slice(0,500) };
  await appendDeployLog(logEntry);
  await audit('deploy_execute', { project, target, option: option||undefined, status, version, duration }, req);
  // Report the recomputed comparison rather than leaving the client to redo it:
  // the badge is now wrong the instant a deploy lands, and the server is the only
  // side that knows how a release stamp is ordered.
  const srcNow = await getLocalVersion(p.path || workspacePath(p.name));
  res.json({ ok: status==='success', status, output: output.slice(0,5000), version, duration, user: req.user?.username,
   sourceNewer: sourceNewer(srcNow?.version, version), sourceVersion: srcNow?.version || null });
 });

 app.get(BASE + '/api/deploy/:project/log', requireAuth, requireProjectAccess, async (req,res)=>{
  try { res.json({ok:true, log: await readDeployLog(req.params.project)}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
 });

 app.get(BASE + '/api/deploy/:project/:target/version', requireAuth, requireProjectAccess, async (req,res)=>{
  try {
   const { project, target } = req.params;
   if(!validName(project)) return res.status(400).json({ok:false,error:'Invalid project name'});
   if(!['dev','prod'].includes(target)) return res.status(400).json({ok:false,error:'Target must be dev or prod'});
   const cfg = await loadDeployConfig();
   const tc = cfg[project]?.[target];
   if(!tc?.versionCmd) return res.json({ok:true, version:null, configured:false});
   const users = await loadUsers();
   const currentUser = users.find(u => u.username === req.user?.username);
   const deployEnv = getDeployEnv(users, currentUser);
   const version = await getDeployedVersion(project, target, cfg, deployEnv);
   res.json({ok:true, version, configured:true});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
 });

 app.get(BASE + '/api/deploy/:project/card', requireAuth, requireProjectAccess, async (req,res)=>{
  try {
   const projectName = req.params.project;
   const p = await projectByName(projectName);
   if(!p) return res.status(404).json({ok:false,error:'Unknown project'});
   const isAdmin = req.user?.role === 'admin';
   const cfg = await loadDeployConfig();
   const users = await loadUsers();
   const currentUser = users.find(u => u.username === req.user?.username);
   const deployEnv = getDeployEnv(users, currentUser);
   res.json({ok:true, html: await deployModalCard(p, cfg, isAdmin, deployEnv)});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
 });
}

app.use((err,_req,res,_next)=>{ console.error(err); res.status(500).type('html').send(`<h1>Workbench error</h1><pre>${esc(err.message || err)}</pre><p><a href="${BASE}/manage">Back to Manage</a></p>`); });
const PORT = parseInt(process.env.PORT || '3000', 10);
const srv = app.listen(PORT,'127.0.0.1',()=>{
 console.log(`dashboard listening on 127.0.0.1:${PORT}`);
 console.log(`[deploy-mode] ${DEPLOY_MODE}`);
 if(!ISOLATED && PER_USER_CLAUDE){
  pruneUserCredentialTrees()
   .then(r => { if(r.removed?.length) console.log(`[per-user-claude] pruned ${r.removed.length} orphaned credential tree(s)`); })
   .catch(e => console.warn(`[per-user-claude] boot credential prune failed: ${e?.message || e}`));
 }
 // Before the host-mode return, because a host install is exactly where the
 // pre-boundary boxes are. Failure is logged, never fatal: a dashboard that
 // cannot repair an old box must still serve every project whose box is fine.
 repairLegacyBoxOwnership()
  .then(r => {
   for(const b of r.repaired) console.log(`[boxes] handed ${b.dir} back to the terminal owner`);
   for(const b of r.refused) console.warn(`[boxes] NOT repaired: ${b.dir} — ${b.reason}`);
  })
  .catch(e => console.warn(`[boxes] boot ownership repair failed: ${e?.message || e}`));
 // Armed for BOTH modes and before the host-mode return: a scheduled task runs
 // through newTmuxWindow(), which works in host mode too, so gating it on
 // container mode would silently give host installs a UI that never fires.
 // Never in an isolated instance — those point at real projects.
 if(!ISOLATED) startTaskScheduler();
 if(DEPLOY_MODE === 'host'){ if(!ISOLATED) sweepOrphanTmuxSessions(); return; }
 if(ISOLATED){ console.log('[isolated] skipping tmux/ttyd/nginx auto-start'); return; }
 sweepOrphanTmuxSessions();
 setTimeout(async ()=>{
  try {
   const projects = await loadProjects();
   for(const p of projects){
    try { await startProject(p); console.log(`[boot] started terminal for ${p.name} on port ${p.port}`); }
    catch(e){ console.error(`[boot] failed to start ${p.name}:`, e.message); }
   }
   await applyRouting(projects);
   console.log(`[boot] auto-start complete (${projects.length} project${projects.length===1?'':'s'})`);
  } catch(e){ console.error('[boot] auto-start error:', e.message); }
 }, 2000);
});
// Streamed inbox uploads can legitimately outlast Node's 300s default request
// timeout (multi-GB zips over Wi-Fi). Headers still time out, so idle-connection
// protection remains.
srv.requestTimeout = 0;
