# Continuity

Continuity is an optional Datascape surface for navigating ongoing machine-scale work through a human-scale semantic viewport.

It is not a second data silo and it is not a dashboard. The same Datascape runtime data boundary remains in place; Continuity is another projection over data loaded from `config.dataBase`.

## Core interaction contract

Continuity keeps four operations separate:

- **Recenter** — change which concept is selected.
- **Re-abstract** — keep the selected concept, but change the semantic resolution of its neighborhood.
- **Time-travel** — inspect the same conceptual space at another historical snapshot.
- **Inspect** — reveal evidence without changing the current conceptual position.

The default attention budget is one center concept plus at most four neighboring concepts.

> Zoom changes resolution, not information quantity.

## Enable the surface

Add a `continuity.json` file beside the other runtime Datascape JSON files and open:

```text
?view=continuity
```

The normal landscape remains the default view.

`continuity.json` is optional. Existing Datascape datasets continue to load without it.

The formal shape is documented in [`continuity.schema.json`](continuity.schema.json).

## Generate a snapshot locally

If you have already run the normal Datascape import pipeline and have `content.json`, `thoughts.json`, and the optional evidence/provenance files, Continuity can synthesize the next current semantic snapshot:

```bash
npm run continuity -- public/data
```

The command:

1. reads the **preprocessed Datascape output**, not the raw ChatGPT export;
2. asks the local owner's configured Anthropic account to produce the smallest useful current decision-state projection;
3. validates concept ancestry before writing;
4. appends the new snapshot to `public/data/continuity.json` instead of rewriting previous snapshots.

That append-only behavior is intentional: later time travel should reconstruct what the semantic ontology looked like at that point, not overwrite it with today's interpretation.

Useful development commands:

```bash
# verify that the input bundle can be assembled without making an API call
npm run continuity -- public/sample-data --dry-run

# start a fresh semantic history instead of appending
npm run continuity -- public/data --replace

# validate an existing Continuity file
npm run validate:continuity -- public/data/continuity.json
```

The generator currently follows the repository's existing local Anthropic integration pattern. The **browser never receives an API key**. However, running the generator does send the preprocessed context bundle to the configured Anthropic API. If that is not acceptable for a particular corpus, skip this generator and produce the same `continuity.json` contract with a local/private model instead.

`DATASCAPE_CONTINUITY_MODEL` can override the configured model and `CONTINUITY_THOUGHT_LIMIT` controls how many recent preprocessed thoughts are supplied to a generation run.

## Minimal example

```json
{
  "attentionBudget": {
    "maxNeighbors": 4,
    "targetReadSeconds": 15
  },
  "snapshots": [
    {
      "id": "now",
      "label": "Now",
      "largeContext": "Distribution is the primary uncertainty.",
      "dominant": "Distribution",
      "concepts": {
        "Distribution": {
          "status": "live",
          "summary": "A repeatable acquisition path is still unproven.",
          "resolutions": [
            ["Social", "Community", "Partnerships"],
            ["Short-form promising", "Community niche", "Partnerships slow"],
            ["Short-form experiment", "Community post", "Partnership hypothesis"]
          ],
          "evidence": [
            "Short-form currently has the strongest initial signal."
          ]
        }
      }
    }
  ]
}
```

## Literal concepts vs dynamic abstractions

A resolution label may refer to another literal concept in the same snapshot:

```text
Distribution
└─ Short-form experiment
```

If `Short-form experiment` is also a key in `snapshot.concepts`, it can be clicked and recentered.

A resolution label may also be a generated abstraction that exists only for the current semantic partition:

```text
Distribution
└─ Short-form promising
```

Such labels are displayed as **dynamic abstractions** and are not treated as persisted graph nodes.

This distinction lets the abstraction engine generate human-friendly local partitions without forcing every visible label to become part of the permanent ontology.

## Historical ontology

Continuity deliberately does not assume that today's concepts always existed.

If a user selects a concept and scrubs backward to a snapshot where it was not represented, the surface preserves the selected concept and renders its historical absence instead of silently substituting another concept.

This is required to answer:

> What did we actually believe and how did we structure the problem at that time?

rather than rewriting history using today's ontology.

## Status vocabulary

Supported persisted statuses are:

```text
live
committed
merged
superseded
deferred
reverted
blocked
needs_human
```

`live` means uncommitted cognition or an unresolved semantic branch. It should never be visually conflated with committed history.

## Data ownership and privacy

The public repository should contain only:

- generic engine/UI code;
- schemas and import contracts;
- synthetic sample data.

A personal/private deployment can keep its real corpus, connectors, private configuration, and generated `continuity.json` outside this repository while pointing Datascape at that data through `VITE_DATA_BASE`.

If a private repository is used, the preferred dependency direction is:

```text
private deployment
└─ depends on public Datascape
```

not a public Datascape clone that requires a private submodule.

## Current vs target architecture

The current public implementation consumes immutable precomputed semantic snapshots. The local generator gives those snapshots a first automated production path while keeping the UI/data contract stable.

The target architecture is:

```text
raw events / chats / projects / git / tools
                  ↓
      temporal semantic decision DAG
                  ↓
         abstraction engine
                  ↓
         attention budget
                  ↓
            Continuity
```

In that architecture, snapshot `resolutions` are cached semantic projections produced from the underlying graph rather than the primary source of truth.

The UI contract should remain stable while that substrate evolves.
