// v6.1.2:remap — the real five-lane remapping and 8-hour shadow schedule
// (spec V6.1.2 §13, §14, §15, §17).
//
// Lane trunks become CONTAINERS. Executable topic intents are derived only from
// source-grounded evidence, and where no such evidence exists the lane simply
// has no executable work — which the spec explicitly allows and which is the
// honest answer here.
//
// No execution. No transport. No generated scope text used as evidence.
import fs from "node:fs";
import path from "node:path";
import { createContainer, applyTimerClassification, deriveTopicIntent } from "../src/continuity/control/topic.js";
import { createGateScope, createScope, topicOf } from "../src/continuity/control/scope.js";
import { createIntent } from "../src/continuity/control/intent.js";
import { attributionMetrics, exercisedCategories, releaseCriterion, simulate } from "../src/continuity/control/simulate.js";
import { runAdversarial } from "../src/continuity/control/adversarial.js";
import { selectCanary } from "../src/continuity/control/canary.js";

const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6.1.2");
const START = process.env.SIM_START || "2026-08-21T22:00:00+10:00";

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

// --- lanes ---------------------------------------------------------------------
const laneRecords = readJson(path.join(SHIP, "mustreads", "lanes.json"), {});
const lanes = Object.values(laneRecords).map((lane) => ({
  ...lane,
  status: lane.stoppedAt ? "done" : "active",
  // timer_evidence is deliberately absent. Section 7 forbids reading an
  // autoRunUrl or a six-minute firing history as evidence of an authored
  // recurring goal, and no lane record carries an authored one, so every timer
  // classifies as UNDETERMINED. Populating this from the registry would be
  // exactly the reinterpretation the spec rules out.
  timer_evidence: lane.timer_evidence ?? {},
}));

// --- the authoritative exception layer ----------------------------------------
const exDir = path.join(SHIP, "exceptions");
const exceptions = (fs.existsSync(exDir) ? fs.readdirSync(exDir) : [])
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => {
    const text = fs.readFileSync(path.join(exDir, f), "utf8");
    const field = (name) => (text.match(new RegExp(`^${name}:\\s*(.+)$`, "m")) || [])[1]?.trim() ?? null;
    const loop = field("loop");
    return { id: field("id") || f.replace(/\.md$/, ""), loop, topic: topicOf(loop), status: field("status"), title: field("title") };
  });
// Section 5: each gate's scope is a PROJECTION of what its exception already
// references. Nothing is added to an exception to make V6 happy, so a thin
// exception yields a thin gate scope and that thinness is reported.
const openGates = exceptions
  .filter((e) => e.status === "blocked-on-owner")
  .map((gate) => ({ ...gate, ...createGateScope(gate) }));

// --- the remapping -------------------------------------------------------------
const laneReports = [];
const intents = [];

for (const lane of lanes) {
  const timer = applyTimerClassification(lane);
  const container = createContainer({
    lane: lane.lane,
    label: lane.label,
    mission: lane.note || null,
    policy: timer.policy,
  });
  intents.push(container);

  const laneGates = openGates.filter((g) => {
    const prefix = String(g.loop || "").split("/")[0];
    return prefix === lane.lane || lane.lane.startsWith(prefix) || prefix.startsWith(lane.lane);
  });

  // Owner-gated intents: one per open gate, each carrying its own gate scope.
  const gateIntents = laneGates.map((gate) => ({
    ...createIntent({
      intent_id: `topic:${lane.lane}:${gate.id}`,
      semantic_centre: lane.label || lane.lane,
      goal: gate.title || gate.id,
      success_condition: "the owner rules on this exception",
      owner_gate_ids: [gate.id],
      state: "blocked_on_owner",
    }),
    role: "executable",
    executable: true,
    lane: lane.lane,
    scope: createScope({
      semantic_centre: lane.label || lane.lane,
      lane: lane.lane,
      topic_refs: [gate.topic].filter(Boolean),
      scope_provenance_refs: [gate.id],
      completeness: gate.gate_scope_completeness,
    }),
    authority: "owner_required",
  }));
  intents.push(...gateIntents);

  // Executable topic intents: derived ONLY from grounded evidence. The lane
  // registry records that a lane exists and that a cron fires; it records no
  // current_operation, no checkpoint and no open work record. So nothing here
  // is derivable, and that is reported rather than filled in.
  const grounded = (lane.work_evidence || []).map((evidence) =>
    deriveTopicIntent({ lane, evidence, openGates: laneGates }));
  const derived = grounded.filter((g) => g.ok).map((g) => g.intent);
  intents.push(...derived);

  laneReports.push({
    lane: lane.lane,
    container_intent: container.intent_id,
    timer_class: timer.klass,
    timer_basis: timer.basis,
    executable_topic_intents: derived.length,
    owner_gated_intents: gateIntents.length,
    refused_for_lack_of_provenance: grounded.filter((g) => !g.ok).length,
    scope_complete: [...gateIntents, ...derived].filter((i) => i.scope.completeness === "complete").length,
    scope_partial: [...gateIntents, ...derived].filter((i) => i.scope.completeness === "partial").length,
    scope_unknown: [...gateIntents, ...derived].filter((i) => i.scope.completeness === "unknown").length,
  });
}

// --- the 8-hour prospective schedule ------------------------------------------
const sim = simulate({ intents, openGates, startMs: Date.parse(START), hours: 8, tickMs: 360000 });
const metrics = attributionMetrics(sim);
const exercised = exercisedCategories(sim);
const adversarial = runAdversarial();
const countFailures = (names) => adversarial.cases.filter((c) => names.includes(c.name) && !c.pass).length;

const dangerous = {
  simultaneous_lease_violations: sim.simultaneous_lease_violations,
  stale_generation_mutations_accepted: countFailures(["stale_generation_cannot_mutate", "stale_write_refused_by_fence"]),
  machine_gate_resolutions_accepted: countFailures(["machine_gate_claim_has_no_authority", "machine_ruling_cannot_transition"]),
  generic_ctn_gate_resolutions_accepted: countFailures(["generic_owner_ctn_resolves_nothing", "generic_owner_ctn_cannot_transition"]),
  unattributed_result_settlements: countFailures(["unattributed_result_cannot_settle", "wrong_intent_id_cannot_settle"]),
  scope_expansion_violations_accepted: countFailures(["scope_expansion_is_refused", "scope_expansion_requires_new_dispatch"]),
};

// --- section 12: deterministic real-shaped discrimination -----------------------
//
// The real-lane run above exercises ONE category, because every lane is
// currently owner-gated or ungrounded. That alone cannot show the firewall
// distinguishes cases rather than simply denying everything — and a system that
// denies uniformly looks identical to a correct one right up until it matters.
//
// So the three outcomes are proven on a deterministic real-shaped fixture,
// reported SEPARATELY. These numbers are never mixed into the real-lane
// numbers: a fixture dispatch is not evidence that a real lane may dispatch.
const FIXTURE_GATE = { id: "FG1", loop: "fixture/gated-topic", topic: "gated-topic", scope_completeness: "complete" };
const fixtureIntent = (key, scope, state = "ready") => ({
  ...createIntent({
    intent_id: `fixture:${key}`, semantic_centre: "Fixture",
    goal: "verify", success_condition: "green", current_operation: "run_tests",
    state, owner_gate_ids: state === "blocked_on_owner" ? [FIXTURE_GATE.id] : [],
  }),
  role: "executable", executable: true, authority: "autonomous",
  wake: { type: "recurring_goal", next_step_budget: { max_steps: 2 }, goal_ref: key },
  scope,
});
const discriminationSim = simulate({
  intents: [
    // Explicitly unrelated, both scopes complete -> must dispatch.
    fixtureIntent("unrelated", createScope({
      semantic_centre: "Fixture", topic_refs: ["other-topic"],
      scope_provenance_refs: ["fixture-evidence-1"], completeness: "complete",
    })),
    // Explicitly overlapping -> must block on the owner.
    fixtureIntent("overlapping", createScope({
      semantic_centre: "Fixture", topic_refs: ["gated-topic"],
      scope_provenance_refs: ["fixture-evidence-2"], completeness: "complete",
    })),
    // Relationship unknown -> must block, not proceed.
    fixtureIntent("undeclared", createScope({
      semantic_centre: "Fixture", scope_provenance_refs: ["fixture-evidence-3"], completeness: "partial",
    })),
  ],
  openGates: [FIXTURE_GATE], startMs: Date.parse(START), hours: 8, tickMs: 360000,
});
const discriminationMetrics = attributionMetrics(discriminationSim);
const discriminationExercised = exercisedCategories(discriminationSim);

const criterion = releaseCriterion(metrics, dangerous, exercised);
const fixtureCriterion = releaseCriterion(discriminationMetrics, dangerous, discriminationExercised);
const canary = criterion.met
  ? selectCanary(sim.dispatches, Object.fromEntries(intents.map((i) => [i.intent_id, i])))
  : { considered: 0, eligible: 0, candidate: null, blocked_reason: "the shadow gate has not passed, so no canary is selected" };

const report = {
  real_lanes: lanes.length,
  container_intents: intents.filter((i) => i.role === "container").length,
  executable_topic_intents: intents.filter((i) => i.role === "executable" && i.authority !== "owner_required").length,
  owner_gated_intents: intents.filter((i) => i.authority === "owner_required").length,

  legacy_fixed_timers: lanes.length,
  converted_recurring: laneReports.filter((l) => l.timer_class === "recurring_goal").length,
  converted_named_polls: laneReports.filter((l) => l.timer_class === "named_poll_condition").length,
  removed: laneReports.filter((l) => l.timer_class === "obsolete").length,
  unclassifiable: laneReports.filter((l) => l.timer_class === "undetermined").length,

  scope_complete: laneReports.reduce((a, l) => a + l.scope_complete, 0),
  scope_partial: laneReports.reduce((a, l) => a + l.scope_partial, 0),
  scope_unknown: laneReports.reduce((a, l) => a + l.scope_unknown, 0),

  eligibility_events_8h: Object.values(sim.outcomes).reduce((a, b) => a + b, 0),
  would_dispatch: metrics.would_dispatch,
  fully_attributed: metrics.fully_attributed,
  would_block_owner: metrics.owner_gate_blocked,
  would_block_scope_unknown: metrics.scope_unknown_blocked,
  would_block_authority_unknown: metrics.authority_unknown_blocked,
  would_block_budget: metrics.budget_blocked,
  would_wait_dependency: metrics.dependency_wakeups,

  ...dangerous,

  adversarial_cases: adversarial.total,
  adversarial_passed: adversarial.passed,
  exercised_categories: exercised,
  // Kept separate on purpose. A fixture dispatch proves the firewall
  // discriminates; it does NOT establish that any real lane may dispatch.
  discrimination_fixture: {
    would_dispatch: discriminationMetrics.would_dispatch,
    fully_attributed: discriminationMetrics.fully_attributed,
    would_block_owner: discriminationMetrics.owner_gate_blocked,
    would_block_scope_unknown: discriminationMetrics.scope_unknown_blocked,
    exercised: discriminationExercised,
    all_three_outcomes_reachable: discriminationExercised.dispatch_beside_unrelated_gate
      && discriminationExercised.owner_gate_block
      && discriminationExercised.unknown_scope_block,
    criterion_met_on_fixture: fixtureCriterion.met,
    fixture_blocking_reasons: fixtureCriterion.reasons,
  },
  execution_release_criterion_met: criterion.met,
  blocking_reasons: criterion.reasons,
  canary,

  execution_dispatched: 0,
  continuation_messages_sent: 0,
  owner_state_mutations: 0,
  lanes: laneReports,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "remap-report.json"), JSON.stringify({ report, sim_outcomes: sim.outcomes }, null, 2));

console.log(JSON.stringify(report, null, 2));
process.exit(0);
