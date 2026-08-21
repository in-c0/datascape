// The Continuity ingestion protocol — spec V5.
//
// The point of this file is that Continuity should stop caring whether
// cognition came from a Claude Code lane, a ChatGPT session, a GitHub run or
// some future ambient agent. It is an ingestion ENVELOPE, not another database
// of semantic summaries: nothing here interprets, summarises or reconciles
// meaning. It normalises shape and refuses to invent anything.

export const EVENT_KINDS = [
  "observation", "finding", "progress", "state",
  "decision", "owner_action", "action", "evidence",
];
export const AUTHORSHIP = ["owner", "agent", "external_system"];
export const EXECUTION = ["planned", "live", "completed"];
export const TRIGGER = ["owner", "operator", "scheduler", "automation", "unknown"];

/** Still prohibited, and still for the same reason. */
export const PROHIBITED_RELATIONS = ["causes", "caused_by"];
export const ALLOWED_RELATIONS = ["contains", "supports", "contradicts", "supersedes", "depends_on", "references"];

/**
 * Supervision is DERIVED from the trigger and never guessed.
 *
 * `unknown` stays unknown. An ingestion layer that quietly resolves it to
 * "unattended" because most events are would be inventing provenance, which is
 * the one thing this protocol exists to prevent.
 */
export function supervisionOf(trigger) {
  if (trigger === "scheduler" || trigger === "automation") return "unattended";
  if (trigger === "owner" || trigger === "operator") return "attended";
  return "unknown";
}

/**
 * Deterministic canonical identity.
 *
 * Primarily NATIVE identity plus source system, because that is the only thing
 * that actually says "these are the same real event". Content/time fingerprints
 * are a fallback for sources that cannot supply one — never a merge criterion
 * on their own, and never applied across different source systems.
 */
export function canonicalId(event) {
  if (event.native_id) return `${event.source_system}:${event.native_id}`;
  return `${event.source_system}:fp_${fingerprint(`${event.occurred_at}|${event.text}`)}`;
}

function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(text).length; i++) {
    h = Math.imul(h ^ String(text).charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const oneOf = (value, allowed, fallback = null) => (allowed.includes(value) ? value : fallback);

/**
 * Normalise a raw adapter payload into the canonical envelope.
 *
 * Returns `{ event }` or `{ rejected, reason }`. Rejection rather than
 * best-effort coercion: an event whose authored text or timing cannot be
 * trusted is worse than an absent one, because it enters the record looking
 * exactly like a good one.
 */
export function normalizeEvent(raw) {
  if (!raw?.source_system) return { rejected: true, reason: "missing source_system" };
  if (!raw?.occurred_at || !Number.isFinite(Date.parse(raw.occurred_at))) {
    return { rejected: true, reason: "missing or unparseable occurred_at" };
  }
  if (typeof raw.text !== "string" || !raw.text.length) {
    return { rejected: true, reason: "missing authored text" };
  }
  const kind = oneOf(raw.kind, EVENT_KINDS);
  if (!kind) return { rejected: true, reason: `unknown kind: ${raw.kind}` };

  for (const rel of raw.relations || []) {
    if (PROHIBITED_RELATIONS.includes(rel?.kind)) {
      return { rejected: true, reason: `prohibited relation: ${rel.kind}` };
    }
    if (!ALLOWED_RELATIONS.includes(rel?.kind)) {
      return { rejected: true, reason: `unknown relation: ${rel?.kind}` };
    }
  }

  const trigger = oneOf(raw.trigger, TRIGGER, "unknown");
  const event = {
    source_system: raw.source_system,
    native_id: raw.native_id ?? null,
    session_id: raw.session_id ?? null,
    lane_id: raw.lane_id ?? null,
    project_id: raw.project_id ?? null,
    occurred_at: raw.occurred_at,
    // When it reached us, which is not when it happened. Conflating them is
    // how a late-arriving event silently rewrites its own history.
    observed_at: raw.observed_at ?? raw.occurred_at,
    kind,
    authorship: oneOf(raw.authorship, AUTHORSHIP, "external_system"),
    execution: oneOf(raw.execution, EXECUTION, "completed"),
    trigger,
    supervision: supervisionOf(trigger),
    // EXACT. Never trimmed, re-cased, re-wrapped or summarised.
    text: raw.text,
    relations: [...(raw.relations || [])],
    owner_action_ref: raw.owner_action_ref ?? null,
    // WHO INITIATED, kept separate from who authored the record. GitHub
    // authored the merge envelope; a human or a bot initiated the merge. Those
    // are different provenance facts, and collapsing them is how "a human wrote
    // the PR title" silently becomes "a human merged it". Non-semantic: it may
    // never alter authored text or semantic status.
    actor: raw.actor
      ? {
        id: raw.actor.id ?? null,
        type: ["human", "bot", "app", "unknown"].includes(raw.actor.type) ? raw.actor.type : "unknown",
        source_system: raw.actor.source_system ?? raw.source_system,
      }
      : null,
    // An explicit cross-system reference. Co-reference requires evidence like
    // this; it is never inferred from prose similarity.
    external_ref: raw.external_ref ?? null,
  };
  event.event_id = canonicalId(event);
  return { event };
}

/**
 * Deduplicate a stream into canonical events.
 *
 * Two systems reporting the same real event must not create two truths — and
 * equally, two genuinely distinct events must never be merged because their
 * prose happens to match. Identity decides; similarity never does.
 */
export function dedupe(events) {
  const byId = new Map();
  const duplicates = [];
  for (const event of events) {
    const id = event.event_id || canonicalId(event);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...event, event_id: id, reported_by: [event.source_system] });
      continue;
    }
    duplicates.push(id);
    // The earliest occurrence wins on timing; later reports only add reporters.
    if (Date.parse(event.occurred_at) < Date.parse(existing.occurred_at)) {
      existing.occurred_at = event.occurred_at;
    }
    if (!existing.reported_by.includes(event.source_system)) {
      existing.reported_by.push(event.source_system);
    }
  }
  return { events: [...byId.values()], duplicates };
}
