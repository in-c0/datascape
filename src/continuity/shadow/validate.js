// The candidate validity gate — spec v3.2 §5-§8.
//
// Everything here answers one question: is this candidate DAG structurally
// trustworthy? Not "is the prose good". A fluent, well-written candidate with a
// dangling source id is a failure, and the spec is explicit that we must not
// repair it invisibly and then score the repair as the model's output.

import { scanArtifact } from "./redact.js";

/** What a proposer is permitted to assert (§5). */
export const PROPOSABLE_FIELDS = [
  "candidate_id", "type", "label", "direct_children", "source_observation_ids",
  "evidence", "relationships", "candidate_materiality", "open_questions",
];

/**
 * What it may never assert. These are deterministic or source-derived, and a
 * model that supplies them is claiming authority it does not have — execution
 * state, timestamps and owner-action state are exactly the fields that would
 * let a hallucination look authoritative.
 */
export const FORBIDDEN_FIELDS = [
  "execution", "supervision", "at", "materialAt", "generatedAt", "now",
  "ownerAction", "exceptionState", "status", "revision", "stable_shadow_id",
];

export const ALLOWED_EDGE_KINDS = ["contains", "supports", "contradicts", "supersedes", "depends_on"];
export const PROHIBITED_EDGE_KINDS = ["causes"];

const MATERIALITY = ["low", "medium", "high"];

/**
 * Validate one candidate DAG against an immutable redacted snapshot.
 *
 * Returns every failure rather than the first: a report that stops at the
 * first dangling id tells us nothing about whether the proposer is broadly or
 * narrowly wrong, and that distinction is the whole point of the experiment.
 */
export function validateCandidate(candidate, snapshot, { redactor } = {}) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, ...detail });

  const nodes = Array.isArray(candidate?.projections) ? candidate.projections : [];
  const sourceIds = new Set((snapshot?.redacted || []).map((r) => r.id));
  const byText = new Map((snapshot?.redacted || []).map((r) => [r.id, r.text || ""]));
  const ids = new Set();

  for (const node of nodes) {
    const id = node?.candidate_id;
    if (!id) { fail("missing_candidate_id", { node }); continue; }
    if (ids.has(id)) fail("duplicate_candidate_id", { id });
    ids.add(id);

    // §5: fields the model may not assert at all.
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node, field)) {
        fail("forbidden_field", { id, field });
      }
    }

    // §6: provenance is required, not preferred. Reject rather than degrade.
    if (!Array.isArray(node.direct_children) || node.direct_children.length < 1) {
      fail("no_direct_constituent", { id });
    }
    if (!Array.isArray(node.source_observation_ids) || node.source_observation_ids.length < 1) {
      fail("no_source_observation", { id });
    }
    if (!node.label || typeof node.label !== "string") fail("missing_label", { id });
    if (node.candidate_materiality && !MATERIALITY.includes(node.candidate_materiality)) {
      fail("invalid_materiality", { id, value: node.candidate_materiality });
    }
    // A projection must never carry authored text as its own (v3 §4).
    if (typeof node.text === "string") fail("projection_carries_authored_text", { id });
  }

  // Dangling references, in both directions.
  for (const node of nodes) {
    const id = node?.candidate_id;
    for (const child of node?.direct_children || []) {
      if (!ids.has(child) && !sourceIds.has(child)) fail("dangling_child", { id, child });
    }
    for (const sid of node?.source_observation_ids || []) {
      if (!sourceIds.has(sid)) fail("dangling_source", { id, source: sid });
    }
    // §7: evidence is a REFERENCE, and it has to resolve. A candidate with a
    // beautiful explanation and an unresolvable offset still fails.
    for (const ev of node?.evidence || []) {
      const text = byText.get(ev?.source_id);
      if (text === undefined) { fail("evidence_source_missing", { id, source: ev?.source_id }); continue; }
      const start = Number(ev?.start);
      const end = Number(ev?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) {
        fail("evidence_offset_unresolvable", { id, source: ev?.source_id, start: ev?.start, end: ev?.end });
      }
    }
    for (const rel of node?.relationships || []) {
      if (PROHIBITED_EDGE_KINDS.includes(rel?.kind)) fail("prohibited_edge_kind", { id, kind: rel?.kind });
      else if (!ALLOWED_EDGE_KINDS.includes(rel?.kind)) fail("unknown_edge_kind", { id, kind: rel?.kind });
      if (rel?.target && !ids.has(rel.target) && !sourceIds.has(rel.target)) {
        fail("dangling_relationship_target", { id, target: rel.target });
      }
    }
  }

  for (const cycle of findCycles(nodes)) fail("cycle", { cycle });

  // §2: the last line of defence before anything is written.
  const leaked = scanArtifact(candidate, redactor ? { redactor } : {});
  for (const hit of leaked) fail("raw_secret_in_candidate", { type: hit.type });

  return {
    candidate_valid: failures.length === 0,
    failures,
    counts: {
      projections: nodes.length,
      relationships: nodes.reduce((n, x) => n + (x.relationships?.length || 0), 0),
      evidence: nodes.reduce((n, x) => n + (x.evidence?.length || 0), 0),
    },
  };
}

/** Every cycle reachable in the candidate's child graph. */
export function findCycles(nodes) {
  const children = new Map(nodes.map((n) => [n.candidate_id, n.direct_children || []]));
  const state = new Map();
  const cycles = [];
  const walk = (id, stack) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, "open");
    for (const child of children.get(id) || []) walk(child, [...stack, child]);
    state.set(id, "done");
  };
  for (const node of nodes) walk(node.candidate_id, [node.candidate_id]);
  return cycles;
}

/**
 * A deterministic repair, kept SEPARATE from the original.
 *
 * The spec is explicit: do not repair invisibly and score the repair as the
 * model's output. The original failure stays recorded; this exists only so a
 * broken candidate can still be analysed.
 */
export function normalizeCandidate(candidate, snapshot) {
  const sourceIds = new Set((snapshot?.redacted || []).map((r) => r.id));
  const nodes = (candidate?.projections || []).filter((n) => n?.candidate_id);
  const ids = new Set(nodes.map((n) => n.candidate_id));
  return {
    ...candidate,
    normalized: true,
    projections: nodes.map((node) => {
      const clean = { ...node };
      for (const field of FORBIDDEN_FIELDS) delete clean[field];
      delete clean.text;
      clean.direct_children = (node.direct_children || []).filter((c) => ids.has(c) || sourceIds.has(c));
      clean.source_observation_ids = (node.source_observation_ids || []).filter((s) => sourceIds.has(s));
      clean.relationships = (node.relationships || []).filter(
        (r) => ALLOWED_EDGE_KINDS.includes(r?.kind) && (ids.has(r.target) || sourceIds.has(r.target)),
      );
      return clean;
    }),
  };
}
