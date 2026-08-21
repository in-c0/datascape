// v6.1.3:audit — the real five-lane goal-authority and work-declaration audit
// (spec V6.1.3 §10, §11, §14, §15, §16).
//
// Order matters and is enforced here: look for an AUTHORITATIVE GOAL first, and
// only then look for a current work declaration under it. Reversing that order
// is how a plausible-looking operation acquires a goal retroactively.
//
// Two inferences are refused outright, because the spec names them and because
// this project has already made the equivalent mistake once with timers:
//
//   - a goal is never inferred from repeated `ctn`
//   - a vague product description is never translated into a specific
//     autonomy grant
//
// Where evidence is merely absent, the output says `absent`. It never says
// "safe".
import fs from "node:fs";
import path from "node:path";
import { auditLaneGoal, createGoal, verifyGoalAuthority } from "../src/continuity/control/goal.js";
import { admitWorkDeclaration, createProposalStore, createWorkDeclaration } from "../src/continuity/control/declaration.js";
import { createGateScope, topicOf } from "../src/continuity/control/scope.js";
import { attributionMetrics, exercisedCategories, releaseCriterion, simulate } from "../src/continuity/control/simulate.js";
import { runAdversarial } from "../src/continuity/control/adversarial.js";

const HUB = process.env.HUB_DIR || "D:/Projects/_hub";
const SHIP = process.env.SHIP_INBOX || "D:/Projects/_ship_inbox";
const OUT = process.env.SHADOW_OUT_DIR || path.join(HUB, "shadow", "continuity", "v6.1.3");
const START = process.env.SIM_START || "2026-08-21T22:00:00+10:00";

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

// --- lanes ---------------------------------------------------------------------
const laneRecords = readJson(path.join(SHIP, "mustreads", "lanes.json"), {});
const lanes = Object.values(laneRecords).map((lane) => ({ ...lane, status: lane.stoppedAt ? "done" : "active" }));

// --- authority sources ---------------------------------------------------------
//
// A lane record carries a label, an Auto Run URL, a registration timestamp and
// sometimes a free-text note. None of those is an owner-authored objective with
// a declared autonomy envelope. `goal_sources.json` is the file that WOULD carry
// them; it does not exist, and it is not created here — fabricating the input
// to an audit is the same failure as fabricating its output.
const declaredSources = readJson(path.join(HUB, "ops", "goal-sources.json"), []);

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
const openGates = exceptions
  .filter((e) => e.status === "blocked-on-owner")
  .map((gate) => ({ ...gate, ...createGateScope(gate) }));

// --- step 1: authoritative goals (§10) ----------------------------------------
const goalAudit = lanes.map((lane) => auditLaneGoal(lane, declaredSources));

// --- step 2: current work evidence, ONLY under a valid goal (§11) -------------
const store = createProposalStore();
const declarations = [];
const rejections = {
  no_authority: 0, no_concrete_operation: 0, scope_outside_goal: 0,
  scope_unknown: 0, owner_required: 0, invalid_success_condition: 0, dependency: 0,
};
const admitted = [];

for (const lane of lanes) {
  const audit = goalAudit.find((g) => g.lane === lane.lane);
  if (audit.authoritative_goal === "absent") {
    rejections.no_authority += 1;
    continue;
  }
  const goal = createGoal(lane.goal);
  const authority = verifyGoalAuthority(goal, declaredSources);

  // Candidate operations come from EXACT existing references only.
  const candidates = lane.work_evidence || [];
  if (candidates.length === 0) {
    rejections.no_concrete_operation += 1;
    continue;
  }
  for (const evidence of candidates) {
    const declaration = createWorkDeclaration({
      declaration_id: `decl:${lane.lane}:${evidence.key}`,
      goal_id: goal.goal_id,
      authored_by: "agent",
      operation: evidence.operation,
      success_condition: evidence.success_condition,
      scope_refs: evidence.scope_refs || [],
      scope_provenance_refs: evidence.provenance_refs || [],
      semantic_centre_refs: evidence.semantic_centre_refs || [],
      dependency_refs: evidence.dependency_refs || [],
      authority_requirements: evidence.authority_requirements || [],
      estimated_budget: evidence.estimated_budget || { max_cost: 0, max_wall_time_ms: 600000 },
      created_at: evidence.at || null,
    });
    store.proposeWork(declaration);
    declarations.push(declaration);

    const result = admitWorkDeclaration(declaration, goal, { openGates, goalAuthority: authority });
    if (result.admitted) {
      admitted.push({
        ...result.intent,
        wake: { type: "recurring_goal", next_step_budget: { max_steps: 3 }, goal_ref: goal.goal_id },
      });
    } else {
      const bucket = {
        blocked_authority: "no_authority", blocked_scope: "scope_outside_goal",
        unknown: "scope_unknown", blocked_owner: "owner_required",
        invalid: "invalid_success_condition", blocked_dependency: "dependency",
      }[result.outcome] || "no_authority";
      rejections[bucket] += 1;
    }
  }
}

// --- step 3: simulate only if something was actually admitted (§17) ------------
const adversarial = runAdversarial();
const countFailures = (names) => adversarial.cases.filter((c) => names.includes(c.name) && !c.pass).length;
const dangerous = {
  simultaneous_lease_violations: 0,
  stale_generation_mutations_accepted: countFailures(["stale_generation_cannot_mutate", "stale_write_refused_by_fence"]),
  machine_gate_resolutions_accepted: countFailures(["machine_gate_claim_has_no_authority", "machine_ruling_cannot_transition"]),
  generic_ctn_gate_resolutions_accepted: countFailures(["generic_owner_ctn_resolves_nothing", "generic_owner_ctn_cannot_transition"]),
  unattributed_result_settlements: countFailures(["unattributed_result_cannot_settle", "wrong_intent_id_cannot_settle"]),
  scope_expansion_violations_accepted: countFailures(["scope_expansion_is_refused", "scope_expansion_requires_new_dispatch"]),
};

let metrics = { would_dispatch: 0, fully_attributed: 0, scope_unknown_dispatches: 0, authority_unknown_dispatches: 0 };
let exercised = { dispatch_beside_unrelated_gate: false, owner_gate_block: false, unknown_scope_block: false };
if (admitted.length > 0) {
  const sim = simulate({ intents: admitted, openGates, startMs: Date.parse(START), hours: 8, tickMs: 360000 });
  metrics = attributionMetrics(sim);
  dangerous.simultaneous_lease_violations = sim.simultaneous_lease_violations;
  exercised = exercisedCategories(sim);
}
const criterion = releaseCriterion(metrics, dangerous, exercised);

const report = {
  real_lanes: lanes.length,

  authoritative_goals: {
    complete: goalAudit.filter((g) => g.authoritative_goal === "found").length,
    partial: goalAudit.filter((g) => g.authoritative_goal === "partial").length,
    absent: goalAudit.filter((g) => g.authoritative_goal === "absent").length,
  },
  goal_autonomy_envelopes: {
    complete: goalAudit.filter((g) => g.envelope === "complete").length,
    partial: goalAudit.filter((g) => g.envelope === "partial").length,
    unknown: goalAudit.filter((g) => g.envelope === "unknown").length,
  },

  source_grounded_work_declarations: declarations.length,
  admitted_executable_intents: admitted.length,
  rejected: rejections,

  real_would_dispatch: metrics.would_dispatch,
  fully_attributed: metrics.fully_attributed,
  ...dangerous,

  adversarial_cases: adversarial.total,
  adversarial_passed: adversarial.passed,
  execution_release_criterion_met: criterion.met,
  blocking_reasons: criterion.reasons,

  // Section 15: if this is zero, STOP. The architecture is no longer the
  // blocker — the blocker is that no real source establishes an owner-authorized
  // autonomous goal plus a concrete current work declaration. That is a
  // governance and input problem, not a modelling one, and building a seventh
  // abstraction would not touch it.
  stop_condition_reached: admitted.length === 0,
  owner_escalation_required: admitted.length === 0,

  lanes: goalAudit,
  execution_dispatched: 0,
  continuation_messages_sent: 0,
  owner_state_mutations: 0,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "goal-audit.json"), JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
process.exit(0);
