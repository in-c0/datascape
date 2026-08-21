// The shadow control-plane mapping — spec V6 §16, PR B.
//
// Map the REAL DataScape continuation lanes into shadow intents and compare
// what the lanes do today against what V6 would have them do. Shadow means
// exactly what it meant in V3.2: observe, derive, report. Nothing is executed,
// no continuation message is sent, and no owner state is mutated. The output is
// evidence for the decision about whether PR C should ever exist, and it is
// worth nothing if producing it changed the thing it measured.
//
// GRANULARITY IS THE WHOLE DESIGN HERE. The first version of this file mapped
// one lane to one intent, and immediately reported three high-severity
// "continuing while owner-gated" findings. All three were false: a lane is a
// CONTAINER of work, and one open gate on one topic does not make everything
// else in that lane forbidden. That is precisely the mistake V6 §1 exists to
// prevent — the unit is the intent, not the session — and a mapping that gets
// it wrong manufactures alarming numbers out of its own modelling error.

import { createIntent } from "./intent.js";
import { classify } from "./scheduler.js";

/**
 * Derive the shadow intents for one lane.
 *
 * Two kinds come out:
 *
 *   trunk   the lane's ongoing continuation work, which is what a ctn tick
 *           actually advances
 *   gate    one intent per open owner exception filed under that lane, each
 *           blocked_on_owner and each naming its own gate
 *
 * The exception layer is the source of truth for gates. A lane's prose about
 * itself is not: a lane that says "waiting on the owner" while no exception
 * exists is a lane whose blocker never reached her at all.
 */
export function laneToIntents(lane, exceptions) {
  const gates = exceptions.filter((e) => e.status === "blocked-on-owner" && lanesMatch(e.loop, lane));

  const trunk = createIntent({
    intent_id: `shadow:${lane.lane}`,
    semantic_centre: lane.label || lane.lane,
    goal: lane.goal || lane.note || `continue ${lane.label || lane.lane}`,
    success_condition: lane.success_condition || "lane reaches its own stated completion",
    current_operation: lane.current_operation || null,
    // The trunk carries NO gate. Its gated work is separated out below, which
    // is the entire point: continuation of ungated work stays legitimate.
    owner_gate_ids: [],
    state: lane.status === "done" || lane.status === "stopped" ? "completed"
      : lane.status === "active" ? "ready" : "waiting",
    materially_live: lane.status === "active",
    created_at: lane.registeredAt || null,
    relevant_source_ids: lane.autoRunUrl ? [lane.autoRunUrl] : [],
    kind: "trunk",
  });

  const gateIntents = gates.map((gate) => createIntent({
    intent_id: `shadow:${lane.lane}:${gate.id}`,
    semantic_centre: lane.label || lane.lane,
    goal: gate.title || gate.loop || gate.id,
    success_condition: "the owner rules on this exception",
    owner_gate_ids: [gate.id],
    state: "blocked_on_owner",
    created_at: lane.registeredAt || null,
    kind: "owner_gate",
  }));

  return [{ ...trunk, kind: "trunk" }, ...gateIntents.map((g) => ({ ...g, kind: "owner_gate" }))];
}

/** Loop names are `<lane>/<topic>`; a lane owns every exception under its prefix. */
function lanesMatch(loop, lane) {
  if (!loop) return false;
  const prefix = String(loop).split("/")[0];
  const candidates = [lane.lane, ...(lane.aliases || [])].filter(Boolean);
  return candidates.some((c) => c === prefix || String(c).startsWith(`${prefix}-`) || prefix.startsWith(String(c)));
}

/**
 * Compare one shadow intent against what the lane is observably doing.
 *
 * `observed.gate_topics_progressed` is the only thing that could establish the
 * dangerous case — a lane continuing work that is owner-gated. The lane
 * registry does not record it, so when it is absent the comparison returns
 * `not_observable` rather than agreement. Reporting "no bypasses" from a source
 * that could not have shown one would be the same empty green as a harness that
 * passes on twenty blank frames.
 */
export function compareIntent(intent, observed = {}) {
  const desired = intent.state;
  const divergences = [];
  const unobservable = [];

  if (intent.kind === "owner_gate") {
    if (observed.gate_topics_progressed === undefined) {
      unobservable.push({
        intent_id: intent.intent_id,
        question: "did the lane progress work under this open gate?",
        reason: "the lane registry records continuation ticks, not per-topic work",
      });
    } else if (observed.gate_topics_progressed.includes(intent.owner_gate_ids[0])) {
      divergences.push({
        severity: "high",
        kind: "progressed_owner_gated_work",
        detail: `the lane advanced work under open gate ${intent.owner_gate_ids[0]}`,
      });
    }
    if (observed.owner_claim_without_exception) {
      divergences.push({
        severity: "high",
        kind: "owner_gate_only_in_prose",
        detail: "the lane describes an owner blocker that has no authoritative exception; chat prose does not reach her",
      });
    }
  } else {
    if (observed.polling && !observed.condition_based) {
      divergences.push({
        severity: "medium",
        kind: "polling_instead_of_condition",
        detail: "the lane wakes on a fixed timer where V6 would wake it on a declared condition",
      });
    }
    if (observed.continuing === false && desired === "ready") {
      divergences.push({
        severity: "medium",
        kind: "idle_while_actionable",
        detail: "V6 would schedule this lane; it is not currently progressing",
      });
    }
  }

  return {
    intent_id: intent.intent_id,
    kind: intent.kind,
    desired_state: desired,
    observed_state: observed.state ?? null,
    scheduling_class: desired === "ready" ? classify(intent) : null,
    owner_gate_ids: intent.owner_gate_ids,
    agrees: divergences.length === 0,
    divergences,
    unobservable,
  };
}

/**
 * Do the derived owner gates match the authoritative exception layer exactly?
 *
 * Both directions matter. A gate V6 invented would block real work for no
 * reason; a gate V6 dropped would let an executor proceed past something only
 * she may decide.
 */
export function auditOwnerGates(intents, exceptions) {
  const authoritative = new Set(exceptions.filter((e) => e.status === "blocked-on-owner").map((e) => e.id));
  const mapped = new Set(intents.flatMap((i) => i.owner_gate_ids));

  const invented = [...mapped].filter((id) => !authoritative.has(id));
  const unmapped = [...authoritative].filter((id) => !mapped.has(id));
  return {
    authoritative_gates: authoritative.size,
    mapped_gates: mapped.size,
    invented,
    // Unmapped is EXPECTED and is not a defect: most open exceptions belong to
    // projects that have no continuation lane at all. It is reported because a
    // silently growing number here would mean the lanes are drifting away from
    // the only surface the owner reads.
    unmapped_count: unmapped.length,
    unmapped_sample: unmapped.slice(0, 5),
    ok: invented.length === 0,
  };
}

export function buildShadowReport(lanes, exceptions, observations) {
  const intents = lanes.flatMap((lane) => laneToIntents(lane, exceptions));
  const comparisons = intents.map((intent) => compareIntent(intent, observations[intent.intent_id] || {}));

  const states = {};
  for (const intent of intents) states[intent.state] = (states[intent.state] || 0) + 1;

  return {
    lanes: lanes.length,
    shadow_intents: intents.length,
    trunk_intents: intents.filter((i) => i.kind === "trunk").length,
    owner_gate_intents: intents.filter((i) => i.kind === "owner_gate").length,
    states,
    comparisons,
    divergences: comparisons.flatMap((c) => c.divergences.map((d) => ({ intent_id: c.intent_id, ...d }))),
    // Questions this evidence source cannot answer. Named, not silently
    // counted as agreement.
    unobservable: comparisons.flatMap((c) => c.unobservable),
    owner_gate_audit: auditOwnerGates(intents, exceptions),
    // Structural facts about this run, not promises about it: this module has
    // no executor, no transport and no writer.
    executed_intents: 0,
    continuation_messages_sent: 0,
    owner_state_mutations: 0,
  };
}
