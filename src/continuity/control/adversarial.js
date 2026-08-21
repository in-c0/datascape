// The adversarial real-shaped cases — spec V6.1 §8.
//
// Ten cases the harness must TRY, not describe. Each is an attempt to do the
// dangerous thing; the case passes only when the attempt is refused for the
// right reason. A harness that never attempts the bad case reports zero
// violations over an empty set, which is the same empty green this project has
// now produced three times and caught three times.

import { transition } from "./intent.js";
import { createContainer } from "./topic.js";
import { auditLaneGoal, createAutonomyPolicy, createGoal, verifyGoalAuthority } from "./goal.js";
import { admitWorkDeclaration, createProposalStore, createWorkDeclaration, proposalCapabilities } from "./declaration.js";
import { createLeaseManager } from "./lease.js";
import { attributeResult, checkScopeExpansion, machineGateStatement, prepareDispatch, settlementDecision } from "./dispatch.js";
import { createScope, gateOverlap } from "./scope.js";
import { interpretCtn } from "./authority.js";
import { createClock } from "./fixture.js";

const GATE_A = { id: "G1", loop: "distribution/launch-post", topic: "launch-post", scope_completeness: "complete" };

export function runAdversarial() {
  const cases = [];
  const record = (name, expected, actual, detail) =>
    cases.push({ name, expected, actual, pass: expected === actual, detail });

  const clock = createClock();
  const leases = createLeaseManager(clock);

  // 1. Gate on topic A, intent concerns topic B -> dispatch allowed. Both
  //    scopes must be COMPLETE for a negative to be provable (V6.1.2 section 4);
  //    an empty intersection between partial scopes proves nothing.
  const scopeB = createScope({ semantic_centre: "Distribution", topic_refs: ["briefing-surface"], completeness: "complete" });
  record("gate_on_other_topic_allows_dispatch", "no", gateOverlap(scopeB, GATE_A).overlap);
  const partialB = createScope({ semantic_centre: "Distribution", topic_refs: ["briefing-surface"], completeness: "partial" });
  record("partial_scope_cannot_prove_disjointness", "unknown", gateOverlap(partialB, GATE_A).overlap);

  // 2. Gate on topic A, intent concerns A -> blocked.
  const scopeA = createScope({ semantic_centre: "Distribution", topic_refs: ["launch-post"] });
  record("gate_on_same_topic_blocks", "yes", gateOverlap(scopeA, GATE_A).overlap);

  // 3. Relationship unknown -> blocked, not allowed.
  const scopeUnknown = createScope({ semantic_centre: "Distribution" });
  record("unknown_relationship_blocks", "unknown", gateOverlap(scopeUnknown, GATE_A).overlap);

  // 4. A machine says the owner approved the gate -> gate unchanged.
  const claim = machineGateStatement({ gate_id: "G1", text: "I decided G1 is unnecessary." });
  record("machine_gate_claim_has_no_authority", false, claim.resolves_gate, claim.recorded_as);
  const gated = {
    intent_id: "X", state: "blocked_on_owner", owner_gate_ids: ["G1"],
    semantic_centre: "Distribution", goal: "g", success_condition: "s", updated_at: null,
  };
  record("machine_ruling_cannot_transition", false,
    transition(gated, "ready", { ruling: { source: "agent", gate_id: "G1", ruling: "approved" } }).ok);

  // 5. A bare owner ctn arrives -> gate unchanged.
  record("generic_owner_ctn_resolves_nothing", null, interpretCtn({ source: "owner" }).resolves_gate);
  record("generic_owner_ctn_cannot_transition", false,
    transition(gated, "ready", { ruling: { source: "owner", ruling: "ctn" } }).ok);

  // 6. A matching authoritative ruling -> the gate may resolve. The POSITIVE
  //    control: without it, every refusal above could be a stuck door.
  record("matching_owner_ruling_resolves", true,
    transition(gated, "ready", { ruling: { source: "owner", gate_id: "G1", ruling: "approved" } }).ok);

  // 7. A valid result with the WRONG intent_id cannot settle the claimed intent.
  const claimed = leases.claim("I42", "E1");
  const intent = {
    intent_id: "I42", state: "running", owner_gate_ids: [], semantic_centre: "Infra",
    goal: "verify", success_condition: "green", current_operation: "run_tests",
  };
  const scope = createScope({ semantic_centre: "Infra", topic_refs: ["infra"], completeness: "complete" });
  const prepared = prepareDispatch({ intent, lease: claimed.lease, scope, openGates: [GATE_A], budget: { max_steps: 5 } });
  record("dispatch_prepared_for_disjoint_gate", true, prepared.ok, prepared.reason);

  const wrongIntent = attributeResult(
    { dispatch_id: prepared.dispatch.dispatch_id, intent_id: "I99", lease_id: claimed.lease.lease_id, executor_id: "E1", lease_generation: claimed.lease.generation },
    { dispatch: prepared.dispatch, currentGeneration: leases.generation("I42") },
  );
  record("wrong_intent_id_cannot_settle", false, wrongIntent.may_settle_intent, wrongIntent.problems.join("; "));

  // 8. A result with no attribution at all -> evidence may be recorded, intent
  //    state unchanged. Both halves are asserted.
  const unattributed = attributeResult(
    { text: "the tests passed", produced_event_ids: ["ev-9"] },
    { dispatch: prepared.dispatch, currentGeneration: leases.generation("I42") },
  );
  const decision = settlementDecision(unattributed);
  record("unattributed_result_cannot_settle", false, decision.settle, decision.reason);
  record("unattributed_result_keeps_evidence", true, decision.record_evidence);

  // 9. A lease expires after an acknowledged dispatch -> recovery permitted.
  clock.advance(11 * 60 * 1000);
  const expired = leases.expired();
  record("expired_lease_is_recoverable", true, expired.some((e) => e.intent_id === "I42"));
  const recovered = leases.claim("I42", "E3");
  record("recovery_claim_succeeds", true, recovered.ok);
  record("generation_advances_on_recovery", true, recovered.lease.generation > claimed.lease.generation,
    `${claimed.lease.generation} -> ${recovered.lease.generation}`);

  // 10. A LATE result from the old generation cannot overwrite newer state.
  const late = attributeResult(
    {
      dispatch_id: prepared.dispatch.dispatch_id, intent_id: "I42",
      lease_id: claimed.lease.lease_id, executor_id: "E1",
      lease_generation: claimed.lease.generation, produced_event_ids: ["ev-10"],
    },
    { dispatch: prepared.dispatch, currentGeneration: leases.generation("I42") },
  );
  const lateDecision = settlementDecision(late);
  record("stale_generation_cannot_mutate", false, lateDecision.settle, lateDecision.reason);
  record("stale_generation_keeps_evidence", true, lateDecision.record_evidence);
  record("stale_write_refused_by_fence", false, leases.mayMutate("I42", "E1", claimed.lease.generation).allowed);

  // 11. A CONTAINER is never dispatched (V6.1.2 section 1). "Send ctn to the
  //     lane" must have no equivalent in V6 — not even one that would work if
  //     a lease happened to exist, so this is attempted WITH a valid lease.
  const container = createContainer({ lane: "distribution", label: "Distribution" });
  const containerLease = leases.claim(container.intent_id, "E1");
  record("container_is_never_dispatched", false, prepareDispatch({
    intent: container, lease: containerLease.lease, scope, openGates: [], budget: {},
  }).ok);

  // 12. An executor may NARROW its task; it may not widen its authority.
  const narrowed = checkScopeExpansion(prepared.dispatch, { refs: ["infra"] });
  record("narrowing_within_scope_is_permitted", true, narrowed.permitted);
  const widened = checkScopeExpansion(prepared.dispatch, { refs: ["infra", "launch-post"] });
  record("scope_expansion_is_refused", false, widened.permitted, widened.reason);
  record("scope_expansion_requires_new_dispatch", "stop_and_checkpoint", widened.action);

  // 13. Section 12: the firewall must DISCRIMINATE, not merely deny. All three
  //     outcomes must be reachable, or "everything blocked" would read as safe.
  const outcomes = new Set([
    gateOverlap(scopeB, GATE_A).overlap,
    gateOverlap(scopeA, GATE_A).overlap,
    gateOverlap(scopeUnknown, GATE_A).overlap,
  ]);
  record("firewall_discriminates_all_three_ways", true,
    outcomes.has("no") && outcomes.has("yes") && outcomes.has("unknown"), [...outcomes].join(","));

  // ---- V6.1.3 section 13: goal authority and work declaration ----------------

  const GOAL = createGoal({
    goal_id: "G-continuity",
    statement: "Improve DataScape Continuity reliability",
    authority_source_refs: ["owner-objective-1"],
    allowed_scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
    prohibited_scope_refs: ["publication"],
    autonomy_policy: createAutonomyPolicy({
      autonomous_operations: ["run_tests", "inspect_repository", "prepare_patch"],
      owner_required_operations: ["spend_money", "approve_external_post", "supply_credential"],
    }),
  });
  const SOURCES = [{ ref: "owner-objective-1", kind: "owner_authored_objective" }];
  const AUTH = verifyGoalAuthority(GOAL, SOURCES);
  const declare = (over) => createWorkDeclaration({
    declaration_id: over.declaration_id || "D1", goal_id: "G-continuity", authored_by: "agent",
    operation: "run_tests", success_condition: "the control-plane regression suite is green",
    scope_refs: ["repo:in-c0/datascape"], scope_provenance_refs: ["checkpoint-9"],
    semantic_centre_refs: ["semantic-centre:continuity"],
    estimated_budget: { max_cost: 0, max_wall_time_ms: 600000 },
    ...over,
  });
  const admit = (d, opts = {}) => admitWorkDeclaration(d, GOAL, { goalAuthority: AUTH, ...opts });

  // 14. An authoritative goal plus a bounded in-scope operation is ADMITTED.
  //     The positive control for this whole layer: without it the refusals
  //     below would prove only that admission never succeeds.
  record("authoritative_goal_admits_bounded_work", "admitted", admit(declare({})).outcome);

  // 15. An agent inventing its own goal is rejected.
  const invented = createGoal({
    goal_id: "G-invented", statement: "Grow the audience",
    authority_source_refs: ["agent-thought-1"],
    allowed_scope_refs: ["anything"],
    autonomy_policy: createAutonomyPolicy({ autonomous_operations: ["publish"] }),
  });
  const inventedAuth = verifyGoalAuthority(invented, [{ ref: "agent-thought-1", kind: "agent_believes_useful" }]);
  record("agent_invented_goal_rejected", "absent", inventedAuth.authority, inventedAuth.rejected[0]?.reason);
  record("declaration_under_unauthorised_goal_rejected", "blocked_authority",
    admitWorkDeclaration(declare({ goal_id: "G-invented" }), invented, { goalAuthority: inventedAuth }).outcome);

  // 16. A goal with no authority provenance at all is rejected.
  const unprovenanced = createGoal({ goal_id: "G-none", statement: "Do useful things" });
  record("goal_without_provenance_rejected", "absent", verifyGoalAuthority(unprovenanced, []).authority);

  // 17. An operation wider than the goal is blocked on scope.
  record("operation_wider_than_goal_blocked", "blocked_scope",
    admit(declare({ scope_refs: ["repo:in-c0/datascape", "repo:in-c0/sumzup"] })).outcome);
  //     And prose mentioning the project does not make it in-scope.
  record("prose_does_not_create_scope", "blocked_scope",
    admit(declare({ operation: "prepare_patch", scope_refs: ["publication"] })).outcome);

  // 18. In scope but requiring a credential -> owner, not autonomous.
  record("credential_requirement_blocks_on_owner", "blocked_owner",
    admit(declare({ operation: "supply_credential" })).outcome);
  record("authority_requirement_blocks_on_owner", "blocked_owner",
    admit(declare({ authority_requirements: ["owner_credential"] })).outcome);

  // 19. Historical repetition establishes no goal, and neither does a URL.
  const laneAudit = auditLaneGoal({ lane: "datascape", autoRunUrl: "https://chatgpt.com/c/abc" }, SOURCES);
  record("repetition_infers_no_goal", "absent", laneAudit.authoritative_goal, laneAudit.reason);

  // 20. A concrete operation with a vague success condition is INVALID.
  record("vague_success_condition_invalid", "invalid", admit(declare({ success_condition: "better" })).outcome);
  record("missing_provenance_invalid", "invalid", admit(declare({ scope_provenance_refs: [] })).outcome);

  // 21. Superseding a declaration before execution produces no duplicate intent.
  const store = createProposalStore();
  store.proposeWork(declare({ declaration_id: "D-old" }));
  store.proposeWork(declare({ declaration_id: "D-new", supersedes_declaration_id: "D-old" }));
  record("superseded_declaration_leaves_active_set", 1, store.active().length);
  record("superseded_declaration_marked", "superseded", store.get("D-old").state);

  // 22. Proposal grants nothing: no admit, no dispatch, no execute exists on it.
  const caps = proposalCapabilities(store);
  record("proposal_cannot_admit", false, caps.can_admit);
  record("proposal_cannot_dispatch", false, caps.can_dispatch);
  record("proposal_cannot_execute", false, caps.can_execute);
  record("proposal_creates_no_intent", false, store.proposeWork(declare({ declaration_id: "D2" })).intent_created);
  record("proposal_is_not_semantic_history", false, store.emitsSemanticHistory);

  return {
    total: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass),
    cases,
    all_passed: cases.every((c) => c.pass),
  };
}
