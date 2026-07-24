// Non-root agent terminals.
//
// When PW_TERMINAL_UID is set, interactive shell panes are dropped to that uid
// via `setpriv --reuid <uid> --regid <gid> --init-groups /usr/bin/env` so that
// agents (claude / copilot / bash) never run as the app's root uid.
//
// IMPORTANT: this drop is only valid in CONTAINER mode. There PW's tmux() runs
// as root (see server.js) and can lower privileges. In HOST mode PW already
// spawns panes via `sudo -u admin tmux ...`, i.e. from an unprivileged process;
// layering `setpriv --init-groups` on top of that fails with
//   setpriv: initgroups failed: Operation not permitted
// and is unnecessary, because the pane is already non-root. So the wrap is
// gated to container mode. Unset PW_TERMINAL_UID (or host mode) => passthrough,
// byte-identical to upstream.

export function resolveTerminalPriv(env = {}) {
  const uid = String(env.PW_TERMINAL_UID || '');
  const mode = String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host';
  if (!uid || mode !== 'container') {
    return { enabled: false, uid: '', gid: '', home: '', user: '', extraPath: '' };
  }
  return {
    enabled: true,
    uid,
    gid: String(env.PW_TERMINAL_GID || uid),
    home: env.PW_TERMINAL_HOME || '/home/admin',
    user: env.PW_TERMINAL_USER || 'admin',
    extraPath: env.PW_TERMINAL_EXTRA_PATH || '',
  };
}

// Wrap a canonical ['env', 'HOME=...', ...] token list so the pane runs as
// priv.user. Returns the array unchanged when priv.enabled is false.
export function wrapAgentEnv(priv, canonicalTokens) {
  if (!priv || !priv.enabled) return canonicalTokens;
  const kv = canonicalTokens.slice(1).map((tok) => {
    if (tok.startsWith('HOME=')) return `HOME=${priv.home}`;
    if (tok.startsWith('PATH=') && priv.extraPath) return `${tok}:${priv.extraPath}`;
    return tok;
  });
  if (!kv.some((t) => t.startsWith('USER='))) kv.splice(1, 0, `USER=${priv.user}`, `LOGNAME=${priv.user}`);
  if (!kv.some((t) => t.startsWith('IS_SANDBOX='))) kv.push('IS_SANDBOX=1');
  if (!kv.some((t) => t.startsWith('COPILOT_AUTO_UPDATE='))) kv.push('COPILOT_AUTO_UPDATE=false');
  return ['/usr/bin/setpriv', '--reuid', String(priv.uid), '--regid', String(priv.gid), '--init-groups', '/usr/bin/env', ...kv];
}

// setpriv drop prefix for a direct (non-tmux) login spawn such as the _setup
// ttyd. Returns [] when disabled.
export function agentLoginDrop(priv) {
  if (!priv || !priv.enabled) return [];
  return ['/usr/bin/setpriv', '--reuid', String(priv.uid), '--regid', String(priv.gid), '--init-groups', '/usr/bin/env', `HOME=${priv.home}`, `USER=${priv.user}`, `LOGNAME=${priv.user}`];
}