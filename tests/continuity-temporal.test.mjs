import test from "node:test";
import assert from "node:assert/strict";

import {
  executionLabel,
  supervisionLabel,
  temporalGradient,
  temporalPercent,
  temporalWindowStyle,
  temporalX,
} from "../src/continuity/temporal.js";

const field = {
  windowStart: "2026-08-17T23:00:00+10:00",
  windowEnd: "2026-08-18T19:00:00+10:00",
  now: "2026-08-18T09:00:00+10:00",
  sunrise: "2026-08-18T06:30:00+10:00",
  sunset: "2026-08-18T17:30:00+10:00",
  timezone: "Australia/Sydney",
};

test("temporalPercent maps the local run window monotonically and clamps outside it", () => {
  assert.equal(temporalPercent(field.windowStart, field), 0);
  assert.equal(temporalPercent(field.windowEnd, field), 100);
  assert.equal(temporalPercent("2026-08-17T22:00:00+10:00", field), 0);
  assert.equal(temporalPercent("2026-08-18T21:00:00+10:00", field), 100);
  assert.ok(temporalPercent(field.sunrise, field) < temporalPercent(field.now, field));
});

test("temporalX projects time into graph coordinates without changing semantic y", () => {
  assert.equal(temporalX(field.windowStart, field, 100, 1100), 100);
  assert.equal(temporalX(field.windowEnd, field, 100, 1100), 1100);
  const nowX = temporalX(field.now, field, 100, 1100);
  assert.ok(nowX > 100 && nowX < 1100);
});

test("autonomy windows remain separate from execution state", () => {
  const style = temporalWindowStyle({
    start: "2026-08-17T23:10:00+10:00",
    end: "2026-08-18T07:05:00+10:00",
    mode: "unattended",
  }, field);
  assert.ok(style.left.endsWith("%"));
  assert.ok(style.width.endsWith("%"));
  assert.equal(executionLabel({ executionState: "completed" }), "Already run");
  assert.equal(supervisionLabel({ supervision: "unattended", scheduled: true }), "Scheduled · unattended");
});

test("temporal atmosphere is optional and only generated from valid phase timing", () => {
  assert.equal(temporalGradient(null), null);
  assert.equal(temporalGradient({ windowStart: "bad", windowEnd: "bad" }), null);
  assert.match(temporalGradient(field), /^linear-gradient\(90deg,/);
});
