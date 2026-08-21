// The prepared object, the durable identity, and the amendment chain.
//
// These three failed together in the wired host and for related reasons: the
// receipt carried no draft, so an initial grant could not be built at all; the
// durable goal identity came from a `draft_id` the BROWSER supplied; and the
// amendment builder read its "current authority" from a dummy store that was
// always empty, so narrow and revoke could never see the grant they amend.
import test from "node:test";
import assert from "node:assert/strict";

import { createReceiptStore } from "../src/continuity/control/authority-receipt.js";
import { createAuthorityDraft } from "../src/continuity/control/authority-draft.js";
import { createAuthorityStore } from "../src/continuity/control/authority-store.js";
import {
  createAuthorityJournal, createMemoryStorage,
} from "../src/continuity/control/authority-journal.js";
import { createJournalExceptionPort } from "../src/continuity/control/authority-exception-port.js";

const SESSION = "session-S1";

function world() {
  const now = () => 1_000_000;
  const receipts = createReceiptStore({ now });
  const storage = createMemoryStorage();
  const blockers = new Map([["exc-1", { status: "blocked-on-owner", refs: [] }]]);
  const exceptions = createJournalExceptionPort({
    resolve(id, ref) {
      const item = blockers.get(id);
      if (!item) return { ok: false, failure: "unknown_exception" };
      const others = item.refs.filter((r) => r !== ref);
      if (others.length) return { ok: false, failure: "already_authorized", existing_refs: others };
      item.refs.push(ref); item.status = "resolved";
      return { ok: true, status: "resolved", ruling_ref: ref };
    },
  });
  const journal = createAuthorityJournal({ storage, now, exceptions });
  // The DEPLOYED shape: the record builder is constructed over a dummy store,
  // because the durable journal is owned by the transaction outside it.
  const store = createAuthorityStore({
    boundary: { verify: () => ({ ok: true }) },
    exceptions, now,
    storage: { read: () => [], append: () => {}, update: () => {} },
  });

  let minted = 0;
  const prepare = ({ action = "authorize_goal", draft = null, scopeRefs = null, goalId = null, baseRevision = null }) => {
    // The HOST mints the identity. Whatever the browser called its draft is
    // discarded before anything durable is derived from it.
    const prepared = draft
      ? createAuthorityDraft({ ...draft, draft_id: `prepared:${++minted}` })
      : null;
    return receipts.issue({
      draft: prepared, action,
      authorityDomain: "exc-1",
      sourceExceptionId: action === "authorize_goal" || action === "authorize_bounded_task" ? "exc-1" : null,
      goalId, baseRevision, resultingScopeRefs: scopeRefs,
      readSessionId: SESSION,
    });
  };

  const apply = (receipt) => store.buildFor({
    action: receipt.action,
    draft: receipt.prepared_draft ?? null,
    policy_identity: receipt.policy_identity ?? null,
    goal_id: receipt.goal_id ?? null,
    expected_revision: receipt.base_authority_revision ?? null,
    source_exception_id: receipt.source_exception_id ?? null,
    scope_refs: receipt.resulting_scope_refs ?? null,
    existing: receipt.goal_id ? journal.current(receipt.goal_id) : null,
  }, now());

  const commit = (receipt, operationId) => journal.transact({
    operation_id: operationId,
    source_exception_id: receipt.source_exception_id ?? null,
    build: () => apply(receipt),
  });

  return { receipts, journal, storage, prepare, apply, commit, blockers };
}

const DRAFT = {
  // What the React form actually sends. "new" must never become durable.
  draft_id: "new",
  kind: "persistent_goal",
  statement: "keep the briefing surface green",
  scope_refs: ["scope:datascape/briefing"],
  allowed_capabilities: ["run_tests", "inspect_repository"],
  stop_conditions: ["reviewed"],
  max_cost: 0,
};

test("an initial grant can be built from the receipt alone", () => {
  // It could not before: the receipt carried no draft, so the commit path
  // passed `draft: null` and the record builder refused every initial grant.
  const w = world();
  const receipt = w.prepare({ draft: DRAFT });
  assert.ok(receipt.prepared_draft, "the receipt must carry the prepared draft");

  const built = w.apply(receipt);
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.value.revision, 1);
  assert.equal(built.value.state, "authorized");
});

test("the durable identity is HOST-bound, never the browser's draft_id", () => {
  const w = world();
  const receipt = w.prepare({ draft: DRAFT });
  const built = w.apply(receipt);

  assert.notEqual(built.value.goal.goal_id, "goal:new");
  assert.match(built.value.goal.goal_id, /^goal:prepared:/);
  assert.match(built.value.ruling.ref, /^owner-ruling:prepared:/);
});

test("two separately prepared grants of the SAME text do not collide", () => {
  // With the browser's "new" as the identity, every authorization this machine
  // ever granted would share one durable goal id.
  const w = world();
  const first = w.apply(w.prepare({ draft: DRAFT }));
  const second = w.apply(w.prepare({ draft: DRAFT }));
  assert.notEqual(first.value.goal.goal_id, second.value.goal.goal_id);
});

test("the browser cannot change the identity at commit — it sends no draft", () => {
  // Structural: the prepared draft lives in the receipt, and the commit wire is
  // two opaque strings. There is no field to put a draft_id in.
  const w = world();
  const receipt = w.prepare({ draft: { ...DRAFT, draft_id: "attacker-controlled" } });
  assert.match(receipt.prepared_draft.draft_id, /^prepared:/);
  const built = w.apply(receipt);
  assert.ok(!JSON.stringify(built.value).includes("attacker-controlled"));
});

test("grant then narrow then revoke walks revisions 1, 2, 3", () => {
  // The chain that could not run at all: the amend builder read its current
  // authority from the dummy store and always found nothing.
  const w = world();
  const grant = w.commit(w.prepare({ draft: DRAFT }), "op-1");
  assert.equal(grant.ok, true, grant.reason);
  assert.equal(grant.record.revision, 1);
  const goalId = grant.record.goal.goal_id;

  const narrowed = w.commit(w.prepare({
    action: "narrow_authority", goalId, baseRevision: 1, scopeRefs: [],
  }), "op-2");
  assert.equal(narrowed.ok, true, narrowed.reason);
  assert.equal(narrowed.record.revision, 2);

  const revoked = w.commit(w.prepare({
    action: "revoke_authority", goalId, baseRevision: 2, scopeRefs: [],
  }), "op-3");
  assert.equal(revoked.ok, true, revoked.reason);
  assert.equal(revoked.record.revision, 3);
  assert.equal(revoked.record.state, "revoked");
});

test("narrowing cannot ADD scope", () => {
  const w = world();
  const grant = w.commit(w.prepare({ draft: DRAFT }), "op-1");
  const goalId = grant.record.goal.goal_id;

  const widened = w.apply(w.prepare({
    action: "narrow_authority", goalId, baseRevision: 1,
    scopeRefs: ["scope:datascape/briefing", "scope:everything-else"],
  }));
  assert.equal(widened.ok, false, "narrowing is not a way to grant more");
});

test("one browser mutation produces exactly one journal entry", () => {
  const w = world();
  w.commit(w.prepare({ draft: DRAFT }), "op-1");
  const entries = w.storage.read().filter((e) => e.operation_id === "op-1");
  assert.equal(entries.length, 1, "a nested transaction would show as a second entry");
  assert.equal(entries[0].phase, "committed");
});
