import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_KINDS, TRIGGER, preserveCanonical } from "../src/continuity/protocol/event.js";
import { githubAdapter, hubLaneAdapter } from "../src/continuity/protocol/adapters.js";
import {
  INGESTION_LEGACY, INGESTION_PROTOCOL,
  auditDownstreamTruthfulness, cutoverChurn, ingestHubRecords, semanticSourceIdentities,
} from "../src/continuity/protocol/ingestion.js";
import {
  auditGithubFidelity, createGithubCollector, snapshotOf, toAdapterInput,
} from "../src/continuity/protocol/github-collector.js";

const LANE_SUPERVISION = { Alpha: "unattended", Beta: "unknown" };
const RECORDS = [
  { id: "a1", lane: "Alpha", at: "2026-08-21T09:00:00+10:00", kind: "state", text: "The gate closed." },
  { id: "a2", lane: "Alpha", at: "2026-08-21T09:10:00+10:00", kind: "owner_action", text: "Rotate the key." },
  { id: "b1", lane: "Beta", at: "2026-08-21T09:20:00+10:00", kind: "finding", text: "Scan is clean.", trigger: { kind: "scheduler" } },
];

// ---- V5.2A: the Hub cutover ---------------------------------------------------

test("V5.2A: the protocol path is the default and legacy is explicit only", () => {
  const dflt = ingestHubRecords(RECORDS);
  assert.equal(dflt.mode, INGESTION_PROTOCOL);
  assert.equal(dflt.ok, true);
  const legacy = ingestHubRecords(RECORDS, { mode: INGESTION_LEGACY, laneSupervision: LANE_SUPERVISION });
  assert.equal(legacy.diagnostic, true, "legacy is a diagnostic path, never a default");
});

test("V5.2A: a normalization failure surfaces instead of falling back", () => {
  const broken = [...RECORDS, { id: "bad", lane: "Alpha", at: "not-a-time", kind: "state", text: "x" }];
  const result = ingestHubRecords(broken);
  assert.equal(result.ok, false, "a partial ingestion must not read as complete");
  assert.equal(result.rejected.length, 1);
  assert.match(result.error, /failed protocol normalization/);
  assert.equal(result.mode, INGESTION_PROTOCOL, "it must not silently become the legacy path");
});

test("V5.2A: truthfulness survives downstream, not just the adapter", () => {
  const { events } = ingestHubRecords(RECORDS);
  const audit = auditDownstreamTruthfulness(events, LANE_SUPERVISION);
  assert.ok(audit.unknown_supervision >= 2, "records with no trigger evidence stay unknown");
  assert.ok(audit.at_risk_of_restoration >= 1, "an Alpha record could have inherited unattended");
  assert.equal(audit.still_unknown, true,
    "a later lane-level fallback restoring unattended would be as wrong as inferring it");
});

test("V5.2A: replacing the normalization path causes zero semantic-history churn", () => {
  const legacy = ingestHubRecords(RECORDS, { mode: INGESTION_LEGACY, laneSupervision: LANE_SUPERVISION }).events;
  const protocolEvents = ingestHubRecords(RECORDS).events;
  const churn = cutoverChurn(legacy, protocolEvents);
  assert.equal(churn.churn, 0, JSON.stringify({ added: churn.added, removed: churn.removed }));
  assert.equal(churn.identities_before, churn.identities_after);

  // Negative control: a genuinely changed corpus MUST show churn, or the check
  // is incapable of detecting the thing it exists to detect.
  const edited = ingestHubRecords(
    RECORDS.map((r) => (r.id === "a1" ? { ...r, text: `${r.text} (edited)` } : r)),
  ).events;
  assert.ok(cutoverChurn(legacy, edited).churn > 0);
});

test("V5.2A: identity is stable across repeated ingestion", () => {
  const a = semanticSourceIdentities(ingestHubRecords(RECORDS).events);
  const b = semanticSourceIdentities(ingestHubRecords(RECORDS).events);
  assert.deepEqual(a, b);
});

test("V5.2: normalization never overwrites an already-canonical value", () => {
  // The protocol-wide rule the three real-corpus defects implied.
  for (const kind of EVENT_KINDS) {
    assert.equal(preserveCanonical(kind, EVENT_KINDS, () => "observation"), kind,
      `${kind} is canonical and must pass through untouched`);
  }
  for (const trigger of TRIGGER) {
    assert.equal(preserveCanonical(trigger, TRIGGER, () => "unknown"), trigger);
  }
  // A foreign vocabulary still translates.
  assert.equal(preserveCanonical("risk", EVENT_KINDS, () => "finding"), "finding");

  // And end to end: every canonical kind survives the real adapter.
  for (const kind of EVENT_KINDS) {
    const { events } = hubLaneAdapter.ingest([
      { id: `x-${kind}`, lane: "L", at: "2026-08-21T09:00:00+10:00", kind, text: "t" },
    ]);
    assert.equal(events[0].kind, kind, `${kind} was rewritten by the adapter`);
  }
});

// ---- V5.2B: the collector -----------------------------------------------------

const NATIVE_FIXTURE = [
  {
    number: 21, title: "Briefing V4 PR B", author: { login: "avakim" },
    createdAt: "2026-08-21T11:00:00Z", mergedAt: "2026-08-21T12:00:00Z",
    closedAt: "2026-08-21T12:00:00Z", headRefOid: "abc123",
    url: "https://github.com/in-c0/datascape/pull/21",
  },
  {
    number: 22, title: "Abandoned experiment", author: { login: "bot-user", type: "Bot" },
    createdAt: "2026-08-21T13:00:00Z", closedAt: "2026-08-21T13:30:00Z", mergedAt: null,
    headRefOid: "def456", url: "https://github.com/in-c0/datascape/pull/22",
  },
];

test("V5.2B: the collector exposes no write capability at all", async () => {
  const collector = createGithubCollector({ read: async () => NATIVE_FIXTURE });
  assert.equal(collector.readOnly, true);
  for (const forbidden of ["merge", "comment", "label", "close", "rerun", "write", "update", "delete"]) {
    assert.equal(typeof collector[forbidden], "undefined",
      `${forbidden} must not exist on the collector interface`);
  }
  assert.deepEqual(Object.keys(collector).sort(), ["observe", "readOnly"]);
  assert.throws(() => createGithubCollector({}), /read-only reader is required/);
});

test("V5.2B: native observation types are not collapsed in the collector", async () => {
  const collector = createGithubCollector({ read: async () => NATIVE_FIXTURE });
  const { native } = await collector.observe("in-c0/datascape");
  const types = new Set(native.map((n) => n.native_type));
  assert.ok(types.has("github.pull_request.opened"));
  assert.ok(types.has("github.pull_request.merged"));
  assert.ok(types.has("github.pull_request.closed"), "a closed-unmerged PR is its own source fact");
  assert.equal(native.length, 4);
});

test("V5.2B: the author's identity never leaks into merge trigger provenance", async () => {
  // A human-authored PR whose merge initiator the API does not establish.
  const collector = createGithubCollector({ read: async () => [NATIVE_FIXTURE[0]] });
  const { native } = await collector.observe("in-c0/datascape");
  const merge = native.find((n) => n.native_type === "github.pull_request.merged");
  assert.equal(merge.actor_type, "unknown", "who merged was not established, so it stays unknown");

  const { events } = githubAdapter.ingest(native.map(toAdapterInput));
  const mergeEvent = events.find((e) => e.native_id.endsWith(":merged"));
  assert.equal(mergeEvent.authorship, "external_system");
  assert.equal(mergeEvent.trigger, "unknown",
    "human prose in the title must not make the merge operator-triggered");
  assert.equal(mergeEvent.supervision, "unknown");

  // And when it IS established, it is used.
  const withDetail = createGithubCollector({
    read: async () => [NATIVE_FIXTURE[0]],
    readDetail: async () => ({ mergedBy: { login: "avakim" } }),
  });
  const detailed = await withDetail.observe("in-c0/datascape");
  const known = detailed.native.find((n) => n.native_type === "github.pull_request.merged");
  assert.equal(known.actor_type, "human");
});

test("V5.2B: source fidelity is the gate, and it can fail", async () => {
  const collector = createGithubCollector({ read: async () => NATIVE_FIXTURE });
  const { native } = await collector.observe("in-c0/datascape");
  const { events } = githubAdapter.ingest(native.map(toAdapterInput));
  const clean = auditGithubFidelity(native, events);
  assert.deepEqual(clean.failures, []);
  assert.equal(clean.audited, native.length);

  // Negative control: a rewritten title must be caught.
  const tampered = events.map((e) => ({ ...e, text: `${e.text} (rewritten)` }));
  assert.ok(auditGithubFidelity(native, tampered).failures.length > 0);
});

test("V5.2B: a snapshot carries provenance and no credential", async () => {
  const collector = createGithubCollector({ read: async () => NATIVE_FIXTURE });
  const { native } = await collector.observe("in-c0/datascape");
  const snap = snapshotOf("in-c0/datascape", native, "2026-08-21T12:00:00Z");
  assert.equal(snap.native_event_count, native.length);
  assert.ok(snap.payload_hash);
  const serialized = JSON.stringify(snap).toLowerCase();
  for (const leak of ["token", "authorization", "secret", "password"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must never appear in a snapshot`);
  }
});

test("V5.2B: Hub and GitHub events about one PR stay two events", async () => {
  const hub = hubLaneAdapter.ingest([{
    id: "hub_1", lane: "Datascape", at: "2026-08-21T11:30:00+10:00", kind: "decision",
    text: "Briefing V4 PR B", trigger: { kind: "scheduler" },
  }]).events[0];
  const collector = createGithubCollector({ read: async () => [NATIVE_FIXTURE[0]] });
  const { native } = await collector.observe("in-c0/datascape");
  const gh = githubAdapter.ingest(native.map(toAdapterInput)).events[0];

  assert.notEqual(hub.event_id, gh.event_id,
    "identical prose across two source systems must never be deduplicated into one");
  assert.ok(gh.external_ref, "co-reference is established by an explicit reference");
  for (const event of [hub, gh]) {
    for (const rel of event.relations || []) {
      assert.equal(/^caus/.test(rel.kind), false, "no causal edge may exist between them");
    }
  }
});
