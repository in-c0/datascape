import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_BUDGET,
  altitudeScene,
  decompose,
  hiddenWeight,
  isAuthoredSource,
  isProjection,
  labelOrigin,
  lensPath,
  parentsOf,
  projectionIsWellFormed,
  recompose,
  roots,
} from "../src/continuity/altitude.js";

// A deliberately DAG-shaped fixture: "vibo-traction" matters to both
// Distribution and Forbes evidence, which is the shape the spec says must not
// be flattened by duplicating the source under each parent.
const projection = (id, label, childIds, extra = {}) => ({
  id, type: "projection", label, childIds,
  revision: 1,
  sourceObservationIds: childIds.map((c) => `obs_${c}`),
  generatedAt: "2026-08-21T18:00:00+10:00",
  materiality: "material", confidence: 0.8, status: "committed",
  execution: "completed", supervision: "unattended",
  ...extra,
});
const source = (id, text) => ({ id, type: "source", text, label: text });

const graph = {
  nodes: [
    projection("a0", "PersonalOS reliability converging", ["dist", "forbes"]),
    projection("dist", "Distribution strategy changed", ["vibo-traction", "ph-weak"]),
    projection("forbes", "Forbes evidence thinner than claimed", ["vibo-traction"]),
    projection("vibo-traction", "ViBo activations are real but small", ["rec_1", "rec_2"], { labelOrigin: "selected" }),
    projection("ph-weak", "Product Hunt weak", ["rec_3"]),
    source("rec_1", "19 activations, all from one channel"),
    source("rec_2", "retention evidence missing entirely"),
    source("rec_3", "Product Hunt launch drew 4 upvotes"),
  ],
};

test("the attention budget holds at every altitude, not just entry", () => {
  const wide = { nodes: [projection("w", "wide", ["c1","c2","c3","c4","c5","c6","c7"]),
    ...["c1","c2","c3","c4","c5","c6","c7"].map((c) => source(c, `record ${c}`))] };
  assert.equal(ATTENTION_BUDGET, 5);
  assert.equal(decompose(wide, "w").length, 5, "seven constituents must still present as five");
  assert.equal(altitudeScene(wide, { focus: "w" }).concepts.length, 5);
});

test("a shared concept has two parents and is stored once", () => {
  const parents = parentsOf(graph, "vibo-traction").map((p) => p.id).sort();
  assert.deepEqual(parents, ["dist", "forbes"],
    "one decision may matter to two higher-level concepts");
  const copies = graph.nodes.filter((n) => n.id === "vibo-traction");
  assert.equal(copies.length, 1, "source truth must never be duplicated to manufacture a tree");
});

test("zoom in decomposes one concept; zoom out recomposes along the lens taken", () => {
  const down = decompose(graph, "dist").map((n) => n.id);
  assert.deepEqual(down, ["vibo-traction", "ph-weak"]);

  // Descending through Forbes must climb back to Forbes, not to whichever
  // parent happens to be first — the selected centre stays stable.
  const via = ["a0", "forbes", "vibo-traction"];
  assert.equal(recompose(graph, "vibo-traction", { via }).id, "forbes");
  // Negative control: with no lens recorded, it may pick either, but it must
  // still return a real parent rather than null.
  assert.ok(["dist", "forbes"].includes(recompose(graph, "vibo-traction").id));
});

test("zoom stops at semantic atoms instead of silently doing nothing", () => {
  const scene = altitudeScene(graph, { focus: "rec_1" });
  assert.equal(scene.atSource, true);
  assert.equal(decompose(graph, "rec_1"), null);
});

test("a projection without provenance is rejected, not degraded", () => {
  assert.equal(projectionIsWellFormed(projection("ok", "fine", ["rec_1"])), true);
  for (const missing of ["revision", "sourceObservationIds", "generatedAt", "label"]) {
    const broken = projection("bad", "claim", ["rec_1"]);
    delete broken[missing];
    assert.equal(projectionIsWellFormed(broken), false, `missing ${missing} must be rejected`);
  }
  // A projection that decomposes into nothing is a leaf pretending to be a layer.
  assert.equal(projectionIsWellFormed(projection("leaf", "claim", [])), false);
});

test("a projection is never mistakable for an authored source record", () => {
  const proj = graph.nodes.find((n) => n.id === "dist");
  const rec = graph.nodes.find((n) => n.id === "rec_1");
  assert.equal(isProjection(proj), true);
  assert.equal(isAuthoredSource(proj), false);
  assert.equal(isAuthoredSource(rec), true);
  assert.equal(isProjection(rec), false);
  // Authored text is exact and belongs only to the source object.
  assert.equal(rec.text, "19 activations, all from one channel");
  assert.equal(proj.text, undefined, "a projection must not carry authored text of its own");
});

test("a label copied verbatim from a descendant is disclosed as selected, not generated", () => {
  assert.equal(labelOrigin(graph.nodes.find((n) => n.id === "vibo-traction")), "selected");
  // Default is the honest one: unlabelled provenance means generated.
  assert.equal(labelOrigin(graph.nodes.find((n) => n.id === "dist")), "generated");
  assert.equal(labelOrigin(graph.nodes.find((n) => n.id === "rec_1")), "authored");
});

test("hidden complexity is countable for Inspect and absent from the label", () => {
  const weight = hiddenWeight(graph, "a0");
  assert.ok(weight.records >= 3, "the top concept must know what it stands on");
  const label = graph.nodes.find((n) => n.id === "a0").label;
  assert.equal(/\d+\s+(records|runs|projects)/.test(label), false,
    "counts belong to Inspect, never to the concept the human reads");
});

test("the lens path climbs to a root and its length is the altitude", () => {
  assert.deepEqual(lensPath(graph, "rec_1", { via: ["a0", "dist", "vibo-traction", "rec_1"] }),
    ["a0", "dist", "vibo-traction", "rec_1"]);
  assert.equal(altitudeScene(graph, { focus: "rec_1", via: ["a0", "dist", "vibo-traction", "rec_1"] }).altitude, 3);
  assert.deepEqual(roots(graph).map((n) => n.id), ["a0"]);
});
