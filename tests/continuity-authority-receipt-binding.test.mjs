import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorityEndpoint } from "../src/continuity/control/authority-endpoint.js";
import { createReceiptStore } from "../src/continuity/control/authority-receipt.js";
import { createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import { createContractExceptionStore } from "../src/continuity/control/exception-contract.js";
import { SCOPE_CATALOGUE, fixtureStates } from "../src/continuity/control/authority-fixture.js";

const BLOCKER = "2026-08-21-datascape-v6-execution-authority-b4e2";
const AT = Date.parse("2026-08-22T09:00:00+10:00");
const DRAFT = fixtureStates().F3_authorized_goal.draft;
const CANARY = {
  ...fixtureStates().F5_authorized_canary.draft,
  operation: "run_verification",
  success_condition: "the briefing surface renders with zero console errors",
};

/**
 * A host whose receipt store can be destroyed independently of its journal —
 * which is exactly what a restart does, and the case that exposed the
 * consume-before-commit defect.
 */
function host({ ttlMs = 60000 } = {}) {
  let clock = AT;
  const storage = createMemoryStorage();
  const exceptions = createContractExceptionStore();
  const build = () => {
    const receipts = createReceiptStore({ now: () => clock, ttlMs });
    return {
      receipts,
      endpoint: createAuthorityEndpoint({
        authenticateCaller: () => ({ role: "owner", id: "fake-owner" }),
        exceptions, now: () => clock, storage, receipts, requireReceipt: true,
        readContext: {
          blocker: () => (exceptions.isResolved(BLOCKER) ? null : { id: BLOCKER, title: "V6 execution authority" }),
          domain: () => BLOCKER,
          catalogue: () => SCOPE_CATALOGUE,
          suggestions: () => [],
          draft: () => null,
        },
      }),
    };
  };
  let current = build();
  return {
    get endpoint() { return current.endpoint; },
    get receipts() { return current.receipts; },
    /** Restart: the journal survives, every receipt does not. */
    restart() { current = build(); return current.endpoint; },
    exceptions,
    advance: (ms) => { clock += ms; },
  };
}

const grant = (h) => {
  const prepared = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  const result = h.endpoint.handle("authorize", {
    operation_id: "op-grant", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
  });
  return { prepared, result };
};

// ---- P0-1: the receipt binds the ENTIRE mutation -------------------------------

test("A.1: a narrow receipt cannot authorize a revoke", () => {
  const h = host();
  const { result } = grant(h);
  const narrow = h.endpoint.handle("prepare", {
    authorization_action: "narrow_authority", scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(narrow.action, "narrow_authority");

  const misuse = h.endpoint.handle("authorize", {
    operation_id: "op-misuse", authorization_action: "revoke_authority",
    preview_receipt: narrow.preview_receipt,
  });
  assert.equal(misuse.ok, false);
  assert.equal(misuse.failure, "receipt_action_mismatch");
  assert.equal(h.endpoint.handle("current", { goal_id: result.goal_id }).state, "authorized",
    "the authority must be untouched");
});

test("A.1: a revoke receipt cannot authorize a narrow", () => {
  const h = host();
  grant(h);
  const revoke = h.endpoint.handle("prepare", { authorization_action: "revoke_authority" });
  const misuse = h.endpoint.handle("authorize", {
    operation_id: "op-misuse2", authorization_action: "narrow_authority",
    preview_receipt: revoke.preview_receipt, scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(misuse.failure, "receipt_action_mismatch");
});

test("A.1: an amendment receipt cannot be pointed at another lineage", () => {
  const h = host();
  const { result } = grant(h);
  const narrow = h.endpoint.handle("prepare", {
    authorization_action: "narrow_authority", scope_refs: ["semantic-centre:continuity"],
  });
  // The host bound the lineage itself.
  assert.equal(narrow.goal_id, result.goal_id);

  const crossGoal = h.endpoint.handle("authorize", {
    operation_id: "op-cross", authorization_action: "narrow_authority",
    preview_receipt: narrow.preview_receipt, goal_id: "goal:someone-else",
    scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(crossGoal.failure, "receipt_lineage_mismatch");
});

test("A.1: the resulting scope is bound, not resupplied at commit", () => {
  const h = host();
  grant(h);
  const narrow = h.endpoint.handle("prepare", {
    authorization_action: "narrow_authority", scope_refs: ["semantic-centre:continuity"],
  });
  assert.deepEqual(narrow.resulting_scope_refs, ["semantic-centre:continuity"]);

  const altered = h.endpoint.handle("authorize", {
    operation_id: "op-alt", authorization_action: "narrow_authority",
    preview_receipt: narrow.preview_receipt, scope_refs: ["repo:in-c0/datascape"],
  });
  assert.equal(altered.failure, "receipt_scope_mismatch");

  // The positive control: the exact reviewed narrow lands as rev 2.
  const ok = h.endpoint.handle("authorize", {
    operation_id: "op-ok", authorization_action: "narrow_authority",
    preview_receipt: narrow.preview_receipt, scope_refs: ["semantic-centre:continuity"],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.revision, 2);
});

test("A.1: a bounded-canary receipt cannot authorize a persistent goal", () => {
  const h = host();
  const canaryReceipt = h.endpoint.handle("prepare", { draft: CANARY, authorization_action: "authorize_bounded_task" });
  const misuse = h.endpoint.handle("authorize", {
    operation_id: "op-kind", authorization_action: "authorize_goal",
    preview_receipt: canaryReceipt.preview_receipt,
  });
  assert.equal(misuse.failure, "receipt_action_mismatch");

  // And the reverse: a persistent-goal receipt cannot authorize a bounded task.
  const goalReceipt = h.endpoint.handle("prepare", { draft: DRAFT, authorization_action: "authorize_goal" });
  assert.equal(h.endpoint.handle("authorize", {
    operation_id: "op-kind2", authorization_action: "authorize_bounded_task",
    preview_receipt: goalReceipt.preview_receipt,
  }).failure, "receipt_action_mismatch");
});

test("A.1: the browser cannot choose which authority an amendment concerns", () => {
  const h = host();
  const { result } = grant(h);
  // The browser says nothing about lineage; the host resolves it from the
  // authority domain it already holds.
  const narrow = h.endpoint.handle("prepare", {
    authorization_action: "narrow_authority", scope_refs: ["semantic-centre:continuity"],
    goal_id: "goal:a-lineage-the-browser-made-up",
  });
  assert.equal(narrow.goal_id, result.goal_id, "browser = intent, host = authoritative context");
  assert.equal(narrow.base_authority_revision, 1);
});

test("A.1: preparing an amendment with no current authority is refused", () => {
  const h = host();
  const orphan = h.endpoint.handle("prepare", { authorization_action: "narrow_authority", scope_refs: [] });
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /no current authority to amend/);
});

// ---- P0-2: receipts must not undo durable idempotency --------------------------

test("A.1: a committed operation replays even after every receipt is gone", () => {
  const h = host();
  const { prepared, result } = grant(h);
  assert.equal(result.ok, true);

  // Response lost. Host restarts: the journal survives, receipts do not.
  const after = h.restart();
  const retry = after.handle("authorize", {
    operation_id: "op-grant", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
  });

  assert.equal(retry.ok, true, "a short-lived receipt must not undo durable idempotency");
  assert.equal(retry.replayed, true);
  assert.equal(retry.goal_id, result.goal_id);
  assert.equal(after.history(result.goal_id).length, 1, "one ruling");
  assert.equal(h.exceptions.resolvedBy.size, 1, "one exception resolution");
});

test("A.1: a retry with no receipt at all still replays a committed operation", () => {
  const h = host();
  const { result } = grant(h);
  const retry = h.endpoint.handle("authorize", { operation_id: "op-grant" });
  assert.equal(retry.replayed, true);
  assert.equal(retry.revision, result.revision);
});

test("A.1: preserving idempotency does not weaken single-use consent", () => {
  const h = host();
  const { prepared } = grant(h);
  // A DIFFERENT operation cannot ride the consumed receipt.
  const second = h.endpoint.handle("authorize", {
    operation_id: "op-second", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
  });
  assert.equal(second.ok, false);
  assert.equal(second.failure, "no_receipt");
});

test("A.1: a NEW operation after a restart requires a new review", () => {
  const h = host();
  const { prepared } = grant(h);
  const after = h.restart();
  const fresh = after.handle("authorize", {
    operation_id: "op-brand-new", authorization_action: "authorize_goal",
    preview_receipt: prepared.preview_receipt,
  });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.failure, "no_receipt", "a new authorization needs a new receipt");
});
