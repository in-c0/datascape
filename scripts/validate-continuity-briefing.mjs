// Validate a Continuity briefing document.
//
// Deliberately strict about two things the surface's credibility rests on:
//
//   1. A reconstructed record must declare itself. If `provenance` is
//      "backfilled-from-log" it needs a sourceRef, so "where did this come
//      from" is always answerable from the document alone.
//   2. An owner action that claims authored steps must actually have steps.
//      `authoredSteps: true` with an empty list would render as a checklist
//      that isn't one, which is worse than showing the prose.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STEP_KINDS = new Set(["run", "open", "decide", "physical"]);
const ITEM_TYPES = new Set(["owner_action", "finding", "progress", "state"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

const file = path.resolve(process.argv[2] || "public/data/continuity-briefing.json");
if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
const doc = JSON.parse(fs.readFileSync(file, "utf8"));

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const iso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

if (doc.version !== 1) fail("document", "version must be 1");
if (!iso(doc.generatedAt)) fail("document", "generatedAt must be an ISO date-time");
if (!Array.isArray(doc.lanes)) fail("document", "lanes must be an array");
if (!Array.isArray(doc.ownerActions)) fail("document", "ownerActions must be an array");
if (doc.latestPerLane != null && !(Number.isInteger(doc.latestPerLane) && doc.latestPerLane >= 1)) {
  fail("document", "latestPerLane must be a positive integer");
}

const laneKeys = new Set();
for (const [laneIndex, lane] of (doc.lanes || []).entries()) {
  const where = `lanes[${laneIndex}]`;
  if (!String(lane?.lane || "").trim()) fail(where, "lane key is required");
  if (laneKeys.has(lane?.lane)) fail(where, `duplicate lane key ${lane.lane}`);
  laneKeys.add(lane?.lane);
  if (!String(lane?.label || "").trim()) fail(where, "label is required");
  if (!Number.isInteger(lane?.total) || lane.total < 0) fail(where, "total must be a non-negative integer");
  if (!Array.isArray(lane?.records)) fail(where, "records must be an array");
  if (lane?.records && lane.records.length > (lane.total ?? 0)) {
    fail(where, `shows ${lane.records.length} record(s) but claims total ${lane.total}`);
  }

  for (const [recordIndex, record] of (lane.records || []).entries()) {
    const rw = `${where}.records[${recordIndex}]`;
    if (!/^mr_[a-f0-9]{16}$/.test(record?.id || "")) fail(rw, "invalid record id");
    if (!iso(record?.emittedAt)) fail(rw, "emittedAt must be an ISO date-time");
    if (record?.lane !== lane.lane) fail(rw, `record lane ${record?.lane} does not match ${lane.lane}`);
    if (record?.provenance === "backfilled-from-log" && !record?.sourceRef) {
      fail(rw, "a reconstructed record must carry a sourceRef");
    }
    if (!Array.isArray(record?.items) || record.items.length === 0) {
      fail(rw, "records must carry at least one item");
    }
    for (const [itemIndex, item] of (record?.items || []).entries()) {
      const iw = `${rw}.items[${itemIndex}]`;
      if (!String(item?.headline || "").trim()) fail(iw, "headline is required");
      if (!ITEM_TYPES.has(item?.type)) fail(iw, `unsupported item type ${JSON.stringify(item?.type)}`);
      for (const link of item?.links || []) {
        if (!link?.href) fail(iw, "a link needs an href");
      }
    }
  }
}

const actionIds = new Set();
for (const [index, action] of (doc.ownerActions || []).entries()) {
  const where = `ownerActions[${index}]`;
  if (!String(action?.id || "").trim()) fail(where, "id is required");
  if (actionIds.has(action?.id)) fail(where, `duplicate id ${action.id}`);
  actionIds.add(action?.id);
  if (!String(action?.title || "").trim()) fail(where, "title is required");
  if (!SEVERITIES.has(action?.severity)) fail(where, `unsupported severity ${JSON.stringify(action?.severity)}`);
  if (!Array.isArray(action?.steps)) fail(where, "steps must be an array");
  if (action?.authoredSteps === true && !(action.steps || []).length) {
    fail(where, "authoredSteps is true but no steps are present");
  }
  if (action?.stepCount != null && action.stepCount !== (action.steps || []).length) {
    fail(where, `stepCount ${action.stepCount} does not match ${(action.steps || []).length} step(s)`);
  }
  for (const [stepIndex, step] of (action?.steps || []).entries()) {
    const sw = `${where}.steps[${stepIndex}]`;
    if (!STEP_KINDS.has(step?.kind)) fail(sw, `unsupported step kind ${JSON.stringify(step?.kind)}`);
    if (!String(step?.text || "").trim()) fail(sw, "step text is required");
    if (step?.kind === "run" && !step?.command) fail(sw, "a run step must carry the command");
    if (step?.kind === "open" && !step?.href) fail(sw, "an open step must carry the href");
  }
}

if (errors.length) {
  console.error(`Continuity briefing validation failed (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mustReads = (doc.lanes || []).reduce((n, lane) => n + (lane.records || []).length, 0);
const derived = (doc.ownerActions || []).filter((a) => a.needsBreakdown).length;
console.log(`Continuity briefing valid.`);
console.log(`lanes: ${(doc.lanes || []).length} · must-reads shown: ${mustReads} · owner actions: ${(doc.ownerActions || []).length}`);
if (derived) {
  console.log(`note: ${derived} owner action(s) have no authored "## Owner steps" — their steps are derived from prose.`);
}
