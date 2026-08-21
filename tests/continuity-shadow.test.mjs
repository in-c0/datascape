import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRedactor, redactCorpus, scanArtifact } from "../src/continuity/shadow/redact.js";
import {
  ALLOWED_EDGE_KINDS,
  FORBIDDEN_FIELDS,
  findCycles,
  normalizeCandidate,
  validateCandidate,
} from "../src/continuity/shadow/validate.js";
import {
  assignStableIds,
  matchScore,
  replayReport,
  stabilityReport,
} from "../src/continuity/shadow/identity.js";
import {
  BOUNDED_SHADOW_LIMIT,
  buildSecuritySnapshot,
  createProposer,
  materialityFeatures,
} from "../src/continuity/shadow/snapshot.js";

// A deliberately nasty little corpus: a real-shaped key, a statement ABOUT the
// key that must survive, a scanner result that must not be collapsed with it,
// and an owner exception.
// Credential SHAPES, assembled at runtime. Never written as contiguous
// literals: a secret scanner flags credential-shaped strings in committed
// source, correctly, and a fixture does not get an exemption for being fake.
const OPAQUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const OPENAI_KEY = ["sk", "proj", OPAQUE].join("-");
const GOOGLE_KEY = ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r"].join("");

const records = [
  { id: "sec_01", lane: "Security", at: "2026-08-20T09:00:00+10:00", kind: "risk", severity: "high",
    text: "A live API key is present in published git history." },
  { id: "sec_02", lane: "Security", at: "2026-08-20T09:05:00+10:00", kind: "risk", severity: "high",
    text: `The exposed value is ${OPENAI_KEY} and a second key ${GOOGLE_KEY} appears in the same commit.` },
  { id: "sec_03", lane: "Security", at: "2026-08-21T11:00:00+10:00", kind: "uncertainty_resolved",
    text: "Secret scanning passes the current tree but cannot invalidate the already published credential.",
    references: ["other_01"] },
  { id: "sec_04", lane: "Security", at: "2026-08-21T11:30:00+10:00", kind: "owner_attention", ownerAction: true,
    text: "Rotate the exposed key and revoke the old credential." },
  { id: "other_01", lane: "Distribution", at: "2026-08-21T10:00:00+10:00", kind: "progress",
    text: "Scanner tooling was upgraded to the current ruleset." },
  { id: "other_02", lane: "Distribution", at: "2026-08-21T10:10:00+10:00", kind: "progress",
    text: "Unrelated distribution work that must NOT be pulled in." },
];
const exceptions = [
  { id: "exc_01", sourceId: "sec_04", title: "Rotate the exposed key and revoke the old credential." },
];

// §1 -------------------------------------------------------------------------

test("v3.2 §1: the boundary closes at one explicit hop and pulls in nothing else", () => {
  const snap = buildSecuritySnapshot(records, exceptions);
  assert.equal(snap.blocked, null);
  const ids = new Set(snap.source_ids);
  for (const id of ["sec_01", "sec_02", "sec_03", "sec_04"]) assert.ok(ids.has(id), `${id} missing`);
  assert.ok(ids.has("other_01"), "an explicitly referenced record is one hop and belongs");
  assert.equal(ids.has("other_02"), false,
    "a neighbour must not be pulled in merely because it looks semantically relevant");
  assert.equal(snap.reference_hop_count, 1);
  assert.equal(snap.exception_count, 1);
});

test("v3.2 §1: an oversized closure stops and inventories instead of truncating", () => {
  const many = Array.from({ length: BOUNDED_SHADOW_LIMIT + 5 }, (_, i) => ({
    id: `sec_big_${i}`, lane: "Security", at: "2026-08-20T09:00:00+10:00", kind: "progress", text: `record ${i}`,
  }));
  const snap = buildSecuritySnapshot(many, []);
  assert.equal(snap.blocked, "security slice exceeded bounded-shadow limit");
  assert.equal(snap.inventory.total, BOUNDED_SHADOW_LIMIT + 5);
  assert.equal(snap.source_ids, undefined, "a blocked slice must not hand back a partial corpus");
});

test("v3.2 §1: the snapshot hash changes when the corpus does, and only then", () => {
  const a = buildSecuritySnapshot(records, exceptions);
  const b = buildSecuritySnapshot(records, exceptions);
  assert.equal(a.source_hash, b.source_hash, "the same corpus must hash identically");
  const edited = records.map((r) => (r.id === "sec_01" ? { ...r, text: `${r.text} (edited)` } : r));
  assert.notEqual(buildSecuritySnapshot(edited, exceptions).source_hash, a.source_hash);
});

// §2 -------------------------------------------------------------------------

test("v3.2 §2: secrets are redacted while the statement about them survives", () => {
  const snap = buildSecuritySnapshot(records, exceptions);
  const all = JSON.stringify(snap.redacted);
  assert.equal(all.includes(OPENAI_KEY), false, "a raw key must never reach the redacted corpus");
  assert.equal(all.includes(GOOGLE_KEY), false);
  const statement = snap.redacted.find((r) => r.id === "sec_01");
  assert.equal(statement.text, "A live API key is present in published git history.",
    "the finding itself is not a secret and must be preserved exactly");
  const carrier = snap.redacted.find((r) => r.id === "sec_02");
  assert.match(carrier.text, /<SECRET_\d+:OPENAI_API_KEY>/);
  assert.match(carrier.text, /<SECRET_\d+:GOOGLE_API_KEY>/);
});

test("v3.2 §2: the same secret gets the same placeholder across the snapshot", () => {
  const twice = [
    { id: "a", lane: "Security", at: "2026-08-20T09:00:00+10:00", text: `key ${OPENAI_KEY} here` },
    { id: "b", lane: "Security", at: "2026-08-20T09:01:00+10:00", text: `same key ${OPENAI_KEY} again` },
  ];
  const snap = buildSecuritySnapshot(twice, []);
  const tokenOf = (id) => snap.redacted.find((r) => r.id === id).text.match(/<SECRET_\d+:[A-Z_]+>/)[0];
  assert.equal(tokenOf("a"), tokenOf("b"),
    "a model must be able to reason that two records mention one key without seeing it");
});

test("v3.2 §2: the detector is the gate on every artifact, and it can fail", () => {
  // Negative control: a deliberately leaky artifact must be caught.
  assert.ok(scanArtifact({ label: `oops ${OPENAI_KEY}` }).length > 0,
    "a leaked key in a generated artifact must be detected");
  assert.equal(scanArtifact({ label: "no secrets here" }).length, 0);
  const redactor = createRedactor();
  assert.equal(redactor.detect(redactor.redact(`token ${GOOGLE_KEY}`).text).length, 0,
    "redacted output must itself be clean");
});

test("v3.2 §2: a record that cannot be confidently protected is withheld, not sent", () => {
  const stubborn = createRedactor();
  // Force the failure mode: a redactor whose output still contains a secret.
  const leaky = { redact: (t) => ({ text: t, hits: [] }), detect: stubborn.detect, table: () => [] };
  const { redacted, withheld } = redactCorpus(
    [{ id: "x", text: `key ${OPENAI_KEY}` }, { id: "y", text: "clean" }],
    { redactor: leaky },
  );
  assert.deepEqual(redacted.map((r) => r.id), ["y"]);
  assert.equal(withheld[0].id, "x");
  assert.equal(withheld[0].reason, "withheld_sensitive_source");
});

// §5-§8 ----------------------------------------------------------------------

const snapshot = buildSecuritySnapshot(records, exceptions);
const goodCandidate = {
  projections: [
    {
      candidate_id: "c1", type: "projection",
      label: "A published credential remains exposed",
      direct_children: ["c2", "sec_01"],
      source_observation_ids: ["sec_01", "sec_02"],
      evidence: [{ source_id: "sec_01", start: 0, end: 10 }],
      relationships: [{ kind: "supports", target: "c2" }],
      candidate_materiality: "high",
      open_questions: [],
    },
    {
      candidate_id: "c2", type: "projection",
      label: "The current tree scans clean",
      direct_children: ["sec_03"],
      source_observation_ids: ["sec_03"],
      evidence: [{ source_id: "sec_03", start: 0, end: 12 }],
      relationships: [],
      candidate_materiality: "medium",
      open_questions: [],
    },
  ],
};

test("v3.2 §8: a well-formed candidate passes every structural gate", () => {
  const report = validateCandidate(goodCandidate, snapshot);
  assert.equal(report.candidate_valid, true, JSON.stringify(report.failures));
  assert.equal(report.counts.projections, 2);
});

test("v3.2 §5: the proposer may not assert deterministic or source-derived state", () => {
  for (const field of ["execution", "at", "ownerAction", "status", "stable_shadow_id"]) {
    assert.ok(FORBIDDEN_FIELDS.includes(field), `${field} must be forbidden`);
    const bad = JSON.parse(JSON.stringify(goodCandidate));
    bad.projections[0][field] = "live";
    const report = validateCandidate(bad, snapshot);
    assert.equal(report.candidate_valid, false);
    assert.ok(report.failures.some((f) => f.code === "forbidden_field" && f.field === field));
  }
});

test("v3.2 §8: causal edges are rejected outright", () => {
  const bad = JSON.parse(JSON.stringify(goodCandidate));
  bad.projections[0].relationships = [{ kind: "causes", target: "c2" }];
  const report = validateCandidate(bad, snapshot);
  assert.equal(report.candidate_valid, false);
  assert.ok(report.failures.some((f) => f.code === "prohibited_edge_kind"));
  assert.equal(ALLOWED_EDGE_KINDS.includes("causes"), false);
});

test("v3.2 §6-§7: provenance and resolvable evidence are required, not preferred", () => {
  const noSource = JSON.parse(JSON.stringify(goodCandidate));
  noSource.projections[0].source_observation_ids = [];
  assert.ok(validateCandidate(noSource, snapshot).failures.some((f) => f.code === "no_source_observation"));

  const dangling = JSON.parse(JSON.stringify(goodCandidate));
  dangling.projections[0].source_observation_ids = ["sec_99"];
  assert.ok(validateCandidate(dangling, snapshot).failures.some((f) => f.code === "dangling_source"));

  // A beautiful explanation with an unresolvable offset still fails.
  const badOffset = JSON.parse(JSON.stringify(goodCandidate));
  badOffset.projections[0].evidence = [{ source_id: "sec_01", start: 5, end: 9999 }];
  assert.ok(validateCandidate(badOffset, snapshot).failures.some((f) => f.code === "evidence_offset_unresolvable"));
});

test("v3.2 §8: cycles are found rather than tolerated", () => {
  const cyclic = {
    projections: [
      { ...goodCandidate.projections[0], direct_children: ["c2"] },
      { ...goodCandidate.projections[1], direct_children: ["c1"] },
    ],
  };
  assert.ok(findCycles(cyclic.projections).length > 0);
  assert.ok(validateCandidate(cyclic, snapshot).failures.some((f) => f.code === "cycle"));
});

test("v3.2 §8: a leaked secret inside a candidate is a structural failure", () => {
  const leaky = JSON.parse(JSON.stringify(goodCandidate));
  leaky.projections[0].label = `The key ${OPENAI_KEY} is exposed`;
  const report = validateCandidate(leaky, snapshot);
  assert.equal(report.candidate_valid, false);
  assert.ok(report.failures.some((f) => f.code === "raw_secret_in_candidate"));
});

test("v3.2 §8: repair produces a SEPARATE artifact and never rewrites the verdict", () => {
  const bad = JSON.parse(JSON.stringify(goodCandidate));
  bad.projections[0].execution = "live";
  bad.projections[0].source_observation_ids = ["sec_01", "sec_99"];
  const before = validateCandidate(bad, snapshot);
  const fixed = normalizeCandidate(bad, snapshot);
  assert.equal(before.candidate_valid, false, "the original failure stays recorded");
  assert.equal(fixed.normalized, true);
  assert.equal(fixed.projections[0].execution, undefined);
  assert.equal(validateCandidate(fixed, snapshot).candidate_valid, true);
  assert.notEqual(fixed, bad, "the repair must not mutate the original candidate");
});

// §11-§13 --------------------------------------------------------------------

test("v3.2 §11: identity comes from evidence overlap, not from the model's say-so", () => {
  const a = { candidate_id: "x", label: "Credential exposure", source_observation_ids: ["sec_01", "sec_02"], direct_children: ["sec_01"] };
  const reworded = { candidate_id: "y", label: "A published key is still live", source_observation_ids: ["sec_01", "sec_02"], direct_children: ["sec_01"] };
  const different = { candidate_id: "z", label: "Credential exposure", source_observation_ids: ["sec_03"], direct_children: ["sec_03"] };

  assert.ok(matchScore(a, reworded).score > matchScore(a, different).score,
    "same evidence and different words is the SAME concept; same words and different evidence is not");

  const prior = [{ ...a, stable_shadow_id: "shadow_security_001", revision: 1 }];
  const assigned = assignStableIds([reworded], prior);
  assert.equal(assigned[0].stable_shadow_id, "shadow_security_001");
  assert.equal(assigned[0].revision, 2, "a changed interpretation revises rather than replaces");

  const fresh = assignStableIds([different], prior);
  assert.equal(fresh[0].previous_revision, null, "a genuinely new concept gets a new identity");
  assert.match(fresh[0].stable_shadow_id, /^shadow_security_/);
});

test("v3.2 §11: a shadow id can never be mistaken for a production projection id", () => {
  const assigned = assignStableIds(goodCandidate.projections, []);
  for (const a of assigned) assert.match(a.stable_shadow_id, /^shadow_/);
});

test("v3.2 §12: stability is measured without a pass threshold being invented", () => {
  const r1 = goodCandidate;
  const r2 = { projections: goodCandidate.projections.map((n) => ({ ...n, label: `${n.label} (reworded)` })) };
  const r3 = { projections: [goodCandidate.projections[0]] };
  const report = stabilityReport([r1, r2, r3]);
  assert.equal(report.runs, 3);
  assert.deepEqual(report.node_counts, [2, 2, 1]);
  assert.ok(report.node_count_variance > 0, "a run that dropped a concept must show as variance");
  assert.ok(report.pairs.length === 3);
  const rewordPair = report.pairs.find((p) => p.runs[0] === 1 && p.runs[1] === 2);
  assert.equal(rewordPair.matched_concept_rate, 1, "rewording must not read as structural drift");
  assert.ok(rewordPair.label_only_variation > 0, "but it must still be visible as label variation");
  assert.match(report.note, /No pass threshold/);
});

test("v3.2 §13: replay separates retained, revised and genuinely new concepts", () => {
  const t0 = { projections: [goodCandidate.projections[0]] };
  const t1 = {
    projections: [
      { ...goodCandidate.projections[0], label: "A published credential remains exposed and unrotated" },
      goodCandidate.projections[1],
    ],
  };
  const report = replayReport(t0, t1);
  assert.equal(report.t0_count, 1);
  assert.equal(report.t1_count, 2);
  assert.equal(report.revised, 1, "the same concept reinterpreted keeps its id and takes a revision");
  assert.equal(report.new_concepts, 1);
});

// §14, §18 -------------------------------------------------------------------

test("v3.2 §14: materiality features are recorded alongside the model's claim, never instead of it", () => {
  const features = materialityFeatures(goodCandidate.projections[0], snapshot);
  assert.equal(features.security_severity, "high");
  assert.equal(features.scope, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(features, "volume"), false,
    "volume must never be recordable as a REASON for materiality");
  assert.equal(goodCandidate.projections[0].candidate_materiality, "high",
    "the model's own claim is left untouched for later comparison");
});

test("v3.2 §18: with no proposer configured the run blocks instead of faking output", async () => {
  const proposer = createProposer({ provider: "none" });
  const result = await proposer.propose(snapshot);
  assert.match(result.blocked, /no proposer configured/);
  assert.match(result.detail, /never inferred from an automated continuation/);
  assert.equal(result.proposal_raw, undefined, "a blocked run must not emit a heuristic candidate");
});

test("v3.2 §4: the manifest pins the prompt version so two runs are comparable", () => {
  const a = createProposer({ provider: "test", model: "m", promptTemplate: "v1 prompt" }).manifest(snapshot);
  const b = createProposer({ provider: "test", model: "m", promptTemplate: "v1 prompt" }).manifest(snapshot);
  const moved = createProposer({ provider: "test", model: "m", promptTemplate: "v2 prompt" }).manifest(snapshot);
  assert.equal(a.proposer.prompt_version, b.proposer.prompt_version);
  assert.notEqual(a.proposer.prompt_version, moved.proposer.prompt_version,
    "a silently moving prompt would make every comparison meaningless");
  assert.equal(a.mode, "shadow");
  assert.equal(a.input_snapshot_hash, snapshot.source_hash);
});

test("v3.2 §5: the proposer only ever receives redacted text", async () => {
  let seen = null;
  const proposer = createProposer({
    provider: "test", model: "m", promptTemplate: "p",
    call: async ({ payload }) => { seen = payload; return { projections: [] }; },
  });
  await proposer.propose(snapshot);
  const sent = JSON.stringify(seen);
  assert.equal(sent.includes(OPENAI_KEY), false);
  assert.equal(sent.includes(GOOGLE_KEY), false);
  assert.ok(sent.includes("<SECRET_"));
});

// §3, §17 --------------------------------------------------------------------

test("v3.2 §3/§17: nothing in the application can reach the shadow path", () => {
  const root = path.resolve("src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx)$/.test(entry.name)) continue;
      // The shadow modules themselves are allowed to know their own domain.
      if (full.includes(path.join("continuity", "shadow"))) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/shadow[\\/]/.test(text) || /_hub[\\/]shadow/.test(text) || /from ["'].*shadow\//.test(text)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    "shadow means incapable of affecting the operator, not merely hidden by CSS");
});
