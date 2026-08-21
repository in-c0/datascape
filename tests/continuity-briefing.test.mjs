import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BUDGETS,
  agoLabel,
  buildScene,
  buildUrl,
  effortLabel,
  isDueNow,
  levelOf,
  orderOwnerActions,
  parentPath,
  partitionActions,
  readLocation,
  resolveDeferPreset,
} from "../src/continuity/briefing.js";

// Acceptance tests for spec v1 §13 and its `deferred_until` addendum.
// The node budgets in §12 are hard limits, so they are asserted rather than
// trusted: "no implementation may exceed these limits because there is
// available screen space."

const NOW = Date.parse("2026-08-21T16:00:00+10:00");

const action = (id, over = {}) => ({
  id,
  title: `Decision ${id}`,
  severity: "medium",
  loop: "alpha/one",
  opened: "2026-08-10T09:00:00+10:00",
  updated: "2026-08-20T09:00:00+10:00",
  steps: [],
  proposed: "Do the authored thing.",
  ...over,
});

const laneRecord = (id, items) => ({
  id,
  emittedAt: "2026-08-21T15:00:00+10:00",
  items,
});

function fixture(overrides = {}) {
  return {
    latestPerLane: 2,
    totals: { mustReads: 262 },
    lanes: [
      {
        lane: "alpha", label: "Alpha", total: 40, lastSeen: "2026-08-21T15:00:00+10:00",
        records: [laneRecord("mr_aaaaaaaaaaaaaaaa", [
          { headline: "Alpha merged a PR", type: "progress", detail: "d" },
          { headline: "Alpha found a bug", type: "finding", detail: "d" },
        ])],
      },
      { lane: "bravo", label: "Bravo", total: 9, lastSeen: "2026-08-21T14:00:00+10:00", records: [laneRecord("mr_bbbbbbbbbbbbbbbb", [{ headline: "Bravo state", type: "state", detail: "d" }])] },
      { lane: "charlie", label: "Charlie", total: 8, lastSeen: "2026-08-21T13:00:00+10:00", records: [laneRecord("mr_cccccccccccccccc", [{ headline: "Charlie state", type: "state", detail: "d" }])] },
      { lane: "delta", label: "Delta", total: 7, lastSeen: "2026-08-21T12:00:00+10:00", records: [laneRecord("mr_dddddddddddddddd", [{ headline: "Delta state", type: "state", detail: "d" }])] },
      { lane: "echo", label: "Echo", total: 6, lastSeen: "2026-08-21T11:00:00+10:00", records: [laneRecord("mr_eeeeeeeeeeeeeeee", [{ headline: "Echo state", type: "state", detail: "d" }])] },
    ],
    ownerActions: Array.from({ length: 12 }, (_, i) =>
      action(`ex-${i}`, {
        severity: i < 3 ? "high" : i < 8 ? "medium" : "low",
        loop: `${["alpha", "bravo", "charlie", "delta"][i % 4]}/sub`,
      })),
    ...overrides,
  };
}

const graphNodes = (scene) => scene.nodes.length;

// ---------------------------------------------------------------------------
// §13 semantic density
// ---------------------------------------------------------------------------

test("entry never exceeds 4 graph roots on the real-shaped dataset", () => {
  const scene = buildScene(fixture(), { now: NOW });
  assert.ok(graphNodes(scene) <= BUDGETS.entry, `entry showed ${graphNodes(scene)}`);
  assert.equal(scene.nodes[0].label, "Needs you", "Needs you comes first when decisions are due");
});

test("the 30-sec brief is tighter still", () => {
  const scene = buildScene(fixture(), { brief: "30s", now: NOW });
  assert.ok(graphNodes(scene) <= BUDGETS.entry30, `30s showed ${graphNodes(scene)}`);
});

test("Full does NOT raise the node ceiling — it only changes coverage", () => {
  const full = buildScene(fixture(), { brief: "full", now: NOW });
  assert.ok(graphNodes(full) <= BUDGETS.entry, `full showed ${graphNodes(full)}`);
});

test("selecting Needs you never produces more than 4 buckets", () => {
  const scene = buildScene(fixture(), { path: "needs", now: NOW });
  assert.ok(graphNodes(scene) <= BUDGETS.z0, `z0 showed ${graphNodes(scene)}`);
});

test("selecting a bucket never produces more than 5 nodes", () => {
  const scene = buildScene(fixture(), { path: "needs/alpha", now: NOW });
  assert.ok(graphNodes(scene) <= BUDGETS.z1, `z1 showed ${graphNodes(scene)}`);
});

test("every level of the ladder respects its budget", () => {
  const data = fixture();
  const paths = [
    ["", BUDGETS.entry],
    ["needs", BUDGETS.z0],
    ["needs/alpha", BUDGETS.z1],
    ["needs/alpha/ex-0", BUDGETS.z2],
    ["lane/alpha", BUDGETS.z0],
    ["lane/alpha/Finding", BUDGETS.z1],
  ];
  for (const [path, budget] of paths) {
    const scene = buildScene(data, { path, now: NOW });
    assert.ok(graphNodes(scene) <= budget, `${path || "(entry)"} showed ${graphNodes(scene)} > ${budget}`);
  }
});

test("paging windows the over-budget list instead of appending to it", () => {
  const data = fixture();
  const first = buildScene(data, { path: "needs/alpha", page: 0, now: NOW });
  const second = buildScene(data, { path: "needs/alpha", page: 1, now: NOW });
  assert.ok(graphNodes(second) <= BUDGETS.z1);
  const firstIds = first.nodes.map((n) => n.key).join();
  const secondIds = second.nodes.map((n) => n.key).join();
  if (first.pageCount > 1) assert.notEqual(firstIds, secondIds, "a second page should show different records");
});

// ---------------------------------------------------------------------------
// §13 recenter
// ---------------------------------------------------------------------------

test("selecting a record recenters: siblings are gone, one card remains", () => {
  const scene = buildScene(fixture(), { path: "needs/alpha/ex-0", now: NOW });
  assert.equal(scene.level, "z2");
  assert.ok(graphNodes(scene) <= BUDGETS.z2);
  assert.equal(scene.card.kind, "owner_action");
  assert.equal(scene.card.action.id, "ex-0");
  // The focal node is present and its parent is dimmed behind it.
  assert.ok(scene.nodes.some((n) => n.kind === "focus"));
  assert.ok(scene.nodes.some((n) => n.kind === "parent" && n.dim));
  // At most ONE sibling survives — not the rest of the bundle.
  assert.ok(scene.nodes.filter((n) => n.kind === "sibling").length <= 1);
});

test("Back restores the prior semantic level and centre", () => {
  const location = readLocation("https://x.test/?view=briefing&at=needs%2Falpha%2Fex-0&brief=30s&page=2");
  assert.equal(location.path, "needs/alpha/ex-0");
  assert.equal(location.brief, "30s");
  assert.equal(location.page, 2);
  const url = buildUrl(location, "https://x.test/");
  assert.equal(url.searchParams.get("at"), "needs/alpha/ex-0");
  assert.equal(url.searchParams.get("brief"), "30s");
  assert.equal(levelOf(location.path), "z2");
  assert.equal(parentPath(location.path), "needs/alpha");
  assert.equal(parentPath("needs/alpha/ex-0/hint/2"), "needs/alpha/ex-0");
});

test("the default position writes no stray URL parameters", () => {
  const url = buildUrl({ path: "", brief: "3m", page: 0 }, "https://x.test/?at=a&brief=30s&page=3");
  assert.equal(url.searchParams.has("at"), false);
  assert.equal(url.searchParams.has("brief"), false);
  assert.equal(url.searchParams.has("page"), false);
});

test("a record that is no longer due renders its absence, not a substitute", () => {
  const scene = buildScene(fixture(), { path: "needs/alpha/does-not-exist", now: NOW });
  assert.equal(scene.nodes[0].kind, "absent");
  assert.equal(scene.card, null);
});

// ---------------------------------------------------------------------------
// §13 ordering and fidelity
// ---------------------------------------------------------------------------

test("owner actions order high → medium → low, then oldest open first", () => {
  const ordered = orderOwnerActions([
    action("c", { severity: "low", opened: "2026-08-01T00:00:00+10:00" }),
    action("a", { severity: "high", opened: "2026-08-05T00:00:00+10:00" }),
    action("b", { severity: "high", opened: "2026-08-02T00:00:00+10:00" }),
  ]);
  assert.deepEqual(ordered.map((a) => a.id), ["b", "a", "c"]);
});

test("the authored title survives every level unchanged", () => {
  const exact = "ViBo: the AUD $31/mo Pro premise did NOT survive testing — merge PR #84";
  const data = fixture({ ownerActions: [action("ex-x", { title: exact, loop: "vibo/perf" })] });
  const z1 = buildScene(data, { path: "needs/vibo", now: NOW });
  const z2 = buildScene(data, { path: "needs/vibo/ex-x", now: NOW });
  assert.ok(z1.nodes.some((n) => n.label === exact));
  assert.equal(z2.card.action.title, exact);
  assert.equal(z2.card.action.proposed, "Do the authored thing.");
});

// ---------------------------------------------------------------------------
// Addendum: deferred_until
// ---------------------------------------------------------------------------

test("a future deferred_until removes an item from due-now without changing it", () => {
  const deferredItem = action("ex-d", { deferredUntil: "2026-08-22T09:00:00+10:00" });
  const data = fixture({ ownerActions: [action("ex-a"), deferredItem] });
  const { dueNow, deferred } = partitionActions(data.ownerActions, NOW);
  assert.deepEqual(dueNow.map((a) => a.id), ["ex-a"]);
  assert.deepEqual(deferred.map((a) => a.id), ["ex-d"]);
  // Identity and status are untouched — it is hidden, not mutated.
  assert.equal(deferred[0].id, "ex-d");
  const scene = buildScene(data, { now: NOW });
  assert.equal(scene.counts.dueNow, 1);
  assert.equal(scene.counts.deferred, 1);
});

test("advancing the clock past it makes the same exception reappear", () => {
  const item = action("ex-d", { deferredUntil: "2026-08-22T09:00:00+10:00" });
  assert.equal(isDueNow(item, NOW), false);
  assert.equal(isDueNow(item, Date.parse("2026-08-22T09:00:01+10:00")), true);
});

test("a malformed deferred_until FAILS OPEN into due-now", () => {
  // The one outcome this must never produce is a hidden owner decision.
  for (const bad of ["tomorrow", "", "not-a-date", "1787290200000"]) {
    assert.equal(isDueNow(action("x", { deferredUntil: bad }), NOW), true, `${JSON.stringify(bad)} should stay due-now`);
  }
});

test("deferred items are never graph nodes", () => {
  const data = fixture({
    ownerActions: [action("ex-d", { deferredUntil: "2026-08-30T09:00:00+10:00" })],
  });
  const entry = buildScene(data, { now: NOW });
  assert.equal(entry.counts.dueNow, 0);
  assert.ok(!entry.nodes.some((n) => n.label === "Needs you"), "no Needs you root when nothing is due");
  const needs = buildScene(data, { path: "needs", now: NOW });
  assert.ok(!needs.nodes.some((n) => n.kind === "bucket"));
  assert.equal(needs.deferredActions.length, 1, "still reachable through the deferred control");
});

test("defer presets resolve to absolute instants", () => {
  const base = new Date("2026-08-21T16:00:00+10:00");
  const hour = resolveDeferPreset("1 hour", base);
  assert.equal(hour.getTime() - base.getTime(), 3600 * 1000);
  const tomorrow = resolveDeferPreset("Tomorrow", base);
  assert.ok(tomorrow.getTime() > base.getTime());
  const tonight = resolveDeferPreset("Tonight", base);
  assert.ok(tonight.getTime() > base.getTime(), "Tonight must always be in the future");
});

// ---------------------------------------------------------------------------
// Labels + shipped sample
// ---------------------------------------------------------------------------

test("effort and age read in human units", () => {
  assert.equal(effortLabel(null), "effort unknown");
  assert.equal(effortLabel(30), "~30s");
  assert.equal(effortLabel(300), "~5 min");
  const now = Date.parse("2026-03-15T09:00:00+11:00");
  assert.equal(agoLabel("2026-03-15T08:30:00+11:00", now), "30 min ago");
  assert.equal(agoLabel("2026-03-14T09:00:00+11:00", now), "yesterday");
  assert.equal(agoLabel("garbage", now), "");
});

test("the shipped sample briefing still satisfies every budget", () => {
  const doc = JSON.parse(fs.readFileSync(new URL("../public/sample-data/continuity-briefing.json", import.meta.url), "utf8"));
  assert.equal(doc.version, 1);
  const entry = buildScene(doc, {});
  assert.ok(entry.nodes.length <= BUDGETS.entry);
  for (const n of entry.nodes) {
    const scene = buildScene(doc, { path: n.path });
    assert.ok(scene.nodes.length <= BUDGETS.z0, `${n.path} showed ${scene.nodes.length}`);
  }
});

// ---------------------------------------------------------------------------
// Temporal execution provenance (spec v2)
// ---------------------------------------------------------------------------

import { awayLabel, awaySummary, localHour, spansNight, temporalPhase, TEMPORAL_PHASES } from "../src/continuity/briefing.js";

const laneWith = (over = {}) => ({
  lane: "l", label: "L", total: 3, lastSeen: "2026-08-21T11:53:00+10:00",
  supervision: "attended", execution: "completed", records: [], runs: [], ...over,
});

test("supervision and execution are independent dimensions", () => {
  // The grammar must allow every combination; collapsing them into one axis is
  // what would turn "unattended" into a status colour.
  for (const supervision of ["attended", "unattended"]) {
    for (const execution of ["live", "completed", "planned"]) {
      const scene = buildScene({ lanes: [laneWith({ supervision, execution, records: [laneRecord("mr_1111111111111111", [{ headline: "x", type: "state" }])] })], ownerActions: [] }, { now: NOW });
      const root = scene.nodes.find((n) => n.kind === "root");
      assert.equal(root.supervision, supervision);
      assert.equal(root.execution, execution);
      // Supervision must never become the semantic status.
      assert.notEqual(root.status, supervision);
    }
  }
});

test("header clauses appear only when their count is non-zero", () => {
  const quiet = awaySummary({ lanes: [laneWith()], ownerActions: [] }, NOW);
  assert.deepEqual(quiet.clauses, [], "a quiet day should say nothing about unattended work");

  // Material changes are now return-window scoped, so the fixture needs a
  // departure marker and records that actually landed after it.
  const inWindow = [laneRecord("mr_9999999999999999", [{ headline: "changed", type: "progress" }])];
  const busy = awaySummary({
    ownerLastPresentAt: "2026-08-21T14:00:00+10:00",
    lanes: [
      laneWith({ supervision: "unattended", records: inWindow }),
      laneWith({ lane: "m", supervision: "unattended", execution: "live", records: inWindow }),
    ],
    ownerActions: [action("ex-1")],
  }, NOW);
  assert.match(busy.clauses.join(" · "), /2 material changes unattended/);
  assert.match(busy.clauses.join(" · "), /1 still running/);
  assert.match(busy.clauses.join(" · "), /1 need/);
});

test("return framing puts material unattended change above lane recency", () => {
  const data = {
    lanes: [
      // Newest, but attended and quiet.
      laneWith({ lane: "quiet", label: "Quiet", lastSeen: "2026-08-21T15:00:00+10:00", records: [laneRecord("mr_2222222222222222", [{ headline: "q", type: "state" }])] }),
      // Older, but changed state while nobody was watching.
      laneWith({ lane: "night", label: "Night", supervision: "unattended", lastSeen: "2026-08-21T06:00:00+10:00", records: [laneRecord("mr_3333333333333333", [{ headline: "n", type: "state" }])] }),
    ],
    ownerActions: [],
  };
  const scene = buildScene(data, { now: NOW });
  const labels = scene.nodes.filter((n) => n.kind === "root").map((n) => n.label);
  assert.equal(labels[0], "Night", `unattended change should lead, got ${labels.join(", ")}`);
});

test("one long run is one enclosure, however many events it holds", () => {
  const run = { id: "r", startedAt: "2026-08-21T03:58:00+10:00", endedAt: "2026-08-21T11:53:00+10:00", hours: 7.9, records: 97, supervision: "unattended", execution: "completed" };
  const scene = buildScene({
    lanes: [laneWith({ supervision: "unattended", runs: [run], records: [laneRecord("mr_4444444444444444", [{ headline: "x", type: "state" }])] })],
    ownerActions: [],
  }, { now: NOW });
  const root = scene.nodes.find((n) => n.kind === "root");
  // v2.3 ruling: the interval lives on the envelope and the position, so a
  // temporally grounded unattended root carries no subtitle at all.
  assert.equal(root.sub, null);
  assert.equal(root.quiet, true);
  assert.equal(root.run.hours, 7.9, "97 events must collapse to ONE run");
  assert.equal(root.run.records, 97);
});

test("overnight is derived context, never a supervision value", () => {
  assert.equal(spansNight({ startedAt: "2026-08-21T03:58:00+10:00", endedAt: "2026-08-21T11:53:00+10:00" }), true);
  assert.equal(spansNight({ startedAt: "2026-08-21T13:00:00+10:00", endedAt: "2026-08-21T13:30:00+10:00" }), false);
  // The vocabulary itself must not contain it.
  const scene = buildScene({ lanes: [laneWith({ supervision: "unattended" })], ownerActions: [] }, { now: NOW });
  for (const n of scene.nodes) assert.notEqual(n.supervision, "overnight");
});

test("the temporal phase is a fixed vocabulary derived from the clock alone", () => {
  // Explicit Sydney instants, not new Date(y,m,d,h) — that constructor is
  // runner-local and would make this suite disagree with itself across zones.
  const at = (h) => temporalPhase(new Date(`2026-08-21T${String(h).padStart(2, "0")}:00:00+10:00`));
  assert.equal(at(2), "night");
  assert.equal(at(5), "pre-dawn");
  assert.equal(at(7), "sunrise");
  assert.equal(at(10), "daytime");
  assert.equal(at(15), "afternoon");
  assert.equal(at(19), "evening");
  assert.equal(at(23), "night");
  for (let h = 0; h < 24; h++) assert.ok(TEMPORAL_PHASES.includes(at(h)), `hour ${h} produced an unknown phase`);
});

test("adding provenance did not raise any node budget", () => {
  const data = fixture();
  data.lanes = data.lanes.map((l) => ({ ...l, supervision: "unattended", execution: "live", runs: [] }));
  assert.ok(buildScene(data, { now: NOW }).nodes.length <= BUDGETS.entry);
  assert.ok(buildScene(data, { path: "needs", now: NOW }).nodes.length <= BUDGETS.z0);
  assert.ok(buildScene(data, { path: "lane/alpha", now: NOW }).nodes.length <= BUDGETS.z0);
});

test("temporal reasoning uses Sydney, not the runner's timezone", () => {
  // This is the bug CI caught and this machine hid: getHours() returns
  // runner-local hours, so a 13:00+10:00 run read as 03:00 in a UTC box and was
  // labelled overnight. Asserting against an explicit zone makes the result
  // identical everywhere the suite runs.
  const afternoon = { startedAt: "2026-08-21T13:00:00+10:00", endedAt: "2026-08-21T13:30:00+10:00" };
  const smallHours = { startedAt: "2026-08-21T03:58:00+10:00", endedAt: "2026-08-21T04:30:00+10:00" };
  assert.equal(spansNight(afternoon), false);
  assert.equal(spansNight(smallHours), true);
  // NEGATIVE CONTROL: read in UTC the same afternoon run IS in the small hours,
  // which is exactly what made the original bug look correct locally.
  assert.equal(spansNight(afternoon, "UTC"), true, "control: UTC really does see 03:00 here");

  // 11:00 rather than 12:00: noon sits exactly on the daytime/afternoon
  // boundary, so it is a poor probe for "which zone was consulted".
  const morning = new Date("2026-08-21T11:00:00+10:00");
  assert.equal(temporalPhase(morning), "daytime");
  assert.equal(temporalPhase(morning, "UTC"), "night", "control: the same instant is 01:00 UTC");
  assert.equal(Math.round(localHour(morning)), 11);
  assert.equal(Math.round(localHour(morning, "UTC")), 1);
});

// ---------------------------------------------------------------------------
// Spec v2.1 hard regression invariants
// ---------------------------------------------------------------------------

import { canonicalPath, envelopeGeometry, isReturnWindowChange, materialOutcome, returnWindowLanes, supervisionFromTrigger, temporalAnchor, timeScale } from "../src/continuity/briefing.js";

test("an auto-run-capable lane with an owner-triggered record is ATTENDED", () => {
  // Lane capability is not provenance. This is the case the v2 rule got wrong:
  // a 4am human ruling inside an autonomous lane must not read as machine work.
  assert.equal(supervisionFromTrigger({ kind: "owner" }), "attended");
  assert.equal(supervisionFromTrigger({ kind: "operator" }), "attended");
  assert.equal(supervisionFromTrigger({ kind: "scheduler" }), "unattended");
  assert.equal(supervisionFromTrigger({ kind: "automation" }), "unattended");
  // Unknown stays unknown — never displayed as either.
  for (const bad of [undefined, null, {}, { kind: "" }, { kind: "guess" }]) {
    assert.equal(supervisionFromTrigger(bad), "unknown");
  }
});

test("a completed run before departure is excluded from the return window", () => {
  const departed = "2026-08-21T15:00:00+10:00";
  const now = Date.parse("2026-08-21T15:06:00+10:00");
  assert.equal(isReturnWindowChange("2026-08-21T09:37:00+10:00", departed, now), false, "run A ended 09:37");
  assert.equal(isReturnWindowChange("2026-08-21T15:03:00+10:00", departed, now), true, "run B changed 15:03");
  // A six-minute absence must not promote an eight-hour-old run.
  const lanes = [
    laneWith({ lane: "old", supervision: "unattended", records: [{ id: "mr_a", emittedAt: "2026-08-21T09:37:00+10:00", items: [] }] }),
    laneWith({ lane: "new", supervision: "unattended", records: [{ id: "mr_b", emittedAt: "2026-08-21T15:03:00+10:00", items: [] }] }),
  ];
  assert.deepEqual(returnWindowLanes(lanes, departed, now).map((l) => l.lane), ["new"]);
});

test("with no known departure nothing is promoted as a return-window change", () => {
  const now = Date.parse("2026-08-21T15:06:00+10:00");
  assert.equal(isReturnWindowChange("2026-08-21T15:03:00+10:00", null, now), false);
  assert.equal(awaySummary({ lanes: [laneWith({ supervision: "unattended", records: [1] })], ownerActions: [] }, now).materialChanges, 0);
});

test("envelope geometry derives from started_at/ended_at on one shared scale", () => {
  const scale = timeScale({ from: "2026-08-21T02:00:00+10:00", to: "2026-08-21T10:00:00+10:00", width: 1000 });
  const twoHours = envelopeGeometry({ startedAt: "2026-08-21T03:00:00+10:00", endedAt: "2026-08-21T05:00:00+10:00", execution: "completed" }, scale);
  const fourHours = envelopeGeometry({ startedAt: "2026-08-21T03:00:00+10:00", endedAt: "2026-08-21T07:00:00+10:00", execution: "completed" }, scale);
  // Width IS duration: double the time, double the width.
  assert.ok(Math.abs(fourHours.width - twoHours.width * 2) < 2, `${twoHours.width} vs ${fourHours.width}`);
});

test("a live run intersects NOW; a completed run terminates before it", () => {
  const now = Date.parse("2026-08-21T10:00:00+10:00");
  const scale = timeScale({ from: "2026-08-21T02:00:00+10:00", to: "2026-08-21T10:00:00+10:00", width: 1000 });
  const nowX = scale.x(new Date(now));

  const live = envelopeGeometry({ startedAt: "2026-08-21T08:00:00+10:00", endedAt: null, execution: "live" }, scale, now);
  assert.equal(live.intersectsNow, true);
  assert.ok(Math.abs(live.x2 - nowX) < 1, "a live run must reach NOW");

  const done = envelopeGeometry({ startedAt: "2026-08-21T03:00:00+10:00", endedAt: "2026-08-21T05:00:00+10:00", execution: "completed" }, scale, now);
  assert.equal(done.intersectsNow, false);
  assert.ok(done.x2 < nowX - 10, "a completed run must terminate left of NOW");
});

test("away time is measured from departure, not from lane recency", () => {
  const now = Date.parse("2026-08-21T10:35:00+10:00");
  const lanes = [laneWith({ lastSeen: "2026-08-21T10:30:00+10:00" })];
  // The bug: a scene promoting overnight runs reported "away for 5 min".
  assert.equal(awayLabel(lanes, now, "2026-08-21T02:00:00+10:00"), "8h 35m");
  assert.equal(awayLabel(lanes, now), "5 min", "fallback when no departure is recorded");
});

test("a root prefers the authored outcome over the worker's name", () => {
  const lane = laneWith({
    label: "PersonalOS · Surface Runtime",
    records: [laneRecord("mr_5555555555555555", [{ headline: "Distribution path changed after the LAN hardening", type: "progress" }])],
  });
  assert.match(materialOutcome(lane), /Distribution path changed/);
  // A routine tick is not an outcome — fall back rather than dress it up.
  const ticking = laneWith({ records: [laneRecord("mr_6666666666666666", [{ headline: "tick: still generating", type: "state" }])] });
  assert.equal(materialOutcome(ticking), null);
});

// ---------------------------------------------------------------------------
// Spec v2.2 — the stage IS the field.
//
// v2.1 satisfied "time is spatial" with a strip above the graph, and the review
// named the failure exactly: a timeline dashboard rather than one semantic
// space. These lock the properties a strip cannot have.

test("v2.2: a live lane zooms through to now, not to its last record", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const data = {
    generatedAt: new Date(now).toISOString(),
    lanes: [{
      lane: "live-lane", label: "Live lane", supervision: "unattended", execution: "live",
      lastSeen: "2026-08-21T18:03:00+10:00",
      records: [{ id: "r1", lane: "live-lane", headline: "still open", emittedAt: "2026-08-21T18:03:00+10:00", trigger: { kind: "scheduler" } }],
      runs: [{ id: "run_live", startedAt: "2026-08-21T15:26:00+10:00", endedAt: "2026-08-21T18:03:00+10:00", execution: "live", hours: 2.6 }],
    }],
    ownerActions: [],
  };
  const scene = buildScene(data, { path: "lane/live-lane", now });
  assert.ok(scene.timeline, "a zoomed lane keeps its temporal window");
  assert.equal(Date.parse(scene.timeline.to), now,
    "an open run must be drawn through NOW; ending the window at the last record put NOW off-scale");

  // Negative control: a COMPLETED lane must NOT be stretched to now, or every
  // finished run would falsely appear to reach the present.
  const done = JSON.parse(JSON.stringify(data));
  done.lanes[0].execution = "completed";
  done.lanes[0].runs[0].execution = "completed";
  const doneScene = buildScene(done, { path: "lane/live-lane", now });
  assert.ok(Date.parse(doneScene.timeline.to) < now,
    "a completed lane's window must terminate before now");
});

test("v2.2: envelope geometry separates live from completed without a badge", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const scale = timeScale({ from: "2026-08-21T10:00:00+10:00", to: "2026-08-21T18:40:00+10:00", width: 1110 });
  const nowX = scale.x(new Date(now));

  const live = envelopeGeometry(
    { id: "a", startedAt: "2026-08-21T15:26:00+10:00", endedAt: "2026-08-21T18:03:00+10:00", execution: "live" },
    scale, now,
  );
  const completed = envelopeGeometry(
    { id: "b", startedAt: "2026-08-21T10:05:00+10:00", endedAt: "2026-08-21T13:37:00+10:00", execution: "completed" },
    scale, now,
  );
  assert.equal(live.x2, nowX, "a live envelope terminates exactly at the NOW cursor");
  assert.ok(completed.x2 < nowX, "a completed envelope terminates to the LEFT of NOW");
  assert.equal(live.intersectsNow, true);
  assert.equal(completed.intersectsNow, false);
});

test("v2.2: unknown provenance is never assigned a temporal position", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const data = {
    generatedAt: new Date(now).toISOString(),
    lanes: [
      { lane: "sched", label: "Scheduled", supervision: "unattended", execution: "completed",
        lastSeen: "2026-08-21T12:00:00+10:00",
        records: [{ id: "s1", lane: "sched", headline: "ran", emittedAt: "2026-08-21T12:00:00+10:00", trigger: { kind: "scheduler" } }],
        runs: [{ id: "run_s", startedAt: "2026-08-21T11:00:00+10:00", endedAt: "2026-08-21T12:00:00+10:00", execution: "completed", hours: 1 }] },
      { lane: "mystery", label: "Mystery", supervision: "unknown", execution: "completed",
        lastSeen: "2026-08-21T13:00:00+10:00",
        records: [{ id: "m1", lane: "mystery", headline: "who ran this", emittedAt: "2026-08-21T13:00:00+10:00" }],
        runs: [] },
    ],
    ownerActions: [],
  };
  const scene = buildScene(data, { path: "", now });
  const mystery = scene.nodes.find((n) => n.key === "mystery");
  const sched = scene.nodes.find((n) => n.key === "sched");
  assert.equal(mystery.supervision, "unknown");
  assert.equal(mystery.run ?? null, null,
    "an unknown-provenance lane carries no run, so the view has no honest x for it");
  assert.ok(sched.run, "a scheduler-triggered lane keeps the run that positions it");
});

test("v2.2: node budgets are unchanged by the temporal rework", () => {
  assert.equal(BUDGETS.entry, 4);
  assert.equal(BUDGETS.z0, 4);
  assert.equal(BUDGETS.z1, 5);
  assert.equal(BUDGETS.z2, 3);
  assert.equal(BUDGETS.z3, 4);
  assert.equal(BUDGETS.z4, 2);
});

// ---------------------------------------------------------------------------
// Spec v2.3.

test("v2.3: a live run anchors its node at NOW, a completed one at its end", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const live = { id: "a", startedAt: "2026-08-21T15:26:00+10:00", endedAt: "2026-08-21T18:03:00+10:00", execution: "live" };
  const done = { id: "b", startedAt: "2026-08-21T04:05:00+10:00", endedAt: "2026-08-21T09:37:00+10:00", execution: "completed" };
  assert.equal(Date.parse(temporalAnchor({ run: live }, now)), now,
    "an open run reaches the present, so its node must sit ON the cursor");
  assert.equal(temporalAnchor({ run: done }, now), done.endedAt);
  // Negative control: no run and no trustworthy provenance means no position.
  assert.equal(temporalAnchor({ supervision: "unknown", at: "2026-08-21T12:00:00+10:00" }, now), null);
  assert.equal(temporalAnchor({ supervision: "unattended", at: "2026-08-21T12:00:00+10:00" }, now), "2026-08-21T12:00:00+10:00");
});

test("v2.3: an invalid semantic path walks up to its nearest valid ancestor", () => {
  const now = Date.parse("2026-08-21T18:40:00+10:00");
  const data = {
    lanes: [{
      lane: "alpha", label: "Alpha", supervision: "unattended", execution: "completed",
      lastSeen: "2026-08-21T12:00:00+10:00",
      records: [{ id: "mr_1111111111111111", lane: "alpha", headline: "a real outcome here", emittedAt: "2026-08-21T12:00:00+10:00", trigger: { kind: "scheduler" }, items: [{ type: "state", headline: "a real outcome here" }] }],
      runs: [],
    }],
    ownerActions: [],
  };
  assert.equal(canonicalPath(data, "lane/alpha/z0"), "lane/alpha", "an unknown facet resolves to its lane");
  assert.equal(canonicalPath(data, "lane/nope"), "", "an unknown lane resolves to catch-up entry");
  assert.equal(canonicalPath(data, "lane/alpha"), "lane/alpha", "a valid path is left alone");

  // And the scene reports the correction rather than rendering the token.
  const scene = buildScene(data, { path: "lane/alpha/z0", now });
  assert.equal(scene.redirect, "lane/alpha");
  for (const n of scene.nodes) {
    assert.notEqual(n.label, "z0", "a raw path segment must never become a node label");
  }
});

test("v2.3: an authored decision outranks a state transition as the return root", () => {
  const lane = {
    lane: "l", label: "L", supervision: "unattended",
    records: [{
      id: "mr_2222222222222222", lane: "l", emittedAt: "2026-08-21T09:00:00+10:00",
      items: [
        { type: "state", headline: "the deploy pipeline went green again" },
        { type: "decision", headline: "chose the loopback broker over the LAN one" },
      ],
    }],
  };
  assert.equal(materialOutcome(lane), "chose the loopback broker over the LAN one");
  // Negative control: with no decision present, state still wins.
  const noDecision = { ...lane, records: [{ ...lane.records[0], items: [lane.records[0].items[0]] }] };
  assert.equal(materialOutcome(noDecision), "the deploy pipeline went green again");
});
