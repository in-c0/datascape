import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTimerClassification, classifyLegacyTimer, createContainer,
  deriveTopicIntent, iterationEligible, validatePolicy,
} from "../src/continuity/control/topic.js";
import { createGateScope, createScope, gateOverlap, inheritScope, scopeHash, withinDispatchedScope } from "../src/continuity/control/scope.js";
import { checkScopeExpansion, prepareDispatch } from "../src/continuity/control/dispatch.js";
import { createCheckpoint, scopeDrift } from "../src/continuity/control/checkpoint.js";
import { createLeaseManager } from "../src/continuity/control/lease.js";
import { createClock } from "../src/continuity/control/fixture.js";
import { selectCanary } from "../src/continuity/control/canary.js";
import { releaseCriterion } from "../src/continuity/control/simulate.js";

const LANE = { lane: "datascape", label: "DataScape / Continuity" };
const GATE = { id: "G1", loop: "datascape/governance", topic: "governance", scope_completeness: "complete" };

// ---- §1: the container contract ----------------------------------------------

test("V6.1.2: a container is never dispatched, even holding a valid lease", () => {
  const container = createContainer({ lane: "datascape", label: "DataScape" });
  assert.equal(container.role, "container");
  assert.equal(container.executable, false);

  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim(container.intent_id, "E1");
  const result = prepareDispatch({
    intent: container, lease,
    scope: createScope({ semantic_centre: "DataScape", topic_refs: ["x"], completeness: "complete" }),
    openGates: [], budget: {},
  });
  assert.equal(result.ok, false, "send-ctn-to-the-lane must have no equivalent in V6");
  assert.match(result.reason, /container intent is never dispatched/);
});

// ---- §2: grounded topic intents ----------------------------------------------

test("V6.1.2: no provenance means no executable topic intent", () => {
  const none = deriveTopicIntent({ lane: LANE, evidence: { key: "k", operation: "run_tests", provenance_refs: [] } });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no source-grounded evidence/);

  // Provenance but no concrete operation is also refused: a topic is not a
  // work unit.
  const vague = deriveTopicIntent({ lane: LANE, evidence: { key: "k", provenance_refs: ["ev-1"] } });
  assert.equal(vague.ok, false);
  assert.match(vague.reason, /no concrete current operation/);
});

test("V6.1.2: a grounded topic intent records what established it", () => {
  const { ok, intent } = deriveTopicIntent({
    lane: LANE,
    evidence: {
      key: "verify-head", operation: "run_tests", goal: "verify the deployed bundle",
      provenance_refs: ["checkpoint-9", "pr-26"], topic_refs: ["briefing-surface"],
      at: "2026-08-21T22:00:00+10:00",
    },
  });
  assert.equal(ok, true);
  assert.equal(intent.role, "executable");
  assert.deepEqual(intent.scope.scope_provenance_refs, ["checkpoint-9", "pr-26"]);
  assert.equal(intent.scope.completeness, "partial", "a derived scope is partial unless the source enumerates everything");
  assert.equal(intent.state, "ready");
});

// ---- §4, §5: three-valued overlap with completeness --------------------------

test("V6.1.2: a negative requires proof, not absence", () => {
  const partial = createScope({ semantic_centre: "D", topic_refs: ["other"], completeness: "partial" });
  assert.equal(gateOverlap(partial, GATE).overlap, "unknown",
    "an empty intersection between partial scopes proves nothing");

  const complete = createScope({ semantic_centre: "D", topic_refs: ["other"], completeness: "complete" });
  assert.equal(gateOverlap(complete, GATE).overlap, "no");

  // And a thin gate cannot support a negative either, however complete we are.
  const thinGate = createGateScope({ id: "G9", loop: "datascape" });
  assert.equal(thinGate.gate_scope_completeness, "unknown");
  assert.equal(gateOverlap(complete, thinGate).overlap, "unknown");
});

test("V6.1.2: a gate scope is projected from the exception, never widened", () => {
  const projected = createGateScope(GATE);
  assert.deepEqual(projected.gate_scope_refs, ["governance"]);
  assert.equal(projected.gate_scope_completeness, "complete");

  const thin = createGateScope({ id: "G2", loop: "sumzup/privacy" });
  assert.deepEqual(thin.gate_scope_refs, ["privacy"]);
  assert.equal(thin.gate_scope_completeness, "partial", "a topic alone is partial provenance, not complete");
});

// ---- §6, §7: continuation policy and the legacy timers -----------------------

test("V6.1.2: a recurring policy must declare what would stop it", () => {
  assert.equal(validatePolicy({ kind: "recurring" }).ok, false);
  const complete = {
    kind: "recurring", recurring_goal: "explore the corpus", iteration_budget: 10,
    next_eligibility_policy: { min_interval_ms: 600000 }, stop_conditions: ["corpus exhausted"],
  };
  assert.equal(validatePolicy(complete).ok, true);
  assert.equal(validatePolicy({ kind: "finite" }).ok, false);
  assert.equal(validatePolicy({ kind: "condition_driven", dependencies: ["pr-26"] }).ok, true);
});

test("V6.1.2: time controls eligibility for a bounded iteration, not readiness itself", () => {
  const policy = {
    kind: "recurring", recurring_goal: "explore", iteration_budget: 2,
    next_eligibility_policy: { min_interval_ms: 1000 }, stop_conditions: ["done"],
  };
  assert.equal(iterationEligible(policy, { at: 5000, lastIterationAt: 4500 }).eligible, false);
  assert.equal(iterationEligible(policy, { at: 6000, lastIterationAt: 4500 }).eligible, true);
  assert.equal(iterationEligible(policy, { at: 9000, lastIterationAt: 0, iterationsRun: 2 }).eligible, false,
    "the iteration budget bounds it regardless of elapsed time");
});

test("V6.1.2: repetition history is not evidence of intended repetition", () => {
  // The exact reinterpretation section 7 forbids.
  const running = { lane: "x", autoRunUrl: "https://chatgpt.com/c/abc", timer_evidence: {} };
  const classified = classifyLegacyTimer(running);
  assert.equal(classified.klass, "undetermined");
  assert.match(classified.basis, /not evidence/);
  assert.equal(applyTimerClassification(running).executable, false,
    "an undetermined timer leaves its lane non-executable");

  // Authored evidence does classify it.
  const authored = { lane: "y", timer_evidence: { authored_recurring_goal: "keep exploring the corpus" } };
  assert.equal(classifyLegacyTimer(authored).klass, "recurring_goal");
  const polling = { lane: "z", timer_evidence: { polls_for: "pr-26-merged" } };
  assert.equal(applyTimerClassification(polling).policy.kind, "condition_driven");
});

// ---- §10, §11: inheritance and scope expansion -------------------------------

test("V6.1.2: scope inheritance is prohibited unless explicitly permitted", () => {
  const child = createScope({ semantic_centre: "child" });
  const parent = createScope({ semantic_centre: "parent", topic_refs: ["everything"], completeness: "complete" });

  assert.equal(inheritScope(parent, child).ok, false, "a convenience that recreates lane-wide authority");
  assert.equal(inheritScope({ ...parent, inheritable: true, completeness: "partial" }, child).ok, false);

  const permitted = inheritScope({ ...parent, inheritable: true }, child);
  assert.equal(permitted.ok, true);
  assert.deepEqual(permitted.scope.topic_refs, ["everything"]);
});

test("V6.1.2: an executor may narrow its task and may not widen its authority", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I1", "E1");
  const scope = createScope({
    semantic_centre: "Infra", topic_refs: ["infra", "deploy"],
    scope_provenance_refs: ["ev-1"], completeness: "complete",
  });
  const { dispatch } = prepareDispatch({ intent: { intent_id: "I1", role: "executable", state: "ready", semantic_centre: "Infra", goal: "g", success_condition: "s", current_operation: "run_tests" }, lease, scope, openGates: [], budget: {} });

  assert.equal(checkScopeExpansion(dispatch, { refs: ["infra"] }).permitted, true, "narrowing is fine");
  const widened = checkScopeExpansion(dispatch, { refs: ["infra", "billing"] });
  assert.equal(widened.permitted, false);
  assert.equal(widened.action, "stop_and_checkpoint");
  assert.deepEqual(widened.outside, ["billing"]);

  // The raw predicate, used directly.
  assert.equal(withinDispatchedScope(scope, ["deploy"]).within, true);
  assert.equal(withinDispatchedScope(scope, ["deploy", "other"]).requires_new_dispatch, true);
});

test("V6.1.2: a checkpoint carries scope identity so drift is detectable", () => {
  const scope = createScope({ semantic_centre: "Infra", topic_refs: ["infra"], completeness: "complete" });
  const dispatch = { scope_hash: scopeHash(scope) };

  const same = createCheckpoint({
    intent_id: "I1", semantic_centre: "Infra", next_safe_action: "rerun verification",
    scope_hash: scopeHash(scope), scope_provenance_refs: ["ev-1"],
  });
  assert.equal(scopeDrift(dispatch, same).drifted, false);

  const widened = createScope({ semantic_centre: "Infra", topic_refs: ["infra", "billing"], completeness: "complete" });
  const drifted = createCheckpoint({
    intent_id: "I1", semantic_centre: "Infra", next_safe_action: "rerun verification",
    scope_hash: scopeHash(widened),
  });
  assert.equal(scopeDrift(dispatch, drifted).requires_redispatch, true);

  // A checkpoint with no scope identity at all is treated as drift, not as
  // agreement — absence is not evidence of sameness.
  assert.equal(scopeDrift(dispatch, createCheckpoint({
    intent_id: "I1", semantic_centre: "Infra", next_safe_action: "x",
  })).requires_redispatch, true);
});

// ---- §15, §17: the non-vacuous criterion and the canary ----------------------

test("V6.1.2: blocking everything does not pass the release criterion", () => {
  const noDangerous = {
    simultaneous_lease_violations: 0, stale_generation_mutations_accepted: 0,
    machine_gate_resolutions_accepted: 0, generic_ctn_gate_resolutions_accepted: 0,
    unattributed_result_settlements: 0, scope_expansion_violations_accepted: 0,
  };
  const blockedEverything = releaseCriterion(
    { would_dispatch: 0, fully_attributed: 0, scope_unknown_dispatches: 0, authority_unknown_dispatches: 0 },
    noDangerous,
    { dispatch_beside_unrelated_gate: false, owner_gate_block: true, unknown_scope_block: true },
  );
  assert.equal(blockedEverything.met, false);
  assert.ok(blockedEverything.reasons.some((r) => /vacuous/.test(r)));

  // A run that discriminates and is clean does pass — the positive control.
  const good = releaseCriterion(
    { would_dispatch: 3, fully_attributed: 3, scope_unknown_dispatches: 0, authority_unknown_dispatches: 0 },
    noDangerous,
    { dispatch_beside_unrelated_gate: true, owner_gate_block: true, unknown_scope_block: true },
  );
  assert.equal(good.met, true, "the criterion must be satisfiable, or it proves nothing");

  // One non-zero dangerous counter is enough to refuse.
  assert.equal(releaseCriterion(
    { would_dispatch: 3, fully_attributed: 3, scope_unknown_dispatches: 0, authority_unknown_dispatches: 0 },
    { ...noDangerous, scope_expansion_violations_accepted: 1 },
    { dispatch_beside_unrelated_gate: true, owner_gate_block: true, unknown_scope_block: true },
  ).met, false);
});

test("V6.1.2: no canary is manufactured when nothing qualifies", () => {
  const bare = {
    dispatch_id: "d1", intent_id: "I1", open_owner_gates: [],
    allowed_scope: { completeness: "partial" }, scope_provenance_refs: [],
    gate_overlap_evaluation: { intersecting: [], unknown: [] },
    budget: { max_cost: 5, max_wall_time_ms: 3600000 }, success_condition: null,
  };
  const none = selectCanary([bare], { I1: {} });
  assert.equal(none.candidate, null);
  assert.match(none.blocked_reason, /remains blocked/);
  assert.ok(none.failure_counts.fully_scoped > 0);

  // A dispatch meeting every constraint is selected — the positive control.
  const good = {
    dispatch_id: "d2", intent_id: "I2", open_owner_gates: ["G1"],
    allowed_scope: { completeness: "complete" }, scope_provenance_refs: ["ev-1"],
    gate_overlap_evaluation: { intersecting: [], unknown: [] },
    budget: { max_cost: 0, max_wall_time_ms: 600000 }, success_condition: "tests green",
  };
  const selected = selectCanary([good], { I2: { side_effects: "none", idempotent: true } });
  assert.equal(selected.candidate?.intent_id, "I2");
});
