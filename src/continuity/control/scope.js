// Topic scope and the gate-overlap resolver — spec V6.1 §2, tightened by
// V6.1.2 §3, §4, §5, §10.
//
// The question: does open owner gate G intersect intent I?
//
// This file has now been wrong in both directions, and both corrections are
// load-bearing:
//
//   V6 PR B    "same lane" answered yes, which froze unrelated work and
//              produced three false high-severity findings.
//   V6.1       "no shared reference" answered no, which is only sound when
//              both sides have actually declared everything they touch. An
//              empty intersection between two PARTIAL scopes is not evidence
//              of disjointness; it is evidence of not having looked.
//
// So `no` now requires proof, not absence: two COMPLETE scopes that do not
// overlap, or an explicit relation establishing independence. Everything else
// is `unknown`, and unknown blocks.

export const SCOPE_RESOLUTION = ["resolved", "unknown"];
export const OVERLAP = ["yes", "no", "unknown"];
export const COMPLETENESS = ["complete", "partial", "unknown"];

/**
 * A topic scope.
 *
 * Every field is a REFERENCE — a source record id, a semantic centre id, a PR
 * ref, a dependency id, an exception id. Identity relationships are admissible
 * because they are checkable. Lexical similarity, shared lane, timestamps and
 * model intuition are not, and are refused below.
 *
 * `completeness` is the field that makes a negative answer possible at all.
 * Claiming `complete` means: this scope enumerates everything this work unit
 * touches. It is a claim about the evidence, so it defaults to `unknown`.
 */
export function createScope({
  semantic_centre,
  semantic_centre_refs = [],
  topic_refs = [],
  source_refs = [],
  external_refs = [],
  dependency_refs = [],
  scope_provenance_refs = [],
  completeness = "unknown",
  lane = null,
  excluded_gate_ids = [],
}) {
  if (!semantic_centre) throw new Error("a scope requires a semantic_centre");
  if (!COMPLETENESS.includes(completeness)) throw new Error(`unknown completeness: ${completeness}`);
  return {
    semantic_centre,
    lane,
    semantic_centre_refs: [...semantic_centre_refs],
    topic_refs: [...topic_refs],
    source_refs: [...source_refs],
    external_refs: [...external_refs],
    dependency_refs: [...dependency_refs],
    // What existing evidence establishes that this is a real unit of work?
    // Generated prose may LABEL an intent; it may not create one.
    scope_provenance_refs: [...scope_provenance_refs],
    completeness,
    // Gates ruled out by an authoritative statement, never by an executor's
    // opinion that they look irrelevant.
    excluded_gate_ids: [...excluded_gate_ids],
  };
}

/** A gate's scope, projected from its authoritative exception. */
export function createGateScope(gate) {
  const topic = gate.topic ?? topicOf(gate.loop);
  const refs = [topic, ...(gate.scope_refs || [])].filter(Boolean);
  return {
    gate_id: gate.id,
    // NOT modified to make V6 happy. This is a projection of what the exception
    // already references, and a thin exception yields a thin scope.
    gate_scope_refs: refs,
    gate_scope_completeness: gate.scope_completeness
      ?? (gate.scope_refs?.length ? "complete" : topic ? "partial" : "unknown"),
  };
}

const allRefs = (scope) => [
  ...scope.semantic_centre_refs,
  ...scope.topic_refs,
  ...scope.source_refs,
  ...scope.external_refs,
  ...scope.dependency_refs,
];

/**
 * Does this gate intersect this scope?
 *
 * Resolution order:
 *
 *   1. an explicit exclusion recorded by the exception layer   -> no
 *   2. a shared authoritative reference                        -> yes
 *   3. the gate is directly referenced by the intent           -> yes
 *   4. BOTH scopes complete and no shared reference            -> no
 *   5. anything else                                           -> unknown
 *
 * Step 4 is the only place a negative is inferred, and it now requires both
 * sides to claim completeness. That is the V6.1.2 tightening: absence of a
 * shared reference between two partial scopes proves nothing at all.
 */
export function gateOverlap(scope, gate) {
  const gateScope = gate.gate_scope_refs ? gate : createGateScope(gate);

  if (scope.excluded_gate_ids.includes(gateScope.gate_id)) {
    return { overlap: "no", basis: "explicitly excluded by the exception layer" };
  }

  const mine = allRefs(scope);
  const shared = gateScope.gate_scope_refs.filter((r) => mine.includes(r));
  if (shared.length) {
    return { overlap: "yes", basis: `shared authoritative reference ${shared[0]}` };
  }
  if (gateScope.gate_id && mine.includes(gateScope.gate_id)) {
    return { overlap: "yes", basis: "the gate is referenced by this intent" };
  }

  if (scope.completeness === "complete" && gateScope.gate_scope_completeness === "complete") {
    return { overlap: "no", basis: "two complete scopes with no shared reference" };
  }
  return {
    overlap: "unknown",
    basis: `overlap not established (intent scope ${scope.completeness}, gate scope ${gateScope.gate_scope_completeness})`,
  };
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
 * `dispatchable` is false whenever ANY gate is unresolved. Unknown does not
 * mean probably unrelated — that is the whole reason the third value exists.
 */
export function resolveScope(scope, openGates) {
  const intersecting = [];
  const unknown = [];
  for (const gate of openGates) {
    const { overlap, basis } = gateOverlap(scope, gate);
    if (overlap === "yes") intersecting.push({ gate_id: gate.id ?? gate.gate_id, basis });
    else if (overlap === "unknown") unknown.push({ gate_id: gate.id ?? gate.gate_id, basis });
  }
  const resolution = unknown.length === 0 ? "resolved" : "unknown";
  return {
    scope_resolution: resolution,
    scope_completeness: scope.completeness,
    intersecting_gate_ids: intersecting.map((i) => i.gate_id),
    intersecting,
    unknown,
    dispatchable: resolution === "resolved" && intersecting.length === 0,
    reason: resolution === "unknown"
      ? `scope overlap could not be established for ${unknown.length} open gate(s)`
      : intersecting.length
        ? `blocked by ${intersecting.length} intersecting owner gate(s)`
        : null,
  };
}

/**
 * A stable identity for a scope (spec V6.1.2 §11).
 *
 * Checkpoints carry this so that "the scope changed materially during work" is
 * detectable rather than a matter of opinion.
 */
export function scopeHash(scope) {
  const canonical = [scope.semantic_centre, scope.completeness, ...allRefs(scope).slice().sort()].join("|");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Is `candidate` inside the scope that was actually dispatched (§11)?
 *
 * An executor may NARROW its task while working. It may not widen its own
 * authority envelope. Anything referencing work outside the dispatched scope
 * requires a checkpoint and a new dispatch — which is the difference between
 * an agent finishing its job and an agent giving itself a bigger one.
 */
export function withinDispatchedScope(dispatched, candidateRefs) {
  const allowed = new Set(allRefs(dispatched));
  const outside = candidateRefs.filter((r) => !allowed.has(r));
  return {
    within: outside.length === 0,
    outside,
    requires_new_dispatch: outside.length > 0,
    reason: outside.length ? `operation references ${outside.length} ref(s) outside the dispatched scope` : null,
  };
}

/**
 * Scope inheritance is prohibited by default (§10).
 *
 * "The child has no scope, so use the parent's" is the convenience that quietly
 * recreates lane-wide authority — the exact mistake corrected twice already.
 * Inheritance requires the parent to have explicitly marked the scope
 * inheritable AND complete.
 */
export function inheritScope(parent, child) {
  if (!parent?.inheritable) {
    return { ok: false, scope: child, reason: "scope inheritance is prohibited unless the parent marks it inheritable" };
  }
  if (parent.completeness !== "complete") {
    return { ok: false, scope: child, reason: "an incomplete parent scope may not be inherited" };
  }
  return {
    ok: true,
    scope: createScope({
      ...child,
      semantic_centre: child.semantic_centre,
      topic_refs: [...new Set([...child.topic_refs, ...parent.topic_refs])],
      source_refs: [...new Set([...child.source_refs, ...parent.source_refs])],
      completeness: "complete",
    }),
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
