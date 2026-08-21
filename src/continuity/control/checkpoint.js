// The checkpoint contract — spec V6 §5, §6.
//
// A checkpoint is what lets executor B pick up executor A's work without ever
// reading A's transcript. It is therefore BOUNDED and interoperable by
// construction: references and operational context, never a conversation.
//
// The temptation is obvious and must be refused: dumping the transcript would
// make handoff trivially "work". It would also mean every checkpoint carries
// unbounded private reasoning, redaction becomes impossible, size is unbounded,
// and the handoff quietly depends on one vendor's chat format. V5 already
// settled this for events; V6 inherits it for control state.

const FIELDS = [
  "intent_id",
  "lease_id",
  "semantic_centre",
  "current_operation",
  "last_settled_event_ids",
  "working_state_ref",
  "produced_event_ids",
  "unresolved_questions",
  "dependency_refs",
  "owner_gate_ids",
  "next_safe_action",
  // Scope observability (spec V6.1.2 section 11). Without these, "the scope
  // changed materially during work" is a matter of opinion; with them it is a
  // hash comparison.
  "scope_hash",
  "scope_provenance_refs",
  "gate_overlap_evaluation",
];

/** Fields that would smuggle a transcript or hidden reasoning back in. */
const FORBIDDEN = ["transcript", "messages", "conversation", "chain_of_thought", "reasoning", "scratchpad", "history_dump"];

export function createCheckpoint(fields) {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN.includes(key)) throw new Error(`a checkpoint may not carry ${key}`);
  }
  const checkpoint = {};
  for (const key of FIELDS) {
    const value = fields[key];
    checkpoint[key] = Array.isArray(value) ? [...value] : value ?? null;
  }
  for (const key of ["last_settled_event_ids", "produced_event_ids", "unresolved_questions", "dependency_refs", "owner_gate_ids", "scope_provenance_refs"]) {
    if (!Array.isArray(checkpoint[key])) checkpoint[key] = [];
  }
  return checkpoint;
}

/**
 * Validate a checkpoint against the contract.
 *
 * `next_safe_action` is OPERATIONAL context — "rerun the browser verification
 * against head 4ab..." — not private reasoning about why. The distinction is
 * enforced by length and shape rather than by trust: anything paragraph-sized
 * is prose, and prose in this field is a transcript wearing a hat.
 */
export function validateCheckpoint(checkpoint) {
  const problems = [];
  if (!checkpoint.intent_id) problems.push("missing intent_id");
  if (!checkpoint.semantic_centre) problems.push("missing semantic_centre");
  if (!checkpoint.next_safe_action) problems.push("missing next_safe_action");

  for (const key of Object.keys(checkpoint)) {
    if (!FIELDS.includes(key)) problems.push(`field outside the checkpoint contract: ${key}`);
  }
  const action = checkpoint.next_safe_action || "";
  if (typeof action === "string" && (action.length > 240 || action.split(/\n/).length > 2)) {
    problems.push("next_safe_action is prose, not an operational next step");
  }
  return { ok: problems.length === 0, problems };
}

/** Does a checkpoint contain any transcript-shaped payload? The blunt check. */
export function containsTranscript(checkpoint) {
  const serialized = JSON.stringify(checkpoint);
  if (serialized.length > 8000) return true;

  // A transcript does not arrive as a nested OBJECT — the contract already
  // refuses those field names. It arrives as a string: one executor JSON-encodes
  // its messages into working_state_ref and hands them over "as a reference".
  // Escaped quoting means a naive /"role":/ never fires, so unescape first, and
  // keep unescaping while it still changes: two encodings hide as easily as one.
  let text = serialized;
  for (let depth = 0; depth < 4; depth++) {
    const next = text.replace(/\\+"/g, '"').replace(/\\n/g, "\n");
    if (next === text) break;
    text = next;
  }
  if (/"(role|assistant|user|system|content)"\s*:/.test(text)) return true;
  return FORBIDDEN.some((f) => new RegExp(`"${f}"`).test(text));
}

/**
 * Can executor B actually resume from this alone?
 *
 * B must be able to answer, without the old chat: what is the goal, what has
 * settled, what is being attempted, what evidence matters, what owner gates
 * exist, and what may I safely do next. A checkpoint that cannot answer all six
 * is not a handoff — it is a note to self.
 */
export function reconstructable(checkpoint, intent, resolve) {
  const answers = {
    goal: intent?.goal ?? null,
    settled: checkpoint.last_settled_event_ids.length ? checkpoint.last_settled_event_ids : null,
    attempting: checkpoint.current_operation,
    evidence: checkpoint.produced_event_ids.concat(checkpoint.dependency_refs),
    owner_gates: checkpoint.owner_gate_ids,
    next_safe_action: checkpoint.next_safe_action,
  };
  const unresolved = [...checkpoint.last_settled_event_ids, ...checkpoint.produced_event_ids, ...checkpoint.dependency_refs]
    .filter((ref) => !resolve(ref));
  return {
    // owner_gates may legitimately be empty; the other five may not.
    ok: Boolean(answers.goal && answers.settled && answers.attempting && answers.next_safe_action) && unresolved.length === 0,
    answers,
    unresolved_refs: unresolved,
  };
}

/**
 * Did the scope change materially between dispatch and checkpoint? (§11)
 *
 * A changed hash is not automatically wrong — work legitimately narrows. It
 * means the old dispatch may not silently continue into the new shape: the
 * intent returns for re-evaluation and re-dispatch. The rule being enforced is
 * that an executor may narrow its task and may not widen its authority.
 */
export function scopeDrift(dispatch, checkpoint) {
  if (!checkpoint.scope_hash) {
    return { drifted: true, requires_redispatch: true, reason: "the checkpoint records no scope identity" };
  }
  const drifted = checkpoint.scope_hash !== dispatch.scope_hash;
  return {
    drifted,
    requires_redispatch: drifted,
    reason: drifted ? "the working scope no longer matches the dispatched scope" : null,
  };
}
