import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  EPISTEMIC_CLASSES,
  OBSERVATION_KINDS,
  TIME_PRECISIONS,
} from "./lib/continuity-observations.mjs";

const file = path.resolve(process.argv[2] || "public/data/continuity-observations.json");
if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
const doc = JSON.parse(fs.readFileSync(file, "utf8"));

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const iso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

if (doc.version !== 1) fail("document", "version must be 1");
if (!iso(doc.generatedAt)) fail("document", "generatedAt must be an ISO date-time");
if (!Array.isArray(doc.observations)) fail("document", "observations must be an array");

const ids = new Set();
for (const [index, obs] of (doc.observations || []).entries()) {
  const where = `observations[${index}]`;
  if (!/^obs_[a-f0-9]{16}$/.test(obs?.id || "")) fail(where, "invalid id");
  if (ids.has(obs?.id)) fail(where, `duplicate id ${obs.id}`);
  ids.add(obs?.id);
  if (!OBSERVATION_KINDS.has(obs?.kind)) fail(where, `unsupported kind ${JSON.stringify(obs?.kind)}`);
  if (!EPISTEMIC_CLASSES.has(obs?.epistemic)) fail(where, `unsupported epistemic class ${JSON.stringify(obs?.epistemic)}`);
  if (!TIME_PRECISIONS.has(obs?.timePrecision)) fail(where, `unsupported timePrecision ${JSON.stringify(obs?.timePrecision)}`);
  if (!iso(obs?.observedAt)) fail(where, "observedAt must be an ISO date-time");
  if (obs?.occurredAt != null && !iso(obs.occurredAt)) fail(where, "occurredAt must be null or an ISO date-time");
  if (!obs?.source?.kind || !obs?.source?.ref) fail(where, "source.kind and source.ref are required");
  if (!String(obs?.summary || "").trim()) fail(where, "summary is required");
  if (obs?.confidence != null && (typeof obs.confidence !== "number" || obs.confidence < 0 || obs.confidence > 1)) {
    fail(where, "confidence must be between 0 and 1");
  }
  if (obs?.timePrecision === "month" && obs?.occurredAt && !obs.occurredAt.endsWith("-01T00:00:00.000Z")) {
    fail(where, "month-precision occurredAt must use the normalized first-of-month instant");
  }
}

if (errors.length) {
  console.error(`Continuity observation validation failed (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const counts = doc.observations.reduce((acc, obs) => {
  acc[obs.kind] = (acc[obs.kind] || 0) + 1;
  return acc;
}, {});
console.log(`Continuity observations valid: ${doc.observations.length}`);
console.log(`kinds: ${JSON.stringify(counts)}`);
