# PW Decisions

Permanent cross-project decisions and standing instructions for ProjectWorkbench on PVI2.

## 2026-07-15 — STANDING: Force animations regardless of OS "reduce motion" (all web projects)

Every PW **web** project displays its animations regardless of the OS "reduce motion" preference —
that toggle is spuriously ON for RDP sessions, most VMs, and Windows "Adjust for best performance",
so visitors who never opted out otherwise see a static-looking site. Include the canonical drop-in
(one inline `<script>`, first in `<head>`) from the ProjectWorkbench repo `standards/force-motion/`:
it patches `matchMedia` for JS motion libs and strips `@media (prefers-reduced-motion: reduce)`
blocks from same-origin CSS. Never self-gate animations; never "restore" motion with a CSS `revert`
(it reverts to 0s). Apply it in every new project's first-pass build by default.

