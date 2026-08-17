# Continuity layers

Continuity now has two complementary meanings in DataScape. They are parts of one system, not competing products.

## 1. Human semantic plane

The sparse Continuity surface (`?view=continuity`) compresses machine-scale context into a human attention budget.

It answers:

- What matters now?
- What changed?
- What is unresolved?
- Why do we believe this?

Its four orthogonal interactions are **recenter, re-abstract, time-travel, and inspect**. This plane should usually expose only a handful of concepts even when the underlying corpus/graph contains thousands or millions of records.

See [`continuity.md`](continuity.md).

## 2. Operating / control plane

The operating layer observes project and worker state, recommends allocation, escalates human-only decisions, and may eventually allocate/operate autonomous work under explicit policy.

The current native-ChatGPT bootstrap deliberately starts conservatively: existing contextualised workers, `ctn` as the continuation primitive, artifacts as the deterministic coordination bus, and bounded Scheduled Task allocation.

See [`CONTINUITY-V0.md`](CONTINUITY-V0.md) and [`SCHEDULED-TASK-POLICY.md`](SCHEDULED-TASK-POLICY.md).

## Shared substrate

Both planes must consume the same source-grounded state rather than maintaining independent stories about the portfolio:

```text
source systems
Git · chats · manifests · sessions · exceptions · decisions · metrics
                              ↓
                         adapters
                              ↓
                 normalized observations
                              ↓
                   temporal semantic graph
                       ↙             ↘
              human semantic       operating / control
                 viewport                plane
                       ↘             ↙
                         Observatory
                    provenance / audit
```

The source systems remain authoritative. Normalized observations preserve provenance and epistemic class. The semantic graph may organize and infer structure, but must not silently manufacture causality or commitments.

## Boundary rule

**The control plane may change work; the semantic plane changes understanding.**

A navigation action such as recentering or re-abstracting must never mutate project state. Conversely, an operating action must be represented back into the shared observation/graph substrate so that the human viewport can recover what happened without replaying raw machine activity.

## DataScape relationship

DataScape is the broader engine/platform. Continuity is the operational mode that keeps humans cognitively synchronized with ongoing autonomous work. Landscape remains the broad spatial/intellectual projection; Observatory remains the deeper forensic/governance projection.
