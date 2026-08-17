const MAX_NEIGHBORS = 4;

export const CONTINUITY_STATUS = new Set([
  "live",
  "committed",
  "merged",
  "superseded",
  "deferred",
  "reverted",
  "blocked",
  "needs_human",
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function resolutionLevel(concept, resolution) {
  const levels = concept?.resolutions?.length || 1;
  if (levels <= 1) return 0;
  return Math.round(clamp(resolution, 0, 1) * (levels - 1));
}

export function resolutionStep(concept) {
  const levels = concept?.resolutions?.length || 1;
  return levels <= 1 ? 1 : 1 / (levels - 1);
}

export function conceptHistory(data, conceptId) {
  return data.snapshots.map((snapshot) => {
    const concept = snapshot.concepts?.[conceptId];
    return {
      snapshotId: snapshot.id,
      label: snapshot.label,
      exists: Boolean(concept),
      status: concept?.status || null,
      summary: concept?.summary || null,
    };
  });
}

function normalizeStatus(status, fallback = "merged") {
  return CONTINUITY_STATUS.has(status) ? status : fallback;
}

function literalNode(snapshot, label) {
  const concept = snapshot.concepts?.[label];
  if (!concept) return null;
  return {
    label,
    status: normalizeStatus(concept.status),
    summary: concept.summary || "",
    dynamic: false,
    clickable: true,
  };
}

export function buildContinuityViewport(data, {
  timeIndex,
  selectedId,
  resolution,
}) {
  const snapshots = data?.snapshots || [];
  const safeTimeIndex = clamp(timeIndex, 0, Math.max(0, snapshots.length - 1));
  const snapshot = snapshots[safeTimeIndex];

  if (!snapshot) return null;

  const requestedId = selectedId || snapshot.dominant;
  const concept = snapshot.concepts?.[requestedId] || null;
  const history = conceptHistory(data, requestedId);

  // Historical ontology is part of the state. If a concept did not exist at
  // this time, preserve that absence rather than silently replacing it with
  // today's ontology or the snapshot's dominant concept.
  if (!concept) {
    const dominant = literalNode(snapshot, snapshot.dominant);
    return {
      snapshot,
      selectedId: requestedId,
      concept: null,
      absent: true,
      level: 0,
      parent: null,
      neighbors: dominant ? [dominant] : [],
      history,
      summary: `“${requestedId}” was not represented as a meaningful concept at this point in time.`,
    };
  }

  const level = resolutionLevel(concept, resolution);
  const configuredMax = Number(data.attentionBudget?.maxNeighbors) || MAX_NEIGHBORS;
  const maxNeighbors = clamp(configuredMax, 1, MAX_NEIGHBORS);
  const labels = (concept.resolutions?.[level] || []).slice(0, maxNeighbors);

  const neighbors = labels.map((label) => {
    const literal = literalNode(snapshot, label);
    if (literal) return literal;
    return {
      label,
      status: concept.status === "live" ? "live" : "merged",
      summary: `${label} is a semantic projection of ${requestedId} at this resolution.`,
      dynamic: true,
      clickable: false,
    };
  });

  const parent = concept.parent ? literalNode(snapshot, concept.parent) : null;

  return {
    snapshot,
    selectedId: requestedId,
    concept,
    absent: false,
    level,
    parent,
    neighbors,
    history,
    summary: concept.summary || "",
  };
}
