// As-of reconstruction, the read-only rule, and semantic diff — V4 §4-§9, §16.
//
// The hard safety invariant of this whole phase: entering history must never
// let an owner execute a stale decision. A rewound scene is forensic. Approve,
// Reply, Defer and Dismiss belong to the present tense only, because acting on
// a 14:20 view of an exception that was resolved at 16:10 would be acting on
// something that is no longer true.
//
// The second invariant is no future leakage. A scene at 14:20 is built from
// what existed at 14:20 — not the present with recent items filtered out, which
// is a different and much more dangerous thing.

import { CHANGE_KINDS, materialChange, revisionAt, revisionsOf } from "./revision.js";

export const HISTORICAL_UNAVAILABLE = "historical state unavailable";
export const DIFF_BUDGET = 5;

const ms = (t) => (t == null ? Infinity : Date.parse(t));

/**
 * Reconstruct the world as it stood at `asOf`.
 *
 * If the reconstruction cannot be made truthfully, this returns the
 * unavailable marker rather than substituting the present. Showing "now" under
 * a historical timestamp is the single worst failure this function can have.
 */
export function semanticScene(world, asOf = null) {
  const cutoff = ms(asOf);
  if (asOf != null && !Number.isFinite(cutoff)) {
    return { available: false, reason: HISTORICAL_UNAVAILABLE, asOf };
  }

  const sources = (world?.sources || []).filter((s) => {
    const at = Date.parse(s.at);
    return Number.isFinite(at) && at <= cutoff;
  });

  const projections = [];
  for (const id of world?.projectionIds || []) {
    const rev = revisionAt(world.revisions, id, asOf);
    // A concept that did not yet exist at this moment is absent, not empty.
    if (rev) projections.push(rev);
  }

  // If we are asked for a historical moment that precedes every revision AND
  // every source, there is nothing truthful to render.
  if (asOf != null && !projections.length && !sources.length) {
    return { available: false, reason: HISTORICAL_UNAVAILABLE, asOf };
  }

  return {
    available: true,
    asOf,
    historical: asOf != null,
    sources,
    projections,
    exceptions: reconstructExceptions(world?.exceptionHistory || [], asOf),
    // Everything downstream reads this rather than deciding for itself.
    readOnly: asOf != null,
  };
}

/**
 * An exception's state AS IT WAS, never as it became (§5).
 *
 * The spec's example is the test: unresolved at 14:20, resolved at 16:10, and
 * the 14:20 scene must show it unresolved.
 */
export function reconstructExceptions(history, asOf = null) {
  const cutoff = ms(asOf);
  const byId = new Map();
  for (const entry of history) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || at > cutoff) continue;
    byId.set(entry.id, { id: entry.id, status: entry.status, at: entry.at, title: entry.title ?? byId.get(entry.id)?.title });
  }
  return [...byId.values()];
}

/**
 * What the surface may do in this scene.
 *
 * Returned as data rather than left to each call site, so there is exactly one
 * place the read-only rule lives and exactly one place to test it.
 */
export function affordances(scene) {
  if (scene?.historical) {
    return {
      ownerActions: false,
      canRule: false,
      canResumeLane: false,
      allowed: ["inspect", "zoom", "navigate_revisions", "return_to_now"],
      reason: "historical view is forensic only",
    };
  }
  return {
    ownerActions: true,
    canRule: true,
    canResumeLane: true,
    allowed: ["inspect", "zoom", "approve", "reply", "defer", "dismiss", "resume"],
    reason: null,
  };
}

/**
 * A bounded semantic diff between two revisions of one concept (§9, §10).
 *
 * At most five change concepts, and event volume is never one of them. Going
 * from revision 4 to 5 might sit on three hundred new observations while the
 * only thing worth showing is "deployment verification failed".
 */
export function semanticDiff(index, projectionId, fromRevision, toRevision, { budget = DIFF_BUDGET, labels = {} } = {}) {
  const list = revisionsOf(index, projectionId);
  const from = list.find((r) => r.revision === fromRevision);
  const to = list.find((r) => r.revision === toRevision);
  if (!from || !to) return { type: "semantic_diff", available: false, reason: "revision not found" };

  const change = materialChange(from, to);
  const changes = [];
  const name = (id) => labels[id] || id;

  if (from.label !== to.label) {
    changes.push({ kind: "interpretation_revised", before: from.label, after: to.label });
  }
  for (const id of change.children.added) {
    changes.push({ kind: "constituent_added", concept: name(id), id });
  }
  for (const id of change.children.removed) {
    // Removed evidence stays inspectable historically (§16) — the diff names
    // it and the earlier revision still carries it.
    changes.push({ kind: "constituent_removed", concept: name(id), id, still_inspectable_at_revision: from.revision });
  }
  if (from.relationship_signature !== to.relationship_signature) {
    changes.push({ kind: "relationship_changed", before: from.relationship_signature, after: to.relationship_signature });
  }
  if (from.materiality !== to.materiality) {
    changes.push({ kind: "material_state_changed", before: from.materiality, after: to.materiality });
  }
  if (from.owner_requirement !== to.owner_requirement) {
    changes.push({
      kind: to.owner_requirement ? "owner_requirement_opened" : "owner_requirement_closed",
    });
  }
  if (from.execution !== to.execution) {
    changes.push({ kind: "execution_changed_materially", before: from.execution, after: to.execution });
  }

  for (const c of changes) {
    if (!CHANGE_KINDS.includes(c.kind)) throw new Error(`unknown change kind: ${c.kind}`);
  }

  return {
    type: "semantic_diff",
    available: true,
    // Ephemeral and system-derived: not authored evidence, not projection truth.
    ephemeral: true,
    projection_id: projectionId,
    from_revision: from.revision,
    to_revision: to.revision,
    from_effective_at: from.effective_at,
    to_effective_at: to.effective_at,
    changes: changes.slice(0, budget),
    truncated: Math.max(0, changes.length - budget),
    // Raw counts stay available for Inspect and are deliberately not a change.
    inspect_only: {
      source_count_before: from.source_observation_ids.length,
      source_count_after: to.source_observation_ids.length,
    },
  };
}

/**
 * The URL state contract (§8). History is a third axis, not a semantic
 * altitude, so it round-trips beside lens/centre/altitude rather than inside
 * them.
 */
export function encodeHistoryState({ lens = [], centre = null, altitude = null, z = null, asOf = null, revision = null } = {}) {
  const params = new URLSearchParams();
  if (lens.length) params.set("lens", lens.join("."));
  if (centre) params.set("centre", centre);
  if (altitude != null) params.set("alt", String(altitude));
  if (z != null) params.set("z", String(z));
  if (asOf) params.set("asOf", asOf);
  if (revision != null) params.set("rev", String(revision));
  return params.toString();
}

export function decodeHistoryState(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const num = (key) => (params.has(key) ? Number(params.get(key)) : null);
  return {
    lens: (params.get("lens") || "").split(".").filter(Boolean),
    centre: params.get("centre") || null,
    altitude: num("alt"),
    z: num("z"),
    asOf: params.get("asOf") || null,
    revision: num("rev"),
    historical: Boolean(params.get("asOf") || params.get("rev")),
  };
}
