// The deterministic V4 history fixture — spec V4 §12.
//
// Reuses the V3.1 corpus rather than building another universe, and extends
// only the Reliability branch at controlled times. The four events are chosen
// to prove one thing each, and between them they cover the distinction the
// whole phase rests on: which arrivals become history and which stay working
// state.
//
//   T1  routine observation      -> no revision anywhere
//   T2  material blocker         -> Reliability same id, revision +1
//   T3  recovery evidence        -> Reliability same id, next revision
//   T4  ongoing routine live work-> working overlay, still no new revision
//
// Nothing here calls a model. Every label is authored in this file.

import { FIXTURE_CLOCK, buildProjectionGraph, mutationA } from "./v3-projection.js";
import { appendRevision, createRevisionIndex } from "../history/revision.js";

export const T0 = "2026-08-21T12:34:00+10:00";   // baseline, the V3.1 world
export const T1 = "2026-08-21T13:10:00+10:00";   // immaterial
export const T2 = "2026-08-21T15:26:00+10:00";   // material blocker
export const T3 = "2026-08-21T17:40:00+10:00";   // material recovery
export const T4 = "2026-08-21T18:20:00+10:00";   // live, immaterial at A0

/** Exact authored text. These are source records, preserved verbatim. */
export const T2_TEXT = "Production watcher now rejects all websocket upgrades after deployment.";
export const T3_TEXT = "Production verification passed 1,000 websocket upgrades with zero drops after rollback; the deployment gate is cleared.";
export const T4_TEXT = "Post-deploy watcher is still collecting the final 30-minute stability window.";

const source = (id, at, text, extra = {}) => ({
  id, type: "source", session: "S05", lane: "PersonalOS",
  text, label: text, at,
  kind: extra.kind || "progress",
  materiality: extra.materiality || "material",
  severity: extra.severity || null,
  ownerAction: false,
  execution: extra.execution || "completed",
  supervision: "unattended",
});

/** The four timed events, in order. */
export const TIMELINE = [
  {
    at: T1, label: "routine verification",
    record: {
      ...source("S01_r11", T1, "S01 routine verification 11: no material change.", { kind: "routine_tick", materiality: "immaterial" }),
      session: "S01", lane: "Vibo",
    },
    expect_revision: false,
  },
  {
    at: T2, label: "material blocker",
    record: source("S05_r11", T2, T2_TEXT, { kind: "new_blocker", severity: "high", execution: "live" }),
    expect_revision: true,
  },
  {
    at: T3, label: "material recovery",
    record: source("S05_r12", T3, T3_TEXT, { kind: "state_transition" }),
    expect_revision: true,
  },
  {
    at: T4, label: "ongoing routine live work",
    // Materially live at a LOWER semantic level, and deliberately not enough to
    // move the A0 concept. This is the case that proves working cognition can
    // exist without polluting semantic history.
    record: source("S05_r13", T4, T4_TEXT, { kind: "progress", materiality: "immaterial", execution: "live" }),
    expect_revision: false,
  },
];

/**
 * How the Reliability concept is interpreted after each event.
 *
 * Authored, deterministic, and deliberately unchanged for T1 and T4 — the
 * fixture asserts its own expectations by simply not changing the state that
 * should not change.
 */
function reliabilityStateAt(step) {
  const base = {
    label: "Launch reliability is blocked by conflicting deployment evidence.",
    direct_child_ids: ["rel-migration-disputed", "rel-gate-closed", "rel-build-green"],
    relationships: [{ kind: "depends_on", target: "rel-migration-disputed" }],
    source_observation_ids: ["S05_r01", "S05_r02", "S06_r01", "S02_r02"],
    materiality: "material",
    execution: "live",
    owner_requirement: false,
  };
  if (step < 2) return base;                       // T0 and T1 are identical
  if (step === 2) {
    return {
      ...base,
      label: "Launch reliability is blocked by a production websocket rejection.",
      direct_child_ids: [...base.direct_child_ids, "rel-websocket-rejection"],
      source_observation_ids: [...base.source_observation_ids, "S05_r11"],
    };
  }
  // T3 and T4: the concept recovers, and T4 adds nothing to the interpretation.
  return {
    ...base,
    label: "Launch reliability recovered after rollback.",
    direct_child_ids: [...base.direct_child_ids, "rel-websocket-rejection", "rel-verification-passed"],
    source_observation_ids: [...base.source_observation_ids, "S05_r11", "S05_r12"],
    execution: "completed",
  };
}

/** Concepts that must never move while Reliability does. */
const UNRELATED = {
  dist: {
    label: "Distribution evidence shifted toward short-form demonstrations.",
    direct_child_ids: ["dist-shortform", "dist-landing", "dist-longform", "dist-outreach"],
    relationships: [], source_observation_ids: ["S01_r01", "S01_r02", "S02_r01"],
    materiality: "material", execution: "completed", owner_requirement: false,
  },
  cat: {
    label: "Cat intent validation advanced, but multimodal evidence is still unresolved.",
    direct_child_ids: ["cat-visual-disputed", "cat-fusion-live", "cat-visual-positive"],
    relationships: [], source_observation_ids: ["S09_r01", "S10_r01", "S12_r01"],
    materiality: "material", execution: "live", owner_requirement: false,
  },
};

/**
 * Build the world by replaying the timeline, appending a revision only where a
 * material change actually occurred. The expectations in TIMELINE are asserted
 * by the tests against what this returns, not baked into it.
 */
export function buildHistoryWorld() {
  const graph = buildProjectionGraph();
  const sources = graph.nodes.filter((n) => n.type === "source");
  const index = createRevisionIndex();
  const log = [];

  // T0 baseline: every A0 concept takes revision 1.
  appendRevision(index, "reliability", reliabilityStateAt(0), { at: T0 });
  appendRevision(index, "dist", UNRELATED.dist, { at: T0 });
  appendRevision(index, "cat", UNRELATED.cat, { at: T0 });

  const all = [...sources];
  TIMELINE.forEach((event, i) => {
    const step = i + 1;
    all.push(event.record);
    const result = appendRevision(index, "reliability", reliabilityStateAt(step), { at: event.at });
    // Unrelated concepts are re-offered unchanged at every step; nothing should
    // be appended for them, and the test asserts exactly that.
    const distResult = appendRevision(index, "dist", UNRELATED.dist, { at: event.at });
    const catResult = appendRevision(index, "cat", UNRELATED.cat, { at: event.at });
    log.push({ step, at: event.at, label: event.label, reliability: result, dist: distResult, cat: catResult });
  });

  return {
    sources: all,
    projectionIds: ["reliability", "dist", "cat"],
    revisions: index,
    exceptionHistory: EXCEPTION_HISTORY,
    log,
    now: FIXTURE_CLOCK.now,
  };
}

/**
 * An exception that was open at T2 and resolved after T3.
 *
 * This is the §5 test case in fixture form: a scene reconstructed before the
 * resolution must show it unresolved, and must not inject what it later became.
 */
export const EXCEPTION_HISTORY = [
  { id: "exc_deploy_gate", at: T2, status: "blocked-on-owner", title: "Deployment gate is closed pending a websocket fix" },
  { id: "exc_deploy_gate", at: T3, status: "resolved", title: "Deployment gate is closed pending a websocket fix" },
];

/** The immaterial-volume mutation, reused from V3.1 rather than reinvented. */
export { mutationA };
