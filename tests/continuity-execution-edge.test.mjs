import test from "node:test";
import assert from "node:assert/strict";

import { makeExecutionRecord, summarizeExecutionWindow } from "../scripts/lib/continuity-execution.mjs";

test("stable execution ids are deterministic for the same continuation", () => {
  const input = {
    time: "2026-08-18T02:15:00Z",
    worker: "executor-a",
    project: "datascape",
    sequence: 4,
    result: "success",
    artifactProgress: true,
    latency: "normal",
  };

  assert.equal(makeExecutionRecord(input).id, makeExecutionRecord(input).id);
});

test("a successful run is not counted as a service failure even when attribution is unknown", () => {
  const record = makeExecutionRecord({
    time: "2026-08-18T02:15:00Z",
    worker: "executor-a",
    project: "datascape",
    sequence: 4,
    result: "success",
    serviceAtFailure: "unknown",
    artifactProgress: true,
    latency: "normal",
  });

  assert.deepEqual(summarizeExecutionWindow([record]).serviceFailures, {});
});

test("blocked non-human service failures are not misclassified as human blockers", () => {
  const record = makeExecutionRecord({
    time: "2026-08-18T02:45:00Z",
    worker: "executor-b",
    project: "portfolio",
    sequence: 4,
    result: "blocked",
    serviceAtFailure: "github",
    latency: "normal",
  });

  const summary = summarizeExecutionWindow([record]);
  assert.equal(summary.humanBlockers, 0);
  assert.deepEqual(summary.serviceFailures, { github: 1 });
});

test("empty execution windows summarize to zero without invented evidence", () => {
  assert.deepEqual(summarizeExecutionWindow([]), {
    runsAttempted: 0,
    runsSuccessful: 0,
    timeouts: 0,
    explicitLimits: 0,
    usefulProgressRuns: 0,
    humanBlockers: 0,
    serviceFailures: {},
  });
});
