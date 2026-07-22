# Workbench verification suites

Browser-level acceptance and regression tests for the cockpit UI. All signal
tests (bells, working-cadence, done-latch, pins) run inside a dedicated
throwaway project `_PWTest` that each suite creates and deletes — they never
touch real projects. Role probes hit real projects read-only (403s decided
before ttyd, so nothing attaches).

Setup (once per box):
1. `npm i` here (pairs playwright-core 1.49.1 with the chromium build under
   `~/.cache/ms-playwright/chromium-1148`).
2. Create throwaway users and password files (delete users when done):
   sudo pw-user add _smoke_admin  --role admin          --projects '*'        --password "$(openssl rand -hex 16 | tee ../smoke.pw)"
   sudo pw-user add _smoke_dev    --role developer      --projects '_PWTest'  --password "$(openssl rand -hex 16 | tee ../dev.pw)"
   sudo pw-user add _smoke_editor --role content_editor --projects 'AmrikPublic,HarmaniPublic' --password "$(openssl rand -hex 16 | tee ../editor.pw)"
   (pass files live at tools/*.pw — gitignored)

Suites:
- version-footer.mjs — release format/source + shared footer/cockpit wiring.
- pw-verify.mjs  — full 31-check acceptance sweep (rail, bells, latch, roles,
                   a11y, force-motion, mobile hooks). Run before every ship.
- pintest.mjs    — pinning: manual/auto/toggle/persistence + amber-over-pin.
- worktest2.mjs  — working detector: idle-view false-positive + steady output.
- worktest3.mjs  — working detector: pause continuity, refresh continuity,
                   bell-less stop decay (≤25s by design; bells end instantly).
- authloss.mjs   — session revoked mid-view → auto-redirect to /login?next=…
                   within one tab-poll (~2s); re-login returns to the cockpit.
- crud.mjs       — Manage modal end-to-end with a throwaway project.
- shots.mjs      — ad-hoc screenshot/console-error harness (PW_VIEW, PW_CLICK,
                   PW_HOVER, PW_ACTIONS env knobs).
