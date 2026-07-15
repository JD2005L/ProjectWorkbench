# Goal-loop: cockpit-redesign

**Feature:** Terminal-first cockpit layout — right-edge collapsible project rail with piano-key
done-lighting, `/` lands straight in the last project's cockpit, Manage Projects becomes a tabbed
modal, sharp dark animated design (force-motion standard applied).

**Branch:** `feat/cockpit-redesign` (off `feat/terminal-tab-attention`).
**Confirmed by user 2026-07-15:** root = straight-into-cockpit (bold option); plan approved.

## Key constraints / facts
- Deployed `/opt/project-workbench/app/server.js` had UNCOMMITTED live-patched PVIKPBot handoff
  feature (token env const, tmuxWindowDetails/ensureProjectTmuxSession/ensurePvikpbotClaude/
  waitForPanePrompt/injectPvikpbotPrompt, `POST /api/internal/pvikpbot/handoff`, 30d session TTL,
  orange pwTabFlash) — increment 0 syncs it into the repo. NEVER clobber it.
- Deploy: `sudo cp app/server.js /opt/project-workbench/app/server.js && sudo systemctl restart
  project-workbench` (passwordless sudo verified). Dashboard-only restart; terminals survive.
- PW_AUTH_ENFORCE=true → browser verification uses throwaway `_smoke_admin` via `sudo pw-user add`,
  deleted at the end. Playwright chromium-1148 in ~/.cache/ms-playwright (pair with playwright-core@1.49).
- Piano signal already server-side: `GET /api/projects/status` → {name,pending,bell} (tmux
  window_bell_flag from Claude Stop hook; clears on window select).
- Force-motion snippet: `git show chore/force-motion-standard:standards/force-motion/force-motion.html`
  — must be FIRST in <head> on redesigned pages (RDP shows animations).

## UX assumptions (documented)
- Amber/gold = "done, unviewed" (keys + tabs); cyan/blue = active/current.
- Rail defaults collapsed (keys-only) on first visit; state persisted in localStorage.
- Project switch = real navigation (view-transition cross-fade in Chromium), not SPA iframe swap.
- `/` → redirect to cockpit of last project (cookie `pw_last`, validated) for terminal roles;
  onboarding landing when 0 projects; simple landing for content_editor/viewer.
- Reorder moves into the Manage modal's project list (rail order = projects.json order).
- Manage modal admin-only; old `/manage` URL redirects and auto-opens it.
- Settings, login, /files pages: out of scope (unchanged).

## Acceptance criteria
| # | Criterion | Status | Attempts |
|---|-----------|--------|----------|
| C1 | Cockpit `/term/<p>/` has right-edge rail listing user's projects; click switches project | PENDING | 0 |
| C2 | Rail expands/collapses; state persists across reloads; collapsed = monogram piano keys | PENDING | 0 |
| C3 | Finished turn in another project lights that key (amber, ≤5s); clears after viewing | PENDING | 0 |
| C4 | Session tabs still flash on turn-end (restyled); click clears | PENDING | 0 |
| C5 | Manage modal: list + tabs (General/Preview/Tabs/Danger) + Add; all CRUD works; inline errors | PENDING | 0 |
| C6 | `/manage` redirects + auto-opens modal | PENDING | 0 |
| C7 | `/` lands in cockpit of last project (cookie), fallback first; onboarding when 0 projects; non-terminal roles get landing | PENDING | 0 |
| C8 | WOW: rail/key/modal animations render under forced reduce-motion (force-motion first in head) | PENDING | 0 |
| C9 | Poll pauses when hidden; rail state + lighting survive reload | PENDING | 0 |
| C10 | PVIKPBot handoff preserved: route present in repo+deployed, token/TTL intact | PENDING | 0 |
| C11 | Project w/o tmux session: unlit but clickable; no rail errors | PENDING | 0 |
| C12 | Non-admin: only granted projects in rail; no Manage entry | PENDING | 0 |
| C13 | Mobile ≤640px: rail = overlay drawer; top bar usable; modal responsive | PENDING | 0 |
| C14 | node --check passes; /healthz ok; no console errors on cockpit+landing | PENDING | 0 |
| C15 | A11y: rail toggle/keys keyboard-reachable + ARIA; modal role=dialog + Esc | PENDING | 0 |
| C16 | Non-regression: drawer paste/drop/insert, preview modal, tab CRUD, reorder, settings, login/logout | PENDING | 0 |

## Increment plan
0. Sync deployed drift into repo on new branch. → C10
1. Verification harness: _smoke_admin, playwright-core, shots.mjs, baseline screenshots. → C14 tooling
2. Design tokens + force-motion + cockpit skeleton (rail markup, no behavior yet). → C8 partial
3. Rail behavior: status poll, piano keys, lighting/strike, expand/collapse persist, switching. → C1,C2,C3,C9,C11,C12
4. Top bar + tab strip restyle (amber attention unified). → C4
5. Manage modal + JSON responses on /manage/* + GET /api/projects/config + reorder-in-modal. → C5,C6
6. Root routing: cockpit-first `/`, pw_last cookie, onboarding + non-terminal landing. → C7
7. Mobile/a11y/edge pass. → C13,C15,C11
8. Independent verification sweep (subagent per non-trivial criterion), fixes, final commit. → all

## Iteration log
(entries appended below)

### 2026-07-15 — iter 1 (increments 0+1)
- Branch feat/cockpit-redesign created; deployed drift (PVIKPBot handoff) adopted as baseline, committed 1ba67d2. node --check OK; repo==deployed byte-identical → C10 groundwork done.
- Harness live: _smoke_admin (admin/*), playwright-core@1.49.1 pairs with chromium-1148, shots.mjs logs in via real /login through nginx, screenshots + console-error capture. Baselines: 0 console errors on /, /term/ProjectWorkbench/, /manage, /settings.
- NOTE: this Claude session runs INSIDE pw_ProjectWorkbench — never restart project-terminal@* services.
- Next: cockpit page rewrite (tokens+force-motion+rail+topbar).

### 2026-07-15 — iter 2 (increments 2+3+4: cockpit page)
- Change: consts (forceMotionScript, cockpitCss tokens, projHue/projMonogram, railHtml, railScript) + /term route rewritten via anchored splice (python, all anchors verified unique). Existing tray/tab scripts preserved byte-exact; pw_last cookie now set on every cockpit visit.
- Verify: node --check OK; deployed; /healthz ok; Playwright: 0 console errors. Screenshots: collapsed rail w/ colored monogram keys + current-key cyan (iter2), expanded rail w/ names+foot actions (iter2-open), REAL lit-key test — wrote /var/lib/project-workbench/pending/AmrikPublic (what the Stop hook writes) → AP key lit amber w/ glow ≤5s (iter2-lit). Marker removed after test.
- C1/C2(visual)/C3(marker path)/C8 partial PASS pending independent verify; C4 needs live bell test; persistence (C9) needs reload test.
- Tab strip restyled in same pass (pwTabPulse amber). Rail foot: Manage → /manage (temporary until modal).
- Next: Manage modal + JSON endpoints (inc 5).
