import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const file = path.resolve(process.argv[2] || "public/data/continuity-graph.json");
if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
const graph = JSON.parse(fs.readFileSync(file, "utf8"));

const NODE_KINDS = new Set(["entity", "state", "activity", "commitment", "decision", "hypothesis", "evidence", "constraint", "metric", "objective", "cognition"]);
const EDGE_KINDS = new Set(["about", "part_of", "supersedes", "supports", "contradicts", "depends_on", "causes", "related_to"]);
const EPISTEMIC = new Set(["observed", "reported", "inferred", "projected"]);
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const iso = (value) => value == null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));

if (graph.version !== 1) fail("document", "version must be 1");
if (!iso(graph.generatedAt)) fail("document", "generatedAt must be an ISO date-time");
if (!Array.isArray(graph.nodes)) fail("document", "nodes must be an array");
if (!Array.isArray(graph.edges)) fail("document", "edges must be an array");

const nodeIds = new Set();
for (const [i, node] of (graph.nodes || []).entries()) {
  const where = `nodes[${i}]`;
  if (!/^(sem|ent)_[a-f0-9]{16}$/.test(node?.id || "")) fail(where, "invalid id");
  if (nodeIds.has(node?.id)) fail(where, `duplicate id ${node.id}`);
  nodeIds.add(node?.id);
  if (!NODE_KINDS.has(node?.kind)) fail(where, `unsupported kind ${JSON.stringify(node?.kind)}`);
  if (!EPISTEMIC.has(node?.epistemic)) fail(where, `unsupported epistemic ${JSON.stringify(node?.epistemic)}`);
  if (!String(node?.label || "").trim()) fail(where, "label is required");
  if (!String(node?.summary || "").trim()) fail(where, "summary is required");
  if (!Array.isArray(node?.sourceObservationIds)) fail(where, "sourceObservationIds must be an array");
  if (!iso(node?.validFrom) || !iso(node?.validTo)) fail(where, "validFrom/validTo must be null or ISO date-times");
  if (node?.validFrom && node?.validTo && Date.parse(node.validTo) < Date.parse(node.validFrom)) fail(where, "validTo cannot precede validFrom");
  if (node?.kind === "entity" && !["project", "workstream", "session"].includes(node.entityType)) fail(where, "entity node requires entityType");
}

const edgeIds = new Set();
for (const [i, edge] of (graph.edges || []).entries()) {
  const where = `edges[${i}]`;
  if (!/^edge_[a-f0-9]{16}$/.test(edge?.id || "")) fail(where, "invalid id");
  if (edgeIds.has(edge?.id)) fail(where, `duplicate id ${edge.id}`);
  edgeIds.add(edge?.id);
  if (!EDGE_KINDS.has(edge?.kind)) fail(where, `unsupported kind ${JSON.stringify(edge?.kind)}`);
  if (!EPISTEMIC.has(edge?.epistemic)) fail(where, `unsupported epistemic ${JSON.stringify(edge?.epistemic)}`);
  if (!nodeIds.has(edge?.from)) fail(where, `missing from node ${edge?.from}`);
  if (!nodeIds.has(edge?.to)) fail(where, `missing to node ${edge?.to}`);
  if (edge?.from === edge?.to) fail(where, "self edges are not allowed");
  if (!Array.isArray(edge?.sourceObservationIds)) fail(where, "sourceObservationIds must be an array");
}

// The edge kinds that assert temporal/hierarchical direction must remain acyclic.
const acyclicKinds = new Set(["part_of", "supersedes", "depends_on", "causes"]);
const next = new Map();
for (const edge of graph.edges || []) {
  if (!acyclicKinds.has(edge.kind)) continue;
  if (!next.has(edge.from)) next.set(edge.from, []);
  next.get(edge.from).push(edge.to);
}
const visiting = new Set();
const visited = new Set();
function dfs(id) {
  if (visiting.has(id)) return false;
  if (visited.has(id)) return true;
  visiting.add(id);
  for (const to of next.get(id) || []) if (!dfs(to)) return false;
  visiting.delete(id);
  visited.add(id);
  return true;
}
for (const id of nodeIds) {
  if (!dfs(id)) {
    fail("graph", `cycle detected through ${id}`);
    break;
  }
}

if (errors.length) {
  console.error(`Continuity graph validation failed (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Continuity graph valid: ${graph.nodes.length} nodes · ${graph.edges.length} edges`);
