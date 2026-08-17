# Continuity v0 — Day 2 / Night 2

Date: 2026-08-18 (Australia/Sydney)
Status: active experiment

## Night 1 finding

The scheduler fired, but most scheduled work was observational rather than executable. This was a configuration failure relative to the objective of maximizing useful unattended machine-side progress.

Observed evidence:
- the hourly Continuity/Vibo task fired, but its contract primarily watched and classified state;
- the daily Northstar/Continuity brief and Forbes deadline watch fired;
- Tuned's existing 3× daily autonomous review fired;
- DataScape itself did make substantial progress through its already-running build lane, including the Continuity PR merge, but the new scheduler did not create enough additional execution throughput.

Conclusion: task firing is not a success metric. The primary metric is durable machine-side progress per scheduled run.

## Day 2 correction

Slow-start remains in force, but the two main scheduled lanes are now executors rather than monitors.

### Executor A — DataScape / Continuity

Cadence: hourly at :15.

Responsibilities:
- inspect current DataScape/Continuity state;
- take one bounded next machine-side action each run;
- prefer durable artifacts such as commits, PR updates, tests, adapter/control-plane implementation, provenance, execution telemetry, or validated research;
- preserve the stable CTN/scheduling policy as immutable during unattended execution;
- candidate scheduler/self-modification changes may be researched/tested but are not promoted silently.

### Executor B — portfolio

Cadence: hourly at :45.

Responsibilities:
- maintain a sticky workstream allocation in `ops/continuity/WORKER-B.md`;
- continue the same runnable workstream until completed, blocked, or materially reprioritized;
- exclude DataScape/Continuity (owned by Executor A) and avoid duplicating Tuned's existing loop;
- avoid new Vibo feature work while Vibo is in distribution/evidence mode unless a severe production defect requires it;
- produce one bounded durable machine-side result per run when safe work exists;
- if human-blocked, record the minimum blocker and reallocate rather than idling.

The prior daily Forbes deadline task slot was reused for Executor B. Its original deadline-watch responsibility remains inside Executor B, but runs only once per Sydney calendar day and persists its last-check state.

## CTN / timeout semantics

The CTN baseline remains unchanged.

If a cycle produces `Message delivery timed out. Please try again.` or another ambiguous timeout:
1. do not immediate-retry;
2. wait for the next normal scheduled cycle;
3. inspect actual machine/artifact state first;
4. continue from reality rather than replaying the prior mutation.

Explicit service-specific rate-limit signals (for example 403/429/retry-after/reset) should be attributed to the emitting service.

## Slow-start / congestion control

Current active executor demand: 2 hourly lanes, staggered by 30 minutes.

Do not increase simply because five task slots exist.

Increase only after a clean observation period with useful output and no material congestion. Hold after isolated ambiguous congestion. Back off materially after correlated congestion across independent lanes.

## Day 2 metrics

Measure:
- scheduled runs fired;
- runs that attempted execution;
- runs producing durable artifacts;
- useful progress / run;
- premature monitor-only completions;
- timeouts and explicit limits;
- service at failure where identifiable;
- duplicate/replayed mutations;
- human blockers encountered;
- reallocations;
- rework required after autonomous output.

Tomorrow's review should judge executor throughput and quality, not notification volume or scheduler activity alone.
