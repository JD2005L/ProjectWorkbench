import { TERMINAL_STATES } from './protocol.js';
import { JOB_STATES } from './client.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

export function createDeploymentApi(base, environment = globalThis) {
  return async (route, options = {}) => {
    // Only present on the standalone console's authenticated pages (see
    // renderDeploymentPage's `standalone` option); absent here on every PW
    // page, so this never changes PW's existing request shape.
    const csrfToken = environment.document?.querySelector?.('meta[name="ds-csrf-token"]')?.content;
    const response = await environment.fetch(`${base}/api/deploy-service${route}`, {
      ...options, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
    });
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      throw new Error('The workbench did not return deployment JSON. Sign in again; no deployment was retried.');
    }
    const value = await response.json();
    if (!response.ok || value.ok !== true) throw new Error(value.error || 'Deployment service is unavailable.');
    return value;
  };
}

export function createSubmissionFollower(terminalStates, environment = globalThis) {
  const { document, window, setTimeout, clearTimeout } = environment;
  const terminal = new Set(terminalStates);
  return async function followExternalDeployment(result, { base, output, card }) {
    if (result.backend !== 'external' || !result.job) return result;
    const api = createDeploymentApi(base, environment);
    let job = result.job, stopped = false, timer, wake;
    const controller = new AbortController();
    let link = card.querySelector('.deploy-service-job-link');
    if (!link) {
      link = document.createElement('a'); link.className = 'deploy-service-job-link';
      card.appendChild(link);
    }
    link.href = `${base}/deploy-service?job=${encodeURIComponent(job.id)}`;
    link.textContent = 'Open deployment job and live logs';
    const stop = () => { stopped = true; clearTimeout(timer); controller.abort(); wake?.(); };
    const visibility = () => {
      clearTimeout(timer);
      wake?.();
    };
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', visibility);
    try {
      while (!terminal.has(job.state) && !stopped) {
        output.textContent = `External job ${job.id}\nRevision: ${job.revision}\n${job.state}: ${job.phase || job.state}\nThe host job continues independently of this page and the workbench.`;
        await new Promise(resolve => { wake = resolve; if (!document.hidden) timer = setTimeout(resolve, 2000); });
        wake = null;
        if (stopped || document.hidden) continue;
        try { job = (await api(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal })).job; }
        catch (error) {
          if (stopped) break;
          throw new Error(`${error.message} The job may still be running. Use its job link before deploying again.`);
        }
      }
      if (stopped) return { ...result, queued: true, job };
      return { ...result, queued: false, job, ok: job.state === 'succeeded', status: job.state,
        version: job.version || null,
        duration: job.startedAt && job.finishedAt ? ((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1) : '0.0',
        output: `External job ${job.id}: ${job.phase || job.state}. Revision ${job.revision}.`,
        error: job.errorCode || undefined };
    } finally {
      clearTimeout(timer);
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('visibilitychange', visibility);
    }
  };
}

export const deploymentSubmitClientSrc = `const createDeploymentApi = ${createDeploymentApi.toString()};
const followExternalDeployment = (${createSubmissionFollower.toString()})(${json([...TERMINAL_STATES])});`;

function settingsBrowser(base, makeApi) {
  const form = document.getElementById('ds-backend-form');
  if (!form) return;
  const api = makeApi(base), element = id => document.getElementById(id);
  const status = element('ds-backend-status');
  const say = message => { status.textContent = message; };
  function show(value) {
    element('ds-backend').value = value.backend;
    element('ds-endpoint').value = value.endpoint;
    element('ds-token').value = '';
    element('ds-clear-token').checked = false;
    element('ds-console-url').value = value.consoleUrl || '';
    element('ds-credential-state').textContent = value.hasCredential ? 'A credential is saved. Its value is never returned.' : 'No service credential is saved.';
  }
  api('/backend').then(value => show(value.deployment)).catch(error => say(error.message));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = element('ds-backend-save'); button.disabled = true;
    try {
      const body = { backend: element('ds-backend').value, endpoint: element('ds-endpoint').value,
        token: element('ds-token').value, clearToken: element('ds-clear-token').checked,
        consoleUrl: element('ds-console-url').value };
      const value = await api('/backend', { method: 'PUT', body: JSON.stringify(body) });
      show(value.deployment);
      say(value.deployment.backend === 'external' ? 'External execution saved for every project, including new projects. No deployment was started.' : 'Current/local execution saved. The saved endpoint and credential are retained unless explicitly cleared.');
    } catch (error) { say(error.message); }
    finally { button.disabled = false; }
  });
  element('ds-test-connection').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const body = { endpoint: element('ds-endpoint').value, token: element('ds-token').value };
      const value = await api('/connection/test', { method: 'POST', body: JSON.stringify(body) });
      say(value.health.ready ? 'Compatible deployment service is ready. This test did not save settings or start a job.' : 'The service is compatible but not ready. No job was started.');
    } catch (error) { say(error.message); }
    finally { event.currentTarget.disabled = false; }
  });
}

export function renderDeploymentSettings(base) {
  return `<section id="tab-deployment"><h2>Deployment</h2>
<p class="lead">Choose execution once for the whole workbench. New projects inherit it automatically; repositories describe recipes and targets, never service credentials. Deployments remain human-triggered.</p>
<div class="s-card"><form id="ds-backend-form">
<label for="ds-backend">Execution backend</label><select id="ds-backend"><option value="local">CURRENT / LOCAL (backward-compatible default)</option><option value="external">EXTERNAL deployment service</option></select>
<p>External failures never run the script locally. Source must be a clean, committed Git workspace; only the pinned commit is transferred in memory.</p>
<label for="ds-endpoint">Service endpoint</label><input id="ds-endpoint" type="text" maxlength="2048" autocomplete="off" placeholder="https://deploy.example.test">
<p class="muted">HTTPS for remote services, loopback-only HTTP, or unix:/absolute/socket. Normal certificate verification is required; redirects are rejected.</p>
<label for="ds-token">Service credential (leave blank to keep)</label><input id="ds-token" type="password" maxlength="512" autocomplete="new-password">
<p id="ds-credential-state" class="muted"></p><label><input id="ds-clear-token" type="checkbox"> Explicitly clear the saved credential (requires local execution)</label>
<p>The credential is encrypted at rest. Switching to local preserves the endpoint and credential. Testing a draft endpoint sends the entered or saved credential to that endpoint but does not save it.</p>
<label for="ds-console-url">Standalone console URL (optional)</label><input id="ds-console-url" type="text" maxlength="2048" autocomplete="off" placeholder="https://deploy.example.test/deploy-service">
<p class="muted">When the deployment engine and console run as their own separately hosted unit, set its public HTTPS address here to send administrators there instead of this legacy page. Leave blank to keep this page (backward compatible). The API endpoint above may still be loopback; no credential is ever placed in this URL.</p>
<button id="ds-backend-save" class="button" type="submit">Save deployment backend</button>
<button id="ds-test-connection" class="button secondary" type="button">Test connection</button>
<a class="button secondary" href="${escape(base)}/deploy-service">Jobs and service controls</a>
<a class="button secondary" href="${escape(base)}/deploy-service/connection">Deployment connection settings</a>
<p class="muted">The connection settings link above always stays in Project Workbench, even when jobs and service controls redirect to a separately hosted deployment console.</p>
<p id="ds-backend-status" role="status" aria-live="polite"></p></form></div></section>`;
}

export function deploymentSettingsScript(base) {
  return `<script>(${settingsBrowser.toString()})(${json(base)}, ${createDeploymentApi.toString()});</script>`;
}

export function renderDeploymentNotice(base, project, external) {
  if (!external) return '';
  return `<p class="muted">External execution: a clean, committed Git workspace is required. Service versions are last successful deployment metadata, not fresh runtime probes. Repository-managed input versions describe the committed recipe metadata. <a href="${escape(base)}/deploy-service?project=${encodeURIComponent(project)}">Service jobs and retained history</a></p>`;
}

export function renderExecutionRecipe(execution, external) {
  if (!execution) return '';
  return `<p class="repo-managed-note">Execution adapter: <b>${escape(execution.adapter)}</b>.${!external && execution.adapter !== 'script' ? ' This recipe requires the external backend in global Settings > Deployment; it will not run partially as a local script.' : ''}</p>
<pre aria-label="Repository execution recipe (read-only)">${escape(JSON.stringify(execution, null, 2))}</pre>`;
}

export const deploymentUiCss = `
.ds-page{font:16px system-ui,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}
.ds-page main{max-width:1200px;margin:auto;padding:1.5rem}.ds-page a{color:#7dd3fc}
.ds-page nav,.ds-actions,.ds-filters{display:flex;flex-wrap:wrap;gap:1rem;align-items:end}
.ds-page section{border:1px solid #475569;border-radius:8px;padding:1rem;margin:1rem 0}
.ds-page label{display:block;margin:.6rem 0}.ds-page input,.ds-page select,.ds-page button{font:inherit;padding:.45rem;background:#1e293b;color:#e5e7eb;border:1px solid #64748b;border-radius:4px}
.ds-page button{cursor:pointer}.ds-page button:disabled{opacity:.6;cursor:default}
.ds-page :focus-visible{outline:3px solid #38bdf8;outline-offset:3px}
.ds-page table{width:100%;border-collapse:collapse}.ds-page th,.ds-page td{text-align:left;padding:.55rem;border-bottom:1px solid #475569;vertical-align:top}
.ds-page code{overflow-wrap:anywhere}.ds-page .ds-table{overflow:auto}.ds-page pre{max-height:28rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#020617;padding:1rem}
.ds-page .ds-target{border-top:1px solid #475569;padding:.6rem 0}.ds-page .ds-muted{color:#cbd5e1}
.ds-page [hidden]{display:none!important}
.ds-page .ds-brand{font-weight:600}.ds-page form.ds-logout{margin:0}
.ds-page main.ds-login{max-width:26rem}.ds-page [role="alert"]{color:#fca5a5}`;

export function deploymentPageBrowser(config, makeApi) {
  const api = makeApi(config.base), el = id => document.getElementById(id), terminal = new Set(config.terminalStates);
  const status = el('ds-status'), rows = new Map(), events = new Map();
  const query = new URLSearchParams(window.location.search);
  let selected = query.get('job') || '', currentJob = null, after = 0, liveText = '';
  let timer, controller, busy = false, failed = false, disposed = false, generation = 0;
  const say = value => { if (status.textContent !== value) status.textContent = value; };
  const time = value => value ? new Date(value).toLocaleString() : '-';
  const node = (tag, value) => { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; return item; };
  const stop = () => { clearTimeout(timer); controller?.abort(); };

  if (query.get('project')) el('ds-project').value = query.get('project');
  if (['dev', 'prod'].includes(query.get('target'))) el('ds-target').value = query.get('target');
  function renderJobs(jobs) {
    const keep = new Set(jobs.map(job => job.id));
    for (const [id, value] of rows) if (!keep.has(id)) { value.row.remove(); rows.delete(id); }
    for (const job of jobs) {
      let value = rows.get(job.id);
      if (!value) {
        const row = node('tr'), link = node('a'), cells = Array.from({ length: 7 }, () => node('td'));
        link.href = `${config.pagePath || `${config.base}/deploy-service`}?job=${encodeURIComponent(job.id)}`;
        link.addEventListener('click', event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
          event.preventDefault(); select(job.id);
          window.history.replaceState(null, '', link.href);
        });
        cells[0].appendChild(link); for (const cell of cells) row.appendChild(cell);
        el('ds-jobs').appendChild(row);
        value = { row, link, cells }; rows.set(job.id, value);
      }
      value.link.textContent = `${job.project} / ${job.target}`;
      [job.state, job.phase || '-', job.revision, time(job.createdAt), `${time(job.startedAt)} / ${time(job.finishedAt)}`,
        job.version || job.errorCode || (terminal.has(job.state) ? job.state : '-')].forEach((text, index) => { value.cells[index + 1].textContent = text; });
    }
    el('ds-empty').hidden = jobs.length !== 0;
  }
  function renderDetail(job, log) {
    currentJob = job;
    el('ds-detail').hidden = false;
    el('ds-detail-title').textContent = `${job.project} / ${job.target}: ${job.state}`;
    el('ds-job-meta').textContent = `Job ${job.id} | Revision ${job.revision} | ${job.adapter || 'script'} | ${job.phase || job.state} | Created ${time(job.createdAt)} | Started ${time(job.startedAt)} | Finished ${time(job.finishedAt)} | Outcome ${job.version || job.errorCode || job.state}`;
    el('ds-cancel').disabled = terminal.has(job.state) || job.state === 'cancelling';
    for (const event of log.events) {
      if (events.has(event.seq)) continue;
      const line = node('li', `${time(event.at)} | ${event.phase}${event.state ? ` | ${event.state}` : ''}${event.code ? ` | ${event.code}` : ''}${event.message ? ` | ${event.message}` : ''}`);
      el('ds-history').appendChild(line); events.set(event.seq, line);
    }
    const output = el('ds-live');
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 32;
    liveText = (liveText + log.live.map(entry => entry.text).join('')).slice(-128 * 1024);
    const nextText = liveText || 'No live text is available. Raw logs are bounded, redacted, and memory-only; operational history survives restarts.';
    if (output.textContent !== nextText) output.textContent = nextText;
    if (el('ds-follow').checked && atBottom) output.scrollTop = output.scrollHeight;
    after = log.nextSeq;
    if (terminal.has(job.state)) say(`Job ${job.id} ${job.state}. Automatic job refresh has stopped.`);
    else say(`Job ${job.id}: ${job.state} (${job.phase || job.state}).`);
  }
  async function refresh() {
    if (busy || disposed || document.hidden) return;
    busy = true; clearTimeout(timer);
    controller = new AbortController();
    const version = generation;
    try {
      const filter = new URLSearchParams({ limit: '100' });
      for (const [key, id] of [['project', 'ds-project'], ['target', 'ds-target'], ['state', 'ds-state']]) if (el(id).value) filter.set(key, el(id).value);
      const jobs = await api(`/jobs?${filter}`, { signal: controller.signal });
      if (version !== generation || document.hidden || disposed) return;
      renderJobs(jobs.jobs);
      if (!selected) say(`${jobs.jobs.length} recent job${jobs.jobs.length === 1 ? '' : 's'} shown. Automatic refresh is active.`);
      if (selected && (!currentJob || !terminal.has(currentJob.state))) {
        const [detail, log] = await Promise.all([
          api(`/jobs/${encodeURIComponent(selected)}`, { signal: controller.signal }),
          api(`/jobs/${encodeURIComponent(selected)}/log?after=${after}`, { signal: controller.signal }),
        ]);
        if (version !== generation || document.hidden || disposed) return;
        renderDetail(detail.job, log);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failed = true; say(`${error.message} Polling stopped. Use Refresh jobs to reconnect; no deployment was retried.`);
      }
    } finally {
      busy = false;
      if (version !== generation && !disposed && !document.hidden) refresh();
      else if (!failed && !disposed && !document.hidden && (!currentJob || !terminal.has(currentJob.state))) timer = setTimeout(refresh, 5000);
    }
  }
  function select(id) {
    stop(); generation++; selected = id; currentJob = null; after = 0; liveText = ''; failed = false;
    events.clear(); el('ds-history').replaceChildren(); el('ds-live').textContent = '';
    say('Loading deployment history.'); refresh();
  }
  el('ds-filters').addEventListener('submit', event => {
    event.preventDefault(); selected = ''; currentJob = null; el('ds-detail').hidden = true;
    generation++; failed = false; stop(); refresh();
  });
  el('ds-refresh').addEventListener('click', () => { failed = false; say('Refreshing jobs.'); refresh(); });
  el('ds-follow').addEventListener('change', () => { if (el('ds-follow').checked) el('ds-live').scrollTop = el('ds-live').scrollHeight; });
  el('ds-cancel').addEventListener('click', async () => {
    if (!currentJob || terminal.has(currentJob.state) || currentJob.state === 'cancelling') return;
    const job = currentJob;
    if (!window.confirm(`Cancel ${job.target === 'prod' ? 'PRODUCTION' : 'development'} deployment for ${job.project}, job ${job.id}? Cancellation cannot undo already completed deployment steps.`)) return;
    el('ds-cancel').disabled = true;
    try {
      await api(`/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: JSON.stringify({ confirmProduction: job.target === 'prod' }) });
      say('Cancellation requested. Waiting for the host outcome.'); currentJob = null; failed = false; refresh();
    } catch (error) { say(error.message); el('ds-cancel').disabled = !!currentJob && (terminal.has(currentJob.state) || currentJob.state === 'cancelling'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!failed && (!currentJob || !terminal.has(currentJob.state))) refresh();
  });
  window.addEventListener('pagehide', () => { disposed = true; stop(); });

  if (config.admin) {
    const adminStatus = el('ds-admin-status');
    const adminSay = message => { adminStatus.textContent = message; };
    async function loadAdmin() {
      try {
        const [settings, targets] = await Promise.all([api('/settings'), api('/targets')]);
        el('ds-paused').checked = settings.settings.paused;
        el('ds-concurrency').value = settings.settings.maxConcurrent;
        el('ds-timeout').value = settings.settings.defaultTimeoutSeconds;
        el('ds-retention').value = settings.settings.retentionDays;
        const targetRows = [];
        for (const target of targets.targets) {
          const form = node('form'); form.className = 'ds-target';
          form.appendChild(node('h3', `${target.project} / ${target.target}${target.adapter ? ` (${target.adapter})` : ''}`));
          const pauseLabel = node('label', ' Pause target '), pause = node('input'); pause.type = 'checkbox'; pause.checked = target.paused; pauseLabel.appendChild(pause);
          const timeoutLabel = node('label', 'Timeout override (seconds) '), timeout = node('input'); timeout.type = 'number'; timeout.min = '30'; timeout.max = '3600'; timeout.required = true; timeout.value = target.timeoutSeconds; timeoutLabel.appendChild(timeout);
          const button = node('button', 'Save target policy'); button.type = 'submit';
          for (const item of [pauseLabel, timeoutLabel, button]) form.appendChild(item);
          form.addEventListener('submit', async event => {
            event.preventDefault(); button.disabled = true;
            try {
              await api(`/targets/${encodeURIComponent(target.project)}/${target.target}`, { method: 'PUT',
                body: JSON.stringify({ paused: pause.checked, timeoutSeconds: Number(timeout.value) }) });
              adminSay(`Policy saved for ${target.project} / ${target.target}. No job was started.`);
            } catch (error) { adminSay(error.message); }
            finally { button.disabled = false; }
          });
          targetRows.push(form);
        }
        el('ds-target-policies').replaceChildren(...targetRows);
        el('ds-no-targets').hidden = targetRows.length > 0;
      } catch (error) { adminSay(error.message); }
    }
    el('ds-service-settings').addEventListener('submit', async event => {
      event.preventDefault(); el('ds-service-save').disabled = true;
      try {
        await api('/settings', { method: 'PUT', body: JSON.stringify({ paused: el('ds-paused').checked,
          maxConcurrent: Number(el('ds-concurrency').value), defaultTimeoutSeconds: Number(el('ds-timeout').value), retentionDays: Number(el('ds-retention').value) }) });
        adminSay('Service policy saved. No deployment was started or restarted.');
      } catch (error) { adminSay(error.message); }
      finally { el('ds-service-save').disabled = false; }
    });
    el('ds-admin-refresh').addEventListener('click', loadAdmin);
    el('ds-diagnostics').addEventListener('click', async () => {
      try {
        const { health } = await api('/diagnostics');
        adminSay(`Protocol ${health.apiVersion}, ${health.service}: ${health.ready ? 'ready' : 'not ready'}, ${health.running} running, ${health.queued} queued.`);
      } catch (error) { adminSay(error.message); }
    });
    loadAdmin();
  }
  refresh();
}

// `standalone` is how the independently hosted console (standalone-web.js)
// reuses this exact page for its job/log/pause/target/settings surface: it
// swaps only the navigation (no Dashboard/Deploy/Settings links, which don't
// exist there) for a sign-out control, and nonces the inline style/script for
// its strict Content-Security-Policy. Omitted, PW's own rendering is
// byte-for-byte unchanged from before this option existed.
//
// `connectionOnly` serves a different, PW-side need: once the admin
// /deploy-service route redirects to a configured standalone console (see
// the optional ds-console-url setting below), operators still need a page
// that stays inside Project Workbench to edit its own LOCAL/EXTERNAL backend
// connection (and the console URL that drives that redirect). It renders
// only the existing connection settings markup/script -- never the host job
// list, filters or admin service-policy controls -- so `projects`/`admin`/
// `standalone` are not needed and are ignored in this mode.
export function renderDeploymentPage({ base, admin, projects, standalone, connectionOnly }) {
  if (connectionOnly) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deployment connection settings - Project Workbench</title><style>${deploymentUiCss}</style></head><body class="ds-page"><main>
<nav aria-label="Deployment navigation"><a href="${escape(base)}/">Dashboard</a></nav>
<h1>Deployment connection settings</h1>
<p>Host job status, live logs and per-target pause/timeout controls live on the deployment console when one is configured. This page only edits which backend -- and which console -- this workbench points to.</p>
${renderDeploymentSettings(base)}
</main>${deploymentSettingsScript(base)}</body></html>`;
  }
  const options = projects.map(project => `<option value="${escape(project.name)}">${escape(project.name)}</option>`).join('');
  const adminPanel = !admin ? '' : `<section><h2>Service controls (admin)</h2>
<form id="ds-service-settings"><label><input id="ds-paused" type="checkbox"> Pause service acceptance and queued execution</label>
<label for="ds-concurrency">Maximum concurrent jobs</label><input id="ds-concurrency" type="number" min="1" max="4" required>
<label for="ds-timeout">Default timeout (seconds)</label><input id="ds-timeout" type="number" min="30" max="3600" required>
<label for="ds-retention">Operational history retention (days)</label><input id="ds-retention" type="number" min="1" max="90" required>
<button id="ds-service-save" type="submit">Save service policy</button></form>
<p>Pausing does not restart or cancel active jobs. A job is never automatically retried by this workbench.</p>
<div class="ds-actions"><button id="ds-diagnostics" type="button">Check connection diagnostics</button><button id="ds-admin-refresh" type="button">Reload service and target policies</button></div>
<p id="ds-admin-status" role="status" aria-live="polite"></p>
<h3>Target overrides</h3><p>Targets appear from deployment activity. New projects use service defaults without enrollment or privilege setup.</p>
<p id="ds-no-targets">No target activity yet.</p><div id="ds-target-policies"></div></section>`;
  const nonceAttr = standalone?.nonce ? ` nonce="${escape(standalone.nonce)}"` : '';
  const meta = standalone?.csrfToken ? `<meta name="ds-csrf-token" content="${escape(standalone.csrfToken)}">` : '';
  const nav = standalone
    ? `<span class="ds-brand">Deployment console</span><form class="ds-logout" method="post" action="${escape(standalone.logoutPath)}">`
      + `<input type="hidden" name="csrf" value="${escape(standalone.csrfToken)}"><button type="submit">Log out</button></form>`
    : `<a href="${escape(base)}/">Dashboard</a><a href="${escape(base)}/deploy">Deploy projects</a>${admin ? `<a href="${escape(base)}/settings#deployment">Deployment settings</a>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${meta}<title>Deployment service - Project Workbench</title><style${nonceAttr}>${deploymentUiCss}</style></head><body class="ds-page"><main>
<nav aria-label="Deployment navigation">${nav}</nav>
<h1>Deployment service</h1><p>Host jobs continue independently of the workbench. Reopening this page retrieves retained jobs after a workbench restart. Versions describe the last successful deployment, not a fresh runtime probe.</p>
<p id="ds-status" role="status" aria-live="polite">Loading deployment service.</p>
<form id="ds-filters" class="ds-filters"><label for="ds-project">Project<select id="ds-project"><option value="">All authorized projects</option>${options}</select></label>
<label for="ds-target">Target<select id="ds-target"><option value="">All targets</option><option value="dev">Development</option><option value="prod">Production</option></select></label>
<label for="ds-state">State<select id="ds-state"><option value="">All states</option>${[...JOB_STATES].map(state => `<option value="${state}">${state}</option>`).join('')}</select></label>
<button type="submit">Apply filters</button><button id="ds-refresh" type="button">Refresh jobs</button></form>
<div class="ds-table"><table><caption>Recent deployment jobs</caption><thead><tr><th scope="col">Project / target</th><th scope="col">State</th><th scope="col">Phase</th><th scope="col">Pinned revision</th><th scope="col">Created</th><th scope="col">Started / finished</th><th scope="col">Outcome / version</th></tr></thead><tbody id="ds-jobs"></tbody></table></div><p id="ds-empty" hidden>No jobs match these filters.</p>
<section id="ds-detail" hidden aria-labelledby="ds-detail-title"><h2 id="ds-detail-title">Job details</h2><p id="ds-job-meta"></p><button id="ds-cancel" type="button" disabled>Cancel active job</button>
<h3>Operational history</h3><ol id="ds-history"></ol><h3>Live logs</h3><p class="ds-muted">Raw text is bounded, redacted, and memory-only. It may no longer be available after a service restart.</p>
<label><input id="ds-follow" type="checkbox" checked> Follow new output while at the bottom</label><pre id="ds-live" tabindex="0" aria-label="Deployment live log text" aria-live="off"></pre></section>
${adminPanel}</main><script${nonceAttr}>(${deploymentPageBrowser.toString()})(${json({ base, admin, pagePath: standalone ? base : `${base}/deploy-service`, terminalStates: [...TERMINAL_STATES] })}, ${createDeploymentApi.toString()});</script></body></html>`;
}

// The standalone console's own sign-in page (standalone-web.js). It is a
// plain HTML form post (no fetch/JS involved), so it keeps working even if
// script is blocked, and needs no CSRF token of its own: no session exists
// yet to forge. `error`, when present, is operator-facing text describing
// why a previous attempt did not succeed (never which part of a credential
// was wrong, since there is only one field).
export function renderStandaloneLogin({ basePath, error = '', nonce }) {
  const nonceAttr = nonce ? ` nonce="${escape(nonce)}"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deployment console sign-in</title><style${nonceAttr}>${deploymentUiCss}</style></head><body class="ds-page"><main class="ds-login">
<h1>Deployment console</h1>
${error ? `<p role="alert">${escape(error)}</p>` : ''}
<section><form method="post" action="${escape(basePath)}/login">
<label for="ds-login-token">Administrator token</label>
<input id="ds-login-token" name="token" type="password" autocomplete="current-password" required maxlength="512" autofocus>
<button type="submit">Sign in</button>
</form><p class="ds-muted">This is a separate administrative console. Project Workbench does not serve it, authenticate it, or ever receive this token.</p></section>
</main></body></html>`;
}

// A minimal, session-preserving notice page for the standalone console
// (standalone-web.js). Used when an authenticated action is refused for an
// Origin/CSRF reason (for example, a forged cross-site logout submission),
// so the response never looks like a success-shaped redirect: the visitor is
// told plainly that the action was NOT completed and that they are still
// signed in, with a safe same-origin link back and no token/session id ever
// disclosed.
export function renderStandaloneNotice({ basePath, title, message, nonce }) {
  const nonceAttr = nonce ? ` nonce="${escape(nonce)}"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style${nonceAttr}>${deploymentUiCss}</style></head><body class="ds-page"><main class="ds-login">
<h1>${escape(title)}</h1>
<p role="alert">${escape(message)}</p>
<p><a href="${escape(basePath)}/">Return to the deployment console</a></p>
</main></body></html>`;
}
