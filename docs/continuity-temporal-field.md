# Continuity temporal environment field

The temporal environment field makes **when** work happened perceptible without turning Continuity into a timeline dashboard.

It is an optional projection underneath the semantic graph. The graph still carries meaning; the field carries local time, environmental context, and autonomy intervals.

## Orthogonal dimensions

Continuity must not collapse these into one visual state:

```text
x / environment     = when it happened
semantic node       = what happened
executionState      = running | completed | planned
supervision         = attended | unattended
scheduled           = whether an unattended/attended run was scheduled
status               = live | committed | blocked | ... semantic state
```

Night is **not** a proxy for autonomy. A human may work at 02:00, and an unattended worker may continue at 09:00.

## Optional runtime contract

`continuity.json` may contain:

```json
{
  "temporalField": {
    "timezone": "Australia/Sydney",
    "locationLabel": "Sydney",
    "windowStart": "2026-08-17T23:00:00+10:00",
    "windowEnd": "2026-08-18T20:00:00+10:00",
    "now": "2026-08-18T09:08:00+10:00",
    "sunrise": "2026-08-18T06:28:00+10:00",
    "sunset": "2026-08-18T17:27:00+10:00",
    "weather": {
      "summary": "light cloud",
      "cloudCover": 34,
      "precipitation": 0
    },
    "autonomyWindows": [
      {
        "id": "overnight-1",
        "label": "Overnight unattended run",
        "start": "2026-08-17T23:10:00+10:00",
        "end": "2026-08-18T07:05:00+10:00",
        "mode": "unattended",
        "scheduled": true
      }
    ]
  }
}
```

Concepts may additionally carry:

```json
{
  "occurredAt": "2026-08-18T02:11:00+10:00",
  "endedAt": "2026-08-18T02:24:00+10:00",
  "executionState": "completed",
  "supervision": "unattended",
  "scheduled": true
}
```

## Rendering rules

1. The environment is abstract, not photographic. It may use sunrise/sunset and weather to modulate a low-frequency field, but must never compete with the graph.
2. Weather color is never semantic. A blocker cannot become red because the sky is warm; semantic status keeps its own visual grammar.
3. Literal concepts with timestamps may project onto temporal x positions on sufficiently wide screens.
4. Narrow screens preserve the semantic reflow layout rather than compressing decisions into unreadable time bands.
5. Planned future concepts are ghosted/dashed. They must not look historically completed.
6. Autonomy windows span the real execution interval and sit behind the graph. They are not cards and do not replace node-level supervision metadata.
7. The human attention budget remains unchanged: normally one center + at most four semantic neighbors.

## Real location and weather boundary

The public DataScape engine should **not** own a user's precise location or weather credentials.

Preferred dependency direction:

```text
phone/browser/local device
        ↓ permissioned location
private/local temporal provider
        ↓ weather + sunrise/sunset lookup
sanitized temporalField
        ↓
public DataScape renderer
```

The private provider may use browser/device geolocation, a manually chosen location, or a future local-device bridge. It should emit only what the renderer needs.

Recommended privacy defaults:

- keep precise latitude/longitude private/local;
- keep provider credentials private/local;
- expose only a coarse `locationLabel` when a public/shared view needs one;
- persist the derived environmental snapshot with an unattended run if historical reconstruction matters;
- do not silently reacquire device location after permission has been revoked;
- make location/environment absence a valid state: Continuity still works with its ordinary dark semantic canvas.

## Historical reconstruction

If the temporal field is used as episodic context, snapshot the derived environment alongside the run. Do not assume a third-party weather service will retain enough history to reconstruct an old run later.

The historical record should preserve the environment *as known then*, just as Continuity preserves the semantic ontology *as known then*.

## Morning Continuity

A future entry mode may frame the interval from the last unattended run start to NOW and recursively compress all activity inside it into the ordinary attention budget.

Example:

```text
23:10 unattended begins
       ├─ path A → rejected
       ├─ path B → merged
       └─ path C → survives
07:05 unattended ends
09:08 NOW → 3 material changes · 1 needs human
```

The operator should see the semantic consequences first, not eight hours of worker/session logs.
