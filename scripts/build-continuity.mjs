// Build one immutable Continuity semantic snapshot from an existing Datascape
// data folder. Runs locally; the browser never needs an LLM key.
//
// Usage:
//   node scripts/build-continuity.mjs public/data
//   node scripts/build-continuity.mjs public/sample-data --dry-run
//
// The generator sends only the already-preprocessed Datascape JSON corpus to
// the configured Anthropic account. It does not read the raw ChatGPT export.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { normalizeDatascapeBundle } from "./lib/continuity-observations.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const positional = args.filter((arg) => !arg.startsWith("--"));
const dataDir = path.resolve(positional[0] || "public/data");
const outFile = path.join(dataDir, "continuity.json");
const thoughtLimit = Math.max(20, Math.min(300, Number(process.env.CONTINUITY_THOUGHT_LIMIT) || 120));
const observationLimit = Math.max(40, Math.min(500, Number(process.env.CONTINUITY_OBSERVATION_LIMIT) || 220));
const graphNodeLimit = Math.max(40, Math.min(600, Number(process.env.CONTINUITY_GRAPH_NODE_LIMIT) || 320));
const graphEdgeLimit = Math.max(40, Math.min(900, Number(process.env.CONTINUITY_GRAPH_EDGE_LIMIT) || 500));
const model = process.env.DATASCAPE_CONTINUITY_MODEL || "claude-opus-4-8";

function readJson(name, { optional = false } = {}) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const content = readJson("content.json");
const thoughts = readJson("thoughts.json");
const provenance = readJson("provenance.json", { optional: true }) || {};
const evidence = readJson("evidence.json", { optional: true }) || {};
const gitHistory = readJson("git-history.json", { optional: true }) || {};
const observationFile = readJson("continuity-observations.json", { optional: true });
const graphFile = readJson("continuity-graph.json", { optional: true });

const projects = Array.isArray(content.projects) ? content.projects : [];
const projectByIndex = projects.map((project) => project.title || project.id);
const allThoughts = Array.isArray(thoughts.thoughts) ? thoughts.thoughts : [];
const latestThoughts = [...allThoughts]
  .sort((a, b) => String(a.m || "").localeCompare(String(b.m || "")))
  .slice(-thoughtLimit)
  .map((thought) => ({
    month: thought.m || null,
    title: thought.t || null,
    prompt: thought.q || null,
    project: Number.isInteger(thought.pj) ? projectByIndex[thought.pj] || null : null,
    messages: thought.n || null,
  }));

const projectContext = projects.map((project) => ({
  id: project.id,
  title: project.title,
  category: project.category,
  status: project.status,
  flagship: Boolean(project.flagship),
  description: project.desc,
  stack: project.stack,
  provenance: provenance[project.id] || null,
  evidence: evidence[project.id] || null,
}));

// A private deployment may supply continuity-observations.json from additional
// adapters (_hub, exceptions, sessions, tool state, etc). Otherwise build the
// same generic contract in memory from the ordinary Datascape bundle.
const normalizedDocument = observationFile?.version === 1 && Array.isArray(observationFile.observations)
  ? observationFile
  : normalizeDatascapeBundle(
      { content, thoughts, provenance, evidence, gitHistory },
      { thoughtLimit },
    );

const normalizedObservations = [...normalizedDocument.observations]
  .sort((a, b) => String(a.occurredAt || a.observedAt || "").localeCompare(String(b.occurredAt || b.observedAt || "")))
  .slice(-observationLimit)
  .map((observation) => ({
    id: observation.id,
    kind: observation.kind,
    observedAt: observation.observedAt,
    occurredAt: observation.occurredAt || null,
    timePrecision: observation.timePrecision,
    epistemic: observation.epistemic,
    source: observation.source,
    scope: observation.scope || null,
    summary: observation.summary,
    confidence: observation.confidence ?? null,
    payload: observation.payload || null,
  }));

// The graph is an interpreted layer over observations, not a replacement for
// them. Keep only the graph region grounded in the observations supplied to
// this generation run plus structural entity nodes connected to that region.
const recentObservationIds = new Set(normalizedObservations.map((observation) => observation.id));
let semanticGraph = null;
if (graphFile?.version === 1 && Array.isArray(graphFile.nodes) && Array.isArray(graphFile.edges)) {
  const seededNodeIds = new Set(
    graphFile.nodes
      .filter((node) => (node.sourceObservationIds || []).some((id) => recentObservationIds.has(id)))
      .map((node) => node.id),
  );
  const candidateEdges = graphFile.edges.filter(
    (edge) =>
      (edge.sourceObservationIds || []).some((id) => recentObservationIds.has(id)) ||
      seededNodeIds.has(edge.from) ||
      seededNodeIds.has(edge.to),
  );
  const connectedNodeIds = new Set(seededNodeIds);
  for (const edge of candidateEdges) {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  }
  const candidateNodes = graphFile.nodes.filter((node) => connectedNodeIds.has(node.id));
  const keptNodes = candidateNodes.slice(-graphNodeLimit);
  const keptNodeIds = new Set(keptNodes.map((node) => node.id));
  const keptEdges = candidateEdges
    .filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to))
    .slice(-graphEdgeLimit);
  semanticGraph = {
    generatedAt: graphFile.generatedAt || null,
    nodes: keptNodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      entityType: node.entityType || null,
      label: node.label,
      summary: node.summary,
      epistemic: node.epistemic,
      scope: node.scope || null,
      validFrom: node.validFrom || null,
      validTo: node.validTo || null,
      timePrecision: node.timePrecision || null,
      confidence: node.confidence ?? null,
      sourceObservationIds: node.sourceObservationIds || [],
    })),
    edges: keptEdges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      epistemic: edge.epistemic,
      confidence: edge.confidence ?? null,
      sourceObservationIds: edge.sourceObservationIds || [],
    })),
  };
}

const source = {
  corpus: {
    firstMonth: thoughts.meta?.firstMonth || null,
    lastMonth: thoughts.meta?.lastMonth || content.corpusLastMonth || null,
    thoughtCount: thoughts.meta?.thoughts || allThoughts.length,
    messageCount: thoughts.meta?.messages || null,
  },
  projects: projectContext,
  recentThoughts: latestThoughts,
  normalizedObservations,
  semanticGraph,
};

const SYSTEM = `You are Datascape's Continuity abstraction engine.

Your job is NOT to summarize a portfolio. Infer the smallest useful current decision-state view from the supplied preprocessed project/chat/git metadata, normalized observations, and (when present) a conservative temporal semantic graph.

Continuity is an attention-bounded semantic viewport over ongoing work. Produce a CURRENT semantic snapshot only. A later run will append this snapshot immutably to history.

Normalized observations are the interoperable ingestion layer. Their epistemic field is meaningful:
- observed = directly measured source fact
- reported = asserted by an authoritative source record
- inferred = derived interpretation
- projected = generated semantic interpretation
Never silently promote inferred/projected material into observed evidence. A projected observation cannot be evidence for itself.

The semanticGraph is an interpreted convenience layer over those observations, not a new source of truth. In the current deterministic graph builder, about/part_of/supersedes edges may be inferred safely from provenance and same-source temporal lineage. Do NOT treat temporal adjacency as causation. The absence of a causes/supports/contradicts edge means only that no such relationship is asserted in the supplied graph, not that the relationship is false. Respect every graph node/edge epistemic class and trace claims back to sourceObservationIds when deciding whether they can support evidence text.

Rules:
- Express meaningful state, commitments, constraints, unresolved hypotheses, and decisions — not raw activity feeds.
- Never invent a commitment. Use "committed" only when the supplied evidence clearly supports that it is already settled.
- Do not infer a decision merely because code changed, a conversation occurred, or a project is marked active.
- Use "live" for unresolved cognition, active hypotheses, or an unsettled decision frontier.
- "needs_human" is reserved for a genuinely human-only commitment or value choice.
- Preserve uncertainty. If the evidence is weak, say so in the summary rather than manufacturing confidence.
- The dominant concept is the single concept that best explains what deserves attention now.
- Produce 3-8 persisted concepts total. Persist a concept only if the user may reasonably want to recenter on it.
- Each concept gets exactly 3 semantic resolutions. Each resolution contains 2-4 short labels.
- Resolution labels may be dynamic abstractions and therefore do not all need to be persisted concepts.
- Parent links form a DAG-like local semantic ancestry but MUST be acyclic within this snapshot.
- Evidence strings must be short paraphrases traceable to supplied observed/reported source material; do not fabricate metrics.
- The largeContext sentence must let a returning operator recover the current overall state in seconds.
- Avoid agent names, tool-call counts, token counts, and implementation chatter unless they are themselves decision-relevant.
- Keep labels terse; prefer state transitions such as "distribution now dominates" over generic nouns such as "marketing".

The human-facing viewport will show one center plus at most four neighbors. Compression quality matters more than completeness.`;

const SCHEMA = {
  type: "object",
  properties: {
    largeContext: { type: "string" },
    dominant: { type: "string" },
    concepts: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          parent: { type: ["string", "null"] },
          status: {
            type: "string",
            enum: [
              "live",
              "committed",
              "merged",
              "superseded",
              "deferred",
              "reverted",
              "blocked",
              "needs_human"
            ],
          },
          summary: { type: "string" },
          resolutions: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: { type: "string" },
            },
          },
          evidence: {
            type: "array",
            maxItems: 6,
            items: { type: "string" },
          },
        },
        required: ["label", "parent", "status", "summary", "resolutions", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["largeContext", "dominant", "concepts"],
  additionalProperties: false,
};

function assertGenerated(result) {
  if (!result || typeof result !== "object") throw new Error("generator returned no object");
  if (!result.largeContext?.trim()) throw new Error("generator returned no largeContext");
  if (!result.dominant?.trim()) throw new Error("generator returned no dominant concept");
  if (!Array.isArray(result.concepts) || result.concepts.length < 1) throw new Error("generator returned no concepts");

  const labels = new Set();
  for (const concept of result.concepts) {
    if (!concept.label?.trim()) throw new Error("generated concept has no label");
    if (labels.has(concept.label)) throw new Error(`duplicate generated concept: ${concept.label}`);
    labels.add(concept.label);
  }
  if (!labels.has(result.dominant)) {
    throw new Error(`dominant concept ${JSON.stringify(result.dominant)} was not persisted`);
  }
  for (const concept of result.concepts) {
    if (concept.parent && !labels.has(concept.parent)) {
      throw new Error(`concept ${JSON.stringify(concept.label)} has missing parent ${JSON.stringify(concept.parent)}`);
    }
  }

  // Detect parent cycles before the snapshot can enter immutable history.
  const byLabel = Object.fromEntries(result.concepts.map((concept) => [concept.label, concept]));
  for (const concept of result.concepts) {
    const seen = new Set([concept.label]);
    let cursor = concept.parent;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`parent cycle detected through ${cursor}`);
      seen.add(cursor);
      cursor = byLabel[cursor]?.parent || null;
    }
  }
}

function toSnapshot(result) {
  const generatedAt = new Date().toISOString();
  const concepts = Object.fromEntries(
    result.concepts.map(({ label, parent, ...concept }) => [
      label,
      {
        ...(parent ? { parent } : {}),
        ...concept,
      },
    ]),
  );

  return {
    id: generatedAt,
    label: generatedAt.replace("T", " ").slice(0, 16) + "Z",
    generatedAt,
    source: {
      kind: "llm_projection",
      generator: "scripts/build-continuity.mjs",
      model,
      projects: projects.length,
      suppliedThoughts: latestThoughts.length,
      normalizedObservations: normalizedObservations.length,
      graphNodes: semanticGraph?.nodes.length || 0,
      graphEdges: semanticGraph?.edges.length || 0,
      corpusThoughts: thoughts.meta?.thoughts || allThoughts.length,
      corpusMessages: thoughts.meta?.messages || null,
    },
    largeContext: result.largeContext,
    dominant: result.dominant,
    hiddenCount: normalizedDocument.observations.length || thoughts.meta?.messages || thoughts.meta?.thoughts || allThoughts.length,
    concepts,
  };
}

function existingDocument() {
  if (replace || !fs.existsSync(outFile)) {
    return {
      _readme: "Generated by scripts/build-continuity.mjs from normalized observations, an optional temporal semantic graph, and the preprocessed Datascape corpus. Snapshots are append-only semantic history.",
      attentionBudget: { maxNeighbors: 4, targetReadSeconds: 15 },
      snapshots: [],
    };
  }
  const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
  if (!Array.isArray(parsed.snapshots)) throw new Error(`${outFile} does not contain a snapshots array`);
  return parsed;
}

if (dryRun) {
  console.log(`Continuity dry run OK`);
  console.log(`data: ${dataDir}`);
  console.log(`projects: ${projects.length}`);
  console.log(`thoughts supplied: ${latestThoughts.length}/${allThoughts.length}`);
  console.log(`normalized observations supplied: ${normalizedObservations.length}/${normalizedDocument.observations.length}`);
  console.log(`observation source: ${observationFile ? "continuity-observations.json" : "in-memory standard adapter"}`);
  console.log(`semantic graph supplied: ${semanticGraph ? `${semanticGraph.nodes.length} nodes / ${semanticGraph.edges.length} edges` : "none"}`);
  console.log(`model: ${model}`);
  console.log(`output: ${outFile}`);
  process.exit(0);
}

console.log(`Continuity generation is local, but sends the preprocessed context bundle to the configured Anthropic API.`);
console.log(`projects: ${projects.length} · recent thoughts: ${latestThoughts.length} · observations: ${normalizedObservations.length} · graph: ${semanticGraph ? `${semanticGraph.nodes.length}/${semanticGraph.edges.length}` : "none"} · model: ${model}`);

const client = new Anthropic();
const response = await client.messages.create({
  model,
  max_tokens: 5000,
  output_config: {
    effort: "medium",
    format: { type: "json_schema", schema: SCHEMA },
  },
  system: SYSTEM,
  messages: [
    {
      role: "user",
      content: `Build the next current Continuity snapshot from this Datascape context:\n\n${JSON.stringify(source)}`,
    },
  ],
});

if (response.stop_reason === "refusal") throw new Error("Continuity generation was refused");
const text = response.content.find((block) => block.type === "text")?.text;
if (!text) throw new Error("Continuity generation returned no text output");
const generated = JSON.parse(text);
assertGenerated(generated);

const document = existingDocument();
document.snapshots.push(toSnapshot(generated));

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(document, null, 2) + "\n");
console.log(`wrote ${outFile}`);
console.log(`${document.snapshots.length} continuity snapshot${document.snapshots.length === 1 ? "" : "s"} in history`);
