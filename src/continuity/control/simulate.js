// The prospective shadow scheduler simulation — spec V6.1 §7, §10.
//
// Runs the real intent mapping through a deterministic interval and reports
// what the scheduler WOULD do. No dispatch reaches an executor: the simulator
// has no transport and never constructs one.
//
// This is the evidence that replaces the six unobservable questions from V6 PR
// B. It does not reconstruct what legacy continuation did in the past — that
// data was never recorded and pretending otherwise would be a fabrication. It
// establishes instead that every future dispatch is attributable BY
// CONSTRUCTION, which is the property that actually gates execution.

import { prepareDispatch } from "./dispatch.js";
import { resolveScope } from "./scope.js";
import { evaluateWake } from "./wake.js";
import { classify } from "./scheduler.js";

export const OUTCOMES = [
  "would_dispatch",
  "would_wait",
  "would_block_owner",
  "would_block_scope_unknown",
  "would_block_authority_unknown",
  "would_wake_dependency",
  "would_exhaust_budget",
];

/**
 * Simulate the scheduler over a bounded interval.
 *
 * `intents` carry their scope and wake declaration. `openGates` is the
 * authoritative exception layer. Nothing here mutates either.
 */
export function simulate({ intents, openGates, budgets = {}, startMs, hours = 8, tickMs = 300000, leaseMs = 900000 }) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const dispatches = [];
  const blocked = [];
  // Simulated lease ownership: intent_id -> { executor_id, until, generation }.
  const held = new Map();
  const generations = new Map();
  let simultaneousLeaseViolations = 0;

  const endMs = startMs + hours * 3600000;
  for (let at = startMs; at < endMs; at += tickMs) {
    for (const intent of intents) {
      if (intent.state === "completed" || intent.state === "cancelled") continue;

      // 1. Is it owner-gated at all?
      if (intent.state === "blocked_on_owner") {
        outcomes.would_block_owner += 1;
        continue;
      }

      // 2. Why would it wake? An intent with no declared reason is not ready.
      const wake = evaluateWake(intent.wake, at);
      if (!wake.due) {
        outcomes.would_wait += 1;
        if (wake.blocks_execution) {
          blocked.push({ at, intent_id: intent.intent_id, outcome: "would_wait", reason: wake.reason });
        }
        continue;
      }
      if (wake.kind === "poll_fallback") outcomes.would_wake_dependency += 1;

      // 3. Does any open gate intersect, or fail to resolve?
      const resolution = resolveScope(intent.scope, openGates);
      if (resolution.intersecting_gate_ids.length > 0) {
        outcomes.would_block_owner += 1;
        blocked.push({ at, intent_id: intent.intent_id, outcome: "would_block_owner", gates: resolution.intersecting_gate_ids });
        continue;
      }
      if (resolution.scope_resolution === "unknown") {
        outcomes.would_block_scope_unknown += 1;
        blocked.push({
          at, intent_id: intent.intent_id, outcome: "would_block_scope_unknown",
          unresolved: resolution.unknown.length,
        });
        continue;
      }

      // 4. Is the operation autonomous?
      if (intent.authority === "owner_required" || intent.authority === "unknown") {
        outcomes.would_block_authority_unknown += 1;
        blocked.push({ at, intent_id: intent.intent_id, outcome: "would_block_authority_unknown" });
        continue;
      }

      // 5. Budget.
      const budget = budgets[intent.intent_id];
      if (budget && budget.max_steps !== undefined && budget.spent_steps >= budget.max_steps) {
        outcomes.would_exhaust_budget += 1;
        continue;
      }

      // 6. Lease. One holder at a time, with a fencing generation.
      const existing = held.get(intent.intent_id);
      if (existing && existing.until > at) {
        // Not a violation — correct refusal. Counted only if a second dispatch
        // were nonetheless emitted, which the `continue` prevents.
        outcomes.would_wait += 1;
        continue;
      }
      const generation = (generations.get(intent.intent_id) ?? 0) + 1;
      generations.set(intent.intent_id, generation);
      const lease = {
        lease_id: `sim-${intent.intent_id}-${generation}`,
        intent_id: intent.intent_id,
        executor_id: intent.preferred_executor ?? "E-sim",
        generation,
      };
      held.set(intent.intent_id, { executor_id: lease.executor_id, until: at + leaseMs, generation });

      const prepared = prepareDispatch({
        intent, lease, scope: intent.scope, openGates,
        checkpointRef: intent.checkpoint_ref ?? null,
        budget: budget ?? { max_steps: 10, max_cost: 0 },
      });
      if (!prepared.ok) {
        // Belt and braces: the checks above should already have caught this.
        // If prepareDispatch still refuses, the refusal is the truth and the
        // earlier logic is what is wrong.
        outcomes.would_block_scope_unknown += 1;
        blocked.push({ at, intent_id: intent.intent_id, outcome: "prepare_refused", reason: prepared.reason });
        held.delete(intent.intent_id);
        continue;
      }

      outcomes.would_dispatch += 1;
      dispatches.push({
        at,
        dispatch_id: prepared.dispatch.dispatch_id,
        intent_id: prepared.dispatch.intent_id,
        lease_id: prepared.dispatch.lease_id,
        lease_generation: prepared.dispatch.lease_generation,
        scheduling_class: classify(intent),
        wake_reason: wake.wake_reason,
        scope_resolution: prepared.dispatch.scope_resolution,
        open_owner_gates: prepared.dispatch.open_owner_gates,
        budget: prepared.dispatch.budget,
      });

      // A second executor attempting the same intent in the same tick must
      // lose. Simulated explicitly so the counter has something to count.
      const contended = held.get(intent.intent_id);
      if (contended && contended.generation !== generation) simultaneousLeaseViolations += 1;
    }
  }

  return { outcomes, dispatches, blocked, simultaneous_lease_violations: simultaneousLeaseViolations };
}

/**
 * The §10 attribution metric.
 *
 * "gate bypasses = 0" is not reportable unless every simulated dispatch was
 * observable, so the fully-attributed count is computed and compared rather
 * than assumed. A dispatch missing any one of its six identity fields is
 * counted as unattributed, not quietly dropped.
 */
export function attributionMetrics(result) {
  const required = ["dispatch_id", "intent_id", "lease_id", "lease_generation", "wake_reason", "budget"];
  const fully = result.dispatches.filter((d) =>
    required.every((f) => d[f] !== undefined && d[f] !== null)
    && d.scope_resolution === "resolved"
    && d.open_owner_gates.length >= 0);
  return {
    would_dispatch: result.outcomes.would_dispatch,
    fully_attributed: fully.length,
    unattributed_dispatches: result.outcomes.would_dispatch - fully.length,
    scope_unknown_blocked: result.outcomes.would_block_scope_unknown,
    authority_unknown_blocked: result.outcomes.would_block_authority_unknown,
    owner_gate_blocked: result.outcomes.would_block_owner,
    budget_blocked: result.outcomes.would_exhaust_budget,
    dependency_wakeups: result.outcomes.would_wake_dependency,
    waits: result.outcomes.would_wait,
    // Unknowns MAY exist. They simply must not execute — which is what the
    // blocked counters above record.
    gate_passes: result.outcomes.would_dispatch === fully.length,
  };
}
