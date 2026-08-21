// The Hub/lane read-path cutover — spec V5.2A.
//
// Continuity now consumes lane records THROUGH the interoperability envelope.
// The authoritative records and the exception inbox are untouched: this
// replaces a normalization path, not a source of truth.
//
//   authoritative Hub records → V5 protocol adapter → canonical events
//                                                   → existing semantic machinery
//
// The legacy path is retained for diagnosis and rollback, and is never selected
// automatically. A silent fallback would let a bad protocol deploy quietly
// restore less-truthful legacy behaviour with nobody noticing — which is the
// specific failure this file is written to prevent.

import { hubLaneAdapter } from "./adapters.js";
import { dedupe } from "./event.js";

export const INGESTION_PROTOCOL = "protocol";
export const INGESTION_LEGACY = "legacy";

/** The legacy normalization, kept verbatim for comparison only. */
function legacyNormalize(records, laneSupervision = {}) {
  return records.map((r) => ({
    event_id: `hub-lane:${r.id}`,
    native_id: r.id,
    lane_id: r.lane ?? null,
    occurred_at: r.at ?? r.emittedAt,
    observed_at: null,
    kind: r.kind || "observation",
    text: r.text,
    // The inference V5 removed: supervision inherited from the lane, whether or
    // not the record itself carried any trigger evidence.
    supervision: laneSupervision[r.lane] ?? "unknown",
    trigger: r.trigger?.kind ?? null,
    owner_action_ref: r.kind === "owner_action" ? r.id : null,
    execution: r.execution ?? null,
  }));
}

/**
 * Ingest lane records.
 *
 * `mode` is explicit and defaults to the protocol path. Rejections are
 * SURFACED, never swallowed: `ok` is false when any record failed to normalize,
 * so a caller cannot mistake a partial ingestion for a complete one.
 */
export function ingestHubRecords(records, { mode = INGESTION_PROTOCOL, laneSupervision = {} } = {}) {
  if (mode === INGESTION_LEGACY) {
    const events = legacyNormalize(records, laneSupervision);
    return { mode, ok: true, events, rejected: [], diagnostic: true };
  }
  if (mode !== INGESTION_PROTOCOL) {
    return { mode, ok: false, events: [], rejected: [], error: `unknown ingestion mode: ${mode}` };
  }

  const { events, rejected } = hubLaneAdapter.ingest(records);
  const { events: canonical } = dedupe(events);
  return {
    mode,
    // A rejection is an ingestion failure the operator must see. Falling back
    // to legacy here would be the silent regression the spec forbids.
    ok: rejected.length === 0,
    events: canonical,
    rejected,
    error: rejected.length ? `${rejected.length} record(s) failed protocol normalization` : null,
  };
}

/**
 * Truthfulness must survive the whole pipeline, not just the adapter.
 *
 * An `unknown` supervision that a later lane-level default quietly "restores"
 * to `unattended` is exactly as wrong as the adapter having inferred it in the
 * first place — and harder to spot, because the adapter looks correct.
 */
export function auditDownstreamTruthfulness(events, laneSupervision = {}) {
  const restored = events.filter((e) => {
    if (e.supervision !== "unknown") return false;
    const laneValue = laneSupervision[e.lane_id];
    return laneValue && laneValue !== "unknown";
  });
  return {
    unknown_supervision: events.filter((e) => e.supervision === "unknown").length,
    // These are events where a lane-level fallback COULD have overwritten the
    // honest unknown. They must still read unknown downstream.
    at_risk_of_restoration: restored.length,
    still_unknown: restored.every((e) => e.supervision === "unknown"),
  };
}

/**
 * Semantic identity as the history layer sees it.
 *
 * The cutover replaced a representation; it must not look like a change to any
 * concept. If these identities are stable across paths, V4 revisions cannot
 * churn merely because ingestion moved.
 */
export function semanticSourceIdentities(events) {
  return events
    .map((e) => `${e.native_id}|${e.text}|${e.occurred_at}`)
    .sort();
}

/**
 * Did replacing the normalization path, by itself, change anything the
 * semantic-history layer would treat as material?
 */
export function cutoverChurn(legacyEvents, protocolEvents) {
  const before = semanticSourceIdentities(legacyEvents);
  const after = semanticSourceIdentities(protocolEvents);
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return {
    identities_before: before.length,
    identities_after: after.length,
    added,
    removed,
    // Zero is the only acceptable answer: a cutover may not manufacture
    // revisions, material changes, owner actions or shifted timestamps.
    churn: added.length + removed.length,
  };
}
