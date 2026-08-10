// Which deployment model is this instance? One answer, one place.
//
// Project Workbench ships two mutually exclusive terminal models:
//
//   host      per-project systemd units (project-terminal@.service) run ttyd as `admin`, and the
//             shared tmux server is owned by pw-tmux-server.service on the per-user default socket
//   container the node process spawns and tracks ttyd itself, drops panes to PW_TERMINAL_UID with
//             setpriv, and attaches to a tmux server owned by a sidecar on a bind-mounted socket
//
// Getting this wrong does not degrade gracefully — it produces a deployment that is wrong in a way
// nothing reports. Until this module, `app/terminal-owner.js`, `app/terminal-priv.js`,
// `app/orchestrator/config.js` and `app/server.js` each carried their own copy of
//
//     String(env.PW_DEPLOY_MODE || 'host').toLowerCase() === 'container' ? 'container' : 'host'
//
// which silently resolves BOTH "the operator typed `containr`" and "the variable is missing inside
// an obviously containerised runtime" to full host semantics: `terminalOwnerPlan` returns
// {kind:'named', user:'admin'} and panes are launched via `sudo -u admin tmux`, which is not how a
// container image is built (GOA-5).
//
// The contract:
//
//   * An explicit, recognised value is ALWAYS honoured, and always wins over evidence. Every
//     existing deployment keeps exactly the mode it has today, and an operator statement is never
//     second-guessed by a heuristic.
//   * An unset variable with NO container evidence is `host` from the documented default. That is
//     what every pre-existing `install.sh` install looks like; refusing to boot those would be a
//     worse regression than the one this fixes.
//   * Anything else — an unrecognised value, or an unset value inside a runtime that looks
//     containerised — is AMBIGUOUS. Callers fail safely at their own boundary rather than pick a
//     model. `requireDeployMode()` is the fail-safe form.
//
// Evidence is deliberately narrow. `container=` is set by podman/docker/systemd-nspawn and means
// exactly one thing; `PW_TERMINAL_UID` is only meaningful in container mode (see
// app/terminal-priv.js); `/run/.containerenv` and `/.dockerenv` are the runtimes' own markers.
// `TMUX_TMPDIR` is NOT evidence even though container mode exports it by design — a host operator
// or a test harness may equally have it set, and refusing to boot a working host box over an
// ambient variable is not "failing safely".

import fs from 'node:fs';

export const DEPLOY_MODES = Object.freeze(['host', 'container']);

/** Runtime markers a container writes about itself. Probed, never trusted to mean a specific mode. */
export const CONTAINER_MARKER_FILES = Object.freeze(['/run/.containerenv', '/.dockerenv']);

const defaultProbe = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

/**
 * Non-empty list of reasons this runtime looks containerised. Empty means "nothing suggests it",
 * which is the ordinary state of a bare-metal/VM host install.
 */
export function containerEvidence(env = {}, { probe = defaultProbe } = {}) {
  const found = [];
  const marker = String(env.container || '').trim();
  if (marker) found.push(`container=${marker}`);
  if (String(env.PW_TERMINAL_UID || '').trim()) found.push('PW_TERMINAL_UID is set (container-only, see app/terminal-priv.js)');
  for (const file of CONTAINER_MARKER_FILES) {
    if (probe(file)) found.push(file);
  }
  return found;
}

/**
 * Resolve the deployment model.
 *
 * @returns {{mode: 'host'|'container'|null, source: 'explicit'|'default', ambiguous: boolean, reason: string, evidence: string[]}}
 *          `mode` is null exactly when `ambiguous` is true.
 */
export function resolveDeployMode(env = {}, { probe = defaultProbe } = {}) {
  const raw = String(env.PW_DEPLOY_MODE ?? '').trim();
  if (raw) {
    const value = raw.toLowerCase();
    if (DEPLOY_MODES.includes(value)) {
      return { mode: value, source: 'explicit', ambiguous: false, reason: '', evidence: [] };
    }
    return {
      mode: null,
      source: 'explicit',
      ambiguous: true,
      evidence: [],
      reason: `PW_DEPLOY_MODE=${JSON.stringify(env.PW_DEPLOY_MODE)} is not one of host|container. `
        + 'Refusing to guess a terminal model: set it to the mode this instance actually runs.',
    };
  }

  const evidence = containerEvidence(env, { probe });
  if (evidence.length) {
    return {
      mode: null,
      source: 'default',
      ambiguous: true,
      evidence,
      reason: `PW_DEPLOY_MODE is unset but this runtime looks containerised (${evidence.join('; ')}). `
        + 'Host semantics would launch panes via `sudo -u admin tmux` under per-project systemd units, '
        + 'which is not how a container image is built. Set PW_DEPLOY_MODE=host|container explicitly.',
    };
  }

  return { mode: 'host', source: 'default', ambiguous: false, reason: '', evidence: [] };
}

/** The mode, or a throw naming what the operator has to set. Use at any boundary that must not guess. */
export function requireDeployMode(env = {}, opts = {}) {
  const resolved = resolveDeployMode(env, opts);
  if (resolved.ambiguous) throw new Error(resolved.reason);
  return resolved.mode;
}

/** True when this instance is container mode. Ambiguity is not container — callers must have gated already. */
export function isContainerMode(env = {}, opts = {}) {
  return resolveDeployMode(env, opts).mode === 'container';
}
