// The deterministic V6 fixture — spec V6 §15.
//
// Orchestration is NOT tested against production sessions first. The whole
// point of a control plane is what it does when things go wrong, and the only
// way to exercise "the executor dies mid-run" repeatably is to build a world
// where it dies on cue. No real model calls, no network, no clock.
//
// Eight intents, chosen so that every hard invariant has something to fail on.

import { createIntent } from "./intent.js";

export const EXECUTORS = [
  { executor_id: "E1", kind: "claude-like", capabilities: ["repo", "browser", "tests"] },
  { executor_id: "E2", kind: "chatgpt-like", capabilities: ["repo", "reasoning"] },
  { executor_id: "E3", kind: "generic-local", capabilities: ["repo", "tests"] },
];

export function fixtureIntents() {
  return [
    createIntent({
      intent_id: "I1", semantic_centre: "Research validation", goal: "Land the validation harness",
      success_condition: "harness green on master", created_at: "2026-08-21T09:00:00+10:00",
      current_operation: "run_tests", unblocks: ["I5"],
    }),
    createIntent({
      intent_id: "I2", semantic_centre: "Distribution", goal: "Keep the live briefing surface correct",
      success_condition: "briefing renders real data", created_at: "2026-08-21T09:05:00+10:00",
      materially_live: true, current_operation: "inspect_repository",
    }),
    createIntent({
      intent_id: "I3", semantic_centre: "Distribution", goal: "Publish the launch post",
      success_condition: "post is live", created_at: "2026-08-21T09:10:00+10:00",
      state: "blocked_on_owner", owner_gate_ids: ["gate-post-approval"], current_operation: "approve_external_post",
    }),
    createIntent({
      intent_id: "I4", semantic_centre: "Research validation", goal: "Ingest the upstream corpus",
      success_condition: "corpus ingested", created_at: "2026-08-21T09:15:00+10:00",
      state: "blocked_external",
      open_dependencies: [{ type: "external_artifact_exists", ref: "corpus-2026-08.json" }],
    }),
    createIntent({
      intent_id: "I5", semantic_centre: "Research validation", goal: "Report on validation results",
      success_condition: "report written", created_at: "2026-08-21T09:20:00+10:00",
      state: "waiting",
      open_dependencies: [{ type: "upstream_intent_completed", ref: "I1" }],
    }),
    createIntent({
      intent_id: "I6", semantic_centre: "Infrastructure", goal: "Verify the deployed bundle",
      success_condition: "bundle verified against head", created_at: "2026-08-21T09:25:00+10:00",
      current_operation: "run_tests", requires_capability: "tests",
    }),
    createIntent({
      intent_id: "I7", semantic_centre: "Infrastructure", goal: "Open the substrate PR",
      success_condition: "PR exists exactly once", created_at: "2026-08-21T09:30:00+10:00",
      current_operation: "open_internal_pr",
    }),
    createIntent({
      intent_id: "I8", semantic_centre: "Research validation", goal: "Retire the legacy ingestion path",
      success_condition: "legacy path diagnostic-only", created_at: "2026-08-20T09:00:00+10:00",
      state: "completed",
    }),
  ];
}

/**
 * A deterministic clock.
 *
 * Time only moves when the harness says so. An orchestration test that depends
 * on real elapsed time is a test that passes on a fast machine and fails in CI,
 * which is the same as no test at all.
 */
export function createClock(startMs = Date.parse("2026-08-21T09:00:00+10:00")) {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; return current; } };
}
