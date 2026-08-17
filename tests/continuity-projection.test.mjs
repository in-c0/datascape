import test from "node:test";
import assert from "node:assert/strict";

import { makeObservation } from "../scripts/lib/continuity-observations.mjs";
import { buildContinuityGraph } from "../scripts/lib/continuity-graph.mjs";
import { validateProjectionReferences } from "../scripts/lib/continuity-projection.mjs";

function observation({ kind = "state", epistemic = "reported", summary = "ViBo is live." } = {}) {
  return makeObservation({
    kind,
    observedAt: "2026-08-18T00:00:00Z",
    timePrecision: "unknown",
    epistemic,
    source: { kind: "project_manifest", ref: `test#${kind}:${epistemic}:${summary}` },
    scope: { project: "vibo" },
    summary,
  });
}

function projection(obs, graphNodeId, overrides = {}) {
  return {
    concepts: [
      {
        label: "Distribution",
        status: "live",
        sourceObservationIds: [obs.id],
        sourceGraphNodeIds: graphNodeId ? [graphNodeId] : [],
        evidence: [
          {
            summary: obs.summary,
            sourceObservationIds: [obs.id],
            sourceGraphNodeIds: graphNodeId ? [graphNodeId] : [],
          },
        ],
        ...overrides,
      },
    ],
  };
}

test("projection references supplied observations and graph nodes", () => {
  const obs = observation();
  const graph = buildContinuityGraph({ version: 1, generatedAt: obs.observedAt, observations: [obs] });
  const record = graph.nodes.find((node) => node.sourceObservationIds.includes(obs.id));
  assert.deepEqual(validateProjectionReferences(projection(obs, record.id), [obs], graph), []);
});

test("unknown observation and graph ids are rejected", () => {
  const obs = observation();
  const graph = buildContinuityGraph({ version: 1, generatedAt: obs.observedAt, observations: [obs] });
  const result = projection(obs, null, {
    sourceObservationIds: ["obs_0000000000000000"],
    sourceGraphNodeIds: ["sem_0000000000000000"],
  });
  const errors = validateProjectionReferences(result, [obs], graph);
  assert.ok(errors.some((error) => error.includes("unknown observation")));
  assert.ok(errors.some((error) => error.includes("unknown graph node")));
});

test("projected observations cannot be the sole evidence basis", () => {
  const projected = observation({ epistemic: "projected", summary: "An LLM thinks distribution dominates." });
  const graph = buildContinuityGraph({ version: 1, generatedAt: projected.observedAt, observations: [projected] });
  const record = graph.nodes.find((node) => node.sourceObservationIds.includes(projected.id));
  const errors = validateProjectionReferences(projection(projected, record.id), [projected], graph);
  assert.ok(errors.some((error) => error.includes("cannot be the sole evidence basis")));
});

test("committed concepts require direct commitment-compatible support", () => {
  const cognition = observation({ kind: "cognition", summary: "Should TikTok lead?" });
  const graph = buildContinuityGraph({ version: 1, generatedAt: cognition.observedAt, observations: [cognition] });
  const record = graph.nodes.find((node) => node.sourceObservationIds.includes(cognition.id));
  const errors = validateProjectionReferences(
    projection(cognition, record.id, { status: "committed" }),
    [cognition],
    graph,
  );
  assert.ok(errors.some((error) => error.includes("committed status requires")));
});
