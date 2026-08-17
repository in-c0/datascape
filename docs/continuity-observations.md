# Continuity observations

Continuity must not become a second project-management database.

The source systems remain authoritative. Datascape adapters translate heterogeneous source facts into a small interoperable observation contract; semantic models are built above that contract.

```text
source-of-truth systems
  git · chats · project manifests · sessions · exceptions · human decisions · metrics
                              ↓
                         adapters
                              ↓
                continuity-observations.json
                              ↓
             temporal semantic model / DAG
                              ↓
                    abstraction engine
                              ↓
                        Continuity
```

## Why observation, not event

Not every useful input is an event. A source may report:

- an activity that occurred at a known time;
- a current state whose start time is unknown;
- a human commitment;
- an unresolved hypothesis;
- an exception or blocker;
- a measured metric;
- a derived inference.

Calling all of those `Decision` would erase epistemic distinctions. Calling all of them `Event` would manufacture temporal precision that the source may not possess.

`Observation` is the ingestion unit. Decisions, beliefs, causal edges, semantic concepts, and viewport nodes are downstream interpretations.

The portable schema is [`continuity-observation.schema.json`](continuity-observation.schema.json).

## Required distinctions

Every observation carries:

- **kind** — what sort of thing was reported (`state`, `activity`, `commitment`, `decision`, `hypothesis`, `evidence`, `blocker`, `metric`, `objective`, `exception`, `relationship`, `cognition`);
- **observedAt** — when Datascape saw the source fact;
- **occurredAt** — when the underlying thing happened, if known;
- **timePrecision** — `instant`, `day`, `month`, or `unknown`; never pretend a month-level chat timestamp is an exact instant;
- **epistemic** — `observed`, `reported`, `inferred`, or `projected`;
- **source.kind + source.ref** — a stable route back to the source system;
- **scope** — optional project/workstream/session association;
- **summary** — a terse, source-grounded statement.

### Epistemic contract

```text
observed   directly measured from source material
reported   asserted by an authoritative source record, but not independently measured
inferred   derived deterministically or analytically from source observations
projected  generated semantic interpretation; never evidence for itself
```

Continuity must not silently promote `inferred` or `projected` observations into observed facts.

## Identity and append behavior

Observation IDs are deterministic over the source reference + semantic fact, and deliberately exclude `observedAt`.

Consequences:

1. re-running an adapter over an unchanged source fact is idempotent;
2. a changed state produces a different ID;
3. merging retains the first time an unchanged fact was observed;
4. source histories can grow without duplicating every polling pass.

The normalized observation file is a **derived cache**, not the owner of source state. Deleting it and rebuilding from all available adapters must not mutate the source systems.

## Standard Datascape adapter

The public repository includes:

```bash
npm run continuity:observations -- public/data
```

It currently normalizes the generic Datascape files that already exist:

- `content.json` → reported project state;
- `evidence.json` → observed git/publishing facts;
- `git-history.json` → observed repository-history facts;
- `provenance.json` → measured corpus provenance;
- `thoughts.json` → month-precision cognition observations.

Dry-run:

```bash
npm run continuity:observations -- public/sample-data --dry-run
```

Validation:

```bash
npm run validate:continuity:observations -- public/data/continuity-observations.json
```

The public adapter is intentionally conservative. It does not infer a decision merely because a repository changed or a conversation occurred.

## Private `ava-kim` comparison

The private `in-c0/ava-kim` repository confirms this boundary rather than replacing it with a hidden canonical database.

Its architecture already has heterogeneous authoritative sources and view-specific projections:

- the local Ops Cockpit reads `_hub/portfolio.md`, `_hub/SESSIONS.md`, `_hub/LEDGER.md`, `_hub/ops/LIFE.md`, and `_ship_inbox/exceptions/*` directly;
- repository evidence and git history are mined deterministically;
- conversation corpus/provenance is derived separately;
- navigator/command layers emit declarative view specs rather than mutating source state;
- narrow append-style decision/event logs already exist for some workflows.

That means the shared Datascape substrate should be **an adapter boundary over those stores**, not a replacement project-management database.

The remaining private work is therefore concrete rather than architectural:

```text
_hub/portfolio.md             → state / objective observations
_hub/SESSIONS.md              → session / activity observations
_ship_inbox/exceptions/*      → exception / blocker observations
explicit decision logs        → decision / commitment observations
local tool/project state      → observed activity/evidence
```

Those source files remain private. The public Datascape repository only defines the adapter output contract.

## Relationship to Continuity snapshots

Current `continuity.json` snapshots are cached semantic projections. They are not evidence.

`build-continuity.mjs` now consumes normalized observations directly. If `continuity-observations.json` exists, that file is used; otherwise the standard Datascape adapter produces the same contract in memory.

```text
ordinary Datascape data ─┐
private source adapters ─┼→ normalized observations → abstraction → continuity.json
other integrations ──────┘
```

Snapshot provenance records how many normalized observations were supplied to an LLM projection. The abstraction prompt is explicitly required to preserve `observed` / `reported` / `inferred` / `projected` distinctions.

Later, the temporal semantic DAG can become the durable interpreted layer between observations and viewport projections. The observation contract should survive that change.

## Non-goals

The observation layer does not:

- assign global truth to LLM output;
- replace Git, project files, chat exports, exception queues, or session registries;
- require PostgreSQL or a graph database;
- require every source to expose the same fields;
- expose private source references in the sparse default Continuity viewport.

It exists to make heterogeneous machine/human work semantically interoperable without destroying provenance.
