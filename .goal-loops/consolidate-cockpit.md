# Goal-loop: consolidate-cockpit

**Feature:** Re-base GovAlta-EMU/ProjWB onto the JD2005L cockpit upstream to produce
ONE canonical common tree: cockpit UI + our generic features (`_outbox`+tabbed drawer,
persistent-tmux sidecar) + all env-specifics OPTIONAL at install (AD & non-AD both);
Quick Project Switcher dropped (superseded by cockpit rail).

**Branch:** `consolidate-cockpit` off `upstream/main` (JD2005L 072aa78, cockpit).
**Worktree:** /opt/project-workbench/workspaces/pw-cockpit
**Confirmed by user 2026-07-15.** Base strategy: re-base onto cockpit (chosen).

## Key facts / references
- Upstream cockpit (read-only): /opt/project-workbench/workspaces/.jd2005l-cockpit (072aa78);
  old pre-cockpit upstream: /opt/project-workbench/workspaces/.jd2005l-ref (887758a).
- Prior GOA overlays (reference impl, on OLD upstream): worktree
  /opt/project-workbench/workspaces/pw-consolidate (branch consolidate-jd2005l),
  docs/consolidation/stage{1..4}.md. Stages 1-3 impl, Stage 4 spec-only.
- Our GOA main (feature source): /opt/project-workbench/workspaces/ProjectWorkbench (d00db8d).
- CANNOT run real installs/podman/systemctl/browser here → verify = node --check +
  isolated boot (PW_ISOLATED=1, temp paths, PATH-shim tmux/ttyd/pkill) + greps.
  Real install-matrix + browser UI proof + upstream PR = DEFERRED follow-ups.

## Acceptance criteria
| # | Criterion | Status | Attempts |
|---|-----------|--------|----------|
| C1 | Branch off upstream cockpit; cockpit is git ancestor; node --check clean | PASS | 1 |
| C2 | PW_AUTH_MODE=local|ldap (default local); isolated boot local login→cookie, authed /→200, unauth→/login under enforce; ldap boots + pw reset→400 | PASS | 1 |
| C3 | Quick Switcher absent from app/ (no openSwitcher/projSwitch/pw-open-switcher/Shift+P); cockpit rail present | PENDING | 0 |
| C4 | _outbox + tabbed Inbox/Outbox drawer present+wired; outbox routes; INBOX_WRITE_ROLES; isolated create→list→delete | PENDING | 0 |
| C5 | tmux sidecar files present, reconciled w/ upstream reboot-persist (no double socket-ownership); bash -n clean; CA mount de-GOA'd | PENDING | 0 |
| C6 | GOA optional/off: PW_DEPLOY_CENTRE default off (deploy routes 404), PW_DEPLOY_MODE host|container, de-GOA LDAP/cert defaults; no gov.ab.ca/goa.ds in app/ | PENDING | 0 |
| C7 | Non-regression: cockpit routes (/api/projects/{status,reorder,config}, /manage redirect) + PVIKPBot handoff preserved; healthz ok | PENDING | 0 |
| C8 | Consolidation docs updated for cockpit re-base; this loop-log maintained | PENDING | 0 |

## Increment plan
0. Branch off upstream cockpit + open loop-log. → C1
1. Port Stage-1 auth optionalization (PW_AUTH_MODE, superset user, sessions, de-GOA LDAP) onto cockpit server.js. → C2, C6(auth)
2. Port _outbox + tabbed drawer into cockpit + outbox routes + role gating. → C4
3. tmux sidecar files + reconcile w/ upstream reboot-persist + de-GOA CA (build-arg). → C5
4. Gate deploy-centre (Stage 4) + deploy-mode scaffold (Stage 2) + de-GOA remaining. → C6
5. Confirm switcher gone; update consolidation docs. → C3, C8
6. Independent verification sweep (subagent per non-trivial criterion), fixes, final. → C7, all

## Iteration log
### 2026-07-15 — iter 1 (increment 0)
- Added `upstream` remote (JD2005L/ProjectWorkbench); shared ancestor e319b05 confirmed.
- Created branch `consolidate-cockpit` + worktree pw-cockpit off upstream/main (072aa78).
- Baseline probes: rail/manageModal/pvikpbot PRESENT; switcher/outbox/PW_AUTH_MODE/PW_ISOLATED ABSENT (as expected). node --check clean on server.js + terminal-preload.js.
- C1 PASS (pending independent verify in sweep). Next: iter 2 = Stage-1 auth port.

### 2026-07-15 — iter 2 (increment 1: Stage-1 auth optionalization + isolation foundation)
- Change (app/server.js):
  - Auth: PW_AUTH_MODE=local|ldap (default local, boot-logged); de-GOA'd LDAP consts
    (PW_LDAP_URL/SUFFIX/CACERT/LOGIN_ORG); ldapBindOnce/isRetryableLdapError/ldapBind
    (ldapwhoami, no native deps) + normalizeUsername + shared authenticate(); login
    route rewired to authenticate(); user-create + password-reset made mode-aware
    (ldap: no local password, reset→400); login page mode-aware (PW_LOGIN_ORG).
    Env-overridable users/sessions/audit paths; SESSION_TTL via PW_SESSION_HOURS
    (default 720h=30d, preserves upstream). Session model reused as-is (already matched).
  - Isolation foundation (safe verify on shared box): env-overridable
    registryPath(PW_REGISTRY_PATH)/nginxPath(PW_NGINX_CONF)/workspaceRoot; CANONICAL_REGISTRY
    + ISOLATED guard; applyRouting skips host nginx when ISOLATED; PORT overridable;
    orphan-sweep gated off when ISOLATED.
- Verify: node --check clean. Isolated-boot harness (/tmp/pw-auth-verify.sh, PATH-shimmed
  tmux/sudo/ttyd/nginx/systemctl/ldapwhoami + temp paths): **16/16 PASS** —
  local: boot, create admin, login+cookie, me, bad-pw→401, pw-reset ok, /term 200 + rail,
  logout revokes; enforce: unauth /→/login, authed /→cockpit (not login); ldap: boot,
  org label on login page, pw-reset→400, create-without-password. grep app/ for GOA
  literals → none.
- C2 PASS (independent sweep deferred to iter for increment 6).
- Deviations/notes: normalizeUserRecord not ported (cockpit records already canonical);
  BASE-path + host/container terminal-model reconciliation (upstream uses sudo -u admin
  tmux + project-terminal@.service; GOA uses root tmux + node-spawned ttyd) DEFERRED to a
  later increment; `managedProjects` PVI list still hardcoded (de-env later).
- Next: iter 3 = increment 2 (_outbox + tabbed drawer into cockpit).
