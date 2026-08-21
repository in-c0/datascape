// The V5 event bridge and the visualization mapping — spec V6 §13, §14.
//
// V6 does NOT create a second history system. Control-plane mutations emit
// canonical V5 events where they are historically meaningful, and stay
// ephemeral where they are not. The line is the same one V5 already drew for
// session heartbeats:
//
//   lease heartbeat  !=  semantic history
//
// A machine proving it is still alive is not a fact about the owner's work. If
// it were recorded, the history of a night's autonomous operation would be
// ninety-nine percent "still here" and one percent "here is what changed".

import { dedupe, normalizeEvent } from "../protocol/event.js";

/** Control-plane facts that are historically meaningful. */
export const MATERIAL = ["intent_created", "operation_completed", "blocked_on_owner", "material_failure", "goal_completed"];

/** Control-plane facts that are working state and must never become history. */
export const EPHEMERAL = ["lease_claimed", "lease_heartbeat", "lease_renewed", "lease_expired", "lease_released", "checkpoint_written", "scheduled"];

const KIND = {
  intent_created: "decision",
  operation_completed: "state",
  blocked_on_owner: "owner_action",
  material_failure: "finding",
  goal_completed: "state",
};

/**
 * Translate a control-plane mutation into zero or one canonical V5 event.
 *
 * Zero is the common case and the correct one. A mutation that is not in
 * MATERIAL produces `{ event: null, ephemeral: true }` — not an event with a
 * "minor" flag, because a flag is something a later query can accidentally
 * stop filtering on.
 */
export function toEvent(mutation, { source_system = "continuity.control" } = {}) {
  if (EPHEMERAL.includes(mutation.type)) {
    return { event: null, ephemeral: true, reason: `${mutation.type} is working state, not semantic history` };
  }
  if (!MATERIAL.includes(mutation.type)) {
    return { event: null, ephemeral: true, reason: `unknown control mutation: ${mutation.type}` };
  }
  if (mutation.type === "material_failure" && !mutation.material) {
    // Spec §4: an execution attempt ending unexpectedly is recorded only if
    // that fact is materially relevant. A closed browser is not.
    return { event: null, ephemeral: true, reason: "an execution attempt ended, which is not itself a semantic failure" };
  }

  const { event, rejected, reason } = normalizeEvent({
    source_system,
    // Identity is the intent plus the fact, NOT the attempt or lease. A
    // recovered execution that completes the same operation must produce the
    // same identity, so completion cannot be double-counted after a recovery.
    native_id: `${mutation.intent_id}:${mutation.type}${mutation.operation_id ? `:${mutation.operation_id}` : ""}`,
    lane_id: mutation.lane_id ?? null,
    occurred_at: mutation.at,
    kind: KIND[mutation.type],
    text: mutation.text,
    authorship: "agent",
    execution: mutation.type === "goal_completed" || mutation.type === "operation_completed" ? "completed" : "live",
    // Autonomous continuation is scheduler-triggered, and saying so honestly is
    // what keeps `unattended` supervision meaningful downstream.
    trigger: mutation.trigger ?? "scheduler",
    owner_action_ref: mutation.owner_gate_id ?? null,
    relations: mutation.relations || [],
  });
  if (rejected) return { event: null, ephemeral: false, rejected: true, reason };
  return { event, ephemeral: false };
}

/**
 * Bridge a run of mutations.
 *
 * Deduplicated, so a material completion that is reported twice — once by the
 * executor that did it and once by the executor that recovered the intent —
 * creates exactly one immutable event.
 */
export function bridge(mutations, options = {}) {
  const events = [];
  const ephemeral = [];
  const rejected = [];
  for (const mutation of mutations) {
    const result = toEvent(mutation, options);
    if (result.event) events.push(result.event);
    else if (result.rejected) rejected.push({ mutation, reason: result.reason });
    else ephemeral.push({ type: mutation.type, reason: result.reason });
  }
  const { events: canonical } = dedupe(events);
  return { events: canonical, ephemeral, rejected };
}

// ---- Visualization mapping (§14) ---------------------------------------------
//
// No UI in V6 PR A. Defining the mapping now is still worth doing, because it
// is what stops the control plane from growing fields that could only ever be
// rendered as a table of leases.

export const PROJECTION = {
  ready: "live_working_cognition",
  claimed: "live_working_cognition",
  running: "live_working_cognition",
  blocked_on_owner: "needs_you",
  waiting: "hidden_at_coarse_altitude",
  blocked_external: "hidden_at_coarse_altitude",
  completed: "historical_consequence",
  failed: "promoted_only_if_material",
  cancelled: "hidden_at_coarse_altitude",
};

/**
 * What the owner sees at coarse altitude.
 *
 * Never "83 leases". The control plane's internals are the least interesting
 * true thing available; the whole V6 exercise is only worth doing if it still
 * resolves to a handful of sentences about her actual work.
 */
export function coarseProjection(intents, { limit = 5 } = {}) {
  const groups = new Map();
  for (const intent of intents) {
    const projection = PROJECTION[intent.state];
    if (projection === "hidden_at_coarse_altitude") continue;
    if (projection === "promoted_only_if_material" && !intent.materially_live) continue;
    const key = intent.semantic_centre;
    const entry = groups.get(key) || { semantic_centre: key, needs_you: false, moving: false, settled: false, count: 0 };
    if (projection === "needs_you") entry.needs_you = true;
    if (projection === "live_working_cognition") entry.moving = true;
    if (projection === "historical_consequence") entry.settled = true;
    entry.count += 1;
    groups.set(key, entry);
  }
  // Needs-you first: it is the only category that costs her anything to miss.
  return [...groups.values()]
    .sort((a, b) => Number(b.needs_you) - Number(a.needs_you) || b.count - a.count)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      phrase: entry.needs_you ? `${entry.semantic_centre} blocked on you`
        : entry.moving ? `${entry.semantic_centre} moving`
          : `${entry.semantic_centre} settled`,
    }));
}
