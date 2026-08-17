# Continuity v0 — Overnight Operating Contract

Status: **stable baseline / do not self-modify during an overnight run**  
Owner: Datascape / Continuity  
Originator: LifeOS Studio  
Baseline continuation primitive: `ctn`

## Purpose

Bootstrap Datascape/Continuity as the operating layer for parallel LifeOS Studio work before full cross-session orchestration exists.

The current system is deliberately simple:

- LifeOS Studio originates projects and strategic intent.
- NorthStar provides direction and priorities.
- Datascape / Continuity operates the portfolio.
- Existing ChatGPT sessions remain independent execution environments.
- `ctn` is the stable continuation primitive inside an already-contextualised worker session.
- GitHub, deployed systems, tests and other artifacts are the deterministic coordination surface.
- Continuity observes first, then recommends, then allocates, then operates. It must not skip directly to self-modifying autonomous control.

## Stable `ctn` definition

> from now on, "ctn" implies: "ok, proceed to taking next required action; let me know at any point if you think i should stop and say, do or ask something, otherwise, i would assume that we are on our way to deliver according to the discussion"

Do not replace this baseline with a longer continuation prompt during the baseline experiment. Prompt-engineered continuations may be tested later as explicit candidates against the CTN baseline.

## Global context workers should respect

Continuity should keep the following strategic context available at the supervisor layer and remind workers only when materially relevant:

1. **NorthStar** — strategic direction and prioritisation.
2. **Daily Brief** — current operational state, highest-leverage actions, blockers, and human-attention needs.
3. **November lease constraint** — the November 2026 lease/financial decision boundary is a real portfolio constraint; avoid optimising projects in isolation from it.
4. **Working portfolio map** — LifeOS Studio originates; Datascape/Continuity operates. Products, WIP/R&D, Research-in-Public workstreams, and personal/Studio MadSadCat projects remain distinct.
5. **Human attention is scarce** — workers should continue through ordinary uncertainty and interrupt only when a real human decision/action is necessary.

## Working portfolio map — current snapshot

### LifeOS Studio

**Bringing future systems to life.**  
**Automating R&D and building AI systems for the future.**

### AI systems & products

- NorthStar — Where it all starts
- Vibo — Online Vision Board
- Consilium — Roundtables to sharpen a point
- Sumzup — the future of social media ingestion
- Tuned — follow attention in agentic social media
- Datascape — visualize layers in abstraction
  - Datascape App
  - Datascape Research — Research in Public
- Huntboard (rename) — Career navigation in the age of AI
  - Huntboard App
  - Huntboard Research — Research in Public
- Herald (rename) — Your online presence manager

### WIP / R&D

- Dewliv — Fresh delivery, before dawn, at every doorstep
  - Dewliv App
  - Dewliv Web
  - Dewliv Research — Research in Public
- LikeKerr — Train like your favourite player
  - LikeKerr App
  - LikeKerr Research — Research in Public
  - LikeKerr MR — Omnidirectional VR treadmill with 3D game simulation — Research in Public
- Datascape / Continuity — machine-scale context made navigable by humans
- Hypothesister — A gamified network for automated frontier research
  - Hypothesister App
  - Hypothesister Research — Research in Public
- Gyeol — Making everyday life better
  - Gyeol Armpad
  - Gyeol e-skin
  - Gyeol Home — Local AI / Smart Home OS
  - Gyeol Research — Research in Public

### Personal brand

- ava.kim — builder of lifeos.studio
- Podcast/blog-derived series
  - Math We Take for Granted
  - Devlogs
- Studio MadSadCat
  - Cat Translator (rename)
    - Cat Translator Device
    - Cat Translator Model/Data
    - Cat Translator Research — Research in Public
  - future games
  - FPS Archery

Standing question: **Which projects genuinely deserve a “Research in Public” label? Do all projects need some Research-in-Public component, or should the label remain only for work with a real unresolved, generalisable question?**

## Night 1 principle: slow start

Do not maximise demand immediately. Learn the usable resource envelope first.

Recommended starting load:

- 2 existing worker sessions
- 1 `ctn` continuation per worker per hour
- stagger worker ticks by approximately 20–30 minutes
- no autonomous creation of extra worker branches during Night 1
- hold this load for the observation window unless there is clear congestion, in which case reduce it

After a clean observation period, increase by **one worker at a time** on later nights. If multiple congestion signals appear, reduce demand materially before probing upward again.

This is an additive-increase / multiplicative-decrease policy, not an attempt to bypass platform limits.

## Timeout / retry semantics

If a worker reports:

> Message delivery timed out. Please try again.

Treat it as a **soft congestion/error signal with unknown source**, not proof that ChatGPT, GitHub, or another service is specifically rate-limiting.

Required behaviour:

1. **Do not press Retry.**
2. **Do not immediately resend.**
3. Wait until the worker’s next normal scheduled tick.
4. Send `ctn` again.
5. The worker should infer current real state and continue from what actually exists.
6. Record whether the prior timed-out operation had nevertheless completed.

Rationale: `ctn` is state-relative. A replay may duplicate a commit, deployment, mutation, or other action that actually succeeded before the response was lost.

For irreversible or non-idempotent operations, verify external state before repetition.

## Congestion policy

Record signals by the last observable service boundary rather than assuming every failure is a ChatGPT rate limit.

Suggested categories:

- ChatGPT generation / delivery
- GitHub read
- GitHub write
- Vercel
- Cloudflare
- web/research
- other connector
- unknown

Responses:

- Clean success: maintain demand.
- Successful but materially slower runs: hold demand; do not increase yet.
- One isolated delivery timeout: hold demand; next tick is `ctn`.
- Repeated timeout in the same worker: pause that lane for a cycle.
- Multiple workers fail in the same observation window: reduce active load significantly.
- Explicit plan/quota limit: stop probing until the platform indicates availability/reset.
- Explicit downstream rate-limit signal such as HTTP 429: obey that service’s retry/reset guidance; do not automatically throttle unrelated work.
- Human-required blocker: allocate no further work to that project until the blocker is resolved; capacity may be reassigned elsewhere.

## Minimum telemetry

Per continuation:

```text
time
worker/session
project
ctn sequence number
result: success | timeout | explicit-limit | blocked | error
service-at-failure: chatgpt | github | vercel | cloudflare | web | other | unknown
artifact/progress: yes | no
latency/slowdown observation: normal | slow | very-slow | unknown
```

Per overnight window:

```text
workers active
runs attempted
runs successful
timeouts
explicit limits
useful-progress runs
duplicate/rework events
human blockers
service-specific failures
allocation change recommended for next night
```

Do not create verbose telemetry unless it is needed to distinguish competing hypotheses.

## Source-of-truth hierarchy

When determining whether work completed, prefer:

1. actual artifacts / repository / deployed state / tests / external system state
2. explicit worker handoff/state
3. chat-history recollection

Chat memory is useful context but should not be the deterministic coordination protocol.

## Self-building rule

Continuity Stable may operate work that builds Continuity Candidate.

Continuity Candidate must **not modify the active overnight supervisor policy while that policy is evaluating it**.

Expected progression:

`Observe -> Recommend -> Allocate -> Operate -> Self-improve`

Candidate scheduling or prompt policies should be evaluated against the stable CTN baseline before promotion.

## Prompt-engineering experiment policy

The long-form continuation protocol is a future experimental candidate, not the current default.

Current baseline: `ctn`.

Later compare candidate prompts on:

- useful artifact completion
- progress per continuation
- premature stops
- unnecessary human interrupts
- duplicated work
- wrong pivots
- rate-limit/quota events
- rework required after review

Only promote a more complex continuation prompt if evidence shows a material improvement over CTN.

## Current native-ChatGPT limitation

Continuity cannot assume a supported API exists to open arbitrary existing ChatGPT conversations, retrieve exact live transcripts, inject messages into them, or programmatically spawn new branch chats.

For the native Plus bootstrap:

- existing worker chats retain their local context
- Scheduled Tasks associated with those workers are the continuation actuator where available
- artifacts/state are the coordination bus
- creation of new worker chats/branches remains a human boundary until a supported orchestration layer exists

Long term, Datascape may own its own worker abstraction over agent runtimes/APIs, but that is outside the CTN baseline experiment and may involve separately billed compute.

## Night 1 success criterion

Night 1 is successful if it produces enough evidence to answer:

1. Did hourly CTN reliably produce useful progress in two contextualised worker sessions?
2. Were there timeouts, explicit limits, slowdowns, duplicate actions, or downstream service congestion?
3. Did state-relative recovery work after any timeout?
4. Did either worker need human attention?
5. Is there evidence to increase from 2 workers to 3 on the next night?

The objective is not maximum throughput on Night 1. The objective is to establish a trustworthy baseline from which Continuity can safely increase utilisation.
