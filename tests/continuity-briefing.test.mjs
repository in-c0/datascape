import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  agoLabel,
  buildBriefingUrl,
  buildBriefingViewport,
  effortLabel,
  readBriefingLocation,
} from "../src/continuity/briefing.js";

const data = {
  latestPerLane: 2,
  generatedAtLocal: "2026-03-15T09:05:00+11:00",
  lanes: [
    {
      lane: "atlas",
      label: "Atlas",
      total: 34,
      lastSeen: "2026-03-15T08:52:00+11:00",
      records: [
        { id: "mr_aaaaaaaaaaaaaaaa", emittedAt: "2026-03-15T08:52:00+11:00", items: [{ headline: "A", type: "progress" }] },
        { id: "mr_bbbbbbbbbbbbbbbb", emittedAt: "2026-03-15T07:40:00+11:00", items: [{ headline: "B", type: "state" }] },
        { id: "mr_cccccccccccccccc", emittedAt: "2026-03-15T06:00:00+11:00", items: [{ headline: "C", type: "state" }] },
      ],
    },
  ],
  ownerActions: [
    { id: "x-1", title: "Decide", severity: "high", steps: [{ n: 1, kind: "run", text: "go", command: "node x.mjs", seconds: 30 }] },
  ],
};

test("the briefing shows only the latest N must-reads per lane", () => {
  const viewport = buildBriefingViewport(data, { latest: 2 });
  assert.equal(viewport.lanes[0].records.length, 2);
  assert.equal(viewport.lanes[0].records[0].id, "mr_aaaaaaaaaaaaaaaa");
  assert.equal(viewport.perLane, 2);
});

test("hiddenCount is recomputed against the slice actually shown", () => {
  // The builder's own hiddenCount was computed for its slice. If the viewport
  // re-slices to 1, a stale 32 would be a lie by one record.
  const one = buildBriefingViewport(data, { latest: 1 });
  assert.equal(one.lanes[0].records.length, 1);
  assert.equal(one.lanes[0].hiddenCount, 33);

  const three = buildBriefingViewport(data, { latest: 3 });
  assert.equal(three.lanes[0].hiddenCount, 31);
});

test("latest falls back to the document default, then to 2", () => {
  assert.equal(buildBriefingViewport(data, {}).perLane, 2);
  assert.equal(buildBriefingViewport({ lanes: [], ownerActions: [] }, {}).perLane, 2);
  // A nonsense value must not produce a zero-record surface.
  assert.equal(buildBriefingViewport(data, { latest: 0 }).perLane, 2);
  assert.equal(buildBriefingViewport(data, { latest: "x" }).perLane, 2);
});

test("every node carries a stable id and items carry a status", () => {
  const viewport = buildBriefingViewport(data, { latest: 1 });
  const record = viewport.lanes[0].records[0];
  assert.equal(record.nodeId, "mr:atlas:mr_aaaaaaaaaaaaaaaa");
  assert.equal(record.items[0].nodeId, "item:mr_aaaaaaaaaaaaaaaa:0");
  assert.equal(record.items[0].status, "merged");
  assert.equal(viewport.ownerActions[0].nodeId, "oa:x-1");
});

test("an owner action with an owner_action item maps to needs_human", () => {
  const viewport = buildBriefingViewport({
    lanes: [{ lane: "l", label: "L", total: 1, records: [{ id: "mr_dddddddddddddddd", emittedAt: "2026-03-15T08:00:00+11:00", items: [{ headline: "H", type: "owner_action" }] }] }],
    ownerActions: [],
  }, {});
  assert.equal(viewport.lanes[0].records[0].items[0].status, "needs_human");
});

test("an unknown step kind degrades to a decision rather than disappearing", () => {
  const viewport = buildBriefingViewport({
    lanes: [],
    ownerActions: [{ id: "y", title: "T", severity: "low", steps: [{ n: 1, kind: "teleport", text: "?" }] }],
  }, {});
  assert.equal(viewport.ownerActions[0].steps[0].kind, "decide");
});

test("expansion state round-trips through the URL", () => {
  const location = readBriefingLocation("https://example.test/?view=briefing&open=oa:x-1,item:mr_a:0&n=3&lane=atlas");
  assert.deepEqual([...location.expanded], ["oa:x-1", "item:mr_a:0"]);
  assert.equal(location.latest, 3);
  assert.equal(location.laneFilter, "atlas");

  const url = buildBriefingUrl(location, "https://example.test/");
  assert.equal(url.searchParams.get("view"), "briefing");
  assert.equal(url.searchParams.get("open"), "oa:x-1,item:mr_a:0");
  assert.equal(url.searchParams.get("n"), "3");
  assert.equal(url.searchParams.get("lane"), "atlas");
});

test("an empty expansion set clears the parameter instead of writing open=", () => {
  const url = buildBriefingUrl({ expanded: new Set(), latest: null, laneFilter: null }, "https://example.test/?open=a&n=2&lane=b");
  assert.equal(url.searchParams.has("open"), false);
  assert.equal(url.searchParams.has("n"), false);
  assert.equal(url.searchParams.has("lane"), false);
});

test("effort and age read in human units", () => {
  assert.equal(effortLabel(null), "effort unknown");
  assert.equal(effortLabel(30), "~30s");
  assert.equal(effortLabel(60), "~1 min");
  assert.equal(effortLabel(300), "~5 min");

  const now = Date.parse("2026-03-15T09:00:00+11:00");
  assert.equal(agoLabel("2026-03-15T08:59:30+11:00", now), "just now");
  assert.equal(agoLabel("2026-03-15T08:30:00+11:00", now), "30 min ago");
  assert.equal(agoLabel("2026-03-15T05:00:00+11:00", now), "4h ago");
  assert.equal(agoLabel("2026-03-14T09:00:00+11:00", now), "yesterday");
  assert.equal(agoLabel("garbage", now), "");
});

test("the shipped sample briefing satisfies the documented contract", () => {
  // The sample is what a new deployment renders before it has any data of its
  // own; shipping one that fails our own validator has happened before.
  const doc = JSON.parse(fs.readFileSync(new URL("../public/sample-data/continuity-briefing.json", import.meta.url), "utf8"));
  assert.equal(doc.version, 1);
  const viewport = buildBriefingViewport(doc, {});
  assert.ok(viewport.lanes.length > 0);
  for (const lane of viewport.lanes) {
    assert.ok(lane.records.length <= viewport.perLane);
    for (const record of lane.records) {
      // A reconstructed record must always be able to say where it came from.
      if (record.provenance === "backfilled-from-log") assert.ok(record.sourceRef);
    }
  }
  for (const action of viewport.ownerActions) {
    for (const step of action.steps) {
      if (step.kind === "run") assert.ok(step.command, `run step ${step.n} of ${action.id} has no command`);
      if (step.kind === "open") assert.ok(step.href, `open step ${step.n} of ${action.id} has no href`);
    }
  }
});
