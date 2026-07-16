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
| C3 | Quick Switcher absent from app/ (no openSwitcher/projSwitch/pw-open-switcher/Shift+P); cockpit rail present | PASS | 1 |
| C4 | _outbox routes + /files Outbox card present+wired; INBOX_WRITE_ROLES/terminal-access gating; isolated create→list→download→delete | PASS | 1 |
| C5 | tmux sidecar unit+keepalive present, de-GOA'd, reconciled w/ upstream reboot-persist (doc, single socket-owner); bash -n clean; unit verifies | PASS | 1 |
| C6 | GOA optional/off: deploy-centre absent→off, de-GOA LDAP/cert defaults, no gov.ab.ca/goa.ds in app/ (PW_DEPLOY_MODE container path deferred) | PASS | 1 |
| C7 | Non-regression: cockpit routes + PVIKPBot handoff preserved (independent code-review CONFIRMED, no regressions) | PASS | 1 |
| C8 | Consolidation docs updated for cockpit re-base; this loop-log maintained | PASS | 1 |

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

### 2026-07-15 — iter 3 (increment 2: _outbox consolidation)
- Change (app/server.js): ported the 4 _outbox routes from the GOA fork (de-BASE'd
  to cockpit's bare-path convention): GET /api/outbox/:project (list), GET
  /api/outbox/:project/file/:name (download), DELETE .../file/:name, DELETE
  /api/outbox/:project (clear). Gating reused from cockpit: list/download =
  requireAuth+requireProjectAccess; mutations = requireTerminalAccess. Added an
  "Outbox" card + refreshOutbox() client JS to the existing /files/:project/ page
  (reuses cockpit's own .f-card/.ilist/.irow pattern).
- Verify: node --check clean; harness now 21/21 — new: outbox list shows agent
  file, download returns body, /files renders Outbox card (id="olist"), delete
  file, file gone from disk. No GOA literals.
- C4 PASS (verifiable scope). DEFERRED to browser stage (documented manual test
  plan): grafting the GOA fork's richer IN-TERMINAL tabbed Inbox/Outbox drawer
  overlay into the cockpit /term page — needs interactive validation and risks the
  cockpit rail/hover-drawer layout, so not done blind here. Outbox capability +
  management is fully present via /files.
- Next: iter 4 = increment 3 (tmux sidecar + reconcile with upstream reboot-persist).

## Manual test plan (browser stage, deferred items)
- /files/<proj>/: Inbox drop/paste/upload still works; Outbox card lists agent
  files, Download saves, Delete removes; role gating (content_editor can view+
  download, terminal roles can delete).
- (Deferred drawer) If the in-terminal tabbed drawer is later grafted into /term:
  verify it opens over the cockpit without breaking the left rail hover-peek, tab
  switching Inbox/Outbox, paste-to-inbox, and OSC-52 copy.

### 2026-07-15 — iter 4 (increment 3: tmux sidecar consolidation, scoped)
- Upstream cockpit is HOST-ONLY (no Containerfile/entrypoint/deploy-local); it has
  reboot-persistence (pw-tmux-save/restore + pw-tmux-persist) + project-terminal@.
  Our sidecar is a CONTAINER-mode artifact (restart-survival).
- Change: added systemd/pw-tmux.service (de-GOA'd: removed /etc/pki/goa-ca mount +
  pw-trust-goa-ca.sh ExecStartPost) + scripts/pw-tmux-keepalive.sh (generic) +
  docs/consolidation/stage5-tmux-persistence.md (reconciliation: host reboot-persist
  vs container restart-survival; single socket-owner boundary via TMUX_TMPDIR).
- Verify: bash -n keepalive OK; systemd-analyze verify pw-tmux.service clean; no GOA
  literals in the unit/keepalive.
- C5 PASS (artifact + reconciliation scope). DEFERRED (needs target env, Stage 2b):
  full container path — Containerfile, scripts/entrypoint.sh TMUX_TMPDIR wait,
  deploy-local.sh, DEPLOY.md, and PW_DEPLOY_MODE host|container terminal-spawn
  duality in server.js. Documented in stage5 doc.

### 2026-07-15 — iter 5 (increments 4+5: switcher-drop confirmation, de-GOA, docs)
- C3: grep app/ → 0 openSwitcher/projSwitch/pw-open-switcher/Shift+P anywhere
  (server.js + terminal-preload.js + terminal-paste.js); cockpit rail present (3 refs).
  Switcher is dropped (absent upstream; not reintroduced).
- C6 (verifiable scope): no gov.ab.ca/goa.ds in app/; Deployment Centre absent
  upstream → naturally off (no /api/deploy routes); LDAP defaults de-GOA'd (example.com
  from iter 2). PW_DEPLOY_MODE + deploy-centre gating = deferred container path.
- C8: added docs/consolidation/README.md (status matrix + verification method +
  deferred-to-target-env list) alongside stage5 doc.
- Next: iter 6 = independent verification sweep (subagent) + bounded-stop summary.

### 2026-07-15 — iter 6 (independent verification sweep + security fix)
- Skeptical code-review subagent (adversarial, try-to-refute): C2/C3/C4 CONFIRMED,
  no regressions, no auth bypass, no _outbox traversal escape, prod path unaffected
  by the ISOLATED guards.
- Fix applied (Medium/High the reviewer found in the ported LDAP bind): the
  directory password was passed via `-w` on ldapwhoami's argv → readable in
  world-readable /proc/<pid>/cmdline (this host grants shells to terminal roles).
  Changed ldapBindOnce to feed the password via stdin (`-y /dev/stdin`, spawn,
  no trailing newline) so it never appears in argv. Also added an empty-password
  guard inside authenticate() (never attempt an unauthenticated empty-password bind).
- Verify: node --check clean; static proof no `-w` remains (uses `-y /dev/stdin`);
  full harness re-run 21/21. Real-DC bind behavior validation remains a target-env
  (ldap) follow-up (harness shims ldapwhoami).
- All in-scope criteria PASS. Bounded stop: deploy-layer (container path Stage 2b,
  deploy-centre gating, PW_DEPLOY_MODE terminal-model duality), browser UI proof,
  and the upstream PR are documented follow-ups needing a target environment.

## RESULT: in-scope criteria (C1–C8) PASS, independently verified. Loop paused at
## bounded stop; deploy-layer + browser + upstream-PR follow-ups documented.

## 2026-07-15 — Loop 2: env-optional parity (verifiable-here increments)
Scope: advance canonical toward env-optional feature-superset (browser/target-env/PR
items deferred). Goal-loop skill installed at ~/.copilot/skills/goal-loop.

### iter 7 — de-bake managedProjects + port admin-only gating (commit ff3ac94)
- Removed dead `managedProjects` PVI list (no env project names baked in).
- Ported admin-only project gating (GOA→canonical, generically useful): hidden from
  non-admins (filterProjectsForUser), 403 on page/API (requireProjectAccess) and on
  the nginx auth_request /api/auth/check (gates the ttyd pty), config carries it,
  /manage/add+update set-or-delete, Manage modal "Admin only" checkbox.
- PVIKPBot handoff already optional (only entry is the PW_INTERNAL_HANDOFF_TOKEN-gated
  route → 403 without token); no change needed.
- Verify: isolated boot w/ REAL non-admin login (PW_AUTH_MODE=local, enforce): admin-only
  project hidden from developer rail; /term + auth/check 403 for dev, 200 for admin;
  config adminOnly present; modal field present; adminOnly preserved on update; scripts
  parse; node --check clean. Independent code-review in progress.

## REMAINING TO FULLY UNIFY (roadmap) — what each needs
Verifiable-here (candidates for future canonical loops):
- Contribute more GOA generic fields to the modal/config: primaryUser (git identity),
  devUrl/prodUrl (server links). Small.
- Pulse: make its nginx routes optional in canonical behind a flag (PW_PULSE). Medium.
DEFERRED — needs a capability this box lacks:
- Full cockpit restyle in the GOA deploy (shell/stage, tokens, top-bar/tabs/tray) +
  mobile rail toggle → needs a BROWSER to verify.
- Stage 2b PW_DEPLOY_MODE=host|container (BASE prefixing, container ttyd model vs
  project-terminal@.service, Containerfile/entrypoint/deploy-local, nginx gen) — the
  true unifier that lets GOA run FROM this canonical repo → needs a TARGET HOST + podman.
- Deployment Centre → PW_DEPLOY_CENTRE (WinRM/SMB deploy UI+toolchain) → GOA machinery,
  large, needs deploy targets.
- Real host+container install matrix; real-DC LDAP bind → target env.
- PR: consolidate-cockpit → JD2005L/ProjectWorkbench; then point GOA at the canonical
  repo and retire the GOA-specific server.js.

### iter 8 — independent review + security fix (auth_request project forwarding)
- Review verdict: adminOnly visibility/app-route gating CONFIRMED clean; but found a
  HIGH gap (pre-existing, exposed by the port): the nginx auth_request for the raw
  ttyd pty/preview never forwarded `project`, so /api/auth/check returned 200 → a
  non-admin could load an adminOnly project's raw shell directly (bypassing /term).
- Fix: /pw-auth-check sends X-Original-URI=$request_uri; /api/auth/check derives the
  project (+ _setup admin scope) from the path (BASE-agnostic).
- Verified end-to-end: empirical nginx auth_request test proved $request_uri is
  forwarded (X-Original-URI=/pty/SecretProj/…); handler 403s dev at
  /pty|/preview/<adminOnly>/ + /pty/_setup/, 200 at granted; admin ok. node --check clean.
- NOTE: the GOA live deploy (deploy-cockpit-ui) has the SAME latent gap (auth_request
  doesn't forward project). Not currently exploitable (no non-admin users exist), but
  the same fix should be ported there. FLAGGED for the user.

### iter 9 — #2 PW_BASE_PATH (URL base-path prefix) — DONE
- Goal: canonical serves+links under `PW_BASE_PATH` (e.g. /workbench); default ''
  = byte-identical to upstream (root-served). Foundational for PW_DEPLOY_MODE=container.
- Change (app/server.js only): `const BASE=(process.env.PW_BASE_PATH||'').replace(/\/+$/,'')`;
  prefixed all 54 route decls with `BASE +`; prefixed 86 client URLs (fetch/href/src/
  action/iframe/location.href/res.redirect) with `${BASE}`; nginxConfig locations +
  auth_check upstream + knownDashboardPaths + preview X-Forwarded-Prefix/redirect + pw_last
  referer map made BASE-aware. Cookie Path stays `/` (sibling SSO). ttyd upstreams stay
  bare (ttyd --base-path is bare) — only the nginx `location` carries BASE.
- Verified (isolated boot, both modes):
  * BASE=/workbench: / →302 /workbench/term/Demo/; /workbench/api/projects/status 200;
    /workbench/term/Demo/ 200; /workbench/manage →302 …?manage=1; root / and /api →404;
    rendered pages: all href/src/iframe carry /workbench; ZERO bare-path leaks.
  * BASE='' (default): / →302 /term/Demo/; routes root-served 200; client URLs bare;
    NO double-slash `//`. Byte-identical behavior.
  * node --check clean.
- Independent code-review subagent: found 1 HIGH — setup-terminal nginx UPSTREAM
  proxy_pass had `${BASE}` while its ttyd base-path is bare `/pty/_setup` (project block
  was correctly bare) → setup terminal 404 under BASE. FIXED (dropped BASE from setup
  upstream to match project pattern). Re-checked: node --check ok, upstreams symmetric.
- Deferred (needs target host/browser): real nginx -t of generated conf under BASE;
  ttyd container base-path wiring is part of #1 PW_DEPLOY_MODE.

### iter 10 — #3 optional AD/proxy login + sibling-app (Pulse) SSO — DONE
- Goal: canonical serves BOTH AD and non-AD envs. Fold GOA's two auth extras as
  OPT-IN (default OFF → non-AD byte-identical, no spoofable-header trust).
- Change (app/server.js): 3 env consts +
  * PW_AUTH_HEADER (default '') — trusted reverse-proxy/AD pre-auth. attachUser,
    after the session-cookie lookup, reads that header, normalizeUsername, and
    authenticates IFF the user exists in users.json (allowlist preserved).
  * PW_DEV_USER (default '') — dev-only bypass (warns loudly).
  * PW_SSO_USER_HEADER (default '') — /api/auth/check emits the username in that
    response header for sibling-app SSO (Pulse); only for REAL (non-implicit) users.
  Session cookie keeps precedence; unknown header user → falls through to
  enforce(null)/soft implicit-admin. Boot [auth] log shows proxyHeader/ssoHeader
  when enabled. Sister-app nginx wiring (auth_request_set + proxy_set_header) is
  env-specific → deferred to target env.
- Verified (isolated boot, enforce=true, seeded users.json {users:[…]}):
  * opt-in ON: admin header+admin=1 →200; dev+admin=1 →403; ghost(not allowlisted)
    →401; dev @/pty/Demo/ →200, @/pty/Other/ →403; X-PW-User: adminuser emitted.
  * DEFAULTS (opt-in OFF): spoofed X-Remote-User IGNORED →401; NO X-PW-User leak.
  * soft mode: implicit-admin unchanged →200, no X-PW-User for implicit admin.
  * node --check clean.
- Independent code-review subagent: no defects; default-off invariant holds; cookie
  precedence, allowlist, no-crash fall-through, no SSO leak for implicit admin, and
  req.user shape parity all confirmed.

### iter 11 — #4a Deploy Centre behind PW_DEPLOY_CENTRE (default off) — DONE
- Ported the GOA Deploy Centre (Windows WinRM/SMB deploy) into canonical, OPT-IN
  via PW_DEPLOY_CENTRE ('true'/'1'); default OFF = byte-identical, boots with NO
  secret-key file (lazy getEncryptionKey). Env-parameterized: PW_SECRET_KEY_PATH,
  PW_DEPLOY_CONFIG, PW_DEPLOY_LOG (generic /etc/project-workbench defaults).
- Routes (all inside if(DEPLOY_CENTRE), BASE-prefixed): /deploy, /api/deploy/config
  (admin), /api/deploy/status, POST /api/deploy/:p/:target (auth+projectAccess),
  /api/deploy/:p/log, /api/deploy/:p/:target/version, /api/deploy/:p/card.
- UI: rail deployEntry + deploy modal + deployCss render only when
  DEPLOY_CENTRE && hasDeployConfigFor(project). Client URLs all ${BASE}.
- Verified (isolated boot): OFF → /deploy+/api/deploy 404, no button, boots w/o key;
  ON → all 200, button present for configured project; ON+BASE=/wb → /wb/deploy 200,
  root /deploy 404, rail href /wb/deploy. node --check clean.
- Independent review: no defects; hardened vs prod (adds requireProjectAccess on the
  deploy trigger the GOA ref lacks); option passed as bash positional $1 + allowlist
  validated (no injection); deploy password env-only, never logged/returned; lazy key
  confirmed. Notes: settings page keeps an inert deployPwCellHtml()=>'' when off
  (DOM-identical); getDeployEnv version-probe shares any stored cred (same as ref).
- Remaining for #4: Pulse /pulse/ nginx route optional (sibling-service infra) — next.

### iter 12 — Upstream visual upgrade (072aa78→a305ee3) ported — DONE
Brought canonical in line with JD2005L's last-24h visual upgrade:
- Server-side WORKING DETECTOR: computeWorking + paneWorkTracker + WORK_GRACE_S
  (cadence model), parseTmuxWindows +attached/+activity, listTmuxWindows extends
  -F to 6 fields + maps working. projectSignals replaces projectHasUnreadBell.
- DONE-STATE LATCH in /api/projects/status (writes pending marker when
  bell&&!attached&&!recentlyViewed>12s) + returns `working`. recentlyViewed map
  in clearPending suppresses re-latch while viewing.
- PINNED rail keys + AUTO-PIN-on-done (client localStorage pwPinned/pwAutoPin),
  LIVE pulse dots (rail .pk-live + tab .live), TOP-BAR project chip (.projChip),
  --rail-w 58→64, animation both→backwards. All CSS/rail/tab/chip deltas applied.
- PRESERVED canonical divergences: BASE prefixing, Deploy Centre (deployEntry/
  deployBits/deployConfigured), optional auth, _outbox. Verbatim detector/latch.
- Ancillary from same commit set: install.sh pending/ → $PW_USER ownership (Stop
  hook writes markers); .gitignore tools/*.pw + tools/verify/*.png; force-motion
  README Razor note; tools/verify/ suite (8 files) brought for repo parity.
- Verified: node --check (server + all mjs); /api/projects/status returns working;
  detector flips on under sustained advancing activity (workdbg: sustained/on=true
  at chSpan≥5,ch≥3,stampAge≤6 — matches model); rendered term page has projChip +
  pk-pin + pk-live + autoPinBtn; deploy gating intact; default BASE='' unchanged.
- Independent review: no defects; canonical divergences intact; detector/latch
  byte-identical to upstream; client pin logic correct. (tools/verify is browser-
  based host-model dev tooling — parses clean, would need base config to run on a
  based deploy → target-env concern, not runtime.)
