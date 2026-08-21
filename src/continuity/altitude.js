// Semantic altitude — spec v3, "Dynamic Multi-Layer Semantic Abstraction".
//
// Continuity's original problem, returned to now that the temporal grammar is
// settled: hundreds of projects, thousands of concurrent sessions, millions of
// observations, and a human who still gets three to five concepts.
//
// Altitude is NOT the Z0-Z4 ladder. Z describes the local record/action
// interaction depth; altitude describes how abstract the concepts themselves
// are, and how many layers exist is a property of the data, not of the UI:
//
//   A0 = highest meaningful abstraction
//   An = semantic atoms, source-grounded records
//
// `n` is dynamic and has no hard maximum. The operator experiences zoom; the
// word "A7" never appears in the interface.

/**
 * The attention budget, at EVERY altitude.
 *
 * A larger screen buys spatial breathing room, never more simultaneous
 * cognition. This is the same rule the Z ladder already obeys, restated here
 * because altitude is where it would be most tempting to break: an abstraction
 * layer with 40 concepts is not an abstraction layer.
 */
export const ATTENTION_BUDGET = 5;

/** Provenance a projection MUST carry to be renderable at all. */
const REQUIRED_PROJECTION_FIELDS = [
  "id", "revision", "label", "childIds", "sourceObservationIds", "generatedAt",
];

/**
 * A projection is a concept ABOVE the record layer. It may carry a generated
 * label, so it is a distinct object type with machine-readable provenance —
 * never an authored record that was quietly rewritten.
 */
export function isProjection(node) {
  return Boolean(node) && node.type === "projection";
}

export function isAuthoredSource(node) {
  return Boolean(node) && node.type === "source";
}

/**
 * A projection missing its provenance is not "a projection with gaps"; it is an
 * unattributable claim, and rendering it would put unsourced text on the same
 * footing as authored text. Reject rather than degrade.
 */
export function projectionIsWellFormed(node) {
  if (!isProjection(node)) return false;
  for (const field of REQUIRED_PROJECTION_FIELDS) {
    const value = node[field];
    if (value == null) return false;
    if (Array.isArray(value) ? value.length === 0 : String(value).length === 0) return false;
  }
  // A projection that decomposes into nothing is a leaf pretending to be a
  // layer, and zooming into it would strand the operator.
  return Array.isArray(node.childIds) && node.childIds.length > 0;
}

/**
 * How a projection got its label.
 *
 *   "selected"  — copied verbatim from one of its own authored descendants
 *   "generated" — synthesised, and therefore must be disclosed as such
 *
 * Selection is preferred wherever an authored record already says the thing,
 * because it cannot drift from the source it claims to summarise.
 */
export function labelOrigin(node) {
  return isProjection(node) ? (node.labelOrigin || "generated") : "authored";
}

const index = (graph) => {
  const byId = new Map();
  for (const n of graph?.nodes || []) byId.set(n.id, n);
  return byId;
};

/**
 * Every parent of `id`.
 *
 * Projection is a DAG, not a tree: one decision may matter to two higher-level
 * concepts, and the fix for that is shared ancestry, never a duplicated copy of
 * the source truth under each parent.
 */
export function parentsOf(graph, id) {
  return (graph?.nodes || []).filter((n) => (n.childIds || []).includes(id));
}

export function childrenOf(graph, id) {
  const byId = index(graph);
  const node = byId.get(id);
  return (node?.childIds || []).map((cid) => byId.get(cid)).filter(Boolean);
}

/** The roots: concepts with no parent at all. */
export function roots(graph) {
  return (graph?.nodes || []).filter((n) => parentsOf(graph, n.id).length === 0);
}

/**
 * How much is hidden underneath a concept.
 *
 * Deliberately NOT part of any label. "PersonalOS reliability converging" is
 * what the human reads; "· 413 records · 22 runs · 5 projects" is Inspect
 * information, and spending entry-level attention on it is the same mistake as
 * the `provenance unknown` prose that v2.3 removed.
 */
export function hiddenWeight(graph, id, seen = new Set()) {
  if (seen.has(id)) return { concepts: 0, records: 0 };
  seen.add(id);
  const byId = index(graph);
  const node = byId.get(id);
  if (!node) return { concepts: 0, records: 0 };
  if (isAuthoredSource(node)) return { concepts: 0, records: 1 };
  let concepts = 0;
  let records = 0;
  for (const child of childrenOf(graph, id)) {
    // A shared child is counted once per lens, not once per parent — the DAG
    // would otherwise inflate every ancestor's weight.
    const sub = hiddenWeight(graph, child.id, seen);
    concepts += 1 + sub.concepts;
    records += sub.records;
  }
  return { concepts, records };
}

/**
 * The path from a root down to `id` through the DAG.
 *
 * A traversal is a LENS through the graph, so where several ancestries exist
 * the caller's own descent decides which one is being looked through. With no
 * descent recorded, the shortest is the least surprising.
 */
export function lensPath(graph, id, { via = [] } = {}) {
  const byId = index(graph);
  if (!byId.has(id)) return [];
  if (via.length && via[via.length - 1] === id && via.every((v) => byId.has(v))) return [...via];

  const queue = [[id]];
  const visited = new Set([id]);
  let best = [id];
  while (queue.length) {
    const path = queue.shift();
    const head = path[0];
    const parents = parentsOf(graph, head);
    if (!parents.length) return path;
    for (const parent of parents) {
      if (visited.has(parent.id)) continue;
      visited.add(parent.id);
      const next = [parent.id, ...path];
      best = next;
      queue.push(next);
    }
  }
  return best;
}

/**
 * Zoom IN: one concept becomes its 2-5 constituent concepts.
 *
 * Not "show five more records" — that is coverage, which the brief presets
 * already control. Decomposition replaces one concept with what it is made of,
 * and the budget holds at every altitude.
 */
export function decompose(graph, id) {
  const children = childrenOf(graph, id);
  if (!children.length) return null;
  return children.slice(0, ATTENTION_BUDGET);
}

/**
 * Zoom OUT: the concepts recompose into one coherent parent.
 *
 * The selected centre stays conceptually stable, so where a node has several
 * parents the lens the operator descended through wins over an arbitrary pick.
 */
export function recompose(graph, id, { via = [] } = {}) {
  const parents = parentsOf(graph, id);
  if (!parents.length) return null;
  const viaIndex = via.lastIndexOf(id);
  if (viaIndex > 0) {
    const previous = parents.find((p) => p.id === via[viaIndex - 1]);
    if (previous) return previous;
  }
  return parents[0];
}

/**
 * The concepts visible at one altitude, given a focus.
 *
 * `atSource` tells the caller it has reached semantic atoms: there is nothing
 * below, so `+` must stop rather than silently do nothing.
 */
export function altitudeScene(graph, { focus = null, via = [] } = {}) {
  const byId = index(graph);
  const focal = focus ? byId.get(focus) : null;
  if (!focal) {
    const top = roots(graph).slice(0, ATTENTION_BUDGET);
    return { focus: null, concepts: top, parents: [], atSource: top.length === 0, altitude: 0 };
  }
  const concepts = decompose(graph, focal.id) || [];
  return {
    focus: focal,
    concepts,
    parents: parentsOf(graph, focal.id),
    atSource: isAuthoredSource(focal) || concepts.length === 0,
    altitude: Math.max(0, lensPath(graph, focal.id, { via }).length - 1),
  };
}

// ---------------------------------------------------------------------------
// Semantic relationships (spec v3 §21).
//
// An edge kind is a claim about how two concepts relate, and `causes` is the
// one claim a summariser must never make on its own: temporal sequence is not
// causality, and a generated causal edge is indistinguishable from a real one
// once it is in the graph. v3 therefore prohibits it outright rather than
// gating it behind a confidence score.

export const EDGE_KINDS = ["contains", "supports", "contradicts", "supersedes", "depends_on"];
export const PROHIBITED_EDGE_KINDS = ["causes"];

export function edgeIsAllowed(kind) {
  return EDGE_KINDS.includes(kind);
}

/** Edges of one kind leaving `id`. */
export function edgesFrom(graph, id, kind) {
  return (graph?.edges || []).filter((e) => e.from === id && (!kind || e.kind === kind));
}

/**
 * Both sides of a disagreement, or null when there is none.
 *
 * Contradiction must not be flattened into "migration status unclear" — the
 * disagreement is usually the material part, so it stays recoverable as two
 * constituent branches under one honestly-named projection.
 */
export function contradictionBranches(graph, id) {
  const disputed = edgesFrom(graph, id, "contradicts");
  if (!disputed.length) return null;
  const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  return disputed.map((e) => [byId.get(e.from), byId.get(e.to)]).flat().filter(Boolean);
}

// ---------------------------------------------------------------------------
// Stable identity (spec v3 §10).
//
// Dynamic abstraction must not mean the graph reshuffles every tick. Browser
// history, bookmarks, spatial memory and overnight comparison all depend on a
// concept keeping its identity while its interpretation is refined.

/**
 * Fold new evidence into an existing projection.
 *
 * Same concept + compatible evidence REVISES the node; only a genuinely
 * different concept earns a new identity. `revision` bumps when the
 * interpretation materially changes, so an unchanged concept that merely
 * gained a source does not churn its revision either.
 */
export function reviseProjection(existing, next) {
  if (!existing) return { ...next, revision: 1, history: [] };
  const sameConcept = next.conceptKey != null && next.conceptKey === existing.conceptKey;
  if (!sameConcept) {
    // Genuinely a different concept: a new identity, not a rewrite of the old
    // one, so the old node stays inspectable in history.
    return { ...next, revision: 1, history: [], supersedes: existing.id };
  }
  const materiallyChanged = next.label !== existing.label
    || next.materiality !== existing.materiality
    || next.status !== existing.status;
  const sources = Array.from(new Set([...(existing.sourceObservationIds || []), ...(next.sourceObservationIds || [])]));
  const childIds = Array.from(new Set([...(existing.childIds || []), ...(next.childIds || [])]));
  return {
    ...existing,
    ...next,
    id: existing.id,
    conceptKey: existing.conceptKey,
    childIds,
    sourceObservationIds: sources,
    revision: materiallyChanged ? (existing.revision || 1) + 1 : (existing.revision || 1),
    history: materiallyChanged
      ? [...(existing.history || []), { revision: existing.revision || 1, label: existing.label, at: existing.generatedAt }]
      : (existing.history || []),
  };
}

// ---------------------------------------------------------------------------
// Materiality and incremental re-projection (spec v3 §11-§12).

/**
 * Whether a change matters at a higher altitude.
 *
 * Explicitly NOT a count. A thousand routine successful ticks collapse to "no
 * material change"; one credential leak reaches A0 immediately. Volume is the
 * least reliable signal there is, which is why it is absent here.
 */
const MATERIAL_KINDS = new Set([
  "goal_impact", "decision_reversal", "new_blocker", "new_opportunity", "risk",
  "dependency_impact", "commitment", "state_transition", "uncertainty_resolved",
  "owner_attention",
]);

export function isMaterial(change) {
  if (!change) return false;
  if (change.ownerAttention === true) return true;
  if (change.severity === "high" || change.severity === "critical") return true;
  return MATERIAL_KINDS.has(change.kind);
}

/**
 * Which projections a new observation dirties, walking up the DAG and stopping
 * where the parent abstraction is materially unchanged.
 *
 * Re-summarising the whole corpus on every worker record is what makes an
 * abstraction layer both expensive and unstable; propagation has to be a
 * property of the change, not of the schedule.
 */
export function dirtyAncestors(graph, changedIds = [], change = null) {
  const dirty = new Set();
  const material = isMaterial(change);
  const walk = (id, depth) => {
    for (const parent of parentsOf(graph, id)) {
      if (dirty.has(parent.id)) continue;
      // The immediate ancestor always recomputes: it owns the record. Beyond
      // that, only a material change keeps climbing.
      if (depth > 0 && !material) return;
      dirty.add(parent.id);
      walk(parent.id, depth + 1);
    }
  };
  for (const id of changedIds) walk(id, 0);
  return [...dirty];
}

// ---------------------------------------------------------------------------
// Live parallel cognition (spec v3 §13-§14).

/**
 * A projection's execution state.
 *
 * Live only when at least one MATERIALLY live descendant exists. A background
 * lint agent being technically alive must never make "Company strategy" read as
 * live — that is how a status surface becomes noise the operator learns to
 * ignore.
 */
export function projectionExecution(graph, id, seen = new Set()) {
  if (seen.has(id)) return "completed";
  seen.add(id);
  const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return "completed";
  if (isAuthoredSource(node)) {
    return node.execution === "live" && node.materiality !== "immaterial" ? "live" : "completed";
  }
  for (const child of childrenOf(graph, id)) {
    if (projectionExecution(graph, child.id, seen) === "live") return "live";
  }
  return "completed";
}

/**
 * Where a projection sits on the temporal field (spec v3 §15).
 *
 * The material transition it represents, not the earliest constituent record —
 * a concept that materialised at 11:53 does not belong at 03:58 merely because
 * that is when its first supporting tick fired. A live projection sits at NOW.
 * The full contributing interval belongs to Inspect; the node itself never
 * becomes a timeline bar.
 */
export function projectionAnchor(graph, id, now = Date.now()) {
  const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return null;
  if (projectionExecution(graph, id) === "live") return new Date(now).toISOString();
  return node.materialAt || node.at || null;
}

/**
 * What Inspect must answer for a derived node (spec v3 §22): why am I being
 * shown this? Never rendered on the default screen.
 */
export function inspectProvenance(graph, id) {
  const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node || !isProjection(node)) return null;
  const weight = hiddenWeight(graph, id);
  return {
    label: node.label,
    derived: true,
    labelOrigin: labelOrigin(node),
    directConcepts: (node.childIds || []).length,
    sourceObservations: weight.records,
    revision: node.revision || 1,
    lastMaterialRevisionAt: node.generatedAt || null,
    relationships: edgesFrom(graph, id).map((e) => ({ kind: e.kind, to: e.to })),
  };
}
