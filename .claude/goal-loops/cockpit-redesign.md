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
| C1 | Cockpit `/term/<p>/` has right-edge rail listing user's projects; click switches project | **PASS** | 1 |
| C2 | Rail expands/collapses; state persists across reloads; collapsed = monogram piano keys | **PASS** | 1 |
| C3 | Finished turn in another project lights that key (amber, ≤5s); clears after viewing | **PASS** | 1 |
| C4 | Session tabs still flash on turn-end (restyled); click clears | **PASS** | 1 |
| C5 | Manage modal: list + tabs (General/Preview/Tabs/Danger) + Add; all CRUD works; inline errors | **PASS** | 1 |
| C6 | `/manage` redirects + auto-opens modal | **PASS** | 1 |
| C7 | `/` lands in cockpit of last project (cookie), fallback first; onboarding when 0 projects; non-terminal roles get landing | **PASS** | 1 |
| C8 | WOW: rail/key/modal animations render under forced reduce-motion (force-motion first in head) | **PASS** | 1 |
| C9 | Poll pauses when hidden; rail state + lighting survive reload | **PASS** | 1 |
| C10 | PVIKPBot handoff preserved: route present in repo+deployed, token/TTL intact | **PASS** | 1 |
| C11 | Project w/o tmux session: unlit but clickable; no rail errors | **PASS** | 1 |
| C12 | Non-admin: only granted projects in rail; no Manage entry | **PASS** | 1 |
| C13 | Mobile ≤640px: rail = overlay drawer; top bar usable; modal responsive | **PASS** | 1 |
| C14 | node --check passes; /healthz ok; no console errors on cockpit+landing | **PASS** | 1 |
| C15 | A11y: rail toggle/keys keyboard-reachable + ARIA; modal role=dialog + Esc | **PASS** | 1 |
| C16 | Non-regression: drawer paste/drop/insert, preview modal, tab CRUD, reorder, settings, login/logout | **PASS** | 1 |

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

### 2026-07-15 — iter 3 (increment 5: Manage modal)
- Change: manageModalHtml/Script consts + /manage → cockpit?manage=1 redirect + JSON-aware add/update/delete + GET /api/projects/config; glyph fixes (fullwidth ＋ → +, brand ⌁ → >_ mono).
- Verify: node --check OK, deployed, healthz OK. Playwright CRUD end-to-end with throwaway _SmokeTest: modal auto-open via /manage ✓, create local project ✓, duplicate name → inline .err ✓, update preview cmd + tab template ✓ (config API round-trip exact), delete arming (disabled until typed name) ✓, delete ✓, registry clean ✓, workspace + unit removed ✓ (checked below). Only console entry = expected 400 from dup test.
- C5 + C6 implemented; independent verify pending in sweep.
- Next: inc 6 cockpit-first routing + landing variants.

### 2026-07-15 — iter 4 (inc 6+7: routing, mobile, a11y)
- / cockpit-first verified (admin → /term/ProjectWorkbench/, dev → granted project, editor → landing grid iter4-editor); pw_last cookie honored (iter4-cookie); mobile drawer + scrim + responsive modal (iter4-mobile, iter4-mmodal); glyph fixes (⏻→↪).

### 2026-07-15 — iter 5 (hardened sweep)
- pw-verify.mjs: 28/28 PASS incl. real-bell chain (bell in _belltest window of pw_AmrikPublic → PW key lit + ● title → visit → tab attention → click clears → key unlit; PVIKPBot window untouched, active window restored), C11 sessionless-project runtime test, console-error capture, inbox-delete assertion.

### 2026-07-15 — iter 6 (independent verification + fixes)
- Judge agent: 13 CONFIRMED / 2 PLAUSIBLE / 0 REFUTED; gaps closed (C11 runtime test, C14 console capture, crud output persisted, sweep no-abort).
- Reviewer agent: no critical/XSS/auth findings; preserved tray/tab script byte-identical, all 57 getElementById targets + load-bearing selectors intact. 3 MAJOR + 5 minor findings ALL FIXED:
  1) modal busy-guard re-entrancy (create/delete/rename transitions no-op'd) — busy cleared before select()/closeModal(), status set after;
  2) zero-grant developers saw dead admin onboarding — landing branches now isAdmin → onboarding, 0 projects → no-grants, else grid;
  3) firstRunNeeded stranded admins off their cockpits — removed from redirect gate (first-run nudges live on landing+/settings only);
  4) navTarget stale on rename round-trip — curNow tracking;
  5) reorder success on non-OK HTTP — response checked;
  6) pwPulse keyframes restored to tokens; 7) .fileInfo hidden ≤640px; 8) inline JSON script embeds hardened vs </script> breakout (projectJson×2, tabPresetsJson, cliTabsJson).
- Re-ran crud.mjs (9/9, fixed transitions verified) + pw-verify.mjs (28/28) post-fix.
- _inbox/ images accidentally committed in ed32150: now gitignored + git rm --cached (history NOT rewritten — non-destructive constraint; files remain on disk).
- Smoke users (_smoke_admin/_smoke_dev/_smoke_editor) deleted at loop end.

## RESULT: all 16 criteria PASS, independently verified. Loop complete 2026-07-15.

### 2026-07-15 — iter 7 (user adjustments: left rail + peek + bar cleanup)
- User asked: (1) rail on the LEFT; (2) collapsed-hover shows names as part of the design, not a bubble; (3) drop Workbench brand + project chip from the top bar, brand → top of side menu, project identified by selected key. Reminder: finished-session highlighting must persist.
- Change: #railPanel absolute layer inside #rail with container-query-driven labels; hover/focus peek widens the panel OVER the terminal (140ms intent delay, no iframe reflow); railHead = brand glyph + WORKBENCH + chevron as the pin toggle (#railToggle); pk-fly bubble removed; keys flipped (rounded-right, +X hover/strike, edge on wall side); mobile drawer from left; leftInfo/brand/projChip removed from top bar and CSS.
- Verify: node --check, deploy, healthz OK. Screenshots: L1 collapsed-left, L2 hover-peek with HarmaniPublic LIT amber "finished — click to view" (real pending marker), L3 pinned (lit key persists), L4 mobile-left drawer (lit key persists). Full pw-verify re-run on new layout: 28/28 PASS (bell chain, persistence, roles, a11y, C10 handoff intact). Marker cleaned; smoke users deleted after.

### 2026-07-16 — post-loop fix: inconsistent rail lighting
- Reported: turn-end lighting on the rail inconsistent. Root cause (two dead legs): (1) pending-marker path never functional — pw-stop-hook.sh never installed AND /var/lib/project-workbench/pending root-owned 755 (admin hook cannot write; installer bakes it in); (2) bell predicate excluded the ACTIVE window, i.e. every single-window project.
- tmux semantics verified empirically: bell on active window of DETACHED session sets window_bell_flag; ATTACH clears it (and stays cleared); bell while attached+active never flags; select-window same-index does NOT clear.
- Fix: projectHasUnreadBell counts bell && (!active || session_attached==0) — self-healing, zero hook changes needed for running sessions; pending dir chown admin:admin (live + install.sh + heal/dirs); Stop hook now also writes the marker (new/restarted sessions).
- Verified: ui3 single-window bell → key lit + ● title → opening ui3 auto-clears (attach) → unlit; marker write as plain admin works and clears on visit; full sweep 29/29 incl. new C3b-active-detached regression check.
