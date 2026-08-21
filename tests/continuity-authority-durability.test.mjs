import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import { policyIdentityOf } from "../src/continuity/control/authority-draft.js";
import { fixtureStates } from "../src/continuity/control/authority-fixture.js";

const DRAFT = fixtureStates().F3_authorized_goal.draft;
const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");

/**
 * A world that survives a restart.
 *
 * `restart()` throws away the process-side objects and rebuilds them over the
 * SAME storage and the same exception state — which is what a restart is. An
 * in-memory Map would pass every other test in this file and fail this one.
 */
function world() {
  const storage = createMemoryStorage();
  const resolved = new Set();
  const exceptions = {
    resolve(id) {
      if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
      resolved.add(id);
      return { ok: true };
    },
    isResolved: (id) => resolved.has(id),
  };
  const build = () => createAuthorityEndpoint({
    authenticateCaller: () => ({ role: "owner", id: "fake" }),
    exceptions, now: () => AT, storage,
  });
  let endpoint = build();
  return {
    get endpoint() { return endpoint; },
    restart() { endpoint = build(); return endpoint; },
    resolved,
    storage,
  };
}

const body = (over = {}) => ({
  operation_id: "op-1",
  authorization_action: "authorize_goal",
  draft: DRAFT,
  policy_identity: policyIdentityOf(DRAFT),
  source_exception_id: BLOCKER,
  ...over,
});

// ---- authority survives a restart ---------------------------------------------

test("V6.1.5B durability: authority survives a backend restart", () => {
  const w = world();
  const granted = w.endpoint.handle("authorize", body());
  assert.equal(granted.ok, true);

  const after = w.restart();
  const read = after.handle("current", { goal_id: granted.goal_id });
  assert.equal(read.revision, 1, "the revision must survive the restart");
  assert.deepEqual(read.record.scope_refs, DRAFT.scope_refs);
});

test("V6.1.5B durability: idempotency survives a backend restart", () => {
  const w = world();
  const first = w.endpoint.handle("authorize", body());

  // Response lost, process restarts, the owner's browser retries.
  const after = w.restart();
  const retry = after.handle("authorize", body());

  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true, "an in-memory idempotency map would have forgotten");
  assert.equal(retry.goal_id, first.goal_id);
  assert.equal(after.history(first.goal_id).length, 1, "exactly one ruling");
  assert.equal(w.resolved.size, 1, "exactly one exception resolution");
});

test("V6.1.5B durability: revision CAS survives a backend restart", () => {
  const w = world();
  const granted = w.endpoint.handle("authorize", body());
  w.endpoint.handle("authorize", {
    operation_id: "op-narrow", authorization_action: "narrow_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1, scope_refs: ["semantic-centre:continuity"],
  });

  const after = w.restart();
  const stale = after.handle("authorize", {
    operation_id: "op-stale", authorization_action: "revoke_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure, "stale_revision", "rev 2 must still be current after a restart");

  // The positive control: the CURRENT revision still writes.
  assert.equal(after.handle("authorize", {
    operation_id: "op-ok", authorization_action: "revoke_authority",
    goal_id: granted.goal_id, expected_authority_revision: 2,
  }).ok, true);
});

// ---- no half-and-half state across any crash point ----------------------------

test("V6.1.5B durability: a crash after the authority write leaves nothing observable", () => {
  const w = world();
  const crashed = w.endpoint.handle("authorize", { ...body(), __faultInjector: "after_authority_written" });
  assert.equal(crashed.ok, false);

  // Before recovery: the authority is written but INVISIBLE, and the blocker
  // was never resolved. An observer sees "nothing happened".
  assert.equal(w.endpoint.observableState("goal:F3", BLOCKER).authority_visible, false);
  assert.equal(w.resolved.has(BLOCKER), false);

  // Recovery rolls it FORWARD, because the record was durable.
  const after = w.restart();
  const state = after.observableState("goal:F3", BLOCKER);
  assert.equal(state.authority_visible, true);
  assert.equal(state.blocker_resolved, true);
  assert.equal(state.in_flight, 0);
});

test("V6.1.5B durability: a crash after the resolution never leaves a resolved blocker with no authority", () => {
  const w = world();
  const crashed = w.endpoint.handle("authorize", { ...body(), __faultInjector: "after_resolution" });
  assert.equal(crashed.ok, false);

  // This is the forbidden window: the exception IS resolved and the commit
  // marker is missing.
  assert.equal(w.resolved.has(BLOCKER), true);
  assert.equal(w.endpoint.observableState("goal:F3", BLOCKER).authority_visible, false);

  // Recovery must close it by rolling forward, never by reopening her blocker.
  const after = w.restart();
  const state = after.observableState("goal:F3", BLOCKER);
  assert.equal(state.authority_visible, true, "the resolved blocker must have matching authority");
  assert.equal(state.blocker_resolved, true);
  assert.equal(state.in_flight, 0);
  assert.equal(after.history("goal:F3").length, 1, "recovery must not duplicate the ruling");
});

test("V6.1.5B durability: an aborted transaction leaves no authority and no resolution", () => {
  const w = world();
  // A draft that fails verification: the build step never produces a record.
  const bad = w.endpoint.handle("authorize", body({
    draft: { ...DRAFT, allowed_capabilities: [] },
    policy_identity: policyIdentityOf({ ...DRAFT, allowed_capabilities: [] }),
  }));
  assert.equal(bad.ok, false);

  const after = w.restart();
  const state = after.observableState("goal:F3", BLOCKER);
  assert.equal(state.authority_visible, false);
  assert.equal(state.blocker_resolved, false);
  assert.equal(state.in_flight, 0, "an aborted entry must not stay mid-flight forever");
});

// ---- the recovery itself is observable ----------------------------------------

test("V6.1.5B durability: recovery reports what it did", () => {
  const w = world();
  w.endpoint.handle("authorize", { ...body(), __faultInjector: "after_authority_written" });
  const after = w.restart();

  const recovered = after.recoveredOnOpen();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "rolled_forward");

  // A clean restart recovers nothing, so the count above is not noise.
  assert.deepEqual(w.restart().recoveredOnOpen(), []);
});
