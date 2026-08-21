// Canary candidate selection — spec V6.1.2 §17.
//
// If the non-vacuous shadow gate ever passes, the first real execution is NOT
// chosen because it demos well. It is chosen because it satisfies every
// constraint below, and if nothing satisfies them then V6.2 stays blocked.
//
// The rule this encodes: WE DO NOT MANUFACTURE A CANARY TASK. Inventing a
// harmless-looking job to prove the machinery works would prove only that we
// can invent jobs — and the whole point of the shadow evidence is that the work
// has to already exist.

export const CANARY_CONSTRAINTS = [
  "owner_independent",
  "fully_scoped",
  "no_unresolved_overlapping_gate",
  "side_effect_free_or_reversible",
  "zero_monetary_cost",
  "no_credential_requirement",
  "bounded_under_15_minutes",
  "clear_success_condition",
  "idempotent_recoverable",
];

/** Evaluate one would-dispatch against every constraint. Each answer is explicit. */
export function evaluateCandidate(dispatch, intent) {
  const checks = {
    owner_independent: (dispatch.open_owner_gates || []).length === 0
      || (dispatch.gate_overlap_evaluation?.intersecting || []).length === 0,
    fully_scoped: dispatch.allowed_scope?.completeness === "complete"
      && (dispatch.scope_provenance_refs || []).length > 0,
    no_unresolved_overlapping_gate: (dispatch.gate_overlap_evaluation?.unknown || []).length === 0
      && (dispatch.gate_overlap_evaluation?.intersecting || []).length === 0,
    // Claimed by the intent, never assumed. An unstated reversibility is not
    // reversibility.
    side_effect_free_or_reversible: intent?.side_effects === "none" || intent?.reversible === true,
    zero_monetary_cost: (dispatch.budget?.max_cost ?? 1) === 0,
    no_credential_requirement: intent?.requires_credential !== true,
    bounded_under_15_minutes: (dispatch.budget?.max_wall_time_ms ?? Infinity) <= 15 * 60 * 1000,
    clear_success_condition: Boolean(dispatch.success_condition),
    idempotent_recoverable: intent?.idempotent === true,
  };
  const failed = CANARY_CONSTRAINTS.filter((c) => !checks[c]);
  return { dispatch_id: dispatch.dispatch_id, intent_id: dispatch.intent_id, checks, failed, eligible: failed.length === 0 };
}

/**
 * Select the first canary, or explain why there is none.
 *
 * Returning `{ candidate: null }` is a perfectly good outcome and the likeliest
 * one: it means V6.2 stays blocked because no real work unit currently meets
 * the bar. That is information, not failure.
 */
export function selectCanary(dispatches, intentsById = {}) {
  const evaluated = dispatches.map((d) => evaluateCandidate(d, intentsById[d.intent_id]));
  const eligible = evaluated.filter((e) => e.eligible);
  // Deterministic: the highest-ranked real would-dispatch, by scheduling class
  // then by identity. Never "whichever is easiest to demo".
  const ranked = eligible.slice().sort((a, b) => a.dispatch_id.localeCompare(b.dispatch_id));
  return {
    considered: evaluated.length,
    eligible: eligible.length,
    candidate: ranked[0] ?? null,
    blocked_reason: ranked.length ? null : "no real intent satisfies the canary constraints; V6.2 remains blocked",
    // Which constraint is doing the blocking, aggregated — useful for knowing
    // what would have to become true, without inventing it.
    failure_counts: CANARY_CONSTRAINTS.reduce((acc, c) => {
      acc[c] = evaluated.filter((e) => e.failed.includes(c)).length;
      return acc;
    }, {}),
  };
}
