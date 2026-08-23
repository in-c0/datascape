# Continuity v0 — Operating Contract

Status: **stable baseline**  
Owner: Datascape / Continuity  
Baseline continuation primitive: `ctn`

## Purpose

Continuity is an operating layer for keeping parallel human + machine work moving without requiring the owner to repeatedly reconstruct state.

The public contract is intentionally small:

- current intent and priority come from an explicit owner-authorized source;
- workers continue existing contextualized work rather than inventing new goals;
- repositories, deployments, tests and other artifacts are the deterministic coordination surface;
- Continuity observes real state before retrying or reallocating work;
- ordinary uncertainty should not interrupt the owner;
- genuinely owner-only decisions are surfaced clearly and minimally.

## Stable `ctn` definition

> from now on, "ctn" implies: "ok, proceed to taking next required action; let me know at any point if you think i should stop and say, do or ask something, otherwise, i would assume that we are on our way to deliver according to the discussion"

`ctn` is state-relative. A worker should inspect what actually exists, then take the next required action. Do not replace it with a longer continuation prompt unless a deliberate experiment demonstrates a material improvement.

## Public / private boundary

This repository is public. It is a **code and protocol repository**, not the source of truth for the owner's private portfolio state.

Do not persist here:

- confidential or embargoed R&D;
- invention candidates, patent strategy, prior-art deltas or unpublished mechanisms;
- private branch names or private commit hashes;
- personal financial, health, family or other private constraints;
- private project maps merely because the scheduler knows about them;
- detailed runtime state for a private workstream.

A private workstream keeps its state in its private source-of-truth repository or private operational store. Public Continuity state may record only that a confidential lane is intentionally omitted when that fact is operationally necessary.

The existence of a confidentiality rule is not permission to summarize the confidential material.

## Operating modes

### Foreground mode

When the owner is actively present, optimize for short feedback loops rather than waiting for scheduled ticks.

- fix demonstrated blockers immediately;
- use real-browser / real-runtime evidence when the problem is user-facing;
- keep priority tickets moving as soon as their preceding gate clears;
- prefer a small verified fix over a new architecture proposal;
- do not duplicate another active lane editing the same files.

### Unattended mode

Scheduled execution is a fallback for useful progress while the owner is away.

- select a bounded runnable workstream;
- produce durable machine-side progress when possible;
- if human-blocked, record the minimum blocker and reallocate;
- do not interpret a timer firing as progress;
- do not silently expand goals, permissions or irreversible authority.

## Owner-facing product rule

The owner surface exists to answer a few questions quickly:

1. What needs me now?
2. What is running or making progress without me?
3. What is blocked, and on exactly what?
4. What changed since I last looked?
5. What is the smallest action I can take to unblock the highest-value work?

Backend concepts should not become owner-facing vocabulary merely because they exist in the implementation. Security and provenance can remain rigorous while the UI stays simple.

## Source-of-truth hierarchy

When determining whether work completed, prefer:

1. actual artifact / repository / deployed / test / external-system state;
2. explicit worker handoff or durable operational state;
3. chat-history recollection.

Chat context is useful but is not the deterministic coordination protocol.

For confidential work, the same hierarchy applies **inside the private source of truth**. Do not mirror it into this public repository.

## Retry semantics

If a worker reports an ambiguous failure such as:

> Message delivery timed out. Please try again.

Treat it as an unknown congestion/error signal, not proof of a particular rate limit.

Required behavior:

1. inspect external state before repeating anything;
2. do not immediately replay a mutation whose outcome is uncertain;
3. if it already completed, continue from the resulting state;
4. if it did not complete, retry only when safe;
5. attribute an explicit service failure only to the service that emitted it.

For irreversible or non-idempotent operations, verification before repetition is mandatory.

## Congestion policy

Useful categories include:

- ChatGPT generation / delivery;
- GitHub read or write;
- deployment provider;
- web/research;
- other connector;
- unknown.

Responses:

- clean success → maintain demand;
- isolated ambiguous timeout → hold demand and inspect state;
- repeated failure in one lane → pause or reallocate that lane;
- correlated failures across lanes → reduce optional fan-out;
- explicit quota/rate limit → obey the emitting service's guidance;
- human-required blocker → surface the minimum action and continue other safe work.

The objective is useful throughput, not maximum simultaneous activity.

## Minimum telemetry

Record only enough to distinguish whether scheduled execution is useful:

```text
time
lane / workstream
result: progress | timeout | blocked | error
service-at-failure: github | deploy | web | other | unknown
artifact/progress: yes | no
human action required: yes | no
```

Do not publish private workstream names or details into a public telemetry record.

## Self-building rule

Continuity may build candidate improvements to itself, but a candidate must not silently rewrite the stable operating policy while that policy is evaluating it.

Expected progression:

`Observe -> Recommend -> Allocate -> Operate -> Self-improve`

A more complex scheduler, prompt, authority model or UI should be promoted only when evidence shows it is materially better than the simpler baseline.

## Success criterion

Continuity is succeeding when:

- the owner can recover the important state in seconds;
- runnable work continues without unnecessary interruption;
- genuine blockers reach the owner with an obvious next action;
- completed work is grounded in verifiable artifacts;
- retries do not duplicate uncertain mutations;
- public/private boundaries are preserved;
- the system removes cognitive load instead of creating another system the owner must operate.

If the owner needs to understand the Continuity architecture in order to use Continuity, the product has failed its interface contract.
