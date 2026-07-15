# Stage 5 — tmux session persistence: two complementary mechanisms

The canonical tree carries **two** tmux-persistence mechanisms, selected by deploy
mode. They solve different failure modes and coexist cleanly.

## Host mode (upstream default) — survive a REBOOT
Upstream's bare-host install keeps terminals across a machine reboot:
- `systemd/pw-tmux-persist.service`, `systemd/pw-tmux-save.service` + `.timer`
- `scripts/pw-tmux-save` / `scripts/pw-tmux-restore` (dump/restore pane content)
- per-project terminals are `project-terminal@.service` units; the tmux server
  runs on the host.

## Container mode — survive an APP-CONTAINER RESTART
The GOA deployment runs the dashboard in a podman container; a full container
restart used to wipe every project's tmux server (all shells/agents/scrollback).
The sidecar fixes that:
- `systemd/pw-tmux.service` — a dedicated always-on `pw-tmux` sidecar container
  (same image) that holds the tmux server in ITS OWN cgroup.
- `scripts/pw-tmux-keepalive.sh` — brings up the server with a non-`pw_`
  `_keepalive` session (so the orphan-sweep never touches it) and idles.
- Shared socket: host dir `/opt/project-workbench/run/tmux`, bind-mounted into
  both containers, with `TMUX_TMPDIR` pointed at it. The app's tmux clients and
  ttyd's `tmux attach` all connect to the sidecar's server.
- Result: restarting the app container preserves every session; only restarting
  `pw-tmux` itself loses them.

## Boundary / how they relate
- The single boundary is **`TMUX_TMPDIR` socket ownership**. In container mode the
  app entrypoint waits for the sidecar's `_keepalive` server before starting node,
  so the app never spawns its own server in the wrong cgroup.
- Host reboot-persistence (save/restore) and container restart-survival (sidecar)
  are orthogonal: one restores content after the whole host reboots, the other
  keeps the live server alive across an app-container restart. A containerized
  install can use both without conflict, because only ONE tmux server ever owns
  the socket.

## De-GOA
`pw-tmux.service` here is generic: the GOA-only CA mount (`/etc/pki/goa-ca`) and
`pw-trust-goa-ca.sh` ExecStartPost were removed. In the canonical repo, container
CA trust arrives via the image (`PW_CA_CERTS` build-arg, Stage 2b), not a host
bind-mount.

## Deferred to the container deploy path (Stage 2b) — needs a target env
The remaining container-mode wiring is part of Stage 2b and cannot be built/run on
the consolidation box (no `podman build` / real install):
- `Containerfile`, `.containerignore`
- `scripts/entrypoint.sh` (the `TMUX_TMPDIR` wait-for-sidecar block)
- `deploy-local.sh` (scoped node-only restart), `DEPLOY.md`
- `PW_DEPLOY_MODE=host|container` selection of the terminal-spawn model in
  `app/server.js` (host: `project-terminal@.service` + `sudo -u admin tmux`;
  container: node-spawned ttyd + root tmux on the shared socket).

This increment lands the sidecar unit + keepalive (the container-mode persistence
artifacts) and this reconciliation; the full container path + its runtime
verification (podman build + install-matrix) is a follow-up on a target host.
