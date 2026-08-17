# Continuity v0 — Night 1 Slow-Start Baseline

Date: 2026-08-18 (Australia/Sydney)
Status: active observation
Originator: LifeOS Studio
Operator: Datascape / Continuity

## Purpose

Establish a conservative empirical baseline for overnight autonomous work using the user's existing ChatGPT Plus Scheduled Tasks and machine-side artifact state. Optimize for useful completed work while learning congestion/resource patterns; do not attempt to bypass platform or service limits.

## Stable rules

- Preserve the existing `ctn` baseline. Do not replace it with a longer engineered continuation prompt except in a later controlled comparison.
- `Message delivery timed out. Please try again.` is a soft congestion/error signal, not proof of which service is limiting.
- Do not immediately retry a timed-out turn. On the next normal probe, inspect actual state first and continue state-relatively.
- Attribute explicit GitHub/Vercel/Cloudflare/other service errors to the emitting service when possible.
- Slow-start: increase demand only after a clean observation period; back off materially when multiple independent lanes show congestion.
- Reuse/extend existing Scheduled Task cadence buckets before creating a new task.
- Do not rewrite the stable Continuity operating policy during the overnight run.

## Current scheduled lanes

1. `[Hourly] Continuity + Vibo Sprint Watch`
   - Role: Continuity supervisor + Vibo Forbes P0 watch.
   - Cadence: hourly.
   - This is the primary overnight observation/control bucket.

2. `[3× Daily 07:30/13:30/19:30] Tuned Autopilot Review`
   - Role: bounded Tuned reviewer/executor handoff.
   - Existing independent machine-work lane; do not create a competing Tuned task.

3. Daily/weekly buckets remain reserved for their existing strategic review roles and are not converted into high-frequency worker lanes tonight.

## Known platform boundary

The current native task/tool surface does not provide a supported operation for the Continuity supervisor to inject `ctn` into arbitrary unrelated existing ChatGPT conversations or to spawn arbitrary new worker chats. Therefore Night 1 does not claim full cross-chat orchestration.

Independent chat sessions that do not already have their own scheduled actuator remain outside deterministic central control. Their machine-side artifacts may still be observable through shared repositories/services.

## What to observe

For each observable lane/event, capture only material evidence:

- meaningful artifact progress
- completion or blocked-human state
- premature stop / idle cycle
- message-delivery timeout
- explicit model/plan limit
- GitHub / Vercel / Cloudflare / other connector-specific failure
- duplicated/repeated work
- evidence of rising latency or congestion
- irreversible/human-authority boundary

Avoid noisy hourly commits when nothing changed.

## Night 1 demand policy

Hold the current conservative demand. Do not add another task solely to increase throughput. At the next daily Northstar + Continuity brief, decide whether evidence supports holding, reducing, or increasing effective worker demand using existing cadence buckets.

## Morning decision

The daily Northstar + Continuity brief should answer:

1. What useful machine work actually completed overnight?
2. Which lanes were progressing, idle, blocked, complete, or congested?
3. Were any errors attributable to ChatGPT/model limits versus downstream services?
4. Did state-relative recovery avoid duplicate work after any timeout?
5. Is there evidence to increase demand, or should the current level be held/reduced?
6. What minimum human action, if any, unlocks the highest-value blocked lane?
