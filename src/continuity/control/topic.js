// Containers, executable topic intents, and continuation policy — spec V6.1.2
// §1, §2, §6, §7, §9.
//
// The governing correction: A LANE TRUNK IS A COORDINATION CONTAINER. It is not
// itself executable work.
//
//   Lane                     container, never dispatched
//   ├── topic intent A       executable
//   ├── topic intent B       executable
//   └── owner-gated intent   blocked_on_owner
//
// This is the third time the same lesson has had to be applied, each time one
// level finer: same lane != same work != same authority scope. Giving each
// trunk a broad recurring goal would have made the simulation green while
// reproducing the container mistake in a new costume.

import { createIntent } from "./intent.js";
import { createScope } from "./scope.js";

export const ROLES = ["container", "executable"];
export const CONTINUATION_POLICIES = ["finite", "recurring", "condition_driven"];

/**
 * A lane container.
 *
 * May carry mission, policy, child ids and budget policy. May NEVER acquire an
 * execution lease — enforced in `dispatch.js`, not merely stated here.
 */
export function createContainer({ lane, label, mission = null, children = [], policy = null, budget_policy = null }) {
  return {
    intent_id: `container:${lane}`,
    role: "container",
    executable: false,
    lane,
    semantic_centre: label || lane,
    mission,
    child_intent_ids: [...children],
    continuation_policy: policy,
    budget_policy,
    state: "waiting",
    owner_gate_ids: [],
    unblocks: [],
  };
}

/**
 * Derive an executable topic intent from GROUNDED evidence.
 *
 * Returns `{ ok: false }` when nothing establishes that a real work unit
 * exists. That refusal is the entire mechanism: without it, five convenient
 * topics appear, the simulation goes green, and the report means nothing.
 *
 * Admissible provenance is listed by the spec — a current operation, a
 * checkpoint, an open work record, a declared dependency, an unfinished
 * progress record, a handoff reference, an owner exception. Generated prose may
 * give the intent a nicer label afterwards; it may not create the work unit.
 */
export function deriveTopicIntent({ lane, evidence, openGates = [] }) {
  const provenance = (evidence?.provenance_refs || []).filter(Boolean);
  if (provenance.length === 0) {
    return { ok: false, reason: "no source-grounded evidence of a concrete work unit", intent: null };
  }
  if (!evidence.operation) {
    return { ok: false, reason: "evidence establishes a topic but no concrete current operation", intent: null };
  }

  const scope = createScope({
    semantic_centre: evidence.semantic_centre || lane.label || lane.lane,
    lane: lane.lane,
    semantic_centre_refs: evidence.semantic_centre_refs || [],
    topic_refs: evidence.topic_refs || [],
    source_refs: evidence.source_refs || [],
    external_refs: evidence.external_refs || [],
    dependency_refs: evidence.dependency_refs || [],
    scope_provenance_refs: provenance,
    // Claimed by the evidence, never assumed. A derived scope is `partial`
    // unless the source enumerates everything the work touches.
    completeness: evidence.scope_completeness || "partial",
  });

  const gates = openGates.map((g) => g.id).filter((id) => (evidence.gate_refs || []).includes(id));
  const intent = createIntent({
    intent_id: `topic:${lane.lane}:${evidence.key}`,
    semantic_centre: scope.semantic_centre,
    goal: evidence.goal || evidence.operation,
    success_condition: evidence.success_condition || "the declared operation completes",
    current_operation: evidence.operation,
    owner_gate_ids: gates,
    state: gates.length ? "blocked_on_owner" : "ready",
    created_at: evidence.at || null,
    relevant_source_ids: provenance,
  });

  return {
    ok: true,
    intent: {
      ...intent,
      role: "executable",
      executable: true,
      lane: lane.lane,
      scope,
      continuation_policy: evidence.continuation_policy || { kind: "finite" },
      authority: evidence.authority || "autonomous",
    },
  };
}

// ---- Continuation policy (§6) -------------------------------------------------

/**
 * Validate a continuation policy.
 *
 * `recurring` is legitimate — some work genuinely is ongoing. It must declare
 * what it is, how much of it may run at once, when the next iteration becomes
 * eligible, and what would stop it. A recurring policy computing
 * `next_iteration_at` from the previous iteration is fine: time then controls
 * ELIGIBILITY for another bounded iteration, rather than substituting for
 * knowing what work is being continued.
 */
export function validatePolicy(policy) {
  if (!policy || !CONTINUATION_POLICIES.includes(policy.kind)) {
    return { ok: false, problems: [`unknown continuation policy: ${policy?.kind ?? "none"}`] };
  }
  const problems = [];
  if (policy.kind === "finite" && !policy.completion_condition) {
    problems.push("a finite policy requires a completion condition");
  }
  if (policy.kind === "condition_driven" && !(policy.dependencies || []).length) {
    problems.push("a condition-driven policy requires named dependencies");
  }
  if (policy.kind === "recurring") {
    for (const field of ["recurring_goal", "iteration_budget", "next_eligibility_policy"]) {
      if (!policy[field]) problems.push(`a recurring policy requires ${field}`);
    }
    if (!(policy.stop_conditions || []).length) problems.push("a recurring policy requires at least one stop condition");
  }
  return { ok: problems.length === 0, problems };
}

/** Is another bounded iteration eligible yet? */
export function iterationEligible(policy, { at, lastIterationAt = null, iterationsRun = 0 }) {
  if (policy?.kind !== "recurring") return { eligible: false, reason: "not a recurring policy" };
  if (policy.iteration_budget !== undefined && iterationsRun >= policy.iteration_budget) {
    return { eligible: false, reason: "iteration budget exhausted" };
  }
  const interval = policy.next_eligibility_policy?.min_interval_ms ?? 0;
  const last = lastIterationAt ?? -Infinity;
  return {
    eligible: at - last >= interval,
    reason: at - last >= interval ? null : "next iteration is not yet eligible",
    next_eligible_at: last + interval,
  };
}

// ---- Legacy timer classification (§7) ----------------------------------------

export const TIMER_CLASSES = ["recurring_goal", "named_poll_condition", "obsolete", "undetermined"];

/**
 * Classify one lane's existing fixed timer from AUTHORED evidence.
 *
 * Explicitly refused as evidence for "this is a genuine recurring goal":
 * the presence of an autoRunUrl, and the fact that something has been firing
 * every six minutes. Historical repetition is not proof that repetition is
 * semantically intended — a cron nobody switched off looks identical to a
 * deliberate research loop, and only authored intent distinguishes them.
 */
export function classifyLegacyTimer(lane) {
  const evidence = lane.timer_evidence || {};
  if (evidence.authored_recurring_goal) {
    return { klass: "recurring_goal", basis: `authored recurring goal: ${evidence.authored_recurring_goal}` };
  }
  if (evidence.polls_for) {
    return { klass: "named_poll_condition", basis: `polls for ${evidence.polls_for}` };
  }
  if (evidence.superseded || lane.stoppedAt) {
    return { klass: "obsolete", basis: "the lane is stopped or the timer is superseded" };
  }
  return {
    klass: "undetermined",
    basis: "no authored evidence of intent; an autoRunUrl and a six-minute history are not evidence",
  };
}

/** `undetermined` timers leave their lane NON-EXECUTABLE. That is the honest outcome. */
export function applyTimerClassification(lane) {
  const { klass, basis } = classifyLegacyTimer(lane);
  switch (klass) {
    case "recurring_goal":
      return { klass, basis, executable: true, policy: lane.timer_evidence.policy ?? null };
    case "named_poll_condition":
      return {
        klass, basis, executable: true,
        policy: { kind: "condition_driven", dependencies: [lane.timer_evidence.polls_for] },
      };
    case "obsolete":
      return { klass, basis, executable: false, policy: null, remove_from_mapping: true };
    default:
      return { klass, basis, executable: false, policy: null };
  }
}
