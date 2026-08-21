import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_GATED_STATE, createIntent, transition } from "../src/continuity/control/intent.js";
import { classifyOperation, interpretCtn, mayPerform } from "../src/continuity/control/authority.js";
import { createLeaseManager } from "../src/continuity/control/lease.js";
import { containsTranscript, createCheckpoint, reconstructable, validateCheckpoint } from "../src/continuity/control/checkpoint.js";
import { createDependency, createDependencyGraph } from "../src/continuity/control/dependency.js";
import { createBudgetLedger, schedule } from "../src/continuity/control/scheduler.js";
import { createOperationLedger } from "../src/continuity/control/idempotency.js";
import { bridge, coarseProjection, toEvent } from "../src/continuity/control/bridge.js";
import { EXECUTORS, createClock, fixtureIntents } from "../src/continuity/control/fixture.js";

const OWNER_RULING = { source: "owner", gate_id: "gate-post-approval", ruling: "approved" };

// ---- §3: one active lease per intent -----------------------------------------

test("V6: two executors cannot hold the same intent at once", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const first = leases.claim("I1", "E1");
  assert.equal(first.ok, true);

  const second = leases.claim("I1", "E2");
  assert.equal(second.ok, false, "the second executor must lose deterministically");
  assert.equal(second.holder, "E1");

  // Observation is always permitted; mutation is not.
  assert.equal(leases.mayMutate("I1", "E2").allowed, false);
  assert.equal(leases.mayMutate("I1", "E1").allowed, true);
});

test("V6: an expired lease permits recovery and is not a failure", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const held = leases.claim("I6", "E1", { ttlMs: 1000 });
  assert.equal(held.ok, true);

  clock.advance(1001);
  const expired = leases.expired();
  assert.deepEqual(expired.map((e) => e.intent_id), ["I6"]);

  const recovered = leases.claim("I6", "E3");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.lease.attempt, 2, "recovery is a later attempt at the same work");

  // The disappearance itself produces no semantic history.
  const { events, ephemeral } = bridge([
    { type: "lease_expired", intent_id: "I6", at: "2026-08-21T09:30:00+10:00", text: "lease expired" },
  ]);
  assert.equal(events.length, 0);
  assert.equal(ephemeral.length, 1);
});

test("V6: a heartbeat extends the lease and creates no history", () => {
  const clock = createClock();
  const leases = createLeaseManager(clock);
  const { lease } = leases.claim("I2", "E1", { ttlMs: 1000 });
  clock.advance(900);
  const beat = leases.heartbeat(lease.lease_id);
  assert.equal(beat.ok, true);
  assert.equal(beat.emits_history, false);
  clock.advance(900);
  assert.deepEqual(leases.expired(), [], "the heartbeat kept it alive");

  assert.equal(bridge([{ type: "lease_heartbeat", intent_id: "I2", at: "2026-08-21T09:30:00+10:00", text: "alive" }]).events.length, 0);
});

// ---- §7, §8: the owner authority firewall ------------------------------------

test("V6: a machine continuation cannot move work out of blocked_on_owner", () => {
  const intent = fixtureIntents().find((i) => i.intent_id === "I3");
  assert.equal(intent.state, OWNER_GATED_STATE);

  const machine = interpretCtn({ source: "agent" });
  assert.equal(machine.authority, "none");
  assert.equal(machine.resolves_gate, null);

  const refused = transition(intent, "ready", { ruling: { source: "agent", gate_id: "gate-post-approval", ruling: "approved" } });
  assert.equal(refused.ok, false, "an agent-sourced ruling is not an owner ruling");
  assert.match(refused.reason, /only the owner/);

  // And with no ruling at all.
  assert.equal(transition(intent, "ready").ok, false);
});

test("V6: a generic owner ctn does not resolve a specific owner gate", () => {
  const intent = fixtureIntents().find((i) => i.intent_id === "I3");
  const generic = interpretCtn({ source: "owner" });
  assert.equal(generic.authority, "owner_continuation");
  assert.equal(generic.resolves_gate, null, "generic continuation is not a wildcard approval token");

  assert.equal(transition(intent, "ready", { ruling: { source: "owner", ruling: "ctn" } }).ok, false);

  // A ruling on a DIFFERENT gate does not release this one either.
  const other = transition(intent, "ready", { ruling: { source: "owner", gate_id: "gate-spend", ruling: "approved" } });
  assert.equal(other.ok, false);
  assert.match(other.reason, /does not gate this intent/);
});

test("V6: a matching owner ruling does release the gate", () => {
  const intent = fixtureIntents().find((i) => i.intent_id === "I3");
  const released = transition(intent, "ready", { ruling: OWNER_RULING });
  assert.equal(released.ok, true, "the positive control must pass, or the gate proves nothing");
  assert.equal(released.intent.state, "ready");
  assert.deepEqual(released.intent.owner_gate_ids, [], "the resolved gate leaves the list");

  const ctn = interpretCtn({ source: "owner", gate_id: "gate-post-approval", ruling: "approved" });
  assert.equal(ctn.resolves_gate, "gate-post-approval");
});

test("V6: unknown authority defaults to blocked, and identity is not authority", () => {
  assert.equal(classifyOperation("run_tests").authority, "autonomous");
  assert.equal(classifyOperation("spend_money").authority, "owner_required");

  const unknown = classifyOperation("rotate_dns");
  assert.equal(unknown.authority, "owner_required");
  assert.equal(unknown.known, false);

  // No executor argument exists at all: trust cannot be an input.
  assert.equal(mayPerform("spend_money").allowed, false);
  assert.equal(mayPerform("spend_money", { grants: [{ operation: "spend_money", source: "agent", gate_id: "g", ruling: "yes" }] }).allowed,
    false, "an agent-issued grant is not a grant");
  assert.equal(mayPerform("spend_money", { grants: [{ operation: "spend_money", source: "owner", gate_id: "gate-spend", ruling: "approved" }] }).allowed,
    true);
});

// ---- §5, §6: checkpoint and handoff ------------------------------------------

const CHECKPOINT = {
  intent_id: "I6", lease_id: "lease-1", semantic_centre: "Infrastructure",
  current_operation: "run_tests", last_settled_event_ids: ["ev-1"], working_state_ref: "wt-1",
  produced_event_ids: ["ev-2"], unresolved_questions: [], dependency_refs: ["dep-1"],
  owner_gate_ids: [], next_safe_action: "rerun the browser verification against head 4ab9c1",
};

test("V6: a checkpoint carries no transcript and no hidden reasoning", () => {
  const checkpoint = createCheckpoint(CHECKPOINT);
  assert.equal(validateCheckpoint(checkpoint).ok, true);
  assert.equal(containsTranscript(checkpoint), false);

  assert.throws(() => createCheckpoint({ ...CHECKPOINT, transcript: "..." }), /may not carry transcript/);
  assert.throws(() => createCheckpoint({ ...CHECKPOINT, chain_of_thought: "..." }), /chain_of_thought/);

  // Negative control: the detector must catch a transcript smuggled as data.
  assert.equal(containsTranscript({ ...checkpoint, working_state_ref: JSON.stringify([{ role: "user", content: "hi" }]) }), true);

  // And prose in next_safe_action is refused.
  const prose = createCheckpoint({ ...CHECKPOINT, next_safe_action: "x".repeat(300) });
  assert.equal(validateCheckpoint(prose).ok, false);
});

test("V6: executor B can reconstruct without the old transcript", () => {
  const checkpoint = createCheckpoint(CHECKPOINT);
  const intent = fixtureIntents().find((i) => i.intent_id === "I6");
  const known = new Set(["ev-1", "ev-2", "dep-1"]);
  const result = reconstructable(checkpoint, intent, (ref) => known.has(ref));
  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved_refs, []);
  assert.equal(result.answers.goal, intent.goal);
  assert.equal(result.answers.next_safe_action, CHECKPOINT.next_safe_action);

  // Negative control: a dangling reference must fail reconstruction.
  const dangling = reconstructable(checkpoint, intent, (ref) => ref !== "dep-1");
  assert.equal(dangling.ok, false);
  assert.deepEqual(dangling.unresolved_refs, ["dep-1"]);
});

// ---- §9: dependency wakeups --------------------------------------------------

test("V6: a completed dependency wakes the dependent exactly once", () => {
  const graph = createDependencyGraph();
  graph.register("I5", [createDependency({ type: "upstream_intent_completed", ref: "I1" })]);

  assert.deepEqual(graph.satisfy("upstream_intent_completed", "I1"), ["I5"]);
  assert.deepEqual(graph.satisfy("upstream_intent_completed", "I1"), [], "a repeated notification must not re-fire");
  assert.deepEqual(graph.open("I5"), []);
});

test("V6: an intent with several dependencies wakes only when all are satisfied", () => {
  const graph = createDependencyGraph();
  graph.register("I4", [
    createDependency({ type: "external_artifact_exists", ref: "corpus-2026-08.json" }),
    createDependency({ type: "credential_available", ref: "cred-upstream" }),
  ]);
  assert.deepEqual(graph.satisfy("external_artifact_exists", "corpus-2026-08.json"), []);
  assert.deepEqual(graph.satisfy("credential_available", "cred-upstream"), ["I4"]);
});

test("V6: an owner gate dependency is satisfied only by a matching ruling", () => {
  const graph = createDependencyGraph();
  graph.register("I3", [createDependency({ type: "owner_gate_resolved", ref: "gate-post-approval" })]);

  assert.equal(graph.satisfyOwnerGate("gate-post-approval", { source: "agent", gate_id: "gate-post-approval", ruling: "ok" }).ok, false);
  assert.equal(graph.satisfyOwnerGate("gate-post-approval", { source: "owner", ruling: "ctn" }).ok, false);
  const good = graph.satisfyOwnerGate("gate-post-approval", OWNER_RULING);
  assert.equal(good.ok, true);
  assert.deepEqual(good.woken, ["I3"]);
});

// ---- §10, §11: deterministic scheduling and budgets --------------------------

test("V6: scheduling is deterministic and never selects owner-gated work", () => {
  const intents = fixtureIntents();
  const a = schedule(intents, { executors: EXECUTORS });
  const b = schedule(intents, { executors: EXECUTORS });
  assert.deepEqual(a.assignments, b.assignments, "the same world must produce the same plan");

  const ids = a.considered.map((c) => c.intent_id);
  assert.equal(ids.includes("I3"), false, "blocked_on_owner is not a scheduling candidate");
  assert.equal(ids.includes("I5"), false, "waiting is not ready");
  assert.equal(ids.includes("I8"), false, "completed work is not rescheduled");
  assert.equal(a.considered[0].intent_id, "I2", "materially-live continuation outranks ordinary ready work");
});

test("V6: one executor per intent, and capability gates assignment", () => {
  const intents = fixtureIntents();
  const { assignments } = schedule(intents, { executors: EXECUTORS });
  assert.equal(new Set(assignments.map((a) => a.executor_id)).size, assignments.length);
  assert.equal(new Set(assignments.map((a) => a.intent_id)).size, assignments.length);

  // I6 requires "tests", which E2 does not have.
  const only = schedule([intents.find((i) => i.intent_id === "I6")], { executors: [EXECUTORS[1]] });
  assert.deepEqual(only.assignments, []);
});

test("V6: a budget cannot be exceeded, and a zero cost budget blocks paid work", () => {
  const ledger = createBudgetLedger({ max_wall_time_ms: 1000, max_steps: 2, max_external_requests: 1, max_cost: 0 });
  assert.equal(ledger.consume({ steps: 1 }).ok, true);
  assert.equal(ledger.consume({ steps: 1 }).ok, true);

  const over = ledger.consume({ steps: 1 });
  assert.equal(over.ok, false);
  assert.equal(over.next_state, "waiting", "exhaustion parks the work, it does not continue uncontrolled");
  assert.match(over.reason, /budget_exhausted:steps/);
  assert.equal(ledger.spent().steps, 2, "a refused consumption must not be recorded as spent");

  assert.equal(ledger.consume({ cost: 0.01 }).ok, false, "max_cost 0 means paid usage blocks rather than inferring permission");
});

// ---- §12: idempotency --------------------------------------------------------

test("V6: a side effect performed before a lost lease is not repeated", () => {
  const ledger = createOperationLedger();
  const opId = "I7:open_internal_pr";

  // Executor A declares intent, performs the side effect, then dies before
  // acknowledging it.
  assert.equal(ledger.begin(opId, { executor_id: "E1", kind: "pr_creation" }).proceed, true);
  let prsCreated = 1;

  // Executor B recovers and must NOT execute again.
  const resumed = ledger.begin(opId, { executor_id: "E3", kind: "pr_creation" });
  assert.equal(resumed.proceed, false);
  assert.equal(resumed.indeterminate, true);

  // It reconciles by observing the world.
  const reconciled = ledger.reconcile(opId, () => ({ result_ref: "pr-25" }));
  assert.equal(reconciled.outcome, "already_performed");
  assert.equal(prsCreated, 1, "the side effect must have happened exactly once");
  assert.deepEqual(ledger.counts(), { pr_creation: 1 });

  // A completed operation is observed, never repeated.
  assert.equal(ledger.begin(opId, { executor_id: "E2", kind: "pr_creation" }).proceed, false);

  // Negative control: an operation that genuinely never happened stays runnable.
  const fresh = createOperationLedger();
  fresh.begin("other", { executor_id: "E1", kind: "pr_creation" });
  assert.equal(fresh.reconcile("other", () => null).outcome, "never_performed");
  assert.equal(fresh.begin("other", { executor_id: "E3", kind: "pr_creation" }).proceed, true);
  prsCreated += 1;
  assert.equal(prsCreated, 2);
});

// ---- §13, §14: the V5 bridge and the projection ------------------------------

test("V6: a material completion creates exactly one immutable event", () => {
  const mutation = {
    type: "operation_completed", intent_id: "I1", operation_id: "op-1",
    at: "2026-08-21T09:40:00+10:00", text: "Validation harness is green on master.",
  };
  // Reported twice: once by the executor that did it, once by the recovering one.
  const { events } = bridge([mutation, { ...mutation, at: "2026-08-21T09:41:00+10:00" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, mutation.text);
  assert.equal(events[0].authorship, "agent");
  assert.equal(events[0].supervision, "unattended");
});

test("V6: an execution attempt ending is not a semantic failure unless material", () => {
  const base = { type: "material_failure", intent_id: "I6", at: "2026-08-21T09:45:00+10:00", text: "Executor disappeared." };
  assert.equal(toEvent(base).event, null);
  assert.equal(toEvent({ ...base, material: true }).event !== null, true, "a genuinely material failure still records");
});

test("V6: the coarse projection speaks about work, never about leases", () => {
  const intents = fixtureIntents();
  const view = coarseProjection(intents);
  assert.ok(view.length <= 5, "the attention budget holds at every altitude");
  assert.equal(view[0].phrase, "Distribution blocked on you", "needs-you comes first");
  assert.ok(view.some((v) => v.phrase === "Research validation moving"));
  const serialized = JSON.stringify(view);
  for (const leak of ["lease", "attempt", "heartbeat", "executor"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must never surface at coarse altitude`);
  }
});

// ---- §15: the acceptance run -------------------------------------------------

test("V6 acceptance: the full deterministic run holds every invariant", async () => {
  const { runAcceptance } = await import("../src/continuity/control/acceptance.js");
  const report = runAcceptance();

  assert.equal(report.fixture_intents, 8);
  assert.equal(report.executors, 3);
  assert.equal(report.simultaneous_lease_violations, 0);
  assert.equal(report.owner_gate_bypasses, 0);
  assert.equal(report.recovered_expired_leases, 1);
  assert.equal(report.duplicate_side_effects, 0);
  assert.equal(report.dependency_wakeups, 1);
  assert.equal(report.budget_overruns, 0);
  assert.equal(report.heartbeat_created_events, 0);
  assert.equal(report.unresolved_checkpoint_refs, 0);
  assert.ok(report.immutable_events_emitted > 0, "material work must still produce history");
  assert.equal(report.all_invariants_passed, true, JSON.stringify(report.violations));
});

// ---- §16: the shadow control-plane mapping (PR B) ----------------------------

const LANES = [
  { lane: "datascape-continuity-governance", label: "DataScape / Continuity", status: "active", registeredAt: "2026-08-21T12:00:00+10:00" },
  { lane: "cat-intent", label: "Cat Intent Signals", status: "done", registeredAt: "2026-08-21T04:05:00+10:00" },
];
const EXCEPTIONS = [
  { id: "gate-a", loop: "datascape/shadow-proposer", status: "blocked-on-owner", title: "needs a credential" },
  { id: "gate-b", loop: "datascape/governance", status: "blocked-on-owner", title: "needs a ruling" },
  { id: "gate-c", loop: "sumzup/digest-budget", status: "blocked-on-owner", title: "unrelated lane" },
  { id: "gate-d", loop: "datascape/old", status: "resolved", title: "already answered" },
];

test("V6 shadow: a lane is a container of intents, not one intent", async () => {
  const { laneToIntents } = await import("../src/continuity/control/shadow-map.js");
  const intents = laneToIntents(LANES[0], EXCEPTIONS);

  const trunk = intents.find((i) => i.kind === "trunk");
  const gates = intents.filter((i) => i.kind === "owner_gate");
  assert.equal(gates.length, 2, "one intent per open gate under this lane");
  assert.deepEqual(trunk.owner_gate_ids, [],
    "one open gate must not make the whole lane forbidden — that is the mapping error V6 section 1 exists to prevent");
  assert.equal(trunk.state, "ready");
  assert.ok(gates.every((g) => g.state === "blocked_on_owner"));

  // A resolved exception is not a gate, and another lane's gate is not ours.
  const ids = gates.flatMap((g) => g.owner_gate_ids);
  assert.equal(ids.includes("gate-c"), false);
  assert.equal(ids.includes("gate-d"), false);
});

test("V6 shadow: an unanswerable question is reported as unobservable, never as a pass", async () => {
  const { buildShadowReport } = await import("../src/continuity/control/shadow-map.js");
  const observations = {
    "shadow:datascape-continuity-governance": { state: "active", continuing: true, polling: true, condition_based: false },
  };
  const report = buildShadowReport(LANES, EXCEPTIONS, observations);
  assert.equal(report.unobservable.length, 2, "each open gate raises a question the registry cannot answer");
  assert.equal(report.divergences.some((d) => d.kind === "progressed_owner_gated_work"), false,
    "no bypass may be asserted from a source that could not have shown one");

  // And when the evidence DOES exist, the bypass is reported.
  const witnessed = buildShadowReport(LANES, EXCEPTIONS, {
    ...observations,
    "shadow:datascape-continuity-governance:gate-a": { gate_topics_progressed: ["gate-a"] },
  });
  assert.equal(witnessed.divergences.some((d) => d.kind === "progressed_owner_gated_work"), true);
});

test("V6 shadow: an invented owner gate fails the audit", async () => {
  const { auditOwnerGates, buildShadowReport } = await import("../src/continuity/control/shadow-map.js");
  const report = buildShadowReport(LANES, EXCEPTIONS, {});
  assert.equal(report.owner_gate_audit.ok, true);
  assert.deepEqual(report.owner_gate_audit.invented, []);
  assert.equal(report.owner_gate_audit.unmapped_count, 1, "gate-c belongs to a lane with no continuation loop");

  // Negative control: a gate with no authoritative exception behind it.
  const fabricated = auditOwnerGates([{ owner_gate_ids: ["gate-imaginary"] }], EXCEPTIONS);
  assert.equal(fabricated.ok, false);
  assert.deepEqual(fabricated.invented, ["gate-imaginary"]);
});

test("V6 shadow: the mapping observes and never acts", async () => {
  const { buildShadowReport } = await import("../src/continuity/control/shadow-map.js");
  const report = buildShadowReport(LANES, EXCEPTIONS, {});
  assert.equal(report.executed_intents, 0);
  assert.equal(report.continuation_messages_sent, 0);
  assert.equal(report.owner_state_mutations, 0);
  const surface = await import("../src/continuity/control/shadow-map.js");
  for (const forbidden of ["send", "execute", "claim", "run", "post"]) {
    assert.equal(typeof surface[forbidden], "undefined", `${forbidden} must not exist in the shadow mapping`);
  }
});
