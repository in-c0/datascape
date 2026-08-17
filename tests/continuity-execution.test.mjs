import test from "node:test";
import assert from "node:assert/strict";

import { makeExecutionRecord, summarizeExecutionWindow } from "../scripts/lib/continuity-execution.mjs";

test("execution records preserve the stable Continuity minimum telemetry", () => {
  const record = makeExecutionRecord({
    time: "2026-08-18T01:15:00Z",
    worker: "executor-a",
    project: "datascape",
    sequence: 3,
    result: "success",
    serviceAtFailure: "unknown",
    artifactProgress: true,
    latency: "normal",
    artifactRef: "commit:abc123",
  });

  assert.equal(record.time, "2026-08-18T01:15:00.000Z");
  assert.equal(record.worker, "executor-a");
  assert.equal(record.project, "datascape");
  assert.equal(record.sequence, 3);
  assert.equal(record.artifactProgress, true);
});

test("window summary distinguishes congestion from useful progress", () => {
  const records = [
    makeExecutionRecord({ time: "2026-08-18T01:15:00Z", worker: "a", project: "datascape", sequence: 1, result: "success", artifactProgress: true, latency: "normal" }),
    makeExecutionRecord({ time: "2026-08-18T01:45:00Z", worker: "b", project: "vibo", sequence: 1, result: "timeout", serviceAtFailure: "unknown", latency: "very-slow" }),
    makeExecutionRecord({ time: "2026-08-18T02:15:00Z", worker: "a", project: "datascape", sequence: 2, result: "explicit-limit", serviceAtFailure: "github", latency: "slow" }),
  ];

  assert.deepEqual(summarizeExecutionWindow(records), {
    runsAttempted: 3,
    runsSuccessful: 1,
    timeouts: 1,
    explicitLimits: 1,
    usefulProgressRuns: 1,
    humanBlockers: 0,
    serviceFailures: { unknown: 1, github: 1 },
  });
});

test("invalid service attribution is rejected rather than guessed", () => {
  assert.throws(() => makeExecutionRecord({
    time: "2026-08-18T01:15:00Z",
    worker: "a",
    project: "datascape",
    sequence: 1,
    result: "timeout",
    serviceAtFailure: "chatgpt-or-github",
  }), /unsupported execution service/);
});
