# Force-motion standard

**Standing decision (2026-07-15):** every Project Workbench **web** project displays
its animations regardless of the operating system's "reduce motion" preference.

## Why

Browsers map the CSS `prefers-reduced-motion: reduce` query (and the matching
`window.matchMedia` result) to the OS "show animations" toggle. That toggle is
**off** on a large share of machines nobody deliberately configured for
accessibility:

- any Windows box set to **"Adjust for best performance"** (disables animations wholesale),
- **most VMs**, and
- **every RDP / remote-desktop session** (the remote protocol reports reduced motion).

So visitors who never made an accessibility choice still get our animations
suppressed, and a polished site reads as static or broken. Overriding the
preference is therefore a deliberate **product** decision for our sites. (It does
override a real accessibility signal for the minority who set it on purpose —
that trade-off is accepted for our client-facing product and internal tooling.)

## What suppresses animation (two independent paths)

1. **JS motion libraries** — Framer Motion, GSAP, AOS, Swiper, Lenis, ScrollReveal,
   Motion One, react-spring, etc. call `window.matchMedia('(prefers-reduced-motion: reduce)')`
   and disable themselves.
2. **CSS** — a framework blanket reset (Bootstrap Reboot ships
   `@media (prefers-reduced-motion: reduce){ *,*::before,*::after{ animation-duration:.01ms!important; … } }`,
   animate.css similar) or a hand-written `@media (prefers-reduced-motion: reduce)` guard,
   or a Tailwind `motion-reduce:` variant.

## The drop-in

One inline `<script>` — [`force-motion.html`](./force-motion.html) — handles both:

- patches `matchMedia` so JS libs see **"no preference"**, and
- deletes `@media (prefers-reduced-motion: reduce)` blocks from **same-origin**
  stylesheets at load, so each element's own animation/transition values apply
  again (it removes the *suppressor*; it does not force a duration, so timing is
  preserved).

> Note: `revert`/`unset` in a CSS override does **not** work here — an author-origin
> `revert` rolls back to the UA value (`0s`), which kills the animation rather than
> restoring it. Removing the suppressing rule (what this script does) is the correct fix.

### Placement

- **Must be the first element inside `<head>`**, before any framework/app JS or CSS.
- The `matchMedia` patch part must run before app JS; the CSS-strip part self-defers
  to `DOMContentLoaded`/`load`, so first-in-head satisfies both.

### Per stack

| Stack | Where |
|---|---|
| ASP.NET / Razor | `Views/Shared/_Layout.cshtml` (or `Pages/Shared/_Layout.cshtml`) — first thing after `<head>` |
| Static HTML | each page's `<head>`, or the shared header partial/include, first |
| React / Vite / Next | `index.html` / `public/index.html` `<head>` (or `_document`), first |

### Authoring rules (so the override stays unnecessary)

- **Do not** wrap your own animations in `@media (prefers-reduced-motion: no-preference)` —
  define them unconditionally. (The strip removes `reduce` suppressors; it does not
  un-wrap `no-preference` opt-ins.)
- **Do not** add your own `@media (prefers-reduced-motion: reduce)` guards or Tailwind
  `motion-reduce:` disables.
- Host framework CSS **same-origin** (local `wwwroot/lib/...`, not a third-party CDN),
  or the CSS-strip can't read/modify it. The `matchMedia` patch still works either way.

## Limitations

- Cross-origin (CDN) stylesheets are unreadable by script and are skipped for the
  CSS strip. Self-host framework CSS or avoid self-gating.
- If you truly need to honor reduced motion for one critical, seizure-risk effect,
  that's a conscious per-element exception — not the default.

## Razor (.cshtml) placement note

When pasting the drop-in into a Razor layout, escape the two `@` tokens in the
JS comments (`@media` → `@@media`, `@import` → `@@import`) or the build fails
with CS0103 — Razor parses bare `@` inside `<script>` as directives. (Hit on
AmrikPublic, 2026-07-15.)
