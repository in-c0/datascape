// The deterministic V6 acceptance run — spec V6 §15, §19.
//
// One scripted world exercising every hard invariant at once, because the
// invariants interact: a lease that expires correctly is worthless if the
// recovery it enables then duplicates a side effect, and an owner gate that
// holds against a direct machine ruling is worthless if the scheduler can route
// around it. Testing them only in isolation would miss exactly that.
//
// No real model calls, no network, no wall clock. Every count below is produced
// by an attempt that was actually made, not by an assertion that none was.

import { transition } from "./intent.js";
import { interpretCtn, mayPerform } from "./authority.js";
import { createLeaseManager } from "./lease.js";
import { createCheckpoint, reconstructable, validateCheckpoint } from "./checkpoint.js";
import { createDependency, createDependencyGraph } from "./dependency.js";
import { createBudgetLedger, schedule } from "./scheduler.js";
import { createOperationLedger } from "./idempotency.js";
import { bridge } from "./bridge.js";
import { EXECUTORS, createClock, fixtureIntents } from "./fixture.js";

export function runAcceptance() {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const graph = createDependencyGraph();
  const operations = createOperationLedger();
  const budget = createBudgetLedger({ max_wall_time_ms: 600000, max_steps: 40, max_external_requests: 10, max_cost: 0 });

  const intents = new Map(fixtureIntents().map((i) => [i.intent_id, i]));
  const mutations = [];
  const violations = [];
  const counters = {
    simultaneous_lease_violations: 0,
    owner_gate_bypasses: 0,
    recovered_expired_leases: 0,
    duplicate_side_effects: 0,
    dependency_wakeups: 0,
    budget_overruns: 0,
    unresolved_checkpoint_refs: 0,
  };
  const settledEvents = new Set(["ev-i1-goal"]);

  graph.register("I5", [createDependency({ type: "upstream_intent_completed", ref: "I1" })]);
  graph.register("I3", [createDependency({ type: "owner_gate_resolved", ref: "gate-post-approval" })]);

  const set = (intent) => intents.set(intent.intent_id, intent);
  const move = (id, next, options) => {
    const result = transition(intents.get(id), next, options);
    if (result.ok) set(result.intent);
    return result;
  };

  // --- 1. E1 claims I1; E2 cannot claim it simultaneously ---------------------
  const claimed = leases.claim("I1", "E1");
  if (!claimed.ok) violations.push("E1 could not claim I1");
  move("I1", "claimed", { at: "2026-08-21T09:31:00+10:00" });

  const contended = leases.claim("I1", "E2");
  if (contended.ok) {
    counters.simultaneous_lease_violations += 1;
    violations.push("two executors held I1 at once");
  }
  // E2 may still observe it; only mutation is denied.
  if (leases.mayMutate("I1", "E2").allowed) {
    counters.simultaneous_lease_violations += 1;
    violations.push("a non-holder was permitted to mutate working state");
  }

  // --- 2. I3 cannot run despite a machine ctn --------------------------------
  const machineCtn = interpretCtn({ source: "agent", gate_id: "gate-post-approval", ruling: "approved" });
  const bypass = move("I3", "ready", {
    ruling: machineCtn.resolves_gate ? { source: "agent", gate_id: "gate-post-approval", ruling: "approved" } : null,
  });
  if (bypass.ok) {
    counters.owner_gate_bypasses += 1;
    violations.push("a machine continuation released an owner gate");
  }
  // A generic owner ctn must fail too.
  if (move("I3", "ready", { ruling: { source: "owner", ruling: "ctn" } }).ok) {
    counters.owner_gate_bypasses += 1;
    violations.push("a generic owner continuation released a specific owner gate");
  }
  // And the operation itself stays refused.
  if (mayPerform("approve_external_post").allowed) {
    counters.owner_gate_bypasses += 1;
    violations.push("an owner_required operation ran without a matching ruling");
  }
  mutations.push({
    type: "blocked_on_owner", intent_id: "I3", at: "2026-08-21T09:32:00+10:00",
    owner_gate_id: "gate-post-approval", text: "Publishing the launch post needs an owner ruling.",
  });

  // --- 3. I1 completes, which wakes I5 ---------------------------------------
  const step = budget.consume({ steps: 1, wall_time_ms: 1000 });
  if (!step.ok) counters.budget_overruns += 1;
  move("I1", "running", { at: "2026-08-21T09:33:00+10:00" });
  move("I1", "completed", { at: "2026-08-21T09:35:00+10:00" });
  leases.release(claimed.lease.lease_id);
  mutations.push({
    type: "goal_completed", intent_id: "I1", at: "2026-08-21T09:35:00+10:00",
    text: "The validation harness is green on master.",
  });

  const woken = graph.satisfy("upstream_intent_completed", "I1");
  counters.dependency_wakeups += woken.length;
  for (const id of woken) move(id, "ready", { at: "2026-08-21T09:35:30+10:00" });
  // A repeat notification must not wake it again.
  if (graph.satisfy("upstream_intent_completed", "I1").length > 0) {
    violations.push("a dependency woke its dependent more than once");
  }

  // --- 4. E1 claims I6, disappears, E3 resumes from the checkpoint ------------
  const shortLease = leases.claim("I6", "E1", { ttlMs: 60000 });
  move("I6", "claimed", { at: "2026-08-21T09:36:00+10:00" });
  move("I6", "running", { at: "2026-08-21T09:36:30+10:00" });

  const checkpoint = createCheckpoint({
    intent_id: "I6", lease_id: shortLease.lease.lease_id, semantic_centre: "Infrastructure",
    current_operation: "run_tests", last_settled_event_ids: ["ev-i1-goal"],
    working_state_ref: "wt-i6", produced_event_ids: [], unresolved_questions: [],
    dependency_refs: [], owner_gate_ids: [],
    next_safe_action: "rerun the browser verification against head 4ab9c1",
  });
  if (!validateCheckpoint(checkpoint).ok) violations.push("the I6 checkpoint failed its contract");

  // E1 vanishes. No release, no failure event: a disappearance is not a
  // semantic fact about the work.
  clock.advance(61000);
  const expired = leases.expired();
  mutations.push({ type: "lease_expired", intent_id: "I6", at: "2026-08-21T09:38:00+10:00", text: "attempt ended" });

  const resumed = leases.claim("I6", "E3");
  if (resumed.ok && resumed.recovered) counters.recovered_expired_leases += expired.length;
  else violations.push("an expired lease did not permit recovery");

  const reconstruction = reconstructable(checkpoint, intents.get("I6"), (ref) => settledEvents.has(ref));
  counters.unresolved_checkpoint_refs += reconstruction.unresolved_refs.length;
  if (!reconstruction.ok) violations.push("E3 could not reconstruct I6 from the checkpoint alone");
  // The transition back to ready is recovery, and the state machine allows it
  // without any owner involvement, because no owner gate is in play.
  move("I6", "ready", { at: "2026-08-21T09:38:30+10:00" });

  // --- 5. I7 resumes after a simulated crash; the side effect happens once ----
  const opId = "I7:open_internal_pr";
  let prsCreated = 0;
  const first = operations.begin(opId, { executor_id: "E1", kind: "pr_creation", at: "2026-08-21T09:39:00+10:00" });
  if (first.proceed) prsCreated += 1; // the PR is created, then E1 crashes before acknowledging

  const second = operations.begin(opId, { executor_id: "E3", kind: "pr_creation", at: "2026-08-21T09:40:00+10:00" });
  if (second.proceed) {
    prsCreated += 1;
    counters.duplicate_side_effects += 1;
    violations.push("a recovered executor repeated an unacknowledged side effect");
  }
  operations.reconcile(opId, () => ({ result_ref: "pr-25" }));
  if (prsCreated !== 1) {
    counters.duplicate_side_effects += 1;
    violations.push(`the PR side effect ran ${prsCreated} times`);
  }
  mutations.push({
    type: "operation_completed", intent_id: "I7", operation_id: opId, at: "2026-08-21T09:40:30+10:00",
    text: "The substrate pull request was opened.",
  });
  // Reported a second time by the recovering executor: it must not double-count.
  mutations.push({
    type: "operation_completed", intent_id: "I7", operation_id: opId, at: "2026-08-21T09:41:00+10:00",
    text: "The substrate pull request was opened.",
  });

  // --- 6. Heartbeats and scheduling, which must add no history ---------------
  const beat = leases.heartbeat(resumed.lease.lease_id);
  if (beat.emits_history) violations.push("a heartbeat created semantic history");
  mutations.push({ type: "lease_heartbeat", intent_id: "I6", at: "2026-08-21T09:41:30+10:00", text: "alive" });
  mutations.push({ type: "scheduled", intent_id: "I2", at: "2026-08-21T09:41:40+10:00", text: "selected" });

  const plan = schedule([...intents.values()], { executors: EXECUTORS });
  if (plan.considered.some((c) => c.intent_id === "I3")) {
    counters.owner_gate_bypasses += 1;
    violations.push("the scheduler considered owner-gated work");
  }

  // A paid operation against a zero-cost budget must block rather than run.
  const paid = budget.consume({ cost: 1 });
  if (paid.ok) {
    counters.budget_overruns += 1;
    violations.push("a paid operation ran against a zero-cost budget");
  }

  const { events, ephemeral } = bridge(mutations);
  const heartbeatEvents = events.filter((e) => /heartbeat|scheduled|lease_/.test(e.native_id || "")).length;
  if (heartbeatEvents > 0) violations.push("working state reached semantic history");

  return {
    fixture_intents: intents.size,
    executors: EXECUTORS.length,
    ...counters,
    immutable_events_emitted: events.length,
    heartbeat_created_events: heartbeatEvents,
    ephemeral_mutations: ephemeral.length,
    all_invariants_passed: violations.length === 0,
    violations,
    states: Object.fromEntries([...intents.values()].map((i) => [i.intent_id, i.state])),
  };
}
