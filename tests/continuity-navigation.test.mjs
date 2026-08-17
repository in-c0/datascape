import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContinuityUrl,
  readContinuityLocation,
} from "../src/continuity/navigation.js";

const data = {
  snapshots: [
    { id: "past", dominant: "Readiness" },
    { id: "now", dominant: "Distribution" },
  ],
};

test("Continuity location defaults to the latest dominant semantic position", () => {
  const state = readContinuityLocation(data, "https://example.test/?view=continuity");
  assert.deepEqual(state, {
    timeIndex: 1,
    selected: "Distribution",
    resolution: 0.5,
  });
});

test("Continuity location restores concept, historical snapshot, and resolution", () => {
  const state = readContinuityLocation(
    data,
    "https://example.test/?view=continuity&concept=Retention%20signal&t=past&r=0.75",
  );
  assert.deepEqual(state, {
    timeIndex: 0,
    selected: "Retention signal",
    resolution: 0.75,
  });
});

test("unknown snapshot falls back to latest while preserving requested concept", () => {
  const state = readContinuityLocation(
    data,
    "https://example.test/?view=continuity&concept=Future%20concept&t=missing&r=9",
  );
  assert.equal(state.timeIndex, 1);
  assert.equal(state.selected, "Future concept");
  assert.equal(state.resolution, 1);
});

test("Continuity URL serializes stable snapshot identity rather than an array index", () => {
  const url = buildContinuityUrl(
    data,
    { timeIndex: 0, selected: "Readiness", resolution: 0.333 },
    "https://example.test/?view=landscape#x",
  );
  assert.equal(url.searchParams.get("view"), "continuity");
  assert.equal(url.searchParams.get("concept"), "Readiness");
  assert.equal(url.searchParams.get("t"), "past");
  assert.equal(url.searchParams.get("r"), "0.33");
  assert.equal(url.hash, "#x");
});
