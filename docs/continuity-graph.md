# Continuity temporal semantic graph

The Continuity graph is the interpreted layer between normalized observations and human-facing semantic snapshots.

It is **not** the source of truth. Every graph record must remain traceable to one or more normalized observations, which in turn point back to authoritative source systems.

```text
source systems
    ↓
normalized observations
    ↓
temporal semantic graph
    ↓
dynamic abstraction
    ↓
Continuity viewport
```

The portable schema is [`continuity-graph.schema.json`](continuity-graph.schema.json).

## v1 graph builder

Build:

```bash
npm run continuity:graph -- public/data
```

Validate:

```bash
npm run validate:continuity:graph -- public/data/continuity-graph.json
```

The deterministic v1 builder deliberately does only four things:

1. creates typed semantic records from normalized observations;
2. creates project/workstream/session entity nodes from observation scope;
3. connects records to their scope using `about` and hierarchy using `part_of`;
4. creates `supersedes` only when two observations describe successive values from the **same source field + semantic kind + scope**.

It does **not** infer `causes`, `supports`, `contradicts`, or `depends_on` from temporal adjacency or semantic similarity.

## Node kinds

```text
entity
state
activity
commitment
decision
hypothesis
evidence
constraint
metric
objective
cognition
```

An observation maps conservatively to a graph kind. For example:

```text
observation blocker / exception → graph constraint
observation decision            → graph decision
observation activity            → graph activity
```

An activity observation never becomes a decision merely because it occurred near one.

## Edge kinds

```text
about
part_of
supersedes
supports
contradicts
depends_on
causes
related_to
```

In the deterministic v1 builder, only `about`, `part_of`, and `supersedes` are emitted.

Future enrichers may add the other edge types, but must attach:

- an epistemic class;
- confidence where useful;
- source observation IDs supporting the interpretation.

A model-generated causal edge should normally be `inferred` or `projected`, never `observed` merely because an LLM produced it.

## Time semantics

Graph records carry `validFrom` and optional `validTo`.

For source observations with a known `occurredAt`, `validFrom` uses that time. Otherwise it falls back to `observedAt`.

When a source state is superseded:

```text
new state ──supersedes──▶ old state
```

and the older record receives `validTo = new.validFrom`.

This is a temporal lineage assertion, not a causal assertion.

## Dynamic ontology

The graph is not the same thing as the visible Continuity nodes.

Persisted graph records represent source-grounded or explicitly interpreted semantic state. Human-facing viewport nodes may be dynamic clusters generated at a requested abstraction level and may never become persistent graph nodes.

```text
persistent graph region
        ↓ abstraction
"Distribution uncertainty"
        ↓ finer abstraction
"TikTok" · "Reddit" · "Partnerships"
```

The visible cluster labels can change as the operator's question, time, and resolution change without rewriting historical graph records.

## Historical correctness

Time travel must reconstruct what was knowable at the requested time. Later observations and later ontology must not silently rewrite earlier state.

The graph therefore preserves:

- source observation times and precision;
- superseded records rather than deleting them;
- epistemic class;
- provenance;
- concept absence when an abstraction did not yet exist.

## Relationship to `continuity.json`

`continuity.json` remains the cached human-facing projection format. `build-continuity.mjs` can now consume both:

```text
continuity-observations.json   raw normalized evidence boundary
continuity-graph.json          conservative interpreted structure
```

The graph helps the abstraction engine understand scope and temporal lineage; the observations remain available to verify evidence statements.

Snapshot provenance records the number of graph nodes and edges supplied to generation.

## Safety invariant

> **No edge may become more epistemically certain merely because it was placed in a graph.**

A graph is a representation of claims and relationships, not proof that those relationships are true.
