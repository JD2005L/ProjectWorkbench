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

  // Log-tail scrolling: follow the bottom, but stop following the moment the
  // reader scrolls up to look at something, and resume when they scroll back.
  // A pane that yanks itself down while somebody is reading is worse than one
  // that never scrolls at all.
  function keepTail(output) {
    if (!output || typeof output.scrollHeight !== 'number') return () => {};
    const following = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    return () => { if (following) output.scrollTop = output.scrollHeight; };
  }

  // The verdict lives OUTSIDE the log pane. It used to be the pane's first line,
  // which a tail-following log scrolls out of view within seconds — so a deploy
  // would finish and the one thing the operator was waiting for was three hundred
  // lines up. This element sits directly above the pane and never scrolls.
  function ensureStatus(card, output) {
    if (!card) return null;
    let status = card.querySelector?.('.deploy-status');
    if (status) return status;
    if (!document?.createElement) return null;
    status = document.createElement('div');
    status.className = 'deploy-status';
    const parent = output?.parentNode;
    if (parent?.insertBefore) parent.insertBefore(status, output);
    else card.appendChild?.(status);
    return status;
  }

  function paint(output, run, text, card = null) {
    const status = ensureStatus(card, output);
    if (status) {
      status.textContent = headline(run).replace('\n', ' · ');
      status.className = `deploy-status ${run.status === 'running' ? 'running' : run.status === 'success' ? 'success' : 'failed'}`;
    }
    if (!output) return;
    const tail = keepTail(output);
    output.className = 'deploy-output show';
    // Without a card to hold the status line (a caller that passes a bare pane),
    // the headline stays in the pane rather than being lost.
    const heading = status ? '' : `${headline(run)}\n\n`;
    output.textContent = `${heading}${run.truncated ? '[earlier output dropped — showing the tail]\n' : ''}${text || ''}`;
    tail();
  }

  // A slot mid-deploy is a log viewer, not a form. The class drives the CSS that
  // hides the script, the version command, the backend select and Save — editing
  // the script that is currently running is meaningless, and the output is the
  // only thing worth the space. `deploy-finished` keeps the pane at the same
  // height afterwards so the card does not jump on the last chunk.
  function setCardState(card, state) {
    if (!card?.classList) return;
    card.classList[state === 'running' ? 'add' : 'remove']('deploy-running');
    card.classList[state === 'finished' ? 'add' : 'remove']('deploy-finished');
  }

  // The log view's only control, and the way back to the form. The outcome is in
  // the headline above it, so this button says what it DOES rather than what
  // happened — a button labelled "failed" invites the reading that pressing it
  // does something about the failure.
  function offerReset(card, output, label) {
    if (!card || !document?.createElement) return;
    let button = card.querySelector?.('.deploy-reset');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary small deploy-reset';
      button.addEventListener?.('click', () => {
        setCardState(card, 'idle');
        if (output) { output.textContent = ''; output.className = 'deploy-output'; }
        const status = card.querySelector?.('.deploy-status');
        if (status) { status.textContent = ''; status.className = 'deploy-status'; }
        button.remove?.();
      });
      card.appendChild(button);
    }
    button.textContent = label;
  }

  // Follow one slot's newest run to completion, painting as it goes. Returns the
  // terminal run (or null when the slot has never been deployed from this
  // workbench), and is safe to call on every panel open: a finished run simply
  // paints once and returns.
  async function follow({ base, project, target, output, card = null, intervalMs = 1500, onRunning, onDone, isHidden,
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
    paint(output, run, text, card);
    if (run.status !== 'running') { finishUp(card, output, run, text, onDone); return run; }

    setCardState(card, 'running');
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
      paint(output, run, text, card);
    }
    finishUp(card, output, run, text, onDone);
    return run;
  }

  function finishUp(card, output, run, text, onDone) {
    setCardState(card, 'finished');
    offerReset(card, output, 'Start a new deployment');
    onDone?.(run, text);
  }

  // History drill-in: the retained output of one archived run.
  //
  // It REPLACES the list rather than appending under it. The table runs to fifty
  // rows, so a log nailed to the bottom meant scrolling past every other release
  // to reach the one just clicked, and then scrolling back to find the list again.
  // One panel, two views, and a Back button that says where it goes.
  async function showArchived({ base, project, id, into }) {
    into.hidden = false;      // harmless when the view owns visibility; needed by callers that pass a bare pre
    into.textContent = 'Loading…';
    try {
      const response = await fetch(`${base}/api/deploy/${encodeURIComponent(project)}/run/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const value = await response.json().catch(() => null);
      if (response.status >= 400 || !value?.ok || !value.run) throw new Error(value?.error || `HTTP ${response.status}`);
      into.textContent = `${headline(value.run)}\n\n${value.run.truncated ? '[earlier output dropped — showing the tail]\n' : ''}${value.run.output || '(no output was captured)'}`;
    } catch (error) { into.textContent = error.message || String(error); }
  }

  // Delegated so it keeps working when a table is re-rendered under it.
  function bindHistory({ base, root = document }) {
    // Which run the list was showing when it handed over, so Back can put the
    // keyboard where it came from instead of at the top of a fifty-row table.
    let returnTo = null;
    const views = anchor => {
      const panel = anchor?.closest?.('.history-panel');
      return { panel, list: panel?.querySelector?.('.history-list'), detail: panel?.querySelector?.('.history-detail') };
    };
    const show = (anchor, which) => {
      const { list, detail } = views(anchor);
      if (!list || !detail) return null;
      list.hidden = which !== 'list';
      detail.hidden = which !== 'detail';
      return detail;
    };
    root.addEventListener('click', event => {
      const back = event.target.closest?.('.history-back');
      if (back) {
        event.preventDefault();
        const detail = show(back, 'list');
        const into = detail?.querySelector?.('.run-detail-output');
        if (into) into.textContent = '';        // nothing stale behind the next click
        returnTo?.focus?.();
        returnTo = null;
        return;
      }
      const button = event.target.closest?.('[data-run]');
      if (!button) return;
      event.preventDefault();
      const detail = show(button, 'detail');
      const into = detail?.querySelector?.('.run-detail-output');
      if (!into) return;
      returnTo = button;
      detail.querySelector?.('.history-back')?.focus?.();
      showArchived({ base, project: button.dataset.runProject, id: button.dataset.run, into });
    });
  }

  return { follow, showArchived, bindHistory, headline, paint, setCardState, keepTail };
}

export const deployFollowClientSrc = `const pwRunFollower = (${createRunFollower.toString()})();`;
