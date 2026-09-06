# Motion review 3 — The Ruling Brief (ChatGPT temporary chat, High, "worked for 1m 26s")

2026-09-06 ~16:40 Sydney (+10:00). Verification-only round: the four native 1:1 crops (left column pre-press / 0 / 16.7 / 20 ms; right column same instants; hold left; hold right) uploaded at full scale (1568×592 screenshots of the unscaled PNGs; JPEG transport). No build value changed since round 2.

## VERDICT: PASS

1. **Thread thickness:** the native crop resolves a single-pixel high-energy teal centerline; neighbouring pixels are antialias/JPEG spill, not a second full-width stroke; no 2 px plateau. Change: none; keep the thread at 1 px.
2. **Right-edge contraction:** the moving row shows about a 1 raster-pixel inward shift by 20 ms while the right-side anchor remains visually fixed — what a 2 px final contraction should rasterise to this early. For `220ms cubic-bezier(.16,1,.3,1)`, eased progress is ≈40.0% at 16.7 ms and ≈46.1% at 20 ms, giving ≈0.80 px and ≈0.92 px of a 2 px contraction; the observed 0→1 px quantisation is consistent. Change: none; keep `transform-origin: right center` and `scaleX(.997)`.
3. **Docket/thread start:** confirmed to rendered-frame granularity. At 0 ms the thread is absent and the body is at its start geometry; by the first rAF the thread has non-zero length and the body has begun collapsing toward the docket, with further movement at 20 ms. Sub-frame simultaneity cannot be claimed from stills; both transitions begin in the same 0→16.7 ms frame interval. Change: none.
4. **Numerals:** confirmed. The pre-press crop shows the original numbering; the 0 ms crop already shows the successor rows renumbered 1–5 — the discrete numeral change is at motion start, not after the first animation frame. Change: none.
5. **Curve behaviour:** consistent with both named curves. `.16,1,.3,1` is strongly front-loaded (≈40.0% / 46.1% at 16.7 / 20 ms) and the substantial early thread plus roughly one-pixel contraction match that; `.4,0,.2,1` is only ≈3.86% / 5.9% progressed at those instants, matching the very small early collapse displacement before the fully collapsed hold. No reversal, overshoot, or cadence contradiction. Change: none; retain both curves.
6. **What stills cannot prove:** the literal CSS coefficient `scaleX(.997)`, the exact four control-point numbers, or exact sub-frame equality of the docket/thread start — nearby coefficients rasterise to the same pixels and JPEG adds pixel-scale uncertainty at antialiased edges. Source/instrumentation facts, not remaining visual failures. Concrete changes: none; preserve 1 px thread, `scaleX(.997)`, `transform-origin: right center`, `220ms cubic-bezier(.16,1,.3,1)`, `140ms cubic-bezier(.4,0,.2,1)`.

## Outcome across the three rounds

- Ruling queued (thread → tray, contraction, collapse + docket, renumber): **PASS** (round 3), after one real fix (the 0 ms docket bump, round 2 evidence) and two evidence-transport fixes on this side.
- Fold open/close: **PASS** (round 1, item 4: front-loaded ease-out visible, no overshoot).
- Reduced motion: **PASS** (round 2, item 6).
- Open for the owner: thread timing authority (round 1, item 1) — the build follows the canonical curve; see LOG.md open questions.
