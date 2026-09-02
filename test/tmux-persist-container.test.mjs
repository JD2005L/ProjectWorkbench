// Container-mode tmux session persistence, and the privilege drop that makes it
// safe to turn on at all.
//
// THE DEFECT THIS GUARDS. pw-tmux-restore recreates every saved session at boot
// with `env … bash --noprofile --norc` and no privilege drop. In host mode that is
// correct — the script already runs unprivileged there. In CONTAINER mode the
// caller is pw-tmux-keepalive.sh running as the sidecar's root, so wiring restore
// in without a drop would hand every recreated session a ROOT shell inside a
// workspace the agent account owns: the same defect fixed for the boxes
// (app/workspace-file.js), the preview (startPreviewUnit) and the deploy slots
// (deployExec), reintroduced at every boot with nobody watching.
//
// So the drop is asserted two ways: the resolver's real output, and the refusal
// that must fire when it cannot be resolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HELPER = path.join(REPO, 'scripts', 'pw-tmux-pane-drop');

/** Run the drop resolver with a given env; return its three lines. */
function drop(env) {
  const out = execFileSync(process.execPath, [HELPER], {
    env: { ...env },
    encoding: 'utf8',
  });
  const [prefix, user, home] = out.split('\n');
  return { prefix, user, home };
}

test('pane-drop resolver: OFF yields an empty prefix (host mode, or no PW_TERMINAL_UID)', () => {
  for (const env of [{}, { PW_TERMINAL_UID: '1001' }, { PW_DEPLOY_MODE: 'host', PW_TERMINAL_UID: '1001' }, { PW_DEPLOY_MODE: 'container' }]) {
    assert.equal(drop(env).prefix, '', JSON.stringify(env));
  }
});

test('pane-drop resolver: container + uid yields the setpriv prefix and the pane identity', () => {
  const d = drop({ PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1001', PW_TERMINAL_GID: '1001', PW_TERMINAL_USER: 'admin', PW_TERMINAL_HOME: '/home/admin' });
  assert.equal(d.prefix, '/usr/bin/setpriv --reuid 1001 --regid 1001 --init-groups');
  assert.equal(d.user, 'admin');
  assert.equal(d.home, '/home/admin');
  // No `/usr/bin/env` token: the caller supplies its own `env KEY=VAL… bash …`
  // list, and a prefix that re-execs through env(1) would clobber it.
  assert.ok(!d.prefix.includes('/usr/bin/env'), 'the prefix must not re-exec through env(1)');
});

test('pane-drop resolver stays in step with the resolver the dashboard panes use', async () => {
  // The point of the helper is that there is ONE resolver. If someone
  // re-implements the drop in shell, this is what should start failing.
  const { resolveTerminalPriv, agentSpawnDrop } = await import('../app/terminal-priv.js');
  const env = { PW_DEPLOY_MODE: 'container', PW_TERMINAL_UID: '1234', PW_TERMINAL_GID: '5678', PW_TERMINAL_USER: 'paneacct', PW_TERMINAL_HOME: '/home/paneacct' };
  assert.equal(drop(env).prefix, agentSpawnDrop(resolveTerminalPriv(env)).join(' '));
  assert.match(read('scripts/pw-tmux-pane-drop'), /from '\.\.\/app\/terminal-priv\.js'/, 'the helper no longer imports the shared resolver');
});

test('restore applies the drop at the ONE chokepoint every pane command passes through', () => {
  const src = read('scripts/pw-tmux-restore');
  // resolve_session_credentials() sets cred_env_prefix, and both `new-session`
  // and every `new-window` (via SESSENV) launch exactly that string.
  assert.match(src, /cred_env_prefix="\$PANE_DROP \$cred_env_prefix"/, 'the pane command is no longer wrapped with the privilege drop');
  assert.match(src, /USER=\$PANE_USER LOGNAME=\$PANE_USER/, 'the dropped pane no longer reports the pane account as USER/LOGNAME');
  // Both launch sites must still read only that variable, or a future call site
  // could bypass the wrap.
  assert.match(src, /new-session -d -P -F '#\{window_index\}' -s "\$s" -c "\$cwd" "\$cred_env_prefix"/);
  assert.match(src, /new-window -d -P -F '#\{window_index\}' -t "\$s:" -c "\$cwd" "\$\{SESSENV\[\$s\]\}"/);
});

test('restore REFUSES rather than creating root panes when the drop cannot be resolved', () => {
  const src = read('scripts/pw-tmux-restore');
  const i = src.indexOf('REFUSING TO RESTORE');
  assert.notEqual(i, -1, 'the container-mode root-without-drop refusal is gone');
  const block = src.slice(Math.max(0, i - 700), i + 400);
  assert.match(block, /container/, 'the refusal is no longer gated on container mode');
  assert.match(block, /-z "\$PANE_DROP"/, 'the refusal no longer keys on an unresolved drop');
  assert.match(block, /EUID/, 'the refusal no longer checks that it is running as root');
  assert.match(block, /exit "\$CONFIG_ERROR_EXIT"/, 'the refusal no longer exits with the misconfiguration code');
});

test('keepalive names NO environment-specific path: persistence is deployment-supplied', () => {
  const src = read('scripts/pw-tmux-keepalive.sh');
  // tmux-owner-dispositions pins this: the shared owner script must not carry one
  // site's layout. So the four paths are REQUIRED FROM THE DEPLOYMENT (the unit),
  // and persistence declines loudly when they are absent rather than defaulting.
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const bad of [/\/home\/admin\b/, /\.local\b/, /\/etc\/project-workbench/, /\bgoa\b/i]) {
    assert.equal(code.match(bad), null, `keepalive embeds an environment-specific literal in code: ${code.match(bad)}`);
  }
  assert.match(src, /for v in PW_TMUX_STATE_DIR PW_CLAUDE_SESSIONS_DIR PW_CLAUDE_PROJECTS_DIR PW_REGISTRY_PATH PW_APP_DIR/,
    'the deployment-supplied path contract is gone');
  assert.match(src, /session persistence OFF: the deployment did not supply/,
    'a deployment that supplies nothing must be told, not silently half-enabled');
  // The scripts' own default state dir is container-local, so defaulting it would
  // silently lose every snapshot at the recreate it exists to survive.
  assert.match(src, /findmnt -no FSTYPE -T "\$PW_TMUX_STATE_DIR"/,
    'the container-local-filesystem warning is gone — a lost snapshot would be silent');
});

test('keepalive snapshots on shutdown and on an interval, and host mode is untouched', () => {
  const src = read('scripts/pw-tmux-keepalive.sh');
  assert.match(src, /term\(\) \{ pw_snapshot shutdown; exit 0; \}/,
    'no snapshot on SIGTERM — a planned rebuild would lose the session state');
  assert.match(src, /sleep "\$PW_TMUX_SAVE_INTERVAL" &\n\twait \$!/,
    'a bare sleep would delay the shutdown snapshot by up to a full interval');
  // Host mode already has pw-tmux-persist.service + pw-tmux-save.timer.
  assert.match(src, /if \[\[ "\$HOST_MODE" != 1 \]\]; then/, 'persistence is no longer gated to container mode');
  // set -u: the supervise loop reads the interval in BOTH modes, so its default
  // must sit outside the container-only branch.
  const iv = src.indexOf(': "${PW_TMUX_SAVE_INTERVAL:=120}"');
  const branch = src.indexOf('if [[ "$HOST_MODE" != 1 ]]; then\n\tpersist_missing=()');
  assert.ok(iv !== -1 && iv < branch, 'PW_TMUX_SAVE_INTERVAL default moved inside the branch — host mode aborts on set -u');
});

test('the helper is installed BESIDE app/ in both deployments, never flat', () => {
  // Flat on PATH the relative import resolves /usr/local/app/terminal-priv.js
  // and dies ERR_MODULE_NOT_FOUND — the Round 12 defect.
  assert.match(read('install.sh'), /install -m 0755 "\$SRC_DIR\/scripts\/pw-tmux-pane-drop"\s+"\$PW_INSTALL_DIR\/scripts\/pw-tmux-pane-drop"/);
  assert.match(read('install.sh'), /ln -sfn "\$PW_INSTALL_DIR\/scripts\/pw-tmux-pane-drop"\s+\/usr\/local\/bin\/pw-tmux-pane-drop/);
  // Container: symlinked from the bind-mounted scripts dir, which sits beside app/.
  assert.match(read('Containerfile'), /pw-tmux-assert-owner pw-tmux-pane-drop/);
});
