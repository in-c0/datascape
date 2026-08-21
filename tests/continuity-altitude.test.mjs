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

// ---------------------------------------------------------------------------
// Spec v3 §10-§22: identity, materiality, live cognition, provenance.

import {
  contradictionBranches,
  dirtyAncestors,
  edgeIsAllowed,
  inspectProvenance,
  isMaterial,
  projectionAnchor,
  projectionExecution,
  reviseProjection,
} from "../src/continuity/altitude.js";

test("generated causal edges are prohibited, not merely discouraged", () => {
  for (const kind of ["contains", "supports", "contradicts", "supersedes", "depends_on"]) {
    assert.equal(edgeIsAllowed(kind), true);
  }
  assert.equal(edgeIsAllowed("causes"), false,
    "temporal sequence alone never creates causality");
  assert.equal(edgeIsAllowed("implies"), false, "the vocabulary is closed");
});

test("the same concept keeps its id across revisions; a different one does not", () => {
  const first = {
    id: "p1", type: "projection", conceptKey: "distribution-shift",
    label: "Distribution strategy changed", childIds: ["rec_1"],
    sourceObservationIds: ["obs_1"], generatedAt: "2026-08-21T10:00:00+10:00",
    materiality: "material", status: "committed",
  };
  const revised = reviseProjection(first, { ...first, label: "Distribution shifted to short-form", childIds: ["rec_2"], sourceObservationIds: ["obs_2"] });
  assert.equal(revised.id, "p1", "a refined interpretation must not delete and recreate the node");
  assert.equal(revised.revision, 2);
  assert.deepEqual(revised.childIds, ["rec_1", "rec_2"]);
  assert.deepEqual(revised.sourceObservationIds, ["obs_1", "obs_2"]);
  assert.equal(revised.history[0].label, "Distribution strategy changed",
    "historical revisions remain inspectable");

  // Same concept, same interpretation, one more source: no revision churn.
  const quiet = reviseProjection(revised, { ...revised, sourceObservationIds: ["obs_3"] });
  assert.equal(quiet.revision, 2, "gaining a source is not a material change");

  // Negative control: a genuinely different concept earns a new identity.
  const other = reviseProjection(first, { ...first, id: "p2", conceptKey: "security-risk", label: "Credential leak" });
  assert.equal(other.id, "p2");
  assert.equal(other.revision, 1);
  assert.equal(other.supersedes, "p1");
});

test("many events are not material; one blocker is", () => {
  assert.equal(isMaterial({ kind: "routine_tick" }), false);
  assert.equal(isMaterial({ kind: "routine_tick", count: 1000 }), false,
    "volume must never stand in for materiality");
  assert.equal(isMaterial({ kind: "new_blocker" }), true);
  assert.equal(isMaterial({ kind: "routine_tick", severity: "high" }), true);
  assert.equal(isMaterial({ kind: "routine_tick", ownerAttention: true }), true);
});

test("an immaterial observation stops climbing; a material one reaches A0", () => {
  const noise = dirtyAncestors(graph, ["rec_3"], { kind: "routine_tick" });
  assert.ok(!noise.includes("a0"),
    "a routine tick must not re-summarise the top of the graph");
  assert.deepEqual(noise, ["ph-weak"], "its immediate ancestor still recomputes");

  const leak = dirtyAncestors(graph, ["rec_3"], { kind: "new_blocker", severity: "high" });
  assert.ok(leak.includes("a0"), "a material blocker can reach the top concept");
});

test("a projection is live only when a materially live descendant exists", () => {
  const lint = {
    nodes: [
      { id: "strategy", type: "projection", label: "Company strategy", childIds: ["lint"],
        revision: 1, sourceObservationIds: ["o"], generatedAt: "2026-08-21T10:00:00+10:00" },
      { id: "lint", type: "source", text: "lint agent running", execution: "live", materiality: "immaterial" },
    ],
  };
  assert.equal(projectionExecution(lint, "strategy"), "completed",
    "a background lint agent must not make company strategy read as live");

  const real = JSON.parse(JSON.stringify(lint));
  real.nodes[1].materiality = "material";
  assert.equal(projectionExecution(real, "strategy"), "live");
});

test("a live projection sits at NOW; a completed one at its material transition", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const g = {
    nodes: [
      { id: "done", type: "projection", label: "Gate cleared", childIds: ["s1"],
        revision: 1, sourceObservationIds: ["o"], generatedAt: "2026-08-21T12:00:00+10:00",
        at: "2026-08-21T04:00:00+10:00", materialAt: "2026-08-21T11:53:00+10:00" },
      { id: "s1", type: "source", text: "gate cleared", execution: "completed" },
    ],
  };
  assert.equal(projectionAnchor(g, "done", now), "2026-08-21T11:53:00+10:00",
    "the material transition, not the earliest constituent record");

  g.nodes[1].execution = "live";
  g.nodes[1].materiality = "material";
  assert.equal(Date.parse(projectionAnchor(g, "done", now)), now);
});

test("contradiction stays recoverable as two branches", () => {
  const g = {
    nodes: [
      { id: "disputed", type: "projection", label: "Migration safety disputed", childIds: ["a", "b"],
        revision: 1, sourceObservationIds: ["o"], generatedAt: "2026-08-21T12:00:00+10:00" },
      { id: "a", type: "source", text: "migration safe" },
      { id: "b", type: "source", text: "migration unsafe" },
    ],
    edges: [{ from: "disputed", to: "b", kind: "contradicts" }],
  };
  const branches = contradictionBranches(g, "disputed");
  assert.ok(branches && branches.length >= 2, "both sides must survive the abstraction");
  assert.equal(g.nodes[1].text, "migration safe");
  assert.equal(g.nodes[2].text, "migration unsafe");
  assert.equal(contradictionBranches(g, "a"), null, "no edge, no claimed dispute");
});

test("Inspect answers why am I being shown this, and default screens do not", () => {
  const p = inspectProvenance(graph, "dist");
  assert.equal(p.derived, true);
  assert.equal(p.labelOrigin, "generated");
  assert.equal(p.directConcepts, 2);
  assert.ok(p.sourceObservations >= 3);
  assert.equal(p.revision, 1);
  // A source record has no derived provenance to expose.
  assert.equal(inspectProvenance(graph, "rec_1"), null);
});
