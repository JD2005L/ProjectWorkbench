# Consolidation — GovAlta-EMU/ProjWB ⇄ JD2005L (cockpit re-base)

Goal: one canonical repo both environments run from, with env-specific bits
**optional at install** (AD & non-AD). Branch `consolidate-cockpit` is re-based
directly on the JD2005L cockpit upstream; GOA-specific behavior is layered back as
opt-in flags, and our generic features are contributed upstream-side.

Loop record: `.goal-loops/consolidate-cockpit.md`.

## Status

| Area | State | Notes |
|------|-------|-------|
| Base = cockpit upstream | DONE | branch off `upstream/main` (072aa78) |
| Auth optional (`PW_AUTH_MODE=local\|ldap`) | DONE | default `local` = upstream; `ldap` = optional directory bind. See stage1-auth.md |
| Isolation foundation (`PW_ISOLATED`, env paths, `PORT`) | DONE | safe on-box testing; skips host nginx/tmux |
| `_outbox` consolidation | DONE | routes + `/files` Outbox card. C4 |
| tmux sidecar (container-mode) | DONE (artifact) | de-GOA'd unit + keepalive + reconciliation. See stage5-tmux-persistence.md |
| Quick Project Switcher dropped | DONE | absent upstream; not reintroduced. Cockpit rail is the replacement |
| Deployment Centre off-by-default | DONE (absent) | GOA feature not in upstream → naturally off; add behind `PW_DEPLOY_CENTRE` if ported |
| De-GOA defaults | DONE | no `gov.ab.ca`/`goa.ds` in `app/`; LDAP defaults are `example.com` |

## Verification on this box
Static + isolated boot only (no real install / podman / browser here):
- `node --check app/server.js && node --check app/terminal-preload.js`
- isolated-boot harness: PATH-shimmed `tmux/sudo/ttyd/nginx/systemctl/ldapwhoami`
  + temp `PW_REGISTRY_PATH/PW_USERS_PATH/PW_SESSIONS_PATH/PW_AUDIT_LOG` + free
  `PORT` + `PW_ISOLATED=1`. Covers auth (local/enforce/ldap) + outbox CRUD.
- `grep -rniE 'gov\.ab\.ca|goa\.ds' app/` → none.

## Deferred to a target environment (cannot verify on the consolidation box)
- **Container deploy path (Stage 2b):** `Containerfile`, `.containerignore`,
  `scripts/entrypoint.sh` (TMUX_TMPDIR wait), `deploy-local.sh`, `DEPLOY.md`, and
  `PW_DEPLOY_MODE=host|container` terminal-spawn duality in `app/server.js`
  (host: `project-terminal@.service` + `sudo -u admin tmux`; container:
  node-spawned ttyd + root tmux on the shared socket). Needs `podman build` + a
  real install.
- **Deployment Centre (Stage 4):** if GOA's WinRM/SMB deploy UI is contributed to
  the canonical repo, gate it behind `PW_DEPLOY_CENTRE` (default off).
- **Browser UI validation:** cockpit rail/hover-drawer + the richer in-terminal
  tabbed Inbox/Outbox drawer overlay; force-motion; a11y. Needs a real browser.
- **Upstream PR:** open a PR from `consolidate-cockpit` to `JD2005L/ProjectWorkbench`.
- **PVI/GOA de-environment:** `managedProjects` is a hardcoded PVI list upstream;
  should become config so neither org's project names are baked in.
