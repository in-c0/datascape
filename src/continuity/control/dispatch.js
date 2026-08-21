// Scoped dispatch, acknowledgement and execution receipts — spec V6.1 §1, §3,
// §4, §5.
//
// The gap V6 left open: the scheduler could decide WHICH intent should run, but
// if the execution adapter then sent a bare `ctn` into a session containing
// several topics, the control plane had constrained only its own intention. The
// remote executor still received a lane-wide continuation signal and could
// work on anything in that session — including a topic behind an owner gate.
//
// So generic `ctn` stops being an execution primitive. A dispatch is a
// structured, single-intent unit; the natural language an executor reads is
// GENERATED from it, and the structure remains authoritative.

import { resolveScope } from "./scope.js";

export const DISPATCH_STATES = ["prepared", "sent", "acknowledged", "running", "settled", "abandoned"];

/**
 * Prepare a dispatch.
 *
 * Refuses rather than degrades. An unresolved scope, an intersecting gate or a
 * missing lease produces `{ ok: false }` with a reason — never a dispatch with
 * a warning attached, because a warning is something a busy adapter logs and
 * proceeds past.
 */
export function prepareDispatch({ intent, lease, scope, openGates = [], checkpointRef = null, budget, operationPolicy = "autonomous_only" }) {
  if (!lease || lease.intent_id !== intent.intent_id) {
    return { ok: false, reason: "a dispatch requires an active lease for this intent" };
  }
  if (intent.state === "blocked_on_owner") {
    return { ok: false, reason: "an owner-gated intent is never dispatched" };
  }
  const resolution = resolveScope(scope, openGates);
  if (!resolution.dispatchable) {
    return { ok: false, reason: resolution.reason, scope_resolution: resolution.scope_resolution, resolution };
  }

  const dispatch = {
    dispatch_id: `${intent.intent_id}#${lease.lease_id}:${lease.generation ?? lease.attempt}`,
    intent_id: intent.intent_id,
    lease_id: lease.lease_id,
    // The fencing token travels WITH the dispatch, so a result can be checked
    // against the generation that produced it rather than against whatever
    // generation happens to be current when it arrives.
    lease_generation: lease.generation ?? lease.attempt,
    semantic_centre: intent.semantic_centre,
    goal: intent.goal,
    current_operation: intent.current_operation,
    success_condition: intent.success_condition,
    allowed_scope: {
      semantic_centre: scope.semantic_centre,
      topic_refs: [...scope.topic_refs],
      source_refs: [...scope.source_refs],
    },
    // Open gates travel as CONSTRAINTS and context. Never their rulings, never
    // their secrets. Telling an executor "G17 is unresolved and outside your
    // authority" narrows what it may do; handing it the ruling would widen it.
    open_owner_gates: openGates.map((g) => g.id),
    checkpoint_ref: checkpointRef,
    budget,
    operation_policy: operationPolicy,
    state: "prepared",
    scope_resolution: resolution.scope_resolution,
  };
  return { ok: true, dispatch };
}

/**
 * Render the executor-facing instruction.
 *
 * Generated FROM the structure, and materially different from `ctn`: it names
 * the intent, bounds the work, names the gates that are outside the executor's
 * authority, and says where evidence must be recorded.
 */
export function renderInstruction(dispatch) {
  const lines = [
    `Continue intent ${dispatch.intent_id}: ${dispatch.current_operation || dispatch.goal}.`,
    `Work only toward this intent (${dispatch.semantic_centre}).`,
  ];
  if (dispatch.open_owner_gates.length) {
    lines.push(`Owner gate(s) ${dispatch.open_owner_gates.join(", ")} remain unresolved and are outside your authority.`);
  }
  lines.push(`Record resulting events against ${dispatch.intent_id}.`);
  return lines.join(" ");
}

/**
 * The dispatch lifecycle.
 *
 * `claimed -> sent -> acknowledged -> running`. The acknowledgement step is not
 * ceremony: without it, "we sent a message" silently becomes "an agent is
 * working on it", and a lease burns its whole term on an executor that never
 * received anything.
 */
export function createDispatchTracker({ now, ackTimeoutMs = 120000 }) {
  if (typeof now !== "function") throw new Error("a clock function is required");
  const dispatches = new Map();

  return {
    send(dispatch) {
      const record = { ...dispatch, state: "sent", sent_at: now(), acknowledged_at: null };
      dispatches.set(dispatch.dispatch_id, record);
      return record;
    },

    /**
     * Acknowledge.
     *
     * The acknowledgement must name the intent AND the lease. An adapter for a
     * system that cannot return structure may derive this from an explicitly
     * correlated first event — correlated by identity or reference, never by
     * prose that reads like it might be about the same thing.
     */
    acknowledge(dispatchId, { intent_id, lease_id } = {}) {
      const record = dispatches.get(dispatchId);
      if (!record) return { ok: false, reason: "no such dispatch" };
      if (record.intent_id !== intent_id || record.lease_id !== lease_id) {
        return { ok: false, reason: "acknowledgement does not match the dispatched intent and lease" };
      }
      record.state = "acknowledged";
      record.acknowledged_at = now();
      return { ok: true, dispatch: record };
    },

    start(dispatchId) {
      const record = dispatches.get(dispatchId);
      if (!record) return { ok: false, reason: "no such dispatch" };
      if (record.state !== "acknowledged") {
        return { ok: false, reason: "a dispatch may not run before it is acknowledged" };
      }
      record.state = "running";
      return { ok: true, dispatch: record };
    },

    /**
     * Dispatches that were sent and never acknowledged.
     *
     * They become RECOVERABLE, not failed — the same rule as an expired lease.
     * Assuming the agent is working is the failure mode this replaces.
     */
    unacknowledged(at = now()) {
      return [...dispatches.values()]
        .filter((d) => d.state === "sent" && at - d.sent_at >= ackTimeoutMs)
        .map((d) => ({ dispatch_id: d.dispatch_id, intent_id: d.intent_id, recoverable: true }));
    },

    get(dispatchId) {
      const record = dispatches.get(dispatchId);
      return record ? { ...record } : null;
    },

    all() {
      return [...dispatches.values()].map((d) => ({ ...d }));
    },
  };
}

// ---- Execution receipts (§3) --------------------------------------------------

export const ATTRIBUTION = ["attributed", "unknown"];

/**
 * Attribute a result returned by an executor.
 *
 * The unattributed case is the whole point. A result that cannot be tied to the
 * active intent may still be perfectly good evidence and may enter V5 as a
 * source record — but it cannot complete the intent, advance its checkpoint,
 * satisfy its success condition, consume its owner gate, or claim its operation
 * completed. Evidence and authority are separated here, permanently.
 */
export function attributeResult(result, { dispatch, currentGeneration }) {
  const problems = [];
  if (!result?.dispatch_id || result.dispatch_id !== dispatch?.dispatch_id) problems.push("dispatch_id does not match");
  if (!result?.intent_id || result.intent_id !== dispatch?.intent_id) problems.push("intent_id does not match the dispatch");
  if (!result?.lease_id || result.lease_id !== dispatch?.lease_id) problems.push("lease_id does not match the dispatch");
  if (!result?.executor_id) problems.push("no executor_id");

  const stale = Number.isFinite(result?.lease_generation) && Number.isFinite(currentGeneration)
    && result.lease_generation < currentGeneration;

  const attribution = problems.length === 0 ? "attributed" : "unknown";
  return {
    execution_attribution: attribution,
    // Fencing (§9): a late writer from an older generation keeps its evidence
    // and loses its authority. Compare-and-swap at claim time cannot stop a
    // result that was already in flight when the lease turned over.
    stale_generation: stale,
    may_record_as_evidence: Boolean(result?.produced_event_ids?.length || result?.text),
    may_settle_intent: attribution === "attributed" && !stale,
    problems,
  };
}

/**
 * Can this result settle the intent?
 *
 * Separated from `attributeResult` so the refusal reason is explicit at the
 * call site rather than implied by a boolean.
 */
export function settlementDecision(attribution) {
  if (attribution.stale_generation) {
    return { settle: false, record_evidence: attribution.may_record_as_evidence, reason: "result is from a superseded lease generation" };
  }
  if (attribution.execution_attribution !== "attributed") {
    return { settle: false, record_evidence: attribution.may_record_as_evidence, reason: `unattributed result: ${attribution.problems.join("; ")}` };
  }
  return { settle: true, record_evidence: true, reason: null };
}

/**
 * A machine statement about an owner gate (§5).
 *
 * "I decided G17 is unnecessary" is preserved as an authored agent observation
 * — it is a real thing that was said — and carries exactly zero authority over
 * the gate. Both halves matter: discarding it would lose evidence, and acting
 * on it would let an executor approve its own blocker.
 */
export function machineGateStatement(statement) {
  return {
    recorded_as: "agent_observation",
    text: statement.text,
    gate_id: statement.gate_id ?? null,
    resolves_gate: false,
    authority: "none",
    reason: "only a matching gate_id plus an authoritative owner ruling changes gate state",
  };
}
