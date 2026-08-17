import test from "node:test";
import assert from "node:assert/strict";

import { makeObservation } from "../scripts/lib/continuity-observations.mjs";
import { buildContinuityGraph } from "../scripts/lib/continuity-graph.mjs";

const doc = (observations) => ({
  version: 1,
  generatedAt: "2026-08-18T00:00:00.000Z",
  observations,
});

function state(summary, observedAt) {
  return makeObservation({
    kind: "state",
    observedAt,
    timePrecision: "unknown",
    epistemic: "reported",
    source: { kind: "project_manifest", ref: "portfolio#vibo:status" },
    scope: { project: "vibo" },
    summary,
  });
}

test("graph creates a project entity and provenance-preserving about edge", () => {
  const obs = state("ViBo is active.", "2026-08-17T00:00:00Z");
  const graph = buildContinuityGraph(doc([obs]), { generatedAt: "2026-08-18T00:00:00Z" });
  const project = graph.nodes.find((n) => n.kind === "entity" && n.entityType === "project" && n.label === "vibo");
  const record = graph.nodes.find((n) => n.sourceObservationIds?.includes(obs.id));
  assert.ok(project);
  assert.ok(record);
  assert.ok(graph.edges.some((e) => e.kind === "about" && e.from === record.id && e.to === project.id));
});

test("same-source state changes create a temporal supersedes edge", () => {
  const older = state("ViBo is building.", "2026-08-15T00:00:00Z");
  const newer = state("ViBo is active.", "2026-08-17T00:00:00Z");
  const graph = buildContinuityGraph(doc([older, newer]), { generatedAt: "2026-08-18T00:00:00Z" });
  const oldNode = graph.nodes.find((n) => n.sourceObservationIds?.includes(older.id));
  const newNode = graph.nodes.find((n) => n.sourceObservationIds?.includes(newer.id));
  assert.ok(graph.edges.some((e) => e.kind === "supersedes" && e.from === newNode.id && e.to === oldNode.id));
  assert.equal(oldNode.validTo, newer.observedAt);
});

test("activity adjacency does not manufacture causal or decision edges", () => {
  const first = makeObservation({
    kind: "activity",
    observedAt: "2026-08-18T00:00:00Z",
    occurredAt: "2026-08-17",
    timePrecision: "day",
    epistemic: "observed",
    source: { kind: "git", ref: "repo#commit:a" },
    scope: { project: "vibo" },
    summary: "A commit occurred.",
  });
  const second = makeObservation({
    kind: "activity",
    observedAt: "2026-08-18T00:00:00Z",
    occurredAt: "2026-08-18",
    timePrecision: "day",
    epistemic: "observed",
    source: { kind: "git", ref: "repo#commit:b" },
    scope: { project: "vibo" },
    summary: "Another commit occurred.",
  });
  const graph = buildContinuityGraph(doc([first, second]));
  assert.equal(graph.edges.some((e) => ["causes", "supports", "depends_on"].includes(e.kind)), false);
  assert.equal(graph.nodes.some((n) => n.kind === "decision"), false);
});

test("session/workstream hierarchy remains structural and directed", () => {
  const obs = makeObservation({
    kind: "activity",
    observedAt: "2026-08-18T00:00:00Z",
    timePrecision: "unknown",
    epistemic: "reported",
    source: { kind: "session", ref: "sessions#s1" },
    scope: { project: "datascape", workstream: "continuity", session: "agent-1" },
    summary: "Continuity implementation session is active.",
  });
  const graph = buildContinuityGraph(doc([obs]));
  const session = graph.nodes.find((n) => n.entityType === "session");
  const workstream = graph.nodes.find((n) => n.entityType === "workstream");
  const project = graph.nodes.find((n) => n.entityType === "project");
  assert.ok(graph.edges.some((e) => e.kind === "part_of" && e.from === session.id && e.to === workstream.id));
  assert.ok(graph.edges.some((e) => e.kind === "part_of" && e.from === workstream.id && e.to === project.id));
});
