# Scheduled Task Policy — Continuity

Status: **stable operating rule**
Owner: Datascape / Continuity
Originator: LifeOS Studio

## Core rule

**Reuse or extend an existing Scheduled Task before creating a new one.**

ChatGPT Plus task slots are a scarce shared resource. Continuity must treat scheduling as cadence-bucket allocation rather than one-task-per-concern.

Before proposing or creating any Scheduled Task:

1. Inspect the currently active tasks.
2. Identify the required cadence and operating purpose.
3. Prefer an existing compatible cadence bucket (for example: hourly, multi-daily, daily, weekly).
4. Extend that task's prompt to include the new review/watch responsibility when doing so does not make the task incoherent or unsafe.
5. Create a new task only when no existing active cadence can responsibly carry the work.
6. If the active-task ceiling is reached, consolidate before considering deletion or replacement.

## Naming rule

Every active Scheduled Task title should expose its cadence, e.g.:

- `[Hourly] ...`
- `[3× Daily 07:30/13:30/19:30] ...`
- `[Daily ~08:00] ...`
- `[Weekly Sun ~19:00] ...`

This makes the task set readable as a compute/scheduling allocation map rather than a list of unrelated reminders.

## Current consolidation precedent

The Continuity overnight / morning resource review is folded into the existing daily Northstar brief instead of consuming a new task slot. The daily brief should review available Continuity worker/task/artifact evidence, congestion/timeout signals, human blockers, and whether worker demand should hold, decrease, or increase.

## CTN baseline interaction

Scheduled worker continuations should preserve the stable `ctn` baseline unless an explicit controlled prompt-engineering experiment is being run. A timed-out delivery should not trigger an immediate retry; the next normal scheduled continuation should use state-relative `ctn` and first inspect whether the prior action actually completed.

## Governance

LifeOS Studio originates projects and strategic intent. Datascape / Continuity operates resource allocation, including Scheduled Task reuse, cadence selection, worker allocation, congestion control, and escalation for human attention.
