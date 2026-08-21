// Goal authority — spec V6.1.3 §1, §2, §10.
//
// The boundary this file draws, and the reason V6.1.3 exists at all:
//
//   "the agent can decide HOW to advance the goal"
//        is not
//   "the agent can decide WHAT the goal is"
//
// A Goal is a DISTINCT control-plane object. It is deliberately not folded into
// the container, the intent, the checkpoint or the lane — each of those already
// means something, and overloading one of them is how strategic authority
// quietly becomes a property of whatever object happened to be nearby.
//
// The load-bearing field is `authority_source_refs`. A goal is valid only if
// something AUTHORITATIVE establishes that this is desired work. Historical
// activity is evidence that activity occurred; it is not evidence that the
// activity remains authorized. Those are different claims and the system has
// already confused them once, at the level of timers.

export const GOAL_AUTHORITY = ["found", "partial", "absent"];

/**
 * Authority sources that establish a goal.
 *
 * Each is something a person authored or approved, and each is checkable after
 * the fact by reading the thing it points at.
 */
export const ACCEPTED_AUTHORITY = [
  "owner_authored_objective",
  "owner_approved_lane_mission",
  "authoritative_project_config",
  "owner_ruling",
];

/**
 * Explicitly NOT authority. Every one of these is a fact about machine
 * behaviour, and none of them is a fact about what the owner wants.
 */
export const REJECTED_AUTHORITY = [
  "repeated_agent_activity",
  "timer_exists",
  "auto_run_url_exists",
  "agent_believes_useful",
  "old_session_discussed_it",
];

export function createGoal({
  goal_id,
  statement,
  lane_id = null,
  project_id = null,
  authority_source_refs = [],
  semantic_centre_refs = [],
  allowed_scope_refs = [],
  prohibited_scope_refs = [],
  autonomy_policy = null,
  stop_conditions = [],
  created_at = null,
  supersedes_goal_id = null,
}) {
  if (!goal_id || !statement) throw new Error("a goal requires goal_id and statement");
  return {
    goal_id,
    statement,
    lane_id,
    project_id,
    authority_source_refs: [...authority_source_refs],
    semantic_centre_refs: [...semantic_centre_refs],
    allowed_scope_refs: [...allowed_scope_refs],
    prohibited_scope_refs: [...prohibited_scope_refs],
    autonomy_policy,
    stop_conditions: [...stop_conditions],
    created_at,
    supersedes_goal_id,
  };
}

/**
 * Is this goal authoritative?
 *
 * `found` requires at least one accepted authority source. `partial` means a
 * source exists but the scope envelope is incomplete — a direction without a
 * boundary. `absent` means nothing authoritative establishes it, whatever the
 * machine has been doing.
 *
 * A rejected source is reported explicitly rather than ignored, because
 * "we looked and found only a timer" is materially different information from
 * "we found nothing".
 */
export function verifyGoalAuthority(goal, sources = []) {
  const accepted = [];
  const rejected = [];
  for (const ref of goal.authority_source_refs) {
    const source = sources.find((s) => s.ref === ref);
    if (!source) { rejected.push({ ref, reason: "authority source does not resolve" }); continue; }
    if (REJECTED_AUTHORITY.includes(source.kind)) {
      rejected.push({ ref, reason: `${source.kind} is not authority; it is evidence that activity occurred` });
      continue;
    }
    if (!ACCEPTED_AUTHORITY.includes(source.kind)) {
      rejected.push({ ref, reason: `unrecognised authority kind: ${source.kind}` });
      continue;
    }
    accepted.push({ ref, kind: source.kind });
  }

  if (accepted.length === 0) {
    return { authority: "absent", accepted, rejected, reason: "no accepted authority source establishes this goal" };
  }
  // A direction without a boundary is not an autonomy grant. "Work on Cat
  // Intent" may ground a persistent direction and still not authorise buying
  // hardware — the envelope is a separate question from the direction.
  const envelope = envelopeCompleteness(goal);
  return {
    authority: envelope === "complete" ? "found" : "partial",
    accepted,
    rejected,
    envelope,
    reason: envelope === "complete" ? null : "the goal is established but its autonomy envelope is not fully declared",
  };
}

/** Is the autonomy envelope fully declared? */
export function envelopeCompleteness(goal) {
  const policy = goal.autonomy_policy;
  if (!policy) return "unknown";
  const hasAutonomous = (policy.autonomous_operations || []).length > 0;
  const hasOwnerRequired = (policy.owner_required_operations || []).length > 0;
  const hasScope = goal.allowed_scope_refs.length > 0;
  if (hasAutonomous && hasOwnerRequired && hasScope) return "complete";
  if (hasAutonomous || hasScope) return "partial";
  return "unknown";
}

/**
 * The autonomy envelope (§2).
 *
 * The point of a goal is that the owner does NOT approve every test run. A
 * valid goal establishes a standing envelope, and an agent may originate
 * bounded operations underneath it without asking again — which is how autonomy
 * scales without a generic `ctn` ever carrying authority.
 */
export function createAutonomyPolicy({ autonomous_operations = [], owner_required_operations = [], max_cost = 0, max_wall_time_ms = 15 * 60 * 1000 }) {
  return {
    autonomous_operations: [...autonomous_operations],
    owner_required_operations: [...owner_required_operations],
    max_cost,
    max_wall_time_ms,
  };
}

/**
 * Does this operation sit inside the goal's envelope?
 *
 * Unknown blocks, in keeping with the rest of the control plane. An operation
 * the envelope does not mention has not been authorised by it; silence is not
 * a grant.
 */
export function operationWithinEnvelope(goal, operation) {
  const policy = goal.autonomy_policy;
  if (!policy) return { within: false, authority: "unknown", reason: "the goal declares no autonomy policy" };
  if ((policy.owner_required_operations || []).includes(operation)) {
    return { within: false, authority: "owner_required", reason: `${operation} is owner-required under this goal` };
  }
  if ((policy.autonomous_operations || []).includes(operation)) {
    return { within: true, authority: "autonomous", reason: null };
  }
  return { within: false, authority: "unknown", reason: `${operation} is not named in the goal's autonomy envelope` };
}

/**
 * Is a proposed scope inside the goal's allowed scope, and outside its
 * prohibited scope? (§6)
 *
 * Reference-based, never prose. An operation to publish a launch post does not
 * become in-scope for a repository goal because its text mentions the project.
 * That requires a separate authority relationship, and the resolver will not
 * invent one.
 */
export function scopeWithinGoal(goal, scopeRefs) {
  const prohibited = scopeRefs.filter((r) => goal.prohibited_scope_refs.includes(r));
  if (prohibited.length) {
    return { within: false, outcome: "blocked_scope", prohibited, reason: `references prohibited scope: ${prohibited.join(", ")}` };
  }
  if (goal.allowed_scope_refs.length === 0) {
    return { within: false, outcome: "unknown", reason: "the goal declares no allowed scope" };
  }
  const outside = scopeRefs.filter((r) => !goal.allowed_scope_refs.includes(r));
  if (outside.length) {
    return { within: false, outcome: "blocked_scope", outside, reason: `references ${outside.length} ref(s) outside the goal's allowed scope` };
  }
  if (scopeRefs.length === 0) {
    return { within: false, outcome: "unknown", reason: "the declaration references no scope at all" };
  }
  return { within: true, outcome: "within", reason: null };
}

/**
 * Audit one lane for an authoritative goal (§10).
 *
 * Deliberately refuses two inferences the spec calls out by name: a goal is
 * never inferred from repeated `ctn`, and a vague product description is never
 * translated into a specific autonomy grant. Where evidence is merely absent,
 * the result says `absent` — never "safe".
 */
export function auditLaneGoal(lane, sources = []) {
  const declared = lane.goal ? createGoal(lane.goal) : null;
  if (!declared) {
    return {
      lane: lane.lane,
      authoritative_goal: "absent",
      authority_source_refs: [],
      envelope: "unknown",
      reason: "no authoritative goal is declared for this lane; repeated continuation is not a goal",
    };
  }
  const verified = verifyGoalAuthority(declared, sources);
  return {
    lane: lane.lane,
    goal_id: declared.goal_id,
    authoritative_goal: verified.authority,
    authority_source_refs: verified.accepted.map((a) => a.ref),
    rejected_sources: verified.rejected,
    envelope: verified.envelope ?? "unknown",
    reason: verified.reason,
  };
}
