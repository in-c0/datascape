import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VALID_STATUS = new Set([
  "live",
  "committed",
  "merged",
  "superseded",
  "deferred",
  "reverted",
  "blocked",
  "needs_human",
]);

const VALID_SOURCE_KIND = new Set([
  "synthetic",
  "manual",
  "imported",
  "llm_projection",
  "decision_graph",
]);

const file = path.resolve(process.argv[2] || "public/sample-data/continuity.json");
const errors = [];

function fail(message) {
  errors.push(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateOptionalCount(prefix, source, field) {
  if (source[field] == null) return;
  if (!Number.isInteger(source[field]) || source[field] < 0) {
    fail(`${prefix}: source.${field} must be a non-negative integer when supplied`);
  }
}

function validateSource(prefix, source) {
  if (source == null) return;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail(`${prefix}: source must be an object when supplied`);
    return;
  }
  if (!VALID_SOURCE_KIND.has(source.kind)) {
    fail(`${prefix}: invalid source.kind ${JSON.stringify(source.kind)}`);
  }
  for (const field of ["projects", "suppliedThoughts", "corpusThoughts", "corpusMessages"]) {
    validateOptionalCount(prefix, source, field);
  }
  for (const field of ["generator", "model"]) {
    if (source[field] != null && !nonEmptyString(source[field])) {
      fail(`${prefix}: source.${field} must be a non-empty string when supplied`);
    }
  }
}

function validateConcept(snapshot, name, concept) {
  const at = `snapshot ${snapshot.id} / concept ${JSON.stringify(name)}`;

  if (!concept || typeof concept !== "object" || Array.isArray(concept)) {
    fail(`${at}: must be an object`);
    return;
  }
  if (!VALID_STATUS.has(concept.status)) {
    fail(`${at}: invalid status ${JSON.stringify(concept.status)}`);
  }
  if (!nonEmptyString(concept.summary)) {
    fail(`${at}: summary must be a non-empty string`);
  }
  if (!Array.isArray(concept.resolutions) || concept.resolutions.length === 0) {
    fail(`${at}: resolutions must contain at least one semantic partition`);
  } else {
    concept.resolutions.forEach((partition, index) => {
      if (!Array.isArray(partition) || partition.length === 0) {
        fail(`${at}: resolution ${index} must be a non-empty array`);
        return;
      }
      partition.forEach((label, labelIndex) => {
        if (!nonEmptyString(label)) {
          fail(`${at}: resolution ${index}[${labelIndex}] must be a non-empty string`);
        }
      });
    });
  }
  if (concept.parent != null && !nonEmptyString(concept.parent)) {
    fail(`${at}: parent must be a non-empty string when supplied`);
  }
  if (concept.evidence != null) {
    if (!Array.isArray(concept.evidence)) {
      fail(`${at}: evidence must be an array when supplied`);
    } else {
      concept.evidence.forEach((item, index) => {
        if (!nonEmptyString(item)) fail(`${at}: evidence[${index}] must be a non-empty string`);
      });
    }
  }
}

function validateParentGraph(snapshot) {
  const concepts = snapshot.concepts;
  for (const [name, concept] of Object.entries(concepts)) {
    if (!concept.parent) continue;
    if (!concepts[concept.parent]) {
      fail(`snapshot ${snapshot.id} / concept ${JSON.stringify(name)}: parent ${JSON.stringify(concept.parent)} does not exist in the same historical snapshot`);
      continue;
    }

    const seen = new Set([name]);
    let cursor = concept.parent;
    while (cursor) {
      if (seen.has(cursor)) {
        fail(`snapshot ${snapshot.id}: parent cycle detected through ${JSON.stringify(cursor)}`);
        break;
      }
      seen.add(cursor);
      cursor = concepts[cursor]?.parent || null;
    }
  }
}

let data;
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Continuity validation failed: could not parse ${file}\n${error.message}`);
  process.exit(1);
}

if (!data || typeof data !== "object" || Array.isArray(data)) {
  fail("root must be an object");
}

if (data?.attentionBudget?.maxNeighbors != null) {
  const value = data.attentionBudget.maxNeighbors;
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    fail("attentionBudget.maxNeighbors must be an integer between 1 and 4");
  }
}

if (!Array.isArray(data?.snapshots) || data.snapshots.length === 0) {
  fail("snapshots must be a non-empty array");
} else {
  const ids = new Set();
  for (const [index, snapshot] of data.snapshots.entries()) {
    const prefix = `snapshot[${index}]`;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      fail(`${prefix}: must be an object`);
      continue;
    }
    if (!nonEmptyString(snapshot.id)) fail(`${prefix}: id must be a non-empty string`);
    else if (ids.has(snapshot.id)) fail(`${prefix}: duplicate id ${JSON.stringify(snapshot.id)}`);
    else ids.add(snapshot.id);

    if (!nonEmptyString(snapshot.label)) fail(`${prefix}: label must be a non-empty string`);
    if (!nonEmptyString(snapshot.largeContext)) fail(`${prefix}: largeContext must be a non-empty string`);
    if (!nonEmptyString(snapshot.dominant)) fail(`${prefix}: dominant must be a non-empty string`);
    validateSource(prefix, snapshot.source);

    if (!snapshot.concepts || typeof snapshot.concepts !== "object" || Array.isArray(snapshot.concepts)) {
      fail(`${prefix}: concepts must be an object`);
      continue;
    }
    if (Object.keys(snapshot.concepts).length === 0) fail(`${prefix}: concepts must not be empty`);
    if (snapshot.dominant && !snapshot.concepts[snapshot.dominant]) {
      fail(`${prefix}: dominant concept ${JSON.stringify(snapshot.dominant)} is missing from concepts`);
    }
    if (snapshot.hiddenCount != null && (!Number.isInteger(snapshot.hiddenCount) || snapshot.hiddenCount < 0)) {
      fail(`${prefix}: hiddenCount must be a non-negative integer when supplied`);
    }

    for (const [name, concept] of Object.entries(snapshot.concepts)) {
      if (!nonEmptyString(name)) fail(`${prefix}: concept keys must be non-empty strings`);
      validateConcept(snapshot, name, concept);
    }
    validateParentGraph(snapshot);
  }
}

if (errors.length) {
  console.error(`Continuity validation failed for ${file}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Continuity data valid: ${file}`);
console.log(`${data.snapshots.length} snapshots · ${data.snapshots.reduce((sum, snapshot) => sum + Object.keys(snapshot.concepts).length, 0)} persisted concepts`);
