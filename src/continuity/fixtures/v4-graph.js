// The V4 graph at a point in history — spec V4 PR B §10, §12.
//
// Historical semantic zoom is the second architecture gate: from a rewound
// concept the operator must descend through the DAG AS IT EXISTED THEN. So the
// graph itself is reconstructed per as-of point, not filtered afterwards.
//
// The difference matters. Filtering the current graph would leave later
// constituents present-but-hidden, and "not in the first list" is not the same
// as absent. Future evidence must be genuinely missing from the scene.

import { buildProjectionGraph } from "./v3-projection.js";
import { revisionAt } from "../history/revision.js";
import { T2, T3, T4, buildHistoryWorld } from "./v4-history.js";

/** The two concepts that only exist after the blocker and the recovery. */
const LATER_CONCEPTS = [
  {
    id: "rel-websocket-rejection",
    label: "Production websocket rejection became a material blocker.",
    childIds: ["S05_r11"],
    bornAt: T2,
  },
  {
    id: "rel-verification-passed",
    label: "Post-rollback verification cleared the deployment gate.",
    childIds: ["S05_r12"],
    bornAt: T3,
  },
];

const projection = (id, label, childIds) => ({
  id, type: "projection", label, childIds,
  conceptKey: id, labelOrigin: "generated", revision: 1,
  sourceObservationIds: [], generatedAt: null,
  materiality: "material", status: "committed",
});

/**
 * Build the semantic graph as it stood at `asOf`.
 *
 * `asOf === null` is the live world. Anything else reconstructs: sources after
 * the cutoff are removed entirely, concepts that had not been formed yet are
 * absent, and the Reliability concept carries the constituents its
 * in-force revision actually had.
 */
export function buildV4Graph(world, asOf = null) {
  const cutoff = asOf == null ? Infinity : Date.parse(asOf);
  const base = buildProjectionGraph();

  // Sources: the V3 corpus plus the V4 timeline records, cut at the boundary.
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  for (const record of world.sources) byId.set(record.id, record);
  const nodes = [...byId.values()].filter((n) => {
    if (n.type !== "source") return true;
    const at = Date.parse(n.at);
    return !Number.isFinite(at) || at <= cutoff;
  });

  const present = new Set(nodes.map((n) => n.id));

  // Concepts born after the cutoff simply do not exist.
  for (const concept of LATER_CONCEPTS) {
    if (Date.parse(concept.bornAt) > cutoff) continue;
    const childIds = concept.childIds.filter((c) => present.has(c));
    if (!childIds.length) continue;
    nodes.push(projection(concept.id, concept.label, childIds));
    present.add(concept.id);
  }

  // Reliability takes the constituents of whichever revision was in force.
  const rev = revisionAt(world.revisions, "reliability", asOf);
  const reliability = nodes.find((n) => n.id === "reliability");
  if (reliability && rev) {
    reliability.label = rev.label;
    reliability.childIds = rev.direct_child_ids.filter((c) => present.has(c));
  }

  // Any dangling child reference is dropped rather than left pointing at a
  // node the reconstruction removed.
  for (const node of nodes) {
    if (node.type !== "projection") continue;
    node.childIds = (node.childIds || []).filter((c) => present.has(c));
  }

  const sourcesUnder = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const node = nodes.find((n) => n.id === id);
    if (!node) return [];
    if (node.type === "source") return [node.id];
    return (node.childIds || []).flatMap((c) => sourcesUnder(c, seen));
  };
  for (const node of nodes) {
    if (node.type !== "projection") continue;
    node.sourceObservationIds = Array.from(new Set(sourcesUnder(node.id)));
  }

  return { nodes, edges: base.edges.filter((e) => present.has(e.from) && present.has(e.to)) };
}

/** The material revisions of a concept, for the ← / → controls. */
export function revisionTimeline(world, projectionId) {
  const list = [...(world.revisions.get(projectionId) || [])];
  return list.map((r) => ({
    revision: r.revision,
    effective_at: r.effective_at,
    label: r.label,
  }));
}

export { buildHistoryWorld, T2, T3, T4 };
