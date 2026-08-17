// Normalize ordinary Datascape runtime data into Continuity observations.
// Source files remain authoritative; this file is a derived, append-safe cache.
//
// Usage:
//   node scripts/build-continuity-observations.mjs public/data
//   node scripts/build-continuity-observations.mjs public/sample-data --dry-run

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  mergeObservationDocuments,
  normalizeDatascapeBundle,
} from "./lib/continuity-observations.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const positional = args.filter((arg) => !arg.startsWith("--"));
const dataDir = path.resolve(positional[0] || "public/data");
const outFile = path.join(dataDir, "continuity-observations.json");
const thoughtLimit = Math.max(0, Math.min(500, Number(process.env.CONTINUITY_OBSERVATION_THOUGHT_LIMIT) || 120));

function readJson(name, { optional = false } = {}) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const bundle = {
  content: readJson("content.json"),
  thoughts: readJson("thoughts.json"),
  evidence: readJson("evidence.json", { optional: true }) || {},
  gitHistory: readJson("git-history.json", { optional: true }) || {},
  provenance: readJson("provenance.json", { optional: true }) || {},
};

const incoming = normalizeDatascapeBundle(bundle, { thoughtLimit });
const counts = incoming.observations.reduce((acc, obs) => {
  acc[obs.kind] = (acc[obs.kind] || 0) + 1;
  return acc;
}, {});

if (dryRun) {
  console.log("Continuity observation dry run OK");
  console.log(`data: ${dataDir}`);
  console.log(`observations: ${incoming.observations.length}`);
  console.log(`kinds: ${JSON.stringify(counts)}`);
  console.log(`output: ${outFile}`);
  process.exit(0);
}

let existing = null;
if (!replace && fs.existsSync(outFile)) {
  existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
}

const merged = replace ? incoming : mergeObservationDocuments(existing, incoming, incoming.generatedAt);
fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n");

console.log(`wrote ${outFile}`);
console.log(`observations: ${merged.observations.length} (${incoming.observations.length} seen this run)`);
console.log(`kinds: ${JSON.stringify(counts)}`);
