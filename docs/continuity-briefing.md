# Continuity briefing — the catch-up surface

```text
?view=briefing
```

The briefing answers one question: **what happened while I was away, and what
needs me?**

It is the third Continuity surface, and the only one whose content is authored
rather than interpreted:

| Surface | Question | Content |
|---|---|---|
| Landscape | what is the shape of all of this? | spatial projection |
| Continuity (`?view=continuity`) | what matters now, and why do we believe it? | semantic projection |
| Briefing (`?view=briefing`) | what happened, and what needs me? | **verbatim authored text** |

## Why it is not a projection

Everything else in Continuity may be re-abstracted: `continuity.json` snapshots
are explicitly an `llm_projection` over source material, and the graph builder is
deliberately conservative about what it will infer.

The briefing is different. Its content is a sentence a worker wrote *for the
operator* — a must-read line, or an owner-gated ask. Paraphrasing it would
destroy the only property it has. So the briefing:

- carries authored text **verbatim**, and never sends it through a model;
- is built deterministically, with no API call;
- marks anything reconstructed rather than emitted.

> `continuity.json` is what the system *believes*. `continuity-briefing.json` is
> what the system *said*.

## The two node families

Both collapse to one line and expand in place. The collapsed line is the TL;DR;
everything else is behind the expansion. That is the attention budget: a surface
that renders 262 must-reads is the transcript it was built to replace.

### Lane must-reads

Per lane, the latest **N** records (default 2 — "the latest two messages"),
newest first. Per lane rather than globally: a global "latest 2" shows two
records from the chattiest lane and nothing from the other three.

Each record's items are already two-level, because the house must-read format
writes them that way:

```markdown
### Must-read

1. **PR #7 merged** — master is `ff44db8`, e2e 35/35, verified on the merged
   tree rather than the branch.
```

The bold lead is the node label; the remainder is the expansion. No summariser
is involved — the author wrote both levels.

A lane also carries its two ChatGPT conversations: the `autoRunUrl` the loop
drives and the frozen `seedUrl` it was branched from. See
[`CONTINUITY-WORKER-LANES.md`](CONTINUITY-WORKER-LANES.md).

### Owner actions

Every open owner-gated blocker, expanding into **atomic steps** optimised for
the operator's execution speed — fewest clicks, least physical action, least
comprehension time. Each step is one of:

```text
run       one command she can execute as-is
open      a hyperlink she clicks
decide    a ruling, stating the exact words that unblock it
physical  the irreducible ones — a device, a card, a person
```

Steps are ordered, carry a coarse `seconds` estimate, and the queue sorts by
severity then by cheapest-first, so a twenty-second click is not stranded behind
a five-minute errand.

**This half is a rendering, not a queue.** It is read live from the exception
inbox. Nothing can appear here that is not already in the one list the owner
reads daily, and resolving an exception removes it from here by construction.
Adding a second owner surface is the specific mistake that killed a previous
lane.

### Derived steps are labelled as derived

An owner action whose expansion was extracted from prose is marked
`needsBreakdown: true`, and the surface says so:

> Steps derived from prose — the filing lane has not broken this down. Treat as
> a hint, not a checklist.

An essay dressed as a checklist costs more comprehension time than an essay
admitting it is one. The authored form is a `## Owner steps` section in the
exception itself.

## Navigation contract

Expansion is navigation, so it lives in the URL:

```text
?view=briefing&open=<nodeId>,<nodeId>&n=<per-lane>&lane=<laneKey>
```

- **Reload** restores exactly which nodes were open.
- **Back** closes what Enter opened.
- `n` re-slices client-side, so "show me one more" never needs a rebuild.
- Nodes are keyboard-operable: focus and press **Enter** or **Space**.

`hiddenCount` is recomputed against the slice actually shown. The builder's
count was computed for the builder's slice, and displaying it after the viewport
re-slices would be wrong by exactly the difference.

## Producing the document

The public repository owns the **contract and the renderer**. Private sources
stay outside it, exactly as with [adapters](continuity-adapters.md):

```text
private must-read store + exception inbox
                  ↓  (private composer)
        continuity-briefing.json
                  ↓
   public/data/  →  ?view=briefing
```

Validate any document against the contract:

```bash
npm run validate:continuity:briefing -- public/data/continuity-briefing.json
```

The formal shape is [`continuity-briefing.schema.json`](continuity-briefing.schema.json).
A synthetic example ships at `public/sample-data/continuity-briefing.json`; the
file is optional, and a deployment without one renders the other views normally.

## Provenance

A record reconstructed from an ops log rather than captured from a message
carries:

```json
{ "provenance": "backfilled-from-log", "sourceRef": "ops/…/log.md#tick-9" }
```

and renders with a `reconstructed` marker. The validator rejects a reconstructed
record with no `sourceRef`, so "where did this come from" is always answerable
from the document alone.
