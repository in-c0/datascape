// Run one or more private/local Continuity observation adapters without
// coupling their source-specific parsing logic to the public Datascape repo.
//
// Usage:
//   npm run continuity:adapters -- --out .data/continuity-observations.json ./private-ops-adapter.mjs
//   npm run continuity:adapters -- --dry-run ./tests/fixtures/continuity-adapter.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runObservationAdapters } from "./lib/continuity-adapters.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
let outFile = null;
const adapterPaths = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run" || arg === "--replace") continue;
  if (arg === "--out") {
    outFile = path.resolve(args[++i]);
    continue;
  }
  if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
  adapterPaths.push(path.resolve(arg));
}

if (!adapterPaths.length) {
  throw new Error("provide at least one adapter module path");
}
if (!outFile && !dryRun) {
  throw new Error("--out <file> is required unless --dry-run is used");
}

let existing = null;
if (!replace && outFile && fs.existsSync(outFile)) {
  existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
}

const { runs, document } = await runObservationAdapters(adapterPaths, {
  existing,
  context: {
    cwd: process.cwd(),
    env: process.env,
  },
});

console.log(`Continuity adapters ${dryRun ? "dry run " : ""}OK`);
for (const run of runs) console.log(`- ${run.name}: ${run.count} observation${run.count === 1 ? "" : "s"}`);
console.log(`merged observations: ${document.observations.length}`);

if (!dryRun) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(document, null, 2) + "\n");
  console.log(`wrote ${outFile}`);
}
