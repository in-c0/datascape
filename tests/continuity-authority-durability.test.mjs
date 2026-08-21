import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { AuthorityStateUnavailable, createFileStorage, createMemoryStorage } from "../src/continuity/control/authority-journal.js";
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
 *
 * The fault injector is a CONSTRUCTION capability, and a restart drops it,
 * because "the process died and came back" is exactly that.
 */
function world({ fault = null } = {}) {
  const storage = createMemoryStorage();
  // The real exception layer's required contract: resolve() is idempotent FOR
  // THE SAME RULING, and reports who resolved it so recovery can distinguish
  // "already mine" from "closed by something else entirely".
  const resolvedBy = new Map();
  const exceptions = {
    resolve(id, meta) {
      if (id !== BLOCKER) return { ok: false, reason: "refusing a different exception" };
      const existing = resolvedBy.get(id);
      if (existing && existing !== meta?.ruling_ref) {
        return { ok: false, resolved_by: existing, reason: "already resolved by a different ruling" };
      }
      resolvedBy.set(id, meta?.ruling_ref ?? "unknown");
      return { ok: true, resolved_by: meta?.ruling_ref ?? "unknown" };
    },
    isResolved: (id) => resolvedBy.has(id),
    resolvedBy,
  };
  let faulty = fault;
  const build = () => createAuthorityEndpoint({
    authenticateCaller: () => ({ role: "owner", id: "fake" }),
    exceptions, now: () => AT, storage, faultInjector: faulty,
  });
  let endpoint = build();
  return {
    get endpoint() { return endpoint; },
    restart() { faulty = null; endpoint = build(); return endpoint; },
    get resolved() { return { size: resolvedBy.size, has: (id) => resolvedBy.has(id) }; },
    exceptions,
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
  const w = world({ fault: "after_authority_written" });
  const crashed = w.endpoint.handle("authorize", body());
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
  const w = world({ fault: "after_resolution" });
  const crashed = w.endpoint.handle("authorize", body());
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

test("V6.1.5B durability: a crash between the resolution and the journal recovers", () => {
  // The narrowest window in the design: the outside world has SEEN the
  // resolution and the journal does not know it yet. Recovery calls resolve()
  // again, which is only safe because the contract requires idempotency for the
  // same ruling.
  const w = world({ fault: "between_resolve_and_journal" });
  const crashed = w.endpoint.handle("authorize", body());
  assert.equal(crashed.ok, false);
  assert.equal(w.resolved.has(BLOCKER), true, "the external resolution already happened");

  const after = w.restart();
  const state = after.observableState("goal:F3", BLOCKER);
  assert.equal(state.authority_visible, true);
  assert.equal(state.blocker_resolved, true);
  assert.equal(after.history("goal:F3").length, 1, "recovery must not duplicate the ruling");
  assert.equal(w.exceptions.resolvedBy.size, 1, "resolve must be idempotent for the same ruling");
});

test("V6.1.5B durability: a blocker resolved by a DIFFERENT ruling fails closed", () => {
  const w = world({ fault: "between_resolve_and_journal" });
  w.endpoint.handle("authorize", body());

  // Something else closed the blocker while the process was down.
  w.exceptions.resolvedBy.set(BLOCKER, "owner-ruling:someone-else:rev1");

  const after = w.restart();
  assert.equal(after.recoveredOnOpen()[0].outcome, "inconsistent",
    "a resolution that meant something else must not be adopted");
  assert.equal(after.observableState("goal:F3", BLOCKER).authority_visible, false,
    "no authority may be stacked on another ruling's resolution");
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
  const w = world({ fault: "after_authority_written" });
  w.endpoint.handle("authorize", body());
  const after = w.restart();

  const recovered = after.recoveredOnOpen();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "rolled_forward");

  // A clean restart recovers nothing, so the count above is not noise.
  assert.deepEqual(w.restart().recoveredOnOpen(), []);
});

// ---- fail-closed storage -------------------------------------------------------

test("V6.1.5B durability: a corrupt journal is unavailable, never empty", () => {
  const missing = createFileStorage({
    fs: { readFileSync() { const e = new Error("nope"); e.code = "ENOENT"; throw e; } },
    path: "x",
  });
  assert.deepEqual(missing.read(), [], "absence is the only benign read failure");

  for (const [label, thrower] of [
    ["corrupt", () => "{not json"],
    ["not an array", () => JSON.stringify({ nope: true })],
  ]) {
    const storage = createFileStorage({ fs: { readFileSync: thrower }, path: "x" });
    assert.throws(() => storage.read(), AuthorityStateUnavailable, label);
  }

  const denied = createFileStorage({
    fs: { readFileSync() { const e = new Error("denied"); e.code = "EACCES"; throw e; } },
    path: "x",
  });
  assert.throws(() => denied.read(), AuthorityStateUnavailable,
    "a permission failure must never read as no authority");
});

// ---- fault injection is not a request feature ---------------------------------

test("V6.1.5B durability: a browser-supplied fault injector is ignored", () => {
  const w = world();
  const result = w.endpoint.handle("authorize", { ...body(), __faultInjector: "after_resolution" });

  // It committed normally: the request could not steer the transaction.
  assert.equal(result.ok, true);
  assert.equal(w.endpoint.observableState("goal:F3", BLOCKER).authority_visible, true);
  assert.equal(w.endpoint.observableState("goal:F3", BLOCKER).in_flight, 0);
});

// ---- V5 evidence survives a restart --------------------------------------------

test("V6.1.5B durability: authority events survive a backend restart", () => {
  const w = world();
  const granted = w.endpoint.handle("authorize", body());
  w.endpoint.handle("authorize", {
    operation_id: "op-revoke", authorization_action: "revoke_authority",
    goal_id: granted.goal_id, expected_authority_revision: 1,
  });
  const before = w.endpoint.materialEvents().events;
  assert.equal(before.length, 2);

  const after = w.restart().materialEvents().events;
  assert.equal(after.length, 2, "a restart must not erase the evidence of the owner's ruling");
  assert.deepEqual(after.map((e) => e.text).sort(), before.map((e) => e.text).sort());
  assert.ok(after.every((e) => e.trigger === "owner"));
});
