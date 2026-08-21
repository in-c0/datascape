import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_BUDGET,
  altitudeScene,
  childrenOf,
  conceptRoots,
  contradictionBranches,
  decompose,
  dirtyAncestors,
  hiddenWeight,
  isAuthoredSource,
  isProjection,
  lensPath,
  orphanedMaterial,
  parentsOf,
  projectionExecution,
  projectionIsWellFormed,
  recompose,
  reviseProjection,
} from "../src/continuity/altitude.js";
import {
  CANONICAL_DESCENT,
  FIXTURE_CLOCK,
  MUTATION_B_TEXT,
  RECORDS_PER_SESSION,
  SESSIONS,
  buildProjectionGraph,
  buildSourceRecords,
  mutationA,
  mutationB,
} from "../src/continuity/fixtures/v3-projection.js";

const graph = buildProjectionGraph();
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const labelOf = (id) => byId.get(id)?.label;

// §1 -------------------------------------------------------------------------

test("v3.1 §1: the fixture is pinned, sized exactly, and not randomised", () => {
  assert.equal(FIXTURE_CLOCK.timeZone, "Australia/Sydney");
  assert.equal(FIXTURE_CLOCK.since, "2026-08-21T10:00:00+10:00");
  assert.equal(FIXTURE_CLOCK.now, "2026-08-21T18:40:00+10:00");
  assert.equal(SESSIONS.length, 12);
  assert.equal(RECORDS_PER_SESSION, 10);

  const sources = graph.nodes.filter(isAuthoredSource);
  assert.equal(sources.length, 120, "12 sessions x 10 records, exactly");

  const laneCounts = SESSIONS.reduce((acc, s) => ({ ...acc, [s.lane]: (acc[s.lane] || 0) + 1 }), {});
  assert.deepEqual(laneCounts, { Vibo: 2, Sumzup: 1, Outreach: 1, PersonalOS: 2, Security: 2, "Cat Intent": 4 });

  // Determinism: two builds must be byte-identical, or no capture is comparable
  // with any other capture.
  assert.deepEqual(buildSourceRecords(), buildSourceRecords());
  assert.equal(JSON.stringify(buildProjectionGraph()), JSON.stringify(buildProjectionGraph()));
});

test("v3.1 §1: routine filler is numbered by slot and sits below the threshold", () => {
  const s01 = buildSourceRecords().filter((r) => r.session === "S01");
  assert.equal(s01[2].text, "S01 routine verification 03: no material change.",
    "filler is numbered by SLOT, which is what makes mutation A's 'verification 11' line up");
  assert.equal(s01[2].materiality, "immaterial");
  assert.equal(s01.filter((r) => r.materiality === "material").length, 2);
});

test("v3.1 §1: exactly three concurrent materially-live sessions", () => {
  const live = SESSIONS.filter((s) => s.execution === "live").map((s) => s.id);
  assert.deepEqual(live, ["S03", "S05", "S12"]);
});

// §2 -------------------------------------------------------------------------

test("v3.1 §2: authored evidence is present verbatim", () => {
  const texts = new Set(graph.nodes.filter(isAuthoredSource).map((n) => n.text));
  for (const exact of [
    "The 7-second spatial before/after clip held attention 2.4× longer than the static walkthrough.",
    "The first three seconds decided most drop-off; the reveal version retained 68% versus 31%.",
    "Landing-page conversion rose from 4.8% to 7.1% after the interactive preview was moved above the fold.",
    "The preview bundle passed the production build and browser smoke.",
    "Three short clips drove more qualified clicks than the full episode post.",
    "The fourth short clip is still collecting data.",
    "No direct outreach experiment has been run yet.",
    "Approve using the existing creator account for one 20-message outreach batch.",
    "Production shadow run dropped 3 websocket events; do not promote yet.",
    "Production watcher still reports the deployment gate closed.",
    "Migration dry-run completed with zero schema drift; safe to promote.",
    "A live API key is present in published git history.",
    "Rotate the exposed key and revoke the old credential.",
    "Secret scanning passes the current tree but cannot invalidate the already published credential.",
    "Visual posture alone predicted door intent correctly in 18 of 20 trials.",
    "Audio reversed the predicted intent class in 6 of 20 otherwise identical posture clips.",
    "The household pilot cannot proceed until one real household recording is supplied.",
    "Provide one household recording for the pilot.",
    "Fusion review is still comparing six visual-audio disagreement cases.",
  ]) {
    assert.ok(texts.has(exact), `missing or altered: ${exact}`);
  }
});

test("v3.1 §2: no projection carries authored text, and no source is reachable only as a label", () => {
  for (const node of graph.nodes) {
    if (isProjection(node)) {
      assert.equal(node.text, undefined, `${node.id} must not carry authored text`);
      assert.equal(projectionIsWellFormed(node), true, `${node.id} must carry full provenance`);
    }
  }
  assert.equal(orphanedMaterial(graph).length, 0,
    "a material observation no projection reaches is invisible at every altitude");
});

// §3 -------------------------------------------------------------------------

test("v3.1 §3: exactly four A0 concepts, with no counts or lane names in labels", () => {
  const a0 = conceptRoots(graph);
  assert.equal(a0.length, 4);
  assert.deepEqual(a0.map((n) => n.label), [
    "Distribution evidence shifted toward short-form demonstrations.",
    "Launch reliability is blocked by conflicting deployment evidence.",
    "Cat intent validation advanced, but multimodal evidence is still unresolved.",
    "Needs you",
  ]);
  for (const node of a0) {
    assert.equal(/\d+\s*(records?|runs?|sessions?|projects?)/i.test(node.label), false,
      `counts belong to Inspect, not to ${node.label}`);
  }
  // Negative control: the aperture must not silently include stray atoms.
  assert.ok(conceptRoots(graph).every(isProjection));
});

// §4 -------------------------------------------------------------------------

test("v3.1 §4: the canonical branch is six transitions and every step has a sibling", () => {
  assert.equal(CANONICAL_DESCENT.length, 7, "seven nodes is six transitions");
  assert.equal(CANONICAL_DESCENT[0], "dist");
  assert.equal(isAuthoredSource(byId.get(CANONICAL_DESCENT[6])), true, "the descent ends at source");
  assert.equal(byId.get(CANONICAL_DESCENT[6]).text,
    "The first three seconds decided most drop-off; the reveal version retained 68% versus 31%.");

  for (let i = 0; i < CANONICAL_DESCENT.length - 1; i++) {
    const parent = CANONICAL_DESCENT[i];
    const next = CANONICAL_DESCENT[i + 1];
    const kids = childrenOf(graph, parent).map((n) => n.id);
    assert.ok(kids.includes(next), `${parent} must decompose into ${next}`);
    assert.ok(kids.length >= 2,
      `${parent} needs a sibling for ${next}, or the path is a disguised linked list`);
    assert.ok(kids.length <= ATTENTION_BUDGET, `${parent} exceeds the constituent ceiling`);
  }
});

test("v3.1 §4: the named siblings are the authored ones", () => {
  assert.deepEqual(childrenOf(graph, "dist").map((n) => n.label), [
    "Short-form demonstrations have the strongest positive evidence.",
    "Landing conversion improved.",
    "Long-form posting produced weaker qualified traffic.",
    "Direct outreach remains untested.",
  ]);
  assert.ok(childrenOf(graph, "dist-shortform").map((n) => n.label)
    .includes("Sumzup short clips outperform its full-post path."));
  assert.ok(childrenOf(graph, "vibo-beforeafter").map((n) => n.label)
    .includes("Static walkthrough loses attention earlier."));
  assert.ok(childrenOf(graph, "ba-spatial").map((n) => n.label)
    .includes("Longer walkthrough duration weakens the hook."));
});

// §5 -------------------------------------------------------------------------

test("v3.1 §5: the shared node exists once and is reachable through two lenses", () => {
  const copies = graph.nodes.filter((n) => n.label === "Interactive preview build is production-compatible.");
  assert.equal(copies.length, 1, "the object exists once");
  const shared = copies[0];

  const distLens = lensPath(graph, shared.id, { via: ["dist", "dist-shortform", "sf-vibo", "vibo-preview", shared.id] });
  const relLens = lensPath(graph, shared.id, { via: ["reliability", "rel-build-green", shared.id] });
  assert.equal(distLens[0], "dist");
  assert.equal(relLens[0], "reliability");

  // Descending through one lens must climb back through THAT lens.
  assert.equal(recompose(graph, shared.id, { via: distLens }).id, "vibo-preview");
  assert.equal(recompose(graph, shared.id, { via: relLens }).id, "rel-build-green");

  assert.equal(childrenOf(graph, shared.id)[0].text,
    "The preview bundle passed the production build and browser smoke.");
});

// §6 -------------------------------------------------------------------------

test("v3.1 §6: both contradictions keep both branches recoverable", () => {
  const migration = byId.get("rel-migration-disputed");
  assert.equal(migration.label, "Migration safety is disputed.");
  const migrationTexts = childrenOf(graph, migration.id).map((n) => n.text);
  assert.ok(migrationTexts.includes("Migration dry-run completed with zero schema drift; safe to promote."));
  assert.ok(migrationTexts.includes("Production shadow run dropped 3 websocket events; do not promote yet."));
  assert.ok(contradictionBranches(graph, migration.id));

  const visual = byId.get("cat-visual-disputed");
  assert.equal(visual.label, "Whether visual-only evidence is sufficient is disputed.");
  const visualTexts = childrenOf(graph, visual.id).map((n) => n.text);
  assert.ok(visualTexts.includes("Visual posture alone predicted door intent correctly in 18 of 20 trials."));
  assert.ok(visualTexts.includes("Audio reversed the predicted intent class in 6 of 20 otherwise identical posture clips."));
  assert.ok(contradictionBranches(graph, visual.id));

  // Negative control: neither was flattened into an "uncertain" label.
  for (const node of graph.nodes) {
    assert.equal(/status unclear|uncertain$/i.test(node.label || ""), false);
  }
});

// §7 -------------------------------------------------------------------------

test("v3.1 §7: Needs you projects the exception inbox rather than duplicating it", () => {
  assert.deepEqual(childrenOf(graph, "needs").map((n) => n.label), ["Security", "Outreach", "Cat pilot"]);
  const security = childrenOf(graph, "needs-security").filter(isAuthoredSource).map((n) => n.text);
  assert.ok(security.includes("Rotate the exposed key and revoke the old credential."));

  // Every owner action in the fixture is reachable through Needs you, and there
  // is exactly one queue.
  const ownerActions = graph.nodes.filter((n) => n.ownerAction === true);
  assert.equal(ownerActions.length, 3);
  const reachable = new Set(childrenOf(graph, "needs")
    .flatMap((bucket) => childrenOf(graph, bucket.id))
    .map((n) => n.id));
  for (const action of ownerActions) {
    assert.ok(reachable.has(action.id), `${action.text} must be reachable through Needs you`);
  }
});

// §11 ------------------------------------------------------------------------

test("v3.1 §11: three live sessions surface as two live A0 concepts, not three", () => {
  const live = conceptRoots(graph).filter((n) => projectionExecution(graph, n.id) === "live");
  assert.deepEqual(live.map((n) => n.id), ["reliability", "cat"],
    "liveness must not propagate mechanically to every ancestor");

  // The boundary is honest about ITSELF: the fourth clip really is still
  // collecting, so this node reads live. What the boundary stops is the
  // inheritance — its parents do not become live because of it.
  assert.equal(projectionExecution(graph, "sf-sumzup"), "live");
  assert.equal(projectionExecution(graph, "dist-shortform"), "completed",
    "the parent of a boundary must not inherit its liveness");
  // Negative control: remove the boundary and Distribution does go live.
  const leaky = { ...graph, nodes: graph.nodes.map((n) => n.id === "sf-sumzup" ? { ...n, liveBoundary: false } : n) };
  assert.equal(projectionExecution(leaky, "dist"), "live",
    "without the boundary the fixture would show three live roots, which is the failure mode");
});

// §9 / budget ----------------------------------------------------------------

test("v3.1 §9: no altitude ever renders more than five concepts", () => {
  for (const node of graph.nodes.filter(isProjection)) {
    const scene = altitudeScene(graph, { focus: node.id });
    assert.ok(scene.concepts.length <= ATTENTION_BUDGET,
      `${node.id} rendered ${scene.concepts.length} concepts`);
  }
  assert.ok(conceptRoots(graph).length <= 4, "the return aperture is at most four roots");
});

// §13 ------------------------------------------------------------------------

test("v3.1 §13 mutation A: irrelevant volume does not move A0", () => {
  const before = conceptRoots(graph).map((n) => ({ id: n.id, label: n.label, revision: n.revision }));
  const mutated = mutationA(graph);

  assert.equal(mutated.nodes.filter(isAuthoredSource).length, 121);
  assert.equal(mutated.nodes.find((n) => n.id === "S01_r11").text,
    "S01 routine verification 11: no material change.");

  const after = conceptRoots(mutated).map((n) => ({ id: n.id, label: n.label, revision: n.revision }));
  assert.deepEqual(after, before, "labels, ids and revisions must all be untouched");

  const dirty = dirtyAncestors(mutated, ["S01_r11"], { kind: "routine_tick" });
  assert.ok(!dirty.includes("dist"), "materiality propagation must stop below A0");
});

test("v3.1 §13 mutation B: a material blocker revises reliability and nothing else", () => {
  const mutated = mutationB(graph);
  assert.ok(mutated.nodes.some((n) => n.text === MUTATION_B_TEXT));

  const dirty = dirtyAncestors(mutated, ["S05_r11"], { kind: "new_blocker", severity: "high" });
  assert.ok(dirty.includes("rel-gate-closed"));
  assert.ok(dirty.includes("reliability"), "a material blocker reaches its A0 concept");
  assert.ok(!dirty.includes("dist"), "unrelated Distribution must not be dirtied");
  assert.ok(!dirty.includes("cat"), "unrelated Cat Intent must not be dirtied");

  // The concept keeps its identity and takes a material revision.
  const before = byId.get("reliability");
  const revised = reviseProjection(before, {
    ...before,
    label: "Launch reliability is blocked by conflicting deployment evidence.",
    materiality: "material",
    status: "blocked",
  });
  assert.equal(revised.id, "reliability");
  assert.equal(revised.revision, 2);
  assert.equal(revised.history.length, 1);

  // Unrelated roots keep revision 1.
  for (const id of ["dist", "cat"]) {
    assert.equal(byId.get(id).revision, 1);
  }
});

// Provenance -----------------------------------------------------------------

test("v3.1: hidden complexity is real and countable but never in the label", () => {
  const weight = hiddenWeight(graph, "dist");
  assert.ok(weight.records > 10, `Distribution should stand on real evidence, got ${weight.records}`);
  assert.equal(/\d/.test(labelOf("dist").replace(/short-form/, "")), false,
    "no digits leak into the A0 label");

  // A shared child is counted once per lens rather than once per parent.
  const shared = hiddenWeight(graph, "shared-preview-build");
  assert.equal(shared.records, 1);
  assert.equal(parentsOf(graph, "shared-preview-build").length, 2);
});

test("v3.1: decompose stops at source and never invents a deeper layer", () => {
  const sourceId = CANONICAL_DESCENT[6];
  assert.equal(decompose(graph, sourceId), null);
  assert.equal(altitudeScene(graph, { focus: sourceId }).atSource, true);
});
