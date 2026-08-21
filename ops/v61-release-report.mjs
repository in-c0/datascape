// v6.1:release-report — the real prospective shadow run (spec V6.1 §7, §10).
//
// Reads the live lane registry and the authoritative exception inbox, derives
// the real intent mapping, classifies every existing wakeup honestly, runs the
// deterministic 8-hour scheduler simulation, and emits the release-criterion
// report.
//
// NOTHING IS DISPATCHED. There is no transport in this process. The simulation
// answers the six formerly-unobservable questions PROSPECTIVELY: not by
// reconstructing what legacy continuation did — that was never recorded, and
// inventing it would be a fabrication — but by establishing that every future
// dispatch is attributable by construction.
import fs from "node:fs";
import path from "node:path";
import { buildShadowReport, laneToIntents } from "../src/continuity/control/shadow-map.js";
import { createScope } from "../src/continuity/control/scope.js";
import { classifyLaneWakes } from "../src/continuity/control/wake.js";
import { attributionMetrics, simulate } from "../src/continuity/control/simulate.js";
import { runAdversarial } from "../src/continuity/control/adversarial.js";
import { topicOf } from "../src/continuity/control/scope.js";

const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6.1");
const START = process.env.SIM_START || "2026-08-21T22:00:00+10:00";

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

// --- lanes ---------------------------------------------------------------------
const laneRecords = readJson(path.join(SHIP, "mustreads", "lanes.json"), {});
const lanes = Object.values(laneRecords).map((lane) => ({
  ...lane,
  status: lane.stoppedAt ? "done" : "active",
  // The wake declaration as it ACTUALLY exists today. Every lane is driven by a
  // fixed-interval cron and declares no condition. Writing anything richer here
  // would be inventing a condition to make the report green, which section 6
  // explicitly forbids.
  wake: lane.wake ?? { type: "interval", interval: 360000 },
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
const openGates = exceptions.filter((e) => e.status === "blocked-on-owner");

// --- the real intent mapping ---------------------------------------------------
const intents = lanes.flatMap((lane) => {
  const derived = laneToIntents(lane, exceptions);
  return derived.map((intent) => ({
    ...intent,
    wake: intent.kind === "trunk" ? lane.wake : null,
    // The trunk of a ctn lane declares NO topic today, so its scope cannot be
    // resolved against the open gates. That is the honest state of the world
    // and it is what blocks execution; a topic invented here would be a lie
    // that happened to produce a green report.
    scope: createScope({
      semantic_centre: intent.semantic_centre,
      lane: lane.lane,
      topic_refs: intent.kind === "owner_gate"
        ? [topicOf(openGates.find((g) => g.id === intent.owner_gate_ids[0])?.loop)].filter(Boolean)
        : [],
    }),
    authority: "autonomous",
  }));
});

// --- runs ----------------------------------------------------------------------
const shadow = buildShadowReport(lanes, exceptions, {});
const wakes = classifyLaneWakes(lanes);
const adversarial = runAdversarial();
const sim = simulate({
  intents,
  openGates,
  startMs: Date.parse(START),
  hours: 8,
  tickMs: 360000,
});
const metrics = attributionMetrics(sim);

const report = {
  real_lanes: lanes.length,
  shadow_intents: intents.length,

  legacy_fixed_timers: wakes.legacy_fixed_timers,
  real_time_dependencies: wakes.real_time_dependencies,
  named_poll_fallbacks: wakes.named_poll_fallbacks,
  unconditional_continuations: wakes.unconditional_continuations,

  simulated_hours: 8,
  simulated_wakeups: Object.values(sim.outcomes).reduce((a, b) => a + b, 0),
  would_dispatch: metrics.would_dispatch,
  fully_attributed: metrics.fully_attributed,
  scope_unknown_blocked: metrics.scope_unknown_blocked,
  authority_unknown_blocked: metrics.authority_unknown_blocked,
  owner_gate_blocked: metrics.owner_gate_blocked,
  budget_blocked: metrics.budget_blocked,

  // The five dangerous counters. Every one is produced by an attempt actually
  // made in the adversarial harness, not asserted over an empty set.
  simultaneous_lease_violations: sim.simultaneous_lease_violations,
  stale_generation_mutations_accepted: countFailures(adversarial, ["stale_generation_cannot_mutate", "stale_write_refused_by_fence"]),
  machine_gate_resolutions_accepted: countFailures(adversarial, ["machine_gate_claim_has_no_authority", "machine_ruling_cannot_transition"]),
  generic_ctn_gate_resolutions_accepted: countFailures(adversarial, ["generic_owner_ctn_resolves_nothing", "generic_owner_ctn_cannot_transition"]),
  unattributed_result_settlements: countFailures(adversarial, ["unattributed_result_cannot_settle", "wrong_intent_id_cannot_settle"]),

  adversarial_cases: adversarial.total,
  adversarial_passed: adversarial.passed,
  owner_gate_audit: shadow.owner_gate_audit,
  execution_dispatched: 0,
  continuation_messages_sent: 0,
  owner_state_mutations: 0,
};

function countFailures(result, names) {
  return result.cases.filter((c) => names.includes(c.name) && !c.pass).length;
}

// The PR C release criterion, stated as the spec states it.
const dangerous = [
  report.simultaneous_lease_violations,
  report.stale_generation_mutations_accepted,
  report.machine_gate_resolutions_accepted,
  report.generic_ctn_gate_resolutions_accepted,
  report.unattributed_result_settlements,
];
report.all_dangerous_counters_zero = dangerous.every((n) => n === 0);
report.every_dispatch_fully_attributed = report.would_dispatch === report.fully_attributed;

// VACUITY. With zero would-dispatches, "every dispatch was fully attributed"
// is 0 === 0 — true, and evidence of nothing. Section 10 exists precisely to
// stop a zero being read as a clean bill of health, so the vacuity is stated
// rather than left for a reader to notice.
report.attribution_claim_vacuous = report.would_dispatch === 0;
report.caveats = [];
if (report.attribution_claim_vacuous) {
  report.caveats.push("every_dispatch_fully_attributed is vacuously true: zero dispatches occurred");
}
if (report.scope_unknown_blocked === 0 && report.would_dispatch === 0) {
  report.caveats.push("the scope resolver was never reached: every lane was already blocked at the wake gate, so scope_unknown_blocked=0 is not evidence that scopes resolve");
}

// COUNTERFACTUAL. The run above is dominated by one blocker, which tells us
// little about what happens once it is removed. So: hold everything else
// constant and give each trunk a declared recurring goal — the honest model of
// "keep working this lane" — and see what the scope resolver then does against
// the real 22 open gates. Still zero dispatches reach anything; this is a
// second simulation, not a relaxation of the gate.
const counterfactualIntents = intents.map((intent) => (intent.kind === "trunk"
  ? { ...intent, wake: { type: "recurring_goal", next_step_budget: { max_steps: 3 }, goal_ref: intent.intent_id } }
  : intent));
const cfSim = simulate({
  intents: counterfactualIntents, openGates,
  startMs: Date.parse(START), hours: 8, tickMs: 360000,
});
const cfMetrics = attributionMetrics(cfSim);
report.counterfactual_if_lanes_declared_goals = {
  premise: "each trunk declares a recurring goal with a bounded next step; nothing else changes",
  would_dispatch: cfMetrics.would_dispatch,
  fully_attributed: cfMetrics.fully_attributed,
  unattributed_dispatches: cfMetrics.unattributed_dispatches,
  scope_unknown_blocked: cfMetrics.scope_unknown_blocked,
  owner_gate_blocked: cfMetrics.owner_gate_blocked,
  // The real question this answers: would the topic-provenance layer actually
  // hold, or would it wave everything through?
  attribution_claim_vacuous: cfMetrics.would_dispatch === 0,
};
report.execution_release_criterion_met =
  report.all_dangerous_counters_zero
  && report.every_dispatch_fully_attributed
  && report.unconditional_continuations === 0;

report.execution_release_criterion_met = report.execution_release_criterion_met && !report.attribution_claim_vacuous;

report.blocking_reason = report.execution_release_criterion_met ? null
  : report.unconditional_continuations > 0
    ? `${report.unconditional_continuations} lane(s) still wake unconditionally, so no dispatch can declare why it woke`
    : "a dangerous counter is non-zero";

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "release-report.json"), JSON.stringify({ report, sim_outcomes: sim.outcomes, wake_detail: wakes.detail }, null, 2));

console.log(JSON.stringify(report, null, 2));

// Exit 0: a blocked release is the correct, informative outcome of this run,
// not a failure of the run.
process.exit(0);
