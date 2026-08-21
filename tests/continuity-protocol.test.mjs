import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RELATIONS,
  EVENT_KINDS,
  PROHIBITED_RELATIONS,
  canonicalId,
  dedupe,
  normalizeEvent,
  supervisionOf,
} from "../src/continuity/protocol/event.js";
import {
  buildHandoff,
  compareIngestion,
  createSessionStatus,
  githubAdapter,
  hubLaneAdapter,
} from "../src/continuity/protocol/adapters.js";

const HUB_RECORDS = [
  { id: "sec_01", lane: "Security", at: "2026-08-21T09:00:00+10:00", kind: "risk",
    text: "A live API key is present in published git history.", trigger: { kind: "scheduler" } },
  { id: "sec_02", lane: "Security", at: "2026-08-21T09:30:00+10:00", kind: "owner_attention",
    ownerAction: true, text: "Rotate the exposed key and revoke the old credential." },
  { id: "sec_03", lane: "Security", at: "2026-08-21T10:00:00+10:00", kind: "routine_tick",
    text: "S01 routine verification 03: no material change.", trigger: { kind: "scheduler" },
    references: ["sec_01"] },
];

const GITHUB_ACTIVITY = [
  { repo: "in-c0/datascape", number: 21, action: "opened", at: "2026-08-21T11:00:00+10:00",
    actorType: "user", title: "Briefing V4 PR B: history as a lens state" },
  { repo: "in-c0/datascape", number: 21, action: "merged", at: "2026-08-21T12:00:00+10:00",
    actorType: "user", title: "Briefing V4 PR B: history as a lens state" },
];

// ---- the envelope -----------------------------------------------------------

test("V5: authored text survives normalization byte for byte", () => {
  const { events } = hubLaneAdapter.ingest(HUB_RECORDS);
  const exact = events.find((e) => e.native_id === "sec_01");
  assert.equal(exact.text, "A live API key is present in published git history.",
    "an ingestion envelope may not trim, re-case or re-wrap authored text");
  for (const [i, record] of HUB_RECORDS.entries()) {
    assert.equal(events[i].text, record.text);
  }
});

test("V5: supervision derives from the trigger and unknown is never guessed", () => {
  assert.equal(supervisionOf("scheduler"), "unattended");
  assert.equal(supervisionOf("automation"), "unattended");
  assert.equal(supervisionOf("owner"), "attended");
  assert.equal(supervisionOf("operator"), "attended");
  assert.equal(supervisionOf("unknown"), "unknown");
  assert.equal(supervisionOf(undefined), "unknown", "an absent trigger must not resolve to a guess");

  const { event } = normalizeEvent({
    source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", kind: "observation",
    text: "something happened", trigger: "not-a-real-trigger",
  });
  assert.equal(event.trigger, "unknown");
  assert.equal(event.supervision, "unknown");
});

test("V5: causal relations are rejected at the boundary", () => {
  for (const kind of PROHIBITED_RELATIONS) {
    const result = normalizeEvent({
      source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", kind: "state",
      text: "a merge happened", relations: [{ kind, target: "rec_1" }],
    });
    assert.equal(result.rejected, true, `${kind} must be rejected`);
    assert.match(result.reason, /prohibited relation/);
  }
  assert.ok(ALLOWED_RELATIONS.includes("references"));
  assert.equal(ALLOWED_RELATIONS.some((r) => PROHIBITED_RELATIONS.includes(r)), false);
});

test("V5: an event that cannot be trusted is rejected rather than coerced", () => {
  const bad = [
    [{ occurred_at: "2026-08-21T09:00:00+10:00", kind: "state", text: "x" }, /source_system/],
    [{ source_system: "x", kind: "state", text: "x" }, /occurred_at/],
    [{ source_system: "x", occurred_at: "nope", kind: "state", text: "x" }, /occurred_at/],
    [{ source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", kind: "state", text: "" }, /authored text/],
    [{ source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", kind: "vibes", text: "x" }, /unknown kind/],
  ];
  for (const [raw, pattern] of bad) {
    const result = normalizeEvent(raw);
    assert.equal(result.rejected, true, JSON.stringify(raw));
    assert.match(result.reason, pattern);
  }
  assert.ok(EVENT_KINDS.includes("owner_action"));
});

test("V5: occurred_at and observed_at stay distinct", () => {
  const { event } = normalizeEvent({
    source_system: "x", native_id: "n1",
    occurred_at: "2026-08-21T09:00:00+10:00",
    observed_at: "2026-08-21T18:00:00+10:00",
    kind: "finding", text: "found late", trigger: "scheduler",
  });
  assert.equal(event.occurred_at, "2026-08-21T09:00:00+10:00");
  assert.equal(event.observed_at, "2026-08-21T18:00:00+10:00");
});

// ---- deduplication ----------------------------------------------------------

test("V5: the same native event imported twice becomes one canonical event", () => {
  const { events: a } = hubLaneAdapter.ingest(HUB_RECORDS);
  const { events: b } = hubLaneAdapter.ingest(HUB_RECORDS);
  const { events, duplicates } = dedupe([...a, ...b]);
  assert.equal(events.length, HUB_RECORDS.length, "two imports of one truth is still one truth");
  assert.equal(duplicates.length, HUB_RECORDS.length);
});

test("V5: similar prose from two distinct native events remains two events", () => {
  const twins = [
    { id: "a1", lane: "L", at: "2026-08-21T09:00:00+10:00", kind: "progress", text: "Deployment verification failed.", trigger: { kind: "scheduler" } },
    { id: "a2", lane: "L", at: "2026-08-21T09:05:00+10:00", kind: "progress", text: "Deployment verification failed.", trigger: { kind: "scheduler" } },
  ];
  const { events } = hubLaneAdapter.ingest(twins);
  const { events: merged } = dedupe(events);
  assert.equal(merged.length, 2, "identity decides; similarity never does");
  assert.notEqual(merged[0].event_id, merged[1].event_id);
});

test("V5: identity is scoped to its source system", () => {
  const hub = canonicalId({ source_system: "hub-lane", native_id: "42" });
  const gh = canonicalId({ source_system: "github", native_id: "42" });
  assert.notEqual(hub, gh, "two systems that happen to share a native id are not one event");
});

test("V5: a source without native identity falls back to a content fingerprint", () => {
  const a = canonicalId({ source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", text: "same" });
  const b = canonicalId({ source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", text: "same" });
  const c = canonicalId({ source_system: "x", occurred_at: "2026-08-21T09:00:00+10:00", text: "different" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- two genuinely different shapes -----------------------------------------

test("V5: two differently-shaped sources normalize through one envelope", () => {
  const hub = hubLaneAdapter.ingest(HUB_RECORDS);
  const gh = githubAdapter.ingest(GITHUB_ACTIVITY);
  assert.equal(hub.rejected.length, 0, JSON.stringify(hub.rejected));
  assert.equal(gh.rejected.length, 0, JSON.stringify(gh.rejected));

  for (const event of [...hub.events, ...gh.events]) {
    for (const field of ["event_id", "source_system", "occurred_at", "kind", "authorship", "execution", "trigger", "supervision", "text"]) {
      assert.ok(event[field] !== undefined, `${field} missing from ${event.event_id}`);
    }
  }
  const merged = githubAdapter.ingest(GITHUB_ACTIVITY).events.find((e) => e.native_id.endsWith(":merged"));
  assert.equal(merged.kind, "state");
  assert.equal(merged.authorship, "external_system");
  assert.equal(merged.supervision, "attended", "a human clicking merge is an operator");

  const bot = githubAdapter.ingest([{ ...GITHUB_ACTIVITY[1], actorType: "bot" }]).events[0];
  assert.equal(bot.supervision, "unattended");
  const mystery = githubAdapter.ingest([{ ...GITHUB_ACTIVITY[1], actorType: undefined }]).events[0];
  assert.equal(mystery.trigger, "unknown");
  assert.equal(mystery.supervision, "unknown");
});

test("V5: owner exception identity and source relations survive normalization", () => {
  const { events } = hubLaneAdapter.ingest(HUB_RECORDS);
  const ownerEvent = events.find((e) => e.kind === "owner_action");
  assert.equal(ownerEvent.owner_action_ref, "sec_02");
  assert.equal(ownerEvent.authorship, "owner");
  assert.equal(ownerEvent.supervision, "attended");

  const withRef = events.find((e) => e.native_id === "sec_03");
  assert.deepEqual(withRef.relations, [{ kind: "references", target: "sec_01" }]);
});

test("V5 NEGATIVE CONTROL: a merge after a recommendation is not caused by it", () => {
  const recommendation = hubLaneAdapter.ingest([{
    id: "rec_1", lane: "L", at: "2026-08-21T11:30:00+10:00", kind: "decision",
    text: "Recommend merging PR 21 once checks are green.", trigger: { kind: "scheduler" },
  }]).events[0];
  const merge = githubAdapter.ingest([GITHUB_ACTIVITY[1]]).events[0];

  assert.ok(Date.parse(merge.occurred_at) > Date.parse(recommendation.occurred_at));
  for (const event of [recommendation, merge]) {
    for (const rel of event.relations) {
      assert.equal(PROHIBITED_RELATIONS.includes(rel.kind), false);
    }
  }
  // And the protocol offers no way to assert it even deliberately.
  const attempt = normalizeEvent({
    source_system: "github", native_id: "x", occurred_at: merge.occurred_at, kind: "state",
    text: merge.text, relations: [{ kind: "caused_by", target: recommendation.event_id }],
  });
  assert.equal(attempt.rejected, true, "temporal proximity must not become causality");
});

// ---- session status ---------------------------------------------------------

test("V5: a heartbeat updates working state and creates no history", () => {
  const session = createSessionStatus({ session_id: "s1", started_at: "2026-08-21T09:00:00+10:00", current_intent: "verify the branch" });
  const first = session.heartbeat("2026-08-21T09:05:00+10:00", { current_operation: "running tests" });
  assert.deepEqual(first.events, [], "a heartbeat is not a decision");
  const second = session.heartbeat("2026-08-21T09:10:00+10:00");
  assert.deepEqual(second.events, []);
  assert.equal(session.get().last_heartbeat_at, "2026-08-21T09:10:00+10:00");
  assert.equal(session.get().last_settled_event_id, null);
  assert.equal(session.get().ephemeral, true);
});

test("V5: a material transition emits exactly one immutable event", () => {
  const session = createSessionStatus({ session_id: "s1", started_at: "2026-08-21T09:00:00+10:00" });
  const { events } = session.transition({
    at: "2026-08-21T09:20:00+10:00", kind: "state",
    text: "The deployment gate closed after the shadow run dropped events.",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "The deployment gate closed after the shadow run dropped events.");
  assert.equal(session.get().last_settled_event_id, events[0].event_id);
  // Working state moved, but the heartbeat that follows still writes nothing.
  assert.deepEqual(session.heartbeat("2026-08-21T09:25:00+10:00").events, []);
});

// ---- handoff ----------------------------------------------------------------

test("V5: a handoff bundle carries references, never a transcript", () => {
  const bundle = buildHandoff({
    semanticCentre: "reliability",
    lensPath: ["dist", "dist-shortform"],
    settledEventIds: ["hub-lane:sec_01"],
    workingState: { session_id: "s1", current_intent: "verify the branch" },
    openExceptions: ["2026-08-21-datascape-shadow-proposer-d069"],
    sourceIds: ["sec_01", "sec_02"],
  });
  assert.equal(bundle.contains_transcript, false);
  assert.equal(bundle.semantic_centre, "reliability");
  assert.deepEqual(bundle.relevant_source_ids, ["sec_01", "sec_02"]);
  assert.ok(bundle.open_owner_exceptions.includes("2026-08-21-datascape-shadow-proposer-d069"));

  // The bundle must be small: it is references, so its size cannot scale with
  // conversation length.
  assert.ok(JSON.stringify(bundle).length < 800, `${JSON.stringify(bundle).length} bytes`);
  // And it must be enough to reconstruct position.
  for (const field of ["semantic_centre", "lens_path", "last_settled_event_ids", "working_state", "open_owner_exceptions"]) {
    assert.ok(bundle[field] !== undefined, `${field} is required to resume`);
  }
});

// ---- shadow equivalence -----------------------------------------------------

test("V5: the comparator proves equivalence before anything switches paths", () => {
  const existing = hubLaneAdapter.ingest(HUB_RECORDS).events;
  const normalized = hubLaneAdapter.ingest(HUB_RECORDS).events;
  const same = compareIngestion(existing, normalized);
  assert.equal(same.equivalent, true, JSON.stringify(same.differences));
  assert.equal(same.compared, 3);

  // Negative control: a comparator that cannot detect a difference is useless.
  const drifted = normalized.map((e, i) => (i === 0 ? { ...e, text: `${e.text} (rewritten)` } : e));
  const differs = compareIngestion(existing, drifted);
  assert.equal(differs.equivalent, false);
  assert.equal(differs.differences[0].field, "text");

  const dropped = compareIngestion(existing, normalized.slice(1));
  assert.equal(dropped.equivalent, false);
  assert.equal(dropped.missing_from_normalized.length, 1);

  const extra = compareIngestion(existing.slice(1), normalized);
  assert.equal(extra.equivalent, false);
  assert.equal(extra.extra_in_normalized.length, 1);
});
