import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES, NEVER_AUTONOMOUS, authorCanary, authorize, composeEnvelope,
  createAuthorityDraft, createAuthorityLedger, createPauseState, renderPreview,
  resolveScopeSelection, suggestFromEvidence,
} from "../src/continuity/control/authority-draft.js";
import { describeScope } from "../src/continuity/control/authority-draft.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";
import { verifyGoalAuthority } from "../src/continuity/control/goal.js";
import { admitWorkDeclaration } from "../src/continuity/control/declaration.js";

const F = fixtureStates();
const AT = "2026-08-22T09:00:00+10:00";

// ---- §5: deny-by-default composition -----------------------------------------

test("V6.1.4: an unselected capability is owner-required, not merely absent", () => {
  const envelope = composeEnvelope(["run_tests"]);
  assert.ok(envelope.allowed_capabilities.includes("run_tests"));
  assert.ok(envelope.owner_required_capabilities.includes("prepare_patch"),
    "ticking one box must not imply a neighbouring one");
  assert.ok(envelope.owner_required_capabilities.includes("spend_money"));
});

test("V6.1.4: the never-autonomous capabilities cannot be granted here at all", () => {
  const envelope = composeEnvelope(NEVER_AUTONOMOUS);
  for (const name of NEVER_AUTONOMOUS) {
    for (const op of CAPABILITIES[name].operations) {
      assert.equal(envelope.allowed_capabilities.includes(op), false, `${op} must never be autonomous`);
      assert.ok(envelope.owner_required_capabilities.includes(op));
    }
  }
  // And authorizing a draft that selects one is refused outright.
  const draft = createAuthorityDraft({
    draft_id: "d", statement: "Do the important work", scope_refs: ["repo:x"],
    allowed_capabilities: ["run_tests", "spend_money"],
  });
  const result = authorize(draft, { actor: "owner", action: "authorize_goal", at: AT });
  assert.equal(result.ok, false);
  assert.match(result.reason, /may not be granted autonomously/);
});

test("V6.1.4: an unknown capability is refused, never silently ignored", () => {
  const envelope = composeEnvelope(["run_tests", "deploy_everything"]);
  assert.deepEqual(envelope.unknown_capabilities, ["deploy_everything"]);
  assert.ok(envelope.prohibited_capabilities.includes("deploy_everything"));
});

// ---- §3: suggestions are copy-into-draft, never pre-authorized ---------------

test("V6.1.4: a suggestion carries no authority and prechecks nothing", () => {
  const suggestions = suggestFromEvidence([
    { authored_by: "owner", ref: "brief-1", text: "Continue improving Continuity." },
    { authored_by: "agent", ref: "agent-1", text: "I think we should publish." },
  ]);
  assert.equal(suggestions.length, 1, "only owner-authored evidence may seed a suggestion");
  assert.equal(suggestions[0].pre_authorized, false);
  assert.deepEqual(suggestions[0].capabilities_prechecked, [],
    "historical behaviour must never precheck a permission");
  assert.equal(suggestions[0].source_ref, "brief-1");
});

// ---- §7: scope resolution ----------------------------------------------------

test("V6.1.4: an unresolvable scope needs clarification, not a broad default", () => {
  const good = resolveScopeSelection("DataScape / Continuity", SCOPE_CATALOGUE);
  assert.equal(good.resolved, true);
  assert.deepEqual(good.scope_refs, ["repo:in-c0/datascape", "semantic-centre:continuity"]);

  const missing = resolveScopeSelection("everything", SCOPE_CATALOGUE);
  assert.equal(missing.resolved, false);
  assert.equal(missing.outcome, "needs_clarification");
  assert.equal(missing.scope_refs, undefined, "no scope may be manufactured to make the form submittable");
});

// ---- §8: the deterministic preview -------------------------------------------

test("V6.1.4: the preview is derived from the policy and is identical every time", () => {
  const draft = F.F3_authorized_goal.draft;
  const envelope = composeEnvelope(draft.allowed_capabilities);
  const a = renderPreview(draft, envelope);
  const b = renderPreview(draft, envelope);
  assert.deepEqual(a, b, "a preview the owner authorizes cannot vary between renders");
  assert.equal(a.deterministic, true);
  assert.ok(a.may_autonomously.includes("Run local tests"));
  assert.ok(a.must_stop_and_ask.includes("Spend money"));
  assert.ok(a.must_stop_and_ask.includes("Use credentials"));
  assert.equal(a.max_cost, 0);
  assert.equal(a.max_iteration_minutes, 15);
});

// ---- §9: save is the authority event -----------------------------------------

test("V6.1.4: only an explicit owner authorization creates a ruling", () => {
  const draft = F.F2_draft_goal.draft;
  assert.equal(draft.state, "draft");
  assert.equal(draft.grants_authority, false, "a draft grants nothing");

  for (const attempt of [
    { actor: "agent", action: "authorize_goal" },
    { actor: "system", action: "authorize_goal" },
    { actor: "owner", action: "ctn" },
    { actor: "owner", action: "open_form" },
    { actor: "owner", action: "edit_draft" },
  ]) {
    assert.equal(authorize(draft, { ...attempt, at: AT }).ok, false, JSON.stringify(attempt));
  }

  // The positive control.
  const authorized = authorize(draft, { actor: "owner", action: "authorize_goal", at: AT });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.ruling.kind, "owner_authored_objective");
  assert.deepEqual(authorized.goal.authority_source_refs, [authorized.ruling.ref]);
});

test("V6.1.4: an authorized goal is what the V6.1.3 verifier accepts", () => {
  const { goal, ruling } = authorize(F.F3_authorized_goal.draft, { actor: "owner", action: "authorize_goal", at: AT });
  const verified = verifyGoalAuthority(goal, [{ ref: ruling.ref, kind: ruling.kind }]);
  assert.equal(verified.authority, "found", "the surface must produce authority the existing verifier recognises");
  assert.equal(verified.envelope, "complete");

  // F1 is the real state: no ruling, so no authority.
  assert.equal(F.F1_no_authority.authorized, null);
  assert.equal(verifyGoalAuthority(goal, []).authority, "absent");
});

// ---- §10: revision, narrowing, revocation ------------------------------------

test("V6.1.4: a running lease never becomes a grandfathered authority token", () => {
  const ledger = createAuthorityLedger();
  const { goal, ruling } = authorize(F.F6_narrowed.draft, { actor: "owner", action: "authorize_goal", at: AT });
  ledger.record(goal.goal_id, ruling, goal);

  const inScope = ["repo:in-c0/datascape"];
  assert.equal(ledger.checkRunningLease(goal.goal_id, inScope).within, true);

  ledger.narrow(goal.goal_id, { scope_refs: ["semantic-centre:continuity"] }, { at: AT });
  const rechecked = ledger.checkRunningLease(goal.goal_id, inScope);
  assert.equal(rechecked.within, false);
  assert.equal(rechecked.action, "stop_and_checkpoint");

  ledger.revoke(goal.goal_id, { at: AT });
  assert.equal(ledger.checkRunningLease(goal.goal_id, ["semantic-centre:continuity"]).action, "stop_and_checkpoint");
  assert.equal(ledger.current(goal.goal_id).state, "revoked");
  assert.equal(ledger.history(goal.goal_id).length, 3, "authority is revisioned, not overwritten");
});

test("V6.1.4: a revoked goal admits no new work", () => {
  const ledger = createAuthorityLedger();
  const { goal, ruling } = authorize(F.F7_revoked.draft, { actor: "owner", action: "authorize_goal", at: AT });
  ledger.record(goal.goal_id, ruling, goal);
  ledger.revoke(goal.goal_id, { at: AT });

  const revoked = ledger.current(goal.goal_id).goal;
  const declaration = {
    declaration_id: "d", goal_id: goal.goal_id, authored_by: "agent", operation: "run_tests",
    success_condition: "the regression suite is green", scope_refs: ["semantic-centre:continuity"],
    scope_provenance_refs: ["ev-1"], semantic_centre_refs: ["semantic-centre:continuity"],
    dependency_refs: [], authority_requirements: [], estimated_budget: { max_cost: 0 },
    proposed_policy: { kind: "finite", completion_condition: "green" },
  };
  const result = admitWorkDeclaration(declaration, revoked, { goalAuthority: { authority: "found" } });
  assert.equal(result.admitted, false, "revoked authority must not admit new work");
});

// ---- §11: pause --------------------------------------------------------------

test("V6.1.4: pause stops new dispatches and is not an incident", () => {
  const pause = createPauseState();
  assert.equal(pause.mayDispatch("g1").allowed, true);

  pause.pause("g1");
  assert.equal(pause.mayDispatch("g1").allowed, false);
  assert.equal(pause.mayDispatch("g2").allowed, true, "per-goal pause is not global");

  pause.pauseAll();
  assert.equal(pause.mayDispatch("g2").allowed, false);
  pause.resumeAll();
  pause.resume("g1");
  assert.equal(pause.mayDispatch("g1").allowed, true);

  assert.deepEqual(pause.effects(), { deletes_history: false, resolves_exceptions: false, creates_failures: false });
});

// ---- §12: the bounded canary path --------------------------------------------

test("V6.1.4: owner authorship is not a bypass of admission", () => {
  const authored = authorCanary(F.F5_authorized_canary.draft, { actor: "owner", at: AT });
  assert.equal(authored.ok, true);
  assert.equal(authored.bypasses_admission, false);
  assert.equal(authored.declaration.authored_by, "owner");

  // It still goes through the same deterministic admission.
  const admitted = admitWorkDeclaration(authored.declaration, authored.goal, {
    goalAuthority: verifyGoalAuthority(authored.goal, [{ ref: authored.ruling.ref, kind: authored.ruling.kind }]),
  });
  assert.equal(admitted.outcome, "admitted");

  // And a malformed owner-authored task is still rejected.
  const vague = authorCanary({ ...F.F5_authorized_canary.draft, success_condition: "done" }, { actor: "owner", at: AT });
  assert.equal(vague.ok, false);
  assert.match(vague.reason, /testable success condition/);

  // An agent cannot author a canary at all.
  assert.equal(authorCanary(F.F5_authorized_canary.draft, { actor: "agent", at: AT }).ok, false);
});

// ---- §13: the fixture --------------------------------------------------------

test("V6.1.4: F1 is the real state and no fixture grants real authority", () => {
  assert.equal(F.F1_no_authority.real, true);
  assert.equal(F.F1_no_authority.authorized, null);
  for (const state of Object.values(F)) {
    if (!state.draft) continue;
    assert.equal(state.draft.grants_authority, false,
      `${state.key} must not grant authority merely by existing`);
  }
  assert.equal(Object.keys(F).length, 7, "F1 through F7");
});

// ---- §8 regression: the preview must not widen the displayed scope ----------

test("V6.1.4: the preview renders every operative scope constraint, never just the first", () => {
  // The defect the visual review caught: a draft scoped to Continuity INSIDE
  // the datascape repo rendered its boundary as "anything outside
  // in-c0/datascape" — telling the owner she was granting repo-wide authority
  // at the exact moment she is supposed to understand what she is granting.
  const refs = ["repo:in-c0/datascape", "semantic-centre:continuity"];
  const draft = createAuthorityDraft({
    draft_id: "scope", statement: "Keep Continuity green", scope_refs: refs,
    allowed_capabilities: ["run_tests"],
  });
  const preview = renderPreview(draft, composeEnvelope(draft.allowed_capabilities));

  assert.equal(preview.scope_boundary, "datascape / Continuity",
    "with no catalogue label, the boundary is derived from every ref");

  // With the catalogue's own label, the owner sees the name she typed.
  const labelled = renderPreview(
    createAuthorityDraft({ ...draft, scope_label: "DataScape / Continuity" }),
    composeEnvelope(draft.allowed_capabilities),
  );
  assert.equal(labelled.scope_boundary, "DataScape / Continuity");
  assert.ok(/Continuity/.test(preview.scope_boundary),
    "the narrowing constraint must survive into the rendered boundary");

  // Negative control: the boundary may NEVER read as repo-only when a narrower
  // constraint is present.
  assert.notEqual(preview.scope_boundary, "datascape");
  assert.notEqual(preview.scope_boundary, "in-c0/datascape");

  // Repo-only input still renders repo-only — the rule is fidelity, not
  // always appending something.
  const repoOnly = renderPreview(
    createAuthorityDraft({ draft_id: "r", statement: "s", scope_refs: ["repo:in-c0/datascape"], allowed_capabilities: ["run_tests"] }),
    composeEnvelope(["run_tests"]),
  );
  assert.equal(repoOnly.scope_boundary, "datascape");

  // And it is deterministic and order-independent.
  assert.equal(describeScope([...refs].reverse()), describeScope(refs));
  assert.equal(describeScope([]), null);
});
