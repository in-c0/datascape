// Work declarations, proposal and deterministic admission — spec V6.1.3 §3–§9,
// §12.
//
// Three verbs, three owners, and they must never collapse into each other:
//
//   proposeWork   the source agent  "the next bounded thing I can do is X"
//   admitWork     the control plane "X is admitted for autonomous execution"
//   executeWork   the executor      only after lease + dispatch
//
// The key ruling in V6.1.3 §4: agents MAY author operational decomposition.
// Requiring every concrete operation to pre-exist in owner-authored text would
// mean the system could never decide "run one more browser regression against
// this head" — which is not autonomy, it is remote control. What an agent may
// not author is the underlying GOAL, or any expansion of its authority.

import { operationWithinEnvelope, scopeWithinGoal } from "./goal.js";
import { createIntent } from "./intent.js";
import { createScope, resolveScope } from "./scope.js";
import { validatePolicy } from "./topic.js";

export const ADMISSION = [
  "admitted",
  "blocked_owner",
  "blocked_scope",
  "blocked_authority",
  "blocked_dependency",
  "invalid",
  "unknown",
];

export function createWorkDeclaration({
  declaration_id,
  goal_id,
  authored_by,
  semantic_centre_refs = [],
  operation,
  success_condition,
  scope_refs = [],
  scope_provenance_refs = [],
  dependency_refs = [],
  expected_side_effects = [],
  authority_requirements = [],
  proposed_policy = { kind: "finite" },
  estimated_budget = null,
  created_at = null,
  expires_at = null,
  supersedes_declaration_id = null,
}) {
  if (!declaration_id) throw new Error("a work declaration requires declaration_id");
  if (!["agent", "system", "owner"].includes(authored_by)) {
    throw new Error(`unknown authorship: ${authored_by}`);
  }
  return {
    declaration_id,
    goal_id,
    authored_by,
    semantic_centre_refs: [...semantic_centre_refs],
    operation,
    success_condition,
    scope_refs: [...scope_refs],
    scope_provenance_refs: [...scope_provenance_refs],
    dependency_refs: [...dependency_refs],
    expected_side_effects: [...expected_side_effects],
    authority_requirements: [...authority_requirements],
    proposed_policy,
    estimated_budget,
    created_at,
    expires_at,
    supersedes_declaration_id,
    state: "proposed",
  };
}

/**
 * The proposal substrate (§12).
 *
 * Writes ONLY the declaration. Never a dispatch, never an intent, never a
 * lease. An agent may call this freely within its reporting contract, and
 * calling it a thousand times produces a thousand proposals and zero
 * authority — which is the property that makes it safe to expose.
 */
export function createProposalStore() {
  const declarations = new Map();

  return {
    proposeWork(declaration) {
      if (declaration.supersedes_declaration_id) {
        const prior = declarations.get(declaration.supersedes_declaration_id);
        // Supersession before execution is ordinary and expected (§8): an agent
        // reconsidering its next operation is thinking, not failing.
        if (prior && prior.state === "proposed") prior.state = "superseded";
      }
      declarations.set(declaration.declaration_id, { ...declaration });
      return { ok: true, declaration_id: declaration.declaration_id, dispatched: false, intent_created: false };
    },

    /** Proposals are working state, not semantic history (§7). */
    emitsSemanticHistory: false,

    expire(at) {
      const expired = [];
      for (const d of declarations.values()) {
        if (d.state === "proposed" && d.expires_at && Date.parse(d.expires_at) <= at) {
          d.state = "expired";
          expired.push(d.declaration_id);
        }
      }
      return expired;
    },

    active() {
      return [...declarations.values()].filter((d) => d.state === "proposed");
    },

    get(id) {
      const d = declarations.get(id);
      return d ? { ...d } : null;
    },

    all() {
      return [...declarations.values()].map((d) => ({ ...d }));
    },
  };
}

/**
 * Deterministic admission (§5).
 *
 * Not a judgement call and not a model call: a fixed sequence of checks, each
 * of which can only narrow the outcome. Any unknown affecting authority makes
 * the declaration non-executable, consistent with every other decision in this
 * control plane.
 */
export function admitWorkDeclaration(declaration, goal, { openGates = [], goalAuthority = null, satisfiedDependencies = [], policy = null } = {}) {
  const reject = (outcome, reason) => ({ outcome, admitted: false, intent: null, reason });

  // 1. A valid authoritative goal. Without this the agent would be granting
  //    itself the strategic envelope, which is the entire thing V6.1.3 forbids.
  if (!goal) return reject("blocked_authority", "the declaration names no goal");
  if (declaration.goal_id !== goal.goal_id) return reject("invalid", "the declaration names a different goal");
  if (goalAuthority && goalAuthority.authority === "absent") {
    return reject("blocked_authority", "no authoritative source establishes this goal");
  }

  // 2. A concrete operation and a testable success condition.
  if (!declaration.operation) return reject("invalid", "no concrete operation");
  if (!declaration.success_condition || String(declaration.success_condition).trim().length < 8) {
    return reject("invalid", "the success condition is not testable or observable");
  }

  // 3. Resolvable scope provenance. What existing evidence says this is real?
  if (declaration.scope_provenance_refs.length === 0) {
    return reject("invalid", "no scope provenance; nothing establishes that this work unit exists");
  }

  // 4. Inside the goal's allowed scope and outside its prohibited scope.
  const scoped = scopeWithinGoal(goal, declaration.scope_refs);
  if (!scoped.within) {
    return reject(scoped.outcome === "unknown" ? "unknown" : "blocked_scope", scoped.reason);
  }

  // 5. The operation is autonomous under this goal's envelope.
  const envelope = operationWithinEnvelope(goal, declaration.operation);
  if (!envelope.within) {
    return reject(envelope.authority === "owner_required" ? "blocked_owner" : "blocked_authority", envelope.reason);
  }
  if (declaration.authority_requirements.length > 0) {
    return reject("blocked_owner", `the operation requires ${declaration.authority_requirements.join(", ")}`);
  }

  // 6. No intersecting or unresolved owner gate.
  const scope = createScope({
    semantic_centre: declaration.semantic_centre_refs[0] || goal.statement,
    semantic_centre_refs: declaration.semantic_centre_refs,
    topic_refs: declaration.scope_refs,
    dependency_refs: declaration.dependency_refs,
    scope_provenance_refs: declaration.scope_provenance_refs,
    completeness: declaration.scope_completeness || "partial",
  });
  const resolution = resolveScope(scope, openGates);
  if (resolution.intersecting_gate_ids.length) {
    return reject("blocked_owner", `blocked by owner gate(s) ${resolution.intersecting_gate_ids.join(", ")}`);
  }
  if (resolution.scope_resolution === "unknown") {
    return reject("unknown", resolution.reason);
  }

  // 7. Budget admissible under the goal's envelope.
  const budget = declaration.estimated_budget || {};
  const maxCost = goal.autonomy_policy?.max_cost ?? 0;
  if ((budget.max_cost ?? 0) > maxCost) {
    return reject("blocked_authority", `estimated cost exceeds the goal's autonomous budget`);
  }
  if (goal.autonomy_policy?.max_wall_time_ms && (budget.max_wall_time_ms ?? Infinity) > goal.autonomy_policy.max_wall_time_ms) {
    return reject("blocked_authority", "estimated wall time exceeds the goal's autonomous budget");
  }

  // 8. Dependencies satisfied or at least representable.
  const unmet = declaration.dependency_refs.filter((d) => !satisfiedDependencies.includes(d));
  if (unmet.length) return reject("blocked_dependency", `unmet dependencies: ${unmet.join(", ")}`);

  // 9. A recurring declaration must be a valid recurring policy (§9).
  const proposed = policy || declaration.proposed_policy;
  if (proposed?.kind === "recurring") {
    const valid = validatePolicy(proposed);
    if (!valid.ok) return reject("invalid", valid.problems.join("; "));
  }

  const intent = {
    ...createIntent({
      intent_id: `intent:${declaration.declaration_id}`,
      semantic_centre: scope.semantic_centre,
      goal: goal.statement,
      success_condition: declaration.success_condition,
      current_operation: declaration.operation,
      owner_gate_ids: [],
      state: "ready",
      created_at: declaration.created_at,
      relevant_source_ids: declaration.scope_provenance_refs,
    }),
    role: "executable",
    executable: true,
    goal_id: goal.goal_id,
    declaration_id: declaration.declaration_id,
    scope,
    authority: "autonomous",
    continuation_policy: proposed,
  };
  return { outcome: "admitted", admitted: true, intent, reason: null };
}

/**
 * Admission is the ONLY thing that creates an executable intent.
 *
 * Stated as a checkable property rather than a comment: the proposal store
 * exposes no admit, no dispatch and no execute, so an agent holding one cannot
 * reach execution by any path through this module.
 */
export function proposalCapabilities(store) {
  return {
    can_propose: typeof store.proposeWork === "function",
    can_admit: typeof store.admitWork === "function",
    can_dispatch: typeof store.dispatch === "function",
    can_execute: typeof store.execute === "function",
  };
}
