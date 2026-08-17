import test from "node:test";
import assert from "node:assert/strict";

import {
  makeObservation,
  mergeObservationDocuments,
  normalizeDatascapeBundle,
} from "../scripts/lib/continuity-observations.mjs";

test("same source fact receives a stable id across adapter runs", () => {
  const base = {
    kind: "state",
    timePrecision: "unknown",
    epistemic: "reported",
    source: { kind: "project_manifest", ref: "content.json#project:x:status" },
    scope: { project: "x" },
    summary: "X is live.",
  };
  const a = makeObservation({ ...base, observedAt: "2026-08-17T00:00:00Z" });
  const b = makeObservation({ ...base, observedAt: "2026-08-18T00:00:00Z" });
  assert.equal(a.id, b.id);
});

test("a changed source state receives a new id", () => {
  const common = {
    kind: "state",
    observedAt: "2026-08-18T00:00:00Z",
    timePrecision: "unknown",
    epistemic: "reported",
    source: { kind: "project_manifest", ref: "content.json#project:x:status" },
    scope: { project: "x" },
  };
  const live = makeObservation({ ...common, summary: "X is live." });
  const archived = makeObservation({ ...common, summary: "X is archived." });
  assert.notEqual(live.id, archived.id);
});

test("merge is idempotent and retains first-observed timestamp", () => {
  const source = {
    kind: "state",
    timePrecision: "unknown",
    epistemic: "reported",
    source: { kind: "project_manifest", ref: "content.json#project:x:status" },
    scope: { project: "x" },
    summary: "X is live.",
  };
  const first = makeObservation({ ...source, observedAt: "2026-08-17T00:00:00Z" });
  const later = makeObservation({ ...source, observedAt: "2026-08-18T00:00:00Z" });
  const merged = mergeObservationDocuments(
    { version: 1, generatedAt: first.observedAt, observations: [first] },
    { version: 1, generatedAt: later.observedAt, observations: [later] },
    later.observedAt,
  );
  assert.equal(merged.observations.length, 1);
  assert.equal(merged.observations[0].observedAt, first.observedAt);
});

test("standard Datascape adapter preserves epistemic distinctions", () => {
  const doc = normalizeDatascapeBundle(
    {
      content: {
        projects: [{ id: "vibo", title: "ViBo", status: "live", category: "product" }],
      },
      thoughts: {
        thoughts: [{ t: "Distribution question", q: "Should TikTok lead?", m: "2026-08", n: 12, pj: 0 }],
      },
      evidence: {
        vibo: { firstCommit: "2026-07-01", lastCommit: "2026-08-17", commits: 42, url: "https://example.test" },
      },
      gitHistory: {},
      provenance: { vibo: { count: 4, msgs: 80, firstMonth: "2026-07", lastMonth: "2026-08" } },
    },
    { generatedAt: "2026-08-18T00:00:00Z", thoughtLimit: 10 },
  );

  const state = doc.observations.find((x) => x.kind === "state");
  const git = doc.observations.find((x) => x.source.kind === "git");
  const cognition = doc.observations.find((x) => x.kind === "cognition");
  assert.equal(state.epistemic, "reported");
  assert.equal(git.epistemic, "observed");
  assert.equal(cognition.timePrecision, "month");
  assert.equal(cognition.scope.project, "vibo");
});
