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
const VALID_EXECUTION_STATE = new Set(["running", "completed", "planned"]);
const VALID_SUPERVISION = new Set(["attended", "unattended"]);

const VALID_SOURCE_KIND = new Set([
  "synthetic",
  "manual",
  "imported",
  "llm_projection",
  "decision_graph",
]);

const OBSERVATION_ID = /^obs_[a-f0-9]{16}$/;
const GRAPH_NODE_ID = /^(sem|ent)_[a-f0-9]{16}$/;

const file = path.resolve(process.argv[2] || "public/sample-data/continuity.json");
const dataDir = path.dirname(file);
const errors = [];

function fail(message) {
  errors.push(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readOptionalJson(name) {
  const target = path.join(dataDir, name);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    fail(`${name}: could not parse sidecar for provenance validation: ${error.message}`);
    return null;
  }
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
  for (const field of [
    "projects",
    "suppliedThoughts",
    "normalizedObservations",
    "graphNodes",
    "graphEdges",
    "corpusThoughts",
    "corpusMessages",
  ]) {
    validateOptionalCount(prefix, source, field);
  }
  for (const field of ["generator", "model"]) {
    if (source[field] != null && !nonEmptyString(source[field])) {
      fail(`${prefix}: source.${field} must be a non-empty string when supplied`);
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

const observationSidecar = readOptionalJson("continuity-observations.json");
const graphSidecar = readOptionalJson("continuity-graph.json");
const knownObservationIds = observationSidecar?.observations
  ? new Set(observationSidecar.observations.map((observation) => observation.id))
  : null;
const knownGraphNodeIds = graphSidecar?.nodes
  ? new Set(graphSidecar.nodes.map((node) => node.id))
  : null;

function validateReferenceArray(at, value, pattern, knownIds, { requireOne = false } = {}) {
  if (value == null) {
    if (requireOne) fail(`${at}: must contain at least one reference`);
    return;
  }
  if (!Array.isArray(value)) {
    fail(`${at}: must be an array when supplied`);
    return;
  }
  if (requireOne && value.length === 0) fail(`${at}: must contain at least one reference`);
  const seen = new Set();
  for (const [index, id] of value.entries()) {
    if (!pattern.test(id || "")) fail(`${at}[${index}]: invalid reference ${JSON.stringify(id)}`);
    if (seen.has(id)) fail(`${at}[${index}]: duplicate reference ${id}`);
    seen.add(id);
    if (knownIds && !knownIds.has(id)) fail(`${at}[${index}]: reference ${id} is absent from the sidecar source document`);
  }
}

function validateEvidence(at, item, index) {
  const evidenceAt = `${at}: evidence[${index}]`;
  if (typeof item === "string") {
    if (!nonEmptyString(item)) fail(`${evidenceAt} must be a non-empty string`);
    return;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail(`${evidenceAt} must be a string or structured evidence object`);
    return;
  }
  if (!nonEmptyString(item.summary)) fail(`${evidenceAt}.summary must be a non-empty string`);
  validateReferenceArray(
    `${evidenceAt}.sourceObservationIds`,
    item.sourceObservationIds,
    OBSERVATION_ID,
    knownObservationIds,
    { requireOne: true },
  );
  validateReferenceArray(
    `${evidenceAt}.sourceGraphNodeIds`,
    item.sourceGraphNodeIds,
    GRAPH_NODE_ID,
    knownGraphNodeIds,
  );
}

function validateTemporalField(field) {
  if (field == null) return;
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    fail("temporalField must be an object when supplied");
    return;
  }
  for (const key of ["windowStart", "windowEnd", "now"]) {
    if (!validInstant(field[key])) fail(`temporalField.${key} must be an ISO-compatible date-time`);
  }
  for (const key of ["sunrise", "sunset"]) {
    if (field[key] != null && !validInstant(field[key])) fail(`temporalField.${key} must be an ISO-compatible date-time when supplied`);
  }
  const start = Date.parse(field.windowStart || "");
  const end = Date.parse(field.windowEnd || "");
  if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
    fail("temporalField.windowEnd must be after windowStart");
  }
  if (field.weather?.cloudCover != null) {
    const value = field.weather.cloudCover;
    if (typeof value !== "number" || value < 0 || value > 100) {
      fail("temporalField.weather.cloudCover must be between 0 and 100");
    }
  }
  if (field.autonomyWindows != null && !Array.isArray(field.autonomyWindows)) {
    fail("temporalField.autonomyWindows must be an array when supplied");
  }
  for (const [index, window] of (field.autonomyWindows || []).entries()) {
    const at = `temporalField.autonomyWindows[${index}]`;
    if (!validInstant(window?.start) || !validInstant(window?.end)) {
      fail(`${at}: start/end must be ISO-compatible date-times`);
      continue;
    }
    if (Date.parse(window.end) <= Date.parse(window.start)) fail(`${at}: end must be after start`);
    if (!VALID_SUPERVISION.has(window.mode)) fail(`${at}: mode must be attended or unattended`);
    if (window.scheduled != null && typeof window.scheduled !== "boolean") fail(`${at}: scheduled must be boolean when supplied`);
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
  if (concept.executionState != null && !VALID_EXECUTION_STATE.has(concept.executionState)) {
    fail(`${at}: invalid executionState ${JSON.stringify(concept.executionState)}`);
  }
  if (concept.supervision != null && !VALID_SUPERVISION.has(concept.supervision)) {
    fail(`${at}: invalid supervision ${JSON.stringify(concept.supervision)}`);
  }
  if (concept.scheduled != null && typeof concept.scheduled !== "boolean") {
    fail(`${at}: scheduled must be boolean when supplied`);
  }
  for (const key of ["occurredAt", "endedAt"]) {
    if (concept[key] != null && !validInstant(concept[key])) {
      fail(`${at}: ${key} must be an ISO-compatible date-time when supplied`);
    }
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

  validateReferenceArray(
    `${at}: sourceObservationIds`,
    concept.sourceObservationIds,
    OBSERVATION_ID,
    knownObservationIds,
  );
  validateReferenceArray(
    `${at}: sourceGraphNodeIds`,
    concept.sourceGraphNodeIds,
    GRAPH_NODE_ID,
    knownGraphNodeIds,
  );

  if (concept.evidence != null) {
    if (!Array.isArray(concept.evidence)) {
      fail(`${at}: evidence must be an array when supplied`);
    } else {
      concept.evidence.forEach((item, index) => validateEvidence(at, item, index));
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

if (!data || typeof data !== "object" || Array.isArray(data)) {
  fail("root must be an object");
}

if (data?.attentionBudget?.maxNeighbors != null) {
  const value = data.attentionBudget.maxNeighbors;
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    fail("attentionBudget.maxNeighbors must be an integer between 1 and 4");
  }
}

validateTemporalField(data?.temporalField);

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
if (data.temporalField) {
  console.log(`temporal field: ${data.temporalField.windowStart} → ${data.temporalField.windowEnd} · ${(data.temporalField.autonomyWindows || []).length} autonomy window(s)`);
}
if (knownObservationIds || knownGraphNodeIds) {
  console.log(`provenance sidecars: ${knownObservationIds?.size || 0} observations · ${knownGraphNodeIds?.size || 0} graph nodes`);
}
