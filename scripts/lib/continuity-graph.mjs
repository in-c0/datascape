import { createHash } from "node:crypto";

const hash16 = (parts) =>
  createHash("sha256").update(parts.map((x) => String(x ?? "")).join("\u241f")).digest("hex").slice(0, 16);

const nodeId = (prefix, ...parts) => `${prefix}_${hash16(parts)}`;
const edgeId = (...parts) => `edge_${hash16(parts)}`;

const GRAPH_KIND_BY_OBSERVATION = {
  state: "state",
  activity: "activity",
  commitment: "commitment",
  decision: "decision",
  hypothesis: "hypothesis",
  evidence: "evidence",
  blocker: "constraint",
  metric: "metric",
  objective: "objective",
  exception: "constraint",
  relationship: "evidence",
  cognition: "cognition",
};

const timeOf = (obs) => obs.occurredAt || obs.observedAt || null;
const clip = (s, n = 88) => (String(s || "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ""));

function entityNode(entityType, value) {
  return {
    id: nodeId("ent", entityType, value),
    kind: "entity",
    entityType,
    label: value,
    summary: `${entityType} ${value}`,
    epistemic: "inferred",
    sourceObservationIds: [],
  };
}

function recordNode(obs) {
  const graphKind = GRAPH_KIND_BY_OBSERVATION[obs.kind] || "evidence";
  const scopeLabel = obs.scope?.project || obs.scope?.workstream || obs.scope?.session || graphKind;
  return {
    id: nodeId("sem", obs.id, graphKind),
    kind: graphKind,
    label: clip(`${scopeLabel} · ${graphKind}`, 72),
    summary: obs.summary,
    epistemic: obs.epistemic,
    ...(obs.scope ? { scope: obs.scope } : {}),
    validFrom: timeOf(obs),
    validTo: null,
    timePrecision: obs.timePrecision,
    ...(obs.confidence == null ? {} : { confidence: obs.confidence }),
    sourceObservationIds: [obs.id],
  };
}

function pushUnique(map, value) {
  if (!map.has(value.id)) map.set(value.id, value);
  return map.get(value.id);
}

function makeEdge({ kind, from, to, epistemic = "inferred", sourceObservationIds = [], confidence }) {
  return {
    id: edgeId(kind, from, to, ...sourceObservationIds),
    kind,
    from,
    to,
    epistemic,
    ...(confidence == null ? {} : { confidence }),
    sourceObservationIds: [...new Set(sourceObservationIds)],
  };
}

export function buildContinuityGraph(observationDocument, { generatedAt = new Date().toISOString() } = {}) {
  if (observationDocument?.version !== 1 || !Array.isArray(observationDocument.observations)) {
    throw new Error("Continuity graph builder requires a version-1 observation document");
  }

  const nodes = new Map();
  const edges = new Map();
  const recordByObservation = new Map();

  for (const obs of observationDocument.observations) {
    const record = pushUnique(nodes, recordNode(obs));
    recordByObservation.set(obs.id, record);

    const scopeEntities = [];
    if (obs.scope?.project) scopeEntities.push(entityNode("project", obs.scope.project));
    if (obs.scope?.workstream) scopeEntities.push(entityNode("workstream", obs.scope.workstream));
    if (obs.scope?.session) scopeEntities.push(entityNode("session", obs.scope.session));

    for (const entity of scopeEntities) pushUnique(nodes, entity);

    for (const entity of scopeEntities) {
      const edge = makeEdge({
        kind: "about",
        from: record.id,
        to: entity.id,
        epistemic: "inferred",
        sourceObservationIds: [obs.id],
      });
      pushUnique(edges, edge);
    }

    if (obs.scope?.project && obs.scope?.workstream) {
      const workstream = entityNode("workstream", obs.scope.workstream);
      const project = entityNode("project", obs.scope.project);
      pushUnique(nodes, workstream);
      pushUnique(nodes, project);
      pushUnique(
        edges,
        makeEdge({
          kind: "part_of",
          from: workstream.id,
          to: project.id,
          sourceObservationIds: [obs.id],
        }),
      );
    }
    if (obs.scope?.workstream && obs.scope?.session) {
      const session = entityNode("session", obs.scope.session);
      const workstream = entityNode("workstream", obs.scope.workstream);
      pushUnique(nodes, session);
      pushUnique(nodes, workstream);
      pushUnique(
        edges,
        makeEdge({
          kind: "part_of",
          from: session.id,
          to: workstream.id,
          sourceObservationIds: [obs.id],
        }),
      );
    } else if (obs.scope?.project && obs.scope?.session) {
      const session = entityNode("session", obs.scope.session);
      const project = entityNode("project", obs.scope.project);
      pushUnique(nodes, session);
      pushUnique(nodes, project);
      pushUnique(
        edges,
        makeEdge({
          kind: "part_of",
          from: session.id,
          to: project.id,
          sourceObservationIds: [obs.id],
        }),
      );
    }
  }

  // Supersession is the only temporal semantic edge inferred automatically in
  // v1. It is safe because the observations came from the same source field
  // and semantic kind; newer source state replaces older source state. We do
  // NOT infer causes/support/decisions from mere temporal adjacency.
  const lineage = new Map();
  for (const obs of observationDocument.observations) {
    if (!["state", "commitment", "decision", "hypothesis", "blocker", "objective", "exception"].includes(obs.kind)) continue;
    const key = [
      obs.kind,
      obs.source?.kind,
      obs.source?.ref,
      obs.scope?.project,
      obs.scope?.workstream,
      obs.scope?.session,
    ].join("|");
    if (!lineage.has(key)) lineage.set(key, []);
    lineage.get(key).push(obs);
  }

  for (const group of lineage.values()) {
    group.sort((a, b) => String(timeOf(a) || "").localeCompare(String(timeOf(b) || "")) || a.id.localeCompare(b.id));
    for (let i = 1; i < group.length; i++) {
      const older = group[i - 1];
      const newer = group[i];
      const olderNode = recordByObservation.get(older.id);
      const newerNode = recordByObservation.get(newer.id);
      if (!olderNode || !newerNode || olderNode.id === newerNode.id) continue;
      olderNode.validTo = timeOf(newer);
      pushUnique(
        edges,
        makeEdge({
          kind: "supersedes",
          from: newerNode.id,
          to: olderNode.id,
          epistemic: "inferred",
          sourceObservationIds: [older.id, newer.id],
        }),
      );
    }
  }

  return {
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    observationGeneratedAt: observationDocument.generatedAt || null,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function graphStats(graph) {
  const nodeKinds = {};
  const edgeKinds = {};
  for (const node of graph.nodes || []) nodeKinds[node.kind] = (nodeKinds[node.kind] || 0) + 1;
  for (const edge of graph.edges || []) edgeKinds[edge.kind] = (edgeKinds[edge.kind] || 0) + 1;
  return { nodes: graph.nodes?.length || 0, edges: graph.edges?.length || 0, nodeKinds, edgeKinds };
}
