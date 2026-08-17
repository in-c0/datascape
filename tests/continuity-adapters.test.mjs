import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runObservationAdapters } from "../scripts/lib/continuity-adapters.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "continuity-adapter.mjs");

test("external adapter emits normalized source-addressable observations", async () => {
  const out = await runObservationAdapters([FIXTURE], {
    observedAt: "2026-08-18T00:00:00Z",
  });
  assert.equal(out.runs[0].name, "synthetic-private-ops");
  assert.equal(out.document.observations.length, 2);
  assert.ok(out.document.observations.every((observation) => /^obs_[a-f0-9]{16}$/.test(observation.id)));
  assert.ok(out.document.observations.every((observation) => observation.source.adapter === "synthetic-private-ops"));
});

test("external adapter merge is idempotent", async () => {
  const first = await runObservationAdapters([FIXTURE], {
    observedAt: "2026-08-18T00:00:00Z",
  });
  const second = await runObservationAdapters([FIXTURE], {
    observedAt: "2026-08-19T00:00:00Z",
    existing: first.document,
  });
  assert.equal(second.document.observations.length, first.document.observations.length);
  assert.deepEqual(
    second.document.observations.map((observation) => observation.observedAt),
    first.document.observations.map((observation) => observation.observedAt),
  );
});
