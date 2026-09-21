import crypto from 'node:crypto';
import { DeploymentClient } from './client.js';
import {
  API_VERSION, DeploymentError, validateJob, validateRecipe, TERMINAL_STATES,
} from './protocol.js';

export function deploymentFailure(res, error) {
  const known = error instanceof DeploymentError;
  return res.status(known ? error.statusCode : 500).json({ ok: false,
    error: known ? error.message : 'Deployment service operation failed. No local fallback or automatic retry was attempted.',
    code: known ? error.code : 'deployment_service_error' });
}

export function requireDeploymentOrigin(req, res, next) {
  const host = req.get('host') || '';
  const forwarded = req.get('x-forwarded-proto');
  const protocol = forwarded || req.protocol || (req.socket?.encrypted ? 'https' : 'http');
  let origin = '', expected = '';
  try {
    const destination = new URL(`${protocol}://${host}`);
    const claimed = new URL(req.get('origin') || req.get('referer') || '');
    if (!destination.username && !destination.password && destination.pathname === '/') expected = destination.origin;
    if (!claimed.username && !claimed.password && (!req.get('origin') || (claimed.pathname === '/' && !claimed.search && !claimed.hash))) origin = claimed.origin;
  } catch { /* An invalid origin is refused below, never treated as loopback. */ }
  if (!['http', 'https'].includes(protocol) || !host || !origin || origin !== expected
      || req.get('sec-fetch-site') === 'cross-site') {
    return deploymentFailure(res, new DeploymentError('CSRF check failed: a same-origin browser request is required.', 403, 'deployment_csrf'));
  }
  return next();
}

function assertManifestSource(manifest, source, target) {
  if (!manifest) return;
  const file = source.files.find(entry => entry.path === '.pw/deploy.json');
  let slot;
  try { slot = JSON.parse(Buffer.from(file?.data || '', 'base64').toString('utf8')).slots?.[target]; }
  catch { throw new DeploymentError('The displayed deployment manifest is not in the selected commit.', 409, 'deployment_manifest_changed'); }
  if (!slot || (slot.script ?? '') !== (manifest.script ?? '')
      || JSON.stringify(validateRecipe(slot.execution)) !== JSON.stringify(validateRecipe(manifest.execution))) {
    throw new DeploymentError('The committed deployment recipe differs from the displayed recipe. Reopen deployment.', 409, 'deployment_manifest_changed');
  }
}

export function buildDeploymentJob({
  project, target, snapshot, config, manifest = null, selection = null, option = '',
  execution, deployUser = '', deployPassword = '', requestId = crypto.randomUUID(),
}) {
  assertManifestSource(manifest, snapshot.source, target);
  const recipe = validateRecipe(manifest?.execution ?? config.execution ?? execution);
  const environment = { DEPLOY_PROJECT: project, DEPLOY_TARGET: target,
    ...(manifest ? selection?.env : { DEPLOY_OPTION: option }) };
  // Legacy slots received their option as $1. Transfer it as data, never splice
  // an operator's selection into shell text.
  const script = recipe.adapter === 'podman' ? (config.script || '') : manifest ? config.script : `set -- "$DEPLOY_OPTION"\n${config.script || ''}`;
  return validateJob({ apiVersion: API_VERSION, requestId, project, target, ...snapshot,
    script, versionCommand: config.versionCmd || '', environment,
    secrets: { DEPLOY_USER: deployUser, DEPLOY_PASSWORD: deployPassword }, recipe });
}

export function createDeploymentService({ settingsStore, snapshot, Client = DeploymentClient }) {
  async function client(options = {}) {
    const { forceExternal = false, ...draft } = options;
    const connection = forceExternal
      ? await (settingsStore.externalConnection ? settingsStore.externalConnection() : settingsStore.connection({}))
      : await settingsStore.connection(Object.keys(draft).length ? draft : undefined);
    return connection ? new Client(connection) : null;
  }
  async function requiredClient({ forceExternal = false } = {}) {
    const value = await client({ forceExternal });
    if (!value) throw new DeploymentError('External deployment is not selected. Use Settings > Deployment or the slot execution backend to select it.', 409, 'deployment_local');
    return value;
  }
  async function backend() {
    if (typeof settingsStore.load !== 'function') return (await client()) ? 'external' : 'local';
    return (await settingsStore.load()).deployment.backend;
  }
  async function enqueue(options) {
    const worker = options.client || await requiredClient({ forceExternal: options.forceExternal });
    if (!(await worker.health()).ready) throw new DeploymentError('Deployment service is not ready.', 503, 'deployment_not_ready');
    const source = await snapshot(options.workspace);
    const job = buildDeploymentJob({ ...options, snapshot: source });
    return worker.submit(job);
  }
  return { client, requiredClient, backend, enqueue, settingsStore };
}

export function deploymentHistoryEntry(job) {
  return {
    ts: job.finishedAt || job.startedAt || job.createdAt, project: job.project, target: job.target,
    jobId: job.id, revision: job.revision, phase: job.phase,
    status: job.state === 'succeeded' ? 'success' : job.state,
    version: job.version || null, user: 'deployment service',
    duration: job.startedAt && job.finishedAt ? ((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1) : null,
    active: !TERMINAL_STATES.has(job.state),
    backend: 'external',
  };
}
