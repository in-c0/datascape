// Semantic revisions and the working overlay — spec V4 §2, §3, §10, §11, §15.
//
// Git-like history for decisions rather than code, with one difference that
// matters more than the analogy: a commit is whatever you chose to commit,
// whereas a semantic revision may only be appended when the INTERPRETATION
// materially changed. A hundred routine ticks produce no revision at all.
//
// The distinction that makes this usable is settled-versus-working. A live
// branch accumulates evidence continuously; almost none of it changes what the
// branch MEANS. Recording every arrival as history would turn the record into
// the event log V4 exists to avoid.

/** The vocabulary of what can change between two revisions (§9). */
export const CHANGE_KINDS = [
  "constituent_added",
  "constituent_removed",
  "relationship_changed",
  "material_state_changed",
  "owner_requirement_opened",
  "owner_requirement_closed",
  "support_changed",
  "interpretation_revised",
  "execution_changed_materially",
];

const sig = (rels = []) => rels.map((r) => `${r.kind}:${r.target}`).sort().join("|");
const setOf = (xs) => new Set(xs || []);
const diffSets = (before, after) => {
  const a = setOf(before);
  const b = setOf(after);
  return {
    added: [...b].filter((x) => !a.has(x)),
    removed: [...a].filter((x) => !b.has(x)),
  };
};

/**
 * What materially changed between two states of one concept.
 *
 * Deliberately NOT a count of anything. Gaining three hundred supporting
 * observations while the label, constituents, relationships, materiality and
 * owner requirement all stay put is not a semantic change, and treating it as
 * one is exactly how a history view becomes "483 things happened".
 */
export function materialChange(previous, next) {
  if (!previous) return { changed: true, kinds: ["interpretation_revised"] };
  const kinds = [];

  if (previous.label !== next.label) kinds.push("interpretation_revised");

  const children = diffSets(previous.direct_child_ids, next.direct_child_ids);
  if (children.added.length) kinds.push("constituent_added");
  if (children.removed.length) kinds.push("constituent_removed");

  if (sig(previous.relationships) !== sig(next.relationships)) kinds.push("relationship_changed");
  if (previous.materiality !== next.materiality) kinds.push("material_state_changed");
  if (previous.owner_requirement !== next.owner_requirement) {
    kinds.push(next.owner_requirement ? "owner_requirement_opened" : "owner_requirement_closed");
  }
  // Execution counts only when it crosses the live/completed boundary; a live
  // branch breathing does not make history.
  if (previous.execution !== next.execution) kinds.push("execution_changed_materially");

  // Support changes ONLY register when they accompany something else, or when
  // evidence was withdrawn. New corroboration for an unchanged interpretation
  // is working state, not history.
  const sources = diffSets(previous.source_observation_ids, next.source_observation_ids);
  if (sources.removed.length) kinds.push("support_changed");
  else if (sources.added.length && kinds.length) kinds.push("support_changed");

  return { changed: kinds.length > 0, kinds, children, sources };
}

/** An append-only index of material revisions, keyed by stable projection id. */
export function createRevisionIndex(seed = []) {
  const byId = new Map();
  for (const rev of seed) {
    if (!byId.has(rev.projection_id)) byId.set(rev.projection_id, []);
    byId.get(rev.projection_id).push(rev);
  }
  for (const list of byId.values()) list.sort((a, b) => a.revision - b.revision);
  return byId;
}

/**
 * Append a revision IF and only if the interpretation materially changed.
 *
 * Returns what happened either way, because "nothing was appended" is a result
 * the caller needs to be able to assert on, not a silent no-op.
 */
export function appendRevision(index, projectionId, next, { at, semanticAnchor = null } = {}) {
  const list = index.get(projectionId) || [];
  const previous = list[list.length - 1] || null;
  const change = materialChange(previous, next);
  if (!change.changed) {
    return { appended: false, reason: "no material semantic change", revision: previous?.revision ?? null, kinds: [] };
  }
  const revision = {
    projection_id: projectionId,
    revision: (previous?.revision || 0) + 1,
    effective_at: at,
    label: next.label,
    direct_child_ids: [...(next.direct_child_ids || [])],
    relationship_signature: sig(next.relationships),
    relationships: [...(next.relationships || [])],
    source_observation_ids: [...(next.source_observation_ids || [])],
    materiality: next.materiality ?? null,
    execution: next.execution ?? null,
    owner_requirement: next.owner_requirement ?? false,
    semantic_anchor: semanticAnchor,
    supersedes_revision: previous?.revision ?? null,
    // A genuine split records what it came from rather than quietly reusing an
    // id to avoid admitting the concept divided (§11).
    derived_from: next.derived_from || null,
    supersedes: next.supersedes || null,
  };
  index.set(projectionId, [...list, revision]);
  return { appended: true, revision: revision.revision, kinds: change.kinds, record: revision };
}

export function revisionsOf(index, projectionId) {
  return [...(index.get(projectionId) || [])];
}

/** The revision in force at a moment. Never a later one. */
export function revisionAt(index, projectionId, asOf) {
  const cutoff = asOf == null ? Infinity : Date.parse(asOf);
  const list = index.get(projectionId) || [];
  let found = null;
  for (const rev of list) {
    if (Date.parse(rev.effective_at) <= cutoff) found = rev;
    else break;
  }
  return found;
}

/**
 * Evidence that arrived after the last settled revision (§3, §15).
 *
 * This is the working tree, and it is NOT history. It may look live, it may be
 * inspectable, and it becomes a revision only when it actually changes what the
 * concept means.
 */
export function workingOverlay(index, projectionId, sources, { now = Date.now() } = {}) {
  const list = index.get(projectionId) || [];
  const settled = list[list.length - 1] || null;
  if (!settled) return { settled_revision: null, working_evidence: [], material_semantic_change: "none yet" };
  const since = Date.parse(settled.effective_at);
  const known = setOf(settled.source_observation_ids);
  const working = (sources || []).filter((s) => {
    const at = Date.parse(s.at);
    return Number.isFinite(at) && at > since && at <= now && !known.has(s.id);
  });
  return {
    settled_revision: settled.revision,
    working_evidence: working.map((s) => s.id),
    working_evidence_count: working.length,
    // Stated only when it is truthfully what the evaluator found. The overlay
    // must never be able to read as a settled revision (§16).
    material_semantic_change: "none yet",
    is_settled: false,
  };
}
