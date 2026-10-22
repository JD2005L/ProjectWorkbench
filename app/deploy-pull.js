// "Pull latest", offered up front: when a project's workspace is behind its remote, its Deploy
// buttons are replaced by a Pull button before anyone presses Deploy, rather than after the
// deploy has been refused.
//
// The server half is two routes in server.js:
//   GET  /api/deploy/:project/workspace/upstream  the same comparison a deploy makes first
//                                                 (deployment/source.js checkUpstream, as the
//                                                 pane account, ls-remote: nothing written)
//   POST /api/deploy/:project/workspace/pull      fast-forward only, as the pane account
//                                                 (deployment/prod-status.js fastForwardWorkspace)
// The deploy route still refuses a workspace that is behind; this only means the operator sees
// the way forward first. Pulling deploys nothing: Deploy comes back once the workspace is current.
//
// Two surfaces use it verbatim, as with deploy-follow.js: the cockpit modal and the standalone
// Deployment Centre page.
export function createDeployPull(environment = globalThis) {
  const { fetch, document } = environment;
  const IDLE = '⬇ Pull latest';

  const cardsOf = (scope, project) => [...scope.querySelectorAll('.target-card')]
    .filter((card) => !card.dataset.project || card.dataset.project === project);

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // One sentence for the card, from the upstream comparison.
  function noteFor(u) {
    if (u.state === 'behind') {
      const n = Number.isInteger(u.behind) && u.behind > 0 ? plural(u.behind, 'commit') + ' ' : '';
      return 'This workspace is ' + n + 'behind ' + (u.upstream || 'its remote') + (u.unfetched ? ' (new commits on the remote)' : '') +
        '. Pull it before deploying: a deploy from here would be refused.';
    }
    if (u.state === 'diverged') {
      return 'This workspace and ' + (u.upstream || 'its remote') + ' have diverged (' + (u.ahead || '?') + ' local, ' + (u.behind || '?') +
        ' remote). Reconcile them in the terminal (git pull --rebase or a merge), then deploy.';
    }
    return '';
  }

  function setDeployVisible(card, visible) {
    card.querySelectorAll('.deploy-btn').forEach((btn) => {
      if (visible) { if (btn.dataset.pullHidden) { btn.style.display = btn.dataset.pullHidden === '-' ? '' : btn.dataset.pullHidden; delete btn.dataset.pullHidden; } }
      else if (!btn.dataset.pullHidden) { btn.dataset.pullHidden = btn.style.display || '-'; btn.style.display = 'none'; }
    });
  }

  function clear(card) {
    card.querySelectorAll('.pull-front').forEach((el) => el.remove());
    setDeployVisible(card, true);
  }

  function say(card, text) {
    const out = card.querySelector('.deploy-output');
    if (!out) return;
    out.className = 'deploy-output show';
    out.textContent = text;
  }

  function render(scope, project, base, u) {
    for (const card of cardsOf(scope, project)) {
      const note = noteFor(u);
      if (!note) { clear(card); continue; }
      let front = card.querySelector('.pull-front');
      if (!front) {
        front = document.createElement('div');
        front.className = 'pull-front';
        const anchor = card.querySelector('.deploy-btn');
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(front, anchor);
        else card.appendChild(front);
      }
      front.textContent = '';
      front.dataset.state = u.state;
      if (u.state === 'behind') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pull-btn';
        btn.textContent = IDLE;
        btn.onclick = () => pull(scope, project, base, btn);
        front.appendChild(btn);
      }
      const p = document.createElement('div');
      p.className = 'pull-note';
      p.textContent = note;
      front.appendChild(p);
      setDeployVisible(card, false);
    }
  }

  async function getJson(url, options) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!j) throw new Error('The dashboard is not answering (' + r.status + ')');
    return j;
  }

  async function check(scope, project, base) {
    if (!scope || !project) return null;
    let u;
    try { u = await getJson(base + '/api/deploy/' + encodeURIComponent(project) + '/workspace/upstream'); }
    catch { return null; }
    if (!u || !u.ok) return null;
    render(scope, project, base, u);
    return u;
  }

  async function pull(scope, project, base, btn) {
    const cards = cardsOf(scope, project);
    cards.forEach((card) => card.querySelectorAll('.pull-btn').forEach((b) => { b.disabled = true; b.textContent = 'Pulling…'; }));
    let x;
    try {
      x = await getJson(base + '/api/deploy/' + encodeURIComponent(project) + '/workspace/pull',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { x = { ok: false, message: e.message || String(e) }; }
    const text = (x.ok ? '✅ ' : '⚠️ ') + (x.message || x.error || 'The pull failed.');
    const where = (btn && btn.closest && btn.closest('.target-card')) || cards[0];
    if (where) say(where, text);
    const u = await check(scope, project, base);
    if (!u) cards.forEach((card) => card.querySelectorAll('.pull-btn').forEach((b) => { b.disabled = false; b.textContent = IDLE; }));
    if (x.ok) {
      // The source the panel shows has moved; the surface refreshes its own badges on this event.
      if (x.sourceVersion) scope.querySelectorAll('.version.source').forEach((el) => { el.textContent = x.sourceVersion; });
      try { scope.dispatchEvent(new environment.CustomEvent('pw-pulled', { bubbles: true, detail: { project, result: x } })); } catch { /* no CustomEvent */ }
    }
    return x;
  }

  return { check, pull, render, noteFor };
}

export const deployPullClientSrc = `const pwDeployPull = (${createDeployPull.toString()})();`;
