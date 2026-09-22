import { DeploymentError, fields, projectName, targetName, TERMINAL_STATES, consoleSelectorQuery } from './protocol.js';
import { publicDeploymentSettings, publicDeployCredentials, DEPLOY_TARGETS } from './settings.js';
import { deploymentFailure, requireDeploymentOrigin } from './pw.js';
import { renderDeploymentPage } from './ui.js';
import { JOB_STATES } from './client.js';

export async function sendDeploymentHealth(service, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const client = await service.client();
    const ready = !client || (await client.health()).ready;
    return res.status(ready ? 200 : 503).json({ ok: ready, backend: client ? 'external' : 'local', ready });
  } catch { return res.status(503).json({ ok: false, ready: false }); }
}

export function mountDeploymentRoutes(app, {
  base, service, requireAuth, requireAdmin, requireProjectAccess,
  loadProjects, filterProjectsForUser, audit, publicHealth = true,
  // Injected so this module never learns how the instance authenticates:
  // (account, password) -> { ok, reason? }, a directory bind and nothing else.
  verifyDeployAccount = null,
}) {
  const api = `${base}/api/deploy-service`;
  const route = handler => async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { return await handler(req, res, next); }
    catch (error) { return deploymentFailure(res, error); }
  };
  const visible = async req => filterProjectsForUser(await loadProjects(), req.user);
  const authorizeProject = async (req, res, project, action) => {
    if (req.user.role !== 'admin' && !(await visible(req)).some(value => value.name === project)) {
      throw new DeploymentError('Not authorized for this deployment project.', 403, 'deployment_project_forbidden');
    }
    req.params.project = project;
    return requireProjectAccess(req, res, action);
  };
  const jobRoute = handler => route(async (req, res) => {
    const client = await service.requiredClient({ forceExternal: true });
    const job = await client.job(req.params.id);
    return authorizeProject(req, res, job.project, () => handler(req, res, client, job));
  });

  // This is deliberately JSON even without a login, and reveals no endpoint,
  // queue, target, account, or credential details.
  if (publicHealth) app.get(`${api}/health`, (_req, res) => sendDeploymentHealth(service, res));
  app.get(`${base}/deploy-service/connection`, requireAdmin, route(async (_req, res) => {
    res.type('html').send(renderDeploymentPage({ base, admin: true, connectionOnly: true }));
  }));
  app.get(`${base}/deploy-service`, requireAuth, route(async (req, res) => {
    if (req.user.role === 'admin') {
      const { consoleUrl } = publicDeploymentSettings(await service.settingsStore.load());
      if (consoleUrl) {
        const destination = new URL(consoleUrl);
        destination.search = consoleSelectorQuery(req.query);
        return res.redirect(303, destination.href);
      }
    }
    res.type('html').send(renderDeploymentPage({ base, admin: req.user.role === 'admin', projects: await visible(req) }));
  }));
  app.get(`${api}/backend`, requireAdmin, route(async (_req, res) => {
    res.json({ ok: true, deployment: publicDeploymentSettings(await service.settingsStore.load()) });
  }));
  app.put(`${api}/backend`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const deployment = await service.settingsStore.updateDeployment(req.body);
    await audit('deploy_service_backend_update', { backend: deployment.backend }, req);
    res.json({ ok: true, deployment });
  }));
  // The Windows account deploys RUN AS, per target, for the whole workbench.
  // docs/deploy-credentials.md. Admin-only in both directions, and the response
  // carries state and the account name — never the password, in any state.
  app.get(`${api}/credentials`, requireAdmin, route(async (_req, res) => {
    res.json({ ok: true, credentials: publicDeployCredentials(await service.settingsStore.load()) });
  }));
  app.put(`${api}/credentials`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const target = req.body?.target;
    const credentials = await service.settingsStore.updateDeployCredential(req.body || {});
    await audit(req.body?.clear ? 'deploy_credential_cleared' : 'deploy_credential_set',
      { scope: 'instance', target, user: credentials[target]?.user || '' }, req);
    res.json({ ok: true, credentials });
  }));
  // "Did that account's password change?" without running a deploy — the one
  // question a shared credential makes urgent, because one expiry breaks every
  // project at once with nothing but an SMB/WinRM authentication error.
  app.post(`${api}/credentials/test`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const target = req.body?.target;
    if (!DEPLOY_TARGETS.includes(target)) throw new DeploymentError('Deploy credential target must be dev or prod.', 400, 'deploy_credential_target_invalid');
    const credential = await service.settingsStore.deployCredential(target);
    if (credential.state === 'none') return res.json({ ok: true, tested: false, reason: `No ${target} deployment credential is saved for this workbench.` });
    if (credential.state === 'unreadable') return res.json({ ok: true, tested: false, user: credential.user, reason: `The saved ${target} credential cannot be decrypted on this server. Re-enter it.` });
    if (!verifyDeployAccount) return res.json({ ok: true, tested: false, user: credential.user, reason: 'This instance cannot verify a Windows account against a directory.' });
    const result = await verifyDeployAccount(credential.user, credential.password);
    await audit('deploy_credential_test', { scope: 'instance', target, user: credential.user, verified: !!result.ok }, req);
    res.json({ ok: true, tested: true, verified: !!result.ok, user: credential.user, ...(result.ok ? {} : { reason: result.reason || 'The directory rejected this account and password.' }) });
  }));
  app.post(`${api}/connection/test`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const client = await service.client(req.body || {});
    res.json({ ok: true, health: await client.health() });
  }));
  app.get(`${api}/diagnostics`, requireAdmin, route(async (_req, res) => {
    res.json({ ok: true, health: await (await service.requiredClient({ forceExternal: true })).health() });
  }));
  app.get(`${api}/jobs`, requireAuth, route(async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DeploymentError('Job limit must be 1-200.');
    const project = req.query.project === undefined ? undefined : projectName(req.query.project);
    const target = req.query.target === undefined ? undefined : targetName(req.query.target);
    const state = req.query.state;
    if (state !== undefined && !JOB_STATES.has(state)) throw new DeploymentError('Invalid deployment job state.');
    const client = await service.requiredClient({ forceExternal: true });
    const list = async () => {
      let jobs;
      if (req.user.role === 'admin' || project !== undefined) jobs = await client.jobs({ project, target, limit: 200 });
      else {
        jobs = [];
        // Ask separately for allowed projects so other tenants cannot crowd
        // authorized history out of the service's per-request result limit.
        for (const value of await visible(req)) jobs.push(...await client.jobs({ project: value.name, target, limit: 200 }));
      }
      jobs = jobs.filter(job => state === undefined || job.state === state)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
      res.json({ ok: true, jobs });
    };
    return project === undefined ? list() : authorizeProject(req, res, project, list);
  }));
  app.get(`${api}/jobs/:id`, requireAuth, jobRoute(async (_req, res, _client, job) => res.json({ ok: true, job })));
  app.get(`${api}/jobs/:id/log`, requireAuth, jobRoute(async (req, res, client, job) => {
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    if (!Number.isSafeInteger(after) || after < 0) throw new DeploymentError('Invalid deployment log cursor.');
    res.json({ ok: true, ...await client.log(job.id, after) });
  }));
  app.post(`${api}/jobs/:id/cancel`, requireAuth, requireDeploymentOrigin, jobRoute(async (req, res, client, job) => {
    fields(req.body || {}, ['confirmProduction'], 'cancellation');
    if (req.body?.confirmProduction !== undefined && typeof req.body.confirmProduction !== 'boolean') throw new DeploymentError('confirmProduction must be boolean.');
    if (job.target === 'prod' && req.body?.confirmProduction !== true) throw new DeploymentError('Explicit production cancellation confirmation is required.');
    if (TERMINAL_STATES.has(job.state)) throw new DeploymentError('This deployment has already finished.', 409, 'job_finished');
    const cancelled = await client.cancel(job.id);
    if (cancelled.project !== job.project || cancelled.target !== job.target) throw new DeploymentError('Deployment service returned a mismatched job.', 502, 'deployment_protocol_error');
    await audit('deploy_service_cancel', { project: job.project, target: job.target, jobId: job.id }, req);
    res.json({ ok: true, job: cancelled });
  }));
  app.get(`${api}/version/:project/:target`, requireAuth, requireProjectAccess, route(async (req, res) => {
    return authorizeProject(req, res, req.params.project, async () => {
      res.json({ ok: true, ...await (await service.requiredClient({ forceExternal: true })).version(req.params.project, req.params.target) });
    });
  }));
  app.get(`${api}/targets`, requireAdmin, route(async (_req, res) => {
    res.json({ ok: true, targets: await (await service.requiredClient({ forceExternal: true })).targets() });
  }));
  app.put(`${api}/targets/:project/:target`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const target = await (await service.requiredClient({ forceExternal: true })).updateTarget(req.params.project, req.params.target, req.body);
    await audit('deploy_service_target_update', { project: req.params.project, target: req.params.target }, req);
    res.json({ ok: true, target });
  }));
  app.get(`${api}/settings`, requireAdmin, route(async (_req, res) => {
    res.json({ ok: true, settings: await (await service.requiredClient({ forceExternal: true })).settings() });
  }));
  app.put(`${api}/settings`, requireAdmin, requireDeploymentOrigin, route(async (req, res) => {
    const settings = await (await service.requiredClient({ forceExternal: true })).updateSettings(req.body);
    await audit('deploy_service_settings_update', { paused: settings.paused, maxConcurrent: settings.maxConcurrent }, req);
    res.json({ ok: true, settings });
  }));
}
