// The continuation intent and its state machine — spec V6 §1, §2.
//
// The unit of unattended work is an INTENT, never a chat session. "Send ctn to
// conversation X every six minutes" describes a keystroke, not work: it cannot
// say what is being attempted, cannot survive the death of that conversation,
// and cannot be reasoned about by a second executor. An intent can.
//
// A conversation is merely one executor surface. That is what allows:
//
//   session dies -> a compatible executor -> the SAME intent continues
//
// without pretending the new executor inherited a transcript it never read.

/** The closed work-state vocabulary. Nothing outside this list is a state. */
export const WORK_STATES = [
  "ready",
  "claimed",
  "running",
  "waiting",
  "blocked_on_owner",
  "blocked_external",
  "completed",
  "failed",
  "cancelled",
];

export const TERMINAL_STATES = ["completed", "failed", "cancelled"];

/**
 * `waiting` and `blocked_on_owner` are NOT two shades of "stuck".
 *
 *   waiting            no action is useful until some non-owner condition changes
 *   blocked_on_owner   progression requires an authoritative owner act or ruling
 *
 * The difference is the whole point of the firewall below. A machine may move
 * work out of `waiting` the moment a dependency changes. Nothing a machine can
 * emit — including a continuation signal — may move work out of
 * `blocked_on_owner`. That has to be impossible in the state machine itself,
 * not merely discouraged in a prompt, because prompts are exactly what an
 * unattended agent talks itself out of at 3am.
 */
export const OWNER_GATED_STATE = "blocked_on_owner";

const ALLOWED = {
  ready: ["claimed", "cancelled", "blocked_on_owner", "blocked_external", "waiting"],
  claimed: ["running", "ready", "cancelled", "blocked_on_owner"],
  running: ["waiting", "blocked_on_owner", "blocked_external", "completed", "failed", "ready"],
  waiting: ["ready", "blocked_on_owner", "cancelled"],
  blocked_external: ["ready", "blocked_on_owner", "cancelled"],
  // Exactly one exit, and it is gated below. Not two. Not "or cancelled by the
  // scheduler if it has been open a while".
  blocked_on_owner: ["ready", "cancelled"],
  completed: [],
  failed: ["ready"],
  cancelled: [],
};

export function createIntent(fields) {
  const required = ["intent_id", "semantic_centre", "goal", "success_condition"];
  for (const key of required) {
    if (!fields?.[key]) throw new Error(`continuation intent requires ${key}`);
  }
  return {
    intent_id: fields.intent_id,
    semantic_centre: fields.semantic_centre,
    goal: fields.goal,
    success_condition: fields.success_condition,
    current_operation: fields.current_operation ?? null,
    relevant_source_ids: [...(fields.relevant_source_ids || [])],
    open_dependencies: [...(fields.open_dependencies || [])],
    owner_gate_ids: [...(fields.owner_gate_ids || [])],
    preferred_executor: fields.preferred_executor ?? null,
    requires_capability: fields.requires_capability ?? null,
    state: WORK_STATES.includes(fields.state) ? fields.state : "ready",
    // Working state, not history. See bridge.js for what becomes immutable.
    attempt: fields.attempt ?? 0,
    materially_live: Boolean(fields.materially_live),
    unblocks: [...(fields.unblocks || [])],
    deadline: fields.deadline ?? null,
    created_at: fields.created_at ?? null,
    updated_at: fields.updated_at ?? fields.created_at ?? null,
  };
}

/**
 * Attempt a state transition.
 *
 * Returns `{ ok, intent, reason }` and never throws for a refused transition:
 * a refusal is an ordinary control-plane outcome that the caller must be able
 * to observe and record, not an exception to be swallowed by a retry loop.
 *
 * `ruling` is the ONLY way out of blocked_on_owner, and it must name the gate.
 */
export function transition(intent, next, { at = null, ruling = null, reason = null } = {}) {
  if (!WORK_STATES.includes(next)) {
    return { ok: false, intent, reason: `unknown work state: ${next}` };
  }
  if (!ALLOWED[intent.state].includes(next)) {
    return { ok: false, intent, reason: `illegal transition ${intent.state} -> ${next}` };
  }

  if (intent.state === OWNER_GATED_STATE && next !== "cancelled") {
    const check = ownerRulingSatisfies(intent, ruling);
    if (!check.ok) return { ok: false, intent, reason: check.reason };
  }

  return {
    ok: true,
    reason,
    intent: {
      ...intent,
      state: next,
      updated_at: at ?? intent.updated_at,
      // A resolved gate leaves the intent's gate list; an unresolved one does
      // not. Otherwise "the owner ruled on something" would gradually read as
      // "the owner ruled on everything".
      owner_gate_ids: ruling?.gate_id
        ? intent.owner_gate_ids.filter((g) => g !== ruling.gate_id)
        : [...intent.owner_gate_ids],
    },
  };
}

/**
 * Does this ruling actually release this intent?
 *
 * Three separate ways to say no, because three separate real mistakes:
 *
 *   - a machine-issued continuation claiming to be a ruling
 *   - a genuine owner continuation that named no gate (generic ctn is not a
 *     wildcard approval token; "ctn" typed at 1am is not "yes, spend $500")
 *   - an owner ruling on a DIFFERENT gate than the one holding this intent
 */
export function ownerRulingSatisfies(intent, ruling) {
  if (!ruling) return { ok: false, reason: "blocked_on_owner requires an authoritative owner ruling" };
  if (ruling.source !== "owner") {
    return { ok: false, reason: `only the owner may resolve an owner gate (source: ${ruling.source})` };
  }
  if (!ruling.gate_id) {
    return { ok: false, reason: "a generic owner continuation does not resolve a specific owner gate" };
  }
  if (!intent.owner_gate_ids.includes(ruling.gate_id)) {
    return { ok: false, reason: `ruling names gate ${ruling.gate_id}, which does not gate this intent` };
  }
  if (!ruling.ruling) return { ok: false, reason: "an owner gate requires a ruling, not an acknowledgement" };
  return { ok: true };
}
