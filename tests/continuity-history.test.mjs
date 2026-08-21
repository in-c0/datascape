import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_KINDS,
  appendRevision,
  createRevisionIndex,
  materialChange,
  revisionAt,
  revisionsOf,
  workingOverlay,
} from "../src/continuity/history/revision.js";
import {
  DIFF_BUDGET,
  HISTORICAL_UNAVAILABLE,
  affordances,
  decodeHistoryState,
  encodeHistoryState,
  reconstructExceptions,
  semanticDiff,
  semanticScene,
} from "../src/continuity/history/asof.js";
import {
  T0, T1, T2, T3, T4,
  T2_TEXT, T3_TEXT, T4_TEXT,
  TIMELINE,
  buildHistoryWorld,
} from "../src/continuity/fixtures/v4-history.js";

const world = buildHistoryWorld();
const rel = () => revisionsOf(world.revisions, "reliability");

// §18 acceptance tests ---------------------------------------------------------

test("V4 §18: a routine observation causes no revision churn anywhere", () => {
  const step = world.log.find((l) => l.step === 1);
  assert.equal(step.reliability.appended, false, T1);
  assert.equal(step.reliability.reason, "no material semantic change");
  assert.equal(step.dist.appended, false);
  assert.equal(step.cat.appended, false);
});

test("V4 §18: the material blocker revises Reliability and keeps its id", () => {
  const step = world.log.find((l) => l.step === 2);
  assert.equal(step.reliability.appended, true);
  assert.equal(step.reliability.revision, 2, "revision 1 was the T0 baseline");
  assert.ok(step.reliability.kinds.includes("interpretation_revised"));
  assert.ok(step.reliability.kinds.includes("constituent_added"));
  assert.equal(step.reliability.record.projection_id, "reliability", "the concept is the same concept");
  assert.equal(step.reliability.record.supersedes_revision, 1);
});

test("V4 §18: the recovery evidence takes the next revision, same id", () => {
  const step = world.log.find((l) => l.step === 3);
  assert.equal(step.reliability.appended, true);
  assert.equal(step.reliability.revision, 3);
  assert.equal(step.reliability.record.label, "Launch reliability recovered after rollback.");
  assert.equal(step.reliability.record.projection_id, "reliability");
});

test("V4 §18: ongoing routine live work makes a working overlay, not a revision", () => {
  const step = world.log.find((l) => l.step === 4);
  assert.equal(step.reliability.appended, false,
    "materially-live work at a lower level must not create an A0 revision");

  const overlay = workingOverlay(world.revisions, "reliability", world.sources, { now: Date.parse(T4) + 1000 });
  assert.equal(overlay.settled_revision, 3);
  assert.equal(overlay.is_settled, false, "an overlay must never read as a settled revision");
  assert.equal(overlay.material_semantic_change, "none yet");
  assert.ok(overlay.working_evidence.includes("S05_r13"), "the T4 evidence is visible as working state");
});

test("V4 §18: unrelated concepts never move while Reliability does", () => {
  for (const id of ["dist", "cat"]) {
    const list = revisionsOf(world.revisions, id);
    assert.equal(list.length, 1, `${id} took ${list.length} revisions; it should have taken only its baseline`);
    assert.equal(list[0].revision, 1);
  }
  assert.equal(rel().length, 3, "Reliability: baseline, blocker, recovery");
});

// §5 as-of reconstruction ------------------------------------------------------

test("V4 §5: a scene at T0 cannot observe evidence from T2, T3 or T4", () => {
  const scene = semanticScene(world, T0);
  assert.equal(scene.available, true);
  const ids = new Set(scene.sources.map((s) => s.id));
  for (const later of ["S05_r11", "S05_r12", "S05_r13"]) {
    assert.equal(ids.has(later), false, `${later} leaked into the T0 scene`);
  }
  const texts = scene.sources.map((s) => s.text).join(" ");
  assert.equal(texts.includes(T2_TEXT), false);
  assert.equal(texts.includes(T3_TEXT), false);
  assert.equal(texts.includes(T4_TEXT), false);

  const reliability = scene.projections.find((p) => p.projection_id === "reliability");
  assert.equal(reliability.revision, 1, "the T0 scene must show the baseline interpretation");
});

test("V4 §5: a scene at T2 cannot observe the T3 recovery", () => {
  const scene = semanticScene(world, T2);
  const reliability = scene.projections.find((p) => p.projection_id === "reliability");
  assert.equal(reliability.revision, 2);
  assert.equal(reliability.label, "Launch reliability is blocked by a production websocket rejection.");
  assert.equal(scene.sources.some((s) => s.text === T3_TEXT), false,
    "the recovery had not happened yet and must not appear");
});

test("V4 §5: the present is reconstructed from the same function without a cutoff", () => {
  const now = semanticScene(world, null);
  assert.equal(now.historical, false);
  assert.equal(now.readOnly, false);
  const reliability = now.projections.find((p) => p.projection_id === "reliability");
  assert.equal(reliability.revision, 3);
});

test("V4 §5: an unreconstructable moment says so rather than substituting the present", () => {
  const bad = semanticScene(world, "not-a-timestamp");
  assert.equal(bad.available, false);
  assert.equal(bad.reason, HISTORICAL_UNAVAILABLE);
  assert.equal(bad.sources, undefined, "the present must not be handed back under a historical label");

  const beforeEverything = semanticScene(world, "2000-01-01T00:00:00+10:00");
  assert.equal(beforeEverything.available, false);
  assert.equal(beforeEverything.reason, HISTORICAL_UNAVAILABLE);
});

test("V4 §5: an exception shows the state it was in, not what it became", () => {
  const during = reconstructExceptions(world.exceptionHistory, T2);
  assert.equal(during[0].status, "blocked-on-owner",
    "at T2 the exception was unresolved and the scene must say so");
  const after = reconstructExceptions(world.exceptionHistory, T4);
  assert.equal(after[0].status, "resolved");
  const before = reconstructExceptions(world.exceptionHistory, T1);
  assert.deepEqual(before, [], "an exception that did not exist yet must be absent, not pending");
});

// §4 the read-only rule --------------------------------------------------------

test("V4 §4: a historical scene offers no owner action at all", () => {
  const past = affordances(semanticScene(world, T2));
  assert.equal(past.ownerActions, false);
  assert.equal(past.canRule, false);
  assert.equal(past.canResumeLane, false);
  for (const forbidden of ["approve", "reply", "defer", "dismiss", "resume"]) {
    assert.equal(past.allowed.includes(forbidden), false, `${forbidden} must be impossible while rewound`);
  }
  assert.ok(past.allowed.includes("return_to_now"));

  // Negative control: the present must still allow all of them.
  const present = affordances(semanticScene(world, null));
  assert.equal(present.ownerActions, true);
  for (const allowed of ["approve", "reply", "defer", "dismiss"]) {
    assert.ok(present.allowed.includes(allowed));
  }
});

// §9-§10 semantic diff ---------------------------------------------------------

test("V4 §9: a diff is bounded, revision-grounded and ephemeral", () => {
  const diff = semanticDiff(world.revisions, "reliability", 1, 2);
  assert.equal(diff.available, true);
  assert.equal(diff.type, "semantic_diff");
  assert.equal(diff.ephemeral, true, "a diff is system-derived, never projection truth");
  assert.equal(diff.from_revision, 1);
  assert.equal(diff.to_revision, 2);
  assert.ok(diff.changes.length > 0);
  assert.ok(diff.changes.length <= DIFF_BUDGET);
  for (const change of diff.changes) assert.ok(CHANGE_KINDS.includes(change.kind), change.kind);
  const interpretation = diff.changes.find((c) => c.kind === "interpretation_revised");
  assert.match(interpretation.after, /websocket rejection/);
});

test("V4 §10: volume is never a change, and stays Inspect-level", () => {
  const diff = semanticDiff(world.revisions, "reliability", 2, 3);
  for (const change of diff.changes) {
    assert.equal(/\d+\s*(observations?|records?|events?)/i.test(JSON.stringify(change)), false,
      "a count must never reach the change aperture");
  }
  assert.ok(diff.inspect_only.source_count_after >= diff.inspect_only.source_count_before);
});

test("V4 §16: removed evidence remains inspectable at the earlier revision", () => {
  const index = createRevisionIndex();
  const base = {
    label: "A concept", direct_child_ids: ["a", "b"], relationships: [],
    source_observation_ids: ["s1", "s2"], materiality: "material", execution: "completed", owner_requirement: false,
  };
  appendRevision(index, "p", base, { at: T0 });
  appendRevision(index, "p", { ...base, label: "A narrower concept", direct_child_ids: ["a"], source_observation_ids: ["s1"] }, { at: T2 });
  const diff = semanticDiff(index, "p", 1, 2);
  const removed = diff.changes.find((c) => c.kind === "constituent_removed");
  assert.equal(removed.id, "b");
  assert.equal(removed.still_inspectable_at_revision, 1);
  assert.deepEqual(revisionAt(index, "p", T0).direct_child_ids, ["a", "b"],
    "the earlier revision still carries what was later removed");
});

// §2-§3 the settled/working distinction ---------------------------------------

test("V4 §2: corroboration alone is not a semantic change", () => {
  const before = {
    label: "Same meaning", direct_child_ids: ["a"], relationships: [],
    source_observation_ids: ["s1"], materiality: "material", execution: "live", owner_requirement: false,
  };
  const moreEvidence = { ...before, source_observation_ids: ["s1", "s2", "s3"] };
  assert.equal(materialChange(before, moreEvidence).changed, false,
    "three hundred new observations that change nothing are not history");

  // But withdrawn support IS a change.
  const withdrawn = { ...before, source_observation_ids: [] };
  assert.equal(materialChange(before, withdrawn).changed, true);
  assert.ok(materialChange(before, withdrawn).kinds.includes("support_changed"));
});

test("V4 §11: a genuine split records what it came from instead of reusing an id", () => {
  const index = createRevisionIndex();
  const base = {
    label: "Distribution strategy", direct_child_ids: ["a", "b"], relationships: [],
    source_observation_ids: ["s1"], materiality: "material", execution: "completed", owner_requirement: false,
  };
  appendRevision(index, "distribution", base, { at: T0 });
  const creator = appendRevision(index, "creator-distribution", {
    ...base, label: "Creator distribution", derived_from: "distribution", supersedes: "distribution",
  }, { at: T2 });
  assert.equal(creator.record.projection_id, "creator-distribution");
  assert.equal(creator.record.derived_from, "distribution");
  assert.equal(creator.record.revision, 1, "a new concept starts at revision 1");
  assert.equal(revisionsOf(index, "distribution").length, 1,
    "the original stays inspectable rather than being overwritten");
});

// §8 URL state -----------------------------------------------------------------

test("V4 §8: history is a third axis and round-trips beside lens and altitude", () => {
  const state = { lens: ["dist", "dist-shortform"], centre: "sf-vibo", altitude: 2, z: 1, asOf: T2, revision: 2 };
  const round = decodeHistoryState(encodeHistoryState(state));
  assert.deepEqual(round.lens, state.lens);
  assert.equal(round.centre, "sf-vibo");
  assert.equal(round.altitude, 2);
  assert.equal(round.z, 1);
  assert.equal(round.asOf, T2);
  assert.equal(round.revision, 2);
  assert.equal(round.historical, true);

  const live = decodeHistoryState(encodeHistoryState({ lens: ["dist"], centre: "dist", altitude: 0 }));
  assert.equal(live.historical, false, "no asOf means the live world");
  assert.equal(live.asOf, null);
});

test("V4: the fixture's own expectations match what replay actually produced", () => {
  for (const [i, event] of TIMELINE.entries()) {
    const step = world.log.find((l) => l.step === i + 1);
    assert.equal(step.reliability.appended, event.expect_revision,
      `${event.label} at ${event.at}: expected appended=${event.expect_revision}`);
  }
});
