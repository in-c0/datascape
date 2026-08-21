import test from "node:test";
import assert from "node:assert/strict";
import { createScope, gateOverlap, refuseSimilarityMatching, resolveScope } from "../src/continuity/control/scope.js";
import {
  attributeResult, createDispatchTracker, machineGateStatement,
  prepareDispatch, renderInstruction, settlementDecision,
} from "../src/continuity/control/dispatch.js";
import { classifyLaneWakes, classifyWake, evaluateWake } from "../src/continuity/control/wake.js";
import { createLeaseManager } from "../src/continuity/control/lease.js";
import { createClock } from "../src/continuity/control/fixture.js";
import { runAdversarial } from "../src/continuity/control/adversarial.js";
import { attributionMetrics, simulate } from "../src/continuity/control/simulate.js";

const GATE = { id: "G1", loop: "distribution/launch-post", topic: "launch-post", scope_completeness: "complete" };
const INTENT = {
  intent_id: "I42", state: "ready", owner_gate_ids: [], semantic_centre: "Infrastructure",
  goal: "verify the deployment", success_condition: "green at head", current_operation: "run_tests",
};

// ---- §2: topic provenance ----------------------------------------------------

test("V6.1: same lane is not the same authority scope", () => {
  const other = createScope({
    semantic_centre: "Distribution", lane: "distribution",
    topic_refs: ["briefing-surface"], completeness: "complete",
  });
  assert.equal(gateOverlap(other, GATE).overlap, "no",
    "a gate on one topic must not freeze unrelated work in the same lane");

  const same = createScope({ semantic_centre: "Distribution", lane: "distribution", topic_refs: ["launch-post"] });
  assert.equal(gateOverlap(same, GATE).overlap, "yes");

  // V6.1.2 section 4: the SAME disjoint pair, but with a partial scope, is no
  // longer provable. Absence of a shared reference is not proof of
  // disjointness when either side has not enumerated what it touches.
  const partial = createScope({
    semantic_centre: "Distribution", lane: "distribution",
    topic_refs: ["briefing-surface"], completeness: "partial",
  });
  assert.equal(gateOverlap(partial, GATE).overlap, "unknown");
});

test("V6.1: unknown overlap blocks and never reads as unrelated", () => {
  const undeclared = createScope({ semantic_centre: "Distribution", lane: "distribution" });
  const overlap = gateOverlap(undeclared, GATE);
  assert.equal(overlap.overlap, "unknown");
  assert.notEqual(overlap.overlap, "no", "unknown must not mean probably unrelated");

  const resolution = resolveScope(undeclared, [GATE]);
  assert.equal(resolution.scope_resolution, "unknown");
  assert.equal(resolution.dispatchable, false);

  // A gate that declares no topic is also unresolvable.
  const declared = createScope({ semantic_centre: "X", topic_refs: ["t"] });
  assert.equal(gateOverlap(declared, { id: "G9" }).overlap, "unknown");
});

test("V6.1: overlap is never resolved by prose similarity", () => {
  assert.throws(() => refuseSimilarityMatching(), /never by prose similarity/);
  // Words in common, no authoritative reference in common.
  const scope = createScope({ semantic_centre: "Post-hoc validation", topic_refs: ["post-hoc-validation"], completeness: "complete" });
  assert.equal(gateOverlap(scope, { id: "G2", loop: "distribution/launch-post", scope_completeness: "complete" }).overlap, "no");
});

test("V6.1: an explicit exclusion is authoritative, an opinion is not", () => {
  const excluded = createScope({ semantic_centre: "D", excluded_gate_ids: ["G1"] });
  assert.equal(gateOverlap(excluded, GATE).overlap, "no");
  assert.equal(resolveScope(excluded, [GATE]).dispatchable, true);
});

// ---- §1, §5: scoped dispatch -------------------------------------------------

test("V6.1: a dispatch is single-intent and materially different from ctn", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");
  const scope = createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" });

  const { ok, dispatch } = prepareDispatch({ intent: INTENT, lease, scope, openGates: [GATE], budget: { max_steps: 5, max_cost: 0 } });
  assert.equal(ok, true);
  assert.equal(dispatch.intent_id, "I42");
  assert.equal(dispatch.lease_generation, lease.generation);
  assert.deepEqual(dispatch.open_owner_gates, ["G1"]);

  const text = renderInstruction(dispatch);
  assert.match(text, /Continue intent I42/);
  assert.match(text, /outside your authority/);
  assert.match(text, /Record resulting events against I42/);
  assert.notEqual(text.trim(), "ctn");
});

test("V6.1: a dispatch carries gates as constraints, never as rulings or secrets", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");
  const scope = createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" });
  const { dispatch } = prepareDispatch({
    intent: INTENT, lease, scope,
    openGates: [{ ...GATE, ruling: "approved", secret: "REDACTED-PLACEHOLDER" }],
    budget: { max_steps: 5 },
  });
  const serialized = JSON.stringify(dispatch);
  for (const leak of ["ruling", "secret", "REDACTED-PLACEHOLDER", "approved"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must not travel with a dispatch`);
  }

  const claim = machineGateStatement({ gate_id: "G1", text: "I decided G1 is unnecessary." });
  assert.equal(claim.resolves_gate, false);
  assert.equal(claim.authority, "none");
  assert.equal(claim.recorded_as, "agent_observation", "the statement is preserved as evidence");
});

test("V6.1: an unresolved or intersecting scope refuses the dispatch outright", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");

  const unknown = prepareDispatch({
    intent: INTENT, lease, scope: createScope({ semantic_centre: "Infrastructure" }),
    openGates: [GATE], budget: {},
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.scope_resolution, "unknown");

  const intersecting = prepareDispatch({
    intent: INTENT, lease, scope: createScope({ semantic_centre: "D", topic_refs: ["launch-post"] }),
    openGates: [GATE], budget: {},
  });
  assert.equal(intersecting.ok, false);
  assert.match(intersecting.reason, /intersecting owner gate/);

  // And an owner-gated intent is never dispatched at all.
  assert.equal(prepareDispatch({
    intent: { ...INTENT, state: "blocked_on_owner" }, lease,
    scope: createScope({ semantic_centre: "I", topic_refs: ["infra"] }), openGates: [], budget: {},
  }).ok, false);
});

// ---- §4: acknowledgement -----------------------------------------------------

test("V6.1: a dispatch may not run until it is acknowledged, by identity", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");
  const scope = createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" });
  const { dispatch } = prepareDispatch({ intent: INTENT, lease, scope, openGates: [], budget: {} });

  const tracker = createDispatchTracker({ now: clock.now, ackTimeoutMs: 60000 });
  tracker.send(dispatch);
  assert.equal(tracker.start(dispatch.dispatch_id).ok, false, "sent is not running");

  assert.equal(tracker.acknowledge(dispatch.dispatch_id, { intent_id: "I99", lease_id: lease.lease_id }).ok, false,
    "an acknowledgement for another intent is not an acknowledgement");
  assert.equal(tracker.acknowledge(dispatch.dispatch_id, { intent_id: "I42", lease_id: lease.lease_id }).ok, true);
  assert.equal(tracker.start(dispatch.dispatch_id).ok, true);
});

test("V6.1: silence is recoverable, never assumed to be work in progress", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");
  const scope = createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" });
  const { dispatch } = prepareDispatch({ intent: INTENT, lease, scope, openGates: [], budget: {} });

  const tracker = createDispatchTracker({ now: clock.now, ackTimeoutMs: 60000 });
  tracker.send(dispatch);
  assert.deepEqual(tracker.unacknowledged(), []);
  clock.advance(60001);
  const stuck = tracker.unacknowledged();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].recoverable, true);
});

// ---- §3, §9: attribution and fencing -----------------------------------------

test("V6.1: an unattributed result keeps its evidence and loses its authority", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I42", "E1");
  const scope = createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" });
  const { dispatch } = prepareDispatch({ intent: INTENT, lease, scope, openGates: [], budget: {} });

  const attribution = attributeResult({ text: "tests passed", produced_event_ids: ["ev-1"] },
    { dispatch, currentGeneration: leases.generation("I42") });
  assert.equal(attribution.execution_attribution, "unknown");
  const decision = settlementDecision(attribution);
  assert.equal(decision.settle, false);
  assert.equal(decision.record_evidence, true, "valid evidence still enters V5 as a source record");

  // Positive control: a fully attributed, current-generation result settles.
  const good = attributeResult({
    dispatch_id: dispatch.dispatch_id, intent_id: "I42", lease_id: lease.lease_id,
    executor_id: "E1", lease_generation: lease.generation, produced_event_ids: ["ev-2"],
  }, { dispatch, currentGeneration: leases.generation("I42") });
  assert.equal(settlementDecision(good).settle, true);
});

test("V6.1: a late writer from a superseded generation cannot mutate", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const first = leases.claim("I6", "E1", { ttlMs: 1000 });
  clock.advance(1001);
  const second = leases.claim("I6", "E3");
  assert.ok(second.lease.generation > first.lease.generation);

  assert.equal(leases.fence("I6", first.lease.generation).ok, false);
  assert.equal(leases.fence("I6", second.lease.generation).ok, true, "the current generation still writes");
  assert.equal(leases.mayMutate("I6", "E1", first.lease.generation).allowed, false);
  assert.equal(leases.mayMutate("I6", "E3", second.lease.generation).allowed, true);
});

// ---- §6: wake conditions -----------------------------------------------------

test("V6.1: a bare interval is an unconditional continuation, and it blocks", () => {
  assert.equal(classifyWake({ type: "interval", interval: 360000 }).kind, "unconditional_continuation");
  assert.equal(classifyWake(null).kind, "unconditional_continuation");
  const evaluated = evaluateWake({ type: "interval", interval: 360000 }, 0);
  assert.equal(evaluated.due, false);
  assert.equal(evaluated.blocks_execution, true);
});

test("V6.1: real time dependencies and named polls are legitimate", () => {
  const at = Date.parse("2026-08-21T12:00:00+10:00");
  assert.equal(evaluateWake({ type: "time_reached", at: "2026-08-21T11:00:00+10:00" }, at).due, true);
  assert.equal(evaluateWake({ type: "time_reached", at: "2026-08-21T13:00:00+10:00" }, at).due, false);

  const poll = evaluateWake({ type: "poll_condition", source_ref: "pr-25", condition: "merged", interval: 60000, last_checked_at: "2026-08-21T11:00:00+10:00" }, at);
  assert.equal(poll.due, true);
  assert.equal(poll.kind, "poll_fallback");
  assert.match(poll.wake_reason, /^poll_condition:pr-25/);

  // "Keep exploring" is modelled as what it is, not as a fake event wait.
  const recurring = evaluateWake({ type: "recurring_goal", next_step_budget: { max_steps: 3 }, goal_ref: "explore" }, at);
  assert.equal(recurring.due, true);
  assert.equal(recurring.kind, "recurring_goal");
});

test("V6.1: backoff bounds a failing poll instead of hot-looping", () => {
  const at = 10_000_000;
  const base = { type: "poll_condition", source_ref: "s", condition: "c", interval: 1000, last_checked_at: new Date(at - 2000).toISOString() };
  assert.equal(evaluateWake(base, at).due, true);
  assert.equal(evaluateWake({ ...base, consecutive_failures: 4 }, at).due, false, "backoff pushes the next check out");
});

test("V6.1: lane wake classification gates execution honestly", () => {
  const summary = classifyLaneWakes([
    { lane: "a", wake: { type: "interval", interval: 360000 } },
    { lane: "b", wake: { type: "poll_condition", source_ref: "x", condition: "y" } },
    { lane: "c", wake: { type: "time_reached", at: "2026-08-22T09:00:00+10:00" } },
  ]);
  assert.equal(summary.unconditional_continuations, 1);
  assert.equal(summary.named_poll_fallbacks, 1);
  assert.equal(summary.real_time_dependencies, 1);
  assert.equal(summary.ready_for_execution, false, "one unconditional timer is enough to hold execution");
});

// ---- §8: the adversarial harness ---------------------------------------------

test("V6.1: every adversarial case is attempted and refused for the right reason", () => {
  const result = runAdversarial();
  assert.equal(result.all_passed, true, JSON.stringify(result.failed));
  assert.ok(result.total >= 18, "the ten spec cases expand to at least eighteen assertions");
  // The positive control must be among them, or the refusals prove only that
  // the door is stuck shut.
  assert.ok(result.cases.some((c) => c.name === "matching_owner_ruling_resolves" && c.pass));
});

// ---- §7, §10: the prospective simulation -------------------------------------

const START = Date.parse("2026-08-21T22:00:00+10:00");

test("V6.1: an intent with no declared condition never dispatches", () => {
  const result = simulate({
    intents: [{
      ...INTENT, state: "ready", wake: { type: "interval", interval: 360000 },
      scope: createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" }),
      authority: "autonomous",
    }],
    openGates: [], startMs: START, hours: 8,
  });
  assert.equal(result.outcomes.would_dispatch, 0);
  assert.ok(result.outcomes.would_wait > 0);
});

test("V6.1: every would-dispatch is fully attributed, and unknowns block", () => {
  const dispatchable = {
    ...INTENT, wake: { type: "recurring_goal", next_step_budget: { max_steps: 2 }, goal_ref: "verify" },
    scope: createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" }),
    authority: "autonomous",
  };
  const undeclared = {
    ...INTENT, intent_id: "I43",
    wake: { type: "recurring_goal", next_step_budget: { max_steps: 2 }, goal_ref: "explore" },
    scope: createScope({ semantic_centre: "Distribution" }),
    authority: "autonomous",
  };
  const result = simulate({ intents: [dispatchable, undeclared], openGates: [GATE], startMs: START, hours: 8 });
  const metrics = attributionMetrics(result);

  assert.ok(metrics.would_dispatch > 0);
  assert.equal(metrics.unattributed_dispatches, 0);
  assert.equal(metrics.fully_attributed, metrics.would_dispatch);
  assert.equal(metrics.gate_passes, true);
  assert.ok(metrics.scope_unknown_blocked > 0, "the undeclared intent must be blocked, not dispatched");
  assert.equal(result.dispatches.every((d) => d.intent_id === "I42"), true);
  assert.equal(result.dispatches.every((d) => d.wake_reason), true, "every dispatch declares why it woke");
  assert.equal(new Set(result.dispatches.map((d) => d.lease_generation)).size, result.dispatches.length,
    "each dispatch carries its own fencing generation");
});

test("V6.1: an owner-gated intent is never dispatched across the whole window", () => {
  const result = simulate({
    intents: [{
      ...INTENT, state: "blocked_on_owner", owner_gate_ids: ["G1"],
      wake: { type: "recurring_goal", next_step_budget: { max_steps: 2 } },
      scope: createScope({ semantic_centre: "Distribution", topic_refs: ["launch-post"] }),
      authority: "autonomous",
    }],
    openGates: [GATE], startMs: START, hours: 8,
  });
  assert.equal(result.outcomes.would_dispatch, 0);
  assert.ok(result.outcomes.would_block_owner > 0);
});

test("V6.1: a zero-dispatch run cannot claim full attribution", () => {
  // The whole run blocked at the wake gate, so nothing was dispatched.
  const result = simulate({
    intents: [{
      ...INTENT, wake: { type: "interval", interval: 360000 },
      scope: createScope({ semantic_centre: "Infrastructure" }), authority: "autonomous",
    }],
    openGates: [GATE], startMs: START, hours: 8,
  });
  const metrics = attributionMetrics(result);
  assert.equal(metrics.would_dispatch, 0);
  // gate_passes is 0 === 0 here. TRUE, and evidence of nothing — which is why
  // the release report must flag the vacuity rather than report a clean bill.
  assert.equal(metrics.gate_passes, true);
  assert.equal(metrics.would_dispatch === 0, true,
    "a caller reading gate_passes without checking would_dispatch would be reading an empty green");
});

test("V6.1: declaring a wake condition alone does not unblock a topicless intent", () => {
  // The counterfactual the real report runs: fix the timer, change nothing
  // else. Scope is still unresolvable against an open gate, so it stays blocked.
  const result = simulate({
    intents: [{
      ...INTENT, wake: { type: "recurring_goal", next_step_budget: { max_steps: 3 }, goal_ref: "explore" },
      scope: createScope({ semantic_centre: "Infrastructure" }), authority: "autonomous",
    }],
    openGates: [GATE], startMs: START, hours: 8,
  });
  assert.equal(result.outcomes.would_dispatch, 0);
  assert.ok(result.outcomes.would_block_scope_unknown > 0);

  // And with a declared topic, the same intent dispatches. The positive control
  // that proves the block is about topic provenance and nothing else.
  const scoped = simulate({
    intents: [{
      ...INTENT, wake: { type: "recurring_goal", next_step_budget: { max_steps: 3 }, goal_ref: "explore" },
      scope: createScope({ semantic_centre: "Infrastructure", topic_refs: ["infra"], completeness: "complete" }), authority: "autonomous",
    }],
    openGates: [GATE], startMs: START, hours: 8,
  });
  assert.ok(scoped.outcomes.would_dispatch > 0);
});
