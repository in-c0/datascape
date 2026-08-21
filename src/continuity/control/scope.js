// Intent scope and the gate-overlap resolver — spec V6.1 §2.
//
// The question this file exists to answer: does open owner gate G intersect
// intent I? V6 PR B established that "same lane" is NOT the answer — a lane is
// a transport boundary, not an authority boundary, and treating it as one
// froze unrelated work and produced three false high-severity findings.
//
// The replacement must not swing to the opposite error. "Not obviously related"
// is not the same as "unrelated", and a resolver that answers `false` whenever
// it cannot see a relationship would authorise exactly the dispatch the whole
// firewall exists to prevent. So the vocabulary has three values, not two, and
// the third one blocks.

export const SCOPE_RESOLUTION = ["resolved", "unknown"];
export const OVERLAP = ["intersects", "disjoint", "unknown"];

/**
 * An intent's scope.
 *
 * `topic_refs` are AUTHORITATIVE references — an exception loop topic, a repo
 * path, a source event id — not prose. Keyword matching is explicitly refused
 * below: a gate titled "publish the launch post" and an intent about "post-hoc
 * validation" share a word and nothing else, and no amount of tuning makes
 * string similarity into an authority decision.
 */
export function createScope({ semantic_centre, topic_refs = [], source_refs = [], dependency_refs = [], lane = null, excluded_gate_ids = [] }) {
  if (!semantic_centre) throw new Error("a scope requires a semantic_centre");
  return {
    semantic_centre,
    lane,
    topic_refs: [...topic_refs],
    source_refs: [...source_refs],
    dependency_refs: [...dependency_refs],
    // Gates explicitly ruled out of this intent by an authoritative statement,
    // never by an executor's opinion that they look irrelevant.
    excluded_gate_ids: [...excluded_gate_ids],
  };
}

/**
 * Does this gate intersect this scope?
 *
 * Resolution order, strictest first:
 *
 *   1. an explicit exclusion recorded by the exception layer  -> disjoint
 *   2. a shared authoritative topic reference                 -> intersects
 *   3. the gate declares a topic and the scope declares topics
 *      that do not include it                                 -> disjoint
 *   4. anything else                                          -> unknown
 *
 * Step 3 is the only place a negative is inferred, and it is safe precisely
 * because both sides declared their topics: absence of overlap between two
 * populated, authoritative lists is real evidence. Absence of a list is not.
 */
export function gateOverlap(scope, gate) {
  if (scope.excluded_gate_ids.includes(gate.id)) {
    return { overlap: "disjoint", basis: "explicitly excluded by the exception layer" };
  }
  const gateTopic = gate.topic ?? topicOf(gate.loop);
  if (!gateTopic) {
    return { overlap: "unknown", basis: "the gate declares no authoritative topic" };
  }
  if (scope.topic_refs.includes(gateTopic)) {
    return { overlap: "intersects", basis: `shared topic reference ${gateTopic}` };
  }
  if (gate.id && (scope.source_refs.includes(gate.id) || scope.dependency_refs.includes(gate.id))) {
    return { overlap: "intersects", basis: "the gate is referenced by this intent" };
  }
  if (scope.topic_refs.length > 0) {
    return { overlap: "disjoint", basis: "both sides declare topics and they do not overlap" };
  }
  // Same lane, no declared topics. This is the case that used to read as
  // "intersects" (freezing the lane) and must never read as "disjoint".
  return { overlap: "unknown", basis: "the intent declares no topic references, so overlap cannot be established" };
}

/** `<lane>/<topic>` is the authoritative loop naming used by the exception layer. */
export function topicOf(loop) {
  if (!loop || typeof loop !== "string") return null;
  const parts = loop.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : null;
}

/**
 * Resolve an intent's scope against every open gate.
 *
 * `dispatchable` is the field that matters, and it is false whenever ANY gate
 * is unresolved against this intent. Unknown does not mean probably unrelated.
 */
export function resolveScope(scope, openGates) {
  const intersecting = [];
  const unknown = [];
  for (const gate of openGates) {
    const { overlap, basis } = gateOverlap(scope, gate);
    if (overlap === "intersects") intersecting.push({ gate_id: gate.id, basis });
    else if (overlap === "unknown") unknown.push({ gate_id: gate.id, basis });
  }
  const resolution = unknown.length === 0 ? "resolved" : "unknown";
  return {
    scope_resolution: resolution,
    intersecting_gate_ids: intersecting.map((i) => i.gate_id),
    intersecting,
    unknown,
    // Dispatchable requires BOTH: every gate resolved, and none intersecting.
    dispatchable: resolution === "resolved" && intersecting.length === 0,
    reason: resolution === "unknown"
      ? `scope overlap could not be established for ${unknown.length} open gate(s)`
      : intersecting.length
        ? `blocked by ${intersecting.length} intersecting owner gate(s)`
        : null,
  };
}

/**
 * Deliberately absent: any similarity-based resolver.
 *
 * Kept as a named export so the refusal is testable rather than merely
 * described in a comment. A future edit that "just adds a fuzzy fallback" has
 * to delete this first, which is the point.
 */
export function refuseSimilarityMatching() {
  throw new Error("gate overlap is resolved by authoritative references, never by prose similarity");
}
