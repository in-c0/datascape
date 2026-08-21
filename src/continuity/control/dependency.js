// Dependency wakeups — spec V6 §9.
//
// Do not poll every blocked intent every six minutes. That is not a scheduler,
// it is a metronome: it burns budget in proportion to how much work is STUCK,
// which is precisely backwards, and it produces a stream of "still blocked"
// ticks that make the loop look busy while nothing moves.
//
// An intent instead declares the CONDITION under which it becomes actionable.
// Where a source cannot push, bounded polling is an acceptable implementation
// of that condition — but the model stays condition-based, so the polling is an
// adapter detail rather than the architecture.

export const DEPENDENCY_TYPES = [
  "github_pr_merged",
  "credential_available",
  "owner_gate_resolved",
  "time_reached",
  "external_artifact_exists",
  "upstream_intent_completed",
];

export function createDependency({ type, ref, condition = null }) {
  if (!DEPENDENCY_TYPES.includes(type)) throw new Error(`unknown dependency type: ${type}`);
  if (!ref) throw new Error("a dependency requires a ref");
  return { type, ref, condition, satisfied: false, woke: false };
}

/**
 * The wakeup registry.
 *
 * "Exactly once" is the invariant that matters. A dependency that fires twice
 * produces two claims on the same intent and, downstream, two attempts at the
 * same side effect — so satisfaction is recorded on the edge itself, not
 * inferred by re-reading the world each tick.
 */
export function createDependencyGraph() {
  /** intent_id -> dependency[] */
  const byIntent = new Map();

  return {
    register(intentId, dependencies) {
      byIntent.set(intentId, dependencies.map((d) => ({ ...d })));
    },

    /**
     * Mark a real-world condition satisfied and report which intents that wakes.
     *
     * An intent wakes only when ALL of its dependencies are satisfied, and only
     * the first time. Later notifications about the same ref are observed and
     * discarded rather than re-firing.
     */
    satisfy(type, ref) {
      const woken = [];
      for (const [intentId, deps] of byIntent) {
        let touched = false;
        for (const dep of deps) {
          if (dep.type === type && dep.ref === ref && !dep.satisfied) {
            dep.satisfied = true;
            touched = true;
          }
        }
        if (!touched) continue;
        if (deps.every((d) => d.satisfied) && !deps.some((d) => d.woke)) {
          deps.forEach((d) => { d.woke = true; });
          woken.push(intentId);
        }
      }
      return woken;
    },

    open(intentId) {
      return (byIntent.get(intentId) || []).filter((d) => !d.satisfied);
    },

    /**
     * An owner gate is a dependency like any other in shape, and unlike any
     * other in authority: only the exception layer may satisfy it. Routing it
     * through this method rather than `satisfy` keeps that asymmetry visible.
     */
    satisfyOwnerGate(gateId, ruling) {
      if (ruling?.source !== "owner" || ruling?.gate_id !== gateId || !ruling?.ruling) {
        return { ok: false, woken: [], reason: "an owner gate is satisfied only by a matching authoritative ruling" };
      }
      return { ok: true, woken: this.satisfy("owner_gate_resolved", gateId) };
    },

    snapshot() {
      return [...byIntent.entries()].map(([intent_id, deps]) => ({ intent_id, dependencies: deps.map((d) => ({ ...d })) }));
    },
  };
}
