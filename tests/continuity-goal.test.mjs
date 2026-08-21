import test from "node:test";
import assert from "node:assert/strict";
import {
  auditLaneGoal, createAutonomyPolicy, createGoal, envelopeCompleteness,
  operationWithinEnvelope, scopeWithinGoal, verifyGoalAuthority,
} from "../src/continuity/control/goal.js";
import {
  admitWorkDeclaration, createProposalStore, createWorkDeclaration, proposalCapabilities,
} from "../src/continuity/control/declaration.js";
import { runAdversarial } from "../src/continuity/control/adversarial.js";

const POLICY = createAutonomyPolicy({
  autonomous_operations: ["run_tests", "inspect_repository", "prepare_patch"],
  owner_required_operations: ["spend_money", "supply_credential", "approve_external_post"],
});
const GOAL = createGoal({
  goal_id: "G1",
  statement: "Improve DataScape Continuity reliability",
  authority_source_refs: ["owner-objective-1"],
  allowed_scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity"],
  prohibited_scope_refs: ["publication"],
  autonomy_policy: POLICY,
});
const SOURCES = [{ ref: "owner-objective-1", kind: "owner_authored_objective" }];
const AUTH = verifyGoalAuthority(GOAL, SOURCES);

const declare = (over = {}) => createWorkDeclaration({
  declaration_id: "D1", goal_id: "G1", authored_by: "agent",
  operation: "run_tests", success_condition: "the control-plane regression suite is green",
  scope_refs: ["repo:in-c0/datascape"], scope_provenance_refs: ["checkpoint-9"],
  semantic_centre_refs: ["semantic-centre:continuity"],
  estimated_budget: { max_cost: 0, max_wall_time_ms: 600000 },
  ...over,
});

// ---- §1: goal authority ------------------------------------------------------

test("V6.1.3: machine behaviour is never goal authority", () => {
  assert.equal(AUTH.authority, "found");

  for (const kind of ["repeated_agent_activity", "timer_exists", "auto_run_url_exists", "agent_believes_useful", "old_session_discussed_it"]) {
    const goal = createGoal({ goal_id: "Gx", statement: "s", authority_source_refs: ["r"], allowed_scope_refs: ["x"], autonomy_policy: POLICY });
    const verified = verifyGoalAuthority(goal, [{ ref: "r", kind }]);
    assert.equal(verified.authority, "absent", `${kind} must not establish a goal`);
    assert.match(verified.rejected[0].reason, /not authority|unrecognised/);
  }

  // An unresolvable reference is rejected too — a citation to nothing is not a
  // citation.
  assert.equal(verifyGoalAuthority(GOAL, []).authority, "absent");
});

test("V6.1.3: a direction without a boundary is only partial authority", () => {
  const vague = createGoal({
    goal_id: "G2", statement: "Work on Cat Intent",
    authority_source_refs: ["owner-objective-1"],
  });
  const verified = verifyGoalAuthority(vague, SOURCES);
  assert.equal(verified.authority, "partial",
    "a persistent direction is not automatically an autonomy grant");
  assert.equal(envelopeCompleteness(vague), "unknown");
  assert.equal(envelopeCompleteness(GOAL), "complete");
});

// ---- §2, §6: the envelope ----------------------------------------------------

test("V6.1.3: an operation the envelope does not name is not authorised by silence", () => {
  assert.equal(operationWithinEnvelope(GOAL, "run_tests").within, true);
  assert.equal(operationWithinEnvelope(GOAL, "spend_money").authority, "owner_required");

  const unnamed = operationWithinEnvelope(GOAL, "rotate_dns");
  assert.equal(unnamed.within, false);
  assert.equal(unnamed.authority, "unknown");
});

test("V6.1.3: prose mentioning the project does not create scope", () => {
  assert.equal(scopeWithinGoal(GOAL, ["repo:in-c0/datascape"]).within, true);
  assert.equal(scopeWithinGoal(GOAL, ["repo:in-c0/datascape", "repo:in-c0/sumzup"]).outcome, "blocked_scope");
  assert.equal(scopeWithinGoal(GOAL, ["publication"]).outcome, "blocked_scope");
  assert.equal(scopeWithinGoal(GOAL, []).outcome, "unknown", "referencing nothing is not being in scope");

  const noAllowed = createGoal({ goal_id: "G3", statement: "s", autonomy_policy: POLICY });
  assert.equal(scopeWithinGoal(noAllowed, ["anything"]).outcome, "unknown");
});

// ---- §3, §4, §5: proposal and admission --------------------------------------

test("V6.1.3: an agent may author the operation but not the goal", () => {
  // The key ruling: operational decomposition is the agent's to make.
  const admitted = admitWorkDeclaration(declare(), GOAL, { goalAuthority: AUTH });
  assert.equal(admitted.outcome, "admitted");
  assert.equal(admitted.intent.current_operation, "run_tests");
  assert.equal(admitted.intent.authority, "autonomous");
  assert.equal(admitted.intent.goal_id, "G1");

  // But the goal underneath it must be authoritative.
  const invented = createGoal({
    goal_id: "G-invented", statement: "Grow the audience", authority_source_refs: ["thought"],
    allowed_scope_refs: ["anything"], autonomy_policy: POLICY,
  });
  const inventedAuth = verifyGoalAuthority(invented, [{ ref: "thought", kind: "agent_believes_useful" }]);
  assert.equal(admitWorkDeclaration(declare({ goal_id: "G-invented" }), invented, { goalAuthority: inventedAuth }).outcome,
    "blocked_authority");
});

test("V6.1.3: admission is deterministic and every refusal names its reason", () => {
  const cases = [
    [declare({ operation: null }), "invalid"],
    [declare({ success_condition: "ok" }), "invalid"],
    [declare({ scope_provenance_refs: [] }), "invalid"],
    [declare({ scope_refs: ["repo:in-c0/sumzup"] }), "blocked_scope"],
    [declare({ operation: "supply_credential" }), "blocked_owner"],
    [declare({ operation: "rotate_dns" }), "blocked_authority"],
    [declare({ authority_requirements: ["owner_credential"] }), "blocked_owner"],
    [declare({ estimated_budget: { max_cost: 5 } }), "blocked_authority"],
    [declare({ dependency_refs: ["pr-99"] }), "blocked_dependency"],
  ];
  for (const [declaration, expected] of cases) {
    const result = admitWorkDeclaration(declaration, GOAL, { goalAuthority: AUTH });
    assert.equal(result.outcome, expected, `${declaration.operation}/${declaration.success_condition}`);
    assert.equal(result.admitted, false);
    assert.ok(result.reason, "a refusal must say why");
  }

  // An intersecting owner gate blocks; the same declaration with the gate
  // resolved is admitted, so the block is about the gate and nothing else.
  const gate = { id: "G-gate", loop: "continuity/repo:in-c0/datascape", topic: "repo:in-c0/datascape", scope_completeness: "complete" };
  assert.equal(admitWorkDeclaration(declare(), GOAL, { goalAuthority: AUTH, openGates: [gate] }).outcome, "blocked_owner");
  assert.equal(admitWorkDeclaration(declare(), GOAL, { goalAuthority: AUTH, openGates: [] }).outcome, "admitted");
});

test("V6.1.3: a recurring declaration must still declare what would stop it", () => {
  const bare = declare({ proposed_policy: { kind: "recurring" } });
  assert.equal(admitWorkDeclaration(bare, GOAL, { goalAuthority: AUTH }).outcome, "invalid");

  const complete = declare({
    proposed_policy: {
      kind: "recurring", recurring_goal: "verification sweep", iteration_budget: 10,
      next_eligibility_policy: { min_interval_ms: 21600000 }, stop_conditions: ["deployment stable"],
    },
  });
  assert.equal(admitWorkDeclaration(complete, GOAL, { goalAuthority: AUTH }).outcome, "admitted");
});

// ---- §7, §8, §12: the proposal substrate -------------------------------------

test("V6.1.3: proposing work grants nothing and records no history", () => {
  const store = createProposalStore();
  const result = store.proposeWork(declare());
  assert.equal(result.dispatched, false);
  assert.equal(result.intent_created, false);
  assert.equal(store.emitsSemanticHistory, false,
    "an agent reconsidering three times must not produce three semantic events");

  const caps = proposalCapabilities(store);
  assert.equal(caps.can_propose, true);
  assert.equal(caps.can_admit, false);
  assert.equal(caps.can_dispatch, false);
  assert.equal(caps.can_execute, false);
});

test("V6.1.3: a declaration may be superseded before execution", () => {
  const store = createProposalStore();
  store.proposeWork(declare({ declaration_id: "D-old", operation: "inspect_repository" }));
  store.proposeWork(declare({ declaration_id: "D-new", supersedes_declaration_id: "D-old" }));

  assert.equal(store.get("D-old").state, "superseded");
  assert.equal(store.active().length, 1, "supersession must not leave two live proposals");

  // Expiry is also a non-event: a lapsed proposal produces no revision.
  const store2 = createProposalStore();
  store2.proposeWork(declare({ declaration_id: "D-exp", expires_at: "2026-08-21T10:00:00+10:00" }));
  assert.deepEqual(store2.expire(Date.parse("2026-08-21T11:00:00+10:00")), ["D-exp"]);
  assert.equal(store2.active().length, 0);
});

// ---- §10: the lane audit -----------------------------------------------------

test("V6.1.3: no goal is inferred from repetition, and absent never reads as safe", () => {
  const audit = auditLaneGoal({ lane: "datascape", autoRunUrl: "https://chatgpt.com/c/abc" }, SOURCES);
  assert.equal(audit.authoritative_goal, "absent");
  assert.match(audit.reason, /repeated continuation is not a goal/);
  assert.equal(JSON.stringify(audit).includes("safe"), false);

  // A lane that DOES declare an authoritative goal audits as found.
  const declared = auditLaneGoal({ lane: "x", goal: GOAL }, SOURCES);
  assert.equal(declared.authoritative_goal, "found");
  assert.deepEqual(declared.authority_source_refs, ["owner-objective-1"]);
});

// ---- §13: the adversarial suite ----------------------------------------------

test("V6.1.3: the adversarial suite covers goal authority and admission", () => {
  const result = runAdversarial();
  assert.equal(result.all_passed, true, JSON.stringify(result.failed));
  assert.ok(result.total >= 42);
  // The positive control for the whole layer.
  assert.ok(result.cases.some((c) => c.name === "authoritative_goal_admits_bounded_work" && c.pass),
    "admission must be reachable, or every refusal above proves nothing");
});
