import test from "node:test";
import assert from "node:assert/strict";
import {
  createAuthorityStore, createOwnerBoundary, draftActivityIsEphemeral,
  policyIdentity, shadowReauditRequest,
} from "../src/continuity/control/authority-store.js";
import { createAuthorityDraft } from "../src/continuity/control/authority-draft.js";
import { fixtureStates } from "../src/continuity/control/authority-fixture.js";

const AT = Date.parse("2026-08-22T09:00:00+10:00");
const DRAFT = fixtureStates().F3_authorized_goal.draft;
const EXCEPTION_ID = "2026-08-21-datascape-v6-execution-authority-b4e2";

/** A fake owner store. No real authority is created by any test in this file. */
function harness({ authenticate, resolveOk = true } = {}) {
  const resolved = [];
  const exceptions = {
    resolve(id, meta) {
      if (!resolveOk) return { ok: false, reason: "the exception store rejected the write" };
      resolved.push({ id, ...meta });
      return { ok: true };
    },
    resolved,
  };
  const boundary = createOwnerBoundary({
    authenticate: authenticate ?? ((creds) => (creds === "valid-owner-session" ? { role: "owner", id: "ava" } : null)),
  });
  return { store: createAuthorityStore({ boundary, exceptions, now: () => AT }), exceptions };
}

const request = (over = {}) => ({
  operation_id: "op-1",
  action: "authorize_goal",
  credentials: "valid-owner-session",
  draft: DRAFT,
  policy_identity: policyIdentity(DRAFT),
  source_exception_id: EXCEPTION_ID,
  ...over,
});

// ---- §2: the authenticated owner boundary ------------------------------------

test("V6.1.5: a claimed actor string is never proof of owner identity", () => {
  const { store } = harness();
  const boundary = createOwnerBoundary({ authenticate: () => null });
  assert.equal(boundary.trusts_claimed_actor, false);

  // The exact spoof an agent could construct.
  assert.equal(store.commit(request({ credentials: null, actor: "owner" })).ok, false);
  assert.equal(store.commit(request({ operation_id: "op-2", credentials: "guessed" })).ok, false);

  // A non-authorization action is refused even with valid credentials.
  for (const action of ["ctn", "open_form", "edit_draft", "navigate", null]) {
    const result = store.commit(request({ operation_id: `op-${action}`, action }));
    assert.equal(result.ok, false, `${action} must not be an authorization`);
  }

  // The positive control: a real authenticated owner action succeeds.
  assert.equal(store.commit(request()).ok, true);
});

test("V6.1.5: a non-owner principal cannot authorize", () => {
  const { store } = harness({ authenticate: () => ({ role: "agent", id: "claude" }) });
  const result = store.commit(request());
  assert.equal(result.ok, false);
  assert.match(result.reason, /authenticated owner provenance/);
});

// ---- §3: preview / persistence equivalence -----------------------------------

test("V6.1.5: a draft edited after preview cannot be authorized against it", () => {
  const { store } = harness();
  const stalePreview = policyIdentity(DRAFT);
  const widened = createAuthorityDraft({
    ...DRAFT,
    // The dangerous edit: broader scope than what she read.
    scope_refs: ["repo:in-c0/datascape", "semantic-centre:continuity", "repo:in-c0/sumzup"],
  });

  const result = store.commit(request({ draft: widened, policy_identity: stalePreview }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "stale_preview");
  assert.match(result.reason, /review is required again/);

  // Re-previewing the widened draft is a different identity, and works.
  assert.equal(store.commit(request({
    operation_id: "op-fresh", draft: widened, policy_identity: policyIdentity(widened),
  })).ok, true);
});

test("V6.1.5: the policy identity covers every field the owner agreed to", () => {
  const base = policyIdentity(DRAFT);
  const changes = [
    { statement: "Something else entirely" },
    { scope_refs: ["repo:in-c0/sumzup"] },
    { allowed_capabilities: ["run_tests"] },
    { max_cost: 20 },
    { max_wall_time_ms: 3600000 },
    { stop_conditions: [] },
  ];
  for (const change of changes) {
    assert.notEqual(policyIdentity({ ...DRAFT, ...change }), base, JSON.stringify(change));
  }
  // Order must not matter, or an identical envelope would read as a new one.
  assert.equal(policyIdentity({ ...DRAFT, scope_refs: [...DRAFT.scope_refs].reverse() }), base);
});

// ---- §4: idempotency ---------------------------------------------------------

test("V6.1.5: a retried authorization creates exactly one ruling", () => {
  const { store, exceptions } = harness();
  const first = store.commit(request());
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);

  // Write succeeded, response lost, owner retries.
  const retry = store.commit(request());
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true, "the same operation replays, it does not repeat");
  assert.equal(retry.revision, 1);

  assert.equal(store.history(first.goal_id).length, 1, "one authority revision");
  assert.equal(exceptions.resolved.length, 1, "one exception resolution");
});

test("V6.1.5: a FAILED authorization is retryable, not replayed as success", () => {
  const { store } = harness();
  const bad = store.commit(request({ credentials: "wrong" }));
  assert.equal(bad.ok, false);

  // The same operation_id with valid credentials must be able to succeed —
  // remembering a failure as a completed operation would strand the owner.
  const good = store.commit(request());
  assert.equal(good.ok, true);
  assert.equal(good.replayed, false);
});

// ---- §1, §7: the transaction and exception resolution ------------------------

test("V6.1.5: a failed resolution leaves no partial goal and no resolved blocker", () => {
  const { store } = harness({ resolveOk: false });
  const result = store.commit(request());
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "resolution_failed");
  assert.equal(store.current("goal:F3"), null, "no half-written authority may survive");
});

test("V6.1.5: an invalid draft does not resolve the blocker merely because Authorize was clicked", () => {
  const { store, exceptions } = harness();
  const malformed = createAuthorityDraft({
    draft_id: "bad", statement: "x", scope_refs: [], allowed_capabilities: [],
  });
  const result = store.commit(request({ draft: malformed, policy_identity: policyIdentity(malformed) }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "invalid_draft");
  assert.equal(exceptions.resolved.length, 0);
});

test("V6.1.5: authority that fails the goal verifier never becomes usable", () => {
  const { store, exceptions } = harness();
  const store2 = createAuthorityStore({
    boundary: createOwnerBoundary({ authenticate: () => ({ role: "owner", id: "ava" }) }),
    exceptions,
    now: () => AT,
    // A verifier that refuses everything: the transaction must abort rather
    // than persist an object the rest of V6 would not accept.
    verifier: () => ({ authority: "partial" }),
  });
  const result = store2.commit(request());
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "not_admissible");
  assert.equal(exceptions.resolved.length, 0);
  assert.equal(store.current("goal:F3"), null);
});

// ---- §5: scope fidelity at the storage boundary ------------------------------

test("V6.1.5: the refs are the authority and the label is only display metadata", () => {
  const { store } = harness();
  const result = store.commit(request());
  const record = store.current(result.goal_id);

  assert.deepEqual(record.scope_refs, ["repo:in-c0/datascape", "semantic-centre:continuity"],
    "every resolved ref must round-trip exactly");
  assert.equal(record.scope_label, "DataScape / Continuity");
  assert.deepEqual(record.goal.allowed_scope_refs, record.scope_refs);
  assert.notDeepEqual(record.scope_refs, ["DataScape / Continuity"],
    "a display label must never be stored in place of the refs");
});

// ---- §6: revision concurrency ------------------------------------------------

test("V6.1.5: narrowing is compare-and-swap, never last-writer-wins", () => {
  const { store } = harness();
  const { goal_id } = store.commit(request());

  // Tab B narrows first.
  const b = store.commit({
    operation_id: "op-b", action: "narrow_authority", credentials: "valid-owner-session",
    goal_id, expected_revision: 1, scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(b.ok, true);
  assert.equal(b.revision, 2);

  // Tab A, still holding rev 1, must lose.
  const a = store.commit({
    operation_id: "op-a", action: "narrow_authority", credentials: "valid-owner-session",
    goal_id, expected_revision: 1, scope_refs: ["repo:in-c0/datascape"],
  });
  assert.equal(a.ok, false);
  assert.equal(a.outcome, "stale_revision");
  assert.deepEqual(store.current(goal_id).scope_refs, ["semantic-centre:continuity"]);
});

test("V6.1.5: narrowing may only remove scope, never add it", () => {
  const { store } = harness();
  const { goal_id } = store.commit(request());
  const widening = store.commit({
    operation_id: "op-w", action: "narrow_authority", credentials: "valid-owner-session",
    goal_id, expected_revision: 1, scope_refs: ["repo:in-c0/datascape", "repo:in-c0/sumzup"],
  });
  assert.equal(widening.ok, false);
  assert.equal(widening.outcome, "not_a_narrowing");
});

test("V6.1.5: revocation is a revision, not an erasure", () => {
  const { store } = harness();
  const { goal_id } = store.commit(request());
  const revoked = store.commit({
    operation_id: "op-r", action: "revoke_authority", credentials: "valid-owner-session",
    goal_id, expected_revision: 1,
  });
  assert.equal(revoked.ok, true);
  assert.equal(store.current(goal_id).state, "revoked");
  assert.equal(store.current(goal_id).goal.autonomy_policy, null);
  assert.equal(store.history(goal_id).length, 2, "the grant remains in the record");
});

// ---- §8: the V5 bridge -------------------------------------------------------

test("V6.1.5: granting and revoking are history; draft edits are not", () => {
  const { store } = harness();
  const { goal_id } = store.commit(request());
  store.commit({
    operation_id: "op-r2", action: "revoke_authority", credentials: "valid-owner-session",
    goal_id, expected_revision: 1,
  });

  const { events } = store.materialEvents();
  assert.equal(events.length, 2, "one grant, one revocation");
  assert.ok(events.every((e) => e.trigger === "owner"));
  assert.ok(events.some((e) => /authorized/i.test(e.text)));
  assert.ok(events.some((e) => /revoked/i.test(e.text)));

  for (const kind of ["draft_edited", "preview_rendered", "form_opened", "navigated_away"]) {
    assert.equal(draftActivityIsEphemeral(kind), true, `${kind} must not reach semantic history`);
  }
  assert.equal(draftActivityIsEphemeral("authority_granted"), false);
});

// ---- §10: the shadow re-audit trigger ----------------------------------------

test("V6.1.5: authorizing triggers a re-audit and explicitly not execution", () => {
  const { store } = harness();
  const { goal_id } = store.commit(request());
  const trigger = shadowReauditRequest(store.current(goal_id));

  assert.equal(trigger.reason, "authority_changed");
  assert.equal(trigger.executes, false);
  assert.equal(trigger.dispatches, false);
  assert.deepEqual(trigger.scope_refs, ["repo:in-c0/datascape", "semantic-centre:continuity"]);

  // The store exposes no execution surface at all.
  for (const forbidden of ["dispatch", "execute", "send", "run"]) {
    assert.equal(typeof store[forbidden], "undefined", `${forbidden} must not exist on the authority store`);
  }
});
