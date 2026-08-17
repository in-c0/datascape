// Build the first interpreted Continuity graph from normalized observations.
// This v1 builder is intentionally conservative: it creates typed records,
// scope/entity links, and safe same-source supersession only. It does not infer
// causes, support, contradictions, or decisions from activity.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildContinuityGraph, graphStats } from "./lib/continuity-graph.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("--"));
const dataDir = path.resolve(positional[0] || "public/data");
const input = path.join(dataDir, "continuity-observations.json");
const output = path.join(dataDir, "continuity-graph.json");

if (!fs.existsSync(input)) {
  throw new Error(`missing ${input}; run npm run continuity:observations -- ${dataDir} first`);
}

const observations = JSON.parse(fs.readFileSync(input, "utf8"));
const graph = buildContinuityGraph(observations);
const stats = graphStats(graph);

console.log(`Continuity graph ${dryRun ? "dry run " : ""}OK`);
console.log(`observations: ${observations.observations?.length || 0}`);
console.log(`nodes: ${stats.nodes} ${JSON.stringify(stats.nodeKinds)}`);
console.log(`edges: ${stats.edges} ${JSON.stringify(stats.edgeKinds)}`);
console.log(`output: ${output}`);

if (!dryRun) fs.writeFileSync(output, JSON.stringify(graph, null, 2) + "\n");
