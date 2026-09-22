// Like preload-harness.mjs, execute real server source in a VM with explicit
// boundary doubles. No host services, production stores, or Linux login locks.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DeployManifestError, resolveDeployManifest, validateDeployInputs } from '../app/deploy-manifest.js';
import { deployInputNotice, deployInputsClientSrc, describeDeploySelection, renderDeployInputs } from '../app/deploy-inputs.js';
import { deployCss } from '../app/deploy-css.js';
import { resolveDeployReauth } from '../app/deploy-reauth.js';
import { agentSpawnDrop, resolveTerminalPriv } from '../app/terminal-priv.js';
import { deploymentSubmitClientSrc, renderDeploymentNotice, renderExecutionRecipe } from '../app/deployment/ui.js';
import { deploymentFailure, deploymentHistoryEntry, requireDeploymentOrigin } from '../app/deployment/pw.js';
import { DeploymentError, validateRecipe } from '../app/deployment/protocol.js';

export const serverSource = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = value => JSON.parse(JSON.stringify(value));

function section(start, end) {
 const from = serverSource.indexOf(start), to = serverSource.indexOf(end, from + start.length);
 if (from < 0 || to < 0) throw new Error(`Server harness seam missing: ${start}`);
 return serverSource.slice(from, to);
}
export function functionSource(name) {
 const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(serverSource);
 if (!match) throw new Error(`Server function missing: ${name}`);
 const rest = serverSource.slice(match.index);
 const end = rest.slice(1).search(/\n(?:async function |function |const |let |app\.)/);
 return end < 0 ? rest : rest.slice(0, end + 1);
}
// The deployment section as the harness executes it, and the server's own top-level functions that
// it calls. The harness hand-declares that dependency list, and nothing used to notice when the
// production section grew a call the list did not carry: 5d17c94 added reclaimWorkspaceOwnership()
// to the deploy route and every runAsRoot route test started throwing
// "ReferenceError: reclaimWorkspaceOwnership is not defined" from a synthesized filename. These two
// exports let a test hold the list to the source. See deploy-ownership-reclaim.test.mjs.
export const deploymentSection = () => section('if(DEPLOY_CENTRE){\n const fmtDeployLog', '\napp.use((err,_req,res,_next)');
export function deploymentSectionCallees() {
 const declared = [...serverSource.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)].map(match => match[1]);
 const body = deploymentSection();
 // Own-name calls only: a bounded, enumerable set (the server's top-level functions), matched where
 // they are CALLED and not as a property, so this needs no JavaScript parser to stay exact.
 return [...new Set(declared)].filter(name => new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(body)).sort();
}

export function serverTemplate(name) {
 const match = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\n').exec(serverSource);
 if (!match) throw new Error(`Server template missing: ${name}`);
 return vm.runInNewContext('`' + match[1] + '`', { BASE: '/pw', deployInputsClientSrc, deploymentSubmitClientSrc });
}

// scripts/ is a sibling of app/ in every deployment, and server.js builds this exact path for the
// ownership tool. The harness uses the real path so a route test proves which tool the deploy would
// run, not merely that it ran something.
export const FIX_OWNERSHIP_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pw-fix-workspace-ownership');

export function deployRouteHarness(root, options = {}) {
 const routes = new Map(), executions = [], audit = [], history = [], boundaryCalls = [], reclaims = [];
 const project = { name: 'demo', path: root, ...options.project };
 let config = options.config || { demo: { dev: { script: 'legacy-saved-script', versionCmd: 'legacy-version-command', reauth: false } } };
 const user = { username: 'operator', role: 'admin', projects: '*', ...options.user };
 const users = [{ ...user, ...options.storedUser }];
 let credentialReads = 0, sourceReads = 0, saves = 0;
 const middleware = {
  requireAuth(req, res, next) { boundaryCalls.push('auth'); return req.user ? next() : res.status(401).json({ ok: false }); },
  requireProjectAccess(req, res, next) {
   boundaryCalls.push('project');
   return req.user?.role === 'admin' || req.user?.projects?.includes(req.params.project) ? next() : res.status(403).json({ ok: false });
  },
  requireAdmin(req, res, next) { boundaryCalls.push('admin'); return req.user?.role === 'admin' ? next() : res.status(403).json({ ok: false }); },
 };
 const nativeExec = promisify(execFile);
 const context = {
  BASE: '/pw', DEPLOY_CENTRE: true, deployCss, deployInputsClientSrc,
  DeployManifestError, resolveDeployManifest, validateDeployInputs, resolveDeployReauth,
  deployInputNotice, describeDeploySelection, renderDeployInputs, agentSpawnDrop,
  deploymentSubmitClientSrc, renderDeploymentNotice, renderExecutionRecipe, deploymentFailure, deploymentHistoryEntry, requireDeploymentOrigin, DeploymentError, validateRecipe,
  deploymentService: options.deploymentService || { client: async () => null },
  TERMINAL_PRIV: resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001', PW_TERMINAL_USER: 'pane' }),
  process: { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: options.nativeExec ? root : '/root', USER: 'root', LOGNAME: 'root', DEPLOY_OPTION: 'must-not-leak' } },
  console,
  app: {
   get: (url, ...handlers) => routes.set(`GET ${url}`, handlers),
   post: (url, ...handlers) => routes.set(`POST ${url}`, handlers),
  },
  ...middleware,
  loadDeployConfig: async () => structuredClone(config),
  saveDeployConfig: async next => { config = plain(next); saves++; },
  loadProjects: async () => [project],
  filterProjectsForUser: projects => projects,
  projectByName: async name => name === project.name ? project : null,
  workspacePath: () => root,
  workspaceRoot: root,
  FIX_OWNERSHIP_HELPER,
  loadUsers: async () => { credentialReads++; return users; },
  decrypt: value => value.replace(/^sealed:/, ''),
  encrypt: value => `sealed:${value}`,
  withUsersLock: async mutate => { saves++; return mutate(users); },
  authenticate: async (username, password) => {
   if (options.onAuthenticate) await options.onAuthenticate(username, password);
   return password === 'good-password' ? user : null;
  },
  appendDeployLog: async entry => history.push(plain(entry)),
  readDeployLog: async () => history.map(plain),
  audit: async (event, detail) => audit.push({ event, ...plain(detail) }),
  getLocalVersion: async () => { sourceReads++; return { version: 'V1.26.0909.1200', hash: 'abc123' }; },
  execFileAsync: async (file, args, execOptions) => {
   const execution = { file, args: [...args], options: { ...execOptions, env: { ...execOptions.env } } };
   // The ownership reclaim is its own seam, kept out of `executions`: that array is the DEPLOY
   // command the operator's slot runs, and an assertion about it must not be satisfiable — or
   // broken — by a maintenance tool that happens to run as root right after. Its default result is
   // silent so deploy-output fixtures stay exactly what the deploy script printed; onReclaim gives
   // a test the real production shape (output appended, failures swallowed).
   if (file === FIX_OWNERSHIP_HELPER) {
    reclaims.push(execution);
    return options.onReclaim ? options.onReclaim(execution) : { stdout: '', stderr: '' };
   }
   executions.push(execution);
   if (options.nativeExec) {
    if (file !== 'bash') throw new Error('The native deployment harness only executes Bash fixtures.');
    // Login profiles belong to the machine, not the fixture. Their stderr is
    // combined with stdout by the real route and must not pollute its JSON probe.
    execution.nativeArgs = ['--noprofile', '--norc', ...args];
    execution.result = await nativeExec(file, execution.nativeArgs, execOptions);
    return execution.result;
   }
   return options.onExec ? options.onExec(executions.at(-1)) : { stdout: 'deployed-ok', stderr: '' };
  },
 };
 vm.createContext(context);
 const helpers = [
  functionSource('esc'), functionSource('validName'), functionSource('deployExec'),
  functionSource('getDeployedVersion'), functionSource('getDeployEnv'),
  functionSource('deploymentHistory'),
  functionSource('reclaimWorkspaceOwnership'),
  section('const DEFAULT_DEPLOY_SLOTS = ', 'async function getLocalVersion('),
  section('const DEPLOY_BACKENDS = ', 'async function getDeployedVersion('),
  section('const DEPLOY_STAMP_RE = ', 'function hasDeployConfigFor('),
 ].join('\n');
 const deployment = section('if(DEPLOY_CENTRE){\n const fmtDeployLog', '\napp.use((err,_req,res,_next)');
 vm.runInContext(helpers + '\n' + deployment, context, { filename: 'server-deployment-routes.js' });
 context.deployScript = serverTemplate('deployScript');
 return {
  routes, executions, audit, history, middleware, boundaryCalls, users, reclaims, context,
  get config() { return config; },
  get credentialReads() { return credentialReads; },
  get sourceReads() { return sourceReads; },
  get saves() { return saves; },
  async call(method, route, { body = {}, params = {}, caller = user, headers = {}, query = {} } = {}) {
   const handlers = routes.get(`${method} /pw${route}`);
   if (!handlers) throw new Error(`Unknown harness route ${method} ${route}`);
   const requestHeaders = { host: 'workbench.example.test', origin: 'http://workbench.example.test', ...headers };
   const req = { body, params, user: caller, query, protocol: 'http', get: name => requestHeaders[name.toLowerCase()] };
   const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = plain(value); return this; },
    type() { return this; },
    send(value) { this.html = value; return this; },
   };
   let index = 0;
   const next = async () => {
    const handler = handlers[index++];
    if (handler) return handler(req, res, next);
   };
   await next();
   return res;
  },
 };
}
