# Continuity external adapters

Private/local source parsing should live outside the public DataScape repository.

DataScape exposes a tiny plugin boundary instead:

```bash
npm run continuity:adapters -- \
  --out .data/continuity-observations.json \
  /absolute/path/to/private-ops-adapter.mjs
```

An adapter module exports `collect()` directly, through `adapter.collect`, or as the default export.

Minimal shape:

```js
export const adapter = {
  name: "private-ops",
  async collect({ observedAt, makeObservation, context }) {
    return [
      makeObservation({
        kind: "state",
        observedAt,
        timePrecision: "unknown",
        epistemic: "reported",
        source: {
          kind: "project_manifest",
          ref: "private-source#project:x:state",
          adapter: "private-ops",
        },
        scope: { project: "x" },
        summary: "Project X is active.",
      }),
    ];
  },
};
```

## Contract

The adapter owns only **source-specific parsing**. DataScape owns:

- deterministic observation IDs;
- observation merge/idempotency semantics;
- observation/graph validation;
- semantic graph construction;
- abstraction and Continuity rendering.

This keeps the dependency direction clean:

```text
private deployment / local adapter
            ↓
public DataScape observation contract
            ↓
Continuity
```

The public repository never needs the private source paths, credentials, corpus, or parsing rules.

## Multiple adapters

Multiple module paths can be passed in one run. Their observations are merged by deterministic ID.

```bash
npm run continuity:adapters -- \
  --out .data/continuity-observations.json \
  ./project-state-adapter.mjs \
  ./session-adapter.mjs \
  ./exception-adapter.mjs
```

If the output file already exists, unchanged observations retain their first-seen timestamp and new facts append. Use `--replace` only when intentionally rebuilding the derived cache from scratch.

## Dry run

```bash
npm run continuity:adapters -- \
  --dry-run \
  ./private-ops-adapter.mjs
```

The repository CI exercises this interface with a synthetic external adapter fixture.

## Privacy

The output observation document is still derived project/cognition state and may be sensitive. A private deployment should keep it in a gitignored/local data directory unless it has been explicitly redacted for publication.

For the current private `ava-kim` deployment, `.data/` is already gitignored, so it is an appropriate local output boundary.
