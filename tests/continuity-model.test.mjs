import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuityViewport,
  resolutionLevel,
} from "../src/continuity/model.js";

const data = {
  attentionBudget: { maxNeighbors: 4 },
  snapshots: [
    {
      id: "past",
      label: "Past",
      largeContext: "Product readiness dominates.",
      dominant: "Product readiness",
      hiddenCount: 100,
      concepts: {
        "Product readiness": {
          status: "live",
          summary: "Still stabilizing.",
          resolutions: [["Reliability", "Persistence"]],
        },
      },
    },
    {
      id: "now",
      label: "Now",
      largeContext: "Distribution dominates.",
      dominant: "Distribution",
      hiddenCount: 1000,
      concepts: {
        Distribution: {
          status: "live",
          summary: "Acquisition path unproven.",
          resolutions: [
            ["Social", "Community", "Partnerships"],
            ["TikTok promising", "Reddit niche", "Partnerships slow", "Launch deferred"],
            ["TikTok", "Reddit", "Partnerships", "Launch platform", "Hidden fifth child"],
          ],
        },
        TikTok: {
          parent: "Distribution",
          status: "live",
          summary: "Leading acquisition hypothesis.",
          resolutions: [["Acquisition", "Retention", "Creative"]],
        },
      },
    },
  ],
};

test("attention budget caps the viewport at one center plus four neighbors", () => {
  const viewport = buildContinuityViewport(data, {
    timeIndex: 1,
    selectedId: "Distribution",
    resolution: 1,
  });

  assert.equal(viewport.selectedId, "Distribution");
  assert.equal(viewport.neighbors.length, 4);
});

test("re-abstraction preserves the selected concept while changing its partition", () => {
  const coarse = buildContinuityViewport(data, {
    timeIndex: 1,
    selectedId: "Distribution",
    resolution: 0,
  });
  const fine = buildContinuityViewport(data, {
    timeIndex: 1,
    selectedId: "Distribution",
    resolution: 1,
  });

  assert.equal(coarse.selectedId, fine.selectedId);
  assert.notDeepEqual(
    coarse.neighbors.map((node) => node.label),
    fine.neighbors.map((node) => node.label),
  );
});

test("time travel preserves a concept that did not yet exist", () => {
  const viewport = buildContinuityViewport(data, {
    timeIndex: 0,
    selectedId: "TikTok",
    resolution: 0.5,
  });

  assert.equal(viewport.selectedId, "TikTok");
  assert.equal(viewport.absent, true);
  assert.equal(viewport.concept, null);
  assert.equal(viewport.neighbors[0].label, "Product readiness");
});

test("literal child concepts remain traversable while generated labels do not", () => {
  const viewport = buildContinuityViewport(data, {
    timeIndex: 1,
    selectedId: "Distribution",
    resolution: 1,
  });

  const literal = viewport.neighbors.find((node) => node.label === "TikTok");
  const generated = viewport.neighbors.find((node) => node.label === "Launch platform");

  assert.equal(literal.clickable, true);
  assert.equal(literal.dynamic, false);
  assert.equal(generated.clickable, false);
  assert.equal(generated.dynamic, true);
});

test("resolution is normalized to a semantic level without changing node count semantics", () => {
  const concept = data.snapshots[1].concepts.Distribution;
  assert.equal(resolutionLevel(concept, 0), 0);
  assert.equal(resolutionLevel(concept, 0.5), 1);
  assert.equal(resolutionLevel(concept, 1), 2);
});
