// Like preload-harness.mjs, execute real server source in a VM with explicit
// boundary doubles. No host services, production stores, or Linux login locks.
import fs from 'node:fs';
import vm from 'node:vm';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DeployManifestError, resolveDeployManifest, validateDeployInputs } from '../app/deploy-manifest.js';
import { deployInputNotice, deployInputsClientSrc, describeDeploySelection, renderDeployInputs } from '../app/deploy-inputs.js';
import { deployCss } from '../app/deploy-css.js';
import { resolveDeployReauth } from '../app/deploy-reauth.js';
import { agentSpawnDrop, resolveTerminalPriv } from '../app/terminal-priv.js';

export const serverSource = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const plain = value => JSON.parse(JSON.stringify(value));

function section(start, end) {
 const from = serverSource.indexOf(start), to = serverSource.indexOf(end, from + start.length);
 if (from < 0 || to < 0) throw new Error(`Server harness seam missing: ${start}`);
 return serverSource.slice(from, to);
}
function functionSource(name) {
 const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(serverSource);
 if (!match) throw new Error(`Server function missing: ${name}`);
 const rest = serverSource.slice(match.index);
 const end = rest.slice(1).search(/\n(?:async function |function |const |let |app\.)/);
 return end < 0 ? rest : rest.slice(0, end + 1);
}
export function serverTemplate(name) {
 const match = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\n').exec(serverSource);
 if (!match) throw new Error(`Server template missing: ${name}`);
 return vm.runInNewContext('`' + match[1] + '`', { BASE: '/pw', deployInputsClientSrc });
}

export function deployRouteHarness(root, options = {}) {
 const routes = new Map(), executions = [], audit = [], history = [], boundaryCalls = [];
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
  TERMINAL_PRIV: resolveTerminalPriv({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001', PW_TERMINAL_USER: 'pane' }),
  process: { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: '/root', USER: 'root', LOGNAME: 'root', DEPLOY_OPTION: 'must-not-leak' } },
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
   executions.push({ file, args: [...args], options: { ...execOptions, env: { ...execOptions.env } } });
   if (options.nativeExec) return nativeExec(file, args, execOptions);
   return options.onExec ? options.onExec(executions.at(-1)) : { stdout: 'deployed-ok', stderr: '' };
  },
 };
 vm.createContext(context);
 const helpers = [
  functionSource('esc'), functionSource('validName'), functionSource('deployExec'),
  functionSource('getDeployedVersion'), functionSource('getDeployEnv'),
  section('const DEFAULT_DEPLOY_SLOTS = ', 'async function getLocalVersion('),
  section('const DEPLOY_STAMP_RE = ', 'function hasDeployConfigFor('),
 ].join('\n');
 const deployment = section('if(DEPLOY_CENTRE){\n const fmtDeployLog', '\napp.use((err,_req,res,_next)');
 vm.runInContext(helpers + '\n' + deployment, context, { filename: 'server-deployment-routes.js' });
 context.deployScript = serverTemplate('deployScript');
 return {
  routes, executions, audit, history, middleware, boundaryCalls, users,
  get config() { return config; },
  get credentialReads() { return credentialReads; },
  get sourceReads() { return sourceReads; },
  get saves() { return saves; },
  async call(method, route, { body = {}, params = {}, caller = user } = {}) {
   const handlers = routes.get(`${method} /pw${route}`);
   if (!handlers) throw new Error(`Unknown harness route ${method} ${route}`);
   const req = { body, params, user: caller };
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
