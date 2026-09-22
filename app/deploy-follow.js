// Watching a LOCAL deploy: attach, follow, and survive the panel being closed.
//
// The state lives on the server (app/deploy-runs.js). This is the client half,
// and it is deliberately the same shape as createSubmissionFollower() in
// app/deployment/ui.js, which does the equivalent job for the external service
// backend — one mental model for both, so a slot switching backends does not
// change how the panel behaves.
//
// Two surfaces use it verbatim: the cockpit modal and the standalone Deployment
// Centre page. Keeping it here rather than inlining it twice is what stops the
// two drifting, which they already had (only one of them updated the "Last:" line
// on failure, and that is how a colleague's name ended up over somebody else's
// failure).

export function createRunFollower(environment = globalThis) {
  const { fetch, setTimeout, clearTimeout, document } = environment;

  // The one place a run's headline is written, so the panel, a reattachment and
  // History all say the same thing about the same run.
  function headline(run) {
    const mark = run.status === 'running' ? '⏳ RUNNING' : run.status === 'success' ? '✅ SUCCESS' : '❌ FAILED';
    const took = run.status === 'running' ? 'in progress' : `${run.duration || '?'}s`;
    const who = run.user ? `, by ${run.user}` : '';
    const ran = run.deployUser && run.identitySource && run.identitySource !== 'operator' ? ` as ${run.deployUser}` : '';
    const when = run.startedAt ? ` — started ${String(run.startedAt).replace('T', ' ').replace(/\..*/, ' UTC')}` : '';
    return `${mark} (${took})${when}${who}${ran}\nVersion: ${run.version || (run.status === 'running' ? 'pending' : 'unknown')}`;
  }

  function paint(output, run, text) {
    output.className = 'deploy-output show';
    output.textContent = `${headline(run)}\n\n${run.truncated ? '[earlier output dropped — showing the tail]\n' : ''}${text || ''}`;
  }

  // Follow one slot's newest run to completion, painting as it goes. Returns the
  // terminal run (or null when the slot has never been deployed from this
  // workbench), and is safe to call on every panel open: a finished run simply
  // paints once and returns.
  async function follow({ base, project, target, output, intervalMs = 1500, onRunning, onDone, isHidden,
    // `requireRunning` + `until` are for the operator who just pressed Deploy:
    // wait for THEIR run to appear rather than painting the previous one, and
    // give up the moment the request they are waiting on has answered (a 401
    // password prompt or a 409 starts no run at all).
    requireRunning = false, until = null }) {
    const url = suffix => `${base}/api/deploy/${encodeURIComponent(project)}/${encodeURIComponent(target)}/run${suffix}`;
    let settled = false;
    until?.then?.(() => { settled = true; }, () => { settled = true; });

    let initial = null;
    for (let attempt = 0; ; attempt++) {
      const first = await fetch(url(''), { cache: 'no-store' });
      if (first.status === 401) return null;
      const value = await first.json().catch(() => null);
      if (value?.ok && value.run && (!requireRunning || value.run.status === 'running')) { initial = value; break; }
      if (!requireRunning || settled || attempt > 40) return null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    let run = initial.run, text = initial.run.output || '', offset = initial.run.offset || text.length;
    if (output) paint(output, run, text);
    if (run.status !== 'running') { onDone?.(run, text); return run; }

    onRunning?.(run);
    while (run.status === 'running') {
      // A hidden tab should not poll: a deploy takes minutes and the browser is
      // free to throttle timers anyway, so the visible reopen does the catch-up.
      await new Promise(resolve => { const timer = setTimeout(resolve, intervalMs); void timer; });
      if (isHidden?.()) continue;
      let next;
      try { next = await (await fetch(url(`?after=${offset}`), { cache: 'no-store' })).json(); }
      catch { continue; }                      // a dropped poll is not a failed deploy
      if (!next || !next.ok || !next.run) break;
      run = next.run;
      if (next.behind) text = '';
      text += next.chunk || '';
      offset = next.offset ?? offset;
      if (output) paint(output, run, text);
    }
    onDone?.(run, text);
    return run;
  }

  // History drill-in: the retained output of one archived run.
  async function showArchived({ base, project, id, into }) {
    into.hidden = false;
    into.textContent = 'Loading…';
    try {
      const response = await fetch(`${base}/api/deploy/${encodeURIComponent(project)}/run/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const value = await response.json().catch(() => null);
      if (response.status >= 400 || !value?.ok || !value.run) throw new Error(value?.error || `HTTP ${response.status}`);
      into.textContent = `${headline(value.run)}\n\n${value.run.truncated ? '[earlier output dropped — showing the tail]\n' : ''}${value.run.output || '(no output was captured)'}`;
    } catch (error) { into.textContent = error.message || String(error); }
  }

  // Delegated so it keeps working when a table is re-rendered under it.
  function bindHistory({ base, root = document, container }) {
    root.addEventListener('click', event => {
      const button = event.target.closest?.('[data-run]');
      if (!button) return;
      event.preventDefault();
      const into = container?.() || button.closest('.deploy-tab-panel')?.querySelector('.run-detail-output')
        || button.closest('.project-card')?.querySelector('.run-detail-output');
      if (!into) return;
      showArchived({ base, project: button.dataset.runProject, id: button.dataset.run, into });
    });
  }

  return { follow, showArchived, bindHistory, headline, paint };
}

export const deployFollowClientSrc = `const pwRunFollower = (${createRunFollower.toString()})();`;
