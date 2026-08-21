// Adapters, session status, handoff and the shadow comparator — spec V5.
//
// Two sources with deliberately different shapes: the Hub lane record (authored
// prose, lane-scoped, agent-written) and GitHub PR/merge activity (structured,
// external, no prose of its own). If both normalise cleanly through one
// envelope, the protocol is doing its job.

import { EVENT_KINDS, canonicalId, normalizeEvent } from "./event.js";

/**
 * The adapter contract. `read` returns raw payloads; `toEvents` maps them into
 * the envelope. Adapters never interpret meaning — they only say what shape
 * their native records have.
 */
export function createAdapter({ sourceSystem, toEvents }) {
  return {
    sourceSystem,
    ingest(natives = []) {
      const events = [];
      const rejected = [];
      for (const native of natives) {
        const raw = toEvents(native);
        for (const candidate of Array.isArray(raw) ? raw : [raw]) {
          if (!candidate) continue;
          const result = normalizeEvent({ ...candidate, source_system: sourceSystem });
          if (result.rejected) rejected.push({ native_id: candidate.native_id ?? null, reason: result.reason });
          else events.push(result.event);
        }
      }
      return { events, rejected };
    },
  };
}

/** The lane record source Continuity reads today. */
export const hubLaneAdapter = createAdapter({
  sourceSystem: "hub-lane",
  toEvents: (record) => ({
    native_id: record.id,
    session_id: record.session ?? null,
    lane_id: record.lane ?? null,
    occurred_at: record.at ?? record.emittedAt,
    observed_at: record.observedAt ?? record.at ?? record.emittedAt,
    // A kind that is ALREADY canonical passes through untouched. The first
    // version mapped only vendor-specific names and silently fell through to
    // "observation" for everything the real corpus actually uses, turning 37
    // owner actions into observations. Mapping should translate what needs
    // translating, never overwrite what is already right.
    kind: hubKind(record.kind),
    // An owner-action record is written BY AN AGENT about something the owner
    // must do. The owner neither authored nor triggered it. Treating "this
    // needs the owner" as "the owner did this" conflated three separate facts
    // — who authored the record, who must act, and who initiated the event —
    // which is precisely the distinction the GitHub actor ruling drew.
    authorship: "agent",
    execution: record.execution || "completed",
    // Absent trigger stays UNKNOWN. Falling back to "scheduler" because most
    // lane records are scheduled is exactly the provenance inference this
    // protocol exists to stop, and my own adapter was doing it.
    trigger: record.trigger?.kind || "unknown",
    text: record.text,
    owner_action_ref: isOwnerAction(record) ? record.id : null,
    relations: (record.references || []).map((target) => ({ kind: "references", target })),
  }),
});

/** GitHub authored the envelope; someone else initiated the event. */
const actorType = (raw) => {
  if (raw === "user" || raw === "human") return "human";
  if (raw === "bot") return "bot";
  if (raw === "app") return "app";
  return "unknown";
};
const initiatorTrigger = (raw) => {
  const type = actorType(raw);
  if (type === "human") return "operator";
  if (type === "bot" || type === "app") return "automation";
  return "unknown";
};

const isOwnerAction = (record) => record.ownerAction === true || record.kind === "owner_action";
const hubKind = (kind) => (EVENT_KINDS.includes(kind) ? kind : (KIND_FROM_HUB[kind] || "observation"));

const KIND_FROM_HUB = {
  risk: "finding",
  finding: "finding",
  progress: "progress",
  state_transition: "state",
  new_blocker: "state",
  decision_reversal: "decision",
  decision: "decision",
  owner_attention: "owner_action",
  uncertainty_resolved: "finding",
  routine_tick: "observation",
};

/**
 * GitHub PR/merge activity.
 *
 * Structurally different in every way that matters: no authored prose of its
 * own beyond the title, an external actor, and a native id that is genuinely
 * stable. It is the honest test of whether the envelope is a protocol or just
 * the Hub record wearing a hat.
 */
export const githubAdapter = createAdapter({
  sourceSystem: "github",
  toEvents: (activity) => ({
    native_id: `${activity.repo}#${activity.number}:${activity.action}`,
    project_id: activity.repo,
    occurred_at: activity.at,
    observed_at: activity.observedAt ?? activity.at,
    kind: activity.action === "merged" ? "state" : activity.action === "opened" ? "action" : "observation",
    authorship: "external_system",
    execution: activity.action === "merged" ? "completed" : "live",
    // The INITIATOR decides trigger provenance, not whoever wrote the prose.
    // A human-authored PR merged by a bot is automation: the presence of human
    // text in the title says nothing about who performed the merge.
    trigger: initiatorTrigger(activity.actorType),
    actor: { id: activity.actor ?? null, type: actorType(activity.actorType), source_system: "github" },
    external_ref: activity.externalRef ?? null,
    text: activity.title,
    relations: (activity.references || []).map((target) => ({ kind: "references", target })),
  }),
});

// ---------------------------------------------------------------------------
// Session status: working state, never history.

/**
 * One ephemeral status document per live session.
 *
 * A heartbeat is not a decision. If every heartbeat became an immutable event,
 * the record would fill with "still alive" and the semantic history this whole
 * architecture protects would be worthless within a day.
 */
export function createSessionStatus({ session_id, started_at, current_intent = null }) {
  let status = {
    session_id,
    started_at,
    current_intent,
    current_operation: null,
    last_settled_event_id: null,
    blocked_on: [],
    last_heartbeat_at: started_at,
  };
  return {
    get() { return { ...status, ephemeral: true }; },
    /** Updates working state and emits NOTHING. */
    heartbeat(at, patch = {}) {
      status = { ...status, ...patch, last_heartbeat_at: at };
      return { events: [] };
    },
    /**
     * A material transition emits one immutable event. This is the only path
     * from working state into history.
     */
    transition({ at, kind, text, trigger = "automation", execution = "completed", lane_id = null }) {
      const result = normalizeEvent({
        source_system: "session",
        native_id: `${session_id}:${at}`,
        session_id, lane_id,
        occurred_at: at, observed_at: at,
        kind, authorship: "agent", execution, trigger, text,
      });
      if (result.rejected) return { events: [], rejected: result };
      status = { ...status, last_settled_event_id: result.event.event_id, last_heartbeat_at: at };
      return { events: [result.event] };
    },
  };
}

// ---------------------------------------------------------------------------
// Handoff: references, not transcripts.

/**
 * A bundle another agent can resume from.
 *
 * The payoff of the whole abstraction stack: what one agent needs from another
 * is where it was, what settled, and what is open — not three hundred thousand
 * tokens of prior conversation. If this bundle is enough to reconstruct the
 * position, the architecture has earned its keep.
 */
export function buildHandoff({ semanticCentre, lensPath = [], settledEventIds = [], workingState = null, openExceptions = [], sourceIds = [] }) {
  return {
    kind: "continuity_handoff",
    semantic_centre: semanticCentre,
    lens_path: [...lensPath],
    last_settled_event_ids: [...settledEventIds],
    working_state: workingState ? { ...workingState } : null,
    open_owner_exceptions: [...openExceptions],
    // IDs only. A bundle that carried the text would be a transcript with
    // extra steps, and would go stale the moment the source was revised.
    relevant_source_ids: [...sourceIds],
    contains_transcript: false,
  };
}

// ---------------------------------------------------------------------------
// Shadow equivalence: prove the new path matches the old before switching.

const FIELDS = ["kind", "text", "occurred_at", "trigger", "supervision", "owner_action_ref"];

/**
 * Compare existing ingestion against protocol-normalized ingestion.
 *
 * Normal Continuity keeps reading the old path until this reports equivalence,
 * so the protocol can be wrong in public without being wrong in production.
 */
export function compareIngestion(existing, normalized) {
  const byId = new Map(normalized.map((e) => [e.event_id, e]));
  const differences = [];
  const missing = [];

  for (const old of existing) {
    const id = old.event_id || canonicalId(old);
    const next = byId.get(id);
    if (!next) { missing.push(id); continue; }
    for (const field of FIELDS) {
      if (JSON.stringify(old[field] ?? null) !== JSON.stringify(next[field] ?? null)) {
        differences.push({ event_id: id, field, existing: old[field] ?? null, normalized: next[field] ?? null });
      }
    }
    byId.delete(id);
  }

  return {
    equivalent: differences.length === 0 && missing.length === 0 && byId.size === 0,
    compared: existing.length,
    differences,
    missing_from_normalized: missing,
    extra_in_normalized: [...byId.keys()],
  };
}
