// V5.1 real shadow equivalence run.
//
// Both ingestion paths over the REAL corpus, in parallel, with nothing switched
// over. Prints one bounded report; changes no read path and no UI.
import fs from "node:fs";
import path from "node:path";
import { hubLaneAdapter, githubAdapter, buildHandoff, createSessionStatus } from "../src/continuity/protocol/adapters.js";
import { dedupe } from "../src/continuity/protocol/event.js";
import { auditText, buildEquivalenceReport, compareEvent } from "../src/continuity/protocol/equivalence.js";

const BRIEFING = process.env.SHADOW_BRIEFING
  || "D:/Projects/datascape-mustreads/public/data/continuity-briefing.json";
const EXCEPTIONS = process.env.SHADOW_EXCEPTIONS_DIR || "D:/Projects/_ship_inbox/exceptions";

/** The old path: lane records exactly as Continuity reads them today. */
function readHubSample(limit = 200) {
  if (!fs.existsSync(BRIEFING)) return [];
  const doc = JSON.parse(fs.readFileSync(BRIEFING, "utf8"));
  const out = [];
  for (const lane of doc.lanes || []) {
    for (const record of lane.records || []) {
      for (const item of record.items || [{ headline: record.headline, type: record.type }]) {
        if (!item?.headline) continue;
        const trigger = record.trigger?.kind || null;
        out.push({
          id: `${record.id}:${out.length}`,
          lane: lane.lane,
          at: record.emittedAt,
          kind: item.type || "progress",
          text: item.headline,
          // What the OLD path asserts. supervision here is the lane-level
          // value, which is precisely the inference V5 stopped making.
          supervision: lane.supervision,
          trigger,
          execution: lane.execution,
          ownerAction: item.type === "owner_action",
        });
      }
    }
  }
  return out.slice(0, limit);
}

const hubSample = readHubSample();
const lanes = new Set(hubSample.map((r) => r.lane));

const KIND = {
  risk: "finding", finding: "finding", progress: "progress",
  state: "state", state_transition: "state", new_blocker: "state",
  decision: "decision", decision_reversal: "decision",
  owner_action: "owner_action", owner_attention: "owner_action",
  uncertainty_resolved: "finding", routine_tick: "observation",
};

// The old path's own view, expressed in comparable terms.
const oldHub = hubSample.map((r) => ({
  native_id: r.id,
  text: r.text,
  occurred_at: r.at,
  observed_at: null,
  canonical_kind: KIND[r.kind] || "observation",
  trigger: r.trigger,
  supervision: r.supervision,
  owner_action_ref: r.ownerAction ? r.id : null,
  relations: [],
  execution: r.execution,
}));

const { events: hubEvents, rejected: hubRejected } = hubLaneAdapter.ingest(hubSample);
const byNative = new Map(hubEvents.map((e) => [e.native_id, e]));
const hubComparisons = oldHub.map((old) => compareEvent(old, byNative.get(old.native_id)));

// GitHub: report the limitation honestly rather than inventing a sample.
const githubSample = [];
const githubNote = "DataScape's current corpus does not represent GitHub PR/merge events as source records, so no real GitHub sample exists to compare. The adapter is exercised by fixtures only; this is a corpus limitation, not an adapter result.";
const githubComparisons = [];

// ---- text fidelity, over every real record ----
const textAudit = hubSample.map((r) => auditText(r.text, byNative.get(r.id)?.text));
const textFailures = textAudit.filter((a) => !a.exact);

// ---- deduplication over real identities ----
const first = dedupe(hubEvents).events.length;
const second = dedupe([...hubEvents, ...hubLaneAdapter.ingest(hubSample).events]).events.length;

// ---- owner-action continuity ----
const exceptionIds = fs.existsSync(EXCEPTIONS)
  ? fs.readdirSync(EXCEPTIONS).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  : [];
const ownerEvents = hubEvents.filter((e) => e.kind === "owner_action");
const clonedExceptions = ownerEvents.filter((e) => exceptionIds.includes(e.event_id));

// ---- working state ----
const session = createSessionStatus({ session_id: "v51-probe", started_at: "2026-08-21T09:00:00+10:00" });
let emitted = 0;
for (const at of ["09:05", "09:10", "09:15"]) emitted += session.heartbeat(`2026-08-21T${at}:00+10:00`).events.length;
const afterHeartbeats = emitted;
emitted += session.transition({ at: "2026-08-21T09:20:00+10:00", kind: "state", text: "Gate closed." }).events.length;

// ---- handoff ----
const activeLane = [...lanes][0] || null;
const laneEvents = hubEvents.filter((e) => e.lane_id === activeLane);
const bundle = buildHandoff({
  semanticCentre: activeLane,
  lensPath: [activeLane],
  settledEventIds: laneEvents.slice(-3).map((e) => e.event_id),
  workingState: session.get(),
  openExceptions: exceptionIds.slice(0, 3),
  sourceIds: laneEvents.slice(-5).map((e) => e.native_id),
});
const fullContextBytes = Buffer.byteLength(JSON.stringify(laneEvents), "utf8");
const bundleBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
const resolvable = bundle.relevant_source_ids.every((id) => byNative.has(id));

const report = buildEquivalenceReport({ "Hub/lane": hubComparisons, GitHub: githubComparisons });

console.log(JSON.stringify({
  ...report,
  scope: {
    hub_records: hubSample.length,
    hub_lanes: lanes.size,
    hub_rejected: hubRejected.length,
    github_events: githubSample.length,
    github_note: githubNote,
  },
  authored_text: {
    audited: textAudit.length,
    exact: textAudit.length - textFailures.length,
    failures: textFailures.length,
  },
  deduplication: { first_import: first, second_import: second, stable: first === second },
  owner_actions: {
    owner_events: ownerEvents.length,
    real_exceptions_on_disk: exceptionIds.length,
    cloned_exceptions: clonedExceptions.length,
    note: "the protocol references exception identity; the exception layer stays authoritative",
  },
  working_state: {
    heartbeats_emitted_events: afterHeartbeats,
    total_after_transition: emitted,
    invariant_holds: afterHeartbeats === 0 && emitted === 1,
  },
  handoff: {
    contains_transcript: bundle.contains_transcript,
    all_references_resolve: resolvable,
    full_source_context_bytes: fullContextBytes,
    bundle_bytes: bundleBytes,
    ratio: fullContextBytes ? Number((bundleBytes / fullContextBytes).toFixed(4)) : null,
    note: "descriptive, not a performance score",
  },
}, null, 2));

process.exit(report.cutover_gate.passes && textFailures.length === 0 ? 0 : 1);
