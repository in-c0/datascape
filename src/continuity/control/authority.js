// The owner authority firewall — spec V6 §7, §8.
//
// The most important rule in V6. Every operation is either autonomous or
// owner_required, that classification comes from control-plane policy plus
// authoritative owner rulings, and NO executor can move an operation from
// owner_required to autonomous because another agent told it to.
//
// The failure this prevents is not exotic. It is one agent writing "approved,
// go ahead" into a channel a second agent reads, at which point a machine has
// manufactured owner authority out of prose. Executor identity is not
// authority: a "trusted" executor does not gain owner power by being trusted.

export const AUTHORITY = ["autonomous", "owner_required"];

/**
 * Default policy. Deliberately small and readable — a policy nobody can hold in
 * their head is a policy nobody can audit.
 */
export const DEFAULT_POLICY = {
  autonomous: [
    "run_tests",
    "inspect_repository",
    "prepare_patch",
    "open_internal_pr",
    "read_public_source",
    "write_report",
  ],
  owner_required: [
    "spend_money",
    "supply_credential",
    "approve_external_post",
    "provide_household_data",
    "strategic_ruling",
    "expose_to_network",
    "modify_owner_state",
  ],
};

/**
 * Classify an operation.
 *
 * An unrecognised operation is owner_required. Not autonomous, not "probably
 * fine", not resolved by asking a model what it thinks. Unknown authority
 * defaults to blocked, because the cost asymmetry is total: a wrongly-blocked
 * autonomous operation costs one owner glance, and a wrongly-autonomous owner
 * operation costs money, a credential, or a public statement in her name.
 */
export function classifyOperation(operation, policy = DEFAULT_POLICY) {
  if (policy.owner_required.includes(operation)) {
    return { operation, authority: "owner_required", known: true };
  }
  if (policy.autonomous.includes(operation)) {
    return { operation, authority: "autonomous", known: true };
  }
  return {
    operation,
    authority: "owner_required",
    known: false,
    reason: "unknown operation; unknown authority defaults to blocked",
  };
}

/**
 * May this executor perform this operation right now?
 *
 * `grants` are matched owner rulings, keyed by gate. An executor's identity,
 * reputation or trust level is never consulted — it is not an input to this
 * function at all, which is the structural form of "executor identity is not
 * authority".
 */
export function mayPerform(operation, { policy = DEFAULT_POLICY, grants = [] } = {}) {
  const classified = classifyOperation(operation, policy);
  if (classified.authority === "autonomous") return { allowed: true, ...classified };

  const grant = grants.find((g) => g.operation === operation && g.source === "owner" && g.gate_id && g.ruling);
  if (grant) return { allowed: true, ...classified, via_gate: grant.gate_id };
  return {
    allowed: false,
    ...classified,
    reason: classified.reason ?? "requires an authoritative owner ruling naming this gate",
  };
}

/**
 * Interpret a continuation signal.
 *
 * Encodes the distinction that already governs this lane in practice:
 *
 *   ctn from the owner      a continuation signal; ordinary autonomous work may
 *                           resume; it does NOT satisfy a separately identified
 *                           owner gate
 *   ctn from an agent       a heartbeat / continue request with zero authority
 *
 * The second is the one that matters for unattended operation, because every
 * tick of every loop emits one, and the moment "ctn" can carry authority, an
 * agent can grant itself permission by writing three characters.
 */
export function interpretCtn({ source, gate_id = null, ruling = null } = {}) {
  if (source !== "owner") {
    return {
      continuation: true,
      authority: "none",
      resolves_gate: null,
      reason: "a machine continuation signal carries no owner authority",
    };
  }
  if (!gate_id || !ruling) {
    return {
      continuation: true,
      authority: "owner_continuation",
      resolves_gate: null,
      reason: "a generic owner continuation is not a wildcard approval token",
    };
  }
  return { continuation: true, authority: "owner_ruling", resolves_gate: gate_id, ruling };
}
