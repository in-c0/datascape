// The adversarial real-shaped cases — spec V6.1 §8.
//
// Ten cases the harness must TRY, not describe. Each is an attempt to do the
// dangerous thing; the case passes only when the attempt is refused for the
// right reason. A harness that never attempts the bad case reports zero
// violations over an empty set, which is the same empty green this project has
// now produced three times and caught three times.

import { transition } from "./intent.js";
import { createContainer } from "./topic.js";
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

  return {
    total: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass),
    cases,
    all_passed: cases.every((c) => c.pass),
  };
}
