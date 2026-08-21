// The authority mutation transaction — parts 6, 7 and 8.
//
// What is under test is the ORDER. Each step exists because doing it later
// would let something through, so the tests drive the sequence rather than the
// happy path: what the browser may send, what happens when the world moves
// while Windows Hello is open, and whether a lost response can be replayed
// without becoming a credential.
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMIT_FIELDS, FORBIDDEN_COMMIT_FIELDS, commitAuthority, prepareAuthority, promptForReceipt,
  validateCommitWire,
} from "../src/continuity/control/authority-commit.js";
import { createReceiptStore } from "../src/continuity/control/authority-receipt.js";
import { createAuthorityDraft } from "../src/continuity/control/authority-draft.js";

const SESSION = "session-S1";

function harness({ outcome = "verified", revision = 1 } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const state = { revision, session: SESSION, consumeOk: true };
  const prompts = [];
  const writes = [];
  const ledger = new Map();

  const receipts = createReceiptStore({ now });
  const receipt = receipts.issue({
    draft: createAuthorityDraft({
      draft_id: "draft:commit",
      kind: "bounded_canary",
      statement: "one bounded task",
      scope_refs: ["scope:datascape/briefing"],
      allowed_capabilities: ["read"],
      stop_conditions: ["reviewed"],
      max_cost: 0,
    }),
    action: "authorize_bounded_task",
    sourceExceptionId: "2026-08-21-datascape-v6-execution-authority-b4e2",
    goalId: "goal:1",
    baseRevision: revision,
    resultingScopeRefs: ["scope:datascape/briefing"],
    readSessionId: SESSION,
  });

  const issued = new Set();
  const deps = {
    now,
    authenticate: () => (state.session
      ? { ok: true, context: { principal: "owner", read_session_id: state.session, expires_at: clock + 1000 } }
      : { ok: false, failure: "read_session_invalid", reason: "the owner-read session has expired or was replaced" }),
    operations: {
      completed: (id) => (ledger.get(id)?.phase === "committed" ? ledger.get(id) : null),
      begin: ({ operation_id, receipt_id, at }) => ledger.set(operation_id, { phase: "preparing", receipt_id, at }),
      complete: (id, result) => ledger.set(id, { ...ledger.get(id), phase: "committed", result }),
      abort: (id, reason) => ledger.set(id, { ...ledger.get(id), phase: "aborted", reason }),
    },
    receipts,
    presence: {
      verifier: {
        verify: async ({ purpose, operationRef }) => {
          prompts.push({ purpose, operationRef });
          if (state.duringPrompt) state.duringPrompt();
          if (outcome !== "verified") return { outcome, reason: `device said ${outcome}` };
          const v = { outcome: "verified", operation_ref: operationRef };
          issued.add(v);
          return v;
        },
        authorizes: (v, ref) => {
          if (!state.consumeOk) return { ok: false, reason: "already used or did not originate here" };
          if (v?.outcome !== "verified" || v.operation_ref !== ref) return { ok: false, reason: "wrong verification" };
          if (!issued.has(v)) return { ok: false, reason: "already used" };
          issued.delete(v);
          return { ok: true };
        },
      },
      budget: { mayPrompt: () => ({ ok: true }), recordOutcome: () => {} },
    },
    currentRevision: () => state.revision,
    applyAuthority: async (r) => { writes.push(r); return { authority_id: "auth:1", action: r.action }; },
  };

  return {
    deps, receipt, state, prompts, writes, ledger, issued,
    advance: (ms) => { clock += ms; },
    commit: (body) => commitAuthority({ body, ...deps }),
    body: (overrides = {}) => ({ operation_id: "op-1", preview_receipt: receipt.receipt_id, ...overrides }),
  };
}

// ---------------------------------------------------------------------------
// Part 6 — the wire is two identifiers
// ---------------------------------------------------------------------------

test("wire: authoritative fields are REFUSED, not ignored", () => {
  for (const field of FORBIDDEN_COMMIT_FIELDS) {
    const result = validateCommitWire({ operation_id: "op-1", preview_receipt: "r", [field]: "anything" });
    assert.equal(result.ok, false, field);
    assert.equal(result.failure, "browser_authoritative_field", field);
    // Ignoring would let a stale or hostile client believe it is steering the
    // transaction while the host quietly does something else.
    assert.deepEqual(result.fields, [field]);
  }
  assert.deepEqual(COMMIT_FIELDS, ["operation_id", "preview_receipt"]);
});

test("wire: an unknown field is refused too, and both identifiers are required", () => {
  assert.equal(validateCommitWire({ operation_id: "op", preview_receipt: "r", note: "hi" }).failure, "unknown_commit_field");
  assert.equal(validateCommitWire({ preview_receipt: "r" }).failure, "invalid_commit");
  assert.equal(validateCommitWire({ operation_id: "op" }).failure, "invalid_commit");
  assert.equal(validateCommitWire({ operation_id: "op", preview_receipt: "r" }).ok, true);
});

test("wire: a rejected commit never reaches a prompt", async () => {
  const h = harness();
  const result = await h.commit(h.body({ authority_domain: "somewhere-else" }));
  assert.equal(result.failure, "browser_authoritative_field");
  assert.equal(result.prompt_shown, false);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.writes.length, 0);
});

test("prompt: it is derived entirely from the receipt", () => {
  const h = harness();
  const prompt = promptForReceipt(h.receipt);
  assert.match(prompt, /Authorize one bounded DataScape task/);
  assert.match(prompt, /scope:datascape\/briefing/);
  assert.match(prompt, /Paid usage: \$0/);
});

// ---------------------------------------------------------------------------
// Part 7 — the consent sequence
// ---------------------------------------------------------------------------

test("commit: the happy path prompts once and writes once", async () => {
  const h = harness();
  const result = await h.commit(h.body());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authority_written, true);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.writes.length, 1);
  // The prompt described the receipt, not the request.
  assert.match(h.prompts[0].purpose, /Authorize one bounded DataScape task/);
  // And the receipt is single-use, consumed only after the durable commit.
  assert.equal(h.deps.receipts.verify(h.receipt.receipt_id, {}, { readSessionId: SESSION }).failure, "no_receipt");
});

test("commit: an unauthenticated caller never reaches the receipt", async () => {
  const h = harness();
  h.state.session = null;
  const result = await h.commit(h.body());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "read_session_invalid");
  assert.equal(h.prompts.length, 0);
  assert.equal(h.writes.length, 0);
});

test("commit: a receipt from another session is refused before any prompt", async () => {
  const h = harness();
  h.state.session = "session-S2";
  const result = await h.commit(h.body());
  assert.equal(result.failure, "receipt_session_mismatch");
  assert.equal(h.prompts.length, 0);
  assert.equal(h.writes.length, 0);
});

test("commit: authority moving while Hello is open spends the presence and writes nothing", async () => {
  const h = harness();
  h.state.duringPrompt = () => { h.state.revision = 2; };

  const result = await h.commit(h.body());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_authority_revision");
  assert.equal(result.prompt_shown, true, "the prompt happened — it is the WRITE that must not");
  assert.equal(h.writes.length, 0);
  assert.equal(h.issued.size, 0, "the verification is spent on the stale attempt, not carried forward");
});

test("commit: the read session ending during Hello writes nothing and migrates nothing", async () => {
  const h = harness();
  h.state.duringPrompt = () => { h.state.session = null; };

  const result = await h.commit(h.body());
  assert.equal(result.failure, "read_session_lost");
  assert.equal(result.prompt_shown, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.issued.size, 0);

  // The receipt did not migrate: a NEW session cannot present it either,
  // because that is a different review.
  h.state.session = "session-S2";
  const migrated = await h.commit({ operation_id: "op-2", preview_receipt: h.receipt.receipt_id });
  assert.equal(migrated.failure, "receipt_session_mismatch");
  assert.equal(h.writes.length, 0);
});

test("commit: a non-verified outcome writes nothing", async () => {
  for (const outcome of ["cancelled", "failed", "unavailable"]) {
    const h = harness({ outcome });
    const result = await h.commit(h.body());
    assert.equal(result.ok, false, outcome);
    assert.equal(result.failure, outcome);
    assert.equal(result.authority_written, false);
    assert.equal(h.writes.length, 0);
  }
});

test("commit: presence that cannot be consumed writes nothing", async () => {
  const h = harness();
  h.state.consumeOk = false;
  const result = await h.commit(h.body());
  assert.equal(result.failure, "presence_not_valid");
  assert.equal(result.prompt_shown, true);
  assert.equal(h.writes.length, 0);
});

// ---------------------------------------------------------------------------
// Part 8 — durable replay, without becoming a credential
// ---------------------------------------------------------------------------

test("replay: a lost response replays with no second prompt and no second write", async () => {
  const h = harness();
  const first = await h.commit(h.body());
  assert.equal(first.authority_written, true);

  const replay = await h.commit(h.body());
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(h.prompts.length, 1, "prompt delta 0");
  assert.equal(h.writes.length, 1, "write delta 0");
  // And the consumed receipt is not needed for the replay.
  assert.equal(replay.prompt_shown, false);
});

test("replay: operation_id is NOT a bearer credential", async () => {
  const h = harness();
  await h.commit(h.body());

  // The committed result is private authority state. An unauthenticated caller
  // holding the operation id must learn nothing — authentication comes before
  // the durable lookup, deliberately.
  h.state.session = null;
  const stranger = await h.commit(h.body());
  assert.equal(stranger.ok, false);
  assert.equal(stranger.failure, "read_session_invalid");
  assert.equal(stranger.result, undefined, "no private state leaks to an unauthenticated caller");
});

test("replay: the ledger records aborts rather than silently forgetting them", async () => {
  const h = harness({ outcome: "cancelled" });
  await h.commit(h.body());
  assert.equal(h.ledger.get("op-1").phase, "aborted");
  assert.equal(h.ledger.get("op-1").reason, "cancelled");
  assert.equal(h.deps.operations.completed("op-1"), null, "an aborted operation is not replayable");
});

// ---------------------------------------------------------------------------
// The production path cannot issue an unbound receipt
// ---------------------------------------------------------------------------

test("prepare: the HTTP path REQUIRES a live read session", () => {
  const h = harness();
  const issue = {
    draft: createAuthorityDraft({
      draft_id: "draft:prepare", kind: "bounded_canary", statement: "t",
      scope_refs: ["scope:x"], allowed_capabilities: ["read"], stop_conditions: ["done"],
    }),
    action: "authorize_bounded_task",
    sourceExceptionId: "2026-08-21-datascape-v6-execution-authority-b4e2",
    goalId: "goal:1",
    baseRevision: 1,
  };

  // Locked: nothing is prepared at all.
  h.state.session = null;
  const locked = prepareAuthority({ authenticate: h.deps.authenticate, receipts: h.deps.receipts, issue });
  assert.equal(locked.ok, false);
  assert.equal(locked.failure, "read_session_invalid");

  // Unlocked: bound, without the caller having to remember an argument. The
  // store tolerates unbound receipts so the generic substrate stays usable, so
  // the browser path has to make the omission impossible rather than unlikely.
  h.state.session = SESSION;
  const prepared = prepareAuthority({ authenticate: h.deps.authenticate, receipts: h.deps.receipts, issue });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.receipt.read_session_id, SESSION);

  // And that receipt is only committable from the session that prepared it.
  assert.equal(h.deps.receipts.verify(prepared.receipt.receipt_id, {}, { readSessionId: "session-S2" }).failure,
    "receipt_session_mismatch");
});

test("prepare: a store that dropped the binding is caught, not trusted", () => {
  const h = harness();
  const forgetful = {
    issue: (args) => ({ ...h.receipt, read_session_id: null, receipt_id: "r-unbound" }),
  };
  const result = prepareAuthority({
    authenticate: h.deps.authenticate, receipts: forgetful, issue: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "receipt_not_bound",
    "a silently portable receipt would make part 5 decoration");
});
