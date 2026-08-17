const DIRECT_EVIDENCE_EPISTEMIC = new Set(["observed", "reported"]);
const COMMITMENT_SUPPORT_KINDS = new Set(["commitment", "decision", "state", "evidence"]);

const uniqueStrings = (items) => [...new Set((items || []).filter((item) => typeof item === "string" && item))];

export function evidenceSummary(item) {
  if (typeof item === "string") return item;
  return item?.summary || "";
}

export function conceptProvenanceCounts(concept) {
  return {
    observations: uniqueStrings(concept?.sourceObservationIds).length,
    graphNodes: uniqueStrings(concept?.sourceGraphNodeIds).length,
  };
}

export function validateProjectionReferences(result, normalizedObservations, semanticGraph) {
  const errors = [];
  const observations = new Map((normalizedObservations || []).map((observation) => [observation.id, observation]));
  const graphNodes = new Map((semanticGraph?.nodes || []).map((node) => [node.id, node]));

  const requireKnownObservationIds = (ids, at, { directEvidence = false } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      errors.push(`${at}: requires at least one source observation`);
      return [];
    }
    const resolved = [];
    for (const id of uniqueStrings(ids)) {
      const observation = observations.get(id);
      if (!observation) {
        errors.push(`${at}: unknown observation ${id}`);
        continue;
      }
      resolved.push(observation);
    }
    if (directEvidence && resolved.length && !resolved.some((observation) => DIRECT_EVIDENCE_EPISTEMIC.has(observation.epistemic))) {
      errors.push(`${at}: projected/inferred observations cannot be the sole evidence basis`);
    }
    return resolved;
  };

  const requireKnownGraphNodeIds = (ids, at) => {
    if (!Array.isArray(ids)) {
      errors.push(`${at}: sourceGraphNodeIds must be an array`);
      return;
    }
    for (const id of uniqueStrings(ids)) {
      if (!graphNodes.has(id)) errors.push(`${at}: unknown graph node ${id}`);
    }
  };

  for (const [index, concept] of (result?.concepts || []).entries()) {
    const at = `concepts[${index}] ${JSON.stringify(concept?.label)}`;
    const sourceObservations = requireKnownObservationIds(concept?.sourceObservationIds, at, { directEvidence: true });
    requireKnownGraphNodeIds(concept?.sourceGraphNodeIds, at);

    if (concept?.status === "committed") {
      const supportsCommitment = sourceObservations.some(
        (observation) =>
          DIRECT_EVIDENCE_EPISTEMIC.has(observation.epistemic) &&
          COMMITMENT_SUPPORT_KINDS.has(observation.kind),
      );
      if (!supportsCommitment) {
        errors.push(`${at}: committed status requires a direct commitment/decision/state/evidence source`);
      }
    }

    if (!Array.isArray(concept?.evidence)) {
      errors.push(`${at}: evidence must be an array`);
      continue;
    }
    for (const [evidenceIndex, item] of concept.evidence.entries()) {
      const evidenceAt = `${at} evidence[${evidenceIndex}]`;
      if (typeof item === "string") {
        // Legacy/manual snapshots may still use strings. New generated
        // projections are expected to use the structured form and are checked
        // by build-continuity's output schema before reaching this function.
        continue;
      }
      if (!item || typeof item !== "object" || !String(item.summary || "").trim()) {
        errors.push(`${evidenceAt}: requires a summary`);
        continue;
      }
      requireKnownObservationIds(item.sourceObservationIds, evidenceAt, { directEvidence: true });
      requireKnownGraphNodeIds(item.sourceGraphNodeIds, evidenceAt);
    }
  }

  return errors;
}

export function assertProjectionReferences(result, normalizedObservations, semanticGraph) {
  const errors = validateProjectionReferences(result, normalizedObservations, semanticGraph);
  if (errors.length) throw new Error(`Continuity projection provenance invalid:\n- ${errors.join("\n- ")}`);
}
