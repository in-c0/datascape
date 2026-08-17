# Continuity Portfolio Executor B

Status: ACTIVE
Cadence: hourly at :45 Australia/Sydney
Allocation: UNASSIGNED
Allocation since: —
Last execution: —
Last durable artifact: —
Human blocker: NONE
Congestion state: CLEAN / UNKNOWN BASELINE

## Allocation rule

On the next run, select the highest-value runnable machine-side workstream consistent with current Northstar evidence, then replace `UNASSIGNED` with that project/workstream and keep the allocation sticky.

Do not select:
- DataScape / Continuity (Executor A owns it);
- Tuned (already has an autonomous loop);
- new Vibo feature work while Vibo remains in distribution/evidence mode, unless a severe production defect requires it.

Reallocate only when the current workstream is complete, genuinely blocked, materially deprioritized, or another workstream has clearly higher expected value.

If human-blocked, record the minimum human action and reallocate to another runnable workstream rather than idling.

## Per-run record

Keep this file compact. Update only material fields above plus, when useful, append one line here:

- YYYY-MM-DD HH:MM — RESULT — durable artifact / blocker / reallocation reason
