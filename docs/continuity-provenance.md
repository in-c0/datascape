# Continuity provenance

A Continuity concept is a compressed semantic projection. Compression must never sever the route back to source material.

The provenance chain is:

```text
visible Continuity concept
        ↓
sourceObservationIds / sourceGraphNodeIds
        ↓
temporal semantic graph
        ↓
normalized observations
        ↓
source.kind + source.ref
        ↓
authoritative source system
```

## Generated concepts are source-addressable

New LLM-generated concepts must contain:

```json
{
  "sourceObservationIds": ["obs_…"],
  "sourceGraphNodeIds": ["sem_…", "ent_…"]
}
```

`sourceObservationIds` must contain at least one exact observation supplied to that generation request.

`sourceGraphNodeIds` may be empty when the concept does not need graph structure or no graph was supplied.

The generator rejects:

- invented observation IDs;
- invented graph-node IDs;
- concepts with no source observation;
- an inferred/projected observation as the sole evidence basis;
- a `committed` concept that has no direct commitment/decision/state/evidence source.

This validation happens **after** structured model output and before the snapshot is appended to history. A model returning syntactically valid JSON is not sufficient.

## Evidence is source-addressable too

New generated evidence uses the structured form:

```json
{
  "summary": "Production signup passed the recorded validation.",
  "sourceObservationIds": ["obs_…"],
  "sourceGraphNodeIds": ["sem_…"]
}
```

Each evidence item must include at least one `observed` or `reported` observation. `inferred` and `projected` observations may supplement an evidence item, but cannot establish it alone.

Legacy, manual, imported, and synthetic snapshots may continue to use plain evidence strings. This preserves compatibility with existing DataScape datasets while making new machine-generated history stricter.

## Inspect stays human-scale

The default Continuity viewport never shows raw IDs.

Inspect currently exposes the useful compression of provenance:

```text
4 source observations · 3 graph records
```

alongside the evidence summaries. Raw source identifiers belong in a deeper forensic/Observatory surface, not the attention-bounded default interface.

## Sidecar validation

When `continuity-observations.json` and `continuity-graph.json` exist beside `continuity.json`, the Continuity validator checks that persisted concept/evidence references resolve to those sidecars.

This catches a class of failures that ordinary schema validation cannot:

```text
valid-looking semantic snapshot
        but
references a source record that never existed
```

## Epistemic invariant

> A semantic summary may become shorter and more useful as it moves upward through Continuity, but it may not become more certain merely because it was summarized.

The graph and viewport therefore preserve the distinction between:

```text
observed
reported
inferred
projected
```

and source-addressability makes that distinction auditable rather than rhetorical.
