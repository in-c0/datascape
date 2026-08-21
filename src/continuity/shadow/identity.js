// Stable identity and stability measurement — spec v3.2 §11-§13.
//
// The model returns RUN-LOCAL ids only. It is never allowed to assert "I am the
// same concept as yesterday", because that claim is exactly the one a fluent
// model would make most confidently and least reliably. The system decides
// identity, deterministically, from evidence overlap.

const jaccard = (a, b) => {
  const A = new Set(a || []);
  const B = new Set(b || []);
  if (!A.size && !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  return shared / (A.size + B.size - shared);
};

/** A comparable signature of a node's outgoing relationships. */
const relSignature = (node) =>
  (node?.relationships || []).map((r) => `${r.kind}:${r.target}`).sort().join("|");

/** Cheap token-overlap similarity; used only as the last tiebreaker. */
const labelSimilarity = (a = "", b = "") => {
  const tok = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  return jaccard([...tok(a)], [...tok(b)]);
};

/**
 * Priority order is the spec's, and the order matters more than the weights:
 * source-set overlap first, then direct-child overlap, then relationship
 * signature, then label similarity. Label is LAST on purpose — a model that
 * rewords a concept has not created a new one, and a model that reuses wording
 * across two different concepts has not merged them.
 */
export function matchScore(a, b) {
  const sources = jaccard(a?.source_observation_ids, b?.source_observation_ids);
  const children = jaccard(a?.direct_children, b?.direct_children);
  const rels = relSignature(a) && relSignature(a) === relSignature(b) ? 1 : 0;
  const label = labelSimilarity(a?.label, b?.label);
  return {
    sources, children, rels, label,
    score: sources * 0.55 + children * 0.3 + rels * 0.1 + label * 0.05,
  };
}

/**
 * Assign stable shadow ids by matching this run's candidates against the
 * previous run's assignments.
 *
 * A shadow id is namespaced so it can never collide with, or be mistaken for,
 * a production projection id (§11).
 */
export function assignStableIds(candidates, previous = [], { threshold = 0.45, domain = "security" } = {}) {
  const taken = new Set();
  const assignments = [];
  const scored = [];

  for (const node of candidates) {
    for (const prior of previous) {
      const m = matchScore(node, prior);
      if (m.score >= threshold) scored.push({ node, prior, ...m });
    }
  }
  // Greedy best-first, so the strongest evidence claims its match before a
  // weaker one can steal it.
  scored.sort((x, y) => y.score - x.score);

  const matchedNodes = new Set();
  for (const entry of scored) {
    if (matchedNodes.has(entry.node.candidate_id) || taken.has(entry.prior.stable_shadow_id)) continue;
    matchedNodes.add(entry.node.candidate_id);
    taken.add(entry.prior.stable_shadow_id);
    // A concept whose interpretation materially changed keeps its id and takes
    // a revision; identical structure and label keeps the revision too.
    const changed = entry.node.label !== entry.prior.label
      || jaccard(entry.node.source_observation_ids, entry.prior.source_observation_ids) < 1;
    assignments.push({
      candidate_id: entry.node.candidate_id,
      stable_shadow_id: entry.prior.stable_shadow_id,
      match_confidence: Number(entry.score.toFixed(3)),
      previous_revision: entry.prior.revision || 1,
      revision: changed ? (entry.prior.revision || 1) + 1 : (entry.prior.revision || 1),
      matched_on: { sources: entry.sources, children: entry.children, rels: entry.rels, label: entry.label },
    });
  }

  let n = previous.length;
  for (const node of candidates) {
    if (matchedNodes.has(node.candidate_id)) continue;
    n += 1;
    assignments.push({
      candidate_id: node.candidate_id,
      stable_shadow_id: `shadow_${domain}_${String(n).padStart(3, "0")}`,
      match_confidence: 0,
      previous_revision: null,
      revision: 1,
      matched_on: null,
    });
  }
  return assignments;
}

/**
 * Structural stability across repeated runs on ONE immutable snapshot (§12).
 *
 * Deliberately no pass threshold: this first run exists to produce empirical
 * distributions, and inventing a threshold before seeing one would be choosing
 * the answer in advance.
 */
export function stabilityReport(runs, { threshold = 0.45 } = {}) {
  const nodeSets = runs.map((r) => r.projections || []);
  const rootsOf = (nodes) => {
    const child = new Set(nodes.flatMap((n) => n.direct_children || []));
    return nodes.filter((n) => !child.has(n.candidate_id));
  };
  const rootCounts = nodeSets.map((n) => rootsOf(n).length);
  const nodeCounts = nodeSets.map((n) => n.length);

  const pairs = [];
  for (let i = 0; i < nodeSets.length; i++) {
    for (let j = i + 1; j < nodeSets.length; j++) {
      const matched = [];
      const usedB = new Set();
      const all = [];
      for (const a of nodeSets[i]) {
        for (const b of nodeSets[j]) all.push({ a, b, ...matchScore(a, b) });
      }
      all.sort((x, y) => y.score - x.score);
      const usedA = new Set();
      for (const entry of all) {
        if (entry.score < threshold) break;
        if (usedA.has(entry.a.candidate_id) || usedB.has(entry.b.candidate_id)) continue;
        usedA.add(entry.a.candidate_id);
        usedB.add(entry.b.candidate_id);
        matched.push(entry);
      }
      const denom = Math.max(nodeSets[i].length, nodeSets[j].length) || 1;
      pairs.push({
        runs: [i + 1, j + 1],
        matched_concepts: matched.length,
        matched_concept_rate: Number((matched.length / denom).toFixed(3)),
        source_membership_overlap: mean(matched.map((m) => m.sources)),
        relationship_agreement: mean(matched.map((m) => m.rels)),
        // A concept matched on evidence but reworded is the benign kind of
        // variation; it is measured separately so it cannot be mistaken for
        // structural drift.
        label_only_variation: matched.filter((m) => m.sources === 1 && m.label < 1).length,
        unmatched: [nodeSets[i].length - matched.length, nodeSets[j].length - matched.length],
      });
    }
  }

  return {
    runs: runs.length,
    root_count_variance: variance(rootCounts),
    node_count_variance: variance(nodeCounts),
    root_counts: rootCounts,
    node_counts: nodeCounts,
    pairs,
    note: "No pass threshold is set at V3.2; these are the empirical distributions V3.3 thresholds derive from.",
  };
}

/**
 * Historical replay: what identity did between two real cutoffs (§13).
 *
 * If the real history has no usable incremental boundary, the caller reports
 * that. Inventing an event to satisfy the gate would make the replay a
 * fixture test wearing a real-data costume.
 */
export function replayReport(t0, t1, { threshold = 0.45, domain = "security" } = {}) {
  const first = assignStableIds(t0.projections || [], [], { threshold, domain });
  const priorByCandidate = new Map(first.map((a) => [a.candidate_id, a]));
  const prior = (t0.projections || []).map((n) => ({
    ...n,
    stable_shadow_id: priorByCandidate.get(n.candidate_id)?.stable_shadow_id,
    revision: 1,
  }));
  const second = assignStableIds(t1.projections || [], prior, { threshold, domain });

  return {
    t0_count: (t0.projections || []).length,
    t1_count: (t1.projections || []).length,
    retained: second.filter((a) => a.previous_revision !== null && a.revision === a.previous_revision).length,
    revised: second.filter((a) => a.previous_revision !== null && a.revision > a.previous_revision).length,
    new_concepts: second.filter((a) => a.previous_revision === null).length,
    assignments: second,
  };
}

const mean = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : 0);
const variance = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Number((xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length).toFixed(3));
};
